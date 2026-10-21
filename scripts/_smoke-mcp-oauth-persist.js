'use strict';

/**
 * Offline smoke: MCP OAuth DCR + auth codes persist via SQLite (survives "restart").
 * Usage: node scripts/_smoke-mcp-oauth-persist.js
 */

const fs = require('fs');
const os = require('os');
const path = require('path');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-oauth-'));
const dbPath = path.join(dir, 'oauth.sqlite');
process.env.DB_DRIVER = 'sqlite';
process.env.SQLITE_PATH = dbPath;

const oauth = require('../server/mcpOAuth');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

(async () => {
  await oauth.ensureOAuthTables();
  const reg = await oauth.registerClient({
    client_name: 'persist-smoke',
    redirect_uris: ['http://127.0.0.1/callback'],
  });
  assert(reg.client_id && reg.client_id.startsWith('dcr_'), 'registerClient returns dcr_ id');

  // Simulate process restart: clear module cache + reload against same SQLite file.
  delete require.cache[require.resolve('../server/mcpOAuth')];
  delete require.cache[require.resolve('../server/db')];
  const oauth2 = require('../server/mcpOAuth');
  const loaded = await oauth2.getClient(reg.client_id);
  assert(loaded && loaded.client_id === reg.client_id, 'DCR client survives reload');

  const code = await oauth2.createAuthorizationCode(
    {
      client_id: reg.client_id,
      redirect_uri: 'http://127.0.0.1/callback',
      state: 's',
      code_challenge: 'TFeFrm8bHVXuFr1FkhPxZnIxFwIMCtrr801hXy3uzmU',
      code_challenge_method: 'S256',
      scope: 'mcp',
      resource: oauth2.mcpResourceUrl(),
    },
    { id: 1, workspace_id: 1, lead_id: 1, email: 'smoke@example.com' }
  );
  assert(typeof code === 'string' && code.length > 20, 'auth code minted');

  delete require.cache[require.resolve('../server/mcpOAuth')];
  delete require.cache[require.resolve('../server/db')];
  const oauth3 = require('../server/mcpOAuth');
  // Code should still be consumable after "restart" (exchange will fail PKCE/mint without portal,
  // but take path is covered by getClient + table presence).
  const { query } = require('../server/db');
  const rows = await query(
    'SELECT code FROM mcp_oauth_auth_codes WHERE code = :code LIMIT 1',
    { code }
  );
  assert(rows && rows[0] && rows[0].code === code, 'auth code row persisted');

  console.log('OK mcp-oauth persist (DCR + auth code in SQLite)');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
