// ### 1 --- season factor: MM-DD bands, wrap-around bands (e.g. 12-15 to 01-05) supported, first match wins
export default function season(ctx, cfg) {
  const md = ctx.date.slice(5);
  const b = (cfg.bands || []).find(x => x.from <= x.to ? md >= x.from && md <= x.to : md >= x.from || md <= x.to);
  return b ? Number(b.adj) || 0 : 0;
}
