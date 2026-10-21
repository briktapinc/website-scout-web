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
        resolve({ status: res.statusCode, json, text: text.slice(0, 500) });
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
  const site = db.prepare('SELECT preview_url FROM websites WHERE id = 1').get();
  console.log('stored preview_url=', site.preview_url);

  const projects = await api(token, `/client/v4/accounts/${accountId}/pages/projects?per_page=20`);
  const list = (((projects.json || {}).result) || []).map((p) => ({
    name: p.name,
    subdomain: p.subdomain,
    url: p.canonical_deployment && p.canonical_deployment.url,
  }));
  console.log('projects=', JSON.stringify(list, null, 2));

  for (const name of ['site-1', 'site-1-1ol']) {
    const deps = await api(token, `/client/v4/accounts/${accountId}/pages/projects/${name}/deployments?per_page=3`);
    if (!deps.json || !deps.json.success) {
      console.log('deployments', name, 'status=', deps.status, deps.text);
      continue;
    }
    for (const d of deps.json.result || []) {
      console.log('dep', name, d.id, 'url=', d.url, 'aliases=', d.aliases, 'stage=', d.latest_stage && d.latest_stage.name, d.latest_stage && d.latest_stage.status);
    }
  }
  db.close();
}

main().catch((e) => { console.error(e); process.exit(1); });
