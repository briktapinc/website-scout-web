'use strict';
const assert=require('node:assert/strict'),crypto=require('node:crypto');
const db=require('/app/server/db'),policy=require('/app/server/oauthTokenPolicy'),workspace=require('/app/server/workspace');
const hash=s=>crypto.createHash('sha256').update(s).digest('hex');
(async()=>{
 let ready=false;for(let n=0;n<100;n++){try{await db.ping();ready=true;break}catch{}await new Promise(resolve=>setTimeout(resolve,500));}assert(ready,'fixture MySQL did not become ready');
 // Rehearse upgrading an old token table; every row and credential here is synthetic.
 await db.query(`CREATE TABLE workspace_tokens (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, workspace_id BIGINT UNSIGNED NOT NULL, name VARCHAR(120),token_hash CHAR(64),token_prefix VARCHAR(12),lead_id BIGINT UNSIGNED NULL,last_used_at DATETIME NULL,created_at DATETIME DEFAULT CURRENT_TIMESTAMP)`);
 await db.migrate();
 await db.query("INSERT INTO workspaces (id,name,slug) VALUES (1,'Synthetic fixture','synthetic-fixture')");
 await db.query("INSERT INTO client_portal_users (id,email,password_hash,workspace_id,lead_id,status) VALUES (1,'fixture@example.invalid','unused',1,7,'active')");
 await db.query(`INSERT INTO workspace_tokens (workspace_id,name,token_hash,token_prefix,lead_id) VALUES (1,'Claude OAuth · fixture@example.invalid · lead 7',:hash,'cl_fixture',7)`,{hash:hash('cl_fixture')});
 const migration=await policy.backfill(db.query);assert.deepEqual(migration,{legacy:1,bound:1,expired:0});assert(await workspace.findWorkspaceByToken('cl_fixture'));
 await db.migrate();assert.equal((await policy.backfill(db.query)).legacy,0);
 await db.query("UPDATE client_portal_users SET status='disabled' WHERE id=1");assert.equal(await workspace.findWorkspaceByToken('cl_fixture'),null);
 await db.query("UPDATE client_portal_users SET status='active' WHERE id=1");await db.query('UPDATE workspace_tokens SET expires_at=:expiry',{expiry:Date.now()-1});assert.equal(await workspace.findWorkspaceByToken('cl_fixture'),null);
 const service=await workspace.createWorkspaceToken(1,'Service fixture');assert(await workspace.findWorkspaceByToken(service.token));
 console.log(JSON.stringify({passed:true,groups:5,oldSchemaUpgrade:true,legacyConnectionPreserved:true,idempotent:true,expiryAndDisabledIdentityEnforced:true,serviceTokensPreserved:true}));process.exit(0);
})().catch(e=>{console.error(e);process.exit(1)});
