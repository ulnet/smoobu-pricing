// ### 1 --- holiday/event multiplier: stacks multiplicatively on top of the summed factors
export default function eventMult(events, aptId, date) {
  let m = 1;
  (events || []).forEach(e => {
    if (date < e.from || date > e.to) return;
    if (e.apartmentIds && e.apartmentIds.length && !e.apartmentIds.includes(aptId)) return;
    m *= Number(e.mult) || 1;
  });
  return m;
}
