// ### 1 --- day of week factor: days map keyed 0 (Sun) to 6 (Sat)
import { dowOf } from '../util.js';
export default function dow(ctx, cfg) { return Number((cfg.days || {})[dowOf(ctx.date)]) || 0; }
