'use strict';

// Idempotent seeding for the Website Scout database.
// runSeed(db) inserts default settings, the 7 AI prompts, one sample
// automation rule, and 2 demo leads (only when the leads table is empty).
// PROMPT_SEEDS and SETTING_SEEDS are exported so prompts:reset / other
// modules can restore seed bodies without duplicating content.

const SETTING_SEEDS = [
  // AI provider
  ['ai.api_key', ''],
  ['ai.base_url', 'https://api.openai.com/v1'],
  ['ai.model.default', 'gpt-4o-mini'],
  ['ai.model.research', ''],
  ['ai.model.generation', ''],
  ['ai.model.scoring', ''],
  ['ai.model.email', ''],
  ['ai.model.qa', ''],
  ['ai.model.editor', ''],
  ['ai.model.followup', ''],
  ['ai.model.image', 'gpt-image-1'],
  ['ai.model.vision', ''],
  // Cost controls
  ['cost.daily_budget_usd', '10'],
  ['cost.max_websites_per_day', '25'],
  ['cost.max_outreach_per_day', '200'],
  ['cost.per_1k_prompt', '0.0015'],
  ['cost.per_1k_completion', '0.002'],
  // Automation
  ['automation_paused', '0'],
  // Design agent auto-trigger (when a job becomes waiting_on_agent)
  ['design.agent_notify', '1'],
  ['design.agent_trigger_command', ''],
  ['design.agent_trigger_file', ''],
  ['design.agent_webhook_url', ''],
  ['design.agent_webhook_secret', ''],
  // Design learning (observe reviews / redesigns → playbook for agents)
  ['design.learning.enabled', '1'],
  ['design.learning.playbook', '[]'],
  ['design.learning.last_learned_at', ''],
  ['design.learning.max_playbook', '24'],
  // Scheduled lead discovery (runs while the Electron app is open)
  ['discovery.schedule.enabled', '0'],
  ['discovery.schedule.mode', 'interval'],
  ['discovery.schedule.interval_hours', '6'],
  ['discovery.schedule.daily_time', '09:00'],
  ['discovery.schedule.provider', 'tavily'],
  ['discovery.schedule.category', 'Plumber'],
  ['discovery.schedule.location', 'Springfield'],
  ['discovery.schedule.limit', '8'],
  ['discovery.schedule.score', '1'],
  ['discovery.schedule.group', ''],
  ['discovery.schedule.website_presence', ''],
  ['discovery.schedule.last_run', ''],
  ['discovery.schedule.next_run', ''],
  ['discovery.schedule.last_status', ''],
  ['discovery.schedule.last_error', ''],
  ['discovery.schedule.last_result', ''],
  // Tavily discovery (API key is a secret; depth is a regular setting)
  ['providers.tavily.search_depth', 'advanced'],
  // SMTP / mail
  ['smtp.host', ''],
  ['smtp.port', '587'],
  ['smtp.secure', '0'],
  ['smtp.user', ''],
  ['smtp.pass', ''],
  ['smtp.from_name', 'Website Scout'],
  ['smtp.from_email', ''],
  ['mail.footer', 'Reply STOP to opt out of future messages.'],
  ['mail.inbound_drop_dir', ''],
  ['mail.imap.enabled', '0'],
  ['mail.imap.host', ''],
  ['mail.imap.port', '993'],
  ['mail.imap.secure', '1'],
  ['mail.imap.user', ''],
  ['mail.imap.pass', ''],
  ['mail.imap.mailbox', 'INBOX'],
  ['mail.imap.auto_submit', '1'],
  // Scoring
  ['score.threshold_qualified', '50'],
  ['score.threshold_hot', '70'],
  // App
  ['app.name', 'Website Scout'],
  // Cloudflare Pages publishing (optional)
  ['cf.api_token', ''],
  ['cf.account_id', ''],
  ['cf.project', ''],
  ['cf.preview_domain', ''],
];

// Settings keys that settings:set is allowed to write (validated in ipc/system.js).
// This whitelist is derived from SETTING_SEEDS.
const SETTINGS_WHITELIST = SETTING_SEEDS.map(([key]) => key);

const PROMPT_SEEDS = [
  {
    key: 'research_lead',
    name: 'Research Lead',
    body: `You are a business research assistant. Research the following local business using the provided provider data.

Business: {{business_name}}
Category: {{category}}
City: {{city}}, {{state}}
Website: {{website}}
Known facts: {{known_facts}}

Task: produce a structured JSON summary with fields: services (array), hours (array of {day, open, close}), address, phone, email, description (2-3 sentences), and open_questions (facts you could not verify).
Rules:
- Do NOT invent facts. Only include facts present in the provided data.
- Anything you are unsure about goes in open_questions with claim class UNKNOWN.
- Keep copy concise and professional.`,
  },
  {
    key: 'score_lead',
    name: 'Score Lead',
    body: `You are a lead qualification analyst. Score this business as a prospect for a done-for-you AI website offer.

Business: {{business_name}} ({{category}}) — {{city}}, {{state}}
Website status: {{website_status}} (none = no website)
Rating: {{rating}} from {{review_count}} reviews
Services offered: {{services}}
Known facts: {{known_facts}}

Task: return JSON: { "score": 0-100, "breakdown": {signal: points}, "qualified": true|false, "reason": "..." }.
Scoring guidance: no website or broken website is a strong positive signal; clear services list and recent reviews add points; missing contact info reduces the score.
- Do NOT invent business facts. Score only on provided data.
- threshold_qualified = {{threshold_qualified}}, threshold_hot = {{threshold_hot}}.`,
  },
  {
    key: 'build_website',
    name: 'Build Website',
    body: `You are an expert web designer generating a website structure for a local business. Output structured page data (JSON), NOT raw HTML.

Business: {{business_name}}
Category: {{category}}
Location: {{city}}, {{state}}
VERIFIED facts (only use these; never invent): {{verified_facts}}
AI-draft copy (may be used with the label "AI copy — owner to confirm"): {{ai_copy}}

Task: produce JSON: { "name": ..., "industry": ..., "theme": {"primary": hex, "secondary": hex, "font": ...}, "pages": [{"slug", "title", "sections": [{"type": hero|services|about|gallery|testimonials|hours|contact|faq, "content": {...}}]}] }.
Include pages: home, services, about, contact at minimum.
Rules:
- Every factual claim (phone, hours, services, address) must come from VERIFIED facts. If a fact is missing, write copy that avoids the claim (e.g. "Call us for hours") rather than inventing one.
- Tone: friendly, professional, suitable for a local service business.`,
  },
  {
    key: 'qa_website',
    name: 'QA Website',
    body: `You are a QA reviewer for AI-generated local business websites. Review the generated site structure for this business.

Business: {{business_name}} ({{category}}) — {{city}}, {{state}}
VERIFIED facts: {{verified_facts}}
Site structure JSON: {{site_json}}

Task: return JSON: { "passed": true|false, "issues": [{"severity": "critical|major|minor", "page": slug, "detail": ...}], "fixed_copy": optional improved sections }.
Checks:
1. No invented facts — flag any claim (hours, phone, services, address) not present in VERIFIED facts as CRITICAL.
2. Claim classification present on all business-specific copy.
3. All pages renderable: sections have valid types and non-empty content.
4. Spelling, grammar, tone.
5. Title and headings mention the business name and location.`,
  },
  {
    key: 'write_outreach',
    name: 'Write Outreach',
    body: `You are a copywriter writing cold outreach email #{{sequence_step}} for a local business that does not have a good website.

Recipient: {{owner_name}} at {{business_name}} ({{category}}, {{city}}, {{state}})
What we noticed: {{observation}}
Offer: a done-for-you AI-built website, preview link: {{preview_url}}
Sender: {{from_name}}

Task: write the email as JSON: { "subject": "...", "body": "..." }.
Rules:
- Under 120 words. Plain, human tone — no hype, no emojis.
- Reference ONE specific observation about their business or online presence.
- Include the preview link naturally in the body.
- Do NOT invent facts about their business. Only use the observation provided.
- End with the mail footer: {{mail_footer}}`,
  },
  {
    key: 'follow_up',
    name: 'Follow Up',
    body: `You are a copywriter writing follow-up email #{{sequence_step}} (previous email sent {{days_since}} days ago) for a local business.

Recipient: {{owner_name}} at {{business_name}} ({{category}}, {{city}}, {{state}})
Original angle: {{observation}}
Preview link: {{preview_url}}
Their intent signals so far: {{intent_summary}}
Sender: {{from_name}}

Task: write the email as JSON: { "subject": "...", "body": "..." }.
Rules:
- Under 100 words. New angle from the original — do not just repeat email #1.
- Respect their signals: if they opened the preview but did not reply, acknowledge it lightly.
- Do NOT invent facts about their business.
- End with the mail footer: {{mail_footer}}`,
  },
  {
    key: 'site_editor',
    name: 'Site Editor',
    body: `You are an AI assistant helping a business owner edit their website in plain language.

Business: {{business_name}}
Current page being edited: {{page_slug}}
Requested change: {{user_request}}
Current section JSON: {{section_json}}

Task: return JSON with the updated section: { "type": ..., "content": {...} }.
Rules:
- Apply exactly what the owner asked. Do not redesign unrelated sections.
- Do NOT invent new business facts. If the requested change adds facts (e.g. new services, prices), keep the owner's wording verbatim and mark the fact OWNER_PROVIDED.
- Preserve the existing tone and theme.`,
  },
];

const AUTOMATION_RULE_SEED = {
  name: 'Daily production loop',
  config: JSON.stringify({
    steps: ['discover', 'research', 'score', 'generate', 'qa', 'outreach'],
    schedule: 'daily',
    lead_goal_per_day: 25,
    only_qualified: true,
    min_score: 50,
  }),
  enabled: 1,
};

const DEMO_LEADS = [
  {
    business_name: 'Demo Plumbing Co.',
    category: 'Plumber',
    phone: '(555) 010-2030',
    email: 'hello@demplumbing.example',
    website: '',
    address: '123 Main St',
    city: 'Springfield',
    state: 'IL',
    postal_code: '62701',
    rating: 4.6,
    review_count: 87,
    description: 'Demo lead — residential plumbing repairs and installs.',
    source: 'demo',
    status: 'qualified',
    score: 72,
    qualified: 1,
    tags: JSON.stringify(['demo']),
    notes: 'Demo record. Delete any time.',
  },
  {
    business_name: 'Demo Sunny Bakery',
    category: 'Bakery',
    phone: '(555) 010-4471',
    email: 'orders@sunnybakery.example',
    website: '',
    address: '45 Oak Ave',
    city: 'Springfield',
    state: 'IL',
    postal_code: '62702',
    rating: 4.9,
    review_count: 214,
    description: 'Demo lead — family bakery, custom cakes.',
    source: 'demo',
    status: 'new',
    score: 0,
    qualified: 0,
    tags: JSON.stringify(['demo']),
    notes: 'Demo record. Delete any time.',
  },
];

function runSeed(db) {
  const insertSetting = db.prepare(
    'INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)'
  );
  const seedSettings = db.transaction(() => {
    for (const [key, value] of SETTING_SEEDS) insertSetting.run(key, value);
  });
  seedSettings();

  const insertPrompt = db.prepare(
    'INSERT OR IGNORE INTO prompts (key, name, body) VALUES (?, ?, ?)'
  );
  const seedPrompts = db.transaction(() => {
    for (const p of PROMPT_SEEDS) insertPrompt.run(p.key, p.name, p.body);
  });
  seedPrompts();

  const ruleCount = db
    .prepare('SELECT COUNT(*) AS c FROM automation_rules')
    .get().c;
  if (ruleCount === 0) {
    db.prepare(
      'INSERT INTO automation_rules (name, config, enabled) VALUES (?, ?, ?)'
    ).run(AUTOMATION_RULE_SEED.name, AUTOMATION_RULE_SEED.config, AUTOMATION_RULE_SEED.enabled);
  }

  const leadCount = db.prepare('SELECT COUNT(*) AS c FROM leads').get().c;
  if (leadCount === 0) {
    const insertLead = db.prepare(
      `INSERT INTO leads (business_name, category, phone, email, website, address, city, state, postal_code,
        rating, review_count, description, source, status, score, qualified, tags, notes)
       VALUES (@business_name, @category, @phone, @email, @website, @address, @city, @state, @postal_code,
        @rating, @review_count, @description, @source, @status, @score, @qualified, @tags, @notes)`
    );
    const insertLeads = db.transaction(() => {
      for (const lead of DEMO_LEADS) insertLead.run(lead);
    });
    insertLeads();
  }
}

module.exports = { runSeed, SETTING_SEEDS, SETTINGS_WHITELIST, PROMPT_SEEDS };
