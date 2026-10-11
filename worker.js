import simActions from './pricing/sim.js';
import snapshotRates from './pricing/snapshot.js';
import { runPricing, priceAfterBooking, getPricingStatus } from './pricing/run.js';

// ### 1 --- smoobu api auth helpers
const BASE_URL = 'https://login.smoobu.com';

async function sha256Hex(str) {
  const data = new TextEncoder().encode(str);
  const hashBuffer = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(hashBuffer)).map(b => b.toString(16).padStart(2, '0')).join('');
}

async function hmacBase64(message, secret) {
  const encoder = new TextEncoder();
  const key = await crypto.subtle.importKey('raw', encoder.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const signature = await crypto.subtle.sign('HMAC', key, encoder.encode(message));
  let binary = '';
  new Uint8Array(signature).forEach(b => binary += String.fromCharCode(b));
  return btoa(binary);
}

function isoTimestamp() { return new Date().toISOString().replace(/\.\d{3}Z$/, 'Z'); }

async function smoobuRequest(env, method, path, queryParams, bodyObj) {
  const key = env.SMOOBU_API_KEY, secret = env.SMOOBU_API_SECRET;
  const timestamp = isoTimestamp(), nonce = crypto.randomUUID();
  const bodyString = bodyObj ? JSON.stringify(bodyObj) : '';
  const bodyHash = await sha256Hex(bodyString);
  const query = queryParams ? Object.keys(queryParams).sort().map(k => `${k}=${queryParams[k]}`).join('&') : '';
  const canonical = [method, path, query, timestamp, nonce, bodyHash, key].join('\n');
  const signature = await hmacBase64(canonical, secret);

  let url = BASE_URL + path;
  if (query) url += '?' + query;

  const headers = { 'X-API-Key': key, 'X-Timestamp': timestamp, 'X-Nonce': nonce, 'X-Signature': signature };
  const options = { method, headers };
  if (bodyObj) { headers['Content-Type'] = 'application/json'; options.body = bodyString; }

  const response = await fetch(url, options);
  const text = await response.text();
  let body;
  try { body = JSON.parse(text || '{}'); } catch (e) { body = { raw: text }; }
  return { status: response.status, body };
}

// ### 1b --- smoobu passthrough
function getApartments(env) { return smoobuRequest(env, 'GET', '/api/apartments', null, null); }
function getRates(env, params) { return smoobuRequest(env, 'GET', '/api/rates', params, null); }
function getBookings(env, params) { return smoobuRequest(env, 'GET', '/api/reservations', params, null); }
function blockDates(env, apartmentId, arrivalDate, departureDate) {
  return smoobuRequest(env, 'POST', '/api/reservations', null, {
    apartmentId: Number(apartmentId), arrivalDate, departureDate,
    firstName: 'Blocked', lastName: 'Period', email: 'blocked@placeholder.local'
  });
}
function setRateOps(env, apartmentId, operations) {
  return smoobuRequest(env, 'POST', '/api/rates', null, { apartments: [Number(apartmentId)], operations });
}
function pricingDeps(env) {
  return {
    getRates: params => getRates(env, params),
    setRateOps: (id, ops) => setRateOps(env, id, ops),
    alert: (title, detail) => addAlert(env, 'error', title, detail, ''),
    telegram: m => sendTelegramAlert(env, m)
  };
}
const GMAIL_TRIGGERS = new Set(['newReservation', 'updateReservation', 'addSimBooking', 'updateSimBooking', 'syncLiveBookings', 'restoreBooking']);
const PRICE_TRIGGERS = new Set(['newReservation', 'updateReservation', 'cancelReservation', 'deleteReservation', 'addSimBooking', 'updateSimBooking', 'deleteSimBooking']);
function listingOf(payload) {
  const d = payload.data || {};
  return String((d.apartment && d.apartment.id) || d.apartmentId || payload.m_apartment_id || payload.apartment_id || '');
}
function setRate(env, apartmentId, from, to, price) {
  return smoobuRequest(env, 'POST', '/api/rates', null, {
    apartments: [Number(apartmentId)],
    operations: [{ dates: [from === to ? from : `${from}:${to}`], daily_price: Number(price) }]
  });
}

async function getOccupiedApartments(env, from, to) {
  const occupied = new Set();
  let page = 1;
  const maxPages = 5;
  while (page <= maxPages) {
    const res = await getBookings(env, { from, to, page });
    const body = res.body || {};
    const bookings = body.bookings || [];
    const reqFrom = new Date(from), reqTo = new Date(to);
    bookings.forEach(b => {
      const bFrom = new Date(b.arrival), bTo = new Date(b.departure);
      if (b.type !== 'cancellation' && reqFrom < bTo && bFrom < reqTo && b.apartment && b.apartment.id) occupied.add(b.apartment.id);
    });
    if (!body.page_count || page >= body.page_count) break;
    page++;
  }
  return occupied;
}

// ### 2 --- sim_bookings CRUD (isolated test/simulation data, not real Smoobu bookings)
async function getSimBookings(env) {
  const res = await env.DB.prepare(`SELECT * FROM sim_bookings ORDER BY arrival`).all();
  return { success: true, bookings: res.results };
}

async function addSimBooking(env, data) {
  const id = data.id || crypto.randomUUID();
  const now = new Date().toISOString();
  await env.DB.prepare(
    `INSERT INTO sim_bookings (id, reference_id, apartment_id, apartment_name, arrival, departure, guest_name, channel, m_arrival, m_departure, m_apartment_id, m_apartment_name, room_number, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind(id, data.reference_id || '', data.apartment_id || '', data.apartment_name || '', data.arrival, data.departure, data.guest_name || '', data.channel || '', data.arrival, data.departure, data.apartment_id || '', data.apartment_name || '', data.room_number || '', JSON.stringify(data.details || {}), now).run();
  return { success: true, id };
}

async function updateSimBooking(env, id, patch) {
  const fields = ['guest_name', 'channel', 'apartment_id', 'apartment_name', 'm_arrival', 'm_departure', 'm_apartment_id', 'm_apartment_name', 'room_number'];
  const sets = [], vals = [];
  fields.forEach(f => { if (patch[f] !== undefined) { sets.push(f + ' = ?'); vals.push(patch[f]); } });
  if (patch.details !== undefined) { sets.push('details = ?'); vals.push(JSON.stringify(patch.details)); }
  if (!sets.length) return { success: true, id };
  vals.push(id);
  await env.DB.prepare(`UPDATE sim_bookings SET ${sets.join(', ')} WHERE id = ?`).bind(...vals).run();
  return { success: true, id };
}

async function deleteSimBooking(env, id) {
  await env.DB.prepare(`DELETE FROM sim_bookings WHERE id = ?`).bind(id).run();
  return { success: true, id };
}

// ### 3 --- generic meta key/value store (apartments, manual_listings, future settings)
async function getMeta(env, key) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first();
  return { success: true, key, value: row ? JSON.parse(row.value) : null };
}

async function setMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, JSON.stringify(value)).run();
  return { success: true, key };
}

// ### 4 --- per-apartment, per-date overrides (threshold + note); apartment_id='__day__' is the global per-day note sentinel; past dates auto-purged on read
async function getDateOverrides(env) {
  const today = new Date().toISOString().slice(0, 10);
  await env.DB.prepare(`DELETE FROM date_overrides WHERE date < ?`).bind(today).run();
  const res = await env.DB.prepare(`SELECT * FROM date_overrides`).all();
  return { success: true, overrides: res.results };
}

async function setDateOverride(env, apartmentId, date, thresholdOverride, notes) {
  if (thresholdOverride == null && !notes) {
    await env.DB.prepare(`DELETE FROM date_overrides WHERE apartment_id = ? AND date = ?`).bind(apartmentId, date).run();
    return { success: true };
  }
  await env.DB.prepare(
    `INSERT INTO date_overrides (apartment_id, date, threshold_override, notes) VALUES (?, ?, ?, ?)
     ON CONFLICT(apartment_id, date) DO UPDATE SET threshold_override = excluded.threshold_override, notes = excluded.notes`
  ).bind(apartmentId, date, thresholdOverride, notes || '').run();
  return { success: true };
}

// ### 4b --- clear every per-property threshold override (optionally just one date); day notes are kept
async function clearThresholdOverrides(env, date) {
  const w = date ? ' AND date = ?' : '';
  const b = date ? [date] : [];
  const n = (await env.DB.prepare(`SELECT COUNT(*) AS c FROM date_overrides WHERE apartment_id != '__day__' AND threshold_override IS NOT NULL${w}`).bind(...b).first()).c;
  await env.DB.prepare(`UPDATE date_overrides SET threshold_override = NULL WHERE apartment_id != '__day__'${w}`).bind(...b).run();
  await env.DB.prepare(`DELETE FROM date_overrides WHERE apartment_id != '__day__' AND (notes IS NULL OR notes = '')${w}`).bind(...b).run();
  return { success: true, cleared: n };
}

// ### 4c --- set (or clear) one property's threshold override across an inclusive date range; a value equal to the property's default clears it
async function setThresholdRange(env, apartmentId, from, to, threshold) {
  const re = /^\d{4}-\d{2}-\d{2}$/;
  if (!re.test(from || '') || !re.test(to || '') || to < from) return { success: false, error: 'Bad date range' };
  const metaRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'apartments'`).first();
  const prop = (metaRow ? JSON.parse(metaRow.value) : []).find(a => a.id === apartmentId);
  if (!prop) return { success: false, error: 'Unknown property: ' + apartmentId };
  const val = threshold === null || threshold === undefined || threshold === '' || Number(threshold) === Number(prop.threshold) ? null : Number(threshold);
  if (val !== null && !(val >= 0)) return { success: false, error: 'Bad threshold' };
  const days = [];
  for (let d = from; d <= to && days.length < 400; d = addDaysIso(d, 1)) days.push(d);
  if (val === null) {
    await env.DB.prepare(`UPDATE date_overrides SET threshold_override = NULL WHERE apartment_id = ? AND date >= ? AND date <= ?`).bind(apartmentId, from, to).run();
    await env.DB.prepare(`DELETE FROM date_overrides WHERE apartment_id = ? AND date >= ? AND date <= ? AND (notes IS NULL OR notes = '')`).bind(apartmentId, from, to).run();
  } else {
    await env.DB.batch(days.map(d => env.DB.prepare(`INSERT INTO date_overrides (apartment_id, date, threshold_override, notes) VALUES (?, ?, ?, '') ON CONFLICT(apartment_id, date) DO UPDATE SET threshold_override = excluded.threshold_override`).bind(apartmentId, d, val)));
  }
  return { success: true, days: days.length, override: val };
}

// ### 5 --- capacity test against dummy data (sim_bookings) — decision only, never touches Smoobu
async function getPropertyOccupancy(env, prop, arrival, departure) {
  if (!prop.listingIds.length) return 0;
  const placeholders = prop.listingIds.map(() => '?').join(',');
  const rows = await env.DB.prepare(
    `SELECT m_arrival, m_departure FROM sim_bookings WHERE m_apartment_id IN (${placeholders})`
  ).bind(...prop.listingIds).all();
  let maxCount = 0;
  let d = new Date(arrival + 'T00:00:00');
  const end = new Date(departure + 'T00:00:00');
  while (d < end) {
    const ds = d.toISOString().slice(0, 10);
    const count = rows.results.filter(r => r.m_arrival <= ds && ds < r.m_departure).length;
    if (count > maxCount) maxCount = count;
    d.setDate(d.getDate() + 1);
  }
  return maxCount;
}

// ### 7a --- alert wording is per PROPERTY + date range (a property is closed or open as a whole); listing ids only appear in detail lines
function propOfListing(apartments, id) {
  return apartments.find(a => (a.listingIds || []).map(String).includes(String(id)));
}
function groupByProperty(apartments, ids) {
  const g = {};
  ids.forEach(id => { const p = propOfListing(apartments, id); const n = p ? p.name : '(unassigned)'; g[n] = (g[n] || 0) + 1; });
  return g;
}
function groupText(g) {
  return Object.keys(g).map(n => n + ' (' + g[n] + ' listing' + (g[n] > 1 ? 's' : '') + ')').join(', ');
}
async function blockMany(env, ids, arrival, departure) {
  const failed = [];
  for (const id of ids) {
    const res = await blockDates(env, id, arrival, departure);
    if (!(res.status >= 200 && res.status < 300)) failed.push({ id: String(id), status: res.status });
  }
  return failed;
}

function effThreshold(prop, ovs, d) {
  const o = ovs.find(x => x.apartment_id === prop.id && x.date === d);
  return o && o.threshold_override != null ? Number(o.threshold_override) : (Number(prop.threshold) || 0);
}

// ### 7c --- portfolio-wide (G.Total) capacity: threshold = sum of every property's threshold (per-day overrides included), checked FIRST — when hit, every free listing across every property is blocked
async function globalCapacityBlock(env, apartments, arrival, departure) {
  if (!apartments.length) return null;
  const rows = (await env.DB.prepare(`SELECT m_arrival, m_departure FROM sim_bookings`).all()).results;
  const ovs = (await env.DB.prepare(`SELECT apartment_id, date, threshold_override FROM date_overrides WHERE date >= ? AND date < ? AND threshold_override IS NOT NULL`).bind(arrival, departure).all()).results;
  let hitDay = null, last = null;
  for (let d = arrival; d < departure; d = addDaysIso(d, 1)) {
    const count = rows.filter(r => r.m_arrival <= d && d < r.m_departure).length;
    const threshold = apartments.reduce((t, p) => t + effThreshold(p, ovs, d), 0);
    last = { count, threshold };
    if (threshold > 0 && count >= threshold) { hitDay = last; break; }
  }
  if (!hitDay) return Object.assign({ hit: false }, last);
  const count = hitDay.count, threshold = hitDay.threshold;

  const allIds = apartments.flatMap(a => a.listingIds || []);
  const occupied = await getOccupiedApartments(env, arrival, departure);
  const toBlock = allIds.filter(id => !occupied.has(Number(id)));
  const failed = await blockMany(env, toBlock, arrival, departure);
  const span = arrival + ' \u2192 ' + departure;
  if (failed.length) {
    const fg = groupByProperty(apartments, failed.map(f => f.id));
    await addAlert(env, 'error', 'G.Total block incomplete — ' + Object.keys(fg).join(', ') + ' still partly open', span + ' \u00b7 ' + failed.map(f => f.id + ' (HTTP ' + f.status + ')').join(', '), arrival);
    await sendTelegramAlert(env, '\u26a0\ufe0f G.Total block INCOMPLETE ' + span + ': ' + groupText(fg) + ' could not be blocked');
  }
  if (toBlock.length) {
    const g = groupByProperty(apartments, toBlock);
    await sendTelegramAlert(env, '\ud83d\udeab G.Total full (' + count + '/' + threshold + ') \u2014 all properties blocked ' + span + ': ' + Object.keys(g).join(', '));
    await addAlert(env, 'capacity', 'G.Total full (' + count + '/' + threshold + ') \u2014 all properties blocked', span + ' \u00b7 ' + groupText(g), arrival);
  }
  return { hit: true, count, threshold, blockedListings: toBlock };
}

async function testCapacityCheck(env, data) {
  if (data['is-blocked-booking'] === true) return { skipped: true, reason: 'Blocked period, not counted' };
  if (data.email === 'blocked@placeholder.local') return { skipped: true, reason: 'Our own synthetic block, not counted' };
  if (!data['guest-name']) return { skipped: true, reason: 'No guest name — likely test/incomplete data' };

  const listingId = String(data.apartment && data.apartment.id || '');
  const arrival = data.arrival, departure = data.departure;
  if (!listingId || !arrival || !departure) return { error: 'Missing listing/dates' };

  const metaRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'apartments'`).first();
  const apartments = metaRow ? JSON.parse(metaRow.value) : [];
  const prop = apartments.find(a => (a.listingIds || []).includes(listingId));
  if (!prop) return { hit: false, reason: 'Listing not mapped to any property' };

  const override = await env.DB.prepare(`SELECT threshold_override FROM date_overrides WHERE apartment_id = ? AND date = ?`).bind(prop.id, arrival).first();
  const threshold = override && override.threshold_override != null ? override.threshold_override : prop.threshold;
  const count = await getPropertyOccupancy(env, prop, arrival, departure);
  const hit = count >= threshold;

  if (hit) await sendTelegramAlert(env, '🧪 [SIMULATION] Capacity hit — ' + prop.name + ' (' + count + '/' + threshold + ') ' + arrival + ' to ' + departure + '. Would block: ' + prop.listingIds.join(', '));
  return { hit, property: prop.name, count, threshold, wouldBlockListings: prop.listingIds };
}

// ### 5b --- expenses (for profit = earnings - expenses)
async function getExpenses(env) {
  const res = await env.DB.prepare(`SELECT * FROM expenses ORDER BY date DESC`).all();
  return { success: true, expenses: res.results };
}
async function addExpense(env, data) {
  const id = data.id || crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO expenses (id, date, amount, description, property_id, created_at) VALUES (?, ?, ?, ?, ?, ?)`)
    .bind(id, data.date, Number(data.amount) || 0, data.description || '', data.property_id || '', new Date().toISOString()).run();
  return { success: true, id };
}
async function deleteExpense(env, id) {
  await env.DB.prepare(`DELETE FROM expenses WHERE id = ?`).bind(id).run();
  return { success: true, id };
}

// ### 6b --- telegram alert (bot token + chat id are Cloudflare secrets: TELEGRAM_BOT_TOKEN, TELEGRAM_CHAT_ID)
async function sendTelegramAlert(env, message) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text: message })
    });
  } catch (e) {}
}

// ### 6c --- record real Smoobu reservations into sim_bookings (id = smoobu-<id>) so the tracker shows them; existing rows are never overwritten
async function recordReservation(env, data) {
  if (!data.id || !data['guest-name'] || data['is-blocked-booking'] === true || data['guest-name'] === 'Blocked Period' || data.email === 'blocked@placeholder.local') return false;
  const earning = Math.max(0, (Number(data.price) || 0) - (Number(data['commission-included']) || 0));
  const a = data.apartment || {}, ap = String(a.id || '');
  const details = { contact: data.phone || '', note: '', guests: (Number(data.adults) || 0) + (Number(data.children) || 0) || '', price: earning };
  const res = await env.DB.prepare(
    `INSERT OR IGNORE INTO sim_bookings (id, reference_id, apartment_id, apartment_name, arrival, departure, guest_name, channel, m_arrival, m_departure, m_apartment_id, m_apartment_name, room_number, details, created_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
  ).bind('smoobu-' + data.id, data['reference-id'] || '', ap, a.name || '', data.arrival, data.departure, data['guest-name'], (data.channel && data.channel.name) || '', data.arrival, data.departure, ap, a.name || '', '', JSON.stringify(details), new Date().toISOString()).run();
  return res.meta.changes > 0;
}

async function syncLiveBookings(env, from, to) {
  const today = new Date().toISOString().slice(0, 10);
  const end = new Date(Date.now() + 90 * 86400000).toISOString().slice(0, 10);
  from = from || today; to = to || end;
  let added = 0, seen = 0, page = 1;
  while (page <= 10) {
    const res = await getBookings(env, { from, to, page });
    const body = res.body || {};
    for (const b of body.bookings || []) { seen++; if (await recordReservation(env, b)) added++; }
    if (!body.page_count || page >= body.page_count) break;
    page++;
  }
  return { success: true, from, to, seen, added };
}

// ### 6d --- alerts feed (meta key 'alerts', newest first, capped at 100): cancellation | modification | capacity | error
async function addAlert(env, type, title, detail, date, ref) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'alerts'`).first();
    const list = row ? JSON.parse(row.value) : [];
    list.unshift({ id: crypto.randomUUID(), type, title, detail: detail || '', date: date || '', ref: ref || '', ts: new Date().toISOString() });
    await setMeta(env, 'alerts', list.slice(0, 100));
  } catch (e) {}
}

async function replaceAlerts(env, type, title, detail, date) {
  try {
    const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'alerts'`).first();
    const list = (row ? JSON.parse(row.value) : []).filter(a => a.type !== type);
    if (title) list.unshift({ id: crypto.randomUUID(), type, title, detail: detail || '', date: date || '', ref: '', ts: new Date().toISOString() });
    await setMeta(env, 'alerts', list.slice(0, 100));
  } catch (e) {}
}

const MON3 = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
function fmtDay(iso) { return Number(iso.slice(8, 10)) + ' ' + MON3[Number(iso.slice(5, 7)) - 1]; }
function fmtRange(from, to) { return from === to ? fmtDay(from) : fmtDay(from) + '\u2013' + fmtDay(to); }
function summarize(ranges, suffix) {
  const by = {};
  ranges.forEach(x => (by[x.prop] = by[x.prop] || []).push(x));
  return Object.keys(by).map(n => n + ': ' + by[n].map(x => fmtRange(x.from, x.to)).join(', ') + (suffix ? ' ' + suffix(by[n]) : '')).join('\n');
}

async function getAlerts(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'alerts'`).first();
  return { success: true, alerts: row ? JSON.parse(row.value) : [] };
}

async function dismissAlert(env, id) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'alerts'`).first();
  const list = row ? JSON.parse(row.value) : [];
  await setMeta(env, 'alerts', id === 'all' ? [] : list.filter(a => a.id !== id));
  return { success: true };
}

// ### 6e --- cancelled bookings archive: a Smoobu cancellation removes the booking from the calendar but keeps a restorable copy
const SIM_COLS = ['id', 'reference_id', 'apartment_id', 'apartment_name', 'arrival', 'departure', 'guest_name', 'channel', 'm_arrival', 'm_departure', 'created_at', 'room_number', 'm_apartment_id', 'm_apartment_name', 'details'];

function ensureCancelledTable(env) {
  return env.DB.prepare(`CREATE TABLE IF NOT EXISTS cancelled_bookings (id TEXT PRIMARY KEY, row TEXT, cancelled_at TEXT)`).run();
}

async function archiveBooking(env, id) {
  await ensureCancelledTable(env);
  const row = await env.DB.prepare(`SELECT * FROM sim_bookings WHERE id = ?`).bind(id).first();
  if (!row) return false;
  await env.DB.prepare(`INSERT OR REPLACE INTO cancelled_bookings (id, row, cancelled_at) VALUES (?, ?, ?)`).bind(id, JSON.stringify(row), new Date().toISOString()).run();
  await env.DB.prepare(`DELETE FROM sim_bookings WHERE id = ?`).bind(id).run();
  return true;
}

async function getCancelledBookings(env) {
  await ensureCancelledTable(env);
  const res = await env.DB.prepare(`SELECT id, row, cancelled_at FROM cancelled_bookings ORDER BY cancelled_at DESC`).all();
  return { success: true, cancelled: res.results.map(r => ({ id: r.id, cancelled_at: r.cancelled_at, booking: JSON.parse(r.row) })) };
}

async function restoreBooking(env, id) {
  await ensureCancelledTable(env);
  const r = await env.DB.prepare(`SELECT row FROM cancelled_bookings WHERE id = ?`).bind(id).first();
  if (!r) return { success: false, error: 'Not in the cancelled archive' };
  const b = JSON.parse(r.row);
  await env.DB.prepare(`INSERT OR IGNORE INTO sim_bookings (${SIM_COLS.join(', ')}) VALUES (${SIM_COLS.map(() => '?').join(', ')})`).bind(...SIM_COLS.map(c => b[c] === undefined ? null : b[c])).run();
  await env.DB.prepare(`DELETE FROM cancelled_bookings WHERE id = ?`).bind(id).run();
  return { success: true, id };
}

// ### 6e2 --- our own deletes: after a booking is saved, remove it from Smoobu so the calendar opens online; the resulting cancel webhook is recognised and ignored (marker in details.smoobu_deleted_at, 1h window)
async function setDeleteMarker(env, rid, on) {
  const row = await env.DB.prepare(`SELECT details FROM sim_bookings WHERE id = ?`).bind(rid).first();
  if (!row) return false;
  const det = JSON.parse(row.details || '{}');
  if (on) det.smoobu_deleted_at = new Date().toISOString(); else delete det.smoobu_deleted_at;
  await env.DB.prepare(`UPDATE sim_bookings SET details = ? WHERE id = ?`).bind(JSON.stringify(det), rid).run();
  return true;
}

async function removeFromSmoobu(env, smoobuId) {
  const rid = 'smoobu-' + smoobuId;
  if (!(await setDeleteMarker(env, rid, true))) return false;
  const res = await smoobuRequest(env, 'DELETE', '/api/reservations/' + smoobuId, null, null);
  if (res.status >= 200 && res.status < 300) return true;
  await setDeleteMarker(env, rid, false);
  await addAlert(env, 'error', 'Could not delete booking ' + smoobuId + ' from Smoobu', 'HTTP ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 200), '');
  return false;
}

// ### 6e2a --- unblock on Smoobu: only ever deletes a reservation Smoobu itself confirms is a system-created block (guest 'Blocked Period' / placeholder email / is-blocked-booking) — never a real guest booking
async function unblockOnSmoobu(env, smoobuId) {
  if (!smoobuId) return { success: false, error: 'Missing id' };
  const check = await smoobuRequest(env, 'GET', '/api/reservations/' + smoobuId, null, null);
  if (check.status < 200 || check.status >= 300) return { success: false, error: 'Could not read reservation ' + smoobuId + ' (HTTP ' + check.status + ')' };
  const r = check.body || {};
  const isBlock = r['is-blocked-booking'] === true || r['guest-name'] === 'Blocked Period' || r.email === 'blocked@placeholder.local';
  if (!isBlock) return { success: false, error: 'Reservation ' + smoobuId + ' is not a system block — refusing to delete' };
  const res = await smoobuRequest(env, 'DELETE', '/api/reservations/' + smoobuId, null, null);
  if (res.status >= 200 && res.status < 300) return { success: true, id: smoobuId };
  return { success: false, error: 'HTTP ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 160) };
}

// ### 6e2b --- manual cancel-on-Smoobu: for a booking already in our DB that is still live on Smoobu (never auto-deleted, or predates that feature) — picked by choice from the Import Bookings "still live on Smoobu" list
async function cancelOnSmoobu(env, bookingId) {
  const rid = String(bookingId || '').startsWith('smoobu-') ? bookingId : 'smoobu-' + bookingId;
  const row = await env.DB.prepare(`SELECT id FROM sim_bookings WHERE id = ?`).bind(rid).first();
  if (!row) return { success: false, error: 'Not in our database: ' + rid };
  const smoobuId = rid.replace(/^smoobu-/, '');
  const ok = await removeFromSmoobu(env, smoobuId);
  return { success: ok, id: rid };
}

async function isOurOwnDelete(env, rid) {
  const row = await env.DB.prepare(`SELECT details FROM sim_bookings WHERE id = ?`).bind(rid).first();
  if (!row) return false;
  const at = JSON.parse(row.details || '{}').smoobu_deleted_at;
  return !!at && Date.now() - new Date(at).getTime() < 3600000;
}

// ### 6e3 --- real booking modification: unknown booking = treated as new; known booking = update our copy, re-run capacity, quietly re-delete from Smoobu
async function handleModification(env, data) {
  const rid = 'smoobu-' + data.id;
  const old = await env.DB.prepare(`SELECT * FROM sim_bookings WHERE id = ?`).bind(rid).first();
  if (!old) return handleSmoobuWebhook(env, data);
  const earning = Math.max(0, (Number(data.price) || 0) - (Number(data['commission-included']) || 0));
  const ap = String((data.apartment && data.apartment.id) || ''), an = (data.apartment && data.apartment.name) || '';
  const untouched = old.m_arrival === old.arrival && old.m_departure === old.departure && old.m_apartment_id === old.apartment_id;
  const det = JSON.parse(old.details || '{}');
  det.price = earning;
  const guests = (Number(data.adults) || 0) + (Number(data.children) || 0);
  if (guests) det.guests = guests;
  const mArr = untouched ? data.arrival : old.m_arrival, mDep = untouched ? data.departure : old.m_departure;
  const mAp = untouched ? ap : old.m_apartment_id, mAn = untouched ? an : old.m_apartment_name;
  await env.DB.prepare(`UPDATE sim_bookings SET arrival = ?, departure = ?, apartment_id = ?, apartment_name = ?, m_arrival = ?, m_departure = ?, m_apartment_id = ?, m_apartment_name = ?, guest_name = ?, details = ? WHERE id = ?`)
    .bind(data.arrival, data.departure, ap, an, mArr, mDep, mAp, mAn, data['guest-name'] || old.guest_name, JSON.stringify(det), rid).run();
  const moved = old.arrival !== data.arrival || old.departure !== data.departure || old.apartment_id !== ap;
  await addAlert(env, 'modification', 'Modified: ' + (data['guest-name'] || old.guest_name) + ' (' + an + ')', moved ? old.arrival + ' → ' + old.departure + ' (' + old.apartment_name + ')  became  ' + data.arrival + ' → ' + data.departure + ' (' + an + ')' + (untouched ? '' : ' — your manual edits on the calendar were kept') : 'price/details updated', data.arrival);
  let deleted = false;
  try {
    await setDeleteMarker(env, rid, true);
    const res = await smoobuRequest(env, 'DELETE', '/api/reservations/' + data.id, null, null);
    deleted = res.status >= 200 && res.status < 300;
    if (!deleted && res.status !== 404) { await setDeleteMarker(env, rid, false); await addAlert(env, 'error', 'Could not delete modified booking ' + data.id + ' from Smoobu', 'HTTP ' + res.status, ''); }
  } catch (e) {}
  if (!moved) return { modified: true, deleted };
  return { modified: true, capacity: await capacityBlock(env, data, earning, deleted) };
}

// ### 6f --- reservation changes from Smoobu: cancellation archives the booking (restorable) + alerts; modification updates our copy
async function handleReservationChange(env, action, data) {
  if (!data.id || data['is-blocked-booking'] === true || data.email === 'blocked@placeholder.local' || data['guest-name'] === 'Blocked Period') return { skipped: true };
  const guest = data['guest-name'] || ('#' + data.id), unit = (data.apartment && data.apartment.name) || '';
  const span = (data.arrival || '') + ' → ' + (data.departure || '');
  if (action === 'updateReservation') {
    if (data.type === 'cancellation') return handleReservationChange(env, 'cancelReservation', data);
    if (await isOurOwnDelete(env, 'smoobu-' + data.id)) return { ignored: 'our own delete' };
    return handleModification(env, data);
  }
  const rid = 'smoobu-' + data.id;
  if (await isOurOwnDelete(env, rid)) return { ignored: 'our own delete' };
  const archived = await archiveBooking(env, rid);
  await addAlert(env, 'cancellation', 'Cancelled in Smoobu: ' + guest + ' (' + unit + ')', span + (archived ? ' — removed from the calendar, restorable' : ' — was not in our database'), data.arrival, archived ? rid : '');
  return { cancelled: archived };
}

// ### 7 --- real Smoobu webhook handler — LIVE: calls blockDates for real when a property's threshold is hit
async function handleSmoobuWebhook(env, data) {
  if (data['is-blocked-booking'] === true) return { skipped: true, reason: 'Blocked period, not counted' };
  if (data.email === 'blocked@placeholder.local') return { skipped: true, reason: 'Our own synthetic block, not counted' };
  if (!data['guest-name']) return { skipped: true, reason: 'No guest name — likely test/incomplete data' };

  const earning = Math.max(0, (Number(data.price) || 0) - (Number(data['commission-included']) || 0));
  let deleted = false;
  try { await recordReservation(env, data); deleted = await removeFromSmoobu(env, data.id); } catch (e) { await addAlert(env, 'error', 'Save/delete failed for booking ' + data.id, e.message, ''); }
  return capacityBlock(env, data, earning, deleted);
}

// ### 7b --- capacity decision from our DB + live blocking on Smoobu (shared by new reservations and modifications)
async function capacityBlock(env, data, earning, deleted) {
  const listingId = String(data.apartment && data.apartment.id || '');
  const arrival = data.arrival, departure = data.departure;
  if (!listingId || !arrival || !departure) return { error: 'Missing listing/dates' };

  const metaRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'apartments'`).first();
  const apartments = metaRow ? JSON.parse(metaRow.value) : [];
  const prop = apartments.find(a => (a.listingIds || []).includes(listingId));
  const st = await getAuditSettings(env);
  const doProperty = async () => {
    if (!prop) return { blocked: false, reason: 'Listing not mapped to any property' };
    if (!st.blockProperty) return { blocked: false, property: prop.name, reason: 'Per-property blocking is switched off in settings' };
    const override = await env.DB.prepare(`SELECT threshold_override FROM date_overrides WHERE apartment_id = ? AND date = ?`).bind(prop.id, arrival).first();
    const threshold = override && override.threshold_override != null ? override.threshold_override : prop.threshold;
    const count = await getPropertyOccupancy(env, prop, arrival, departure);
    if (count < threshold) return { blocked: false, property: prop.name, count, threshold };

    const occupied = await getOccupiedApartments(env, arrival, departure);
    const toBlock = prop.listingIds.filter(id => !occupied.has(Number(id)));
    const failed = await blockMany(env, toBlock, arrival, departure);
    const span = arrival + ' \u2192 ' + departure;
    if (failed.length) {
      await addAlert(env, 'error', 'Block incomplete: ' + prop.name + ' \u2014 ' + failed.length + ' of ' + toBlock.length + ' listing(s) still open', span + ' \u00b7 ' + failed.map(f => f.id + ' (HTTP ' + f.status + ')').join(', '), arrival);
      await sendTelegramAlert(env, '\u26a0\ufe0f ' + prop.name + ' block INCOMPLETE ' + span + ' (' + failed.length + ' of ' + toBlock.length + ' listings failed)');
    }
    if (toBlock.length) await sendTelegramAlert(env, '\ud83d\udeab ' + prop.name + ' full (' + count + '/' + threshold + ') \u2014 blocked ' + span);
    await addAlert(env, 'capacity', 'Capacity hit: ' + prop.name + ' (' + count + '/' + threshold + ') \u2014 property blocked', span + ' \u00b7 ' + (toBlock.length - failed.length) + ' of ' + toBlock.length + ' listing(s) closed', arrival);
    return { blocked: true, property: prop.name, count, threshold, blockedListings: toBlock };
  };
  const global = st.blockTotal ? await globalCapacityBlock(env, apartments, arrival, departure) : null;
  if (global && global.hit) return { blocked: true, earning, deleted, global };
  return Object.assign({ earning, deleted, global }, await doProperty());
}

// ### 10 --- capacity audit (cron every 15 min + on demand): capacity hit in our DB but a listing still open on Smoobu = overbooking risk; open/closed comes from Smoobu's rates endpoint (one call for all listings)
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function getAuditSettings(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'audit_settings'`).first();
  const st = Object.assign({ autoBlock: false, days: 60 }, row ? JSON.parse(row.value) : {});
  if (typeof st.blockProperty !== 'boolean') st.blockProperty = true;
  if (typeof st.blockTotal !== 'boolean') st.blockTotal = st.globalMode !== 'off';
  return st;
}

async function smoobuAvailability(env, ids, from, to) {
  const open = {};
  for (let k = 0; k < ids.length; k += 20) {
    const params = { start_date: from, end_date: to };
    ids.slice(k, k + 20).forEach((id, n) => { params['apartments%5B' + n + '%5D'] = id; });
    const res = await getRates(env, params);
    if (res.status !== 200) throw new Error('Smoobu rates HTTP ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 120));
    const data = (res.body && res.body.data) || {};
    Object.keys(data).forEach(lid => {
      const set = open[lid] || (open[lid] = new Set());
      Object.keys(data[lid]).forEach(d => { if (data[lid][d].available === 1) set.add(d); });
    });
  }
  return open;
}

async function smoobuOurBlocks(env, from, to, blocksOut) {
  const ours = {};
  for (let page = 1; page <= 15; page++) {
    const res = await getBookings(env, { from, to, page, pageSize: 100 });
    const body = res.body || {};
    (body.bookings || []).forEach(b => {
      if (b.type === 'cancellation' || !b.apartment) return;
      if (b['guest-name'] !== 'Blocked Period' && b.email !== 'blocked@placeholder.local') return;
      const set = ours[String(b.apartment.id)] || (ours[String(b.apartment.id)] = new Set());
      for (let d = b.arrival; d < b.departure; d = addDaysIso(d, 1)) set.add(d);
      if (blocksOut) (blocksOut[String(b.apartment.id)] = blocksOut[String(b.apartment.id)] || []).push({ id: String(b.id), from: b.arrival, to: b.departure });
    });
    if (!body.page_count || page >= body.page_count) break;
  }
  return ours;
}

function dateRanges(dates) {
  const out = [];
  let from = dates[0], prev = from;
  dates.slice(1).forEach(d => { if (d === addDaysIso(prev, 1)) prev = d; else { out.push({ from, to: prev }); from = d; prev = d; } });
  out.push({ from, to: prev });
  return out;
}

async function runAudit(env) {
  const st = await getAuditSettings(env);
  const days = Math.min(120, Math.max(1, Number(st.days) || 60));
  const today = new Date().toISOString().slice(0, 10), end = addDaysIso(today, days);
  const metaRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'apartments'`).first();
  const apartments = metaRow ? JSON.parse(metaRow.value) : [];
  const bk = (await env.DB.prepare(`SELECT m_apartment_id, m_arrival, m_departure FROM sim_bookings WHERE m_departure > ? AND m_arrival < ?`).bind(today, end).all()).results;
  const ov = (await env.DB.prepare(`SELECT apartment_id, date, threshold_override FROM date_overrides WHERE threshold_override IS NOT NULL`).all()).results;
  const avail = await smoobuAvailability(env, apartments.flatMap(a => (a.listingIds || []).map(String)), today, addDaysIso(end, -1));
  let ours = {};
  const blocksBy = {};
  try { ours = await smoobuOurBlocks(env, today, end, blocksBy); } catch (e) {}
  const globalHit = new Set();
  for (let d = today; d < end; d = addDaysIso(d, 1)) {
    const total = bk.filter(b => b.m_arrival <= d && d < b.m_departure).length;
    const sum = apartments.reduce((t, p) => t + effThreshold(p, ov, d), 0);
    if (st.blockTotal && sum > 0 && total >= sum) globalHit.add(d);
  }
  const risks = [], stucks = [];
  const pack = (prop, by) => {
    const dates = Object.keys(by).sort();
    if (!dates.length) return [];
    return dateRanges(dates).map(g => {
      const inR = dates.filter(d => d >= g.from && d <= g.to), per = {};
      inR.forEach(d => by[d].forEach(lid => (per[lid] = per[lid] || []).push(d)));
      const items = [];
      Object.keys(per).forEach(lid => dateRanges(per[lid]).forEach(x => items.push({ lid, from: x.from, to: x.to })));
      return { prop: prop.name, propId: prop.id, from: g.from, to: g.to, nights: inR.length, listings: Object.keys(per).length, items };
    });
  };
  for (const prop of apartments) {
    const ids = (prop.listingIds || []).map(String);
    const openBy = {}, stuckBy = {};
    for (let d = today; d < end; d = addDaysIso(d, 1)) {
      const count = bk.filter(b => ids.includes(String(b.m_apartment_id)) && b.m_arrival <= d && d < b.m_departure).length;
      const th = effThreshold(prop, ov, d);
      if (!((st.blockProperty && count >= th) || globalHit.has(d))) {
        const sl = ids.filter(lid => ours[lid] && ours[lid].has(d));
        if (sl.length) stuckBy[d] = sl;
        continue;
      }
      const ol = ids.filter(lid => avail[lid] && avail[lid].has(d));
      if (ol.length) openBy[d] = ol;
    }
    pack(prop, openBy).forEach(x => risks.push(x));
    pack(prop, stuckBy).forEach(x => {
      const sid = new Set();
      x.blocks = [];
      x.items.forEach(it => (blocksBy[it.lid] || []).forEach(bl => {
        if (bl.from < addDaysIso(it.to, 1) && bl.to > it.from && !sid.has(bl.id)) { sid.add(bl.id); x.blocks.push({ id: bl.id, lid: it.lid, from: bl.from, to: bl.to }); }
      }));
      stucks.push(x);
    });
  }
  const stRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'audit_state'`).first();
  const seen = new Set(stRow ? JSON.parse(stRow.value) : []);
  const keep = [];
  let blocked = 0;
  const rkKey = rk => 'P|' + rk.propId + '|' + rk.from + '|' + rk.to;
  let openLeft = risks;
  if (st.autoBlock && risks.length) {
    const done = [], bad = [];
    for (const rk of risks) {
      let okAll = true;
      const fails = [];
      for (const it of rk.items) {
        const res = await blockDates(env, it.lid, it.from, addDaysIso(it.to, 1));
        if (res.status >= 200 && res.status < 300) blocked++;
        else { okAll = false; fails.push(it.lid + ' HTTP ' + res.status + ' ' + String((res.body && (res.body.detail || res.body.title)) || '').slice(0, 60)); }
      }
      if (okAll) done.push(rk); else bad.push(Object.assign({ fails }, rk));
    }
    if (done.length) {
      await addAlert(env, 'capacity', 'Audit auto-blocked ' + done.length + ' date range(s)', summarize(done), done[0].from);
      await sendTelegramAlert(env, '\ud83d\udee0 Audit auto-blocked (properties were full but open):\n' + summarize(done));
    }
    if (bad.length) {
      const fresh = bad.filter(rk => !seen.has(rkKey(rk)));
      bad.forEach(rk => keep.push(rkKey(rk)));
      if (fresh.length) {
        await addAlert(env, 'error', 'Audit could not fully block ' + bad.length + ' date range(s)', bad.map(rk => rk.prop + ' ' + fmtRange(rk.from, rk.to) + ' \u2014 ' + rk.fails.join('; ')).join('\n'), bad[0].from);
        await sendTelegramAlert(env, '\u26a0\ufe0f Auto-block FAILED \u2014 still OPEN on Smoobu:\n' + summarize(bad));
      }
    }
    openLeft = bad;
    await replaceAlerts(env, 'risk', null);
  } else {
    risks.forEach(rk => keep.push(rkKey(rk)));
    if (risks.length) {
      const nProps = new Set(risks.map(x => x.prop)).size;
      await replaceAlerts(env, 'risk', 'Capacity full but open on Smoobu \u2014 ' + nProps + ' propert' + (nProps > 1 ? 'ies' : 'y') + ', ' + risks.length + ' date range(s)', summarize(risks, g => '(' + Math.max.apply(null, g.map(x => x.listings)) + ' listings open)') + '\nBlock them, or turn on auto-block in Settings.', risks[0].from);
      if (risks.some(rk => !seen.has(rkKey(rk)))) await sendTelegramAlert(env, '\u26a0\ufe0f Capacity full but OPEN on Smoobu:\n' + summarize(risks));
    } else await replaceAlerts(env, 'risk', null);
  }
  stucks.forEach(sk => keep.push('S|' + sk.propId + '|' + sk.from + '|' + sk.to));
  if (stucks.length) {
    await replaceAlerts(env, 'stuck', 'Stuck blocks \u2014 under capacity but still blocked: ' + stucks.length + ' date range(s)', summarize(stucks) + '\nUnblock them if that is not intended.', stucks[0].from);
    if (stucks.some(sk => !seen.has('S|' + sk.propId + '|' + sk.from + '|' + sk.to))) await sendTelegramAlert(env, '\ud83d\udd12 Under capacity but still blocked:\n' + summarize(stucks));
  } else await replaceAlerts(env, 'stuck', null);
  await setMeta(env, 'audit_state', keep);
  await setMeta(env, 'audit_snapshot', { generated_at: new Date().toISOString(), risks, stucks });
  return { success: true, from: today, to: end, risks: openLeft.length, stuck: stucks.length, blocked, autoBlock: !!st.autoBlock };
}

async function getAuditSnapshot(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'audit_snapshot'`).first();
  return { success: true, snapshot: row ? JSON.parse(row.value) : { generated_at: null, risks: [], stucks: [] } };
}

// ### 10b --- direct-site booking recorded in sim_bookings by the direct-site worker: run the capacity decision, and keep the property's whole-property listing (if any) blocked while a room is taken
async function directBooked(env, data) {
  const ids = (data.listingIds || []).map(String), arrival = data.arrival, departure = data.departure;
  if (!ids.length || !arrival || !departure) return { error: 'Missing listing/dates' };
  const res = await capacityBlock(env, { apartment: { id: ids[0] }, arrival, departure }, 0, false);
  if (res.error) return res;
  const metaRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'apartments'`).first();
  const prop = (metaRow ? JSON.parse(metaRow.value) : []).find(a => (a.listingIds || []).map(String).includes(ids[0]));
  const row = prop ? await env.DB.prepare(`SELECT whole_listing_id FROM site_content WHERE property_id = ?`).bind(prop.id).first().catch(() => null) : null;
  const wl = row && row.whole_listing_id ? String(row.whole_listing_id) : '';
  if (wl && !ids.includes(wl) && !(res.blockedListings || []).includes(wl)) {
    const occupied = await getOccupiedApartments(env, arrival, departure);
    if (!occupied.has(Number(wl))) {
      const b = await blockDates(env, wl, arrival, departure);
      if (!(b.status >= 200 && b.status < 300)) {
        await addAlert(env, 'error', 'Whole-property block failed (listing ' + wl + ')', 'HTTP ' + b.status + ' — ' + arrival + ' → ' + departure, arrival);
        await sendTelegramAlert(env, '⚠️ Whole-property listing ' + wl + ' block FAILED ' + arrival + ' to ' + departure);
        res.wholeBlockFailed = true;
      } else res.wholeBlocked = wl;
    }
  }
  return res;
}

// ### 8 --- response helper
function jsonResponse(obj, status = 200) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: {
      'Content-Type': 'application/json',
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type'
    }
  });
}

// ### 9 --- fetch handler
export default {
  async scheduled(event, env, ctx) {
    if (event.cron === '0 * * * *' || event.cron === '0 3 * * *') {
      const near = event.cron === '0 * * * *';
      ctx.waitUntil(runPricing(env, pricingDeps(env), { scope: near ? 'near' : 'far', trigger: near ? 'hourly' : 'daily', forceDry: false }).catch(e => addAlert(env, 'error', 'Pricing run failed', e.message, '')));
      return;
    }
    ctx.waitUntil(runAudit(env).catch(e => addAlert(env, 'error', 'Capacity audit failed', e.message, '')));
  },
  async fetch(request, env, ctx) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: {
          'Access-Control-Allow-Origin': '*',
          'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
          'Access-Control-Allow-Headers': 'Content-Type'
        }
      });
    }
    let curAction = '';
    try {
      if (request.method === 'GET') {
        const action = new URL(request.url).searchParams.get('action');
        if (action === 'getSimBookings') return jsonResponse(await getSimBookings(env));
        if (action === 'getApartments') return jsonResponse(await getApartments(env));
        return jsonResponse({ error: 'Unknown or missing action' });
      }

      if (request.method === 'POST') {
        const payload = await request.json();
        curAction = payload.action;
        const action = payload.action;
        let result;
        if (action === 'getSimBookings') result = await getSimBookings(env);
        else if (action === 'addSimBooking') result = await addSimBooking(env, payload);
        else if (action === 'updateSimBooking') result = await updateSimBooking(env, payload.id, payload);
        else if (action === 'deleteSimBooking') result = await deleteSimBooking(env, payload.id);
        else if (action === 'getMeta') result = await getMeta(env, payload.key);
        else if (action === 'setMeta') result = await setMeta(env, payload.key, payload.value);
        else if (action === 'getApartments') result = await getApartments(env);
        else if (action === 'getBookings') result = await getBookings(env, payload.params || {});
        else if (action === 'directBooked') result = await directBooked(env, payload);
        else if (action === 'getApartmentDetail') result = await smoobuRequest(env, 'GET', '/api/apartments/' + encodeURIComponent(String(payload.id || '')), null, null);
        else if (action === 'updateReservation' || action === 'cancelReservation' || action === 'deleteReservation') result = await handleReservationChange(env, action, payload.data || {});
        else if (action === 'getCancelledBookings') result = await getCancelledBookings(env);
        else if (action === 'restoreBooking') result = await restoreBooking(env, payload.id);
        else if (action === 'getRates') result = await getRates(env, payload.params || {});
        else if (action === 'runAudit') result = await runAudit(env);
        else if (action === 'cancelOnSmoobu') result = await cancelOnSmoobu(env, payload.id);
        else if (action === 'unblockOnSmoobu') result = await unblockOnSmoobu(env, payload.id);
        else if (action === 'getAuditSnapshot') result = await getAuditSnapshot(env);
        else if (action === 'getAlerts') result = await getAlerts(env);
        else if (action === 'dismissAlert') result = await dismissAlert(env, payload.id);
        else if (action === 'syncLiveBookings') result = await syncLiveBookings(env, payload.from, payload.to);
        else if (action === 'blockDates') result = await blockDates(env, payload.apartmentId, payload.arrivalDate, payload.departureDate);
        else if (action === 'setRate') result = await setRate(env, payload.apartmentId, payload.from, payload.to, payload.price);
        else if (action === 'getDateOverrides') result = await getDateOverrides(env);
        else if (action === 'setThresholdRange') result = await setThresholdRange(env, payload.apartment_id, payload.from, payload.to, payload.threshold);
        else if (action === 'clearThresholdOverrides') result = await clearThresholdOverrides(env, payload.date);
        else if (action === 'setDateOverride') result = await setDateOverride(env, payload.apartment_id, payload.date, payload.threshold_override, payload.notes);
        else if (action === 'testCapacityCheck') result = await testCapacityCheck(env, payload.data || {});
        else if (action === 'newReservation') result = await handleSmoobuWebhook(env, payload.data || {});
        else if (action === 'getExpenses') result = await getExpenses(env);
        else if (action === 'addExpense') result = await addExpense(env, payload);
        else if (action === 'deleteExpense') result = await deleteExpense(env, payload.id);
        else if (action === 'snapshotSmoobuRates') result = await snapshotRates(env, payload, getRates);
        else if (action === 'runPricing') result = await runPricing(env, pricingDeps(env), { scope: payload.scope || 'all', apartmentId: payload.apartmentId, forceDry: payload.forceDry !== false, preview: !!payload.preview, draft: payload.draft || null, trigger: 'manual' });
        else if (action === 'getPricingStatus') result = await getPricingStatus(env);
        else if (simActions[action]) result = await simActions[action](env, payload);
        else result = { error: 'Unknown or missing action' };
        if (PRICE_TRIGGERS.has(action) && result && !result.error) ctx.waitUntil(priceAfterBooking(env, pricingDeps(env), listingOf(payload)).catch(() => {}));
        if (GMAIL_TRIGGERS.has(action) && env.GMAIL && result && !result.error) ctx.waitUntil(Promise.resolve().then(() => env.GMAIL.sync()).catch(() => {}));
        return jsonResponse(result);
      }

      return jsonResponse({ error: 'Method not allowed' }, 405);
    } catch (err) {
      await addAlert(env, 'error', 'Internal error' + (curAction ? ' in ' + curAction : ''), err.message, '');
      return jsonResponse({ error: err.message }, 500);
    }
  }
};
