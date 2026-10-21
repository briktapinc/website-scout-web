/**
 * Curated Google Fonts for site themes and per-element type.
 * Loaded in the browser as window.WsFonts and in Node via require().
 */
(function (root, factory) {
  const api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.WsFonts = api;
})(typeof window !== 'undefined' ? window : null, function () {
  const SYSTEM = 'system-ui, -apple-system, "Segoe UI", Roboto, sans-serif';

  const CATALOG = [
    { name: 'Inter', generic: 'sans-serif', group: 'Sans' },
    { name: 'Roboto', generic: 'sans-serif', group: 'Sans' },
    { name: 'Open Sans', generic: 'sans-serif', group: 'Sans' },
    { name: 'Lato', generic: 'sans-serif', group: 'Sans' },
    { name: 'Montserrat', generic: 'sans-serif', group: 'Sans' },
    { name: 'Poppins', generic: 'sans-serif', group: 'Sans' },
    { name: 'Nunito', generic: 'sans-serif', group: 'Sans' },
    { name: 'Raleway', generic: 'sans-serif', group: 'Sans' },
    { name: 'Source Sans 3', generic: 'sans-serif', group: 'Sans' },
    { name: 'Work Sans', generic: 'sans-serif', group: 'Sans' },
    { name: 'DM Sans', generic: 'sans-serif', group: 'Sans' },
    { name: 'Outfit', generic: 'sans-serif', group: 'Sans' },
    { name: 'Figtree', generic: 'sans-serif', group: 'Sans' },
    { name: 'Manrope', generic: 'sans-serif', group: 'Sans' },
    { name: 'Karla', generic: 'sans-serif', group: 'Sans' },
    { name: 'Rubik', generic: 'sans-serif', group: 'Sans' },
    { name: 'Mulish', generic: 'sans-serif', group: 'Sans' },
    { name: 'Josefin Sans', generic: 'sans-serif', group: 'Sans' },
    { name: 'Barlow', generic: 'sans-serif', group: 'Sans' },
    { name: 'Nunito Sans', generic: 'sans-serif', group: 'Sans' },
    { name: 'Merriweather', generic: 'serif', group: 'Serif' },
    { name: 'Playfair Display', generic: 'serif', group: 'Serif' },
    { name: 'Lora', generic: 'serif', group: 'Serif' },
    { name: 'Libre Baskerville', generic: 'serif', group: 'Serif' },
    { name: 'Source Serif 4', generic: 'serif', group: 'Serif' },
    { name: 'EB Garamond', generic: 'serif', group: 'Serif' },
    { name: 'Crimson Pro', generic: 'serif', group: 'Serif' },
    { name: 'Fraunces', generic: 'serif', group: 'Serif' },
    { name: 'Cormorant Garamond', generic: 'serif', group: 'Serif' },
    { name: 'Bitter', generic: 'serif', group: 'Serif' },
    { name: 'Oswald', generic: 'sans-serif', group: 'Display' },
    { name: 'Bebas Neue', generic: 'sans-serif', group: 'Display' },
    { name: 'Abril Fatface', generic: 'serif', group: 'Display' },
    { name: 'Anton', generic: 'sans-serif', group: 'Display' },
    { name: 'Archivo Black', generic: 'sans-serif', group: 'Display' },
    { name: 'Pacifico', generic: 'cursive', group: 'Display' },
    { name: 'Lobster', generic: 'cursive', group: 'Display' },
    { name: 'Comfortaa', generic: 'cursive', group: 'Display' },
    { name: 'JetBrains Mono', generic: 'monospace', group: 'Mono' },
    { name: 'IBM Plex Mono', generic: 'monospace', group: 'Mono' },
    { name: 'Space Mono', generic: 'monospace', group: 'Mono' },
    { name: 'Inconsolata', generic: 'monospace', group: 'Mono' },
  ];

  function escapeRe(s) {
    return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function mentions(blob, name) {
    const re = new RegExp('(^|[^A-Za-z0-9])' + escapeRe(name) + '([^A-Za-z0-9]|$)', 'i');
    return re.test(String(blob || ''));
  }

  function byName(name) {
    const want = String(name || '').trim().toLowerCase();
    if (!want) return null;
    return CATALOG.find((f) => f.name.toLowerCase() === want) || null;
  }

  function primaryFamily(stack) {
    const s = String(stack || '').trim();
    const quoted = s.match(/^["']([^"']+)["']/);
    if (quoted) return quoted[1].trim();
    return (s.split(',')[0] || '').trim();
  }

  /**
   * Catalog family that is the primary face of a stack, or ''.
   * The system stack lists Roboto as a fallback; that is not a Google font choice.
   */
  function matchName(stack) {
    const s = String(stack || '').trim();
    if (!s) return '';
    const primary = primaryFamily(s);
    if (/^(system-ui|-apple-system|segoe ui)$/i.test(primary)) return '';
    const direct = byName(primary);
    if (direct) return direct.name;
    if (/system-ui|-apple-system|segoe ui/i.test(s)) return '';
    for (const f of CATALOG) {
      if (mentions(s, f.name)) return f.name;
    }
    return '';
  }

  function stackFor(name) {
    const f = byName(name);
    if (!f) return SYSTEM;
    return '"' + f.name + '", ' + f.generic;
  }

  function safeStack(value) {
    const s = String(value == null ? '' : value).trim();
    if (!s) return SYSTEM;
    if (s.length > 180 || /[{}<>;]|url\s*\(|expression|javascript/i.test(s)) return SYSTEM;
    const name = matchName(s);
    if (name) return stackFor(name);
    if (/^[\w\s"',.-]+$/.test(s)) return s;
    return SYSTEM;
  }

  function namesIn(blob) {
    let s = String(blob || '');
    s = s.replace(/system-ui\s*,(?:[^;}<]|<(?!\/style))*?(?:sans-serif|serif|monospace|cursive|fantasy)/gi, ' ');
    return CATALOG.filter((f) => mentions(s, f.name)).map((f) => f.name);
  }

  function hrefFor(names) {
    const picked = [];
    for (const n of names || []) {
      const f = byName(n) || (matchName(n) ? byName(matchName(n)) : null);
      if (f && !picked.includes(f.name)) picked.push(f.name);
    }
    if (!picked.length) return '';
    const q = picked.map((n) => 'family=' + encodeURIComponent(n).replace(/%20/g, '+') + ':wght@400;600;700').join('&');
    return 'https://fonts.googleapis.com/css2?' + q + '&display=swap';
  }

  function catalogHref() {
    return hrefFor(CATALOG.map((f) => f.name));
  }

  function fillSelect(select, currentStack, opts) {
    if (!select) return;
    const o = opts || {};
    const currentName = matchName(currentStack);
    const custom = currentStack && !currentName && !/system-ui/.test(String(currentStack))
      ? String(currentStack).trim()
      : '';
    const groups = [];
    CATALOG.forEach((f) => {
      let g = groups.find((x) => x.label === f.group);
      if (!g) {
        g = { label: f.group, fonts: [] };
        groups.push(g);
      }
      g.fonts.push(f);
    });
    const defaultLabel = o.defaultLabel || 'Site default';
    let html = '<option value="">' + defaultLabel + '</option>';
    if (custom) {
      html += '<option value="__custom__">Custom (' + custom.replace(/</g, '') + ')</option>';
    }
    groups.forEach((g) => {
      html += '<optgroup label="' + g.label + '">';
      g.fonts.forEach((f) => {
        html += '<option value="' + f.name.replace(/"/g, '&quot;') + '" style="font-family:\'' + f.name.replace(/'/g, '') + '\', ' + f.generic + '">' + f.name + '</option>';
      });
      html += '</optgroup>';
    });
    select.innerHTML = html;
    if (custom) select.value = '__custom__';
    else select.value = currentName || '';
  }

  function selectedStack(select) {
    if (!select) return '';
    const v = select.value;
    if (!v || v === '__custom__') return '';
    return stackFor(v);
  }

  function selectedName(select) {
    if (!select) return '';
    const v = select.value;
    if (!v || v === '__custom__') return '';
    return byName(v) ? v : '';
  }

  return {
    SYSTEM,
    CATALOG,
    matchName,
    stackFor,
    safeStack,
    namesIn,
    hrefFor,
    catalogHref,
    fillSelect,
    selectedStack,
    selectedName,
  };
});
