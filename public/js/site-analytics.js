'use strict';
(function(){
 const loader=document.currentScript;if(!loader||window.__bitpypeAnalytics)return;
 // Preview frames, app-hosted exports and automation do not become customer traffic.
 if(window.self!==window.top||navigator.webdriver)return;
 const token=loader.getAttribute('data-site-token');if(!/^[1-9]\d{0,11}_[a-f0-9]{48}$/.test(token||''))return;
 const base=new URL(loader.src).origin;if(location.origin===base)return;
 window.__bitpypeAnalytics=true;
 const endpoint=base+'/api/v1/site-analytics/public/'+token;
 const storageKey='bp_analytics_consent_v1_'+token;
 let cfg,active=false,counted=false,googleLoaded=false,clickCount=0;
 function stored(){try{const value=JSON.parse(localStorage.getItem(storageKey)||'null'),age=value&&Date.now()-value.at;return value&&Number.isFinite(age)&&age>=0&&age<180*86400000?value.choice:null}catch{return null}}
 function save(choice){try{localStorage.setItem(storageKey,JSON.stringify({choice,at:Date.now()}))}catch{}}
 function path(){return location.pathname==='/'?'/index.html':location.pathname;}
 function event(type,kind){if(!active||!cfg.internalEnabled||!cfg.paths.includes(path()))return;
  fetch(endpoint+'/events',{method:'POST',credentials:'omit',referrerPolicy:'no-referrer',keepalive:true,headers:{'Content-Type':'text/plain'},body:JSON.stringify({event:type,path:path(),kind,consent:true})}).catch(()=>{});
 }
 function gtag(){window.dataLayer=window.dataLayer||[];window.dataLayer.push(arguments);}
 function startGoogle(){if(googleLoaded||!cfg.googleIds.length)return;googleLoaded=true;
  window.dataLayer=window.dataLayer||[];window.gtag=window.gtag||gtag;
  gtag('consent','default',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});
  gtag('consent','update',{analytics_storage:'granted',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});
  gtag('js',new Date());
  for(const id of cfg.googleIds){window['ga-disable-'+id]=false;gtag('config',id,{send_page_view:false,allow_google_signals:false,allow_ad_personalization_signals:false,page_location:location.origin+path(),page_referrer:''});
   gtag('event','page_view',{send_to:id,page_location:location.origin+path(),page_referrer:'',page_title:''});}
  const script=document.createElement('script');script.async=true;script.src='https://www.googletagmanager.com/gtag/js?id='+encodeURIComponent(cfg.googleIds[0]);document.head.appendChild(script);
 }
 function accept(){if(navigator.globalPrivacyControl===true||navigator.doNotTrack==='1'){reject();return}
  save('accepted');active=true;if(googleLoaded){for(const id of cfg.googleIds)window['ga-disable-'+id]=false;gtag('consent','update',{analytics_storage:'granted',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'})}else startGoogle();if(!counted){event('pageview');counted=true}hide();}
 function reject(){save('rejected');active=false;for(const id of cfg.googleIds)window['ga-disable-'+id]=true;
  if(googleLoaded)gtag('consent','update',{analytics_storage:'denied',ad_storage:'denied',ad_user_data:'denied',ad_personalization:'denied'});hide();}
 function hide(){document.getElementById('bp-analytics-consent')?.remove();}
 function button(label,fn){const b=document.createElement('button');b.type='button';b.textContent=label;b.addEventListener('click',fn);return b;}
 function choices(){hide();const bar=document.createElement('section');bar.id='bp-analytics-consent';bar.setAttribute('aria-label','Analytics privacy choices');
  Object.assign(bar.style,{position:'fixed',bottom:'0',left:'0',right:'0',zIndex:'2147483000',background:'#111827',color:'#fff',padding:'18px',display:'flex',gap:'14px',flexWrap:'wrap',alignItems:'center',font:'16px/1.5 system-ui'});
  const text=document.createElement('p');text.textContent='Allow website analytics? '+(cfg.googleIds.length?'Google Analytics and ':'')+'Bitpype can measure page visits and clicks. You can decline or change your choice anytime.';text.style.margin='0';bar.append(text);
  for(const b of [button('Allow analytics',accept),button('Decline analytics',reject)]){b.id=b.textContent==='Allow analytics'?'bp-analytics-allow':'bp-analytics-decline';Object.assign(b.style,{padding:'10px 16px',border:'2px solid #fff',borderRadius:'6px',background:'#fff',color:'#111827',cursor:'pointer',font:'inherit'});bar.append(b)}
  document.body.append(bar);
 }
 document.addEventListener('click',e=>{
  if(!active||clickCount>=100||!e.isTrusted||e.target.closest('#bp-analytics-consent,#bp-analytics-privacy'))return;
  const a=e.target.closest('a[href]'),b=e.target.closest('button');if(!a&&!b)return;
  let kind='button';if(a){let u;try{u=new URL(a.href,location.href)}catch{return}kind=u.protocol==='tel:'?'phone':u.protocol==='mailto:'?'email':u.origin===location.origin?'internal':['http:','https:'].includes(u.protocol)?'external':'button'}
  clickCount++;event('click',kind);
 },{capture:true});
 fetch(endpoint+'/config',{credentials:'omit',referrerPolicy:'no-referrer'}).then(r=>r.ok?r.json():null).then(json=>{
  cfg=json&&json.ok&&json.data;if(!cfg||(!cfg.internalEnabled&&!cfg.googleIds.length))return;
  document.getElementById('bp-cookie-bar')?.remove();document.body.classList.remove('bp-cookie-pad');
  const privacy=button('Analytics privacy',choices);privacy.id='bp-analytics-privacy';Object.assign(privacy.style,{position:'fixed',bottom:'10px',left:'10px',zIndex:'2147482901',padding:'8px 12px',background:'#111827',color:'#fff',border:'1px solid #fff',borderRadius:'6px',cursor:'pointer'});document.body.append(privacy);
  // GPC and Do Not Track take precedence over saved consent.
  if(navigator.globalPrivacyControl===true||navigator.doNotTrack==='1'){reject();return}
  const choice=stored();if(choice==='accepted')accept();else if(choice!=='rejected')choices();
 }).catch(()=>{});
})();
