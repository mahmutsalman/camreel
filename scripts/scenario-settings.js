'use strict';
// The Settings window, end to end, with real input events, then a restart.
//   node scripts/scenario-settings.js
//   STC_SABOTAGE=no-persist  node scripts/scenario-settings.js   → the restart checks go red
//   STC_SABOTAGE=paste-noop  node scripts/scenario-settings.js   → the paste checks go red
// Uses a SCRATCH userData folder (never his real settings) and fake-token stand-in links.
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = process.env.STC_SABOTAGE ? `settings-sabotage-${process.env.STC_SABOTAGE}` : 'settings';
const S = process.env.STANDIN_URL || 'http://127.0.0.1:8777';
const userData = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-settings-'));
const LINKS = [
  `${S}/widgets/guest-star/anachan?display=single&slot=1&auth=FAKE-TOKEN-AAAA`,
  `${S}/widgets/guest-star/bobchan?display=single&slot=2&auth=FAKE-TOKEN-BBBB`,
  `${S}/guest?n=3&auth=FAKE-TOKEN-CCCC`,
];
const get = (url) => new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', () => r(true)); }).on('error', () => r(false)));

function runPhase(phase) {
  const proof = { out: path.join(ROOT, 'proof'), prefix: PREFIX, settingsTest: true, phase, links: LINKS };
  const res = spawnSync(path.join(ROOT, 'scripts/prove.sh'), ['', JSON.stringify(proof), '120'], {
    encoding: 'utf8', env: { ...process.env, STC_USERDATA: userData, STC_CONFIG: '' } });
  return (res.stdout || '') + (res.stderr || '');
}

(async () => {
  let server = null;
  if (!(await get(`${S}/states`))) { server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 800)); }
  for (const n of [1, 2, 3]) await get(`${S}/control?n=${n}&state=alive`);
  let logs = '';
  let code = 1;
  try {
    for (const n of [1, 2]) fs.rmSync(path.join(ROOT, 'proof', `${PREFIX}-phase${n}.json`), { force: true }); // never judge a stale result
    logs += runPhase(1);
    logs += runPhase(2);
    fs.writeFileSync(path.join(ROOT, 'proof', `${PREFIX}-log.txt`), logs.split('\n').filter((l) => l.includes('[camreel]')).join('\n') + '\n');
    const p1 = JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-phase1.json`), 'utf8'));
    const p2 = JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-phase2.json`), 'utf8'));
    const leaked = /FAKE-TOKEN/.test(logs) || /FAKE-TOKEN/.test(JSON.stringify([p1, p2]));
    code = judge(p1, p2, leaked);
  } catch (e) { console.log('RESULT FAIL (could not judge):', e.message); }
  finally { if (server) server.kill(); fs.rmSync(userData, { recursive: true, force: true }); }
  process.exit(code);
})();

function judge(p1, p2, leaked) {
  const res = [];
  const ok = (name, pass, detail) => res.push({ name, pass: !!pass, detail });
  const names = (rows) => (rows || []).filter((x) => !x.empty).map((x) => x.name);
  const empties = (rows) => (rows || []).filter((x) => x.empty).length;
  const st = p1.steps || {};
  if (p1.error) ok('phase 1 ran without error', false, p1.error);
  if (p2.error) ok('phase 2 ran without error', false, p2.error);
  ok('first run opens Settings', p1.settingsOpenAtFirstRun);
  ok('window titles', p1.stripTitle === 'CamReel — Strip' && p1.settingsTitle === 'CamReel — Settings', [p1.stripTitle, p1.settingsTitle]);
  const pst = (s, want, row) => s && JSON.stringify(names(s.rows)) === JSON.stringify(want) && empties(s.rows) === 1 && s.active.row === String(row) && /name/.test(s.active.cls);
  ok('paste 1 → a row (named from the channel) + a fresh empty row, focus on its name', pst(st.paste1, ['anachan'], 0), st.paste1);
  ok('paste 2 → second row', pst(st.paste2, ['anachan', 'bobchan'], 1), st.paste2 && names(st.paste2.rows));
  ok('paste 3 → third row ("Guest 3": no channel in the link)', pst(st.paste3, ['anachan', 'bobchan', 'Guest 3'], 2), st.paste3 && names(st.paste3.rows));
  ok('pasting a duplicate warns and adds nothing', st.dup && names(st.dup.rows).length === 3 && /already/.test(st.dup.error), st.dup && st.dup.error);
  ok('pasting a non-link shows an error and adds nothing', st.notUrl && names(st.notUrl.rows).length === 3 && /not a link/.test(st.notUrl.error), st.notUrl && st.notUrl.error);
  ok('links are masked in the table', st.paste3 && st.paste3.rows.filter((x) => !x.empty).every((x) => x.masked));
  ok('rename by typing → saved', st.rename && names(st.rename.rows)[2] === 'Cem' && st.rename.diskNames[2] === 'Cem', st.rename);
  ok('the strip shows all 3 live guests', st.allShown && st.stripBefore.length === 3, st.stripBefore);
  ok('toggle OFF → its card leaves the strip and its page is unloaded', st.toggleOff && !st.toggleOff.stripCards.includes('bobchan') && JSON.stringify(st.toggleOff.stripShown) === '["anachan","Cem"]', st.toggleOff);
  ok('reorder ▲ → table, disk and strip order change', st.reorder && JSON.stringify(names(st.reorder.rows)) === '["anachan","Cem","bobchan"]' && JSON.stringify(st.reorder.diskNames) === '["anachan","Cem","bobchan"]' && JSON.stringify(st.reorder.stripShown) === '["anachan","Cem"]', st.reorder);
  ok('delete ✕ → row gone from table and disk', st.del && JSON.stringify(names(st.del.rows)) === '["Cem","bobchan"]' && JSON.stringify(st.del.diskNames) === '["Cem","bobchan"]', st.del);
  ok('toggle storm (20 real clicks OFF/ON): app up, guest back on the strip', st.storm && st.storm.appAlive && st.storm.back && st.storm.rows[0].on, st.storm);
  ok('layout edit (cycle seconds typed) saved', st.layout && st.layout.diskCycle === 0, st.layout);
  ok('style → Endless loop: saved, strip switches, the cost warning shows, speed + direction fields only', st.animLoop && st.animLoop.disk === 'loop' && st.animLoop.strip && /never rests/.test(st.animLoop.ui.warning) && JSON.stringify(st.animLoop.ui.shown) === '["layout.secondsPerGuest","layout.direction"]', st.animLoop);
  ok('style → Step and hold: saved, strip switches, no warning, its own fields', st.animStep && st.animStep.disk === 'step' && st.animStep.strip && st.animStep.ui.warning === '' && st.animStep.ui.shown.includes('layout.slideSeconds'), st.animStep);
  ok('card padding typed → saved and applied on the strip', st.padding && st.padding.disk === 12 && st.padding.strip, st.padding);
  { const m = st.meld;
    ok('Meld box 432 × 830 → the strip is exactly 432 × 830, applied live', m && m.disk.width === 432 && m.disk.height === 830 && m.stripSize[0] === 432 && m.stripSize[1] === 830 && /same as Meld/.test(m.note), m); }
  { const p = st.preview;
    ok('preview: pointing at Card padding lights up the frame and explains it', p && p.pad.hl === 'frame' && p.pad.marks >= 1 && /frame/i.test(p.pad.tip), p && p.pad);
    ok('preview: Name strip height → the name strips; Side margin → the side margins (2 bands)', p && p.name.hl === 'name' && p.name.marks >= 1 && p.margin.hl === 'margin-side' && p.margin.marks === 2, p && [p.name, p.margin]);
    ok('preview: draws one card per live guest, sized by the settings (padding 12 → frame)', p && p.pad.cards >= 1 && p.pad.frames.every((f) => f.w > 0 && f.h > 0), p && p.pad);
    ok('style tile click (Fade) → saved, tile marked, preview says what it does', p && p.tileDisk === 'fade' && p.tileOn === 'fade' && /Fade|Stands still/.test(p.after.motion), p && [p.tileDisk, p.tileOn, p.after.motion]); }
  ok('atomic save: .bak kept, no .tmp left', p1.bakExists && !p1.tmpLeft);
  ok('closing Settings does not quit', p1.afterCloseAppAlive);
  ok('Dock click reopens Settings', p1.dockReopensSettings);
  ok('restart: Settings does not pop up when there are guests', p2.settingsOpenAtStart === false);
  ok('restart: the menu item opens Settings', p2.menuOpensSettings);
  ok('restart: rows come back from disk (names, order, on/off)', JSON.stringify((p2.rows || []).filter((x) => !x.empty).map((x) => [x.name, x.on])) === '[["Cem",true],["bobchan",false]]', p2.rows);
  ok('restart: the strip shows only the ON guest', p2.stripAlive && JSON.stringify(p2.stripCards) === '["Cem"]', p2.stripCards);
  ok('restart: layout came back', p2.disk && p2.disk.layout && p2.disk.layout.cycleSeconds === 0);
  ok('no token in logs or results', !leaked);
  const failed = res.filter((x) => !x.pass);
  for (const x of [...failed, ...res.filter((x) => x.pass)]) console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '   ' + String(JSON.stringify(x.detail)).slice(0, 300)}`);
  console.log(`paste path used: ${['paste1', 'paste2', 'paste3', 'dup', 'notUrl'].map((k) => st[k] && st[k].how).join(', ')}`);
  console.log(failed.length ? `RESULT FAIL ${failed.length}/${res.length}` : `RESULT PASS ${res.length}/${res.length}`);
  return failed.length ? 1 : 0;
}
