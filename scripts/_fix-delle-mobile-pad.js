'use strict';

/**
 * Delle Donne (#1): add mobile edge padding for header + emergency strip banner.
 * Then force-rematerialize + Cloudflare republish.
 */
const domain = require('../server/domain');
const { openWorkspaceDb } = require('../server/workspaceDb');

const MOBILE_PAD_BLOCK = `
/* === mobile edge padding: header + strip (managed) === */
@media (max-width:820px){
  .wrap{padding-left:max(18px, env(safe-area-inset-left));padding-right:max(18px, env(safe-area-inset-right))}
  .strip{padding-left:0;padding-right:0}
  .strip .wrap{
    padding:10px max(18px, env(safe-area-inset-left)) 10px max(18px, env(safe-area-inset-right));
    gap:8px;
    justify-content:center;
    text-align:center;
    line-height:1.35;
  }
  .strip .wrap span{display:block;max-width:100%;overflow-wrap:anywhere;word-break:break-word}
  header.site .wrap{padding-left:max(16px, env(safe-area-inset-left));padding-right:max(16px, env(safe-area-inset-right))}
  .hbar{
    padding:12px 0;
    gap:10px 12px;
    align-items:center;
  }
  .brand{min-width:0;max-width:100%}
  .brand .bn{font-size:1rem;overflow-wrap:anywhere}
  .brand-logo,[data-ws-logo]{max-height:36px;max-width:min(160px,42vw)}
  nav.main{
    width:100%;
    order:3;
    gap:10px 14px;
    justify-content:flex-start;
    padding:4px 0 2px;
  }
  nav.main a{font-size:.9rem}
  .callbtn{margin-left:auto;padding:8px 12px;font-size:.88rem}
  .hero .wrap{padding-left:max(18px, env(safe-area-inset-left));padding-right:max(18px, env(safe-area-inset-right))}
  .hero-grid{padding:36px 0 48px;gap:22px}
  .hero h1{font-size:1.85rem;overflow-wrap:anywhere}
  .hero p.lede{font-size:1.02rem;max-width:100%}
  .badge-card{left:8px;right:auto;max-width:calc(100% - 24px)}
  .ticker .wrap{padding:12px max(18px, env(safe-area-inset-left));gap:14px 18px;letter-spacing:.1em;font-size:.78rem}
}
/* === end mobile edge padding === */
`.trim();

function stripManagedBlock(css) {
  return String(css || '')
    .replace(/\n?\/\* === mobile edge padding: header \+ strip \(managed\) === \*\/[\s\S]*?\/\* === end mobile edge padding === \*\//g, '')
    .replace(/\s+$/g, '');
}

async function main() {
  const db = openWorkspaceDb(1);
  const row = db.prepare('SELECT id, theme, pages FROM websites WHERE id = 1').get();
  if (!row) throw new Error('site 1 not found');
  const theme = JSON.parse(row.theme || '{}');
  const pages = JSON.parse(row.pages || '[]');
  if (!Array.isArray(pages) || !pages.length) throw new Error('site 1 has no pages');
  const prev = String(theme.customCss || '');
  theme.customCss = `${stripManagedBlock(prev)}\n\n${MOBILE_PAD_BLOCK}\n`;

  const saved = domain.sitesSave(1, 1, {
    pages,
    theme,
    note: 'Mobile padding for header + emergency strip',
  });
  console.log('saved version', saved && saved.version);

  const preview = await domain.sitesPreview(1, 1, { force: true });
  console.log(JSON.stringify({
    url: preview.url,
    via: preview.via,
    project: preview.detail && preview.detail.project,
  }, null, 2));
}

main().catch((e) => {
  console.error(e && e.stack || e);
  process.exit(1);
});
