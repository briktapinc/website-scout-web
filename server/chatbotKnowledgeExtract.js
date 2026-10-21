'use strict';
const helpers = require('./chatbotKnowledgeParse');
const { runIsolated } = require('./knowledgeParseRunner');
module.exports = { ...helpers, extractKnowledgeText: (buffer, opts = {}) => runIsolated(buffer, {
  fileName: String(opts.fileName || 'upload.bin').slice(0, 200),
  mimeType: String(opts.mimeType || '').slice(0, 150),
}) };
