'use strict';
/**
 * Smoke: blog excerpt derivation + post_limit / show_excerpt embed settings.
 */
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');
const modules = require('../server/siteModules');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-blog-'));
const dbPath = path.join(dir, 't.db');
const db = new Database(dbPath);
db.exec(`
  CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT);
  INSERT INTO leads (id, business_name) VALUES (1, 'Test Co');
`);
modules.ensureTables(db);

const words = Array.from({ length: 40 }, (_, i) => `word${i + 1}`).join(' ');
const body = `<p>${words}</p>`;
const post = modules.createBlogPost(db, 1, {
  title: 'Hello',
  body_html: body,
  status: 'published',
});
if (!post.excerpt) throw new Error('expected derived excerpt');
const count = post.excerpt.replace(/…$/, '').split(/\s+/).filter(Boolean).length;
if (count !== 30) throw new Error(`expected 30 words, got ${count}: ${post.excerpt}`);
if (!post.excerpt.endsWith('…')) throw new Error('expected ellipsis on truncated excerpt');

const explicit = modules.updateBlogPost(db, 1, post.id, { excerpt: 'Custom blurb here.' });
if (explicit.excerpt !== 'Custom blurb here.') throw new Error('explicit excerpt not kept');

// Seed 7 posts
for (let i = 2; i <= 7; i++) {
  modules.createBlogPost(db, 1, {
    title: `Post ${i}`,
    slug: `post-${i}`,
    body_html: `<p>Body for post ${i} with enough words to make an excerpt automatically from the html content here.</p>`,
    status: 'published',
  });
}

db.prepare(`
  INSERT INTO site_module_embeds
    (lead_id, module_type, title, public_token, published, embed_enabled, target_page_slug, settings_json)
  VALUES (1, 'blog', 'Blog', '1_testtokenblogxx', 1, 1, 'blog', ?)
`).run(JSON.stringify({ post_limit: 3, show_excerpt: true }));

const limited = modules.getPublicModuleByToken(db, '1_testtokenblogxx');
if (limited.items.length !== 3) throw new Error(`expected 3 items, got ${limited.items.length}`);
if (!limited.truncated) throw new Error('expected truncated=true');
if (limited.show_excerpt !== true) throw new Error('show_excerpt should be true');
if (!limited.items.every((it) => it.excerpt)) throw new Error('every card needs excerpt');

modules.writeEmbedSettings(db, limited.embed.id, { post_limit: null, show_excerpt: false });
const all = modules.getPublicModuleByToken(db, '1_testtokenblogxx');
if (all.items.length !== 7) throw new Error(`expected 7 items, got ${all.items.length}`);
if (all.truncated) throw new Error('expected truncated=false');
if (all.show_excerpt !== false) throw new Error('show_excerpt should be false');

// custom section html must mark for edit
const engine = require('../src/websiteEngine');
const marked = engine.sectionToHtml(
  { type: 'custom', content: { html: '<h1>Test</h1><p>Add your content here.</p>' } },
  {},
  { page: 0, section: 1, editing: true }
);
if (!/data-edit="html:0:1:\d+"/.test(marked)) {
  throw new Error(`custom html not marked for edit: ${marked.slice(0, 200)}`);
}

console.log('ok blog excerpt+limit + custom html edit markers');
db.close();
fs.rmSync(dir, { recursive: true, force: true });
