'use strict';
const db=require('/app/server/db');
(async()=>{let ready=false;for(let i=0;i<100;i++){try{await db.ping();ready=true;break}catch{}await new Promise(resolve=>setTimeout(resolve,500));}if(!ready)throw Error('Isolated MySQL not ready');require('/app/tests/job-concurrency-regressions.cjs');})().catch(e=>{console.error(e.message);process.exit(1)});
