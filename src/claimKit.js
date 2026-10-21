'use strict';

/**
 * Claim kit: signed Yes/No claim page URL + site preview URL + QR codes + postcard PDF.
 * Intent on Yes/No reuses outreach.applyInterestResponse (engaged / lost + suppression).
 */

const QRCode = require('qrcode');
const PDFDocument = require('pdfkit');

const outreach = require('./outreach');

/** Token action letter for the claim page (not a direct interested/uninterested click). */
const CLAIM_ACTION = 'c';

function claimPagePath(token) {
  return `/claim.html?t=${encodeURIComponent(token)}`;
}

/**
 * Stable public claim URL (HMAC token). Empty string when APP_URL / workspace missing.
 */
function buildClaimUrl(workspaceId, leadId) {
  const base = String(process.env.APP_URL || '').replace(/\/$/, '');
  const w = Number(workspaceId);
  const l = Number(leadId);
  if (!base || !Number.isInteger(w) || w <= 0 || !Number.isInteger(l) || l <= 0) return '';
  try {
    const token = outreach.signInterestToken({ workspaceId: w, leadId: l, action: CLAIM_ACTION });
    return `${base}${claimPagePath(token)}`;
  } catch {
    return '';
  }
}

function verifyClaimToken(token) {
  const verified = outreach.verifyInterestToken(token);
  if (verified.action !== 'claim') {
    throw Object.assign(new Error('Not a claim link'), { code: 'INVALID_TOKEN' });
  }
  return { workspaceId: verified.workspaceId, leadId: verified.leadId };
}

async function qrPngBuffer(url, opts = {}) {
  const text = String(url || '').trim();
  if (!text) throw new Error('URL required for QR');
  return QRCode.toBuffer(text, {
    type: 'png',
    errorCorrectionLevel: opts.errorCorrectionLevel || 'M',
    margin: opts.margin != null ? opts.margin : 1,
    width: opts.width || 280,
    color: {
      dark: opts.dark || '#0b5442',
      light: opts.light || '#ffffff',
    },
  });
}

async function qrDataUrl(url, opts = {}) {
  const buf = await qrPngBuffer(url, opts);
  return `data:image/png;base64,${buf.toString('base64')}`;
}

function slugify(name) {
  return String(name || 'site')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'site';
}

/**
 * Build postcard PDF (~4×6 in, landscape). Returns Buffer.
 */
function buildPostcardPdf({
  businessName,
  pitch,
  siteUrl,
  claimUrl,
  siteQrPng,
  claimQrPng,
}) {
  return new Promise((resolve, reject) => {
    // 6 × 4 inches landscape postcard (print-friendly)
    const W = 6 * 72;
    const H = 4 * 72;
    const doc = new PDFDocument({
      size: [W, H],
      margin: 0,
      info: {
        Title: `BitPype postcard — ${businessName || 'website'}`,
        Author: 'BitPype',
      },
    });
    const chunks = [];
    doc.on('data', (c) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    // Soft green wash background (no flat single fill only)
    doc.rect(0, 0, W, H).fill('#f3f7f5');
    doc.save();
    doc.path(`M 0 0 L ${W * 0.55} 0 L ${W * 0.35} ${H} L 0 ${H} Z`).fill('#e4ece8');
    doc.restore();

    const pad = 22;
    const name = String(businessName || 'Your business').slice(0, 80);
    const blurb = String(pitch || 'We built a website for your business. Scan to view it, or scan to claim it with a simple Yes or No.')
      .slice(0, 220);

    doc.fillColor('#0b5442')
      .font('Helvetica-Bold')
      .fontSize(9)
      .text('BITPYPE', pad, pad, { characterSpacing: 1.5 });

    doc.fillColor('#1a2420')
      .font('Helvetica-Bold')
      .fontSize(18)
      .text(name, pad, pad + 16, { width: W - pad * 2, lineGap: 2 });

    const titleBottom = doc.y + 6;
    doc.fillColor('#33443d')
      .font('Helvetica')
      .fontSize(9)
      .text(blurb, pad, titleBottom, { width: W - pad * 2, lineGap: 1.5 });

    const qrTop = Math.max(doc.y + 14, 118);
    const qrSize = 96;
    const colGap = 28;
    const totalQrBlock = qrSize * 2 + colGap;
    const leftX = (W - totalQrBlock) / 2;
    const rightX = leftX + qrSize + colGap;

    if (siteQrPng) {
      doc.image(siteQrPng, leftX, qrTop, { width: qrSize, height: qrSize });
    }
    if (claimQrPng) {
      doc.image(claimQrPng, rightX, qrTop, { width: qrSize, height: qrSize });
    }

    const labelY = qrTop + qrSize + 6;
    doc.fillColor('#0b5442')
      .font('Helvetica-Bold')
      .fontSize(8)
      .text('VIEW YOUR SITE', leftX, labelY, { width: qrSize, align: 'center' });
    doc.text('SCAN TO CLAIM', rightX, labelY, { width: qrSize, align: 'center' });

    doc.fillColor('#5a6b64')
      .font('Helvetica')
      .fontSize(6.5)
      .text(String(siteUrl || '').slice(0, 72), leftX - 8, labelY + 12, {
        width: qrSize + 16,
        align: 'center',
      });
    doc.text("Yes I'm interested · No - Delete it", rightX - 8, labelY + 12, {
      width: qrSize + 16,
      align: 'center',
    });

    doc.fillColor('#7a8a83')
      .font('Helvetica')
      .fontSize(7)
      .text('bitpype.com', pad, H - 18, { width: W - pad * 2, align: 'right' });

    doc.end();
  });
}

/**
 * Assemble claim kit for a lead (optional websiteId). Does not require automation.
 * @returns {Promise<object>}
 */
async function buildClaimKit(db, workspaceId, { leadId, websiteId, includePdf = false } = {}) {
  const lid = Number(leadId);
  if (!Number.isInteger(lid) || lid <= 0) throw new Error('leadId is required');

  const lead = db.prepare(
    'SELECT id, business_name, email, status, city, category FROM leads WHERE id = ?'
  ).get(lid);
  if (!lead) throw Object.assign(new Error('Lead not found'), { code: 'NOT_FOUND' });

  let site = null;
  const wid = websiteId != null ? Number(websiteId) : null;
  if (Number.isInteger(wid) && wid > 0) {
    site = db.prepare(
      `SELECT id, lead_id, name, preview_url, preview_path, status
       FROM websites WHERE id = ?`
    ).get(wid);
    if (!site) throw Object.assign(new Error('Website not found'), { code: 'NOT_FOUND' });
    if (Number(site.lead_id) !== lid) {
      throw Object.assign(new Error('Website does not belong to this lead'), { code: 'MISMATCH' });
    }
  } else {
    try {
      site = db.prepare(
        `SELECT id, lead_id, name, preview_url, preview_path, status, custom_domain
         FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lid);
    } catch {
      site = db.prepare(
        `SELECT id, lead_id, name, preview_url, preview_path, status
         FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1`
      ).get(lid);
    }
  }

  const siteUrl = outreach.resolveWebsiteLink(db, lid)
    || (site && site.preview_url && String(site.preview_url).trim())
    || '';
  const claimUrl = buildClaimUrl(workspaceId, lid);
  if (!claimUrl) {
    throw Object.assign(
      new Error('APP_URL and SESSION_SECRET are required to build claim links'),
      { code: 'MISCONFIGURED' }
    );
  }

  const businessName = lead.business_name || (site && site.name) || 'Your business';
  const place = [lead.city, lead.category].filter(Boolean).join(' · ');
  const pitch = place
    ? `A custom website for ${businessName} (${place}). Scan left to preview, right to claim it.`
    : `A custom website for ${businessName}. Scan left to preview, right to claim it with Yes or No.`;

  let siteQrPng = null;
  let claimQrPng = null;
  let siteQrDataUrl = null;
  let claimQrDataUrl = null;

  if (siteUrl) {
    siteQrPng = await qrPngBuffer(siteUrl, { width: 320 });
    siteQrDataUrl = `data:image/png;base64,${siteQrPng.toString('base64')}`;
  }
  claimQrPng = await qrPngBuffer(claimUrl, { width: 320 });
  claimQrDataUrl = `data:image/png;base64,${claimQrPng.toString('base64')}`;

  const kit = {
    leadId: lid,
    websiteId: site ? site.id : null,
    businessName,
    status: lead.status,
    siteUrl: siteUrl || null,
    claimUrl,
    siteQrDataUrl,
    claimQrDataUrl,
    pitch,
  };

  if (includePdf) {
    if (!siteUrl) {
      throw Object.assign(
        new Error('No preview URL yet — publish or open Preview URL before generating a postcard.'),
        { code: 'NO_SITE_URL' }
      );
    }
    const pdf = await buildPostcardPdf({
      businessName,
      pitch,
      siteUrl,
      claimUrl,
      siteQrPng,
      claimQrPng,
    });
    kit.pdf = pdf;
    kit.filename = `bitpype-postcard-${slugify(businessName)}-${lid}.pdf`;
  }

  return kit;
}

/**
 * True when the lead has already shown positive claim/engagement intent.
 * Used to suppress the preview claim popup.
 */
function isIntentPositive(db, lead) {
  if (!lead) return false;
  const status = String(lead.status || '').toLowerCase();
  if (['engaged', 'claimed', 'trial', 'customer'].includes(status)) return true;
  const interested = db.prepare(
    `SELECT id FROM prospect_events WHERE lead_id = ? AND type = 'email.interested' LIMIT 1`
  ).get(lead.id);
  if (interested) return true;
  const latest = outreach.getIntent(db, lead.id);
  const label = String((latest && latest.label) || '').toLowerCase();
  if (label === 'hot' || label === 'interested' || label === 'customer') return true;
  const score = Number(latest && latest.score) || 0;
  if (score >= 31) return true; // Interested threshold
  return false;
}

/**
 * Public claim-page meta (no session). Token must be claim action.
 */
function claimPageMeta(db, workspaceId, leadId) {
  const lead = db.prepare(
    'SELECT id, business_name, status FROM leads WHERE id = ?'
  ).get(Number(leadId));
  if (!lead) throw Object.assign(new Error('Lead not found'), { code: 'NOT_FOUND' });
  const siteUrl = outreach.resolveWebsiteLink(db, lead.id) || null;
  const interested = db.prepare(
    `SELECT id FROM prospect_events WHERE lead_id = ? AND type = 'email.interested' LIMIT 1`
  ).get(lead.id);
  const uninterested = db.prepare(
    `SELECT id FROM prospect_events WHERE lead_id = ? AND type = 'email.uninterested' LIMIT 1`
  ).get(lead.id);
  const laterRow = db.prepare(
    `SELECT COUNT(*) AS c FROM prospect_events WHERE lead_id = ? AND type = 'claim.later'`
  ).get(lead.id);
  const laterCount = Number(laterRow && laterRow.c) || 0;
  const intentPositive = isIntentPositive(db, lead);
  // Hide after Yes (positive) or No (uninterested). "Later" stays showClaimPrompt so
  // a future visit can re-prompt (client may session-hide until then).
  const showClaimPrompt = !intentPositive && !interested && !uninterested;
  return {
    businessName: lead.business_name || '',
    status: lead.status,
    siteUrl,
    alreadyInterested: !!interested,
    alreadyUninterested: !!uninterested,
    alreadyDeferred: laterCount > 0,
    laterCount,
    intentPositive,
    showClaimPrompt,
  };
}

/**
 * Inject claim Yes/No popup loader into exported preview HTML files.
 * Script loads from APP_URL so Cloudflare Pages previews work cross-origin.
 */
function injectClaimPreviewIntoExport(exportDir, workspaceId, leadId) {
  const fs = require('fs');
  const path = require('path');
  const dir = String(exportDir || '');
  if (!dir || !fs.existsSync(dir)) return { injected: 0 };
  const claimUrl = buildClaimUrl(workspaceId, leadId);
  if (!claimUrl) return { injected: 0, reason: 'no_claim_url' };
  let token = '';
  try {
    const u = new URL(claimUrl);
    token = u.searchParams.get('t') || '';
  } catch {
    const m = String(claimUrl).match(/[?&]t=([^&]+)/);
    token = m ? decodeURIComponent(m[1]) : '';
  }
  if (!token) return { injected: 0, reason: 'no_token' };
  const apiBase = String(process.env.APP_URL || '').replace(/\/$/, '');
  if (!apiBase) return { injected: 0, reason: 'no_app_url' };

  const snippet = [
    '',
    '<!-- bitpype-claim-preview -->',
    `<script>window.BitpypeClaim=${JSON.stringify({ apiBase, token, v: 4 })};</script>`,
    `<script src="${apiBase}/js/claim-preview.js?v=6" defer></script>`,
    '<!-- /bitpype-claim-preview -->',
    '',
  ].join('\n');

  let injected = 0;
  const names = fs.readdirSync(dir).filter((n) => /\.html?$/i.test(n));
  for (const name of names) {
    const full = path.join(dir, name);
    try {
      if (!fs.statSync(full).isFile()) continue;
      let html = fs.readFileSync(full, 'utf8');
      if (/bitpype-claim-preview/i.test(html)) {
        html = html.replace(
          /\n?<!-- bitpype-claim-preview -->[\s\S]*?<!-- \/bitpype-claim-preview -->\n?/i,
          ''
        );
      }
      if (/<\/body>/i.test(html)) {
        html = html.replace(/<\/body>/i, `${snippet}</body>`);
      } else {
        html += snippet;
      }
      fs.writeFileSync(full, html, 'utf8');
      injected++;
    } catch (e) {
      console.warn('[claimKit] inject', name, e.message || e);
    }
  }
  return { injected, token: true };
}

/**
 * Parse EXPORT_ROOT folder names → { workspaceId?, websiteId? }.
 * Supports ws-{ws}-site-{id}-… and site-{id}.
 */
function parseExportFolderName(name) {
  const n = String(name || '');
  let m = n.match(/^ws-(\d+)-site-(\d+)/i);
  if (m) return { workspaceId: Number(m[1]), websiteId: Number(m[2]) };
  m = n.match(/^site-(\d+)$/i);
  if (m) return { websiteId: Number(m[1]) };
  m = n.match(/^qa-site-(\d+)$/i);
  if (m) return { websiteId: Number(m[1]) };
  return null;
}

/**
 * Backfill claim popup into existing EXPORT_ROOT site folders.
 * Resolves lead_id from each workspace DB when possible.
 * @param {string} rootDir
 * @param {{ resolveLead?: (workspaceId:number|null, websiteId:number) => {workspaceId:number, leadId:number}|null }} [opts]
 */
function injectClaimPreviewIntoAllExports(rootDir, opts = {}) {
  const fs = require('fs');
  const path = require('path');
  const root = String(rootDir || '');
  if (!root || !fs.existsSync(root)) return { folders: 0, files: 0, skipped: 0 };
  const resolveLead = typeof opts.resolveLead === 'function' ? opts.resolveLead : null;
  let folders = 0;
  let files = 0;
  let skipped = 0;
  for (const name of fs.readdirSync(root)) {
    const full = path.join(root, name);
    try {
      if (!fs.statSync(full).isDirectory()) continue;
      const parsed = parseExportFolderName(name);
      if (!parsed || !parsed.websiteId) continue;
      let workspaceId = parsed.workspaceId || null;
      let leadId = null;
      if (resolveLead) {
        const hit = resolveLead(workspaceId, parsed.websiteId);
        if (hit) {
          workspaceId = hit.workspaceId;
          leadId = hit.leadId;
        }
      }
      if (!workspaceId || !leadId) {
        skipped++;
        continue;
      }
      const r = injectClaimPreviewIntoExport(full, workspaceId, leadId);
      if (r && r.injected > 0) {
        folders++;
        files += r.injected;
      } else {
        skipped++;
      }
    } catch (e) {
      console.warn('[claimKit] backfill', name, e.message || e);
      skipped++;
    }
  }
  return { folders, files, skipped };
}

module.exports = {
  CLAIM_ACTION,
  claimPagePath,
  buildClaimUrl,
  verifyClaimToken,
  qrPngBuffer,
  qrDataUrl,
  buildPostcardPdf,
  buildClaimKit,
  claimPageMeta,
  isIntentPositive,
  injectClaimPreviewIntoExport,
  injectClaimPreviewIntoAllExports,
  parseExportFolderName,
  slugify,
};
