'use strict';

const LOADERS = Object.freeze({
  'form-embed.js': 'data-bitpype-form-script',
  'chat-embed.js': 'data-bitpype-chat-script',
  'module-embed.js': 'data-bitpype-module-script',
});

function appBase() {
  try {
    const url = new URL(String(process.env.APP_URL || ''));
    return /^https?:$/.test(url.protocol) && !url.username && !url.password ? url.origin : '';
  } catch { return ''; }
}

function loaderTag(file) {
  if (!LOADERS[file]) return '';
  return `<script src="${appBase()}/js/${file}" defer ${LOADERS[file]}="1"></script>`;
}

// Caller-supplied markers, attributes and script bodies never confer trust.
function approvedScript(attrs) {
  const match = /(?:^|\s)src\s*=\s*(["'])([^"']*)\1/i.exec(String(attrs || ''));
  if (!match) return '';
  const src = match[2];
  for (const file of Object.keys(LOADERS)) {
    if (src === `/js/${file}` || (appBase() && src === `${appBase()}/js/${file}`)) return loaderTag(file);
  }
  return '';
}

module.exports = { appBase, loaderTag, approvedScript };
