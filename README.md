# CamReel

Your Twitch **Stream Together** guests' cameras as a strip of moving cards, for OBS or Meld Studio.
Guests whose camera is off disappear by themselves and come back when it is on again. Mac and Windows.

⭐ **If CamReel helps your stream, a star on this repo is appreciated. Thank you for the support!**

## Download

**https://kinesinships.com/meldframes/**: Mac (signed and notarized by Apple) and Windows, with a
picture guide. The downloaded app updates itself (it asks first; it never restarts on its own).

## Start here (3 steps)

1. **Twitch:** Stream Together → Settings → Browser Sources → **Copy** ONE link (any row).
2. **CamReel:** paste it next to the **+** (⌘V / Ctrl+V), then click **Add … guest seats**.
   Done for good: your links never change.
3. **OBS:** Sources → + → **Window Capture** (Mac: *macOS Screen Capture*, Method: Window Capture) →
   **CamReel — Strip**. **Meld:** Display capture layer → **CamReel — Strip**.
   Black box around the cards? CamReel → Background → **green**, then a **Chroma Key** filter.

🔴 **Your links work like a password.** Never send them to anyone, never show them or the Settings
window on stream. Collabing? Everyone runs CamReel on their own computer with their own link.

Settings has a **Simple** view (guests + background) and an **Advanced** view (motion, cards, names,
window size). Right-click the Dock icon → **Show Strip** if you lose the strip.

That's it. Everything is saved by itself.

### 🔴 Keep the strip window on screen
Meld captures what macOS actually **draws**. If the strip is minimized, hidden, or parked
by **Stage Manager** (the small windows at the left edge of the screen), your stream gets
only a small slanted thumbnail.
- CamReel notices: Settings shows a **yellow bar** ("Strip is parked…") with a
  **Bring strip back** button, and the CamReel icon in the menu bar turns **yellow**.
- Tick **Keep strip visible** in Settings: the strip stays on top of other windows, so
  Stage Manager does not park it. CamReel also remembers which screen you put it on.

### Mirror a camera
Each guest row in Settings has a **⇋** button: it flips that camera left ↔ right. Only the
camera picture is mirrored; text inside it (like Twitch's name tag) stays readable.
**Mirror all cameras** (Layout) is the default for every camera; a camera's own ⇋ choice wins.
If a guest's page has no real video in it, CamReel flips the whole picture instead (then any
text in it reads backwards) and writes that in its log.

**Hide Twitch's name tag** (Layout) hides the name Twitch draws inside the video; CamReel's
own name strip under the card stays. If Twitch changes its page and the tag can't be found,
that guest's row says so.

### Every day
- Open CamReel before you go live. Guests whose camera is off are simply not shown.
- **Settings**: CamReel menu → **Settings…** (⌘,), or click CamReel's Dock icon, or
  click the CamReel icon in the menu bar.
- Closing the Settings window does not stop the strip. Quit = CamReel menu → **Quit** (⌘Q).
- With the strip window in front: **R** reloads all guests, **D** shows a status box.

### In Settings
| | |
|---|---|
| **On** switch | off = that guest is not loaded at all (costs nothing) |
| **Name** | shown under the card |
| **Link** | hidden as •••• . 👁 shows it, **Copy** copies it |
| **Status** | ● live = on the strip · loading · no video (camera off: hidden) · off |
| ▲ ▼ | the order on the strip |
| ✕ | remove the guest |

**Animation:** the motion style:
| Style | What it does |
|---|---|
| Up and down | scrolls to the last guest and back (cycle seconds; 0 = still) |
| Endless loop | always the same way; a guest leaving the top comes back at the bottom. ⚠️ never rests: costs more CPU |
| Step and hold | holds, then moves one guest on (up or down) |
| Fade | one guest at a time, dissolving into the next |
| Deck of cards | the front guest flies off, the next comes up from behind |
| 3D drum | the guests on a turning wheel |
| Still | no motion, the cheapest |

**Move only when they don't all fit** (on by default): when every live guest fits in the window, the cards stand still,
centred, whatever style is chosen; the style moves only when more guests are live than fit.

"Seconds on each guest" and "Change takes" set the pace of step / fade / deck / drum; for the loop,
"Seconds per guest" is its speed.

**Settings layout (0.3.3):** Guests · Motion (style tiles) · Cards · Names · Window & Meld, with a live preview of the strip
on the right: point at any setting and the part of the strip it changes lights up, with one line saying what it does.

**Resize the strip** by dragging its edge: the cards follow live and the size is saved. **Lock size** (Window & Meld) turns
dragging off.

**Meld box** (Window & Meld): type the size Meld shows under the CamReel layer (e.g. 432 × 830) and click **Match**: the strip
window becomes exactly that size (Meld's numbers are canvas pixels: 1:1 is already sharp), so the cards fill Meld's box with no
black bars. Make the box taller in Meld → type the new size → Match: the strip gets taller and shows more guests.
A window capture can only be SCALED by Meld (it is a picture of the window), unlike a Browser source, which Meld lays out
at the box's size: that is why the size is typed here.

With **Move only when they don't all fit** on, the Endless loop / Step with too few guests to fill the reel (it would
leave an empty stretch after the last guest) moves up and down instead, and loops again once there are enough guests.

**Default look (0.3.1):** a 920×1080 transparent window, cards filling it edge to edge, no margin, no padding, no
shadow, no outline.
Updating from an older version: settings still on the old defaults move to these; values you chose stay.

**Layout:** side, card width (0 = fill the window), gap, side margin, top/bottom margin, card padding (a frame round each
picture) + frame colour, card shadow, card outline, corner radius, tilt, name strip (height, padding, text size, left / centre /
right), accent colour, background (green / transparent / your colour), window size (width + height,
or Strip 480×1080 / Wide 1920×1080), mute. Changes show on the strip at once.

### If CamReel ever crashes
It starts itself again within about 2 seconds, with the same guests and the strip in the
same place, and Settings says "CamReel restarted itself…". (If it crashes more than 3 times
in 2 minutes it stops trying.) Quitting it yourself (⌘Q) never restarts it.
Its log: `~/Library/Application Support/CamReel/logs/camreel.log`; crash dumps stay on your Mac.

### If something looks wrong
- **A card says "Your Browser Source seems misconfigured"**: that link is wrong or expired.
  Copy a fresh one from Stream Together and replace it.
- **A guest never appears**: their camera is off in Stream Together ("Include my camera"),
  or their link is old. The status column says "no video".
- **Sound**: guests' sound comes with the app. Tick **Mute guests** if you don't want it.

---

## For developers

`npm install && npm start` runs it from source. The settings live in
`~/Library/Application Support/CamReel/config.json`. An older `config.json` in this
folder is copied there on the first run. The file is written atomically (`.tmp` → rename),
the previous version is kept as `config.json.bak`, and a hand edit is applied live (a
broken edit keeps the last good settings).

How it works: each guest link is opened as its own page in an Electron `<webview>`, not
an iframe. Twitch's `X-Frame-Options: SAMEORIGIN` blocks iframes; it does not apply to a
top-level page. No header is changed. Once a second the strip asks each page whether it
has a playing `<video>` whose time moves. A card shows after 1 s live and hides after 4 s
without moving video. A hidden guest stays loaded (parked, invisible, tiny) so it can come back.

| Command | |
|---|---|
| `npm run standin` | local stand-in guest pages: same `X-Frame-Options` as Twitch, a real `<video>`, `/control?n=2&state=stop\|remove\|blank\|alive` |
| `npm run test:dead` | auto-hide + live config, end to end (`STC_SABOTAGE=always-alive` must fail) |
| `npm run test:settings` | the Settings window with real input events + a restart (`STC_SABOTAGE=no-persist` / `paste-noop` must fail) |
| `npm run test:redact` | the link-secret redaction |
| `node scripts/scenario-mirror.js` | ⇋ mirror per camera + Mirror all, pixels + restart (`STC_SABOTAGE=mirror-ignored` must fail) |
| `node scripts/scenario-fill.js` | every guest's picture fills its card (`STC_SABOTAGE=webview-block` must fail) |
| `node scripts/scenario-watch.js` | strip parked/minimized/hidden → yellow bar + tray + Bring back (`STC_SABOTAGE=no-watch` must fail) |
| `node scripts/scenario-crash.js` | crash relaunch, clean quit stays quit (`STC_SABOTAGE=no-watchdog` must fail) |
| `node scripts/scenario-covered.js` | a covered strip keeps drawing |
| `node scripts/repro-toggle.js . 20` | a source OFF/ON through the settings file, 20 times |
| `scripts/cpu-table.sh` | CPU at several guest counts (`KILL=2,3`, `CYCLE=0`, `STC_PERF_OFF=idle,park`, `STC_SCALE=2` for A/B) |
| `APPLE_KEYCHAIN_PROFILE=<your notary profile> npm run dist:mac` | signed, notarized universal dmg + zip in `dist/` |
| `npm run dist:win` | unsigned Windows installer (NSIS, per user) |
| `node scripts/test-seats.js` · `test-updater.js` | seat links from one link · the update rules (never restarts by itself) |
| `node scripts/scenario-seats.js` | one-paste seats + Simple/Advanced in the real Settings window |

Builds you make yourself are unsigned and have no update feed (the updater is simply off). To sign on a Mac,
add your own `"identity"` under `build.mac` in `package.json` and set `notarize` back to `true`.

## License

MIT. See [LICENSE](LICENSE). ⭐ Stars are appreciated!

**CPU**, measured on a MacBook Pro with stand-in guests (30 fps video each), the 480×1080
strip, 100 % = one core: 4 live guests ≈ 59 % average; 2 of 4 dead ≈ 45 %; 8 guests ≈ 88 %;
12 ≈ 117 % (the 8/12 numbers are from the older 1920×1080 window). Most of it is the GPU
process drawing the guests' video; the app's own work is a few percent.
