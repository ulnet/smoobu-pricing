// ### 1 --- turn one listing's date/price changes into Smoobu rate operations (same price shares an operation, consecutive dates collapse to ranges)
import { addDays } from './util.js';

function toRanges(dates) {
  const out = [];
  let a = null, b = null;
  dates.forEach(d => {
    if (a === null) { a = b = d; return; }
    if (addDays(b, 1) === d) { b = d; return; }
    out.push(a === b ? a : a + ':' + b);
    a = b = d;
  });
  if (a !== null) out.push(a === b ? a : a + ':' + b);
  return out;
}

export function buildOps(changes) {
  const by = new Map();
  changes.forEach(c => { if (!by.has(c.price)) by.set(c.price, []); by.get(c.price).push(c.date); });
  return [...by.entries()].map(([price, dates]) => ({ dates: toRanges(dates.sort()), daily_price: price }));
}

// ### 2 --- apply one listing, 60 dates per request, one retry each; returns per-chunk outcomes
export async function applyListing(setRateOps, listingId, changes) {
  const sorted = changes.slice().sort((x, y) => x.date < y.date ? -1 : 1);
  const out = [];
  for (let i = 0; i < sorted.length; i += 60) {
    const chunk = sorted.slice(i, i + 60);
    const ops = buildOps(chunk);
    let err = '';
    for (let t = 0; t < 2; t++) {
      try {
        const res = await setRateOps(listingId, ops);
        if (res.status >= 200 && res.status < 300) { err = ''; break; }
        const b = res.body || {};
        err = 'HTTP ' + res.status + ': ' + (b.detail || b.title || JSON.stringify(b)).slice(0, 160);
      } catch (e) { err = e.message; }
    }
    out.push({ changes: chunk, error: err });
  }
  return out;
}
