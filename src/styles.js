'use strict';
// The motion styles, as PURE math (no DOM): the strip (renderer.js) and the node test
// (scripts/test-styles.js) run the same code.
//   advance(motion, dt, layout, n) moves the clock and returns u = where the reel is,
//     in CARDS (u = 2.5: halfway from guest 3 to guest 4).
//   place(style, i, n, u, d) says where visible card i stands: { y, s, o, rx, zr, z }
//     y px from the top · s scale · o opacity · rx degrees round the X axis · zr drum radius px · z stacking.
// "pingpong" and "still" are not here: the strip moves its whole column for those (the original way).
(function (root) {
  const DRIVEN = ['loop', 'step', 'fade', 'deck', 'drum'];
  const mod = (a, m) => ((a % m) + m) % m;
  const clamp01 = (x) => Math.max(0, Math.min(1, x));
  const ease = (t) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2);

  // loop: constant speed. The others HOLD a guest for secondsPerGuest, then move one card on in slideSeconds.
  function advance(motion, dt, L, n) {
    const dir = L.direction === 'down' ? -1 : 1;
    if (L.style === 'loop') { motion.u = (motion.u || 0) + dir * dt / L.secondsPerGuest; return motion.u; }
    const hold = L.secondsPerGuest, slide = L.slideSeconds, cycle = hold + slide;
    // one guest (or none): nothing to move on to, so the clock waits (a still strip idles)
    if (n >= 2 || L.style === 'step') motion.stepT = (motion.stepT || 0) + dt;
    const t = motion.stepT || 0;
    const k = Math.floor(t / cycle), local = t - k * cycle;
    const u = k + (local < hold ? 0 : ease(clamp01((local - hold) / slide)));
    motion.u = L.style === 'step' ? dir * u : u;
    return motion.u;
  }

  // Is the reel between two guests right now? (false = holding still: the strip may idle)
  function sliding(motion, L) {
    if (L.style === 'loop') return true;
    const cycle = L.secondsPerGuest + L.slideSeconds;
    return mod(motion.stepT || 0, cycle) >= L.secondsPerGuest;
  }

  // seconds until the next slide starts (0 while sliding)
  function untilSlide(motion, L) {
    if (L.style === 'loop') return 0;
    const t = mod(motion.stepT || 0, L.secondsPerGuest + L.slideSeconds);
    return t >= L.secondsPerGuest ? 0 : L.secondsPerGuest - t;
  }

  // loop / step: the reel's length in px. The cards in a row (n · pitch), and never shorter than the
  // window + one card: a card changes ends only when it is fully above (y = -H) and reappears fully
  // below (y = winH). So the empty stretch after the last guest is exactly what that needs, no more.
  function loopLength(n, d, sabotage) {
    const P = d.H + d.gap;
    if (sabotage === 'loop-visible-wrap') return { P, L: Math.max(1, n) * P }; // tests only
    return { P, L: Math.max(n * P, d.winH + d.H + 2) }; // + 2 px: never a sliver of a card at the edge
  }

  function place(style, i, n, u, d, sabotage) {
    const cy = d.winH / 2 - d.H / 2;
    if (style === 'loop' || style === 'step') {
      const { P, L } = loopLength(n, d, sabotage);
      // u = 0: card 0 at the top margin; a card's y runs from -H (gone above) to L - H (just below)
      return { y: -d.H + mod((i - u) * P + d.margin + d.H, L), s: 1, o: 1, rx: 0, zr: 0, z: 0 };
    }
    if (style === 'fade') {
      // the incoming guest waits fully opaque UNDER the outgoing one, which fades away: never a
      // half-transparent moment where the green background shows through both
      if (n <= 1) return { y: cy, s: 1, o: 1, rx: 0, zr: 0, z: 2 };
      const k = mod(Math.floor(u), n), f = u - Math.floor(u);
      if (i === k) return { y: cy, s: 1, o: 1 - f, rx: 0, zr: 0, z: 2 };
      if (i === (k + 1) % n) return { y: cy, s: 1, o: f > 0 ? 1 : 0, rx: 0, zr: 0, z: 1 };
      return { y: cy, s: 1, o: 0, rx: 0, zr: 0, z: 0 };
    }
    if (style === 'deck') {
      const r = n <= 1 ? 0 : (n - 1) - mod((n - 1) - (i - u), n); // in (-1, n-1]: 0 = in front, 1, 2 … = behind it, < 0 = flying off
      if (r < 0) return { y: cy + r * (cy + d.H), s: 1, o: 1 + r, rx: 0, zr: 0, z: 1000 };
      // the card that just flew off waits invisible at the very back, then fades in as it moves up
      const o = n <= 1 ? 1 : Math.min(r <= 2 ? 1 : clamp01(3 - r), clamp01(n - 1 - r));
      return { y: cy + r * 24, s: 1 - 0.06 * r, o, rx: 0, zr: 0, z: Math.round(900 - r * 100) };
    }
    if (style === 'drum') {
      // n cards round a wheel turning on the X axis; fewer than 4 still sit 90° apart, so a card
      // changes ends only when it is edge-on or behind the wheel (invisible)
      const step = n < 4 ? 90 : 360 / n;
      const s = n <= 1 ? 0 : mod(i - u + n / 2, n) - n / 2;
      const th = -s * step;
      const R = ((d.H + d.gap) / 2) / Math.tan((step / 2) * Math.PI / 180);
      const c = Math.cos(th * Math.PI / 180);
      return { y: cy, s: 1, o: clamp01((c - 0.2) / 0.8), rx: th, zr: R, z: Math.round(c * 1000) };
    }
    throw new Error('not a driven style: ' + style);
  }

  const api = { DRIVEN, advance, sliding, untilSlide, place, loopLength };
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
  else root.CamReelStyles = api;
})(typeof window !== 'undefined' ? window : globalThis);
