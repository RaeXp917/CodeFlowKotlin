// Read-only smoke against the currently registered, selected project. Source
// stays in memory; this script never changes registry state or project files.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import vm from 'node:vm';
import { performance } from 'node:perf_hooks';
const base='http://127.0.0.1:4173';
const get=async path=>{const r=await fetch(base+path);assert.ok(r.ok,path+': '+r.status);return r;};
const status=await (await get('/__codeflow/status')).json();
assert.ok(status.ok&&status.id,'Select a registered project first');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const block=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
const ctx={console,URL,getSecurityScanContent:f=>f.content||'',isSanitizedPreviewRenderer:()=>false};vm.createContext(ctx);
vm.runInContext(block('function normalizeExcludePath(','function shouldIgnoreDirectory(')+block('// ===== CODEFLOW_ANALYZER_START =====','// ===== CODEFLOW_ANALYZER_END =====')+block('// ===== CODEFLOW_GUIDE_START =====','// ===== CODEFLOW_GUIDE_END ====='),ctx);
vm.runInContext('this.Parser=Parser',ctx);
const listed=await (await get('/__codeflow/files?pid='+encodeURIComponent(status.pid))).json();
const analyzed=[],allFns=[],source=new Map();
for(const f of listed.files){
 if(!ctx.Parser.isCode(f.path)||ctx.Parser.isOversized(f.size))continue;
 const content=await (await get('/__codeflow/file?path='+encodeURIComponent(f.path)+'&pid='+encodeURIComponent(status.pid))).text();
 source.set(f.path,content);
 const functions=ctx.Parser.extract(content,f.path),layer=ctx.Parser.detectLayer(f.path,content);
 analyzed.push({...f,content,functions,isCode:true,layer,lines:content.split('\n').length});
 functions.forEach(fn=>allFns.push({...fn,folder:f.folder,layer}));
}
assert.equal((await (await get('/__codeflow/status')).json()).id,status.id,'Project changed during smoke');
const start=performance.now();
const data=await ctx.buildAnalysisData({analyzed,allFns,yieldFn:()=>Promise.resolve()});
const analyzedMs=performance.now()-start;
const indexedAt=performance.now(),ix=ctx.buildGuideIndex(data,ctx.compileExcludePatterns((status.exclusions||[]).join('\n'))),indexMs=performance.now()-indexedAt;
const selected=data.files.find(f=>/\.kt$/.test(f.path)&&f.path.startsWith('app/')&&f.guide.components.length&&(ix.outgoing.get(f.path)||[]).length&&(ix.findings.get(f.path)||[]).length)
 ||data.files.find(f=>/\.kt$/.test(f.path)&&f.guide.components.length&&(ix.outgoing.get(f.path)||[]).length);
assert.ok(selected,'No real Kotlin component with resolved relationships found');
const related=ix.outgoing.get(selected.path)[0];assert.ok(ix.files.has(related.to));
const nav=await (await get('/__codeflow/file?path='+encodeURIComponent(related.to)+'&pid='+encodeURIComponent(status.pid))).text();assert.equal(nav,source.get(related.to));
if(related.line)assert.ok(related.line>=1&&related.line<=nav.split('\n').length);
for(const f of data.architectureInsights){assert.ok(source.has(f.path));assert.equal(source.get(f.path).split('\n')[f.line-1].trim().slice(0,200),f.code);}
const selectedFindings=ix.findings.get(selected.path)||[];
const viewModel=data.files.find(f=>f.path.startsWith('app/')&&f.guide.components.some(c=>c.role==='ViewModel'));assert.ok(viewModel,'No real ViewModel recognized');
console.log(JSON.stringify({project:status.name,files:data.files.length,connections:data.connections.length,findings:data.architectureInsights.length,analyzedMs:Math.round(analyzedMs),guideIndexMs:+indexMs.toFixed(2),selected:selected.path,roles:selected.guide.components.map(c=>c.role),selectedFindings:selectedFindings.length,viewModel:viewModel.path,related:{path:related.to,kind:related.kind,line:related.line},sourceNavigation:'verified against active project endpoint',ecosystems:[...ix.ecosystems]},null,2));
