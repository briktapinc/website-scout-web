#!/bin/sh
set -e
cd /root/website-scout-web
docker compose up -d app
sleep 5
docker compose exec -T app node -e "require('@noble/hashes/blake3'); console.log('noble ok')"
docker compose exec -T app node scripts/_test-export-assets.js
docker compose exec -T app node scripts/_rematerialize-site1.js
