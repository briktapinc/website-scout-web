'use strict';

const fs = require('fs');
const path = require('path');
const Database = require('better-sqlite3');
const learning = require('../src/designLearning');

const db = new Database(':memory:');
db.exec(fs.readFileSync(path.join(__dirname, '../src/schema.sql'), 'utf8'));
learning.ensureTables(db);

const ev = learning.observeReview(db, 1, {
  pass: false,
  summary: 'CTA weak on mobile',
  issues: ['Mobile CTA too small', 'Missing tel: link'],
  redesign_instructions: 'Rethink hero CTA hierarchy for local conversion',
  improvement_instructions: 'Enlarge the primary CTA on mobile viewports',
  vision_used: true,
  screenshots: [{ page: 'home', viewport: 'mobile', path: 'C:/tmp/review-shots/a.png' }],
});
console.log('review event', ev);

learning.observeChangeRequest(db, 1, 'improvements', 'Enlarge mobile CTA and fix tap targets', null);
learning.observeDeliver(db, 1, {
  hadPrior: true,
  requestKind: 'improvements',
  siteShape: 'landing',
  pageCount: 1,
});
learning.observeEmailMessage(db, {
  id: 9,
  subject: 'Please make the call button bigger',
  from_email: 'client@example.com',
  body: 'On my phone the Call Now button is too small.',
  request_kind: 'improvements',
  source: 'paste',
});

learning.maybeDistill(db, { force: true }).then((d) => {
  console.log('distill', { ok: d.ok, reason: d.reason, ai_used: d.ai_used, playbook_count: d.playbook_count });
  const playbook = learning.getPlaybook(db);
  console.log('playbook len', playbook.length);
  const brief = { constraints: [], job_type: 'website', site_shape: 'landing', instruction: 'Build site' };
  learning.attachLessonsToBrief(db, brief);
  console.log('learned_lessons', brief.learned_lessons && brief.learned_lessons.length);
  console.log('status', learning.getStatus(db));

  const catalog = require('../src/mcpCatalog');
  if (!catalog.tools.some((t) => t.name === 'design.lessons')) {
    throw new Error('mcpCatalog missing design.lessons');
  }
  const mcpSrc = fs.readFileSync(path.join(__dirname, '../src/mcp.js'), 'utf8');
  if (!mcpSrc.includes("'design.lessons'")) throw new Error('mcp.js missing design.lessons tool');

  // buildBrief path
  const design = require('../src/designJobs');
  design.ensureTables(db);
  const b = design.buildBrief(db, null, 'Make a logo', 'logo', null);
  if (!Array.isArray(b.learned_lessons)) throw new Error('buildBrief missing learned_lessons');
  console.log('ok');
}).catch((e) => {
  console.error(e);
  process.exit(1);
});
