import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
import { performance } from 'node:perf_hooks';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
function block(start,end){return html.slice(html.indexOf(start),html.indexOf(end,html.indexOf(start)));}
const ctx={console,URL,performance,getSecurityScanContent:f=>f.content||'',isSanitizedPreviewRenderer:()=>false};
ctx.self=ctx;
vm.createContext(ctx);
vm.runInContext(block('function normalizeExcludePath(', 'function shouldIgnoreDirectory('),ctx);
vm.runInContext(block('// ===== CODEFLOW_ANALYZER_START =====','// ===== CODEFLOW_ANALYZER_END =====')+block('// ===== CODEFLOW_GUIDE_START =====','// ===== CODEFLOW_GUIDE_END ====='),ctx);
const file=(path,content='')=>({path,name:path.split('/').pop(),content,isCode:true,functions:[],layer:'unknown'});
const describe=(path,content)=>ctx.describeGuideFile(file(path,content));
const roles=m=>m.components.map(c=>c.role);
const plain=x=>JSON.parse(JSON.stringify(x));
const index=(files,connections=[],architectureInsights=[],fnStats={})=>ctx.buildGuideIndex({files,connections,architectureInsights,fnStats});
for(const [name,path,code,expected] of [
 ['Kotlin Composable','Screen.kt','@Composable fun Screen() {}',['Composable']],
 ['Kotlin ViewModel','State.kt','class State : ViewModel() {}',['ViewModel']],
 ['Kotlin Repository','Data.kt','class ItemRepository {}',['Repository']],
 ['Kotlin DAO','Db.kt','@Dao interface ItemDao {}',['DAO']],
 ['Swift View','Screen.swift','import SwiftUI\nstruct Screen: View {}',['SwiftUI View']],
 ['Swift legacy model','Model.swift','class Model: ObservableObject {}',['ObservableObject']],
 ['Swift modern model','Model.swift','@Observable final class Model {}',['@Observable model']],
 ['Dart Widget','main.dart',"import 'package:flutter/widgets.dart';\nclass Home extends StatelessWidget {}",['Widget / View']],
 ['Dart controller','state.dart','class Counter extends ChangeNotifier {}',['ChangeNotifier']],
 ['Dart Riverpod','state.dart','class Counter extends AsyncNotifier<int> {}',['AsyncNotifier']],
 ['Dart Repository and Service','data.dart','class ItemRepository {}\nclass ApiService {}',['Repository','Service']],
 ['Kotlin multiple declarations','App.kt','class App: ComponentActivity() {}\nclass HomeViewModel: ViewModel() {}\n@Composable fun Home() {}',['Activity','ViewModel','Composable']],
 ['Swift actor','Worker.swift','actor Worker {}',['Actor']],
 ['Kotlin UseCase/API','Data.kt','class LoadUseCase {}\ninterface Api { @GET suspend fun load() }',['UseCase','Retrofit API']]
])test('classification: '+name,()=>assert.deepEqual(plain(roles(describe(path,code))),expected));
for(const [path,code] of [['x.kt','fun sum(a:Int,b:Int)=a+b'],['x.swift','func sum() {}'],['x.dart','int sum()=>1;']])test('unknown role: '+path,()=>assert.equal(describe(path,code).components.length,0));
test('naming inference is distinct from source inheritance',()=>{
 assert.match(describe('A.kt','class HomeViewModel {}').components[0].evidence,/Inferred/);
 assert.equal(describe('A.kt','class HomeViewModel: ViewModel() {}').components[0].confidence,'high');
 assert.match(describe('Db.kt','interface ItemDao {}').components[0].evidence,/Inferred/);
});
test('comments and strings cannot introduce components or imports',()=>{
 for(const path of ['x.kt','x.swift','x.dart']){
  const m=describe(path,'// class FakeRepository {}\n/* import fake.Type */\nval text = "class FakeService {}"');
  assert.equal(m.components.length,0);assert.equal(m.imports.length,0);
 }
});
test('imports retain one-based source locations and are not calls',()=>{
 const m=describe('a.kt','// import nope\nimport app.State\nclass A {}');
 assert.deepEqual(plain(m.imports),[{name:'app.State',line:2}]);
 const f=file('a.kt');f.guide=m;const ix=index([f]);assert.equal(ix.outgoing.size,0);
});
test('real call edges have correct incoming/outgoing direction and definition line',()=>{
 const ix=index([file('a.kt'),file('b.kt')],[{source:{id:'b.kt'},target:'a.kt',fn:'load',functionKey:'b:load'}],[],{'b:load':{line:7}});
 assert.equal(ix.outgoing.get('a.kt')[0].to,'b.kt');assert.equal(ix.incoming.get('b.kt')[0].from,'a.kt');
 assert.equal(ix.outgoing.get('a.kt')[0].line,7);assert.match(ix.outgoing.get('a.kt')[0].kind,/Function call/);
});
test('missing targets, unknown edges, self edges and foreign project paths are not invented',()=>{
 const ix=index([file('a.kt')],[{source:'missing.kt',target:'a.kt',functionKey:'x'},{source:'a.kt',target:'a.kt',functionKey:'y'},{source:'a.kt',target:'a.kt'}]);
 assert.equal(ix.outgoing.size,0);assert.equal(ix.incoming.size,0);
 assert.equal(ctx.guideWalkStep(['a.kt'],'foreign.kt',ix),null);
});
test('resolved import metadata stays separate from calls and has no fabricated line',()=>{
 const a=file('a.dart');a.guide={importTargets:['b.dart']};
 const ix=index([a,file('b.dart')]);const e=ix.outgoing.get('a.dart')[0];assert.equal(e.kind,'Imported file');assert.equal(e.line,null);
});
test('walkthrough handles cycles, unrelated files, missing targets, and depth bound',()=>{
 const files=Array.from({length:15},(_,i)=>file(i+'.kt'));
 const edges=files.slice(1).map((_,i)=>({source:(i+1)+'.kt',target:i+'.kt',functionKey:'f'}));
 edges.push({source:'0.kt',target:'1.kt',functionKey:'cycle'});
 const ix=index(files,edges);let trail=['0.kt'];
 assert.equal(ctx.guideWalkStep(trail,'14.kt',ix),null);
 trail=ctx.guideWalkStep(trail,'1.kt',ix);assert.equal(ctx.guideWalkStep(trail,'0.kt',ix),null);
 for(let i=2;i<12;i++)trail=ctx.guideWalkStep(trail,i+'.kt',ix);
 assert.equal(trail.length,12);assert.equal(ctx.guideWalkStep(trail,'12.kt',ix),null);
});
test('full findings index matches exact paths beyond the Actions cap',()=>{
 const findings=Array.from({length:70},(_,i)=>({path:i===0?'other/A.kt':'ui/A.kt',line:i+1,code:'expression '+i,ruleId:'compose-state-without-remember',topicId:'compose-state'}));
 const ix=index([file('ui/A.kt'),file('other/A.kt')],[],findings);
 assert.equal(ix.findings.get('ui/A.kt').length,69);assert.equal(ix.findings.get('ui/A.kt')[68].code,'expression 69');assert.equal(ix.findings.get('ui/A.kt')[68].line,70);
});
test('project switching, removed/excluded files, and reanalysis replace all indexed context',()=>{
 const a=file('ui/A.kt');a.guide={ecosystem:'kotlin'};
 const old=index([a],[],[{path:a.path,code:'private A'}]);
 const next=index([file('B.swift')]);assert.equal(next.files.has(a.path),false);assert.equal(next.findings.size,0);
 assert.equal(index([a]).findings.size,0);
 const excluded=ctx.buildGuideIndex({files:[a],architectureInsights:[{path:a.path}]},ctx.compileExcludePatterns('ui'));
 assert.equal(excluded.files.size,0);assert.equal(excluded.findings.size,0);
 assert.equal(old.findings.get(a.path).length,1);
});
test('unsafe paths and non-source entries are rejected before navigation',()=>{
 for(const path of ['../a.kt','/a.kt','C:/a.kt','a\\b.kt','a/../b.kt','a\u0000.kt','x.md'])assert.equal(index([file(path)]).files.size,0,path);
});
test('ecosystems remain separated in mixed-language projects',()=>{
 const ix=index([file('a.kt'),file('b.swift')]);
 for(const [path,code,ecosystem] of [['a.kt','class A: ViewModel() {}','kotlin'],['b.swift','import SwiftUI\nstruct B: View {}','swift'],['c.dart',"import 'package:flutter/widgets.dart';",'flutter']]){
 const topics=ctx.guideTopics(describe(path,code),[],ix);assert.ok(topics.length);assert.ok(topics.every(t=>t.ecosystem===ecosystem));
 }
 assert.equal(ctx.guideTopics(describe('plain.dart','int sum()=>1;'),[],ix).length,0);
});
test('finding-linked learning topic is prioritized and URLs are controlled',()=>{
 const topics=ctx.guideTopics(describe('x.kt','class X {}'),[{topicId:'compose-state'}],index([]));assert.equal(topics[0].topicId,'compose-state');
 for(const t of ctx.listLearningTopics())assert.ok(ctx.guideDocUrl(t.docUrl));
 for(const u of ['javascript:alert(1)','https://developer.apple.com.evil.test/','https://evil.test','https://user@developer.apple.com/','http://dart.dev'])assert.equal(ctx.guideDocUrl(u),null);
});
// Execute the real React component with a small hook host. Elements and event
// handlers are real createElement results; no browser/network/source reads needed.
vm.runInContext(readFileSync(new URL('../vendor/react/react.production.min.js',import.meta.url),'utf8'),ctx);
function host(props){
 let values=[],cursor=0,effects=[];
 ctx.useState=initial=>{const n=cursor++;if(!(n in values))values[n]=initial;return [values[n],v=>{values[n]=typeof v==='function'?v(values[n]):v;}];};
 ctx.useEffect=fn=>effects.push(fn);
 return {render(p=props){props=p;cursor=0;effects=[];const tree=ctx.ArchitectureGuide(props);effects.forEach(fn=>fn());return tree;}};
}
function nodes(tree){if(tree==null||typeof tree==='boolean')return[];if(Array.isArray(tree))return tree.flatMap(nodes);if(typeof tree!=='object')return[tree];return[tree,...nodes(tree.props&&tree.props.children)];}
function text(tree){return nodes(tree).filter(n=>typeof n==='string'||typeof n==='number').join(' ');}
function buttons(tree){return nodes(tree).filter(n=>n&&n.type==='button');}
const guideFile=(path,content)=>{const f=file(path,content);f.guide=ctx.describeGuideFile(f);return f;};
test('rendering: no selection, unknown role, no findings, and illustrative examples',()=>{
 const a=guideFile('a.kt','fun sum() {}'),ix=index([a]);
 const base={index:ix,onSource(){},onNavigate(){}};
 assert.match(text(host(base).render()),/Select a source file/);
 const tree=host({...base,path:a.path}).render(),content=text(tree);
 assert.match(content,/Architectural role unknown/);assert.match(content,/No architecture findings were reported/);assert.match(content,/Illustrative example — not project code/);
 assert.ok(!/perfectly|free of problems|healthy/.test(content));
 assert.equal(nodes(tree).some(n=>n&&n.props&&n.props.dangerouslySetInnerHTML),false);
});
test('selection changes replace details and stale watcher content never renders',()=>{
 const a=guideFile('A.kt','class ARepository {}'),b=guideFile('B.swift','@Observable class B {}'),ix=index([a,b]);
 const base={index:ix,onNavigate(){},onSource(){}};const h=host({...base,path:a.path});assert.match(text(h.render()),/ARepository/);
 const next=text(h.render({...base,path:b.path}));assert.match(next,/@Observable model/);assert.ok(!next.includes('ARepository'));
 const stale=text(h.render({...base,path:b.path,stale:true}));assert.match(stale,/Re-analyze/);assert.ok(!stale.includes('@Observable model'));
});
test('navigation handlers open actual related file, return, and preserve exact finding line',()=>{
 const a=guideFile('a.kt','class A {}'),b=guideFile('b.kt','class B {}');let navigated=[],sources=[];
 const ix=index([a,b],[{source:'b.kt',target:'a.kt',fn:'load',functionKey:'f'}],[{path:'a.kt',line:9,code:'bad()',ruleId:'android-globalscope-usage',severity:'high',confidence:'high',kind:'issue'}],{f:{line:5}});
 const base={index:ix,path:'a.kt',onNavigate:p=>navigated.push(p),onSource:(...x)=>sources.push(x)};
 const h=host(base);let tree=h.render();buttons(tree).find(b=>b.props['aria-label']==='Explore related file b.kt').props.onClick();assert.deepEqual(navigated,['b.kt']);
 tree=h.render({...base,path:'b.kt'});buttons(tree).find(b=>b.props['aria-label']==='Return to previous guide component').props.onClick();assert.deepEqual(navigated,['b.kt','a.kt']);
 tree=h.render(base);buttons(tree).find(b=>b.props['aria-label']==='View source a.kt:9').props.onClick();assert.deepEqual(sources,[['a.kt',9]]);
});
test('large projects keep initial rendering bounded and all findings reachable',()=>{
 const a=guideFile('a.kt','class A: ViewModel() {}');const files=[a,...Array.from({length:1000},(_,i)=>file('f'+i+'.kt'))];
 const edges=files.slice(1).map(f=>({source:f.path,target:'a.kt',fn:'load',functionKey:'f'}));
 const findings=Array.from({length:80},(_,i)=>({path:'a.kt',line:i+1,code:'expression '+i,title:'finding '+i,ruleId:'android-globalscope-usage'}));
 const start=performance.now(),ix=index(files,edges,findings),h=host({index:ix,path:'a.kt',onNavigate(){},onSource(){}});let tree=h.render();
 assert.equal(nodes(tree).filter(n=>n&&n.type==='article').length,20);assert.equal(buttons(tree).filter(b=>/^Explore related/.test(b.props['aria-label']||'')).length,20);
 for(let i=0;i<3;i++){buttons(tree).find(b=>text(b)==='Show 20 more findings').props.onClick();tree=h.render();}
 assert.equal(nodes(tree).filter(n=>n&&n.type==='article').length,80);
 const ms=performance.now()-start;assert.ok(ms<1000,'guide indexing/render exceeded 1 second: '+ms);console.log('Guide 1,001 files / 1,000 edges / 80 findings: '+ms.toFixed(1)+'ms');
});
test('shared analyzer produces compact metadata before source disposal',async()=>{
 const files=[file('Home.kt','import androidx.compose.runtime.*\n@Composable fun Home(){ val s = mutableStateOf(0) }'),file('Model.swift','import SwiftUI\n@Observable class Model {}'),file('lib/main.dart',"import 'package:flutter/widgets.dart';\nclass Home extends StatelessWidget {}")];
 const data=await ctx.buildAnalysisData({analyzed:files,allFns:[],yieldFn:()=>Promise.resolve()});
 assert.ok(data.files.every(f=>f.content===null&&f.guide));assert.ok(data.architectureInsights.length);assert.deepEqual(plain(roles(data.files[1].guide)),['@Observable model']);
 assert.ok(!JSON.stringify(data.files.map(f=>f.guide)).includes('mutableStateOf'));
});

function navigationHost(files,excluded=[]){
 const state={selected:null,tab:'guide',preview:null,reads:0},ix=ctx.buildGuideIndex({files},ctx.compileExcludePatterns(excluded.join('\n')));
 const nav={data:{files},guideIndex:ix,repoInfo:{},localSourceKind:'local-project',isMobile:false,graphConfig:{vizType:'code'},useCallback:fn=>fn,
 setActiveSymbol(){},setSelected:f=>state.selected=f,setRightTab:fn=>state.tab=typeof fn==='function'?fn(state.tab):fn,setMobilePanel(){},setLegendCollapsed(){},calcBlast:()=>({}),setBlastRadius(){},setOwnership(){},setOwnerLoading(){},setExpandedFns(){},selectedPathRef:{},codeLinkParticlesHiddenRef:{},queueForceLinkVisuals(){},
 filePreviewRequestRef:{current:0},setFilePreview:p=>state.preview=p,fileHasLoadedSource:f=>typeof f.content==='string',analysisHydrationIdRef:{current:'project-A:revision-1'},rememberHydratedSources(){},canReadLiveFileSource:()=>true,readLiveFileSource:()=>{state.reads++;return Promise.resolve('loaded source');}};
 vm.createContext(nav);
 vm.runInContext(block('    var selectFile=useCallback(function(path){','    selectFileRef.current=selectFile;')+block('    function openFilePreview(path,line){','    // Scroll to highlighted line')+block('    function openSearchResult(path,line){','    // Ctrl+Shift+F'),nav);
 return {nav,state};
}
test('real selectFile entry point replaces Guide context and preserves the Guide tab',()=>{
 const {nav,state}=navigationHost([file('a.kt'),file('b.swift')]);
 nav.selectFile('a.kt');assert.equal(state.selected.path,'a.kt');assert.equal(state.tab,'guide');
 nav.selectFile('b.swift');assert.equal(state.selected.path,'b.swift');assert.equal(state.tab,'guide');
 state.tab='security';nav.selectFile('a.kt');assert.equal(state.tab,'details');
});
test('real search/preview entry point selects the file and exact source line',()=>{
 const {nav,state}=navigationHost([file('a.kt','source A'),file('b.swift','source B')]);
 nav.selectFile('a.kt');nav.openSearchResult('b.swift',11);
 assert.equal(state.selected.path,'b.swift');assert.equal(state.preview.line,11);assert.equal(state.preview.content,'source B');assert.equal(state.reads,0);
});
test('excluded, removed and unauthorized selections perform no source reads',()=>{
 const {nav,state}=navigationHost([file('private/a.kt'),file('ok.kt')],['private']);
 for(const path of ['private/a.kt','removed.kt','../escape.kt']){nav.selectFile(path);nav.openSearchResult(path,1);}
 assert.equal(state.selected,null);assert.equal(state.preview,null);assert.equal(state.reads,0);
});
test('late source hydration from a previous project is rejected',async()=>{
 const f=file('a.kt');f.content=null;const {nav,state}=navigationHost([f]);let release;
 nav.readLiveFileSource=()=>new Promise(resolve=>release=resolve);
 nav.openFilePreview('a.kt',2);nav.analysisHydrationIdRef.current='project-B:revision-1';state.preview=null;release('private project A code');
 await Promise.resolve();assert.equal(state.preview,null);
});

test('framework imports in comments do not activate unrelated teaching',()=>{
 for(const [path,code] of [['x.swift','// import SwiftUI\nclass Item {}'],['x.dart',"// import 'package:flutter/widgets.dart';\nclass Item {}"],['x.kt','// import androidx.compose.runtime.*\nclass Item {}']])assert.equal(describe(path,code).framework,'Not detected');
 assert.equal(describe('x.dart',"// import 'package:flutter/widgets.dart';").ecosystem,null);
});
test('DAO annotation and Android Service inheritance work without conventional names',()=>{
 assert.deepEqual(plain(roles(describe('Db.kt','@Dao interface Queries {}'))),['DAO']);
 assert.equal(describe('Worker.kt','class Worker: Service() {}').components[0].role,'Service');
});

test('a slower preview cannot replace the most recently selected file',async()=>{
 const a=file('a.kt'),b=file('b.kt');a.content=null;b.content=null;
 const {nav,state}=navigationHost([a,b]);const waiting={};nav.readLiveFileSource=path=>new Promise(resolve=>waiting[path]=resolve);
 nav.openFilePreview('a.kt',2);nav.openFilePreview('b.kt',4);waiting['b.kt']('B source');await Promise.resolve();waiting['a.kt']('A source');await Promise.resolve();
 assert.equal(state.preview.path,'b.kt');assert.equal(state.preview.content,'B source');assert.equal(state.selected.path,'b.kt');
});
test('late analyzer results cannot overwrite a newer project or reanalysis',async()=>{
 let release,started;const entered=new Promise(resolve=>started=resolve),runRef={current:0};const writes=[];
 const nav={console,cliStatus:{ok:true,pid:'A',root:'A'},cliRecordMatchesStatus:()=>true,cliWatchCacheMeta:()=>({title:'A',sourceKey:'A'}),analysisRunRef:runRef,activeExcludePatterns:[],
 cliWatchDuringRef:{},cliWatchReadRef:{},cliWatchSnapRevRef:{},cliAnalyzingRef:{},localFolderKeyRef:{},localFolderSelectionRef:{},zipArchiveRef:{},zipFileRef:{},zipKeyRef:{},
 setError(e){throw new Error(e);},resetAnalysisState(){runRef.current++;},setData:data=>writes.push(data),setCliStatus(){},setLocalDirHandle(){},setLocalSourceKind(){},setLoading(){},setProgress(){},
 Parser:{initTreeSitter:()=>Promise.resolve(),isCode:()=>true,isOversized:()=>false,isScriptContainer:()=>false,extract:()=>[],detectLayer:()=> 'ui'},
 fetch:async url=>({ok:true,status:200,json:async()=>({files:[file('A.kt')]}),text:async()=> 'class A {}'}),filterAnalyzableLocalFiles:files=>files,normalizeCliWatchPath:p=>p,cliWatchSnapRevFromResponse:()=>null,
 yieldToBrowser:()=>Promise.resolve(),runAnalysisData:()=>{started();return new Promise(resolve=>release=resolve);}};
 vm.createContext(nav);vm.runInContext(block('    async function analyzeLocalProject(','    function resetAnalysisState('),nav);
 const pending=nav.analyzeLocalProject(true,nav.cliStatus);await entered;runRef.current++;release({files:[file('old-A.kt')]});assert.equal(await pending,false);assert.equal(writes.length,0);
});
