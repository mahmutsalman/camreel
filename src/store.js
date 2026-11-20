'use strict';
// Where the settings live and how they are written.
//  - userData/config.json (macOS: ~/Library/Application Support/CamReel/config.json)
//  - every save: write config.json.tmp, copy the current file to config.json.bak, rename
//    the .tmp over config.json (a crash mid-save never leaves a half file).
//  - first run: an older project-folder config.json is copied in (migration).
const fs = require('fs');
const path = require('path');

function writeAtomic(file, text) {
  const tmp = file + '.tmp';
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const fd = fs.openSync(tmp, 'w', 0o600);
  try { fs.writeSync(fd, text); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  if (fs.existsSync(file)) fs.copyFileSync(file, file + '.bak');
  fs.renameSync(tmp, file);
}

// Returns a note for the log (never the file's content).
function ensure(file, legacyFile, emptyConfig) {
  if (fs.existsSync(file)) return 'existing';
  if (legacyFile && fs.existsSync(legacyFile)) {
    writeAtomic(file, fs.readFileSync(legacyFile, 'utf8'));
    return 'migrated from the project folder';
  }
  writeAtomic(file, JSON.stringify(emptyConfig, null, 2));
  return 'created (empty)';
}

module.exports = { writeAtomic, ensure };
