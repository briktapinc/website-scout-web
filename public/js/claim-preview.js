'use strict';

/**
 * Preview-site claim popup: Yes I'm interested / No - Delete it / Maybe later.
 * Shows after 10s OR on back/leave (whichever first), only when intent is not positive.
 * Expects window.BitpypeClaim = { apiBase, token }.
 */
(function () {
  const cfg = window.BitpypeClaim || {};
  const apiBase = String(cfg.apiBase || '').replace(/\/$/, '');
  const token = String(cfg.token || '').trim();
  if (!apiBase || !token) return;

  const DELAY_MS = 10000;
  const storageKey = 'bp_claim_done_' + token.slice(0, 24);
  const laterKey = storageKey + '_later';

  try {
    if (window.localStorage && localStorage.getItem(storageKey)) return;
  } catch { /* private mode */ }

  let meta = null;
  let visitAnswered = false; // Yes / No / Later this page load (persisted answers)
  let closedWithoutAnswer = false; // X close — hide for this load only; refresh shows again
  let timerId = null;
  let armed = false;
  let historyHooked = false;

  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function markDone() {
    try {
      if (window.localStorage) localStorage.setItem(storageKey, '1');
    } catch { /* */ }
  }

  function markLaterSession() {
    try {
      if (window.sessionStorage) sessionStorage.setItem(laterKey, '1');
    } catch { /* */ }
  }

  function isOpen() {
    return !!document.getElementById('bp-claim-overlay');
  }

  function remove() {
    const el = document.getElementById('bp-claim-overlay');
    if (el) el.remove();
  }

  function clearTimer() {
    if (timerId != null) {
      clearTimeout(timerId);
      timerId = null;
    }
  }

  function disarm() {
    armed = false;
    visitAnswered = true;
    clearTimer();
    try {
      window.removeEventListener('popstate', onPopState);
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    } catch { /* */ }
  }

  function canTrigger() {
    return !!(meta && armed && !visitAnswered && !closedWithoutAnswer && !isOpen());
  }

  /** Close (X) dismisses UI only — not an answer; next refresh will ask again. */
  function closeWithoutAnswer() {
    closedWithoutAnswer = true;
    clearTimer();
    remove();
    try {
      window.removeEventListener('beforeunload', onBeforeUnload);
      window.removeEventListener('pagehide', onPageHide);
      document.removeEventListener('visibilitychange', onVisibilityChange);
    } catch { /* */ }
  }

  function triggerShow(/* reason */) {
    if (!canTrigger()) return;
    showPopup(meta);
    clearTimer();
  }

  function setBusy(btns, on) {
    (btns || []).forEach((b) => { if (b) b.disabled = !!on; });
  }

  async function decide(action, msgEl, btns) {
    if (msgEl) msgEl.textContent = 'Saving…';
    setBusy(btns, true);
    try {
      const res = await fetch(
        apiBase + '/api/v1/outreach/public/claim/' + encodeURIComponent(token),
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ action }),
          credentials: 'omit',
          mode: 'cors',
        }
      );
      const data = await res.json().catch(() => ({}));
      if (!res.ok || !data.ok) {
        if (msgEl) msgEl.textContent = (data && data.error) || 'Could not save your choice.';
        setBusy(btns, false);
        return;
      }
      const d = data.data || {};
      if (d.action === 'interested') {
        markDone();
        disarm();
        if (msgEl) msgEl.textContent = 'Thanks — we recorded your interest. BitPype will follow up soon.';
        setTimeout(remove, 1600);
      } else if (d.action === 'uninterested') {
        markDone();
        disarm();
        if (msgEl) msgEl.textContent = 'Got it — we will take this preview down.';
        setTimeout(remove, 1600);
      } else {
        // Maybe later — this visit only; no timer / leave re-fire
        markLaterSession();
        disarm();
        if (msgEl) msgEl.textContent = 'No problem — we will ask again next time.';
        setTimeout(remove, 1200);
      }
    } catch (e) {
      if (msgEl) msgEl.textContent = e.message || 'Network error';
      setBusy(btns, false);
    }
  }

  /** Pull colors/fonts/radius from the live preview page so the popup matches the site. */
  function sampleSiteTheme() {
    const root = document.documentElement;
    const body = document.body || root;
    const cs = window.getComputedStyle(root);
    const bodyCs = window.getComputedStyle(body);
    const pick = (...keys) => {
      for (const k of keys) {
        const v = (cs.getPropertyValue(k) || '').trim();
        if (v) return v;
      }
      return '';
    };
    let primary = pick('--ws-primary', '--primary', '--navy', '--brand', '--accent', '--teal');
    let secondary = pick('--ws-secondary', '--secondary', '--amber', '--gold', '--coral');
    let bg = pick('--ws-bg', '--bg', '--paper', '--cream', '--surface') || bodyCs.backgroundColor || '#ffffff';
    let text = pick('--ws-text', '--text', '--ink', '--fg') || bodyCs.color || '#111111';
    const font = pick('--ws-font', '--font', '--body-font')
      || bodyCs.fontFamily
      || 'system-ui, sans-serif';
    const headingFont = pick('--ws-heading-font', '--heading-font', '--disp', '--display-font')
      || font;

    // Prefer a real primary CTA on the page when CSS vars are missing/odd.
    const sampleBtn = document.querySelector(
      'a.btn-primary, .btn-primary, a.callbtn, .callbtn, a.nav-cta, .nav-cta, header a.btn, .hero a.btn, button.btn'
    );
    let radius = '12px';
    if (sampleBtn) {
      const bcs = window.getComputedStyle(sampleBtn);
      if (!primary || primary === 'rgba(0, 0, 0, 0)' || primary === 'transparent') {
        primary = bcs.backgroundColor || primary;
      }
      if (bcs.borderRadius) radius = bcs.borderRadius.split(' ')[0] || radius;
    }
    if (!primary || primary === 'rgba(0, 0, 0, 0)' || primary === 'transparent') {
      primary = '#0e2a47';
    }
    if (!secondary) secondary = primary;

    // Soft muted text from site text color
    const muted = text;

    return { primary, secondary, bg, text, muted, font, headingFont, radius };
  }

  function ensureClaimStyles(theme) {
    const existing = document.getElementById('bp-claim-style');
    if (existing) existing.remove();
    const style = document.createElement('style');
    style.id = 'bp-claim-style';
    const t = theme || {};
    style.textContent = [
      '#bp-claim-overlay{--bp-c-primary:' + (t.primary || '#0e2a47') + ';',
      '--bp-c-secondary:' + (t.secondary || t.primary || '#0e2a47') + ';',
      '--bp-c-bg:' + (t.bg || '#fff') + ';',
      '--bp-c-text:' + (t.text || '#111') + ';',
      '--bp-c-font:' + (t.font || 'system-ui,sans-serif') + ';',
      '--bp-c-heading:' + (t.headingFont || t.font || 'system-ui,sans-serif') + ';',
      '--bp-c-radius:' + (t.radius || '12px') + ';',
      'position:fixed;inset:0;z-index:2147483000;display:flex;align-items:flex-end;justify-content:center;',
      'padding:16px;background:color-mix(in srgb, var(--bp-c-text) 45%, transparent);',
      'font-family:var(--bp-c-font);color:var(--bp-c-text);}',
      '@media(min-width:640px){#bp-claim-overlay{align-items:center;}}',
      '#bp-claim-card{position:relative;width:min(26rem,100%);background:var(--bp-c-bg);color:var(--bp-c-text);',
      'border-radius:calc(var(--bp-c-radius) + 4px);',
      'box-shadow:0 18px 50px color-mix(in srgb, var(--bp-c-text) 28%, transparent);',
      'padding:1.25rem 1.2rem 1.1rem;border:1px solid color-mix(in srgb, var(--bp-c-text) 14%, transparent);}',
      '#bp-claim-close{position:absolute;top:.55rem;right:.55rem;width:2rem;height:2rem;border:0;',
      'border-radius:999px;background:transparent;color:inherit;opacity:.65;font:inherit;font-size:1.35rem;',
      'line-height:1;cursor:pointer;padding:0;}',
      '#bp-claim-close:hover{opacity:1;background:color-mix(in srgb, var(--bp-c-text) 8%, transparent);}',
      '#bp-claim-card .bp-brand{margin:0 0 .55rem;font-size:.72rem;letter-spacing:.1em;text-transform:uppercase;',
      'color:var(--bp-c-primary);opacity:.85;font-family:var(--bp-c-font);padding-right:1.75rem;font-weight:700;}',
      '#bp-claim-card h2{margin:0 0 .45rem;font-size:1.25rem;line-height:1.25;font-weight:700;',
      'font-family:var(--bp-c-heading);color:var(--bp-c-text);}',
      '#bp-claim-card p{margin:0 0 1rem;line-height:1.45;font-size:1rem;',
      'color:color-mix(in srgb, var(--bp-c-text) 72%, transparent);}',
      '#bp-claim-actions{display:flex;flex-direction:column;gap:.55rem;}',
      '#bp-claim-actions button{font:inherit;font-family:var(--bp-c-font);font-size:1rem;font-weight:700;',
      'padding:.8rem 1rem;border-radius:var(--bp-c-radius);cursor:pointer;border:1px solid transparent;width:100%;}',
      '#bp-claim-yes{background:var(--bp-c-primary);color:#fff;}',
      '#bp-claim-yes:hover{filter:brightness(1.05);}',
      '#bp-claim-no{background:transparent;color:var(--bp-c-text);',
      'border-color:color-mix(in srgb, var(--bp-c-text) 28%, transparent);}',
      '#bp-claim-later{background:color-mix(in srgb, var(--bp-c-secondary) 18%, var(--bp-c-bg));',
      'color:var(--bp-c-text);border-color:color-mix(in srgb, var(--bp-c-secondary) 35%, transparent);}',
      '#bp-claim-msg{min-height:1.2em;margin:.75rem 0 0;font-size:.9rem;',
      'color:color-mix(in srgb, var(--bp-c-text) 75%, transparent);}',
    ].join('');
    document.head.appendChild(style);
  }

  function showPopup(m) {
    if (isOpen()) return;
    const name = (m && m.businessName) || 'your business';
    ensureClaimStyles(sampleSiteTheme());

    const overlay = document.createElement('div');
    overlay.id = 'bp-claim-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'bp-claim-title');
    overlay.innerHTML = [
      '<div id="bp-claim-card">',
      '<button type="button" id="bp-claim-close" aria-label="Close">&times;</button>',
      '<p class="bp-brand">Website preview</p>',
      '<h2 id="bp-claim-title">Do you want to claim this website as yours?</h2>',
      '<p>We built this preview for <strong>' + esc(name) + '</strong>. Say yes if you want to keep it.</p>',
      '<div id="bp-claim-actions">',
      '<button type="button" id="bp-claim-yes">Yes I\'m interested</button>',
      '<button type="button" id="bp-claim-no">No - Delete it</button>',
      '<button type="button" id="bp-claim-later">Maybe later</button>',
      '</div>',
      '<p id="bp-claim-msg" role="status"></p>',
      '</div>',
    ].join('');

    (document.body || document.documentElement).appendChild(overlay);

    const msg = document.getElementById('bp-claim-msg');
    const yesBtn = document.getElementById('bp-claim-yes');
    const noBtn = document.getElementById('bp-claim-no');
    const laterBtn = document.getElementById('bp-claim-later');
    const closeBtn = document.getElementById('bp-claim-close');
    const btns = [yesBtn, noBtn, laterBtn, closeBtn];

    yesBtn.addEventListener('click', () => decide('interested', msg, btns));
    noBtn.addEventListener('click', () => decide('uninterested', msg, btns));
    laterBtn.addEventListener('click', () => decide('later', msg, btns));
    closeBtn.addEventListener('click', () => closeWithoutAnswer());
    overlay.addEventListener('click', (ev) => {
      if (ev.target === overlay) closeWithoutAnswer();
    });
  }

  function onPopState() {
    if (!canTrigger()) return;
    // Stay on the preview and show the custom modal instead of leaving.
    try {
      history.pushState({ bpClaimGuard: 1 }, '', location.href);
    } catch { /* */ }
    triggerShow('back');
  }

  function onVisibilityChange() {
    if (!canTrigger()) return;
    if (document.visibilityState === 'hidden') {
      // Paint modal so it is waiting if they return; also covers some mobile leave cases.
      triggerShow('visibility');
    }
  }

  function onPageHide() {
    if (!canTrigger()) return;
    triggerShow('pagehide');
  }

  function onBeforeUnload(e) {
    // Last resort native prompt — custom modals cannot run here.
    if (!armed || visitAnswered || closedWithoutAnswer || isOpen()) return;
    e.preventDefault();
    e.returnValue = '';
    return '';
  }

  function armTriggers() {
    if (armed || visitAnswered || !meta) return;
    armed = true;

    timerId = setTimeout(() => triggerShow('timer'), DELAY_MS);

    if (!historyHooked) {
      historyHooked = true;
      try {
        history.pushState({ bpClaimGuard: 1 }, '', location.href);
      } catch { /* */ }
      window.addEventListener('popstate', onPopState);
    }

    document.addEventListener('visibilitychange', onVisibilityChange);
    window.addEventListener('pagehide', onPageHide);
    window.addEventListener('beforeunload', onBeforeUnload);
  }

  async function boot() {
    try {
      if (window.sessionStorage && sessionStorage.getItem(laterKey)) return;
    } catch { /* */ }

    const res = await fetch(
      apiBase + '/api/v1/outreach/public/claim/' + encodeURIComponent(token),
      { credentials: 'omit', mode: 'cors' }
    );
    const data = await res.json().catch(() => ({}));
    if (!res.ok || !data.ok) return;
    meta = data.data || {};
    if (
      meta.showClaimPrompt === false
      || meta.intentPositive
      || meta.alreadyInterested
      || meta.alreadyUninterested
    ) {
      markDone();
      return;
    }

    function start() {
      armTriggers();
    }
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', start);
    } else {
      start();
    }
  }

  boot().catch(() => { /* silent */ });
})();
