'use strict';

// Tailscale helpers for remote MCP. Uses the local `tailscale` CLI when present.
// Never requires Tailscale to run the app — status is informational.

const { execFile } = require('child_process');
const { promisify } = require('util');
const execFileAsync = promisify(execFile);

const EXEC_OPTS = {
  timeout: 4000,
  windowsHide: true,
  maxBuffer: 1024 * 1024,
};

async function runTailscale(args) {
  try {
    const { stdout, stderr } = await execFileAsync('tailscale', args, EXEC_OPTS);
    return { ok: true, stdout: String(stdout || ''), stderr: String(stderr || '') };
  } catch (e) {
    const code = e && e.code;
    const notFound = code === 'ENOENT' || /not recognized|not found/i.test(String(e.message || ''));
    return {
      ok: false,
      notFound,
      error: e && e.message ? e.message : String(e),
      stdout: String((e && e.stdout) || ''),
      stderr: String((e && e.stderr) || ''),
    };
  }
}

function firstIpv4(text) {
  const m = String(text || '').match(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/);
  return m ? m[1] : '';
}

/**
 * @returns {Promise<{
 *   installed: boolean,
 *   running: boolean,
 *   ipv4: string,
 *   dnsName: string,
 *   backendState: string,
 *   error: string,
 *   serveHint: string,
 * }>}
 */
async function getStatus() {
  const out = {
    installed: false,
    running: false,
    ipv4: '',
    dnsName: '',
    backendState: '',
    error: '',
    serveHint: '',
  };

  const ip = await runTailscale(['ip', '-4']);
  if (ip.notFound) {
    out.error = 'Tailscale CLI not found. Install Tailscale, then sign in on this machine.';
    return out;
  }
  out.installed = true;
  if (!ip.ok) {
    out.error = (ip.stderr || ip.error || 'tailscale ip failed').trim();
    return out;
  }
  out.ipv4 = firstIpv4(ip.stdout);
  if (!out.ipv4) {
    out.error = 'Tailscale is installed but has no IPv4 yet. Sign in with: tailscale up';
    return out;
  }

  const st = await runTailscale(['status', '--json']);
  if (st.ok) {
    try {
      const j = JSON.parse(st.stdout);
      out.backendState = String(j.BackendState || '');
      out.running = out.backendState === 'Running' || !!out.ipv4;
      const self = j.Self || {};
      const dns = self.DNSName || (Array.isArray(self.DNSName) ? self.DNSName[0] : '');
      out.dnsName = String(dns || '').replace(/\.$/, '');
      if (!out.dnsName && self.HostName) out.dnsName = String(self.HostName);
    } catch {
      out.running = !!out.ipv4;
    }
  } else {
    out.running = !!out.ipv4;
  }

  out.serveHint = out.dnsName
    ? `Optional: tailscale serve --bg ${8742}`
    : 'Optional: tailscale serve can publish the MCP port on your MagicDNS name.';
  return out;
}

module.exports = { getStatus, runTailscale };
