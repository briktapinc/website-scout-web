'use strict';

const Database = require('better-sqlite3');
const path = require('path');

const dbPath = process.env.WS_DB || path.join('/app/data/workspaces/1/websitescout.db');
const db = new Database(dbPath, { readonly: true });

const sites = db.prepare(
  `SELECT id, lead_id, name, preview_url FROM websites ORDER BY id DESC LIMIT 8`
).all();

for (const s of sites) {
  const row = db.prepare('SELECT pages FROM websites WHERE id = ?').get(s.id);
  let pages = [];
  try { pages = JSON.parse(row.pages); } catch { /* */ }
  const summary = (pages || []).map((p, i) => ({
    i,
    slug: p.slug,
    title: p.title,
    hasHtml: !!(p.html && String(p.html).trim()),
    htmlLen: p.html ? String(p.html).length : 0,
    sections: Array.isArray(p.sections) ? p.sections.length : 0,
    fullDoc: p.html ? /^\s*(<!doctype|<html)/i.test(p.html) : false,
  }));
  console.log(JSON.stringify({
    id: s.id,
    name: s.name,
    lead_id: s.lead_id,
    preview_url: s.preview_url,
    pages: summary,
  }, null, 2));
}

const leads = db.prepare(
  `SELECT id, business_name, email FROM leads
   WHERE business_name LIKE '%Delle%' OR business_name LIKE '%Electric%'
   OR email LIKE '%portal-smoke%' LIMIT 20`
).all();
console.log('leads', JSON.stringify(leads, null, 2));
