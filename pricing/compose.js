// ### 1 --- build the per-apartment presets the engine reads from named strategies + per-apartment limits
export default function composePresets(strategies, aptSettings) {
  const out = {};
  Object.keys(aptSettings || {}).forEach(id => {
    const a = aptSettings[id], s = (strategies || {})[a.strategyId];
    if (!s) return;
    out[id] = { base: a.base, min: a.min, max: a.max, spread: a.spread, factors: s.factors || {}, orphan: s.orphan, minNotice: s.minNotice, maxChange: s.maxChange };
  });
  return out;
}
