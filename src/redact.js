'use strict';
// The Stream Together URL carries a secret: ?auth=<token>. Nothing this app prints
// (console, logs, error text, the debug overlay) may contain it. Every string that
// could hold a URL goes through redact() first.

const SECRET_PARAMS = ['auth', 'token', 'access_token', 'key', 'secret', 'sig', 'signature'];
const RE = new RegExp('([?&#;](?:' + SECRET_PARAMS.join('|') + ')=)[^&#\\s"\'<>\\\\]*', 'gi'); // stops at a backslash too: JSON-escaped text stays valid JSON

function redact(value) {
  if (value === null || value === undefined) return value;
  const s = typeof value === 'string' ? value : (value instanceof Error ? (value.stack || value.message) : String(value));
  return s.replace(RE, '$1[REDACTED]');
}

module.exports = { redact };
