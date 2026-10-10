'use strict';

// Tiny hash router. Each route loads renderer/<page>.html into #view,
// then loads renderer/<page>.js via a dynamic script tag and calls its
// init() export if present (the page script sets window.pageInit = init).

(function () {
  const KNOWN_ROUTES = ['dashboard', 'leads', 'websites', 'design', 'outreach', 'pipeline', 'mcp', 'settings'];
  const view = document.getElementById('view');

  function setActiveNav(route) {
    document.querySelectorAll('.nav-links a').forEach((a) => {
      const on = a.dataset.route === route;
      a.classList.toggle('active', on);
      if (on) a.setAttribute('aria-current', 'page');
      else a.removeAttribute('aria-current');
    });
  }

  async function refreshShellStatus() {
    const el = document.getElementById('shell-automation');
    if (!el || !window.api || typeof window.api.invoke !== 'function') return;
    try {
      const stats = await window.api.invoke('dashboard:stats');
      const paused = !!(stats && stats.automationPaused);
      el.classList.toggle('is-paused', paused);
      el.classList.toggle('is-running', !paused);
      el.textContent = paused ? 'Automation paused' : 'Automation running';
    } catch {
      el.textContent = 'Automation status unavailable';
    }
  }

  function showError(message) {
    view.innerHTML = '';
    const div = document.createElement('div');
    div.className = 'card error-card';
    const h = document.createElement('h2');
    h.textContent = 'Page failed to load';
    const p = document.createElement('p');
    p.textContent = message;
    div.append(h, p);
    view.appendChild(div);
  }

  function loadScript(src) {
    return new Promise((resolve, reject) => {
      // Remove any previously injected page script.
      const old = document.getElementById('page-script');
      if (old) old.remove();
      const script = document.createElement('script');
      script.id = 'page-script';
      script.src = src;
      script.onload = resolve;
      script.onerror = () => reject(new Error('Could not load ' + src));
      document.body.appendChild(script);
    });
  }

  async function navigate() {
    const hash = window.location.hash || '#/dashboard';
    const match = hash.match(/^#\/([a-z-]+)/);
    const route = match ? match[1] : null;
    setActiveNav(route);

    if (!route || !KNOWN_ROUTES.includes(route)) {
      showError('Unknown route: ' + (route || '(none)') + '. Choose a page from the navigation bar.');
      return;
    }

    try {
      const res = await fetch(route + '.html');
      if (!res.ok) throw new Error('HTTP ' + res.status);
      view.innerHTML = await res.text();
    } catch (err) {
      showError('Could not load ' + route + '.html (' + err.message + '). This page may not be implemented yet.');
      return;
    }

    try {
      await loadScript(route + '.js');
      // Page scripts expose their initializer as window.pageInit.
      if (typeof window.pageInit === 'function') {
        const init = window.pageInit;
        window.pageInit = null;
        await init(view);
      }
      refreshShellStatus();
    } catch (err) {
      showError('Could not load ' + route + '.js (' + err.message + ').');
    }
  }

  window.refreshShellStatus = refreshShellStatus;
  window.addEventListener('hashchange', navigate);
  document.addEventListener('DOMContentLoaded', navigate);
})();
