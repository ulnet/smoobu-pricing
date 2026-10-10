import { esc, redirect } from './util.js';
import { layout, paras, img, absUrl } from './layout.js';
import { bookPage, bookingPage, startCheckout, payWebhook } from './bookings.js';
import { loadProperties, loadBySlug, roomIds, getFacts, getSettings, quoteAll, money, allow, telegram } from './public.js';

// ### 2 --- home
async function home(env, u) {
  const S = await getSettings(env), props = await loadProperties(env);
  const facts = await getFacts(env, props.flatMap(x => roomIds(x.p, x.r)));
  const cards = props.map(({ p, r }) => {
    const ids = roomIds(p, r), mins = ids.map(id => facts[id] && facts[id].priceMin).filter(Boolean);
    const from = mins.length ? `<span class="muted">from ${money(Math.round(Math.min(...mins) * 100 * (100 - r.discount_pct) / 100))} / night</span>` : '';
    const cover = r.photos.find(x => !x.for);
    return `<a class="card" href="/property/${esc(r.slug)}">${img(cover, false)}<div><strong>${esc(r.title || p.name)}</strong>${from}<div class="muted" style="padding:4px 0 0">${ids.length} room${ids.length === 1 ? '' : 's'}</div></div></a>`;
  }).join('');
  return layout(S, u, { title: S.site_name + ' - book direct', desc: 'Book holiday accommodation direct with ' + S.site_name + ' and save on booking-site prices.', path: '/', image: (props[0] && props[0].r.photos[0] || {}).key }, `<h1>${esc(S.site_name)}</h1><p class="muted">Book direct for the best price.</p><div class="grid">${cards || '<p>No properties available yet.</p>'}</div>`);
}

// ### 3 --- property page
function aggregate(ids, facts) {
  const f = ids.map(id => facts[id]).filter(Boolean);
  const add = k => f.reduce((s, x) => s + (x[k] || 0), 0);
  const am = []; f.forEach(x => x.amenities.forEach(a => { if (!am.includes(a)) am.push(a); }));
  return { guests: add('maxOccupancy'), bedrooms: add('bedrooms'), bathrooms: add('bathrooms'), amenities: am, addr: f.find(x => x.city) || f[0] || {} };
}

function quoteCard(label, q, nameOf, photo, slug) {
  const head = `<div class="room">${photo ? img(photo, false) : ''}<div style="flex:1"><strong>${esc(label)}</strong>`;
  if (!q.ok) return `${head}<div class="muted">${esc(q.error)}</div></div></div>`;
  const save = q.otaTotal - q.total, st = x => (q.discountPct ? '<s>' + money(x.ota) + '</s> ' : '') + money(x.direct);
  const nightRows = q.lines.map(x => `<tr><td>${esc(x.date)}</td><td>${st(x)}</td></tr>`).join('');
  const roomRows = q.scope === 'whole' ? q.perRoom.map(x => `<tr><td>${esc(nameOf(x.id))}</td><td>${st(x)}</td></tr>`).join('') : '';
  const fees = (q.extraGuestFee ? `<tr><td>Extra guests (${q.extraGuests})</td><td>${money(q.extraGuestFee)}</td></tr>` : '') + (q.cleaning ? `<tr><td>Cleaning fee</td><td>${money(q.cleaning)}</td></tr>` : '');
  return `${head}<div><span style="font-size:22px;font-weight:700">${money(q.total)}</span> total${save > 0 ? ` <s>${money(q.otaTotal)}</s> <span class="muted">(save ${money(save)})</span>` : ''}<br><span class="muted">${q.nights} night${q.nights === 1 ? '' : 's'}, ${q.guests} guest${q.guests === 1 ? '' : 's'}</span></div><details><summary class="muted">Price breakdown</summary>${roomRows ? `<p class="muted" style="margin:6px 0 0">By room</p><table class="q">${roomRows}</table>` : ''}<p class="muted" style="margin:6px 0 0">By night${q.scope === 'whole' ? ' (all rooms)' : ''}</p><table class="q">${nightRows}${fees}<tr class="tot"><td>Total</td><td>${money(q.total)}</td></tr></table></details><a class="btn" style="text-decoration:none" href="/book/${esc(slug)}?scope=${esc(q.scope)}&amp;arrival=${esc(q.arrival)}&amp;departure=${esc(q.departure)}&amp;guests=${q.guests}">Book</a></div></div>`;
}

async function propertyPage(env, u, slug, sent, ip) {
  const S = await getSettings(env), item = await loadBySlug(env, slug);
  if (!item) return layout(S, u, { title: 'Not found', noindex: true, status: 404, path: u.pathname }, '<h1>Not found</h1><p><a href="/">Back to all properties</a></p>');
  const { p, r } = item, ids = roomIds(p, r), facts = await getFacts(env, ids), ag = aggregate(ids, facts);
  const title = r.title || p.name, gallery = r.photos.filter(x => !x.for);
  const sp = u.searchParams, scope = sp.get('scope') || '', arrival = sp.get('arrival') || '', departure = sp.get('departure') || '', guests = sp.get('guests') || '2';
  const today = new Date().toISOString().slice(0, 10);
  const nameOf = id => (r.room_content[id] && r.room_content[id].t) || (facts[id] && facts[id].name) || 'Room';
  const opts = (ids.length > 1 ? `<option value="whole"${scope === 'whole' ? ' selected' : ''}>Whole property</option>` : '') + ids.map(id => `<option value="${esc(id)}"${scope === id ? ' selected' : ''}>${esc(nameOf(id))}</option>`).join('');
  let result = '';
  if (arrival && departure) {
    if (!(await allow(env, 'q:' + ip, 40, 600))) result = '<div class="msg bad">Too many searches. Please wait a few minutes.</div>';
    else {
      let qa;
      try { qa = await quoteAll(env, p, r, arrival, departure, guests); } catch (e) { console.error(e.stack || e.message); qa = { ok: false, error: 'Prices are temporarily unavailable. Please send an enquiry.' }; }
      if (!qa.ok) result = `<div class="msg bad">${esc(qa.error)}</div>`;
      else {
        const any = qa.results.some(x => x.q.ok);
        result = `<h3>${esc(arrival)} to ${esc(departure)}</h3>${any ? '' : '<div class="msg bad">Nothing is available for these dates. Send us an enquiry below and we will see what we can do.</div>'}` + qa.results.map(x => quoteCard(x.scope === 'whole' ? 'Whole property' : nameOf(x.scope), x.q, nameOf, x.scope === 'whole' ? gallery[0] : r.photos.find(y => y.for === x.scope), r.slug)).join('') + '<p class="muted">Struck-through prices are the equivalent total on booking sites.</p>';
      }
    }
  }
  const roomsHtml = ids.length > 1 || r.room_content[ids[0]] ? ids.map(id => { const c = r.room_content[id] || {}, f = facts[id] || {}, cover = r.photos.find(x => x.for === id); return `<div class="room">${img(cover, false)}<div><strong>${esc(nameOf(id))}</strong><div class="muted">${[f.maxOccupancy ? 'Sleeps ' + f.maxOccupancy : '', f.bedrooms ? f.bedrooms + ' bedroom' + (f.bedrooms > 1 ? 's' : '') : '', f.bathrooms ? f.bathrooms + ' bathroom' + (f.bathrooms > 1 ? 's' : '') : ''].filter(Boolean).join(' · ')}</div>${paras(c.d)}</div></div>`; }).join('') : '';
  const factList = [ag.guests ? 'Sleeps ' + ag.guests : '', ag.bedrooms ? ag.bedrooms + ' bedroom' + (ag.bedrooms > 1 ? 's' : '') : '', ag.bathrooms ? ag.bathrooms + ' bathroom' + (ag.bathrooms > 1 ? 's' : '') : ''].filter(Boolean).map(x => `<li>${esc(x)}</li>`).join('');
  const loc = [ag.addr.city, ag.addr.country].filter(Boolean).join(', ');
  const hp = `<input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true">`;
  const enq = `<h2 id="enquire">Enquire about these dates</h2>${sent ? '<div class="msg good">Thanks, we have your enquiry and will reply soon.</div>' : ''}<form class="box" method="post" action="/public/enquiry"><input type="hidden" name="slug" value="${esc(r.slug)}">${hp}<div class="r"><div><label for="ea">Arrival</label><input type="date" id="ea" name="arrival" value="${esc(arrival)}" min="${today}"></div><div><label for="ed">Departure</label><input type="date" id="ed" name="departure" value="${esc(departure)}" min="${today}"></div><div><label for="eg">Guests</label><input type="number" id="eg" name="guests" min="1" max="50" value="${esc(guests)}"></div></div><label for="es">About</label><select id="es" name="scope">${opts}</select><div class="r"><div><label for="en">Your name</label><input type="text" id="en" name="name" required maxlength="100"></div><div><label for="ee">Email</label><input type="email" id="ee" name="email" required maxlength="200"></div><div><label for="ep">Phone (optional)</label><input type="text" id="ep" name="phone" maxlength="40"></div></div><label for="em">Message</label><textarea id="em" name="message" required maxlength="2000" rows="4"></textarea><button class="btn">Send enquiry</button></form>`;
  const body = `<h1>${esc(title)}</h1>${loc ? `<p class="muted">${esc(loc)}</p>` : ''}${gallery.length ? `<div class="gal">${img(gallery[0], true)}<div class="thumbs">${gallery.slice(1).map(x => img(x, false)).join('')}</div></div>` : ''}<ul class="facts">${factList}</ul>${paras(r.description)}${ag.amenities.length ? `<h2>Amenities</h2><ul class="chips">${ag.amenities.map(a => `<li>${esc(a)}</li>`).join('')}</ul>` : ''}${roomsHtml ? `<h2>Rooms</h2>${roomsHtml}` : ''}<h2 id="book">Check availability and price</h2><form class="box" method="get" action="/property/${esc(r.slug)}#book"><div class="r"><div><label for="a">Arrival</label><input type="date" id="a" name="arrival" value="${esc(arrival)}" min="${today}" required></div><div><label for="d">Departure</label><input type="date" id="d" name="departure" value="${esc(departure)}" min="${today}" required></div><div><label for="g">Guests</label><input type="number" id="g" name="guests" min="1" max="50" value="${esc(guests)}" required></div></div><button class="btn">Check prices</button></form>${result}${enq}${r.gbp_link ? `<p><a href="${esc(r.gbp_link)}" rel="noopener">Find us on Google</a></p>` : ''}`;
  const addr = ag.addr, images = gallery.map(x => absUrl(S, '/img/' + x.key));
  const jsonld = { '@context': 'https://schema.org', '@type': 'VacationRental', name: title, description: r.seo_description || r.description.slice(0, 300), url: absUrl(S, '/property/' + r.slug), identifier: r.slug, image: images, address: { '@type': 'PostalAddress', streetAddress: addr.street || undefined, addressLocality: addr.city || undefined, postalCode: addr.zip || undefined, addressCountry: addr.country || undefined }, latitude: addr.lat || undefined, longitude: addr.lng || undefined, containsPlace: { '@type': 'Accommodation', additionalType: 'EntirePlace', occupancy: ag.guests ? { '@type': 'QuantitativeValue', value: ag.guests } : undefined, numberOfBedrooms: ag.bedrooms || undefined, numberOfBathroomsTotal: ag.bathrooms || undefined, amenityFeature: ag.amenities.map(a => ({ '@type': 'LocationFeatureSpecification', name: a, value: true })) } };
  return layout(S, u, { title: r.seo_title || (title + ' | ' + S.site_name), desc: r.seo_description || r.description.slice(0, 160), path: '/property/' + r.slug, image: gallery[0] && gallery[0].key, jsonld, cache: arrival || sent ? 'no-store' : undefined }, body);
}

// ### 4 --- legal, sitemap, robots
async function legal(env, u, slug) {
  const S = await getSettings(env), r = await env.DB.prepare(`SELECT * FROM legal_pages WHERE slug = ?`).bind(slug).first();
  if (!r) return layout(S, u, { title: 'Not found', noindex: true, status: 404, path: u.pathname }, '<h1>Not found</h1>');
  return layout(S, u, { title: r.title + ' | ' + S.site_name, desc: r.title, path: '/legal/' + r.slug }, `<p><a href="/">← Back to properties</a></p><h1>${esc(r.title)}</h1>${paras(r.body)}<p><a href="/">← Back to properties</a></p>`);
}

async function sitemap(env) {
  const S = await getSettings(env), props = await loadProperties(env);
  const legalRows = (await env.DB.prepare(`SELECT slug FROM legal_pages`).all()).results;
  const urls = [{ loc: '/', mod: '' }].concat(props.map(x => ({ loc: '/property/' + x.r.slug, mod: (x.r.updated_at || '').slice(0, 10) })), legalRows.map(x => ({ loc: '/legal/' + x.slug, mod: '' })));
  return new Response(`<?xml version="1.0" encoding="UTF-8"?><urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">${urls.map(x => `<url><loc>${esc(S.site_url + x.loc)}</loc>${x.mod ? '<lastmod>' + x.mod + '</lastmod>' : ''}</url>`).join('')}</urlset>`, { headers: { 'Content-Type': 'application/xml', 'Cache-Control': 'public, max-age=3600' } });
}

async function robots(env) {
  const S = await getSettings(env);
  return new Response(`User-agent: *\nDisallow: /admin\nDisallow: /public/\nAllow: /\n\nSitemap: ${S.site_url}/sitemap.xml\n`, { headers: { 'Content-Type': 'text/plain', 'Cache-Control': 'public, max-age=3600' } });
}

// ### 5 --- public json and enquiry handler
async function enquiry(req, env, u) {
  if (req.headers.get('Origin') !== u.origin) return new Response('Bad origin', { status: 403 });
  const f = await req.formData(), ip = req.headers.get('CF-Connecting-IP') || 'x', v = (k, n) => String(f.get(k) || '').trim().slice(0, n);
  if (f.get('website')) return redirect('/');
  const item = await loadBySlug(env, v('slug', 80));
  if (!item) return new Response('Unknown property', { status: 400 });
  const name = v('name', 100), email = v('email', 200), message = v('message', 2000);
  if (!name || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !message) return new Response('Please fill in your name, a valid email and a message.', { status: 400 });
  if (!(await allow(env, 'e:' + ip, 5, 3600))) return new Response('Too many enquiries. Please try again later.', { status: 429 });
  const d = k => /^\d{4}-\d{2}-\d{2}$/.test(v(k, 10)) ? v(k, 10) : '';
  const scope = v('scope', 30), label = scope === 'whole' ? 'Whole property' : 'Room ' + scope;
  const id = crypto.randomUUID();
  await env.DB.prepare(`INSERT INTO enquiries (id, property_id, arrival, departure, guests, name, email, phone, message, status, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, 'new', ?)`).bind(id, item.p.id, d('arrival'), d('departure'), Math.round(Number(f.get('guests'))) || null, name, email, v('phone', 40), label + '\n' + message, new Date().toISOString()).run();
  await telegram(env, '📩 Enquiry: ' + item.p.name + ' (' + label + ') ' + d('arrival') + ' to ' + d('departure') + '\n' + name + ' <' + email + '>\n' + message.slice(0, 300));
  return redirect('/property/' + item.r.slug + '?sent=1#enquire');
}

async function quoteJson(req, env, u) {
  if (req.headers.get('Origin') !== u.origin) return new Response('Bad origin', { status: 403 });
  const ip = req.headers.get('CF-Connecting-IP') || 'x';
  if (!(await allow(env, 'q:' + ip, 40, 600))) return Response.json({ ok: false, error: 'Too many requests' }, { status: 429 });
  let b;
  try { b = JSON.parse(await req.text()); } catch (e) { return Response.json({ ok: false, error: 'Bad request' }, { status: 400 }); }
  const item = await loadBySlug(env, String(b.slug || ''));
  if (!item) return Response.json({ ok: false, error: 'Unknown property' }, { status: 404 });
  return Response.json(await quote(env, item.p, item.r, String(b.scope || 'whole'), b.arrival, b.departure, b.guests));
}

async function propertiesJson(env) {
  const props = await loadProperties(env);
  return Response.json(props.map(x => ({ slug: x.r.slug, title: x.r.title || x.p.name, mode: x.r.mode, rooms: roomIds(x.p, x.r).length })));
}

// ### 6 --- router
export default async function site(req, env, u) {
  const p = u.pathname.replace(/\/+$/, '') || '/', m = req.method;
  let x;
  if (m === 'GET') {
    if (p === '/') return home(env, u);
    if ((x = p.match(/^\/property\/([a-z0-9-]+)$/))) return propertyPage(env, u, x[1], u.searchParams.get('sent'), req.headers.get('CF-Connecting-IP') || 'x');
    if ((x = p.match(/^\/legal\/([a-z0-9-]+)$/))) return legal(env, u, x[1]);
    if (p === '/sitemap.xml') return sitemap(env);
    if (p === '/robots.txt') return robots(env);
    if (p === '/public/properties') return propertiesJson(env);
    if ((x = p.match(/^\/book\/([a-z0-9-]+)$/))) return bookPage(env, u, x[1]);
    if ((x = p.match(/^\/booking\/([A-Za-z0-9]+)$/))) return bookingPage(env, u, x[1]);
  }
  if (m === 'POST') {
    if (p === '/public/enquiry') return enquiry(req, env, u);
    if (p === '/public/quote') return quoteJson(req, env, u);
    if (p === '/public/checkout') return startCheckout(req, env, u);
    if ((x = p.match(/^\/pay\/([a-z]+)\/webhook$/))) return payWebhook(req, env, x[1]);
  }
  return null;
}
