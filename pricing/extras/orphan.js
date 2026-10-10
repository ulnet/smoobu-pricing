// ### 1 --- orphan gap adjustment: signed % (negative discounts, positive raises) for a lone open night between two real bookings
export default function orphan(cfg, isOrphan) {
  if (!cfg || !cfg.enabled || !isOrphan) return 0;
  return cfg.adj !== undefined ? Number(cfg.adj) || 0 : -(Number(cfg.discount) || 0);
}
