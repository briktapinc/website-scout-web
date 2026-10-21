'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),D=require('/app/node_modules/better-sqlite3');
const forms=require('/app/server/contactForms');
let workspaces=0,encryptedRows=0;
for(const e of fs.readdirSync('/app/data/workspaces',{withFileTypes:true})){
 if(!e.isDirectory()||!/^\d+$/.test(e.name))continue;
 const file=path.join('/app/data/workspaces',e.name,'websitescout.db');if(!fs.existsSync(file))continue;
 const db=new D(file,{readonly:true});workspaces++;
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_submissions'").get()){
  const columns=db.pragma('table_info(form_submissions)').map(x=>x.name);
  if(columns.includes('encrypted_payload'))for(const row of db.prepare('SELECT encrypted_payload FROM form_submissions WHERE encrypted_payload IS NOT NULL').iterate()){
   assert.notEqual(forms.decryptPayload(row.encrypted_payload),null,'restored encrypted submission unavailable');encryptedRows++;
  }
 }
 db.close();
}
// Synthetic round-trip verifies that the restored secret is usable even with no historical encrypted rows.
assert.deepEqual(forms.decryptPayload(forms.encryptPayload({fixture:'recovery-only'})),{fixture:'recovery-only'});
console.log(JSON.stringify({passed:true,workspaces,encryptedRows,restoredKeyRoundTrip:true,customerDataPrinted:false}));
