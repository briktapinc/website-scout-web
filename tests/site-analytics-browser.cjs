'use strict';
const assert=require('assert/strict'),fs=require('fs'),path=require('path'),puppeteer=require('puppeteer');
const root=path.resolve(__dirname,'..'),tracker=fs.readFileSync(path.join(root,'public/js/site-analytics.js'),'utf8');
const token='7_'+'a'.repeat(48),app='https://app.example.invalid',site='https://site.example.invalid';
let browser,groups=0;
const fixture=`<!doctype html><meta name="viewport" content="width=device-width"><body><h1>Fixture</h1><button id="action">Action</button><input id="private" value="PRIVATE-FIXTURE"><script src="${app}/js/site-analytics.js" data-site-token="${token}"></script></body>`;
async function make({iframe=false,gpc=false,webdriver=false,host=site}={}){
 const context=await browser.createBrowserContext(),page=await context.newPage(),events=[],google=[],errors=[];
 page.on('pageerror',e=>errors.push(e.message));
 await page.evaluateOnNewDocument(({gpc,webdriver})=>{Object.defineProperty(navigator,'webdriver',{get:()=>webdriver});Object.defineProperty(navigator,'globalPrivacyControl',{get:()=>gpc});},{gpc,webdriver});
 await page.setRequestInterception(true);
 page.on('request',r=>{
  if(r.url().startsWith('https://www.googletagmanager.com/')){google.push(r.url());return r.respond({status:200,contentType:'application/javascript',body:'/* synthetic tag; no Google traffic */'})}
  if(r.url().includes('/js/site-analytics.js'))return r.respond({status:200,headers:{'Cross-Origin-Resource-Policy':'cross-origin'},contentType:'application/javascript',body:tracker});
  if(r.url().includes('/config'))return r.respond({status:200,headers:{'Access-Control-Allow-Origin':'*'},contentType:'application/json',body:JSON.stringify({ok:true,data:{internalEnabled:true,googleIds:['G-ABC1234567'],paths:['/index.html'],consentVersion:1}})});
  if(r.url().includes('/events')){events.push(JSON.parse(r.postData()));return r.respond({status:204,headers:{'Access-Control-Allow-Origin':'*'}})}
  if(r.url().startsWith(host))return r.respond({status:200,contentType:'text/html',body:iframe?'<iframe src="'+site+'/child"></iframe>':fixture});
  if(iframe&&r.url().startsWith(site))return r.respond({status:200,contentType:'text/html',body:fixture});
  return r.abort();
 });
 await page.goto(host+'/index.html?email=PRIVATE-FIXTURE',{waitUntil:'networkidle0'});
 return {context,page,events,google,errors};
}
(async()=>{try{
 browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 const f=await make();await f.page.waitForSelector('#bp-analytics-consent');assert.equal(f.events.length,0);assert.equal(f.google.length,0);groups++;
 await f.page.click('#bp-analytics-allow');await f.page.waitForFunction(()=>document.querySelector('script[src^="https://www.googletagmanager.com/"]'));
 await f.page.waitForNetworkIdle();assert.equal(f.events.length,1);assert.equal(f.events[0].path,'/index.html');assert.equal(f.google.length,1);groups++;
 await f.page.click('#action');await f.page.waitForNetworkIdle();assert.equal(f.events[1].kind,'button');assert.equal(f.events[1].event,'click');assert(!JSON.stringify(f.events).includes('PRIVATE-FIXTURE'));groups++;
 const layer=await f.page.evaluate(()=>window.dataLayer.map(x=>Array.from(x)));assert(layer.some(x=>x[0]==='consent'&&x[1]==='default'&&x[2].analytics_storage==='denied'));assert(layer.some(x=>x[0]==='config'&&x[2].send_page_view===false));assert(layer.filter(x=>x[0]==='event'&&x[1]==='page_view').every(x=>!x[2].page_location.includes('?')));groups++;
 await f.page.click('#bp-analytics-privacy');await f.page.click('#bp-analytics-decline');await f.page.click('#action');await f.page.waitForNetworkIdle();assert.equal(f.events.length,2);assert.equal(await f.page.evaluate(()=>window['ga-disable-G-ABC1234567']),true);groups++;
 await f.page.reload({waitUntil:'networkidle0'});assert.equal(f.google.length,1);assert.equal(f.events.length,2);assert.equal(await f.page.$('#bp-analytics-consent'),null);groups++;
 await f.page.click('#bp-analytics-privacy');await f.page.click('#bp-analytics-allow');await f.page.waitForNetworkIdle();assert.equal(f.events.length,3);assert.equal(f.google.length,2);groups++;
 await f.page.click('#bp-analytics-privacy');await f.page.click('#bp-analytics-decline');await f.page.click('#bp-analytics-privacy');await f.page.click('#bp-analytics-allow');assert.equal(await f.page.evaluate(()=>window['ga-disable-G-ABC1234567']),false);assert.equal(f.errors.length,0,f.errors.join(';'));groups++;
 await f.context.close();
 for(const options of [{gpc:true},{webdriver:true},{host:app},{iframe:true,host:'https://parent.example.invalid'}]){const x=await make(options);assert.equal(x.events.length,0);assert.equal(x.google.length,0);if(options.gpc){await x.page.click('#bp-analytics-privacy');await x.page.click('#bp-analytics-allow');assert.equal(x.events.length,0);assert.equal(x.google.length,0)}assert.equal(x.errors.length,0,x.errors.join(';'));await x.context.close();groups++}
 console.log(JSON.stringify({passed:true,groups,checks:['no Google/events before opt-in','consented pageview and real click','query/input exclusion','Google consent/defaults','revoke/reaccept','saved decline','GPC','automation exclusion','app-host exclusion','iframe preview exclusion']}));
}finally{if(browser)await browser.close()}})().catch(e=>{console.error(e);process.exitCode=1});
