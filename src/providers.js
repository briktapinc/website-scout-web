'use strict';

/**
 * Lead providers for Website Scout (single-user desktop app).
 *
 * A LeadProvider plugs a discovery source into the lead engine. All raw
 * provider output is converted to one canonical shape via normalize(),
 * described in `normalizeToLead()` below (spec section 13: Lead
 * normalization).
 *
 * @typedef {Object} LeadProvider
 * @property {string} name - unique provider name, e.g. 'csv', 'manual', 'tavily'
 * @property {(opts: object) => Promise<RawLead[]>} search - run a discovery
 *   search; opts: { query, category, location, radiusMiles, minRating,
 *   minReviews, limit, websitePresence ('has'|'no'), ...providerSpecific }
 * @property {(ref: object|string) => Promise<RawLead>} fetchBusiness - fetch one
 *   business record by provider reference
 * @property {(url: string) => Promise<WebsiteCheck>} fetchWebsite - fetch +
 *   analyse a business website; returns quality flags
 * @property {(biz: RawLead) => Promise<ContactDetails>} fetchContactDetails -
 *   enrich contact details for a raw business record
 * @property {(raw: RawLead) => CanonicalLead} normalize - convert provider raw
 *   output to the canonical lead shape
 *
 * @typedef {Object} RawLead - provider-specific raw business record
 * @typedef {Object} WebsiteCheck
 * @property {boolean} reachable
 * @property {boolean} hasSsl
 * @property {boolean} mobileFriendly
 * @property {boolean} hasCta
 * @property {boolean} hasContactForm
 * @property {boolean} hasBooking
 * @property {number} loadTimeMs
 * @property {boolean} outdatedDesign
 * @property {string} checkedAt
 * @typedef {Object} ContactDetails
 * @property {string} [phone]
 * @property {string} [email]
 * @property {string} [website]
 *
 * @typedef {Object} CanonicalLead - spec section-13 normalization schema
 * @property {string} business_name
 * @property {string} [category]
 * @property {string} [phone]
 * @property {string} [email]
 * @property {string} [website]
 * @property {string} [address]
 * @property {string} [city]
 * @property {string} [state]
 * @property {string} [postal_code]
 * @property {string} [country]
 * @property {number} [latitude]
 * @property {number} [longitude]
 * @property {number} [rating]
 * @property {number} [review_count]
 * @property {string} [description]
 * @property {Array} [hours]
 * @property {Array} [services]
 * @property {Array} [social_links]
 * @property {string} [source]
 */

const MAX_TEXT = 2000;

/** Trim a value to a safe string (or undefined when empty). */
function s(v, max = MAX_TEXT) {
  if (v === null || v === undefined) return undefined;
  const t = String(v).trim();
  return t ? t.slice(0, max) : undefined;
}

/** Parse a number-ish value (or undefined). */
function n(v) {
  if (v === null || v === undefined || v === '') return undefined;
  const x = Number(v);
  return Number.isFinite(x) ? x : undefined;
}

/**
 * Convert any provider raw record into the canonical lead shape
 * (spec section 13). Maps 1:1 onto the `leads` table columns.
 * Exported so leadEngine and the CSV importer share one mapping.
 *
 * @param {object} raw
 * @returns {CanonicalLead}
 */
function normalizeToLead(raw) {
  const r = raw || {};
  const lead = {
    business_name: s(r.business_name || r.name) || '',
    category: s(r.category, 200),
    phone: s(r.phone, 60),
    email: s(r.email, 320),
    website: s(r.website || r.url, 500),
    address: s(r.address, 500),
    city: s(r.city, 200),
    state: s(r.state, 100),
    postal_code: s(r.postal_code || r.zip || r.postalCode, 40),
    country: s(r.country, 100) || 'US',
    latitude: n(r.latitude),
    longitude: n(r.longitude),
    rating: n(r.rating),
    review_count: n(r.review_count || r.reviews),
    description: s(r.description, 5000),
    hours: Array.isArray(r.hours) ? r.hours : undefined,
    services: Array.isArray(r.services) ? r.services : undefined,
    social_links: Array.isArray(r.social_links) ? r.social_links : undefined,
    source: s(r.source, 100),
    source_ref: s(r.source_ref, 500),
  };
  // Drop undefined keys so partial records stay clean.
  for (const k of Object.keys(lead)) {
    if (lead[k] === undefined) delete lead[k];
  }
  return lead;
}

/**
 * Error factory for providers that need credentials/config before use.
 */
function notConfiguredError(providerName, instructions) {
  const err = new Error(`PROVIDER_NOT_CONFIGURED: ${providerName}. ${instructions}`);
  err.code = 'PROVIDER_NOT_CONFIGURED';
  err.provider = providerName;
  return err;
}

/**
 * CsvProvider — parses uploaded CSV text into raw lead records.
 * Header mapping (case-insensitive): business_name, category, phone, email,
 * website, address, city, state, postal_code, rating, review_count,
 * description (+ aliases: name->business_name, zip->postal_code).
 */
class CsvProvider {
  constructor() {
    this.name = 'csv';
    this.description = 'Parse uploaded CSV text into lead records';
    this.configured = true;
  }

  /** Parse CSV text into an array of raw row objects. Handles quoted fields. */
  parse(text) {
    if (typeof text !== 'string' || !text.trim()) return [];
    const rows = [];
    let row = [];
    let field = '';
    let inQuotes = false;
    const pushField = () => { row.push(field); field = ''; };
    const pushRow = () => { rows.push(row); row = []; };
    for (let i = 0; i < text.length; i++) {
      const c = text[i];
      if (inQuotes) {
        if (c === '"') {
          if (text[i + 1] === '"') { field += '"'; i++; }
          else inQuotes = false;
        } else field += c;
      } else if (c === '"') {
        inQuotes = true;
      } else if (c === ',') {
        pushField();
      } else if (c === '\r') {
        // ignore; \n handles the break
      } else if (c === '\n') {
        pushField(); pushRow();
      } else field += c;
    }
    pushField(); pushRow();
    const nonEmpty = rows.filter(r => r.some(c => String(c).trim() !== ''));
    if (nonEmpty.length === 0) return [];
    const headers = nonEmpty[0].map(h =>
      String(h).trim().toLowerCase().replace(/[\s-]+/g, '_'));
    const aliases = {
      name: 'business_name', business: 'business_name', company: 'business_name',
      zip: 'postal_code', zipcode: 'postal_code', zip_code: 'postal_code',
      reviews: 'review_count', num_reviews: 'review_count',
      url: 'website', homepage: 'website', site: 'website',
      type: 'category', industry: 'category',
      phone_number: 'phone', telephone: 'phone', tel: 'phone',
      email_address: 'email', e_mail: 'email',
      street: 'address', street_address: 'address',
      description: 'description', about: 'description', notes: 'description',
    };
    return nonEmpty.slice(1).map(cols => {
      const raw = {};
      headers.forEach((h, i) => {
        const key = aliases[h] || h;
        raw[key] = cols[i] !== undefined ? String(cols[i]).trim() : '';
      });
      return raw;
    });
  }

  async search(opts) {
    const rows = this.parse(opts && opts.text ? opts.text : '');
    return rows.map(r => this.normalize(r));
  }

  async fetchBusiness(ref) { return this.normalize(ref); }

  async fetchWebsite() {
    throw notConfiguredError('csv',
      'CSV rows have no live website fetcher. Use a configured discovery provider (e.g. Tavily) or site ingest for quality checks.');
  }

  async fetchContactDetails(biz) {
    const lead = this.normalize(biz);
    return { phone: lead.phone, email: lead.email, website: lead.website };
  }

  normalize(raw) {
    const lead = normalizeToLead(raw);
    lead.source = 'csv';
    return lead;
  }
}

/**
 * ManualProvider — passthrough for hand-entered leads (UI "Add lead" form).
 */
class ManualProvider {
  constructor() {
    this.name = 'manual';
    this.description = 'Manually entered leads (passthrough, validated downstream)';
    this.configured = true;
  }

  async search() { return []; }

  async fetchBusiness(ref) { return this.normalize(ref); }

  async fetchWebsite() {
    throw notConfiguredError('manual',
      'Manual leads have no website fetcher. Use a configured discovery provider (e.g. Tavily) or site ingest for quality checks.');
  }

  async fetchContactDetails(biz) {
    const lead = this.normalize(biz);
    return { phone: lead.phone, email: lead.email, website: lead.website };
  }

  normalize(raw) {
    const lead = normalizeToLead(raw);
    lead.source = 'manual';
    return lead;
  }
}

/* ------------------------------------------------------------------ */
/* Tavily helpers — local-biz query templates + field extraction       */
/* ------------------------------------------------------------------ */

/** Hosts that list businesses but are not the business's own site. */
const DIRECTORY_HOST_SUFFIXES = [
  'yelp.com', 'yellowpages.com', 'bbb.org', 'angi.com', 'angieslist.com',
  'homeadvisor.com', 'thumbtack.com', 'mapquest.com', 'superpages.com',
  'manta.com', 'hotfrog.com', 'foursquare.com', 'tripadvisor.com',
  'nextdoor.com', 'houzz.com', 'porch.com', 'buildzoom.com',
  'facebook.com', 'instagram.com', 'linkedin.com', 'twitter.com', 'x.com',
  'google.com', 'bing.com', 'apple.com', 'mapcarta.com', 'waze.com',
  'citysearch.com', 'merchantcircle.com', 'chamberofcommerce.com',
  'expertise.com', 'clutch.co', 'bark.com', 'taskrabbit.com',
  // Roundup / media pages — not a single business homepage
  'statesman.com', 'nytimes.com', 'forbes.com', 'businessinsider.com',
  'timeout.com', 'eater.com', 'thrillist.com', 'patch.com',
];

const TITLE_NOISE_RE = /\s*[-–|•:]\s*(?:yelp|yellow\s*pages|bbb|angi(?:e'?s?\s*list)?|homeadvisor|thumbtack|facebook|instagram|linkedin|tripadvisor|nextdoor|houzz|mapquest|superpages|manta|reviews?|directory|listing).*$/i;

const LISTICLE_TITLE_RE = /^(?:top\s+)?\d+\s+best\b|\b(?:top|best)\s+\d+\b|\b(?:best|top)\s+.+\s+near\b|\b(?:directory|listings?|service providers)\b/i;

function hostFromUrl(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    return u.hostname.replace(/^www\./, '').toLowerCase();
  } catch {
    return '';
  }
}

function isDirectoryHost(host) {
  if (!host) return false;
  return DIRECTORY_HOST_SUFFIXES.some((d) => host === d || host.endsWith(`.${d}`));
}

/** True when the URL looks like a roundup/blog/search page, not a biz homepage. */
function isNonBusinessPage(url) {
  try {
    const u = new URL(/^https?:\/\//i.test(url) ? url : `https://${url}`);
    const path = (u.pathname || '').toLowerCase();
    if (/\/(search|best|top-\d|blog|article|news|list)\b/i.test(path)) return true;
    if (/[?&]find_desc=/i.test(u.search || '')) return true;
    return false;
  } catch {
    return false;
  }
}

function cleanBusinessName(title, url) {
  let name = String(title || '').trim();
  if (!name) {
    const host = hostFromUrl(url);
    name = host ? host.split('.')[0] : 'Unknown business';
  }
  name = name.replace(TITLE_NOISE_RE, '').trim();
  name = name.replace(/\s+\|\s+.*$/, '').trim();
  // Drop embedded phone numbers from SEO titles.
  name = name.replace(/(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}/g, ' ').trim();
  name = name.replace(/\s{2,}/g, ' ').replace(/^[,:\-–|]+\s*/, '').replace(/\s+[,:\-–|]+$/, '').trim();
  // Prefer a cleaner brand from the hostname when the title is a long SEO dump.
  if (name.length > 60 || /\b(emergency|24\s*hour|services?)\b/i.test(name)) {
    const host = hostFromUrl(url);
    if (host && !isDirectoryHost(host)) {
      let brand = host.replace(/\.(com|net|org|biz|co|us)$/i, '').split('.')[0];
      brand = brand.replace(/[-_]+/g, ' ');
      brand = brand.replace(/(plumbing|electric(?:al)?|hvac|roofing|dental|dentist|law|legal|auto|home|services?)$/i, ' $1');
      brand = brand.replace(/\s+/g, ' ').trim()
        .replace(/\b\w/g, (c) => c.toUpperCase());
      if (brand.length >= 3 && brand.length <= 48) name = brand;
    }
  }
  return name.slice(0, 200) || 'Unknown business';
}

function extractPhone(text) {
  const t = String(text || '');
  // Prefer NANP-style numbers; avoid years like 2024.
  const re = /(?:\+?1[-.\s]?)?(?:\(?\d{3}\)?[-.\s])\d{3}[-.\s]\d{4}\b/g;
  const m = t.match(re);
  if (!m) return undefined;
  for (const raw of m) {
    const digits = raw.replace(/\D/g, '');
    const n = digits.length === 11 && digits.startsWith('1') ? digits.slice(1) : digits;
    if (n.length === 10 && !/^(\d)\1{9}$/.test(n)) return raw.trim().slice(0, 60);
  }
  return undefined;
}

function extractEmail(text) {
  const m = String(text || '').match(/\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b/);
  if (!m) return undefined;
  const email = m[0].toLowerCase();
  if (/@(example|email|domain|sentry|wixpress)\./i.test(email)) return undefined;
  return email.slice(0, 320);
}

/** Rough US street address from snippet text. */
function extractAddress(text) {
  const t = String(text || '').replace(/\s+/g, ' ');
  // Word-boundary after short suffixes so "St"≠"Austin"/"Standard", "Dr"≠"Address".
  const m = t.match(
    /\b\d{1,5}\s+[A-Za-z0-9.'#-][A-Za-z0-9.'#\-\s]{1,40}?\s(?:Streets?|St|Avenues?|Ave|Roads?|Rd|Boulevards?|Blvd|Drives?|Dr|Lanes?|Ln|Ways?|Courts?|Ct|Highways?|Hwy|Parkways?|Pkwy)\b\.?(?:\s*,?\s*[A-Za-z .'-]{2,40})?(?:\s*,?\s*[A-Z]{2}\s+\d{5}(?:-\d{4})?)?/i
  );
  if (!m) return undefined;
  const addr = m[0].trim().slice(0, 500);
  // Reject phone-fragment false positives (e.g. last-4 + following prose).
  if (/#/.test(addr)) return undefined;
  if (addr.split(/\s+/).length < 3) return undefined;
  return addr;
}

/** Pull an official http(s) site mentioned in content (not directory hosts). */
function extractWebsiteFromText(text, excludeHost) {
  const re = /https?:\/\/[^\s"'<>)\]]+/gi;
  const t = String(text || '');
  let m;
  while ((m = re.exec(t)) !== null) {
    let raw = m[0].replace(/[.,;:]+$/, '');
    const host = hostFromUrl(raw);
    if (!host || isDirectoryHost(host)) continue;
    if (excludeHost && host === excludeHost) continue;
    if (/\.(png|jpe?g|gif|svg|webp|css|js)(\?|$)/i.test(raw)) continue;
    return raw.slice(0, 500);
  }
  // Bare domain mentions: "visit acmeplumbing.com"
  const bare = t.match(/\b(?:visit|website|site|www)[:\s]+(?:https?:\/\/)?([a-z0-9][-a-z0-9.]*\.[a-z]{2,})/i);
  if (bare) {
    const host = bare[1].replace(/^www\./, '').toLowerCase();
    if (!isDirectoryHost(host) && host !== excludeHost) {
      return `https://${host}`.slice(0, 500);
    }
  }
  return undefined;
}

function parseCityState(location) {
  const loc = String(location || '').trim();
  if (!loc) return { city: undefined, state: undefined };
  // "Springfield, IL" / "Austin TX"
  const m = loc.match(/^(.+?)[,\s]+([A-Za-z]{2})$/);
  if (m && !/^\d/.test(m[1])) {
    return { city: m[1].trim().slice(0, 200), state: m[2].toUpperCase() };
  }
  // ZIP-only → leave city as the raw location string for tagging
  return { city: loc.slice(0, 200), state: undefined };
}

/**
 * Build 2–3 local-discovery query variants. Tavily has no native geo/biz
 * filter — sharper natural-language queries are the main lever.
 */
function buildTavilyQueries({ category, location, websitePresence }) {
  const raw = String(category || '').trim();
  const cat = (!raw || raw === '*' || /^any$/i.test(raw))
    ? 'local business'
    : raw;
  const loc = String(location || '').trim();
  const wp = String(websitePresence || '').trim().toLowerCase();
  const near = loc ? `${cat} near ${loc}` : `${cat} local businesses`;
  const inLoc = loc ? `${cat} in ${loc}` : cat;
  const queries = [
    `${near} phone address`,
    `${inLoc} (directory OR "top rated" OR "best ${cat}") contact`,
  ];
  if (wp === 'no') {
    queries.push(`${inLoc} ("call today" OR "phone number") (facebook OR yelp OR "yellow pages")`);
  } else if (wp === 'has') {
    queries.push(`${inLoc} official website ("visit our website" OR "contact us") -yelp -facebook`);
  } else {
    queries.push(`list of ${cat} businesses ${loc ? `in ${loc} ` : ''}phone website`.trim());
  }
  // Dedupe while preserving order
  const seen = new Set();
  return queries.filter((q) => {
    const k = q.toLowerCase();
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  }).slice(0, 3);
}

function tavilyResultToLead(r, i, { category, location, query }) {
  const title = String(r.title || '').trim();
  const url = String(r.url || '').trim();
  const content = String(r.content || r.snippet || r.raw_content || '').trim();
  const host = hostFromUrl(url);
  const directory = isDirectoryHost(host);
  const phone = extractPhone(content) || extractPhone(title);
  const email = extractEmail(content);
  const address = extractAddress(content);
  const { city, state } = parseCityState(location);

  let website;
  if (url && !directory && !isNonBusinessPage(url)) {
    website = url;
  } else {
    website = extractWebsiteFromText(content, host) || undefined;
  }

  const businessName = cleanBusinessName(title, url);
  // Skip listicle / directory-search pages — phones on those pages are not one lead.
  if (LISTICLE_TITLE_RE.test(businessName) || LISTICLE_TITLE_RE.test(title)) {
    return null;
  }
  // Yelp/etc. search result URLs (not /biz/ pages) are not single businesses.
  if (directory && /\/search\b/i.test(url)) {
    return null;
  }

  const lead = {
    business_name: businessName,
    category,
    phone,
    email,
    website,
    address,
    city: city || undefined,
    state: state || undefined,
    description: content.slice(0, 2000) || undefined,
    source: 'tavily',
    source_ref: url ? `tavily:${url}` : `tavily:${query}:${i}`,
  };
  for (const k of Object.keys(lead)) {
    if (lead[k] === undefined) delete lead[k];
  }
  return lead;
}

/**
 * TavilySearchProvider — real web-search discovery via Tavily API.
 * Throws PROVIDER_NOT_CONFIGURED until an API key is set in Settings.
 */
class TavilySearchProvider {
  constructor(opts = {}) {
    this.name = 'tavily';
    this.description = 'Tavily web search for local-business discovery';
    this.apiKey = opts.apiKey || null;
    this.searchDepth = opts.searchDepth === 'basic' ? 'basic' : 'advanced';
    this.configured = Boolean(this.apiKey);
  }

  configure(apiKey, opts = {}) {
    this.apiKey = apiKey ? String(apiKey).trim() : null;
    this.configured = Boolean(this.apiKey);
    if (opts.searchDepth != null) {
      const d = String(opts.searchDepth).trim().toLowerCase();
      this.searchDepth = d === 'basic' ? 'basic' : 'advanced';
    }
    return this;
  }

  _requireConfigured() {
    if (!this.configured) {
      throw notConfiguredError('tavily',
        'Set a Tavily API key in Settings → Lead discovery (Tavily). Get a key at https://tavily.com.');
    }
  }

  async _tavilySearchOnce(query, { maxResults, searchDepth }) {
    const body = {
      query,
      search_depth: searchDepth,
      max_results: maxResults,
      topic: 'general',
      include_answer: false,
      include_raw_content: false,
      // Prefer US-local business pages; still returns global when needed.
      country: 'united states',
    };
    if (searchDepth === 'advanced') {
      body.chunks_per_source = 3;
    }
    const res = await fetch('https://api.tavily.com/search', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      throw new Error(`Tavily search failed (${res.status}): ${text.slice(0, 300) || res.statusText}`);
    }
    const data = await res.json();
    return Array.isArray(data.results) ? data.results : [];
  }

  async search(opts = {}) {
    this._requireConfigured();
    const category = String(opts.category || opts.query || 'business').trim() || 'business';
    const location = String(opts.location || '').trim();
    const limit = Math.min(Math.max(parseInt(opts.limit, 10) || 10, 1), 50);
    const wp = String(opts.websitePresence || '').trim().toLowerCase();
    const depthRaw = String(opts.searchDepth || this.searchDepth || 'advanced').trim().toLowerCase();
    const searchDepth = depthRaw === 'basic' ? 'basic' : 'advanced';
    // Fan out 2–3 query variants; Tavily caps max_results at 20 per call.
    const queries = buildTavilyQueries({
      category,
      location,
      websitePresence: wp === 'has' || wp === 'no' ? wp : '',
    });
    const perQuery = Math.min(20, Math.max(8, Math.ceil(limit / queries.length) + 4));

    const batches = await Promise.all(
      queries.map((q) => this._tavilySearchOnce(q, { maxResults: perQuery, searchDepth })
        .then((rows) => ({ query: q, rows }))
        .catch((err) => ({ query: q, rows: [], error: err })))
    );
    const hardErrors = batches.filter((b) => b.error);
    if (hardErrors.length === batches.length) {
      throw hardErrors[0].error;
    }

    const seen = new Set();
    const leads = [];
    for (const batch of batches) {
      batch.rows.forEach((r, i) => {
        const url = String(r.url || '').trim().toLowerCase();
        const host = hostFromUrl(url);
        const key = url || `${String(r.title || '').trim().toLowerCase()}|${i}`;
        if (seen.has(key)) return;
        // Also collapse same-site hits (home vs /plumbing) into one lead.
        if (host && !isDirectoryHost(host) && seen.has(`host:${host}`)) return;
        // Drop very low-relevance hits when Tavily provides a score.
        if (typeof r.score === 'number' && r.score < 0.25) return;
        const lead = tavilyResultToLead(r, i, { category, location, query: batch.query });
        if (!lead) return;
        seen.add(key);
        if (host && !isDirectoryHost(host)) seen.add(`host:${host}`);
        leads.push(lead);
      });
    }

    if (leads.length === 0) {
      const qPreview = queries.map((q) => `"${q}"`).join(', ');
      const errHint = hardErrors.length
        ? ` (${hardErrors.length}/${batches.length} queries failed: ${hardErrors[0].error.message})`
        : '';
      console.warn(
        `[tavily] thin discovery: 0 usable leads from ${batches.reduce((n, b) => n + b.rows.length, 0)} raw results; queries=${qPreview}${errHint}`
      );
    } else if (leads.length < Math.min(limit, 5)) {
      console.warn(
        `[tavily] thin discovery: ${leads.length} leads (wanted ${limit}); depth=${searchDepth}; queries=${queries.length}`
      );
    }

    return leads.slice(0, limit);
  }

  async fetchBusiness(ref) {
    this._requireConfigured();
    const base = typeof ref === 'object' ? ref : { business_name: String(ref) };
    const rows = await this.search({
      query: base.business_name || base.name || 'business',
      category: base.category,
      location: base.city || base.location,
      limit: 1,
    });
    return { ...(rows[0] || {}), ...this.normalize(base), source: 'tavily' };
  }

  async fetchWebsite(url) {
    this._requireConfigured();
    const now = new Date().toISOString();
    if (!url) {
      return {
        reachable: false, hasSsl: false, mobileFriendly: false, hasCta: false,
        hasContactForm: false, hasBooking: false, loadTimeMs: 0,
        outdatedDesign: false, checkedAt: now,
      };
    }
    // Lightweight probe — SSRF-safe (validates each hop + pins resolved IP).
    try {
      const { fetchPublic } = require('../server/urlSafety');
      const t0 = Date.now();
      const res = await fetchPublic(url, { method: 'GET', timeoutMs: 15000, maxRedirects: 5 });
      try { await res.arrayBuffer(); } catch { /* drain */ }
      return {
        reachable: res.ok,
        hasSsl: String(url).startsWith('https'),
        mobileFriendly: true,
        hasCta: false,
        hasContactForm: false,
        hasBooking: false,
        loadTimeMs: Date.now() - t0,
        outdatedDesign: false,
        checkedAt: now,
      };
    } catch {
      return {
        reachable: false, hasSsl: String(url).startsWith('https'), mobileFriendly: false,
        hasCta: false, hasContactForm: false, hasBooking: false, loadTimeMs: 0,
        outdatedDesign: false, checkedAt: now,
      };
    }
  }

  async fetchContactDetails(biz) {
    this._requireConfigured();
    const lead = this.normalize(biz);
    return { phone: lead.phone, email: lead.email, website: lead.website };
  }

  normalize(raw) {
    const lead = normalizeToLead(raw);
    lead.source = 'tavily';
    return lead;
  }
}

/** Provider registry — discovery providers must be configured (API key) before search. */
const registry = {
  csv: new CsvProvider(),
  manual: new ManualProvider(),
  tavily: new TavilySearchProvider(),
};

/** Apply API keys / Tavily options from the app DB (or a plain key bag). */
function configureFromSettings(settingsOrDb) {
  let key = '';
  let searchDepth = 'advanced';
  const read = (k) => {
    if (settingsOrDb && typeof settingsOrDb.prepare === 'function') {
      try {
        const row = settingsOrDb.prepare('SELECT value FROM settings WHERE key = ?').get(k);
        return row && row.value != null ? String(row.value) : '';
      } catch { return ''; }
    }
    if (settingsOrDb && typeof settingsOrDb === 'object') {
      return settingsOrDb[k] != null ? String(settingsOrDb[k]) : '';
    }
    return '';
  };
  key = read('providers.tavily.api_key');
  const depthRaw = read('providers.tavily.search_depth').trim().toLowerCase();
  if (depthRaw === 'basic' || depthRaw === 'advanced') searchDepth = depthRaw;
  if (registry.tavily && typeof registry.tavily.configure === 'function') {
    registry.tavily.configure(key && key !== '***' ? key : '', { searchDepth });
  }
  return listProviders();
}

function getProvider(name) {
  return registry[name] || null;
}

function listProviders() {
  return Object.values(registry).map(p => ({
    name: p.name,
    description: p.description,
    configured: Boolean(p.configured),
  }));
}

/** Extension point: other workstreams can register providers without edits here. */
function registerProvider(provider) {
  if (!provider || !provider.name) throw new Error('registerProvider: provider must have a name');
  registry[provider.name] = provider;
  return provider;
}

module.exports = {
  normalizeToLead,
  notConfiguredError,
  CsvProvider,
  ManualProvider,
  TavilySearchProvider,
  buildTavilyQueries,
  getProvider,
  listProviders,
  registerProvider,
  configureFromSettings,
};
