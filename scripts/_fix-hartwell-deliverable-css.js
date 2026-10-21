/** Sync design job 11 deliverable.theme from website 9 (Hartwell). */
const Database = require('better-sqlite3');
const dbPath = process.argv[2] || require('path').join(__dirname, '..', 'data', 'workspaces', '1', 'websitescout.db');
const db = new Database(dbPath);
const site = db.prepare('SELECT theme, pages FROM websites WHERE id = 9').get();
if (!site) {
  console.error('website 9 missing');
  process.exit(1);
}
const job = db.prepare('SELECT id, deliverable FROM design_jobs WHERE id = 11').get();
if (!job) {
  console.error('job 11 missing');
  process.exit(1);
}
const payload = JSON.parse(job.deliverable || 'null');
const theme = JSON.parse(site.theme || '{}');
const pages = JSON.parse(site.pages || '[]');
payload.theme = theme;
payload.pages = pages;
db.prepare(`UPDATE design_jobs SET deliverable = ?, website_id = 9, updated_at = datetime('now') WHERE id = 11`)
  .run(JSON.stringify(payload));
console.log('synced deliverable theme.customCss len', (theme.customCss || '').length);
console.log('pages', pages.length);
db.close();
