'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),vm=require('vm'),http=require('http'),express=require('express'),Database=require('better-sqlite3');
const analytics=require('../server/siteAnalytics');const root=path.resolve(__dirname,'..');
const databases=new Map();for(const ws of [7,8]){const db=new Database(':memory:');db.exec('CREATE TABLE websites(id INTEGER PRIMARY KEY,lead_id INTEGER,pages TEXT,preview_url TEXT)');db.prepare('INSERT INTO websites VALUES(1,10,?,?)').run('[{"slug":"/","sections":[]}]',`https://bp-w${ws}-s1.pages.dev/`);databases.set(ws,db)}
let opened=0;
const domain={withDb(ws,fn){opened++;assert(databases.has(ws));return fn(databases.get(ws))}};
function load(rel,stubs){const mod={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(root,rel),'utf8'),{module:mod,exports:mod.exports,require:n=>n in stubs?stubs[n]:require(n),console,Date,Buffer,URL,SyntaxError},{filename:rel});return mod.exports}
const limits={rateLimit:()=>((_q,_s,next)=>next())};
const publicRouter=load('server/routes/siteAnalyticsPublic.js',{'../domain':domain,'../workspaceExists':{assertWorkspaceExists:async ws=>{if(!databases.has(ws))throw Object.assign(new Error('Not found'),{code:'NOT_FOUND',status:404})}},'../rateLimit':limits,'../siteAnalytics':analytics});
const privateRouter=load('server/routes/portal.js',{'../domain':domain,'../siteAnalytics':analytics,'../clientPortal':{findById:async id=>({id,status:'active',workspace_id:id===1?7:8,lead_id:10})},'../captcha':{requireCaptcha:()=>((_q,_s,next)=>next())},'../rateLimit':limits});
const app=express();app.use(express.json({limit:'1kb'}));app.use((req,_res,next)=>{req.session=req.get('x-fixture-user')?{clientPortalId:Number(req.get('x-fixture-user')),clientLastActiveAt:Date.now()}:{};next()});app.use('/private',privateRouter);app.use('/public',publicRouter);
let server;let groups=0;
(async()=>{try{
 server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
 async function req(p,{user,origin,body,type='application/json',method=body?'POST':'GET'}={}){return fetch(base+p,{method,headers:{...(user?{'x-fixture-user':String(user)}:{}),...(origin?{Origin:origin}:{}),...(body?{'Content-Type':type}:{})},body:body?JSON.stringify(body):undefined})}
 assert.equal((await req('/private/analytics')).status,401);groups++;
 assert.equal((await req('/private/analytics',{user:1,body:{internalEnabled:true,googleIds:['G-ABC1234567'],workspaceId:8,leadId:999}})).status,200);groups++;
 const one=await (await req('/private/analytics',{user:1})).json();assert.equal(one.data.internalEnabled,true);assert.equal((await (await req('/private/analytics',{user:2})).json()).data.internalEnabled,false);groups++;
 const token=databases.get(7).prepare('SELECT token FROM site_analytics_settings').get().token;
 const origin='https://bp-w7-s1.pages.dev';
 const c=await req('/public/'+token+'/config',{origin});assert.equal(c.status,200);assert.equal(c.headers.get('access-control-allow-origin'),'*');assert.equal(c.headers.get('cache-control'),'no-store');groups++;
 assert.equal((await req('/public/'+token+'/config',{origin:'https://evil.example'})).status,404);groups++;
 const before=opened;assert.equal((await req('/public/999_'+'a'.repeat(48)+'/config',{origin})).status,404);assert.equal(opened,before);groups++;
 const e=await req('/public/'+token+'/events',{origin,body:{event:'pageview',path:'/',consent:true},type:'text/plain'});assert.equal(e.status,204);groups++;
 const stats=(await (await req('/private/analytics',{user:1})).json()).data;assert.equal(stats.visits,1);assert.equal((await (await req('/private/analytics',{user:2})).json()).data.visits,0);groups++;
 assert.equal((await req('/public/'+token+'/events',{origin,body:{event:'click',kind:'phone',path:'/?email=secret',consent:true},type:'text/plain'})).status,400);groups++;
 assert.equal((await req('/public/'+token+'/events',{origin,body:{event:'pageview',path:'/',consent:true,padding:'x'.repeat(2000)},type:'text/plain'})).status,413);groups++;
 assert.equal((await req('/private/analytics',{user:1,body:{internalEnabled:true,googleIds:['GTM-ABCDEF01']}})).status,400);groups++;
 console.log(JSON.stringify({passed:true,groups,checks:['real portal auth guard','session-derived tenant/lead scope','public CORS','origin validation','nonexistent workspace denial before opening SQLite','consented event to private report','payload limits','tag validation']}));
}finally{if(server)await new Promise(r=>server.close(r));for(const db of databases.values())db.close()}})().catch(e=>{console.error(e);process.exitCode=1});
