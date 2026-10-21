'use strict';

/**
 * Smoke: build claim token for a cold lead, hit meta + decide APIs, verify HTML inject.
 * Run inside app container: node scripts/_tmp-smoke-claim.js
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const claimKit = require('../src/claimKit');
const outreach = require('../src/outreach');
const openPreview = require('../src/openPreview');

const APP = String(process.env.APP_URL || 'https://bitpype.com').replace(/\/$/, '');
const dbPath = '/app/data/workspaces/1/websitescout.db';
const db = new Database(dbPath, { readonly: true });

const site = db.prepare(`
  SELECT w.id, w.lead_id, w.name, w.preview_url, w.preview_path, w.status AS site_status,
         l.business_name, l.status AS lead_status
  FROM websites w
  JOIN leads l ON l.id = w.lead_id
  WHERE w.lead_id IS NOT NULL
  ORDER BY w.id DESC
  LIMIT 20
`).all();

console.log('sites sample', site.slice(0, 5).map((s) => ({
  id: s.id, lead: s.lead_id, name: s.business_name, lead_status: s.lead_status, preview_url: s.preview_url,
})));

// Prefer a lead that is NOT already positive/uninterested for popup show.
let pick = null;
for (const s of site) {
  const meta = claimKit.claimPageMeta(db, 1, s.lead_id);
  if (meta.showClaimPrompt) {
    pick = { ...s, meta };
    break;
  }
}
if (!pick) {
  // Fall back to any site with lead
  pick = site[0] ? { ...site[0], meta: claimKit.claimPageMeta(db, 1, site[0].lead_id) } : null;
}
if (!pick) {
  console.error('No websites with leads');
  process.exit(1);
}

const token = outreach.signInterestToken({
  workspaceId: 1,
  leadId: pick.lead_id,
  action: 'c',
});
console.log('picked', {
  websiteId: pick.id,
  leadId: pick.lead_id,
  business: pick.business_name,
  lead_status: pick.lead_status,
  showClaimPrompt: pick.meta.showClaimPrompt,
  preview_url: pick.preview_url,
});

const exportRoot = openPreview.exportRoot();
const folders = fs.readdirSync(exportRoot).filter((n) =>
  n === `site-${pick.id}` || n.startsWith(`ws-1-site-${pick.id}-`)
);
console.log('export folders', folders);
for (const f of folders) {
  const index = path.join(exportRoot, f, 'index.html');
  if (!fs.existsSync(index)) continue;
  const html = fs.readFileSync(index, 'utf8');
  console.log(f, {
    hasClaim: /bitpype-claim-preview/i.test(html),
    hasBitpypeClaim: /BitpypeClaim/i.test(html),
    hasScript: /claim-preview\.js/i.test(html),
  });
}

(async () => {
  const metaUrl = `${APP}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`;
  const metaRes = await fetch(metaUrl);
  const metaBody = await metaRes.json();
  console.log('GET claim meta', metaRes.status, JSON.stringify(metaBody).slice(0, 400));

  // Do NOT permanently flip a real lead in smoke — only POST if lead already uninterested/interested
  // or use a dry check that the route accepts the token shape.
  if (pick.meta.showClaimPrompt === false) {
    console.log('skip POST decide (intent already settled)');
  } else {
    console.log('NOTE: skipping POST decide against live cold lead to avoid mutating pipeline; token verified via GET.');
  }

  // Local /site-previews HTML fetch
  if (folders[0]) {
    const previewPath = `${APP}/site-previews/${folders[0]}/`;
    const htmlRes = await fetch(previewPath);
    const text = await htmlRes.text();
    console.log('preview GET', previewPath, htmlRes.status, {
      hasClaim: /bitpype-claim-preview/i.test(text),
      hasScript: /claim-preview\.js/i.test(text),
    });
  }

  db.close();
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
