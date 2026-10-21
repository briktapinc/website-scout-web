'use strict';

// Runs inside the opaque preview. No parent DOM, cookies, credentials or API proxy.
(function () {
  function fontLink(href) {
    if (!href) return;
    try {
      var url = new URL(href);
      if (url.origin !== 'https://fonts.googleapis.com' || !/^\/css2?$/.test(url.pathname)) return;
      var link = document.getElementById('ws-bridge-fonts');
      if (!link) { link = document.createElement('link'); link.id = 'ws-bridge-fonts'; link.rel = 'stylesheet'; document.head.appendChild(link); }
      link.href = url.href;
    } catch (err) { /* Invalid font URLs are ignored. */ }
  }
  function fonts(data) {
    document.documentElement.style.setProperty('--ws-font', String(data.font || '').slice(0, 2000));
    document.documentElement.style.setProperty('--ws-heading-font', String(data.headingFont || data.font || '').slice(0, 2000));
    var style = document.getElementById('ws-font-rules');
    if (!style) { style = document.createElement('style'); style.id = 'ws-font-rules'; document.head.appendChild(style); }
    style.textContent = 'body{font-family:var(--ws-font)}h1,h2,h3,h4,h5,h6{font-family:var(--ws-heading-font,var(--ws-font))}';
    fontLink(data.fontHref);
  }
  function rewrite(from, to) {
    if (!/^#[\da-f]{6}$/i.test(from) || !/^#[\da-f]{6}$/i.test(to) || from === to) return;
    var re = new RegExp(from, 'gi');
    document.querySelectorAll('style').forEach(function (el) { el.textContent = el.textContent.replace(re, to); });
    document.querySelectorAll('[style],[fill],[stroke]').forEach(function (el) {
      ['style', 'fill', 'stroke'].forEach(function (attr) { var value = el.getAttribute(attr); if (value) el.setAttribute(attr, value.replace(re, to)); });
    });
  }
  window.addEventListener('message', function (event) {
    var data = event.data;
    if (event.source !== parent || !data || data.source !== 'ws-portal') return;
    if (data.type === 'site-fonts') fonts(data);
    if (data.type === 'set-font') fontLink(data.fontHref);
    if (data.type === 'theme-preview') {
      (Array.isArray(data.rewrites) ? data.rewrites.slice(0, 100) : []).forEach(function (pair) { if (pair) rewrite(pair.from, pair.to); });
      ['primary', 'secondary', 'bg', 'text'].forEach(function (key) {
        var value = data.colors && data.colors[key];
        if (/^#[\da-f]{6}$/i.test(value)) document.documentElement.style.setProperty('--ws-' + key, value);
      });
      fonts(data);
    }
    if (data.type === 'restore-scroll' && Number.isFinite(data.x) && Number.isFinite(data.y)) window.scrollTo(Math.max(0, data.x), Math.max(0, data.y));
  });
  var queued = false;
  window.addEventListener('scroll', function () {
    if (queued) return;
    queued = true;
    requestAnimationFrame(function () {
      queued = false;
      parent.postMessage({source:'ws-preview', type:'scroll-position', x:window.scrollX, y:window.scrollY}, '*');
    });
  }, {passive:true});
})();
