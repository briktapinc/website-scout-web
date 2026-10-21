#!/bin/bash
set -euo pipefail
cd /root/website-scout-web
CTR=website-scout-web-app-1

FILES=(
  src/siteStructure.js
  src/designJobs.js
  src/defaultDesignInstructions.js
  src/mcpCatalog.js
  src/mcpParityTools.js
  server/clientPortal.js
  server/routes/portal.js
  server/domain.js
  server/routes/domainApi.js
  server/mcp.js
  public/js/portal.js
  public/portal.html
  public/portal.vps.html
  public/js/api.js
  public/js/app.js
  public/styles.css
)

for f in "${FILES[@]}"; do
  docker exec "$CTR" mkdir -p "/app/$(dirname "$f")"
  docker cp "$f" "$CTR:/app/$f"
  echo "copied $f"
done

docker compose restart app
echo "waiting for listen..."
for i in $(seq 1 40); do
  if docker logs "$CTR" --tail 50 2>&1 | grep -q 'listening on'; then
    echo "up"
    break
  fi
  sleep 1
done

echo "--- live checks ---"
curl -sS -o /dev/null -w "portal_html=%{http_code}\n" https://bitpype.com/portal
curl -sS https://bitpype.com/js/portal.js | grep -c 'data-action="nest"' || true
curl -sS https://bitpype.com/js/app.js | grep -c 'menu-nest' || true
docker exec "$CTR" node -e "
const r=require('fs').readFileSync('/app/server/routes/portal.js','utf8');
if(!r.includes('req.client.workspace_id')) process.exit(2);
const s=require('/app/src/siteStructure');
const pages=[{slug:'home',title:'Home',sections:[]},{slug:'services',title:'Services',sections:[]},{slug:'plumbing',title:'Plumbing',sections:[]}];
const nested=s.applyMenuAction(pages,{action:'nest',fromIndex:2});
if(!nested.changed||nested.pages[2].menuParent!=='services') process.exit(3);
const cat=require('/app/src/mcpCatalog');
const names=cat.tools.map(t=>t.name);
if(!names.includes('website.structure')||!names.includes('website.structure.reorder')) process.exit(4);
console.log('structure_nest_mcp_ok');
"
echo DONE
