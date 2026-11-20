'use strict';
// Seat links (src/seats.js), without Electron. Fake keys only.
//   T1 a guest link, the "You" link and the group link of one person all give the SAME five guest seats
//   T2 a made seat link differs from Twitch's own link for that seat in NOTHING (compared as text)
//   T3 the key is never changed, moved or dropped (#auth=… stays a fragment, &auth=… stays a query)
//   T4 seats already in the list are not offered again; another person's seats do not count
//   T5 links that are not seat links (other pages, no key, not a link) are left alone
//   node scripts/test-seats.js                      → PASS
//   STC_SABOTAGE=seat-off-by-one node scripts/...   → must FAIL (T2)
const S = require('../src/seats.js');
const SAB = process.env.STC_SABOTAGE || '';
const fails = [];
let checks = 0;
const check = (ok, msg) => { checks++; if (!ok) fails.push(msg); };
const seatUrl = (url, n) => S.seatUrl(url, SAB === 'seat-off-by-one' ? n + 1 : n);

const KEY = 'FAKE-KEY-0000000000000000';
const base = 'https://dashboard.twitch.tv/widgets/guest-star/somechannel';
// Twitch's own links, in the exact shape its panel gives them
const twitch = (n) => `${base}?display=single&slot=${n}#auth=${KEY}`;
const group = `${base}?display=group#auth=${KEY}`;

// T1 + T2 + T3
for (const [label, from] of [['You', twitch(0)], ['Guest 1', twitch(1)], ['Guest 4', twitch(4)], ['Group', group]]) {
  const seats = S.missingSeats(from, []);
  check(seats.length === 5 && seats.every((s, i) => s.slot === i + 1), `T1 from ${label}: seats 1..5, got ${seats.map((s) => s.slot)}`);
  for (let n = 1; n <= 5; n++) {
    const made = seatUrl(from, n);
    check(made === twitch(n), `T2 from ${label}, seat ${n}: not Twitch's own link (${String(made).replace(KEY, '<KEY>')})`);
    check(String(made).split(KEY).length === 2 && String(made).endsWith(`#auth=${KEY}`), `T3 from ${label}, seat ${n}: key changed or moved`);
  }
}
// T3, the stand-in shape: the key is a query parameter and must stay one
{
  const q = 'http://127.0.0.1:8777/widgets/guest-star/anachan?display=single&slot=1&auth=FAKE-TOKEN-AAAA';
  const made = S.seatUrl(q, 3);
  check(made === 'http://127.0.0.1:8777/widgets/guest-star/anachan?display=single&slot=3&auth=FAKE-TOKEN-AAAA', `T3 query key: ${made}`);
}

// T4
{
  const list = [twitch(0), twitch(2), twitch(5), `https://dashboard.twitch.tv/widgets/guest-star/otherchannel?display=single&slot=1#auth=FAKE-KEY-OTHER`, 'https://example.com/x'];
  const seats = S.missingSeats(twitch(2), list).map((s) => s.slot);
  check(JSON.stringify(seats) === '[1,3,4]', `T4 seats 2 and 5 are in the list, another channel's seat 1 does not count: got ${seats}`);
  check(S.missingSeats(twitch(1), [1, 2, 3, 4, 5].map(twitch)).length === 0, 'T4 all five in the list → nothing to add');
  const upper = S.missingSeats(twitch(1).replace('somechannel', 'SomeChannel'), [twitch(1)]).map((s) => s.slot);
  check(JSON.stringify(upper) === '[2,3,4,5]', `T4 the channel name is not case sensitive: got ${upper}`);
}

// T5
for (const bad of ['', 'not a link', 'https://example.com/widgets/other/x?slot=1#auth=k', `${base}?display=single&slot=1`, `${base}/extra?slot=1#auth=k`, 'ftp://dashboard.twitch.tv/widgets/guest-star/x?slot=1#auth=k', 'http://127.0.0.1:8777/guest?n=3&auth=FAKE-TOKEN-CCCC']) {
  check(S.parse(bad) === null, `T5 should not be a seat link: ${bad}`);
  check(S.seatUrl(bad, 1) === null && S.missingSeats(bad, []).length === 0, `T5 nothing is made from: ${bad}`);
}
{
  const p = S.parse(twitch(0));
  check(p && p.slot === 0 && !p.group && p.channel === 'somechannel', 'T5 "You" is seat 0');
  const g = S.parse(group);
  check(g && g.slot === null && g.group, 'T5 the group link has no seat');
}

if (fails.length) { console.log(`RESULT FAIL: ${fails.length} of ${checks} checks`); for (const f of fails) console.log('  ✗ ' + f); process.exit(1); }
console.log(`RESULT PASS: ${checks} checks`);
