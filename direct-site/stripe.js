import { safeEq, hmacHex } from './util.js';

// ### 1 --- stripe rest helper (no sdk)
const API = 'https://api.stripe.com/v1';

function enc(o, pre, out) {
  Object.keys(o).forEach(k => {
    const v = o[k], key = pre ? pre + '[' + k + ']' : k;
    if (v == null) return;
    if (typeof v === 'object') enc(v, key, out);
    else out.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(v)));
  });
  return out;
}

async function call(env, method, path, params, idem) {
  const headers = { Authorization: 'Bearer ' + env.STRIPE_SECRET_KEY };
  if (params) headers['Content-Type'] = 'application/x-www-form-urlencoded';
  if (idem) headers['Idempotency-Key'] = idem;
  const res = await fetch(API + path, { method, headers, body: params ? enc(params, '', []).join('&') : undefined });
  const j = await res.json();
  if (!res.ok) throw new Error('Stripe ' + res.status + ': ' + (j.error && j.error.message || 'error'));
  return j;
}

// ### 2 --- provider adapter: createCheckout, capture, cancelAuth, refund, verifyWebhook
export const stripe = {
  name: 'stripe',
  async createCheckout(env, o) {
    const s = await call(env, 'POST', '/checkout/sessions', {
      mode: 'payment',
      line_items: { 0: { quantity: 1, price_data: { currency: o.currency.toLowerCase(), unit_amount: o.amount, product_data: { name: o.name, description: o.description } } } },
      customer_email: o.email,
      client_reference_id: o.reference,
      metadata: { reference: o.reference },
      payment_intent_data: { metadata: { reference: o.reference }, description: o.name },
      success_url: o.successUrl,
      cancel_url: o.cancelUrl,
      expires_at: Math.floor(Date.now() / 1000) + 1860
    }, 'checkout-' + o.reference);
    return { id: s.id, url: s.url };
  },
  async capture() { throw new Error('capture is not supported by this provider yet'); },
  async cancelAuth(env, sessionId) {
    try { await call(env, 'POST', '/checkout/sessions/' + encodeURIComponent(sessionId) + '/expire', {}); } catch (e) {}
  },
  async refund(env, paymentId, amount, key) {
    const p = { payment_intent: paymentId };
    if (amount) p.amount = amount;
    return call(env, 'POST', '/refunds', p, key);
  },
  async verifyWebhook(env, raw, header) {
    if (!env.STRIPE_WEBHOOK_SECRET) return null;
    const parts = String(header || '').split(',').map(x => x.trim().split('='));
    const t = (parts.find(x => x[0] === 't') || [])[1], sigs = parts.filter(x => x[0] === 'v1').map(x => x[1]);
    if (!t || Math.abs(Date.now() / 1000 - Number(t)) > 300) return null;
    const mac = await hmacHex(t + '.' + raw, env.STRIPE_WEBHOOK_SECRET);
    let ok = false;
    for (const s of sigs) if (await safeEq(s, mac, env.STRIPE_WEBHOOK_SECRET)) ok = true;
    return ok ? JSON.parse(raw) : null;
  }
};

export function getProvider(name) {
  return name === 'stripe' ? stripe : null;
}
