'use strict';

/**
 * Lead engine for Website Scout — pure logic + better-sqlite3 access.
 *
 * Owns: create/read/update/delete, CSV import, duplicate detection + merge,
 * lead scoring (spec section 16), qualification (spec section 15), researched
 * facts with provenance (spec sections 17–18), and research orchestration.
 *
 * Anti-hallucination rule: facts are only stored when a source exists.
 * CSV/manual passthrough facts are stored as claim_class UNKNOWN;
 * AI-generated marketing copy is AI_COPY; provider-verified facts are
 * VERIFIED; owner-supplied facts are OWNER_PROVIDED.
 */

const { CsvProvider, getProvider, normalizeToLead, notConfiguredError } = require('./providers');

/* ------------------------------------------------------------------ */
/* Constants                                                           */
/* ------------------------------------------------------------------ */

/** Scoring table, spec section 16. */
const SCORE_SIGNALS = {
  no_website: 30,
  many_reviews: 15,      // review_count >= 20
  high_rating: 10,       // rating > 4
  public_email: 10,
  phone: 5,
  active_business: 10,   // rule-based heuristic, see below
  poor_website: 15,      // rule-based heuristic, see below
  strong_category: 10,   // category in STRONG_CATEGORIES
};
const SCORE_CAP = 100;

/**
 * Categories with strong demand for done-for-you websites (spec section 16,
 * "strong service category"). Kept as a plain list so the heuristic is
 * transparent and editable.
 */
const STRONG_CATEGORIES = [
  'plumber', 'plumbing',
  'electrician', 'electrical',
  'hvac',
  'roofing', 'roofer',
  'law', 'lawyer', 'attorney', 'law firm',
  'dental', 'dentist',
];

const CLAIM_CLASSES = ['VERIFIED', 'AI_COPY', 'OWNER_PROVIDED', 'UNKNOWN'];

const LEAD_STATUSES = [
  'new', 'researching', 'qualified', 'building', 'qa_pending', 'ready',
  'outreach_pending', 'contacted', 'engaged', 'claimed', 'trial',
  'customer', 'lost',
];

/* ------------------------------------------------------------------ */
/* Helpers                                                             */
/* ------------------------------------------------------------------ */

function validationError(message) {
  const err = new Error(message);
  err.code = 'VALIDATION_ERROR';
  return err;
}

/** Digits only — used for phone dedup. */
function normalizePhoneDigits(phone) {
  if (!phone) return '';
  const d = String(phone).replace(/\D/g, '');
  // Drop a leading US country code so +1-555… matches 555…
  return d.length === 11 && d.startsWith('1') ? d.slice(1) : d;
}

/** Lowercase, strip entity suffixes (LLC/Inc/…), strip punctuation/space. */
function normalizeName(name) {
  return String(name || '')
    .toLowerCase()
    .replace(/\b(llc|inc|corp|corporation|ltd|co|company|llp|pllc|pa|pc|dba)\b\.?/g, '')
    .replace(/[^a-z0-9]/g, '');
}

/** Lowercase host without www. from a URL string. */
function domainFromWebsite(website) {
  if (!website) return '';
  try {
    const u = new URL(/^https?:\/\//i.test(website) ? website : `https://${website}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

/** Lowercase domain from an email address. */
function domainFromEmail(email) {
  const m = String(email || '').trim().toLowerCase().match(/@([a-z0-9.-]+\.[a-z]{2,})$/);
  return m ? m[1] : '';
}

/** Normalized address key for dedup. */
function normalizeAddress(addr) {
  return String(addr || '').toLowerCase().replace(/[^a-z0-9]/g, '');
}

function isValidEmail(email) {
  return /^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(String(email).trim());
}

function isValidUrl(url) {
  const raw = String(url).trim();
  if (!raw || /\s/.test(raw)) return false;
  // Reject non-http(s) schemes like ftp:// or ht!tp://
  if (raw.includes('://') && !/^https?:\/\//i.test(raw)) return false;
  try {
    const u = new URL(/^https?:\/\//i.test(raw) ? raw : `https://${raw}`);
    return ['http:', 'https:'].includes(u.protocol) && u.hostname.includes('.');
  } catch {
    return false;
  }
}

/** Empty/null/whitespace = no website; valid http(s) URL = has website. */
function leadHasWebsite(website) {
  if (website == null || String(website).trim() === '') return false;
  return isValidUrl(website);
}

/** Normalize websitePresence filter: 'has' | 'no' | null (any). */
function normalizeWebsitePresence(value) {
  const v = String(value == null ? '' : value).trim().toLowerCase();
  if (v === 'has' || v === 'no') return v;
  return null;
}

function toJson(v) {
  return v === undefined || v === null ? null : JSON.stringify(v);
}

function fromJson(text, fallback) {
  if (!text) return fallback;
  try { return JSON.parse(text); } catch { return fallback; }
}

/** Get a setting value (string) with fallback. */
function getSetting(db, key, fallback) {
  try {
    const row = db.prepare('SELECT value FROM settings WHERE key = ?').get(key);
    return row ? row.value : fallback;
  } catch {
    return fallback;
  }
}

/** Ensure lead_group (and indexes) exist on older databases. */
function ensureLeadColumns(db) {
  const cols = db.prepare('PRAGMA table_info(leads)').all();
  if (cols.length && !cols.some((c) => c.name === 'lead_group')) {
    db.exec('ALTER TABLE leads ADD COLUMN lead_group TEXT');
  }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_group ON leads(lead_group)'); } catch { /* ignore */ }
  try { db.exec('CREATE INDEX IF NOT EXISTS idx_leads_category ON leads(category)'); } catch { /* ignore */ }
}

function normalizeGroupName(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).trim().replace(/\s+/g, ' ').slice(0, 200);
  return s || null;
}

/** Default hunt folder label from category + location. */
function defaultDiscoverGroup(category, location) {
  const c = String(category || '').trim();
  const loc = String(location || '').trim();
  if (c && loc) return normalizeGroupName(`${c} · ${loc}`);
  return normalizeGroupName(c || loc || 'Discovery');
}

/** Convert a DB row into a lead object with JSON fields parsed. */
function rowToLead(row) {
  if (!row) return null;
  return {
    ...row,
    hours: fromJson(row.hours, []),
    services: fromJson(row.services, []),
    social_links: fromJson(row.social_links, []),
    tags: fromJson(row.tags, []),
    qualified: Boolean(row.qualified),
  };
}

function logEvent(db, leadId, type, detail) {
  db.prepare(
    'INSERT INTO lead_events (lead_id, type, detail) VALUES (?, ?, ?)'
  ).run(leadId, type, detail != null ? String(detail).slice(0, 2000) : null);
}

/* ------------------------------------------------------------------ */
/* CRUD                                                                */
/* ------------------------------------------------------------------ */

/** Validate + normalize lead input. Throws VALIDATION_ERROR. */
function validateLeadInput(data) {
  const lead = normalizeToLead(data || {});
  if (!lead.business_name) throw validationError('business_name is required');
  if (lead.email && !isValidEmail(lead.email)) {
    throw validationError(`invalid email: ${lead.email}`);
  }
  if (lead.website && !isValidUrl(lead.website)) {
    throw validationError(`invalid website URL: ${lead.website}`);
  }
  if (lead.rating !== undefined && (lead.rating < 0 || lead.rating > 5)) {
    throw validationError('rating must be between 0 and 5');
  }
  if (lead.review_count !== undefined && (!Number.isInteger(lead.review_count) || lead.review_count < 0)) {
    throw validationError('review_count must be a non-negative integer');
  }
  if (lead.status && !LEAD_STATUSES.includes(lead.status)) {
    throw validationError(`invalid status: ${lead.status}`);
  }
  if (data.tags !== undefined && !Array.isArray(data.tags)) {
    throw validationError('tags must be an array');
  }
  return lead;
}

/**
 * Create a lead. `data` may be raw (any provider shape) — it is normalized
 * first, then validated. Returns the created lead row.
 */
function createLead(db, data) {
  const lead = validateLeadInput(data);
  ensureLeadColumns(db);
  const tags = Array.isArray(data.tags) ? data.tags.map(String) : [];
  const notes = data.notes != null ? String(data.notes).slice(0, 10000) : null;
  const status = LEAD_STATUSES.includes(data.status) ? data.status : 'new';
  const leadGroup = normalizeGroupName(data.lead_group ?? data.group);

  const stmt = db.prepare(`
    INSERT INTO leads
      (business_name, category, phone, email, website, address, city, state,
       postal_code, country, latitude, longitude, rating, review_count,
       description, hours, services, social_links, source, source_ref,
       status, tags, lead_group, notes)
    VALUES
      (@business_name, @category, @phone, @email, @website, @address, @city, @state,
       @postal_code, @country, @latitude, @longitude, @rating, @review_count,
       @description, @hours, @services, @social_links, @source, @source_ref,
       @status, @tags, @lead_group, @notes)
  `);
  const info = stmt.run({
    // normalizeToLead() drops empty keys; default everything to null so no
    // named parameter is ever missing from the INSERT.
    business_name: null, category: null, phone: null, email: null, website: null,
    address: null, city: null, state: null, postal_code: null, country: null,
    latitude: null, longitude: null, rating: null, review_count: null,
    description: null, source: null, source_ref: null, notes: null, lead_group: null,
    ...lead,
    hours: toJson(lead.hours), services: toJson(lead.services),
    social_links: toJson(lead.social_links),
    status, tags: JSON.stringify(tags), lead_group: leadGroup, notes,
  });
  logEvent(db, info.lastInsertRowid, 'created', `source=${lead.source || 'manual'}`);
  return getLead(db, info.lastInsertRowid);
}

function getLead(db, id) {
  const row = db.prepare('SELECT * FROM leads WHERE id = ?').get(id);
  return rowToLead(row);
}

/** Partial update of a lead. Validates changed fields. Returns updated row. */
function updateLead(db, id, obj) {
  const existing = getLead(db, id);
  if (!existing) throw validationError(`lead not found: ${id}`);
  const merged = { ...existing, ...(obj || {}) };
  const lead = validateLeadInput(merged);
  const tags = obj.tags !== undefined
    ? (Array.isArray(obj.tags) ? obj.tags.map(String) : null)
    : existing.tags;
  if (obj.tags !== undefined && !Array.isArray(obj.tags)) {
    throw validationError('tags must be an array');
  }
  ensureLeadColumns(db);
  const notes = obj.notes !== undefined ? String(obj.notes).slice(0, 10000) : existing.notes;
  const status = obj.status !== undefined
    ? (LEAD_STATUSES.includes(obj.status) ? obj.status : (() => { throw validationError(`invalid status: ${obj.status}`); })())
    : existing.status;
  const leadGroup = (obj.lead_group !== undefined || obj.group !== undefined)
    ? normalizeGroupName(obj.lead_group !== undefined ? obj.lead_group : obj.group)
    : (existing.lead_group || null);

  db.prepare(`
    UPDATE leads SET
      business_name=@business_name, category=@category, phone=@phone,
      email=@email, website=@website, address=@address, city=@city,
      state=@state, postal_code=@postal_code, country=@country,
      latitude=@latitude, longitude=@longitude, rating=@rating,
      review_count=@review_count, description=@description,
      hours=@hours, services=@services, social_links=@social_links,
      source=@source, source_ref=@source_ref, status=@status,
      tags=@tags, lead_group=@lead_group, notes=@notes, updated_at=datetime('now')
    WHERE id=@id
  `).run({
    // normalizeToLead() drops empty keys; default everything to null so no
    // named parameter is ever missing from the UPDATE.
    business_name: null, category: null, phone: null, email: null, website: null,
    address: null, city: null, state: null, postal_code: null, country: null,
    latitude: null, longitude: null, rating: null, review_count: null,
    description: null, source: null, source_ref: null, notes: null, lead_group: null,
    ...lead,
    hours: toJson(lead.hours), services: toJson(lead.services),
    social_links: toJson(lead.social_links),
    status, tags: JSON.stringify(tags || []), lead_group: leadGroup, notes, id,
  });
  logEvent(db, id, 'updated', 'fields updated');
  return getLead(db, id);
}

/** Delete a lead and its dependent rows. */
function deleteLead(db, id) {
  const existing = getLead(db, id);
  if (!existing) throw validationError(`lead not found: ${id}`);
  const tx = db.transaction(() => {
    db.prepare('DELETE FROM business_facts WHERE lead_id = ?').run(id);
    db.prepare('DELETE FROM lead_scores WHERE lead_id = ?').run(id);
    db.prepare('DELETE FROM lead_events WHERE lead_id = ?').run(id);
    db.prepare('DELETE FROM leads WHERE id = ?').run(id);
  });
  tx();
  return { ok: true, id };
}

/* ------------------------------------------------------------------ */
/* CSV import                                                          */
/* ------------------------------------------------------------------ */

const CSV_MAX_BYTES = 1024 * 1024; // 1 MB

/**
 * Import leads from CSV text. Returns { created, skipped, errors }.
 * Row-level failures never abort the whole import.
 */
function importCsv(db, text, opts = {}) {
  if (typeof text !== 'string' || !text.trim()) {
    throw validationError('CSV text is empty');
  }
  if (Buffer.byteLength(text, 'utf8') > CSV_MAX_BYTES) {
    throw validationError('CSV text exceeds 1 MB limit');
  }
  ensureLeadColumns(db);
  const leadGroup = normalizeGroupName(opts.group || opts.lead_group);
  const provider = new CsvProvider();
  const raws = provider.parse(text);
  const result = { created: 0, skipped: 0, errors: [], group: leadGroup };
  raws.forEach((raw, i) => {
    const lineNo = i + 2; // header is line 1
    if (!Object.values(raw).some(v => String(v).trim() !== '')) {
      result.skipped++;
      return;
    }
    try {
      createLead(db, {
        ...raw,
        source: 'csv',
        lead_group: normalizeGroupName(raw.lead_group || raw.group) || leadGroup,
      });
      result.created++;
    } catch (e) {
      result.skipped++;
      result.errors.push({ line: lineNo, error: e.message });
    }
  });
  return result;
}

/**
 * Discover leads from a provider search and insert new ones.
 * Skips rows whose source_ref already exists. Optionally scores each new lead.
 */
async function discoverLeads(db, opts = {}) {
  ensureLeadColumns(db);
  const { getProvider } = require('./providers');
  const providerName = String(opts.provider || 'tavily').trim() || 'tavily';
  const provider = getProvider(providerName);
  if (!provider) throw validationError(`unknown provider: ${providerName}`);
  if (provider.name === 'csv' || provider.name === 'manual') {
    throw validationError(`provider "${providerName}" does not support discovery search`);
  }
  if (provider.configured === false) {
    await provider.search(opts); // throws PROVIDER_NOT_CONFIGURED
  }
  const limit = Math.min(50, Math.max(1, Number(opts.limit) || 10));
  const query = String(opts.query || opts.category || 'business').trim() || 'business';
  const category = String(opts.category || query).trim();
  const location = String(opts.location || 'Springfield').trim() || 'Springfield';
  const scoreAfter = opts.score !== false;
  const websitePresence = normalizeWebsitePresence(opts.websitePresence);
  const leadGroup = normalizeGroupName(opts.group || opts.lead_group) || defaultDiscoverGroup(category, location);
  const autoTags = [category, location].map((t) => String(t).trim()).filter(Boolean);

  // Over-fetch when post-filtering by website presence (providers rarely support it natively).
  const fetchLimit = websitePresence
    ? Math.min(50, Math.max(limit * 3, limit))
    : limit;

  const searchDepthSetting = String(getSetting(db, 'providers.tavily.search_depth', 'advanced') || 'advanced')
    .trim().toLowerCase();
  const searchDepth = searchDepthSetting === 'basic' ? 'basic' : 'advanced';

  const rawResults = await provider.search({
    query,
    category,
    location,
    limit: fetchLimit,
    radiusMiles: opts.radiusMiles,
    minRating: opts.minRating,
    minReviews: opts.minReviews,
    websitePresence: websitePresence || undefined,
    searchDepth,
  });

  // Post-filter: empty/null/whitespace website = no; valid http(s) URL = has.
  // Providers (e.g. Tavily) have no native website-presence filter — only query hints.
  // Directory listing URLs are no longer treated as the business website upstream.
  let filtered = rawResults;
  if (websitePresence) {
    filtered = rawResults.filter((raw) => {
      const website = (provider.normalize ? provider.normalize(raw) : raw).website;
      const has = leadHasWebsite(website);
      return websitePresence === 'has' ? has : !has;
    });
  }

  const result = {
    provider: provider.name, queried: rawResults.length, created: 0, skipped: 0,
    scored: 0, leads: [], errors: [], group: leadGroup,
    websitePresence: websitePresence || null,
    searchDepth,
    warning: null,
  };

  if (rawResults.length === 0) {
    result.warning = `No search hits from ${provider.name} for "${category}" in "${location}". Try a clearer category/location or check the Tavily key.`;
    console.warn(`[discover] ${result.warning}`);
  } else if (websitePresence && filtered.length === 0) {
    result.warning = `Found ${rawResults.length} hits but none matched website filter "${websitePresence}". Try "Any" or a different niche/location.`;
    console.warn(`[discover] ${result.warning}`);
  } else if (filtered.length < limit) {
    result.warning = `Thin results: ${filtered.length} usable of ${rawResults.length} hits (wanted ${limit}).`;
    console.warn(`[discover] ${result.warning}`);
  }
  const existingRef = db.prepare('SELECT id FROM leads WHERE source = ? AND source_ref = ?');

  for (const raw of filtered) {
    if (result.created >= limit) break;
    try {
      const normalized = provider.normalize ? provider.normalize(raw) : raw;
      const source = normalized.source || provider.name;
      const sourceRef = normalized.source_ref || null;
      if (sourceRef) {
        const hit = existingRef.get(source, sourceRef);
        if (hit) { result.skipped++; continue; }
      }
      const tags = new Set([...(Array.isArray(normalized.tags) ? normalized.tags : []), ...autoTags]);
      const lead = createLead(db, {
        ...normalized,
        category: normalized.category || category,
        source,
        source_ref: sourceRef,
        status: 'new',
        lead_group: leadGroup,
        tags: [...tags],
      });
      result.created++;
      result.leads.push({
        id: lead.id, business_name: lead.business_name, score: lead.score, lead_group: lead.lead_group,
      });
      if (scoreAfter) {
        try {
          const scored = scoreLead(db, lead.id);
          result.scored++;
          result.leads[result.leads.length - 1].score = scored.score;
        } catch (scoreErr) {
          result.errors.push({ name: lead.business_name, error: `score: ${scoreErr.message}` });
        }
      }
    } catch (e) {
      result.skipped++;
      result.errors.push({ name: (raw && (raw.business_name || raw.name)) || '?', error: e.message });
    }
  }

  try {
    const thin = result.warning ? ` ${result.warning}` : '';
    db.prepare('INSERT INTO activity_log (area, message) VALUES (?, ?)').run(
      'leads',
      `Discover via ${provider.name}: ${result.created} created, ${result.skipped} skipped, ${result.queried} queried → group "${leadGroup}" (${category} · ${location}).${thin}`
        .slice(0, 2000)
    );
  } catch { /* ignore */ }

  return result;
}

/**
 * Facets for filtering: distinct groups, categories, and tags with counts.
 */
function listLeadFacets(db) {
  ensureLeadColumns(db);
  const groups = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(lead_group), ''), '(ungrouped)') AS name, COUNT(*) AS count
    FROM leads GROUP BY name ORDER BY count DESC, name ASC LIMIT 100
  `).all();
  const categories = db.prepare(`
    SELECT COALESCE(NULLIF(TRIM(category), ''), '(uncategorized)') AS name, COUNT(*) AS count
    FROM leads GROUP BY name ORDER BY count DESC, name ASC LIMIT 100
  `).all();
  const tagCounts = new Map();
  const tagRows = db.prepare('SELECT tags FROM leads WHERE tags IS NOT NULL AND tags != \'\'').all();
  for (const row of tagRows) {
    let tags = [];
    try { tags = JSON.parse(row.tags || '[]'); } catch { tags = []; }
    if (!Array.isArray(tags)) continue;
    for (const t of tags) {
      const key = String(t || '').trim();
      if (!key) continue;
      tagCounts.set(key, (tagCounts.get(key) || 0) + 1);
    }
  }
  const tags = [...tagCounts.entries()]
    .map(([name, count]) => ({ name, count }))
    .sort((a, b) => b.count - a.count || a.name.localeCompare(b.name))
    .slice(0, 100);
  return { groups, categories, tags };
}

/* ------------------------------------------------------------------ */
/* Duplicate detection + merge                                         */
/* ------------------------------------------------------------------ */

/**
 * Find likely duplicates of a lead (spec section 14).
 * Matches on: normalized phone digits, normalized business name
 * (lowercase, entity suffixes + punctuation stripped), normalized address,
 * website domain, email domain, exact email.
 * Returns [{ id, business_name, matched_on: [...] }].
 */
function findDuplicates(db, lead) {
  const me = typeof lead === 'object' ? lead : getLead(db, lead);
  if (!me) throw validationError('lead not found for duplicate check');

  const myPhone = normalizePhoneDigits(me.phone);
  const myName = normalizeName(me.business_name);
  const myDomain = domainFromWebsite(me.website) || domainFromEmail(me.email);
  const myEmail = String(me.email || '').trim().toLowerCase();
  const myAddr = normalizeAddress(me.address);

  if (!myPhone && !myName && !myAddr && !myDomain && !myEmail) return [];

  const rows = db.prepare(
    'SELECT id, business_name, phone, email, website, address FROM leads WHERE id != ?'
  ).all(me.id);

  const out = [];
  for (const r of rows) {
    const matchedOn = [];
    const rPhone = normalizePhoneDigits(r.phone);
    if (myPhone && rPhone && myPhone === rPhone && myPhone.length >= 7) matchedOn.push('phone');
    const rName = normalizeName(r.business_name);
    if (myName && rName && myName === rName) matchedOn.push('name');
    const rAddr = normalizeAddress(r.address);
    if (myAddr && rAddr && myAddr === rAddr && myAddr.length >= 8) matchedOn.push('address');
    const rDomain = domainFromWebsite(r.website) || domainFromEmail(r.email);
    if (myDomain && rDomain && myDomain === rDomain) matchedOn.push('domain');
    const rEmail = String(r.email || '').trim().toLowerCase();
    if (myEmail && rEmail && myEmail === rEmail) matchedOn.push('email');
    if (matchedOn.length > 0) {
      out.push({ id: r.id, business_name: r.business_name, matched_on: matchedOn });
      if (out.length >= 20) break;
    }
  }
  return out;
}

/**
 * Merge duplicate leads into one keeper. Moves facts/events/scores to the
 * keeper, fills empty keeper fields from dropped leads, unions tags, appends
 * notes, then deletes the dropped leads. All in one transaction.
 */
function mergeLeads(db, keepId, dropIds) {
  const keep = getLead(db, keepId);
  if (!keep) throw validationError(`keeper lead not found: ${keepId}`);
  const ids = [...new Set((dropIds || []).map(Number).filter(n => Number.isInteger(n) && n !== keepId))];
  if (ids.length === 0) throw validationError('no leads to merge');

  ensureLeadColumns(db);
  const FILL_FIELDS = ['category', 'phone', 'email', 'website', 'address', 'city',
    'state', 'postal_code', 'country', 'latitude', 'longitude', 'rating',
    'review_count', 'description', 'lead_group'];

  const tx = db.transaction(() => {
    const merged = { ...keep };
    const tagSet = new Set(keep.tags || []);
    const noteParts = [];
    if (keep.notes) noteParts.push(keep.notes);

    for (const dropId of ids) {
      const drop = getLead(db, dropId);
      if (!drop) throw validationError(`lead to merge not found: ${dropId}`);
      for (const f of FILL_FIELDS) {
        if ((merged[f] === null || merged[f] === undefined || merged[f] === '') &&
            drop[f] !== null && drop[f] !== undefined && drop[f] !== '') {
          merged[f] = drop[f];
        }
      }
      (drop.tags || []).forEach(t => tagSet.add(t));
      if (drop.notes) noteParts.push(`--- merged from #${dropId} (${drop.business_name}) ---\n${drop.notes}`);
      noteParts.push(`merged lead #${dropId} (${drop.business_name}) on ${new Date().toISOString()}`);

      db.prepare('UPDATE business_facts SET lead_id = ? WHERE lead_id = ?').run(keepId, dropId);
      db.prepare('UPDATE lead_scores SET lead_id = ? WHERE lead_id = ?').run(keepId, dropId);
      db.prepare('UPDATE lead_events SET lead_id = ? WHERE lead_id = ?').run(keepId, dropId);
      db.prepare('DELETE FROM leads WHERE id = ?').run(dropId);
    }

    const setCols = FILL_FIELDS.map(f => `${f} = @${f}`).join(', ');
    const params = {};
    for (const f of FILL_FIELDS) params[f] = merged[f] === undefined ? null : merged[f];
    db.prepare(`
      UPDATE leads SET ${setCols}, tags=@tags, notes=@notes,
        updated_at=datetime('now') WHERE id=@id
    `).run({ ...params, tags: JSON.stringify([...tagSet]), notes: noteParts.join('\n\n').slice(0, 10000) || null, id: keepId });
    logEvent(db, keepId, 'merged', `absorbed leads: ${ids.join(', ')}`);
  });
  tx();
  return getLead(db, keepId);
}

/* ------------------------------------------------------------------ */
/* Website quality heuristics (transparent, rule-based)                */
/* ------------------------------------------------------------------ */

/** Read stored website-check facts for a lead into a flags object. */
function websiteFlagsFromFacts(db, leadId) {
  const rows = db.prepare(
    "SELECT fact_key, value FROM business_facts WHERE lead_id = ? AND fact_key LIKE 'website.%'"
  ).all(leadId);
  const flags = {};
  for (const r of rows) {
    const key = r.fact_key.replace(/^website\./, '');
    if (r.value === 'true') flags[key] = true;
    else if (r.value === 'false') flags[key] = false;
    else if (r.value !== '' && Number.isFinite(Number(r.value))) flags[key] = Number(r.value);
    else flags[key] = r.value;
  }
  return flags;
}

/**
 * "Poor website" heuristic (spec section 16, +15).
 * website present AND (unreachable OR no SSL OR not mobile-friendly OR
 * outdated design). Transparent: every input comes from stored website.*
 * facts written by researchLead, or from an explicit opts.websiteCheck.
 */
function isPoorWebsite(lead, flags) {
  if (!lead.website) return false;
  if (flags.reachable === false) return true;
  if (flags.has_ssl === false) return true;
  if (flags.mobile_friendly === false) return true;
  if (flags.outdated_design === true) return true;
  return false;
}

/**
 * "Active business" heuristic (spec section 16, +10).
 * status not in ('lost') AND has at least one contact channel
 * (phone, email, or website).
 */
function isActiveBusiness(lead) {
  if (lead.status === 'lost') return false;
  return Boolean(lead.phone || lead.email || lead.website);
}

/** "Strong category" heuristic (spec section 16, +10). */
function isStrongCategory(lead) {
  const c = String(lead.category || '').toLowerCase();
  return STRONG_CATEGORIES.some(k => c.includes(k));
}

/* ------------------------------------------------------------------ */
/* Scoring (spec section 16)                                           */
/* ------------------------------------------------------------------ */

/**
 * Score a lead 0–100 using the spec section-16 table. Writes a lead_scores
 * row (with JSON breakdown) and updates leads.score. opts.websiteCheck can
 * inject a WebsiteCheck object; otherwise stored website.* facts are used.
 */
function scoreLead(db, id, opts = {}) {
  const lead = getLead(db, id);
  if (!lead) throw validationError(`lead not found: ${id}`);

  const flags = opts.websiteCheck
    ? {
        reachable: opts.websiteCheck.reachable,
        has_ssl: opts.websiteCheck.hasSsl,
        mobile_friendly: opts.websiteCheck.mobileFriendly,
        outdated_design: opts.websiteCheck.outdatedDesign,
      }
    : websiteFlagsFromFacts(db, id);

  const breakdown = {};
  if (!lead.website) breakdown.no_website = SCORE_SIGNALS.no_website;
  if (Number.isInteger(lead.review_count) && lead.review_count >= 20) {
    breakdown.many_reviews = SCORE_SIGNALS.many_reviews;
  }
  if (typeof lead.rating === 'number' && lead.rating > 4) {
    breakdown.high_rating = SCORE_SIGNALS.high_rating;
  }
  if (lead.email && isValidEmail(lead.email)) breakdown.public_email = SCORE_SIGNALS.public_email;
  if (lead.phone) breakdown.phone = SCORE_SIGNALS.phone;
  if (isActiveBusiness(lead)) breakdown.active_business = SCORE_SIGNALS.active_business;
  if (isPoorWebsite(lead, flags)) breakdown.poor_website = SCORE_SIGNALS.poor_website;
  if (isStrongCategory(lead)) breakdown.strong_category = SCORE_SIGNALS.strong_category;

  const score = Math.min(SCORE_CAP, Object.values(breakdown).reduce((a, b) => a + b, 0));

  db.prepare('INSERT INTO lead_scores (lead_id, score, breakdown) VALUES (?, ?, ?)')
    .run(id, score, JSON.stringify(breakdown));
  db.prepare("UPDATE leads SET score = ?, updated_at = datetime('now') WHERE id = ?")
    .run(score, id);
  logEvent(db, id, 'scored', `score=${score} breakdown=${JSON.stringify(breakdown)}`);
  return { id, score, breakdown };
}

/* ------------------------------------------------------------------ */
/* Qualification (spec section 15)                                     */
/* ------------------------------------------------------------------ */

/**
 * Qualify a lead from spec section-15 positive/negative flags plus the
 * current score vs score.threshold_qualified.
 * Sets qualified (0/1), qualification_note, and moves status to 'qualified'
 * when newly qualified from new/researching. Returns
 * { id, qualified, positives, negatives, score, threshold, note }.
 */
function qualifyLead(db, id) {
  const lead = getLead(db, id);
  if (!lead) throw validationError(`lead not found: ${id}`);
  const flags = websiteFlagsFromFacts(db, id);

  const positives = [];
  const negatives = [];

  // Positive flags (opportunities for a new website)
  if (!lead.website) positives.push('no_website');
  if (flags.reachable === false && lead.website) positives.push('broken_website');
  if (flags.mobile_friendly === false) positives.push('not_mobile_responsive');
  if (flags.has_ssl === false) positives.push('missing_ssl');
  if (flags.has_cta === false) positives.push('missing_cta');
  if (flags.has_contact_form === false) positives.push('no_contact_mechanism');
  if (flags.has_booking === false && lead.website) positives.push('no_booking_mechanism');
  if (typeof flags.load_time_ms === 'number' && flags.load_time_ms > 8000) positives.push('slow_website');
  if (flags.outdated_design === true) positives.push('outdated_design');
  if (isPoorWebsite(lead, flags) && !positives.includes('no_website')) positives.push('poor_website');

  // Negative flags (disqualifiers)
  const excellentWebsite = Boolean(lead.website) &&
    flags.reachable !== false && flags.has_ssl === true &&
    flags.mobile_friendly === true && flags.has_cta !== false &&
    flags.outdated_design !== true && !isPoorWebsite(lead, flags);
  if (excellentWebsite) negatives.push('excellent_existing_website');
  if (lead.status === 'lost') negatives.push('closed_or_lost');
  const dupes = findDuplicates(db, lead);
  if (dupes.length > 0) negatives.push(`duplicate_listing (#${dupes.map(d => d.id).join(', #')})`);
  if (!lead.phone && !lead.email && !lead.website) negatives.push('invalid_contact_information');

  const threshold = Number(getSetting(db, 'score.threshold_qualified', '50')) || 50;
  const score = typeof lead.score === 'number' ? lead.score : 0;
  const qualified = positives.length > 0 && negatives.length === 0 && score >= threshold;

  const note = [
    `score=${score} (threshold=${threshold})`,
    `positives: ${positives.join(', ') || 'none'}`,
    `negatives: ${negatives.join(', ') || 'none'}`,
    qualified ? 'QUALIFIED' : 'NOT QUALIFIED',
  ].join(' | ');

  db.prepare(`
    UPDATE leads SET qualified = ?, qualification_note = ?,
      status = CASE WHEN ? = 1 AND status IN ('new','researching') THEN 'qualified' ELSE status END,
      updated_at = datetime('now')
    WHERE id = ?
  `).run(qualified ? 1 : 0, note.slice(0, 2000), qualified ? 1 : 0, id);
  logEvent(db, id, qualified ? 'qualified' : 'disqualified', note.slice(0, 2000));

  return { id, qualified, positives, negatives, score, threshold, note };
}

/* ------------------------------------------------------------------ */
/* Facts with provenance (spec sections 17–18)                         */
/* ------------------------------------------------------------------ */

/**
 * Store one researched fact. claim_class must be one of
 * VERIFIED / AI_COPY / OWNER_PROVIDED / UNKNOWN. Never invent facts —
 * every fact needs a source.
 */
function addFact(db, leadId, fact) {
  const lead = getLead(db, leadId);
  if (!lead) throw validationError(`lead not found: ${leadId}`);
  const f = fact || {};
  if (!f.fact_key || !String(f.fact_key).trim()) throw validationError('fact.fact_key is required');
  if (f.value === null || f.value === undefined || String(f.value).trim() === '') {
    throw validationError('fact.value is required');
  }
  if (!f.source || !String(f.source).trim()) throw validationError('fact.source is required');
  if (!CLAIM_CLASSES.includes(f.claim_class)) {
    throw validationError(`fact.claim_class must be one of ${CLAIM_CLASSES.join('/')}`);
  }
  const confidence = ['high', 'medium', 'low'].includes(f.confidence) ? f.confidence : 'medium';
  const key = String(f.fact_key).trim().slice(0, 200);
  // Site ingest JSON (structure/snapshot/style/map) regularly exceeds 5k; keep headroom so JSON stays valid.
  const maxVal = /^site\.(structure|snapshot|style_guide|map|faq)$/.test(key) ? 80000 : 5000;
  const info = db.prepare(`
    INSERT INTO business_facts (lead_id, fact_key, value, source, source_url, confidence, claim_class)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).run(
    leadId,
    key,
    String(f.value).slice(0, maxVal),
    String(f.source).trim().slice(0, 200),
    f.source_url ? String(f.source_url).slice(0, 1000) : null,
    confidence,
    f.claim_class
  );
  logEvent(db, leadId, 'fact_added', `${f.fact_key} [${f.claim_class}] via ${f.source}`);
  return db.prepare('SELECT * FROM business_facts WHERE id = ?').get(info.lastInsertRowid);
}

function getFacts(db, leadId) {
  return db.prepare('SELECT * FROM business_facts WHERE lead_id = ? ORDER BY fetched_at DESC, id DESC')
    .all(leadId);
}

/* ------------------------------------------------------------------ */
/* Research (spec section 17)                                          */
/* ------------------------------------------------------------------ */

/**
 * Research a lead: fetch business details + contact details + website
 * quality via a provider, store each fact with provenance, and fill empty
 * lead fields. Prefers a configured discovery provider (e.g. Tavily);
 * otherwise uses csv/manual passthrough (facts stored as UNKNOWN) plus
 * site ingest. Never invents stub businesses. AI enhancement is optional
 * and never invents facts.
 */
async function researchLead(db, id) {
  const lead = getLead(db, id);
  if (!lead) throw validationError(`lead not found: ${id}`);

  // Prefer lead.source when it is a configured discovery provider; else Tavily
  // if configured; else csv/manual passthrough of existing lead fields.
  let provider = getProvider(lead.source);
  const sourceIsDiscovery = provider && provider.configured !== false &&
    provider.name !== 'csv' && provider.name !== 'manual';
  if (!sourceIsDiscovery) {
    const tavily = getProvider('tavily');
    if (tavily && tavily.configured) {
      provider = tavily;
    } else if (!provider || provider.configured === false) {
      provider = getProvider('manual');
    }
  }
  if (!provider) {
    throw notConfiguredError('research',
      'No discovery provider is configured. Set a Tavily API key in Settings → Lead discovery.');
  }
  const isVerified = provider.name !== 'csv' && provider.name !== 'manual' &&
    provider.configured !== false;
  const factClass = isVerified ? 'VERIFIED' : 'UNKNOWN';
  const factConfidence = isVerified ? 'medium' : 'low';
  const sourceUrl = lead.website || null;

  db.prepare("UPDATE leads SET status='researching', updated_at=datetime('now') WHERE id=?").run(id);
  logEvent(db, id, 'research_started', `provider=${provider.name}`);

  const stored = [];
  const storeFact = (fact_key, value, extra = {}) => {
    if (value === null || value === undefined || String(value).trim() === '') return;
    stored.push(addFact(db, id, {
      fact_key, value: String(value), source: provider.name,
      source_url: sourceUrl, confidence: factConfidence,
      claim_class: factClass, ...extra,
    }));
  };

  try {
    const biz = await provider.fetchBusiness({ business_name: lead.business_name, website: lead.website });
    const norm = provider.normalize ? provider.normalize(biz) : normalizeToLead(biz);

    // Store business facts with provenance.
    storeFact('phone', norm.phone);
    storeFact('email', norm.email);
    storeFact('address', norm.address);
    storeFact('city', norm.city);
    storeFact('state', norm.state);
    storeFact('postal_code', norm.postal_code);
    storeFact('rating', norm.rating);
    storeFact('review_count', norm.review_count);
    storeFact('description', norm.description);
    if (Array.isArray(norm.services)) norm.services.forEach((sv, i) => storeFact(`service:${i}`, sv));
    if (Array.isArray(norm.hours)) storeFact('hours', JSON.stringify(norm.hours));

    // Website quality check + rich site ingest (content for redesign briefs).
    const siteUrl = norm.website || lead.website;
    let ingestFill = {};
    if (siteUrl) {
      let check = null;
      try {
        check = await provider.fetchWebsite(siteUrl);
      } catch {
        check = null;
      }

      let ingest = null;
      let ingestStoredQuality = false;
      try {
        const siteIngest = require('./siteIngest');
        ingest = await siteIngest.ingestSite(siteUrl);
        for (const f of siteIngest.factsFromIngest(ingest)) {
          stored.push(addFact(db, id, f));
          if (String(f.fact_key).startsWith('website.')) ingestStoredQuality = true;
        }
        if (ingest && ingest.check) check = ingest.check;
        if (ingest && ingest.extracted) {
          if (ingest.extracted.phones[0]) ingestFill.phone = ingest.extracted.phones[0];
          if (ingest.extracted.emails[0]) ingestFill.email = ingest.extracted.emails[0];
          if (ingest.extracted.about && !norm.description) ingestFill.description = ingest.extracted.about.slice(0, 2000);
          if (ingest.extracted.services.length) ingestFill.services = ingest.extracted.services;
          if (ingest.extracted.hours.length) ingestFill.hours = ingest.extracted.hours;
        }
        const map = ingest.siteMap || (ingest.extracted && ingest.extracted.site_map) || {};
        logEvent(db, id, 'site_ingested',
          `pages=${ingest.pageCount || 0} services=${(map.services && map.services.length) || (ingest.extracted && ingest.extracted.services.length) || 0}` +
          ` sitemap=${map.sitemap_count || 0} areas=${(map.areas && map.areas.length) || 0}` +
          (ingest.error ? ` err=${ingest.error}` : ''));

        // Optional AI enhancement of hero/gallery photos (fal.ai).
        try {
          const imageEnhance = require('./imageEnhance');
          const imgs = (ingest.extracted && ingest.extracted.images) || [];
          const ranked = [...imgs].sort((a, b) => {
            const rank = (r) => (r === 'hero' ? 0 : r === 'logo' ? 1 : 2);
            return rank(a.role) - rank(b.role);
          });
          const urls = ranked.map((x) => x.url).filter(Boolean).slice(0, imageEnhance.MAX_IMAGES);
          if (urls.length && imageEnhance.falConfigured(db)) {
            const enhanced = await imageEnhance.enhanceImages(db, urls, { leadId: id });
            let ei = 0;
            for (const row of enhanced) {
              if (!row.enhanced_url) {
                logEvent(db, id, 'image_enhance_skipped',
                  `${row.source} :: ${row.error || row.reason || 'skip'}`.slice(0, 500));
                continue;
              }
              stored.push(addFact(db, id, {
                fact_key: `site.image.enhanced:${ei}`,
                value: row.enhanced_url,
                source: 'fal-enhance',
                source_url: row.source,
                confidence: 'medium',
                claim_class: 'AI_COPY',
              }));
              if (row.local_path) {
                stored.push(addFact(db, id, {
                  fact_key: `site.image.enhanced:${ei}.local`,
                  value: row.local_path,
                  source: 'fal-enhance',
                  source_url: row.source,
                  confidence: 'medium',
                  claim_class: 'AI_COPY',
                }));
              }
              ei++;
            }
            logEvent(db, id, 'images_enhanced', `count=${ei} model=${imageEnhance.DEFAULT_MODEL}`);
          }
        } catch (enhErr) {
          logEvent(db, id, 'image_enhance_failed',
            String((enhErr && enhErr.message) || enhErr).slice(0, 500));
        }
      } catch (ingestErr) {
        logEvent(db, id, 'site_ingest_failed',
          String((ingestErr && ingestErr.message) || ingestErr).slice(0, 500));
      }

      // Provider probe only when ingest did not already write quality facts.
      if (check && !ingestStoredQuality) {
        storeFact('website.reachable', String(check.reachable));
        storeFact('website.has_ssl', String(check.hasSsl));
        storeFact('website.mobile_friendly', String(check.mobileFriendly));
        storeFact('website.has_cta', String(check.hasCta));
        storeFact('website.has_contact_form', String(check.hasContactForm));
        storeFact('website.has_booking', String(check.hasBooking));
        storeFact('website.load_time_ms', String(check.loadTimeMs));
        storeFact('website.outdated_design', String(check.outdatedDesign));
        storeFact('website.checked_at', check.checkedAt);
      }
    }

    // Fill empty lead fields from research (never overwrite existing data).
    const fillable = ['phone', 'email', 'website', 'address', 'city', 'state',
      'postal_code', 'rating', 'review_count', 'description'];
    const updates = {};
    const merged = { ...norm, ...ingestFill };
    for (const f of fillable) {
      if ((lead[f] === null || lead[f] === undefined || lead[f] === '') &&
          merged[f] !== null && merged[f] !== undefined && merged[f] !== '') {
        updates[f] = merged[f];
      }
    }
    // services / hours live as JSON columns when empty on the lead.
    if ((!lead.services || lead.services === '[]' || lead.services === '') &&
        Array.isArray(ingestFill.services) && ingestFill.services.length) {
      updates.services = JSON.stringify(ingestFill.services);
    }
    if ((!lead.hours || lead.hours === '[]' || lead.hours === '') &&
        Array.isArray(ingestFill.hours) && ingestFill.hours.length) {
      updates.hours = JSON.stringify(ingestFill.hours);
    }
    if (Object.keys(updates).length > 0) {
      const set = Object.keys(updates).map(k => `${k} = @${k}`).join(', ');
      db.prepare(`UPDATE leads SET ${set}, updated_at=datetime('now') WHERE id=@id`)
        .run({ ...updates, id });
    }

    // Optional AI enhancement: draft marketing copy (AI_COPY, never facts).
    // src/ai.js is owned by another workstream and may not exist yet.
    try {
      const ai = require('./ai.js');
      if (ai && typeof ai.aiConfigured === 'function' && ai.aiConfigured()) {
        const res = await ai.chat({
          task: 'research',
          messages: [
            { role: 'system', content: 'Write a short, friendly marketing description (2-3 sentences) for a local business website. Do NOT invent factual claims (founding year, awards, service areas) — only generic, clearly promotional language.' },
            { role: 'user', content: `Business: ${lead.business_name} (${lead.category || 'local business'}). Known: ${norm.description || 'no description available'}.` },
          ],
          maxTokens: 150, leadId: id, note: 'research marketing blurb',
        });
        const copy = res && (res.text || res.content || res);
        if (copy && String(copy).trim()) {
          storeFact('marketing_blurb', String(copy).trim().slice(0, 1000), {
            claim_class: 'AI_COPY', confidence: 'low',
          });
        }
      }
    } catch (aiErr) {
      // AI optional: module missing, not configured, or failed — skip.
      logEvent(db, id, 'research_ai_skipped', String((aiErr && aiErr.message) || aiErr).slice(0, 500));
    }

    logEvent(db, id, 'research_completed',
      `provider=${provider.name} facts=${stored.length} class=${factClass}`);
    return { id, provider: provider.name, facts: stored.length, filled: Object.keys(updates).length };
  } catch (err) {
    logEvent(db, id, 'research_failed', String(err.message).slice(0, 1000));
    throw err;
  }
}

/* ------------------------------------------------------------------ */

module.exports = {
  // constants
  SCORE_SIGNALS, SCORE_CAP, STRONG_CATEGORIES, CLAIM_CLASSES, LEAD_STATUSES,
  CSV_MAX_BYTES,
  // helpers (exported for tests / other workstreams)
  normalizePhoneDigits, normalizeName, domainFromWebsite, domainFromEmail,
  normalizeAddress, isValidEmail, isValidUrl, leadHasWebsite, normalizeWebsitePresence,
  isPoorWebsite, isActiveBusiness, isStrongCategory, websiteFlagsFromFacts,
  getSetting, ensureLeadColumns, normalizeGroupName, defaultDiscoverGroup,
  // crud
  createLead, getLead, updateLead, deleteLead,
  // import / discover / dedup / merge
  importCsv, discoverLeads, listLeadFacets, findDuplicates, mergeLeads,
  // scoring / qualification
  scoreLead, qualifyLead,
  // facts / research
  addFact, getFacts, researchLead,
};
