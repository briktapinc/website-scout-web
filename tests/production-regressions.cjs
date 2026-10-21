'use strict';
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const root = process.env.BITPYPE_TEST_ROOT || path.resolve(__dirname, '..');
let Database;
try { Database = require('better-sqlite3'); } catch { Database = require('node:sqlite').DatabaseSync; }
const db = new Database(':memory:');
const contacts = require(path.join(root, 'server/portalContacts.js'));
const results = [];
function check(name, fn) { fn(); results.push(name); }
function load(file, mocks) {
  const module = { exports: {} };
  vm.runInNewContext(fs.readFileSync(path.join(root, file), 'utf8'), {
    module, exports: module.exports, require: name => {
      if (Object.hasOwn(mocks, name)) return mocks[name];
      if (!name.startsWith('.')) return require(name);
      throw new Error('Unexpected dependency: ' + name);
    }, process: { env: {} }, console, Buffer, URL, Date, setTimeout, clearTimeout,
  }, { filename: file });
  return module.exports;
}
function capture(leadId, submissionId, payload) {
  const r = contacts.captureFromSubmission(db, { leadId, submissionId, formId: leadId, formName: 'Fixture', payload });
  assert.equal(r.error, undefined);
  return Number(r.contact.id);
}
async function main() {
  const shared = capture(1, 1, {name:'Client One Name',email:'shared@example.invalid',phone:'1112223333',private_note:'ONE ONLY'});
  assert.equal(capture(2, 2, {name:'Client Two Name',email:'shared@example.invalid',phone:'9998887777',private_note:'TWO ONLY'}),shared);
  const foreign = capture(2, 3, {name:'Unrelated Person',email:'foreign@example.invalid'});
  check('scoped list excludes foreign contacts, identity and aggregates',()=>{
    const rows=contacts.listContacts(db,{leadId:1}); assert.equal(rows.length,1);
    assert.equal(rows[0].name,'Client One Name'); assert.equal(rows[0].phone,'1112223333'); assert.equal(rows[0].event_count,1);
    assert(!JSON.stringify(rows).includes('Client Two'));
  });
  check('scoped detail rejects guessed foreign IDs and excludes foreign events',()=>{
    assert.throws(()=>contacts.getContact(db,foreign,{leadId:1}),e=>e.code==='NOT_FOUND');
    const detail=contacts.getContact(db,shared,{leadId:1});
    assert.equal(detail.events.length,1); assert.equal(detail.contact.name,'Client One Name');
    assert(!JSON.stringify(detail).includes('TWO ONLY'));
  });
  check('invalid scope fails closed while explicit internal workspace views remain available',()=>{
    assert.throws(()=>contacts.listContacts(db,{leadId:0}),e=>e.code==='FORBIDDEN');
    assert.equal(contacts.listContacts(db).length,2);
  });
  db.prepare('UPDATE leadscout_events SET created_at = ? WHERE lead_id = ?').run('2099-01-01 00:00:00',2);
  check('other business timestamps are excluded',()=>assert(!JSON.stringify(contacts.listContacts(db,{leadId:1})).includes('2099')));
  const failure=db.prepare('INSERT INTO leadscout_capture_failures(kind,lead_id,error,payload_json) VALUES (?,?,?,?)');
  failure.run('synthetic',1,'one failure','{}');failure.run('synthetic',2,'two failure','{"private":"TWO"}');
  check('health and retries operate only on caller business',()=>{
    const health=contacts.captureHealth(db,{leadId:1});assert.equal(health.open_failures,1);assert.equal(health.failures[0].lead_id,1);
    const r=contacts.retryOpenFailures(db,{leadId:1});assert.equal(r.tried,1);assert.equal(r.health.open_failures,1);
    assert.equal(db.prepare('SELECT retries FROM leadscout_capture_failures WHERE lead_id = ?').get(2).retries,0);
  });
  db.prepare('UPDATE leadscout_events SET payload_json = ? WHERE lead_id = ?').run('corrupt snapshot',1);
  check('corrupt snapshots do not fall back to shared foreign identity',()=>{
    assert.equal(contacts.listContacts(db,{leadId:1})[0].name,'');
    assert.equal(contacts.getContact(db,shared,{leadId:1}).contact.phone,'');
  });
  const portal=load('server/clientPortal.js',{
    bcryptjs:{hashSync:()=> 'fixture'},'./db':{},'./mailer':{},'./stripeClient':{},'./workspaceDb':{},
    './domain':{withDb:(_ws,fn)=>fn(db)},'./portalContacts':contacts,
  });
  check('portal wrappers ignore allSites and reject missing scope',()=>{
    assert.equal(portal.listLeadScoutContacts(1,1,{allSites:true}).length,1);
    assert.throws(()=>portal.listLeadScoutContacts(1,null,{allSites:true}),e=>e.code==='FORBIDDEN');
    assert.throws(()=>portal.getLeadScoutContact(1,1,foreign),e=>e.code==='NOT_FOUND');
    assert.equal(portal.leadScoutHealth(1,1).open_failures,1);
  });
  const mcp=load('server/clientMcp.js',{
    './domain':{},'./clientPortal':{...portal,activeEmailForLead:async()=> 'fixture@example.invalid'},
    './billing':{effectivePlan:async()=> 'premium'},'./plans':{getPlan:()=>({entitlements:{}})},
  });
  const cl=await mcp.dispatchPortalTool(1,'leadscout.contacts.list',{allSites:true},{leadId:1});
  assert.equal(cl.contacts.length,1); assert.equal(cl.health.open_failures,1);
  await assert.rejects(mcp.dispatchPortalTool(1,'leadscout.contacts.get',{id:foreign},{leadId:1}),e=>e.code==='NOT_FOUND');
  const ws=await mcp.dispatchPortalTool(1,'leadscout.contacts.list',{allSites:true},{});
  assert.equal(ws.contacts.length,2);assert.equal(ws.health.open_failures,2);
  results.push('MCP client tokens remain pinned; explicit workspace token views are preserved');
  const portalRoutes=[];
  const portalRouter={use(){}};
  for(const method of ['get','post','put','patch','delete'])portalRouter[method]=(route,...handlers)=>portalRoutes.push({method,route,handlers});
  load('server/routes/portal.js',{
    express:{Router:()=>portalRouter},'../clientPortal':{...portal,findById:async()=>({id:1,status:'active',workspace_id:1,lead_id:1})},
    '../captcha':{requireCaptcha:()=>((_req,_res,next)=>next())},'../rateLimit':{rateLimit:()=>((_req,_res,next)=>next())},
  });
  async function callPortal(method,url,query={},params={}){
    const route=portalRoutes.find(x=>x.method===method&&x.route===url);assert(route,url);
    const req={session:{clientPortalId:1,clientLastActiveAt:Date.now()},query,params,app:{locals:{}}};
    let status=200,body;const res={status(v){status=v;return this},json(v){body=v;return this}};
    for(const handler of route.handlers){let advanced=false;await handler(req,res,()=>{advanced=true});if(!advanced)break;}
    return {status,body};
  }
  assert.equal((await callPortal('get','/leadscout/contacts',{allSites:'1'})).body.data.contacts.length,1);
  assert.equal((await callPortal('get','/leadscout/contacts/:id',{}, {id:String(foreign)})).status,404);
  assert.equal((await callPortal('get','/leadscout/health')).body.data.open_failures,1);
  assert.equal((await callPortal('post','/leadscout/retry')).body.data.tried,1);
  assert.equal(db.prepare('SELECT retries FROM leadscout_capture_failures WHERE lead_id = ?').get(2).retries,0);
  results.push('real portal route handlers ignore allSites, reject foreign detail, scope health and retries');
  const middleware=load('server/middleware.js',{'./workspace':{}});
  const registrations=[],uses=[];
  const router={use(...h){uses.push(...h)}};
  for(const method of ['get','post','patch','delete'])router[method]=(route,...handlers)=>registrations.push({method,route,handlers});
  let jobCalls=0;
  const jobs=new Proxy({}, {get:()=>async()=>{jobCalls++;return {ok:true}}});
  load('server/routes/jobs.js',{
    express:{Router:()=>router},'../jobs':jobs,'../db':{query:async()=>{jobCalls++;return []}},
    '../middleware':{...middleware,requireWorkspace:(_req,_res,next)=>next()},
  });
  async function call(route,auth){
    const req={auth,params:{id:'1'},body:{}};let status=200,body;
    const res={status(v){status=v;return this},json(v){body=v;return this}};
    for(const handler of [...uses,...route.handlers]){
      let advanced=false;await handler(req,res,()=>{advanced=true});
      if(!advanced)break;
    }
    return {status,body};
  }
  for(const route of registrations){
    const before=jobCalls;const r=await call(route,{via:'token',role:'token',leadId:1,workspaceId:1});
    assert.equal(r.status,403,route.method+' '+route.route);assert.equal(jobCalls,before);
  }
  results.push('all job endpoints reject client tokens before queries or execution');
  const run=registrations.find(x=>x.method==='post'&&x.route==='/:id/run');
  assert.equal((await call(run,{via:'session',role:'member',workspaceId:1})).status,403);
  assert.equal((await call(run,{via:'session',role:'owner',workspaceId:1})).status,200);
  assert.equal((await call(run,{via:'token',role:'token',leadId:null,workspaceId:1})).status,200);
  results.push('forced execution allows owners and workspace service tokens; denies ordinary members');
  db.close();console.log(JSON.stringify({passed:results.length,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
