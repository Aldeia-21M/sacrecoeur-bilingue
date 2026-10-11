import { getStore } from '@netlify/blobs';
// Sauvegarde en ligne des profils : une « valise » par code famille (XXXX-XXXX-XXXX).
// Aucune donnée personnelle : pseudos, points et réponses comptées. Qui connaît le code retrouve les données.
const OK = /^[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}-[A-HJ-NP-Z2-9]{4}$/;
const MAX = 400000; // octets
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
const valid = (d) => d && Array.isArray(d.profiles) && d.profiles.length <= 8
  && d.profiles.every(p => p && typeof p.id === 'string' && p.id.length < 40 && typeof p.name === 'string' && p.name.length <= 40 && p.days && typeof p.days === 'object');
export default async (req) => {
  const store = getStore('profils');
  const url = new URL(req.url);
  if (req.method === 'GET') {
    const c = (url.searchParams.get('c') || '').toUpperCase();
    if (!OK.test(c)) return json({ error: 'code' }, 400);
    const d = await store.get(c, { type: 'json' });
    return d ? json({ data: d }) : json({ error: 'absent' }, 404);
  }
  if (req.method !== 'PUT' && req.method !== 'POST') return json({ error: 'method' }, 405);
  const raw = await req.text();
  if (raw.length > MAX) return json({ error: 'taille' }, 413);
  let b; try { b = JSON.parse(raw); } catch (_) { return json({ error: 'json' }, 400); }
  const c = String(b.code || '').toUpperCase();
  if (!OK.test(c) || !valid(b.data)) return json({ error: 'donnees' }, 400);
  await store.setJSON(c, { v: 1, at: Date.now(), profiles: b.data.profiles, del: b.data.del || {} });
  return json({ ok: true });
};
