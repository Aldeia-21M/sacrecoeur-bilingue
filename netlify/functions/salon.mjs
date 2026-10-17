import { getStore } from '@netlify/blobs';
// Salon à distance (BÊTA) : un salon = un petit document, mis à jour par les joueurs (sondage régulier).
// Aucune donnée personnelle : pseudos, avatars, classes, points de la partie. Les salons expirent après 4 h.
const CODE = /^[A-HJ-NP-Z2-9]{5}$/, PID = /^[A-Za-z0-9_-]{3,24}$/, AL = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
const THEMES = ['mix', 'de', 'fr', 'ma'];
// Jeux de plateau : le serveur ne connaît pas les règles, il garde l'état envoyé par le joueur dont c'est le tour.
const GAMES = {
  chevaux: { min: 2, max: 4, xs: [2, 4] }, uno: { min: 2, max: 4, xs: [0, 1, 2] }, cartes: { min: 2, max: 4, xs: [0, 1, 2] },
  puissance4: { min: 2, max: 2, xs: [0] }, navale: { min: 2, max: 4, xs: [6, 8] }, pendu: { min: 2, max: 4, xs: [0, 1] }, moulin: { min: 2, max: 2, xs: [6, 9] },
  race: { min: 2, max: 6, xs: [5, 8, 12] }, memory: { min: 2, max: 4, xs: [6, 10] }, loto: { min: 2, max: 6, xs: [0] } };
const ROUNDS = 3, VOTE_MS = 45000, ASK_MS = 12000, ANS_MS = 30000, REV_MS = 5500, GONE = 35000, TTL = 4 * 3600e3, MAXP = 8;
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const st = () => getStore({ name: 'salons', consistency: 'strong' });
const clean = s => String(s || '').replace(/[<>&"'`]/g, '').trim().slice(0, 14);
const prof = p => ({ id: String(p.id), name: clean(p.name) || 'Joueur', av: String(p.av || '🙂').slice(0, 8), col: /^#[0-9a-f]{6}$/i.test(p.col || '') ? p.col : '#1f5fd6', gr: ['1H', '4H', '6H'].includes(p.gr) ? p.gr : '4H' });
const shuffle = a => { a = a.slice(); for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
const fresh = (r, id, t) => (r.seen[id] || 0) > t - GONE;
const driver = (r, t) => { const p = r.players.find(x => fresh(r, x.id, t)); return p ? p.id : null; };
const newTurn = (r, n, t) => ({ n, pid: r.order[n % r.order.length], q: null, ans: null, t0: t, deadline: t + ASK_MS, revealUntil: 0 });
function startPlay(r, t) {
  const a = r.players.filter(p => fresh(r, p.id, t)), ps = a.length ? a : r.players;
  r.order = shuffle(ps.map(p => p.id)); r.scores = {}; ps.forEach(p => { r.scores[p.id] = { pts: 0, ok: 0, a: 0 }; });
  r.total = r.order.length * ROUNDS; r.turn = newTurn(r, 0, t); r.phase = 'play';
}
function resolveVote(r, t) {
  const c = {}; Object.values(r.vote.votes).forEach(v => { if (THEMES.includes(v)) c[v] = (c[v] || 0) + 1; });
  const mx = Math.max(0, ...Object.values(c)), top = Object.keys(c).filter(k => c[k] === mx);
  r.theme = top.length ? top[Math.floor(Math.random() * top.length)] : 'mix'; startPlay(r, t);
}
// avance l'état selon l'heure (une seule personne s'en charge : le « pilote »)
function step(r, t) {
  if (r.phase === 'vote' && r.vote && t >= r.vote.start + r.vote.dur) { resolveVote(r, t); return true; }
  if (r.phase !== 'play' || !r.turn) return false;
  const u = r.turn;
  if (u.ans) {
    if (t < u.revealUntil) return false;
    let n = u.n + 1; if (n >= r.total) { r.phase = 'end'; return true; }
    for (let k = 0; k < r.order.length && !fresh(r, r.order[n % r.order.length], t) && n < r.total; k++) n++;
    if (n >= r.total) { r.phase = 'end'; return true; }
    r.turn = newTurn(r, n, t); return true;
  }
  if (t > u.deadline) {
    if (u.q && r.scores[u.pid]) r.scores[u.pid].a++;
    u.ans = { k: -1, ok: false, timeout: true }; u.revealUntil = t + (u.q ? REV_MS : 2500); return true;
  }
  return false;
}
async function mutate(code, fn) {
  const s = st();
  for (let i = 0; i < 4; i++) {
    const r = await s.get(code, { type: 'json' }); if (!r) return null;
    if (fn(r) === false) return r;
    r.v = (r.v || 0) + 1; r.stamp = Math.random().toString(36).slice(2); await s.setJSON(code, r);
    const chk = await s.get(code, { type: 'json' }); if (chk && chk.stamp === r.stamp) return r;
  }
  return await s.get(code, { type: 'json' });
}
const okQ = q => q && typeof q === 'object' && Array.isArray(q.options) && q.options.length >= 2 && q.options.length <= 6 && Number.isInteger(q.correct) && q.correct >= 0 && q.correct < q.options.length && JSON.stringify(q).length < 12000;
// « Qui est en ligne ? » : un petit carnet de présence anonyme (identifiant aléatoire, rien d'autre).
const LB = '_lobby', FRESH = 75000;
async function lobby(url, t) {
  const me = url.searchParams.get('p') || ''; if (!PID.test(me)) return json({ error: 'pid' }, 400);
  const s = st(), c = (url.searchParams.get('c') || '').toUpperCase(), e = { t };
  if (CODE.test(c)) e.c = c;
  await s.setJSON('_lb/' + me, e);
  const d = { seen: {} }, { blobs } = await s.list({ prefix: '_lb/' });
  await Promise.all(blobs.map(async b => { const v = await s.get(b.key, { type: 'json' }); if (!v) return; if (v.t < t - FRESH * 2) { await s.delete(b.key); return; } d.seen[b.key.slice(4)] = v; }));
  const live = Object.values(d.seen).filter(x => x.t > t - FRESH);
  const codes = [...new Set(live.map(x => x.c).filter(x => x && x !== e.c))].slice(0, 8), open = [];
  for (const k of codes) {
    const r = await s.get(k, { type: 'json' });
    if (!r || t - r.created > TTL || r.phase !== 'lobby' || r.players.length >= MAXP) continue;
    const h = r.players.find(p => p.id === r.host) || r.players[0] || {};
    open.push({ c: k, nm: h.name || 'Un joueur', av: h.av || '🙂', n: r.players.length });
  }
  return json({ online: live.length, open: open.slice(0, 4), now: t });
}
export default async (req) => {
  const s = st(), t = Date.now(), url = new URL(req.url);
  if (req.method === 'GET') {
    if (url.searchParams.get('lobby')) return lobby(url, t);
    const c = (url.searchParams.get('c') || '').toUpperCase(), me = url.searchParams.get('p') || '', v = +url.searchParams.get('v') || 0;
    if (!CODE.test(c)) return json({ error: 'code' }, 400);
    let r = await s.get(c, { type: 'json' });
    if (!r || t - r.created > TTL) return json({ error: 'absent' }, 404);
    const fn = rr => {
      let ch = false;
      if (rr.players.some(x => x.id === me) && (rr.seen[me] || 0) < t - 8000) { rr.seen[me] = t; ch = true; }
      if (driver(rr, t) === me && step(rr, t)) ch = true;
      return ch ? undefined : false;
    };
    if (fn(JSON.parse(JSON.stringify(r))) !== false) r = await mutate(c, fn) || r;
    return r.v === v ? json({ same: true, now: t }) : json({ room: r, now: t });
  }
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let b; try { b = await req.json(); } catch (_) { return json({ error: 'json' }, 400); }
  const a = b.a, me = String(b.p || '');
  if (!PID.test(me)) return json({ error: 'pid' }, 400);
  if (a === 'create') {
    if (!b.profile) return json({ error: 'profil' }, 400);
    let code = '', ok = false;
    for (let i = 0; i < 6 && !ok; i++) { code = Array.from({ length: 5 }, () => AL[Math.floor(Math.random() * AL.length)]).join(''); ok = !(await s.get(code, { type: 'json' })); }
    if (!ok) return json({ error: 'busy' }, 503);
    const r = { code, v: 1, stamp: 'n', created: t, host: me, phase: 'lobby', players: [prof(Object.assign({}, b.profile, { id: me }))], seen: { [me]: t }, vote: null, theme: null, order: [], scores: {}, total: 0, turn: null, g: null };
    await s.setJSON(code, r); return json({ room: r, now: t });
  }
  const code = String(b.c || '').toUpperCase(); if (!CODE.test(code)) return json({ error: 'code' }, 400);
  let err = null;
  const r = await mutate(code, rr => {
    err = null;
    if (t - rr.created > TTL) { err = 'absent'; return false; }
    const inRoom = rr.players.some(x => x.id === me);
    if (a === 'join') {
      if (!b.profile) { err = 'profil'; return false; }
      const p = prof(Object.assign({}, b.profile, { id: me })), i = rr.players.findIndex(x => x.id === me);
      if (i >= 0) rr.players[i] = p; else if (rr.players.length >= MAXP) { err = 'plein'; return false; } else rr.players.push(p);
      rr.seen[me] = t; if (rr.phase === 'play' && !rr.order.includes(me)) { rr.order.push(me); rr.scores[me] = { pts: 0, ok: 0, a: 0 }; rr.total += ROUNDS; }
      return; }
    if (!inRoom) { err = 'membre'; return false; }
    rr.seen[me] = t;
    if (a === 'vote') {
      if (!THEMES.includes(b.theme)) { err = 'theme'; return false; }
      if (rr.phase === 'lobby') { rr.phase = 'vote'; rr.vote = { start: t, dur: VOTE_MS, votes: {} }; }
      if (rr.phase !== 'vote') { err = 'phase'; return false; }
      rr.vote.votes[me] = b.theme;
      const act = rr.players.filter(x => fresh(rr, x.id, t));
      if (act.length && act.every(x => rr.vote.votes[x.id])) resolveVote(rr, t);
      return; }
    if (a === 'ask') {
      const u = rr.turn; if (rr.phase !== 'play' || !u || u.n !== b.n || u.pid !== me || u.q || u.ans || !okQ(b.q)) { err = 'tour'; return false; }
      u.q = b.q; u.deadline = t + ANS_MS; return; }
    if (a === 'answer') {
      const u = rr.turn; if (rr.phase !== 'play' || !u || u.n !== b.n || u.pid !== me || !u.q || u.ans) { err = 'tour'; return false; }
      const k = Math.floor(+b.k), good = k === u.q.correct, sc = rr.scores[me] || (rr.scores[me] = { pts: 0, ok: 0, a: 0 });
      sc.a++; if (good) { sc.ok++; sc.pts += 10; } u.ans = { k, ok: good }; u.revealUntil = t + REV_MS; return; }
    if (a === 'start') {
      if (rr.phase !== 'lobby') { err = 'phase'; return false; }
      const G = GAMES[b.game]; if (!G) { err = 'jeu'; return false; }
      const ps = rr.players.filter(x => fresh(rr, x.id, t)); if (ps.length < G.min || ps.length > G.max) { err = 'joueurs'; return false; }
      rr.phase = 'game'; rr.vote = null; rr.g = { type: b.game, x: G.xs.includes(+b.x) ? +b.x : G.xs[0], order: ps.map(x => x.id), n: 0, turn: ps[0].id, by: null, s: null, over: false, msg: '', t0: t }; return; }
    if (a === 'move') {
      const g = rr.g; if (rr.phase !== 'game' || !g || g.over || g.turn !== me || b.n !== g.n || !g.order.includes(String(b.turn))) { err = 'tour'; return false; }
      const st0 = b.s; if (!st0 || typeof st0 !== 'object' || JSON.stringify(st0).length > 20000) { err = 'etat'; return false; }
      g.s = st0; g.n++; g.by = me; g.turn = String(b.turn); g.over = !!b.over; g.msg = String(b.msg || '').slice(0, 300); return; }
    if (a === 'again') { if (!(rr.phase === 'end' || (rr.phase === 'game' && rr.g && (rr.g.over || rr.host === me)))) { err = 'phase'; return false; } rr.phase = 'lobby'; rr.g = null; rr.vote = null; rr.theme = null; rr.turn = null; rr.order = []; rr.scores = {}; rr.total = 0; return; }
    if (a === 'leave') { if (rr.phase === 'game') { rr.phase = 'lobby'; rr.g = null; } rr.players = rr.players.filter(x => x.id !== me); delete rr.seen[me]; if (rr.host === me && rr.players[0]) rr.host = rr.players[0].id; return; }
    err = 'action'; return false;
  });
  if (!r) return json({ error: 'absent' }, 404);
  if (err) return json({ error: err, room: r, now: t }, err === 'absent' ? 404 : 409);
  return json({ room: r, now: t });
};
