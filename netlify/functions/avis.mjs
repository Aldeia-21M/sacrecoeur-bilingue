import { getStore } from '@netlify/blobs';
// Compteurs publics : nombre de 👍 et de commentaires. Les textes ne sont PAS stockés ici
// (ils arrivent par Netlify Forms, en privé, avec notification e-mail).
const KEY = 'compteurs';
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'content-type': 'application/json', 'cache-control': 'no-store' } });
export default async (req) => {
  const store = getStore('avis');
  const cur = (await store.get(KEY, { type: 'json' })) || { likes: 0, comments: 0 };
  if (req.method === 'GET') return json(cur);
  if (req.method !== 'POST') return json({ error: 'method' }, 405);
  let b = {}; try { b = await req.json(); } catch (_) { return json({ error: 'json' }, 400); }
  if (b.like === true) cur.likes += 1;
  if (b.comment === true) cur.comments += 1;
  await store.setJSON(KEY, cur);
  return json(cur);
};
