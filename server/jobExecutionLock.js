'use strict';
const crypto=require('node:crypto'),os=require('node:os');
const {query,driver,mysqlConfig}=require('./db');
let lockConnections=0;
function conflict(){return Object.assign(new Error('Job is already running'),{code:'JOB_RUNNING',status:409});}
async function withJobLock(workspaceId,jobId,fn){
 const ws=Number(workspaceId),id=Number(jobId);
 if(!Number.isSafeInteger(ws)||ws<=0||!Number.isSafeInteger(id)||id<=0)throw Object.assign(new Error('Invalid job identity'),{code:'INVALID',status:400});
 if(driver()!=='sqlite'){
  const name='bp-job:'+crypto.createHash('sha256').update(`${process.env.MYSQL_DATABASE||'website_scout'}:${ws}:${id}`).digest('hex').slice(0,48);
  if(lockConnections>=8)throw Object.assign(new Error('Job execution capacity is busy; retry later'),{code:'JOB_RUNNING',status:409});
  lockConnections++;
  let conn;
  try{
   // Dedicated connection keeps job locks from exhausting the normal query pool.
   const {waitForConnections,connectionLimit,...config}=mysqlConfig();
   conn=await require('mysql2/promise').createConnection({...config,connectTimeout:10000});
   const [rows]=await conn.execute('SELECT GET_LOCK(?, 0) AS acquired',[name]);
   if(Number(rows[0].acquired)!==1)throw conflict();
   try{return await fn();}finally{
    try{await conn.execute('SELECT RELEASE_LOCK(?) AS released',[name]);}
    catch{conn.destroy();console.warn('[jobs] lock connection closed after release failure');}
   }
  }finally{
   lockConnections--;
   if(conn)try{await conn.end()}catch{conn.destroy()}
  }
 }
 // SQLite dev/test installs share this table across processes. Only demonstrably
 // dead local owners are reclaimed; foreign/uncertain owners fail closed.
 await query(`CREATE TABLE IF NOT EXISTS job_execution_locks (workspace_id INTEGER NOT NULL,job_id INTEGER NOT NULL,owner TEXT NOT NULL,owner_pid INTEGER NOT NULL,owner_host TEXT NOT NULL,PRIMARY KEY(workspace_id,job_id))`);
 const owner=crypto.randomBytes(24).toString('hex'),host=os.hostname();
 let inserted=await query('INSERT OR IGNORE INTO job_execution_locks VALUES (:ws,:id,:owner,:pid,:host)',{ws,id,owner,pid:process.pid,host});
 if(!Number(inserted.affectedRows)){
  const [old]=await query('SELECT * FROM job_execution_locks WHERE workspace_id=:ws AND job_id=:id',{ws,id});
  let dead=false;
  if(old&&old.owner_host===host){try{process.kill(Number(old.owner_pid),0)}catch(e){dead=e.code==='ESRCH'}}
  if(!dead)throw conflict();
  const changed=await query('UPDATE job_execution_locks SET owner=:owner,owner_pid=:pid,owner_host=:host WHERE workspace_id=:ws AND job_id=:id AND owner=:oldOwner',{ws,id,owner,pid:process.pid,host,oldOwner:old.owner});
  if(!Number(changed.affectedRows))throw conflict();
 }
 try{return await fn();}finally{await query('DELETE FROM job_execution_locks WHERE workspace_id=:ws AND job_id=:id AND owner=:owner',{ws,id,owner});}
}
module.exports={withJobLock};
