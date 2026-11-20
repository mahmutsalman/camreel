'use strict';
// The 0.3.1 look, in the real app (2 stand-in guests):
//   L1 a settings file from before 0.3.1 with the OLD defaults moves to the new look on start:
//      920 wide, cards fill it edge to edge (x = 0, width 920), no margin, transparent; the old file is kept as .bak
//   L2 a file whose values were CHOSEN (not the old defaults) keeps them
//   L3 no shadow, no outline by default; switching them on draws them
//   L4 the strip window cannot be resized by hand; a size typed in Settings still applies
//   L5 transparent: the window's empty corner is see-through (alpha 0)
//   node scripts/scenario-look.js
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const S = 'http://127.0.0.1:8777';
const get = (url) => new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', () => r(true)); }).on('error', () => r(false)));
const sources = [1, 2].map((n) => ({ url: `${S}/guest?n=${n}&auth=FAKE-TOKEN-${n}`, name: `G${n}` }));

function runApp(prefix, cfgObj, steps) {
  const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-look-'));
  fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify(cfgObj, null, 2));
  fs.rmSync(path.join(ROOT, 'proof', `${prefix}-result.json`), { force: true });
  spawnSync(path.join(ROOT, 'scripts/prove.sh'), ['', JSON.stringify({ out: path.join(ROOT, 'proof'), prefix, steps }), '90'],
    { encoding: 'utf8', env: { ...process.env, STC_USERDATA: ud, STC_CONFIG: '' } });
  return { r: JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${prefix}-result.json`), 'utf8')), disk: JSON.parse(fs.readFileSync(path.join(ud, 'config.json'), 'utf8')), bak: fs.existsSync(path.join(ud, 'config.json.bak')), log: fs.readFileSync(path.join(ud, 'logs', 'camreel.log'), 'utf8') };
}

(async () => {
  let server = null;
  if (!(await get(`${S}/states`))) { server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 800)); }
  for (const n of [1, 2]) await get(`${S}/control?n=${n}&state=alive`);
  const fails = [];
  const ok = (c, m, v) => { console.log(`${c ? 'ok  ' : 'FAIL'} ${m}${c ? '' : '  ' + String(JSON.stringify(v)).slice(0, 300)}`); if (!c) fails.push(m); };
  try {
    // 1: an old file, every look value still the old default (exactly what 0.3.0 wrote)
    const a = runApp('look-old', { sources, layout: { style: 'still', cardWidth: 420, margin: 30, cycleSeconds: 0 }, window: { width: 480, height: 1080, background: '#00ff00' } }, [
      { until: { shown: 2 }, timeoutMs: 20000 }, { wait: 800, shot: 'new-look' },
      { userResize: true }, { wait: 1000 },                 // 2, 3: dragged 200 px wider
      { patchLayout: { shadow: true, outline: true } }, { wait: 800 },   // 4, 5
      { patchWindow: { width: 700 } }, { wait: 900 },       // 6, 7
      { patchWindow: { lockSize: true } }, { wait: 900 },   // 8, 9
    ]);
    const st = a.r.steps;
    const first = st[1].snapshot.cards;
    ok(a.disk.lookVersion === 2 && a.disk.window.background === 'transparent' && a.disk.layout.cardWidth === 0 && a.disk.layout.margin === 0 && a.bak,
      'L1 old defaults → the new look on disk (transparent, fill, margin 0; 920 = the cards below), old file kept as .bak', { disk: a.disk.window, layout: a.disk.layout, bak: a.bak });
    ok(/new default look applied \(window\.width, layout\.cardWidth, layout\.margin, window\.background\)/.test(a.log), 'L1 the log says what changed');
    ok(first.length === 2 && first.every((c) => c.rect.x === 0 && c.rect.w === 920), 'L1 the cards touch both edges (x 0, width 920)', first.map((c) => c.rect));
    ok(first.every((c) => c.boxShadow === 'none' || !/rgba?\((?!0, 0, 0, 0\))/.test(c.boxShadow)), 'L3 no shadow, no outline by default', first.map((c) => c.boxShadow));
    ok(st[5].snapshot.cards.every((c) => /0px 0px 0px 2px/.test(c.boxShadow) && /18px 40px/.test(c.boxShadow)), 'L3 switched on: shadow and outline drawn', st[5].snapshot.cards.map((c) => c.boxShadow));
    // a drag on the window's edge is refused by macOS when the window is not resizable (Electron's own setSize is not)
    ok(st[1].resizable === true && st[1].contentSize[0] === 920, 'L4 the strip starts at 920 and can be resized by dragging', { resizable: st[1].resizable, size: st[1].contentSize });
    ok(st[3].contentSize[0] === 1120 && st[3].snapshot.cards.every((c) => c.rect.w === 1120 && c.rect.x === 0) && /resized to 1120x1080/.test(a.log),
      'L6 resized 200 px wider: the cards fill the new width, and the size is saved', { size: st[3].contentSize, cards: st[3].snapshot.cards.map((c) => c.rect.w) });
    ok(st[7].contentSize[0] === 700 && st[7].snapshot.cards.every((c) => c.rect.w === 700 && c.rect.x === 0), 'L4 a width set in Settings applies (700, cards fill it)', { size: st[7].contentSize, w: st[7].snapshot.cards.map((c) => c.rect) });
    ok(st[9].resizable === false, 'L7 "Lock size" on: the strip cannot be resized by dragging', st[9].resizable);
    const shot = a.r.shots.find((s) => s.name === 'new-look');
    ok(shot && shot.cornerAlpha === 0, 'L5 transparent: the empty corner is see-through', shot && { alpha: shot.cornerAlpha });
    // 2: an old file with CHOSEN values
    const b = runApp('look-custom', { sources, layout: { style: 'still', cardWidth: 300, margin: 12, cycleSeconds: 0 }, window: { width: 600, height: 1080, background: '#123456' } }, [
      { until: { shown: 2 }, timeoutMs: 20000 }, { wait: 1500 }]); // after the cards' grow-in (0.85 → 1 in 0.6 s)
    ok(b.disk.lookVersion === 2 && b.disk.window.width === 600 && b.disk.window.background === '#123456' && b.disk.layout.cardWidth === 300 && b.disk.layout.margin === 12,
      'L2 chosen values are kept', { w: b.disk.window, l: b.disk.layout });
    ok(b.r.steps[1].snapshot.cards.every((c) => c.rect.w === 300), 'L2 the strip shows them (card 300 wide)', b.r.steps[1].snapshot.cards.map((c) => c.rect.w));
  } catch (e) { fails.push('could not judge: ' + e.message); console.log(e); }
  if (server) server.kill();
  console.log(fails.length ? `RESULT FAIL (${fails.length})` : 'RESULT PASS');
  process.exit(fails.length ? 1 : 0);
})();
