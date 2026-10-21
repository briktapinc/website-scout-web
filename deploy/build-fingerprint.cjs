'use strict';
// Content comparison deliberately excludes filesystem timestamps and container metadata.
const fs=require('node:fs'),path=require('node:path'),crypto=require('node:crypto'),{execFileSync}=require('node:child_process');
const hash=b=>crypto.createHash('sha256').update(b).digest('hex');
const files=[];
function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name,'en'))){
 const p=path.join(dir,e.name);if(e.isDirectory())walk(p);
 else if(e.isSymbolicLink())files.push([p,'link',fs.readlinkSync(p)]);
 else if(e.isFile())files.push([p,fs.statSync(p).mode&0o777,hash(fs.readFileSync(p))]);
}}
walk('/app');
const packages=execFileSync('dpkg-query',['-W','-f=${Package}=${Version}\n'],{encoding:'utf8'}).trim().split('\n').sort();
console.log(JSON.stringify({node:process.version,abi:process.versions.modules,architecture:process.arch,
 runtimeFiles:files.length,runtimeSha256:hash(JSON.stringify(files)),osPackagesSha256:hash(packages.join('\n')),
 chromiumSha256:hash(fs.readFileSync('/usr/lib/chromium/chromium')),files,packages},null,2));
