// Phase A — Architecture analysis foundation.
// Verifies: evidence-based ecosystem detection for the three priority ecosystems
// (Kotlin/Android, Swift/SwiftUI, Flutter/Dart) plus React, Flutter-vs-plain-Dart
// disambiguation, and the shared rule/guide catalog data contract (integrity,
// accessors, and that every emitted insight ruleId has a catalog entry).
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(__dirname, '..', 'index.html'), 'utf8');
const s = '// ===== CODEFLOW_ANALYZER_START =====';
const e = '// ===== CODEFLOW_ANALYZER_END =====';
const a = html.indexOf(s);
const b = html.indexOf(e, a);
if (a < 0 || b < 0) throw new Error('analyzer block not found');
const ctx = { console, getSecurityScanContent: (f) => (f && f.content ? f.content : ''), isSanitizedPreviewRenderer: () => false };
vm.createContext(ctx);
vm.runInContext(html.slice(a, b) + '\nthis.Parser=Parser;', ctx);
const P = ctx.Parser;

const file = (path, content) => ({ path, name: path.split('/').pop(), content, isCode: true });

test('Flutter app is detected (flutter + dart) from a flutter SDK dependency', () => {
  const eco = P.detectProjectEcosystems([
    file('pubspec.yaml', 'name: app\ndependencies:\n  flutter:\n    sdk: flutter\n'),
    file('lib/main.dart', "import 'package:flutter/material.dart';\nvoid main(){}"),
  ]);
  assert.equal(eco.flutter, true);
  assert.equal(eco.dart, true);
  assert.equal(eco.android, false);
});

test('a package:flutter import alone marks Flutter', () => {
  const eco = P.detectProjectEcosystems([file('lib/x.dart', "import 'package:flutter/widgets.dart';")]);
  assert.equal(eco.flutter, true);
  assert.equal(eco.dart, true);
});

test('a plain Dart package is dart but NOT flutter', () => {
  const eco = P.detectProjectEcosystems([
    file('pubspec.yaml', 'name: mypkg\ndependencies:\n  http: ^1.0.0\n'),
    file('lib/calc.dart', 'int add(int a,int b)=>a+b;'),
  ]);
  assert.equal(eco.dart, true);
  assert.equal(eco.flutter, false);
});

test('a project with no Dart is neither dart nor flutter', () => {
  const eco = P.detectProjectEcosystems([file('src/App.kt', 'import androidx.compose.runtime.*')]);
  assert.equal(eco.dart, false);
  assert.equal(eco.flutter, false);
  assert.equal(eco.android, true);
});

test('existing ecosystems still detected (Kotlin/Android, SwiftUI, React)', () => {
  assert.equal(P.detectProjectEcosystems([file('AndroidManifest.xml', '<manifest/>')]).android, true);
  assert.equal(P.detectProjectEcosystems([file('V.swift', 'import SwiftUI\nstruct V: View {}')]).swiftui, true);
  assert.equal(P.detectProjectEcosystems([file('package.json', '{"dependencies":{"react":"^18"}}')]).react, true);
});

test('rule catalog: accessors return well-formed entries', () => {
  const r = P.getArchitectureRule('android-viewmodel-holds-ui-reference');
  assert.ok(r, 'rule missing');
  for (const field of ['ruleId', 'ecosystem', 'kind', 'severity', 'confidence', 'title', 'explanation', 'evidence', 'badExample', 'goodExample', 'exclusions', 'docUrl']) {
    assert.ok(r[field] !== undefined && r[field] !== '', 'missing field ' + field);
  }
  assert.ok(Array.isArray(r.exclusions));
  assert.match(r.docUrl, /^https:\/\/developer\.android\.com\//);
  assert.equal(P.getArchitectureRule('does-not-exist'), null);
});

test('learning topics: accessors, required fields and ecosystem filter', () => {
  const flutter = P.getLearningTopics('flutter');
  assert.ok(flutter.length >= 3, 'expected flutter topics');
  flutter.forEach((t) => {
    for (const field of ['topicId', 'title', 'ecosystem', 'roles', 'explanation', 'example', 'docUrl', 'relatedRuleIds']) {
      assert.ok(t[field] !== undefined, t.topicId + ' missing ' + field);
    }
    assert.equal(t.ecosystem, 'flutter');
    assert.match(t.docUrl, /^https:\/\//);
  });
  assert.equal(P.getLearningTopic('kotlin-mvvm-layers').ecosystem, 'kotlin');
  assert.equal(P.getLearningTopic('nope'), null);
  // Every ecosystem we target has at least one topic.
  ['kotlin', 'swift', 'flutter'].forEach((eco) =>
    assert.ok(P.getLearningTopics(eco).length > 0, 'no topics for ' + eco));
});

test('every emitted insight ruleId has a catalog entry, and insights carry docUrl/topicId', () => {
  // Build a tiny Compose project that triggers a known rule.
  const files = [
    file('AndroidManifest.xml', '<manifest/>'),
    file('ui/CounterScreen.kt',
      'import androidx.compose.runtime.*\n' +
      '@Composable fun CounterScreen(){\n  var n = mutableStateOf(0)\n}'),
  ];
  const insights = P.detectArchitectureInsights(files);
  assert.ok(insights.length >= 1, 'expected at least one insight');
  insights.forEach((ins) => {
    const rule = P.getArchitectureRule(ins.ruleId);
    assert.ok(rule, 'emitted ruleId not in catalog: ' + ins.ruleId);
    assert.ok(ins.docUrl, 'insight missing docUrl: ' + ins.ruleId);
    // topicId is present on the insight when the catalog links a learning topic.
    if (rule.learnTopicId) assert.equal(ins.topicId, rule.learnTopicId);
  });
});

test('catalog rule docUrls are all official documentation hosts', () => {
  const allowed = ['developer.android.com', 'developer.apple.com', 'react.dev', 'docs.flutter.dev', 'dart.dev'];
  const cat = ['android-globalscope-usage', 'android-viewmodel-holds-ui-reference', 'compose-state-without-remember',
    'android-ui-builds-data-layer', 'swiftui-observedobject-ownership', 'swiftui-state-not-private', 'react-array-index-key'];
  cat.forEach((id) => {
    const r = P.getArchitectureRule(id);
    assert.ok(r, id);
    assert.ok(allowed.some((host) => r.docUrl.includes(host)), id + ' has non-official docUrl ' + r.docUrl);
  });
});
