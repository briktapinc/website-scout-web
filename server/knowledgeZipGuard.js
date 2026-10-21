'use strict';
const {createInflateRaw}=require('node:zlib');
const MAX=32*1024*1024;
async function guardZip(buf){
 if(buf.length<4||buf.readUInt32LE(0)!==0x04034b50)return;
 let end=-1;for(let i=buf.length-22;i>=Math.max(0,buf.length-65557);i--)if(buf.readUInt32LE(i)===0x06054b50&&i+22+buf.readUInt16LE(i+20)===buf.length){end=i;break;}
 if(end<0)throw Error('Invalid document archive');
 const count=buf.readUInt16LE(end+10),offset=buf.readUInt32LE(end+16),directoryBytes=buf.readUInt32LE(end+12);
 if(buf.readUInt16LE(end+4)||buf.readUInt16LE(end+6)||count>2000||count===65535||offset+directoryBytes>end)throw Error('Document archive limits exceeded');
 let pos=offset,total=0;const names=new Set();
 for(let i=0;i<count;i++){
  if(pos+46>end||buf.readUInt32LE(pos)!==0x02014b50)throw Error('Invalid archive directory');
  const flags=buf.readUInt16LE(pos+8),method=buf.readUInt16LE(pos+10),packed=buf.readUInt32LE(pos+20),size=buf.readUInt32LE(pos+24),nameLength=buf.readUInt16LE(pos+28),extra=buf.readUInt16LE(pos+30),comment=buf.readUInt16LE(pos+32),local=buf.readUInt32LE(pos+42);
  if(pos+46+nameLength+extra+comment>end)throw Error('Invalid archive entry');
  const name=buf.subarray(pos+46,pos+46+nameLength).toString('utf8').replace(/\\/g,'/');
  if(names.has(name)||name.startsWith('/')||/^[a-z]:/i.test(name)||name.split('/').includes('..')||name.includes('\0'))throw Error('Unsafe archive path');names.add(name);
  if(flags&1||![0,8].includes(method)||size>MAX||total+size>MAX||local+30>offset||buf.readUInt32LE(local)!==0x04034b50)throw Error('Document archive limits exceeded');
  const dataStart=local+30+buf.readUInt16LE(local+26)+buf.readUInt16LE(local+28);
  if(dataStart+packed>offset)throw Error('Invalid archive data range');
  const data=buf.subarray(dataStart,dataStart+packed);let actual=0;
  if(method===0)actual=data.length;
  else{
   const stream=createInflateRaw();stream.end(data);
   try{for await(const chunk of stream){actual+=chunk.length;if(total+actual>MAX||actual>size)throw Error('Document archive expands beyond limit');}}finally{stream.destroy();}
  }
  if(actual!==size)throw Error('Invalid expanded archive size');total+=actual;
  pos+=46+nameLength+extra+comment;
 }
 if(pos!==offset+directoryBytes)throw Error('Invalid archive directory size');
}
module.exports={guardZip};
