// ### 1 --- escaping and encoding
export const esc = s => String(s == null ? '' : s).replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const enc = new TextEncoder();

function b64u(buf) {
  let s = '';
  new Uint8Array(buf).forEach(b => s += String.fromCharCode(b));
  return btoa(s).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

// ### 2 --- signing and session cookie
export async function hmac(msg, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return b64u(await crypto.subtle.sign('HMAC', key, enc.encode(msg)));
}

export async function safeEq(a, b, secret) {
  const [x, y] = await Promise.all([hmac(a, secret), hmac(b, secret)]);
  let d = x.length ^ y.length;
  for (let i = 0; i < x.length; i++) d |= x.charCodeAt(i) ^ y.charCodeAt(i % y.length);
  return d === 0;
}

export async function signSession(env, ttl) {
  const p = 'a.' + (Date.now() + ttl);
  return p + '.' + await hmac(p, env.SESSION_SECRET);
}

export async function checkSession(env, tok) {
  if (!tok || !env.SESSION_SECRET) return false;
  const parts = tok.split('.');
  if (parts.length !== 3 || parts[0] !== 'a') return false;
  if (!(Number(parts[1]) > Date.now())) return false;
  return safeEq(parts[2], await hmac(parts[0] + '.' + parts[1], env.SESSION_SECRET), env.SESSION_SECRET);
}

export function getCookie(req, name) {
  const m = (req.headers.get('Cookie') || '').split(';').map(s => s.trim()).find(s => s.startsWith(name + '='));
  return m ? m.slice(name.length + 1) : '';
}

// ### 3 --- responses
export function html(body, status = 200, headers = {}) {
  return new Response(body, { status, headers: Object.assign({ 'Content-Type': 'text/html;charset=utf-8', 'X-Content-Type-Options': 'nosniff', 'Referrer-Policy': 'same-origin' }, headers) });
}

export function redirect(url, headers = {}) {
  return new Response(null, { status: 303, headers: Object.assign({ Location: url }, headers) });
}

export function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 60) || 'property';
}

// ### 4 --- random ids, hex hmac, dates
export function randHex(n) {
  const b = new Uint8Array(n);
  crypto.getRandomValues(b);
  return Array.from(b).map(x => x.toString(16).padStart(2, '0')).join('');
}

export function randRef() {
  const a = 'ABCDEFGHJKMNPQRSTUVWXYZ23456789', b = new Uint8Array(8);
  crypto.getRandomValues(b);
  return 'KZ' + Array.from(b).map(x => a[x % a.length]).join('');
}

export async function hmacHex(msg, secret) {
  const key = await crypto.subtle.importKey('raw', enc.encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return Array.from(new Uint8Array(await crypto.subtle.sign('HMAC', key, enc.encode(msg)))).map(x => x.toString(16).padStart(2, '0')).join('');
}

export function fmtDate(iso) {
  return new Date(iso + 'T00:00:00Z').toLocaleDateString('en-GB', { timeZone: 'UTC', weekday: 'short', day: 'numeric', month: 'short', year: 'numeric' });
}
