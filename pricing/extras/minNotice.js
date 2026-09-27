// ### 1 --- minimum notice floor: inside N days out, price never drops below floor
export default function minNotice(cfg, price, lead) {
  return cfg && cfg.days && lead < cfg.days ? Math.max(price, Number(cfg.floor) || 0) : price;
}
