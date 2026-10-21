'use strict';
const fs=require('node:fs'),path=require('node:path'),vm=require('node:vm'),assert=require('node:assert/strict');
const root=path.resolve(process.argv[2] || path.join(__dirname,'..'));
const source=fs.readFileSync(path.join(root,'public/js/portal.js'),'utf8');
const html=fs.readFileSync(path.join(root,'public/portal.html'),'utf8');
const panels=[...html.matchAll(/<button[^>]*role="tab"[^>]*data-panel="([^"]+)"/g)].map(m=>m[1]);
assert(panels.includes('leadscout'));
const handlers={},nodes=new Map();
function node(id){return {id,attrs:{hidden:'','aria-selected':'false'},setAttribute(k,v){this.attrs[k]=v;},removeAttribute(k){delete this.attrs[k];},getAttribute(k){return k==='data-panel'?id:this.attrs[k];},focus(){this.focused=true;}};}
for(const id of panels)nodes.set(id,{section:node(id),tab:node(id)});
const nav={addEventListener(k,fn){handlers[k]=fn;},contains(b){return [...nodes.values()].some(n=>n.tab===b);},querySelectorAll(){return [...nodes.values()].map(n=>n.tab);}};
const location={hash:'#/website',search:'',href:'https://example.test/portal#/website'};
const context={location,URL,URLSearchParams,history:{replaceState(a,b,url){location.hash=url.includes('#')?url.slice(url.indexOf('#')):'';}},state:{editFullscreen:false},window:{addEventListener(k,fn){handlers[k]=fn;}},document:{getElementById(){return nav;},querySelector(sel){if(sel==='.wrap')return {classList:{toggle(){}}};const id=sel.match(/data-panel="([^"]+)"/)[1];return nodes.get(id)[sel.startsWith('section')?'section':'tab'];}},showGate(){},setEditFullscreen(){},portalCheckoutFlag(){return false;},loadAnalytics:async()=>{},loadReferrals:async()=>{},refreshMcpTokens:async()=>{}};
vm.createContext(context);
vm.runInContext(source.slice(source.indexOf('  const PORTAL_PANELS'),source.indexOf('  function showGate()'))+'\nportalAuthed=true;globalThis.show=showPortalPanel;globalThis.resolve=resolvePortalPanel;globalThis.sync=syncPortalPanelFromHash;',context);
function selected(id){assert.equal(nodes.get(id).tab.attrs['aria-selected'],'true');for(const [key,n]of nodes){assert.equal('hidden'in n.section.attrs,key!==id);assert.equal(n.tab.attrs['aria-selected'],String(key===id));}}
for(const id of panels){context.show(id);selected(id);assert.equal(location.hash,'#/'+id);}
const target=nodes.get('leadscout').tab;target.closest=()=>target;handlers.click({target});selected('leadscout');
location.hash='#/leadscout';handlers.hashchange();selected('leadscout');
context.show('forms');let prevented=false;handlers.keydown({key:'ArrowRight',preventDefault(){prevented=true;}});assert(prevented);selected('leadscout');assert(target.focused);
context.show('modules');selected('modules');assert('hidden'in nodes.get('leadscout').section.attrs);
location.hash='';location.search='?panel=leadscout';context.sync();selected('leadscout');
assert.equal(context.resolve('LEADSCOUT'),'leadscout');context.show('unknown');selected('website');
console.log(JSON.stringify({passed:true,groups:7,renderedTabs:panels.length,checks:['all rendered tabs','click','hash link','keyboard','hide on leave','query link','fallback']}));
