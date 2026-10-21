'use strict';
const assert=require('node:assert/strict'),fs=require('node:fs'),path=require('node:path'),puppeteer=require('puppeteer');
const root=path.resolve(process.env.BITPYPE_TEST_ROOT||path.join(__dirname,'..'));
const html=fs.readFileSync(path.join(root,'public/portal.html'),'utf8'),source=fs.readFileSync(path.join(root,'public/js/portal.js'),'utf8');
const style=html.match(/<style>([\s\S]*?)<\/style>/)[1];
const start=source.indexOf('  function hideUpsellTip()'),end=source.indexOf("  document.getElementById('btn-edit-mode').onclick",start);
async function main(){
 const browser=await puppeteer.launch({headless:true,executablePath:process.env.PUPPETEER_EXECUTABLE_PATH||'/usr/bin/chromium',args:['--no-sandbox','--disable-dev-shm-usage']});
 try{
  const page=await browser.newPage();await page.setViewport({width:1100,height:800});
  await page.goto('data:text/html,<!doctype html><html><head></head><body></body></html>');
  await page.evaluate((markup)=>{const template=document.createElement('template');template.innerHTML=markup;document.body.innerHTML='<button id="before">Outside action</button>'+template.content.querySelector('#upsell-tip-modal').outerHTML;},html);
  await page.addStyleTag({content:style});
  const visible=()=>page.$eval('#upsell-tip-modal',el=>getComputedStyle(el).display!=='none');
  assert.equal(await visible(),false,'first paint must hide the empty card');
  assert.equal(await page.$eval('#upsell-tip-modal',el=>el.getAttribute('aria-modal')),null);
  // In-memory synthetic storage and API response only; no app endpoint is called.
  await page.addScriptTag({content:`let portalAuthed=true,upsellTipEpoch=0,upsellTipTimer=null,upsellTipReturnFocus=null;const state={plan:'free'};const sessionStorage={getItem(){return null},setItem(){}};const api=()=>new Promise(resolve=>window.resolveTip=resolve);${source.slice(start,end)}window.tipTest={show:showUpsellTip,hide:hideUpsellTip,maybe:maybeShowUpsellTip,state,logout(){portalAuthed=false;hideUpsellTip()}};document.getElementById('upsell-tip-close').onclick=hideUpsellTip;`});
  await page.click('#before');
  await page.evaluate(()=>window.tipTest.show({title:'Tip',body:'Useful text'}));assert(await visible());
  assert.equal(await page.evaluate(()=>document.activeElement.id),'before','nonmodal tip must not steal focus');
  await page.click('#before');assert.equal(await page.evaluate(()=>document.activeElement.id),'before','outside controls stay clickable');
  await page.click('#upsell-tip-close');assert.equal(await visible(),false);assert.equal(await page.evaluate(()=>document.activeElement.id),'before');
  await page.evaluate(()=>window.tipTest.show({title:' ',body:''}));assert.equal(await visible(),false);
  await page.evaluate(()=>{window.tipTest.state.plan='premium';window.tipTest.show({title:'Tip',body:'Paid users must not see this'});});assert.equal(await visible(),false);
  await page.evaluate(()=>{window.tipTest.state.plan='free';window.pendingTip=window.tipTest.maybe();window.tipTest.state.plan='standard';window.resolveTip({tip:{title:'Stale tip',body:'Must not show'}});});await page.evaluate(()=>window.pendingTip);assert.equal(await visible(),false);
  await page.evaluate(()=>{window.tipTest.state.plan='free';window.pendingTip=window.tipTest.maybe();window.tipTest.hide();window.resolveTip({tip:{title:'Stale tip',body:'Must not show'}});});await page.evaluate(()=>window.pendingTip);assert.equal(await visible(),false);
  await page.evaluate(()=>{window.tipTest.logout();window.tipTest.show({title:'Tip',body:'Signed out'});});assert.equal(await visible(),false);
  console.log(JSON.stringify({passed:true,groups:8,checks:['hidden first paint','nonmodal semantics and focus','outside controls stay usable','dismissal and focus return','empty tips rejected','paid plans excluded','stale plan/context responses ignored','signed-out users excluded']}));
 }finally{await browser.close();}
}
main().catch(e=>{console.error(e);process.exitCode=1});
