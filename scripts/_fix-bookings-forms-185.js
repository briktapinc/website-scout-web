'use strict';

/**
 * Fix + verify lead 185 / site 5 /book after bookings form bugs deploy.
 * - Mark bookings companion as provisioned
 * - Set show_request_form=false (widget only)
 * - Delete appointment companion forms (or disable embed)
 * - Export twice and assert no re-provision / single interactive form on /book
 */
const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');

const LEAD_ID = 185;
const SITE_ID = 5;

function walk(dir, out = []) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); } catch { return out; }
  for (const e of entries) {
    const p = path.join(dir, e.name);
    if (e.isDirectory()) {
      if (['node_modules', '.git', 'exports', 'site-previews'].includes(e.name)) continue;
      walk(p, out);
    } else if (/\.(sqlite|db)$/i.test(e.name)) out.push(p);
  }
  return out;
}

function findDb() {
  const roots = ['/app/data', '/app/workspaces', '/data', '/app'];
  const dbs = [];
  for (const r of roots) walk(r, dbs);
  for (const dbPath of dbs) {
    try {
      const db = new Database(dbPath, { readonly: true });
      const lead = db.prepare('SELECT id, business_name FROM leads WHERE id = ?').get(LEAD_ID);
      const site = db.prepare('SELECT id, lead_id FROM websites WHERE id = ?').get(SITE_ID);
      db.close();
      if (lead && site && Number(site.lead_id) === LEAD_ID) return dbPath;
      if (lead) return dbPath;
    } catch { /* skip */ }
  }
  throw new Error('Could not find workspace DB containing lead 185');
}

function main() {
  const dbPath = findDb();
  console.log('db', dbPath);
  const db = new Database(dbPath);
  const forms = require('/app/server/contactForms');
  const modules = require('/app/server/siteModules');
  const domain = require('/app/server/domain');

  forms.ensureTables(db);
  modules.ensureTables(db);

  const lead = db.prepare('SELECT id, business_name FROM leads WHERE id = ?').get(LEAD_ID);
  console.log('lead', lead);

  const site = db.prepare(
    'SELECT id, lead_id FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1'
  ).get(LEAD_ID);
  console.log('site', site);
  const siteId = site ? site.id : SITE_ID;

  // Infer workspaceId from a public token if present
  let workspaceId = null;
  const tokRow = db.prepare(
    "SELECT public_token FROM site_module_embeds WHERE lead_id = ? AND public_token LIKE '%\\_%' ESCAPE '\\' LIMIT 1"
  ).get(LEAD_ID) || db.prepare(
    "SELECT public_token FROM contact_forms WHERE lead_id = ? AND public_token LIKE '%\\_%' ESCAPE '\\' LIMIT 1"
  ).get(LEAD_ID);
  if (tokRow && tokRow.public_token) {
    const m = String(tokRow.public_token).match(/^(\d+)_/);
    if (m) workspaceId = Number(m[1]);
  }
  if (!workspaceId) {
    // fallback: parse db path ws-N
    const m = dbPath.match(/workspace[_-]?(\d+)/i) || dbPath.match(/\/(\d+)\//);
    if (m) workspaceId = Number(m[1]);
  }
  console.log('workspaceId', workspaceId);

  let emb = modules.getEmbedRow(db, LEAD_ID, 'bookings');
  console.log('bookings before', emb && modules.publicEmbed(emb));

  // Mark provisioned + show_request_form false (widget only for North Harbor /book)
  if (emb) {
    modules.writeEmbedSettings(db, emb.id, {
      show_request_form: false,
      appointment_form_provisioned: true,
    });
    emb = modules.getEmbedRow(db, LEAD_ID, 'bookings');
  }

  // Delete companion appointment forms (keep at least one non-appointment form)
  const list = forms.listFormRows(db, LEAD_ID);
  console.log('forms before', list.map((f) => ({
    id: f.id, name: f.name, kind: f.form_kind, embed: f.embed_enabled, slug: f.target_page_slug,
  })));

  for (const row of list) {
    const kind = row.form_kind || (/appoint|book|schedule/i.test(String(row.name || '')) ? 'appointment' : null);
    if (kind !== 'appointment') continue;
    try {
      forms.deleteForm(db, LEAD_ID, row.id);
      console.log('deleted appointment form', row.id);
    } catch (e) {
      // last form — disable embed instead
      forms.saveForm(db, LEAD_ID, row.id, { embed_enabled: false, embed_on_page: false });
      console.log('disabled appointment form', row.id, e.message);
    }
  }

  // Prove embed_enabled write sticks
  const remaining = forms.listFormRows(db, LEAD_ID);
  if (remaining[0]) {
    const id = remaining[0].id;
    forms.saveForm(db, LEAD_ID, id, { embed_enabled: false });
    const afterOff = forms.getFormById(db, LEAD_ID, id);
    console.log('embed_enabled after false', afterOff.embed_enabled, afterOff.embed_on_page);
    forms.saveForm(db, LEAD_ID, id, { embed_enabled: true });
    const afterOn = forms.getFormById(db, LEAD_ID, id);
    console.log('embed_enabled after true', afterOn.embed_enabled);
  }

  // Export twice — must not recreate appointment form
  if (workspaceId) {
    domain.materializeWebsiteExport(db, workspaceId, siteId);
    domain.materializeWebsiteExport(db, workspaceId, siteId);
  } else {
    forms.ensureSiteForms(db, LEAD_ID, { workspaceId: 1, missingOnly: true });
    forms.syncSiteFormEmbeds(db, LEAD_ID);
    forms.ensureSiteForms(db, LEAD_ID, { workspaceId: 1, missingOnly: true });
    forms.syncSiteFormEmbeds(db, LEAD_ID);
  }

  const after = forms.listFormsForLead(db, LEAD_ID);
  const appts = after.filter((f) => f.form_kind === 'appointment'
    || /appointment\s*request/i.test(String(f.name || '')));
  console.log('forms after 2x export', after.map((f) => ({
    id: f.id, name: f.name, kind: f.form_kind, embed: f.embed_enabled, slug: f.target_page_slug,
  })));
  console.log('appointment forms count', appts.length);

  const pages = JSON.parse(
    db.prepare('SELECT pages FROM websites WHERE id = ?').get(siteId).pages || '[]'
  );
  const book = pages.find((p) => String(p.slug || '').replace(/^\//, '') === 'book');
  const html = book
    ? (typeof book.html === 'string' ? book.html
      : (book.sections || []).map((s) => (s && s.content && s.content.html) || '').join('\n'))
    : '';
  const formPanels = (html.match(/bitpype-form-embed|bitpype-form-panel/gi) || []).length;
  const moduleEmbeds = (html.match(/bitpype-module-embed|data-bitpype-module-token/gi) || []).length;
  const formScripts = (html.match(/form-embed\.js/gi) || []).length;
  console.log('book page', {
    found: !!book,
    formPanels,
    moduleEmbeds,
    formScripts,
    htmlLen: html.length,
  });

  emb = modules.getEmbedRow(db, LEAD_ID, 'bookings');
  console.log('bookings settings', modules.parseEmbedSettings(emb));

  const ok = appts.length === 0 && formPanels === 0 && moduleEmbeds > 0;
  console.log(ok ? 'VERIFY_OK' : 'VERIFY_FAIL');
  if (!ok) process.exitCode = 1;
  db.close();
}

main();
