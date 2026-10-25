import assert from 'node:assert/strict';
import test from 'node:test';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
const html=readFileSync(new URL('../index.html',import.meta.url),'utf8');const ctx={console};vm.createContext(ctx);
vm.runInContext(html.slice(html.indexOf('// ===== CODEFLOW_CANVAS_START ====='),html.indexOf('// ===== CODEFLOW_CANVAS_END =====')),ctx);
vm.runInContext(readFileSync(new URL('../vendor/d3/d3.min.js',import.meta.url),'utf8'),ctx);
function handler(target,extra={}){
 let stopped=false,prevented=false,called;const local={...ctx,zoomRef:{current:{scaleBy:(s,f,p)=>called={factor:f,point:p}}},svgRef:{current:{getBoundingClientRect:()=>({left:20,top:30,height:600})}},d3:{select:()=>({})}};
 vm.createContext(local);const a=html.indexOf('        function onWheel(e){',html.indexOf('var el=codeCanvasRef.current;')),b=html.indexOf("        el.addEventListener('wheel'",a);vm.runInContext(html.slice(a,b),local);
 local.onWheel({deltaY:-80,clientX:220,clientY:180,target,preventDefault(){prevented=true;},stopPropagation(){stopped=true;},...extra});return {called,prevented,stopped};
}
test('actual listener zooms ordinary canvas wheel around pointer and blocks page scrolling',()=>{
 const r=handler({closest:()=>null});assert.ok(r.called.factor>1);assert.deepEqual(Array.from(r.called.point),[200,150]);assert.equal(r.prevented,true);
 assert.ok(handler({closest:()=>null},{deltaY:80}).called.factor<1);
});
test('scrollable vertical/horizontal source and editor keep native input; Ctrl overrides',()=>{
 for(const selector of ['.code-source-editor','.code-card-body']){
 const target={closest:s=>s===selector?{scrollHeight:900,clientHeight:300,scrollWidth:900,clientWidth:500}:null};
 const native=handler(target);assert.equal(native.called,undefined);assert.equal(native.prevented,false);assert.equal(native.stopped,true);
 assert.ok(handler(target,{ctrlKey:true}).called);assert.equal(handler(target,{ctrlKey:true}).prevented,true);
 }
});
test('wheel delta modes and trackpad changes are controlled',()=>{
 assert.equal(ctx.codeCanvasWheelZoomFactor({deltaY:0}),1);assert.ok(ctx.codeCanvasWheelZoomFactor({deltaY:-1})<1.01);
 assert.equal(ctx.codeCanvasWheelZoomFactor({deltaY:2,deltaMode:1}),ctx.codeCanvasWheelZoomFactor({deltaY:32}));
 assert.ok(ctx.codeCanvasWheelZoomFactor({deltaY:-1e8})<=Math.exp(.35));
});
test('retained D3 zoom clamps scale and keeps world point under pointer',()=>{
 // Exercise the real vendored D3 transform and scaleBy, rather than a second zoom implementation.
 const node={__zoom:ctx.d3.zoomIdentity.translate(25,40).scale(2)};
 const selection=ctx.d3.select(node),zoom=ctx.d3.zoom().extent([[0,0],[800,600]]).scaleExtent([.08,5]);
 const point=[220,180],world=node.__zoom.invert(point);
 zoom.scaleBy(selection,1.2,point);assert.ok(Math.abs(node.__zoom.apply(world)[0]-point[0])<1e-9);assert.ok(Math.abs(node.__zoom.apply(world)[1]-point[1])<1e-9);
 zoom.scaleBy(selection,1e9,point);assert.equal(node.__zoom.k,5);zoom.scaleBy(selection,1e-9,point);assert.equal(node.__zoom.k,.08);
 const moved=node.__zoom.translate(10,-20);assert.ok(Math.abs(moved.x-(node.__zoom.x+10*.08))<1e-9);
});
