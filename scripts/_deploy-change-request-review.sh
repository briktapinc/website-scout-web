#!/bin/bash
# Deploy instruction-review layer for client change requests.
set -euo pipefail
cd /root/website-scout-web
CTR=website-scout-web-app-1

FILES=(
  src/changeRequestReview.js
  src/designReview.js
  src/designJobs.js
  src/defaultDesignInstructions.js
  src/emailRedesign.js
  src/mcpCatalog.js
  src/mcp.js
  server/mcp.js
  server/clientMcp.js
  server/domain.js
  scripts/_smoke-change-request-review.js
)

for f in "${FILES[@]}"; do
  docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$CTR:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs "$CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

echo "--- smoke ---"
docker exec "$CTR" node /app/scripts/_smoke-change-request-review.js
echo DONE
