// ### 1 --- booking views built from sim_bookings rows (pure, no io)
import { addDays, dowOf } from './util.js';

export function isBlock(r) {
  return r.guest_name === 'Blocked Period' || String(r.details || '').includes('blocked@placeholder.local');
}

export function buildData(rows, today) {
  const by = new Map();
  rows.forEach(r => {
    const u = String(r.m_apartment_id);
    if (!by.has(u)) by.set(u, []);
    by.get(u).push({ from: r.m_arrival, to: r.m_departure, created: String(r.created_at || '').slice(0, 10), block: isBlock(r), id: String(r.id) });
  });
  const list = u => by.get(String(u)) || [];
  const cache = new Map();

// ### 2 --- availability and gap views
  const isBooked = (u, d) => list(u).some(b => b.from <= d && d < b.to);
  const testId = (u, d) => { const b = list(u).find(x => x.from <= d && d < x.to); return b && b.id.startsWith('simgen-') ? b.id : null; };
  const isReal = (u, d) => list(u).some(b => !b.block && b.from <= d && d < b.to);
  const isOrphan = (u, d) => !isBooked(u, d) && isReal(u, addDays(d, -1)) && isReal(u, addDays(d, 1));

// ### 3 --- occupancy now, and occupancy as it stood `lead` days before the date (uses created_at)
  const fillAt = (apt, d, lead) => {
    const cut = addDays(d, -lead);
    const n = apt.listingIds.filter(u => list(u).some(b => !b.block && b.created <= cut && b.from <= d && d < b.to)).length;
    return apt.listingIds.length ? n / apt.listingIds.length : 0;
  };
  const occupancy = (apt, d) => apt.listingIds.length ? apt.listingIds.filter(u => isReal(u, d)).length / apt.listingIds.length : 0;

// ### 4 --- pace: actual fill vs the average fill of past same-weekday dates at the same lead time
  const expected = (apt, d, lead, cfg) => {
    const win = (cfg && cfg.historyDays) || 90, minN = (cfg && cfg.minSamples) || 3;
    const k = apt.id + '|' + dowOf(d) + '|' + lead + '|' + win;
    if (cache.has(k)) return cache.get(k);
    let sum = 0, n = 0;
    for (let p = addDays(today, -1); p >= addDays(today, -win); p = addDays(p, -1)) {
      if (dowOf(p) !== dowOf(d)) continue;
      sum += fillAt(apt, p, lead);
      n++;
    }
    const v = n >= minN ? sum / n : null;
    cache.set(k, v);
    return v;
  };
  const paceRatio = (apt, d, t, cfg) => {
    const lead = Math.max(0, Math.round((new Date(d + 'T00:00:00Z') - new Date(t + 'T00:00:00Z')) / 86400000));
    const e = expected(apt, d, lead, cfg);
    if (!e) return null;
    return fillAt(apt, d, lead) / e * 100;
  };
  return { isBooked, testId, isOrphan, occupancy, paceRatio, fillAt };
}
