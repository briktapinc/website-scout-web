'use strict';
const express=require('express');
const {assertWorkspaceExists}=require('../workspaceExists');
const {rateLimit}=require('../rateLimit');
const analytics=require('../siteAnalytics');
const router=express.Router();
router.use((req,res,next)=>{res.set('Access-Control-Allow-Origin','*');res.set('Access-Control-Allow-Methods','GET, POST, OPTIONS');res.set('Access-Control-Allow-Headers','Content-Type');res.set('Cross-Origin-Resource-Policy','cross-origin');res.set('Cache-Control','no-store');if(req.method==='OPTIONS')return res.sendStatus(204);next()});
router.use(rateLimit({windowMs:60000,max:240,name:'site-analytics'}));
async function scoped(req,fn){
 const token=String(req.params.token||'');const m=token.match(/^([1-9]\d{0,11})_[a-f0-9]{48}$/);
 if(!m)throw Object.assign(new Error('Not found'),{status:404});
 const ws=Number(m[1]);await assertWorkspaceExists(ws);
 return require('../domain').withDb(ws,db=>fn(db,token,req.get('origin')));
}
function fail(res,e){const status=e.status|| (e.code==='NOT_FOUND'?404:e.code==='INVALID'||e instanceof SyntaxError?400:500);res.status(status).json({ok:false,error:status>=500?'Analytics unavailable':status===404?'Not found':e.message});}
router.get('/:token/config',async(req,res)=>{try{const data=await scoped(req,(db,t,o)=>analytics.config(db,t,o));if(!data)return res.sendStatus(404);res.json({ok:true,data})}catch(e){fail(res,e)}});
router.post('/:token/events',express.text({type:'text/plain',limit:'1kb'}),async(req,res)=>{try{
 const body=typeof req.body==='string'?JSON.parse(req.body):req.body;
 if(Buffer.byteLength(JSON.stringify(body||{}))>1024)return res.sendStatus(413);
 const accepted=await scoped(req,(db,t,o)=>analytics.collect(db,t,o,body));res.sendStatus(accepted?204:404);
}catch(e){fail(res,e)}});
module.exports=router;
