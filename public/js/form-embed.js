/**
 * In-page BitPype contact forms.
 * Mounts on [data-bitpype-form-embed] / .bitpype-form-embed[data-bitpype-managed]
 * and loads schema/submit from data-bitpype-api (or the script origin).
 */
(function () {
  'use strict';

  if (window.BitpypeForms && window.BitpypeForms.__booted) return;

  var STYLE_ID = 'bitpype-form-embed-css';
  var TOKEN_ATTR = 'data-bitpype-form-embed';

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function apiBase(el) {
    var raw = (el && el.getAttribute('data-bitpype-api')) || '';
    if (raw) return String(raw).replace(/\/$/, '');
    try {
      var src = document.querySelector('script[data-bitpype-form-script],script[src*="form-embed.js"]');
      if (src && src.src) return new URL(src.src).origin;
    } catch (e) { /* ignore */ }
    return '';
  }

  function ensureStyles() {
    if (document.getElementById(STYLE_ID)) return;
    var css = [
      '.bitpype-form-embed{',
      '--bp-form-ink:var(--ws-text,var(--ink,currentColor));',
      '--bp-form-muted:var(--ws-muted,var(--muted,color-mix(in srgb,var(--bp-form-ink) 58%,transparent)));',
      '--bp-form-line:var(--ws-line,var(--line,color-mix(in srgb,var(--bp-form-ink) 14%,transparent)));',
      '--bp-form-accent:var(--ws-primary,var(--accent,#0e7a68));',
      '--bp-form-paper:var(--ws-bg,var(--paper,#fff));',
      'color:var(--bp-form-ink);font:inherit;line-height:1.5;width:100%;max-width:560px;margin:1.5rem 0;',
      '}',
      '.bitpype-form-embed.bitpype-form-standalone{max-width:520px;margin:0 auto;padding:22px 16px 32px;}',
      '.bitpype-form-embed .bp-form-card{',
      'border:1px solid var(--bp-form-line);border-radius:1.35rem;padding:clamp(1.2rem,3vw,1.7rem);',
      'background:color-mix(in srgb,var(--bp-form-paper) 96%,var(--bp-form-ink));',
      'box-shadow:0 18px 44px color-mix(in srgb,var(--bp-form-ink) 8%,transparent);',
      '}',
      '.bitpype-form-embed .bp-form-title{',
      'margin:0 0 0.4rem;font-size:clamp(1.55rem,3vw,2rem);letter-spacing:-0.03em;line-height:1.1;',
      'font-family:var(--ws-heading-font,inherit);',
      '}',
      '.bitpype-form-embed .bp-form-intro{margin:0 0 1.15rem;color:var(--bp-form-muted);}',
      '.bitpype-form-embed .bp-form-field{margin:0 0 0.9rem;}',
      '.bitpype-form-embed label{display:block;font-size:0.88rem;font-weight:700;margin:0 0 0.35rem;}',
      '.bitpype-form-embed input,.bitpype-form-embed textarea,.bitpype-form-embed select{',
      'width:100%;border:1.5px solid var(--bp-form-line);border-radius:0.85rem;padding:0.7rem 0.85rem;',
      'font:inherit;background:var(--bp-form-paper);color:var(--bp-form-ink);box-sizing:border-box;',
      '}',
      '.bitpype-form-embed input:focus,.bitpype-form-embed textarea:focus,.bitpype-form-embed select:focus{',
      'outline:3px solid color-mix(in srgb,var(--bp-form-accent) 35%,transparent);border-color:var(--bp-form-accent);',
      '}',
      '.bitpype-form-embed textarea{min-height:120px;resize:vertical;}',
      '.bitpype-form-embed .bp-form-check{display:flex;align-items:center;gap:0.55rem;}',
      '.bitpype-form-embed .bp-form-check input{width:auto;}',
      '.bitpype-form-embed .bp-form-btn{',
      'appearance:none;border:0;border-radius:999px;background:var(--bp-form-accent);color:#fff;',
      'font:inherit;font-weight:700;padding:0.75rem 1.25rem;cursor:pointer;margin-top:0.35rem;',
      '}',
      '.bitpype-form-embed .bp-form-btn:disabled{opacity:0.55;cursor:wait;}',
      '.bitpype-form-embed .bp-form-msg{margin:0.85rem 0 0;font-size:0.95rem;min-height:1.2em;color:var(--bp-form-muted);}',
      '.bitpype-form-embed .bp-form-msg.ok{color:var(--bp-form-accent);font-weight:700;}',
      '.bitpype-form-embed .bp-form-msg.err{color:#9b2c2c;}',
      '.bitpype-form-embed .bp-form-captcha{margin:0.9rem 0;}',
      /* Inside site contact-card / .info form panel: no nested card chrome */
      '.contact-card .bitpype-form-embed,.info .bitpype-form-embed,.bitpype-form-panel .bitpype-form-embed{',
      'max-width:none;margin:0;width:100%;}',
      '.contact-card .bitpype-form-embed .bp-form-card,.info .bitpype-form-embed .bp-form-card,',
      '.bitpype-form-panel .bitpype-form-embed .bp-form-card{',
      'border:0;border-radius:0;padding:0;background:transparent;box-shadow:none;',
      '}',
      '.contact-card .bitpype-form-embed .bp-form-title,.info .bitpype-form-embed .bp-form-title,',
      '.bitpype-form-panel .bitpype-form-embed .bp-form-title{',
      'font-size:1.15rem;letter-spacing:0.04em;text-transform:uppercase;',
      'font-family:var(--disp,var(--ws-heading-font,inherit));}',
      '.bitpype-form-embed .bp-form-captcha iframe{display:block;}',
    ].join('');
    var style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = css;
    document.head.appendChild(style);
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

  function mountOne(el) {
    var token = el.getAttribute(TOKEN_ATTR) || '';
    if (!token || !/^\d+_[A-Za-z0-9_-]+$/.test(token)) {
      el.innerHTML = '<p class="bp-form-msg err">Missing or invalid form token.</p>';
      return;
    }
    ensureStyles();
    el.classList.add('bitpype-form-inpage');
    if (document.body && el.parentElement === document.body) {
      el.classList.add('bitpype-form-standalone');
    }
    el.innerHTML = '<p class="bp-form-msg">Loading form…</p>';
    var base = apiBase(el);
    window.BitpypeApiBase = base || window.BitpypeApiBase || '';

    var schemaUrl = (base || '') + '/api/v1/forms/public/' + encodeURIComponent(token);
    fetch(schemaUrl, { credentials: 'omit' })
      .then(function (r) { return r.json().then(function (j) { return { r: r, j: j }; }); })
      .then(function (pack) {
        if (!pack.r.ok || !pack.j || !pack.j.ok) {
          throw new Error((pack.j && pack.j.error) || 'Form unavailable');
        }
        return renderForm(el, pack.j.data, base, token);
      })
      .catch(function (e) {
        el.innerHTML = '<p class="bp-form-msg err">' + esc(e.message || 'Form unavailable') + '</p>';
      });
  }

  async function renderForm(el, form, base, token) {
    var title = form.title || 'Contact';
    var intro = form.intro || '';
    el.innerHTML =
      '<div class="bp-form-card">'
      + '<h2 class="bp-form-title">' + esc(title) + '</h2>'
      + (intro ? '<p class="bp-form-intro">' + esc(intro) + '</p>' : '')
      + '<form class="bp-form" novalidate></form>'
      + '<p class="bp-form-msg" role="status"></p>'
      + '</div>';

    var formEl = el.querySelector('form');
    var msg = el.querySelector('.bp-form-msg');
    var captcha = { enabled: false, getToken: async function () { return ''; }, reset: function () {} };
    var captchaBox = document.createElement('div');
    captchaBox.className = 'bp-form-captcha';
    captchaBox.hidden = true;

    (form.fields || []).forEach(function (f) {
      var wrap = document.createElement('div');
      wrap.className = 'bp-form-field';
      var label = document.createElement('label');
      label.textContent = f.label + (f.required ? ' *' : '');
      label.setAttribute('for', 'bpf_' + f.field_key);
      var input;
      if (f.field_type === 'textarea') {
        input = document.createElement('textarea');
      } else if (f.field_type === 'select') {
        input = document.createElement('select');
        (f.options || []).forEach(function (opt) {
          var o = document.createElement('option');
          o.value = String(opt);
          o.textContent = String(opt);
          input.appendChild(o);
        });
      } else if (f.field_type === 'checkbox') {
        input = document.createElement('input');
        input.type = 'checkbox';
        wrap.className = 'bp-form-field bp-form-check';
      } else {
        input = document.createElement('input');
        input.type = f.field_type === 'tel' ? 'tel'
          : f.field_type === 'email' ? 'email'
          : f.field_type === 'number' ? 'number'
          : f.field_type === 'url' ? 'url'
          : 'text';
      }
      input.id = 'bpf_' + f.field_key;
      input.name = f.field_key;
      if (f.placeholder) input.placeholder = String(f.placeholder);
      if (f.required && f.field_type !== 'checkbox') input.required = true;
      if (f.field_type === 'checkbox') {
        wrap.appendChild(input);
        wrap.appendChild(label);
      } else {
        wrap.appendChild(label);
        wrap.appendChild(input);
      }
      formEl.appendChild(wrap);
    });

    formEl.appendChild(captchaBox);

    var btn = document.createElement('button');
    btn.type = 'submit';
    btn.className = 'bp-form-btn';
    btn.textContent = form.submit_label || 'Send Message';
    formEl.appendChild(btn);

    try {
      if (base) await loadScript(base + '/js/captcha.js?v=form5');
      if (window.ScoutCaptcha) {
        captcha = await window.ScoutCaptcha.mount(captchaBox, { apiBase: base });
      }
    } catch (e) {
      // Captcha optional when disabled server-side.
    }

    formEl.onsubmit = async function (ev) {
      ev.preventDefault();
      msg.className = 'bp-form-msg';
      msg.textContent = 'Sending…';
      btn.disabled = true;
      try {
        var values = {};
        (form.fields || []).forEach(function (f) {
          var field = formEl.elements[f.field_key];
          if (!field) return;
          values[f.field_key] = f.field_type === 'checkbox' ? !!field.checked : field.value;
        });
        var captchaToken = await captcha.getToken();
        var submit = await fetch((base || '') + '/api/v1/forms/public/' + encodeURIComponent(token) + '/submit', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'omit',
          body: JSON.stringify({ values: values, captchaToken: captchaToken }),
        });
        var out = await submit.json();
        if (!submit.ok || !out.ok) throw new Error((out && out.error) || 'Submit failed');
        msg.className = 'bp-form-msg ok';
        msg.textContent = (out.data && out.data.success_message) || form.success_message || 'Thanks!';
        formEl.reset();
        if (captcha.reset) captcha.reset();
      } catch (e) {
        msg.className = 'bp-form-msg err';
        msg.textContent = e.message || 'Could not send';
        if (captcha.reset) captcha.reset();
      } finally {
        btn.disabled = false;
      }
    };
  }

  function boot() {
    ensureStyles();
    var nodes = document.querySelectorAll('[' + TOKEN_ATTR + ']');
    for (var i = 0; i < nodes.length; i++) mountOne(nodes[i]);
  }

  window.BitpypeForms = {
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
