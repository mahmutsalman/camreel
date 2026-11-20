'use strict';
// Mirror mode, end to end (real clicks in Settings, pixels from the strip, then a restart).
//   node scripts/scenario-mirror.js
//   STC_RENDER=offscreen node scripts/scenario-mirror.js     (the offscreen path)
//   STC_SABOTAGE=mirror-ignored node scripts/scenario-mirror.js  → must FAIL
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const TAG = [process.env.STC_RENDER, process.env.STC_SABOTAGE].filter(Boolean).join('-');
const PREFIX = 'mirror' + (TAG ? '-' + TAG : '');
const S = process.env.STANDIN_URL || 'http://127.0.0.1:8777';
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-mirror-'));
fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
  sources: [{ url: `${S}/guest?n=1&auth=FAKE-TOKEN-1111`, name: 'G1' }, { url: `${S}/guest?n=2&auth=FAKE-TOKEN-2222`, name: 'G2' }],
  layout: { cycleSeconds: 0, cardWidth: 400 }, window: { width: 480, height: 1080 } }, null, 2));
const get = (url) => new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', () => r(true)); }).on('error', () => r(false)));
// phase 3: a page with no <video> (canvas only), always shown (hideWhenDead off: no video = "dead")
const ud3 = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-mirror3-'));
fs.writeFileSync(path.join(ud3, 'config.json'), JSON.stringify({ hideWhenDead: false,
  sources: [{ url: `${S}/canvasonly?n=3&auth=FAKE-TOKEN-3333`, name: 'G3' }], layout: { cycleSeconds: 0, cardWidth: 400 }, window: { width: 480, height: 1080 } }, null, 2));
// phase 4: hide-name self-check: a real Twitch guest link without a token (its page has no name
// tag) must get the "not found" note; a non-Twitch page must not
const ud4 = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-mirror4-'));
fs.writeFileSync(path.join(ud4, 'config.json'), JSON.stringify({ hideWhenDead: false,
  sources: [{ url: 'https://dashboard.twitch.tv/widgets/guest-star/somechannel?display=single&slot=1', name: 'Twitch' }, { url: `${S}/novideo?n=9&auth=FAKE-TOKEN-9999`, name: 'Other' }],
  layout: { cycleSeconds: 0, cardWidth: 400, hideTwitchName: true }, window: { width: 480, height: 1080 } }, null, 2));
const run = (phase) => spawnSync(path.join(ROOT, 'scripts/prove.sh'), ['', JSON.stringify({ out: path.join(ROOT, 'proof'), prefix: PREFIX, mirrorTest: true, phase, openSettings: true }), '120'],
  { encoding: 'utf8', env: { ...process.env, STC_USERDATA: phase === 4 ? ud4 : phase === 3 ? ud3 : ud, STC_CONFIG: '' } });

(async () => {
  let server = null;
  if (!(await get(`${S}/states`))) { server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore', env: { ...process.env, STANDIN_PORT: new URL(S).port } }); await new Promise((r) => setTimeout(r, 800)); }
  for (const n of [1, 2]) await get(`${S}/control?n=${n}&state=alive`);
  for (const n of [1, 2, 3, 4]) fs.rmSync(path.join(ROOT, 'proof', `${PREFIX}-phase${n}.json`), { force: true }); // never judge a stale result
  run(1); run(2); run(3); run(4);
  if (server) server.kill();
  const res = [];
  const ok = (name, pass, detail) => res.push({ name, pass: !!pass, detail });
  try {
    const p1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-phase1.json`), 'utf8'));
    const p2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-phase2.json`), 'utf8'));
    const p3 = JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-phase3.json`), 'utf8'));
    if (p3.error) ok('phase 3 ran', false, p3.error);
    const p4 = JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-phase4.json`), 'utf8'));
    if (p1.error) ok('phase 1 ran', false, p1.error);
    if (p2.error) ok('phase 2 ran', false, p2.error);
    const st = p1.states;
    const side = (x) => (!x ? '?' : x.redLeft > 0.02 && x.redRight < 0.005 ? 'left' : x.redRight > 0.02 && x.redLeft < 0.005 ? 'right' : `? (L ${x.redLeft} R ${x.redRight})`);
    const sides = (k, s = st) => s[k] ? [side(s[k].cards.G1), side(s[k].cards.G2)] : ['?', '?'];
    ok('both shown', p1.bothShown && p2.bothShown);
    ok('A normal: red marker on the LEFT of both', String(sides('A-normal')) === 'left,left', sides('A-normal'));
    ok('B ⇋ on G1: G1 red on the RIGHT, G2 unchanged', String(sides('B-G1-mirrored')) === 'right,left', sides('B-G1-mirrored'));
    const same = (a, b, n) => st[a] && st[b] && st[a].cards[n].stripHash && st[a].cards[n].stripHash === st[b].cards[n].stripHash;
    ok('B: G1 name strip pixel-identical to A (only the picture flipped)', same('A-normal', 'B-G1-mirrored', 'G1'));
    const sameLabel = (a, b, n, sa = st, sb = st) => sa[a] && sb[b] && sa[a].cards[n].labelHash === sb[b].cards[n].labelHash;
    ok('B: the text tag over G1\'s video did NOT flip (pixel-identical to A)', sameLabel('A-normal', 'B-G1-mirrored', 'G1'));
    ok('B: G1 mirrored INSIDE the page (mode css, not the whole card)', st['B-G1-mirrored'] && st['B-G1-mirrored'].cards.G1.mirrorMode === 'css', st['B-G1-mirrored'] && st['B-G1-mirrored'].cards.G1.mirrorMode);
    ok('B: saved (G1 mirror true) and the row shows ⇋ pressed', st['B-G1-mirrored'] && st['B-G1-mirrored'].disk.mirror[0] === true && st['B-G1-mirrored'].rows[0] === true, st['B-G1-mirrored'] && st['B-G1-mirrored'].disk);
    ok('C ⇋ again: G1 back to the LEFT', String(sides('C-G1-normal-again')) === 'left,left', sides('C-G1-normal-again'));
    ok('D "Mirror all": G2 (no own choice) mirrors, G1 keeps its own "off"', String(sides('D-mirror-all')) === 'left,right', sides('D-mirror-all'));
    ok('D: name strips still identical to A', same('A-normal', 'D-mirror-all', 'G1') && same('A-normal', 'D-mirror-all', 'G2'));
    ok('E ⇋ on G1: both mirrored', String(sides('E-G1-mirrored')) === 'right,right', sides('E-G1-mirrored'));
    ok('E: both text tags still readable (identical to A)', sameLabel('A-normal', 'E-G1-mirrored', 'G1') && sameLabel('A-normal', 'E-G1-mirrored', 'G2'));
    ok('E2: one save renames G2 AND un-mirrors it: both happen', p1.namesAfterE2 && p1.namesAfterE2.includes('G2 renamed') && st['E2-rename-and-unmirror'] && side(st['E2-rename-and-unmirror'].cards['G2 renamed']) === 'left', { names: p1.namesAfterE2, side: st['E2-rename-and-unmirror'] && side(st['E2-rename-and-unmirror'].cards['G2 renamed']) });
    ok('after restart: both still mirrored, from disk', String(sides('F-after-restart', p2.states)) === 'right,right' && p2.states['F-after-restart'].disk.mirrorAll === true, p2.states['F-after-restart'] && sides('F-after-restart', p2.states));
    const tag = (k, n, s = st) => s[k] && s[k].cards[n] ? s[k].cards[n].tagShare : null;
    ok('A: Twitch-style name tag visible on both', tag('A-normal', 'G1') > 0.5 && tag('A-normal', 'G2') > 0.5, [tag('A-normal', 'G1'), tag('A-normal', 'G2')]);
    ok('I: mirror on + "Hide Twitch\'s name tag" on → no tag on either', tag('I-mirror-and-hide', 'G1') < 0.02 && tag('I-mirror-and-hide', 'G2') < 0.02 && String(sides('I-mirror-and-hide')) === 'right,right', [tag('I-mirror-and-hide', 'G1'), tag('I-mirror-and-hide', 'G2'), sides('I-mirror-and-hide')]);
    ok('J: hide off → the tag is back, readable (identical to A)', sameLabel('A-normal', 'J-hide-off', 'G1') && sameLabel('A-normal', 'J-hide-off', 'G2'), [tag('J-hide-off', 'G1'), tag('J-hide-off', 'G2')]);
    ok('after restart: the tag is still hidden (persisted)', p2.states['F-after-restart'] && tag('F-after-restart', 'G1', p2.states) < 0.02 && tag('F-after-restart', 'G2', p2.states) < 0.02, p2.states['F-after-restart'] && [tag('F-after-restart', 'G1', p2.states), tag('F-after-restart', 'G2', p2.states)]);
    const appLog = (() => { try { return fs.readFileSync(path.join(ud, 'logs', 'camreel.log'), 'utf8'); } catch { return ''; } })();
    ok('the app verified and logged "name tag hidden"', /name tag hidden/.test(appLog));
    const r4 = (p4.rows4 || []);
    ok('Twitch link without a name tag → the row says "not found" and it is logged', r4.find((x) => x.name === 'Twitch') && r4.find((x) => x.name === 'Twitch').npNote === true && p4.notFoundLogged === true, r4);
    ok('non-Twitch link → no warning', r4.find((x) => x.name === 'Other') && r4.find((x) => x.name === 'Other').npNote === false, r4);
    const s3 = p3.states || {};
    ok('no-video page: normal = red on the LEFT', s3['G-novideo-normal'] && side(s3['G-novideo-normal'].cards.G3) === 'left', s3['G-novideo-normal'] && side(s3['G-novideo-normal'].cards.G3));
    ok('no-video page: mirror on → the WHOLE card flips (red on the RIGHT, mode element)', s3['H-novideo-mirrored'] && side(s3['H-novideo-mirrored'].cards.G3) === 'right' && s3['H-novideo-mirrored'].cards.G3.mirrorMode === 'element', s3['H-novideo-mirrored'] && [side(s3['H-novideo-mirrored'].cards.G3), s3['H-novideo-mirrored'].cards.G3.mirrorMode]);
    ok('no-video page: the fallback is logged', p3.fallbackLogged === true);
    ok('after restart: Settings shows both ⇋ pressed', p2.states['F-after-restart'] && String(p2.states['F-after-restart'].rows) === 'true,true', p2.states['F-after-restart'] && p2.states['F-after-restart'].rows);
  } catch (e) { ok('results readable', false, e.message); }
  const failed = res.filter((x) => !x.pass);
  for (const x of [...failed, ...res.filter((x) => x.pass)]) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '   ' + String(JSON.stringify(x.detail)).slice(0, 200)}`);
  console.log(failed.length ? `RESULT FAIL ${failed.length}/${res.length}` : `RESULT PASS ${res.length}/${res.length}`);
  process.exit(failed.length ? 1 : 0);
})();
