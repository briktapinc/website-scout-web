#!/bin/bash
set -euo pipefail
cd /root/website-scout-web

FILES=(
  src/openaiImages.js
  src/socialMedia.js
  src/seed.js
  src/ipc/system.js
  src/mcpCatalog.js
  server/clientPortal.js
  server/routes/portal.js
  server/settingsKeys.js
  server/platform.js
  public/portal.html
  public/js/portal.js
  public/js/app.js
)

for f in "${FILES[@]}"; do
  docker cp "$f" "website-scout-web-app-1:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs website-scout-web-app-1 --tail 40 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

docker compose exec -T app node -e '
const platform = require("./server/platform");
const fs = require("fs");
const path = require("path");
const Database = require("better-sqlite3");
const NEW_IMAGE = "gpt-image-2.5-sunburst";
const OLD_IMAGE = "gpt-image-1";
(async () => {
  const cur = await platform.getPlatformSetting("social.image_price_usd", "");
  if (cur === "" || cur == null) {
    await platform.setPlatformSetting("social.image_price_usd", "1");
    console.log("seeded platform social.image_price_usd=1");
  } else {
    console.log("platform social.image_price_usd=", cur);
  }

  // Migrate seeded default only — leave custom ai.model.image overrides alone.
  const wsRoot = process.env.WORKSPACE_DATA_DIR || "/app/data/workspaces";
  let migrated = 0;
  if (fs.existsSync(wsRoot)) {
    for (const ent of fs.readdirSync(wsRoot, { withFileTypes: true })) {
      if (!ent.isDirectory()) continue;
      const dbPath = path.join(wsRoot, ent.name, "websitescout.db");
      if (!fs.existsSync(dbPath)) continue;
      try {
        const db = new Database(dbPath);
        const row = db.prepare("SELECT value FROM settings WHERE key = ?").get("ai.model.image");
        if (!row) {
          db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("ai.model.image", NEW_IMAGE);
          migrated++;
        } else if (String(row.value || "").trim() === OLD_IMAGE) {
          db.prepare("UPDATE settings SET value = ? WHERE key = ?").run(NEW_IMAGE, "ai.model.image");
          migrated++;
        }
        db.close();
      } catch (e) {
        console.warn("skip db", dbPath, e.message);
      }
    }
  }
  console.log("migrated ai.model.image defaults:", migrated, "->", NEW_IMAGE);
})().catch((e) => { console.error(e); process.exit(1); });
'

curl -sS -o /dev/null -w "portal_html=%{http_code}\n" https://bitpype.com/portal
curl -sS https://bitpype.com/portal | grep -oE 'post-card|post-pager|cal-scroll|image-price-hint|Generate branded' | sort -u
echo DONE
