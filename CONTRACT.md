# Website Scout — integration contract

All workstreams read this. Do not deviate without telling the coordinator.

## Runtime
- Electron main process: `main.js` (BrowserWindow, auto-loads every module in `src/ipc/*.js` via fs.readdirSync — each registers its own `ipcMain.handle` channels; no edits to main.js needed).
- Preload: `preload.js` exposes ONLY `window.api.invoke(channel, ...args)` (context isolation on). No per-workstream preload code.
- DB: `src/db.js` exports a better-sqlite3 instance `db`, plus helpers `get/post` not needed — use prepared statements directly. DB file: `app.getPath('userData')/websitescout.db`, initialized from `src/schema.sql`, seeded by `src/seed.js`.
- AI client: `src/ai.js` (owned by Website Engine workstream) exports:
  - `async function chat({ task, messages, maxTokens, leadId, note })` — task in {research, generation, scoring, email, qa, editor, followup}. Reads settings: `ai.api_key`, `ai.base_url`, `ai.model.<task>` (fallback `ai.model.default`). Enforces `automation_paused` and `cost.daily_budget_usd`. Logs every call to `ai_usage` with rough cost estimate (settings `cost.per_1k_prompt`, `cost.per_1k_completion`, defaults 0.0015/0.002).
  - `function aiConfigured()` — true when an API key is set.
  - Without a key: chat() throws `AI_NOT_CONFIGURED`; generators must fall back to deterministic template output.
- Settings keys (seeded): `ai.api_key`, `ai.base_url` (default https://api.openai.com/v1), `ai.model.default`, `ai.model.research|generation|scoring|email|qa|editor|followup`, `cost.daily_budget_usd` (default 10), `cost.max_websites_per_day` (25), `cost.max_outreach_per_day` (200), `automation_paused` (0/1), `smtp.*` (host,port,secure,user,pass,from_name,from_email), `mail.footer`, `score.threshold_qualified` (50), `score.threshold_hot` (70), `app.name`, `cf.api_token`, `cf.account_id`, `cf.project`, `cf.preview_domain`.

## IPC channels (namespaced)
- Leads: `leads:list {q, status, minScore, tag, sort, page, pageSize}`, `leads:get id`, `leads:create obj`, `leads:update {id, obj}`, `leads:delete id`, `leads:score id`, `leads:qualify id`, `leads:merge {keepId, dropIds}`, `leads:bulk {action, ids}` (action: tag|untag|status|delete|research), `leads:importCsv text`, `leads:research id`, `leads:events id`, `leads:facts id`, `leads:duplicates id`, `providers:list`, `providers:search {provider, ...opts}`
- Sites: `sites:list {status}`, `sites:get id`, `sites:generate leadId`, `sites:save {id, pages, theme, note}`, `sites:versions id`, `sites:restore versionId`, `sites:qa id`, `sites:export id`, `sites:forLead leadId`
- Outreach: `campaigns:list`, `campaigns:create {name, templateId, leadIds, ratePerHour}`, `campaigns:setStatus {id, status}`, `templates:list`, `templates:save {id?, name, subject, body}`, `outreach:processQueue`, `outreach:stats`, `suppression:list`, `suppression:add {email, reason}`, `timeline:get leadId`, `intent:get leadId`, `intent:record {leadId, type, detail}`, `pipeline:board`, `dashboard:stats`
- System: `settings:getAll`, `settings:set {key, value}`, `settings:setSecret {key, value}` (secrets only: `ai.api_key`, `smtp.pass`, `cf.api_token`; never returned in cleartext), `prompts:list`, `prompts:save {key, body}`, `prompts:reset key`, `ai:usage {days}`, `automation:pause`, `automation:resume`, `activity:recent {limit}`
- Publishing (Cloudflare Pages): `cloudflare:getConfig` → `{configured, accountId, project, previewDomain}` (token never returned), `cloudflare:saveConfig {apiToken, accountId, project, previewDomain}`, `cloudflare:testConnection`, `cloudflare:publish {websiteId, dir?}` → `{ok:true, url, ...}` / `{ok:false, error}` (falls back to websiteEngine.exportStatic when dir omitted)
- Publishing (Cloudflare Pages): `cloudflare:getConfig` → `{configured, accountId, project, previewDomain}` (token never returned), `cloudflare:saveConfig {apiToken, accountId, project, previewDomain}` → `{ok}` / `{ok:false, error, hint?}`, `cloudflare:testConnection` → `{ok, projects}` / `{ok:false, error}`, `cloudflare:publish {websiteId, dir?}` → `{ok:true, url, deploymentId, project}` / `{ok:false, error, hint?|detail?}` — if `dir` is omitted, main exports via `websiteEngine.exportStatic(db, websiteId, tmpdir)` first.

## Renderer conventions
- One `.html` + one `.js` per page under `renderer/`. Shell: `renderer/index.html` + `renderer/app.js` (nav router loading pages into #view) + `renderer/styles.css`.
- All data access via `window.api.invoke(...)`. Escape user content before innerHTML. Validate inputs before sending.
- Clean, functional UI. No flashy styling.

## Rules for every workstream
- No secrets in code. No hardcoded pricing. Validate all inputs.
- `node --check` every JS file you write before finishing.
- Anti-hallucination: never invent business facts in generated copy. Claim classification VERIFIED / AI_COPY / OWNER_PROVIDED / UNKNOWN on business_facts.
- Social media, SEO, review management: NOT in scope — leave clean extension points only.
- Single-user app: no tenants, no auth, no billing UI.
