'use strict';

(async () => {
  const portal = require('../server/clientPortal');
  const email = process.argv[2] || 'elyayertey@gmail.com';
  try {
    const result = await portal.requestAccess(email);
    console.log('OK', JSON.stringify(result));
  } catch (e) {
    console.log('FAIL', e.code || '', e.message || e);
    process.exitCode = 1;
  }
})();
