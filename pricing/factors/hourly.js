// ### 1 --- hour of day factor: tonight only (lead 0), price drops linearly from startHour to endHour by up to dropPct
export default function hourly(ctx, cfg) {
  if (ctx.lead !== 0 || ctx.hour === undefined || ctx.hour === null) return 0;
  const s = Number(cfg.startHour), e = Number(cfg.endHour), d = Number(cfg.dropPct);
  if (!(e > s) || !d) return 0;
  const f = Math.min(Math.max((ctx.hour - s) / (e - s), 0), 1);
  return Math.round(-d * f * 100) / 100 || 0;
}
