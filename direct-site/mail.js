import { esc, fmtDate } from './util.js';
import { money } from './public.js';

// ### 1 --- resend delivery
export async function sendMail(env, S, to, subject, text, htmlBody) {
  if (!env.RESEND_API_KEY) return { ok: false, error: 'RESEND_API_KEY not set' };
  const body = { from: S.site_name + ' <' + S.email_from + '>', to: [to], subject, text, html: htmlBody };
  if (S.email_reply_to) body.reply_to = S.email_reply_to;
  const res = await fetch('https://api.resend.com/emails', { method: 'POST', headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
  return res.ok ? { ok: true } : { ok: false, error: 'Resend ' + res.status + ' ' + (await res.text()).slice(0, 200) };
}

// ### 2 --- confirmation email
export function confirmationMail(S, b, title, manageUrl) {
  const stay = fmtDate(b.arrival) + ' to ' + fmtDate(b.departure);
  const text = `Hello ${b.guest_name},\n\nYour booking is confirmed.\n\nReference: ${b.reference}\n${title}\n${stay}\nGuests: ${b.guests}\nTotal paid: ${money(b.total_pence)}\n\nManage or cancel your booking: ${manageUrl}\n\nIf you have any questions just reply to this email.\n\n${S.site_name}`;
  const h = `<p>Hello ${esc(b.guest_name)},</p><p><strong>Your booking is confirmed.</strong></p><p>Reference: <strong>${esc(b.reference)}</strong><br>${esc(title)}<br>${esc(stay)}<br>Guests: ${b.guests}<br>Total paid: ${money(b.total_pence)}</p><p><a href="${esc(manageUrl)}">Manage or cancel your booking</a></p><p>If you have any questions just reply to this email.</p><p>${esc(S.site_name)}</p>`;
  return { subject: 'Booking confirmed - ' + b.reference, text, html: h };
}
