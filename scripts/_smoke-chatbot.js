'use strict';

/**
 * Local smoke: chatbot module tables, sitewide attach, public message path,
 * knowledge extract/upload, client-MCP boundary constants.
 */
const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');
const Database = require('better-sqlite3');

const siteModules = require('../server/siteModules');
const chatbot = require('../server/chatbot');
const extract = require('../server/chatbotKnowledgeExtract');
const { getPlan } = require('../server/plans');
const { portalToolDefs } = require('../server/clientMcp');
const { clientToolDefs } = require('../server/mcp');

assert.strictEqual(getPlan('free').entitlements.chatbot, false);
assert.strictEqual(getPlan('standard').entitlements.chatbot, true);
assert.strictEqual(getPlan('premium').entitlements.chatbot, true);
assert.ok(siteModules.MODULE_TYPES.includes('chatbot'));
assert.ok(siteModules.MODULE_META.chatbot.sitewide);
assert.ok(extract.SUPPORTED_LABEL.includes('PDF'));

const portalNames = new Set(portalToolDefs().map((t) => t.name));
for (const n of [
  'chatbot.pending', 'chatbot.next', 'chatbot.reply', 'chatbot.escalate',
  'chatbot.knowledge.list', 'chatbot.knowledge.upload', 'chatbot.actions',
]) {
  assert.ok(portalNames.has(n), `missing portal tool ${n}`);
}
const clientNames = new Set(clientToolDefs().map((t) => t.name));
assert.ok(clientNames.has('chatbot.pending'));
assert.ok(!clientNames.has('design.next'), 'design.next must not be on client tool list');
assert.ok(!clientNames.has('lead.create'), 'lead.create must not be on client tool list');

(async () => {
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-chatbot-'));
  const dbPath = path.join(tmp, 't.db');
  const db = new Database(dbPath);
  db.exec(`
    CREATE TABLE websites (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      pages TEXT,
      updated_at TEXT DEFAULT (datetime('now'))
    );
  `);
  db.prepare(
    `INSERT INTO websites (lead_id, pages) VALUES (1, ?)`
  ).run(JSON.stringify([
    { slug: 'home', title: 'Home', html: '<html><body><main><h1>Hi</h1></main></body></html>' },
    { slug: 'about', title: 'About', html: '<html><body><main><p>About</p></main></body></html>' },
  ]));

  siteModules.ensureTables(db);
  const attached = siteModules.attachModule(db, 1, 'chatbot', {
    workspaceId: 1,
    appUrl: 'https://example.test',
    authorMode: false,
  });
  assert.ok(attached.embed && attached.embed.public_token);
  assert.ok(attached.sitewide || (attached.sync && attached.sync.chatbot));

  const site = db.prepare('SELECT pages FROM websites WHERE lead_id = 1').get();
  const pages = JSON.parse(site.pages);
  assert.ok(pages.every((p) => /data-bitpype-chat-token/.test(p.html || JSON.stringify(p.sections || []))),
    'chat mount should be on all pages');
  assert.ok(pages.every((p) => /chat-embed\.js/.test(p.html || JSON.stringify(p.sections || []))),
    'chat-embed.js on all pages');

  // Export sanitizeHtml must park ALL managed embeds (pattern: data-bitpype-*-script / *-embed.js).
  try {
    const eng = require('../src/websiteEngine');
    const sample = pages[0].html || JSON.stringify(pages[0].sections || []);
    const mount = (sample.match(/<div\b[^>]*\bdata-bitpype-chat\b[\s\S]*?<\/div>\s*<script\b[^>]*chat-embed\.js[^>]*>\s*<\/script>/i) || [])[0]
      || sample;
    const sanitized = eng.sanitizeHtml(String(mount));
    assert.ok(/chat-embed\.js/.test(sanitized), 'sanitizeHtml keeps chat-embed.js');
    assert.ok(/data-bitpype-chat/.test(sanitized), 'sanitizeHtml keeps chat mount');

    const trio = [
      '<div class="bitpype-module-embed" data-bitpype-module="1" data-bitpype-api="https://example.test"></div>',
      '<script src="https://example.test/js/module-embed.js" defer data-bitpype-module-script="1"></script>',
      '<div class="bitpype-form-embed" data-bitpype-form-embed="1_t" data-bitpype-api="https://example.test"></div>',
      '<script src="https://example.test/js/form-embed.js" defer data-bitpype-form-script="1"></script>',
      mount,
      '<script>alert(1)</script>',
    ].join('\n');
    const all = eng.sanitizeHtml(trio);
    assert.ok(/module-embed\.js/.test(all), 'sanitizeHtml keeps module-embed.js');
    assert.ok(/form-embed\.js/.test(all), 'sanitizeHtml keeps form-embed.js');
    assert.ok(/chat-embed\.js/.test(all), 'sanitizeHtml keeps chat with module+form');
    assert.ok(!/alert\(1\)/.test(all), 'still strips inline scripts');
    const asserted = eng.assertManagedEmbedScripts(all, 'smoke-chatbot');
    assert.ok(asserted.ok, 'assertManagedEmbedScripts ok for trio');
  } catch (e) {
    if (e && e.code === 'MODULE_NOT_FOUND') throw e;
    throw e;
  }

  chatbot.addKnowledge(db, 1, { kind: 'link', title: 'Hours', url: 'https://example.test/hours', content_text: 'Open 9-5' });
  const cfg = chatbot.getPublicConfigByToken(db, attached.embed.public_token);
  assert.ok(cfg.settings.greeting);
  assert.ok(Array.isArray(cfg.allowed_actions));

  const md = await extract.extractKnowledgeText(
    Buffer.from('Refunds within 30 days for unused services.'),
    { fileName: 'policy.txt', mimeType: 'text/plain' }
  );
  assert.ok(md.text.includes('Refunds'));

  const prevCwd = process.cwd();
  process.chdir(tmp);
  let stored;
  try {
    stored = await chatbot.storeKnowledgeUpload(1, 1, {
      data: Buffer.from('Shipping takes 3-5 business days.').toString('base64'),
      mimeType: 'text/plain',
      fileName: 'shipping.txt',
      title: 'Shipping',
    });
  } finally {
    process.chdir(prevCwd);
  }
  assert.ok(stored.file_path.includes('chatbot/1/'));
  assert.ok(stored.content_text.includes('Shipping takes'));
  chatbot.addKnowledge(db, 1, {
    kind: 'doc',
    title: stored.title,
    content_text: stored.content_text,
    file_name: stored.file_name,
    file_path: stored.file_path,
  });
  const snip = chatbot.knowledgeSnippets(db, 1, { query: 'shipping days' });
  assert.ok(snip.text.toLowerCase().includes('shipping') || snip.snippets.length >= 1);

  // parseAiFallbackResponse unit checks
  const pFound = chatbot.parseAiFallbackResponse('{"found":true,"reply":"We ship in 3-5 days."}');
  assert.strictEqual(pFound.found, true);
  assert.ok(pFound.reply.includes('3-5'));
  const pMiss = chatbot.parseAiFallbackResponse(
    '{"found":false,"reply":""}',
    { businessName: 'Acme Electric' }
  );
  assert.strictEqual(pMiss.found, false);
  assert.ok(/Acme Electric/i.test(pMiss.reply));
  assert.ok(/leave your/i.test(pMiss.reply));
  const pMarkers = chatbot.parseAiFallbackResponse('FOUND: no\nREPLY: Thanks for visiting!');
  assert.strictEqual(pMarkers.found, false);
  const pEmpty = chatbot.parseAiFallbackResponse('');
  assert.strictEqual(pEmpty.found, false);
  assert.ok(pEmpty.reply);

  // Business support context from lead + facts
  db.exec(`
    CREATE TABLE IF NOT EXISTS leads (
      id INTEGER PRIMARY KEY,
      business_name TEXT,
      category TEXT,
      phone TEXT,
      email TEXT,
      website TEXT,
      address TEXT,
      city TEXT,
      state TEXT,
      postal_code TEXT,
      description TEXT,
      hours TEXT,
      services TEXT
    );
    CREATE TABLE IF NOT EXISTS business_facts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER,
      fact_key TEXT,
      value TEXT,
      claim_class TEXT
    );
  `);
  try { db.exec('ALTER TABLE websites ADD COLUMN name TEXT'); } catch { /* exists */ }
  try { db.exec('ALTER TABLE websites ADD COLUMN theme TEXT'); } catch { /* exists */ }
  db.prepare(`
    INSERT INTO leads (id, business_name, category, phone, city, description, hours)
    VALUES (1, 'Acme Electric', 'electrician', '555-0100', 'Fleetwood', 'Local electrician.', '[]')
    ON CONFLICT(id) DO UPDATE SET
      business_name=excluded.business_name,
      category=excluded.category,
      phone=excluded.phone,
      city=excluded.city,
      description=excluded.description,
      hours=excluded.hours
  `).run();
  db.prepare(`
    INSERT INTO business_facts (lead_id, fact_key, value, claim_class)
    VALUES (1, 'address', '80 Gould Ln', 'VERIFIED')
  `).run();
  db.prepare(`
    UPDATE websites SET name = ?, theme = ? WHERE lead_id = 1
  `).run('Acme Site', JSON.stringify({ brandName: 'Acme Electric Co' }));
  const biz = chatbot.loadBusinessSupportContext(db, 1);
  assert.ok(/Acme Electric/i.test(biz.businessName));
  assert.ok(biz.text.includes('Phone') || biz.phone);
  assert.ok(biz.address || /Gould/i.test(biz.text));

  const posted = chatbot.postVisitorMessage(db, attached.embed.public_token, {
    message: 'What are your hours?',
  });
  assert.ok(posted.session && posted.session.session_token);
  assert.strictEqual(posted.agent_boundary, 'portal_client_mcp_only');

  const pending = chatbot.listPendingSessions(db, 1);
  assert.ok(pending.sessions.length >= 1);
  assert.strictEqual(pending.boundary, 'portal_client_mcp_only');
  assert.ok(/never admin MCP/i.test(pending.hint));
  assert.ok(pending.knowledge && pending.knowledge.snippets);

  const replied = chatbot.agentReply(db, 1, pending.sessions[0].id, 'We are open 9–5.');
  assert.ok(replied.message && replied.message.role === 'agent');

  const hist = chatbot.getSessionHistory(db, attached.embed.public_token, {
    sessionToken: posted.session.session_token,
  });
  assert.ok(hist.messages.some((m) => m.role === 'agent'));

  chatbot.escalateSession(db, 1, { sessionId: posted.session.id || pending.sessions[0].id, reason: 'test' });
  const lead = chatbot.captureLead(db, attached.embed.public_token, {
    session: posted.session.session_token,
    name: 'Pat',
    email: 'pat@example.com',
    message: 'Call me',
  });
  assert.ok(lead.lead && lead.lead.email === 'pat@example.com');

  db.close();
  fs.rmSync(tmp, { recursive: true, force: true });
  console.log('smoke chatbot OK');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
