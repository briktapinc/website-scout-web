'use strict';

(async () => {
  const paths = [
    '/app/server/mcpOAuth',
    '/app/server/db',
    '/app/server/domain',
    '/app/server/chatbot',
    '/app/server/clientMcp',
    '/app/server/rateLimit',
    '/app/src/websiteEngine',
  ];
  for (const p of paths) {
    require(p);
    console.log('loaded', p);
  }
  const oauth = require('/app/server/mcpOAuth');
  await oauth.ensureOAuthTables();
  const reg = await oauth.registerClient({
    client_name: 'vps-smoke',
    redirect_uris: ['http://127.0.0.1/callback'],
  });
  const again = await oauth.getClient(reg.client_id);
  if (!again) throw new Error('DCR not durable');
  const eng = require('/app/src/websiteEngine');
  const out = eng.sanitizeHtml(
    '<div class="bitpype-chat-embed" data-bitpype-chat="1" data-bitpype-api="https://bitpype.com"></div>'
  );
  if (!/chat-embed\.js/.test(out)) throw new Error('embed sanitize broken');
  const chat = require('/app/server/chatbot');
  if (typeof chat.claimNeedsAgent !== 'function' || typeof chat.cancelAiFallbackReply !== 'function') {
    throw new Error('chatbot race helpers missing');
  }
  console.log('vps_verify_ok');
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
