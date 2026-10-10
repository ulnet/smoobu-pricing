// ### 1 --- tables the live engine and locks rely on
export async function ensureTables(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS price_overrides (apartment_id TEXT, date TEXT, price REAL, note TEXT, created_at TEXT, PRIMARY KEY (apartment_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS price_locks (listing_id TEXT, date TEXT, price REAL, note TEXT, created_at TEXT, PRIMARY KEY (listing_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS price_state (listing_id TEXT, date TEXT, dry_price REAL, PRIMARY KEY (listing_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS price_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, mode TEXT, trigger_name TEXT, listing_id TEXT, date TEXT, old_price REAL, new_price REAL, status TEXT, error TEXT, breakdown TEXT)`)
  ]);
}

// ### 2 --- shared plan builder: loads bookings, locks and overrides, builds the data views, runs the engine
import { buildData } from './data.js';
import { planPrices } from './engine.js';

export async function computePlan(env, o) {
  await ensureTables(env);
  const rows = (await env.DB.prepare(`SELECT id, m_apartment_id, m_arrival, m_departure, created_at, guest_name, details FROM sim_bookings`).all()).results.filter(o.rowFilter || (() => true));
  const ov = new Map(), lk = new Map();
  (await env.DB.prepare(`SELECT apartment_id, date, price FROM price_overrides WHERE date >= ? AND date <= ?`).bind(o.from, o.to).all()).results.forEach(r => ov.set(r.apartment_id + '|' + r.date, r.price));
  (await env.DB.prepare(`SELECT listing_id, date, price FROM price_locks WHERE date >= ? AND date <= ?`).bind(o.from, o.to).all()).results.forEach(r => lk.set(r.listing_id + '|' + r.date, r.price));
  const data = buildData(rows, o.today);
  return planPrices({
    apartments: o.apartments, presets: o.presets, calendar: o.calendar, data, today: o.today, from: o.from, to: o.to, hour: o.hour,
    last: o.last,
    overridePrice: (aid, d) => ov.has(aid + '|' + d) ? ov.get(aid + '|' + d) : null,
    lockPrice: (lid, d) => lk.has(lid + '|' + d) ? lk.get(lid + '|' + d) : null
  });
}
