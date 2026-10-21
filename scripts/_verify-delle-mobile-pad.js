'use strict';
const { openWorkspaceDb } = require('../server/workspaceDb');
const db = openWorkspaceDb(1);
const row = db.prepare('SELECT theme FROM websites WHERE id = 1').get();
const theme = JSON.parse((row && row.theme) || '{}');
const css = String(theme.customCss || '');
const marker = 'mobile edge padding: header + strip';
console.log(JSON.stringify({
  hasManaged: css.includes(marker),
  cssLen: css.length,
  stripRule: css.includes('.strip .wrap'),
  hbarRule: css.includes('.hbar{'),
  brandRule: css.includes('.brand{min-width:0'),
}, null, 2));
