'use strict';

/**
 * Acceptance tests for css-present-and-applied + images registry + reviewJob export.
 * Run: node scripts/_test-css-qa-guard.js
 */

const engine = require('../src/websiteEngine');
const designReview = require('../src/designReview');
const designJobs = require('../src/designJobs');

let failed = 0;
function ok(cond, msg) {
  if (!cond) {
    console.error('FAIL:', msg);
    failed += 1;
    return false;
  }
  console.log('OK:', msg);
  return true;
}

// --- CSS helper: broken class-heavy, no CSS ---
const brokenPages = [{
  slug: 'home',
  title: 'Home',
  html: `<main class="hero wrap">
    <h1 class="hero-title">Hello</h1>
    <p class="lede copy">We fix things.</p>
    <a class="btn btn-primary cta" href="tel:555">Call</a>
    <section class="services grid">
      <article class="card card-a"><h2 class="card-title">A</h2></article>
      <article class="card card-b"><h2 class="card-title">B</h2></article>
    </section>
  </main>`,
}];
const brokenTheme = {
  baseCss: false,
  customCss: '/* agent forgot the real stylesheet */',
};

const failResult = engine.validatePagesCss(brokenPages, brokenTheme);
ok(!failResult.ok, 'broken payload fails css-present-and-applied');
ok(failResult.check.name === 'css-present-and-applied', 'check name is css-present-and-applied');
ok(/home/i.test(failResult.check.detail), 'failure detail names page slug');
ok(/hero|wrap|btn/i.test(failResult.check.detail), 'failure detail names class samples');

let threw = false;
try {
  engine.assertPagesCss(brokenPages, brokenTheme);
} catch (e) {
  threw = e.code === 'INVALID_CSS';
}
ok(threw, 'assertPagesCss throws INVALID_CSS');

// Long CSS that does not define the markup classes → >10% undefined
const longUnusedCss = `${'/* pad */ body{margin:0}'.repeat(40)}\n.unused-only{color:red}`;
const mismatch = engine.validatePagesCss(brokenPages, { baseCss: false, customCss: longUnusedCss });
ok(!mismatch.ok, 'long CSS without matching selectors fails');
ok(/not defined|undefined/i.test(mismatch.check.detail), 'mismatch detail mentions undefined classes');

// --- Good payload: inline <style> defining used classes ---
const goodCss = `
.hero{padding:48px 24px;background:#0f172a;color:#fff}
.wrap{max-width:960px;margin:0 auto}
.hero-title{font-size:2.4rem;margin:0 0 12px}
.lede,.copy{opacity:.9;line-height:1.5}
.btn{display:inline-block;padding:12px 20px;border-radius:8px;text-decoration:none;font-weight:700}
.btn-primary,.cta{background:#38bdf8;color:#0f172a}
.services,.grid{display:grid;grid-template-columns:1fr 1fr;gap:16px;margin-top:32px}
.card,.card-a,.card-b{background:#fff;color:#0f172a;padding:20px;border-radius:12px}
.card-title{margin:0;font-size:1.2rem}
`.repeat(2);

const goodPages = [{
  slug: 'home',
  title: 'Home',
  html: `<!DOCTYPE html><html><head><style>${goodCss}</style></head><body>
<main class="hero wrap">
  <h1 class="hero-title">Hello</h1>
  <p class="lede copy">We fix things.</p>
  <a class="btn btn-primary cta" href="tel:555">Call</a>
  <section class="services grid">
    <article class="card card-a"><h2 class="card-title">A</h2></article>
    <article class="card card-b"><h2 class="card-title">B</h2></article>
  </section>
</main></body></html>`,
}];
ok(engine.validatePagesCss(goodPages, { baseCss: false, customCss: '' }).ok,
  'inline style defining classes passes CSS check');

const goodPagesBody = [{
  slug: '/',
  title: 'Home',
  html: brokenPages[0].html,
}];
ok(engine.validatePagesCss(goodPagesBody, { baseCss: false, customCss: goodCss }).ok,
  'theme.customCss defining classes passes');

// Section-only template pages (no freeform html) skip CSS class check
const sectionPages = [{
  slug: '/',
  title: 'Home',
  sections: [
    { type: 'nav', content: { business_name: 'Acme' } },
    { type: 'hero', content: { heading: 'Hi', subheading: 'There', cta_label: 'Call', cta_href: 'tel:1' } },
  ],
}];
ok(engine.validatePagesCss(sectionPages, {}).ok, 'section-only pages pass CSS check');

// Modular html sections with class-heavy markup need theme.customCss (same as freeform)
const modularBroken = [{
  slug: 'home',
  title: 'Home',
  sections: [
    { type: 'nav', content: { business_name: 'Acme' } },
    {
      type: 'html',
      content: {
        html: `<section class="hero wrap"><h1 class="hero-title">Hi</h1><p class="lede copy">Body</p><a class="btn btn-primary cta" href="#">Go</a></section>`,
      },
    },
  ],
}];
ok(!engine.validatePagesCss(modularBroken, { baseCss: false, customCss: '/* empty */' }).ok,
  'modular html sections without CSS fail');
ok(engine.validatePagesCss(modularBroken, { baseCss: false, customCss: goodCss }).ok,
  'modular html sections with theme.customCss pass');

// --- Registered relative images ---
const registry = new Set(['images/openai-1.png', 'images/hero.jpg']);
ok(engine._isRegisteredImageSrc('images/openai-1.png', registry), 'registered images/ url accepted');
ok(engine._isRegisteredImageSrc('./images/hero.jpg', registry), './images/ relative accepted');
ok(!engine._isRegisteredImageSrc('http://evil.test/x.jpg', registry), 'non-https external not registered');

{
  const src = 'images/openai-1.png';
  const isReg = engine._isRegisteredImageSrc(src, registry);
  const isPlaceholder = /(?:via\.placeholder|picsum\.photos)/i.test(src);
  const wouldFail = !isReg && (isPlaceholder || !src.startsWith('https://'));
  ok(!wouldFail, 'registered local image would pass images-are-placeholders');
}

// --- design.review export wiring ---
ok(typeof designReview.reviewDesignJob === 'function', 'reviewDesignJob exported');
ok(typeof designReview.reviewJob === 'function', 'reviewJob alias exported');
ok(designReview.reviewJob === designReview.reviewDesignJob, 'reviewJob aliases reviewDesignJob');
ok(typeof designJobs.reviewJob === 'function', 'designJobs.reviewJob exported');

if (failed) {
  console.error(`\n${failed} CSS QA guard test(s) failed.`);
  process.exit(1);
}
console.log('\nAll CSS QA guard tests passed.');
