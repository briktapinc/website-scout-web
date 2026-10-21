'use strict';
const fs=require('fs'),path=require('path'),assert=require('assert/strict');
const {extractKnowledgeText}=require('../server/chatbotKnowledgeExtract');
(async()=>{const image=await require('sharp')(Buffer.from('<svg xmlns="http://www.w3.org/2000/svg" width="1200" height="180"><rect width="100%" height="100%" fill="white"/><text x="35" y="115" font-family="Arial" font-size="65" fill="black">BITPYPE FIXTURE 2468</text></svg>')).png().toBuffer();const out=await extractKnowledgeText(image,{fileName:'fixture.png',mimeType:'image/png'});assert.equal(out.supported,true,out.warning);assert.match(out.text,/FIXTURE\s+2468/i);console.log(JSON.stringify({passed:true,groups:1,format:'PNG OCR',syntheticOnly:true}));})().catch(e=>{console.error(e);process.exitCode=1});
