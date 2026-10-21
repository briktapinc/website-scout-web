'use strict';

/**
 * Copy platform cf.api_token (+ account_id if missing) into workspace 1 settings
 * when the platform token can call Registrar and the workspace token cannot.
 */
const fs = require('fs');
const path = require('path');
const https = require('https');
const Database = require('better-sqlite3');

function apiRequest({ method, apiPath, token }) {
  return new Promise((resolve, reject) => {
    const headers = { Accept: 'application/json' };
    if (token) headers.Authorization = `Bearer ${token}`;
    const req = https.request(
      { host: 'api.cloudflare.com', path: apiPath, method, timeout: 30000, headers },
      (res) => {
        const chunks = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let json = null;
          try { json = JSON.parse(text); } catch { /* */ }
          resolve({ statusCode: res.statusCode, json, text: text.slice(0, 400) });
        });
      }
    );
    req.on('error', reject);
    req.end();
  });
}

async function registrarOk(token, accountId) {
  const r = await apiRequest({
    method: 'GET',
    apiPath: `/client/v4/accounts/${accountId}/registrar/domain-search?q=stickmanautomation.com`,
    token,
  });
  return { ok: r.statusCode === 200 && !!(r.json && (r.json.success !== false || r.json.result)), status: r.statusCode, text: r.text };
}

async function main() {
  const platform = require('/app/server/platform');
  const pToken = String(await platform.getPlatformSetting('cf.api_token', '') || '').trim();
  const pAccount = String(await platform.getPlatformSetting('cf.account_id', '') || '').trim().toLowerCase();
  if (!pToken || !pAccount) {
    console.log('No platform CF credentials');
    process.exit(1);
  }

  const dbPath = '/app/data/workspaces/1/websitescout.db';
  const db = new Database(dbPath);
  const wToken = ((db.prepare("SELECT value FROM settings WHERE key='cf.api_token'").get() || {}).value || '').trim();
  const wAccount = ((db.prepare("SELECT value FROM settings WHERE key='cf.account_id'").get() || {}).value || '').trim().toLowerCase() || pAccount;

  const before = await registrarOk(wToken, wAccount);
  console.log('workspace_before', before.status, before.ok);
  const plat = await registrarOk(pToken, pAccount);
  console.log('platform', plat.status, plat.ok, plat.text.slice(0, 180));

  if (!plat.ok) {
    console.log('Platform token also cannot use Registrar — paste a new token in Admin → API keys / Settings.');
    process.exit(2);
  }
  if (before.ok) {
    console.log('Workspace token already works — nothing to sync.');
    process.exit(0);
  }

  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf.api_token', ?)").run(pToken);
  db.prepare("INSERT OR REPLACE INTO settings (key, value) VALUES ('cf.account_id', ?)").run(pAccount);
  const after = await registrarOk(pToken, pAccount);
  console.log('workspace_after_sync', after.status, after.ok);
  if (after.ok) {
    console.log('RESULT=SYNCED — workspace now uses platform Pages+Registrar token');
  } else {
    console.log('RESULT=FAIL');
    process.exit(3);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
