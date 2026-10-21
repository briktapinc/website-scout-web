'use strict';
// Conservative checks for reproduced generation defects. Never rewrite copy,
// dates, URLs, scripts or CSS, and never deduplicate intentional body content.
function visible(value) {
  return String(value || '').replace(/<!--[^]*?-->/g, '').replace(/<(script|style|pre|code)\b[^>]*>[^]*?<\/\1\s*>/gi, '')
    .replace(/<[^>]*>/g, ' ').replace(/&#(?:x([a-f0-9]+)|(\d+));?/gi, (all, hex, dec) => {
      const number = parseInt(hex || dec, hex ? 16 : 10); return number > 0 && number <= 0x10ffff ? String.fromCodePoint(number) : all;
    }).replace(/&(?:nbsp|amp|quot|apos|lt|gt);/gi, entity => ({ '&nbsp;': ' ', '&amp;': '&', '&quot;': '"', '&apos;': "'", '&lt;': '<', '&gt;': '>' })[entity.toLowerCase()])
    .replace(/\s+/g, ' ').trim();
}
function headings(html) {
  const source = String(html || '').replace(/<!--[^]*?-->/g, '').replace(/<(script|style|pre|code)\b[^>]*>[^]*?<\/\1\s*>/gi, '');
  return [...source.matchAll(/<h[12]\b[^>]*>([^]*?)<\/h[12]\s*>/gi)].map(match => visible(match[1]).toLowerCase()).filter(text => text.length >= 16);
}
function inspect(pages, theme = {}) {
  const issues = [];
  for (const [pageIndex, page] of (Array.isArray(pages) ? pages : []).entries()) {
    if (!page || typeof page !== 'object') continue;
    const pageKey = String(page.slug ?? pageIndex);
    const sections = Array.isArray(page.sections) ? page.sections : [];
    const bodyHeadings = new Set(sections.filter(section => section?.type !== 'nav').flatMap(section => headings(section?.content?.html)));
    if (typeof page.html === 'string' && !sections.length) for (const heading of headings(page.html)) bodyHeadings.add(heading);
    const repeatedShared = [...new Set(headings(theme?.partials?.headerHtml).filter(heading => bodyHeadings.has(heading)))];
    if (repeatedShared.length >= 2) issues.push({ code: 'SHARED_HEADER_CONTAINS_PAGE_BODY', page: pageKey, path: '/theme/partials/headerHtml', count: repeatedShared.length });
    for (const [sectionIndex, section] of sections.entries()) if (section?.type === 'nav') {
      const repeated = [...new Set(headings(section.content?.html).filter(heading => bodyHeadings.has(heading)))];
      // A brand title alone is allowed. The reproduced bug carries multiple
      // body headings inside navigation and repeats them in real body sections.
      if (repeated.length >= 2) issues.push({ code: 'NAV_CONTAINS_PAGE_BODY', page: pageKey, path: `/sections/${sectionIndex}/content/html`, count: repeated.length });
    }
    function walk(value, path = '', key = '') {
      if (typeof value === 'string') {
        if (/^(?:customCss|customJs|customHead|style|css|js|script|src|href|url|.*_url|slug|id|class|className|type|image|icon)$/i.test(key)) return;
        const text = visible(value);
        const pattern = /\b(?:isn|aren|wasn|weren|don|doesn|didn|hasn|haven|hadn|can|couldn|wouldn|shouldn|won|mustn|needn)2019t\b|\b(?:that|there|here|what|who|it|let)2019s\b|\\u20(?:14|19)/gi;
        const matches = [...text.matchAll(pattern)];
        if (matches.length) issues.push({ code: 'CORRUPT_PUNCTUATION', page: pageKey, path, count: matches.length });
      } else if (Array.isArray(value)) value.forEach((item,index) => walk(item, path + '/' + index, key));
      else if (value && typeof value === 'object') for (const [child,item] of Object.entries(value)) walk(item, path + '/' + child, child);
    }
    walk(page);
  }
  return issues;
}
function assertNoNewDefects(pages, previous = [], theme = {}, previousTheme = {}) {
  const totals = rows => rows.reduce((map, row) => { const key = row.code + ':' + row.page; map.set(key, (map.get(key) || 0) + row.count); return map; }, new Map());
  const before = totals(inspect(previous, previousTheme)), current = inspect(pages, theme), after = totals(current);
  const added = current.filter(issue => after.get(issue.code + ':' + issue.page) > (before.get(issue.code + ':' + issue.page) || 0));
  if (added.length) throw Object.assign(new Error('Generated content needs correction: ' + [...new Set(added.map(issue => issue.code))].join(', ') + '. Fix the source copy or navigation fragment before saving.'), { code: 'INVALID_GENERATED_CONTENT', status: 422, issues: added });
  return current;
}
module.exports = { inspect, assertNoNewDefects, visible };
