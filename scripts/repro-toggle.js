'use strict';
// Reproduce: a source switched OFF then ON through the settings FILE (atomic replace, as
// any editor or script does) while the app runs. Scratch userData + stand-in only.
//   node scripts/repro-toggle.js <appDir> [cycles=20] [offMs=1500] [onMs=3000]
// Exit 0 = the app survived every cycle; 1 = it died (prints its last output).
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const appDir = path.resolve(process.argv[2] || '.');
const cycles = Number(process.argv[3] || 20), offMs = Number(process.argv[4] || 1500), onMs = Number(process.argv[5] || 3000);
// APP_BINARY = a packaged app's executable (then appDir is ignored)
const ELECTRON = process.env.APP_BINARY || path.join(__dirname, '..', 'node_modules/electron/dist/Electron.app/Contents/MacOS/Electron');
const S = process.env.STANDIN_URL || 'http://127.0.0.1:8777';
const ud = fs.mkdtempSync(path.join(os.tmpdir(), 'camreel-toggle-'));
const CFG = path.join(ud, 'config.json');
const ONLY = process.env.ONLY_ONE !== '0'; // his case: the ONLY source goes off (0 guests on)
const FIRST = process.env.SOURCE_URL || `${S}/guest?n=1&auth=FAKE-TOKEN-1111`;
const cfg = { sources: [{ url: FIRST, name: 'G1', enabled: true }].concat(ONLY ? [] : [{ url: `${S}/guest?n=2&auth=FAKE-TOKEN-2222`, name: 'G2', enabled: true }]), layout: { cycleSeconds: 24 } };
const write = (c) => { const t = CFG + '.perf.tmp'; fs.writeFileSync(t, JSON.stringify(c, null, 2)); fs.renameSync(t, CFG); };
write(cfg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
let out = '';
let exited = null;
const child = spawn(ELECTRON, process.env.APP_BINARY ? [] : [appDir], { env: { ...process.env, STC_USERDATA: ud, STC_CONFIG: '', ELECTRON_ENABLE_LOGGING: '1' } });
child.stdout.on('data', (d) => { out += d; });
child.stderr.on('data', (d) => { out += d; });
child.on('exit', (code, sig) => { exited = { code, sig, at: new Date().toISOString() }; });
(async () => {
  await sleep(9000);
  if (process.env.CLOSE_PIPES) {
    // like an app started from a shell that has since gone away: its stdout/stderr readers vanish
    child.stdout.destroy(); child.stderr.destroy();
    out += '[repro] closed the app\'s stdout/stderr readers\n';
  }
  let i = 0;
  for (; i < cycles && !exited; i++) {
    cfg.sources[0].enabled = false; if (process.env.CYCLE0_WHILE_OFF) cfg.layout.cycleSeconds = 0; write(cfg); await sleep(offMs);
    if (exited) break;
    cfg.sources[0].enabled = true; cfg.layout.cycleSeconds = 24; write(cfg); await sleep(onMs);
  }
  const died = !!exited;            // it exited by itself before we stopped it
  if (!exited) { child.kill('SIGTERM'); await sleep(1500); }
  const tail = out.replace(/auth=[^&\s"']+/g, 'auth=[REDACTED]').split('\n').filter((l) => /camreel|stc|FATAL|Check|rror|fatal|abort/i.test(l)).slice(-25).join('\n');
  console.log(died ? `DIED after ${i} cycle(s): ${JSON.stringify(exited)}` : `SURVIVED ${i} cycles`);
  console.log(tail);
  process.exit(died ? 1 : 0);
})();
