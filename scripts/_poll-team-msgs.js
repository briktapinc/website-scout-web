'use strict';
const https = require('https');
(async () => {
  const platform = require('../server/platform');
  const u = await platform.getPlatformSetting('smtp.user', '');
  const s = await platform.getPlatformSetting('smtp.pass', '');
  const auth = Buffer.from(u + ':' + s).toString('base64');
  function get(path) {
    return new Promise((resolve, reject) => {
      https.get({
        hostname: 'api.mailjet.com',
        path,
        headers: { Authorization: 'Basic ' + auth, Accept: 'application/json' },
      }, (r) => {
        let d = '';
        r.on('data', (c) => { d += c; });
        r.on('end', () => {
          try { resolve(JSON.parse(d)); } catch { resolve(d); }
        });
      }).on('error', reject);
    });
  }
  const recent = await get('/v3/REST/message?Limit=8&Sort=ArrivedAt+DESC');
  for (const m of (recent.Data || [])) {
    console.log(JSON.stringify({
      ID: String(m.ID),
      Status: m.Status,
      ArrivedAt: m.ArrivedAt,
      ContactAlt: m.ContactAlt,
    }));
  }
})().catch((e) => { console.error(e); process.exit(1); });
