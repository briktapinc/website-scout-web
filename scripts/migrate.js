'use strict';

require('dotenv').config();
const { migrate, ping } = require('../server/db');

(async () => {
  await ping();
  await migrate();
  console.log('Migration complete.');
  process.exit(0);
})().catch((e) => {
  console.error(e);
  process.exit(1);
});
