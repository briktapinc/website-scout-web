'use strict';
const FORMAT='bitpype.submission-copy.v1';
function encryptedSubmission(db,id){
 if(!id||!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_submissions'").get())return null;
 return db.prepare('SELECT id, form_id, lead_id, encrypted_payload FROM form_submissions WHERE id=? AND encrypted_payload IS NOT NULL').get(Number(id))||null;
}
function encode(payload){
 const {encryptPayload}=require('./contactForms');
 return JSON.stringify({format:FORMAT,ciphertext:encryptPayload(payload)});
}
function decode(json){
 const value=JSON.parse(json||'null');
 if(!value||value.format!==FORMAT)return value;
 const plain=require('./contactForms').decryptPayload(value.ciphertext);
 if(plain==null)throw Object.assign(new Error('Encrypted submission copy is unavailable'),{code:'PAYLOAD_UNAVAILABLE'});
 return plain;
}
function serialize(db,id,payload,{encrypted=false}={}){
 return encrypted||encryptedSubmission(db,id)?encode(payload):JSON.stringify(payload);
}
function migrate(db,{dryRun=false}={}){
 if(!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='form_submissions'").get())return {events:0,failures:0};
 const exists=name=>!!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name=?").get(name);
 const rows=exists('leadscout_events')?db.prepare(`SELECT e.id,s.encrypted_payload FROM leadscout_events e JOIN form_submissions s ON s.id=e.submission_id WHERE s.encrypted_payload IS NOT NULL`).all():[];
 const failures=exists('leadscout_capture_failures')?db.prepare(`SELECT f.id,s.form_id,s.encrypted_payload FROM leadscout_capture_failures f JOIN form_submissions s ON s.id=f.ref_id WHERE f.kind='submission' AND s.encrypted_payload IS NOT NULL`).all():[];
 let events=0,failed=0;
 const run=()=>{
  for(const [table,items] of [['leadscout_events',rows],['leadscout_capture_failures',failures]])for(const row of items){
   const current=db.prepare(`SELECT payload_json FROM ${table} WHERE id=?`).get(row.id);
   let parsed;try{parsed=JSON.parse(current.payload_json||'null')}catch{}
   if(parsed&&parsed.format===FORMAT){decode(current.payload_json);continue;}
   const original=require('./contactForms').decryptPayload(row.encrypted_payload);
   if(original==null)throw new Error('Cannot migrate submission copies: original decryption failed');
   const value=table==='leadscout_events'?original:{formId:row.form_id,...(parsed&&typeof parsed==='object'?parsed:{}),payload:original};
   const encoded=encode(value);decode(encoded);
   if(!dryRun)db.prepare(`UPDATE ${table} SET payload_json=?${table==='leadscout_capture_failures'?", error='Submission capture failed'":''} WHERE id=?`).run(encoded,row.id);
   if(table==='leadscout_events')events++;else failed++;
  }
 };
 // All duplicates in one workspace migrate atomically; never emit payloads.
 if(dryRun)run();else db.transaction(run).immediate();return {events,failures:failed};
}
module.exports={FORMAT,encryptedSubmission,encode,decode,serialize,migrate};
