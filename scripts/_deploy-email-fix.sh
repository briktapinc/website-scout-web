#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/designJobs.js
  src/mcpCatalog.js
  src/mcp.js
  src/mcpParityTools.js
  src/ipc/design.js
  server/domain.js
  server/routes/domainApi.js
  server/mcp.js
  public/js/app.js
  scripts/_set-bitpype-name.js
  scripts/_test-platform-smtp.js
  scripts/test-smtp-send.js
)

for f in "${FILES[@]}"; do
  if [ -f "$f" ]; then
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
  if docker logs website-scout-web-app-1 --tail 20 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker compose exec -T app node scripts/_set-bitpype-name.js
docker compose exec -T app node scripts/_test-platform-smtp.js eliayertey@gmail.com
docker compose exec -T app node scripts/test-smtp-send.js /app/data/workspaces/1/websitescout.db eliayertey@gmail.com
