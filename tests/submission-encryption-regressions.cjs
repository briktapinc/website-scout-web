'use strict';
const assert=require('node:assert/strict'),Database=require('better-sqlite3');
process.env.SESSION_SECRET='isolated-synthetic-encryption-test-secret';
const forms=require('../server/contactForms'),contacts=require('../server/portalContacts'),copies=require('../server/submissionCopies');
const db=new Database(':memory:');contacts.ensureTables(db);
db.exec('CREATE TABLE form_submissions(id INTEGER PRIMARY KEY,form_id INTEGER,lead_id INTEGER,encrypted_payload TEXT,payload_json TEXT)');
const marker='PRIVATE_DISTINCTIVE_FIELD_734296',payload={name:'Fixture Person',email:'fixture@example.invalid',private_note:marker};
function source(id,lead=1,encrypted=true){db.prepare('INSERT INTO form_submissions VALUES (?,1,?,?,?)').run(id,lead,encrypted?forms.encryptPayload(payload):null,encrypted?null:JSON.stringify(payload));}
function plainCount(){return db.prepare("SELECT COUNT(*) AS n FROM leadscout_events WHERE payload_json LIKE ?").get('%'+marker+'%').n+db.prepare("SELECT COUNT(*) AS n FROM leadscout_capture_failures WHERE payload_json LIKE ? OR error LIKE ?").get('%'+marker+'%','%'+marker+'%').n;}
let groups=0;source(1);let result=contacts.captureFromSubmission(db,{leadId:1,formId:1,submissionId:1,payload});assert(!result.error);assert.equal(plainCount(),0);groups++;
let viewed=contacts.getContact(db,result.contact.id,{leadId:1});assert.equal(viewed.events[0].payload.private_note,marker);assert.equal(contacts.listContacts(db,{leadId:1})[0].email,payload.email);groups++;
assert.throws(()=>contacts.getContact(db,result.contact.id,{leadId:2}),e=>e.code==='NOT_FOUND');groups++;
source(2);db.exec("CREATE TRIGGER synthetic_fail BEFORE INSERT ON leadscout_events BEGIN SELECT RAISE(ABORT,'PRIVATE_DISTINCTIVE_FIELD_734296'); END;");result=contacts.captureFromSubmission(db,{leadId:1,formId:1,submissionId:2,payload});assert.equal(result.error,'Submission capture failed');assert.equal(plainCount(),0);groups++;
db.exec('DROP TRIGGER synthetic_fail');const retried=contacts.retryOpenFailures(db,{leadId:1});assert.equal(retried.resolved,1);assert.equal(plainCount(),0);groups++;
// Historical event/failure duplicates, including malformed old truncated JSON.
db.prepare('UPDATE leadscout_events SET payload_json=? WHERE submission_id=1').run(JSON.stringify(payload));db.prepare("UPDATE leadscout_capture_failures SET payload_json='{truncated', error=?").run(marker);
const preview=copies.migrate(db,{dryRun:true});assert.equal(preview.events,1);assert.equal(preview.failures,1);assert(plainCount()>0);groups++;
const migrated=copies.migrate(db);assert.equal(migrated.events,1);assert.equal(migrated.failures,1);assert.equal(plainCount(),0);assert.equal(contacts.getContact(db,viewed.contact.id,{leadId:1}).events[0].payload.private_note,marker);groups++;
assert.deepEqual(copies.migrate(db),{events:0,failures:0});groups++;
source(3,2,false);const standard=contacts.captureFromSubmission(db,{leadId:2,formId:1,submissionId:3,payload});assert(!standard.error);assert.equal(contacts.getContact(db,standard.contact.id,{leadId:2}).events[0].payload.private_note,marker);groups++;
const blob=copies.encode(payload);process.env.SESSION_SECRET='wrong-key';assert.throws(()=>copies.decode(blob),e=>e.code==='PAYLOAD_UNAVAILABLE');process.env.SESSION_SECRET='isolated-synthetic-encryption-test-secret';groups++;
source(4);db.prepare('UPDATE form_submissions SET encrypted_payload=? WHERE id=4').run('invalid');db.prepare("INSERT INTO leadscout_events(contact_id,lead_id,kind,submission_id,payload_json) VALUES (?,1,'submission',4,?)").run(viewed.contact.id,JSON.stringify(payload));assert.throws(()=>copies.migrate(db),/original decryption failed/);assert.equal(db.prepare('SELECT payload_json FROM leadscout_events WHERE submission_id=4').get().payload_json,JSON.stringify(payload));groups++;
console.log(JSON.stringify({passed:true,groups,checks:['encrypted event storage','authorized viewing and identity projection','foreign scope denied','encrypted retry records and sanitized errors','retry compatibility','dry-run and historical repair','idempotence','standard-plan compatibility','wrong-key rejection','transactional failure preserves originals']}));db.close();
