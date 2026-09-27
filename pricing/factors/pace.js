// ### 1 --- booking pace factor: current fill vs historical fill at the same lead time and weekday, as a percentage
import { tierAdj } from '../util.js';
export default function pace(ctx, cfg) {
  return tierAdj(cfg.tiers, ctx.data.paceRatio(ctx.apt, ctx.date, ctx.today, cfg));
}
