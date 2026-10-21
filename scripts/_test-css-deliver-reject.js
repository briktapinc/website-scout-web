'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const design = require('../src/designJobs');
const engine = require('../src/websiteEngine');

const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8'));
design.ensureTables(db);
engine.ensureTables(db);

const lead = db.prepare(
  "INSERT INTO leads (business_name, status) VALUES ('Test Co', 'new')"
).run();
const lid = Number(lead.lastInsertRowid);
const job = design.createJob(db, {
  leadId: lid,
  type: 'website',
  title: 'T',
  instructions: 'x',
});

const broken = {
  name: 'T',
  theme: { baseCss: false, customCss: '/* nope */' },
  pages: [{
    slug: 'home',
    title: 'Home',
    html: '<div class="hero wrap grid card btn cta lede services card-title hero-title">x</div>',
  }],
};

let code = null;
try {
  design.deliverJob(db, job.id, broken, []);
} catch (e) {
  code = e.code;
  console.log('deliver reject:', e.code, String(e.message).slice(0, 200));
}
if (code !== 'INVALID_CSS') {
  console.error('FAIL: deliver expected INVALID_CSS, got', code);
  process.exit(1);
}

const goodCss = [
  '.hero,.wrap,.grid,.card,.btn,.cta,.lede,.services,.card-title,.hero-title',
  '{display:block;padding:8px;margin:4px;color:#111;background:#eee;border-radius:4px;font-size:1rem;line-height:1.4}',
].join('').repeat(3);

const good = {
  name: 'T',
  theme: { baseCss: false, customCss: goodCss },
  pages: [{
    slug: 'home',
    title: 'Home',
    html: '<div class="hero wrap grid card btn cta lede services card-title hero-title"><img src="images/openai-1.png" alt="x"></div>',
  }],
  images: [{ url: 'images/openai-1.png', source: 'openai', name: 'openai-1.png' }],
};

const delivered = design.deliverJob(db, job.id, good, []);
console.log('deliver ok:', delivered.status, 'website_id=', delivered.website_id);

if (!delivered.website_id) {
  console.error('FAIL: expected website_id after deliver');
  process.exit(1);
}

let code2 = null;
try {
  design.saveWebsiteEdit(db, job.id, broken.pages, broken.theme);
} catch (e) {
  code2 = e.code;
  console.log('saveWebsite reject:', e.code, String(e.message).slice(0, 200));
}
if (code2 !== 'INVALID_CSS') {
  console.error('FAIL: saveWebsite expected INVALID_CSS, got', code2);
  process.exit(1);
}

// QA: registered image + good CSS should not fail those checks
engine.qaSite(db, delivered.website_id).then((qa) => {
  const byName = Object.fromEntries(qa.checks.map((c) => [c.name, c]));
  console.log('qa css:', byName['css-present-and-applied']);
  console.log('qa images:', byName['images-are-placeholders']);
  if (!byName['css-present-and-applied'] || !byName['css-present-and-applied'].pass) {
    console.error('FAIL: css check should pass on good deliverable');
    process.exit(1);
  }
  if (!byName['images-are-placeholders'] || !byName['images-are-placeholders'].pass) {
    console.error('FAIL: registered images/ should pass images check');
    process.exit(1);
  }
  console.log('integration OK');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
