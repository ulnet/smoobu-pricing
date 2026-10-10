// ### 1 --- helpers
const MONTHS = {january:1,february:2,march:3,april:4,may:5,june:6,july:7,august:8,september:9,october:10,november:11,december:12};
function field(body, label) {
  const m = body.match(new RegExp('^\s*' + label + '\s*:[ \t]*(.*)$', 'im'));
  return m ? m[1].trim() : '';
}
function longDate(s) {
  const m = s.match(/(\d{1,2})(?:st|nd|rd|th)?\s+([A-Za-z]+)\s+(\d{4})/);
  if (!m || !MONTHS[m[2].toLowerCase()]) return '';
  return m[3] + '-' + String(MONTHS[m[2].toLowerCase()]).padStart(2, '0') + '-' + String(m[1]).padStart(2, '0');
}
// ### 2 --- normalizer (every channel parser returns raw fields, this makes the final JSON)
const REQUIRED = ['code', 'guest', 'room', 'arrival', 'departure'];
function normalize(source, raw) {
  if (raw.parseError) return {parseError: raw.parseError, source};
  const out = {
    source, event: raw.event || '', code: raw.code || '', channelRef: raw.channelRef || '',
    guest: raw.guest || '', contact: raw.contact || '', email: raw.email || '',
    room: raw.room || '', propertyRef: raw.propertyRef || '',
    arrival: raw.arrival || '', departure: raw.departure || '',
    guests: Number.isFinite(raw.guests) ? raw.guests : null,
    earning: raw.earning == null ? null : raw.earning
  };
  const miss = REQUIRED.filter(k => !out[k]);
  if (!['new', 'modified', 'cancelled'].includes(out.event)) miss.push('event');
  if (out.arrival && out.departure && out.arrival >= out.departure) miss.push('date-order');
  return miss.length ? {parseError: 'missing/invalid ' + miss.join(','), source} : out;
}
// ### 3 --- channel parsers (add one entry per channel: match + parse)
const CHANNELS = [
  {
    source: 'sykes',
    match: m => m.from.includes('sykes'),
    parse(m, body) {
      if (!/you have a new booking/i.test(body)) return {parseError: 'unclassified sykes email'};
      const prop = field(body, 'Property name').match(/^(.*?)\s*-\s*Ref:\s*(\d+)\s*$/i);
      const g = field(body, 'Guest name').match(/^(?:(?:Mr|Mrs|Ms|Miss|Dr|Mx)\.?\s+)?(.*?)\s*(?:\((\d+)\))?\s*$/i);
      const phone = field(body, 'Contact no');
      const email = field(body, 'Email address');
      const n = k => parseInt(field(body, k), 10) || 0;
      return {
        event: 'new', code: (body.match(/booking reference is\s+([A-Z0-9-]+)/i) || [])[1],
        guest: g && g[1], channelRef: g && g[2], contact: /[1-9]/.test(phone) ? phone : email, email,
        room: prop ? prop[1] : field(body, 'Property name'), propertyRef: prop && prop[2],
        arrival: longDate(field(body, 'Check in')), departure: longDate(field(body, 'Check out')),
        guests: n('Adults') + n('Children') + n('Teenagers')
      };
    }
  }
];
// ### 4 --- entry
function parseEmail(m) {
  const msg = {from: (m.from || '').toLowerCase(), subject: m.subject || ''};
  const body = (m.body || '').replace(/\r/g, '');
  const ch = CHANNELS.find(c => c.match(msg));
  if (!ch) return {parseError: 'unknown sender'};
  let raw;
  try { raw = ch.parse(msg, body); } catch (e) { raw = {parseError: 'parser threw: ' + e.message}; }
  return normalize(ch.source, raw);
}
if (typeof module !== 'undefined') module.exports = {parseEmail, CHANNELS};
