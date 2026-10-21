'use strict';

/**
 * Curated Lucide-style icons (inline SVG, no webfont).
 * Service + brand set for website sections / design.deliver validation.
 */

const SERVICE_ICONS = [
  'globe', 'phone', 'mail', 'calendar', 'chat', 'star', 'chart', 'camera',
  'video', 'map-pin', 'clock', 'shield', 'zap', 'users', 'check',
];

const BRAND_ICONS = [
  'instagram', 'tiktok', 'facebook', 'youtube', 'x', 'linkedin', 'google',
];

/** @type {Record<string, { brand?: boolean, paths: string[], circle?: boolean }>} */
const ICON_PATHS = {
  // Lucide-inspired stroke icons (24×24)
  globe: {
    paths: [
      'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z',
      'M2 12h20',
      'M12 2a15.3 15.3 0 0 1 4 10 15.3 15.3 0 0 1-4 10 15.3 15.3 0 0 1-4-10 15.3 15.3 0 0 1 4-10z',
    ],
  },
  phone: {
    paths: [
      'M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z',
    ],
  },
  mail: {
    paths: [
      'M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z',
      'm22 6-10 7L2 6',
    ],
  },
  calendar: {
    paths: [
      'M8 2v4', 'M16 2v4',
      'M3 10h18',
      'M5 4h14a2 2 0 0 1 2 2v14a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V6a2 2 0 0 1 2-2z',
    ],
  },
  chat: {
    paths: [
      'M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z',
    ],
  },
  star: {
    paths: [
      'M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z',
    ],
  },
  chart: {
    paths: [
      'M3 3v18h18',
      'M18 17V9',
      'M13 17V5',
      'M8 17v-3',
    ],
  },
  camera: {
    paths: [
      'M23 19a2 2 0 0 1-2 2H3a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h4l2-3h6l2 3h4a2 2 0 0 1 2 2z',
      'M12 17a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
    ],
  },
  video: {
    paths: [
      'M23 7l-7 5 7 5V7z',
      'M14 5H3a2 2 0 0 0-2 2v10a2 2 0 0 0 2 2h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2z',
    ],
  },
  'map-pin': {
    paths: [
      'M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z',
      'M12 13a3 3 0 1 0 0-6 3 3 0 0 0 0 6z',
    ],
  },
  clock: {
    paths: [
      'M12 22c5.523 0 10-4.477 10-10S17.523 2 12 2 2 6.477 2 12s4.477 10 10 10z',
      'M12 6v6l4 2',
    ],
  },
  shield: {
    paths: [
      'M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z',
    ],
  },
  zap: {
    paths: [
      'M13 2L3 14h9l-1 8 10-12h-9l1-8z',
    ],
  },
  users: {
    paths: [
      'M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2',
      'M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
      'M23 21v-2a4 4 0 0 0-3-3.87',
      'M16 3.13a4 4 0 0 1 0 7.75',
    ],
  },
  check: {
    paths: [
      'M20 6L9 17l-5-5',
    ],
  },
  // Brand (filled-ish simple marks)
  instagram: {
    brand: true,
    paths: [
      'M7 2h10a5 5 0 0 1 5 5v10a5 5 0 0 1-5 5H7a5 5 0 0 1-5-5V7a5 5 0 0 1 5-5z',
      'M12 16a4 4 0 1 0 0-8 4 4 0 0 0 0 8z',
      'M17.5 6.5h.01',
    ],
  },
  tiktok: {
    brand: true,
    paths: [
      'M9 12a4 4 0 1 0 4 4V4a5 5 0 0 0 5 5',
    ],
  },
  facebook: {
    brand: true,
    paths: [
      'M18 2h-3a5 5 0 0 0-5 5v3H7v4h3v8h4v-8h3l1-4h-4V7a1 1 0 0 1 1-1h3z',
    ],
  },
  youtube: {
    brand: true,
    paths: [
      'M22.54 6.42a2.78 2.78 0 0 0-1.95-1.96C18.88 4 12 4 12 4s-6.88 0-8.59.46A2.78 2.78 0 0 0 1.46 6.42 29 29 0 0 0 1 12a29 29 0 0 0 .46 5.58A2.78 2.78 0 0 0 3.41 19.5C5.12 20 12 20 12 20s6.88 0 8.59-.46a2.78 2.78 0 0 0 1.95-1.95A29 29 0 0 0 23 12a29 29 0 0 0-.46-5.58z',
      'M9.75 15.02L15.5 12 9.75 8.98v6.04z',
    ],
  },
  x: {
    brand: true,
    paths: [
      'M4 4l16 16',
      'M20 4L4 20',
    ],
  },
  linkedin: {
    brand: true,
    paths: [
      'M16 8a6 6 0 0 1 6 6v7h-4v-7a2 2 0 0 0-4 0v7h-4v-7a6 6 0 0 1 6-6z',
      'M2 9h4v12H2z',
      'M4 6a2 2 0 1 0 0-4 2 2 0 0 0 0 4z',
    ],
  },
  google: {
    brand: true,
    paths: [
      'M12 11v2.4h5.4c-.2 1.3-1.6 3.8-5.4 3.8A6.2 6.2 0 1 1 12 5.8a5.5 5.5 0 0 1 3.9 1.5l2.6-2.5A9.3 9.3 0 0 0 12 2a10 10 0 1 0 0 20c5.8 0 9.6-4.1 9.6-9.8 0-.7-.1-1.2-.2-1.7H12z',
    ],
  },
};

const ALL_NAMES = new Set([...SERVICE_ICONS, ...BRAND_ICONS]);

const NETWORK_TO_ICON = {
  instagram: 'instagram',
  ig: 'instagram',
  tiktok: 'tiktok',
  facebook: 'facebook',
  fb: 'facebook',
  youtube: 'youtube',
  yt: 'youtube',
  x: 'x',
  twitter: 'x',
  linkedin: 'linkedin',
  google: 'google',
  gmb: 'google',
};

function normalizeIconName(name) {
  const s = String(name || '').trim().toLowerCase().replace(/_/g, '-');
  if (!s) return '';
  if (ALL_NAMES.has(s)) return s;
  if (NETWORK_TO_ICON[s]) return NETWORK_TO_ICON[s];
  return s;
}

function isKnownIcon(name) {
  const n = normalizeIconName(name);
  return ALL_NAMES.has(n);
}

function listIconNames() {
  return { service: SERVICE_ICONS.slice(), brand: BRAND_ICONS.slice() };
}

function renderIconSvg(name, opts = {}) {
  const n = normalizeIconName(name);
  const def = ICON_PATHS[n];
  if (!def) return '';
  const label = opts.label != null ? String(opts.label) : n;
  const brand = !!def.brand;
  const cls = brand ? 'ws-icon ws-icon-brand' : 'ws-icon';
  const paths = def.paths.map((d) => `<path d="${d}"></path>`).join('');
  if (brand) {
    return `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" aria-hidden="true" focusable="false" data-ws-icon="${n}" role="img"><title>${escapeXml(label)}</title>${paths}</svg>`;
  }
  return `<svg class="${cls}" viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true" focusable="false" data-ws-icon="${n}" role="img"><title>${escapeXml(label)}</title>${paths}</svg>`;
}

function escapeXml(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function iconForNetwork(network) {
  return NETWORK_TO_ICON[String(network || '').trim().toLowerCase()] || '';
}

/**
 * Walk pages/sections and collect icon name usages for validation.
 * Returns [{ path, name }] for every icon-like field found.
 */
function collectIconUsages(pages) {
  const out = [];
  const list = Array.isArray(pages) ? pages : [];
  list.forEach((page, pi) => {
    const sections = Array.isArray(page && page.sections) ? page.sections : [];
    sections.forEach((sec, si) => {
      const c = (sec && sec.content) || {};
      const base = `pages[${pi}].sections[${si}]`;
      if (c.icon) out.push({ path: `${base}.content.icon`, name: c.icon });
      ['items', 'reviews', 'links'].forEach((key) => {
        if (!Array.isArray(c[key])) return;
        c[key].forEach((it, i) => {
          if (!it || typeof it !== 'object') return;
          if (it.icon) out.push({ path: `${base}.content.${key}[${i}].icon`, name: it.icon });
          if (it.network) {
            const mapped = iconForNetwork(it.network);
            if (mapped) out.push({ path: `${base}.content.${key}[${i}].network`, name: mapped });
            else out.push({ path: `${base}.content.${key}[${i}].network`, name: it.network });
          }
        });
      });
    });
  });
  return out;
}

/**
 * Throws { code: 'INVALID_ICON', message } if any unknown icon names are used.
 */
function assertKnownIcons(pages) {
  const bad = [];
  for (const u of collectIconUsages(pages)) {
    if (!isKnownIcon(u.name)) {
      bad.push(`${u.path}: unknown icon "${u.name}"`);
    }
  }
  if (bad.length) {
    const err = new Error(
      `Unknown icon name(s). Use one of: ${[...SERVICE_ICONS, ...BRAND_ICONS].join(', ')}. `
      + bad.slice(0, 8).join('; ')
    );
    err.code = 'INVALID_ICON';
    throw err;
  }
}

/** CSS for icons — works with baseCss true/false (currentColor). */
function iconCss() {
  return `
.ws-icon{width:var(--ws-icon-size,1.5rem);height:var(--ws-icon-size,1.5rem);display:inline-block;vertical-align:middle;flex:0 0 auto;color:inherit}
.ws-icon:not(.ws-icon-brand){fill:none;stroke:currentColor;stroke-width:2;stroke-linecap:round;stroke-linejoin:round}
.ws-icon-brand{fill:currentColor;stroke:none}
.ws-icon-wrap{display:inline-flex;align-items:center;justify-content:center;margin-bottom:12px;color:var(--ws-primary,currentColor)}
.chip.ws-icon-chip{background:transparent;width:auto;height:auto;padding:0;color:var(--ws-primary,currentColor)}
.social-row a.ws-social{display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;padding:0;border-radius:999px;border:1px solid #d1d5db;color:var(--ws-secondary,currentColor);text-decoration:none}
.social-row a.ws-social:hover{border-color:var(--ws-primary,currentColor);color:var(--ws-primary,currentColor)}
.social-row a.ws-social .ws-icon{width:1.25rem;height:1.25rem}
`.replace(/\n/g, '');
}

module.exports = {
  SERVICE_ICONS,
  BRAND_ICONS,
  ALL_NAMES,
  normalizeIconName,
  isKnownIcon,
  listIconNames,
  renderIconSvg,
  iconForNetwork,
  collectIconUsages,
  assertKnownIcons,
  iconCss,
};
