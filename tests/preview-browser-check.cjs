'use strict';
// Synthetic HTTP server and browser only: no production credentials or databases.
const assert=require('node:assert/strict'),http=require('node:http'),path=require('node:path'),fs=require('node:fs');
const express=require('express'),puppeteer=require('puppeteer');
const {rejectOpaqueAppRequests,isolateStaticPreview,CAPTCHA_CSP}=require('../server/previewSecurity');
const root=path.resolve(__dirname,'..'),app=express();let browser,server,base,previewHtml,privateReads=0,submissions=0;
app.use(rejectOpaqueAppRequests);
app.use((req,res,next)=>{if(req.path.startsWith('/api/')||req.path.startsWith('/js/')){res.set('Access-Control-Allow-Origin','*');res.set('Cross-Origin-Resource-Policy','cross-origin');res.set('Access-Control-Allow-Headers','Content-Type');if(req.method==='OPTIONS')return res.sendStatus(204);}next();});
app.use(express.json());
app.get('/api/v1/portal/private',(req,res)=>{privateReads++;res.json({secret:'synthetic'});});
app.get('/api/v1/captcha/config',(req,res)=>res.json({ok:true,data:{enabled:true,siteKey:'synthetic-test-key'}}));
app.get('/api/v1/forms/public/1_fixture',(req,res)=>res.json({ok:true,data:{title:'Fixture contact',fields:[{field_key:'name',label:'Name',field_type:'text',required:true}],success_message:'Fixture received'}}));
app.post('/api/v1/forms/public/1_fixture/submit',(req,res)=>{assert.equal(req.headers.cookie,undefined);assert.equal(req.body.captchaToken,'synthetic-token');submissions++;res.json({ok:true,data:{success_message:'Fixture received'}});});
app.get('/api/v1/chat/public/1_fixture',(req,res)=>res.json({ok:true,data:{settings:{bubble_label:'Fixture chat'}}}));
app.get('/api/v1/modules/public/1_fixture',(req,res)=>res.json({ok:true,data:{module_type:'bookings',title:'Fixture booking',items:[{id:1,name:'Consultation'}],booking:{settings:{}}}}));
app.get('/api/v1/modules/public/1_fixture/slots',(req,res)=>res.json({ok:true,data:{slots:[{starts_at:'2026-10-25T10:00:00Z',ends_at:'2026-10-25T10:30:00Z',label:'10:00'}]}}));
app.use('/js',express.static(path.join(root,'public/js')));
app.use('/embed',(req,res,next)=>{res.set('Content-Security-Policy',CAPTCHA_CSP);next();},express.static(path.join(root,'public/embed')));
app.get('/site-previews/fixture.html',isolateStaticPreview,(req,res)=>res.type('html').send(previewHtml));
app.get('/',(req,res)=>{res.set('Set-Cookie','fixture_auth=synthetic; HttpOnly; SameSite=Lax; Path=/');res.type('html').send('<!doctype html><html><head></head><body><h1 id="parent-secret">Parent only</h1><iframe id="preview" sandbox="allow-scripts allow-forms"></iframe><script>window.events=[];window.addEventListener("message",e=>{if(e.source===document.getElementById("preview").contentWindow)window.events.push(e.data)});</script></body></html>');});
async function main(){
 try{
  server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));base='http://127.0.0.1:'+server.address().port;process.env.APP_URL=base;
  const engine=require('../src/websiteEngine');
  const pageSpec={slug:'/',title:'Fixture',html:`<!doctype html><html><head></head><body><h1 id="headline" style="color:#112233">Editable heading</h1><div data-bitpype-form-embed="1_fixture" data-bitpype-api="${base}"></div><div data-bitpype-module="bookings" data-bitpype-module-token="1_fixture" data-bitpype-api="${base}"></div><div class="bitpype-chat-embed" data-bitpype-chat="1" data-bitpype-chat-token="1_fixture" data-bitpype-api="${base}"></div></body></html>`};
  const customJs=`window.attack={};try{window.attack.parent=parent.document.getElementById('parent-secret').textContent}catch(e){window.attack.parentBlocked=true}try{window.attack.cookie=document.cookie}catch(e){window.attack.cookieBlocked=true}try{localStorage.getItem('secret');window.attack.storage=false}catch(e){window.attack.storage=true}fetch(${JSON.stringify(base+'/api/v1/portal/private')},{credentials:'include'}).then(r=>window.attack.status=r.status).catch(()=>window.attack.fetchBlocked=true);`;
  previewHtml=engine.renderPage(pageSpec,[pageSpec],{primary:'#112233',customJs},{preview:true,editable:true});
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage();const errors=[],networkErrors=[];page.on('pageerror',e=>errors.push(e.message));
  page.on('requestfailed',request=>networkErrors.push({url:request.url(),error:request.failure()?.errorText}));
  page.on('console',message=>{if(message.type()==='error')networkErrors.push({console:message.text()});});
  await page.setRequestInterception(true);page.on('request',req=>{
   if(req.url().startsWith(base))return req.continue();
   if(req.url().startsWith('https://challenges.cloudflare.com/turnstile/'))return req.respond({status:200,contentType:'application/javascript',body:'window.turnstile={render:function(el,opts){setTimeout(function(){opts.callback("synthetic-token")},20);return 1},reset:function(){}};'});
   return req.abort();
  });
  await page.goto(base);await page.$eval('#preview',(el,html)=>{el.srcdoc=html;},previewHtml);
  await page.waitForFunction(()=>{const frame=document.querySelector('#preview');return frame&&window.events.some(e=>e.type==='ready');},{timeout:15000});
  const frame=await (await page.$('#preview')).contentFrame();
  await frame.waitForFunction(()=>window.attack&&(window.attack.status||window.attack.fetchBlocked),{timeout:10000});
  const attack=await frame.evaluate(()=>window.attack);assert(attack.parentBlocked);assert(attack.cookieBlocked||!attack.cookie);assert(attack.storage);assert(attack.status===403||attack.fetchBlocked);assert.equal(privateReads,0);
  assert.equal(await page.$eval('#preview',el=>el.contentDocument),null);
  try {
    await frame.waitForSelector('.bp-form input[name="name"]');await frame.waitForSelector('[data-bp-book]');await frame.waitForSelector('.bp-chat-bubble');
  } catch (error) {
    console.error(JSON.stringify({fixtureErrors:errors,networkErrors,fixtureState:await frame.evaluate(()=>({text:document.body.innerText.slice(0,800),scripts:[...document.scripts].map(s=>s.src),forms:document.querySelectorAll('.bp-form').length,bookings:document.querySelectorAll('[data-bp-book]').length,chats:document.querySelectorAll('.bp-chat-bubble').length}))}));
    throw error;
  }
  await page.evaluate(()=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'theme-preview',colors:{primary:'#334455'},rewrites:[{from:'#112233',to:'#334455'}],font:'serif',headingFont:'serif'},'*'));
  await frame.waitForFunction(()=>document.documentElement.style.getPropertyValue('--ws-primary')==='#334455');
  assert.equal(await frame.$eval('#headline',el=>el.style.color),'rgb(51, 68, 85)');
  await frame.evaluate(()=>window.postMessage({source:'ws-portal',type:'site-fonts',font:'monospace'},'*'));
  assert.equal(await frame.evaluate(()=>document.documentElement.style.getPropertyValue('--ws-font')),'serif');
  await page.evaluate(()=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'edit-mode',on:true},'*'));
  await frame.waitForFunction(()=>document.documentElement.classList.contains('ws-editing'));
  await frame.click('#headline [data-edit]');
  await frame.type('#headline [data-edit]',' updated');
  await page.click('#parent-secret');
  await page.waitForFunction(()=>window.events.some(e=>e.source==='ws-preview'&&typeof e.text==='string'&&e.text.includes('updated')));
  await page.evaluate(()=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'set-font',family:'monospace',name:''},'*'));
  await page.waitForFunction(()=>window.events.some(e=>e.type==='element-font'));
  await page.evaluate(()=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'edit-mode',on:false},'*'));
  await frame.waitForFunction(()=>!document.documentElement.classList.contains('ws-editing'));
  // Only synthetic fixture records are submitted; captcha API is stubbed above.
  await frame.waitForFunction(()=>{const f=document.querySelector('.bp-form');return f&&typeof f.onsubmit==='function';},{timeout:15000});
  await frame.type('.bp-form input[name="name"]','Synthetic fixture');await frame.click('.bp-form button[type="submit"]');
  await frame.waitForFunction(()=>document.querySelector('.bp-form-msg.ok'));
  assert.equal(submissions,1);
  await page.evaluate(()=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'edit-mode',on:true},'*'));
  await frame.waitForFunction(()=>document.documentElement.classList.contains('ws-editing'));
  const canvasId=await frame.$eval('#headline',el=>{el.setAttribute('data-ws-canvas-id','fixture-target');return 'fixture-target';});
  await page.evaluate(id=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'insert-block',targetId:id,html:'<span id="fixture-added">Synthetic block</span>'},'*'),canvasId);
  await frame.waitForSelector('#fixture-added');
  await page.evaluate(()=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'undo'},'*'));
  await frame.waitForFunction(()=>!document.querySelector('#fixture-added'));
  const direct=await browser.newPage();await direct.setRequestInterception(true);direct.on('request',req=>req.url().startsWith(base)?req.continue():req.abort());await direct.goto(base+'/site-previews/fixture.html');
  assert.equal(await direct.evaluate(()=>window.origin),'null');
  assert(!errors.length,'Unexpected browser exceptions: '+errors.join('; '));
  // A modular edit and its undo must serialize its section, never the page/nav.
  const modular={slug:'/',title:'Modular fixture',sections:[
    {type:'nav',content:{html:'<header id="module-nav"><nav><a href="index.html">Home</a></nav></header>'}},
    {type:'html',content:{html:'<style>.fixture-row{padding:8px}</style><section id="module-body"><h1 id="module-heading">Modular heading</h1><ul id="module-list"><li class="fixture-row">First item</li><li class="fixture-row">Second item</li><li class="fixture-row">Third item</li></ul></section>'}},
    {type:'html',content:{html:'<section id="module-sibling"><h2>Sibling content unchanged</h2></section>'}}
  ]};
  previewHtml=engine.renderPage(modular,[modular],{}, {preview:true,editable:true});
  await page.evaluate(url=>{window.events=[];document.querySelector('#preview').style.cssText='width:100%;height:1200px';document.querySelector('#preview').removeAttribute('srcdoc');document.querySelector('#preview').src=url},base+'/site-previews/fixture.html?modular=1');
  assert(previewHtml.includes('id="module-list"'));
  const modularFrame=await page.waitForFrame(frame=>frame.url().includes('modular=1'));
  await modularFrame.waitForSelector('#module-list');
  await page.evaluate(()=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'edit-mode',on:true},'*'));
  await modularFrame.waitForSelector('#module-list .ws-ff-add');
  // Activate the button directly: nested opaque iframe scrolling is unstable in headless Chromium.
  await modularFrame.$eval('#module-list .ws-ff-add',el=>el.click());
  await page.waitForFunction(()=>window.events.some(event=>event.action==='freeform-save'));
  const modularSaved=await page.evaluate(()=>window.events.filter(event=>event.action==='freeform-save').at(-1));
  assert.equal(modularSaved.sectionIndex,1);
  assert(modularSaved.html.includes('First item'));
  assert(!modularSaved.html.includes('id="module-nav"'));
  assert(!modularSaved.html.includes('Sibling content unchanged'));
  await page.evaluate(()=>document.querySelector('#preview').contentWindow.postMessage({source:'ws-portal',type:'undo'},'*'));
  await modularFrame.waitForFunction(()=>document.querySelectorAll('#module-list li').length===3);
  assert.equal(await modularFrame.$eval('#module-nav',el=>el.querySelectorAll('h1,h2').length),0);
  const modularUndone=await page.evaluate(()=>window.events.filter(event=>event.action==='freeform-save').at(-1));
  assert.equal(modularUndone.sectionIndex,1);
  assert(!modularUndone.html.includes('id="module-nav"'));
  console.log(JSON.stringify({passed:true,groups:13,checks:['opaque parent DOM/cookie/storage isolation','private API denied without side effects','form/chat/booking mounts','theme/font bridge','foreign message rejection','edit mode bridge','inline text edits','element font changes','block insertion and undo','synthetic form and captcha plumbing','direct fallback sandbox','no browser exceptions','modular list edit and undo retain section context']}));
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
