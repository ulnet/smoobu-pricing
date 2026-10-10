const fs = require('fs'), path = require('path');
const {parseEmail} = require('./parse');
const dir = path.join(__dirname, 'samples');
for (const f of fs.readdirSync(dir).filter(x => x.endsWith('.txt'))) {
  const t = fs.readFileSync(path.join(dir, f), 'utf8');
  const [head, ...rest] = t.split('\n---\n');
  const from = (head.match(/^FROM:\s*(.*)$/m) || [])[1], subject = (head.match(/^SUBJECT:\s*(.*)$/m) || [])[1];
  console.log(f, JSON.stringify(parseEmail({from, subject, body: rest.join('\n---\n')}), null, 1));
}
