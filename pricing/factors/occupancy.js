// ### 1 --- occupancy factor: share of the apartment's listings booked on that date
import { tierAdj } from '../util.js';
export default function occupancy(ctx, cfg) {
  return tierAdj(cfg.tiers, ctx.data.occupancy(ctx.apt, ctx.date) * 100);
}
