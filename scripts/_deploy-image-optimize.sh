#!/bin/bash
set -euo pipefail
cd /root/website-scout-web
CTR=website-scout-web-app-1

for f in \
  src/imageOptimize.js \
  src/pexels.js \
  src/openaiImages.js \
  src/mcpCatalog.js \
  src/mcpParityTools.js \
  src/mcp.js \
  server/domain.js \
  server/mcp.js \
  server/clientPortal.js \
  server/clientMcp.js \
  server/routes/domainApi.js \
  server/routes/portal.js
do
  echo "docker cp $f"
  docker cp "/root/website-scout-web/$f" "$CTR:/app/$f"
done

docker restart "$CTR"
echo "waiting for listen..."
for i in $(seq 1 90); do
  if docker logs "$CTR" --tail 80 2>&1 | grep -q 'listening on'; then
    echo up
    break
  fi
  sleep 1
done

docker exec "$CTR" node -e '
  const io = require("/app/src/imageOptimize");
  const domain = require("/app/server/domain");
  if (typeof domain.sitesOptimizeImages !== "function") throw new Error("sitesOptimizeImages missing");
  const cat = require("/app/src/mcpCatalog");
  if (!cat.tools.some(t => t.name === "website.optimizeImages")) throw new Error("catalog missing tool");
  console.log("image_optimize_ok");
  (async () => {
    const sharp = require("sharp");
    const big = await sharp({
      create: { width: 2800, height: 1600, channels: 3, background: { r: 10, g: 20, b: 30 } },
    }).jpeg({ quality: 92 }).toBuffer();
    const r = await io.optimizeBuffer(big, { fileName: "hero.jpg", role: "photo" });
    console.log("smoke", JSON.stringify({
      before: r.bytesBefore,
      after: r.bytesAfter,
      ext: r.ext,
      reason: r.reason,
    }));
  })().catch((e) => { console.error(e); process.exit(1); });
'
echo DONE
