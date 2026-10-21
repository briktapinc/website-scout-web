'use strict';
const Database = require('better-sqlite3');
const db = new Database('/app/data/workspaces/1/websitescout.db', { readonly: true });

for (const id of [1, 2, 3]) {
  const row = db.prepare('SELECT id, lead_id, name, preview_url, pages FROM websites WHERE id=?').get(id);
  if (!row) { console.log('missing', id); continue; }
  const pages = JSON.parse(row.pages || '[]');
  console.log('=== site', id, row.name, 'lead', row.lead_id, 'pages', pages.length);
  console.log('preview', row.preview_url);
  for (const p of pages) {
    const secs = (p.sections || []).map((s) => {
      let t = s.type || '?';
      if (s.content && s.content.bitpype_module_managed) t += '*mod';
      if (s.content && s.content.html && /bitpype-module/.test(s.content.html)) t += '*emb';
      if (s.content && s.content.html && /module-embed\.js/.test(s.content.html)) t += '*js';
      if (s.type === 'nav' && s.content && s.content.html) t += '*chrome';
      if (s.type === 'footer' && s.content && s.content.html) t += '*chrome';
      return t;
    }).join(',');
    const html = String(p.html || '');
    const mods = (html.match(/bitpype-module-embed/g) || []).length;
    const scripts = (html.match(/module-embed\.js/g) || []).length;
    const hasHtml = html.trim().length > 0;
    const secLen = (p.sections || []).length;
    console.log(
      ' ',
      p.slug,
      'secs', secLen, '[' + secs + ']',
      'htmlLen', html.length,
      'htmlMods', mods,
      'htmlScripts', scripts,
      'hybrid', hasHtml && secLen > 0,
      'navVis', p.navVisible
    );
  }
  const embeds = db.prepare(
    `SELECT module_type, published, embed_enabled, target_page_slug,
            substr(public_token,1,16) AS t
     FROM site_module_embeds WHERE lead_id=?`
  ).all(row.lead_id);
  console.log(' embeds', JSON.stringify(embeds));
}
db.close();
