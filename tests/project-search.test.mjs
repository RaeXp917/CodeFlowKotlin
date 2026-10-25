// Stage 6 — project-search module: query matching (literal / case / whole-word /
// regex), glob filters, line numbering across CRLF/LF/Unicode, filename vs
// content results, exclusions, and limit/truncation reporting.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  makeMatcher, scanContent, splitLines, buildGlobMatcher, parseGlobList,
  globToRegExpSource, searchProjectRoot, SEARCH_LIMITS,
} from '../cli/project-search.mjs';
import { makeExcludeMatcher } from '../cli/server-utils.mjs';

test('literal matcher finds every occurrence with correct columns', () => {
  const m = makeMatcher({ query: 'vm', caseSensitive: true });
  const { matches } = scanContent('val vm = VM()\n// vm note', m);
  assert.equal(matches.length, 2);
  assert.deepEqual(matches[0], { line: 1, col: 4, length: 2, preview: 'val vm = VM()' });
  assert.equal(matches[1].line, 2);
  // Case-insensitive (default) also catches the uppercase VM on line 1.
  const ci = scanContent('val vm = VM()', makeMatcher({ query: 'vm' }));
  assert.equal(ci.matches.length, 2);
});

test('case sensitivity and whole-word matching are honoured', () => {
  assert.equal(scanContent('ViewModel viewmodel', makeMatcher({ query: 'viewmodel', caseSensitive: true })).matches.length, 1);
  assert.equal(scanContent('ViewModel viewmodel', makeMatcher({ query: 'viewmodel', caseSensitive: false })).matches.length, 2);
  // whole-word: "View" must not match inside "ViewModel".
  assert.equal(scanContent('View ViewModel', makeMatcher({ query: 'View', wholeWord: true })).matches.length, 1);
  assert.equal(scanContent('View ViewModel', makeMatcher({ query: 'View', wholeWord: false })).matches.length, 2);
});

test('regex mode works and invalid patterns error out', () => {
  const m = makeMatcher({ query: 'fun\\s+\\w+', regex: true });
  const { matches } = scanContent('fun load() {}\nval x = 1', m);
  assert.equal(matches.length, 1);
  assert.equal(matches[0].line, 1);
  assert.equal(makeMatcher({ query: '(', regex: true }).error, 'invalid-regex');
  assert.equal(makeMatcher({ query: '' }).error, 'empty-query');
  assert.equal(makeMatcher({ query: 'x'.repeat(SEARCH_LIMITS.maxQueryLen + 1) }).error, 'query-too-long');
});

test('a zero-width regex does not loop forever', () => {
  const m = makeMatcher({ query: 'x*', regex: true });
  const { matches } = scanContent('xx yy', m);
  assert.ok(matches.length >= 1 && matches.length <= SEARCH_LIMITS.maxMatchesPerFile);
});

test('line numbers are one-based across CRLF, LF and CR', () => {
  assert.deepEqual(splitLines('a\r\nb\nc\rd').length, 4);
  const { matches } = scanContent('a\r\nb\ntarget\r\nd', makeMatcher({ query: 'target' }));
  assert.equal(matches[0].line, 3);
});

test('Unicode content matches with correct line', () => {
  const { matches } = scanContent('// café\nval café = 1', makeMatcher({ query: 'café' }));
  assert.equal(matches.length, 2);
  assert.equal(matches[1].line, 2);
});

test('long lines are capped in the preview but still counted', () => {
  const long = 'x'.repeat(50) + 'needle' + 'y'.repeat(500);
  const { matches } = scanContent(long, makeMatcher({ query: 'needle' }));
  assert.equal(matches.length, 1);
  assert.ok(matches[0].preview.length <= SEARCH_LIMITS.previewMaxLen);
});

test('glob matcher: basename vs full-path, *, **, ?', () => {
  assert.equal(globToRegExpSource('*.kt'), '[^/]*\\.kt');
  const kt = buildGlobMatcher('*.kt', true);
  assert.equal(kt('a/b/C.kt'), true, 'no-slash pattern matches basename');
  assert.equal(kt('a/b/C.java'), false);
  const deep = buildGlobMatcher('src/**', true);
  assert.equal(deep('src/a/b.kt'), true);
  assert.equal(deep('other/a.kt'), false);
  const q = buildGlobMatcher('Main?.kt', true);
  assert.equal(q('MainA.kt'), true);
  assert.equal(q('Main.kt'), false);
  // Empty list: include matches all, exclude matches none.
  assert.equal(buildGlobMatcher('', true)('anything'), true);
  assert.equal(buildGlobMatcher('', false)('anything'), false);
  assert.deepEqual(parseGlobList('a, b\nc'), ['a', 'b', 'c']);
});

async function makeTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-search-'));
  await fs.mkdir(path.join(root, 'app', 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'generated'), { recursive: true });
  await fs.writeFile(path.join(root, 'app', 'src', 'ListScreen.kt'), 'class ListScreen {\n  val vm = ListViewModel()\n}');
  await fs.writeFile(path.join(root, 'app', 'src', 'ListViewModel.java'), 'class ListViewModel {}');
  await fs.writeFile(path.join(root, 'app', 'src', 'Widget.swift'), 'struct Widget { let vm = 1 }');
  await fs.writeFile(path.join(root, 'app', 'src', 'main.dart'), 'void main() { final vm = 0; }');
  await fs.writeFile(path.join(root, 'app', 'build.gradle.kts'), 'dependencies { implementation("x") }');
  await fs.writeFile(path.join(root, 'app', 'AndroidManifest.xml'), '<manifest package="com.vm" />');
  await fs.writeFile(path.join(root, 'generated', 'Gen.kt'), 'class ListViewModel {}');
  return root;
}

test('searchProjectRoot is code-only: Kotlin/Java/Swift/Dart/.kts yes, XML no', async () => {
  const root = await makeTree();
  const out = await searchProjectRoot(root, { query: 'ListViewModel' });
  const byPath = Object.fromEntries(out.results.map((r) => [r.path.replace(/\\/g, '/'), r]));
  assert.ok(byPath['app/src/ListScreen.kt'].matches.length >= 1);
  assert.ok(byPath['app/src/ListViewModel.java'].matches.length >= 1);
  // The .java file name also matches the query (filename result).
  assert.equal(byPath['app/src/ListViewModel.java'].fileMatch, true);
  const vm = await searchProjectRoot(root, { query: 'vm' });
  const vmPaths = vm.results.map((r) => r.path.replace(/\\/g, '/'));
  // Source files match.
  assert.ok(vmPaths.includes('app/src/main.dart'));
  assert.ok(vmPaths.includes('app/src/Widget.swift'));
  // The Gradle Kotlin script is code and remains searchable.
  const grad = await searchProjectRoot(root, { query: 'implementation' });
  assert.ok(grad.results.some((r) => r.path.replace(/\\/g, '/') === 'app/build.gradle.kts'));
  // AndroidManifest.xml is NOT source code and must never be searched.
  assert.ok(!vmPaths.includes('app/AndroidManifest.xml'), 'XML is not source code');
  const manifest = await searchProjectRoot(root, { query: 'manifest' });
  assert.ok(!manifest.results.some((r) => r.path.endsWith('.xml')), 'no .xml results in code-only search');
  await fs.rm(root, { recursive: true, force: true });
});

test('filename/path matches are distinguished and carry no fake line number', async () => {
  const root = await makeTree();
  const out = await searchProjectRoot(root, { query: 'ListScreen' });
  const hit = out.results.find((r) => r.path.replace(/\\/g, '/') === 'app/src/ListScreen.kt');
  assert.equal(hit.fileMatch, true);
  // Content of ListScreen.kt also contains "ListScreen" (the class), so it has matches too;
  // a pure path query that is not in content yields fileMatch with empty matches:
  const pathOnly = await searchProjectRoot(root, { query: 'app/src' });
  const any = pathOnly.results.find((r) => r.fileMatch && r.matches.length === 0);
  assert.ok(any, 'a path-only match must have fileMatch=true and no invented matches');
  await fs.rm(root, { recursive: true, force: true });
});

test('exclusions remove files from search entirely', async () => {
  const root = await makeTree();
  const out = await searchProjectRoot(root, { query: 'ListViewModel', isExcluded: makeExcludeMatcher(['generated']) });
  const paths = out.results.map((r) => r.path.replace(/\\/g, '/'));
  assert.ok(!paths.some((p) => p.startsWith('generated/')), 'excluded dir must not appear');
  assert.ok(paths.includes('app/src/ListViewModel.java'));
  await fs.rm(root, { recursive: true, force: true });
});

test('include/exclude temporary filters scope the search', async () => {
  const root = await makeTree();
  const onlyKt = await searchProjectRoot(root, { query: 'ListViewModel', include: '*.kt' });
  assert.ok(onlyKt.results.every((r) => r.path.endsWith('.kt')));
  const noGen = await searchProjectRoot(root, { query: 'ListViewModel', exclude: 'generated/**' });
  assert.ok(!noGen.results.some((r) => r.path.replace(/\\/g, '/').startsWith('generated/')));
  await fs.rm(root, { recursive: true, force: true });
});

test('same filename in different directories stays distinct', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-search-'));
  await fs.mkdir(path.join(root, 'a'), { recursive: true });
  await fs.mkdir(path.join(root, 'b'), { recursive: true });
  await fs.writeFile(path.join(root, 'a', 'App.kt'), 'class App // marker');
  await fs.writeFile(path.join(root, 'b', 'App.kt'), 'class App // marker');
  const out = await searchProjectRoot(root, { query: 'marker' });
  const paths = out.results.map((r) => r.path.replace(/\\/g, '/')).sort();
  assert.deepEqual(paths, ['a/App.kt', 'b/App.kt']);
  await fs.rm(root, { recursive: true, force: true });
});

test('match limits are enforced and reported, never silent', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-search-'));
  await fs.writeFile(path.join(root, 'many.kt'), Array(500).fill('x needle x').join('\n'));
  const out = await searchProjectRoot(root, { query: 'needle', limits: Object.assign({}, SEARCH_LIMITS, { maxMatchesPerFile: 10 }) });
  assert.equal(out.results[0].matches.length, 10);
  assert.ok(out.truncated);
  assert.ok(out.reasons.includes('matches-per-file'));
  await fs.rm(root, { recursive: true, force: true });
});

test('a superseded search can be aborted mid-scan', async () => {
  const root = await makeTree();
  const out = await searchProjectRoot(root, { query: 'vm', isAborted: () => true });
  assert.ok(out.truncated);
  assert.ok(out.reasons.includes('aborted'));
  assert.equal(out.results.length, 0);
  await fs.rm(root, { recursive: true, force: true });
});
