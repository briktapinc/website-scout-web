'use strict';

const domain = require('../server/domain');
const chatbot = require('../server/chatbot');
const { aiConfigured } = require('../src/ai');

domain.withDb(1, (db) => {
  const k = chatbot.knowledgeSnippets(db, 15, { limit: 5 });
  const biz = chatbot.loadBusinessSupportContext(db, 15);
  const cfg = !!aiConfigured(db);
  // Do not print API keys — only whether configured.
  console.log(JSON.stringify({
    aiConfigured: cfg,
    knowledgeCount: k.count,
    businessName: biz.businessName,
    phone: biz.phone ? '(set)' : '',
    address: biz.address ? biz.address.slice(0, 60) : '',
    hours: biz.hours || '',
    category: biz.category || '',
    hasAbout: !!biz.about,
  }, null, 2));
});
