import assert from 'node:assert/strict';
import test from 'node:test';
import vm from 'node:vm';
import { readFile, access } from 'node:fs/promises';
const html=await readFile(new URL('../index.html',import.meta.url),'utf8');
test('only local source modes can enter caches',()=>{
 const a=html.indexOf('function isLocalAnalysisRecord('),b=html.indexOf('function listRecentAnalyses(',a),ctx={};vm.createContext(ctx);vm.runInContext(html.slice(a,b),ctx);
 for(const mode of ['github','cli','remote','unknown'])assert.equal(ctx.isLocalAnalysisRecord({sourceType:mode}),false);
 for(const mode of ['local-project','folder','zip'])assert.equal(ctx.isLocalAnalysisRecord({sourceType:mode}),true);
});
test('retired product files are absent, Git CI and local runtime remain',async()=>{
 for(const p of ['card/index.js','card/analyze.js','cli/projects-server.mjs','vendor/jsrsasign/jsrsasign-all-min.js'])await assert.rejects(access(new URL('../'+p,import.meta.url)));
 for(const p of ['server/projects-server.mjs','.github/workflows/test.yml','.github/workflows/codeql.yml','LICENSE'])await access(new URL('../'+p,import.meta.url));
});
test('browser fetch destinations are local, including worker assets',()=>{
 const destinations=[...html.matchAll(/fetch\(\s*['"]([^'"]+)['"]/g)].map(m=>m[1]);assert.ok(destinations.length>=5);assert.ok(destinations.every(p=>p.startsWith('/__codeflow/')));
 assert.doesNotMatch(html,/api\.github\.com|githubusercontent|cliWatch|cliDiff|GitHub=|repoUrl|ownerLoading/);
 for(const m of html.matchAll(/<script[^>]+src="([^"]+)"/g))assert.ok(m[1].startsWith('./vendor/'));
});
