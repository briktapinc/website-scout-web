'use strict';

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function argLines(schema) {
  const props = (schema && schema.properties) || {};
  const required = new Set((schema && schema.required) || []);
  const keys = Object.keys(props);
  if (!keys.length) return ['No arguments.'];
  return keys.map((key) => {
    const p = props[key] || {};
    const bits = [p.type || 'any'];
    if (required.has(key)) bits.push('required');
    if (p.minimum != null) bits.push('min ' + p.minimum);
    if (p.maximum != null) bits.push('max ' + p.maximum);
    if (p.maxLength != null) bits.push('max length ' + p.maxLength);
    if (p.default != null) bits.push('default ' + p.default);
    if (p.description) bits.push(p.description);
    return { key, text: bits.join(' · ') };
  });
}

function bootMcp() {
  const root = document.getElementById('mcp-root');
  if (!root || root.dataset.wired) return;
  root.dataset.wired = '1';

  const configEl = document.getElementById('mcp-config');
  const copyBtn = document.getElementById('mcp-copy');
  const copyStatus = document.getElementById('mcp-copy-status');
  const tsConfigEl = document.getElementById('mcp-ts-config');
  const tsStatusEl = document.getElementById('mcp-ts-status');
  let connectionText = '';
  let tsConnectionText = '';

  async function copyText(text, okMsg) {
    try {
      await navigator.clipboard.writeText(text);
      copyStatus.hidden = false;
      copyStatus.textContent = okMsg;
    } catch {
      copyStatus.hidden = false;
      copyStatus.textContent = 'Could not copy automatically. Select the text and copy it.';
    }
  }

  copyBtn.addEventListener('click', () => {
    copyText(connectionText || configEl.textContent || '', 'Copied local stdio connection.');
  });
  document.getElementById('mcp-ts-copy').addEventListener('click', () => {
    copyText(tsConnectionText || tsConfigEl.textContent || '', 'Copied Tailscale MCP config (includes bearer token).');
  });

  function paintRemote(remote) {
    if (!remote) return;
    const ts = remote.tailscale || {};
    const http = remote.http || {};
    const urls = remote.urls || {};
    const urlInput = document.getElementById('mcp-public-url');
    const portInput = document.getElementById('mcp-listen-port');
    if (urlInput && document.activeElement !== urlInput) {
      const stored = String(
        urls.publicUrlSetting != null ? urls.publicUrlSetting : (http.publicUrl || '')
      ).trim();
      // Show the resolved client endpoint when auto-detecting; stored value may be base or full /ws URL.
      urlInput.value = stored || urls.mcp || remote.suggestedPublicUrl || '';
      urlInput.placeholder = remote.suggestedPublicUrl || 'http://your-machine.ts.net:8742/ws';
    }
    if (portInput && document.activeElement !== portInput) {
      portInput.value = String(http.port || 8742);
    }
    const rows = [
      ['Tailscale installed', ts.installed ? 'yes' : 'no'],
      ['Tailscale running', ts.running ? 'yes' : 'no'],
      ['Tailscale IPv4', ts.ipv4 || '—'],
      ['MagicDNS', ts.dnsName || '—'],
      ['Public URL mode', urls.custom ? 'custom' : 'auto-detect'],
      ['HTTP MCP', http.listening
        ? (http.listenerSource === 'external'
          ? `listening :${http.port} (started outside app)`
          : `listening :${http.port}`)
        : 'stopped'],
      ['Client MCP URL (/ws)', urls.mcp || '—'],
      ['ChatGPT-style URL (/mcp)', urls.mcpAlias || '—'],
      ['Local tunnel target', urls.localMcp || '—'],
      ['Bearer token', http.token ? http.token : '—'],
    ];
    if (ts.error) rows.push(['Tailscale note', ts.error]);
    document.getElementById('mcp-ts-facts').innerHTML = rows.map(([k, v]) =>
      `<li><span class="mcp-k">${esc(k)}</span> — ${esc(v || '—')}</li>`
    ).join('');

    const primary = (remote.examples && remote.examples[0] && remote.examples[0].body) || '';
    tsConnectionText = primary;
    tsConfigEl.textContent = primary || 'Start HTTP MCP after Tailscale is signed in.';
    document.getElementById('mcp-ts-examples').innerHTML = (remote.examples || []).slice(1).map((ex) =>
      `<div class="mcp-example"><h3>${esc(ex.title)}</h3><p class="muted">${esc(ex.note)}</p><pre class="mcp-config">${esc(ex.body)}</pre></div>`
    ).join('');
    if (http.listening) {
      const via = http.listenerSource === 'external' ? ' (external process on this port)' : '';
      tsStatusEl.textContent = `HTTP MCP listening :${http.port}${via}. Cursor/Muse → ${urls.mcp || 'URL below'}; ChatGPT tunnel → ${urls.localMcp || '127.0.0.1/mcp'}.`;
    } else {
      tsStatusEl.textContent = 'HTTP MCP is stopped. Start it for Cursor/Muse (URL+Bearer) or as the target for ChatGPT tunnel-client.';
    }
  }

  async function refreshHttp() {
    try {
      const st = await window.api.invoke('mcp:httpStatus');
      if (st && st.remote) paintRemote(st.remote);
      return st;
    } catch (e) {
      tsStatusEl.textContent = e.message || String(e);
      return null;
    }
  }

  async function refreshHttpUntilListening(maxAttempts = 12) {
    for (let i = 0; i < maxAttempts; i++) {
      const st = await refreshHttp();
      if (st && st.remote && st.remote.http && st.remote.http.listening) return st;
      await new Promise((r) => setTimeout(r, 200));
    }
    return refreshHttp();
  }

  document.getElementById('mcp-url-save').addEventListener('click', async () => {
    tsStatusEl.textContent = 'Saving…';
    try {
      const url = document.getElementById('mcp-public-url').value;
      const port = document.getElementById('mcp-listen-port').value;
      const portRes = await window.api.invoke('mcp:setListenPort', { port: Number(port) });
      const urlRes = await window.api.invoke('mcp:setPublicUrl', { url });
      if (urlRes.remote) paintRemote(urlRes.remote);
      else if (portRes.remote) paintRemote(portRes.remote);
      else await refreshHttp();
      tsStatusEl.textContent = 'Public URL and listen port saved. Copy the Tailscale config again.';
    } catch (e) { tsStatusEl.textContent = e.message || String(e); }
  });
  document.getElementById('mcp-url-detect').addEventListener('click', async () => {
    try {
      const st = await window.api.invoke('mcp:httpStatus');
      const suggested = st && st.remote && st.remote.suggestedPublicUrl;
      if (!suggested) {
        tsStatusEl.textContent = 'No Tailscale host detected yet.';
        return;
      }
      document.getElementById('mcp-public-url').value = suggested;
      const res = await window.api.invoke('mcp:setPublicUrl', { url: suggested });
      if (res.remote) paintRemote(res.remote);
      tsStatusEl.textContent = 'Filled and saved the detected Tailscale URL.';
    } catch (e) { tsStatusEl.textContent = e.message || String(e); }
  });
  document.getElementById('mcp-url-clear').addEventListener('click', async () => {
    try {
      document.getElementById('mcp-public-url').value = '';
      const res = await window.api.invoke('mcp:setPublicUrl', { url: '' });
      if (res.remote) paintRemote(res.remote);
      tsStatusEl.textContent = 'Cleared. Client URL will auto-detect from Tailscale.';
    } catch (e) { tsStatusEl.textContent = e.message || String(e); }
  });

  document.getElementById('mcp-http-start').addEventListener('click', async () => {
    tsStatusEl.textContent = 'Starting…';
    try {
      const port = document.getElementById('mcp-listen-port').value;
      const url = document.getElementById('mcp-public-url').value;
      if (port) await window.api.invoke('mcp:setListenPort', { port: Number(port) });
      if (url != null) await window.api.invoke('mcp:setPublicUrl', { url });
      const startRes = await window.api.invoke('mcp:httpStart');
      if (startRes && startRes.remote) paintRemote(startRes.remote);
      if (startRes && startRes.ok === false) {
        tsStatusEl.textContent = startRes.error || 'HTTP MCP did not become ready. Check port 8742 or stop the other process.';
        await refreshHttpUntilListening(5);
        return;
      }
      await refreshHttpUntilListening();
      const st = await window.api.invoke('mcp:httpStatus');
      if (st && st.remote && st.remote.http && st.remote.http.listening) {
        const via = st.remote.http.listenerSource === 'external'
          ? ' (adopted existing listener on this port)'
          : '';
        tsStatusEl.textContent = `HTTP MCP is listening on port ${st.remote.http.port}${via}. Use ${st.remote.urls.mcp} in Cursor.`;
      }
    } catch (e) { tsStatusEl.textContent = e.message || String(e); }
  });
  document.getElementById('mcp-http-stop').addEventListener('click', async () => {
    tsStatusEl.textContent = 'Stopping…';
    try {
      await window.api.invoke('mcp:httpStop');
      await refreshHttp();
    } catch (e) { tsStatusEl.textContent = e.message || String(e); }
  });
  document.getElementById('mcp-http-rotate').addEventListener('click', async () => {
    if (!window.confirm('Rotate the HTTP MCP bearer token? Connected clients must update their config.')) return;
    tsStatusEl.textContent = 'Rotating token…';
    try {
      await window.api.invoke('mcp:httpRotateToken');
      await refreshHttp();
      tsStatusEl.textContent = 'Token rotated. Copy the Tailscale config again.';
    } catch (e) { tsStatusEl.textContent = e.message || String(e); }
  });

  window.api.invoke('mcp:setup').then((info) => {
    connectionText = info.config || '';
    configEl.textContent = connectionText || 'No connection details returned.';

    const examplesEl = document.getElementById('mcp-examples');
    const examples = info.examples || [];
    examplesEl.innerHTML = examples.map((ex) => `<div class="mcp-example">
        <h3>${esc(ex.title)}</h3>
        <p class="muted">${esc(ex.note)}</p>
        <pre class="mcp-config">${esc(ex.body)}</pre>
      </div>`).join('');

    const facts = document.getElementById('mcp-facts');
    const protocols = (info.protocolVersions && info.protocolVersions.length)
      ? info.protocolVersions.join(', ')
      : info.protocolVersion;
    const rows = [
      ['Name', info.server && info.server.name],
      ['Version', info.server && info.server.version],
      ['Protocols', protocols],
      ['Local transport', info.transport + ' · ' + info.framing],
      ['Remote transport', 'HTTP /ws over Tailscale'],
      ['Command', info.command],
      ['Args', (info.args || []).join(' ')],
      ['WS_DB_PATH', info.env && info.env.WS_DB_PATH],
    ];
    facts.innerHTML = rows.map(([k, v]) =>
      `<li><span class="mcp-k">${esc(k)}</span> — ${esc(v || '—')}</li>`
    ).join('');

    document.getElementById('mcp-notes').innerHTML = (info.notes || [])
      .map((n) => `<li>${esc(n)}</li>`).join('');

    const tools = info.tools || [];
    document.getElementById('mcp-tool-count').textContent =
      tools.length + ' tools. This is the same list tools/list returns.';
    document.getElementById('mcp-tools').innerHTML = tools.map((tool) => {
      const args = argLines(tool.schema).map((line) => {
        if (typeof line === 'string') return `<li>${esc(line)}</li>`;
        return `<li><span class="mcp-k">${esc(line.key)}</span> — ${esc(line.text)}</li>`;
      }).join('');
      return `<article class="card mcp-tool">
        <h3>${esc(tool.name)}</h3>
        <p>${esc(tool.description)}</p>
        <ul class="mcp-args">${args}</ul>
      </article>`;
    }).join('');

    const activity = document.getElementById('mcp-activity');
    const recent = info.recent || [];
    if (!recent.length) {
      activity.innerHTML = '<li class="muted">No MCP calls yet. After a client connects, each tool call is written here with secrets redacted.</li>';
    } else {
      activity.innerHTML = recent.map((row) =>
        `<li><span>${esc(row.message)}</span><div class="timestamp">${esc(row.area)} · ${esc(row.at)}</div></li>`
      ).join('');
    }

    paintRemote(info.remote);
    refreshHttp();
  }).catch((err) => {
    configEl.textContent = 'Could not load MCP setup: ' + (err && err.message ? err.message : err);
  });
}

window.pageInit = bootMcp;
