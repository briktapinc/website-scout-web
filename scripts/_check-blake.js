'use strict';
const crypto = require('crypto');
console.log(crypto.getHashes().filter((h) => /blake|sha3|sha256/i.test(h)).join(','));
try {
  require('blake3');
  console.log('blake3 package: yes');
} catch {
  console.log('blake3 package: no');
}
