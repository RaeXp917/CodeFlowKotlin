// Regression tests for ecosystem-aware architecture insights
// (Parser.detectArchitectureInsights) and their integration into the suggestion
// pipeline. Covers Kotlin/Android, Swift/SwiftUI and React rules, ecosystem
// detection, and — critically — false-positive guards: comments, doc comments,
// string literals, idiomatic patterns (ViewModel state props, @StateObject,
// stable keys) and non-React JS/TS must never produce findings.

import assert from 'node:assert/strict';
import { basename } from 'node:path';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');
const htmlSource = await readFile(join(repoRoot, 'index.html'), 'utf8');
const startMarker = '// ===== CODEFLOW_ANALYZER_START =====';
const endMarker = '// ===== CODEFLOW_ANALYZER_END =====';
const parserStart = htmlSource.indexOf(startMarker);
const parserEnd = htmlSource.indexOf(endMarker, parserStart);
if (parserStart < 0 || parserEnd < 0) throw new Error('Could not locate analyzer source in index.html');

const context = {
  console,
  TreeSitter: undefined,
  Babel: undefined,
  acorn: undefined,
  getSecurityScanContent(file) { return file && file.content ? file.content : ''; },
  isSanitizedPreviewRenderer() { return false; },
};
vm.createContext(context);
vm.runInContext(
  `${htmlSource.slice(parserStart, parserEnd)}\nthis.Parser = Parser; this.buildAnalysisData = buildAnalysisData;`,
  context
);
const { Parser, buildAnalysisData } = context;

function insightsFor(fileDescs) {
  return Parser.detectArchitectureInsights(fileDescs.map((f) => ({
    path: f.path,
    name: basename(f.path),
    content: f.content,
    isCode: Parser.isCode(basename(f.path)),
  })));
}

function ruleIds(insights) {
  return insights.map((i) => i.ruleId).sort();
}

async function analyzeSyntheticFiles(fileDescs) {
  const analyzed = fileDescs.map((file) => {
    const path = file.path;
    const name = basename(path);
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'root';
    return {
      path,
      name,
      folder,
      content: file.content,
      functions: [],
      lines: file.content ? file.content.split('\n').length : 0,
      layer: Parser.detectLayer(path),
      churn: 0,
      isCode: Parser.isCode(name),
    };
  });
  return buildAnalysisData({ analyzed, allFns: [], excludePatterns: [], progress() {}, yieldFn: async () => {} });
}

const MANIFEST = { path: 'app/src/main/AndroidManifest.xml', content: '<manifest package="com.x"/>\n' };

// ---------------------------------------------------------------------------
// Ecosystem detection
// ---------------------------------------------------------------------------

test('Kotlin/Android ecosystem is detected from androidx imports and manifest', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/HomeViewModel.kt', content:
      'import androidx.lifecycle.ViewModel\nimport kotlinx.coroutines.GlobalScope\nclass HomeViewModel : ViewModel() {\n  fun load() { GlobalScope.launch { work() } }\n}\n' },
  ]);
  assert.equal(insights.some((i) => i.ecosystem === 'Kotlin/Android'), true);
});

test('Kotlin script (.kts) in an Android project is analyzed', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/Setup.kts', content:
      'import androidx.lifecycle.ViewModel\nimport kotlinx.coroutines.GlobalScope\nfun boot() { GlobalScope.launch { } }\n' },
  ]);
  assert.equal(insights.some((i) => i.path.endsWith('.kts') && i.ruleId === 'android-globalscope-usage'), true);
});

test('Mixed Kotlin/Java Android project: Kotlin arch rules run, Java is left to other analyzers', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/java/Helper.java', content: 'import android.content.Context;\nclass Helper { void x(Context c) {} }\n' },
    { path: 'app/src/main/presentation/MainViewModel.kt', content:
      'import androidx.lifecycle.ViewModel\nimport android.content.Context\nclass MainViewModel(val ctx: Context) : ViewModel()\n' },
  ]);
  assert.equal(insights.some((i) => i.ruleId === 'android-viewmodel-holds-ui-reference' && i.path.endsWith('.kt')), true);
});

test('Swift project without SwiftUI yields no SwiftUI insights', () => {
  const insights = insightsFor([
    { path: 'Sources/Model.swift', content: 'import Foundation\nclass Model { var count = 0 }\n' },
  ]);
  assert.equal(ruleIds(insights).join(','), '');
});

test('SwiftUI ecosystem is detected from import SwiftUI', () => {
  const insights = insightsFor([
    { path: 'Sources/ContentView.swift', content:
      'import SwiftUI\nstruct ContentView: View {\n  @ObservedObject var m = Model()\n  var body: some View { Text("x") }\n}\n' },
  ]);
  assert.equal(insights.some((i) => i.ecosystem === 'Swift/SwiftUI'), true);
});

test('React JavaScript project is detected from a react import', () => {
  const insights = insightsFor([
    { path: 'src/List.jsx', content:
      "import React from 'react';\nexport function List({items}){ return items.map((x,i)=><li key={i}>{x}</li>); }\n" },
  ]);
  assert.equal(insights.some((i) => i.ecosystem === 'React' && i.ruleId === 'react-array-index-key'), true);
});

test('React TypeScript/TSX project is detected', () => {
  const insights = insightsFor([
    { path: 'src/List.tsx', content:
      "import React from 'react';\nexport function List({items}:any){ return items.map((x:any,index:number)=><li key={index}>{x}</li>); }\n" },
  ]);
  assert.equal(insights.some((i) => i.ruleId === 'react-array-index-key'), true);
});

test('Ordinary TypeScript project that is not React is never flagged', () => {
  const insights = insightsFor([
    { path: 'src/util.ts', content: 'export function f(xs:number[]){ return xs.map((x,index)=>x+index); }\n' },
  ]);
  assert.equal(ruleIds(insights).join(','), '');
});

test('Unrelated languages (Python) produce no architecture insights', () => {
  const insights = insightsFor([
    { path: 'src/main.py', content: 'def f():\n    return 1\n' },
  ]);
  assert.equal(ruleIds(insights).join(','), '');
});

// ---------------------------------------------------------------------------
// Kotlin/Android architecture findings
// ---------------------------------------------------------------------------

test('GlobalScope.launch is flagged with accurate line and snippet', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/HomeViewModel.kt', content:
      'import androidx.lifecycle.ViewModel\nimport kotlinx.coroutines.GlobalScope\nclass HomeViewModel : ViewModel() {\n    fun load() {\n        GlobalScope.launch { fetch() }\n    }\n}\n' },
  ]);
  const hit = insights.find((i) => i.ruleId === 'android-globalscope-usage');
  assert.notEqual(hit, undefined);
  assert.equal(hit.severity, 'high');
  assert.equal(hit.line, 5);
  assert.equal(hit.code, 'GlobalScope.launch { fetch() }');
  assert.ok(/developer\.android\.com/.test(hit.docUrl));
});

test('ViewModel holding a Context is flagged; a Context only in a comment or string is not', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/LeakViewModel.kt', content:
      'import androidx.lifecycle.ViewModel\nimport android.content.Context\nclass LeakViewModel(val ctx: Context) : ViewModel() {\n    val label = "val a: Activity is only a string"\n    // val v: View mentioned in a comment\n}\n' },
  ]);
  const hits = insights.filter((i) => i.ruleId === 'android-viewmodel-holds-ui-reference');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

test('AndroidViewModel holding the Application context is not flagged', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/AppVM.kt', content:
      'import androidx.lifecycle.AndroidViewModel\nimport android.app.Application\nclass AppVM(val app: Application) : AndroidViewModel(app)\n' },
  ]);
  assert.equal(insights.some((i) => i.ruleId === 'android-viewmodel-holds-ui-reference'), false);
});

test('mutableStateOf inside a @Composable without remember is flagged; ViewModel state property is not', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/CounterViewModel.kt', content:
      'import androidx.lifecycle.ViewModel\nimport androidx.compose.runtime.mutableStateOf\nclass CounterViewModel : ViewModel() {\n    var count by mutableStateOf(0)\n}\n' },
    { path: 'app/src/main/presentation/CounterScreen.kt', content:
      'import androidx.compose.runtime.*\n@Composable\nfun CounterScreen() {\n    val bad = mutableStateOf(0)\n    val good = remember { mutableStateOf(0) }\n}\n' },
  ]);
  const hits = insights.filter((i) => i.ruleId === 'compose-state-without-remember');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].path, 'app/src/main/presentation/CounterScreen.kt');
  assert.equal(hits[0].line, 4);
});

test('UI layer constructing the data layer directly (Retrofit/Room) is flagged', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/DetailScreen.kt', content:
      'import androidx.compose.runtime.Composable\n@Composable\nfun DetailScreen() {\n    val api = Retrofit.Builder().baseUrl("https://x").build()\n}\n' },
  ]);
  const hit = insights.find((i) => i.ruleId === 'android-ui-builds-data-layer');
  assert.notEqual(hit, undefined);
  assert.equal(hit.line, 4);
});

test('Correctly layered Kotlin (ViewModel + repository, no violations) yields no issues', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/OrderViewModel.kt', content:
      'import androidx.lifecycle.ViewModel\nimport androidx.lifecycle.viewModelScope\nclass OrderViewModel(private val repo: OrderRepository) : ViewModel() {\n    fun refresh() { viewModelScope.launch { repo.load() } }\n}\n' },
    { path: 'app/src/main/data/OrderRepository.kt', content:
      'class OrderRepository(private val api: OrderApi) {\n    suspend fun load() = api.fetch()\n}\n' },
  ]);
  assert.equal(ruleIds(insights).join(','), '');
});

test('Kotlin comments and strings containing architecture keywords never trigger findings', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/presentation/HeaderShell.kt', content:
      'import androidx.compose.runtime.Composable\n/**\n * Uses GlobalScope.launch and mutableStateOf in prose only.\n */\n// val ctx: Context, Retrofit.Builder() are mentioned in comments\n@Composable\nfun HeaderShell() {\n    val note = "GlobalScope.launch and Retrofit.Builder() are just text"\n}\n' },
  ]);
  assert.equal(ruleIds(insights).join(','), '');
});

// ---------------------------------------------------------------------------
// Swift/SwiftUI architecture findings
// ---------------------------------------------------------------------------

test('@ObservedObject with an initializer is flagged; @StateObject is not', () => {
  const insights = insightsFor([
    { path: 'Sources/ProfileView.swift', content:
      'import SwiftUI\nstruct ProfileView: View {\n    @ObservedObject var vm = ProfileModel()\n    @StateObject var owned = ProfileModel()\n    var body: some View { Text("x") }\n}\n' },
  ]);
  const hits = insights.filter((i) => i.ruleId === 'swiftui-observedobject-ownership');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
});

test('Non-private @State is a recommendation; @State private is accepted', () => {
  const insights = insightsFor([
    { path: 'Sources/FormView.swift', content:
      'import SwiftUI\nstruct FormView: View {\n    @State var name = ""\n    @State private var age = 0\n    var body: some View { Text(name) }\n}\n' },
  ]);
  const hits = insights.filter((i) => i.ruleId === 'swiftui-state-not-private');
  assert.equal(hits.length, 1);
  assert.equal(hits[0].line, 3);
  assert.equal(hits[0].severity, 'low');
  assert.equal(hits[0].kind, 'recommendation');
});

test('@ObservedObject passed in (no initializer) is not flagged', () => {
  const insights = insightsFor([
    { path: 'Sources/ChildView.swift', content:
      'import SwiftUI\nstruct ChildView: View {\n    @ObservedObject var vm: ChildModel\n    var body: some View { Text("x") }\n}\n' },
  ]);
  assert.equal(insights.some((i) => i.ruleId === 'swiftui-observedobject-ownership'), false);
});

// ---------------------------------------------------------------------------
// React architecture findings
// ---------------------------------------------------------------------------

test('Array index as a React key is flagged as a potential issue', () => {
  const insights = insightsFor([
    { path: 'src/TodoList.jsx', content:
      "import React from 'react';\nexport function TodoList({ todos }) {\n  return (\n    <ul>\n      {todos.map((todo, index) => (\n        <li key={index}>{todo.text}</li>\n      ))}\n    </ul>\n  );\n}\n" },
  ]);
  const hit = insights.find((i) => i.ruleId === 'react-array-index-key');
  assert.notEqual(hit, undefined);
  assert.equal(hit.kind, 'potential');
  assert.equal(hit.line, 6);
});

test('Stable keys and ordinary hooks (useState/useEffect/custom hooks) are never flagged', () => {
  const insights = insightsFor([
    { path: 'src/useThing.ts', content:
      "import { useState, useEffect } from 'react';\nexport function useThing(items: any[]) {\n  const [n, setN] = useState(0);\n  useEffect(() => { setN(items.length); }, [items]);\n  return n;\n}\n" },
    { path: 'src/Good.tsx', content:
      "import React from 'react';\nexport function Good({ items }: any) {\n  return items.map((item, index) => <li key={item.id}>{item.name}</li>);\n}\n" },
  ]);
  assert.equal(ruleIds(insights).join(','), '');
});

// ---------------------------------------------------------------------------
// Integration & cross-cutting
// ---------------------------------------------------------------------------

test('Identical filenames in different directories produce independent findings', () => {
  const insights = insightsFor([
    MANIFEST,
    { path: 'app/src/main/feature/a/Screen.kt', content:
      'import androidx.compose.runtime.Composable\n@Composable\nfun A(){ val x = mutableStateOf(0) }\nimport androidx.compose.runtime.mutableStateOf\n' },
    { path: 'app/src/main/feature/b/Screen.kt', content:
      'import androidx.compose.runtime.Composable\n// Screen.kt in b is clean\n@Composable\nfun B(){ }\n' },
  ]);
  const flagged = insights.filter((i) => i.ruleId === 'compose-state-without-remember').map((i) => i.path);
  assert.equal(flagged.includes('app/src/main/feature/a/Screen.kt'), true);
  assert.equal(flagged.includes('app/src/main/feature/b/Screen.kt'), false);
});

test('Insights flow into data.suggestions with evidence (path, line, ruleId, docUrl)', async () => {
  const data = await analyzeSyntheticFiles([
    MANIFEST,
    { path: 'app/src/main/presentation/HomeViewModel.kt', content:
      'import androidx.lifecycle.ViewModel\nimport kotlinx.coroutines.GlobalScope\nclass HomeViewModel : ViewModel() {\n    fun load() { GlobalScope.launch { fetch() } }\n}\n' },
  ]);
  assert.ok(Array.isArray(data.architectureInsights));
  const card = (data.suggestions || []).find((s) => s.ruleId === 'android-globalscope-usage');
  assert.notEqual(card, undefined);
  assert.equal(card.path, 'app/src/main/presentation/HomeViewModel.kt');
  assert.equal(typeof card.line, 'number');
  assert.ok(card.title.includes('Kotlin/Android'));
  assert.ok(/developer\.android\.com/.test(card.docUrl));
});

test('Existing non-architecture analysis is preserved (security still runs)', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'app/Exec.kt', content: 'fun run(c: String) {\n    Runtime.getRuntime().exec(c)\n}\n' },
  ]);
  assert.equal((data.securityIssues || []).some((i) => i.title === 'Command Execution'), true);
});

test('Architecture functions are present inside the shared analyzer block (browser/worker parity)', () => {
  const block = htmlSource.slice(parserStart, parserEnd);
  assert.ok(block.includes('function computeArchitectureInsights'));
  assert.ok(block.includes('detectArchitectureInsights:function'));
  assert.ok(block.includes('function maskJsLiterals'));
});
