// ### 1 --- current date and fractional hour in a timezone (falls back to UTC on a bad zone name)
export function tzNow(tz) {
  const fmt = z => new Intl.DateTimeFormat('en-CA', { timeZone: z, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(new Date());
  let parts;
  try { parts = fmt(tz || 'UTC'); } catch (e) { parts = fmt('UTC'); }
  const g = t => parts.find(x => x.type === t).value;
  return { date: g('year') + '-' + g('month') + '-' + g('day'), hour: Number(g('hour')) + Number(g('minute')) / 60 };
}
