import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile, access } from 'node:fs/promises';
import { createRequire } from 'node:module';
const require=createRequire(import.meta.url);
const acorn=require('../vendor/acorn/acorn.min.js');
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
const marker='<script type="text/babel">';
const script=html.slice(html.indexOf(marker)+marker.length,html.lastIndexOf('</script>'));
const ast=acorn.parse(script,{ecmaVersion:'latest',sourceType:'script'});
function walk(node,visit){if(!node||typeof node!=='object')return;visit(node);for(const value of Object.values(node)){if(Array.isArray(value))value.forEach(item=>walk(item,visit));else if(value&&typeof value==='object')walk(value,visit);}}
function prefix(node){return node.type==='Literal'?node.value:node.type==='BinaryExpression'&&node.operator==='+'?prefix(node.left):null;}
test('only registered project records enter the analysis cache',()=>{
 const a=html.indexOf('function isLocalAnalysisRecord('),b=html.indexOf('function listRecentAnalyses(',a),ctx={};vm.createContext(ctx);vm.runInContext(html.slice(a,b),ctx);
 assert.equal(ctx.isLocalAnalysisRecord({sourceType:'local-project'}),true);
 for(const record of [null,{}, {sourceType:'unsupported'}, {sourceType:''}])assert.equal(ctx.isLocalAnalysisRecord(record),false);
});
test('browser network destinations use the audited local endpoint contract',()=>{
 const allowed=new Set(['/__codeflow/edit-source','/__codeflow/projects','/__codeflow/status','/__codeflow/files','/__codeflow/file','/__codeflow/search']);let calls=0;
 walk(ast,node=>{if(node.type!=='CallExpression'||node.callee.type!=='Identifier'||node.callee.name!=='fetch')return;calls++;const arg=node.arguments[0];if(script.slice(arg.start,arg.end)==='window.location.href')return;const destination=prefix(arg);assert.equal(typeof destination,'string');assert.ok(allowed.has(destination.split('?')[0]),destination);});
 assert.ok(calls>=10);
});
test('project selector mutations use the audited registered-project endpoints',async()=>{
 const selector=await readFile(new URL('../server/project-selector.js',import.meta.url),'utf8');const tree=acorn.parse(selector,{ecmaVersion:'latest'});
 const allowed=new Set(['/__codeflow/select-project','/__codeflow/pick-folder','/__codeflow/add-project','/__codeflow/remove-project','/__codeflow/set-hidden','/__codeflow/set-exclusions']);let calls=0;
 walk(tree,node=>{if(node.type==='CallExpression'&&node.callee.name==='mutate'){calls++;assert.ok(allowed.has(prefix(node.arguments[0])));}});assert.ok(calls>=6);
});
test('project source identity has one registered-project kind',()=>{
 const kinds=new Set();walk(ast,node=>{if(node.type==='Property'&&(node.key.name||node.key.value)==='sourceType'&&node.value.type==='Literal')kinds.add(node.value.value);});
 assert.deepEqual([...kinds].sort(),['local-project','module','script']);
 assert.doesNotMatch(html,/<input[^>]*type=["']file["']/i);
});
test('browser dependencies and the local runtime are available on disk',async()=>{
 for(const match of html.matchAll(/<script[^>]+src="([^"]+)"/g)){assert.ok(match[1].startsWith('./vendor/'));await access(new URL('../'+match[1],import.meta.url));}
 for(const file of ['server/projects-server.mjs','server/project-selector.js','LICENSE'])await access(new URL('../'+file,import.meta.url));
});



test('cache hydration rejects a different active root and changed exclusions',()=>{
 const source=(a,b)=>html.slice(html.indexOf(a),html.indexOf(b,html.indexOf(a)));
 let applied=0,discarded=0;
 const ctx={projectStatus:{ok:true,root:'C:/projects/A',exclusions:['private']},showNotification(){},discardSourceEdits(){discarded++;return true;},analysisRunRef:{current:0},compactAnalysisForCache:x=>x,setData(){applied++;},setExpandedPaths(){},setSelected(){},setBlastRadius(){},setFolderFilter(){},setCachedFromId(){},setActiveSymbol(){},setProjectDirty(){},clearProjectLiveDiffs(){},setProjectInfo(){},setGraphConfig(){}};
 vm.createContext(ctx);
 vm.runInContext(source('function normalizeProjectRoot(','function normalizeProjectWatchPath(')+source('function isLocalAnalysisRecord(','function listRecentAnalyses(')+source('    function applyCachedAnalysis(','    function loadRecentAnalysis('),ctx);
 const record={sourceType:'local-project',sourceKey:'C:/projects/B',data:{excludePatterns:['private']}};
 ctx.applyCachedAnalysis(record);assert.equal(applied,0);assert.equal(discarded,0);
 record.sourceKey='C:/projects/A';record.data.excludePatterns=[];ctx.applyCachedAnalysis(record);assert.equal(applied,0);
 record.data.excludePatterns=['private'];ctx.applyCachedAnalysis(record);assert.equal(applied,1);assert.equal(discarded,1);
});

test('analysis captures the selected project id and its exclusions before asynchronous reads',async()=>{
 const a=html.indexOf('    async function analyzeLocalProject('),b=html.indexOf('    function resetAnalysisState(',a);
 const status={ok:true,pid:'active-generation',root:'C:/projects/A',exclusions:['private']};let requests=[],filtered,options,result,persisted;
 const ctx={projectStatus:status,discardSourceEdits:()=>true,projectWatchCacheMeta:()=>({title:'A',sourceKey:status.root}),projectRecordMatchesStatus:()=>true,compileExcludePatterns:text=>text.split('\n'),projectWatchDuringRef:{},projectWatchReadRef:{},projectWatchSnapRevRef:{},projectAnalyzingRef:{},analysisRunRef:{current:1},resetAnalysisState:()=>true,Parser:{initTreeSitter:async()=>{},isCode:()=>true,isOversized:()=>false,isScriptContainer:()=>false,extract:()=>[],detectLayer:()=> 'logic'},filterAnalyzableLocalFiles:(files,patterns)=>{filtered=patterns;return files.filter(f=>!f.path.startsWith('private/'));},fetch:async url=>{requests.push(url);return{ok:true,status:200,json:async()=>({files:[{path:'src/Main.kt',name:'Main.kt'},{path:'private/Secret.kt',name:'Secret.kt'}]}),text:async()=> 'class Main',headers:{get:()=>null}};},normalizeProjectWatchPath:x=>x,projectWatchSnapRevFromResponse:()=>null,runAnalysisData:async input=>{options=input;return {files:input.analyzed};},retainProjectWatchPathsAfterAnalysis:()=>[],setData:x=>result=x,persistCurrentAnalysis:(...args)=>persisted=args,clearProjectLiveDiffs(){},setProjectStatus(){},setLoading(){},setProgress(){},setExpandedPaths(){},setProjectInfo(){},setCachedFromId(){},setProjectDirty(){},setError:error=>assert.fail(error),yieldToBrowser:async()=>{}};
 vm.createContext(ctx);vm.runInContext(html.slice(a,b),ctx);
 assert.equal(await ctx.analyzeLocalProject(true,status),true);
 assert.deepEqual(Array.from(filtered),['private']);assert.deepEqual(Array.from(options.excludePatterns),['private']);
 assert.equal(result.files.length,1);assert.equal(result.files[0].path,'src/Main.kt');assert.equal(persisted[1].sourceType,'local-project');
 assert.equal(requests.length,2);assert.ok(requests.every(url=>url.startsWith('/__codeflow/')&&url.includes('pid=active-generation')));
});
