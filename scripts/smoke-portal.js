'use strict';

/**
 * Local smoke checks for client portal modules (no SMTP / live HTTP required).
 * Usage: node scripts/smoke-portal.js
 */

require('dotenv').config();

async function main() {
  const portal = require('../server/clientPortal');
  const assert = (cond, msg) => {
    if (!cond) throw new Error(msg);
  };

  const pw = portal.generatePassword();
  assert(pw && pw.length >= 10, 'password length');
  assert(portal.normalizeEmail('  A@B.Com ') === 'a@b.com', 'normalize email');

  const matches = portal.findLeadMatches('nobody-should-match-xyz@example.invalid');
  assert(Array.isArray(matches), 'findLeadMatches returns array');

  // Route module loads
  require('../server/routes/portal');

  const mcp = require('../server/mcp');
  const clientNames = mcp.clientToolDefs().map((t) => t.name);
  assert(clientNames.includes('site.get'), 'client MCP site.get');
  assert(clientNames.includes('site.publish'), 'client MCP site.publish');
  assert(clientNames.includes('pages.structure.update'), 'client MCP pages.structure.update');
  assert(!clientNames.includes('form.submissions.list'), 'no client form MCP');
  assert(!clientNames.includes('form.ensureForSite'), 'no client form.ensureForSite');

  console.log('smoke-portal: ok', {
    passwordSampleLen: pw.length,
    matchCount: matches.length,
    clientToolCount: clientNames.length,
  });
}

main().catch((e) => {
  console.error('smoke-portal failed:', e);
  process.exit(1);
});
