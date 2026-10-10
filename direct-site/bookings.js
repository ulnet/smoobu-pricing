import { esc, redirect, randRef, hmacHex, safeEq, fmtDate } from './util.js';
import { layout } from './layout.js';
import { smoobu, getSettings, loadBySlug, roomIds, getFacts, availability, quote, money, allow, telegram } from './public.js';
import { getProvider } from './stripe.js';
import { sendMail, confirmationMail } from './mail.js';

// ### 1 --- manage token (derived, so links can always be re-sent) and helpers
export async function manageToken(env, ref) {
  return (await hmacHex('manage:' + ref, env.SESSION_SECRET)).slice(0, 32);
}

async function manageOk(env, ref, tok) {
  return !!tok && safeEq(String(tok), await manageToken(env, ref), env.SESSION_SECRET);
}

function nameFor(r, facts, id) {
  return (r.room_content[id] && r.room_content[id].t) || (facts[id] && facts[id].name) || 'Room';
}

async function alertErr(env, msg) {
  console.error(msg);
  await telegram(env, '⚠️ Direct site: ' + msg);
}

// ### 2 --- booking details page (GET /book/<slug>): re-quote, then guest details form
export async function bookPage(env, u, slug) {
  const S = await getSettings(env), item = await loadBySlug(env, slug), sp = u.searchParams;
  const nf = layout(S, u, { title: 'Not found', noindex: true, status: 404, path: u.pathname, cache: 'no-store' }, '<h1>Not found</h1>');
  if (!item) return nf;
  const { p, r } = item, scope = sp.get('scope') || '', arrival = sp.get('arrival') || '', departure = sp.get('departure') || '', guests = sp.get('guests') || '2';
  const q = await quote(env, p, r, scope, arrival, departure, guests);
  const back = `/property/${esc(r.slug)}?arrival=${esc(arrival)}&departure=${esc(departure)}&guests=${esc(guests)}#book`;
  const facts = await getFacts(env, roomIds(p, r)), title = r.title || p.name;
  const label = scope === 'whole' ? 'Whole property' : nameFor(r, facts, scope);
  if (!q.ok) return layout(S, u, { title: 'Booking | ' + S.site_name, noindex: true, path: u.pathname, cache: 'no-store' }, `<h1>${esc(title)}</h1><div class="msg bad">${esc(q.error)}</div><p><a href="${back}">Back to dates</a></p>`);
  const refund = r.nonrefundable_pct ? `${r.nonrefundable_pct}% of the total is non-refundable. ` : '';
  const body = `<h1>${esc(title)}</h1><p><strong>${esc(label)}</strong><br>${esc(fmtDate(arrival))} to ${esc(fmtDate(departure))} (${q.nights} night${q.nights === 1 ? '' : 's'}), ${q.guests} guest${q.guests === 1 ? '' : 's'}</p><p style="font-size:24px;font-weight:700">${money(q.total)}${q.otaTotal > q.total ? ` <s style="font-size:16px">${money(q.otaTotal)}</s>` : ''}</p><form class="box" method="post" action="/public/checkout"><input type="hidden" name="slug" value="${esc(r.slug)}"><input type="hidden" name="scope" value="${esc(scope)}"><input type="hidden" name="arrival" value="${esc(arrival)}"><input type="hidden" name="departure" value="${esc(departure)}"><input type="hidden" name="guests" value="${esc(guests)}"><input class="hp" type="text" name="website" tabindex="-1" autocomplete="off" aria-hidden="true"><div class="r"><div><label for="n">Full name</label><input type="text" id="n" name="name" required maxlength="100" autocomplete="name"></div><div><label for="e">Email</label><input type="email" id="e" name="email" required maxlength="200" autocomplete="email"></div><div><label for="p">Phone</label><input type="text" id="p" name="phone" required maxlength="40" autocomplete="tel"></div></div><label for="m">Note for us (optional)</label><textarea id="m" name="note" maxlength="1000" rows="3"></textarea><p class="muted">${esc(refund)}Payment is taken securely by Stripe. Your dates are held for ${S.hold_minutes} minutes while you pay.</p><label style="font-weight:400"><input type="checkbox" name="agree" value="1" required style="width:auto"> I accept the <a href="/legal/terms" target="_blank" rel="noopener">terms</a> and <a href="/legal/cancellation" target="_blank" rel="noopener">cancellation policy</a></label><button class="btn">Pay ${money(q.total)}</button></form><p><a href="${back}">Back to dates</a></p>`;
  return layout(S, u, { title: 'Book ' + title + ' | ' + S.site_name, noindex: true, path: u.pathname, cache: 'no-store' }, body);
}

// ### 3 --- start checkout (POST /public/checkout): re-quote, hold, create pending booking, redirect to provider
function failPage(S, u, msg, back) {
  return layout(S, u, { title: 'Booking | ' + S.site_name, noindex: true, status: 409, path: u.pathname, cache: 'no-store' }, `<h1>Sorry</h1><div class="msg bad">${esc(msg)}</div><p><a href="${esc(back)}">Back to dates</a></p>`);
}

export async function startCheckout(req, env, u) {
  if (req.headers.get('Origin') !== u.origin) return new Response('Bad origin', { status: 403 });
  const S = await getSettings(env), f = await req.formData(), ip = req.headers.get('CF-Connecting-IP') || 'x';
  const v = (k, n) => String(f.get(k) || '').trim().slice(0, n);
  if (f.get('website')) return redirect('/');
  const item = await loadBySlug(env, v('slug', 80));
  if (!item) return new Response('Unknown property', { status: 400 });
  const { p, r } = item, scope = v('scope', 30), arrival = v('arrival', 10), departure = v('departure', 10), guests = v('guests', 3);
  const back = '/property/' + r.slug + '?arrival=' + arrival + '&departure=' + departure + '&guests=' + guests + '#book';
  const name = v('name', 100), email = v('email', 200), phone = v('phone', 40);
  if (!name || !phone || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) || !f.get('agree')) return failPage(S, u, 'Please fill in your name, a valid email, a phone number and accept the terms.', back);
  if (!(await allow(env, 'c:' + ip, 10, 3600))) return new Response('Too many attempts. Please try again later.', { status: 429 });
  const prov = getProvider('stripe');
  if (!env.STRIPE_SECRET_KEY) return failPage(S, u, 'Online payment is not available yet. Please send us an enquiry.', back);
  const q = await quote(env, p, r, scope, arrival, departure, guests);
  if (!q.ok) return failPage(S, u, q.error, back);
  const ref = randRef(), group = crypto.randomUUID(), now = new Date(), holdId = crypto.randomUUID();
  const expires = new Date(now.getTime() + S.hold_minutes * 60000).toISOString();
  await env.DB.batch([
    env.DB.prepare(`INSERT INTO direct_bookings (reference, group_id, status, property_id, scope, listing_ids, arrival, departure, guests, guest_name, guest_email, guest_phone, guest_note, price_breakdown, total_pence, currency, provider, created_at) VALUES (?, ?, 'pending_payment', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 'stripe', ?)`).bind(ref, group, p.id, q.scope, JSON.stringify(q.listingIds), arrival, departure, q.guests, name, email, phone, v('note', 1000), JSON.stringify(q), q.total, q.currency, now.toISOString()),
    env.DB.prepare(`INSERT INTO checkout_holds (id, reference, property_id, listing_ids, arrival, departure, expires_at) VALUES (?, ?, ?, ?, ?, ?, ?)`).bind(holdId, ref, p.id, JSON.stringify(q.listingIds), arrival, departure, expires)
  ]);
  const mine = await env.DB.prepare(`SELECT rowid FROM checkout_holds WHERE id = ?`).bind(holdId).first();
  const others = (await env.DB.prepare(`SELECT rowid, listing_ids FROM checkout_holds WHERE expires_at > ? AND reference != ? AND arrival < ? AND departure > ?`).bind(now.toISOString(), ref, departure, arrival).all()).results;
  const clash = others.some(o => o.rowid < mine.rowid && JSON.parse(o.listing_ids).some(id => q.listingIds.includes(id)));
  const drop = async (status) => env.DB.batch([env.DB.prepare(`DELETE FROM checkout_holds WHERE id = ?`).bind(holdId), env.DB.prepare(`UPDATE direct_bookings SET status = ? WHERE reference = ?`).bind(status, ref)]);
  if (clash) { await drop('expired'); return failPage(S, u, 'These dates are being booked right now (possibly by you in another tab). Please wait a few minutes and try again.', back); }
  const facts = await getFacts(env, roomIds(p, r)), title = r.title || p.name;
  const label = scope === 'whole' ? 'Whole property' : nameFor(r, facts, scope);
  let s;
  try {
    s = await prov.createCheckout(env, { amount: q.total, currency: q.currency, name: title + ' - ' + label, description: fmtDate(arrival) + ' to ' + fmtDate(departure) + ', ' + q.guests + ' guest(s). Ref ' + ref, email, reference: ref, successUrl: S.site_url + '/booking/' + ref + '?t=' + (await manageToken(env, ref)), cancelUrl: S.site_url + back });
  } catch (e) {
    await drop('expired');
    await alertErr(env, 'could not start checkout ' + ref + ': ' + e.message);
    return failPage(S, u, 'We could not start payment. Please try again or send us an enquiry.', back);
  }
  await env.DB.prepare(`UPDATE checkout_holds SET session_id = ? WHERE id = ?`).bind(s.id, holdId).run();
  return redirect(s.url);
}

// ### 4 --- payment webhook (POST /pay/<provider>/webhook): verify, dedupe, then settle
export async function payWebhook(req, env, provName) {
  const prov = getProvider(provName);
  if (!prov) return new Response('Unknown provider', { status: 404 });
  const raw = await req.text(), ev = await prov.verifyWebhook(env, raw, req.headers.get('Stripe-Signature'));
  if (!ev) return new Response('Bad signature', { status: 400 });
  const claim = await env.DB.prepare(`INSERT OR IGNORE INTO webhook_events (id, provider, received_at) VALUES (?, ?, ?)`).bind(ev.id, provName, new Date().toISOString()).run();
  if (!claim.meta.changes) return new Response('ok');
  try {
    if (ev.type === 'checkout.session.completed' && ev.data.object.payment_status === 'paid') await settlePaid(env, prov, ev.data.object);
    else if (ev.type === 'checkout.session.expired') await settleExpired(env, ev.data.object);
  } catch (e) {
    await env.DB.prepare(`DELETE FROM webhook_events WHERE id = ?`).bind(ev.id).run();
    await alertErr(env, 'webhook ' + ev.type + ' failed: ' + e.message);
    return new Response('retry', { status: 500 });
  }
  return new Response('ok');
}

async function settleExpired(env, s) {
  const ref = s.client_reference_id;
  if (!ref) return;
  await env.DB.batch([env.DB.prepare(`DELETE FROM checkout_holds WHERE reference = ?`).bind(ref), env.DB.prepare(`UPDATE direct_bookings SET status = 'expired' WHERE reference = ? AND status = 'pending_payment'`).bind(ref)]);
}

async function settlePaid(env, prov, s) {
  const ref = s.client_reference_id, pi = s.payment_intent;
  const b = ref && await env.DB.prepare(`SELECT * FROM direct_bookings WHERE reference = ?`).bind(ref).first();
  if (!b) { await alertErr(env, 'payment received for unknown booking ' + ref + ' (' + pi + ')'); return; }
  if (b.status === 'confirmed' || b.status === 'refunded' || b.status === 'cancelled') return;
  const S = await getSettings(env), items = await loadBySlugById(env, b.property_id);
  const refundAll = async (why) => {
    await prov.refund(env, pi, 0, 'auto-' + ref);
    await env.DB.batch([env.DB.prepare(`UPDATE direct_bookings SET status = 'refunded', provider_payment_id = ?, refunded_pence = total_pence WHERE reference = ?`).bind(pi, ref), env.DB.prepare(`DELETE FROM checkout_holds WHERE reference = ?`).bind(ref)]);
    await telegram(env, '↩️ Auto-refunded ' + ref + ' (' + money(b.total_pence) + '): ' + why);
    await sendMail(env, S, b.guest_email, 'Your booking could not be completed - ' + ref, `Hello ${b.guest_name},\n\nSorry, the dates you paid for were taken just before your payment completed, so your booking could not be confirmed. Your payment has been refunded in full and should appear within 5 to 10 working days.\n\nReference: ${ref}\n\n${S.site_name}`, `<p>Hello ${esc(b.guest_name)},</p><p>Sorry, the dates you paid for were taken just before your payment completed, so your booking could not be confirmed. Your payment has been refunded in full and should appear within 5 to 10 working days.</p><p>Reference: ${esc(ref)}</p><p>${esc(S.site_name)}</p>`);
  };
  if (s.amount_total !== b.total_pence) return refundAll('amount mismatch ' + s.amount_total + ' vs ' + b.total_pence);
  if (!items) return refundAll('property no longer on site');
  const { p, r } = items, ids = JSON.parse(b.listing_ids);
  const av = await availability(env, p, r, b.arrival, b.departure, ref);
  const free = ids.every(id => av.free[id]) && (b.scope !== 'whole' || av.wholeFree);
  if (!free) return refundAll('dates no longer available');
  const q = JSON.parse(b.price_breakdown), facts = await getFacts(env, roomIds(p, r)), now = new Date().toISOString();
  const extras = q.extraGuestFee + q.cleaning;
  const stmts = ids.map((id, n) => {
    const pr = q.perRoom.find(x => x.id === id), share = Math.floor(extras / ids.length) + (n === 0 ? extras % ids.length : 0);
    const details = { contact: b.guest_phone, email: b.guest_email, note: b.guest_note, guests: b.guests, price: (pr.direct + share) / 100, direct_reference: ref, direct_group: b.group_id, source: 'direct' };
    return env.DB.prepare(`INSERT OR REPLACE INTO sim_bookings (id, reference_id, apartment_id, apartment_name, arrival, departure, guest_name, channel, m_arrival, m_departure, m_apartment_id, m_apartment_name, room_number, details, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, 'direct', ?, ?, ?, ?, '', ?, ?)`).bind('direct-' + ref + '-' + id, ref, id, nameFor(r, facts, id), b.arrival, b.departure, b.guest_name, b.arrival, b.departure, id, nameFor(r, facts, id), JSON.stringify(details), now);
  });
  stmts.push(env.DB.prepare(`UPDATE direct_bookings SET status = 'confirmed', provider_payment_id = ?, confirmed_at = ? WHERE reference = ?`).bind(pi, now, ref));
  stmts.push(env.DB.prepare(`DELETE FROM checkout_holds WHERE reference = ?`).bind(ref));
  await env.DB.batch(stmts);
  let cap = {};
  try { cap = await smoobu(env, { action: 'directBooked', listingIds: ids, arrival: b.arrival, departure: b.departure }); } catch (e) { cap = { error: e.message }; }
  if (cap.error) await alertErr(env, 'capacity check failed for ' + ref + ': ' + cap.error);
  const title = (r.title || p.name) + (b.scope === 'whole' ? ' (whole property)' : ' - ' + nameFor(r, facts, ids[0]));
  await telegram(env, '✅ Direct booking ' + ref + ': ' + title + '\n' + b.arrival + ' to ' + b.departure + ', ' + b.guests + ' guest(s)\n' + b.guest_name + ' ' + b.guest_phone + '\n' + money(b.total_pence) + (cap.blocked ? '\n🚫 Capacity hit: ' + (cap.blockedListings || []).length + ' listing(s) blocked' : ''));
  const m = confirmationMail(S, b, title, S.site_url + '/booking/' + ref + '?t=' + (await manageToken(env, ref)));
  const sent = await sendMail(env, S, b.guest_email, m.subject, m.text, m.html);
  if (!sent.ok) await alertErr(env, 'confirmation email not sent for ' + ref + ': ' + sent.error);
}

async function loadBySlugById(env, pid) {
  const row = await env.DB.prepare(`SELECT slug FROM site_content WHERE property_id = ?`).bind(pid).first();
  return row ? loadBySlug(env, row.slug) : null;
}

// ### 5 --- booking status page (GET /booking/<ref>?t=...)
export async function bookingPage(env, u, ref) {
  const S = await getSettings(env), tok = u.searchParams.get('t') || '';
  const nf = layout(S, u, { title: 'Not found', noindex: true, status: 404, path: u.pathname, cache: 'no-store' }, '<h1>Booking not found</h1><p>Check your link and reference.</p>');
  if (!/^KZ[A-Z0-9]{8}$/.test(ref) || !(await manageOk(env, ref, tok))) return nf;
  const b = await env.DB.prepare(`SELECT * FROM direct_bookings WHERE reference = ?`).bind(ref).first();
  if (!b) return nf;
  const facts = await getFacts(env, JSON.parse(b.listing_ids)), item = await loadBySlugById(env, b.property_id);
  const title = item ? (item.r.title || item.p.name) : 'Your stay';
  const msg = { pending_payment: '<div class="msg warn" style="background:#fff4d6">Confirming your payment. This page refreshes automatically.</div>', confirmed: '<div class="msg good">Your booking is confirmed. A confirmation email is on its way.</div>', cancelled: '<div class="msg bad">This booking has been cancelled.</div>', refunded: '<div class="msg bad">This booking could not be completed and was refunded.</div>', expired: '<div class="msg bad">This booking was not completed.</div>' }[b.status] || '';
  const rows = [['Reference', b.reference], ['Property', title], ['Arrival', fmtDate(b.arrival)], ['Departure', fmtDate(b.departure)], ['Guests', b.guests], ['Total', money(b.total_pence)], ['Status', b.status.replace('_', ' ')]].map(x => `<tr><td>${esc(x[0])}</td><td>${esc(x[1])}</td></tr>`).join('');
  const meta = b.status === 'pending_payment' ? '<meta http-equiv="refresh" content="6">' : '';
  return layout(S, u, { title: 'Booking ' + ref + ' | ' + S.site_name, noindex: true, path: u.pathname, cache: 'no-store', head: meta }, `<h1>Booking ${esc(ref)}</h1>${msg}<table class="q">${rows}</table>`);
}

// ### 6 --- scheduled cleanup: expire stale holds and abandoned sessions
export async function cleanupHolds(env) {
  const prov = getProvider('stripe'), now = new Date().toISOString();
  const old = (await env.DB.prepare(`SELECT id, reference, session_id FROM checkout_holds WHERE expires_at < ?`).bind(now).all()).results;
  for (const h of old) {
    if (h.session_id) await prov.cancelAuth(env, h.session_id);
    await env.DB.batch([env.DB.prepare(`DELETE FROM checkout_holds WHERE id = ?`).bind(h.id), env.DB.prepare(`UPDATE direct_bookings SET status = 'expired' WHERE reference = ? AND status = 'pending_payment'`).bind(h.reference)]);
  }
  return old.length;
}
