import { WorkerEntrypoint } from 'cloudflare:workers';

// ### 1 --- constants + helpers
// the Google account to connect comes from the GMAIL_ACCOUNT secret (kept out of the public repo)
const accountOf = env => String(env.GMAIL_ACCOUNT || '').toLowerCase();
const SCOPE = 'https://www.googleapis.com/auth/contacts';
const PEOPLE = 'https://people.googleapis.com/v1';
const json = (o, s = 200) => new Response(JSON.stringify(o), { status: s, headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' } });
const digits = s => String(s || '').replace(/\D/g, '');
const norm = (s, cc) => {
  let p = String(s || '').replace(/[^\d+]/g, '');
  if (p.startsWith('00')) p = '+' + p.slice(2);
  if (!p.startsWith('+')) p = p.replace(/\+/g, '');
  if (!digits(p)) return '';
  if (p.startsWith('+')) return p;
  if (p.startsWith('0')) return cc ? '+' + cc + p.replace(/^0+/, '') : p;
  return '+' + p;
};
const title = s => String(s || '').trim().replace(/\s+/g, ' ').toLowerCase().replace(/(^|[\s\-'’.])(\S)/g, (m, p, c) => p + c.toLocaleUpperCase());
const gkey = (name, phone) => digits(phone) || 'n:' + String(name || '').trim().toLowerCase();

// ### 2 --- own tables (never touches sim_bookings)
async function ensure(env) {
  await env.DB.batch([
    env.DB.prepare('CREATE TABLE IF NOT EXISTS gmail_kv (k TEXT PRIMARY KEY, v TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS gmail_contacts (guest_key TEXT PRIMARY KEY, resource_name TEXT, name TEXT, phone TEXT, synced_at TEXT)'),
    env.DB.prepare('CREATE TABLE IF NOT EXISTS gmail_sync (booking_id TEXT PRIMARY KEY, guest_key TEXT, status TEXT, error TEXT, synced_at TEXT)')
  ]);
}
const kvGet = async (env, k) => (await env.DB.prepare('SELECT v FROM gmail_kv WHERE k=?').bind(k).first())?.v ?? null;
const kvSet = (env, k, v) => env.DB.prepare('INSERT INTO gmail_kv (k,v) VALUES (?,?) ON CONFLICT(k) DO UPDATE SET v=excluded.v').bind(k, v).run();

// ### 3 --- OAuth (one-time consent as the GMAIL_ACCOUNT, refresh token kept in D1)
async function tokenCall(env, body) {
  const r = await fetch('https://oauth2.googleapis.com/token', { method: 'POST', headers: { 'Content-Type': 'application/x-www-form-urlencoded' }, body: new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, client_secret: env.GOOGLE_CLIENT_SECRET, ...body }) });
  const j = await r.json();
  if (!r.ok) throw new Error(j.error_description || j.error || 'token error');
  return j;
}
async function accessToken(env) {
  const rt = await kvGet(env, 'refresh_token');
  if (!rt) throw new Error('Not connected to Google yet');
  return (await tokenCall(env, { grant_type: 'refresh_token', refresh_token: rt })).access_token;
}
async function authStart(env, url) {
  const st = crypto.randomUUID();
  await kvSet(env, 'state', st);
  const q = new URLSearchParams({ client_id: env.GOOGLE_CLIENT_ID, redirect_uri: url.origin + '/auth/callback', response_type: 'code', scope: SCOPE + ' email', access_type: 'offline', prompt: 'consent', login_hint: accountOf(env), state: st });
  return Response.redirect('https://accounts.google.com/o/oauth2/v2/auth?' + q, 302);
}
async function authCallback(env, url) {
  const st = await kvGet(env, 'state');
  if (!st || url.searchParams.get('state') !== st) return new Response('Bad state', { status: 400 });
  const t = await tokenCall(env, { grant_type: 'authorization_code', code: url.searchParams.get('code'), redirect_uri: url.origin + '/auth/callback' });
  const me = await (await fetch('https://openidconnect.googleapis.com/v1/userinfo', { headers: { Authorization: 'Bearer ' + t.access_token } })).json();
  const em = me.email || '';
  if (!accountOf(env) || em.toLowerCase() !== accountOf(env)) return new Response('Signed in as ' + em + ' - must be the configured account. Nothing was saved.', { status: 403 });
  if (!t.refresh_token) return new Response('No refresh token returned; remove the app at myaccount.google.com/permissions and retry.', { status: 400 });
  await kvSet(env, 'refresh_token', t.refresh_token);
  await kvSet(env, 'email', em);
  await kvSet(env, 'state', '');
  return Response.redirect(url.origin + '/?connected=1', 302);
}

// ### 4 --- read bookings from our DB (real Smoobu bookings only) and work out what each one needs
async function loadBookings(env) {
  const cc = digits(await kvGet(env, 'country'));
  const { results } = await env.DB.prepare(
    `SELECT b.id, b.guest_name, b.channel, b.m_arrival AS arrival, b.m_departure AS departure, b.m_apartment_name AS apartment, b.details,
            s.status, s.error, s.synced_at, s.guest_key AS sk, c.resource_name, c.name AS cname, c.phone AS cphone
     FROM sim_bookings b LEFT JOIN gmail_sync s ON s.booking_id=b.id LEFT JOIN gmail_contacts c ON c.guest_key=s.guest_key
     WHERE b.id LIKE 'smoobu-%' ORDER BY b.m_arrival DESC`
  ).all();
  const cnt = {};
  const rows = results.map(r => {
    let d = {};
    try { d = JSON.parse(r.details || '{}'); } catch (e) {}
    const raw = String(d.contact || '').trim(), phone = norm(raw, cc), name = title(r.guest_name);
    const want = 'Gst ' + name;
    let state = 'pending';
    const key = gkey(name, phone);
    if (name && digits(phone)) cnt[key] = (cnt[key] || 0) + 1;
    if (!name) state = 'skip';
    else if (!digits(phone)) state = 'nophone';
    else if (r.status === 'synced') state = (r.cphone === phone && r.cname === want) ? 'synced' : 'changed';
    else if (r.status === 'error') state = 'error';
    return { id: r.id, name, phone, raw, want, channel: r.channel, arrival: r.arrival, departure: r.departure, apartment: r.apartment, state, error: r.error, synced_at: r.synced_at, resource_name: r.resource_name, key, cname: r.cname, cphone: r.cphone, oldKey: r.sk };
  });
  for (const b of rows) {
    b.shared = cnt[b.key] || 1;
    if (b.state === 'changed' && b.shared > 1 && b.cphone === b.phone) b.state = 'synced';
  }
  return rows;
}

// ### 5 --- People API writes
const body = b => ({ names: [{ givenName: b.want }], phoneNumbers: [{ value: b.phone, type: 'mobile' }], biographies: [{ value: 'Smoobu guest - ' + (b.apartment || '') + ' ' + b.arrival + ' to ' + b.departure + (b.channel ? ' (' + b.channel + ')' : ''), contentType: 'TEXT_PLAIN' }] });
async function people(tok, path, method, payload) {
  const r = await fetch(PEOPLE + path, { method, headers: { Authorization: 'Bearer ' + tok, 'Content-Type': 'application/json' }, body: payload ? JSON.stringify(payload) : undefined });
  const j = await r.json().catch(() => ({}));
  if (!r.ok) throw new Error((j.error && j.error.message) || 'People API ' + r.status);
  return j;
}
async function markOk(env, b, rn) {
  const now = new Date().toISOString();
  await env.DB.batch([
    env.DB.prepare('INSERT INTO gmail_contacts (guest_key,resource_name,name,phone,synced_at) VALUES (?,?,?,?,?) ON CONFLICT(guest_key) DO UPDATE SET resource_name=excluded.resource_name,name=excluded.name,phone=excluded.phone,synced_at=excluded.synced_at').bind(b.key, rn, b.want, b.phone, now),
    env.DB.prepare("INSERT INTO gmail_sync (booking_id,guest_key,status,error,synced_at) VALUES (?,?,'synced',NULL,?) ON CONFLICT(booking_id) DO UPDATE SET guest_key=excluded.guest_key,status='synced',error=NULL,synced_at=excluded.synced_at").bind(b.id, b.key, now)
  ]);
}
const markErr = (env, b, msg) => env.DB.prepare("INSERT INTO gmail_sync (booking_id,guest_key,status,error,synced_at) VALUES (?,?,'error',?,?) ON CONFLICT(booking_id) DO UPDATE SET guest_key=excluded.guest_key,status='error',error=excluded.error,synced_at=excluded.synced_at").bind(b.id, b.key, msg, new Date().toISOString()).run();

// ### 6 --- sync: one contact per guest (phone, else name); existing contacts are updated, new ones batch-created
async function syncBookings(env, ids) {
  const all = await loadBookings(env);
  const todo = all.filter(b => ['pending', 'error', 'changed'].includes(b.state) && (!ids || ids.includes(b.id)));
  const out = { created: 0, linked: 0, updated: 0, failed: 0, errors: [] };
  if (!todo.length) return out;
  const tok = await accessToken(env);
  const known = new Map((await env.DB.prepare('SELECT guest_key,resource_name,name,phone FROM gmail_contacts').all()).results.map(r => [r.guest_key, r]));
  const fresh = new Map(), upd = [];
  for (const b of todo) {
    const c = known.get(b.key);
    if (c && c.phone === b.phone && (c.name === b.want || b.shared > 1)) { await markOk(env, b, c.resource_name); out.linked++; continue; }
    if (c) { upd.push({ b, rn: c.resource_name }); continue; }
    const ok = b.oldKey && b.oldKey !== b.key ? known.get(b.oldKey) : null;
    if (ok && !all.some(x => x.id !== b.id && x.oldKey === b.oldKey && x.key === b.oldKey && x.state !== 'changed')) {
      known.delete(b.oldKey);
      known.set(b.key, { resource_name: ok.resource_name, name: b.want, phone: b.phone });
      upd.push({ b, rn: ok.resource_name, old: b.oldKey });
      continue;
    }
    if (!fresh.has(b.key)) fresh.set(b.key, []);
    fresh.get(b.key).push(b);
  }
  for (const u of upd) {
    try {
      const p = await people(tok, '/' + u.rn + '?personFields=names,phoneNumbers,biographies', 'GET');
      await people(tok, '/' + u.rn + ':updateContact?updatePersonFields=names,phoneNumbers,biographies', 'PATCH', { etag: p.etag, ...body(u.b) });
      await markOk(env, u.b, u.rn);
      if (u.old) await env.DB.prepare('DELETE FROM gmail_contacts WHERE guest_key=?').bind(u.old).run();
      out.updated++;
    } catch (e) { await markErr(env, u.b, e.message); out.failed++; out.errors.push(u.b.want + ': ' + e.message); }
  }
  const groups = [...fresh.values()];
  for (let i = 0; i < groups.length; i += 50) {
    const chunk = groups.slice(i, i + 50);
    try {
      const j = await people(tok, '/people:batchCreateContacts', 'POST', { contacts: chunk.map(g => ({ contactPerson: body(g[0]) })), readMask: 'names' });
      const cp = j.createdPeople || [];
      for (let k = 0; k < chunk.length; k++) {
        const rn = cp[k] && cp[k].person && cp[k].person.resourceName;
        for (const b of chunk[k]) {
          if (rn) { await markOk(env, b, rn); out.created++; } else { await markErr(env, b, 'No resource returned'); out.failed++; }
        }
      }
    } catch (e) {
      for (const g of chunk) for (const b of g) { await markErr(env, b, e.message); out.failed++; }
      out.errors.push(e.message);
    }
  }
  return out;
}

// ### 6b --- one sync at a time (D1 lock); a request that arrives mid-run queues one more pass
async function runLocked(env, ids) {
  const t = Date.now();
  await env.DB.prepare("INSERT OR IGNORE INTO gmail_kv (k,v) VALUES ('lock','0')").run();
  const got = await env.DB.prepare("UPDATE gmail_kv SET v=? WHERE k='lock' AND CAST(v AS INTEGER) < ?").bind(String(t), t - 120000).run();
  if (!got.meta.changes) {
    if (ids) return { error: 'Another sync is running - try again in a minute' };
    await kvSet(env, 'again', '1');
    return { queued: true };
  }
  try {
    let o;
    do { await kvSet(env, 'again', '0'); o = await syncBookings(env, ids); } while (!ids && (await kvGet(env, 'again')) === '1');
    return o;
  } finally { await kvSet(env, 'lock', '0'); }
}

// ### 6c --- RPC entry for the main worker (service binding, not reachable from the internet)
export class GmailSync extends WorkerEntrypoint {
  async sync() {
    const env = this.env;
    await ensure(env);
    if ((await kvGet(env, 'auto')) !== '1' || !(await kvGet(env, 'refresh_token'))) return { skipped: true };
    return await runLocked(env, null);
  }
}

// ### 7 --- actions
async function act(env, d) {
  if (d.action === 'status') return { connected: !!(await kvGet(env, 'refresh_token')), email: await kvGet(env, 'email'), account: accountOf(env), auto: (await kvGet(env, 'auto')) === '1', country: await kvGet(env, 'country') || '', configured: !!(env.GOOGLE_CLIENT_ID && env.GOOGLE_CLIENT_SECRET) };
  if (d.action === 'list') return { bookings: await loadBookings(env) };
  if (d.action === 'sync') return await runLocked(env, d.ids || null);
  if (d.action === 'setAuto') { await kvSet(env, 'auto', d.value ? '1' : '0'); return { ok: true }; }
  if (d.action === 'setCountry') { await kvSet(env, 'country', digits(d.value)); return { ok: true }; }
  if (d.action === 'forget') { await env.DB.prepare('DELETE FROM gmail_sync WHERE booking_id=?').bind(d.id).run(); return { ok: true }; }
  if (d.action === 'disconnect') { await kvSet(env, 'refresh_token', ''); await kvSet(env, 'email', ''); return { ok: true }; }
  return { error: 'Unknown action' };
}

// ### 8 --- entry
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Methods': 'POST, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type, X-App-Key' } });
    const url = new URL(request.url);
    try {
      await ensure(env);
      if (url.pathname === '/auth/callback') return await authCallback(env, url);
      const key = request.headers.get('X-App-Key') || url.searchParams.get('k') || '';
      if (env.APP_KEY && key !== env.APP_KEY) return json({ error: 'Bad app key' }, 401);
      if (url.pathname === '/auth/start') return await authStart(env, url);
      if (url.pathname === '/api' && request.method === 'POST') return json(await act(env, JSON.parse(await request.text() || '{}')));
      return new Response('Not found', { status: 404 });
    } catch (e) { return json({ error: e.message }, 500); }
  }
};
