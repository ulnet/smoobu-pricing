// ### 1 --- global calendar: season bands (additive %, stack in the sum) and event multipliers (multiplicative), shared by every strategy
export function seasonAdj(seasons, aptId, date) {
  const md = date.slice(5);
  let sum = 0;
  (seasons || []).forEach(b => {
    if (b.apartmentIds && b.apartmentIds.length && !b.apartmentIds.includes(aptId)) return;
    const hit = b.from <= b.to ? md >= b.from && md <= b.to : md >= b.from || md <= b.to;
    if (hit) sum += Number(b.adj) || 0;
  });
  return sum;
}
export function eventMult(events, aptId, date) {
  let m = 1;
  (events || []).forEach(e => {
    if (date < e.from || date > e.to) return;
    if (e.apartmentIds && e.apartmentIds.length && !e.apartmentIds.includes(aptId)) return;
    m *= Number(e.mult) || 1;
  });
  return m;
}
