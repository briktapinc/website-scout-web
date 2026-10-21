'use strict';
const fs=require('node:fs'),path=require('node:path'),assert=require('node:assert/strict'),os=require('node:os'),{zipSync,strToU8}=require('fflate');
const api=require('../server/chatbotKnowledgeExtract'),{runIsolated}=require('../server/knowledgeParseRunner');
const fixtures=path.join(__dirname,'fixtures/knowledge');
const archive=parts=>Buffer.from(zipSync(Object.fromEntries(Object.entries(parts).map(([k,v])=>[k,strToU8(v)]))));
const load=async name=>api.extractKnowledgeText(fs.readFileSync(path.join(fixtures,name)),{fileName:name});
const watchdog=setTimeout(()=>{console.error('Parser regression timed out');process.exit(1)},90000);
(async()=>{
 let groups=0;
 for(const [name,terms] of [
  ['book.xlsx',['Sheet: Fixture','Café, fixture','42','Second sheet marker','東京']],
  ['legacy.xls',['Sheet: Fixture','Café, fixture','42','Second sheet marker','東京']],
  ['data.csv',['Café, fixture','Quoted','2468']],
  ['document.docx',['Bitpype DOCX café fixture','Table marker 2468']],
  ['slides.pptx',['Bitpype slide one café','Second slide marker 2468']],
  ['legacy.doc',['second test','Unicode']],
  ['document.pdf',['Bitpype PDF fixture 2468']],
  ['note.txt',['plain text café fixture']],
 ]){const out=await load(name);assert.equal(out.supported,true,name+': '+out.warning);for(const term of terms)assert(out.text.includes(term),name+' missing '+term);groups++;}
 const html=await load('page.html');assert(html.text.includes('HTML fixture'));assert(!html.text.includes('SECRET_'));groups++;
 const bad=await api.extractKnowledgeText(Buffer.from('not a DOCX'),{fileName:'bad.docx'});assert.equal(bad.supported,false);assert.equal(bad.extractor,'error');groups++;
 const traversal=await api.extractKnowledgeText(archive({'../escape.xml':'unsafe'}),{fileName:'unsafe.docx'});assert.equal(traversal.supported,false);groups++;
 const bomb=archive({'huge.xml':'x'.repeat(33*1024*1024)});assert(bomb.length<5*1024*1024);let before=Date.now();const oversized=await api.extractKnowledgeText(bomb,{fileName:'large.docx'});assert.equal(oversized.supported,false);assert(Date.now()-before<5000);groups++;
 // Lie about uncompressed length. The guard measures actual inflation, not only ZIP metadata.
 const forged=archive({'huge.xml':'x'.repeat(1024*1024)});for(let i=0;i<forged.length-46;i++)if(forged.readUInt32LE(i)===0x02014b50){forged.writeUInt32LE(1,i+24);break;}
 const dishonest=await api.extractKnowledgeText(forged,{fileName:'forged.xlsx'});assert.equal(dishonest.supported,false);groups++;
 const asf=Buffer.alloc(80);Buffer.from('3026b2758e66cf11a6d900aa0062ce6c','hex').copy(asf);before=Date.now();await api.extractKnowledgeText(asf,{fileName:'malformed.bin'});assert(Date.now()-before<5000);groups++;
 const tooBig=await api.extractKnowledgeText(Buffer.alloc(5*1024*1024+1),{fileName:'big.txt'});assert.equal(tooBig.supported,false);groups++;
 const capped=await api.extractKnowledgeText(Buffer.from('x'.repeat(250000)),{fileName:'long.txt'});assert.equal(capped.text.length,api.MAX_TEXT);groups++;
 const workers=path.join(__dirname,'fixtures/parser-workers');const hang=path.join(workers,'hang.cjs');before=Date.now();const timed=await runIsolated(Buffer.from('fixture'),{}, {workerPath:hang,timeoutMs:250});assert.equal(timed.supported,false);assert.match(timed.warning,/time limit/);assert(Date.now()-before<2000);groups++;
 const p1=runIsolated(Buffer.from('fixture'),{},{workerPath:hang,timeoutMs:250}),p2=runIsolated(Buffer.from('fixture'),{},{workerPath:hang,timeoutMs:250});const busy=await runIsolated(Buffer.from('fixture'),{});assert.match(busy.warning,/busy/);await Promise.all([p1,p2]);groups++;
 const crashed=await runIsolated(Buffer.from('fixture'),{},{workerPath:path.join(workers,'crash.cjs')});assert.equal(crashed.supported,false);assert.equal((await load('note.txt')).supported,true);groups++;
 const privatePath=path.join(os.tmpdir(),'bitpype-parser-fixture-private-'+process.pid);fs.writeFileSync(privatePath,'SYNTHETIC_PRIVATE_MARKER');const old=process.env.SESSION_SECRET;process.env.SESSION_SECRET='synthetic-parent-secret';
 try{const checked=await runIsolated(Buffer.from('fixture'),{privatePath},{workerPath:path.join(workers,'permissions.cjs')});assert.deepEqual(JSON.parse(checked.text),{blocked:true,secret:false});}finally{if(old==null)delete process.env.SESSION_SECRET;else process.env.SESSION_SECRET=old;fs.unlinkSync(privatePath)}groups++;
 const classify=require('../server/chatbotKnowledgeParse').isOcrInput;assert.equal(classify({fileName:'unsafe.docx',mimeType:'image/png'}),false);assert.equal(classify({fileName:'unsafe.png',mimeType:'application/pdf'}),false);assert.equal(classify({fileName:'image.png',mimeType:'image/png'}),true);groups++;
 const pkg=require('../package.json'),lock=require('../package-lock.json');for(const name of ['mammoth','node-cron','pdf-parse'])assert(!pkg.dependencies[name]);for(const name of ['mammoth','node-cron','pdf-parse','argparse','sprintf-js'])assert(!lock.packages['node_modules/'+name]);assert.equal(require('xlsx').version,'0.20.3');assert.equal(pkg.dependencies.officeparser,'8.2.0');groups++;
 console.log(JSON.stringify({passed:true,groups,formats:['XLSX','XLS','CSV','DOCX','PPTX','DOC','PDF','text','HTML'],checks:['unicode and multi-sheet text','document and slide content','malformed inputs','archive traversal and expansion limits','forged ZIP metadata','ASF completion bounded','upload and output size limits','timeout and concurrency cap','crash recovery','private file and secret isolation','vulnerable dependency chains removed']}));
})().catch(e=>{console.error(e);process.exitCode=1}).finally(()=>clearTimeout(watchdog));
