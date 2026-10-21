'use strict';

/**
 * Cookie notice footer for BitPype preview / published sites.
 * Dismiss stores consent in localStorage so it stays hidden.
 */
(function () {
  try {
    if (window.localStorage && localStorage.getItem('bp_cookie_ok') === '1') return;
  } catch { /* private mode */ }

  if (document.getElementById('bp-cookie-bar')) return;

  function mount() {
    if (document.getElementById('bp-cookie-bar')) return;

    const style = document.createElement('style');
    style.id = 'bp-cookie-bar-style';
    style.textContent = [
      '#bp-cookie-bar{position:fixed;left:0;right:0;bottom:0;z-index:2147482900;',
      'display:flex;flex-wrap:wrap;align-items:center;justify-content:space-between;gap:12px 18px;',
      'padding:14px max(16px, env(safe-area-inset-right)) calc(14px + env(safe-area-inset-bottom,0px)) max(16px, env(safe-area-inset-left));',
      'background:#1c140f;color:#fffaf4;font:15px/1.45 system-ui,-apple-system,Segoe UI,Roboto,sans-serif;',
      'box-shadow:0 -8px 28px rgba(0,0,0,.18);}',
      '#bp-cookie-bar p{margin:0;flex:1 1 16rem;max-width:52rem;opacity:.95;}',
      '#bp-cookie-bar a{color:#f0b429;text-decoration:underline;}',
      '#bp-cookie-bar .bp-cookie-actions{display:flex;flex-wrap:wrap;gap:8px;align-items:center;}',
      '#bp-cookie-bar button{appearance:none;border:0;cursor:pointer;font:inherit;font-weight:700;',
      'padding:10px 16px;border-radius:999px;background:#fffaf4;color:#1c140f;}',
      '#bp-cookie-bar button:hover{background:#f4efe6;}',
      'body.bp-cookie-pad{padding-bottom:max(88px, calc(72px + env(safe-area-inset-bottom,0px)));}',
    ].join('');

    const bar = document.createElement('div');
    bar.id = 'bp-cookie-bar';
    bar.setAttribute('role', 'dialog');
    bar.setAttribute('aria-live', 'polite');
    bar.setAttribute('aria-label', 'Cookie notice');
    bar.innerHTML = [
      '<p>We use cookies to run this site and understand how it is used. By continuing, you agree to our use of cookies.',
      ' <a href="https://bitpype.com/legal/privacy.html" target="_blank" rel="noopener noreferrer">Privacy</a></p>',
      '<div class="bp-cookie-actions">',
      '<button type="button" id="bp-cookie-accept">Got it</button>',
      '</div>',
    ].join('');

    document.head.appendChild(style);
    document.body.appendChild(bar);
    document.body.classList.add('bp-cookie-pad');

    document.getElementById('bp-cookie-accept').addEventListener('click', () => {
      try {
        if (window.localStorage) localStorage.setItem('bp_cookie_ok', '1');
      } catch { /* */ }
      bar.remove();
      style.remove();
      document.body.classList.remove('bp-cookie-pad');
    });
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', mount);
  } else {
    mount();
  }
})();
