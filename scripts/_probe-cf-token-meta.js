'use strict';

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
      { host: 'api.cloudflare.com', path: apiPath, method, timeout: 30000, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* */ }
          resolve({ statusCode: res.statusCode, json, text: text.slice(0, 600) });
        });
      }
    );
    req.on('error', reject);
    if (bodyBuf) req.write(bodyBuf);
    req.end();
  });
}

function fingerprint(token) {
  const t = String(token || '');
  return { len: t.length, prefix: t.slice(0, 6), suffix: t.slice(-4) };
}

async function probe(label, token, accountId) {
  console.log('---', label, fingerprint(token), 'account', String(accountId || '').slice(0, 8));
  if (!token || !accountId) {
    console.log('missing creds');
    return;
  }
  const verify = await apiRequest({ method: 'GET', apiPath: '/client/v4/user/tokens/verify', token });
  console.log('verify', verify.statusCode, JSON.stringify((verify.json && verify.json.result) || (verify.json && verify.json.errors)));
  const pages = await apiRequest({
    method: 'GET',
    apiPath: `/client/v4/accounts/${accountId}/pages/projects?page=1&per_page=1`,
    token,
  });
  console.log('pages', pages.statusCode, pages.json && pages.json.success);
  const search = await apiRequest({
    method: 'GET',
    apiPath: `/client/v4/accounts/${accountId}/registrar/domain-search?q=test`,
    token,
  });
  console.log('registrar_search', search.statusCode, search.text.slice(0, 220));
}

async function main() {
  const root = '/app/data/workspaces';
  for (const id of ['1', '2']) {
    const dbPath = path.join(root, id, 'websitescout.db');
    if (!fs.existsSync(dbPath)) continue;
    const db = new Database(dbPath, { readonly: true });
    const token = ((db.prepare("SELECT value FROM settings WHERE key='cf.api_token'").get() || {}).value || '').trim();
    const accountId = ((db.prepare("SELECT value FROM settings WHERE key='cf.account_id'").get() || {}).value || '').trim().toLowerCase();
    await probe(`workspace ${id}`, token, accountId);
    db.close();
  }

  // platform defaults file (no secrets usually) + MySQL platform if available via env
  try {
    const platform = require('/app/server/platform');
    const pToken = String(await platform.getPlatformSetting('cf.api_token', '') || '').trim();
    const pAccount = String(await platform.getPlatformSetting('cf.account_id', '') || '').trim().toLowerCase();
    await probe('platform', pToken, pAccount);
  } catch (e) {
    console.log('platform probe skipped', e.message);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
