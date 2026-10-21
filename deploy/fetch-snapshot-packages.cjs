'use strict';
// Package selection and hashes come only from authenticated, dated APT indexes.
// Alternate endpoints may supply identical bytes, never newer package versions.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto');
const {execFileSync,execFile}=require('node:child_process');
const downloadFile=require('node:util').promisify(execFile);
const packages=process.argv.slice(2);
async function main(){
 const deadline=setTimeout(()=>{console.error('Pinned package download deadline exceeded');process.exit(1)},10*60*1000);
 deadline.unref();
 if(!packages.length||packages.some(x=>!/^[a-z0-9][a-z0-9+.-]*$/.test(x)))throw Error('Explicit package names required');
 const metadata=new Map();
 for(const paragraph of execFileSync('apt-cache',['dumpavail'],{encoding:'utf8',maxBuffer:150*1024*1024}).split(/\n\n/)){
  const fields=Object.fromEntries(paragraph.split('\n').filter(x=>/^[A-Za-z0-9-]+: /.test(x)).map(x=>{const i=x.indexOf(': ');return[x.slice(0,i),x.slice(i+2)]}));
  if(!fields.Filename||!fields.SHA256)continue;
  if(!/^[a-f0-9]{64}$/.test(fields.SHA256))throw Error('Invalid authenticated package hash');
  const old=metadata.get(fields.Filename);
  if(old&&old.SHA256!==fields.SHA256)throw Error('Conflicting authenticated package metadata');
  metadata.set(fields.Filename,fields);
 }
 const printed=execFileSync('apt-get',['--print-uris','--yes','--download-only','install','--no-install-recommends',...packages],{encoding:'utf8',maxBuffer:10*1024*1024});
 const downloads=[];
 for(const line of printed.split('\n')){
  const m=line.match(/^'([^']+)' (\S+) (\d+) /);if(!m)continue;
  const url=new URL(m[1]);
  const match=decodeURIComponent(url.pathname).match(/^\/archive\/(debian|debian-security)\/\d{8}T\d{6}Z\/(pool\/.+)$/);
  if(url.protocol!=='https:'||url.hostname!=='snapshot.debian.org'||!match||!/^[-a-zA-Z0-9_.+:%~]+\.deb$/.test(m[2]))throw Error('Unexpected snapshot package URI');
  const entry=metadata.get(match[2]);
  if(!entry||Number(entry.Size)!==Number(m[3]))throw Error('Missing authenticated package metadata');
  const alternate=match[1]==='debian'?'https://deb.debian.org/debian/':'https://security.debian.org/debian-security/';
  downloads.push({name:m[2],size:Number(m[3]),sha:entry.SHA256,urls:[url.href,alternate+match[2]]});
 }
 const directory='/var/cache/apt/archives';fs.mkdirSync(directory,{recursive:true});
 async function valid(file,item){
  if(!fs.existsSync(file)||fs.statSync(file).size!==item.size)return false;
  const digest=crypto.createHash('sha256');for await(const chunk of fs.createReadStream(file))digest.update(chunk);
  return digest.digest('hex')===item.sha;
 }
 async function download(item){
  const target=path.join(directory,item.name),temporary=target+'.partial';
  if(await valid(target,item))return;
  for(let attempt=0;attempt<3;attempt++){
   for(const url of item.urls){
    try{
     // Use APT's own TLS/proxy/retry transport, including its checksum check.
     await downloadFile('/usr/lib/apt/apt-helper',['-o','Acquire::Retries=1','-o','Acquire::https::Timeout=15','download-file',url,temporary,'SHA256:'+item.sha],{timeout:90000,maxBuffer:1024*1024});
     if(!await valid(temporary,item))throw Error('Package checksum mismatch');
     fs.renameSync(temporary,target);return;
    }catch{fs.rmSync(temporary,{force:true});}
   }
   await new Promise(resolve=>setTimeout(resolve,1000*(attempt+1)));
  }
  throw Error('Cannot retrieve authenticated pinned package: '+item.name);
 }
 let next=0,completed=0;
 await Promise.all(Array.from({length:4},async()=>{while(next<downloads.length){await download(downloads[next++]);completed++;if(completed%20===0)console.log('Verified pinned packages: '+completed+'/'+downloads.length);}}));
 clearTimeout(deadline);
 console.log(JSON.stringify({authenticatedPinnedPackages:downloads.length,sha256Verified:true}));
 execFileSync('apt-get',['-o','Acquire::Retries=3','install','--yes','--no-install-recommends',...packages],{stdio:'inherit'});
}
main().catch(error=>{console.error(error.message);process.exit(1)});
