#!/bin/bash
set -e
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
echo CTR=$CTR
docker cp /root/website-scout-web/src/websiteEngine.js "$CTR:/app/src/websiteEngine.js"
docker restart "$CTR"
sleep 8
CTR=$(docker ps -q -f name=website-scout-web-app | head -1)
docker exec -w /app "$CTR" node -e "
const domain=require('./server/domain');
(async()=>{
  for (const id of [1,2,3]) {
    const r=await domain.sitesPreview(1,id,{force:true});
    console.log('published', id, r && (r.url||r.previewUrl||r));
  }
})().catch(e=>{console.error(e);process.exit(1);});
"
