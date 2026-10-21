'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),vm=require('node:vm'),{fork}=require('node:child_process');
const temp=process.env.JOB_FIXTURE_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'bitpype-job-'));
if(!process.env.DB_DRIVER)process.env.DB_DRIVER='sqlite';
if(process.env.DB_DRIVER==='sqlite')process.env.SQLITE_PATH=path.join(temp,'auth.sqlite');
const db=require('../server/db');
const worker=process.argv[2]==='worker',crash=process.argv[3]==='crash';
let forceError=false;
const workspace={getSetting:async()=>null,logActivity:async(ws,_area,message)=>{
 if(!message.startsWith('Custom job ran:'))return;
 await db.query('INSERT INTO fixture_effects (label) VALUES (:label)',{label:message});
 if(crash){process.send({running:true});return new Promise(()=>{})}
 await new Promise(resolve=>setTimeout(resolve,250));if(forceError)throw Error('Synthetic job failure');
}};
const moduleFixture={exports:{}};
vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../server/jobs.js'),'utf8'),{module:moduleFixture,exports:moduleFixture.exports,require:n=>n==='./db'?db:n==='./workspace'?workspace:n==='./domain'?{}:n==='./jobExecutionLock'?require('../server/jobExecutionLock'):require(n),Date,console,setInterval,clearInterval,setTimeout});
const jobs=moduleFixture.exports;
if(worker){process.on('message',async message=>{if(!message.go)return;try{const data=await jobs.executeJob(1,message.id,{source:'fixture-process',triggeredBy:'fixture-worker'});process.send({ok:true,data});process.exit(0)}catch(e){process.send({ok:false,code:e.code});process.exit(0)}});process.send({ready:true});}
else (async()=>{
 let groups=0;
 await db.query(process.env.DB_DRIVER==='sqlite' ? `CREATE TABLE job_runs(id INTEGER PRIMARY KEY AUTOINCREMENT,workspace_id INTEGER,job_id INTEGER,status TEXT,result TEXT,error TEXT,started_at TEXT DEFAULT (datetime('now')),finished_at TEXT)` : `CREATE TABLE job_runs(id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,workspace_id BIGINT UNSIGNED,job_id BIGINT UNSIGNED,status VARCHAR(40),result JSON,error TEXT,started_at DATETIME DEFAULT CURRENT_TIMESTAMP,finished_at DATETIME)`);
 await db.migrate();await db.query("INSERT INTO workspaces (id,name,slug) VALUES (1,'Jobs fixture','jobs-fixture')");
 await db.query('CREATE TABLE fixture_effects (label TEXT)');
 const created=await Promise.all(Array.from({length:20},(_,i)=>jobs.createJob(1,{name:'Fixture '+i,type:'custom',interval_minutes:60})));
 assert.equal(new Set(created.map(j=>j.id)).size,20);for(let i=0;i<20;i++)assert.equal(created[i].name,'Fixture '+i);groups++;
 const target=created[0];
 const runs=await Promise.allSettled(Array.from({length:20},()=>jobs.executeJob(1,target.id,{source:'manual',triggeredBy:'user:fixture'})));
 assert.equal(runs.filter(r=>r.status==='fulfilled').length,1);for(const r of runs.filter(r=>r.status==='rejected'))assert.equal(r.reason.code,'JOB_RUNNING');groups++;
 const result=runs.find(r=>r.status==='fulfilled').value;const run=(await db.query('SELECT * FROM job_runs WHERE id=:id',{id:result.runId}))[0];assert.equal(Number(run.job_id),Number(target.id));assert.equal(run.status,'ok');assert.equal(run.trigger_source,'manual');assert.equal(run.triggered_by,'user:fixture');groups++;
 const distinct=await Promise.all([jobs.executeJob(1,created[1].id),jobs.executeJob(1,created[2].id)]);assert.notEqual(distinct[0].runId,distinct[1].runId);for(const r of distinct){const row=(await db.query('SELECT * FROM job_runs WHERE id=:id',{id:r.runId}))[0];assert.equal(Number(row.job_id),Number(r.jobId));assert.equal(row.status,'ok');}groups++;
 forceError=true;await assert.rejects(jobs.executeJob(1,target.id),/Synthetic job failure/);forceError=false;const after=await jobs.executeJob(1,target.id);assert(after.runId!==result.runId);assert((await db.query("SELECT * FROM job_runs WHERE status='error'")).length>=1);groups++;
 await jobs.updateJob(1,target.id,{enabled:false});await assert.rejects(jobs.executeJob(1,target.id),e=>e.code==='DISABLED');assert(await jobs.executeJob(1,target.id,{force:true}));groups++;
 await jobs.updateJob(1,target.id,{enabled:true});assert.equal((await jobs.executeJob(1,target.id,{dueOnly:true})).skipped,true);groups++;
 await db.query("UPDATE scheduled_jobs SET next_run_at='2020-01-01 00:00:00' WHERE id=:id",{id:target.id});
 const due=await jobs.executeJob(1,target.id,{dueOnly:true,source:'scheduler',triggeredBy:'scheduler'});assert(due.runId);assert.equal((await jobs.executeJob(1,target.id,{dueOnly:true})).skipped,true);groups++;
 const routeHandlers=[];const fakeRouter={use(){},get(){},patch(){},delete(){},post(url,...handlers){if(url==='/:id/run')routeHandlers.push(handlers.at(-1))}};
 const rm={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../server/routes/jobs.js'),'utf8'),{module:rm,exports:rm.exports,require:n=>n==='express'?{Router:()=>fakeRouter}:n==='../jobs'?{executeJob:async()=>{throw Object.assign(new Error('Job is already running'),{code:'JOB_RUNNING'})}}:n==='../db'?db:n==='../middleware'?{requireWorkspace(){},denyLeadScopedToken(){},requireRole:()=>()=>{}}:require(n)});
 const response={status(code){this.code=code;return this},json(body){this.body=body}};await routeHandlers[0]({auth:{workspaceId:1,userId:1},params:{id:target.id}},response,()=>{});assert.equal(response.code,409);assert.equal(response.body.code,'JOB_RUNNING');groups++;
 function child(mode){return fork(__filename,['worker',mode||'normal'],{env:{...process.env,JOB_FIXTURE_DIR:temp},stdio:['ignore','ignore','pipe','ipc']});}
 const children=Array.from({length:4},()=>child());await Promise.all(children.map(c=>new Promise((resolve,reject)=>{c.on('message',m=>{if(m.ready)resolve()});c.on('error',reject)})));
 const completed=children.map(c=>new Promise((resolve,reject)=>{let receipt;c.on('message',m=>{if('ok'in m)receipt=m});c.on('exit',code=>code?reject(Error('worker exited '+code)):resolve(receipt));c.on('error',reject)}));children.forEach(c=>c.send({go:true,id:target.id}));
 const receipts=await Promise.all(completed);assert.equal(receipts.filter(r=>r.ok).length,1);for(const r of receipts.filter(r=>!r.ok))assert.equal(r.code,'JOB_RUNNING');groups++;
 const crashed=child('crash');await new Promise((resolve,reject)=>{crashed.on('message',m=>{if(m.ready)resolve()});crashed.on('error',reject)});const running=new Promise(resolve=>crashed.on('message',m=>{if(m.running)resolve()}));crashed.send({go:true,id:target.id});await running;const exited=new Promise(resolve=>crashed.on('exit',resolve));crashed.kill('SIGKILL');await exited;
 const recovered=await jobs.executeJob(1,target.id);assert(recovered.runId);assert.equal((await db.query("SELECT * FROM job_runs WHERE status='abandoned' AND job_id=:id",{id:target.id})).length,1);groups++;
 await assert.rejects(jobs.executeJob(1,-1),e=>e.code==='INVALID');groups++;
 await assert.rejects(jobs.executeJob(1,999999),e=>e.code==='NOT_FOUND');groups++;
 console.log(JSON.stringify({passed:true,groups,driver:process.env.DB_DRIVER,concurrentCreates:20,concurrentRuns:20,processes:4,checks:['own inserted IDs','exclusive execution','initiator metadata','different jobs independent','failure unlock','disabled/forced behavior','due recheck','cross-process exclusivity','crash lock recovery and abandoned run','invalid and missing jobs']}));process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
