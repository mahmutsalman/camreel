'use strict';
// The motion styles' math (src/styles.js), without Electron. For 1..20 guests and 3 window
// sizes, runs every driven style 60 s at 30 fps and checks what a viewer would see:
//   S1 a card never JUMPS while any part of it is in the window (loop/step change ends off-screen;
//      deck/drum change ends while invisible)
//   S2 loop never stops; step / fade / deck / drum rest (hold still) between changes
//   S3 fade: at every moment the cards covering the spot add up to fully opaque (no see-through moment)
//   S4 deck: the front card is fully opaque and the largest whenever the deck rests
//   S5 every guest gets its turn (is fully in the window / in front) within one round
//   S6 direction "down" moves loop/step cards down
//   node scripts/test-styles.js                         → PASS
//   STC_SABOTAGE=loop-visible-wrap node scripts/...     → must FAIL (S1)
const S = require('../src/styles.js');
const SAB = process.env.STC_SABOTAGE || '';
const fails = [];
let checks = 0;
const check = (ok, msg) => { checks++; if (!ok && fails.length < 25) fails.push(msg); };

const windows = [{ winH: 1080, cardWidth: 420, gap: 24, margin: 30 }, { winH: 720, cardWidth: 300, gap: 10, margin: 0 }, { winH: 1080, cardWidth: 1200, gap: 40, margin: 60 }];
for (const w of windows) {
  const cardH = Math.round(w.cardWidth * 9 / 16);
  const d = { H: cardH + Math.max(20, Math.round(w.cardWidth * 0.08)), gap: w.gap, winH: w.winH, margin: w.margin };
  for (const style of S.DRIVEN) {
    for (const n of [1, 2, 3, 4, 5, 8, 20]) {
      for (const direction of ['up', 'down']) {
        if (direction === 'down' && !['loop', 'step'].includes(style)) continue;
        const L = { style, secondsPerGuest: 3, slideSeconds: 0.8, direction };
        const m = {};
        const tag = `${style} n=${n} ${direction} win ${w.winH}/${w.cardWidth}`;
        let prev = null, rests = 0, moves = 0, dirSum = 0;
        const turn = new Array(n).fill(false);
        const dt = 1 / 30, steps = 60 * 30;
        for (let f = 0; f < steps; f++) {
          const u = S.advance(m, dt, L, n);
          const now = [];
          for (let i = 0; i < n; i++) now.push(S.place(style, i, n, u, d, SAB));
          const inWin = (p) => p.o > 0.01 && p.y + d.H > 0 && p.y < d.winH;
          if (prev) {
            let moved = false;
            for (let i = 0; i < n; i++) {
              const a = prev[i], b = now[i];
              const jump = Math.abs(b.y - a.y) > d.H * 0.6 || Math.abs(b.rx - a.rx) > 45;
              // S1: a jump is fine only when the card is invisible before AND after it
              const showing = (p) => (p.o > 0.01 ? Math.max(0, Math.min(p.y + d.H, d.winH - p.y, d.H)) : 0);
              // loop/step: a jump is the reel changing ends (exactly L); allowed only while no more of the card shows
              // than this frame's own travel. Elsewhere (deck, drum): invisible before AND after.
              const travel = style === 'loop' || style === 'step' ? Math.abs(Math.abs(b.y - a.y) - S.loopLength(n, d, SAB).L) : 0;
              if (jump) check(showing(a) <= travel + 2 && showing(b) <= travel + 2, `S1 ${tag}: card ${i} jumped ${a.y.toFixed(0)}→${b.y.toFixed(0)}px rx ${a.rx.toFixed(0)}→${b.rx.toFixed(0)} while visible (t=${(f * dt).toFixed(2)}s)`);
              if (Math.abs(b.y - a.y) > 1e-6 || Math.abs(b.rx - a.rx) > 1e-6 || Math.abs(b.o - a.o) > 1e-6) moved = true;
              if (!jump) dirSum += b.y - a.y;
            }
            moved ? moves++ : rests++;
          }
          // S3: fade covers the spot
          if (style === 'fade') {
            const order = now.map((p, i) => ({ ...p, i })).sort((a, b) => b.z - a.z);
            let through = 1; for (const p of order) through *= 1 - p.o;
            check(through < 0.001, `S3 ${tag}: the spot is ${(through * 100).toFixed(0)}% see-through at t=${(f * dt).toFixed(2)}s`);
          }
          // S4: deck at rest
          if (style === 'deck' && !S.sliding(m, L)) {
            const front = now.reduce((a, b) => (b.z > a.z ? b : a));
            check(front.o === 1 && now.every((p) => p.s <= front.s), `S4 ${tag}: the front card is not fully opaque / largest at rest`);
          }
          // S5 turns
          for (let i = 0; i < n; i++) {
            const p = now[i];
            if (style === 'loop' || style === 'step') { if (p.y >= 0 && p.y + d.H <= d.winH) turn[i] = true; }
            else if (p.o === 1 && (style !== 'drum' || Math.abs(p.rx) < 1)) turn[i] = true;
          }
          prev = now;
        }
        if (style === 'loop') check(rests === 0, `S2 ${tag}: the loop stood still for ${rests} frames`);
        else if (n >= 2) check(rests > moves, `S2 ${tag}: rests ${rests} frames, moves ${moves}: it should mostly rest`);
        // a full round: loop/step pass every slot; the window is at least one card tall in these sizes
        const ll = S.loopLength(n, d);
        const round = style === 'loop' ? (ll.L / ll.P) * L.secondsPerGuest : n * (L.secondsPerGuest + L.slideSeconds);
        if (round <= 55) check(turn.every(Boolean), `S5 ${tag}: guest(s) ${turn.map((t, i) => (t ? null : i)).filter((x) => x !== null).join(',')} never got a turn in ${round.toFixed(0)} s`);
        if ((style === 'loop' || style === 'step') && n >= 1) check(direction === 'up' ? dirSum < 0 : dirSum > 0, `S6 ${tag}: cards moved the wrong way (net ${dirSum.toFixed(0)}px)`);
      }
    }
  }
}
console.log(`checks: ${checks}`);
for (const f of fails) console.log('  ' + f);
console.log(fails.length ? `RESULT FAIL (${fails.length}${fails.length >= 25 ? '+' : ''} failures)` : `RESULT PASS ${checks}/${checks}`);
process.exit(fails.length ? 1 : 0);
