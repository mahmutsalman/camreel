'use strict';
// "Add guest seats" in the real Settings window: ONE Electron run, about 30 s.
//   node scripts/scenario-seats.js
// Uses a SCRATCH userData folder (never his real settings), fake-key stand-in links, its own
// stand-in server on port 8791 (8777 may belong to something else), and NOT the system clipboard.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const PORT = 8791;
const S = `http://127.0.0.1:${PORT}`;
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-seats-'));
const LINKS = [`${S}/widgets/guest-star/anachan?display=single&slot=1&auth=FAKE-TOKEN-AAAA`, `${S}/guest?n=9&auth=FAKE-TOKEN-CCCC`];
const OUT = path.join(ROOT, 'proof', 'seats-phaseseats.json');

const server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore', env: { ...process.env, STANDIN_PORT: String(PORT) } });
let code = 1;
try {
  spawnSync('sleep', ['1']);
  fs.rmSync(OUT, { force: true }); // never judge a stale result
  const proof = { out: path.join(ROOT, 'proof'), prefix: 'seats', settingsTest: true, phase: 'seats', links: LINKS };
  const res = spawnSync(path.join(ROOT, 'scripts/prove.sh'), ['', JSON.stringify(proof), '60'], { encoding: 'utf8', env: { ...process.env, STC_USERDATA: userData, STC_CONFIG: '' } });
  const logs = (res.stdout || '') + (res.stderr || '');
  const raw = fs.readFileSync(OUT, 'utf8');
  const p = JSON.parse(raw);
  const st = p.steps || {};
  const out = [];
  const ok = (name, pass, detail) => out.push({ name, pass: !!pass, detail });
  const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);
  const seat = (n) => `anachan:single:${n}:same-key`;
  if (p.error) ok('ran without error', false, p.error);
  const V = (v) => v || {};
  ok('first start = Simple: guests + Strip box shown; Motion, Window, mirror column, jump links hidden', V(st.viewFirst).view === 'simple' && st.viewFirst.guests && st.viewFirst.simpleBox && !st.viewFirst.motion && !st.viewFirst.windowSec && !st.viewFirst.mirrorCol && !st.viewFirst.jump, st.viewFirst);
  ok('Simple: pointing at things does NOT light up the preview', V(st.viewFirst).hoverHL === null && V(st.viewSimpleAgain).hoverHL === null, [V(st.viewFirst).hoverHL, V(st.viewSimpleAgain).hoverHL]);
  ok('Advanced (clicked): every section, mirror column and jump links shown; the preview lights up again', V(st.viewAdvanced).view === 'advanced' && st.viewAdvanced.motion && st.viewAdvanced.windowSec && st.viewAdvanced.mirrorCol && st.viewAdvanced.jump && !st.viewAdvanced.simpleBox && st.viewAdvanced.hoverHL === 'guests', st.viewAdvanced);
  ok('back to Simple (clicked): hidden again', V(st.viewSimpleAgain).view === 'simple' && !st.viewSimpleAgain.motion && st.viewSimpleAgain.simpleBox, st.viewSimpleAgain);
  ok('Simple background → green: saved to disk and the Advanced control agrees; back → transparent', V(st.bgGreen).disk === '#00ff00' && st.bgGreen.advancedSelect === 'green' && V(st.bgBack).disk === 'transparent', [st.bgGreen, st.bgBack]);
  ok('a new install moves with Endless loop', st.defaultStyle === 'loop', st.defaultStyle);
  ok('the strip has an invisible drag layer over the whole window, on top of the cards', st.grab && st.grab.region === 'drag' && st.grab.cover && st.grab.onTop && /rgba\(0, 0, 0, 0\)|transparent/.test(st.grab.see), st.grab);
  ok('empty list: no offer, a + button, the field says "Start here"', st.start && st.start.offer === null && st.start.plus === true && /^Start here/.test(st.start.placeholder), st.start);
  ok('clicking + puts the cursor in the paste field', st.plusFocus === 'paste', st.plusFocus);
  ok('a seat link already in the list (no paste) → the offer for the missing seat shows', st.existing && st.existing.offer && st.existing.offer.button === 'Add 1 guest seat', st.existing);
  ok('"No thanks" hides it, and it stays hidden after the table redraws', st.noThanks && st.noThanks.offer === null && st.noThanksAfterRender && st.noThanksAfterRender.offer === null, [st.noThanks, st.noThanksAfterRender]);
  ok('pasting the link again brings it back; Add → 6 rows again', st.back && st.back.rows.length === 6 && st.back.offer === null, st.back && st.back.rows);
  ok('paste one seat link → ONE row, and the offer names the 4 missing seats', st.pasted && eq(st.pasted.rows, ['anachan']) && st.pasted.offer && st.pasted.offer.button === 'Add 4 guest seats' && /Guest 2, 3, 4, 5/.test(st.pasted.offer.text), st.pasted);
  ok('nothing is added before the click (disk has 1 link)', st.pasted && st.pasted.diskSeats.length === 1, st.pasted && st.pasted.diskSeats);
  ok('click → rows Guest 2..5 in the table', st.added && eq(st.added.rows, ['anachan', 'Guest 2', 'Guest 3', 'Guest 4', 'Guest 5']), st.added && st.added.rows);
  ok('click → disk holds seats 1..5, same channel, same key', st.added && eq(st.added.diskSeats, [1, 2, 3, 4, 5].map(seat)), st.added && st.added.diskSeats);
  ok('the offer is gone after adding', st.added && st.added.offer === null, st.added && st.added.offer);
  ok('pasting the link again: "already in the list", nothing added, no offer', st.again && st.again.rows.length === 5 && /already/.test(st.again.error) && st.again.offer === null, st.again);
  ok('one seat deleted + paste again → offer for exactly that seat', st.oneMissing && st.oneMissing.rows.length === 4 && st.oneMissing.offer && st.oneMissing.offer.button === 'Add 1 guest seat' && /Guest 3\./.test(st.oneMissing.offer.text), st.oneMissing);
  ok('click → seat 3 is back (no seat twice)', st.refilled && eq(st.refilled.diskSeats, [1, 2, 4, 5, 3].map(seat)) && eq(st.refilled.rows, ['anachan', 'Guest 2', 'Guest 4', 'Guest 5', 'Guest 3']), st.refilled);
  ok('a link that is not a seat link is added as before, with no offer', st.plain && st.plain.rows.length === 6 && st.plain.offer === null, st.plain);
  ok('the strip has a card for every row (6)', st.stripCards && st.stripCards.length === 6, st.stripCards);
  ok('no key in the offer text, the logs or the result', !/FAKE-TOKEN/.test(logs) && !/FAKE-TOKEN/.test(raw));
  const failed = out.filter((x) => !x.pass);
  for (const x of [...failed, ...out.filter((x) => x.pass)]) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '   ' + String(JSON.stringify(x.detail)).slice(0, 400)}`);
  console.log(failed.length ? `RESULT FAIL ${failed.length}/${out.length}` : `RESULT PASS ${out.length}/${out.length}`);
  code = failed.length ? 1 : 0;
} catch (e) { console.log('RESULT FAIL (could not judge):', e.message); }
finally { server.kill(); fs.rmSync(userData, { recursive: true, force: true }); }
process.exit(code);
