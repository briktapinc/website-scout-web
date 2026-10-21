'use strict';

/**
 * Offline smoke test for site modules schema + CRUD + embed sync + bookings slots.
 * Usage: node scripts/_smoke-site-modules.js
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const Database = require('better-sqlite3');

const modules = require('../server/siteModules');
const { getPlan } = require('../server/plans');

function assert(cond, msg) {
  if (!cond) throw new Error(msg || 'assertion failed');
}

const free = getPlan('free');
const standard = getPlan('standard');
const premium = getPlan('premium');
assert(!free.entitlements.siteModules, 'free must not have siteModules');
assert(standard.entitlements.siteModules, 'standard must have siteModules');
assert(premium.entitlements.siteModules, 'premium must have siteModules');

const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ws-modules-'));
const dbPath = path.join(dir, 'test.db');
const db = new Database(dbPath);
db.pragma('foreign_keys = ON');

// Minimal website schema for sync
db.exec(`
  CREATE TABLE leads (id INTEGER PRIMARY KEY, business_name TEXT);
  CREATE TABLE websites (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    lead_id INTEGER,
    pages TEXT,
    updated_at TEXT DEFAULT (datetime('now'))
  );
`);
db.prepare('INSERT INTO leads (id, business_name) VALUES (1, ?)').run('Test Co');
db.prepare(`INSERT INTO websites (lead_id, pages) VALUES (1, ?)`).run(JSON.stringify([
  { slug: 'home', title: 'Home', html: '<main><h1>Home</h1></main>', sections: [] },
]));

modules.ensureTables(db);

const post = modules.createBlogPost(db, 1, {
  title: 'Hello World',
  body_html: '<p>Hi</p>',
  status: 'published',
});
assert(post.slug === 'hello-world', 'slug');
assert(modules.listBlogPosts(db, 1).length === 1, 'blog list');

const product = modules.createProduct(db, 1, {
  name: 'Widget',
  price: 19.99,
  checkout_url: 'https://buy.stripe.com/test',
  status: 'published',
});
assert(product.price_cents === 1999, 'price cents');

const course = modules.createCourse(db, 1, {
  title: 'Intro',
  status: 'published',
  lessons: [{ title: 'Lesson 1', body_html: '<p>One</p>' }],
});
assert(course.lessons.length === 1, 'lessons');

const album = modules.createAlbum(db, 1, {
  title: 'Photos',
  status: 'published',
  images: [{ image_url: 'https://example.com/a.jpg', caption: 'A' }],
});
assert(album.images.length === 1, 'images');

const listing = modules.createListing(db, 1, {
  name: 'Acme',
  category: 'Services',
  status: 'published',
});
assert(listing.name === 'Acme', 'listing');

const faq = modules.createFaqItem(db, 1, {
  question: 'Do you offer evenings?',
  answer_html: '<p>Yes on request.</p>',
  status: 'published',
});
assert(faq.question.includes('evenings'), 'faq');

const testimonial = modules.createTestimonial(db, 1, {
  quote: 'Fantastic work.',
  author_name: 'Sam',
  rating: 5,
  status: 'published',
});
assert(testimonial.rating === 5, 'testimonial');

const member = modules.createTeamMember(db, 1, {
  name: 'Alex Rivera',
  role_title: 'Owner',
  status: 'published',
});
assert(member.slug === 'alex-rivera', 'team slug');

const event = modules.createEvent(db, 1, {
  title: 'Open House',
  starts_at: '2099-06-01',
  status: 'published',
});
assert(event.title === 'Open House', 'event');

const service = modules.createBookingService(db, 1, {
  name: 'Consultation',
  duration_minutes: 30,
  status: 'published',
});
assert(service.duration_minutes === 30, 'booking service');
modules.setBookingHours(db, 1, [
  { weekday: 1, start_time: '09:00', end_time: '12:00' },
  { weekday: 2, start_time: '09:00', end_time: '17:00' },
  { weekday: 3, start_time: '09:00', end_time: '17:00' },
  { weekday: 4, start_time: '09:00', end_time: '17:00' },
  { weekday: 5, start_time: '09:00', end_time: '17:00' },
]);
modules.updateBookingSettings(db, 1, { min_notice_hours: 0, max_days_ahead: 30, auto_confirm: false });

// Next Monday from a fixed reference so the smoke is deterministic-ish
function nextWeekday(from, weekday) {
  const d = new Date(from.getFullYear(), from.getMonth(), from.getDate());
  const delta = (weekday - d.getDay() + 7) % 7 || 7;
  d.setDate(d.getDate() + delta);
  return d;
}
const monday = nextWeekday(new Date(), 1);
const ymd = `${monday.getFullYear()}-${String(monday.getMonth() + 1).padStart(2, '0')}-${String(monday.getDate()).padStart(2, '0')}`;
const slots = modules.listAvailableSlots(db, 1, { date: ymd, serviceId: service.id });
assert(slots.slots.length > 0, 'slots generated');
const booked = modules.createPublicBooking(db, 1, {
  service_id: service.id,
  starts_at: slots.slots[0].starts_at,
  customer_name: 'Pat Client',
  customer_email: 'pat@example.com',
});
assert(booked.status === 'pending', 'booking pending');
const slots2 = modules.listAvailableSlots(db, 1, { date: ymd, serviceId: service.id });
assert(!slots2.slots.some((s) => s.starts_at === slots.slots[0].starts_at), 'slot consumed');

const attached = modules.attachModule(db, 1, 'blog', {
  workspaceId: 42,
  target_page_slug: 'blog',
  appUrl: 'https://example.com',
});
assert(attached.embed.public_token.startsWith('42_'), 'token');
assert(attached.sync.synced, 'sync');

const site = db.prepare('SELECT pages FROM websites WHERE lead_id = 1').get();
const pages = JSON.parse(site.pages);
assert(pages.some((p) => String(p.html || '').includes('data-bitpype-module-token')), 'js mount injected');
assert(pages.some((p) => String(p.html || '').includes('/js/module-embed.js')), 'module embed script injected');
assert(pages.some((p) => p.slug === 'blog'), 'blog page created');

const pub = modules.getPublicModuleByToken(db, attached.embed.public_token);
assert(pub.items.length === 1, 'public items');
assert(pub.module_type === 'blog', 'public type');

const item = modules.getPublicModuleItem(db, attached.embed.public_token, post.slug);
assert(item.item.title === 'Hello World', 'public item');

// Attach remaining module types
for (const t of ['ecommerce', 'courses', 'gallery', 'directory', 'faq', 'testimonials', 'team', 'events', 'bookings']) {
  const r = modules.attachModule(db, 1, t, { workspaceId: 42, appUrl: 'https://example.com' });
  assert(r.embed.module_type === t, `attach ${t}`);
}

const bookingEmbed = modules.getEmbedRow(db, 1, 'bookings');
const pubBook = modules.getPublicModuleByToken(db, bookingEmbed.public_token);
assert(pubBook.booking && pubBook.booking.settings, 'booking settings on public payload');
assert(pubBook.items.length === 1, 'public booking services');

const summary = modules.portalSummary(db, 1, { siteModules: true, appUrl: 'https://example.com' });
assert(summary.modules.length === 10, 'ten modules');
assert(summary.modules.every((m) => m.count >= 1), 'counts');

db.close();
fs.rmSync(dir, { recursive: true, force: true });
console.log('OK site-modules smoke');
