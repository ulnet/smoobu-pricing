import { esc, html, redirect, getCookie, signSession, checkSession, safeEq, slugify } from './util.js';
import { LEGAL_DEFAULTS } from './legal-defaults.js';

// ### 1 --- constants and page shell
const MAX_PHOTOS = 5;
const SETTING_DEFAULTS = { hold_minutes: 15, currency: 'GBP', site_name: 'Kazija', site_url: 'https://book.kazija.com', email_from: 'bookings@kazija.com', email_reply_to: '' };
const CSS = `*{box-sizing:border-box}body{font:15px/1.5 system-ui,sans-serif;margin:0;background:#f4f5f7;color:#1c1f24}header{background:#1c1f24;padding:0 16px;display:flex;flex-wrap:wrap;align-items:center;gap:4px;position:sticky;top:0}header a,header button{color:#fff;text-decoration:none;padding:12px;background:none;border:0;font:inherit;cursor:pointer}header a:hover,header button:hover{background:#333}header form{margin:0 0 0 auto}main{max-width:820px;margin:0 auto;padding:16px}h1{font-size:22px}h2{font-size:17px;margin:24px 0 8px}fieldset{border:1px solid #d5d8de;background:#fff;border-radius:8px;margin:0 0 16px;padding:12px 16px}legend{font-weight:600;padding:0 6px}label{display:block;margin:10px 0 2px;font-weight:600;font-size:13px}input[type=text],input[type=number],input[type=password],select,textarea{width:100%;padding:8px;border:1px solid #b8bdc7;border-radius:6px;font:inherit;background:#fff}textarea{min-height:110px}.row{display:flex;gap:12px;flex-wrap:wrap}.row>div{flex:1;min-width:140px}.hint{font-size:12px;color:#5b6270;margin:2px 0}button.p,.btn{background:#0a6cff;color:#fff;border:0;border-radius:6px;padding:9px 16px;font:inherit;cursor:pointer;text-decoration:none;display:inline-block}button.d{background:#c62828;color:#fff;border:0;border-radius:6px;padding:5px 10px;cursor:pointer}button.s{background:#eee;border:1px solid #bbb;border-radius:6px;padding:5px 10px;cursor:pointer}.msg{padding:10px 14px;border-radius:6px;margin:0 0 14px}.ok{background:#e3f6e8;color:#14552a}.err{background:#fde8e8;color:#8a1c1c}.warn{background:#fff4d6;color:#6b4b00}table{width:100%;border-collapse:collapse;background:#fff}td,th{padding:8px;border-bottom:1px solid #e4e6ea;text-align:left}.ph{display:flex;gap:12px;align-items:flex-start;padding:8px 0;border-bottom:1px solid #eee}.ph img{width:120px;height:80px;object-fit:cover;border-radius:4px}.ph>div{flex:1}.chk{display:flex;align-items:center;gap:8px;margin-top:10px}.chk label{margin:0}.rr{display:flex;gap:8px;align-items:center;flex-wrap:wrap;margin:6px 0}.rr input{width:90px}`;

function shell(title, nonce, body, nav = true, script = '') {
  const head = nav ? `<header><a href="/admin">Properties</a><a href="/admin/legal">Legal pages</a><a href="/admin/settings">Settings</a><form method="post" action="/admin/logout"><button>Log out</button></form></header>` : '';
  const csp = `default-src 'none'; style-src 'unsafe-inline'; script-src 'nonce-${nonce}'; img-src 'self' data: blob:; connect-src 'self'; form-action 'self'; frame-ancestors 'none'; base-uri 'none'`;
  return html(`<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta name="robots" content="noindex,nofollow"><title>${esc(title)}</title><style>${CSS}</style></head><body>${head}<main>${body}</main>${script ? `<script nonce="${nonce}">${script}</script>` : ''}</body></html>`, 200, { 'Content-Security-Policy': csp, 'Cache-Control': 'no-store' });
}

function banner(u) {
  const ok = u.searchParams.get('ok'), er = u.searchParams.get('err');
  return (ok ? `<div class="msg ok">${esc(ok)}</div>` : '') + (er ? `<div class="msg err">${esc(er)}</div>` : '');
}

function back(path, k, msg) { return redirect(path + '?' + k + '=' + encodeURIComponent(msg)); }

// ### 2 --- data helpers
async function metaGet(env, key) {
  const r = await env.DB.prepare(`SELECT value FROM meta WHERE key = ?`).bind(key).first();
  return r ? JSON.parse(r.value) : null;
}

async function smoobu(env, payload) {
  const r = await env.SMOOBU.fetch('https://smoobu-proxy-v2/', { method: 'POST', headers: { 'Content-Type': 'text/plain;charset=utf-8' }, body: JSON.stringify(payload) });
  return r.json();
}

async function getProps(env) {
  const j = await smoobu(env, { action: 'getMeta', key: 'apartments' });
  return Array.isArray(j.value) ? j.value : [];
}

async function listingNames(env) {
  try {
    const j = await smoobu(env, { action: 'getApartments' });
    const b = j.body || {}, list = Array.isArray(b) ? b : (b.apartments || []);
    const out = {};
    list.forEach(a => { out[String(a.id)] = a.name; });
    return out;
  } catch (e) { return {}; }
}

async function getSettings(env) {
  return Object.assign({}, SETTING_DEFAULTS, await metaGet(env, 'direct_settings') || {});
}

async function ensureRow(env, p) {
  let row = await env.DB.prepare(`SELECT * FROM site_content WHERE property_id = ?`).bind(p.id).first();
  if (row) return row;
  const base = slugify(p.name);
  let slug = base, n = 2;
  while (await env.DB.prepare(`SELECT 1 FROM site_content WHERE slug = ?`).bind(slug).first()) slug = base + '-' + n++;
  await env.DB.prepare(`INSERT INTO site_content (property_id, slug, title, updated_at) VALUES (?, ?, ?, ?)`).bind(p.id, slug, p.name, new Date().toISOString()).run();
  return env.DB.prepare(`SELECT * FROM site_content WHERE property_id = ?`).bind(p.id).first();
}

async function seedLegal(env) {
  const now = new Date().toISOString();
  for (const slug of Object.keys(LEGAL_DEFAULTS)) {
    await env.DB.prepare(`INSERT OR IGNORE INTO legal_pages (slug, title, body, updated_at) VALUES (?, ?, ?, ?)`).bind(slug, LEGAL_DEFAULTS[slug].title, LEGAL_DEFAULTS[slug].body, now).run();
  }
}

// ### 3 --- login and session
async function login(req, env, nonce, u) {
  if (!env.ADMIN_PASSWORD || !env.SESSION_SECRET) return shell('Admin login', nonce, `<div class="msg err">Admin is not configured yet: the ADMIN_PASSWORD and SESSION_SECRET secrets are missing.</div>`, false);
  const form = (msg) => shell('Admin login', nonce, `<h1>Admin login</h1>${msg ? `<div class="msg err">${esc(msg)}</div>` : ''}<form method="post" action="/admin/login"><label for="pw">Password</label><input type="password" id="pw" name="password" autocomplete="current-password" autofocus><p><button class="p">Log in</button></p></form>`, false);
  if (req.method !== 'POST') return form('');
  const ip = req.headers.get('CF-Connecting-IP') || 'x', now = Date.now();
  await env.DB.prepare(`DELETE FROM login_attempts WHERE ts < ?`).bind(now - 15 * 60000).run();
  const cnt = await env.DB.prepare(`SELECT COUNT(*) c FROM login_attempts WHERE ip = ?`).bind(ip).first();
  if (cnt.c >= 5) return form('Too many attempts. Try again in 15 minutes.');
  const pw = String((await req.formData()).get('password') || '');
  if (!(await safeEq(pw, env.ADMIN_PASSWORD, env.SESSION_SECRET))) {
    await env.DB.prepare(`INSERT INTO login_attempts (ip, ts) VALUES (?, ?)`).bind(ip, now).run();
    return form('Wrong password.');
  }
  await env.DB.prepare(`DELETE FROM login_attempts WHERE ip = ?`).bind(ip).run();
  const tok = await signSession(env, 8 * 3600 * 1000);
  return redirect('/admin', { 'Set-Cookie': `ds_admin=${tok}; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=28800` });
}

// ### 4 --- dashboard
async function dashboard(env, nonce, u) {
  const props = await getProps(env);
  const rows = [];
  for (const p of props) {
    const r = await ensureRow(env, p);
    const ph = JSON.parse(r.photo_keys).filter(x => !x.for).length;
    rows.push(`<tr><td><a href="/admin/property/${esc(p.id)}">${esc(p.name)}</a></td><td>/property/${esc(r.slug)}</td><td>${r.is_public ? 'Shown' : 'Hidden'}</td><td>${r.discount_pct}%</td><td>${ph}/${MAX_PHOTOS}</td></tr>`);
  }
  return shell('Admin', nonce, `<h1>Properties</h1>${banner(u)}<table><tr><th>Property</th><th>Page</th><th>On site</th><th>Direct discount</th><th>Photos</th></tr>${rows.join('') || '<tr><td colspan="5">No properties found in the apartments setting.</td></tr>'}</table><p class="hint">Properties come from your existing Properties setting in the tracker. Add or rename them there.</p>`);
}

// ### 5 --- property editor
function photoGroup(pid, photos, grp, n) {
  const mine = photos.map((ph, i) => ({ ph, i })).filter(x => (x.ph.for || '') === grp);
  const rows = mine.map((x, j) => `<div class="ph"><img src="/img/${esc(x.ph.key)}" alt="${esc(x.ph.alt)}"><div><label for="alt${x.i}">Alt text (describe the photo, needed for SEO and accessibility)</label><input type="text" id="alt${x.i}" name="alt${x.i}" maxlength="160" value="${esc(x.ph.alt)}"></div><div style="flex:0 0 auto">${j ? `<button class="s" formaction="/admin/property/${esc(pid)}/photo-first" name="key" value="${esc(x.ph.key)}">Make first</button> ` : '<em>Cover</em> '}<button class="d" formaction="/admin/property/${esc(pid)}/photo-delete" name="key" value="${esc(x.ph.key)}">Delete</button></div></div>`).join('');
  const add = mine.length < MAX_PHOTOS ? `<p><label for="up${n}">Add photos (${mine.length}/${MAX_PHOTOS}). You can select several at once. Save your other changes first.</label><input type="file" id="up${n}" accept="image/*" multiple data-url="/admin/photo/${esc(pid)}?g=${esc(grp)}" data-left="${MAX_PHOTOS - mine.length}"><span class="hint"></span></p>` : `<p class="hint">Maximum ${MAX_PHOTOS} photos. Delete one to add another.</p>`;
  return rows + add;
}

function ruleRow(i, x) {
  return `<div class="rr"><input type="number" aria-label="Days before arrival" name="rdays${i}" min="0" max="365" value="${x.daysBefore == null ? '' : x.daysBefore}"> days or more before arrival: <input type="number" aria-label="Refund percent" name="rpct${i}" min="0" max="100" value="${x.refundPct == null ? '' : x.refundPct}"> % refunded <button type="button" class="s rm">Remove</button></div>`;
}

async function propertyPage(env, nonce, u, pid) {
  const props = await getProps(env), p = props.find(x => x.id === pid);
  if (!p) return shell('Not found', nonce, '<h1>Property not found</h1>');
  const r = await ensureRow(env, p), names = await listingNames(env);
  const rules = JSON.parse(r.refund_rules), rooms = JSON.parse(r.room_content), photos = JSON.parse(r.photo_keys);
  const ids = (p.listingIds || []).map(String);
  const roomHtml = ids.filter(id => id !== r.whole_listing_id).map(id => { const c = rooms[id] || {}; return `<fieldset><legend>Room: ${esc(names[id] || 'Listing')} (${esc(id)})</legend><label for="rt${id}">Room title on site</label><input type="text" id="rt${id}" name="rt_${esc(id)}" maxlength="120" value="${esc(c.t || '')}"><label for="rd${id}">Room description</label><textarea id="rd${id}" name="rd_${esc(id)}" maxlength="2000">${esc(c.d || '')}</textarea><label for="rc${id}">Cleaning fee (£, per stay)</label><input type="number" id="rc${id}" name="rc_${esc(id)}" min="0" step="0.01" value="${c.c ? (c.c / 100).toFixed(2) : ''}"><h2>Room photos</h2>${photoGroup(pid, photos, id, 'r' + id)}</fieldset>`; }).join('');
  const wholeOpts = `<option value="">None (whole property = sum of all rooms)</option>` + ids.map(id => `<option value="${esc(id)}"${id === r.whole_listing_id ? ' selected' : ''}>${esc(names[id] || 'Listing')} (${esc(id)})</option>`).join('');
  const rr = rules.length ? rules : [{}];
  const ruleRows = `<div id="rules" data-n="${rr.length}">${rr.map((x, n) => ruleRow(n, x)).join('')}</div><template id="rtpl">${ruleRow('__i__', {})}</template><p><button type="button" class="s" id="addr">+ Add tier</button></p>`;
  const body = `<p><a href="/admin">← All properties</a></p><h1>${esc(p.name)}</h1>${banner(u)}<form method="post" action="/admin/property/${esc(pid)}">
<fieldset><legend>Visibility and page</legend><div class="chk"><input type="checkbox" id="pub" name="is_public" value="1"${r.is_public ? ' checked' : ''}><label for="pub">Show this property on the site</label></div>
<label for="slug">Page address (slug): /property/…</label><input type="text" id="slug" name="slug" maxlength="60" value="${esc(r.slug)}">
<label for="title">Page title</label><input type="text" id="title" name="title" maxlength="120" value="${esc(r.title)}">
<label for="desc">Description</label><textarea id="desc" name="description" maxlength="4000">${esc(r.description)}</textarea>
<label for="gbp">Google Business Profile link (optional)</label><input type="text" id="gbp" name="gbp_link" maxlength="300" value="${esc(r.gbp_link)}"></fieldset>
<fieldset><legend>SEO</legend><label for="st">SEO title (up to 70 characters)</label><input type="text" id="st" name="seo_title" maxlength="70" value="${esc(r.seo_title)}"><label for="sd">SEO description (up to 170 characters)</label><textarea id="sd" name="seo_description" maxlength="170" style="min-height:70px">${esc(r.seo_description)}</textarea></fieldset>
<fieldset><legend>Booking and pricing</legend><label for="mode">Booking mode</label><select id="mode" name="mode"><option value="instant" selected>Instant booking</option><option disabled>Request to book (later)</option><option disabled>Guest chooses (later)</option></select>
<div class="row"><div><label for="disc">Direct-booking discount (% off nightly rate)</label><input type="number" id="disc" name="discount_pct" min="0" max="100" step="0.1" value="${r.discount_pct}"></div><div><label for="bg">Guests included in the rate</label><input type="number" id="bg" name="base_guests" min="1" max="50" value="${r.base_guests}"></div><div><label for="eg">Extra guest fee (% of nightly rate, per extra guest, per night)</label><input type="number" id="eg" name="extra_guest_pct" min="0" max="100" step="0.1" value="${r.extra_guest_pct}"></div></div>
<label for="whole">Whole-property listing</label><select id="whole" name="whole_listing_id">${wholeOpts}</select><p class="hint">Only if you have a separate Smoobu listing that represents the whole property (e.g. Graville). It is not shown as a room and is excluded from capacity counts.</p></fieldset>
<fieldset><legend>Cancellation and refunds</legend><label for="nr">Non-refundable portion (% of the total, never refunded)</label><input type="number" id="nr" name="nonrefundable_pct" min="0" max="100" step="0.1" value="${r.nonrefundable_pct}">
<p class="hint">Tiers apply to the refundable amount. The first tier (largest days) that the cancellation date satisfies is used. Cancelling later than every tier refunds nothing. With no tiers, cancelling is always fully refundable.</p>${ruleRows}</fieldset>
${roomHtml}
<fieldset><legend>Property photos (gallery)</legend>${photoGroup(pid, photos, '', 'p')}</fieldset>
<p><button class="p">Save</button> <button class="s" name="next" value="1">Save and close</button></p></form>`;
  const script = `document.querySelectorAll('input[data-url]').forEach(inp=>inp.addEventListener('change',async()=>{const st=inp.nextElementSibling,fs=[...inp.files].slice(0,+inp.dataset.left);let n=0;for(const f of fs){st.textContent=' Uploading '+(++n)+'/'+fs.length+'…';try{const b=await createImageBitmap(f),s=Math.min(1,1600/Math.max(b.width,b.height)),c=document.createElement('canvas');c.width=Math.round(b.width*s);c.height=Math.round(b.height*s);c.getContext('2d').drawImage(b,0,0,c.width,c.height);const blob=await new Promise(r=>c.toBlob(r,'image/jpeg',0.82)),r=await fetch(inp.dataset.url,{method:'POST',body:blob,headers:{'Content-Type':'image/jpeg'}});if(!r.ok){st.textContent=' Failed: '+await r.text();return}}catch(e){st.textContent=' Failed: '+e.message;return}}location.reload()}));const rl=document.getElementById('rules'),tp=document.getElementById('rtpl');let ri=+rl.dataset.n;document.getElementById('addr').addEventListener('click',()=>{if(ri>=8)return;const d=document.createElement('div');d.innerHTML=tp.innerHTML.replace(/__i__/g,ri++);rl.appendChild(d.firstElementChild)});rl.addEventListener('click',e=>{if(e.target.classList.contains('rm')){const d=e.target.closest('.rr');d.querySelectorAll('input').forEach(x=>x.value='');d.style.display='none'}});`;
  return shell(p.name, nonce, body, true, script);
}

function mergeAlts(photos, f) {
  return photos.map((ph, i) => ({ key: ph.key, alt: f.has('alt' + i) ? String(f.get('alt' + i)).slice(0, 160) : ph.alt, for: ph.for || '' }));
}

async function saveProperty(env, pid, f) {
  const props = await getProps(env), p = props.find(x => x.id === pid);
  if (!p) return 'Property not found.';
  const r = await ensureRow(env, p);
  const num = (k, lo, hi, d) => { const v = parseFloat(f.get(k)); return isNaN(v) ? d : Math.min(hi, Math.max(lo, v)); };
  const txt = (k, n) => String(f.get(k) || '').trim().slice(0, n);
  const slug = txt('slug', 60).toLowerCase();
  if (!/^[a-z0-9]+(-[a-z0-9]+)*$/.test(slug)) return 'Slug can only use lowercase letters, numbers and single hyphens.';
  if (await env.DB.prepare(`SELECT 1 FROM site_content WHERE slug = ? AND property_id != ?`).bind(slug, pid).first()) return 'That slug is already used by another property.';
  const gbp = txt('gbp_link', 300);
  if (gbp && !/^https:\/\//.test(gbp)) return 'Google Business Profile link must start with https://';
  const ids = (p.listingIds || []).map(String);
  const whole = txt('whole_listing_id', 30);
  if (whole && !ids.includes(whole)) return 'Whole-property listing must be one of this property\'s listings.';
  const rules = [0, 1, 2, 3, 4, 5, 6, 7].map(i => ({ d: parseInt(f.get('rdays' + i), 10), p: parseFloat(f.get('rpct' + i)) })).filter(x => !isNaN(x.d) && !isNaN(x.p)).map(x => ({ daysBefore: Math.min(365, Math.max(0, x.d)), refundPct: Math.min(100, Math.max(0, x.p)) })).sort((a, b) => b.daysBefore - a.daysBefore);
  const rooms = {};
  ids.forEach(id => { rooms[id] = { t: txt('rt_' + id, 120), d: txt('rd_' + id, 2000), c: Math.round(Math.max(0, parseFloat(f.get('rc_' + id)) || 0) * 100) }; });
  await env.DB.prepare(`UPDATE site_content SET slug=?, is_public=?, title=?, description=?, seo_title=?, seo_description=?, mode='instant', discount_pct=?, base_guests=?, extra_guest_pct=?, refund_rules=?, nonrefundable_pct=?, whole_listing_id=?, room_content=?, photo_keys=?, gbp_link=?, updated_at=? WHERE property_id=?`)
    .bind(slug, f.get('is_public') ? 1 : 0, txt('title', 120), txt('description', 4000), txt('seo_title', 70), txt('seo_description', 170), num('discount_pct', 0, 100, 0), Math.round(num('base_guests', 1, 50, 2)), num('extra_guest_pct', 0, 100, 0), JSON.stringify(rules), num('nonrefundable_pct', 0, 100, 0), whole || null, JSON.stringify(rooms), JSON.stringify(mergeAlts(JSON.parse(r.photo_keys), f)), gbp, new Date().toISOString(), pid).run();
  return '';
}

async function photoAction(env, pid, f, act) {
  const r = await env.DB.prepare(`SELECT photo_keys FROM site_content WHERE property_id = ?`).bind(pid).first();
  if (!r) return;
  let photos = mergeAlts(JSON.parse(r.photo_keys), f);
  const key = String(f.get('key') || '');
  if (act === 'delete') {
    photos = photos.filter(x => x.key !== key);
    await env.PHOTOS.delete('p/' + key);
  } else {
    const hit = photos.find(x => x.key === key);
    if (hit) {
      const rest = photos.filter(x => x !== hit), at = rest.findIndex(x => x.for === hit.for);
      rest.splice(at < 0 ? 0 : at, 0, hit);
      photos = rest;
    }
  }
  await env.DB.prepare(`UPDATE site_content SET photo_keys = ? WHERE property_id = ?`).bind(JSON.stringify(photos), pid).run();
}

async function uploadPhoto(req, env, pid, grp) {
  const props = await getProps(env), p = props.find(x => x.id === pid);
  if (!p) return new Response('Property not found', { status: 404 });
  const r = await ensureRow(env, p), photos = JSON.parse(r.photo_keys);
  if (grp && !(p.listingIds || []).map(String).includes(grp)) return new Response('Unknown room', { status: 400 });
  if (photos.filter(x => (x.for || '') === grp).length >= MAX_PHOTOS) return new Response('Maximum ' + MAX_PHOTOS + ' photos here', { status: 400 });
  const buf = await req.arrayBuffer(), b = new Uint8Array(buf);
  if (buf.byteLength > 2500000) return new Response('Image too large', { status: 413 });
  if (!(b[0] === 0xFF && b[1] === 0xD8 && b[2] === 0xFF)) return new Response('Not a JPEG', { status: 400 });
  const key = crypto.randomUUID() + '.jpg';
  await env.PHOTOS.put('p/' + key, buf, { httpMetadata: { contentType: 'image/jpeg' } });
  photos.push({ key, alt: '', for: grp });
  await env.DB.prepare(`UPDATE site_content SET photo_keys = ? WHERE property_id = ?`).bind(JSON.stringify(photos), pid).run();
  return new Response('ok');
}

// ### 6 --- legal pages
async function legalList(env, nonce, u) {
  await seedLegal(env);
  const rows = (await env.DB.prepare(`SELECT slug, title, updated_at FROM legal_pages ORDER BY slug`).all()).results;
  return shell('Legal pages', nonce, `<h1>Legal pages</h1>${banner(u)}<div class="msg warn">These are sample placeholders, not legal advice. Have them reviewed by a solicitor before going live.</div><table><tr><th>Page</th><th>Address</th><th>Last edited</th></tr>${rows.map(x => `<tr><td><a href="/admin/legal/${esc(x.slug)}">${esc(x.title)}</a></td><td>/legal/${esc(x.slug)}</td><td>${esc((x.updated_at || '').slice(0, 10))}</td></tr>`).join('')}</table>`);
}

async function legalEdit(env, nonce, u, slug) {
  await seedLegal(env);
  const r = await env.DB.prepare(`SELECT * FROM legal_pages WHERE slug = ?`).bind(slug).first();
  if (!r) return shell('Not found', nonce, '<h1>Page not found</h1>');
  return shell(r.title, nonce, `<p><a href="/admin/legal">← All legal pages</a></p><h1>${esc(r.title)}</h1>${banner(u)}<div class="msg warn">Sample text. Get it reviewed before going live.</div><form method="post" action="/admin/legal/${esc(slug)}"><label for="t">Title</label><input type="text" id="t" name="title" maxlength="120" value="${esc(r.title)}"><label for="b">Text (blank line = new paragraph)</label><textarea id="b" name="body" maxlength="30000" style="min-height:420px">${esc(r.body)}</textarea><p><button class="p">Save</button> <button class="s" name="next" value="1">Save and close</button></p></form>`);
}

async function legalSave(env, slug, f) {
  await env.DB.prepare(`UPDATE legal_pages SET title = ?, body = ?, updated_at = ? WHERE slug = ?`).bind(String(f.get('title') || '').slice(0, 120), String(f.get('body') || '').slice(0, 30000), new Date().toISOString(), slug).run();
}

// ### 7 --- settings
async function settingsPage(env, nonce, u) {
  const s = await getSettings(env);
  const fld = (k, l, type = 'text', extra = '') => `<label for="${k}">${l}</label><input type="${type}" id="${k}" name="${k}" value="${esc(s[k])}" ${extra}>`;
  return shell('Settings', nonce, `<h1>Settings</h1>${banner(u)}<form method="post" action="/admin/settings"><fieldset><legend>Site</legend>${fld('site_name', 'Site name')}${fld('site_url', 'Site address (https://…)')}${fld('currency', 'Currency code', 'text', 'maxlength="3"')}</fieldset><fieldset><legend>Checkout</legend>${fld('hold_minutes', 'Checkout hold (minutes the dates are reserved while a guest pays)', 'number', 'min="5" max="60"')}</fieldset><fieldset><legend>Guest emails</legend>${fld('email_from', 'From address')}${fld('email_reply_to', 'Reply-to address (optional)')}</fieldset><p><button class="p">Save</button></p></form>`);
}

async function settingsSave(env, f) {
  const v = k => String(f.get(k) || '').trim();
  const url = v('site_url').replace(/\/+$/, '');
  if (!/^https:\/\/[a-z0-9.-]+$/i.test(url)) return 'Site address must look like https://book.example.com';
  const hold = Math.min(60, Math.max(5, parseInt(v('hold_minutes'), 10) || 15));
  const em = x => /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(x);
  if (!em(v('email_from'))) return 'From address is not a valid email.';
  if (v('email_reply_to') && !em(v('email_reply_to'))) return 'Reply-to is not a valid email.';
  const s = { hold_minutes: hold, currency: (v('currency') || 'GBP').toUpperCase().slice(0, 3), site_name: v('site_name').slice(0, 80) || 'Kazija', site_url: url, email_from: v('email_from'), email_reply_to: v('email_reply_to') };
  await env.DB.prepare(`INSERT INTO meta (key, value) VALUES ('direct_settings', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`).bind(JSON.stringify(s)).run();
  return '';
}

// ### 8 --- router
export default async function admin(req, env, u) {
  const p = u.pathname.replace(/\/+$/, '') || '/admin', m = req.method;
  const nonce = crypto.randomUUID().replace(/-/g, '');
  if (m === 'POST' && req.headers.get('Origin') !== u.origin) return new Response('Bad origin', { status: 403 });
  if (p === '/admin/login') return login(req, env, nonce, u);
  if (!(await checkSession(env, getCookie(req, 'ds_admin')))) return redirect('/admin/login');
  if (p === '/admin/logout' && m === 'POST') return redirect('/admin/login', { 'Set-Cookie': 'ds_admin=; Path=/admin; HttpOnly; Secure; SameSite=Strict; Max-Age=0' });
  if (p === '/admin' && m === 'GET') return dashboard(env, nonce, u);
  let x;
  if ((x = p.match(/^\/admin\/property\/([\w-]+)$/))) {
    if (m === 'GET') return propertyPage(env, nonce, u, x[1]);
    const f = await req.formData(), err = await saveProperty(env, x[1], f);
    if (err) return back(p, 'err', err);
    return f.get('next') ? back('/admin', 'ok', 'Saved.') : back(p, 'ok', 'Saved.');
  }
  if ((x = p.match(/^\/admin\/property\/([\w-]+)\/photo-(delete|first)$/)) && m === 'POST') {
    await photoAction(env, x[1], await req.formData(), x[2]);
    return back('/admin/property/' + x[1], 'ok', x[2] === 'delete' ? 'Photo deleted.' : 'Cover photo changed.');
  }
  if ((x = p.match(/^\/admin\/photo\/([\w-]+)$/)) && m === 'POST') return uploadPhoto(req, env, x[1], u.searchParams.get('g') || '');
  if (p === '/admin/legal' && m === 'GET') return legalList(env, nonce, u);
  if ((x = p.match(/^\/admin\/legal\/([\w-]+)$/))) {
    if (m === 'GET') return legalEdit(env, nonce, u, x[1]);
    const f = await req.formData();
    await legalSave(env, x[1], f);
    return f.get('next') ? back('/admin/legal', 'ok', 'Saved.') : back(p, 'ok', 'Saved.');
  }
  if (p === '/admin/settings') {
    if (m === 'GET') return settingsPage(env, nonce, u);
    const err = await settingsSave(env, await req.formData());
    return err ? back(p, 'err', err) : back(p, 'ok', 'Saved.');
  }
  return shell('Not found', nonce, '<h1>Not found</h1>');
}
