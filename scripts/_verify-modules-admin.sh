#!/bin/bash
set -euo pipefail
CTR=website-scout-web-app-1
for i in $(seq 1 40); do
  if docker logs "$CTR" --tail 40 2>&1 | grep -q 'listening on'; then
    echo up
    break
  fi
  sleep 1
done
curl -sS -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
echo -n "js_hits="
curl -sS "https://bitpype.com/js/portal.js?v=modules-admin-tabs1" | grep -cE 'MODULE_NAV_GROUPS|setFormsPane|syncModulesPaneTabs' || true
echo -n "html_hits="
curl -sS https://bitpype.com/portal | grep -cE 'modules-admin|forms-pane-tabs|modules-admin-tabs1' || true
docker exec "$CTR" node -e "require('/app/server/siteModules'); require('/app/src/siteStructure'); console.log('server_ok')"
echo DONE
