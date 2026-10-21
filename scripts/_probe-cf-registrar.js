'use strict';

const fs = require('fs');
const path = require('path');
const https = require('https');

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
      { host: 'api.cloudflare.com', path: apiPath, method, timeout: 30000, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* */ }
          resolve({ statusCode: res.statusCode, json, text: text.slice(0, 800) });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

async function main() {
  const cf = require('/app/src/cloudflare');
  const root = process.env.WORKSPACE_DATA_DIR || '/app/data/workspaces';
  const dirs = fs.readdirSync(root);
  let dbPath = null;
  for (const d of dirs) {
    const candidates = [
      path.join(root, d, 'websitescout.db'),
      path.join(root, d, 'workspace.sqlite'),
      path.join(root, d, 'db.sqlite'),
      path.join(root, d, 'data.sqlite'),
    ];
    for (const c of candidates) {
      if (fs.existsSync(c)) { dbPath = c; break; }
    }
    if (dbPath) break;
    const flat = path.join(root, d);
    if ((d.endsWith('.sqlite') || d.endsWith('.db')) && fs.existsSync(flat)) { dbPath = flat; break; }
  }
  console.log('dbPath', dbPath, 'dirs', dirs.slice(0, 8));
  if (!dbPath) {
    // try platform settings via domain withDb first workspace
    console.log('no sqlite found under', root);
    process.exit(1);
  }
  const Database = require('better-sqlite3');
  const db = new Database(dbPath, { readonly: true });
  const creds = await cf.resolveCfCredentials(db);
  console.log('via', creds.via, 'account', (creds.accountId || '').slice(0, 8) + '…', 'tokenLen', (creds.token || '').length);

  const accountId = creds.accountId;
  const token = creds.token;
  const pages = await apiRequest({
    method: 'GET',
    apiPath: `/client/v4/accounts/${accountId}/pages/projects?page=1&per_page=1`,
    token,
  });
  console.log('pages', pages.statusCode, JSON.stringify(pages.json && pages.json.errors || pages.json && pages.json.success));

  const search = await apiRequest({
    method: 'GET',
    apiPath: `/client/v4/accounts/${accountId}/registrar/domain-search?q=stickmanautomation.com`,
    token,
  });
  console.log('search', search.statusCode, search.text);

  const check = await apiRequest({
    method: 'POST',
    apiPath: `/client/v4/accounts/${accountId}/registrar/domain-check`,
    token,
    body: { domains: ['stickmanautomation.com'] },
  });
  console.log('check', check.statusCode, check.text);
}

main().catch((e) => { console.error(e); process.exit(1); });
