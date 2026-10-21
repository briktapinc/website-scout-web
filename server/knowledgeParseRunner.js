'use strict';
const {fork}=require('node:child_process'),fs=require('node:fs'),os=require('node:os'),path=require('node:path');
let active=0;
const failure=warning=>({text:'',extractor:'error',supported:false,warning});
function runIsolated(buffer,opts={},controls={}){
 if(!Buffer.isBuffer(buffer)||!buffer.length)return Promise.resolve({text:'',extractor:'none',supported:false,warning:'empty file'});
 if(buffer.length>5*1024*1024)return Promise.resolve(failure('Knowledge file max 5MB'));
 if(active>=2)return Promise.resolve(failure('Document extraction is busy. Please retry.'));
 const image=require('./chatbotKnowledgeParse').isOcrInput(opts);
 active++;
 return new Promise(resolve=>{
  let child,timer,settled=false,result;const scratch=fs.mkdtempSync(path.join(os.tmpdir(),'bitpype-parser-'));
  const finish=()=>{
   if(settled)return;settled=true;clearTimeout(timer);active--;
   try{if(path.dirname(scratch)===path.resolve(os.tmpdir())&&path.basename(scratch).startsWith('bitpype-parser-'))fs.rmSync(scratch,{recursive:true,force:true});}catch{console.warn('[knowledge] temporary parser cleanup deferred');}
   resolve(result||failure('Document parser stopped unexpectedly'));
  };
  try{
   const moduleRoot=path.resolve(__dirname,'../node_modules');
   const args=['--max-old-space-size=192','--unhandled-rejections=strict','--permission',`--allow-fs-read=${__dirname}`,`--allow-fs-read=${moduleRoot}`,`--allow-fs-read=${path.resolve(__dirname, "../package.json")}`,`--allow-fs-read=${scratch}`,`--allow-fs-write=${scratch}`];
   if(image)args.push('--allow-addons','--allow-worker');
   if(controls.workerPath)args.push(`--allow-fs-read=${controls.workerPath}`);
   if(opts.mimeType==='application/pdf'||/\.pdf$/i.test(opts.fileName||''))args.push('--allow-addons');
   const env={TZ:'UTC',PATH:process.env.PATH||'',HOME:scratch,TMPDIR:scratch,TEMP:scratch,TMP:scratch};
   for(const k of ['SystemRoot','SystemDrive'])if(process.env[k])env[k]=process.env[k];
   child=fork(controls.workerPath||path.join(__dirname,'knowledgeParseWorker.js'),[],{cwd:scratch,execArgv:args,env,stdio:['ignore','ignore',controls.debugStderr?'inherit':'ignore','ipc'],serialization:'advanced'});
   timer=setTimeout(()=>{result=failure('Document extraction exceeded its time limit');child.kill('SIGKILL')},controls.timeoutMs||(image?60000:15000));
   child.on('message',data=>{
    if(data&&typeof data.text==='string'&&data.text.length<=200000){result=data;child.kill();}
    else{result=failure('Invalid parser response');child.kill();}
   });
   child.once('error',()=>{result=failure('Document parser could not start');if(child.pid)child.kill('SIGKILL');else finish()});
   child.once('exit',finish);
   child.send({buffer,opts},error=>{if(error){result=failure('Document could not be sent to parser');child.kill('SIGKILL')}});
  }catch{result=failure('Document parser could not start');if(child&&child.pid)child.kill('SIGKILL');else finish();}
 });
}
module.exports={runIsolated};
