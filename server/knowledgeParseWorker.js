'use strict';
process.once('message',async({buffer,opts})=>{
 try{
  const image=require('./chatbotKnowledgeParse').isOcrInput(opts);
  if(!image){
   const blocked=()=>{throw Error('External network access is disabled for document parsing')};
   global.fetch=async()=>blocked();
   for(const name of ['node:http','node:https']){const m=require(name);m.request=blocked;m.get=blocked;}
   for(const name of ['node:net','node:tls']){const m=require(name);m.connect=blocked;if(m.createConnection)m.createConnection=blocked;}
  }
  await require('./knowledgeZipGuard').guardZip(buffer);
  const out=await require('./chatbotKnowledgeParse').extractKnowledgeText(buffer,opts);
  process.send(out);
 }catch{process.send({text:'',extractor:'error',supported:false,warning:'Document is malformed, unsupported, or exceeds extraction limits'});}
});
