'use strict';

const Database = require('better-sqlite3');
const https = require('https');

const dbPath = process.argv[2] || '/app/data/workspaces/1/websitescout.db';
const db = new Database(dbPath, { readonly: true });
const token = db.prepare("SELECT value FROM settings WHERE key='cf.api_token'").get().value;
const accountId = db.prepare("SELECT value FROM settings WHERE key='cf.account_id'").get().value;

function req(path) {
  return new Promise((resolve, reject) => {
    const r = https.request(
      {
        host: 'api.cloudflare.com',
        path,
        method: 'GET',
        headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
      },
      (res) => {
        let d = '';
        res.on('data', (c) => { d += c; });
        res.on('end', () => resolve({ status: res.statusCode, body: d.slice(0, 400) }));
      }
    );
    r.on('error', reject);
    r.end();
  });
}

(async () => {
  const qs = ['', '?page=1', '?per_page=20', '?page=1&per_page=20', '?per_page=10', '?per_page=25', '?per_page=50'];
  for (const q of qs) {
    const r = await req(`/client/v4/accounts/${accountId}/pages/projects${q}`);
    console.log(JSON.stringify({ q: q || '(none)', status: r.status, body: r.body }));
  }
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
