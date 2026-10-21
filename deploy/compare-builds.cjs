'use strict';
const fs=require('node:fs'),assert=require('node:assert/strict');
const [first,second]=process.argv.slice(2).map(p=>JSON.parse(fs.readFileSync(p,'utf8')));
for(const k of ['node','abi','architecture','runtimeFiles','runtimeSha256','osPackagesSha256','chromiumSha256']){
 assert.equal(first[k],second[k],'clean builds differ: '+k);
}
console.log(JSON.stringify({passed:true,runtimeFiles:first.runtimeFiles,runtimeSha256:first.runtimeSha256,
 osPackagesSha256:first.osPackagesSha256,comparison:'runtime contents, permissions, symlinks and OS package versions; excludes OCI metadata and timestamps'}));
