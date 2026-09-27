// ### 1 --- orphan gap discount: lone open night between two real bookings
export default function orphan(cfg, isOrphan) {
  return cfg && cfg.enabled && isOrphan ? Number(cfg.discount) || 0 : 0;
}
