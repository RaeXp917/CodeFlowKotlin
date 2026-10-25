// Phase D — Swift/SwiftUI architecture intelligence. Positive + negative fixtures
// for construct recognition, improved/added rules (ObservedObject ownership,
// ObservableObject-in-State, ObservedObject-on-@Observable, @State visibility,
// blocking work in body, detached-task-captures-self), modern vs legacy
// Observation, concurrency guards, evidence accuracy, same-basename isolation,
// catalog wiring and no cross-language regressions.
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
const analyzerBlock = htmlSource.slice(htmlSource.indexOf('// ===== CODEFLOW_ANALYZER_START ====='), htmlSource.indexOf('// ===== CODEFLOW_ANALYZER_END ====='));
const context = {
  console, TreeSitter: undefined, Babel: undefined, acorn: undefined,
  getSecurityScanContent(file) { return file && file.content ? file.content : ''; },
  isSanitizedPreviewRenderer() { return false; },
};
vm.createContext(context);
vm.runInContext(`${analyzerBlock}\nthis.Parser = Parser; this.buildAnalysisData = buildAnalysisData;`, context);
const { Parser, buildAnalysisData } = context;

function insightsFor(fileDescs) {
  return Parser.detectArchitectureInsights(fileDescs.map((f) => ({
    path: f.path, name: basename(f.path), content: f.content, isCode: Parser.isCode(basename(f.path)),
  })));
}
const ruleIds = (ins) => Array.from(ins, (i) => i.ruleId).sort();
const idsForFile = (ins, p) => Array.from(ins.filter((i) => i.path === p), (i) => i.ruleId).sort();

// Model files that establish type conformance for project-level resolution.
const LEGACY = { path: 'Models/CounterModel.swift', content: 'import Combine\nfinal class CounterModel: ObservableObject { @Published var count = 0 }' };
const MODERN = { path: 'Models/NewModel.swift', content: 'import Observation\n@Observable final class NewModel { var count = 0 }' };

test('Swift construct recognition from source evidence', () => {
  const c = Parser.detectSwiftConstructs(`import SwiftUI
import Observation
@main struct MyApp: App { var body: some Scene { WindowGroup { ContentView() } } }
struct ContentView: View {
  @State private var n = 0
  @StateObject private var vm = CounterModel()
  @ObservedObject var injected: CounterModel
  @Environment(\\.dismiss) var dismiss
  @Bindable var model: NewModel
  var body: some View { Text("x") }
}
@Observable final class NewModel { var x = 0 }
final class CounterModel: ObservableObject { @Published var y = 0 }
actor DataStore { func load() async {} }
final class ApiService {}
final class ItemRepository {}
@Model final class Note {}
`);
  assert.ok(c.isSwiftUI && c.hasObservationImport);
  assert.ok(c.views.includes('ContentView'));
  assert.ok(c.apps.includes('MyApp'));
  assert.ok(c.observableObjects.includes('CounterModel'));
  assert.ok(c.observableMacroTypes.includes('NewModel'));
  assert.ok(c.actors.includes('DataStore'));
  assert.ok(c.services.includes('ApiService'));
  assert.ok(c.repositories.includes('ItemRepository'));
  assert.equal(c.wrappers.state, true);
  assert.equal(c.wrappers.stateObject, true);
  assert.equal(c.wrappers.bindable, true);
  assert.equal(c.wrappers.environment, true);
  assert.equal(c.swiftData, true);
});

test('Rule A: a View that constructs its own @ObservedObject is flagged', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @ObservedObject var model = CounterModel()\n  var body: some View { Text("x") }\n}' };
  const ins = insightsFor([LEGACY, view]).filter((i) => i.ruleId === 'swiftui-observedobject-ownership');
  assert.equal(ins.length, 1);
  assert.equal(ins[0].line, 3);
  assert.match(ins[0].code, /@ObservedObject var model = CounterModel\(\)/);
});

test('Rule A negatives: @StateObject ownership and injected @ObservedObject are not flagged', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @StateObject private var owned = CounterModel()\n  @ObservedObject var injected: CounterModel\n  var body: some View { Text("x") }\n}' };
  const ins = insightsFor([LEGACY, view]).filter((i) => i.ruleId === 'swiftui-observedobject-ownership');
  assert.equal(ins.length, 0);
});

test('Rule C: @ObservedObject on an @Observable type (not ObservableObject) is flagged', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @ObservedObject var model: NewModel\n  var body: some View { Text("x") }\n}' };
  const ins = insightsFor([MODERN, view]);
  assert.ok(ins.some((i) => i.ruleId === 'swiftui-observedobject-on-observable-type' && i.line === 3));
  // Must not ALSO be reported as plain ownership (A defers to C).
  assert.equal(ins.filter((i) => i.ruleId === 'swiftui-observedobject-ownership').length, 0);
});

test('Rule C negative: @ObservedObject on a real ObservableObject is not a mismatch', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @ObservedObject var model: CounterModel\n  var body: some View { Text("x") }\n}' };
  assert.equal(insightsFor([LEGACY, view]).filter((i) => i.ruleId === 'swiftui-observedobject-on-observable-type').length, 0);
});

test('Rule B: a legacy ObservableObject stored in @State is flagged; modern @Observable in @State is not', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @State var legacy = CounterModel()\n  @State var modern = NewModel()\n  var body: some View { Text("x") }\n}' };
  const ins = insightsFor([LEGACY, MODERN, view]);
  const b = ins.filter((i) => i.ruleId === 'swiftui-observableobject-in-state');
  assert.equal(b.length, 1);
  assert.equal(b[0].line, 3);
});

test('Rule B negative: a value type in @State is not flagged (only the visibility recommendation applies)', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @State var count = 0\n  var body: some View { Text("x") }\n}' };
  const ins = insightsFor([view]);
  assert.equal(ins.filter((i) => i.ruleId === 'swiftui-observableobject-in-state').length, 0);
  assert.ok(ins.some((i) => i.ruleId === 'swiftui-state-not-private'));
});

test('Rule D: non-private @State is a low recommendation; @State private is not flagged', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @State var a = 0\n  @State private var b = 0\n  var body: some View { Text("x") }\n}' };
  const d = insightsFor([view]).filter((i) => i.ruleId === 'swiftui-state-not-private');
  assert.equal(d.length, 1);
  assert.equal(d[0].line, 3);
  assert.equal(d[0].severity, 'low');
  assert.equal(d[0].kind, 'recommendation');
});

test('Rule E: blocking I/O inside body is flagged; the same call in .task is not', () => {
  const bad = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  let url: URL\n  var body: some View {\n    let d = try! Data(contentsOf: url)\n    return Text("x")\n  }\n}' };
  const e = insightsFor([bad]).filter((i) => i.ruleId === 'swiftui-blocking-work-in-body');
  assert.equal(e.length, 1);
  assert.equal(e[0].line, 5);

  const good = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  let url: URL\n  @State private var d: Data?\n  var body: some View { Text("x").task { d = try? Data(contentsOf: url) } }\n}' };
  assert.equal(insightsFor([good]).filter((i) => i.ruleId === 'swiftui-blocking-work-in-body').length, 0, '.task usage must not be flagged');
});

test('Rule F: Task.detached capturing self is flagged; structured Task and MainActor.run are not', () => {
  const bad = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @State private var items: [Int] = []\n  func load() { Task.detached { self.items = [1] } }\n  var body: some View { Text("x") }\n}' };
  const f = insightsFor([bad]).filter((i) => i.ruleId === 'swift-detached-task-captures-self');
  assert.equal(f.length, 1);
  assert.equal(f[0].line, 4);

  const good = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @State private var items: [Int] = []\n  func load() { Task { self.items = await fetch() } }\n  func other() { Task.detached { await doIndependentWork() } }\n  var body: some View { Text("x") }\n}' };
  assert.equal(insightsFor([good]).filter((i) => i.ruleId === 'swift-detached-task-captures-self').length, 0, 'structured Task and self-free detached are not flagged');
});

test('comments, doc comments and string literals never trigger Swift rules', () => {
  const view = { path: 'Views/V.swift', content: `import SwiftUI
struct V: View {
  /// @ObservedObject var model = CounterModel()  in a doc comment
  // @State var leak = 0
  let note = "Task.detached { self.x } and Data(contentsOf: url) in a string"
  var body: some View { Text(note) }
}` };
  const ids = ruleIds(insightsFor([LEGACY, view]).filter((i) => i.ecosystem === 'Swift/SwiftUI'));
  assert.deepEqual(ids, [], 'masked comments/strings must not match: ' + JSON.stringify(ids));
});

test('a plain Swift library (no import SwiftUI) is not analyzed by SwiftUI rules', () => {
  const lib = { path: 'Lib/Thing.swift', content: 'public struct Thing { public var value = 0 }\nfinal class CounterModel: ObservableObject { @Published var c = 0 }\nstruct Fake { @State var x = 0 }' };
  assert.deepEqual(ruleIds(insightsFor([lib])), []);
});

test('identical basenames in different directories stay independent', () => {
  const bad = 'import SwiftUI\nstruct V: View { @ObservedObject var m = CounterModel()\n var body: some View { Text("x") } }';
  const good = 'import SwiftUI\nstruct V: View { @StateObject var m = CounterModel()\n var body: some View { Text("x") } }';
  const ins = insightsFor([LEGACY, { path: 'a/V.swift', content: bad }, { path: 'b/V.swift', content: good }]);
  assert.ok(idsForFile(ins, 'a/V.swift').includes('swiftui-observedobject-ownership'));
  assert.equal(idsForFile(ins, 'b/V.swift').filter((r) => r === 'swiftui-observedobject-ownership').length, 0);
});

test('mixed legacy + modern models in one project resolve correctly', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @StateObject var legacy = CounterModel()\n  @State var modern = NewModel()\n  var body: some View { Text("x") }\n}' };
  // Correct usage of both systems → no ownership/mismatch findings.
  const ins = insightsFor([LEGACY, MODERN, view]);
  assert.equal(ins.filter((i) => ['swiftui-observedobject-ownership', 'swiftui-observableobject-in-state', 'swiftui-observedobject-on-observable-type'].includes(i.ruleId)).length, 0);
});

test('evidence (line + snippet + ecosystem + docUrl + topic) is accurate', () => {
  const view = { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View {\n  @State var model = CounterModel()\n  var body: some View { Text("x") }\n}' };
  const hit = insightsFor([LEGACY, view]).find((i) => i.ruleId === 'swiftui-observableobject-in-state');
  assert.equal(hit.line, 3);
  assert.match(hit.code, /CounterModel/);
  assert.equal(hit.ecosystem, 'Swift/SwiftUI');
  assert.ok(hit.docUrl && /developer\.apple\.com/.test(hit.docUrl));
  assert.equal(hit.topicId, 'swiftui-observation');
});

test('Swift rules do not fire on non-Swift languages', () => {
  const dart = { path: 'lib/x.dart', content: "import 'package:flutter/material.dart';\nclass S extends StatelessWidget {}" };
  assert.ok(insightsFor([dart]).every((i) => i.ecosystem !== 'Swift/SwiftUI'));
});

test('catalog + learning topics are wired for the new/updated Swift rules', () => {
  const map = {
    'swiftui-observableobject-in-state': 'swiftui-observation',
    'swiftui-observedobject-on-observable-type': 'swiftui-observation-migration',
    'swiftui-blocking-work-in-body': 'swiftui-view-lifecycle',
    'swift-detached-task-captures-self': 'swift-concurrency',
  };
  for (const [id, topic] of Object.entries(map)) {
    const rule = Parser.getArchitectureRule(id);
    assert.ok(rule, id + ' in catalog');
    assert.equal(rule.ecosystem, 'swift');
    assert.equal(rule.learnTopicId, topic);
    assert.ok(Parser.getLearningTopic(topic), topic + ' exists');
    assert.ok(rule.docUrl && /^https:\/\//.test(rule.docUrl) && rule.goodExample && rule.badExample);
  }
  const topics = Parser.getLearningTopics('swift').map((t) => t.topicId);
  ['swiftui-observation-migration', 'swiftui-view-lifecycle', 'swift-concurrency'].forEach((t) => assert.ok(topics.includes(t), t));
});

test('Phase D findings flow through buildAnalysisData', async () => {
  const files = [LEGACY, { path: 'Views/V.swift', content: 'import SwiftUI\nstruct V: View { @ObservedObject var m = CounterModel()\n var body: some View { Text("x") } }' }];
  const analyzed = files.map((f) => ({ path: f.path, name: basename(f.path), folder: 'x', content: f.content, functions: [], lines: f.content.split('\n').length, layer: Parser.detectLayer(f.path), churn: 0, isCode: true }));
  const data = await buildAnalysisData({ analyzed, allFns: [], excludePatterns: [], progress() {}, yieldFn: async () => {} });
  assert.ok(data.architectureInsights.some((i) => i.ruleId === 'swiftui-observedobject-ownership'));
});

test('the Swift Phase D analyzer lives in the shared browser/worker block', () => {
  assert.ok(analyzerBlock.includes('function detectSwiftConstructs'));
  assert.ok(analyzerBlock.includes('swiftui-observableobject-in-state'));
  assert.ok(analyzerBlock.includes('function collectSwiftTypeSets'));
});
