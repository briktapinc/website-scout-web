'use strict';

/**
 * Smoke-test claim token + Yes/No intent + postcard PDF/QR.
 * Creates a disposable lead (+ optional fake preview URL) and cleans up.
 * Usage: node scripts/_test-claim-postcard.js [workspaceId]
 */

const fs = require('fs');
const path = require('path');
const claimKit = require('../src/claimKit');
const outreach = require('../src/outreach');
const leadEngine = require('../src/leadEngine');
const { openWorkspaceDb } = require('../server/workspaceDb');

const workspaceId = Number(process.argv[2] || 1);
if (!process.env.APP_URL) process.env.APP_URL = 'https://bitpype.com';
if (!process.env.SESSION_SECRET || process.env.SESSION_SECRET === 'dev-change-me') {
  process.env.SESSION_SECRET = 'claim-postcard-smoke-secret';
}

const db = openWorkspaceDb(workspaceId);
const created = leadEngine.createLead(db, {
  business_name: 'Claim Postcard Smoke Co',
  email: `claim-postcard-smoke-${Date.now()}@example.invalid`,
  status: 'contacted',
  source: 'smoke-test',
  city: 'Austin',
  category: 'Demo',
});
const leadId = Number(created.id || created);
const lead = db.prepare('SELECT id, business_name, email, status FROM leads WHERE id = ?').get(leadId);

let siteId = null;
try {
  const ins = db.prepare(
    `INSERT INTO websites (lead_id, name, status, origin, pages, theme, preview_url, created_at, updated_at)
     VALUES (?, ?, 'ready', 'smoke', '[]', '{}', ?, datetime('now'), datetime('now'))`
  ).run(leadId, 'Claim Postcard Smoke Site', 'https://example.invalid/preview/smoke/');
  siteId = Number(ins.lastInsertRowid);
} catch (e) {
  console.warn('website insert skipped:', e.message);
}

function cleanup() {
  try { db.prepare('DELETE FROM prospect_events WHERE lead_id = ?').run(leadId); } catch { /* */ }
  try { db.prepare('DELETE FROM intent_scores WHERE lead_id = ?').run(leadId); } catch { /* */ }
  try { db.prepare('DELETE FROM lead_events WHERE lead_id = ?').run(leadId); } catch { /* */ }
  try {
    db.prepare('DELETE FROM suppression_list WHERE lower(email) = lower(?)').run(lead.email);
  } catch { /* */ }
  if (siteId) {
    try { db.prepare('DELETE FROM websites WHERE id = ?').run(siteId); } catch { /* */ }
  }
  try { db.prepare('DELETE FROM leads WHERE id = ?').run(leadId); } catch { /* */ }
}

(async () => {
  try {
    const claimUrl = claimKit.buildClaimUrl(workspaceId, leadId);
    console.log('claimUrl', claimUrl);
    if (!claimUrl || !claimUrl.includes('/claim.html?t=')) {
      throw new Error('expected claim.html URL');
    }
    const token = decodeURIComponent(claimUrl.split('t=')[1]);
    const verified = claimKit.verifyClaimToken(token);
    if (verified.workspaceId !== workspaceId || verified.leadId !== leadId) {
      throw new Error(`verify mismatch: ${JSON.stringify(verified)}`);
    }

    // Direct interested/uninterested tokens must not verify as claim
    const iTok = outreach.signInterestToken({ workspaceId, leadId, action: 'interested' });
    let badClaim = false;
    try {
      claimKit.verifyClaimToken(iTok);
    } catch (e) {
      badClaim = e.code === 'INVALID_TOKEN';
    }
    if (!badClaim) throw new Error('interested token should not verify as claim');

    const meta = claimKit.claimPageMeta(db, workspaceId, leadId);
    console.log('meta', meta);
    if (meta.businessName !== lead.business_name) throw new Error('meta business name');

    const yes = outreach.applyInterestResponse(db, leadId, 'interested');
    if (yes.status !== 'engaged') throw new Error(`expected engaged, got ${yes.status}`);

    db.prepare(`UPDATE leads SET status = 'contacted' WHERE id = ?`).run(leadId);
    db.prepare(`DELETE FROM prospect_events WHERE lead_id = ? AND type = 'email.interested'`).run(leadId);

    const no = outreach.applyInterestResponse(db, leadId, 'uninterested');
    if (no.status !== 'lost') throw new Error(`expected lost, got ${no.status}`);
    if (!outreach.isSuppressed(db, lead.email)) throw new Error('expected suppression');

    const kit = await claimKit.buildClaimKit(db, workspaceId, {
      leadId,
      websiteId: siteId || undefined,
      includePdf: true,
    });
    console.log('kit', {
      siteUrl: kit.siteUrl,
      claimUrl: kit.claimUrl,
      hasSiteQr: !!kit.siteQrDataUrl,
      hasClaimQr: !!kit.claimQrDataUrl,
      pdfBytes: kit.pdf && kit.pdf.length,
      filename: kit.filename,
    });
    if (!kit.siteUrl) throw new Error('expected siteUrl');
    if (!kit.claimQrDataUrl || !kit.siteQrDataUrl) throw new Error('expected QR data URLs');
    if (!kit.pdf || kit.pdf.length < 500) throw new Error('PDF too small');
    if (kit.pdf.slice(0, 4).toString() !== '%PDF') throw new Error('not a PDF');

    const outDir = path.join(__dirname, '..', '.tmp-claim-postcard');
    fs.mkdirSync(outDir, { recursive: true });
    const outPdf = path.join(outDir, kit.filename || 'smoke.pdf');
    fs.writeFileSync(outPdf, kit.pdf);
    console.log('wrote', outPdf);

    // Optional live HTTP (when app is running locally)
    const port = process.env.PORT || 3000;
    try {
      const metaRes = await fetch(`http://127.0.0.1:${port}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`);
      const metaJson = await metaRes.json();
      console.log('http claim meta', metaRes.status, metaJson.ok ? 'ok' : metaJson.error);
      if (metaRes.status === 200 && metaJson.ok) {
        const decide = await fetch(`http://127.0.0.1:${port}/api/v1/outreach/public/claim/${encodeURIComponent(token)}`, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action: 'interested' }),
        });
        const decideJson = await decide.json();
        console.log('http claim decide', decide.status, decideJson.data && decideJson.data.action);
      }
    } catch (e) {
      console.log('http skipped (app not running):', e.message);
    }

    console.log('OK');
    cleanup();
  } catch (e) {
    cleanup();
    console.error('FAIL', e.message || e);
    process.exit(1);
  }
})();
