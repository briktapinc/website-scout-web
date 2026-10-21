'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),crypto=require('node:crypto');
const root=process.env.BITPYPE_TEST_ROOT||path.resolve(__dirname,'..');
const results=[];
function load(file,mocks,env={}){
 const module={exports:{}};
 vm.runInNewContext(fs.readFileSync(path.join(root,file),'utf8'),{
  module,exports:module.exports,require:n=>{if(Object.hasOwn(mocks,n))return mocks[n];if(!n.startsWith('.'))return require(n);throw new Error('Unexpected dependency '+n)},
  process:{env},console:{...console,error(){}},Buffer,URL,URLSearchParams,Date,setTimeout,clearTimeout,
 },{filename:file});return module.exports;
}
function build(file,known=true){
 const routes=[],rates=[];let calls=0,checked=false,authCalls=0;
 const router={};for(const m of ['get','post'])router[m]=(p,...handlers)=>routes.push({m,p,handlers});
 const exists=load('server/workspaceExists.js',{'./db':{query:async(_sql,params)=>{authCalls++;await Promise.resolve();return known&&params.id===1?[{id:1}]:[]}}});
 const guard=async id=>{await exists.assertWorkspaceExists(id);checked=true};
 const domain=new Proxy({}, {get:(_t,name)=>(...args)=>{assert(checked,'domain touched before workspace validation: '+name);calls++;if(name==='withDb')return args[1]({});return {ok:true,leadId:2}}});
 const mocks={express:{Router:()=>router},'../domain':domain,'../siteModules':{
  parseWorkspaceFromToken:t=>Number(String(t).split('_')[0]),
  getPublicModuleByToken:()=>({ok:true}),getPublicModuleItem:()=>({ok:true}),getPublicBookingSlots:()=>({slots:[]}),createPublicBookingByToken:()=>({ok:true}),
 },'../../src/socialMedia':{},'../workspaceExists':{assertWorkspaceExists:guard},
 '../billing':{workspacePlan:async()=> 'free'},'../appUrls':{socialReturnPath:()=>'/app#/social'},
 '../contactForms':{parseWorkspaceFromToken:t=>Number(String(t).split('_')[0]),getPublicFormByToken:()=>({}),acceptSubmission:async()=>({})},
 '../chatbot':{getPublicConfigByToken:()=>({embed:{lead_id:2},settings:{}}),startOrGetSession:()=>({}),publicSession:()=>({}),postVisitorMessage:()=>({}),getSessionHistory:()=>({}),captureLead:()=>({})},
 '../captcha':{requireCaptcha:()=>((_q,_s,n)=>n()),getCaptchaConfig:async()=>({}),clientIp:()=> 'fixture'},
 '../rateLimit':{rateLimit:opts=>{rates.push(opts);return (_q,_s,n)=>n()}},};
 load(file,mocks,{SESSION_SECRET:'synthetic-secret-for-tests'});
 return {routes,rates,counts:()=>({calls,authCalls})};
}
async function invoke(b,route,req){
 let status=200,body;const res={status(n){status=n;return this},json(v){body=v;return this},send(v){body=v;return this},redirect(v){body=v;return this}};
 for(const h of route.handlers){let next=false;await h(req,res,()=>{next=true});if(!next)break}
 return {status,body};
}
function request(file,id){
 const req={params:{token:`${id}_fixture`},query:{w:String(id),workspaceId:String(id),date:'2030-01-01',session:'fixture'},body:{w:id,action:'approve',message:'fixture'},get:()=> 'fixture'};
 if(file.includes('social'))req.params.token='fixture';return req;
}
async function main(){
 for(const file of ['server/routes/modulesPublic.js','server/routes/designPublic.js','server/routes/socialPublic.js','server/routes/formsPublic.js','server/routes/chatbotPublic.js']){
  for(const known of [false,true]){
   const b=build(file,known);
   const routes=b.routes.filter(r=>r.p!=='/meta/callback');
   for(const route of routes){
    const before=b.counts().calls;const r=await invoke(b,route,request(file,1));
    assert.equal(r.status,known?200:404,file+' '+route.m+' '+route.p);
    assert.equal(b.counts().calls-before,known?1:0);
   }
   assert(b.rates.some(r=>r.windowMs===60000),'missing public read limiter');
  }
  results.push(file+': unknown workspace never reaches domain; valid workspace preserves routes');
  const b=build(file,true);for(const route of b.routes.filter(r=>r.p!=='/meta/callback')){
   for(const id of [0,-1,1.5,Infinity]){const r=await invoke(b,route,request(file,id));assert.equal(r.status,400);}
  }
  assert.equal(b.counts().calls,0);results.push(file+': malformed workspace IDs never reach domain');
 }
 for(const known of [false,true]){
  const b=build('server/routes/socialPublic.js',known);const route=b.routes.find(r=>r.p==='/meta/callback');
  const body=Buffer.from(JSON.stringify({w:1,l:2})).toString('base64url');
  const signature=crypto.createHmac('sha256','synthetic-secret-for-tests').update(body).digest('base64url');
  await invoke(b,route,{query:{code:'fixture',state:body+'.'+signature}});
  assert.equal(b.counts().calls,known?1:0);
 }
 results.push('signed social callback checks workspace existence before domain/OAuth work');
 const b=build('server/routes/socialPublic.js',true);await invoke(b,b.routes.find(r=>r.p==='/meta/callback'),{query:{code:'fixture',state:'bad.signature'}});assert.equal(b.counts().authCalls,0);
 results.push('invalid social state is rejected before workspace lookup');
 let queries=0;const helper=load('server/workspaceExists.js',{'./db':{query:async()=>{queries++;return []}}});
 await assert.rejects(helper.assertWorkspaceExists(999),e=>e.code==='NOT_FOUND');await assert.rejects(helper.assertWorkspaceExists(999),e=>e.code==='NOT_FOUND');assert.equal(queries,1);
 results.push('nonexistent workspaces are negatively cached without tenant database access');
 console.log(JSON.stringify({passed:results.length,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
