'use strict';

/**
 * Verify portal freeform inline edit for workspace 1 / Delle Donne (or latest site).
 * Runs inside the app container (has DB + module paths).
 */
const portal = require('../server/clientPortal');
const engine = require('../src/websiteEngine');
const { openWorkspaceDb } = require('../server/workspaceDb');

async function main() {
  const workspaceId = 1;
  const db = openWorkspaceDb(workspaceId);
  const site = db.prepare(
    `SELECT id, lead_id, name, pages FROM websites WHERE lead_id IS NOT NULL ORDER BY id DESC LIMIT 1`
  ).get();
  if (!site) throw new Error('No site');

  let pages = [];
  try { pages = JSON.parse(site.pages); } catch { /* */ }
  const freeform = pages.some((p) => p.html && String(p.html).trim());
  const sections = pages.some((p) => Array.isArray(p.sections) && p.sections.length);

  const rendered = portal.renderClientSite(workspaceId, site.lead_id, { editable: true });
  const markerCount = (rendered.html.match(/data-edit="/g) || []).length;
  const freeMarkers = (rendered.html.match(/data-edit="html:/g) || []).length;
  const hasEditScript = /contentEditable|data-edit/.test(rendered.html)
    && rendered.html.includes('ws-preview');
  const hasEditModeToggle = rendered.html.includes('ws-portal')
    && rendered.html.includes('edit-mode')
    && rendered.html.includes('ws-editing');

  // Dry-run apply on a copy: tweak first freeform text node if present
  let applyOk = null;
  if (freeform && freeMarkers > 0) {
    const before = pages[0].html;
    const next = engine.applyFreeformTextEdits(before, new Map([[0, 'PORTAL_EDIT_PROBE_HEADLINE']]));
    applyOk = next.includes('PORTAL_EDIT_PROBE_HEADLINE') && next !== before;
  }

  console.log(JSON.stringify({
    ok: true,
    siteId: site.id,
    name: site.name,
    leadId: site.lead_id,
    freeform,
    sections,
    editable: rendered.editable,
    freeformFlag: rendered.freeform,
    markerCount,
    freeMarkers,
    hasEditScript,
    hasEditModeToggle,
    htmlLen: (rendered.html || '').length,
    applyDryRunOk: applyOk,
    previewUrl: rendered.previewUrl,
  }, null, 2));

  if (!rendered.editable) throw new Error('expected editable=true for freeform site');
  if (freeform && freeMarkers < 5) throw new Error(`expected freeform markers, got ${freeMarkers}`);
  if (!hasEditScript) throw new Error('missing edit script wiring');
  if (!hasEditModeToggle) throw new Error('missing edit-mode toggle in preview HTML');
  if (freeform && applyOk === false) throw new Error('apply dry-run failed');
}

main().catch((e) => {
  console.error(JSON.stringify({ ok: false, error: e.message, stack: e.stack }));
  process.exit(1);
});
