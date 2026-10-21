'use strict';

/**
 * Walk modular page content including column cells so token/presence scans
 * see widgets placed via website.addBlock({ cellIndex }).
 */

function forEachContentBlob(pages, visit) {
  const list = Array.isArray(pages) ? pages : [];
  for (const page of list) {
    if (!page || typeof page !== 'object') continue;
    if (typeof page.html === 'string') visit(page.html, { page, kind: 'page.html' });
    if (typeof page.customJs === 'string') visit(page.customJs, { page, kind: 'page.customJs' });
    const sections = Array.isArray(page.sections) ? page.sections : [];
    for (const sec of sections) {
      if (!sec || !sec.content || typeof sec.content !== 'object') continue;
      const c = sec.content;
      if (typeof c.html === 'string') visit(c.html, { page, section: sec, kind: 'section.html' });
      if (typeof c.bitpype_embed_html === 'string') {
        visit(c.bitpype_embed_html, { page, section: sec, kind: 'section.embed' });
      }
      const cells = Array.isArray(c.cells) ? c.cells
        : (Array.isArray(c.columns) ? c.columns : []);
      for (let i = 0; i < cells.length; i++) {
        const cell = cells[i];
        if (!cell || typeof cell !== 'object') continue;
        if (typeof cell.html === 'string') {
          visit(cell.html, { page, section: sec, cell, cellIndex: i, kind: 'cell.html' });
        }
        if (cell.widget && typeof cell.widget === 'object') {
          const w = cell.widget;
          const tok = String(w.public_token || w.publicToken || w.form_token || w.formToken || '').trim();
          if (tok) visit(`token:${tok}`, { page, section: sec, cell, cellIndex: i, kind: 'cell.widget', widget: w });
          if (typeof w.html === 'string') {
            visit(w.html, { page, section: sec, cell, cellIndex: i, kind: 'cell.widget.html' });
          }
        }
      }
    }
  }
}

function pagesBlobHas(pages, predicate) {
  let hit = false;
  forEachContentBlob(pages, (blob, ctx) => {
    if (hit) return;
    if (predicate(blob, ctx)) hit = true;
  });
  return hit;
}

/** Collect token strings from typed site_module / form sections + cell widgets. */
function collectTypedTokens(pages, { module = true, form = true } = {}) {
  const out = new Set();
  for (const page of pages || []) {
    for (const sec of (page && page.sections) || []) {
      if (!sec || !sec.content) continue;
      const t = String(sec.type || '').toLowerCase();
      const c = sec.content;
      if (module && (t === 'site_module' || t === 'module')) {
        const tok = String(c.public_token || c.publicToken || '').trim();
        if (tok) out.add(tok);
      }
      if (form && (t === 'form' || t === 'bitpype_form' || t === 'contact_form')) {
        const tok = String(c.form_token || c.bitpype_form_token || '').trim();
        if (tok) out.add(tok);
      }
      const cells = Array.isArray(c.cells) ? c.cells : [];
      for (const cell of cells) {
        if (!cell || !cell.widget) continue;
        const w = cell.widget;
        const wt = String(w.type || w.blockType || '').toLowerCase();
        if (module && (wt === 'site_module' || wt === 'module')) {
          const tok = String(w.public_token || w.publicToken || '').trim();
          if (tok) out.add(tok);
        }
        if (form && (wt === 'form' || wt === 'bitpype_form')) {
          const tok = String(w.form_token || w.formToken || '').trim();
          if (tok) out.add(tok);
        }
      }
    }
  }
  return out;
}

module.exports = {
  forEachContentBlob,
  pagesBlobHas,
  collectTypedTokens,
};
