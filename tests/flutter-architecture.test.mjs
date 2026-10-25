// Phase B — Flutter/Dart architecture intelligence. Positive + negative fixtures
// for construct recognition, the three high-confidence rules (BuildContext across
// async gaps, missing dispose, widget builds data layer), false-positive guards
// (comments/strings, guarded context, proper dispose, passed-in fields, plain
// Dart, no-boundary), evidence accuracy, same-basename isolation, catalog wiring
// and no cross-language regressions. Shares the real analyzer from index.html.
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
const analyzerBlock = htmlSource.slice(parserStart, parserEnd);

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
// Array.from rebuilds the list in this realm so deepStrictEqual's prototype check
// passes (Parser returns arrays from the vm context).
const ruleIds = (ins) => Array.from(ins, (i) => i.ruleId).sort();

const UNSAFE = `
import 'package:flutter/material.dart';
class RecordScreen extends StatefulWidget { @override State<RecordScreen> createState() => _RecordScreenState(); }
class _RecordScreenState extends State<RecordScreen> {
  final _ctrl = TextEditingController();
  Future<void> _save() async {
    await Future<void>.delayed(const Duration(seconds: 1));
    Navigator.of(context).pop();
  }
  @override Widget build(BuildContext context) => Container();
}
`;
const SAFE = `
import 'package:flutter/material.dart';
class SafeScreen extends StatefulWidget { @override State<SafeScreen> createState() => _S(); }
class _S extends State<SafeScreen> {
  final _ctrl = TextEditingController();
  Future<void> _save() async {
    await Future<void>.delayed(const Duration(seconds: 1));
    if (!context.mounted) return;
    Navigator.of(context).pop();
  }
  @override void dispose() { _ctrl.dispose(); super.dispose(); }
  @override Widget build(BuildContext context) => Container();
}
`;

test('Flutter is detected from a package:flutter import; plain Dart is not Flutter', () => {
  const flutter = Parser.detectProjectEcosystems([{ path: 'lib/a.dart', name: 'a.dart', content: "import 'package:flutter/widgets.dart';", isCode: true }]);
  assert.equal(flutter.flutter, true);
  assert.equal(flutter.dart, true);
  const plain = Parser.detectProjectEcosystems([{ path: 'lib/calc.dart', name: 'calc.dart', content: 'class Calc { int add(int a, int b) => a + b; }', isCode: true }]);
  assert.equal(plain.dart, true);
  assert.equal(plain.flutter, false);
});

test('construct recognition: widgets, states, view-models, repositories, services', () => {
  const c = Parser.detectDartConstructs(`
import 'package:flutter/material.dart';
class HomePage extends StatelessWidget {}
class HomeState extends State<HomePage> {}
class HomeViewModel extends ChangeNotifier {}
class ItemRepository {}
class ApiService {}
`);
  assert.equal(c.isFlutter, true);
  assert.ok(c.widgets.includes('HomePage'));
  assert.ok(c.states.includes('HomeState'));
  assert.ok(c.viewModels.includes('HomeViewModel'));
  assert.ok(c.repositories.includes('ItemRepository'));
  assert.ok(c.services.includes('ApiService'));
  assert.equal(c.stateMgmt.changeNotifier, true);
});

test('state-management libraries are recognized (Provider / Riverpod / BLoC)', () => {
  assert.equal(Parser.detectDartConstructs("import 'package:provider/provider.dart';").stateMgmt.provider, true);
  assert.equal(Parser.detectDartConstructs("import 'package:flutter_riverpod/flutter_riverpod.dart';").stateMgmt.riverpod, true);
  assert.equal(Parser.detectDartConstructs("import 'package:flutter_bloc/flutter_bloc.dart';").stateMgmt.bloc, true);
});

test('unsafe BuildContext-after-await is flagged with accurate evidence', () => {
  const ins = insightsFor([{ path: 'lib/record_screen.dart', content: UNSAFE }]);
  const ctx = ins.find((i) => i.ruleId === 'flutter-buildcontext-across-async-gap');
  assert.ok(ctx, 'should flag the async-gap context use');
  assert.equal(ctx.line, 8, 'points at the Navigator.of(context) line');
  assert.match(ctx.code, /Navigator\.of\(context\)/);
  assert.equal(ctx.ecosystem, 'Flutter/Dart');
  assert.ok(ctx.docUrl && /use_build_context_synchronously/.test(ctx.docUrl));
  assert.equal(ctx.topicId, 'flutter-buildcontext');
});

test('guarded BuildContext + proper dispose produce NO findings', () => {
  const ins = insightsFor([{ path: 'lib/safe_screen.dart', content: SAFE }]);
  assert.deepEqual(ruleIds(ins), [], 'safe code must be clean: ' + JSON.stringify(ruleIds(ins)));
});

test('owned controllers without dispose() are flagged (high confidence)', () => {
  const ins = insightsFor([{ path: 'lib/s.dart', content: UNSAFE }]);
  const d = ins.filter((i) => i.ruleId === 'flutter-missing-dispose');
  assert.equal(d.length, 1, 'one owned controller, no dispose()');
  assert.equal(d[0].confidence, 'high');
  assert.match(d[0].code, /TextEditingController/);
});

test('dispose() that misses one owned field is flagged (medium), the released one is not', () => {
  const src = `
import 'package:flutter/material.dart';
class X extends StatefulWidget { @override State<X> createState() => _X(); }
class _X extends State<X> {
  final _a = TextEditingController();
  final _b = ScrollController();
  @override void dispose() { _a.dispose(); super.dispose(); }
  @override Widget build(BuildContext context) => Container();
}
`;
  const ins = insightsFor([{ path: 'lib/x.dart', content: src }]).filter((i) => i.ruleId === 'flutter-missing-dispose');
  assert.equal(ins.length, 1, 'only the un-disposed field is flagged');
  assert.equal(ins[0].confidence, 'medium');
  assert.match(ins[0].code, /ScrollController/);
});

test('a passed-in controller (not constructed) is not treated as owned', () => {
  const src = `
import 'package:flutter/material.dart';
class X extends StatefulWidget { @override State<X> createState() => _X(); }
class _X extends State<X> {
  final TextEditingController controller;
  _X(this.controller);
  @override Widget build(BuildContext context) => Container();
}
`;
  const ins = insightsFor([{ path: 'lib/x.dart', content: src }]).filter((i) => i.ruleId === 'flutter-missing-dispose');
  assert.equal(ins.length, 0, 'the class does not construct the controller, so it does not own it');
});

test('widget-builds-data-layer fires only when a repository boundary exists', () => {
  const widget = `
import 'package:flutter/material.dart';
class Screen extends StatelessWidget {
  @override Widget build(BuildContext context) { final d = Dio(); return Container(); }
}
`;
  // No boundary anywhere -> not flagged.
  const noBoundary = insightsFor([{ path: 'lib/screen.dart', content: widget }]).filter((i) => i.ruleId === 'flutter-widget-builds-data-layer');
  assert.equal(noBoundary.length, 0, 'no repository boundary => no finding');
  // With a repository boundary -> flagged.
  const withBoundary = insightsFor([
    { path: 'lib/screen.dart', content: widget },
    { path: 'lib/item_repository.dart', content: 'class ItemRepository { Future fetch() async => 1; }' },
  ]).filter((i) => i.ruleId === 'flutter-widget-builds-data-layer');
  assert.equal(withBoundary.length, 1);
  assert.match(withBoundary[0].code, /Dio\(\)/);
});

test('comments and string literals never trigger Dart rules', () => {
  const src = `
import 'package:flutter/material.dart';
class _X extends State<X> {
  // final _ctrl = TextEditingController();   <- commented out, owns nothing
  final note = 'await then Navigator.of(context).pop() inside a string';
  final doc = """
    AnimationController() mentioned in a doc string
  """;
  @override Widget build(BuildContext context) => Container();
}
`;
  const ins = insightsFor([{ path: 'lib/x.dart', content: src }]);
  assert.deepEqual(ruleIds(ins), [], 'masked comments/strings must not match: ' + JSON.stringify(ins));
});

test('a ChangeNotifier view-model is recognized but not falsely flagged', () => {
  const src = `
import 'package:flutter/material.dart';
class CounterViewModel extends ChangeNotifier {
  int count = 0;
  void increment() { count++; notifyListeners(); }
}
`;
  const ins = insightsFor([{ path: 'lib/counter_vm.dart', content: src }]);
  assert.deepEqual(ruleIds(ins), [], 'idiomatic ChangeNotifier must not warn');
});

test('identical basenames in different directories stay independent', () => {
  const ins = insightsFor([
    { path: 'lib/a/record_screen.dart', content: UNSAFE },
    { path: 'lib/b/record_screen.dart', content: SAFE },
  ]);
  const unsafeHits = ins.filter((i) => i.path === 'lib/a/record_screen.dart');
  const safeHits = ins.filter((i) => i.path === 'lib/b/record_screen.dart');
  assert.ok(unsafeHits.length >= 2, 'the unsafe file is flagged');
  assert.equal(safeHits.length, 0, 'the safe file with the same basename is not');
});

test('Dart rules do not fire on non-Dart languages (no cross-language regression)', () => {
  const kotlin = { path: 'app/MainActivity.kt', content: 'import androidx.appcompat.app.AppCompatActivity\nfun f(){ GlobalScope.launch { } }' };
  const ins = insightsFor([kotlin]);
  assert.ok(ins.every((i) => i.ecosystem !== 'Flutter/Dart'), 'no Flutter rules on Kotlin');
  // Existing Kotlin rule still works.
  assert.ok(ins.some((i) => i.ruleId === 'android-globalscope-usage'));
});

test('plain Dart (no Flutter) yields no Flutter findings', () => {
  const ins = insightsFor([{ path: 'lib/calc.dart', content: 'class Calc { Future<int> f() async { await g(); return 1; } }' }]);
  assert.deepEqual(ruleIds(ins), []);
});

test('the catalog + learning topics are wired for the Dart rules', () => {
  for (const id of ['flutter-buildcontext-across-async-gap', 'flutter-missing-dispose', 'flutter-widget-builds-data-layer']) {
    const rule = Parser.getArchitectureRule(id);
    assert.ok(rule, id + ' in catalog');
    assert.equal(rule.ecosystem, 'flutter');
    assert.ok(rule.docUrl && /^https:\/\//.test(rule.docUrl));
    assert.ok(rule.learnTopicId && Parser.getLearningTopic(rule.learnTopicId), id + ' links a learning topic');
    assert.ok(rule.goodExample && rule.badExample);
  }
  const topics = Parser.getLearningTopics('flutter').map((t) => t.topicId);
  assert.ok(topics.includes('flutter-buildcontext'));
});

test('architecture insights flow into buildAnalysisData output', async () => {
  const analyzed = [{ path: 'lib/record_screen.dart', name: 'record_screen.dart', folder: 'lib', content: UNSAFE, functions: [], lines: UNSAFE.split('\n').length, layer: Parser.detectLayer('lib/record_screen.dart'), churn: 0, isCode: true }];
  const data = await buildAnalysisData({ analyzed, allFns: [], excludePatterns: [], progress() {}, yieldFn: async () => {} });
  assert.ok(Array.isArray(data.architectureInsights));
  assert.ok(data.architectureInsights.some((i) => i.ruleId === 'flutter-missing-dispose'));
});

test('the Dart analyzer lives in the shared browser/worker analyzer block', () => {
  assert.ok(analyzerBlock.includes('function runDartArchitectureRules'), 'rules are in the shared block');
  assert.ok(analyzerBlock.includes('function maskDartLiterals'));
});
