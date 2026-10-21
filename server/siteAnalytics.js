'use strict';
const crypto=require('node:crypto');
const fs=require('node:fs'),path=require('node:path');
const invalid=message=>Object.assign(new Error(message),{code:'INVALID',status:400});
function googleIds(value){
 const ids=Array.isArray(value)?value:String(value||'').split(/[\s,]+/);
 const clean=[...new Set(ids.map(x=>String(x).trim().toUpperCase()).filter(Boolean))];
 if(clean.length>3||clean.some(x=>! /^(?:G|GT)-[A-Z0-9]{6,20}$/.test(x)))throw invalid('Enter up to three Google tag IDs, such as G-XXXXXXXXXX or GT-XXXXXXXX.');
 return clean;
}
function ensure(db){db.exec(`CREATE TABLE IF NOT EXISTS site_analytics_settings (
 website_id INTEGER PRIMARY KEY, token TEXT NOT NULL UNIQUE, internal_enabled INTEGER NOT NULL DEFAULT 0,
 google_ids TEXT NOT NULL DEFAULT '[]', updated_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP);
 CREATE TABLE IF NOT EXISTS site_analytics_daily (
 website_id INTEGER NOT NULL, day TEXT NOT NULL, path TEXT NOT NULL, kind TEXT NOT NULL,
 count INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(website_id,day,path,kind));
 CREATE INDEX IF NOT EXISTS site_analytics_retention ON site_analytics_daily(day);`);}
function exists(db){return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_analytics_settings'").get();}
function siteForLead(db,leadId){const site=db.prepare('SELECT * FROM websites WHERE lead_id=? ORDER BY id DESC LIMIT 1').get(Number(leadId));if(!site)throw Object.assign(new Error('Your website is not available yet.'),{code:'NO_SITE',status:404});return site;}
function settings(db,leadId){const site=siteForLead(db,leadId);ensure(db);const row=db.prepare('SELECT * FROM site_analytics_settings WHERE website_id=?').get(site.id);return {siteId:site.id,internalEnabled:!!row?.internal_enabled,googleIds:row?JSON.parse(row.google_ids):[],retentionDays:90};}
function save(db,workspaceId,leadId,body){
 const site=siteForLead(db,leadId);
 if(typeof body.internalEnabled!=='boolean')throw invalid('Choose whether to enable built-in analytics.');
 const ids=googleIds(body.googleIds);ensure(db);
 db.prepare(`INSERT INTO site_analytics_settings(website_id,token,internal_enabled,google_ids) VALUES(?,?,?,?)
 ON CONFLICT(website_id) DO UPDATE SET internal_enabled=excluded.internal_enabled,google_ids=excluded.google_ids,updated_at=CURRENT_TIMESTAMP`)
 .run(site.id,`${workspaceId}_${crypto.randomBytes(24).toString('hex')}`,body.internalEnabled?1:0,JSON.stringify(ids));
 return settings(db,leadId);
}
function pagesFor(site){
 let pages;try{pages=typeof site.pages==='string'?JSON.parse(site.pages):site.pages}catch{return new Set(['/','/index.html'])}
 const engine=require('../src/websiteEngine');const paths=new Set(['/','/index.html']);
 for(const p of (Array.isArray(pages)?pages:[]).slice(0,100)){
  const file=engine.isHomePage(p,pages)?'index.html':engine.pageFileName(p.slug);
  if(/^[a-zA-Z0-9_./-]{1,160}$/.test(file)&&!file.includes('..'))paths.add('/'+file.replace(/^\/+/,''));
 }
 return paths;
}
function lookup(db,token){
 if(!exists(db))return null;
 const row=db.prepare('SELECT * FROM site_analytics_settings WHERE token=?').get(token);
 if(!row)return null;const site=db.prepare('SELECT * FROM websites WHERE id=?').get(row.website_id);
 return site?{row,site}:null;
}
function allowedOrigin(db,site,origin){
 if(!origin||origin==='null')return false;
 let u;try{u=new URL(origin);if(u.origin!==origin||u.protocol!=='https:')return false}catch{return false}
 const urls=[site.preview_url];
 if(db.prepare("SELECT 1 FROM sqlite_master WHERE type='table' AND name='site_domains'").get()){
  for(const row of db.prepare('SELECT domain_name,public_url,status FROM site_domains WHERE website_id=?').all(site.id)){
   if(!['active','linked','connected'].includes(row.status))continue;
   urls.push(row.public_url,'https://'+row.domain_name);
  }
 }
 return urls.some(value=>{try{
  const published=new URL(value);if(published.protocol!=='https:')return false;
  if(published.origin===origin)return !isAppOrigin(origin);
  // Deployment and production aliases of this exact Pages project only.
  const m=published.hostname.match(/^(?:[a-z0-9-]+\.)?([a-z0-9-]+)\.pages\.dev$/i);
  const tracking=db.prepare('SELECT token FROM site_analytics_settings WHERE website_id=?').get(site.id);
  const ws=tracking?.token.split('_')[0];
  return !!m && m[1]===`bp-w${ws}-s${site.id}` && (u.hostname===`${m[1]}.pages.dev`||u.hostname.endsWith(`.${m[1]}.pages.dev`))&&u.port==='';
 }catch{return false}});
}
function isAppOrigin(origin){try{return new URL(process.env.APP_URL||'https://bitpype.com').origin===origin}catch{return false}}
function config(db,token,origin){const found=lookup(db,token);if(!found||!allowedOrigin(db,found.site,origin))return null;
 return {internalEnabled:!!found.row.internal_enabled,googleIds:JSON.parse(found.row.google_ids),paths:[...pagesFor(found.site)],consentVersion:1};}
function collect(db,token,origin,body){
 const found=lookup(db,token);if(!found||!allowedOrigin(db,found.site,origin))return false;
 if(!found.row.internal_enabled)return true;
 if(!body||body.consent!==true||!['pageview','click'].includes(body.event))throw invalid('Invalid analytics event.');
 const kind=body.event==='pageview'?'pageview':body.kind;
 if(body.event==='click'&&!['phone','email','internal','external','button'].includes(kind))throw invalid('Invalid click category.');
 const p=body.path==='/'?'/index.html':body.path;
 if(typeof p!=='string'||!pagesFor(found.site).has(p))throw invalid('Unknown website page.');
 db.transaction(()=>{
  db.prepare("DELETE FROM site_analytics_daily WHERE day < date('now','-89 days')").run();
  const n=db.prepare("SELECT COALESCE(SUM(count),0) n FROM site_analytics_daily WHERE website_id=? AND day=date('now')").get(found.site.id).n;
  if(n>=100000)return;
  db.prepare(`INSERT INTO site_analytics_daily(website_id,day,path,kind,count) VALUES(?,date('now'),?,?,1)
   ON CONFLICT(website_id,day,path,kind) DO UPDATE SET count=count+1`).run(found.site.id,p,kind);
 }).immediate();return true;
}
function report(db,leadId,days){const setting=settings(db,leadId);days=Number(days||30);if(![7,30,90].includes(days))throw invalid('Choose 7, 30 or 90 days.');
 db.prepare("DELETE FROM site_analytics_daily WHERE day < date('now','-89 days')").run();
 const rows=db.prepare("SELECT day,path,kind,count FROM site_analytics_daily WHERE website_id=? AND day>=date('now',?) ORDER BY day,path,kind").all(setting.siteId,`-${days-1} days`);
 const daily=new Map(),paths=new Map(),clicks=new Map();let visits=0,totalClicks=0;
 for(const r of rows){if(!daily.has(r.day))daily.set(r.day,{day:r.day,visits:0,clicks:0});if(r.kind==='pageview'){visits+=r.count;daily.get(r.day).visits+=r.count;paths.set(r.path,(paths.get(r.path)||0)+r.count)}else{totalClicks+=r.count;daily.get(r.day).clicks+=r.count;clicks.set(r.kind,(clicks.get(r.kind)||0)+r.count)}}
 return {...setting,days,visits,clicks:totalClicks,daily:[...daily.values()],pages:[...paths].map(([path,visits])=>({path,visits})).sort((a,b)=>b.visits-a.visits),clickTypes:[...clicks].map(([kind,count])=>({kind,count})),note:'Page visits count consented page loads, not unique people. UTC dates; automated traffic may be included.'};}
function inject(db,websiteId,dir){
 if(!exists(db))return 0;const row=db.prepare('SELECT * FROM site_analytics_settings WHERE website_id=?').get(websiteId);
 if(!row)return 0;
 const base=new URL(process.env.APP_URL||'https://bitpype.com');if(base.protocol!=='https:')throw invalid('Analytics requires an HTTPS app URL.');
 const esc=s=>String(s).replace(/&/g,'&amp;').replace(/"/g,'&quot;').replace(/</g,'&lt;');
 let n=0;for(const name of fs.readdirSync(dir).filter(x=>/\.html?$/i.test(x))){
  const f=path.join(dir,name);let html=fs.readFileSync(f,'utf8');
  html=html.replace(/\n?<!-- bitpype-analytics -->[\s\S]*?<!-- \/bitpype-analytics -->\n?/g,'');
  if(row.internal_enabled||JSON.parse(row.google_ids).length){
   // Replace the old informational notice only for analytics-enabled exports.
   html=html.replace(/\n?<!-- bitpype-cookie-bar -->[\s\S]*?<!-- \/bitpype-cookie-bar -->\n?/g,'');
   const snippet=`\n<!-- bitpype-analytics -->\n<script defer src="${esc(base.origin)}/js/site-analytics.js?v=1" data-site-token="${esc(row.token)}"></script>\n<!-- /bitpype-analytics -->\n`;
   html=/<\/body>/i.test(html)?html.replace(/<\/body>/i,snippet+'</body>'):html+snippet;
  }
  fs.writeFileSync(f,html,'utf8');n++;
 }return n;
}
module.exports={googleIds,ensure,siteForLead,settings,save,report,config,collect,inject,lookup,allowedOrigin,pagesFor};
