# Website Scout Web

Multi-tenant web rebuild of Website Scout for **Hostinger Node.js** hosting.

- Email/password auth
- Workspaces (tenants) with roles: `owner` / `admin` / `member`
- Per-workspace settings (secrets write-only)
- Leads + design job queue
- **Scheduled jobs** in the app and via MCP (`jobs.*`)
- MCP HTTP at `/mcp` with per-workspace Bearer tokens
- MySQL (not SQLite)

The original Electron app in `website-scout` is unchanged. Legacy `src/`, `main.js`, and `renderer/` copies in this folder are unused leftovers from the copy step — the live app is `server.js` + `server/` + `public/`.

## Local setup

**Quick local (no Docker):** set `DB_DRIVER=sqlite` in `.env` (default in a fresh local `.env`), then:

```bash
npm install
npm start
```

**MySQL local (matches Hostinger):**

```bash
docker compose up -d
# .env → DB_DRIVER=mysql + MYSQL_* credentials
npm install
npm start
```

Copy `.env.example` to `.env` and set a strong `SESSION_SECRET` before production.

Open http://localhost:3000 — register an account (creates your first workspace).

Optional bootstrap user via env:

```
BOOTSTRAP_EMAIL=you@example.com
BOOTSTRAP_PASSWORD=your-password
BOOTSTRAP_WORKSPACE=Primary
```

Mint an MCP token from the **MCP** page, or:

```bash
node scripts/seed-admin.js you@example.com your-password --token
```

## Hostinger deploy

1. Create a **Node.js Web App** (Business/Cloud plan) and a **MySQL** database in hPanel.
2. Set framework to **Express**, Node **20** or **22**, entry file `server.js`, start script `npm start`.
3. Configure environment variables from `.env.example` (`MYSQL_*`, `SESSION_SECRET`, `APP_URL`, `NODE_ENV=production`).
4. Deploy via GitHub or ZIP of this folder (exclude `node_modules`).
5. After first boot, register at your domain or use `BOOTSTRAP_*` env vars.

The server binds to `process.env.PORT` (required on Hostinger).

## MCP (Cursor / agents)

- URL: `https://your-domain.com/mcp`
- Header: `Authorization: Bearer <workspace-token>`
- Tools include leads, design queue, settings, automation pause/resume, analytics, and:

| Tool | Purpose |
|------|---------|
| `jobs.list` | List scheduled jobs |
| `jobs.create` | Create discovery / outreach_process / design_poll_notify / custom |
| `jobs.update` | Enable/disable, change interval/payload |
| `jobs.delete` | Remove a job |
| `jobs.runNow` | Run immediately |

Jobs also run on a 30s server ticker while the Node process is up (no desktop app required).

## API surface (session or Bearer)

- `POST /api/v1/auth/register|login|logout`
- `GET /api/v1/auth/me`
- `GET /api/v1/dashboard/stats`
- `CRUD /api/v1/leads`
- `GET|POST /api/v1/design…`
- `CRUD /api/v1/jobs` + `POST /api/v1/jobs/:id/run`
- `GET|PUT /api/v1/settings` (+ `/secret`, `/automation`)
- `GET|POST /api/v1/mcp/status|token`

All workspace routes require `X-Workspace-Id` (browser session) or a Bearer MCP/API token.
