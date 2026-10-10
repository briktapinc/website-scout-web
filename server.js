'use strict';

require('dotenv').config();

const path = require('path');
const express = require('express');
const helmet = require('helmet');
const compression = require('compression');
const cookieParser = require('cookie-parser');
const session = require('express-session');
const cors = require('cors');

const { migrate, ping } = require('./server/db');
const { MySQLSessionStore } = require('./server/sessionStore');
const { findWorkspaceByToken } = require('./server/workspace');
const { handleJsonRpc, SERVER_INFO } = require('./server/mcp');
const { startScheduler } = require('./server/jobs');

const authRoutes = require('./server/routes/auth');
const domainApi = require('./server/routes/domainApi');
const jobsRoutes = require('./server/routes/jobs');
const mcpAdminRoutes = require('./server/routes/mcpAdmin');
const adminRoutes = require('./server/routes/admin');
const billingRoutes = require('./server/routes/billing');
const inviteRoutes = require('./server/routes/invites');

const PORT = Number(process.env.PORT || 3000);
const app = express();

app.set('trust proxy', 1);
app.use(helmet({
  contentSecurityPolicy: false,
}));
app.use(compression());
app.use(cors({
  origin: true,
  credentials: true,
}));

// Stripe webhooks need the raw body for signature verification — mount before JSON parser.
const stripeWebhook = require('./server/routes/stripeWebhook');
app.use('/api/v1/billing/webhook', express.raw({ type: 'application/json' }), stripeWebhook);

app.use(express.json({ limit: '2mb' }));
app.use(express.urlencoded({ extended: false }));
app.use(cookieParser());

// Secure cookies only when APP_URL is https (or COOKIE_SECURE=1).
// HTTP IP deploys must keep secure:false or the browser drops the session.
const cookieSecure = (() => {
  if (process.env.COOKIE_SECURE === '1' || process.env.COOKIE_SECURE === 'true') return true;
  if (process.env.COOKIE_SECURE === '0' || process.env.COOKIE_SECURE === 'false') return false;
  const appUrl = String(process.env.APP_URL || '');
  return /^https:/i.test(appUrl);
})();

app.use(session({
  name: 'scout.sid',
  secret: process.env.SESSION_SECRET || 'dev-change-me',
  resave: false,
  saveUninitialized: false,
  store: new MySQLSessionStore(),
  cookie: {
    httpOnly: true,
    sameSite: 'lax',
    secure: cookieSecure,
    maxAge: 14 * 24 * 60 * 60 * 1000,
  },
}));

app.get('/health', async (_req, res) => {
  try {
    await ping();
    res.json({
      ok: true,
      server: SERVER_INFO,
      db: true,
      endpoints: ['/api/v1', '/mcp', '/health'],
    });
  } catch (e) {
    res.status(503).json({ ok: false, error: e.message });
  }
});

const { requireSubscription } = require('./server/middleware');

app.use('/api/v1/auth', authRoutes);
app.use('/api/v1/admin', adminRoutes);
// Billing stays reachable without a paid plan (checkout / portal / delete).
app.use('/api/v1/billing', billingRoutes);
app.use('/api/v1/invites', inviteRoutes);
// Product APIs + jobs require an active subscription when the platform flag is on.
app.use('/api/v1/jobs', requireSubscription, jobsRoutes);
app.use('/api/v1/mcp', requireSubscription, mcpAdminRoutes);
app.use('/api/v1', requireSubscription, domainApi);

async function mcpHandler(req, res) {
  try {
    const auth = req.headers.authorization || '';
    if (!auth.startsWith('Bearer ')) {
      return res.status(401).json({ ok: false, error: 'Bearer token required' });
    }
    const ws = await findWorkspaceByToken(auth.slice(7).trim());
    if (!ws) return res.status(401).json({ ok: false, error: 'INVALID_TOKEN' });

    // Mirror product paywall for MCP bearer access
    {
      const billing = require('./server/billing');
      if (await billing.requireSubscriptionEnabled()) {
        const { query } = require('./server/db');
        const members = await query(
          `SELECT u.id, u.is_super_admin, u.subscription_status, u.status, u.deleted_at
           FROM workspace_members m
           JOIN users u ON u.id = m.user_id
           WHERE m.workspace_id = :workspaceId AND m.role IN ('owner','admin')`,
          { workspaceId: ws.workspace_id }
        );
        const ok = (members || []).some((u) => billing.isSubscribed(u));
        if (!ok) {
          return res.status(402).json({ ok: false, error: 'SUBSCRIPTION_REQUIRED', code: 'SUBSCRIPTION_REQUIRED' });
        }
      }
    }

    if (req.method === 'GET') {
      return res.json({
        ok: true,
        server: SERVER_INFO,
        workspaceId: ws.workspace_id,
        transport: 'streamable-http',
      });
    }

    const body = req.body;
    if (Array.isArray(body)) {
      const out = [];
      for (const item of body) {
        const r = await handleJsonRpc(ws.workspace_id, item);
        if (r) out.push(r);
      }
      return res.json(out.length === 1 ? out[0] : out);
    }
    const result = await handleJsonRpc(ws.workspace_id, body);
    if (result == null) return res.status(204).end();
    return res.json(result);
  } catch (e) {
    console.error('[mcp]', e);
    return res.status(500).json({ ok: false, error: e.message });
  }
}

app.post('/mcp', mcpHandler);
app.get('/mcp', mcpHandler);
app.post('/ws', mcpHandler);
app.get('/ws', mcpHandler);

app.use(express.static(path.join(__dirname, 'public')));

app.get('*', (req, res, next) => {
  if (req.path.startsWith('/api') || req.path.startsWith('/mcp') || req.path.startsWith('/ws')) {
    return next();
  }
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.use((err, _req, res, _next) => {
  console.error(err);
  const status = err.status || 500;
  res.status(status).json({ ok: false, error: err.message || 'Server error' });
});

async function main() {
  await migrate();
  console.log('[db] schema ready');

  const platform = require('./server/platform');
  await platform.seedPlatformDefaults();
  console.log('[platform] settings seeded');

  if (process.env.BOOTSTRAP_EMAIL && process.env.BOOTSTRAP_PASSWORD) {
    const { findUserByEmail, createUserWithWorkspace } = require('./server/workspace');
    const admin = require('./server/admin');
    const existing = await findUserByEmail(process.env.BOOTSTRAP_EMAIL);
    if (!existing) {
      const created = await createUserWithWorkspace({
        email: process.env.BOOTSTRAP_EMAIL,
        password: process.env.BOOTSTRAP_PASSWORD,
        name: process.env.BOOTSTRAP_NAME || 'Owner',
        workspaceName: process.env.BOOTSTRAP_WORKSPACE || 'Primary',
      });
      console.log('[bootstrap] created owner user + workspace', created.workspaceId);
      await admin.setSuperAdmin(created.userId, true);
      console.log('[bootstrap] promoted bootstrap user to super admin');
    } else if (
      process.env.BOOTSTRAP_SUPER_ADMIN === '1' ||
      process.env.BOOTSTRAP_SUPER_ADMIN === 'true' ||
      !process.env.BOOTSTRAP_SUPER_ADMIN
    ) {
      // Default: ensure bootstrap email is a super admin (safe for single-tenant ops).
      await admin.setSuperAdmin(existing.id, true);
      console.log('[bootstrap] ensured super admin for', process.env.BOOTSTRAP_EMAIL);
    }
  }

  startScheduler({ intervalMs: Number(process.env.JOB_TICK_MS || 30000) });
  app.listen(PORT, () => {
    console.log(`[website-scout-web] listening on :${PORT}`);
  });
}

main().catch((e) => {
  console.error('Failed to start:', e);
  process.exit(1);
});
