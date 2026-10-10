# Website Scout — Workstream 6 integration patches (Cloudflare Pages publishing)

Workstream 6 added four new files (no existing file was touched):

- `src/cloudflare.js` — Pages Direct-Upload client (dependency-free, `node:https` only)
- `src/ipc/cloudflare.js` — IPC registration (`register(ipcMain, db)`)
- `renderer/cloudflare-publish-snippet.js` — splice-in HTML/JS fragment for the Websites page
- `PATCHES.md` (this file)

Apply the patches below **after all workstreams have landed**. Nothing here
requires editing `main.js` (it auto-loads every `src/ipc/*.js` module with a
`register()` export) or `preload.js` (it exposes generic `window.api.invoke`).

---

## (a) Settings whitelist — `src/seed.js`

`SETTINGS_WHITELIST` is derived from `SETTING_SEEDS` (`src/seed.js:47`), so
this is the only edit needed. Add a Cloudflare block to `SETTING_SEEDS`
(right after the `// App` entries):

```js
  // Cloudflare Pages publishing (Workstream 6)
  ['cf.api_token', ''],
  ['cf.account_id', ''],
  ['cf.project', ''],
  ['cf.preview_domain', ''],
```

Notes:
- The new `cloudflare:saveConfig` channel writes these keys **directly** via
  `INSERT OR REPLACE`, so publishing works even before this patch is applied.
  The whitelist addition lets the Settings page / `settings:set` manage them too.
- ⚠️ `settings:getAll` (in `src/ipc/core.js`) returns **every** settings row to
  the renderer, including `cf.api_token`. That is consistent with existing
  behavior (`ai.api_key`, `smtp.pass` are equally exposed), but the Settings
  page should render `cf.api_token` as a password field and ideally the
  coordinator should mask secret keys (`cf.api_token`, `ai.api_key`,
  `smtp.pass`) out of `settings:getAll` responses.

## (b) Outreach personalization — prefer `preview_url` over `preview_path`

`personalize()` lives in `src/email.js` and accepts an `extra` vars object
(keys are lowercased, so `preview_url` becomes the `{{preview_url}}` template
variable). The call site is the campaign queue builder in `src/outreach.js`
(~line 330, where `personalize({subject, body}, lead, facts, {from_name})`
is called). Change it to:

```js
const site = db.prepare(
  'SELECT preview_url, preview_path FROM websites WHERE lead_id = ?'
).get(leadId);
const previewLink = (site && (site.preview_url || site.preview_path)) || '';
const { subject, body } = personalize(
  { subject: template.subject, body: template.body },
  lead, facts, { from_name: fromName, preview_url: previewLink }
);
```

That makes `{{preview_url}}` in templates resolve to the public Cloudflare URL
when a site has been published, falling back to the local `preview_path`
otherwise. Suggested template copy: `View your free preview site: {{preview_url}}`
(`preview_path` is a local filesystem path — never email it).

## (c) README section (Cloudflare Pages publishing)

Suggested text for the README, under a "Publishing" heading:

```md
### Cloudflare Pages publishing (optional)

Website Scout can publish a generated site to Cloudflare Pages so prospects
get a real public preview URL (stored on `websites.preview_url`).

1. In Cloudflare, create an **API token** with the **Account → Cloudflare
   Pages → Edit** permission (dashboard → Manage Account → API Tokens).
2. In the app, go to **Settings → Cloudflare** and paste the token, your
   32-character **Account ID**, and the **Pages project** name (lowercase
   letters, numbers, hyphens). The project is created automatically on first
   publish if it doesn't exist.
3. On a website, click **Publish preview**. The app uploads the exported
   folder via the Pages Direct Upload REST API — no `wrangler` needed.

**Limitations**

- Requires a Cloudflare API token with the **Pages:Edit** scope; read-only
  tokens fail the connection test.
- Files larger than **25 MB** are skipped; max **20,000 files** per deployment.
- Publishing needs network access to `api.cloudflare.com`; uploads time out
  after 10 minutes.
- Outreach emails use the public `preview_url` when present, otherwise the
  local `preview_path`.
```

## (d) CONTRACT.md channel additions

Append to the **IPC channels** section (after the System block, or as a new
"Publishing" block):

```md
- Publishing (Cloudflare Pages): `cloudflare:getConfig` → `{configured,
  accountId, project, previewDomain}` (token never returned),
  `cloudflare:saveConfig {apiToken, accountId, project, previewDomain}` →
  `{ok}` / `{ok:false, error, hint?}`,
  `cloudflare:testConnection` → `{ok, projects}` / `{ok:false, error}`,
  `cloudflare:publish {websiteId, dir?}` → `{ok:true, url, deploymentId,
  project}` / `{ok:false, error, hint?|detail?}` — if `dir` is omitted, main
  tries `websiteEngine.exportStatic(db, websiteId, tmpdir)` and returns
  `NEEDS_EXPORT` when that module isn't available.
```

Also append to the **Settings keys (seeded)** list in the Runtime section:
`cf.api_token`, `cf.account_id`, `cf.project`, `cf.preview_domain`.

### Schema note

`websites.preview_url` is added **idempotently at runtime** by
`ensureColumn()` (checks `PRAGMA table_info(websites)` first; called on every
publish). The coordinator may also add `preview_url TEXT` to the `websites`
table in `src/schema.sql` — harmless, since `ensureColumn()` is a no-op when
the column already exists.

---

## Verification performed (Workstream 6)

- `node --check` passes on all new JS files.
- Unit tests (all passing):
  - Filesystem: `collectFiles` (nested dirs, sha256 correctness vs
    `crypto`, symlink skip, >25MB skip, 20k cap) and `buildFormData`
    (manifest field, one part per unique hash named by sha256, dedupe,
    content-length).
  - Logic against a mock better-sqlite3 surface: `ensureColumn` idempotency,
    `saveConfig` validation (bad token / account ID / project / domain
    rejected, good config accepted), `getConfig` never returns the token,
    `publishDirectory` early validation (`INVALID_WEBSITE_ID` / `INVALID_DIR` /
    `UNKNOWN_WEBSITE`), IPC channel registration + `websiteId` validation.
  - SQL validated with the `sqlite3` CLI against the real `src/schema.sql`:
    `ALTER TABLE … ADD COLUMN preview_url` (and that a second ALTER fails —
    hence the PRAGMA guard), settings round-trip, `UPDATE websites SET
    preview_url`, `activity_log` insert.
- A full real-better-sqlite3 run was blocked: another workstream's
  `npm install better-sqlite3` (full `node-gyp` source rebuild) was still
  compiling when this workstream finished, so the native binding wasn't
  loadable yet. Re-run `/tmp/cf-unit-test.js` once the install completes.
- Not tested: live `testConnection` / `publishDirectory` (no real API token;
  requires Ely to paste one in Settings).
- Note: `src/websiteEngine.js` has since landed with a real
  `exportStatic(db, websiteId, outDir)` (returns `outDir` string), so the
  `cloudflare:publish` no-dir fallback now resolves to the real exporter;
  the `NEEDS_EXPORT` path remains for safety.
