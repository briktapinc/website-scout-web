'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2]||path.join(__dirname,'..'));
let writes=0;
const current={id:1,name:'Existing',type:'custom',enabled:0,interval_minutes:null,cron_expr:'daily:09:00'};
const query=async(sql)=>{if(sql.trim().startsWith('SELECT'))return [current];writes++;return {affectedRows:1};};
const context={module:{exports:{}},require(id){if(id==='./db')return {query,withConnection:async()=>{throw Error('Unexpected connection');}};if(id==='./workspace')return {getSetting:async()=>null,logActivity:async()=>{}};throw Error('Unexpected import '+id);},Date,console};
vm.runInNewContext(fs.readFileSync(path.join(root,'server/jobs.js'),'utf8'),context);
const jobs=context.module.exports;
function next(time,from,want){const date=new Date(from),unchanged=date.toISOString();assert.equal(jobs.computeNextRun({cron_expr:'daily:'+time},date).toISOString(),want);assert.equal(date.toISOString(),unchanged);}
async function main(){
 next('00:00','2026-10-20T00:01:00Z','2026-10-21T00:00:00.000Z');
 next('00:30','2026-10-20T00:01:00Z','2026-10-20T00:30:00.000Z');
 next('23:59','2026-10-20T23:58:59Z','2026-10-20T23:59:00.000Z');
 next('00:00','2026-12-31T23:59:00Z','2027-01-01T00:00:00.000Z');
 next('00:00','2028-02-28T00:00:00Z','2028-02-29T00:00:00.000Z');
 next('09:00','2026-10-20T09:00:00Z','2026-10-21T09:00:00.000Z');
 for(const value of ['daily:24:00','daily:23:60','daily:-1:00','daily:00','daily:9:00','daily:00:00:00','daily:NaN:00','daily:00:00\n']){
  assert.throws(()=>jobs.computeNextRun({cron_expr:value}),e=>e.code==='INVALID');
  for(const enabled of [true,false]){
   await assert.rejects(jobs.createJob(1,{name:'Test',type:'custom',enabled,cron_expr:value}),e=>e.code==='INVALID');
   await assert.rejects(jobs.updateJob(1,1,{enabled,cron_expr:value}),e=>e.code==='INVALID');
  }
 }
 assert.equal(writes,0,'invalid schedules must never write');
 const from=new Date('2026-10-20T00:00:00Z');
 assert.equal(jobs.computeNextRun({interval_minutes:15,cron_expr:'daily:00:00'},from).toISOString(),'2026-10-20T00:15:00.000Z');
 assert.equal(jobs.computeNextRun({},from).toISOString(),'2026-10-20T06:00:00.000Z');
 const routes=[];const router={use(){},get(){},post(){},delete(){},patch(url,...handlers){routes.push(handlers);}};
 const routeContext={module:{exports:{}},require(id){if(id==='express')return {Router:()=>router};if(id==='../jobs')return {updateJob:async()=>{throw Object.assign(new Error('Invalid daily time'),{code:'INVALID'});}};if(id==='../db')return {query};if(id==='../middleware')return {requireWorkspace(){},denyLeadScopedToken(){},requireRole:()=>()=>{}};throw Error('Unexpected route import');}};
 vm.runInNewContext(fs.readFileSync(path.join(root,'server/routes/jobs.js'),'utf8'),routeContext);
 const res={status(code){this.code=code;return this;},json(value){this.body=value;}};
 await routes[0].at(-1)({auth:{workspaceId:1},params:{id:'1'},body:{}},res,e=>{throw e;});
 assert.equal(res.code,400);assert.equal(res.body.ok,false);
 console.log(JSON.stringify({passed:true,groups:10,checks:['midnight','00:30','23:59','year rollover','leap day','exact time','invalid create/update without writes','interval priority','default interval','invalid PATCH returns 400']}));
}
main().catch(e=>{console.error(e);process.exitCode=1;});
