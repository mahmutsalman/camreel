'use strict';
// Sabotage-checked: set REDACT_SABOTAGE=1 to swap redact() for identity; this test must go red.
const { redact: real } = require('../src/redact');
const redact = process.env.REDACT_SABOTAGE ? (s) => s : real;
const secret = 'abc123SECRETxyz';
const cases = [
  `https://dashboard.twitch.tv/widgets/guest-star/chan?display=single&slot=1&auth=${secret}`,
  `https://dashboard.twitch.tv/widgets/guest-star/chan?auth=${secret}&slot=2`,
  `Error: failed to load https://x/y?AUTH=${secret}#frag`,
  `"url":"https://x/?a=1&auth=${secret}"`,
  new Error(`boom https://x/?auth=${secret}`),
  JSON.stringify({ step: JSON.stringify({ writeRaw: `{"url": "https://x/?auth=${secret}", ` }) }),
];
let bad = 0;
for (const c of cases) {
  const out = redact(c);
  const leaked = String(out).includes(secret);
  if (leaked) bad++;
  console.log(leaked ? 'LEAK ' : 'ok   ', String(out).split('\n')[0]);
}
// redacting JSON text must leave it valid JSON
try { JSON.parse(redact(cases[5])); console.log('ok    redacted JSON still parses'); } catch (e) { bad++; console.log('BROKE JSON:', e.message); }
const keep = redact('https://x/?display=single&slot=1');
if (keep !== 'https://x/?display=single&slot=1') { bad++; console.log('BROKE a harmless URL:', keep); }
console.log(bad ? `FAIL ${bad}` : 'PASS');
process.exit(bad ? 1 : 0);
