'use strict';

const Database = require('better-sqlite3');
const https = require('https');

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function api(token, apiPath) {
  return new Promise((resolve, reject) => {
    const req = https.request({
      host: 'api.cloudflare.com',
      path: apiPath,
      method: 'GET',
      headers: { Authorization: 'Bearer ' + token, Accept: 'application/json' },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json });
      });
    });
    req.on('error', reject);
    req.end();
  });
}

async function main() {
  const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });
  const token = getSetting(db, 'cf.api_token');
  const accountId = getSetting(db, 'cf.account_id');
  const project = 'site-1';
  const id = 'd64cf698-6590-4f4b-91e3-fe812e7408b6';
  const got = await api(token, `/client/v4/accounts/${accountId}/pages/projects/${project}/deployments/${id}`);
  const d = got.json && got.json.result;
  if (!d) {
    console.log('no deployment', got.status, JSON.stringify(got.json).slice(0, 500));
    process.exit(1);
  }
  console.log(JSON.stringify({
    id: d.id,
    url: d.url,
    aliases: d.aliases,
    environment: d.environment,
    is_skipped: d.is_skipped,
    latest_stage: d.latest_stage,
    stages: (d.stages || []).map((s) => ({ name: s.name, status: s.status, started: s.started_on, ended: s.ended_on })),
    files: d.files,
    build_config: d.build_config,
    deployment_trigger: d.deployment_trigger,
    source: d.source,
  }, null, 2));
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
