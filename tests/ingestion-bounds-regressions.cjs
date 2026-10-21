'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),http=require('node:http'),zlib=require('node:zlib');
const {Agent,fetch}=require('undici');
const root=path.resolve(process.env.BITPYPE_TEST_ROOT||path.join(__dirname,'..'));
const source=fs.readFileSync(path.join(root,'server/urlSafety.js'),'utf8');
let active=0,created=0,destroyed=0,redirectBytes=0;
class FixtureAgent extends Agent{
 constructor(){super({connect:{lookup(_h,opts,cb){cb(null,opts.all?[{address:'127.0.0.1',family:4}]:'127.0.0.1',4)}}});active++;created++;}
 destroy(error, callback){if(typeof callback === "function")return super.destroy(error,callback);active--;destroyed++;return super.destroy(error);}
}
function load(lookup=async()=>[{address:'93.184.216.34',family:4}]){
 const m={exports:{}};vm.runInNewContext(source,{module:m,exports:m.exports,require:n=>n==='undici'?{Agent:FixtureAgent,fetch}:n==='dns'?{promises:{lookup}}:require(n),process:{env:{NODE_ENV:'production'}},URL,Buffer,Headers,Response,AbortController,AbortSignal,setTimeout,clearTimeout});return m.exports;
}
const server=http.createServer((req,res)=>{
 if(req.url==='/small'){res.setHeader('content-type','text/html');return res.end('<h1>Fixture café</h1>');}
 if(req.url==='/empty'){res.writeHead(204);return res.end();}
 if(req.url==='/large'){res.writeHead(200,{'content-type':'text/html'});res.end(Buffer.alloc(100000,97));return;}
 if(req.url==='/compressed'){res.writeHead(200,{'content-encoding':'gzip'});res.end(zlib.gzipSync(Buffer.alloc(100000,97)));return;}
 if(req.url.startsWith('/redirect')){
  res.writeHead(302,{location:req.url==='/redirect-private'?'http://private.fixture/':'/small'});res.flushHeaders();
  const timer=setInterval(()=>{redirectBytes+=1024;res.write(Buffer.alloc(1024))},5);res.on('close',()=>clearInterval(timer));return;
 }
 if(req.url==='/loop'){res.writeHead(302,{location:'/loop'});return res.end();}
 if(req.url==='/slow'){res.writeHead(200);res.write('x');const timer=setInterval(()=>res.write('x'),100);res.on('close',()=>clearInterval(timer));return;}
 if(req.url==='/delay-redirect'){const timer=setTimeout(()=>{res.writeHead(302,{location:'/slow'});res.end()},120);res.on('close',()=>clearTimeout(timer));return;}
 if(req.url==='/headers'){return;}
 res.writeHead(404);res.end('missing');
});
(async()=>{
 await new Promise(resolve=>server.listen(0,'127.0.0.1',resolve));let groups=0;
 const url=p=>`http://public.fixture:${server.address().port}${p}`,safe=load();
 try{
  let r=await safe.fetchPublic(url('/small'),{maxBytes:100});assert.equal(await r.text(),'<h1>Fixture café</h1>');assert.equal(r.url,url('/small'));assert.equal(active,0);groups++;
  r=await safe.fetchPublic(url('/empty'));assert.equal(r.status,204);assert.equal(await r.text(),'');groups++;
  for(const p of ['/large','/compressed']){await assert.rejects(safe.fetchPublic(url(p),{maxBytes:1000}),e=>e.code==='URL_BODY_TOO_LARGE');assert.equal(active,0);groups++;}
  r=await safe.fetchPublic(url('/redirect'));assert.match(await r.text(),/Fixture/);assert(redirectBytes<100000);assert.equal(active,0);groups++;
  await assert.rejects(safe.fetchPublic(url('/loop'),{maxRedirects:2}),e=>e.code==='URL_REDIRECTS');assert.equal(active,0);groups++;
  const guarded=load(async h=>[{address:h==='private.fixture'?'127.0.0.1':'93.184.216.34',family:4}]);await assert.rejects(guarded.fetchPublic(url('/redirect-private')),e=>e.code==='URL_PRIVATE');assert.equal(active,0);groups++;
  for(const p of ['/slow','/headers','/delay-redirect']){const before=Date.now();await assert.rejects(safe.fetchPublic(url(p),{timeoutMs:220}),e=>e.code==='URL_TIMEOUT');assert(Date.now()-before<800);assert.equal(active,0);groups++;}
  const stalled=load(()=>new Promise(()=>{}));const before=Date.now();await assert.rejects(stalled.fetchPublic(url('/small'),{timeoutMs:60}),e=>e.code==='URL_TIMEOUT');assert(Date.now()-before<500);groups++;
  for(let i=0;i<12;i++)await safe.fetchPublic(url('/redirect'));assert.equal(active,0);assert.equal(created,destroyed);groups++;
  r=await safe.fetchPublic(url('/missing'));assert.equal(r.status,404);assert.equal(await r.text(),'missing');groups++;
  const ingest=fs.readFileSync(path.join(root,'src/siteIngest.js'),'utf8');
  const ctx={Date,TextDecoder,FETCH_MS:500,MAX_HTML:1000,UA:'synthetic-fixture',require:()=>safe};vm.createContext(ctx);
  vm.runInContext(ingest.slice(ingest.indexOf('async function fetchHtml('),ingest.indexOf('/**',ingest.indexOf('async function fetchHtml(')))+';this.fetchHtml=fetchHtml;',ctx);
  const small=await ctx.fetchHtml(url('/small'));assert.equal(small.ok,true);assert.match(small.html,/Fixture café/);groups++;
  const large=await ctx.fetchHtml(url('/large'));assert.equal(large.ok,false);assert.equal(large.html,'');assert.match(large.error,/size limit/);assert.equal(active,0);groups++;
  console.log(JSON.stringify({passed:true,groups,dispatchersCreated:created,dispatchersDestroyed:destroyed,checks:['bounded decoded bodies','gzip expansion bounded','redirect cancellation','redirect budget and SSRF','shared DNS/header/body/redirect deadline','dispatcher cleanup on every path','success, empty and error contracts']}));
 }finally{server.closeAllConnections();await new Promise(resolve=>server.close(resolve));}
})().catch(e=>{console.error(e);process.exitCode=1});
