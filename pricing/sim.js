// ### 1 --- imports and table setup (sim_ tables only, never touches Smoobu)
import { tzNow } from './clock.js';
import { computePlan } from './plan.js';
import composePresets from './compose.js';
import { toChanges } from './engine.js';
import { addDays, rangeDates } from './util.js';

const DEFAULT_SETTINGS = { horizonDays: 60, enabled: false, dryRun: true };

async function ensureSimTables(env) {
  await env.DB.batch([
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sim_rates (listing_id TEXT, date TEXT, price REAL, updated_at TEXT, PRIMARY KEY (listing_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS sim_price_log (id INTEGER PRIMARY KEY AUTOINCREMENT, ts TEXT, listing_id TEXT, date TEXT, old_price REAL, new_price REAL, breakdown TEXT)`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS price_locks (listing_id TEXT, date TEXT, price REAL, note TEXT, created_at TEXT, PRIMARY KEY (listing_id, date))`),
    env.DB.prepare(`CREATE TABLE IF NOT EXISTS price_overrides (apartment_id TEXT, date TEXT, price REAL, note TEXT, created_at TEXT, PRIMARY KEY (apartment_id, date))`)
  ]);
}

// ### 1b --- price overrides: a locked, hands-off price for one apartment across a date range (all its listings), skipped by the engine's normal math
async function setPriceOverride(env, p) {
  await ensureSimTables(env);
  const from = p.from || p.date, to = p.to || p.from || p.date;
  if (!from || !to || to < from) return { success: false, error: 'Bad date range' };
  if (rangeDates(from, to).length > 366) return { success: false, error: 'Range too long' };
  if (p.price === null || p.price === undefined || p.price === '') {
    await env.DB.prepare(`DELETE FROM price_overrides WHERE apartment_id = ? AND date >= ? AND date <= ?`).bind(String(p.apartmentId), from, to).run();
    return { success: true, removed: true };
  }
  const stmts = rangeDates(from, to).map(d => env.DB.prepare(
    `INSERT INTO price_overrides (apartment_id, date, price, note, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(apartment_id, date) DO UPDATE SET price = excluded.price, note = excluded.note`
  ).bind(String(p.apartmentId), d, Number(p.price), p.note || '', new Date().toISOString()));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { success: true, count: stmts.length };
}
async function setPriceLocks(env, p) {
  await ensureSimTables(env);
  const from = p.from || p.date, to = p.to || from;
  if (!p.listingId || !from || to < from) return { success: false, error: 'Bad lock range' };
  if (rangeDates(from, to).length > 366) return { success: false, error: 'Range too long' };
  if (p.price === null || p.price === undefined || p.price === '') {
    await env.DB.prepare(`DELETE FROM price_locks WHERE listing_id = ? AND date >= ? AND date <= ?`).bind(String(p.listingId), from, to).run();
    return { success: true, removed: true };
  }
  const at = new Date().toISOString();
  const stmts = rangeDates(from, to).map(d => env.DB.prepare(`INSERT INTO price_locks (listing_id, date, price, note, created_at) VALUES (?, ?, ?, ?, ?) ON CONFLICT(listing_id, date) DO UPDATE SET price = excluded.price, note = excluded.note`).bind(String(p.listingId), d, Number(p.price), p.note || '', at));
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  return { success: true, count: stmts.length };
}
async function getPriceLocks(env) {
  await ensureSimTables(env);
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(`DELETE FROM price_locks WHERE date < ?`).bind(today).run();
  return { success: true, locks: (await env.DB.prepare(`SELECT * FROM price_locks ORDER BY listing_id, date`).all()).results };
}
async function getPriceOverrides(env) {
  await ensureSimTables(env);
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(`DELETE FROM price_overrides WHERE date < ?`).bind(today).run();
  const rows = (await env.DB.prepare(`SELECT * FROM price_overrides ORDER BY date`).all()).results;
  return { success: true, overrides: rows };
}

async function meta(env, key, dflt) {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first();
  return r ? JSON.parse(r.value) : dflt;
}

async function putMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, JSON.stringify(value)).run();
}

// ### 2 --- simulated clock (defaults to the real date until first stepped)
async function simToday(env, now, tz) {
  if (now) return String(now).slice(0, 10);
  const c = await meta(env, 'sim_clock', null);
  if (c) return c;
  const t = tz || (await meta(env, 'pricing_settings', {})).timezone;
  return tzNow(t).date;
}

// ### 3 --- run the engine against sim_bookings + sim_rates; optionally persist into sim_rates and sim_price_log
async function simulatePricing(env, p) {
  await ensureSimTables(env);
  const st = Object.assign({}, DEFAULT_SETTINGS, await meta(env, 'pricing_settings', {}));
  const tz = p.timezone || st.timezone || 'UTC';
  const today = await simToday(env, p.now, tz);
  const hour = p.hour !== undefined && p.hour !== null && p.hour !== '' ? Number(p.hour) : tzNow(tz).hour;
  const from = p.from || today;
  const to = p.to || addDays(today, (Number(p.days) || st.horizonDays) - 1);
  let apartments = await meta(env, 'apartments', []);
  if (p.apartmentId) apartments = apartments.filter(a => String(a.id) === String(p.apartmentId));
  const presets = composePresets(p.strategies || await meta(env, 'pricing_strategies', {}), p.aptSettings || await meta(env, 'pricing_apartments', {}));
  const calendar = p.calendar || await meta(env, 'pricing_calendar', { seasons: [], events: [] });
  const lastMap = new Map();
  if (p.useLast !== false) (await env.DB.prepare(`SELECT listing_id, date, price FROM sim_rates WHERE date >= ? AND date <= ?`).bind(from, to).all()).results.forEach(r => lastMap.set(r.listing_id + '|' + r.date, r.price));
  const days = await computePlan(env, { apartments, presets, calendar, today, hour, from, to, last: (id, d) => lastMap.has(id + '|' + d) ? lastMap.get(id + '|' + d) : null, rowFilter: r => !(String(r.id).startsWith('simgen-') && String(r.created_at).slice(0, 10) > today) });
  const changes = toChanges(days);
  if (p.persist) {
    const stmts = [];
    const dm = new Map();
    days.forEach(d => d.listings.forEach(l => dm.set(l.id + '|' + d.date, d)));
    changes.forEach(c => {
      const d = dm.get(c.listingId + '|' + c.date);
      stmts.push(env.DB.prepare(`INSERT INTO sim_rates (listing_id, date, price, updated_at) VALUES (?, ?, ?, ?) ON CONFLICT(listing_id, date) DO UPDATE SET price = excluded.price, updated_at = excluded.updated_at`).bind(c.listingId, c.date, c.price, today));
      stmts.push(env.DB.prepare(`INSERT INTO sim_price_log (ts, listing_id, date, old_price, new_price, breakdown) VALUES (?, ?, ?, ?, ?, ?)`).bind(today, c.listingId, c.date, c.old, c.price, JSON.stringify({ factors: d.factors, sum: d.sum, eventMult: d.eventMult, mid: d.mid })));
    });
    for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  }
  return { success: true, today, from, to, persisted: !!p.persist, settings: st, days, changes: changes.length };
}

// ### 4 --- step the fake clock forward, optionally injecting random bookings stamped with the fake time (so pace history has shape)
async function simulateStep(env, p) {
  const today = await simToday(env, null);
  const sd = p.stepDays === undefined ? 1 : Number(p.stepDays) || 0;
  const next = addDays(today, sd);
  if (sd) await putMeta(env, 'sim_clock', next);
  const n = Number(p.addRandom) || 0;
  if (n) {
    const apartments = await meta(env, 'apartments', []);
    const ids = apartments.flatMap(a => a.listingIds.map(l => ({ id: String(l), name: a.name })));
    const stmts = [];
    for (let i = 0; i < n && ids.length; i++) {
      const u = ids[Math.floor(Math.random() * ids.length)];
      const arr = addDays(next, Math.floor(Math.random() * 45));
      const dep = addDays(arr, 1 + Math.floor(Math.random() * 4));
      stmts.push(env.DB.prepare(`INSERT INTO sim_bookings (id, reference_id, apartment_id, apartment_name, arrival, departure, guest_name, channel, m_arrival, m_departure, m_apartment_id, m_apartment_name, room_number, details, created_at) VALUES (?, '', ?, ?, ?, ?, ?, 'sim', ?, ?, ?, ?, '', '{}', ?)`).bind('simgen-' + crypto.randomUUID(), u.id, u.name, arr, dep, 'Sim Guest ' + (i + 1), arr, dep, u.id, u.name, next + 'T12:00:00Z'));
    }
    if (stmts.length) await env.DB.batch(stmts);
  }
  return simulatePricing(env, { now: next, persist: p.persist !== false, days: p.days, apartmentId: p.apartmentId, strategies: p.strategies, aptSettings: p.aptSettings, calendar: p.calendar, timezone: p.timezone, hour: p.hour });
}

async function simulateSetDate(env, p) {
  if (p.date) await putMeta(env, 'sim_clock', String(p.date).slice(0, 10));
  else await env.DB.prepare(`DELETE FROM meta WHERE key = 'sim_clock'`).run();
  return simulatePricing(env, { strategies: p.strategies, aptSettings: p.aptSettings, calendar: p.calendar, days: p.days, timezone: p.timezone, hour: p.hour });
}

// ### 5 --- read persisted sim prices, price log for one cell, and reset
async function getSimRates(env, p) {
  await ensureSimTables(env);
  const today = await simToday(env, null);
  const rows = (await env.DB.prepare(`SELECT listing_id, date, price FROM sim_rates WHERE date >= ? AND date <= ?`).bind(p.from || today, p.to || addDays(today, 59)).all()).results;
  return { success: true, today, rates: rows };
}

async function getSimPriceLog(env, p) {
  await ensureSimTables(env);
  const rows = (await env.DB.prepare(`SELECT * FROM sim_price_log WHERE listing_id = ? AND date = ? ORDER BY id DESC LIMIT 50`).bind(String(p.listingId), p.date).all()).results;
  return { success: true, log: rows };
}

async function clearTestBookings(env) {
  await env.DB.prepare(`DELETE FROM sim_bookings WHERE id LIKE 'simgen-%'`).run();
  return { success: true };
}

async function resetSim(env) {
  await ensureSimTables(env);
  await env.DB.batch([
    env.DB.prepare(`DELETE FROM sim_rates`),
    env.DB.prepare(`DELETE FROM sim_price_log`),
    env.DB.prepare(`DELETE FROM sim_bookings WHERE id LIKE 'simgen-%'`),
    env.DB.prepare(`DELETE FROM meta WHERE key = 'sim_clock'`)
  ]);
  return { success: true };
}

// ### 6 --- action table consumed by worker.js
export default {
  simulatePricing: (env, p) => simulatePricing(env, p),
  simulateStep: (env, p) => simulateStep(env, p),
  simulateSetDate: (env, p) => simulateSetDate(env, p),
  setPriceOverride: (env, p) => setPriceOverride(env, p),
  getPriceOverrides: (env, p) => getPriceOverrides(env, p),
  setPriceLocks: (env, p) => setPriceLocks(env, p),
  getPriceLocks: (env, p) => getPriceLocks(env, p),
  getSimRates: (env, p) => getSimRates(env, p),
  getSimPriceLog: (env, p) => getSimPriceLog(env, p),
  clearTestBookings: env => clearTestBookings(env),
  resetSim: env => resetSim(env)
};
