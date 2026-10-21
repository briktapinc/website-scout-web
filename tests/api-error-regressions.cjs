'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm');
const root=path.resolve(process.env.BITPYPE_TEST_ROOT||path.join(__dirname,'..'));
const staff=fs.readFileSync(path.join(root,'public/js/api.js'),'utf8');
const portal=fs.readFileSync(path.join(root,'public/js/portal.js'),'utf8');
const start=portal.indexOf('  async function api('),end=portal.indexOf('  const PORTAL_PANELS',start);
let groups=0;
function fixture(kind,status,data,badJson=false){
 let auth=0;const ctx={window:{location:{hash:'#/websites'}},localStorage:{getItem(){return null}},URLSearchParams,Error,fetch:async()=>({status,ok:status>=200&&status<300,statusText:'',json:async()=>{if(badJson)throw Error('not JSON');return data}}),document:{getElementById(){return null}},showPortalLogin(){auth++}};
 vm.createContext(ctx);
 vm.runInContext(kind==='staff'?staff:portal.slice(start,end)+';window.api=api;',ctx);
 const api=kind==='staff'?ctx.window.ScoutApi: {request:ctx.window.api};
 if(kind==='staff')api.setOnAuthRequired(()=>auth++);
 return {ctx,api,auth:()=>auth};
}
async function failure(f,method){try{await(method?f.api[method](1):f.api.request('/fixture'));assert.fail('expected failure')}catch(e){assert.notEqual(e.code,'ERR_ASSERTION');return e}}
(async()=>{
 for(const kind of ['staff','portal']){
  let f=fixture(kind,400,{ok:false,error:{code:'INVALID',message:'Choose a valid time'}}),e=await failure(f);assert.equal(e.message,'Choose a valid time');assert.equal(e.code,'INVALID');assert.equal(e.status,400);assert.equal(e.data.error.message,e.message);groups++;
  f=fixture(kind,401,{ok:false,error:{code:'AUTH_REQUIRED',message:'Please sign in'}});e=await failure(f);assert.equal(f.auth(),1);groups++;
  f=fixture(kind,401,{ok:false,error:'AUTH_REQUIRED'});await failure(f);assert.equal(f.auth(),1);groups++;
  f=fixture(kind,402,{ok:false,error:{code:'INSUFFICIENT_CREDITS',message:'Not enough credits'}});e=await failure(f);assert.equal(e.code,'INSUFFICIENT_CREDITS');assert.equal(f.ctx.window.location.hash,'#/websites');groups++;
  f=fixture(kind,402,{ok:false,error:'Account payment overdue',code:'PAST_DUE'});await failure(f);assert.equal(f.ctx.window.location.hash,'#/websites');groups++;
  f=fixture(kind,500,null,true);e=await failure(f);assert.equal(e.message,'Request failed (500)');groups++;
  f=fixture(kind,200,{ok:true,data:{value:42}});const result=await f.api.request('/fixture');assert.equal(kind==='staff'?result.data.value:result.value,42);groups++;
 }
 for(const data of [{error:'SUBSCRIPTION_REQUIRED'}, {error:{code:'SUBSCRIPTION_REQUIRED',message:'Subscribe first'}}, {error:'Subscribe first',code:'SUBSCRIPTION_REQUIRED'}]){
  const f=fixture('staff',402,{ok:false,...data});await failure(f);assert.equal(f.ctx.window.location.hash,'#/billing');groups++;
 }
 for(const method of ['websitePostcard','leadPostcard','websiteExportZip']){
  const f=fixture('staff',403,{ok:false,error:{code:'FORBIDDEN',message:'No access to this file'}}),e=await failure(f,method);assert.equal(e.message,'No access to this file');assert.equal(e.code,'FORBIDDEN');assert.equal(e.data.error.code,'FORBIDDEN');groups++;
 }
 const f=fixture('portal',401,{ok:false,error:{code:'SESSION_IDLE',message:'Session expired'}});await failure(f);assert.equal(f.auth(),1);groups++;
 console.log(JSON.stringify({passed:true,groups,checks:['nested and legacy errors','auth recovery','credit errors preserve context','subscription-only navigation','non-JSON fallback','success contracts','download errors','portal idle expiry']}));
})().catch(e=>{console.error(e);process.exitCode=1});
