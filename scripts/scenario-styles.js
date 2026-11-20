'use strict';
// Every motion style in the REAL strip (4 stand-in guests, 480x1080), one run:
//   per style: switch live (config file), sample the card rects 5x a second for 4 s, a picture,
//   then CPU of CamReel's processes (top, 3 s interval) — two rounds, interleaved.
//   R1 loop: no card jumps while it is in the window; the reel always moves
//   R2 step / fade / deck / drum: the reel rests between changes (some samples identical)
//   R3 fade: the spot is never see-through (opacities of the stacked cards)
//   R4 drum: a turned card is drawn shorter than a flat one (the 3D really applies)
//   R5 padding + name options: picture fills its (smaller) area, card stays 420 wide, the strip is taller
//   R6 every style shows at least one guest fully in the window at its rest
//   node scripts/scenario-styles.js            STC_SABOTAGE=loop-visible-wrap → R1 must FAIL
const { spawn, spawnSync } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');

const ROOT = path.resolve(__dirname, '..');
const PREFIX = 'styles' + (process.env.STC_SABOTAGE ? '-' + process.env.STC_SABOTAGE : '');
const S = 'http://127.0.0.1:8777';
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-styles-'));
const CPU = path.join(ud, 'cpu.txt');
// smartFit off: each style is tested AS ITSELF here; R8 turns it on
const base = { secondsPerGuest: 2.5, slideSeconds: 0.8, cycleSeconds: 8, cardWidth: 420, smartFit: false };
fs.writeFileSync(path.join(ud, 'config.json'), JSON.stringify({
  sources: [1, 2, 3, 4].map((n) => ({ url: `${S}/guest?n=${n}&auth=FAKE-TOKEN-${n}`, name: `G${n}` })),
  layout: { ...base, style: 'still' }, window: { width: 480, height: 1080 }, lookVersion: 2 }, null, 2));
const get = (url) => new Promise((r) => http.get(url, (res) => { res.resume(); res.on('end', () => r(true)); }).on('error', () => r(false)));
// CamReel's own processes only (this checkout's Electron), the 2nd top sample = a true 3 s average
const cpuSh = (tag) => `P=$(pgrep -f "StreamTogetherCycle/node_modules/electron" | sed 's/^/-pid /' | tr '\\n' ' '); top -l 2 -s 3 -stats pid,cpu $P | awk -v t=${tag} '/^PID/{n++; s=0; next} n==2 && $1 ~ /^[0-9]+$/ {s+=$2} END {print t, s}' >> ${CPU}`;

const ORDER = ['still', 'loop', 'step', 'pingpong', 'fade', 'deck', 'drum'];
const steps = [{ until: { shown: 4 }, timeoutMs: 20000 }, { wait: 1500 }];
for (const round of [1, 2]) {
  for (const style of ORDER) {
    steps.push({ patchLayout: { style }, label: `${style}#${round}` }, { wait: 1200 });
    if (round === 1) { for (let i = 0; i < 20; i++) steps.push({ wait: 200, sample: style }); steps.push({ shot: style }); }
    steps.push({ sh: cpuSh(style) });
  }
}
// R8 SMART: loop chosen; 2 guests go dead → the 2 left fit → still + centred; back → the loop moves again; 1 guest → still
const smartSample = (tag) => { for (let i = 0; i < 6; i++) steps.push({ wait: 250, sample: tag }); };
steps.push({ patchLayout: { style: 'loop', smartFit: true } }, { wait: 1500 });
smartSample('smart-4');                                   // 4 × 294 < 1080 + 270: a loop would leave a gap → up and down
steps.push({ patchWindow: { height: 900 } }, { wait: 1500 });
smartSample('smart-4-short');                             // 900 high: 4 × 294 ≥ 900 + 270: the loop runs, no gap
steps.push({ patchWindow: { height: 1080 } }, { wait: 1500 });
steps.push({ http: `${S}/control?n=3&state=stop` }, { http: `${S}/control?n=4&state=stop` }, { until: { shown: 2 }, timeoutMs: 15000 }, { wait: 1500 });
smartSample('smart-2');
steps.push({ http: `${S}/control?n=2&state=stop` }, { until: { shown: 1 }, timeoutMs: 15000 }, { wait: 4000 }); // the column glides to the centre (~3 s)
smartSample('smart-1');
for (const n of [2, 3, 4]) steps.push({ http: `${S}/control?n=${n}&state=alive` });
steps.push({ until: { shown: 4 }, timeoutMs: 15000 }, { wait: 1500 });
smartSample('smart-back');
steps.push({ patchLayout: { style: 'still', cardPadding: 16, frameColor: '#202040', nameHeight: 44, namePadding: 30, nameSize: 22, nameAlign: 'center', verticalMargin: 10 } }, { wait: 1500, shot: 'padding' });

(async () => {
  let server = null;
  if (!(await get(`${S}/states`))) { server = spawn(process.execPath, [path.join(ROOT, 'standin/server.js')], { stdio: 'ignore' }); await new Promise((r) => setTimeout(r, 800)); }
  for (const n of [1, 2, 3, 4]) await get(`${S}/control?n=${n}&state=alive`);
  fs.rmSync(path.join(ROOT, 'proof', `${PREFIX}-result.json`), { force: true });
  spawnSync(path.join(ROOT, 'scripts/prove.sh'), ['', JSON.stringify({ out: path.join(ROOT, 'proof'), prefix: PREFIX, steps }), '300'],
    { encoding: 'utf8', env: { ...process.env, STC_USERDATA: ud, STC_CONFIG: '' } });
  if (server) server.kill();
  const fails = [];
  const ok = (cond, msg) => { if (!cond) fails.push(msg); };
  try {
    const r = JSON.parse(fs.readFileSync(path.join(ROOT, 'proof', `${PREFIX}-result.json`), 'utf8'));
    const tagOf = (st) => { try { return JSON.parse(st.step).sample; } catch { return null; } };
    const by = {};
    for (const st of r.steps) { const t = tagOf(st); if (t) (by[t] = by[t] || []).push(st.snapshot); }
    const winH = 1080;
    for (const style of ORDER) {
      const snaps = by[style] || [];
      ok(snaps.length >= 15 && snaps.every((s) => s.style === style), `${style}: not sampled in that style`);
      const us = snaps.map((s) => s.u);
      const same = us.slice(1).filter((u, i) => Math.abs(u - us[i]) < 1e-6).length;
      const H = snaps[0] ? snaps[0].cards[0].rect.h : 0;
      if (style === 'loop') {
        ok(same === 0, `R1 loop: the reel stood still in ${same} samples`);
        for (let k = 1; k < snaps.length; k++) for (let i = 0; i < 4; i++) {
          const a = snaps[k - 1].cards[i], b = snaps[k].cards[i];
          const vis = (c) => c.rect.y + c.rect.h > 0 && c.rect.y < winH;
          // changing ends (exactly the reel's length L) is fine while no more of the card shows than this sample's own travel
          // this sample's own travel = the loop's speed × the time between the two samples (+ the follow lag)
          const travel = ((H + 24) / base.secondsPerGuest) * ((snaps[k].wall - snaps[k - 1].wall) / 1000) + 6;
          const showing = (c) => Math.max(0, Math.min(c.rect.y + c.rect.h, winH - c.rect.y, c.rect.h));
          if (Math.abs(b.rect.y - a.rect.y) > H * 0.6) ok(showing(a) <= travel && showing(b) <= travel, `R1 loop: ${b.name} jumped ${a.rect.y}→${b.rect.y}px while in the window`);
        }
      }
      if (['step', 'fade', 'deck', 'drum'].includes(style)) ok(same >= 3 && same < us.length - 1, `R2 ${style}: rested in ${same}/${us.length - 1} samples (wants rests AND moves)`);
      if (style === 'fade') for (const s of snaps) {
        const st = s.cards.filter((c) => c.driven).sort((a, b) => b.driven.z - a.driven.z);
        let through = 1; for (const c of st) through *= 1 - c.driven.o;
        ok(through < 0.01, `R3 fade: the spot was ${(through * 100).toFixed(0)}% see-through`);
      }
      if (style === 'drum') ok(snaps.some((s) => s.cards.some((c) => c.driven && Math.abs(c.driven.rx) > 20 && c.rect.h < H * 0.95)), 'R4 drum: no turned card was drawn shorter');
      const shot = r.steps.find((st) => st.snapshot && st.step.includes(`"shot":"${style}"`));
      if (shot) ok(shot.snapshot.cards.some((c) => c.rect.y >= -2 && c.rect.y + c.rect.h <= winH + 2 && Number(c.opacity) > 0.95), `R6 ${style}: no guest fully in the window`);
    }
    // R8 smart
    const sm = (t) => by[t] || [];
    const moving = (snaps) => snaps.length > 1 && snaps.some((s, k) => k && (s.u !== snaps[k - 1].u || s.offset !== snaps[k - 1].offset));
    const centred = (snaps) => snaps.every((s) => { const sh = s.cards.filter((c) => c.mode === 'shown'); const top = Math.min(...sh.map((c) => c.rect.y)), bot = Math.max(...sh.map((c) => c.rect.y + c.rect.h)); return Math.abs(top - (winH - bot)) <= 3; });
    ok(sm('smart-4').every((s) => s.style === 'pingpong' && s.chosen === 'loop') && moving(sm('smart-4')), 'R9 4 guests that would leave a loop gap: up and down instead (moving)', sm('smart-4').map((s) => s.style));
    ok(sm('smart-4-short').every((s) => s.style === 'loop') && moving(sm('smart-4-short')), 'R9 the same 4 in a shorter window fill the reel: the loop itself runs', sm('smart-4-short').map((s) => s.style));
    ok(sm('smart-4-short').every((s) => { const L = Math.max(4 * 294, s.winH + 270 + 2); return L === 4 * 294; }), 'R9 …and its reel has no empty stretch', sm('smart-4-short').map((s) => s.winH));
    for (const t of ['smart-2', 'smart-1']) {
      const snaps = sm(t);
      ok(snaps.length && snaps.every((s) => s.style === 'still' && s.chosen === 'loop'), `R8 ${t.slice(6)} guest(s) fit: no motion although the loop is chosen`, snaps.map((s) => s.style));
      ok(snaps.length && centred(snaps), `R8 ${t.slice(6)} guest(s): centred (space above = space below)`, snaps.map((s) => s.cards.filter((c) => c.mode === 'shown').map((c) => c.rect.y)));
      ok(snaps.length && snaps.every((s) => s.cards.filter((c) => c.mode === 'shown').every((c) => Number(c.opacity) > 0.95)), `R8 ${t.slice(6)}: every shown card fully visible`);
    }
    ok(sm('smart-back').every((s) => s.style === 'pingpong') && moving(sm('smart-back')), 'R8 back to 4 guests: moving again (up and down: still too few to loop)', sm('smart-back').map((s) => s.style));
    const back = r.shots.find((s) => s.name === 'padding');
    if (back) ok(back.cards.filter((c) => c.mode === 'shown').every((c) => Number(c.opacity) > 0.95), `R7 from 3D drum back to Still: every card visible again (${back.cards.map((c) => c.opacity).join(', ')})`);
    const pad = r.shots.find((s) => s.name === 'padding');
    if (pad) {
      const inside = new Set(pad.cards.filter((c) => c.rect.y >= 0 && c.rect.y + c.rect.h <= winH).map((c) => c.name));
      const px = Object.entries(pad.pixels).filter(([n]) => inside.has(n)).map(([, p]) => p);
      ok(px.length >= 2 && px.every((p) => p.offscreen || p.bottomFill >= 0.9), `R5 padding: picture not filling its area (${px.map((p) => p.bottomFill).join(', ')})`);
      ok(pad.cards.every((c) => c.rect.w === 420 && c.pad === 16), `R5 padding: card width/pad ${pad.cards.map((c) => c.rect.w + '/' + c.pad).join(', ')}`);
    } else fails.push('R5 padding: no picture taken');
    const cpu = {};
    for (const line of fs.readFileSync(CPU, 'utf8').trim().split('\n')) { const [t, v] = line.split(' '); (cpu[t] = cpu[t] || []).push(Number(v)); }
    console.log('CPU of CamReel (4 stand-in guests), % of one core, round 1 / round 2:');
    for (const s of ORDER) console.log(`  ${s.padEnd(9)} ${(cpu[s] || []).map((v) => v.toFixed(1)).join(' / ')}   vs still ${((cpu[s] || [0]).reduce((a, b) => a + b, 0) / (cpu[s] || [1]).length - cpu.still.reduce((a, b) => a + b, 0) / cpu.still.length).toFixed(1)}`);
    fs.writeFileSync(path.join(ROOT, 'proof', `${PREFIX}-cpu.json`), JSON.stringify(cpu, null, 2));
    console.log(`pictures: proof/${PREFIX}-<style>.png, proof/${PREFIX}-padding.png`);
  } catch (e) { fails.push('could not judge: ' + e.message); }
  for (const f of fails.slice(0, 20)) console.log('  ' + f);
  console.log(fails.length ? `RESULT FAIL (${fails.length})` : 'RESULT PASS');
  process.exit(fails.length ? 1 : 0);
})();
