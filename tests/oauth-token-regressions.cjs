'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),os=require('node:os'),path=require('node:path'),crypto=require('node:crypto'),vm=require('node:vm'),{spawn}=require('node:child_process');
const temp=fs.mkdtempSync(path.join(os.tmpdir(),'bitpype-oauth-'));
process.env.DB_DRIVER='sqlite';process.env.SQLITE_PATH=path.join(temp,'auth.sqlite');
const Database=require('better-sqlite3'),raw=new Database(process.env.SQLITE_PATH);
let schema=fs.readFileSync(path.join(__dirname,'../sql/schema.sqlite.sql'),'utf8').replace('  expires_at INTEGER,\n  oauth_user_id INTEGER,\n','');raw.exec(schema);
raw.prepare("INSERT INTO workspaces (id,name,slug) VALUES (1,'Fixture','fixture')").run();
raw.prepare("INSERT INTO client_portal_users (id,email,password_hash,workspace_id,lead_id,status) VALUES (1,'fixture@example.invalid','unused',1,7,'active')").run();
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
function legacy(id,name,token,age=4){raw.prepare("INSERT INTO workspace_tokens (id,workspace_id,name,token_hash,token_prefix,lead_id,created_at) VALUES (?,1,?,?,?,7,datetime('now',?))").run(id,name,hash(token),token.slice(0,10),`-${age} days`);}
legacy(1,'Claude OAuth · fixture@example.invalid · lead 7','cl_legacy');legacy(2,'Service fixture','ws_service');legacy(3,'Claude OAuth · unknown@example.invalid · lead 7','cl_orphan');legacy(4,'Claude OAuth · fixture@example.invalid · lead 7','cl_old',100);raw.close();
const db=require('../server/db'),workspace=require('../server/workspace');
function loadOAuth(){
 const m={exports:{}};vm.runInNewContext(fs.readFileSync(path.join(__dirname,'../server/mcpOAuth.js'),'utf8'),{module:m,exports:m.exports,require:n=>n==='./db'?db:n==='./workspace'?workspace:n==='./clientPortal'?{
 findByEmail:async email=>(await db.query('SELECT * FROM client_portal_users WHERE email=:email',{email}))[0],
 createClientMcpToken:async(ws,lead,_email,opts)=>workspace.createWorkspaceToken(ws,opts.name,{leadId:lead,expiresAt:opts.expiresAt,oauthUserId:opts.oauthUserId}),
 }:require(n),process:{env:{DB_DRIVER:'sqlite',APP_URL:'https://bitpype.com'}},console,Buffer,URL,Date});return m.exports;
}
(async()=>{
 let groups=0;await db.migrate();
 assert(await workspace.findWorkspaceByToken('cl_legacy'));assert(await workspace.findWorkspaceByToken('ws_service'));assert.equal(await workspace.findWorkspaceByToken('cl_orphan'),null);assert.equal(await workspace.findWorkspaceByToken('cl_old'),null);groups++;
 const policy=require('../server/oauthTokenPolicy');assert.equal((await policy.backfill(db.query)).legacy,0);groups++;
 const created=await workspace.createWorkspaceToken(1,'OAuth fixture',{leadId:7,expiresAt:Date.now()+60000,oauthUserId:1});assert(await workspace.findWorkspaceByToken(created.token));groups++;
 await db.query('UPDATE workspace_tokens SET expires_at=:expiry WHERE token_hash=:hash',{expiry:Date.now()-1,hash:hash(created.token)});assert.equal(await workspace.findWorkspaceByToken(created.token),null);groups++;
 await db.query("UPDATE client_portal_users SET status='disabled' WHERE id=1");assert.equal(await workspace.findWorkspaceByToken('cl_legacy'),null);assert(await workspace.findWorkspaceByToken('ws_service'));groups++;
 await db.query("UPDATE client_portal_users SET status='active' WHERE id=1");
 await assert.rejects(workspace.createWorkspaceToken(1,'bad',{leadId:7,expiresAt:Date.now()-1,oauthUserId:1}),e=>e.code==='INVALID');groups++;
 const oauth=loadOAuth(),verifier='v'.repeat(43),pending={client_id:oauth.STATIC_CLIENT_ID,redirect_uri:oauth.CLAUDE_HOSTED_REDIRECT,code_challenge:crypto.createHash('sha256').update(verifier).digest('base64url')};
 const identity=(await db.query('SELECT * FROM client_portal_users WHERE id=1'))[0];
 const code=await oauth.createAuthorizationCode(pending,identity);
 const tokens=await oauth.handleTokenRequest({grant_type:'authorization_code',client_id:pending.client_id,redirect_uri:pending.redirect_uri,code,code_verifier:verifier});
 assert.equal(tokens.expires_in,90*86400);let row=(await db.query('SELECT * FROM workspace_tokens WHERE token_hash=:hash',{hash:hash(tokens.access_token)}))[0];assert.equal(row.oauth_user_id,1);assert(row.expires_at>Date.now()+89*86400000);assert(await workspace.findWorkspaceByToken(tokens.access_token));groups++;
 const rotated=await oauth.handleTokenRequest({grant_type:'refresh_token',client_id:pending.client_id,refresh_token:tokens.refresh_token});assert.notEqual(rotated.refresh_token,tokens.refresh_token);assert.equal(await workspace.findWorkspaceByToken(tokens.access_token),null);assert(await workspace.findWorkspaceByToken(rotated.access_token));groups++;
 await assert.rejects(oauth.handleTokenRequest({grant_type:'refresh_token',client_id:pending.client_id,refresh_token:tokens.refresh_token}),e=>e.oauth==='invalid_grant');groups++;
 await db.query("UPDATE client_portal_users SET status='disabled' WHERE id=1");assert.equal(await workspace.findWorkspaceByToken(rotated.access_token),null);
 await assert.rejects(oauth.handleTokenRequest({grant_type:'refresh_token',client_id:pending.client_id,refresh_token:rotated.refresh_token}),e=>e.oauth==='invalid_grant');groups++;
 await db.query("UPDATE client_portal_users SET status='active' WHERE id=1");
 const revokedCode=await oauth.createAuthorizationCode(pending,identity);
 const revokedTokens=await oauth.handleTokenRequest({grant_type:'authorization_code',client_id:pending.client_id,redirect_uri:pending.redirect_uri,code:revokedCode,code_verifier:verifier});
 await db.query('DELETE FROM workspace_tokens WHERE token_hash=:hash',{hash:hash(revokedTokens.access_token)});
 await assert.rejects(oauth.handleTokenRequest({grant_type:'refresh_token',client_id:pending.client_id,refresh_token:revokedTokens.refresh_token}),e=>e.oauth==='invalid_grant');groups++;
 await db.query("UPDATE client_portal_users SET status='disabled' WHERE id=1");
 const child=spawn(process.execPath,[path.join(__dirname,'../server.js')],{cwd:path.join(__dirname,'..'),env:{PATH:process.env.PATH,HOME:process.env.HOME,NODE_ENV:'production',DB_DRIVER:'sqlite',SQLITE_PATH:process.env.SQLITE_PATH,WORKSPACE_DATA_DIR:path.join(temp,'workspaces'),EXPORT_ROOT:path.join(temp,'exports'),SESSION_SECRET:'synthetic-oauth-test-secret',APP_URL:'https://bitpype.com',CAPTCHA_OPTIONAL:'1',PORT:'31338'},stdio:['ignore','pipe','pipe']});let output='';child.stdout.on('data',b=>output+=b);child.stderr.on('data',b=>output+=b);const closed=new Promise(resolve=>child.on('exit',resolve));
 try{let ready=false;for(let n=0;n<100;n++){if(child.exitCode!=null)throw Error(output);try{if((await fetch('http://127.0.0.1:31338/health')).ok){ready=true;break}}catch{}await new Promise(resolve=>setTimeout(resolve,100));}assert(ready,output);
  for(const token of [created.token,'cl_legacy'])for(const url of ['/api/v1/jobs','/mcp']){const res=await fetch('http://127.0.0.1:31338'+url,{method:url==='/mcp'?'POST':'GET',headers:{authorization:'Bearer '+token,'content-type':'application/json'},body:url==='/mcp'?JSON.stringify({jsonrpc:'2.0',id:1,method:'tools/list'}):undefined});assert.equal(res.status,401,url);assert.equal((await res.json()).error,'INVALID_TOKEN');}groups++;
 }finally{child.kill();await closed;}
 console.log(JSON.stringify({passed:true,groups,checks:['legacy migration and service-token policy','idempotent migration','stored access lifetime','expired and inactive identity rejection','invalid lifetime rejected','PKCE code issuance and refresh rotation','consumed refresh rejection','disabled refresh denial','expired and disabled bearer tokens rejected on live isolated REST and MCP']}));
})().catch(e=>{console.error(e);process.exitCode=1});
