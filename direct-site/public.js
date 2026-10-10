// ### 1 --- smoobu access via service binding, settings, properties
const SETTING_DEFAULTS = { hold_minutes: 15, currency: 'GBP', site_name: 'Kazija', site_url: 'https://book.kazija.com', email_from: 'bookings@kazija.com', email_reply_to: '' };

export async function smoobu(env, payload) {
  const r = await env.SMOOBU.fetch('https://smoobu-proxy-v2/', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
  return r.json();
}

async function metaGet(env, key) {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first();
  return r ? JSON.parse(r.value) : null;
}

export async function getSettings(env) {
  return Object.assign({}, SETTING_DEFAULTS, await metaGet(env, 'direct_settings') || {});
}

function parseRow(r) {
  return Object.assign({}, r, { refund_rules: JSON.parse(r.refund_rules), room_content: JSON.parse(r.room_content), photos: JSON.parse(r.photo_keys) });
}

export async function loadProperties(env) {
  const apts = (await metaGet(env, 'apartments')) || [];
  const rows = (await env.DB.prepare(`SELECT * FROM site_content WHERE is_public = 1`).all()).results;
  const out = [];
  apts.forEach(p => { const r = rows.find(x => x.property_id === p.id); if (r) out.push({ p, r: parseRow(r) }); });
  return out;
}

export async function loadBySlug(env, slug) {
  return (await loadProperties(env)).find(x => x.r.slug === slug) || null;
}

export function roomIds(p, r) {
  return (p.listingIds || []).map(String).filter(id => id !== r.whole_listing_id);
}

// ### 2 --- apartment facts (cached in meta for 12h)
function normFacts(b) {
  const loc = b.location || b, rm = b.rooms || b, eq = b.equipments || b.amenities || [];
  return { name: b.name || '', maxOccupancy: Number(rm.maxOccupancy) || null, bedrooms: Number(rm.bedrooms) || null, bathrooms: Number(rm.bathrooms) || null, amenities: Array.isArray(eq) ? eq.map(x => typeof x === 'string' ? x : (x.name || '')).filter(Boolean) : [], street: loc.street || '', zip: loc.zip || '', city: loc.city || '', country: loc.country || '', lat: Number(loc.latitude) || null, lng: Number(loc.longitude) || null, priceMin: b.price && Number(b.price.minimal) || null };
}

export async function getFacts(env, ids) {
  const cache = (await metaGet(env, 'direct_facts')) || {};
  const now = Date.now();
  let dirty = false, calls = 0;
  for (const id of ids) {
    const c = cache[id];
    if (c && now - c.t < 12 * 3600000) continue;
    if (calls >= 10) break;
    calls++;
    try {
      const j = await smoobu(env, { action: 'getApartmentDetail', id });
      if (j.status === 200 && j.body) { cache[id] = { t: now, d: normFacts(j.body) }; dirty = true; }
    } catch (e) {}
  }
  if (dirty) await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('direct_facts', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(cache)).run();
  const out = {};
  ids.forEach(id => { out[id] = cache[id] ? cache[id].d : null; });
  return out;
}

// ### 3 --- dates and rates
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}

export function nightsBetween(a, d) {
  const out = [];
  for (let x = a; x < d; x = addDays(x, 1)) out.push(x);
  return out;
}

async function getRates(env, ids, arrival, departure) {
  const out = {};
  for (let k = 0; k < ids.length; k += 20) {
    const params = { start_date: arrival, end_date: addDays(departure, -1) };
    ids.slice(k, k + 20).forEach((id, n) => { params['apartments%5B' + n + '%5D'] = id; });
    const j = await smoobu(env, { action: 'getRates', params });
    if (j.status !== 200) throw new Error('rates ' + j.status);
    const data = (j.body && j.body.data) || {};
    Object.keys(data).forEach(lid => { out[lid] = data[lid]; });
  }
  return out;
}

// ### 4 --- availability from our DB (sim_bookings + thresholds) plus Smoobu open/closed flags
export async function availability(env, p, r, arrival, departure, ignoreRef) {
  const rooms = roomIds(p, r), wholeId = r.whole_listing_id, all = wholeId ? rooms.concat([wholeId]) : rooms;
  const nights = nightsBetween(arrival, departure);
  const ph = all.map(() => '?').join(',');
  const bk = (await env.DB.prepare(`SELECT m_apartment_id id, m_arrival a, m_departure d FROM sim_bookings WHERE m_departure > ? AND m_arrival < ? AND m_apartment_id IN (${ph})`).bind(arrival, departure, ...all).all()).results;
  const holds = (await env.DB.prepare(`SELECT listing_ids, arrival a, departure d FROM checkout_holds WHERE expires_at > ? AND reference != ? AND arrival < ? AND departure > ?`).bind(new Date().toISOString(), ignoreRef || '', departure, arrival).all()).results;
  holds.forEach(h => JSON.parse(h.listing_ids).forEach(id => bk.push({ id, a: h.a, d: h.d })));
  const ov = (await env.DB.prepare(`SELECT date, threshold_override t FROM date_overrides WHERE apartment_id = ? AND date >= ? AND date < ? AND threshold_override IS NOT NULL`).bind(p.id, arrival, departure).all()).results;
  const rates = await getRates(env, all, arrival, departure);
  const free = {}, why = {};
  rooms.forEach(id => { free[id] = true; });
  let wholeFree = rooms.length > 0;
  nights.forEach(d => {
    const wholeBooked = wholeId && bk.some(b => String(b.id) === wholeId && b.a <= d && d < b.d);
    const booked = rooms.filter(id => wholeBooked || bk.some(b => String(b.id) === id && b.a <= d && d < b.d));
    const o = ov.find(x => x.date === d), th = o ? o.t : p.threshold;
    const full = booked.length >= th;
    rooms.forEach(id => {
      const rt = rates[id] && rates[id][d];
      if (booked.includes(id)) { free[id] = false; why[id] = 'booked'; }
      else if (full) { free[id] = false; why[id] = why[id] || 'full'; }
      else if (!rt || rt.available !== 1 || rt.price == null) { free[id] = false; why[id] = why[id] || 'closed'; }
    });
    if (booked.length) wholeFree = false;
    rooms.forEach(id => { const rt = rates[id] && rates[id][d]; if (!rt || rt.available !== 1 || rt.price == null) wholeFree = false; });
    if (wholeId) { const rt = rates[wholeId] && rates[wholeId][d]; if (rt && rt.available !== 1) wholeFree = false; }
  });
  return { rooms, nights, free, why, wholeFree, rates };
}

// ### 5 --- quote (always computed server-side)
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;

export function money(p) {
  return '£' + (p % 100 === 0 ? (p / 100).toLocaleString('en-GB') : (p / 100).toLocaleString('en-GB', { minimumFractionDigits: 2, maximumFractionDigits: 2 }));
}

function checkDates(arrival, departure, guests) {
  const today = new Date().toISOString().slice(0, 10);
  if (!DATE_RE.test(arrival || '') || !DATE_RE.test(departure || '') || isNaN(Date.parse(arrival)) || isNaN(Date.parse(departure))) return { ok: false, code: 'dates', error: 'Please choose valid dates.' };
  if (arrival < today) return { ok: false, code: 'dates', error: 'Arrival date is in the past.' };
  const n = nightsBetween(arrival, departure).length;
  if (n < 1) return { ok: false, code: 'dates', error: 'Departure must be after arrival.' };
  if (n > 60) return { ok: false, code: 'dates', error: 'Stays are limited to 60 nights online. Please send an enquiry.' };
  const g = Math.round(Number(guests) || 1);
  if (g < 1 || g > 50) return { ok: false, code: 'guests', error: 'Please enter a valid number of guests.' };
  return null;
}

export async function quoteAll(env, p, r, arrival, departure, guests) {
  const bad = checkDates(arrival, departure, guests);
  if (bad) return bad;
  const rooms = roomIds(p, r), av = await availability(env, p, r, arrival, departure), facts = await getFacts(env, rooms);
  const scopes = rooms.length > 1 ? ['whole'].concat(rooms) : rooms;
  const results = [];
  for (const sc of scopes) results.push({ scope: sc, q: await quote(env, p, r, sc, arrival, departure, guests, { av, facts }) });
  return { ok: true, results };
}

export async function quote(env, p, r, scope, arrival, departure, guests, pre) {
  const bad = checkDates(arrival, departure, guests);
  if (bad) return bad;
  const nights = nightsBetween(arrival, departure), g = Math.round(Number(guests) || 1);
  const rooms = roomIds(p, r), whole = scope === 'whole';
  if (!whole && !rooms.includes(scope)) return { ok: false, code: 'scope', error: 'Unknown room.' };
  if (whole && !rooms.length) return { ok: false, code: 'scope', error: 'Unknown selection.' };
  const inScope = whole ? rooms : [scope];
  const av = pre ? pre.av : await availability(env, p, r, arrival, departure);
  const isFree = whole ? av.wholeFree : av.free[scope];
  if (!isFree) return { ok: false, code: 'unavailable', error: 'Not available for these dates.' };
  const facts = pre && pre.facts || await getFacts(env, inScope);
  const cap = inScope.reduce((s, id) => s + (facts[id] && facts[id].maxOccupancy || 0), 0);
  if (cap && g > cap) return { ok: false, code: 'guests', error: 'Maximum ' + cap + ' guest' + (cap === 1 ? '' : 's') + ' for this selection.' };
  const minStay = Math.max(1, ...inScope.map(id => Number(av.rates[id] && av.rates[id][arrival] && av.rates[id][arrival].min_length_of_stay) || 1));
  if (nights.length < minStay) return { ok: false, code: 'minstay', error: 'Minimum stay for these dates is ' + minStay + ' nights.', minStay };
  const disc = Number(r.discount_pct) || 0, pct = Number(r.extra_guest_pct) || 0;
  const base = inScope.reduce((s, id) => s + Math.min(r.base_guests, facts[id] && facts[id].maxOccupancy || r.base_guests), 0);
  const extra = Math.max(0, g - base);
  let ota = 0, direct = 0, extraOta = 0, extraDirect = 0;
  const perRoom = inScope.map(id => { const o = nights.reduce((x, d) => x + Math.round(av.rates[id][d].price * 100), 0); return { id, ota: o, direct: Math.round(o * (100 - disc) / 100) }; });
  const lines = nights.map(d => {
    const o = inScope.reduce((s, id) => s + Math.round(av.rates[id][d].price * 100), 0), dd = Math.round(o * (100 - disc) / 100);
    const eo = Math.round(extra * pct / 100 * o / inScope.length), ed = Math.round(extra * pct / 100 * dd / inScope.length);
    ota += o; direct += dd; extraOta += eo; extraDirect += ed;
    return { date: d, ota: o, direct: dd };
  });
  const cleaning = inScope.reduce((s, id) => s + ((r.room_content[id] && r.room_content[id].c) || 0), 0);
  return { ok: true, scope: whole ? 'whole' : scope, listingIds: inScope, arrival, departure, nights: nights.length, guests: g, minStay, lines, perRoom, discountPct: disc, extraGuests: extra, extraGuestFee: extraDirect, cleaning, otaTotal: ota + extraOta + cleaning, total: direct + extraDirect + cleaning, currency: 'GBP' };
}

// ### 6 --- rate limiting, telegram
export async function allow(env, key, limit, windowSec) {
  const now = Date.now();
  await env.DB.prepare(`DELETE FROM rate_hits WHERE ts < ?`).bind(now - 86400000).run();
  const c = await env.DB.prepare(`SELECT COUNT(*) c FROM rate_hits WHERE k = ? AND ts > ?`).bind(key, now - windowSec * 1000).first();
  if (c.c >= limit) return false;
  await env.DB.prepare(`INSERT INTO rate_hits (k, ts) VALUES (?, ?)`).bind(key, now).run();
  return true;
}

export async function telegram(env, text) {
  if (!env.TELEGRAM_BOT_TOKEN || !env.TELEGRAM_CHAT_ID) return;
  try {
    await fetch('https://api.telegram.org/bot' + env.TELEGRAM_BOT_TOKEN + '/sendMessage', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ chat_id: env.TELEGRAM_CHAT_ID, text }) });
  } catch (e) {}
}
