-- Website Scout schema (single-user desktop app, SQLite / better-sqlite3)

PRAGMA journal_mode = WAL;

CREATE TABLE IF NOT EXISTS leads (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  business_name TEXT NOT NULL,
  category TEXT,
  phone TEXT,
  email TEXT,
  website TEXT,
  address TEXT,
  city TEXT,
  state TEXT,
  postal_code TEXT,
  country TEXT DEFAULT 'US',
  latitude REAL,
  longitude REAL,
  rating REAL,
  review_count INTEGER,
  description TEXT,
  hours TEXT,            -- JSON array of {day, open, close}
  services TEXT,         -- JSON array of strings
  social_links TEXT,     -- JSON array of {label, url}
  source TEXT,           -- provider name, 'csv', 'manual'
  source_ref TEXT,
  status TEXT DEFAULT 'new', -- new,researching,qualified,building,qa_pending,ready,outreach_pending,contacted,engaged,claimed,trial,customer,lost
  score INTEGER DEFAULT 0,
  qualified INTEGER DEFAULT 0,
  qualification_note TEXT,
  tags TEXT,             -- JSON array
  lead_group TEXT,       -- named hunt / folder (e.g. "plumber · 19510")
  notes TEXT,
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  detail TEXT,
  at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS lead_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  breakdown TEXT NOT NULL, -- JSON {signal: points}
  at TEXT DEFAULT (datetime('now'))
);

-- Researched facts with provenance + anti-hallucination classification
CREATE TABLE IF NOT EXISTS business_facts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  fact_key TEXT NOT NULL,   -- e.g. 'phone', 'hours', 'service:plumbing'
  value TEXT NOT NULL,
  source TEXT NOT NULL,     -- provider name or 'manual'
  source_url TEXT,
  confidence TEXT DEFAULT 'medium', -- high|medium|low
  claim_class TEXT NOT NULL CHECK (claim_class IN ('VERIFIED','AI_COPY','OWNER_PROVIDED','UNKNOWN')),
  fetched_at TEXT DEFAULT (datetime('now'))
);

-- Structured site model: NEVER one giant HTML blob
CREATE TABLE IF NOT EXISTS websites (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL UNIQUE REFERENCES leads(id) ON DELETE CASCADE,
  name TEXT NOT NULL,
  industry TEXT,
  theme TEXT NOT NULL,   -- JSON {primary, secondary, font, ...}
  pages TEXT NOT NULL,   -- JSON [{slug, title, sections:[{type, content}]}]
  status TEXT DEFAULT 'draft', -- draft,qa_pending,approved,published
  preview_path TEXT,     -- local exported preview file
  preview_url TEXT,      -- public Cloudflare Pages URL (set on publish)
  created_at TEXT DEFAULT (datetime('now')),
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS website_versions (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  website_id INTEGER NOT NULL REFERENCES websites(id) ON DELETE CASCADE,
  version_no INTEGER NOT NULL,
  pages TEXT NOT NULL,
  theme TEXT NOT NULL,
  note TEXT,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS email_templates (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaigns (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  template_id INTEGER REFERENCES email_templates(id),
  status TEXT DEFAULT 'draft', -- draft,active,paused,done
  rate_per_hour INTEGER DEFAULT 30,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS campaign_messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  campaign_id INTEGER NOT NULL REFERENCES campaigns(id) ON DELETE CASCADE,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  to_email TEXT NOT NULL,
  subject TEXT NOT NULL,
  body TEXT NOT NULL,
  status TEXT DEFAULT 'queued', -- queued,sent,failed,suppressed
  scheduled_at TEXT,
  sent_at TEXT,
  error TEXT
);

CREATE TABLE IF NOT EXISTS email_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  message_id INTEGER REFERENCES campaign_messages(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- sent,failed,opened,clicked,bounced,unsubscribed
  at TEXT DEFAULT (datetime('now')),
  detail TEXT
);

-- Compliance: unsubscribe + bounce + do-not-contact in one suppression list
CREATE TABLE IF NOT EXISTS suppression_list (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  reason TEXT NOT NULL, -- unsubscribed|bounced|do-not-contact|complaint
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS prospect_events (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  type TEXT NOT NULL, -- preview.opened, page.viewed, editor.opened, logo.uploaded, trial.started, ...
  detail TEXT,
  at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS intent_scores (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  lead_id INTEGER NOT NULL REFERENCES leads(id) ON DELETE CASCADE,
  score INTEGER NOT NULL,
  label TEXT NOT NULL, -- Cold|Warm|Interested|Hot|Customer
  breakdown TEXT,      -- JSON {event_type: points}
  at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS prompts (
  key TEXT PRIMARY KEY, -- research_lead, score_lead, build_website, qa_website, write_outreach, follow_up, site_editor
  name TEXT NOT NULL,
  body TEXT NOT NULL,
  updated_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS ai_usage (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  task TEXT NOT NULL,
  model TEXT NOT NULL,
  prompt_tokens INTEGER DEFAULT 0,
  completion_tokens INTEGER DEFAULT 0,
  cost_usd REAL DEFAULT 0,
  lead_id INTEGER REFERENCES leads(id),
  note TEXT,
  at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS automation_rules (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  config TEXT NOT NULL, -- JSON
  enabled INTEGER DEFAULT 1,
  created_at TEXT DEFAULT (datetime('now'))
);

CREATE TABLE IF NOT EXISTS activity_log (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  area TEXT NOT NULL,
  message TEXT NOT NULL,
  at TEXT DEFAULT (datetime('now'))
);

CREATE INDEX IF NOT EXISTS idx_leads_status ON leads(status);
CREATE INDEX IF NOT EXISTS idx_leads_score ON leads(score DESC);
CREATE INDEX IF NOT EXISTS idx_facts_lead ON business_facts(lead_id);
CREATE INDEX IF NOT EXISTS idx_leads_group ON leads(lead_group);
CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category);
CREATE INDEX IF NOT EXISTS idx_msg_status ON campaign_messages(status, scheduled_at);
