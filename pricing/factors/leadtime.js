// ### 1 --- lead time factor: days from today to the stay date
import { tierAdj } from '../util.js';
export default function leadtime(ctx, cfg) { return tierAdj(cfg.tiers, ctx.lead); }
