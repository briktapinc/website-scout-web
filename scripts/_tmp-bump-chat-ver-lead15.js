'use strict';
/** One-shot: re-sync chatbot embeds so pages use current CHAT_SCRIPT_VER. */
const Database = require('better-sqlite3');
const chatbot = require('../server/chatbot');

const leadId = Number(process.argv[2] || 15);
const dbPath = process.env.DB_PATH || '/app/data/scout.db';
const db = new Database(dbPath);
const row = db.prepare(
  'SELECT id, lead_id, pages_json FROM websites WHERE lead_id=? ORDER BY id DESC LIMIT 1'
).get(leadId);
if (!row) {
  console.error('no website for lead', leadId);
  process.exit(1);
}
let pages = [];
try {
  pages = JSON.parse(row.pages_json || '[]');
} catch (e) {
  pages = [];
}
const re = /chat-embed\.js\?v=chat\d+/g;
const before = (JSON.stringify(pages).match(re) || []).slice(0, 8);
console.log('website', row.id, 'before', before);
chatbot.syncChatbotSitewide(db, leadId, pages);
const after = (JSON.stringify(pages).match(re) || []).slice(0, 8);
console.log('after', after);
db.prepare("UPDATE websites SET pages_json=?, updated_at=datetime('now') WHERE id=?").run(
  JSON.stringify(pages),
  row.id
);
console.log('updated pages_json for website', row.id);
console.log('CHAT_SCRIPT_VER', chatbot.CHAT_SCRIPT_VER);
