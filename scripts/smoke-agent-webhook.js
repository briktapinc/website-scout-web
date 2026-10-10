'use strict';

/**
 * Smoke: fireAgentWebhook empty URL = no-op; mock URL receives redesign payload.
 * Run: node scripts/smoke-agent-webhook.js
 */

const http = require('http');
const {
  fireAgentWebhook,
  buildWebhookPayload,
} = require('../src/designAgentTrigger');

function mockDb(settings = {}, jobTitle = 'Smoke Test Site') {
  return {
    prepare(sql) {
      const s = String(sql);
      return {
        get(...args) {
          if (s.includes('FROM settings')) {
            const key = args[0];
            return settings[key] != null ? { value: settings[key] } : undefined;
          }
          if (s.includes('FROM design_jobs')) {
            return { title: jobTitle };
          }
          return undefined;
        },
        run() { /* activity_log */ },
      };
    },
  };
}

async function main() {
  const empty = await fireAgentWebhook(mockDb({ 'design.agent_webhook_url': '' }), {
    jobId: 42,
    reason: 'redesign',
    status: 'waiting_on_agent',
  });
  if (!empty.skipped || empty.why !== 'empty_url') {
    throw new Error(`expected empty_url skip, got ${JSON.stringify(empty)}`);
  }

  const skippedReason = await fireAgentWebhook(
    mockDb({ 'design.agent_webhook_url': 'http://127.0.0.1:9/hook' }),
    { jobId: 1, reason: 'assigned', status: 'waiting_on_agent' }
  );
  if (!skippedReason.skipped || skippedReason.why !== 'reason') {
    throw new Error(`expected reason skip, got ${JSON.stringify(skippedReason)}`);
  }

  const shape = buildWebhookPayload({
    jobId: 7,
    reason: 'improvements',
    status: 'waiting_on_agent',
    title: 'Acme',
    timestamp: '2026-01-01T00:00:00.000Z',
  });
  if (shape.job_id !== 7 || shape.request_kind !== 'improvements' || shape.title !== 'Acme') {
    throw new Error(`bad payload shape: ${JSON.stringify(shape)}`);
  }

  let received = null;
  const server = http.createServer((req, res) => {
    let buf = '';
    req.on('data', (c) => { buf += c; });
    req.on('end', () => {
      received = {
        method: req.method,
        auth: req.headers.authorization || null,
        secret: req.headers['x-webhook-secret'] || null,
        body: JSON.parse(buf || '{}'),
      };
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end('{"ok":true}');
    });
  });

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}/hook`;

  try {
    const result = await fireAgentWebhook(
      mockDb({
        'design.agent_webhook_url': url,
        'design.agent_webhook_secret': 'smoke-secret',
      }),
      { jobId: 99, reason: 'improvements', status: 'waiting_on_agent' },
      { timeoutMs: 3000 }
    );
    if (!result.ok) throw new Error(`webhook failed: ${JSON.stringify(result)}`);
    if (!received || received.method !== 'POST') throw new Error('no POST received');
    if (received.body.job_id !== 99 || received.body.reason !== 'improvements') {
      throw new Error(`bad body: ${JSON.stringify(received.body)}`);
    }
    if (received.body.title !== 'Smoke Test Site') {
      throw new Error(`expected title from job row, got ${received.body.title}`);
    }
    if (received.auth !== 'Bearer smoke-secret' || received.secret !== 'smoke-secret') {
      throw new Error(`secret headers missing: ${JSON.stringify(received)}`);
    }
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }

  console.log('smoke-agent-webhook: OK');
}

main().catch((e) => {
  console.error('smoke-agent-webhook: FAIL', e.message || e);
  process.exit(1);
});
