'use strict';

/** Clamp page/pageSize and compute SQL OFFSET. */
function pageArgs(opts = {}, defaults = {}) {
  const maxSize = Number(defaults.maxSize) > 0 ? Number(defaults.maxSize) : 200;
  const defSize = Number(defaults.pageSize) > 0 ? Number(defaults.pageSize) : 25;
  let pageSize = Number(opts.pageSize);
  if (!Number.isFinite(pageSize) || pageSize < 1) pageSize = defSize;
  pageSize = Math.min(maxSize, Math.max(1, Math.floor(pageSize)));
  let page = Number(opts.page);
  if (!Number.isFinite(page) || page < 1) page = 1;
  page = Math.min(100000, Math.max(1, Math.floor(page)));
  return { page, pageSize, offset: (page - 1) * pageSize };
}

function pageMeta(total, page, pageSize) {
  const t = Math.max(0, Number(total) || 0);
  const pages = Math.max(1, Math.ceil(t / pageSize) || 1);
  return { total: t, page, pageSize, pages };
}

function pageResult(rows, total, page, pageSize) {
  return Object.assign({ rows: Array.isArray(rows) ? rows : [] }, pageMeta(total, page, pageSize));
}

module.exports = { pageArgs, pageMeta, pageResult };
