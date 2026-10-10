// ### 1 --- imports
import factors from './factors/index.js';
import { seasonAdj, eventMult } from './extras/calendar.js';
import orphanAdj from './extras/orphan.js';
import maxChange from './extras/maxChange.js';
import minNotice from './extras/minNotice.js';
import { dayDiff, rangeDates, seededUnit } from './util.js';

// ### 2 --- price one apartment on one date: summed strategy factors + calendar season, then event multiplier, then per-listing steps
export function priceApartmentDay({ apt, preset, date, today, data, calendar, last, overridePrice, lockPrice, hour }) {
  const lead = dayDiff(today, date);
  const ctx = { apt, date, today, lead, data, hour };
  const fx = {};
  let sum = 0;
  Object.keys(preset.factors || {}).forEach(k => {
    const fn = factors[k];
    if (!fn) return;
    fx[k] = fn(ctx, preset.factors[k]) || 0;
    sum += fx[k];
  });
  const cal = calendar || {};
  const seasonPct = seasonAdj(cal.seasons, apt.id, date);
  fx.season = seasonPct;
  sum += seasonPct;
  const em = eventMult(cal.events, apt.id, date);
  const mid = preset.base * (1 + sum / 100) * em;
  const ov = overridePrice ? overridePrice(apt.id, date) : null;
  const listings = apt.listingIds.map(id => {
    if (data.isBooked(id, date)) return { id: String(id), status: 'booked', price: null, test: data.testId(String(id), date) };
    const lk = lockPrice ? lockPrice(String(id), date) : null;
    if (lk !== null && lk !== undefined) return { id: String(id), status: 'override', price: lk, prev: last ? last(id, date) : null, lock: true };
    if (ov !== null && ov !== undefined) return { id: String(id), status: 'override', price: ov, prev: last ? last(id, date) : null };
    const off = seededUnit(String(id) + '|' + date) * (Number(preset.spread) || 0);
    const orp = orphanAdj(preset.orphan, data.isOrphan(id, date));
    const prev = last ? last(id, date) : null;
    let p = mid * (1 + off / 100) * (1 + orp / 100);
    const spreadP = p;
    p = maxChange(preset.maxChange, p, prev);
    const capped = p !== spreadP;
    p = minNotice(preset.minNotice, p, lead);
    p = Math.round(Math.min(Math.max(p, preset.min), preset.max));
    return { id: String(id), status: 'open', price: p, prev, spread: +off.toFixed(2), orphan: orp, capped };
  });
  return { apartmentId: apt.id, date, lead, sum, factors: fx, eventMult: em, mid: +mid.toFixed(2), overridden: ov !== null && ov !== undefined, listings };
}

// ### 3 --- plan a date range for every apartment that has a preset
export function planPrices({ apartments, presets, calendar, data, today, from, to, last, overridePrice, lockPrice, hour }) {
  const days = [];
  apartments.forEach(apt => {
    const preset = presets[apt.id];
    if (!preset || !apt.listingIds.length) return;
    rangeDates(from, to).forEach(date => days.push(priceApartmentDay({ apt, preset, date, today, data, calendar, last, overridePrice, lockPrice, hour })));
  });
  return days;
}

// ### 4 --- flatten to the listing-level changes a writer would apply
export function toChanges(days) {
  const out = [];
  days.forEach(d => d.listings.forEach(l => {
    if ((l.status === 'open' || l.status === 'override') && l.price !== l.prev) out.push({ listingId: l.id, date: d.date, price: l.price, old: l.prev, apartmentId: d.apartmentId });
  }));
  return out;
}
