import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, mkdir, writeFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectsServer } from '../server/projects-server.mjs';
test('source navigation rejects another project id, removed files and current exclusions',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cfk-guide-scope-'));let app;
 try{
  for(const name of ['A','B']){await mkdir(join(root,name,'private'),{recursive:true});await writeFile(join(root,name,'Same.kt'),'// project '+name);await writeFile(join(root,name,'private','Hidden.kt'),'// hidden '+name);}
  app=createProjectsServer({projectsRoot:root,persist:false});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));
  const base='http://127.0.0.1:'+app.server.address().port;
  await app.changeProject('A');const a=await (await fetch(base+'/__codeflow/status')).json();
  assert.equal(await (await fetch(base+'/__codeflow/file?path=Same.kt&pid='+encodeURIComponent(a.pid))).text(),'// project A');
  await app.changeProject('B');const b=await (await fetch(base+'/__codeflow/status')).json();
  for(const suffix of ['/file?path=Same.kt&pid=','/files?pid='])assert.equal((await fetch(base+'/__codeflow'+suffix+encodeURIComponent(a.pid))).status,409);
  const listed=await (await fetch(base+'/__codeflow/files?pid='+encodeURIComponent(b.pid))).json();assert.equal(listed.pid,b.pid);
  assert.equal(await (await fetch(base+'/__codeflow/file?path=Same.kt&pid='+encodeURIComponent(b.pid))).text(),'// project B');
  await app._registry.setExclusions(b.pid,['private']);
  assert.equal((await fetch(base+'/__codeflow/file?path=private/Hidden.kt&pid='+encodeURIComponent(b.pid))).status,404);
  await rm(join(root,'B','Same.kt'));
  assert.equal((await fetch(base+'/__codeflow/file?path=Same.kt&pid='+encodeURIComponent(b.pid))).status,404);
  assert.equal((await fetch(base+'/__codeflow/file?path=../A/Same.kt&pid='+encodeURIComponent(b.pid))).status,404);
 }finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
});
