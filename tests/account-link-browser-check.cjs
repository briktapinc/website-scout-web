'use strict';
// Actual app shell/router against synthetic APIs. No mail, passwords or payment actions.
const assert=require('node:assert/strict'),path=require('node:path'),http=require('node:http'),express=require('express'),puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..'),app=express();let signedIn=false,writes=0,browser,server;
app.use((req,res,next)=>{if(req.method!=='GET'){writes++;return res.status(500).json({ok:false,error:'No fixture writes allowed'});}next();});
app.get('/api/v1/auth/me',(req,res)=>signedIn?res.json({ok:true,data:{user:{id:1,email:'fixture@example.invalid',isSuperAdmin:true},workspaceId:1,workspaces:[{id:1,name:'Fixture',role:'owner'}],isSuperAdmin:true,productAccess:true}}):res.status(401).json({ok:false,error:'AUTH_REQUIRED',code:'AUTH_REQUIRED'}));
app.get('/api/v1/captcha/config',(req,res)=>res.json({ok:true,data:{enabled:false}}));
app.get('/api/v1/billing/summary',(req,res)=>res.json({ok:true,data:{plan:'free',plans:[],email:'fixture@example.invalid',isSuperAdmin:true,credits:{balance:0}}}));
app.use('/api/v1',(req,res)=>res.json({ok:true,data:{}}));
app.get('/app',(req,res)=>res.sendFile(path.join(root,'public/index.html')));
app.use(express.static(path.join(root,'public'),{index:false}));
async function main(){
 try{
  server=http.createServer(app);await new Promise(r=>server.listen(0,'127.0.0.1',r));const base='http://127.0.0.1:'+server.address().port;
  browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
  const page=await browser.newPage(),errors=[];page.on('pageerror',e=>errors.push(e.message));await page.setRequestInterception(true);page.on('request',r=>r.url().startsWith(base)?r.continue():r.abort());
  await page.goto(base+'/app#/reset/synthetic-fixture-reset');await page.waitForFunction(()=>document.querySelector('#auth-gate').dataset.mode==='reset');
  await page.waitForSelector('#a-pass2',{visible:true});assert.equal(new URL(page.url()).hash,'#/reset/synthetic-fixture-reset');
  await page.goto(base+'/app#/invite/synthetic-fixture-invite');await page.waitForFunction(()=>document.querySelector('#auth-gate').textContent.includes('You were invited'));
  assert.equal(new URL(page.url()).hash,'#/invite/synthetic-fixture-invite');assert.equal(await page.$eval('#auth-gate',el=>el.dataset.mode),'login');
  await page.goto(base+'/app#/billing?checkout=success&plan=standard');await page.waitForFunction(()=>location.hash==='#/login');
  assert.equal(await page.evaluate(()=>sessionStorage.getItem('scout.returnHash')),'#/billing?checkout=success&plan=standard');
  signedIn=true;await page.reload();await page.waitForFunction(()=>document.querySelector('#view h1')?.textContent==='Billing & plans');
  assert.equal(new URL(page.url()).hash,'#/billing?checkout=success&plan=standard');assert(await page.$eval('#view',el=>el.textContent.includes('Payment received.')));
  assert.equal(writes,0);assert.equal(errors.length,0,errors.join('; '));
  console.log(JSON.stringify({passed:true,groups:4,checks:['signed-out reset form retains fixture token','signed-out invite login retains fixture token','expired billing session preserves return route','signed-in billing return reaches requested screen'],fixtureWrites:writes}));
 }finally{if(browser)await browser.close();if(server)await new Promise(r=>server.close(r));}
}
main().catch(e=>{console.error(e);process.exitCode=1;});
