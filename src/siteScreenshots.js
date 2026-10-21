'use strict';

/**
 * siteScreenshots.js — capture live site preview screenshots into EXPORT_ROOT,
 * register them in site_screenshots, and expose email/MMS renditions for outreach.
 *
 * Viewports: desktop 1440×900, mobile 390×844 (viewport shots, not full-page).
 * Pages: homepage + services (when present).
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const http = require('http');
const https = require('https');

const openPreview = require('./openPreview');

const DESKTOP = { name: 'desktop', width: 1440, height: 900 };
const MOBILE = { name: 'mobile', width: 390, height: 844 };
const VIEWPORTS = [DESKTOP, MOBILE];
const EMAIL_MAX_WIDTH = 1200;
const EMAIL_JPEG_QUALITY = 80;
const MMS_MAX_DIM = 1600;
const MMS_MAX_BYTES = 900 * 1024;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function appUrl() {
  return String(process.env.APP_URL || 'http://127.0.0.1:3080').replace(/\/$/, '');
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS site_screenshots (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      website_id INTEGER NOT NULL,
      lead_id INTEGER,
      design_job_id INTEGER,
      version INTEGER NOT NULL DEFAULT 1,
      is_current INTEGER NOT NULL DEFAULT 1,
      page TEXT NOT NULL,
      viewport TEXT NOT NULL,
      kind TEXT NOT NULL DEFAULT 'capture',
      storage_path TEXT NOT NULL,
      public_url TEXT NOT NULL,
      width INTEGER,
      height INTEGER,
      bytes INTEGER,
      content_type TEXT,
      captured_at TEXT NOT NULL DEFAULT (datetime('now')),
      meta TEXT
    );
    CREATE INDEX IF NOT EXISTS idx_site_shots_website
      ON site_screenshots(website_id, is_current, kind);
    CREATE INDEX IF NOT EXISTS idx_site_shots_lead
      ON site_screenshots(lead_id, is_current, kind);
  `);
}

function shotFolder(websiteId) {
  return path.join(openPreview.exportRoot(), `site-${Number(websiteId)}`, 'screenshots');
}

function publicUrlFor(websiteId, relPath) {
  const rel = String(relPath || '').replace(/\\/g, '/').replace(/^\/+/, '');
  return `${appUrl()}/site-previews/site-${Number(websiteId)}/screenshots/${rel}`;
}

function parsePages(site) {
  let pages = site && site.pages;
  if (typeof pages === 'string') {
    try { pages = JSON.parse(pages); } catch { pages = []; }
  }
  return Array.isArray(pages) ? pages : [];
}

function isHomePage(page, pages) {
  try {
    return require('./websiteEngine').isHomePage(page, pages);
  } catch {
    const slug = String((page && page.slug) || '').toLowerCase().replace(/\.html$/i, '');
    return slug === '' || slug === '/' || slug === 'home' || slug === 'index';
  }
}

function pageFileName(slug) {
  try {
    return require('./websiteEngine').pageFileName(slug);
  } catch {
    const s = String(slug || '').replace(/^\//, '');
    if (!s || s === 'home' || s === 'index') return 'index.html';
    return s.replace(/[^a-z0-9-_]/gi, '_') + '.html';
  }
}

/** Pick homepage + services (or first non-home) for capture targets. */
function resolveCapturePages(pages) {
  const list = Array.isArray(pages) ? pages : [];
  if (!list.length) return [];
  const home = list.find((p) => isHomePage(p, list)) || list[0];
  const services = list.find((p) => {
    if (p === home) return false;
    const blob = `${p.slug || ''} ${p.title || ''}`.toLowerCase();
    return /service/.test(blob);
  }) || list.find((p) => p !== home) || null;
  const out = [{ key: 'home', page: home, file: isHomePage(home, list) ? 'index.html' : pageFileName(home.slug) }];
  if (services) {
    out.push({
      key: 'services',
      page: services,
      file: pageFileName(services.slug),
    });
  }
  return out;
}

function nextVersion(db, websiteId) {
  const row = db.prepare(
    'SELECT COALESCE(MAX(version), 0) AS v FROM site_screenshots WHERE website_id = ?'
  ).get(Number(websiteId));
  return Number(row && row.v) + 1;
}

async function loadPuppeteer() {
  try {
    return require('puppeteer');
  } catch {
    throw fail('PUPPETEER_MISSING', 'puppeteer is not installed. Run npm install puppeteer.');
  }
}

function chromeArgs() {
  return [
    '--no-sandbox',
    '--disable-setuid-sandbox',
    '--disable-dev-shm-usage',
    '--font-render-hinting=medium',
    '--disable-gpu',
  ];
}

function resolveChromeExecutable() {
  const candidates = [
    process.env.PUPPETEER_EXECUTABLE_PATH,
    process.env.CHROME_PATH,
    '/usr/bin/chromium',
    '/usr/bin/chromium-browser',
    '/usr/bin/google-chrome-stable',
    '/usr/bin/google-chrome',
  ];
  for (const p of candidates) {
    if (p && fs.existsSync(p)) return p;
  }
  return null;
}

async function waitForAssets(page) {
  try {
    await page.evaluate(async () => {
      if (document.fonts && document.fonts.ready) {
        try { await document.fonts.ready; } catch { /* */ }
      }
      const imgs = Array.from(document.images || []);
      await Promise.all(imgs.map((img) => {
        if (img.complete) return Promise.resolve();
        return new Promise((resolve) => {
          img.addEventListener('load', resolve, { once: true });
          img.addEventListener('error', resolve, { once: true });
          setTimeout(resolve, 8000);
        });
      }));
    });
  } catch { /* best effort */ }
  try {
    await page.evaluate(() => window.scrollTo(0, 0));
  } catch { /* */ }
}

async function captureViewportPng(browser, url, viewport) {
  const page = await browser.newPage();
  try {
    await page.setViewport({
      width: viewport.width,
      height: viewport.height,
      deviceScaleFactor: 1,
      isMobile: viewport.name === 'mobile',
      hasTouch: viewport.name === 'mobile',
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 90000 });
    await waitForAssets(page);
    await new Promise((r) => setTimeout(r, 400));
    const buf = await page.screenshot({
      type: 'png',
      fullPage: false,
      captureBeyondViewport: false,
    });
    return Buffer.isBuffer(buf) ? buf : Buffer.from(buf);
  } finally {
    try { await page.close(); } catch { /* */ }
  }
}

async function makeEmailRendition(pngBuf) {
  const sharp = require('sharp');
  const img = sharp(pngBuf);
  const meta = await img.metadata();
  let pipeline = sharp(pngBuf);
  if ((meta.width || 0) > EMAIL_MAX_WIDTH) {
    pipeline = pipeline.resize({ width: EMAIL_MAX_WIDTH, withoutEnlargement: true });
  }
  const out = await pipeline.jpeg({ quality: EMAIL_JPEG_QUALITY, mozjpeg: true }).toBuffer();
  const info = await sharp(out).metadata();
  return { buffer: out, width: info.width || null, height: info.height || null, contentType: 'image/jpeg' };
}

async function makeMmsRendition(pngBuf) {
  const sharp = require('sharp');
  let quality = 82;
  let width = MMS_MAX_DIM;
  let buffer = null;
  let meta = null;
  for (let attempt = 0; attempt < 8; attempt++) {
    buffer = await sharp(pngBuf)
      .resize({ width, height: MMS_MAX_DIM, fit: 'inside', withoutEnlargement: true })
      .jpeg({ quality, mozjpeg: true })
      .toBuffer();
    meta = await sharp(buffer).metadata();
    if (buffer.length <= MMS_MAX_BYTES) break;
    if (quality > 55) quality -= 8;
    else width = Math.max(640, Math.floor(width * 0.85));
  }
  return {
    buffer,
    width: meta && meta.width || null,
    height: meta && meta.height || null,
    contentType: 'image/jpeg',
    bytes: buffer.length,
  };
}

function writeShotFile(absPath, buffer) {
  fs.mkdirSync(path.dirname(absPath), { recursive: true });
  fs.writeFileSync(absPath, buffer);
}

function insertRow(db, row) {
  if (row.is_current) {
    try {
      db.prepare(`
        UPDATE site_screenshots SET is_current = 0
        WHERE website_id = ? AND page = ? AND viewport = ? AND kind = ?
          AND is_current = 1
      `).run(row.website_id, row.page, row.viewport, row.kind || 'capture');
    } catch { /* optional */ }
  }
  const res = db.prepare(`
    INSERT INTO site_screenshots
      (website_id, lead_id, design_job_id, version, is_current, page, viewport, kind,
       storage_path, public_url, width, height, bytes, content_type, captured_at, meta)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, datetime('now'), ?)
  `).run(
    row.website_id,
    row.lead_id,
    row.design_job_id,
    row.version,
    row.is_current ? 1 : 0,
    row.page,
    row.viewport,
    row.kind,
    row.storage_path,
    row.public_url,
    row.width,
    row.height,
    row.bytes,
    row.content_type,
    row.meta ? JSON.stringify(row.meta) : null
  );
  return Number(res.lastInsertRowid);
}

function publicRow(r) {
  if (!r) return null;
  let meta = null;
  if (r.meta) {
    try { meta = typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta; } catch { meta = null; }
  }
  return {
    id: r.id,
    websiteId: r.website_id,
    leadId: r.lead_id,
    designJobId: r.design_job_id,
    version: r.version,
    isCurrent: !!r.is_current,
    page: r.page,
    viewport: r.viewport,
    kind: r.kind,
    storagePath: r.storage_path,
    publicUrl: r.public_url,
    width: r.width,
    height: r.height,
    bytes: r.bytes,
    contentType: r.content_type,
    capturedAt: r.captured_at,
    meta,
  };
}

/**
 * HEAD/GET the public URL; ready only when HTTP 200 + image/* content-type.
 */
function checkUrlReady(url, opts = {}) {
  const timeoutMs = Number(opts.timeoutMs) || 12000;
  return new Promise((resolve) => {
    if (!url || !/^https?:\/\//i.test(url)) {
      resolve({ ready: false, status: 0, contentType: null, error: 'invalid_url' });
      return;
    }
    let settled = false;
    const done = (result) => {
      if (settled) return;
      settled = true;
      resolve(result);
    };
    const lib = url.startsWith('https') ? https : http;
    const req = lib.request(url, { method: 'GET', timeout: timeoutMs }, (res) => {
      const ct = String(res.headers['content-type'] || '').split(';')[0].trim().toLowerCase();
      const status = res.statusCode || 0;
      res.resume();
      done({
        ready: status === 200 && ct.startsWith('image/'),
        status,
        contentType: ct || null,
      });
    });
    req.on('timeout', () => { try { req.destroy(); } catch { /* */ }; done({ ready: false, status: 0, contentType: null, error: 'timeout' }); });
    req.on('error', (err) => done({ ready: false, status: 0, contentType: null, error: err.message }));
    req.end();
  });
}

async function enrichReady(rows) {
  const out = [];
  for (const r of rows) {
    const check = await checkUrlReady(r.publicUrl);
    out.push(Object.assign({}, r, { ready: !!check.ready, readyCheck: check }));
  }
  return out;
}

function listScreenshots(db, opts = {}) {
  ensureTables(db);
  const websiteId = opts.websiteId != null ? Number(opts.websiteId) : null;
  const leadId = opts.leadId != null ? Number(opts.leadId) : null;
  const currentOnly = opts.currentOnly !== false;
  const clauses = [];
  const params = [];
  if (Number.isInteger(websiteId) && websiteId > 0) {
    clauses.push('website_id = ?');
    params.push(websiteId);
  }
  if (Number.isInteger(leadId) && leadId > 0) {
    clauses.push('lead_id = ?');
    params.push(leadId);
  }
  if (currentOnly) clauses.push('is_current = 1');
  if (opts.kind) {
    clauses.push('kind = ?');
    params.push(String(opts.kind));
  }
  if (!clauses.length) throw fail('INVALID_ARGS', 'websiteId or leadId is required');
  const rows = db.prepare(
    `SELECT * FROM site_screenshots WHERE ${clauses.join(' AND ')}
     ORDER BY version DESC, page ASC, viewport ASC, kind ASC, id ASC`
  ).all(...params).map(publicRow);
  return rows;
}

function getCurrentEmailShot(db, leadId) {
  ensureTables(db);
  const row = db.prepare(
    `SELECT * FROM site_screenshots
     WHERE lead_id = ? AND is_current = 1 AND kind = 'email'
     ORDER BY version DESC, id DESC LIMIT 1`
  ).get(Number(leadId));
  return publicRow(row);
}

function getCurrentMmsShot(db, leadId) {
  ensureTables(db);
  const row = db.prepare(
    `SELECT * FROM site_screenshots
     WHERE lead_id = ? AND is_current = 1 AND kind = 'mms'
     ORDER BY version DESC, id DESC LIMIT 1`
  ).get(Number(leadId));
  return publicRow(row);
}

/**
 * Merge-field bag for outreach personalize().
 * Email: site_screenshot = linked <img> (email JPEG).
 * SMS: pass forSms:true so site_screenshot is the MMS/public URL string.
 */
function screenshotMergeFields(db, leadId, opts = {}) {
  const websiteLink = String((opts && opts.websiteLink) || '').trim();
  const emailShot = getCurrentEmailShot(db, leadId);
  const mmsShot = getCurrentMmsShot(db, leadId);
  const url = (emailShot && emailShot.publicUrl) || '';
  const mms = (mmsShot && mmsShot.publicUrl) || url;
  if (opts.forSms) {
    return {
      site_screenshot: mms || websiteLink || '',
      site_screenshot_url: url || '',
      site_screenshot_mms: mms || '',
      site_screenshot_media_url: mms || '',
    };
  }
  const img = url
    ? `<a href="${escapeAttr(websiteLink || url)}" target="_blank" rel="noopener"><img src="${escapeAttr(url)}" alt="Website preview" style="max-width:100%;height:auto;border:0;display:block;" /></a>`
    : '';
  return {
    site_screenshot: img,
    site_screenshot_url: url,
    site_screenshot_mms: mms,
    site_screenshot_media_url: mms,
  };
}

function escapeAttr(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

/**
 * Capture screenshots for a website. Requires a live preview base URL.
 * opts: { previewUrl, designJobId, leadId, pages? }
 */
async function captureWebsiteScreenshots(db, websiteId, opts = {}) {
  ensureTables(db);
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id <= 0) throw fail('INVALID_ID', 'websiteId must be a positive integer');

  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (!site) throw fail('NOT_FOUND', `Website ${id} not found`);

  const leadId = opts.leadId != null ? Number(opts.leadId) : (site.lead_id != null ? Number(site.lead_id) : null);
  let designJobId = opts.designJobId != null ? Number(opts.designJobId) : null;
  if (!designJobId) {
    try {
      const job = db.prepare(
        'SELECT id FROM design_jobs WHERE website_id = ? ORDER BY id DESC LIMIT 1'
      ).get(id);
      if (job) designJobId = Number(job.id);
    } catch { /* optional */ }
  }

  const previewBase = String(opts.previewUrl || site.preview_url || '').trim().replace(/\/+$/, '');
  if (!previewBase || !/^https?:\/\//i.test(previewBase)) {
    throw fail('NO_PREVIEW', 'Website has no live preview URL to capture. Publish a preview first.');
  }

  const pages = opts.pages || parsePages(site);
  const targets = resolveCapturePages(pages);
  if (!targets.length) throw fail('NO_PAGES', 'Website has no pages to capture');

  const version = nextVersion(db, id);
  const versionDir = path.join(shotFolder(id), `v${version}`);
  fs.mkdirSync(versionDir, { recursive: true });

  const puppeteer = await loadPuppeteer();
  const launchOpts = {
    headless: true,
    args: chromeArgs(),
  };
  const exePath = resolveChromeExecutable();
  if (exePath) launchOpts.executablePath = exePath;

  const browser = await puppeteer.launch(launchOpts);
  const created = [];
  let desktopHomePng = null;

  try {
    for (const target of targets) {
      const pageUrl = `${previewBase}/${target.file === 'index.html' ? '' : target.file}`.replace(/([^:]\/)\/+/g, '$1');
      for (const vp of VIEWPORTS) {
        const png = await captureViewportPng(browser, pageUrl, vp);
        const fileName = `${target.key}-${vp.name}.png`;
        const abs = path.join(versionDir, fileName);
        writeShotFile(abs, png);
        const rel = `v${version}/${fileName}`;
        const sharp = require('sharp');
        const meta = await sharp(png).metadata();
        const rowId = insertRow(db, {
          website_id: id,
          lead_id: leadId,
          design_job_id: designJobId,
          version,
          is_current: 1,
          page: target.key,
          viewport: vp.name,
          kind: 'capture',
          storage_path: abs,
          public_url: publicUrlFor(id, rel),
          width: meta.width || vp.width,
          height: meta.height || vp.height,
          bytes: png.length,
          content_type: 'image/png',
          meta: { sourceUrl: pageUrl, previewBase },
        });
        created.push(publicRow(db.prepare('SELECT * FROM site_screenshots WHERE id = ?').get(rowId)));
        if (target.key === 'home' && vp.name === 'desktop') desktopHomePng = png;
      }
    }
  } finally {
    try { await browser.close(); } catch { /* */ }
  }

  if (desktopHomePng) {
    const email = await makeEmailRendition(desktopHomePng);
    const emailName = `home-desktop-email.jpg`;
    const emailAbs = path.join(versionDir, emailName);
    writeShotFile(emailAbs, email.buffer);
    const emailId = insertRow(db, {
      website_id: id,
      lead_id: leadId,
      design_job_id: designJobId,
      version,
      is_current: 1,
      page: 'home',
      viewport: 'desktop',
      kind: 'email',
      storage_path: emailAbs,
      public_url: publicUrlFor(id, `v${version}/${emailName}`),
      width: email.width,
      height: email.height,
      bytes: email.buffer.length,
      content_type: email.contentType,
      meta: { maxWidth: EMAIL_MAX_WIDTH, quality: EMAIL_JPEG_QUALITY },
    });
    created.push(publicRow(db.prepare('SELECT * FROM site_screenshots WHERE id = ?').get(emailId)));

    const mms = await makeMmsRendition(desktopHomePng);
    const mmsName = `home-desktop-mms.jpg`;
    const mmsAbs = path.join(versionDir, mmsName);
    writeShotFile(mmsAbs, mms.buffer);
    const mmsId = insertRow(db, {
      website_id: id,
      lead_id: leadId,
      design_job_id: designJobId,
      version,
      is_current: 1,
      page: 'home',
      viewport: 'desktop',
      kind: 'mms',
      storage_path: mmsAbs,
      public_url: publicUrlFor(id, `v${version}/${mmsName}`),
      width: mms.width,
      height: mms.height,
      bytes: mms.bytes,
      content_type: mms.contentType,
      meta: { maxBytes: MMS_MAX_BYTES, maxDim: MMS_MAX_DIM },
    });
    created.push(publicRow(db.prepare('SELECT * FROM site_screenshots WHERE id = ?').get(mmsId)));
  }

  // Mark previous versions as not current (keep history).
  db.prepare(
    `UPDATE site_screenshots SET is_current = 0
     WHERE website_id = ? AND version < ?`
  ).run(id, version);

  try {
    db.prepare(
      `INSERT INTO activity_log (area, message) VALUES ('websites', ?)`
    ).run(`Captured ${created.length} preview screenshot(s) for website #${id} (v${version}).`);
  } catch { /* */ }

  // Best-effort ready checks (local APP_URL may not be up during tests).
  const withReady = await enrichReady(created.filter((c) => c.isCurrent));
  return {
    websiteId: id,
    leadId,
    designJobId,
    version,
    count: created.length,
    screenshots: withReady.length ? withReady : created,
  };
}

/**
 * Capture a single viewport PNG for an arbitrary page path.
 * opts: { path, width, height?, previewUrl?, leadId?, designJobId? }
 * path: "index.html" | "about.html" | "/about" | "" (home)
 */
function siteDeploymentKey(site) {
  if (!site) return 'unknown';
  const dep = site.cf_deployment_id != null && String(site.cf_deployment_id).trim()
    ? String(site.cf_deployment_id).trim()
    : '';
  const ver = site.deployed_version_no != null ? Number(site.deployed_version_no) : null;
  if (dep && Number.isInteger(ver) && ver > 0) return `dep:${dep}|v:${ver}`;
  if (dep) return `dep:${dep}`;
  if (Number.isInteger(ver) && ver > 0) return `v:${ver}`;
  // Fall back to content fingerprint so local edits invalidate cache before publish.
  const updated = site.updated_at != null ? String(site.updated_at) : '';
  const hash = crypto.createHash('sha1')
    .update(String(site.pages || ''))
    .update('|')
    .update(String(site.theme || ''))
    .update('|')
    .update(updated)
    .digest('hex')
    .slice(0, 16);
  return `content:${hash}`;
}

function findCachedScreenshot(db, websiteId, pageKey, width, deploymentKey) {
  try {
    const rows = db.prepare(`
      SELECT * FROM site_screenshots
      WHERE website_id = ? AND page = ? AND viewport = ? AND kind = 'capture' AND is_current = 1
      ORDER BY id DESC LIMIT 8
    `).all(Number(websiteId), String(pageKey), String(width));
    for (const r of rows) {
      let meta = null;
      try { meta = r.meta ? (typeof r.meta === 'string' ? JSON.parse(r.meta) : r.meta) : null; } catch { meta = null; }
      if (meta && String(meta.deploymentKey || '') === String(deploymentKey)) {
        if (r.storage_path && fs.existsSync(r.storage_path)) return r;
      }
    }
  } catch { /* optional */ }
  return null;
}

async function captureOneScreenshot(db, websiteId, opts = {}) {
  ensureTables(db);
  const id = Number(websiteId);
  if (!Number.isInteger(id) || id <= 0) throw fail('INVALID_ID', 'websiteId must be a positive integer');

  const site = db.prepare('SELECT * FROM websites WHERE id = ?').get(id);
  if (!site) throw fail('NOT_FOUND', `Website ${id} not found`);

  const width = Math.max(320, Math.min(2560, Math.round(Number(opts.width) || 1440)));
  const height = Math.max(480, Math.min(4096, Math.round(Number(opts.height) || (width <= 500 ? 844 : 900))));
  const viewport = {
    name: width <= 500 ? 'mobile' : (width >= 1200 ? 'desktop' : 'custom'),
    width,
    height,
  };

  let pagePath = String(opts.path != null ? opts.path : 'index.html').trim().replace(/\\/g, '/');
  if (!pagePath || pagePath === '/' || pagePath === 'home') pagePath = 'index.html';
  pagePath = pagePath.replace(/^\//, '');
  if (!/\.html?$/i.test(pagePath) && pagePath !== 'index.html') {
    pagePath = pagePath.replace(/\/$/, '');
    pagePath = `${pagePath || 'index'}.html`;
  }
  if (pagePath.includes('..')) throw fail('INVALID_PATH', 'path must not contain ..');

  const leadId = opts.leadId != null ? Number(opts.leadId) : (site.lead_id != null ? Number(site.lead_id) : null);
  let designJobId = opts.designJobId != null ? Number(opts.designJobId) : null;
  if (!designJobId) {
    try {
      const job = db.prepare(
        'SELECT id FROM design_jobs WHERE website_id = ? ORDER BY id DESC LIMIT 1'
      ).get(id);
      if (job) designJobId = Number(job.id);
    } catch { /* optional */ }
  }

  const deploymentKey = siteDeploymentKey(site);
  const deploymentId = site.cf_deployment_id || null;
  const deployedVersion = site.deployed_version_no != null ? Number(site.deployed_version_no) : null;
  const safeKey = pagePath.replace(/\.html?$/i, '').replace(/[^a-z0-9-_]+/gi, '_') || 'home';

  // Cache hit only when site+page+width+deployment/version fingerprint match.
  if (!opts.force) {
    const cached = findCachedScreenshot(db, id, safeKey, width, deploymentKey);
    if (cached) {
      const row = publicRow(cached);
      return Object.assign({}, row, {
        deploymentId,
        deployedVersion,
        deploymentKey,
        capturedAt: row.capturedAt,
        cacheHit: true,
      });
    }
  }

  // Prefer local render of the latest saved pages unless the caller passed previewUrl
  // explicitly — stored CF preview_url often lags one publish behind after save/replace.
  const explicitPreview = opts.previewUrl != null && String(opts.previewUrl).trim() !== '';
  let previewBase = explicitPreview
    ? String(opts.previewUrl).trim().replace(/\/+$/, '')
    : '';
  if (!previewBase || !/^https?:\/\//i.test(previewBase)) {
    // Render locally via data URL from current DB pages (agent QA / post-save).
    const engine = require('./websiteEngine');
    const pages = parsePages(site);
    const theme = typeof site.theme === 'string' ? JSON.parse(site.theme || '{}') : (site.theme || {});
    const wantSlug = pagePath.replace(/\.html?$/i, '').replace(/^index$/i, '') || '/';
    const page = pages.find((p) => {
      const file = engine.isHomePage(p, pages) ? 'index.html' : engine.pageFileName(p.slug);
      return file === pagePath || String(p.slug || '') === wantSlug;
    }) || (engine.isHomePage ? engine.homePage(pages) : pages[0]);
    const html = engine.renderPage(page || pages[0], pages, theme);
    const puppeteer = await loadPuppeteer();
    const launchOpts = { headless: true, args: chromeArgs() };
    const exePath = resolveChromeExecutable();
    if (exePath) launchOpts.executablePath = exePath;
    const browser = await puppeteer.launch(launchOpts);
    try {
      const pageObj = await browser.newPage();
      await pageObj.setViewport({
        width: viewport.width,
        height: viewport.height,
        deviceScaleFactor: 1,
        isMobile: viewport.name === 'mobile',
        hasTouch: viewport.name === 'mobile',
      });
      await pageObj.setContent(html, { waitUntil: 'networkidle0', timeout: 60000 });
      await waitForAssets(pageObj);
      const png = await pageObj.screenshot({ type: 'png', fullPage: false, captureBeyondViewport: false });
      const buf = Buffer.isBuffer(png) ? png : Buffer.from(png);
      const version = nextVersion(db, id);
      const versionDir = path.join(shotFolder(id), `v${version}`);
      const fileName = `${safeKey}-${viewport.width}.png`;
      const abs = path.join(versionDir, fileName);
      writeShotFile(abs, buf);
      const rel = `v${version}/${fileName}`;
      const sharp = require('sharp');
      const meta = await sharp(buf).metadata();
      const rowId = insertRow(db, {
        website_id: id,
        lead_id: leadId,
        design_job_id: designJobId,
        version,
        is_current: 1,
        page: safeKey,
        viewport: String(viewport.width),
        kind: 'capture',
        storage_path: abs,
        public_url: publicUrlFor(id, rel),
        width: meta.width || viewport.width,
        height: meta.height || viewport.height,
        bytes: buf.length,
        content_type: 'image/png',
        meta: {
          path: pagePath,
          width: viewport.width,
          localRender: true,
          deploymentKey,
          deploymentId,
          deployedVersion,
        },
      });
      const row = publicRow(db.prepare('SELECT * FROM site_screenshots WHERE id = ?').get(rowId));
      return Object.assign({}, row, {
        deploymentId,
        deployedVersion,
        deploymentKey,
        capturedAt: row.capturedAt,
        cacheHit: false,
      });
    } finally {
      try { await browser.close(); } catch { /* */ }
    }
  }

  const pageUrl = `${previewBase}/${pagePath === 'index.html' ? '' : pagePath}`.replace(/([^:]\/)\/+/g, '$1');
  const version = nextVersion(db, id);
  const versionDir = path.join(shotFolder(id), `v${version}`);
  fs.mkdirSync(versionDir, { recursive: true });

  const puppeteer = await loadPuppeteer();
  const launchOpts = { headless: true, args: chromeArgs() };
  const exePath = resolveChromeExecutable();
  if (exePath) launchOpts.executablePath = exePath;
  const browser = await puppeteer.launch(launchOpts);
  try {
    const png = await captureViewportPng(browser, pageUrl, viewport);
    const fileName = `${safeKey}-${viewport.width}.png`;
    const abs = path.join(versionDir, fileName);
    writeShotFile(abs, png);
    const rel = `v${version}/${fileName}`;
    const sharp = require('sharp');
    const meta = await sharp(png).metadata();
    const rowId = insertRow(db, {
      website_id: id,
      lead_id: leadId,
      design_job_id: designJobId,
      version,
      is_current: 1,
      page: safeKey,
      viewport: String(viewport.width),
      kind: 'capture',
      storage_path: abs,
      public_url: publicUrlFor(id, rel),
      width: meta.width || viewport.width,
      height: meta.height || viewport.height,
      bytes: png.length,
      content_type: 'image/png',
      meta: {
        sourceUrl: pageUrl,
        path: pagePath,
        width: viewport.width,
        deploymentKey,
        deploymentId,
        deployedVersion,
      },
    });
    const row = publicRow(db.prepare('SELECT * FROM site_screenshots WHERE id = ?').get(rowId));
    return Object.assign({}, row, {
      deploymentId,
      deployedVersion,
      deploymentKey,
      capturedAt: row.capturedAt,
      cacheHit: false,
    });
  } finally {
    try { await browser.close(); } catch { /* */ }
  }
}

/**
 * Fire-and-forget capture after preview publish. Never throws to caller.
 */
function scheduleCaptureAfterPreview(workspaceId, websiteId, opts = {}) {
  setImmediate(() => {
    Promise.resolve()
      .then(async () => {
        let domain;
        try { domain = require('../server/domain'); } catch { domain = null; }
        if (domain && typeof domain.withDb === 'function') {
          await domain.withDb(workspaceId, async (db) => {
            await captureWebsiteScreenshots(db, websiteId, opts);
          });
        }
      })
      .catch((err) => {
        console.warn('[siteScreenshots] background capture failed:', err && err.message ? err.message : err);
      });
  });
}

module.exports = {
  DESKTOP,
  MOBILE,
  VIEWPORTS,
  EMAIL_MAX_WIDTH,
  EMAIL_JPEG_QUALITY,
  MMS_MAX_DIM,
  MMS_MAX_BYTES,
  ensureTables,
  listScreenshots,
  captureWebsiteScreenshots,
  captureOneScreenshot,
  scheduleCaptureAfterPreview,
  screenshotMergeFields,
  getCurrentEmailShot,
  getCurrentMmsShot,
  checkUrlReady,
  enrichReady,
  resolveCapturePages,
  makeEmailRendition,
  makeMmsRendition,
  publicUrlFor,
  shotFolder,
  publicRow,
};
