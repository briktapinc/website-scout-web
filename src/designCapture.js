'use strict';

/**
 * Capture rendered screenshots of a delivered website for visual review.
 * Requires Electron (desktop app). MCP-only node processes skip capture.
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const engine = require('./websiteEngine');

const VIEWPORTS = [
  { name: 'mobile', width: 390, height: 844 },
  { name: 'desktop', width: 1280, height: 900 },
];
const MAX_PAGES = 3;
const LOAD_MS = 2500;

function fail(code, message) {
  const e = new Error(message);
  e.code = code;
  return e;
}

function electronApi() {
  try {
    const electron = require('electron');
    if (!electron || !electron.app || !electron.BrowserWindow) return null;
    if (!electron.app.isReady || !electron.app.isReady()) return null;
    return electron;
  } catch {
    return null;
  }
}

function outDirFor(jobId) {
  const base = process.env.WS_DB_PATH
    ? path.dirname(process.env.WS_DB_PATH)
    : path.join(process.env.APPDATA || path.join(os.homedir(), 'AppData', 'Roaming'), 'website-scout');
  return path.join(base, 'review-shots', `job-${jobId}`);
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function loadHtmlFile(win, htmlPath) {
  // loadFile already resolves on did-finish-load; only race a timeout + fail.
  let timer = null;
  let onFail = null;
  try {
    await Promise.race([
      win.loadFile(htmlPath),
      new Promise((_, reject) => {
        timer = setTimeout(() => reject(new Error('load timeout')), 20000);
        onFail = (_e, code, desc) => reject(new Error(`load failed ${code}: ${desc}`));
        win.webContents.once('did-fail-load', onFail);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    if (onFail) {
      try { win.webContents.removeListener('did-fail-load', onFail); } catch { /* ignore */ }
    }
  }
}

/**
 * @returns {Promise<{ available: boolean, reason?: string, shots: Array<{page,viewport,path,dataUrl}> }>}
 */
async function captureDesignScreenshots(pages, theme, jobId, opts = {}) {
  const electron = electronApi();
  if (!electron) {
    return {
      available: false,
      reason: 'Screenshots need the desktop app (Electron). HTML-only review used instead.',
      shots: [],
    };
  }

  const list = Array.isArray(pages) ? pages.slice(0, opts.maxPages || MAX_PAGES) : [];
  if (!list.length) {
    return { available: false, reason: 'No pages to capture.', shots: [] };
  }

  const dir = outDirFor(jobId);
  fs.mkdirSync(dir, { recursive: true });
  // Clear prior shots for this job
  for (const f of fs.readdirSync(dir)) {
    if (/\.png$/i.test(f)) {
      try { fs.unlinkSync(path.join(dir, f)); } catch { /* ignore */ }
    }
  }

  const htmlDir = path.join(dir, 'html');
  fs.mkdirSync(htmlDir, { recursive: true });
  const shots = [];
  const { BrowserWindow, app } = electron;
  // Hidden capture windows must not quit the app when destroyed (Windows/Linux).
  const holdOpen = () => {};
  app.on('window-all-closed', holdOpen);

  try {
  for (let i = 0; i < list.length; i++) {
    const page = list[i];
    const slug = String(page.slug || page.title || `page-${i + 1}`)
      .replace(/[^\w.-]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 40) || `page-${i + 1}`;

    let html;
    try {
      html = engine.renderPageAt(pages, theme || {}, { pageIndex: i });
    } catch {
      try {
        html = engine.renderSite([page], theme || {});
      } catch (e) {
        continue;
      }
    }

    const htmlPath = path.join(htmlDir, `${slug}.html`);
    fs.writeFileSync(htmlPath, html, 'utf8');

    for (const vp of VIEWPORTS) {
      let win = null;
      try {
        win = new BrowserWindow({
          width: vp.width,
          height: vp.height,
          show: false,
          paintWhenInitiallyHidden: true,
          webPreferences: {
            offscreen: false,
            sandbox: true,
            contextIsolation: true,
            nodeIntegration: false,
          },
        });
        await loadHtmlFile(win, htmlPath);
        await wait(opts.settleMs != null ? opts.settleMs : LOAD_MS);
        // Scroll to top for consistent hero capture
        await win.webContents.executeJavaScript('window.scrollTo(0,0)').catch(() => {});
        const image = await win.webContents.capturePage();
        const png = image.toPNG();
        const fileName = `${slug}-${vp.name}.png`;
        const filePath = path.join(dir, fileName);
        fs.writeFileSync(filePath, png);
        const dataUrl = `data:image/png;base64,${png.toString('base64')}`;
        shots.push({
          page: slug,
          viewport: vp.name,
          width: vp.width,
          height: vp.height,
          path: filePath,
          dataUrl,
        });
      } catch (e) {
        shots.push({
          page: slug,
          viewport: vp.name,
          error: e.message || String(e),
        });
      } finally {
        if (win && !win.isDestroyed()) {
          try { win.destroy(); } catch { /* ignore */ }
        }
      }
    }
  }

  return {
    available: shots.some((s) => s.dataUrl),
    reason: shots.some((s) => s.dataUrl) ? undefined : 'Capture failed for all viewports.',
    shots: shots.filter((s) => s.dataUrl || s.error),
    dir,
  };
  } finally {
    try { app.removeListener('window-all-closed', holdOpen); } catch { /* ignore */ }
  }
}

/** Compact metadata for JSON storage (no giant base64). */
function shotsMeta(capture) {
  if (!capture || !capture.shots) return [];
  return capture.shots
    .filter((s) => s.path)
    .map((s) => ({
      page: s.page,
      viewport: s.viewport,
      width: s.width,
      height: s.height,
      path: s.path,
    }));
}

module.exports = {
  captureDesignScreenshots,
  shotsMeta,
  outDirFor,
  VIEWPORTS,
  electronApi,
};
