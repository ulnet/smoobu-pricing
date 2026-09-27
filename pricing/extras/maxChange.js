// ### 1 --- max change per run, relative to the last applied price (no last price = uncapped)
export default function maxChange(cfg, price, last) {
  if (!cfg || !cfg.pct || last === null || last === undefined) return price;
  const p = Number(cfg.pct) / 100;
  return Math.min(Math.max(price, last * (1 - p)), last * (1 + p));
}
