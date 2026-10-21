'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http');
const root=process.env.BITPYPE_TEST_ROOT||path.resolve(__dirname,'..');
const {createRequire}=require('node:module');const appRequire=createRequire(path.join(root,'package.json'));
const {Agent}=appRequire('undici');const results=[];
function load({lookup,fetcher,agent=Agent}={}){
 const module={exports:{}};const source=fs.readFileSync(path.join(root,'server/urlSafety.js'),'utf8');
 vm.runInNewContext(source+'\nmodule.exports.testPinnedAgent=pinnedAgent;',{
  module,exports:module.exports,require:n=>n==='undici'?{Agent:agent,fetch:fetcher||appRequire('undici').fetch}:n==='dns'?{promises:{lookup}}:require(n),
  process:{env:{NODE_ENV:'production'}},URL,Buffer,Headers,Response,AbortSignal,AbortController,setTimeout,clearTimeout,fetch:fetcher||fetch,
 });return module.exports;
}
async function main(){
 assert.equal(appRequire('undici/package.json').version,'8.12.3');
 const safe=load({lookup:async()=>[{address:'93.184.216.34',family:4}]});
 for(const ip of ['127.0.0.1','10.0.0.1','169.254.169.254','172.16.0.1','192.168.1.1','::1','::ffff:127.0.0.1'])assert.equal(safe.isPrivateIp(ip),true,ip);
 results.push('pinned dependency loads and private/mapped-private IPs are rejected');
 for(const u of ['http://127.0.0.1','https://localhost','ftp://example.com','https://user:pass@example.com'])await assert.rejects(safe.assertPublicUrl(u));
 results.push('local URLs, credential URLs and unsupported schemes are rejected');
 let calls=0;const a=load({lookup:async h=>[{address:h==='private.invalid'?'127.0.0.1':'93.184.216.34',family:4}],agent:class{async destroy(){}},fetcher:async()=>{calls++;return {status:302,headers:{get:()=> 'http://private.invalid/'},arrayBuffer:async()=>new ArrayBuffer(0)}}});
 await assert.rejects(a.fetchPublic('https://public.invalid/'),e=>e.code==='URL_PRIVATE');assert.equal(calls,1);
 results.push('redirect to private DNS destination is blocked before a second request');
 const mixed=load({lookup:async()=>[{address:'93.184.216.34',family:4},{address:'10.0.0.1',family:4}]});await assert.rejects(mixed.assertPublicUrl('https://mixed.invalid'),e=>e.code==='URL_PRIVATE');
 results.push('mixed public/private DNS responses fail closed');
 let options;const spy=load({lookup:async()=>[],agent:class{constructor(o){options=o}}});spy.testPinnedAgent('93.184.216.34');
 options.connect.lookup('ignored.invalid',{},(err,address,family)=>{assert.equal(err,null);assert.equal(address,'93.184.216.34');assert.equal(family,4)});
 options.connect.lookup('ignored.invalid',{all:true},(err,addresses)=>{assert.equal(err,null);assert.equal(addresses[0].address,'93.184.216.34');assert.equal(addresses[0].family,4)});
 results.push('DNS pin supports scalar and all-address callback contracts');
 const server=http.createServer((_req,res)=>res.end('pinned-fixture'));
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));
 const dispatcher=safe.testPinnedAgent('127.0.0.1');
 try{
  const response=await appRequire('undici').fetch(`http://public-fixture.invalid:${server.address().port}/`,{dispatcher,signal:AbortSignal.timeout(5000)});
  assert.equal(await response.text(),'pinned-fixture');
 }finally{await dispatcher.close();await new Promise(resolve=>server.close(resolve))}
 results.push('matching undici fetch works with dispatcher and DNS pin (isolated loopback fixture only)');
 console.log(JSON.stringify({passed:results.length,results},null,2));
}
main().catch(e=>{console.error(e);process.exitCode=1});
