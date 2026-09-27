import simActions from './pricing/sim.js';
import snapshotRates from './pricing/snapshot.js';

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
  if (!prop) return { blocked: false, earning, deleted, reason: 'Listing not mapped to any property' };

  const override = await env.DB.prepare(`SELECT threshold_override FROM date_overrides WHERE apartment_id = ? AND date = ?`).bind(prop.id, arrival).first();
  const threshold = override && override.threshold_override != null ? override.threshold_override : prop.threshold;

  const count = await getPropertyOccupancy(env, prop, arrival, departure);
  if (count < threshold) return { blocked: false, earning, deleted, property: prop.name, count, threshold };

  const occupied = await getOccupiedApartments(env, arrival, departure);
  const toBlock = prop.listingIds.filter(id => !occupied.has(Number(id)));
  const failed = [];
  for (const id of toBlock) {
    const res = await blockDates(env, id, arrival, departure);
    if (!(res.status >= 200 && res.status < 300)) failed.push(id + ' (HTTP ' + res.status + ')');
  }
  if (failed.length) {
    await addAlert(env, 'error', 'Block failed: ' + prop.name + ' — ' + failed.length + ' listing(s) still open', failed.join(', ') + ' — ' + arrival + ' → ' + departure, arrival);
    await sendTelegramAlert(env, '⚠️ Block FAILED for ' + prop.name + ': ' + failed.join(', ') + ' ' + arrival + ' to ' + departure);
  }
  if (toBlock.length) await sendTelegramAlert(env, '🚫 Capacity hit — ' + prop.name + ' (' + count + '/' + threshold + ') ' + arrival + ' to ' + departure + '. Blocked: ' + toBlock.join(', ') + (failed.length ? ' (failed: ' + failed.join(', ') + ')' : ''));
  await addAlert(env, 'capacity', 'Capacity hit: ' + prop.name + ' (' + count + '/' + threshold + ')', 'Blocked ' + toBlock.length + ' listing(s) ' + arrival + ' → ' + departure, arrival);
  return { blocked: true, earning, deleted, property: prop.name, count, threshold, blockedListings: toBlock };
}

// ### 10 --- capacity audit (cron every 15 min + on demand): capacity hit in our DB but a listing still open on Smoobu = overbooking risk; open/closed comes from Smoobu's rates endpoint (one call for all listings)
function addDaysIso(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

async function getAuditSettings(env) {
  const row = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'audit_settings'`).first();
  return Object.assign({ autoBlock: false, days: 60 }, row ? JSON.parse(row.value) : {});
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

async function smoobuOurBlocks(env, from, to) {
  const ours = {};
  for (let page = 1; page <= 15; page++) {
    const res = await getBookings(env, { from, to, page, pageSize: 100 });
    const body = res.body || {};
    (body.bookings || []).forEach(b => {
      if (b.type === 'cancellation' || !b.apartment) return;
      if (b['guest-name'] !== 'Blocked Period' && b.email !== 'blocked@placeholder.local') return;
      const set = ours[String(b.apartment.id)] || (ours[String(b.apartment.id)] = new Set());
      for (let d = b.arrival; d < b.departure; d = addDaysIso(d, 1)) set.add(d);
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
  try { ours = await smoobuOurBlocks(env, today, end); } catch (e) {}
  const risks = [], stucks = [];
  for (const prop of apartments) {
    const ids = (prop.listingIds || []).map(String);
    const open = {}, stuckD = {};
    for (let d = today; d < end; d = addDaysIso(d, 1)) {
      const count = bk.filter(b => ids.includes(String(b.m_apartment_id)) && b.m_arrival <= d && d < b.m_departure).length;
      const o = ov.find(x => x.apartment_id === prop.id && x.date === d);
      const th = o ? o.threshold_override : prop.threshold;
      if (count < th) { ids.forEach(lid => { if (ours[lid] && ours[lid].has(d)) (stuckD[lid] = stuckD[lid] || []).push(d); }); continue; }
      ids.forEach(lid => { if (avail[lid] && avail[lid].has(d)) (open[lid] = open[lid] || []).push(d); });
    }
    Object.keys(open).forEach(lid => {
      let from = open[lid][0], prev = from;
      const flush = () => risks.push({ prop: prop.name, lid, from, to: prev });
      open[lid].slice(1).forEach(d => { if (d === addDaysIso(prev, 1)) prev = d; else { flush(); from = d; prev = d; } });
      flush();
    });
    Object.keys(stuckD).forEach(lid => dateRanges(stuckD[lid]).forEach(g => stucks.push({ prop: prop.name, lid, from: g.from, to: g.to })));
  }
  const stRow = await env.DB.prepare(`SELECT value FROM meta WHERE key = 'audit_state'`).first();
  const seen = new Set(stRow ? JSON.parse(stRow.value) : []);
  const keep = [];
  let blocked = 0;
  for (const rk of risks) {
    const key = rk.lid + '|' + rk.from + '|' + rk.to, label = rk.prop + ' (listing ' + rk.lid + ') ' + rk.from + ' → ' + rk.to;
    if (st.autoBlock) {
      const res = await blockDates(env, rk.lid, rk.from, addDaysIso(rk.to, 1));
      if (res.status >= 200 && res.status < 300) {
        blocked++;
        await addAlert(env, 'capacity', 'Audit auto-blocked: ' + rk.prop + ' (listing ' + rk.lid + ')', 'Capacity was hit but the listing was open on Smoobu ' + rk.from + ' → ' + rk.to, rk.from);
        await sendTelegramAlert(env, '🛠 Audit auto-blocked ' + label);
        continue;
      }
      keep.push(key);
      if (!seen.has(key)) {
        await addAlert(env, 'error', 'Audit could not block ' + rk.prop + ' (listing ' + rk.lid + ')', 'HTTP ' + res.status + ' ' + JSON.stringify(res.body).slice(0, 160) + ' — ' + rk.from + ' → ' + rk.to, rk.from);
        await sendTelegramAlert(env, '⚠️ Audit could NOT block ' + label);
      }
      continue;
    }
    keep.push(key);
    if (!seen.has(key)) {
      await addAlert(env, 'risk', 'Capacity full but open on Smoobu: ' + rk.prop + ' (listing ' + rk.lid + ')', rk.from + ' → ' + rk.to + ' — block it, or turn on auto-block in Settings', rk.from);
      await sendTelegramAlert(env, '⚠️ Capacity full but OPEN on Smoobu: ' + label);
    }
  }
  for (const sk of stucks) {
    const key = 'S|' + sk.lid + '|' + sk.from + '|' + sk.to;
    keep.push(key);
    if (seen.has(key)) continue;
    await addAlert(env, 'stuck', 'Stuck block: ' + sk.prop + ' (listing ' + sk.lid + ')', 'Under capacity in our database but still blocked on Smoobu ' + sk.from + ' → ' + sk.to + ' — unblock it in Smoobu if it is not intended', sk.from);
    await sendTelegramAlert(env, '🔒 Stuck block (under capacity but blocked): ' + sk.prop + ' listing ' + sk.lid + ' ' + sk.from + ' to ' + sk.to);
  }
  await setMeta(env, 'audit_state', keep);
  return { success: true, from: today, to: end, risks: risks.length, stuck: stucks.length, blocked, autoBlock: !!st.autoBlock };
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
    ctx.waitUntil(runAudit(env).catch(e => addAlert(env, 'error', 'Capacity audit failed', e.message, '')));
  },
  async fetch(request, env) {
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
        else if (action === 'updateReservation' || action === 'cancelReservation' || action === 'deleteReservation') result = await handleReservationChange(env, action, payload.data || {});
        else if (action === 'getCancelledBookings') result = await getCancelledBookings(env);
        else if (action === 'restoreBooking') result = await restoreBooking(env, payload.id);
        else if (action === 'getRates') result = await getRates(env, payload.params || {});
        else if (action === 'runAudit') result = await runAudit(env);
        else if (action === 'getAlerts') result = await getAlerts(env);
        else if (action === 'dismissAlert') result = await dismissAlert(env, payload.id);
        else if (action === 'syncLiveBookings') result = await syncLiveBookings(env, payload.from, payload.to);
        else if (action === 'setRate') result = await setRate(env, payload.apartmentId, payload.from, payload.to, payload.price);
        else if (action === 'getDateOverrides') result = await getDateOverrides(env);
        else if (action === 'setDateOverride') result = await setDateOverride(env, payload.apartment_id, payload.date, payload.threshold_override, payload.notes);
        else if (action === 'testCapacityCheck') result = await testCapacityCheck(env, payload.data || {});
        else if (action === 'newReservation') result = await handleSmoobuWebhook(env, payload.data || {});
        else if (action === 'getExpenses') result = await getExpenses(env);
        else if (action === 'addExpense') result = await addExpense(env, payload);
        else if (action === 'deleteExpense') result = await deleteExpense(env, payload.id);
        else if (action === 'snapshotSmoobuRates') result = await snapshotRates(env, payload, getRates);
        else if (simActions[action]) result = await simActions[action](env, payload);
        else result = { error: 'Unknown or missing action' };
        return jsonResponse(result);
      }

      return jsonResponse({ error: 'Method not allowed' }, 405);
    } catch (err) {
      await addAlert(env, 'error', 'Internal error' + (curAction ? ' in ' + curAction : ''), err.message, '');
      return jsonResponse({ error: err.message }, 500);
    }
  }
};
