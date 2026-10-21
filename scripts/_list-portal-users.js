'use strict';
const { query } = require('../server/db');
query('SELECT id, email, status FROM client_portal_users ORDER BY id ASC LIMIT 10')
  .then((rows) => {
    console.log(JSON.stringify(rows, null, 2));
    process.exit(0);
  })
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
