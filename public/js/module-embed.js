/**
 * In-page BitPype site modules (blog, shop, courses, gallery, directory,
 * faq, testimonials, team, events, bookings).
 * Mounts on [data-bitpype-module][data-bitpype-module-token] and fetches
 * /api/v1/modules/public/:token from data-bitpype-api (or same origin).
 * Bookings also uses /slots and POST /book for calendar + time management.
 */
(function () {
  'use strict';

  if (window.BitpypeModules && window.BitpypeModules.__booted) return;

  var STYLE_ID = 'bitpype-module-embed-css';
  var ITEM_PARAM = 'bpItem';
  var TOKEN_ATTR = 'data-bitpype-module-token';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      'main.bp-mod-main, .bp-mod-main{',
      'max-width:1100px;width:100%;margin-left:auto;margin-right:auto;',
      'padding:clamp(1.75rem,4vw,3.25rem) clamp(1.1rem,3.5vw,2rem) clamp(3.5rem,8vw,5.5rem);',
      'box-sizing:border-box;',
      '}',
      'main.bp-mod-main > .bp-mod-page-title,',
      '.bp-mod-page-title{',
      'margin:0 0 0.2em;letter-spacing:-0.03em;line-height:1.08;',
      'font-size:clamp(2rem,4.5vw,3rem);',
      '}',
      '.bitpype-module-embed{',
      '--bp-mod-ink:var(--ws-text,var(--ink,currentColor));',
      '--bp-mod-muted:var(--ws-muted,var(--muted,color-mix(in srgb,var(--bp-mod-ink) 58%,transparent)));',
      '--bp-mod-line:var(--ws-line,var(--line,color-mix(in srgb,var(--bp-mod-ink) 14%,transparent)));',
      '--bp-mod-accent:var(--ws-primary,var(--accent,#0e7a68));',
      '--bp-mod-secondary:var(--ws-secondary,var(--secondary,var(--bp-mod-ink)));',
      '--bp-mod-paper:var(--ws-bg,var(--paper,#fff));',
      'color:var(--bp-mod-ink);font:inherit;line-height:1.55;width:100%;margin:1.25rem 0 0;',
      '}',
      '.bitpype-module-embed.bitpype-module-standalone{',
      'max-width:920px;margin:0 auto;padding:22px 16px 32px;',
      '}',
      '.bitpype-module-embed .bp-mod-lede{',
      'margin:0 0 1.35rem;max-width:42ch;color:var(--bp-mod-muted);font-size:1.05rem;',
      '}',
      '.bitpype-module-embed .bp-mod-grid{',
      'display:grid;grid-template-columns:repeat(auto-fill,minmax(260px,1fr));gap:1.25rem;',
      '}',
      '.bitpype-module-embed .bp-mod-card{',
      'display:flex;flex-direction:column;border:1px solid var(--bp-mod-line);',
      'border-radius:1.25rem;overflow:hidden;',
      'background:color-mix(in srgb,var(--bp-mod-paper) 94%,var(--bp-mod-ink));',
      'box-shadow:0 16px 40px color-mix(in srgb,var(--bp-mod-ink) 8%,transparent);',
      'transition:transform .18s ease,box-shadow .18s ease;',
      '}',
      '.bitpype-module-embed .bp-mod-card:hover{',
      'transform:translateY(-2px);',
      'box-shadow:0 22px 48px color-mix(in srgb,var(--bp-mod-ink) 12%,transparent);',
      '}',
      '.bitpype-module-embed .bp-mod-cover{',
      'display:block;aspect-ratio:16/10;background:linear-gradient(145deg,var(--bp-mod-secondary),var(--bp-mod-accent)) center/cover no-repeat;',
      'text-decoration:none;position:relative;',
      '}',
      '.bitpype-module-embed .bp-mod-cover-fallback{',
      'display:grid;place-items:center;color:#fff;font-weight:800;font-size:1.6rem;letter-spacing:-0.03em;',
      '}',
      '.bitpype-module-embed .bp-mod-body{padding:1rem 1.1rem 1.2rem;flex:1;display:flex;flex-direction:column;gap:0.5rem;}',
      '.bitpype-module-embed .bp-mod-card h2{',
      'font-size:1.2rem;margin:0;line-height:1.2;letter-spacing:-0.02em;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-card h2 a{color:inherit;text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-card h2 a:hover{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-meta{color:var(--bp-mod-muted);font-size:0.9rem;margin:0;}',
      '.bitpype-module-embed .bp-mod-excerpt{margin:0;font-size:0.95rem;flex:1;color:var(--bp-mod-muted);line-height:1.45;}',
      '.bitpype-module-embed .bp-mod-view-all{margin:1.25rem 0 0;}',
      '.bitpype-module-embed .bp-mod-view-all a{font-weight:700;color:var(--bp-mod-accent);text-decoration:none;}',
      '.bitpype-module-embed .bp-mod-desc{margin:0;font-size:0.95rem;flex:1;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-price{font-weight:700;color:var(--bp-mod-accent);margin:0;}',
      '.bitpype-module-embed .bp-mod-btn{',
      'appearance:none;border:0;border-radius:999px;background:var(--bp-mod-accent);color:#fff;',
      'font:inherit;font-weight:700;padding:0.6rem 1.1rem;cursor:pointer;text-decoration:none;',
      'display:inline-flex;align-items:center;justify-content:center;margin-top:0.35rem;align-self:flex-start;',
      '}',
      '.bitpype-module-embed .bp-mod-btn:hover{filter:brightness(1.05);}',
      '.bitpype-module-embed .bp-mod-btn.ghost{',
      'background:transparent;color:var(--bp-mod-ink);border:1.5px solid var(--bp-mod-line);',
      '}',
      '.bitpype-module-embed .bp-mod-back{',
      'display:inline-flex;align-items:center;gap:0.35rem;margin:0 0 1rem;',
      'color:var(--bp-mod-accent);font-weight:700;text-decoration:none;',
      '}',
      '.bitpype-module-embed .bp-mod-detail{',
      'border:1px solid var(--bp-mod-line);border-radius:1.4rem;padding:clamp(1.2rem,3vw,1.8rem);',
      'background:color-mix(in srgb,var(--bp-mod-paper) 96%,var(--bp-mod-ink));',
      'box-shadow:0 18px 44px color-mix(in srgb,var(--bp-mod-ink) 8%,transparent);',
      '}',
      '.bitpype-module-embed .bp-mod-detail .bp-mod-hero{',
      'width:100%;max-height:380px;object-fit:cover;border-radius:1rem;margin:0 0 1.2rem;display:block;',
      '}',
      '.bitpype-module-embed .bp-mod-detail h1{',
      'font-size:clamp(1.7rem,3.2vw,2.4rem);margin:0 0 0.45rem;letter-spacing:-0.03em;line-height:1.1;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-content{line-height:1.7;margin-top:1rem;}',
      '.bitpype-module-embed .bp-mod-content img{max-width:100%;height:auto;border-radius:0.75rem;}',
      '.bitpype-module-embed .bp-mod-lessons{list-style:none;padding:0;margin:1.1rem 0 0;}',
      '.bitpype-module-embed .bp-mod-lessons li{border-top:1px solid var(--bp-mod-line);padding:0.85rem 0;}',
      '.bitpype-module-embed .bp-mod-lessons li:first-child{border-top:0;}',
      '.bitpype-module-embed .bp-mod-gallery{',
      'display:grid;grid-template-columns:repeat(auto-fill,minmax(160px,1fr));gap:0.75rem;margin-top:0.75rem;',
      '}',
      '.bitpype-module-embed .bp-mod-gallery a{',
      'display:block;aspect-ratio:1;background:#ddd6cb center/cover no-repeat;border-radius:0.85rem;overflow:hidden;',
      '}',
      '.bitpype-module-embed .bp-mod-empty-card{',
      'display:grid;gap:0.65rem;justify-items:start;',
      'padding:clamp(1.4rem,3vw,2rem);border-radius:1.4rem;',
      'border:1px solid var(--bp-mod-line);',
      'background:',
      'linear-gradient(135deg,color-mix(in srgb,var(--bp-mod-accent) 12%,var(--bp-mod-paper)),var(--bp-mod-paper) 55%),',
      'var(--bp-mod-paper);',
      'box-shadow:0 18px 44px color-mix(in srgb,var(--bp-mod-ink) 7%,transparent);',
      '}',
      '.bitpype-module-embed .bp-mod-empty-kicker{',
      'margin:0;font-size:0.75rem;font-weight:800;letter-spacing:0.08em;text-transform:uppercase;',
      'color:var(--bp-mod-accent);',
      '}',
      '.bitpype-module-embed .bp-mod-empty-title{',
      'margin:0;font-size:1.35rem;letter-spacing:-0.02em;line-height:1.2;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-empty-text{margin:0;color:var(--bp-mod-muted);max-width:36ch;}',
      '.bitpype-module-embed .bp-mod-err,.bitpype-module-embed .bp-mod-loading{',
      'color:var(--bp-mod-muted);margin:0;padding:0.5rem 0;',
      '}',
      '.bitpype-module-embed .bp-mod-err{color:#9b2c2c;}',
      '.bitpype-module-embed .bp-mod-title{',
      'font-size:clamp(1.5rem,2.6vw,2rem);margin:0 0 1rem;letter-spacing:-0.03em;line-height:1.1;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-module-embed .bp-mod-faq{display:grid;gap:0.65rem;}',
      '.bitpype-module-embed .bp-mod-faq details{',
      'border:1px solid var(--bp-mod-line);border-radius:1rem;padding:0.85rem 1rem;',
      'background:color-mix(in srgb,var(--bp-mod-paper) 96%,var(--bp-mod-ink));',
      '}',
      '.bitpype-module-embed .bp-mod-faq summary{',
      'cursor:pointer;font-weight:700;letter-spacing:-0.01em;list-style:none;',
      '}',
      '.bitpype-module-embed .bp-mod-faq summary::-webkit-details-marker{display:none;}',
      '.bitpype-module-embed .bp-mod-faq .bp-mod-content{margin-top:0.65rem;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-quote{',
      'margin:0;font-size:1.05rem;line-height:1.55;letter-spacing:-0.01em;',
      '}',
      '.bitpype-module-embed .bp-mod-stars{color:var(--bp-mod-accent);letter-spacing:0.08em;font-size:0.95rem;}',
      '.bitpype-module-embed .bp-mod-book{',
      'display:grid;gap:1.1rem;max-width:640px;',
      '}',
      '.bitpype-module-embed .bp-mod-book-row{display:grid;gap:0.45rem;}',
      '.bitpype-module-embed .bp-mod-book label{font-weight:700;font-size:0.92rem;}',
      '.bitpype-module-embed .bp-mod-book input,',
      '.bitpype-module-embed .bp-mod-book select,',
      '.bitpype-module-embed .bp-mod-book textarea{',
      'width:100%;box-sizing:border-box;border:1px solid var(--bp-mod-line);border-radius:0.85rem;',
      'padding:0.7rem 0.85rem;font:inherit;background:var(--bp-mod-paper);color:var(--bp-mod-ink);',
      '}',
      '.bitpype-module-embed .bp-mod-slots{',
      'display:flex;flex-wrap:wrap;gap:0.5rem;',
      '}',
      '.bitpype-module-embed .bp-mod-slot{',
      'appearance:none;border:1.5px solid var(--bp-mod-line);border-radius:999px;',
      'background:transparent;color:var(--bp-mod-ink);font:inherit;font-weight:700;',
      'padding:0.45rem 0.85rem;cursor:pointer;',
      '}',
      '.bitpype-module-embed .bp-mod-slot.is-selected,',
      '.bitpype-module-embed .bp-mod-slot:hover{',
      'border-color:var(--bp-mod-accent);color:var(--bp-mod-accent);',
      '}',
      '.bitpype-module-embed .bp-mod-book-msg{margin:0;color:var(--bp-mod-muted);}',
      '.bitpype-module-embed .bp-mod-book-msg.ok{color:var(--bp-mod-accent);}',
      '.bitpype-module-embed .bp-mod-book-msg.err{color:#9b2c2c;}',
      '.bitpype-module-embed .bp-mod-captcha{margin:0.35rem 0 0.65rem;}',
      '.bitpype-module-embed .bp-mod-captcha iframe{display:block;}',
      '@media (prefers-reduced-motion:reduce){',
      '.bitpype-module-embed .bp-mod-card{transition:none;}',
      '.bitpype-module-embed .bp-mod-card:hover{transform:none;}',
      '}',
    ].join('');
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
  }

  function polishHost(el) {
    var main = el.closest('main');
    if (main) main.classList.add('bp-mod-main');
    var prev = el.previousElementSibling;
    if (prev && /^H[1-3]$/.test(prev.tagName)) prev.classList.add('bp-mod-page-title');
  }

  function emptyCopy(type) {
    if (type === 'blog') {
      return {
        kicker: 'Blog',
        title: 'Posts are on the way',
        text: 'New articles will show up here as soon as they are published.',
      };
    }
    if (type === 'ecommerce') {
      return { kicker: 'Shop', title: 'No products yet', text: 'Products will appear here once they are published.' };
    }
    if (type === 'courses') {
      return { kicker: 'Courses', title: 'No courses yet', text: 'Published courses will show up in this space.' };
    }
    if (type === 'gallery') {
      return { kicker: 'Gallery', title: 'No albums yet', text: 'Photo albums will appear here when published.' };
    }
    if (type === 'directory') {
      return { kicker: 'Directory', title: 'No listings yet', text: 'Directory listings will show up here when published.' };
    }
    if (type === 'faq') {
      return { kicker: 'FAQ', title: 'No questions yet', text: 'Published FAQs will appear here.' };
    }
    if (type === 'testimonials') {
      return { kicker: 'Testimonials', title: 'No reviews yet', text: 'Customer testimonials will show up here when published.' };
    }
    if (type === 'team') {
      return { kicker: 'Team', title: 'No team members yet', text: 'Team profiles will appear here when published.' };
    }
    if (type === 'events') {
      return { kicker: 'Events', title: 'No events yet', text: 'Upcoming events will show up here when published.' };
    }
    if (type === 'bookings') {
      return { kicker: 'Bookings', title: 'No services yet', text: 'Publish a bookable service to open the appointment calendar.' };
    }
    return { kicker: 'Module', title: 'Nothing published yet', text: 'Published items will appear here.' };
  }

  function starsHtml(n) {
    var r = Math.max(0, Math.min(5, Math.round(Number(n) || 0)));
    if (!r) return '';
    return '<p class="bp-mod-stars" aria-label="' + r + ' of 5">' + '★'.repeat(r) + '☆'.repeat(5 - r) + '</p>';
  }

  function todayYmd() {
    var d = new Date();
    return d.getFullYear() + '-' + String(d.getMonth() + 1).padStart(2, '0') + '-' + String(d.getDate()).padStart(2, '0');
  }

  function renderEmpty(type) {
    var copy = emptyCopy(type);
    return (
      '<div class="bp-mod-empty-card">'
      + '<p class="bp-mod-empty-kicker">' + esc(copy.kicker) + '</p>'
      + '<p class="bp-mod-empty-title">' + esc(copy.title) + '</p>'
      + '<p class="bp-mod-empty-text">' + esc(copy.text) + '</p>'
      + '</div>'
    );
  }

  function coverHtml(href, imageUrl, label) {
    if (imageUrl) {
      return '<a class="bp-mod-cover" href="' + esc(href) + '" style="background-image:url(\'' + esc(imageUrl) + '\')"></a>';
    }
    var letter = String(label || '?').trim().charAt(0).toUpperCase() || '?';
    return '<a class="bp-mod-cover bp-mod-cover-fallback" href="' + esc(href) + '" aria-hidden="true">' + esc(letter) + '</a>';
  }

  function apiBase(el) {
    var raw = el.getAttribute('data-bitpype-api') || '';
    if (raw) return String(raw).replace(/\/$/, '');
    try {
      var src = document.querySelector('script[data-bitpype-module-script],script[src*="module-embed.js"]');
      if (src && src.src) return new URL(src.src).origin;
    } catch (e) { /* ignore */ }
    return '';
  }

  function loadScript(src) {
    return new Promise(function (resolve, reject) {
      var existing = document.querySelector('script[src="' + src + '"]');
      if (existing) {
        if (window.ScoutCaptcha) resolve();
        else existing.addEventListener('load', function () { resolve(); });
        return;
      }
      var s = document.createElement('script');
      s.src = src;
      s.async = true;
      s.onload = function () { resolve(); };
      s.onerror = function () { reject(new Error('Could not load captcha helper')); };
      document.head.appendChild(s);
    });
  }

  function dateLabel(iso) {
    if (!iso) return '';
    try {
      return new Date(iso).toLocaleDateString(undefined, { year: 'numeric', month: 'short', day: 'numeric' });
    } catch (e) { return ''; }
  }

  function currentItemKey() {
    try {
      return new URLSearchParams(location.search).get(ITEM_PARAM) || '';
    } catch (e) { return ''; }
  }

  function listHref() {
    var u = new URL(location.href);
    u.searchParams.delete(ITEM_PARAM);
    return u.pathname + u.search + u.hash;
  }

  function itemHref(key) {
    var u = new URL(location.href);
    u.searchParams.set(ITEM_PARAM, key);
    return u.pathname + '?' + u.searchParams.toString() + u.hash;
  }

  function shouldShowTitle(el) {
    if (el.getAttribute('data-bitpype-show-title') === '1') return true;
    if (el.getAttribute('data-bitpype-hide-title') === '1') return false;
    var prev = el.previousElementSibling;
    if (prev && /^H[1-3]$/.test(prev.tagName)) return false;
    return !el.classList.contains('bitpype-module-inpage');
  }

  function embedSettings(data) {
    var s = (data && data.settings) || (data && data.embed && data.embed.settings) || {};
    return {
      show_excerpt: !(s.show_excerpt === false || s.show_excerpt === 0 || s.show_excerpt === 'false'),
      post_limit: s.post_limit != null && Number(s.post_limit) > 0 ? Math.floor(Number(s.post_limit)) : null,
      target_page_slug: (data && data.embed && data.embed.target_page_slug) || '',
    };
  }

  function pathStem(p) {
    return String(p || '')
      .replace(/^\//, '')
      .replace(/\.html$/i, '')
      .replace(/\/$/, '')
      .toLowerCase();
  }

  /** Link to full blog page when this embed is a truncated preview on another page. */
  function viewAllPostsHref(data) {
    if (!(data && data.truncated)) return '';
    var slug = pathStem((data.embed && data.embed.target_page_slug) || '');
    if (!slug || slug === 'home') slug = 'index';
    var here = pathStem(location.pathname);
    if (!here || here === '' || here === '/') here = 'index';
    if (here === slug) return '';
    if (slug === 'index') return 'index.html';
    return slug.indexOf('.html') >= 0 ? slug : (slug + '.html');
  }

  function renderAlbumDetail(album, showBack) {
    var html = '';
    if (showBack) html += '<a class="bp-mod-back" href="' + esc(listHref()) + '">← All albums</a>';
    html += '<div class="bp-mod-detail"><h1>' + esc(album.title) + '</h1>';
    if (album.description) html += '<p class="bp-mod-meta">' + esc(album.description) + '</p>';
    var imgs = album.images || [];
    if (!imgs.length) html += '<p class="bp-mod-empty">No images yet.</p>';
    else {
      html += '<div class="bp-mod-gallery">';
      for (var i = 0; i < imgs.length; i++) {
        var im = imgs[i];
        html += '<a href="' + esc(im.image_url) + '" target="_blank" rel="noopener" style="background-image:url(\'' + esc(im.image_url) + '\')" title="' + esc(im.caption || '') + '"></a>';
      }
      html += '</div>';
    }
    html += '</div>';
    return html;
  }

  function renderList(el, data) {
    var type = data.module_type;
    var items = Array.isArray(data.items) ? data.items : [];
    var html = '';
    if (shouldShowTitle(el)) {
      html += '<h2 class="bp-mod-title">' + esc(data.title || type) + '</h2>';
    }
    if (type === 'bookings') {
      renderBookings(el, data, html);
      return;
    }
    if (!items.length) {
      el.innerHTML = html + renderEmpty(type);
      return;
    }
    if (type === 'gallery' && items.length === 1 && items[0].images) {
      el.innerHTML = html + renderAlbumDetail(items[0], false);
      return;
    }
    if (type === 'faq') {
      html += '<div class="bp-mod-faq">';
      for (var fi = 0; fi < items.length; fi++) {
        var fq = items[fi];
        html += '<details><summary>' + esc(fq.question) + '</summary>'
          + '<div class="bp-mod-content">' + (fq.answer_html || '') + '</div></details>';
      }
      html += '</div>';
      el.innerHTML = html;
      return;
    }
    html += '<div class="bp-mod-grid">';
    for (var i = 0; i < items.length; i++) {
      var it = items[i];
      var key = it.slug || it.id;
      if (type === 'blog') {
        var blogSet = embedSettings(data);
        html += '<article class="bp-mod-card">'
          + coverHtml(itemHref(key), it.cover_image, it.title)
          + '<div class="bp-mod-body"><h2><a href="' + esc(itemHref(key)) + '">' + esc(it.title) + '</a></h2>'
          + '<p class="bp-mod-meta">' + esc(dateLabel(it.published_at || it.created_at)) + '</p>'
          + (blogSet.show_excerpt && it.excerpt
            ? '<p class="bp-mod-excerpt">' + esc(it.excerpt) + '</p>'
            : '')
          + '</div></article>';
      } else if (type === 'ecommerce') {
        var buy = it.checkout_url
          ? '<a class="bp-mod-btn" href="' + esc(it.checkout_url) + '" target="_blank" rel="noopener">Buy</a>'
          : '<a class="bp-mod-btn ghost" href="' + esc(itemHref(key)) + '">View</a>';
        html += '<article class="bp-mod-card">'
          + coverHtml(itemHref(key), it.image_url, it.name)
          + '<div class="bp-mod-body"><h2><a href="' + esc(itemHref(key)) + '">' + esc(it.name) + '</a></h2>'
          + (it.price_label ? '<p class="bp-mod-price">' + esc(it.price_label) + '</p>' : '')
          + '<p class="bp-mod-desc">' + esc((it.description || '').slice(0, 140)) + '</p>' + buy + '</div></article>';
      } else if (type === 'courses') {
        var n = (it.lessons || []).length;
        html += '<article class="bp-mod-card">'
          + coverHtml(itemHref(key), it.cover_image, it.title)
          + '<div class="bp-mod-body"><h2><a href="' + esc(itemHref(key)) + '">' + esc(it.title) + '</a></h2>'
          + '<p class="bp-mod-meta">' + n + ' lesson' + (n === 1 ? '' : 's') + '</p>'
          + '<p class="bp-mod-desc">' + esc((it.description || '').slice(0, 140)) + '</p>'
          + '<a class="bp-mod-btn ghost" href="' + esc(itemHref(key)) + '">View course</a></div></article>';
      } else if (type === 'gallery') {
        var cover = (it.images && it.images[0] && it.images[0].image_url) || '';
        var count = (it.images || []).length;
        html += '<article class="bp-mod-card">'
          + coverHtml(itemHref(key), cover, it.title)
          + '<div class="bp-mod-body"><h2><a href="' + esc(itemHref(key)) + '">' + esc(it.title) + '</a></h2>'
          + '<p class="bp-mod-meta">' + count + ' photo' + (count === 1 ? '' : 's') + '</p></div></article>';
      } else if (type === 'directory') {
        html += '<article class="bp-mod-card">'
          + (it.image_url
            ? '<div class="bp-mod-cover" style="background-image:url(\'' + esc(it.image_url) + '\')"></div>'
            : '<div class="bp-mod-cover bp-mod-cover-fallback" aria-hidden="true">' + esc(String(it.name || '?').charAt(0).toUpperCase()) + '</div>')
          + '<div class="bp-mod-body"><h2>' + esc(it.name) + '</h2>'
          + (it.category ? '<p class="bp-mod-meta">' + esc(it.category) + '</p>' : '')
          + '<p class="bp-mod-desc">' + esc((it.description || '').slice(0, 160)) + '</p>'
          + (it.website_url ? '<a class="bp-mod-btn ghost" href="' + esc(it.website_url) + '" target="_blank" rel="noopener">Visit</a>' : '')
          + (it.contact_email ? '<p class="bp-mod-meta">' + esc(it.contact_email) + '</p>' : '')
          + (it.contact_phone ? '<p class="bp-mod-meta">' + esc(it.contact_phone) + '</p>' : '')
          + '</div></article>';
      } else if (type === 'testimonials') {
        html += '<article class="bp-mod-card"><div class="bp-mod-body">'
          + starsHtml(it.rating)
          + '<p class="bp-mod-quote">“' + esc(it.quote) + '”</p>'
          + '<p class="bp-mod-meta"><strong>' + esc(it.author_name || 'Client') + '</strong>'
          + (it.author_title || it.author_company
            ? ' · ' + esc([it.author_title, it.author_company].filter(Boolean).join(', '))
            : '')
          + '</p></div></article>';
      } else if (type === 'team') {
        html += '<article class="bp-mod-card">'
          + coverHtml(itemHref(key), it.image_url, it.name)
          + '<div class="bp-mod-body"><h2><a href="' + esc(itemHref(key)) + '">' + esc(it.name) + '</a></h2>'
          + (it.role_title ? '<p class="bp-mod-meta">' + esc(it.role_title) + '</p>' : '')
          + '<p class="bp-mod-desc">' + esc((it.bio || '').slice(0, 140)) + '</p></div></article>';
      } else if (type === 'events') {
        html += '<article class="bp-mod-card">'
          + coverHtml(itemHref(key), it.image_url, it.title)
          + '<div class="bp-mod-body"><h2><a href="' + esc(itemHref(key)) + '">' + esc(it.title) + '</a></h2>'
          + '<p class="bp-mod-meta">' + esc(dateLabel(it.starts_at) || it.starts_at || '') + '</p>'
          + (it.location ? '<p class="bp-mod-meta">' + esc(it.location) + '</p>' : '')
          + '<p class="bp-mod-desc">' + esc((it.description || '').slice(0, 140)) + '</p></div></article>';
      }
    }
    html += '</div>';
    if (type === 'blog') {
      var allHref = viewAllPostsHref(data);
      if (allHref) {
        html += '<p class="bp-mod-view-all"><a href="' + esc(allHref) + '">View all posts</a></p>';
      }
    }
    el.innerHTML = html;
  }

  function renderBookings(el, data, prefixHtml) {
    var services = Array.isArray(data.items) ? data.items : [];
    if (!services.length) {
      el.innerHTML = (prefixHtml || '') + renderEmpty('bookings');
      return;
    }
    var settings = (data.booking && data.booking.settings) || {};
    var maxDays = Number(settings.max_days_ahead) || 60;
    var maxDate = new Date();
    maxDate.setDate(maxDate.getDate() + maxDays);
    var maxYmd = maxDate.getFullYear() + '-' + String(maxDate.getMonth() + 1).padStart(2, '0') + '-' + String(maxDate.getDate()).padStart(2, '0');
    var html = prefixHtml || '';
    html += '<form class="bp-mod-book" data-bp-book="1">'
      + '<div class="bp-mod-book-row"><label for="bp-svc">Service</label><select id="bp-svc" name="service_id" required>';
    for (var i = 0; i < services.length; i++) {
      var s = services[i];
      html += '<option value="' + esc(s.id) + '">' + esc(s.name)
        + (s.duration_label ? ' · ' + esc(s.duration_label) : '')
        + (s.price_label ? ' · ' + esc(s.price_label) : '')
        + '</option>';
    }
    html += '</select></div>'
      + '<div class="bp-mod-book-row"><label for="bp-date">Date</label>'
      + '<input id="bp-date" name="date" type="date" required min="' + esc(todayYmd()) + '" max="' + esc(maxYmd) + '" value="' + esc(todayYmd()) + '" /></div>'
      + '<div class="bp-mod-book-row"><span>Available times</span><div class="bp-mod-slots" data-bp-slots></div>'
      + '<p class="bp-mod-book-msg" data-bp-slot-msg>Pick a date to see open times.</p></div>'
      + '<input type="hidden" name="starts_at" value="" />'
      + '<div class="bp-mod-book-row"><label for="bp-name">Name</label><input id="bp-name" name="customer_name" required autocomplete="name" /></div>'
      + '<div class="bp-mod-book-row"><label for="bp-email">Email</label><input id="bp-email" name="customer_email" type="email" autocomplete="email" /></div>'
      + '<div class="bp-mod-book-row"><label for="bp-phone">Phone</label><input id="bp-phone" name="customer_phone" type="tel" autocomplete="tel" /></div>'
      + '<div class="bp-mod-book-row"><label for="bp-notes">Notes</label><textarea id="bp-notes" name="notes" rows="3"></textarea></div>'
      + '<div class="bp-mod-captcha" data-bp-captcha hidden></div>'
      + '<button type="submit" class="bp-mod-btn">Request appointment</button>'
      + '<p class="bp-mod-book-msg" data-bp-book-msg></p>'
      + '</form>';
    el.innerHTML = html;
    bindBookingForm(el, data);
  }

  function bindBookingForm(el, data) {
    var form = el.querySelector('[data-bp-book]');
    if (!form) return;
    var token = el.getAttribute(TOKEN_ATTR) || '';
    var base = apiBase(el);
    var slotsBox = form.querySelector('[data-bp-slots]');
    var slotMsg = form.querySelector('[data-bp-slot-msg]');
    var bookMsg = form.querySelector('[data-bp-book-msg]');
    var startsInput = form.querySelector('[name="starts_at"]');
    var captchaBox = form.querySelector('[data-bp-captcha]');
    var submitBtn = form.querySelector('button[type="submit"]');
    var captcha = { enabled: false, getToken: async function () { return ''; }, reset: function () {} };
    var selectedSlot = '';

    (async function () {
      try {
        if (base) await loadScript(base + '/js/captcha.js?v=mod5');
        if (window.ScoutCaptcha && captchaBox) {
          captcha = await window.ScoutCaptcha.mount(captchaBox, { apiBase: base });
        }
      } catch (e) { /* captcha optional when disabled server-side */ }
    })();

    function setSlotMsg(text, kind) {
      if (!slotMsg) return;
      slotMsg.textContent = text || '';
      slotMsg.className = 'bp-mod-book-msg' + (kind ? ' ' + kind : '');
    }

    function addDaysYmd(ymd, days) {
      var p = String(ymd || '').split('-');
      if (p.length !== 3) return ymd;
      var dt = new Date(Number(p[0]), Number(p[1]) - 1, Number(p[2]));
      dt.setDate(dt.getDate() + days);
      return dt.getFullYear() + '-' + String(dt.getMonth() + 1).padStart(2, '0') + '-'
        + String(dt.getDate()).padStart(2, '0');
    }

    function fetchSlotsForDate(date, serviceId) {
      var path = (base || '') + '/api/v1/modules/public/' + encodeURIComponent(token)
        + '/slots?date=' + encodeURIComponent(date) + '&serviceId=' + encodeURIComponent(serviceId);
      return fetch(path, { credentials: 'omit' }).then(function (r) { return r.json(); });
    }

    function findNextOpenDay(startDate, serviceId, maxDate) {
      var d = startDate;
      var guard = 0;
      function step() {
        if (d > maxDate || guard >= 90) return Promise.resolve(null);
        guard += 1;
        var probe = d;
        return fetchSlotsForDate(probe, serviceId).then(function (j) {
          if (j && j.ok) {
            var slots = (j.data && j.data.slots) || [];
            if (slots.length) return { date: probe, slots: slots };
          }
          d = addDaysYmd(probe, 1);
          return step();
        });
      }
      return step();
    }

    function loadSlots() {
      var date = form.date.value;
      var serviceId = form.service_id.value;
      selectedSlot = '';
      if (startsInput) startsInput.value = '';
      if (!date || !serviceId) return;
      setSlotMsg('Loading times…');
      if (slotsBox) slotsBox.innerHTML = '';
      fetchSlotsForDate(date, serviceId)
        .then(function (j) {
          if (!j || !j.ok) throw new Error((j && j.error) || 'Could not load times');
          var slots = (j.data && j.data.slots) || [];
          if (slots.length) {
            setSlotMsg('Select a time.');
            if (!slotsBox) return;
            slotsBox.innerHTML = slots.map(function (slot) {
              return '<button type="button" class="bp-mod-slot" data-starts="' + esc(slot.starts_at) + '">'
                + esc(slot.label) + '</button>';
            }).join('');
            return;
          }
          var maxDate = form.date.max || '';
          return findNextOpenDay(addDaysYmd(date, 1), serviceId, maxDate).then(function (next) {
            if (!next) {
              setSlotMsg(j.data && j.data.closed ? 'Closed this day.' : 'No open times on this day.');
              return;
            }
            var nice = next.date;
            try {
              var nd = new Date(next.date + 'T12:00:00');
              nice = nd.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' });
            } catch (e) { /* keep ymd */ }
            setSlotMsg('Next opening: ' + nice + '. Jumping to that date…', 'ok');
            form.date.value = next.date;
            loadSlots();
          });
        })
        .catch(function (e) {
          setSlotMsg(e.message || 'Could not load times', 'err');
        });
    }

    form.addEventListener('change', function (ev) {
      if (ev.target && (ev.target.name === 'date' || ev.target.name === 'service_id')) loadSlots();
    });
    form.addEventListener('click', function (ev) {
      var btn = ev.target && ev.target.closest ? ev.target.closest('[data-starts]') : null;
      if (!btn || !form.contains(btn)) return;
      selectedSlot = btn.getAttribute('data-starts') || '';
      if (startsInput) startsInput.value = selectedSlot;
      var all = form.querySelectorAll('.bp-mod-slot');
      for (var i = 0; i < all.length; i++) all[i].classList.toggle('is-selected', all[i] === btn);
      setSlotMsg('Selected ' + (btn.textContent || '') + '.');
    });
    form.addEventListener('submit', function (ev) {
      ev.preventDefault();
      if (bookMsg) { bookMsg.textContent = ''; bookMsg.className = 'bp-mod-book-msg'; }
      if (!selectedSlot) {
        if (bookMsg) { bookMsg.textContent = 'Please choose an available time.'; bookMsg.className = 'bp-mod-book-msg err'; }
        return;
      }
      var email = String(form.customer_email.value || '').trim();
      var phone = String(form.customer_phone.value || '').trim();
      if (!email && !phone) {
        if (bookMsg) { bookMsg.textContent = 'Email or phone is required.'; bookMsg.className = 'bp-mod-book-msg err'; }
        return;
      }
      if (submitBtn) submitBtn.disabled = true;
      if (bookMsg) bookMsg.textContent = 'Submitting…';
      (async function () {
        try {
          var captchaToken = await captcha.getToken();
          var body = {
            service_id: Number(form.service_id.value),
            starts_at: selectedSlot,
            customer_name: form.customer_name.value,
            customer_email: email,
            customer_phone: phone,
            notes: form.notes.value,
            captchaToken: captchaToken,
          };
          var r = await fetch((base || '') + '/api/v1/modules/public/' + encodeURIComponent(token) + '/book', {
            method: 'POST',
            credentials: 'omit',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(body),
          });
          var j = await r.json();
          if (!r.ok || !j || !j.ok) throw new Error((j && j.error) || 'Booking failed');
          var msg = (j.data && j.data.message) || 'Appointment requested.';
          el.innerHTML = (shouldShowTitle(el)
            ? '<h2 class="bp-mod-title">' + esc(data.title || 'Bookings') + '</h2>'
            : '')
            + '<div class="bp-mod-empty-card"><p class="bp-mod-empty-kicker">Booked</p>'
            + '<p class="bp-mod-empty-title">' + esc(msg) + '</p>'
            + '<p class="bp-mod-empty-text">' + esc((j.data.appointment && j.data.appointment.starts_at) || '') + '</p></div>';
        } catch (e) {
          if (bookMsg) { bookMsg.textContent = e.message || 'Booking failed'; bookMsg.className = 'bp-mod-book-msg err'; }
          if (captcha.reset) captcha.reset();
        } finally {
          if (submitBtn) submitBtn.disabled = false;
        }
      })();
    });
    loadSlots();
  }

  function renderItem(el, data) {
    var type = data.module_type;
    var it = data.item;
    var html = '<a class="bp-mod-back" href="' + esc(listHref()) + '">← Back</a>';
    if (type === 'blog') {
      html += '<article class="bp-mod-detail">'
        + (it.cover_image ? '<img class="bp-mod-hero" src="' + esc(it.cover_image) + '" alt="" />' : '')
        + '<h1>' + esc(it.title) + '</h1>'
        + '<p class="bp-mod-meta">' + esc(dateLabel(it.published_at || it.created_at)) + '</p>'
        + '<div class="bp-mod-content">' + (it.body_html || '') + '</div></article>';
    } else if (type === 'ecommerce') {
      html += '<article class="bp-mod-detail">'
        + (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '')
        + '<h1>' + esc(it.name) + '</h1>'
        + '<p class="bp-mod-price">' + esc(it.price_label || '') + '</p>'
        + '<div class="bp-mod-content"><p>' + esc(it.description || '') + '</p></div>'
        + (it.checkout_url ? '<p style="margin-top:16px"><a class="bp-mod-btn" href="' + esc(it.checkout_url) + '" target="_blank" rel="noopener">Buy now</a></p>' : '')
        + '</article>';
    } else if (type === 'courses') {
      html += '<article class="bp-mod-detail">'
        + (it.cover_image ? '<img class="bp-mod-hero" src="' + esc(it.cover_image) + '" alt="" />' : '')
        + '<h1>' + esc(it.title) + '</h1>'
        + '<p class="bp-mod-desc">' + esc(it.description || '') + '</p>'
        + (it.enrollment_url ? '<p style="margin-top:12px"><a class="bp-mod-btn" href="' + esc(it.enrollment_url) + '" target="_blank" rel="noopener">Enroll</a></p>' : '')
        + '<ul class="bp-mod-lessons">';
      var lessons = it.lessons || [];
      for (var i = 0; i < lessons.length; i++) {
        var les = lessons[i];
        html += '<li><strong>' + esc(les.title) + '</strong>'
          + (les.lesson_url ? ' · <a href="' + esc(les.lesson_url) + '" target="_blank" rel="noopener">Open</a>' : '')
          + (les.body_html ? '<div class="bp-mod-content" style="margin-top:8px">' + les.body_html + '</div>' : '')
          + '</li>';
      }
      html += '</ul></article>';
    } else if (type === 'gallery') {
      html += renderAlbumDetail(it, true);
    } else if (type === 'directory') {
      html += '<article class="bp-mod-detail">'
        + (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '')
        + '<h1>' + esc(it.name) + '</h1>'
        + (it.category ? '<p class="bp-mod-meta">' + esc(it.category) + '</p>' : '')
        + '<p class="bp-mod-desc">' + esc(it.description || '') + '</p>'
        + (it.website_url ? '<p><a class="bp-mod-btn" href="' + esc(it.website_url) + '" target="_blank" rel="noopener">Visit</a></p>' : '')
        + (it.contact_email ? '<p class="bp-mod-meta">' + esc(it.contact_email) + '</p>' : '')
        + (it.contact_phone ? '<p class="bp-mod-meta">' + esc(it.contact_phone) + '</p>' : '')
        + '</article>';
    } else if (type === 'team') {
      html += '<article class="bp-mod-detail">'
        + (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '')
        + '<h1>' + esc(it.name) + '</h1>'
        + (it.role_title ? '<p class="bp-mod-meta">' + esc(it.role_title) + '</p>' : '')
        + '<div class="bp-mod-content"><p>' + esc(it.bio || '') + '</p></div>'
        + (it.email ? '<p class="bp-mod-meta">' + esc(it.email) + '</p>' : '')
        + (it.phone ? '<p class="bp-mod-meta">' + esc(it.phone) + '</p>' : '')
        + (it.social_url ? '<p><a class="bp-mod-btn ghost" href="' + esc(it.social_url) + '" target="_blank" rel="noopener">Profile</a></p>' : '')
        + '</article>';
    } else if (type === 'events') {
      html += '<article class="bp-mod-detail">'
        + (it.image_url ? '<img class="bp-mod-hero" src="' + esc(it.image_url) + '" alt="" />' : '')
        + '<h1>' + esc(it.title) + '</h1>'
        + '<p class="bp-mod-meta">' + esc(dateLabel(it.starts_at) || it.starts_at || '')
        + (it.ends_at ? ' – ' + esc(dateLabel(it.ends_at) || it.ends_at) : '') + '</p>'
        + (it.location ? '<p class="bp-mod-meta">' + esc(it.location) + '</p>' : '')
        + '<div class="bp-mod-content"><p>' + esc(it.description || '') + '</p></div>'
        + (it.ticket_url ? '<p style="margin-top:16px"><a class="bp-mod-btn" href="' + esc(it.ticket_url) + '" target="_blank" rel="noopener">Tickets / RSVP</a></p>' : '')
        + '</article>';
    } else if (type === 'testimonials') {
      html += '<article class="bp-mod-detail">'
        + starsHtml(it.rating)
        + '<p class="bp-mod-quote">“' + esc(it.quote) + '”</p>'
        + '<p class="bp-mod-meta"><strong>' + esc(it.author_name || 'Client') + '</strong>'
        + (it.author_title || it.author_company
          ? ' · ' + esc([it.author_title, it.author_company].filter(Boolean).join(', '))
          : '')
        + '</p></article>';
    } else if (type === 'faq') {
      html += '<article class="bp-mod-detail"><h1>' + esc(it.question) + '</h1>'
        + '<div class="bp-mod-content">' + (it.answer_html || '') + '</div></article>';
    } else if (type === 'bookings') {
      html += '<article class="bp-mod-detail"><h1>' + esc(it.name) + '</h1>'
        + '<p class="bp-mod-meta">' + esc(it.duration_label || '') + (it.price_label ? ' · ' + esc(it.price_label) : '') + '</p>'
        + '<p class="bp-mod-desc">' + esc(it.description || '') + '</p>'
        + '<p><a class="bp-mod-btn" href="' + esc(listHref()) + '">Book this service</a></p></article>';
    }
    el.innerHTML = html;
  }

  function mountOne(el) {
    var token = el.getAttribute(TOKEN_ATTR) || '';
    if (!token) {
      el.innerHTML = '<p class="bp-mod-err">Missing module token.</p>';
      return;
    }
    ensureStyles();
    polishHost(el);
    el.classList.add('bitpype-module-inpage');
    if (document.body && document.body.children.length <= 2 && el.parentElement === document.body) {
      el.classList.add('bitpype-module-standalone');
    }
    el.innerHTML = '<p class="bp-mod-loading">Loading…</p>';
    var base = apiBase(el);
    var item = currentItemKey();
    var path = (base || '') + '/api/v1/modules/public/' + encodeURIComponent(token)
      + (item ? '?slug=' + encodeURIComponent(item) : '');
    fetch(path, { credentials: 'omit' })
      .then(function (r) { return r.json(); })
      .then(function (j) {
        if (!j || !j.ok) throw new Error((j && j.error) || 'Failed to load');
        var data = j.data;
        if (data.item) renderItem(el, data);
        else renderList(el, data);
      })
      .catch(function (e) {
        el.innerHTML = '<p class="bp-mod-err">' + esc(e.message || 'Failed to load module') + '</p>';
      });
  }

  function boot() {
    ensureStyles();
    var nodes = document.querySelectorAll('[data-bitpype-module][data-bitpype-module-token]');
    for (var i = 0; i < nodes.length; i++) mountOne(nodes[i]);
  }

  window.BitpypeModules = {
    __booted: true,
    boot: boot,
    mount: mountOne,
  };

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }
})();
