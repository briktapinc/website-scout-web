'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),{fork}=require('node:child_process');
const Database=require('better-sqlite3'),idem=require('../server/idempotency');
const temp=process.env.IDEM_FIXTURE_DIR||fs.mkdtempSync(path.join(os.tmpdir(),'bitpype-idempotency-'));
const file=path.join(temp,'fixture.db');
if(process.argv[2]==='worker'){
 const db=new Database(file);db.pragma('busy_timeout=5000');
 idem.once(db,'cross-process','shared-key',{lead:1},async()=>{
  db.prepare('INSERT INTO effects (name) VALUES (?)').run('cross-process');
  if(process.argv[3]==='crash'){process.send({claimed:true});return new Promise(()=>{});}
  await new Promise(resolve=>setTimeout(resolve,150));return {id:123};
 }).then(data=>{process.send({data});db.close();process.exit(0)}).catch(e=>{process.send({error:e.code||e.message});process.exit(1)});
}else{
 (async()=>{
  const db=new Database(file),other=new Database(file);db.pragma('journal_mode=WAL');db.exec('CREATE TABLE effects (name TEXT)');
  let groups=0,calls=0;
  const sideEffect=async()=>{calls++;await new Promise(resolve=>setTimeout(resolve,80));return {id:42}};
  const receipts=await Promise.all(Array.from({length:20},(_,i)=>idem.once(i%2?db:other,'lead.create','same-key',{name:'Fixture'},sideEffect)));
  assert.equal(calls,1);for(const r of receipts)assert.deepEqual(r,{id:42});groups++;
  await assert.rejects(idem.once(db,'lead.create','same-key',{name:'Other'},sideEffect),e=>e.code==='IDEMPOTENCY_CONFLICT');groups++;
  const big={text:'🧪'.repeat(200000)};await idem.once(db,'big','key',{},async()=>big);assert.deepEqual(await idem.once(other,'big','key',{},sideEffect),big);groups++;
  await assert.rejects(idem.once(db,'huge','key',{},async()=>({text:'x'.repeat(idem.MAX_RECEIPT_BYTES+1)})),e=>e.code==='IDEMPOTENCY_RECEIPT_TOO_LARGE');
  await assert.rejects(idem.once(other,'huge','key',{},sideEffect),e=>e.code==='IDEMPOTENCY_FAILED');assert.equal(calls,1);groups++;
  await assert.rejects(idem.once(db,'failure','key',{},async()=>{calls++;throw Error('synthetic uncertain failure')}),/synthetic uncertain/);
  await assert.rejects(idem.once(other,'failure','key',{},sideEffect),e=>e.code==='IDEMPOTENCY_FAILED');assert.equal(calls,2);groups++;
  idem.store(db,'legacy','key',{},200,{id:99});assert.deepEqual(await idem.once(other,'legacy','key',{},sideEffect),{id:99});groups++;
  db.prepare("UPDATE api_idempotency SET response_json = '{broken' WHERE operation = 'legacy'").run();await assert.rejects(idem.once(db,'legacy','key',{},sideEffect),e=>e.code==='IDEMPOTENCY_CORRUPT');groups++;
  await idem.once(db,'separate.operation','same-key',{name:'Fixture'},sideEffect);assert.equal(calls,3);groups++;
  await idem.once(db,'no-key',null,{},sideEffect);await idem.once(db,'no-key',null,{},sideEffect);assert.equal(calls,5);groups++;
  db.prepare("UPDATE api_idempotency SET created_at = datetime('now', '-25 hours') WHERE operation = 'lead.create'").run();db.prepare("UPDATE api_idempotency_claims SET created_at = datetime('now', '-25 hours') WHERE operation = 'lead.create'").run();await idem.once(db,'lead.create','same-key',{name:'Fixture'},sideEffect);assert.equal(calls,6);groups++;
  const spawnWorker=mode=>fork(__filename,['worker',mode||'normal'],{env:{...process.env,IDEM_FIXTURE_DIR:temp},stdio:['ignore','ignore','pipe','ipc']});
  const runWorker=()=>new Promise((resolve,reject)=>{const child=spawnWorker();let message;child.on('message',m=>message=m);child.on('error',reject);child.on('exit',code=>code?reject(Error(JSON.stringify(message))):resolve(message));});
  const processes=await Promise.all(Array.from({length:4},()=>runWorker()));for(const m of processes)assert.deepEqual(m.data,{id:123});assert.equal(db.prepare("SELECT COUNT(*) AS n FROM effects WHERE name='cross-process'").get().n,1);groups++;
  db.prepare("DELETE FROM api_idempotency WHERE operation='cross-process'").run();db.prepare("DELETE FROM api_idempotency_claims WHERE operation='cross-process'").run();
  const child=spawnWorker('crash');await new Promise((resolve,reject)=>{child.on('message',resolve);child.on('error',reject)});const exited=new Promise(resolve=>child.on('exit',resolve));child.kill('SIGKILL');await exited;
  const count=db.prepare('SELECT COUNT(*) AS n FROM effects').get().n;db.prepare("UPDATE api_idempotency_claims SET created_at=datetime('now','-25 hours') WHERE operation='cross-process'").run();
  await assert.rejects(idem.once(other,'cross-process','shared-key',{lead:1},async()=>{db.prepare('INSERT INTO effects VALUES (?)').run('duplicate')}),e=>e.code==='IDEMPOTENCY_IN_PROGRESS');assert.equal(db.prepare('SELECT COUNT(*) AS n FROM effects').get().n,count);groups++;
  const vm=require('node:vm'),routes=[];
  const domain={leadsCreate(_ws,body){calls++;return {id:777,name:body.name}}};
  const router=new Proxy({}, {get(_t,method){return (route,...handlers)=>{routes.push({method,route,handlers});return router}}});
  function load(file,mocks,extra=''){
   const m={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'..',file),'utf8')+extra,{module:m,exports:m.exports,require:n=>Object.hasOwn(mocks,n)?mocks[n]:require(n),console,Buffer,process,setTimeout,clearTimeout});return m.exports;
  }
  const middleware=new Proxy({}, {get(){return ()=>()=>{}}});
  load('server/routes/domainApi.js',{'express':{Router:()=>router},'../domain':domain,'../idempotency':idem,'../middleware':middleware,'../workspaceDb':{openWorkspaceDb:()=>db}});
  const mcp=load('server/mcp.js',{'./domain':domain,'./jobs':{},'./workspace':{},'./clientMcp':{},'./idempotency':idem,'./workspaceDb':{openWorkspaceDb:()=>other}},';callClientTool=async()=>undefined;');
  const route=routes.find(r=>r.method==='post'&&r.route==='/leads');
  const req={headers:{'idempotency-key':'transport-key'},auth:{workspaceId:1},body:{name:'Cross transport fixture'}};
  let restResult;const res={json(v){restResult=v},status(){return this}};
  await route.handlers.at(-1)(req,res);assert.equal(restResult.ok,true);const afterRest=calls;
  const mcpResult=await mcp.callTool(1,'lead.create',{...req.body,idempotencyKey:'transport-key'});assert.equal(mcpResult.ok,true);assert.equal(mcpResult.data.lead.id,restResult.data.lead.id);assert.equal(calls,afterRest);groups++;
  req.body={name:'Different fixture'};await route.handlers.at(-1)(req,res);assert.equal(restResult.error.code,'IDEMPOTENCY_CONFLICT');assert.equal(calls,afterRest);groups++;
  other.close();db.close();fs.rmSync(temp,{recursive:true,force:true});
  console.log(JSON.stringify({passed:true,groups,concurrentRequests:20,processes:4,checks:['atomic durable claims','conflicting bodies','valid large UTF-8 receipts','oversize and uncertain-failure replay blocked','legacy receipt compatibility','corrupt receipts fail closed','operation scope and no-key behavior','completed TTL','cross-process duplicate protection','crash recovery does not repeat side effects']}));
 })().catch(e=>{console.error(e);process.exitCode=1});
}
