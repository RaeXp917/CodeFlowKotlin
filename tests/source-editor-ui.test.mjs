import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFileSync } from 'node:fs';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');
const ctx={console,window:{confirm:()=>true},URL};ctx.self=ctx;vm.createContext(ctx);
vm.runInContext(readFileSync(new URL('../vendor/react/react.production.min.js',import.meta.url),'utf8'),ctx);
vm.runInContext(html.slice(html.indexOf('// ===== CODEFLOW_SOURCE_EDITOR_START ====='),html.indexOf('// ===== CODEFLOW_SOURCE_EDITOR_END =====')),ctx);
function all(tree){if(!tree||typeof tree!=='object')return[];if(Array.isArray(tree))return tree.flatMap(all);return[tree,...all(tree.props&&tree.props.children)];}
function host(props){
 let hooks=[],cursor=0,effects=[],cleanups=[];const locals={...ctx};vm.createContext(locals);
 // Each component has an independent hook host, as in React; sessions are owned by App.
 locals.useState=initial=>{const i=cursor++;if(!(i in hooks))hooks[i]=initial;return[hooks[i],fn=>hooks[i]=typeof fn==='function'?fn(hooks[i]):fn];};
 locals.useRef=value=>{const i=cursor++;if(!(i in hooks))hooks[i]={current:value};return hooks[i];};
 locals.useEffect=(fn,deps)=>{const i=cursor++,old=hooks[i];if(!old||deps.some((v,n)=>v!==old[n])){hooks[i]=deps;effects.push(fn);}};
 vm.runInContext(html.slice(html.indexOf('// ===== CODEFLOW_SOURCE_EDITOR_START ====='),html.indexOf('// ===== CODEFLOW_SOURCE_EDITOR_END =====')),locals);
 return{ctx:locals,unmount(){cleanups.forEach(fn=>fn());},render(){cursor=0;effects=[];const tree=locals.SourceCardEditor(props);effects.forEach(fn=>{const cleanup=fn();if(cleanup)cleanups.push(cleanup);});return tree;}};
}
const session=(path,text='original')=>({path,projectId:'A',text,original:text,ready:true,version:'a'.repeat(64),saving:false});
const settle=async()=>{for(let i=0;i<24;i++)await Promise.resolve();};
test('dirty guards protect drafts, allow clean navigation, and block during save',()=>{
 const sessions=new Map([['a.kt',session('a.kt')]]);let asked=0;const no=()=>{asked++;return false;};assert.equal(ctx.sourceSessionGuard(sessions,no,true),true);assert.equal(asked,0);
 sessions.get('a.kt').text='draft';assert.equal(ctx.sourceSessionGuard(sessions,no,true),false);assert.equal(sessions.get('a.kt').text,'draft');assert.equal(ctx.sourceSessionGuard(sessions,()=>true,false),true);assert.equal(sessions.get('a.kt').text,'draft');
 sessions.get('a.kt').saving=true;assert.equal(ctx.sourceSessionGuard(sessions,()=>true,true),false);assert.equal(ctx.sourceSessionsPending(sessions),true);
});
test('focused Ctrl+S saves the captured file with version and CSRF; Undo is untouched',async()=>{
 const s=session('src/A.kt'),sessions=new Map([[s.path,s]]),saved=[];
 const h=host({sessions,path:s.path,projectId:'A',onStatus(){},onSaved:r=>saved.push(r),onCancel(){}});const requests=[];
 h.ctx.fetch=async(url,opts)=>{requests.push({url,opts});return{ok:true,json:async()=>url==='/__codeflow/projects'?{selected:'A',csrf:'token'}:{...s,content:s.text,version:'b'.repeat(64),bom:false,lineEnding:'LF'}};};
 let tree=h.render(),textarea=all(tree).find(n=>n.type==='textarea');textarea.props.onChange({target:{value:'edited\n'}});assert.equal(ctx.sourceSessionDirty(s),true);
 tree=h.render();textarea=all(tree).find(n=>n.type==='textarea');let prevented=0,stopped=0;
 textarea.props.onKeyDown({ctrlKey:true,key:'s',preventDefault(){prevented++;},stopPropagation(){stopped++;}});await settle();
 assert.equal(prevented,1);assert.ok(stopped);assert.equal(requests[1].url,'/__codeflow/edit-source');const body=JSON.parse(requests[1].opts.body);assert.equal(body.path,'src/A.kt');assert.equal(body.projectId,'A');assert.equal(body.content,'edited\n');assert.equal(requests[1].opts.headers['X-Codeflow-CSRF'],'token');assert.equal(saved.length,1);assert.equal(ctx.sourceSessionDirty(s),false);
 let undoPrevented=false;all(h.render()).find(n=>n.type==='textarea').props.onKeyDown({ctrlKey:true,key:'z',preventDefault(){undoPrevented=true;},stopPropagation(){}});assert.equal(undoPrevented,false);
});
test('Cancel never sends a write; declined discard keeps the buffer',()=>{
 const s=session('a.kt');s.text='draft';let cancelled=0;const h=host({sessions:new Map([[s.path,s]]),path:s.path,projectId:'A',onStatus(){},onCancel(){cancelled++;}});h.ctx.window={confirm:()=>false};h.ctx.fetch=()=>{throw new Error('unexpected network')};
 const cancel=all(h.render()).find(n=>n.type==='button'&&n.props['aria-label']==='Cancel editing a.kt');cancel.props.onClick();assert.equal(cancelled,0);assert.equal(s.text,'draft');h.ctx.window.confirm=()=>true;cancel.props.onClick();assert.equal(cancelled,1);
});
test('conflicts keep drafts, expose Reload, and never force overwrite',async()=>{
 const s=session('a.kt');s.text='draft';const h=host({sessions:new Map([[s.path,s]]),path:s.path,projectId:'A',onStatus(){},onSaved(){throw new Error('unexpected save')},onCancel(){}});
 h.ctx.fetch=async url=>({ok:url==='/__codeflow/projects',status:url==='/__codeflow/projects'?200:409,json:async()=>url==='/__codeflow/projects'?{selected:'A',csrf:'t'}:{error:'Source changed externally'}});
 const save=all(h.render()).find(n=>n.type==='button'&&n.props['aria-label']==='Save a.kt');await save.props.onClick();assert.equal(s.text,'draft');assert.equal(s.original,'original');assert.equal(ctx.sourceSessionDirty(s),true);assert.ok(all(h.render()).some(n=>n.type==='button'&&n.props['aria-label']==='Reload source and resolve conflict'));
});
test('editor buffers survive remounts and remain separated for same-named files',()=>{
 const a=session('src/A.kt'),b=session('other/A.kt'),sessions=new Map([[a.path,a],[b.path,b]]);a.text='draft A';b.text='draft B';
 for(const s of [a,b,a]){const h=host({sessions,path:s.path,projectId:'A',onStatus(){},onSaved(){},onCancel(){}});h.ctx.fetch=()=>{throw new Error('should restore without reread')};assert.equal(all(h.render()).find(n=>n.type==='textarea').props.value,s.text);}
});
test('source display restores UTF-8 BOM and original line endings after saving',()=>{
 assert.equal(ctx.sourceEditorDiskText({bom:true,lineEnding:'CRLF',content:'a\nb'}),'\uFEFFa\r\nb');
});
test('project selection/removal/exclusion mutations consult the live dirty guard first',async()=>{
 const selector=readFileSync(new URL('../server/project-selector.js',import.meta.url),'utf8'),start=selector.indexOf('  function mutate('),end=selector.indexOf('  function pickProject(',start);let fetches=0;
 const local={window:{codeflowBeforeProjectChange:()=>false},csrf:()=> 't',fetch:()=>{fetches++;return Promise.resolve({ok:true})}};vm.createContext(local);vm.runInContext(selector.slice(start,end),local);
 for(const path of ['/__codeflow/select-project','/__codeflow/remove-project','/__codeflow/set-exclusions','/__codeflow/add-project'])await assert.rejects(local.mutate(path,{}),/cancelled/);assert.equal(fetches,0);
});
test('saved-source integration updates preview/live content and invalidates search/analysis',()=>{
 const start=html.indexOf('    function savedSourceEdit('),end=html.indexOf('    function refreshRecentList(',start);let live={},dirty=[],preview={path:'a.kt',content:'old'},stale=false,results=['old'];
 const local={searchSeqRef:{current:1},searchAbortRef:{current:null},filePreviewRequestRef:{current:0},setSearchLoading(){},setSearchStats(){},sourceEditorDiskText:ctx.sourceEditorDiskText,mergeProjectLiveContents:(prev,updates)=>({...prev,[updates[0].path]:updates[0].content}),noteProjectWatchPath:(prev,path)=>[...prev,path],setProjectLiveByPath:fn=>live=fn(live),setProjectDirty:fn=>dirty=fn(dirty),setFilePreview:fn=>preview=fn(preview),setSearchStale:v=>stale=v,setSearchResults:v=>results=v,updateSourceEditStatus(){}};
 vm.createContext(local);vm.runInContext(html.slice(start,end),local);local.savedSourceEdit({path:'a.kt',content:'new\n',lineEnding:'LF'});assert.equal(live['a.kt'],'new\n');assert.deepEqual(dirty,['a.kt']);assert.equal(preview.content,'new\n');assert.equal(stale,true);assert.equal(results.length,0);
});

test('native page-unload protection checks all dirty/saving buffers',()=>{
 const start=html.indexOf('        function beforeUnload(event){'),end=html.indexOf("        window.addEventListener('beforeunload'",start),sessions=new Map([['a.kt',session('a.kt')]]);let prevented=false;
 const local={sourceSessionsPending:ctx.sourceSessionsPending,sourceSessionsRef:{current:sessions},sourceGuardRef:{current:()=>true}};vm.createContext(local);vm.runInContext(html.slice(start,end),local);
 const event={preventDefault(){prevented=true;}};local.beforeUnload(event);assert.equal(prevented,false);sessions.get('a.kt').text='draft';local.beforeUnload(event);assert.equal(prevented,true);assert.equal(event.returnValue,'');assert.equal(sessions.get('a.kt').text,'draft');
});

test('a late editor load after remount cannot replace a newer draft',async()=>{
 const sessions=new Map(),props={sessions,path:'a.kt',projectId:'A',onStatus(){},onSaved(){},onCancel(){}};let releaseOld;
 const old=host(props);old.ctx.fetch=()=>new Promise(resolve=>releaseOld=resolve);old.render();old.unmount();
 const next=host(props);next.ctx.fetch=async()=>({ok:true,json:async()=>({path:'a.kt',projectId:'A',content:'new disk version',version:'b'.repeat(64)})});next.render();await settle();all(next.render()).find(n=>n.type==='textarea').props.onChange({target:{value:'newer unsaved draft'}});
 releaseOld({ok:true,json:async()=>({path:'a.kt',projectId:'A',content:'old disk version',version:'a'.repeat(64)})});await settle();assert.equal(sessions.get('a.kt').text,'newer unsaved draft');
});
