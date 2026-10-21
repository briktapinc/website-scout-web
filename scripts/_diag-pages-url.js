'use strict';

/**
 * Diagnose a Cloudflare Pages preview URL + list recent deployments.
 * Usage: node scripts/_diag-pages-url.js [url]
 */

const Database = require('better-sqlite3');
const https = require('https');
const http = require('http');
const { URL } = require('url');

const TARGET = process.argv[2] || 'https://c044edda.site-1-1ol.pages.dev/';

function getSetting(db, key) {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row ? row.value : '';
}

function api(token, apiPath, method = 'GET', body = null) {
  return new Promise((resolve, reject) => {
    const payload = body ? Buffer.from(JSON.stringify(body)) : null;
    const req = https.request({
      host: 'api.cloudflare.com',
      path: apiPath,
      method,
      headers: {
        Authorization: 'Bearer ' + token,
        Accept: 'application/json',
        ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': payload.length } : {}),
      },
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        let json = null;
        try { json = JSON.parse(text); } catch { /* ignore */ }
        resolve({ status: res.statusCode, json, text: text.slice(0, 2000) });
      });
    });
    req.on('error', reject);
    if (payload) req.write(payload);
    req.end();
  });
}

function fetchUrl(url) {
  return new Promise((resolve) => {
    const u = new URL(url);
    const lib = u.protocol === 'http:' ? http : https;
    const req = lib.request({
      hostname: u.hostname,
      path: u.pathname + u.search,
      method: 'GET',
      headers: { Accept: 'text/html,*/*', 'User-Agent': 'website-scout-diag/1.0' },
      timeout: 15000,
      servername: u.hostname,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const body = Buffer.concat(chunks);
        resolve({
          ok: true,
          status: res.statusCode,
          headers: res.headers,
          len: body.length,
          bodyStart: body.toString('utf8', 0, 500),
        });
      });
    });
    req.on('timeout', () => { req.destroy(new Error('timeout')); });
    req.on('error', (e) => resolve({ ok: false, error: e.message, code: e.code }));
    req.end();
  });
}

async function main() {
  console.log('TARGET', TARGET);
  const httpRes = await fetchUrl(TARGET);
  console.log('HTTP', JSON.stringify(httpRes, null, 2));

  // Also try apex project host
  try {
    const u = new URL(TARGET);
    const parts = u.hostname.split('.');
    // c044edda.site-1-1ol.pages.dev -> site-1-1ol.pages.dev
    if (parts.length >= 4 && parts.slice(-2).join('.') === 'pages.dev') {
      const apex = `https://${parts.slice(1).join('.')}/`;
      console.log('APEX', apex);
      console.log('APEX_HTTP', JSON.stringify(await fetchUrl(apex), null, 2));
    }
  } catch { /* ignore */ }

  const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });
  const token = getSetting(db, 'cf.api_token');
  const accountId = getSetting(db, 'cf.account_id');
  const projectSetting = getSetting(db, 'cf.project');
  const site = db.prepare('SELECT id, preview_url, preview_path FROM websites WHERE id = 1').get();
  console.log('settings project=', JSON.stringify(projectSetting));
  console.log('site row=', site);
  console.log('token_len=', token ? token.length : 0, 'accountId=', accountId);

  const projects = await api(token, `/client/v4/accounts/${accountId}/pages/projects?per_page=50`);
  console.log('projects_list status=', projects.status, 'success=', projects.json && projects.json.success);
  const list = ((projects.json && projects.json.result) || []).map((p) => ({
    name: p.name,
    subdomain: p.subdomain,
    domains: p.domains,
    created_on: p.created_on,
    production_branch: p.production_branch,
    canonical_url: p.canonical_deployment && p.canonical_deployment.url,
  }));
  console.log('projects=', JSON.stringify(list, null, 2));

  for (const name of ['site-1', 'site-1-1ol', projectSetting].filter(Boolean)) {
    const info = await api(token, `/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}`);
    console.log('project', name, 'status=', info.status, 'success=', info.json && info.json.success);
    if (info.json && info.json.result) {
      const p = info.json.result;
      console.log(JSON.stringify({
        name: p.name,
        subdomain: p.subdomain,
        domains: p.domains,
        latest_deployment: p.canonical_deployment && {
          id: p.canonical_deployment.id,
          url: p.canonical_deployment.url,
          stage: p.canonical_deployment.latest_stage,
        },
      }, null, 2));
    } else {
      console.log(info.text.slice(0, 400));
    }

    const deps = await api(token, `/client/v4/accounts/${accountId}/pages/projects/${encodeURIComponent(name)}/deployments?per_page=5`);
    if (!(deps.json && deps.json.success)) {
      console.log('deps', name, deps.status, deps.text.slice(0, 300));
      continue;
    }
    for (const d of deps.json.result || []) {
      console.log('DEP', JSON.stringify({
        id: d.id,
        short: String(d.id || '').slice(0, 8),
        url: d.url,
        environment: d.environment,
        aliases: d.aliases,
        latest_stage: d.latest_stage,
        stages: (d.stages || []).map((s) => s.name + ':' + s.status),
        file_count: d.files ? Object.keys(d.files).length : null,
        files: d.files ? Object.keys(d.files) : null,
      }));
    }
  }

  // Specific deployment if hash in URL
  const m = TARGET.match(/https?:\/\/([a-f0-9]+)\.([^.]+)\.pages\.dev/i);
  if (m) {
    const hash = m[1];
    const sub = m[2];
    console.log('parsed hash=', hash, 'subdomain=', sub);
    // Find matching deployment id prefix across site-1
    const deps = await api(token, `/client/v4/accounts/${accountId}/pages/projects/site-1/deployments?per_page=20`);
    const match = ((deps.json && deps.json.result) || []).find((d) => String(d.id).startsWith(hash) || (d.url && d.url.includes(hash)));
    if (match) {
      const full = await api(token, `/client/v4/accounts/${accountId}/pages/projects/site-1/deployments/${match.id}`);
      const d = full.json && full.json.result;
      console.log('MATCHED_DEPLOYMENT', JSON.stringify({
        id: d && d.id,
        url: d && d.url,
        aliases: d && d.aliases,
        latest_stage: d && d.latest_stage,
        stages: d && (d.stages || []).map((s) => ({ name: s.name, status: s.status, started: s.started_on, ended: s.ended_on })),
        files: d && d.files,
        is_skipped: d && d.is_skipped,
        build_config: d && d.build_config,
      }, null, 2));
    } else {
      console.log('No deployment matched hash', hash);
    }
  }

  db.close();
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
