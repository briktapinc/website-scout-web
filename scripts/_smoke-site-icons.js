'use strict';
const i = require('../src/siteIcons');
const e = require('../src/websiteEngine');

const svg = i.renderIconSvg('zap');
if (!svg.includes('ws-icon')) throw new Error('no svg');

const html = e.sectionToHtml(
  { type: 'services', content: { items: [{ name: 'Wiring', description: 'x', icon: 'zap' }] } },
  { baseCss: true },
  null
);
if (!html.includes('data-ws-icon="zap"')) throw new Error(html.slice(0, 400));

const social = e.sectionToHtml(
  { type: 'social_links', content: { links: [{ network: 'instagram', url: 'https://instagram.com/x' }] } },
  { baseCss: false },
  null
);
if (!social.includes('ws-social') || !social.includes('instagram')) throw new Error(social);

try {
  i.assertKnownIcons([{ sections: [{ type: 'services', content: { items: [{ icon: 'not-a-real-icon' }] } }] }]);
  throw new Error('should fail');
} catch (err) {
  if (err.code !== 'INVALID_ICON') throw err;
}

const css = e.siteCss({ baseCss: false, customCss: '.x{}' });
if (!css.includes('.ws-icon')) throw new Error('no icon css in baseCss:false');

console.log('ok icons');
