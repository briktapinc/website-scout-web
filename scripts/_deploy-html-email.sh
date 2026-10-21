#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/emailTemplate.js
  src/email.js
  src/designJobs.js
  src/socialMedia.js
  server/mailer.js
  server/invites.js
  server/passwordReset.js
  server/clientPortal.js
  public/brand/bitpype-mark.svg
  scripts/test-smtp-send.js
  scripts/_test-platform-smtp.js
)

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
    mkdir -p "$(dirname "/tmp/ws-deploy-check/$f")"
    docker exec website-scout-web-app-1 mkdir -p "/app/$(dirname "$f")"
    docker cp "$f" "website-scout-web-app-1:/app/$f"
    echo "copied $f"
  else
    echo "MISSING $f" >&2
    exit 1
  fi
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 30); do
  if docker logs website-scout-web-app-1 --tail 30 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

TO="${1:-eliayertey@gmail.com}"
docker compose exec -T app node scripts/_test-platform-smtp.js "$TO"
docker compose exec -T app node scripts/test-smtp-send.js /app/data/workspaces/1/websitescout.db "$TO"
echo "DONE sample to $TO"
