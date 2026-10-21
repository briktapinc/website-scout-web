'use strict';

/**
 * Attempt to create a Cloudflare API token with Pages + Registrar permissions
 * using the workspace's existing token, then save it if successful.
 *
 * Requires the existing token to have API Tokens Write (or Account API Tokens Edit).
 * Most Pages-only tokens cannot do this — in that case prints a clear next step.
 */

const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');

function apiRequest({ method, apiPath, token, body }) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const bodyBuf = body != null ? Buffer.from(JSON.stringify(body)) : null;
    if (bodyBuf) {
      headers['Content-Type'] = 'application/json';
      headers['Content-Length'] = bodyBuf.length;
    }
    const req = https.request(
      { host: 'api.cloudflare.com', path: apiPath, method, timeout: 45000, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* */ }
          resolve({ statusCode: res.statusCode, json, text: text.slice(0, 2000) });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function findDb() {
  const root = process.env.WORKSPACE_DATA_DIR || '/app/data/workspaces';
  const prefer = process.env.WORKSPACE_ID || '1';
  const preferred = path.join(root, prefer, 'websitescout.db');
  if (fs.existsSync(preferred)) return preferred;
  for (const d of fs.readdirSync(root)) {
    const p = path.join(root, d, 'websitescout.db');
    if (fs.existsSync(p)) return p;
  }
  return null;
}

function pickGroups(groups) {
  const byName = (re) => groups.filter((g) => re.test(String(g.name || '')));
  const registrar = byName(/registrar/i);
  const pages = byName(/cloudflare pages|pages/i);
  const writeish = (list) => list.find((g) => /edit|write/i.test(g.name)) || list[0];
  return {
    registrarWrite: writeish(registrar),
    pagesWrite: writeish(pages),
    registrarAll: registrar.map((g) => g.name),
    pagesAll: pages.map((g) => g.name),
  };
}

async function main() {
  const dbPath = findDb();
  if (!dbPath) throw new Error('No websitescout.db found');
  const db = new Database(dbPath);
  const token = ((db.prepare("SELECT value FROM settings WHERE key='cf.api_token'").get() || {}).value || '').trim();
  const accountId = ((db.prepare("SELECT value FROM settings WHERE key='cf.account_id'").get() || {}).value || '').trim().toLowerCase();
  console.log('db', dbPath);
  console.log('account', accountId, 'tokenLen', token.length);

  const verify = await apiRequest({ method: 'GET', apiPath: '/client/v4/user/tokens/verify', token });
  console.log('verify', verify.statusCode, JSON.stringify((verify.json && verify.json.result) || (verify.json && verify.json.errors)));

  // Prefer account permission groups (for account-owned tokens)
  let groupsResp = await apiRequest({
    method: 'GET',
    apiPath: `/client/v4/accounts/${accountId}/tokens/permission_groups?per_page=500`,
    token,
  });
  if (groupsResp.statusCode !== 200) {
    groupsResp = await apiRequest({
      method: 'GET',
      apiPath: '/client/v4/user/tokens/permission_groups',
      token,
    });
  }
  console.log('permission_groups', groupsResp.statusCode);
  const groups = (groupsResp.json && groupsResp.json.result) || [];
  const picked = pickGroups(groups);
  console.log('registrar groups', picked.registrarAll);
  console.log('pages groups', picked.pagesAll);
  console.log('picked', {
    registrar: picked.registrarWrite && { id: picked.registrarWrite.id, name: picked.registrarWrite.name },
    pages: picked.pagesWrite && { id: picked.pagesWrite.id, name: picked.pagesWrite.name },
  });

  if (!picked.registrarWrite || !picked.pagesWrite) {
    console.log('RESULT=MISSING_GROUP_IDS');
    console.log('Cannot resolve Registrar/Pages permission group IDs with this token.');
    process.exit(2);
  }

  const policy = {
    effect: 'allow',
    resources: { [`com.cloudflare.api.account.${accountId}`]: '*' },
    permission_groups: [
      { id: picked.pagesWrite.id },
      { id: picked.registrarWrite.id },
    ],
  };

  // Try account-owned token create first, then user token create
  let created = await apiRequest({
    method: 'POST',
    apiPath: `/client/v4/accounts/${accountId}/tokens`,
    token,
    body: {
      name: `bitpype-pages-registrar-${new Date().toISOString().slice(0, 10)}`,
      policies: [policy],
    },
  });
  console.log('account_token_create', created.statusCode, created.text.slice(0, 800));

  if (created.statusCode !== 200) {
    created = await apiRequest({
      method: 'POST',
      apiPath: '/client/v4/user/tokens',
      token,
      body: {
        name: `bitpype-pages-registrar-${new Date().toISOString().slice(0, 10)}`,
        policies: [policy],
      },
    });
    console.log('user_token_create', created.statusCode, created.text.slice(0, 800));
  }

  const newToken = created.json && created.json.result && created.json.result.value;
  if (!newToken) {
    console.log('RESULT=CANNOT_CREATE_TOKEN');
    console.log('Existing token cannot mint a Registrar-capable token. Create one in the Cloudflare dashboard and paste it into Settings → Cloudflare.');
    process.exit(3);
  }

  // Verify registrar works
  const search = await apiRequest({
    method: 'GET',
    apiPath: `/client/v4/accounts/${accountId}/registrar/domain-search?q=example`,
    token: newToken,
  });
  console.log('new_token_search', search.statusCode, (search.text || '').slice(0, 300));
  if (search.statusCode !== 200) {
    console.log('RESULT=NEW_TOKEN_NO_REGISTRAR');
    process.exit(4);
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf.api_token', ?)").run(newToken);
  console.log('RESULT=SAVED');
  console.log('Saved new Pages+Registrar token to workspace settings (value not printed).');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
