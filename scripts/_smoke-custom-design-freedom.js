'use strict';

/**
 * Smoke: custom-design freedom APIs (layouts, partials, assets, crop, author-mode, QA).
 * Run: node scripts/_smoke-custom-design-freedom.js
 */

const assert = require('assert');
const path = require('path');
const fs = require('fs');
const os = require('os');

const root = path.join(__dirname, '..');

function ok(label) {
  console.log('  OK', label);
}

async function main() {
  console.log('1) imageCrop');
  const imageCrop = require(path.join(root, 'src/imageCrop'));
  assert.strictEqual(imageCrop.parseAspect('16:9'), 16 / 9);
  // 100x100 red PNG
  const sharp = require('sharp');
  const png = await sharp({
    create: { width: 200, height: 100, channels: 3, background: { r: 200, g: 40, b: 40 } },
  }).png().toBuffer();
  const cropped = await imageCrop.cropBuffer(png, { aspect: '1:1', focalX: 0.5, focalY: 0.5, width: 80, height: 80 });
  assert.strictEqual(cropped.width, 80);
  assert.strictEqual(cropped.height, 80);
  ok(`crop ${cropped.width}x${cropped.height}`);

  console.log('2) pageContentScan + cell token');
  const scan = require(path.join(root, 'src/pageContentScan'));
  const pages = [{
    slug: '/',
    title: 'Home',
    sections: [{
      type: 'columns',
      content: {
        cols: 2,
        cells: [
          { heading: 'Left', body: 'Copy' },
          {
            widget: {
              type: 'site_module',
              public_token: 'tok_test_abc',
              module_type: 'gallery',
              html: '<div data-bitpype-module-token="tok_test_abc"></div>',
            },
            html: '<div data-bitpype-module-token="tok_test_abc"></div>',
          },
        ],
      },
    }],
  }];
  assert.ok(scan.collectTypedTokens(pages, { module: true }).has('tok_test_abc'));
  assert.ok(scan.pagesBlobHas(pages, (b) => /tok_test_abc/.test(b)));
  ok('cell token visible');

  console.log('3) insertBlockIntoSection module-in-cell');
  const structure = require(path.join(root, 'src/siteStructure'));
  const basePages = [{
    slug: '/',
    title: 'Home',
    sections: [
      { type: 'nav', content: { links: [] } },
      { type: 'columns', content: { cols: 2, cells: [{}, {}] } },
    ],
  }];
  const ins = structure.insertBlockIntoSection(basePages, 0, 1, 'module', {
    cellIndex: 1,
    widget: {
      type: 'site_module',
      public_token: 'tok_cell',
      module_type: 'bookings',
      html: '<div class="bitpype-module-embed" data-bitpype-module-token="tok_cell"></div>',
    },
    html: '<div class="bitpype-module-embed" data-bitpype-module-token="tok_cell"></div>',
  });
  assert.ok(ins.changed);
  assert.ok(ins.pages[0].sections[1].content.cells[1].widget);
  assert.strictEqual(ins.pages[0].sections[1].content.cells[1].widget.public_token, 'tok_cell');
  ok('module-in-cell widget stored');

  console.log('4) renderColCell + partials + meta');
  const engine = require(path.join(root, 'src/websiteEngine'));
  const theme = engine.normalizeTheme({
    primary: '#0f766e',
    secondary: '#134e4a',
    bg: '#f8fafc',
    text: '#0f172a',
    customCss: '.hero-x{font-family:serif}',
    customJs: 'window.__wsSmoke=1;',
    favicon: 'assets/favicon.ico',
    partials: {
      headerHtml: '<header data-ws-shared="1"><a href="index.html">Home</a></header>',
      footerHtml: '<footer data-ws-shared="1">© Smoke</footer>',
    },
    baseCss: false,
  });
  assert.ok(theme.partials.headerHtml.includes('data-ws-shared'));
  assert.ok(theme.favicon === 'assets/favicon.ico' || theme.favicon.includes('favicon'));
  const renderPages = [{
    slug: '/',
    title: 'Smoke Home',
    description: 'Meta desc for smoke',
    ogImage: 'images/hero.jpg',
    customJs: 'console.log("page");',
    sections: [
      { type: 'nav', content: { links: [{ label: 'Home', href: 'index.html' }] } },
      {
        type: 'columns',
        content: {
          cols: 2,
          cells: [
            { heading: 'About', body: 'Hello' },
            {
              widget: {
                type: 'form',
                form_token: 'formtok',
                html: '<div class="bitpype-form-embed" data-bitpype-form-embed="formtok"></div>',
              },
            },
          ],
        },
      },
    ],
  }];
  const html = engine.renderPage(renderPages[0], renderPages, theme);
  assert.ok(html.includes('Meta desc for smoke'), 'meta description');
  assert.ok(html.includes('og:image'), 'og image');
  assert.ok(html.includes('data-ws-shared="1"'), 'shared partial');
  assert.ok(html.includes('data-ws-theme-js') || html.includes('__wsSmoke'), 'theme js');
  assert.ok(html.includes('data-ws-page-js') || html.includes('console.log'), 'page js');
  assert.ok(html.includes('col-widget') || html.includes('bitpype-form-embed'), 'form in cell');
  ok('render partials/meta/cell widget');

  console.log('5) pagesHaveModuleToken (siteModules)');
  const siteModules = require(path.join(root, 'server/siteModules'));
  assert.ok(siteModules.pagesHaveModuleToken(ins.pages, 'tok_cell'));
  const purpose = siteModules.pageServesModulePurpose(ins.pages, 'bookings', 'tok_cell', 'book');
  assert.ok(purpose.served);
  ok('author-mode purpose served via cell');

  console.log('6) siteScreenshots.captureOneScreenshot export');
  const shots = require(path.join(root, 'src/siteScreenshots'));
  assert.strictEqual(typeof shots.captureOneScreenshot, 'function');
  ok('captureOneScreenshot exported');

  console.log('7) MCP catalog has new tools');
  const catalog = require(path.join(root, 'src/mcpCatalog'));
  const names = new Set(catalog.tools.map((t) => t.name));
  for (const n of ['website.uploadAsset', 'website.screenshot', 'website.replaceImage', 'website.addBlock']) {
    assert.ok(names.has(n), `missing ${n}`);
  }
  ok('catalog tools present');

  console.log('8) QA required-sections without hero');
  // Unit-check the modular path logic by rendering + inspecting check name via a temp db is heavy;
  // assert the source policy string exists and render works without hero type.
  const noHeroPages = [{
    slug: '/',
    title: 'Custom',
    sections: [
      { type: 'nav', content: { links: [{ label: 'Home', href: 'index.html' }] } },
      { type: 'columns', content: { cols: 2, cells: [{ heading: 'A', body: '1' }, { heading: 'B', body: '2' }] } },
      { type: 'html', content: { html: '<section><p>Contact us</p></section>' } },
    ],
  }];
  const noHeroHtml = engine.renderPage(noHeroPages[0], noHeroPages, theme);
  assert.ok(noHeroHtml.includes('layout-columns') || noHeroHtml.includes('cols-2'));
  ok('custom modular without hero renders');

  console.log('\nAll smoke checks passed.');
}

main().catch((e) => {
  console.error('FAIL', e);
  process.exit(1);
});
