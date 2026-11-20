'use strict';
// Judges proof/dead-result.json. Every check asserts an OUTCOME a viewer would see
// (which cards are on screen, where), not just a state flag.
const fs = require('fs');

function check(file, leaked) {
  const r = JSON.parse(fs.readFileSync(file, 'utf8'));
  const results = [];
  const ok = (name, pass, detail) => results.push({ name, pass: !!pass, detail });
  if (r.error) ok('run finished without error', false, r.error);
  const shot = (n) => r.shots.find((s) => s.name === n);
  const shown = (s) => (s ? s.cards.filter((c) => c.mode === 'shown').map((c) => c.name) : []);
  const stepAfter = (tag) => { const i = r.steps.findIndex((s) => s.step.includes(`"tag":"${tag}"`)); return i < 0 ? null : r.steps[i + 1]; };

  const s1 = shot('1-four-alive');
  ok('4 live guests are on screen', JSON.stringify(shown(s1)) === '["G1","G2","G3","G4"]', shown(s1));
  const everNoCam = r.timeline.some((t) => /NoCam:\w+\/shown/.test(t.cards)) || r.shots.some((s) => shown(s).includes('NoCam'));
  ok('a guest with no video is never shown', !everNoCam, s1 && s1.cards.find((c) => c.name === 'NoCam'));

  const k = stepAfter('kill2');
  ok('killed guest 2 is hidden', k && k.met, k && k.snapshot.cards.find((c) => c.name === 'G2'));
  ok('hidden after the dead delay (3.5 s .. 7 s), not before', k && k.met && k.tookMs >= 3500 && k.tookMs <= 7000, k && `${k.tookMs} ms`);
  const s2 = shot('2-g2-killed'), s2b = shot('2b-still-cycling');
  ok('3 cards remain', JSON.stringify(shown(s2b)) === '["G1","G3","G4"]', shown(s2b));
  if (s2b) {
    const vis = s2b.cards.filter((c) => c.mode === 'shown');
    const slots = vis.map((c) => c.slotY);
    const step = slots[1] - slots[0];
    ok('the gap closed (slots contiguous)', slots[0] === 0 && slots.every((y, i) => y === i * step), slots);
    const rects = vis.map((c) => c.rect).sort((a, b) => a.y - b.y);
    const overlap = rects.some((a, i) => i && rects[i - 1].y + rects[i - 1].h > a.y + 4);
    const gaps = rects.slice(1).map((a, i) => a.y - (rects[i].y + rects[i].h));
    ok('on screen: no overlap, no hole where G2 was', !overlap && gaps.every((g) => g < 80), gaps);
    const g2 = s2b.cards.find((c) => c.name === 'G2');
    ok('the hidden card is invisible', g2 && Number(g2.opacity) === 0, g2 && g2.opacity);
  }
  ok('still cycling after the change', s2 && s2b && s2.offset !== s2b.offset, s2 && s2b && [s2.offset, s2b.offset]);

  const rv = stepAfter('revive2');
  ok('guest 2 comes back after its camera returns', rv && rv.met, rv && `${rv.tookMs} ms`);
  ok('it comes back within 5 s', rv && rv.met && rv.tookMs <= 5000, rv && `${rv.tookMs} ms`);
  const s3 = shot('3-g2-back');
  ok('back in its config place', JSON.stringify(shown(s3)) === '["G1","G2","G3","G4"]', shown(s3));

  // no flicker: between kill and revive, G2 changed state exactly once (alive -> dead)
  const kAt = r.steps.find((s) => s.step.includes('"tag":"kill2"')).atMs;
  const rAt = r.steps.find((s) => s.step.includes('"tag":"revive2"')).atMs;
  const g2states = r.timeline.filter((t) => t.atMs >= kAt && t.atMs <= rAt).map((t) => (/G2:(\w+)\//.exec(t.cards) || [])[1]);
  const flips = g2states.filter((s, i) => i && s !== g2states[i - 1]).length;
  ok('no flicker while dead (one alive->dead change)', flips <= 1 && g2states.at(-1) === 'dead', g2states.join(','));

  const vanish = (n) => r.steps.some((s) => s.step.includes(`"name":"${n}","mode":"parked"`) && s.met);
  const back = (n) => r.steps.some((s) => s.step.includes(`"name":"${n}","mode":"shown"`) && s.met);
  ok('a guest whose page goes blank is hidden and returns', vanish('G3') && back('G3'));
  ok('a guest whose video element is removed is hidden and returns', vanish('G4') && back('G4'));

  const s4 = shot('4-config-edited');
  ok('config edit: G4 removed, G5 added, G1 renamed', JSON.stringify(shown(s4)) === '["G1 renamed","G2","G3","G5"]', shown(s4));
  const s5 = shot('5-broken-json-kept');
  ok('broken JSON: the same cards stay', JSON.stringify(shown(s5)) === JSON.stringify(shown(s4)), shown(s5));
  ok('broken JSON: the error is reported', s5 && /not valid JSON/.test(s5.configError || ''), s5 && s5.configError);
  const s6 = shot('6-none-alive');
  ok('0 alive: nothing on screen', s6 && shown(s6).length === 0, shown(s6));
  ok('no token in the log or result', !leaked);

  const failed = results.filter((x) => !x.pass);
  for (const x of [...failed, ...results.filter((x) => x.pass)]) {
    console.log(`${x.pass ? 'PASS' : 'FAIL'}  ${x.name}${x.pass ? '' : '   ' + JSON.stringify(x.detail)}`);
  }
  console.log(failed.length ? `RESULT FAIL ${failed.length}/${results.length}` : `RESULT PASS ${results.length}/${results.length}`);
  return failed.length ? 1 : 0;
}

module.exports = { check };
if (require.main === module) process.exit(check(process.argv[2] || 'proof/dead-result.json', false));
