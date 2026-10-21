#!/bin/bash
# Deploy nested submenu hover-gap fix (nav-sub click reliability).
set -euo pipefail
cd /root/website-scout-web
CTR=website-scout-web-app-1

FILES=(
  src/websiteEngine.js
  public/css/mobile-nav.css
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

echo "--- verify ---"
docker exec "$CTR" node -e "
const eng=require('/app/src/websiteEngine');
const css=eng.siteCss({primary:'#111',baseCss:true});
if(/\\.nav-sub\\{[^}]*margin-top:\\s*6px/.test(css)) process.exit(2);
if(!css.includes('.nav-sub::before')) process.exit(3);
const pages=[
  {slug:'home',title:'Home',sections:[{type:'nav',content:{business_name:'X'}},{type:'hero',content:{headline:'H'}}]},
  {slug:'services',title:'Services',sections:[{type:'nav',content:{business_name:'X'}},{type:'about',content:{heading:'S',body:'x'}}]},
  {slug:'plumbing',title:'Plumbing',menuParent:'services',sections:[{type:'nav',content:{business_name:'X'}},{type:'about',content:{heading:'P',body:'x'}}]},
];
const html=eng.renderPage(pages[0],pages,{primary:'#111',baseCss:true},{});
if(!html.includes('nav-item has-children')||!html.includes('plumbing.html')) process.exit(4);
const fs=require('fs');
const mob=fs.readFileSync('/app/public/css/mobile-nav.css','utf8');
if(!mob.includes('nav-sub::before')||mob.includes('margin-top: 6px')) process.exit(5);
console.log('nav_submenu_hover_ok');
"
curl -sS -o /dev/null -w "portal=%{http_code}\n" https://bitpype.com/portal
echo DONE
