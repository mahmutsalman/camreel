'use strict';
// Is the STRIP actually drawn at full size? (What Meld/OBS capture is what the window
// server draws: a Stage-Manager-parked strip is captured as a small slanted thumbnail.)
//
// Measured on macOS 26 with Stage Manager on (proof/vis-result.json):
//   - minimize() and Stage Manager parking BOTH leave isMinimized() = false, isVisible() =
//     true and document.visibilityState = "visible". Electron cannot see them.
//   - the window server's bounds do: the 480x1080 strip becomes a 48x161 thumbnail.
// So on a Mac a tiny helper (camreel-winwatch) reports the strip's real on-screen
// geometry; Electron's own signals cover hide/minimize where they work (and Windows).
//
// States: "ok" | "parked" (drawn much smaller than its real size) | "minimized" |
//         "hidden" (not on screen) | "unknown" (no helper: the UI shows a permanent hint)
const { spawn } = require('child_process');
const path = require('path');
const fs = require('fs');

function helperPath() {
  const p = path.join(__dirname, 'assets', 'bin', 'camreel-winwatch').replace('app.asar' + path.sep, 'app.asar.unpacked' + path.sep);
  return process.platform === 'darwin' && fs.existsSync(p) ? p : null;
}

// Pure: decide from the signals. Exported for tests.
function decide({ isVisible, isMinimized, geo, expected }) {
  if (isMinimized) return 'minimized';
  if (!isVisible) return 'hidden';
  if (!geo) return 'unknown';          // no helper: we cannot tell parked from ok
  if (geo === 'pending') return 'ok';   // helper started, first reading not in yet
  if (!geo.found || !geo.onscreen) return 'hidden';
  if (geo.w < expected.w * 0.8 || geo.h < expected.h * 0.8) return 'parked';
  return 'ok';
}

class StripWatch {
  constructor({ log, onChange, disabled }) {
    this.log = log;
    this.onChange = onChange;
    this.disabled = !!disabled; // tests only: detection off (must make the test go red)
    this.state = 'ok';
    this.geo = null;
    this.win = null;
    this.child = null;
    this.timer = null;
  }

  attach(win) {
    this.detach();
    this.win = win;
    const hp = helperPath();
    if (hp && !this.disabled) {
      const id = String(win.getMediaSourceId()).split(':')[1];
      this.child = spawn(hp, [id, '0.5'], { stdio: ['ignore', 'pipe', 'ignore'] });
      this.helperUsed = true;
      let buf = '';
      this.child.stdout.on('data', (d) => {
        buf += d;
        let i;
        while ((i = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, i); buf = buf.slice(i + 1);
          try { this.geo = JSON.parse(line); } catch {}
          this.evaluate();
        }
      });
      this.child.on('exit', () => { this.child = null; });
    }
    for (const ev of ['minimize', 'restore', 'hide', 'show', 'resize']) win.on(ev, () => this.evaluate());
    this.timer = setInterval(() => this.evaluate(), 1000);
    this.evaluate();
  }

  detach() {
    if (this.child) { this.child.kill(); this.child = null; }
    if (this.timer) { clearInterval(this.timer); this.timer = null; }
    this.win = null;
    this.geo = null;
    this.helperUsed = false;
  }

  evaluate() {
    const win = this.win;
    if (!win || win.isDestroyed()) return;
    const [w, h] = win.getSize();
    const geo = this.helperUsed ? (this.geo || 'pending') : null;
    const next = this.disabled ? 'ok' : decide({ isVisible: win.isVisible(), isMinimized: win.isMinimized(), geo, expected: { w, h } });
    if (next !== this.state) {
      const was = this.state;
      this.state = next;
      const g = this.geo && this.geo.found ? ` (drawn ${this.geo.w}x${this.geo.h} at ${this.geo.x},${this.geo.y}; real ${w}x${h})` : '';
      this.log(`strip window: ${was} -> ${next}${g}`);
      this.onChange(next);
    }
  }
}

module.exports = { StripWatch, decide, helperPath };
