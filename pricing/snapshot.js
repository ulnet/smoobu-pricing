// ### 1 --- read-only snapshot of the current Smoobu rates into smoobu_rate_snapshot (before any pricing writes)
import { addDays } from './util.js';

export default async function snapshotRates(env, p, getRates) {
  await env.DB.prepare(`CREATE TABLE IF NOT EXISTS smoobu_rate_snapshot (taken_at TEXT, listing_id TEXT, date TEXT, price REAL, available INTEGER, min_stay INTEGER)`).run();
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'apartments'`).first();
  const ids = (row ? JSON.parse(row.value) : []).flatMap(a => a.listingIds.map(String));
  const from = p.from || new Date().toISOString().slice(0, 10);
  const to = p.to || addDays(from, 59);
  const at = new Date().toISOString();
  const stmts = [];
  for (let k = 0; k < ids.length; k += 20) {
    const params = { start_date: from, end_date: to };
    ids.slice(k, k + 20).forEach((id, n) => { params['apartments%5B' + n + '%5D'] = id; });
    const res = await getRates(env, params);
    if (res.status !== 200) throw new Error('Smoobu rates HTTP ' + res.status);
    const data = (res.body && res.body.data) || {};
    Object.keys(data).forEach(lid => Object.keys(data[lid]).forEach(d => {
      const c = data[lid][d];
      stmts.push(env.DB.prepare(`INSERT INTO smoobu_rate_snapshot (taken_at, listing_id, date, price, available, min_stay) VALUES (?, ?, ?, ?, ?, ?)`).bind(at, lid, d, c.price === null || c.price === undefined ? null : Number(c.price), c.available, c.min_length_of_stay === undefined ? null : c.min_length_of_stay));
    }));
  }
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { success: true, taken_at: at, from, to, listings: ids.length, rows: stmts.length };
}
