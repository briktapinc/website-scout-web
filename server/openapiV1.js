'use strict';

/**
 * OpenAPI 3 description for the Muse agent REST API (/api/v1).
 * Prefer this surface; MCP is the transport fallback for the same core handlers.
 */

const PKG = (() => {
  try { return require('../package.json'); } catch { return { version: '0.1.0' }; }
})();

function buildOpenApi() {
  const ver = String(PKG.version || '0.1.0');
  return {
    openapi: '3.0.3',
    info: {
      title: 'BitPype Website Scout — Muse API',
      version: ver,
      description: [
        'Primary agent surface for leads, design jobs, and websites.',
        'TOOLS ONLY: call documented routes (or MCP tools/list). Do not invent DIY CRMs, forms, booking widgets, or other parallel systems when a capability is missing — report and stop.',
        'Auth: Authorization: Bearer <workspace token> (same ws_/cl_ tokens as MCP).',
        'Access order: prefer /api/v1 for every mirrored operation; use MCP only when the API is unreachable or for long-tail tools not listed here.',
        'Idempotency: send Idempotency-Key on POST /leads, POST /design/jobs, and POST /design/jobs/{id}/deliver (honored across API and MCP).',
        'Deliver returns a compact receipt (<2 KB); fetch GET /design/jobs/{id} for the full job.',
      ].join('\n\n'),
    },
    servers: [{ url: '/api/v1' }],
    components: {
      securitySchemes: {
        bearerAuth: {
          type: 'http',
          scheme: 'bearer',
          description: 'Workspace or lead-scoped token (ws_… / cl_…)',
        },
      },
      schemas: {
        Ok: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [true] },
            data: {},
          },
        },
        Err: {
          type: 'object',
          properties: {
            ok: { type: 'boolean', enum: [false] },
            error: {
              type: 'object',
              properties: {
                code: { type: 'string' },
                message: { type: 'string' },
              },
            },
          },
        },
        DeliverReceipt: {
          type: 'object',
          properties: {
            job_id: { type: 'integer' },
            status: { type: 'string' },
            website_id: { type: 'integer', nullable: true },
            qa: {
              type: 'object',
              properties: {
                passed: { type: 'boolean' },
                checks_failed: { type: 'array', items: { type: 'string' } },
              },
            },
          },
        },
      },
    },
    security: [{ bearerAuth: [] }],
    paths: {
      '/health': {
        get: {
          security: [],
          summary: 'Reachability probe (no auth)',
          responses: {
            200: {
              description: 'OK',
              content: {
                'application/json': {
                  schema: {
                    type: 'object',
                    properties: {
                      ok: { type: 'boolean' },
                      version: { type: 'string' },
                      surface: { type: 'string' },
                    },
                  },
                },
              },
            },
          },
        },
      },
      '/openapi.json': {
        get: {
          security: [],
          summary: 'This OpenAPI document',
          responses: { 200: { description: 'OpenAPI 3 JSON' } },
        },
      },
      '/leads': {
        get: {
          summary: 'List leads (compact)',
          parameters: [
            { name: 'q', in: 'query', schema: { type: 'string' } },
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'city', in: 'query', schema: { type: 'string' } },
            { name: 'category', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
            { name: 'offset', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'Lead list' } },
        },
        post: {
          summary: 'Create lead',
          parameters: [
            { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
          ],
          requestBody: {
            content: {
              'application/json': {
                schema: {
                  type: 'object',
                  required: ['business_name'],
                  properties: {
                    business_name: { type: 'string' },
                    email: { type: 'string' },
                    phone: { type: 'string' },
                    city: { type: 'string' },
                    category: { type: 'string' },
                    website: { type: 'string' },
                    status: { type: 'string' },
                    notes: { type: 'string' },
                  },
                },
              },
            },
          },
          responses: { 200: { description: 'Created lead' } },
        },
      },
      '/leads/{id}': {
        get: { summary: 'Get lead', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Lead' } } },
        patch: { summary: 'Update lead', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Updated lead' } } },
        delete: { summary: 'Delete lead', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Deleted' }, 409: { description: 'FK conflict' } } },
      },
      '/leads/{id}/score': {
        post: { summary: 'Score lead', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Score result' } } },
      },
      '/leads/{id}/qualify': {
        post: { summary: 'Qualify lead', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Qualified lead' } } },
      },
      '/leads/{id}/research': {
        post: { summary: 'Research lead', parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }], responses: { 200: { description: 'Research result' } } },
      },
      '/design/jobs': {
        get: {
          summary: 'List design jobs',
          parameters: [
            { name: 'status', in: 'query', schema: { type: 'string' } },
            { name: 'limit', in: 'query', schema: { type: 'integer' } },
          ],
          responses: { 200: { description: 'Job list' } },
        },
        post: {
          summary: 'Create design job',
          parameters: [{ name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } }],
          responses: { 200: { description: 'Created job' } },
        },
      },
      '/design/jobs/{id}': {
        get: {
          summary: 'Get design job (full, including deliverable when present)',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'Job' } },
        },
      },
      '/design/jobs/{id}/deliver': {
        post: {
          summary: 'Deliver design payload — returns compact receipt only',
          parameters: [
            { name: 'id', in: 'path', required: true, schema: { type: 'integer' } },
            { name: 'Idempotency-Key', in: 'header', schema: { type: 'string' } },
          ],
          responses: {
            200: {
              description: 'Receipt',
              content: { 'application/json': { schema: { $ref: '#/components/schemas/DeliverReceipt' } } },
            },
          },
        },
      },
      '/design/pending': {
        get: { summary: 'Jobs waiting on agent', responses: { 200: { description: 'Pending jobs' } } },
      },
      '/design/next': {
        post: { summary: 'Claim next waiting_on_agent job', responses: { 200: { description: 'Claimed job' } } },
      },
      '/websites': {
        get: { summary: 'List websites', responses: { 200: { description: 'Website list' } } },
      },
      '/websites/{id}': {
        get: {
          summary: 'Get website',
          parameters: [{ name: 'id', in: 'path', required: true, schema: { type: 'integer' } }],
          responses: { 200: { description: 'Website' } },
        },
      },
    },
  };
}

module.exports = { buildOpenApi };
