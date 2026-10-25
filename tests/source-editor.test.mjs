import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs';
import { createRequire } from 'node:module';
const {loadAnalyzer}=createRequire(import.meta.url)('./helpers/analyzer.cjs');
import { mkdtemp, mkdir, writeFile, readFile, rm, symlink, chmod, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createProjectsServer } from '../server/projects-server.mjs';
import { EDIT_BODY_MAX_BYTES, createSourceEditor } from '../server/source-editor.mjs';
import { SOURCE_FILE_MAX_BYTES } from '../server/server-utils.mjs';
async function fixture(fn){
 const root=await mkdtemp(join(tmpdir(),'codeflow-edit-'));let app;
 try{
  for(const p of ['A/src','A/other','A/private','B/src'])await mkdir(join(root,p),{recursive:true});
  await writeFile(join(root,'A/src/List Screen α.kt'),'class Screen {}\n');await writeFile(join(root,'A/other/List Screen α.kt'),'class Other {}\n');await writeFile(join(root,'A/private/Hidden.kt'),'class Hidden {}');await writeFile(join(root,'A/readme.md'),'private note');await writeFile(join(root,'B/src/List Screen α.kt'),'class B {}');
  app=createProjectsServer({projectsRoot:root,persist:false});await new Promise(resolve=>app.server.listen(0,'127.0.0.1',resolve));await app.changeProject('A');
  const base='http://127.0.0.1:'+app.server.address().port,status=await (await fetch(base+'/__codeflow/status')).json();const pid=status.pid;
  const load=async(path='src/List Screen α.kt',id=pid)=>fetch(base+'/__codeflow/edit-source?pid='+encodeURIComponent(id)+'&path='+encodeURIComponent(path));
  const save=(opened,content,headers={})=>fetch(base+'/__codeflow/edit-source',{method:'POST',headers:{'Content-Type':'application/json',Origin:base,'X-Codeflow-CSRF':app._registry.csrf,...headers},body:JSON.stringify({...opened,content})});
  await fn({root,app,base,pid,load,save});
 }finally{if(app)await app.close();await rm(root,{recursive:true,force:true});}
}
test('edit/save/re-read writes the actual Unicode/spaced source path and refreshes version',()=>fixture(async({root,load,save})=>{
 const opened=await (await load()).json(),text='class Screen {\n  val label = "Greek: α"\n}\n';const r=await save(opened,text);assert.equal(r.status,200);const saved=await r.json();assert.notEqual(saved.version,opened.version);assert.equal(saved.content,text);assert.equal(await readFile(join(root,'A/src/List Screen α.kt'),'utf8'),text);assert.equal(await readFile(join(root,'A/other/List Screen α.kt'),'utf8'),'class Other {}\n');assert.equal((await (await load()).json()).content,text);
}));
test('cancel is read-only and an external change produces conflict without overwriting',()=>fixture(async({root,load,save})=>{
 const f=join(root,'A/src/List Screen α.kt'),before=await readFile(f);const opened=await (await load()).json();assert.deepEqual(await readFile(f),before);
 await writeFile(f,'external Android Studio edit\n');const r=await save(opened,'draft');assert.equal(r.status,409);assert.equal((await r.json()).code,'conflict');assert.equal(await readFile(f,'utf8'),'external Android Studio edit\n');
}));
test('same-named files and multiple editing sessions remain independent',()=>fixture(async({root,load,save})=>{
 const a=await (await load()).json(),b=await (await load('other/List Screen α.kt')).json();assert.equal((await save(b,'other edited\n')).status,200);assert.equal((await save(a,'screen edited\n')).status,200);assert.equal(await readFile(join(root,'A/other/List Screen α.kt'),'utf8'),'other edited\n');assert.equal(await readFile(join(root,'A/src/List Screen α.kt'),'utf8'),'screen edited\n');
}));
test('project switching and reopening invalidate stale editor versions and cross-write IDs',()=>fixture(async({app,load,save,pid,base})=>{
 const opened=await (await load()).json();await app.changeProject('B');assert.equal((await save(opened,'wrong project')).status,409);assert.equal((await load('src/List Screen α.kt',pid)).status,409);
 await app.changeProject('A');assert.equal((await save(opened,'expired selection')).status,409);
}));
test('excluded, non-code, traversal, absolute, ADS and missing paths cannot be edited',()=>fixture(async({app,pid,load,save})=>{
 await app._registry.setExclusions(pid,['private']);
 for(const path of ['private/Hidden.kt','readme.md','../B/src/List Screen α.kt','/etc/a.kt','C:/escape.kt','src/a.kt:ads','src/./List Screen α.kt','src/missing.kt']){
  assert.equal((await load(path)).status,404,path);const r=await save({projectId:pid,path,version:'a'.repeat(64)},'bad');assert.equal(r.status,404,path);
 }
}));
test('writes require exact same-origin and valid session CSRF',()=>fixture(async({load,save,base})=>{
 const opened=await (await load()).json();
 for(const headers of [{'X-Codeflow-CSRF':''},{Origin:'https://evil.example'},{Origin:base.replace('http:','https:')},{Origin:''},{Origin:'http://localhost:'+new URL(base).port}])assert.equal((await save(opened,'changed',headers)).status,403);
}));
test('LF, CRLF, UTF-8 BOM, final newline and existing mode are preserved',()=>fixture(async({root,load,save})=>{
 const f=join(root,'A/src/List Screen α.kt');
 for(const [bom,eol] of [[false,'\n'],[false,'\r\n'],[true,'\r\n'],[true,'\n']]){
  await writeFile(f,(bom?'\uFEFF':'')+'class Before {}'+eol);const mode=(await fs.promises.stat(f)).mode&0o777,opened=await (await load()).json();const edited='class After {\n  val α = 1\n}';assert.equal((await save(opened,edited)).status,200);assert.equal(await readFile(f,'utf8'),(bom?'\uFEFF':'')+edited.replace(/\n/g,eol));assert.equal((await fs.promises.stat(f)).mode&0o777,mode);
 }
}));
test('binary/invalid UTF-8, mixed endings and oversized source are unavailable',()=>fixture(async({root,load,save,pid})=>{
 const f=join(root,'A/src/List Screen α.kt');
 for(const bytes of [Buffer.from([0,1,2]),Buffer.from([255,254,253]),Buffer.from('a\r\nb\nc')]){await writeFile(f,bytes);assert.equal((await load()).status,422);}
 await writeFile(f,'x'.repeat(SOURCE_FILE_MAX_BYTES+1));assert.equal((await load()).status,413);
 assert.equal((await save({projectId:pid,path:'src/List Screen α.kt',version:'a'.repeat(64)},'x'.repeat(SOURCE_FILE_MAX_BYTES+1))).status,413);
}));
test('symlink/junction escape cannot be edited',()=>fixture(async({root,load})=>{
 const outside=join(root,'outside');await mkdir(outside);await writeFile(join(outside,'Escape.kt'),'outside');await symlink(outside,join(root,'A/escape'),process.platform==='win32'?'junction':'dir');assert.equal((await load('escape/Escape.kt')).status,404);
}));
test('save makes local search see new content and emits a source revision',()=>fixture(async({root,base,pid,load,save})=>{
 const ctrl=new AbortController(),events=await fetch(base+'/__codeflow/events',{signal:ctrl.signal}),reader=events.body.getReader();
 try{
  const opened=await (await load()).json();assert.equal((await save(opened,'fun uniqueSavedSymbol() {}\n')).status,200);
  const decoder=new TextDecoder();let text='';for(let i=0;i<8&&!text.includes('List Screen');i++){const part=await reader.read();text+=decoder.decode(part.value||new Uint8Array());}assert.ok(text.includes('List Screen'));
  const result=await (await fetch(base+'/__codeflow/search?pid='+encodeURIComponent(pid)+'&q=uniqueSavedSymbol')).json();assert.ok(JSON.stringify(result).includes('uniqueSavedSymbol'));
  const source=await (await fetch(base+'/__codeflow/file?pid='+encodeURIComponent(pid)+'&path='+encodeURIComponent(opened.path))).text();assert.equal(source,'fun uniqueSavedSymbol() {}\n');
  const {Parser}=loadAnalyzer(new URL('../index.html',import.meta.url));assert.ok(Parser.extract(source,'Sample.kt').some(fn=>fn.name==='uniqueSavedSymbol'));
 }finally{ctrl.abort();await reader.cancel().catch(()=>{});}
}));
test('disk-write, fsync and replacement errors leave original bytes intact',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cfk-editor-failure-'));try{
 const file=join(root,'A.kt');await writeFile(file,'original\n');const scope={root,projectId:'A',generation:1,exclusions:[]};
 for(const method of ['writeFileSync','fsyncSync','renameSync']){
  const io=Object.create(fs),editor=createSourceEditor(()=>scope,{io}),opened=editor.read('A','A.kt');io[method]=()=>{const e=new Error('injected disk failure');e.code='ENOSPC';throw e;};
  assert.throws(()=>editor.save({...opened,content:'edited\n'}),e=>e.status===500);assert.equal(await readFile(file,'utf8'),'original\n');assert.deepEqual(await readdir(root),['A.kt']);
 }
 const io=Object.create(fs),editor=createSourceEditor(()=>scope,{io}),opened=editor.read('A','A.kt');io.openSync=(p,flags,...rest)=>{if(flags==='r+'){const e=new Error('denied');e.code='EACCES';throw e;}return fs.openSync(p,flags,...rest);};assert.throws(()=>editor.save({...opened,content:'edit'}),e=>e.status===403);assert.equal(await readFile(file,'utf8'),'original\n');
 }finally{await rm(root,{recursive:true,force:true});}
});
test('external edit during temporary preparation is caught by the final comparison',async()=>{
 const root=await mkdtemp(join(tmpdir(),'cfk-editor-race-'));try{const file=join(root,'A.kt');await writeFile(file,'original');const scope={root,projectId:'A',generation:1,exclusions:[]},io=Object.create(fs),editor=createSourceEditor(()=>scope,{io}),opened=editor.read('A','A.kt');io.fsyncSync=fd=>{fs.fsyncSync(fd);fs.writeFileSync(file,'external change');};assert.throws(()=>editor.save({...opened,content:'draft'}),e=>e.status===409);assert.equal(await readFile(file,'utf8'),'external change');}finally{await rm(root,{recursive:true,force:true});}
});

test('all supported UTF-8 source languages share the write path; removed targets never reappear',()=>fixture(async({root,pid,load,save})=>{
 for(const ext of ['kt','swift','dart','js','tsx','py','java','rs','go','pas','ps1','html']){
  const name='src/example.'+ext,file=join(root,'A',name);await writeFile(file,'original\n');const opened=await (await load(name)).json();assert.equal((await save(opened,'edited '+ext+'\n')).status,200);assert.equal(await readFile(file,'utf8'),'edited '+ext+'\n');
 }
 const opened=await (await load()).json();await rm(join(root,'A',opened.path));assert.equal((await save(opened,'new file?')).status,404);await assert.rejects(readFile(join(root,'A',opened.path)));
}));
test('read-only files are refused without altering their bytes',()=>fixture(async({root,load})=>{
 const file=join(root,'A/src/List Screen α.kt');await chmod(file,0o444);try{assert.equal((await load()).status,403);assert.equal(await readFile(file,'utf8'),'class Screen {}\n');}finally{await chmod(file,0o666);}
}));


test('HTTP editor payloads are bounded and unsupported methods fail',()=>fixture(async({base,app,load})=>{
 const before=await (await load()).json();
 const tooBig=await fetch(base+'/__codeflow/edit-source',{method:'POST',headers:{Origin:base,'X-Codeflow-CSRF':app._registry.csrf,'Content-Type':'application/json'},body:'x'.repeat(EDIT_BODY_MAX_BYTES+1)});assert.equal(tooBig.status,413);
 assert.equal((await fetch(base+'/__codeflow/edit-source',{method:'PUT'})).status,405);
 assert.equal((await (await load()).json()).version,before.version);
}));
