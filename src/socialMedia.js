'use strict';

/**
 * Facebook + Instagram social manager for website clients.
 * Images are optional (IG feed posts without media are skipped).
 */

const crypto = require('crypto');
const { URLSearchParams } = require('url');

const META_GRAPH = 'https://graph.facebook.com/v21.0';
const PLATFORMS = ['facebook', 'instagram'];
const POST_STATUSES = [
  'draft', 'pending_approval', 'approved', 'scheduled', 'posting', 'posted', 'failed', 'rejected', 'skipped',
];

function fail(code, message) {
  const err = new Error(message);
  err.code = code;
  return err;
}

function setting(db, key, fallback = '') {
  const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
  return row && row.value != null ? String(row.value) : fallback;
}

function logActivity(db, message) {
  try {
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run('social', message);
  } catch { /* optional */ }
}

function appSecret() {
  return process.env.SESSION_SECRET || process.env.META_TOKEN_SECRET || 'dev-change-me';
}

function encToken(plain) {
  if (!plain) return '';
  const key = crypto.createHash('sha256').update(appSecret()).digest();
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', key, iv);
  const enc = Buffer.concat([cipher.update(String(plain), 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, enc]).toString('base64url');
}

function decToken(blob) {
  if (!blob) return '';
  try {
    const buf = Buffer.from(String(blob), 'base64url');
    const iv = buf.subarray(0, 12);
    const tag = buf.subarray(12, 28);
    const data = buf.subarray(28);
    const key = crypto.createHash('sha256').update(appSecret()).digest();
    const decipher = crypto.createDecipheriv('aes-256-gcm', key, iv);
    decipher.setAuthTag(tag);
    return Buffer.concat([decipher.update(data), decipher.final()]).toString('utf8');
  } catch {
    return '';
  }
}

function ensureTables(db) {
  db.exec(`
    CREATE TABLE IF NOT EXISTS social_accounts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      platform TEXT NOT NULL,
      account_id TEXT NOT NULL,
      account_name TEXT,
      page_id TEXT,
      access_token_enc TEXT,
      token_expires_at TEXT,
      meta_json TEXT,
      status TEXT NOT NULL DEFAULT 'active',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now')),
      UNIQUE(lead_id, platform, account_id)
    );
    CREATE TABLE IF NOT EXISTS social_campaigns (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      lead_id INTEGER NOT NULL,
      title TEXT,
      month_start TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'draft',
      brief TEXT,
      with_images INTEGER NOT NULL DEFAULT 0,
      require_client_approval INTEGER NOT NULL DEFAULT 1,
      client_email TEXT,
      timezone TEXT NOT NULL DEFAULT 'America/New_York',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS social_posts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      day_index INTEGER NOT NULL DEFAULT 0,
      scheduled_at TEXT,
      caption TEXT NOT NULL DEFAULT '',
      platforms TEXT NOT NULL DEFAULT '["facebook","instagram"]',
      image_url TEXT,
      image_prompt TEXT,
      status TEXT NOT NULL DEFAULT 'draft',
      client_notes TEXT,
      publish_error TEXT,
      published_at TEXT,
      meta_results TEXT,
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE TABLE IF NOT EXISTS social_weekly_batches (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      campaign_id INTEGER NOT NULL,
      lead_id INTEGER NOT NULL,
      week_start TEXT,
      week_end TEXT,
      approval_token TEXT NOT NULL UNIQUE,
      status TEXT NOT NULL DEFAULT 'pending',
      sent_at TEXT,
      decided_at TEXT,
      post_ids TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT (datetime('now')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now'))
    );
    CREATE INDEX IF NOT EXISTS idx_social_posts_campaign ON social_posts(campaign_id);
    CREATE INDEX IF NOT EXISTS idx_social_posts_status_sched ON social_posts(status, scheduled_at);
    CREATE INDEX IF NOT EXISTS idx_social_accounts_lead ON social_accounts(lead_id);
  `);
}

function parseJson(raw, fallback) {
  try { return JSON.parse(raw || ''); } catch { return fallback; }
}

function publicAccount(row) {
  if (!row) return null;
  return {
    id: row.id,
    lead_id: row.lead_id,
    platform: row.platform,
    account_id: row.account_id,
    account_name: row.account_name,
    page_id: row.page_id,
    status: row.status,
    token_expires_at: row.token_expires_at,
    has_token: !!row.access_token_enc,
    created_at: row.created_at,
    updated_at: row.updated_at,
  };
}

function publicPost(row) {
  if (!row) return null;
  return {
    ...row,
    platforms: parseJson(row.platforms, ['facebook', 'instagram']),
    meta_results: parseJson(row.meta_results, null),
    with_image: !!(row.image_url && String(row.image_url).trim()),
  };
}

function publicCampaign(row) {
  if (!row) return null;
  return {
    ...row,
    with_images: !!row.with_images,
    require_client_approval: !!row.require_client_approval,
  };
}

function appUrl() {
  return String(process.env.APP_URL || 'http://127.0.0.1:3000').replace(/\/$/, '');
}

function metaConfigured(db) {
  const appId = setting(db, 'meta.app_id', '').trim();
  const secret = setting(db, 'meta.app_secret', '').trim();
  return !!(appId && secret);
}

function signState(payload) {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  const sig = crypto.createHmac('sha256', appSecret()).update(body).digest('base64url');
  return `${body}.${sig}`;
}

function verifyState(state) {
  const [body, sig] = String(state || '').split('.');
  if (!body || !sig) throw fail('INVALID_STATE', 'Invalid OAuth state');
  const expect = crypto.createHmac('sha256', appSecret()).update(body).digest('base64url');
  const a = Buffer.from(sig);
  const b = Buffer.from(expect);
  if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) {
    throw fail('INVALID_STATE', 'Invalid OAuth state signature');
  }
  const data = JSON.parse(Buffer.from(body, 'base64url').toString('utf8'));
  if (!data || !data.exp || Date.now() > data.exp) throw fail('EXPIRED_STATE', 'OAuth state expired');
  return data;
}

async function metaFetch(path, { method = 'GET', token, body, form } = {}) {
  const url = path.startsWith('http') ? path : `${META_GRAPH}${path}`;
  const headers = {};
  let payload;
  if (form) {
    payload = new URLSearchParams(form).toString();
    headers['Content-Type'] = 'application/x-www-form-urlencoded';
  } else if (body != null) {
    payload = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const u = new URL(url);
  if (token && !u.searchParams.has('access_token')) u.searchParams.set('access_token', token);
  const res = await fetch(u.toString(), { method, headers, body: payload });
  const data = await res.json().catch(() => ({}));
  if (!res.ok || data.error) {
    const msg = (data.error && (data.error.message || data.error.error_user_msg)) || `Meta API ${res.status}`;
    throw fail('META_API', msg);
  }
  return data;
}

function oauthStart(db, { workspaceId, leadId, returnTo } = {}) {
  ensureTables(db);
  const lead = db.prepare('SELECT id, business_name FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const appId = setting(db, 'meta.app_id', '').trim();
  if (!appId || !setting(db, 'meta.app_secret', '').trim()) {
    throw fail('META_NOT_CONFIGURED', 'Set meta.app_id and meta.app_secret in Settings → Social.');
  }
  const redirectUri = `${appUrl()}/api/v1/social/meta/callback`;
  const state = signState({
    w: Number(workspaceId),
    l: Number(leadId),
    r: returnTo || `#/social?leadId=${leadId}`,
    exp: Date.now() + 20 * 60 * 1000,
  });
  const scopes = [
    'pages_show_list',
    'pages_read_engagement',
    'pages_manage_posts',
    'pages_manage_metadata',
    'instagram_basic',
    'instagram_content_publish',
    'business_management',
  ].join(',');
  const url = new URL('https://www.facebook.com/v21.0/dialog/oauth');
  url.searchParams.set('client_id', appId);
  url.searchParams.set('redirect_uri', redirectUri);
  url.searchParams.set('state', state);
  url.searchParams.set('scope', scopes);
  url.searchParams.set('response_type', 'code');
  return { url: url.toString(), redirectUri, leadId: lead.id };
}

async function oauthCallback(db, { code, state } = {}) {
  ensureTables(db);
  const st = verifyState(state);
  const appId = setting(db, 'meta.app_id', '').trim();
  const appSecretVal = setting(db, 'meta.app_secret', '').trim();
  const redirectUri = `${appUrl()}/api/v1/social/meta/callback`;

  const tokenRes = await metaFetch(`/oauth/access_token?${new URLSearchParams({
    client_id: appId,
    client_secret: appSecretVal,
    redirect_uri: redirectUri,
    code: String(code || ''),
  })}`);

  let userToken = tokenRes.access_token;
  try {
    const ll = await metaFetch(`/oauth/access_token?${new URLSearchParams({
      grant_type: 'fb_exchange_token',
      client_id: appId,
      client_secret: appSecretVal,
      fb_exchange_token: userToken,
    })}`);
    if (ll.access_token) userToken = ll.access_token;
  } catch { /* keep short-lived */ }

  const pages = await metaFetch('/me/accounts?fields=id,name,access_token,instagram_business_account{id,username,name}', {
    token: userToken,
  });
  const list = Array.isArray(pages.data) ? pages.data : [];
  if (!list.length) throw fail('NO_PAGES', 'No Facebook Pages found for this Meta user.');

  const leadId = Number(st.l);
  let fbCount = 0;
  let igCount = 0;
  const upsert = db.prepare(`
    INSERT INTO social_accounts (
      lead_id, platform, account_id, account_name, page_id, access_token_enc, status, meta_json, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, 'active', ?, datetime('now'))
    ON CONFLICT(lead_id, platform, account_id) DO UPDATE SET
      account_name = excluded.account_name,
      page_id = excluded.page_id,
      access_token_enc = excluded.access_token_enc,
      status = 'active',
      meta_json = excluded.meta_json,
      updated_at = datetime('now')
  `);

  for (const page of list) {
    if (!page.id || !page.access_token) continue;
    upsert.run(
      leadId, 'facebook', String(page.id), page.name || page.id, String(page.id),
      encToken(page.access_token), JSON.stringify({ source: 'oauth' })
    );
    fbCount += 1;
    const ig = page.instagram_business_account;
    if (ig && ig.id) {
      upsert.run(
        leadId, 'instagram', String(ig.id), ig.username || ig.name || ig.id, String(page.id),
        encToken(page.access_token), JSON.stringify({ username: ig.username || null })
      );
      igCount += 1;
    }
  }

  logActivity(db, `Connected Meta for lead #${leadId}: ${fbCount} Facebook Page(s), ${igCount} Instagram.`);
  return {
    workspaceId: Number(st.w),
    leadId,
    returnTo: st.r || `#/social?leadId=${leadId}`,
    facebook: fbCount,
    instagram: igCount,
  };
}

function listAccounts(db, leadId) {
  ensureTables(db);
  const rows = db.prepare(
    'SELECT * FROM social_accounts WHERE lead_id = ? ORDER BY platform, account_name'
  ).all(Number(leadId));
  return { accounts: rows.map(publicAccount), metaConfigured: metaConfigured(db) };
}

function disconnectAccount(db, accountId) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM social_accounts WHERE id = ?').get(Number(accountId));
  if (!row) throw fail('NOT_FOUND', 'Account not found');
  db.prepare('DELETE FROM social_accounts WHERE id = ?').run(row.id);
  logActivity(db, `Disconnected ${row.platform} account ${row.account_name || row.account_id} from lead #${row.lead_id}`);
  return { id: row.id };
}

function listCampaigns(db, { leadId } = {}) {
  ensureTables(db);
  let rows;
  if (leadId) {
    rows = db.prepare('SELECT * FROM social_campaigns WHERE lead_id = ? ORDER BY id DESC').all(Number(leadId));
  } else {
    rows = db.prepare('SELECT * FROM social_campaigns ORDER BY id DESC LIMIT 100').all();
  }
  return { campaigns: rows.map(publicCampaign) };
}

function getCampaign(db, campaignId) {
  ensureTables(db);
  const campaign = db.prepare('SELECT * FROM social_campaigns WHERE id = ?').get(Number(campaignId));
  if (!campaign) throw fail('NOT_FOUND', 'Campaign not found');
  const posts = db.prepare(
    'SELECT * FROM social_posts WHERE campaign_id = ? ORDER BY scheduled_at ASC, day_index ASC, id ASC'
  ).all(campaign.id).map(publicPost);
  const batches = db.prepare(
    'SELECT id, campaign_id, week_start, week_end, status, sent_at, decided_at, post_ids, created_at FROM social_weekly_batches WHERE campaign_id = ? ORDER BY id DESC'
  ).all(campaign.id).map((b) => ({ ...b, post_ids: parseJson(b.post_ids, []) }));
  const accounts = listAccounts(db, campaign.lead_id).accounts;
  return { campaign: publicCampaign(campaign), posts, batches, accounts };
}

function leadBrief(db, leadId) {
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(Number(leadId));
  if (!lead) throw fail('NOT_FOUND', 'Lead not found');
  const facts = db.prepare(
    `SELECT fact_key, value, claim_class FROM business_facts
     WHERE lead_id = ? AND claim_class IN ('VERIFIED','OWNER_PROVIDED')
     ORDER BY id DESC LIMIT 40`
  ).all(lead.id);
  let siteSnippet = '';
  try {
    const site = db.prepare('SELECT id, name, status FROM websites WHERE lead_id = ? ORDER BY id DESC LIMIT 1').get(lead.id);
    if (site) siteSnippet = `Website on file: ${site.name} (${site.status}).`;
  } catch { /* optional */ }
  return { lead, facts, siteSnippet };
}

function deterministicPosts(lead, count, monthStart) {
  const name = lead.business_name || 'our business';
  const cat = lead.category || 'local business';
  const city = [lead.city, lead.state].filter(Boolean).join(', ') || 'your area';
  const templates = [
    (i) => `Looking for a reliable ${cat.toLowerCase()} in ${city}? ${name} is here to help. Reach out today.`,
    (i) => `Tip from ${name}: regular maintenance saves money and stress. Ask us what we recommend for ${cat.toLowerCase()} clients.`,
    (i) => `This week at ${name} — we're booking ${cat.toLowerCase()} appointments in ${city}. Message us to get on the calendar.`,
    (i) => `Why neighbors choose ${name}: local care, clear communication, and work we're proud of.`,
    (i) => `Quick question for ${city}: what's the #1 thing you want from a ${cat.toLowerCase()}? Tell us below.`,
    (i) => `${name} reminder: small issues become big ones. A quick check-in now can spare a headache later.`,
    (i) => `Proud to serve ${city}. If you need a trusted ${cat.toLowerCase()}, ${name} is ready when you are.`,
  ];
  const start = new Date(`${monthStart}T14:00:00.000Z`);
  if (Number.isNaN(start.getTime())) throw fail('INVALID_DATE', 'monthStart must be YYYY-MM-DD');
  const out = [];
  for (let i = 0; i < count; i += 1) {
    const d = new Date(start.getTime() + i * 24 * 60 * 60 * 1000);
    // Prefer Tue–Sat feel: skip some Sundays by shifting
    out.push({
      day_index: i + 1,
      scheduled_at: d.toISOString(),
      caption: templates[i % templates.length](i),
      platforms: ['facebook', 'instagram'],
      image_prompt: null,
    });
  }
  return out;
}

async function generateMonth(db, {
  leadId,
  monthStart,
  days = 30,
  withImages = false,
  brief = '',
  clientEmail = '',
  requireClientApproval = true,
  timezone = 'America/New_York',
  activate = true,
} = {}) {
  ensureTables(db);
  const { lead, facts, siteSnippet } = leadBrief(db, leadId);
  const count = Math.min(60, Math.max(7, Number(days) || 30));
  const start = String(monthStart || new Date().toISOString().slice(0, 10));
  const factLines = facts.map((f) => `${f.fact_key}: ${f.value}`).join('\n');

  let items = null;
  try {
    const ai = require('./ai');
    if (typeof ai.setDb === 'function') ai.setDb(db);
    if (ai.aiConfigured && ai.aiConfigured(db)) {
      const res = await ai.chat({
        task: 'generation',
        db,
        leadId: lead.id,
        note: 'social_month',
        maxTokens: 4000,
        messages: [
          {
            role: 'system',
            content: `You write a month of Facebook/Instagram captions for a local business.
Return ONLY valid JSON: {"posts":[{"day_index":1,"caption":"...","platforms":["facebook","instagram"],"image_prompt":null}]}
Rules:
- Exactly ${count} posts.
- Never invent phone numbers, addresses, hours, reviews, prices, or certifications.
- Use only provided facts; otherwise keep copy general.
- Captions 1–3 short sentences, natural spoken English, no hashtag spam (0–3 hashtags max).
- image_prompt: null unless images were requested.
- Vary topics: tips, CTA, local pride, reminders, questions.`,
          },
          {
            role: 'user',
            content: `Business: ${lead.business_name}
Category: ${lead.category || ''}
Location: ${[lead.city, lead.state].filter(Boolean).join(', ')}
Website: ${lead.website || 'none'}
${siteSnippet}
Verified facts:
${factLines || '(none)'}
Extra brief: ${brief || '(none)'}
Images requested: ${withImages ? 'yes — include a short photo prompt per post' : 'no — set image_prompt null'}
Month starts: ${start}
Post count: ${count}`,
          },
        ],
      });
      const text = (res && (res.content || res.text || res.message)) || '';
      const m = String(text).match(/\{[\s\S]*\}/);
      if (m) {
        const parsed = JSON.parse(m[0]);
        if (Array.isArray(parsed.posts) && parsed.posts.length) items = parsed.posts;
      }
    }
  } catch (e) {
    if (e.code === 'AUTOMATION_PAUSED' || e.code === 'BUDGET_EXCEEDED') throw e;
    /* fall back */
  }
  if (!items) items = deterministicPosts(lead, count, start);

  const email = String(clientEmail || lead.email || '').trim();
  const info = db.prepare(`
    INSERT INTO social_campaigns (
      lead_id, title, month_start, status, brief, with_images, require_client_approval, client_email, timezone
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(
    lead.id,
    `${lead.business_name || 'Campaign'} · ${start.slice(0, 7)}`,
    start,
    activate ? 'active' : 'draft',
    String(brief || ''),
    withImages ? 1 : 0,
    requireClientApproval ? 1 : 0,
    email,
    String(timezone || 'America/New_York')
  );
  const campaignId = Number(info.lastInsertRowid);
  const base = new Date(`${start}T14:00:00.000Z`);
  const insert = db.prepare(`
    INSERT INTO social_posts (
      campaign_id, lead_id, day_index, scheduled_at, caption, platforms, image_url, image_prompt, status
    ) VALUES (?, ?, ?, ?, ?, ?, NULL, ?, 'draft')
  `);

  let n = 0;
  for (let i = 0; i < items.length && n < count; i += 1) {
    const it = items[i] || {};
    const caption = String(it.caption || '').trim();
    if (!caption) continue;
    const dayIndex = Number(it.day_index) || (n + 1);
    const scheduled = it.scheduled_at
      ? new Date(it.scheduled_at)
      : new Date(base.getTime() + n * 24 * 60 * 60 * 1000);
    let platforms = Array.isArray(it.platforms) ? it.platforms.filter((p) => PLATFORMS.includes(p)) : PLATFORMS.slice();
    if (!platforms.length) platforms = PLATFORMS.slice();
    const imagePrompt = withImages ? (it.image_prompt || `Authentic photo for ${lead.business_name}, ${lead.category || 'local business'}, no fake text`) : null;
    insert.run(
      campaignId,
      lead.id,
      dayIndex,
      scheduled.toISOString(),
      caption.slice(0, 2200),
      JSON.stringify(platforms),
      imagePrompt
    );
    n += 1;
  }

  if (withImages) {
    await attachOptionalImages(db, campaignId).catch(() => {});
  }

  logActivity(db, `Social campaign #${campaignId} created for lead #${lead.id} (${n} posts, images=${withImages ? 'on' : 'off'}).`);
  return getCampaign(db, campaignId);
}

async function attachOptionalImages(db, campaignId) {
  const posts = db.prepare(
    "SELECT * FROM social_posts WHERE campaign_id = ? AND (image_url IS NULL OR image_url = '') ORDER BY id"
  ).all(Number(campaignId));
  if (!posts.length) return { attached: 0 };
  const apiKey = setting(db, 'pexels.api_key', '').trim();
  if (!apiKey) return { attached: 0, reason: 'no_pexels_key' };
  let pexels;
  try { pexels = require('./pexels'); } catch { return { attached: 0, reason: 'no_pexels' }; }
  const campaign = db.prepare('SELECT * FROM social_campaigns WHERE id = ?').get(Number(campaignId));
  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(campaign.lead_id);
  let attached = 0;
  for (const post of posts.slice(0, 30)) {
    const q = post.image_prompt || `${lead.category || 'business'} ${lead.city || ''}`.trim();
    try {
      const photos = await pexels.searchPhotos(apiKey, q, 1);
      const photo = Array.isArray(photos) ? photos[0] : null;
      const url = photo && (photo.url || photo.src || (photo.original) || null);
      if (url) {
        db.prepare("UPDATE social_posts SET image_url = ?, updated_at = datetime('now') WHERE id = ?").run(String(url), post.id);
        attached += 1;
      }
    } catch { /* skip */ }
  }
  return { attached };
}

function updatePost(db, postId, patch = {}) {
  ensureTables(db);
  const row = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(Number(postId));
  if (!row) throw fail('NOT_FOUND', 'Post not found');
  if (['posted', 'posting'].includes(row.status) && patch.caption == null && patch.scheduled_at == null) {
    /* allow notes */
  }
  const caption = patch.caption != null ? String(patch.caption).slice(0, 2200) : row.caption;
  const scheduled_at = patch.scheduled_at != null ? String(patch.scheduled_at) : row.scheduled_at;
  let platforms = row.platforms;
  if (patch.platforms != null) {
    const list = Array.isArray(patch.platforms)
      ? patch.platforms
      : String(patch.platforms).split(',').map((s) => s.trim());
    platforms = JSON.stringify(list.filter((p) => PLATFORMS.includes(p)));
  }
  const image_url = patch.image_url !== undefined ? (patch.image_url ? String(patch.image_url) : null) : row.image_url;
  let status = row.status;
  if (patch.status && POST_STATUSES.includes(patch.status)) status = patch.status;
  db.prepare(`
    UPDATE social_posts SET caption = ?, scheduled_at = ?, platforms = ?, image_url = ?, status = ?,
      client_notes = COALESCE(?, client_notes), updated_at = datetime('now')
    WHERE id = ?
  `).run(caption, scheduled_at, platforms, image_url, status, patch.client_notes != null ? String(patch.client_notes) : null, row.id);
  return publicPost(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(row.id));
}

function setCampaignStatus(db, campaignId, status) {
  ensureTables(db);
  const allowed = ['draft', 'active', 'paused', 'done'];
  if (!allowed.includes(status)) throw fail('INVALID', 'Invalid campaign status');
  const row = db.prepare('SELECT id FROM social_campaigns WHERE id = ?').get(Number(campaignId));
  if (!row) throw fail('NOT_FOUND', 'Campaign not found');
  db.prepare("UPDATE social_campaigns SET status = ?, updated_at = datetime('now') WHERE id = ?").run(status, row.id);
  return getCampaign(db, row.id);
}

function randomToken() {
  return crypto.randomBytes(24).toString('base64url');
}

async function sendWeeklyBatch(db, { campaignId, force = false, workspaceId = null } = {}) {
  ensureTables(db);
  const campaign = db.prepare('SELECT * FROM social_campaigns WHERE id = ?').get(Number(campaignId));
  if (!campaign) throw fail('NOT_FOUND', 'Campaign not found');
  if (campaign.status !== 'active' && !force) throw fail('INACTIVE', 'Campaign is not active');

  const drafts = db.prepare(
    `SELECT * FROM social_posts WHERE campaign_id = ? AND status = 'draft'
     ORDER BY scheduled_at ASC, day_index ASC LIMIT 7`
  ).all(campaign.id);
  if (!drafts.length) return { sent: false, reason: 'no_draft_posts' };

  if (!campaign.require_client_approval) {
    for (const p of drafts) {
      db.prepare("UPDATE social_posts SET status = 'scheduled', updated_at = datetime('now') WHERE id = ?").run(p.id);
    }
    return { sent: false, autoScheduled: drafts.length, reason: 'approval_not_required' };
  }

  const to = String(campaign.client_email || '').trim();
  if (!to) throw fail('NO_EMAIL', 'Set client_email on the campaign (or lead email before generating).');

  const token = randomToken();
  const weekStart = (drafts[0].scheduled_at || '').slice(0, 10);
  const weekEnd = (drafts[drafts.length - 1].scheduled_at || '').slice(0, 10);
  const postIds = drafts.map((p) => p.id);
  const batchId = Number(db.prepare(`
    INSERT INTO social_weekly_batches (
      campaign_id, lead_id, week_start, week_end, approval_token, status, post_ids
    ) VALUES (?, ?, ?, ?, ?, 'pending', ?)
  `).run(campaign.id, campaign.lead_id, weekStart, weekEnd, token, JSON.stringify(postIds)).lastInsertRowid);

  for (const p of drafts) {
    db.prepare("UPDATE social_posts SET status = 'pending_approval', updated_at = datetime('now') WHERE id = ?").run(p.id);
  }

  const lead = db.prepare('SELECT business_name FROM leads WHERE id = ?').get(campaign.lead_id);
  const wq = workspaceId ? `&w=${encodeURIComponent(workspaceId)}` : '';
  const approveUrl = `${appUrl()}/social-approve.html?token=${encodeURIComponent(token)}${wq}`;
  const lines = drafts.map((p, i) => {
    const when = (p.scheduled_at || '').replace('T', ' ').slice(0, 16);
    const img = p.image_url ? ' [photo]' : ' [text only]';
    return `${i + 1}. ${when} UTC${img}\n${p.caption}`;
  }).join('\n\n');
  const subject = `Social content for approval · ${lead && lead.business_name ? lead.business_name : 'your business'} · Batch #${batchId}`;
  const text = [
    `Hi — here's your next week of Facebook/Instagram posts.`,
    ``,
    `Review and approve: ${approveUrl}`,
    ``,
    `Reference: Social batch #${batchId}`,
    ``,
    lines,
    ``,
    `If you approve, we'll schedule them on the connected platforms.`,
  ].join('\n');
  const { renderBrandedEmail } = require('./emailTemplate');
  const branded = renderBrandedEmail({
    title: 'Social posts ready for approval',
    htmlBody: `<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1c1915;">Hi — here's your next week of Facebook/Instagram posts.</p>
<p style="margin:0 0 16px;font-size:15px;line-height:1.55;color:#1c1915;">Reference: Social batch #${batchId}</p>
<pre style="white-space:pre-wrap;font-family:Segoe UI,Helvetica Neue,Arial,sans-serif;font-size:13px;line-height:1.45;color:#1c1915;background:#f7f3ec;border:1px solid #e4ddd2;border-radius:8px;padding:14px;margin:0 0 16px;">${escapeHtml(lines)}</pre>`,
    text,
    cta: { url: approveUrl, label: 'Review & approve' },
  });

  const settings = {};
  for (const r of db.prepare('SELECT key, value FROM settings').all()) settings[r.key] = r.value;
  const { getProvider } = require('./email');
  const provider = getProvider(settings, db);
  let sent = false;
  let sendError = null;
  if (provider.name !== 'stub' && settings['smtp.host'] && settings['smtp.from_email']) {
    try {
      await provider.send({
        to,
        subject,
        text: branded.text,
        html: branded.html,
        skipBrand: true,
      });
      sent = true;
    } catch (e) {
      sendError = e.message;
    }
  }

  db.prepare(`
    UPDATE social_weekly_batches SET status = ?, sent_at = CASE WHEN ? = 1 THEN datetime('now') ELSE sent_at END, updated_at = datetime('now')
    WHERE id = ?
  `).run(sent ? 'sent' : 'pending', sent ? 1 : 0, batchId);

  logActivity(db, `Social batch #${batchId} for campaign #${campaign.id}: ${sent ? 'emailed' : 'composed'} to ${to}`);
  return {
    sent,
    batchId,
    to,
    subject,
    approveUrl,
    postIds,
    sendError,
    smtpConfigured: !!(settings['smtp.host'] && settings['smtp.from_email']),
  };
}

function escapeHtml(s) {
  return String(s || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function getBatchByToken(db, token) {
  ensureTables(db);
  const batch = db.prepare('SELECT * FROM social_weekly_batches WHERE approval_token = ?').get(String(token || ''));
  if (!batch) throw fail('NOT_FOUND', 'Approval link not found');
  const campaign = db.prepare('SELECT * FROM social_campaigns WHERE id = ?').get(batch.campaign_id);
  const lead = db.prepare('SELECT id, business_name, category, city FROM leads WHERE id = ?').get(batch.lead_id);
  const ids = parseJson(batch.post_ids, []);
  const posts = ids.length
    ? db.prepare(`SELECT * FROM social_posts WHERE id IN (${ids.map(() => '?').join(',')}) ORDER BY scheduled_at ASC`).all(...ids).map(publicPost)
    : [];
  return {
    batch: {
      id: batch.id,
      status: batch.status,
      week_start: batch.week_start,
      week_end: batch.week_end,
      sent_at: batch.sent_at,
      decided_at: batch.decided_at,
    },
    campaign: publicCampaign(campaign),
    lead,
    posts,
  };
}

function decideBatch(db, token, { action = 'approve', postIds = null, notes = '' } = {}) {
  ensureTables(db);
  const batch = db.prepare('SELECT * FROM social_weekly_batches WHERE approval_token = ?').get(String(token || ''));
  if (!batch) throw fail('NOT_FOUND', 'Approval link not found');
  if (['approved', 'rejected'].includes(batch.status) && action !== 'approve_selected') {
    /* allow re-decide selected */
  }
  const allIds = parseJson(batch.post_ids, []);
  const selected = Array.isArray(postIds) && postIds.length
    ? postIds.map(Number).filter((id) => allIds.includes(id))
    : allIds.slice();

  if (action === 'reject') {
    for (const id of allIds) {
      db.prepare("UPDATE social_posts SET status = 'rejected', client_notes = ?, updated_at = datetime('now') WHERE id = ?")
        .run(String(notes || 'Rejected by client'), id);
    }
    db.prepare("UPDATE social_weekly_batches SET status = 'rejected', decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
      .run(batch.id);
    return getBatchByToken(db, token);
  }

  // approve or approve_selected
  for (const id of allIds) {
    if (selected.includes(id)) {
      db.prepare("UPDATE social_posts SET status = 'scheduled', updated_at = datetime('now') WHERE id = ? AND status IN ('pending_approval','draft','approved')")
        .run(id);
    } else if (action === 'approve_selected') {
      db.prepare("UPDATE social_posts SET status = 'rejected', client_notes = ?, updated_at = datetime('now') WHERE id = ? AND status = 'pending_approval'")
        .run(String(notes || 'Not selected'), id);
    }
  }
  const status = selected.length === allIds.length ? 'approved' : 'partial';
  db.prepare("UPDATE social_weekly_batches SET status = ?, decided_at = datetime('now'), updated_at = datetime('now') WHERE id = ?")
    .run(status, batch.id);
  logActivity(db, `Social batch #${batch.id} ${status} (${selected.length}/${allIds.length} posts)`);
  return getBatchByToken(db, token);
}

function approvePostsAgency(db, postIds) {
  ensureTables(db);
  const ids = (Array.isArray(postIds) ? postIds : []).map(Number).filter(Boolean);
  let n = 0;
  for (const id of ids) {
    const r = db.prepare(
      "UPDATE social_posts SET status = 'scheduled', updated_at = datetime('now') WHERE id = ? AND status IN ('draft','pending_approval','approved','rejected')"
    ).run(id);
    n += r.changes;
  }
  return { updated: n };
}

async function publishPost(db, postId) {
  ensureTables(db);
  const post = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(Number(postId));
  if (!post) throw fail('NOT_FOUND', 'Post not found');
  if (!['scheduled', 'failed', 'approved'].includes(post.status)) {
    throw fail('NOT_READY', `Post status is ${post.status}`);
  }
  db.prepare("UPDATE social_posts SET status = 'posting', publish_error = NULL, updated_at = datetime('now') WHERE id = ?").run(post.id);

  const platforms = parseJson(post.platforms, ['facebook']);
  const results = {};
  const errors = [];

  for (const platform of platforms) {
    const acct = db.prepare(
      "SELECT * FROM social_accounts WHERE lead_id = ? AND platform = ? AND status = 'active' ORDER BY id DESC LIMIT 1"
    ).get(post.lead_id, platform);
    if (!acct) {
      results[platform] = { ok: false, error: 'No connected account' };
      errors.push(`${platform}: not connected`);
      continue;
    }
    const token = decToken(acct.access_token_enc);
    if (!token) {
      results[platform] = { ok: false, error: 'Missing token' };
      errors.push(`${platform}: reconnect account`);
      continue;
    }
    try {
      if (platform === 'facebook') {
        results.facebook = await publishFacebook(acct, token, post);
      } else if (platform === 'instagram') {
        results.instagram = await publishInstagram(acct, token, post);
      }
    } catch (e) {
      results[platform] = { ok: false, error: e.message };
      errors.push(`${platform}: ${e.message}`);
    }
  }

  const anyOk = Object.values(results).some((r) => r && r.ok);
  const allOk = anyOk && !errors.length;
  const status = allOk ? 'posted' : (anyOk ? 'partial' : 'failed');
  db.prepare(`
    UPDATE social_posts SET status = ?, meta_results = ?, publish_error = ?, published_at = CASE WHEN ? THEN datetime('now') ELSE published_at END, updated_at = datetime('now')
    WHERE id = ?
  `).run(status, JSON.stringify(results), errors.length ? errors.join('; ') : null, anyOk ? 1 : 0, post.id);

  return { postId: post.id, status, results };
}

async function publishFacebook(acct, token, post) {
  const pageId = acct.page_id || acct.account_id;
  if (post.image_url) {
    const data = await metaFetch(`/${pageId}/photos`, {
      method: 'POST',
      token,
      form: {
        url: post.image_url,
        caption: post.caption || '',
        published: 'true',
      },
    });
    return { ok: true, id: data.id || data.post_id };
  }
  const data = await metaFetch(`/${pageId}/feed`, {
    method: 'POST',
    token,
    form: { message: post.caption || '' },
  });
  return { ok: true, id: data.id };
}

async function publishInstagram(acct, token, post) {
  if (!post.image_url) {
    return { ok: false, skipped: true, error: 'Instagram feed posts require an image (caption-only skipped)' };
  }
  const igUserId = acct.account_id;
  const container = await metaFetch(`/${igUserId}/media`, {
    method: 'POST',
    token,
    form: {
      image_url: post.image_url,
      caption: post.caption || '',
    },
  });
  if (!container.id) throw fail('META_API', 'IG container missing id');
  // Poll until ready — do not publish early.
  let ready = false;
  for (let i = 0; i < 20; i += 1) {
    const st = await metaFetch(`/${container.id}?fields=status_code`, { token });
    if (st.status_code === 'FINISHED' || st.status_code === 'PUBLISHED') {
      ready = true;
      break;
    }
    if (st.status_code === 'ERROR') throw fail('META_API', 'Instagram media container failed');
    await new Promise((r) => setTimeout(r, 1500));
  }
  if (!ready) throw fail('META_API', 'Instagram media container not ready in time');
  const pub = await metaFetch(`/${igUserId}/media_publish`, {
    method: 'POST',
    token,
    form: { creation_id: container.id },
  });
  return { ok: true, id: pub.id, containerId: container.id };
}

async function publishDue(db, { limit = 10 } = {}) {
  ensureTables(db);
  if (setting(db, 'automation_paused', '0') === '1') {
    return { skipped: true, reason: 'automation_paused' };
  }
  const due = db.prepare(`
    SELECT id FROM social_posts
    WHERE status IN ('scheduled','failed')
      AND scheduled_at IS NOT NULL
      AND datetime(scheduled_at) <= datetime('now')
    ORDER BY scheduled_at ASC
    LIMIT ?
  `).all(Math.min(50, Math.max(1, Number(limit) || 10)));
  const results = [];
  for (const row of due) {
    try {
      results.push(await publishPost(db, row.id));
    } catch (e) {
      results.push({ postId: row.id, status: 'error', error: e.message });
    }
  }
  return { published: results.length, results };
}

async function weeklyTick(db, { workspaceId = null } = {}) {
  ensureTables(db);
  if (setting(db, 'automation_paused', '0') === '1') {
    return { skipped: true, reason: 'automation_paused' };
  }
  const campaigns = db.prepare("SELECT id FROM social_campaigns WHERE status = 'active'").all();
  const out = [];
  for (const c of campaigns) {
    try {
      // Avoid stacking: skip if a pending/sent undecided batch exists from last 5 days
      const open = db.prepare(`
        SELECT id FROM social_weekly_batches
        WHERE campaign_id = ? AND status IN ('pending','sent')
          AND created_at >= datetime('now', '-5 days')
        LIMIT 1
      `).get(c.id);
      if (open) {
        out.push({ campaignId: c.id, skipped: true, reason: 'open_batch' });
        continue;
      }
      out.push({ campaignId: c.id, ...(await sendWeeklyBatch(db, { campaignId: c.id, workspaceId })) });
    } catch (e) {
      out.push({ campaignId: c.id, error: e.message });
    }
  }
  return { campaigns: out.length, results: out };
}

/**
 * Resolve client-facing price for a branded social image ad (USD).
 * Workspace setting wins; callers may pass a platform fallback.
 */
function imagePriceUsd(db, platformFallback) {
  const raw = setting(db, 'social.image_price_usd', '');
  const fromWs = parseFloat(raw);
  if (Number.isFinite(fromWs) && fromWs >= 0) return fromWs;
  const fromPlat = parseFloat(platformFallback);
  if (Number.isFinite(fromPlat) && fromPlat >= 0) return fromPlat;
  return 1;
}

function todayAiSpendUsd(db) {
  try {
    const row = db.prepare(
      "SELECT COALESCE(SUM(cost_usd), 0) AS spent FROM ai_usage WHERE date(at) = date('now')"
    ).get();
    return Number(row.spent) || 0;
  } catch {
    return 0;
  }
}

/**
 * Generate a branded image ad for one social post via OpenAI Images API.
 * Stores a public /site-previews/… URL on the post and logs a client charge
 * to ai_usage (task=social_branded_image) at social.image_price_usd.
 */
async function generateBrandedAdImage(db, opts = {}) {
  ensureTables(db);
  const postId = Number(opts.postId);
  if (!Number.isFinite(postId) || postId < 1) throw fail('INVALID_ARGS', 'postId is required');

  const post = db.prepare('SELECT * FROM social_posts WHERE id = ?').get(postId);
  if (!post) throw fail('NOT_FOUND', 'Post not found');
  if (opts.leadId != null && Number(post.lead_id) !== Number(opts.leadId)) {
    throw fail('FORBIDDEN', 'Post does not belong to this project');
  }

  const lead = db.prepare('SELECT * FROM leads WHERE id = ?').get(post.lead_id) || {};
  const includedInPlan = !!opts.includedInPlan;
  const price = includedInPlan || opts.chargeUsd === 0
    ? 0
    : (opts.chargeUsd != null && Number.isFinite(Number(opts.chargeUsd))
      ? Number(opts.chargeUsd)
      : imagePriceUsd(db, opts.platformPriceFallback));
  const budget = parseFloat(setting(db, 'cost.daily_budget_usd', '10'));
  if (price > 0 && budget > 0 && todayAiSpendUsd(db) + price > budget) {
    throw fail('BUDGET_EXCEEDED', 'Daily AI budget would be exceeded by this image charge.');
  }
  if (String(setting(db, 'automation_paused', '0')) === '1') {
    throw fail('AUTOMATION_PAUSED', 'Automation is paused; image generation is blocked.');
  }

  const openaiImages = require('./openaiImages');
  if (!openaiImages.imageConfigured(db)) {
    throw fail('AI_NOT_CONFIGURED', 'AI is not configured: set ai.api_key in Settings.');
  }

  const biz = String(lead.business_name || 'Local business').trim();
  const city = [lead.city, lead.state].filter(Boolean).join(', ');
  const category = String(lead.category || 'local business').trim();
  const caption = String(post.caption || '').trim().slice(0, 400);
  const offerLine = caption
    ? `Short on-image headline (6 words max, crisp readable type): "${caption.slice(0, 120)}"`
    : 'One short call-to-action line (e.g. Book today / Call now), crisp readable type.';

  const prompt = [
    `Square (1:1) professional product/business advertisement for "${biz}"`,
    category ? `, a ${category} business` : '',
    city ? ` in ${city}` : '',
    '.',
    'Single clear hero subject that shows the real service or product in use — polished commercial photography, not a generic stock collage.',
    `Business name "${biz}" as the primary brand lockup in clean sans-serif type (high contrast, perfectly spelled).`,
    offerLine,
    'Composition: subject dominant, generous margins, balanced negative space, mobile-legible hierarchy (name → offer → subtle location).',
    'Restrained brand palette; no purple neon glow, fake UI, watermarks, QR codes, or dense paragraphs of text.',
  ].filter(Boolean).join(' ');

  const result = await openaiImages.generateImages(db, prompt, {
    n: 1,
    size: '1024x1024',
    quality: 'high',
    leadId: post.lead_id,
    jobId: `social-${post.lead_id}`,
    note: `portal branded ad post #${post.id}`,
  });

  const img = result.images && result.images[0];
  if (!img || !img.path) throw fail('AI_EMPTY', 'Image provider returned no usable image.');

  const fs = require('fs');
  const path = require('path');
  const openPreviewMod = require('./openPreview');
  const folder = `social-${post.lead_id}`;
  const exportDir = path.join(openPreviewMod.exportRoot(), folder, 'images');
  fs.mkdirSync(exportDir, { recursive: true });
  const ext = (img.mime || '').includes('jpeg') ? 'jpg' : ((img.mime || '').includes('webp') ? 'webp' : 'png');
  const name = `ad-${post.id}-${Date.now()}.${ext}`;
  const dest = path.join(exportDir, name);
  fs.copyFileSync(img.path, dest);

  const publicUrl = `${appUrl()}/site-previews/${folder}/images/${name}`;
  db.prepare(
    "UPDATE social_posts SET image_url = ?, image_prompt = ?, updated_at = datetime('now') WHERE id = ?"
  ).run(publicUrl, prompt.slice(0, 2000), post.id);

  try {
    const note = price > 0
      ? `Client charge $${price.toFixed(2)} for branded ad on social_post #${post.id}`
      : `Premium included branded ad on social_post #${post.id}${opts.planId ? ` (plan=${opts.planId})` : ''}`;
    db.prepare(
      `INSERT INTO ai_usage (task, model, prompt_tokens, completion_tokens, cost_usd, lead_id, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(
      'social_branded_image',
      result.model || 'gpt-image-2.5-sunburst',
      0,
      0,
      price,
      post.lead_id,
      note
    );
  } catch { /* logging optional */ }

  logActivity(
    db,
    price > 0
      ? `Branded image ad generated for social post #${post.id} (charged $${price.toFixed(2)}).`
      : `Branded image ad generated for social post #${post.id} (included in plan).`
  );
  return {
    post: publicPost(db.prepare('SELECT * FROM social_posts WHERE id = ?').get(post.id)),
    image_url: publicUrl,
    price_usd: price,
    included_in_plan: includedInPlan || price === 0,
    plan: opts.planId || null,
    model: result.model,
  };
}

function overview(db) {
  ensureTables(db);
  const campaigns = db.prepare(`
    SELECT c.*, l.business_name
    FROM social_campaigns c
    LEFT JOIN leads l ON l.id = c.lead_id
    ORDER BY c.id DESC LIMIT 50
  `).all().map((r) => ({ ...publicCampaign(r), business_name: r.business_name }));
  const pendingApproval = db.prepare("SELECT COUNT(*) AS c FROM social_posts WHERE status = 'pending_approval'").get().c;
  const scheduled = db.prepare("SELECT COUNT(*) AS c FROM social_posts WHERE status = 'scheduled'").get().c;
  const failed = db.prepare("SELECT COUNT(*) AS c FROM social_posts WHERE status = 'failed'").get().c;
  const accounts = db.prepare('SELECT COUNT(*) AS c FROM social_accounts WHERE status = ?').get('active').c;
  return {
    metaConfigured: metaConfigured(db),
    counts: { pendingApproval, scheduled, failed, accounts, campaigns: campaigns.length },
    campaigns,
  };
}

module.exports = {
  ensureTables,
  metaConfigured,
  oauthStart,
  oauthCallback,
  listAccounts,
  disconnectAccount,
  listCampaigns,
  getCampaign,
  generateMonth,
  attachOptionalImages,
  updatePost,
  setCampaignStatus,
  sendWeeklyBatch,
  getBatchByToken,
  decideBatch,
  approvePostsAgency,
  publishPost,
  publishDue,
  weeklyTick,
  overview,
  imagePriceUsd,
  generateBrandedAdImage,
  publicPost,
  PLATFORMS,
};
