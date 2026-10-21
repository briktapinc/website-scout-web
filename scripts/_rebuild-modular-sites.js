/**
 * Rebuild sites as clean modular section stacks (no freeform page.html).
 * Uses industry templates + lead facts, saves via domain.sitesSave so
 * /site-previews + design deliverables stay in sync with the portal.
 *
 * Usage: node scripts/_rebuild-modular-sites.js
 */
const Database = require('better-sqlite3');
const engine = require('../src/websiteEngine');
const domain = require('../server/domain');

const DB = process.env.WS_DB || '/app/data/workspaces/1/websitescout.db';
const WORKSPACE_ID = Number(process.env.WS_WORKSPACE_ID || 1);
const SITE_IDS = (process.env.WS_SITE_IDS || '1,2,3')
  .split(',')
  .map((s) => Number(s.trim()))
  .filter((n) => Number.isInteger(n) && n > 0);

function syncDesignDeliverable(db, leadId, siteId, pages, theme) {
  try {
    const job = db.prepare(
      `SELECT id, website_id, deliverable FROM design_jobs
       WHERE lead_id = ? AND (website_id = ? OR website_id IS NULL)
       ORDER BY CASE WHEN website_id = ? THEN 0 ELSE 1 END, id DESC LIMIT 1`
    ).get(Number(leadId), Number(siteId), Number(siteId));
    if (!job || !job.deliverable) return;
    let payload;
    try { payload = JSON.parse(job.deliverable); } catch { return; }
    if (!payload || typeof payload !== 'object') return;
    payload.pages = pages;
    payload.theme = theme;
    payload.name = payload.name || undefined;
    db.prepare(
      `UPDATE design_jobs SET deliverable = ?, website_id = ?, updated_at = datetime('now') WHERE id = ?`
    ).run(JSON.stringify(payload), Number(siteId), job.id);
    console.log('synced design_job', job.id);
  } catch (e) {
    console.warn('design sync', e.message || e);
  }
}

async function rebuildOne(db, siteId) {
  const row = db.prepare('SELECT * FROM websites WHERE id = ?').get(siteId);
  if (!row) {
    console.log('skip missing site', siteId);
    return null;
  }
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(row.lead_id);
  if (!lead) {
    console.log('skip site', siteId, 'no lead');
    return null;
  }

  const industry = engine.detectIndustry(lead.category);
  const facts = engine.collectFacts(db, lead);
  let copy;
  let aiUsed = false;
  try {
    const ai = require('../src/ai');
    ai.setDb(db);
    if (ai.aiConfigured && ai.aiConfigured()) {
      // Prefer deterministic for predictable modular rebuilds
    }
  } catch { /* */ }
  copy = engine.deterministicCopy(lead, industry, facts);

  const built = engine.buildPages(lead, industry, facts, copy, aiUsed);
  const pages = built.pages;
  // Showcase new layout modules on home (after hero).
  const home = pages[0];
  if (home && Array.isArray(home.sections)) {
    const heroAt = home.sections.findIndex((s) => s && s.type === 'hero');
    const at = heroAt >= 0 ? heroAt + 1 : 1;
    const layoutBlocks = [
      {
        type: 'columns',
        content: {
          title: 'Why choose us',
          cols: 3,
          cells: [
            { heading: 'Local', body: `Proudly serving ${lead.city || 'the community'}.` },
            { heading: 'Trusted', body: 'Clear communication and careful workmanship.' },
            { heading: 'Ready to help', body: lead.phone ? `Call ${lead.phone}.` : 'Reach out today.' },
          ],
        },
      },
      {
        type: 'text_image',
        content: {
          heading: 'About our work',
          body: copy && copy.about
            ? String(Array.isArray(copy.about) ? copy.about[0] : copy.about).slice(0, 280)
            : `${lead.business_name} is ready to help.`,
          image_position: 'right',
        },
      },
      {
        type: 'cards',
        content: {
          title: 'What we offer',
          cols: 3,
          items: (Array.isArray(copy && copy.services) ? copy.services : [])
            .slice(0, 3)
            .map((s) => ({
              title: (s && (s.name || s.title)) || 'Service',
              text: (s && (s.description || s.text)) || 'Ask us for details.',
            })),
        },
      },
    ];
    if (!layoutBlocks[2].content.items.length) {
      layoutBlocks[2].content.items = [
        { title: 'Quality work', text: 'Done right the first time.' },
        { title: 'Fair pricing', text: 'Clear estimates before we start.' },
        { title: 'Local team', text: `Based in ${lead.city || 'your area'}.` },
      ];
    }
    home.sections.splice(at, 0, ...layoutBlocks);
  }

  let theme = engine.normalizeTheme(
    Object.assign({}, (engine.TEMPLATES[industry] || engine.TEMPLATES.general).theme, { baseCss: true })
  );

  // Preserve logo from previous theme if present
  try {
    const prev = JSON.parse(row.theme || '{}') || {};
    if (prev.logoMode) theme.logoMode = prev.logoMode;
    if (prev.logoUrl) theme.logoUrl = prev.logoUrl;
    if (prev.primary) theme.primary = prev.primary;
    if (prev.secondary) theme.secondary = prev.secondary;
  } catch { /* */ }

  // Save through domain so export folder rematerializes for portal
  const saved = domain.sitesSave(WORKSPACE_ID, siteId, {
    pages,
    theme,
    note: 'Rebuild: clean modular sections (template)',
  });
  db.prepare(`UPDATE websites SET origin = 'template', updated_at = datetime('now') WHERE id = ?`).run(siteId);
  syncDesignDeliverable(db, lead.id, siteId, pages, theme);

  const types = [...new Set(pages.flatMap((p) => (p.sections || []).map((s) => s.type)))];
  console.log(JSON.stringify({
    id: siteId,
    lead: lead.business_name,
    industry,
    pages: pages.length,
    sectionTypes: types,
    version: saved && saved.version,
  }));
  return { siteId, pages: pages.length };
}

async function main() {
  const db = new Database(DB);
  engine.ensureTables(db);
  console.log('DB', DB, 'sites', SITE_IDS.join(','));

  for (const id of SITE_IDS) {
    await rebuildOne(db, id);
  }
  db.close();

  // Publish Cloudflare previews so public URL matches portal export
  for (const id of SITE_IDS) {
    try {
      const r = await domain.sitesPreview(WORKSPACE_ID, id, { force: true });
      console.log('published', id, r && (r.url || r.previewUrl || r));
    } catch (e) {
      console.warn('publish', id, e.message || e);
    }
  }
  console.log('done');
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
