// ### 1 --- date helpers (ISO yyyy-mm-dd, UTC)
export function addDays(iso, n) {
  const d = new Date(iso + 'T00:00:00Z');
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dayDiff(a, b) { return Math.round((new Date(b + 'T00:00:00Z') - new Date(a + 'T00:00:00Z')) / 86400000); }
export function dowOf(iso) { return new Date(iso + 'T00:00:00Z').getUTCDay(); }
export function rangeDates(from, to) {
  const out = [];
  for (let d = from; d <= to; d = addDays(d, 1)) out.push(d);
  return out;
}

// ### 2 --- tier lookup (min inclusive, max exclusive, null = open ended)
export function tierAdj(tiers, v) {
  if (v === null || v === undefined || !Array.isArray(tiers)) return 0;
  const t = tiers.find(x => (x.min === null || x.min === undefined || v >= x.min) && (x.max === null || x.max === undefined || v < x.max));
  return t ? Number(t.adj) || 0 : 0;
}

// ### 3 --- stable per-listing offset in [-1, 1] (FNV-1a hash of the id)
export function seededUnit(str) {
  let h = 2166136261;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 16777619); }
  return ((h >>> 0) / 4294967295) * 2 - 1;
}
