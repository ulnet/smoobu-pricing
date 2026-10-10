// ### 1 --- imports and helpers
import composePresets from './compose.js';
import { computePlan, ensureTables } from './plan.js';
import { applyListing } from './smoobu.js';
import { tzNow } from './clock.js';
import { addDays } from './util.js';

async function meta(env, key, dflt) {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first();
  return r ? JSON.parse(r.value) : dflt;
}

async function putMeta(env, key, value) {
  await env.DB.prepare(`INSERT INTO meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(key, JSON.stringify(value)).run();
}

// ### 2 --- current Smoobu rates for a set of listings (read only), windows of 90 days, 20 listings per call
async function fetchRates(deps, ids, from, to) {
  const map = new Map();
  for (let a = from; a <= to; a = addDays(a, 90)) {
    const b = addDays(a, 89) < to ? addDays(a, 89) : to;
    for (let k = 0; k < ids.length; k += 20) {
      const params = { start_date: a, end_date: b };
      ids.slice(k, k + 20).forEach((id, n) => { params['apartments%5B' + n + '%5D'] = id; });
      const res = await deps.getRates(params);
      if (res.status !== 200) throw new Error('Smoobu rates HTTP ' + res.status);
      const data = (res.body && res.body.data) || {};
      Object.keys(data).forEach(lid => Object.keys(data[lid]).forEach(d => {
        const c = data[lid][d];
        map.set(lid + '|' + d, { price: c.price === null || c.price === undefined ? null : Number(c.price), available: c.available });
      }));
    }
  }
  return map;
}

// ### 3 --- one pricing run: scope near (today, tomorrow), far (rest of horizon), apartment or all
export async function runPricing(env, deps, o) {
  await ensureTables(env);
  const d = o.draft || null;
  const st = Object.assign({ horizonDays: 60 }, d ? d.settings : await meta(env, 'pricing_settings', {}));
  if (!d && !st.enabled) return { success: true, skipped: 'Engine is off' };
  const now = tzNow(st.timezone || 'UTC'), today = now.date, hour = now.hour;
  const hz = Number(st.horizonDays) || 60;
  const scope = o.scope || 'all';
  const from = scope === 'far' ? addDays(today, 2) : today;
  const to = scope === 'near' ? addDays(today, 1) : addDays(today, hz - 1);
  if (to < from) return { success: true, skipped: 'Nothing in range' };
  const strategies = d ? d.strategies : await meta(env, 'pricing_strategies', {});
  const aptSettings = d ? d.aptSettings : await meta(env, 'pricing_apartments', {});
  const calendar = d ? d.calendar : await meta(env, 'pricing_calendar', { seasons: [], events: [] });
  const presets = composePresets(strategies, aptSettings);
  let apts = (await meta(env, 'apartments', [])).filter(a => presets[a.id] && a.listingIds.length);
  if (o.apartmentId) apts = apts.filter(a => String(a.id) === String(o.apartmentId));
  if (!apts.length) return { success: true, skipped: 'No apartment has a strategy' };

// ### 3b --- plan against our bookings (test bookings excluded) with Smoobu's current prices as the baseline
  const rates = await fetchRates(deps, apts.flatMap(a => a.listingIds.map(String)), from, to);
  const days = await computePlan(env, {
    apartments: apts, presets, calendar, today, hour, from, to,
    last: (id, dt) => { const r = rates.get(id + '|' + dt); return r && r.price ? r.price : null; },
    rowFilter: r => !String(r.id).startsWith('simgen-')
  });
  const by = new Map();
  let closed = 0;
  days.forEach(day => day.listings.forEach(l => {
    if (l.status !== 'open' && l.status !== 'override') return;
    const r = rates.get(l.id + '|' + day.date);
    if (r && r.available === 0) { closed++; return; }
    if (r && r.price === l.price) return;
    if (!by.has(day.apartmentId)) by.set(day.apartmentId, []);
    by.get(day.apartmentId).push({ listingId: l.id, date: day.date, price: l.price, old: r ? r.price : null, apartmentId: day.apartmentId, bd: { factors: day.factors, sum: day.sum, eventMult: day.eventMult, mid: day.mid, status: l.status, lock: !!l.lock, spread: l.spread, orphan: l.orphan, capped: l.capped, hour: day.lead === 0 ? hour : undefined } });
  }));

// ### 3c --- preview returns the planned changes and writes nothing
  const trig = o.trigger || 'manual';
  if (o.preview) {
    const all = [...by.values()].flat();
    return { success: true, preview: true, today, hour, from, to, closed, total: all.length, perApartment: apts.map(a => ({ id: a.id, name: a.name, planned: (by.get(a.id) || []).length })), sample: all.slice(0, 300).map(c => ({ listingId: c.listingId, date: c.date, old: c.old, price: c.price, status: c.bd.status })) };
  }

// ### 3d --- dry apartments log what they would set (deduped); live apartments write to Smoobu
  const run = { ts: new Date().toISOString(), trigger: trig, scope, from, to, apartments: [] };
  const logs = [];
  const ts = run.ts;
  for (const a of apts) {
    const ch = by.get(a.id) || [];
    const live = !!(aptSettings[a.id] && aptSettings[a.id].live) && o.forceDry === false;
    const rec = { id: a.id, name: a.name, mode: live ? 'live' : 'dry', planned: ch.length, applied: 0, failed: 0 };
    if (!live) {
      const seen = new Map();
      if (ch.length) (await env.DB.prepare(`SELECT listing_id, date, dry_price FROM price_state WHERE date >= ? AND date <= ?`).bind(from, to).all()).results.forEach(r => seen.set(r.listing_id + '|' + r.date, r.dry_price));
      rec.logged = 0;
      ch.forEach(c => {
        if (seen.get(c.listingId + '|' + c.date) === c.price) return;
        logs.push({ mode: 'dry', c, status: 'planned', error: '' });
        rec.logged++;
      });
      run.apartments.push(rec);
      continue;
    }
    const byL = new Map();
    ch.forEach(c => { if (!byL.has(c.listingId)) byL.set(c.listingId, []); byL.get(c.listingId).push(c); });
    for (const [lid, list] of byL) {
      const res = await applyListing((id, ops) => deps.setRateOps(id, ops), lid, list);
      res.forEach(r => r.changes.forEach(c => {
        if (r.error) { rec.failed++; logs.push({ mode: 'live', c, status: 'error', error: r.error }); } else { rec.applied++; logs.push({ mode: 'live', c, status: 'ok', error: '' }); }
      }));
    }
    run.apartments.push(rec);
  }

// ### 3e --- persist log, dry baseline, run record; alert on failures
  const stmts = [];
  logs.slice(0, 600).forEach(l => {
    stmts.push(env.DB.prepare(`INSERT INTO price_log (ts, mode, trigger_name, listing_id, date, old_price, new_price, status, error, breakdown) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`).bind(ts, l.mode, trig, l.c.listingId, l.c.date, l.c.old, l.c.price, l.status, l.error, JSON.stringify(l.c.bd)));
    if (l.mode === 'dry') stmts.push(env.DB.prepare(`INSERT INTO price_state (listing_id, date, dry_price) VALUES (?, ?, ?) ON CONFLICT(listing_id, date) DO UPDATE SET dry_price = excluded.dry_price`).bind(l.c.listingId, l.c.date, l.c.price));
  });
  for (let i = 0; i < stmts.length; i += 50) await env.DB.batch(stmts.slice(i, i + 50));
  await env.DB.prepare(`DELETE FROM price_log WHERE ts < ?`).bind(addDays(today, -30)).run();
  await env.DB.prepare(`DELETE FROM price_state WHERE date < ?`).bind(today).run();
  const runs = await meta(env, 'pricing_runs', []);
  runs.unshift(run);
  await putMeta(env, 'pricing_runs', runs.slice(0, 30));
  const failed = run.apartments.reduce((n, r) => n + r.failed, 0);
  if (failed) {
    const msg = failed + ' price write(s) to Smoobu failed (' + run.apartments.filter(r => r.failed).map(r => r.name).join(', ') + ')';
    await deps.alert('Pricing write failed', msg);
    await deps.telegram('Pricing: ' + msg);
  }
  return { success: true, today, from, to, closed, apartments: run.apartments };
}

// ### 4 --- run after a booking arrives or changes: that apartment only (all apartments when the listing is unknown)
export async function priceAfterBooking(env, deps, listingId) {
  const apts = await meta(env, 'apartments', []);
  const a = listingId ? apts.find(x => x.listingIds.map(String).includes(String(listingId))) : null;
  return runPricing(env, deps, { scope: 'apartment', apartmentId: a ? a.id : undefined, trigger: 'booking', forceDry: false });
}

// ### 5 --- status for the Live tab
export async function getPricingStatus(env) {
  await ensureTables(env);
  const st = await meta(env, 'pricing_settings', {});
  const runs = await meta(env, 'pricing_runs', []);
  const log = (await env.DB.prepare(`SELECT id, ts, mode, trigger_name, listing_id, date, old_price, new_price, status, error, breakdown FROM price_log ORDER BY id DESC LIMIT 100`).all()).results;
  return { success: true, enabled: !!st.enabled, runs: runs.slice(0, 15), log };
}
