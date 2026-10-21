'use strict';

/**
 * Extract and rewrite brand colors found in theme.customCss + page HTML.
 * Used by the client portal Theme bar so freeform sites (hard-coded hexes)
 * can be recolored without relying only on --ws-* CSS variables.
 */

const ROLE_KEYS = ['primary', 'secondary', 'bg', 'text'];
const MAX_PALETTE = 16;

function normalizeHex(value) {
  let s = String(value == null ? '' : value).trim();
  if (!s) return null;
  if (s[0] !== '#') s = `#${s}`;
  if (/^#[0-9a-fA-F]{3}$/.test(s)) {
    s = `#${s[1]}${s[1]}${s[2]}${s[2]}${s[3]}${s[3]}`;
  }
  if (!/^#[0-9a-fA-F]{6}$/.test(s)) return null;
  return s.toLowerCase();
}

function expandShortHexInMatch(m) {
  const h = m[0] === '#' ? m : `#${m}`;
  return normalizeHex(h);
}

function collectHexesFromText(text, into) {
  const src = String(text || '');
  if (!src) return;
  for (const m of src.matchAll(/#([0-9a-f]{3}|[0-9a-f]{6})\b/gi)) {
    const hex = expandShortHexInMatch(`#${m[1]}`);
    if (!hex) continue;
    if (!into.has(hex)) into.set(hex, 0);
    into.set(hex, into.get(hex) + 1);
  }
  for (const m of src.matchAll(/rgba?\(\s*(\d{1,3})\s*,\s*(\d{1,3})\s*,\s*(\d{1,3})/gi)) {
    const to = (n) => Math.max(0, Math.min(255, Number(n))).toString(16).padStart(2, '0');
    const hex = `#${to(m[1])}${to(m[2])}${to(m[3])}`;
    if (!into.has(hex)) into.set(hex, 0);
    into.set(hex, into.get(hex) + 1);
  }
}

function pagesTextBlob(pages) {
  const list = Array.isArray(pages) ? pages : [];
  const parts = [];
  for (const p of list) {
    if (!p || typeof p !== 'object') continue;
    if (typeof p.html === 'string') parts.push(p.html);
    if (Array.isArray(p.sections)) {
      try { parts.push(JSON.stringify(p.sections)); } catch { /* */ }
    }
  }
  return parts.join('\n');
}

function luma(hex) {
  const h = normalizeHex(hex);
  if (!h) return 0;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return (0.2126 * r + 0.7152 * g + 0.0722 * b) / 255;
}

function saturation(hex) {
  const h = normalizeHex(hex);
  if (!h) return 0;
  const r = parseInt(h.slice(1, 3), 16);
  const g = parseInt(h.slice(3, 5), 16);
  const b = parseInt(h.slice(5, 7), 16);
  return Math.max(r, g, b) - Math.min(r, g, b);
}

/**
 * @returns {{ palette: Array<{hex:string, roles:string[], count:number}>, roles: object }}
 */
function extractPalette(pages, theme) {
  const counts = new Map();
  const t = theme && typeof theme === 'object' ? theme : {};
  if (typeof t.customCss === 'string') collectHexesFromText(t.customCss, counts);
  collectHexesFromText(pagesTextBlob(pages), counts);

  const roleHex = {};
  for (const key of ROLE_KEYS) {
    const hex = normalizeHex(t[key]);
    if (hex) roleHex[key] = hex;
  }

  // Always include role colors even if rare in CSS
  for (const hex of Object.values(roleHex)) {
    if (!counts.has(hex)) counts.set(hex, 1);
  }

  const ranked = [...counts.entries()]
    .map(([hex, count]) => ({ hex, count }))
    .sort((a, b) => {
      // Prefer saturated accents, then frequency
      const sat = saturation(b.hex) - saturation(a.hex);
      if (sat) return sat;
      return b.count - a.count || luma(a.hex) - luma(b.hex);
    });

  const palette = [];
  const seen = new Set();
  // Role colors first (stable order)
  for (const key of ROLE_KEYS) {
    const hex = roleHex[key];
    if (!hex || seen.has(hex)) continue;
    seen.add(hex);
    const roles = ROLE_KEYS.filter((k) => roleHex[k] === hex);
    palette.push({ hex, roles, count: counts.get(hex) || 1 });
  }
  for (const item of ranked) {
    if (seen.has(item.hex)) continue;
    // Skip pure black/white extras unless they are role colors (already added)
    if (item.hex === '#000000' || item.hex === '#ffffff') continue;
    seen.add(item.hex);
    palette.push({ hex: item.hex, roles: [], count: item.count });
    if (palette.length >= MAX_PALETTE) break;
  }

  return { palette, roles: roleHex };
}

function rewriteHexMap(text, map) {
  let out = String(text || '');
  if (!out || !map || typeof map !== 'object') return out;
  const entries = Object.entries(map)
    .map(([from, to]) => [normalizeHex(from), normalizeHex(to)])
    .filter(([from, to]) => from && to && from !== to);
  // Longer keys first; avoid double-rewriting by applying one pass with alternation
  for (const [from, to] of entries) {
    const re = new RegExp(from.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
    out = out.replace(re, to);
    // Also rewrite equivalent 3-digit form when unique
    if (/^#([0-9a-f])\1([0-9a-f])\2([0-9a-f])\3$/i.test(from)) {
      const short = `#${from[1]}${from[3]}${from[5]}`;
      const shortRe = new RegExp(short.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'gi');
      out = out.replace(shortRe, to);
    }
  }
  return out;
}

function applyHexMapToPages(pages, map) {
  const list = Array.isArray(pages) ? pages : [];
  let changed = false;
  const next = list.map((page) => {
    if (!page || typeof page !== 'object') return page;
    const p = Object.assign({}, page);
    if (typeof p.html === 'string') {
      const rewritten = rewriteHexMap(p.html, map);
      if (rewritten !== p.html) {
        p.html = rewritten;
        changed = true;
      }
    }
    if (Array.isArray(p.sections)) {
      try {
        const raw = JSON.stringify(p.sections);
        const rewritten = rewriteHexMap(raw, map);
        if (rewritten !== raw) {
          p.sections = JSON.parse(rewritten);
          changed = true;
        }
      } catch { /* keep sections */ }
    }
    return p;
  });
  return { pages: next, changed };
}

/**
 * Build old→new map from role patch + explicit replacements.
 * replacements: [{ from, to }]
 */
function buildReplacementMap(oldTheme, rolePatch, replacements) {
  const map = {};
  const oldNorm = {};
  for (const key of ROLE_KEYS) {
    const hex = normalizeHex(oldTheme && oldTheme[key]);
    if (hex) oldNorm[key] = hex;
  }
  for (const key of ROLE_KEYS) {
    const next = normalizeHex(rolePatch && rolePatch[key]);
    const prev = oldNorm[key];
    if (prev && next && prev !== next) map[prev] = next;
  }
  const list = Array.isArray(replacements) ? replacements : [];
  for (const row of list) {
    const from = normalizeHex(row && (row.from || row.hex || row.old));
    const to = normalizeHex(row && (row.to || row.value || row.new));
    if (from && to && from !== to) map[from] = to;
  }
  return map;
}

module.exports = {
  ROLE_KEYS,
  normalizeHex,
  extractPalette,
  rewriteHexMap,
  applyHexMapToPages,
  buildReplacementMap,
};
