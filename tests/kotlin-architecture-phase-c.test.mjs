// Phase C — advanced Kotlin/Android architecture intelligence. Positive + negative
// fixtures for construct recognition and the new rules (exposed mutable state,
// lifecycle-aware Flow collection, unstructured coroutine scope, hardcoded
// dispatcher), plus guards (private/asStateFlow, viewModelScope, injected
// dispatcher, multiline remember), evidence accuracy, mixed Kotlin/Java,
// same-basename isolation, catalog wiring and no cross-language regressions.
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
const analyzerBlock = htmlSource.slice(htmlSource.indexOf(startMarker), htmlSource.indexOf(endMarker));
const context = {
  console, TreeSitter: undefined, Babel: undefined, acorn: undefined,
  getSecurityScanContent(file) { return file && file.content ? file.content : ''; },
  isSanitizedPreviewRenderer() { return false; },
};
vm.createContext(context);
vm.runInContext(`${analyzerBlock}\nthis.Parser = Parser; this.buildAnalysisData = buildAnalysisData;`, context);
const { Parser, buildAnalysisData } = context;

// An androidx marker so the project is detected as Android (detection is project-level).
const ANDROID_MARKER = { path: 'app/MainActivity.kt', content: 'import androidx.appcompat.app.AppCompatActivity\nclass MainActivity : AppCompatActivity()' };

function insightsFor(fileDescs) {
  return Parser.detectArchitectureInsights(fileDescs.map((f) => ({
    path: f.path, name: basename(f.path), content: f.content, isCode: Parser.isCode(basename(f.path)),
  })));
}
const ruleIds = (ins) => Array.from(ins, (i) => i.ruleId).sort();
const withMarker = (files) => insightsFor([ANDROID_MARKER, ...files]);
const forFile = (ins, p) => ins.filter((i) => i.path === p);

test('Kotlin construct recognition from source evidence', () => {
  const c = Parser.detectKotlinConstructs(`
import androidx.lifecycle.ViewModel
import androidx.compose.runtime.Composable
import kotlinx.coroutines.flow.*
@HiltViewModel
class FeedViewModel : ViewModel() {
  private val _ui = MutableStateFlow(0)
  suspend fun refresh() {}
  fun go() { viewModelScope.launch { } }
}
class HomeActivity : AppCompatActivity()
class DetailFragment : Fragment()
interface ItemDao
class ItemRepository
class SyncService
@Composable fun Screen() {}
`);
  assert.ok(c.isAndroid);
  assert.ok(c.viewModels.includes('FeedViewModel'));
  assert.ok(c.activities.includes('HomeActivity'));
  assert.ok(c.fragments.includes('DetailFragment'));
  assert.ok(c.repositories.includes('ItemRepository'));
  assert.ok(c.services.includes('SyncService'));
  assert.ok(c.daos.includes('ItemDao'));
  assert.equal(c.composables, 1);
  assert.equal(c.flow.mutableStateFlow, true);
  assert.equal(c.di.hilt, true);
  assert.equal(c.suspendFns, 1);
  assert.equal(c.scopes.viewModelScope, true);
});

test('exposed mutable state is flagged; encapsulated state is not', () => {
  const bad = `import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.*
class VM : ViewModel() {
  val items = MutableStateFlow<List<String>>(emptyList())
  var live = MutableLiveData<Int>()
  private val _ok = MutableStateFlow(0)
  val ok: StateFlow<Int> = _ok.asStateFlow()
}`;
  const ins = withMarker([{ path: 'vm/VM.kt', content: bad }]).filter((i) => i.ruleId === 'android-viewmodel-exposed-mutable-state');
  const lines = Array.from(ins, (i) => i.line).sort((a, b) => a - b);
  assert.deepEqual(lines, [4, 5], 'only the two public mutable declarations');
  assert.ok(ins.every((i) => i.confidence === 'high' && i.kind === 'issue'));
});

test('a local MutableStateFlow inside a function is not treated as exposed state', () => {
  const src = `import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.*
class VM : ViewModel() {
  private val _ui = MutableStateFlow(0)
  val ui = _ui.asStateFlow()
  fun helper() {
    val temp = MutableStateFlow(1)
    temp.value = 2
  }
}`;
  const ins = withMarker([{ path: 'vm/VM.kt', content: src }]).filter((i) => i.ruleId === 'android-viewmodel-exposed-mutable-state');
  assert.equal(ins.length, 0, 'a function-local flow is not public ViewModel state');
});

test('collectAsState in a Composable is a low-severity recommendation; the lifecycle-aware form is not', () => {
  const bad = `import androidx.compose.runtime.*
@Composable fun S(vm: VM) { val x by vm.state.collectAsState() }`;
  const ins = withMarker([{ path: 'ui/S.kt', content: bad }]).filter((i) => i.ruleId === 'android-flow-collect-without-lifecycle');
  assert.equal(ins.length, 1);
  assert.equal(ins[0].severity, 'low');
  assert.equal(ins[0].kind, 'recommendation');

  const good = `import androidx.compose.runtime.*
import androidx.lifecycle.compose.collectAsStateWithLifecycle
@Composable fun S(vm: VM) { val x by vm.state.collectAsStateWithLifecycle() }`;
  assert.equal(withMarker([{ path: 'ui/S.kt', content: good }]).filter((i) => i.ruleId === 'android-flow-collect-without-lifecycle').length, 0);
});

test('collectAsState outside a Composable is not flagged', () => {
  const src = `import androidx.appcompat.app.AppCompatActivity
fun plain(vm: VM) { val x = vm.state.collectAsState() }`;
  assert.equal(withMarker([{ path: 'x/Plain.kt', content: src }]).filter((i) => i.ruleId === 'android-flow-collect-without-lifecycle').length, 0);
});

test('unstructured ad-hoc coroutine scope is flagged; managed scopes are not', () => {
  const bad = `import androidx.lifecycle.ViewModel
import kotlinx.coroutines.*
class VM : ViewModel() {
  fun a() { CoroutineScope(Dispatchers.IO).launch { } }
  fun b() { MainScope().launch { } }
  fun ok1() { viewModelScope.launch { } }
}`;
  const ins = withMarker([{ path: 'vm/VM.kt', content: bad }]).filter((i) => i.ruleId === 'android-unstructured-coroutine-scope');
  assert.equal(ins.length, 2, 'CoroutineScope(...).launch and MainScope().launch');
  assert.ok(ins.every((i) => i.confidence === 'medium' && i.kind === 'potential'));
});

test('rememberCoroutineScope / lifecycleScope are not flagged as unstructured', () => {
  const src = `import androidx.compose.runtime.*
@Composable fun S() { val scope = rememberCoroutineScope(); scope.launch { } }`;
  assert.equal(withMarker([{ path: 'ui/S.kt', content: src }]).filter((i) => i.ruleId === 'android-unstructured-coroutine-scope').length, 0);
});

test('existing GlobalScope rule still fires and is not duplicated by the new scope rule', () => {
  const src = `import androidx.lifecycle.ViewModel
import kotlinx.coroutines.*
class VM : ViewModel() { fun x() { GlobalScope.launch { } } }`;
  const ins = withMarker([{ path: 'vm/VM.kt', content: src }]);
  assert.ok(ins.some((i) => i.ruleId === 'android-globalscope-usage'));
  assert.equal(ins.filter((i) => i.ruleId === 'android-unstructured-coroutine-scope').length, 0, 'GlobalScope is not also flagged as ad-hoc scope');
});

test('hardcoded dispatcher usage in a repository is a recommendation; injected default is not', () => {
  const bad = `import kotlinx.coroutines.*
class ItemRepository(val dao: ItemDao) {
  suspend fun load() = withContext(Dispatchers.IO) { dao.all() }
}`;
  const ins = withMarker([{ path: 'data/ItemRepository.kt', content: bad }]).filter((i) => i.ruleId === 'android-hardcoded-dispatcher');
  assert.equal(ins.length, 1);
  assert.equal(ins[0].severity, 'low');
  assert.equal(ins[0].kind, 'recommendation');

  const good = `import kotlinx.coroutines.*
class ItemRepository(val dao: ItemDao, private val io: CoroutineDispatcher = Dispatchers.IO) {
  suspend fun load() = withContext(io) { dao.all() }
}`;
  assert.equal(withMarker([{ path: 'data/ItemRepository.kt', content: good }]).filter((i) => i.ruleId === 'android-hardcoded-dispatcher').length, 0, 'injected default dispatcher must not be flagged');
});

test('hardcoded dispatcher is not flagged outside the data layer (e.g. in a ViewModel)', () => {
  const src = `import androidx.lifecycle.ViewModel
import kotlinx.coroutines.*
class VM : ViewModel() { fun x() { viewModelScope.launch(Dispatchers.IO) { } } }`;
  assert.equal(withMarker([{ path: 'vm/VM.kt', content: src }]).filter((i) => i.ruleId === 'android-hardcoded-dispatcher').length, 0);
});

test('valid multiline remember and ViewModel-owned state are not flagged', () => {
  const src = `import androidx.compose.runtime.*
@Composable fun S() {
  var n by remember { mutableStateOf(0) }
  val saved by rememberSaveable(
    saver = IntSaver
  ) { mutableStateOf(1) }
}`;
  assert.equal(withMarker([{ path: 'ui/S.kt', content: src }]).filter((i) => i.ruleId === 'compose-state-without-remember').length, 0);
});

test('genuine unremembered Composable state is still flagged (preserved rule)', () => {
  const src = `import androidx.compose.runtime.*
@Composable fun S() { var n = mutableStateOf(0) }`;
  assert.ok(withMarker([{ path: 'ui/S.kt', content: src }]).some((i) => i.ruleId === 'compose-state-without-remember'));
});

test('comments, KDoc and string literals never trigger the new rules', () => {
  const src = `import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.*
/** val items = MutableStateFlow(0) in KDoc */
class VM : ViewModel() {
  // val items = MutableStateFlow(0)
  private val _ui = MutableStateFlow(0)
  val note = "CoroutineScope(Dispatchers.IO).launch { } inside a string"
}`;
  const ids = ruleIds(withMarker([{ path: 'vm/VM.kt', content: src }]).filter((i) => i.ecosystem === 'Kotlin/Android'));
  assert.deepEqual(ids, [], 'masked comments/strings must not match: ' + JSON.stringify(ids));
});

test('evidence (line + snippet) is accurate', () => {
  const src = `import androidx.lifecycle.ViewModel
import kotlinx.coroutines.flow.*
class VM : ViewModel() {
  val items = MutableStateFlow<List<String>>(emptyList())
}`;
  const hit = withMarker([{ path: 'vm/VM.kt', content: src }]).find((i) => i.ruleId === 'android-viewmodel-exposed-mutable-state');
  assert.equal(hit.line, 4);
  assert.match(hit.code, /MutableStateFlow/);
  assert.equal(hit.ecosystem, 'Kotlin/Android');
  assert.ok(hit.docUrl && /developer\.android\.com/.test(hit.docUrl));
  assert.equal(hit.topicId, 'android-ui-state');
});

test('mixed Kotlin/Java Android project: Java file is left to existing handling, Kotlin rules still apply', () => {
  const ins = withMarker([
    { path: 'data/Api.java', content: 'public interface Api { }' },
    { path: 'vm/VM.kt', content: 'import androidx.lifecycle.ViewModel\nimport kotlinx.coroutines.flow.*\nclass VM: ViewModel(){ val items = MutableStateFlow(0) }' },
  ]);
  assert.ok(ins.some((i) => i.ruleId === 'android-viewmodel-exposed-mutable-state' && i.path === 'vm/VM.kt'));
});

test('identical basenames in different directories stay independent', () => {
  const bad = 'import androidx.lifecycle.ViewModel\nimport kotlinx.coroutines.flow.*\nclass VM: ViewModel(){ val items = MutableStateFlow(0) }';
  const good = 'import androidx.lifecycle.ViewModel\nimport kotlinx.coroutines.flow.*\nclass VM: ViewModel(){ private val _i = MutableStateFlow(0)\n val i = _i.asStateFlow() }';
  const ins = withMarker([{ path: 'a/VM.kt', content: bad }, { path: 'b/VM.kt', content: good }]);
  assert.ok(forFile(ins, 'a/VM.kt').some((i) => i.ruleId === 'android-viewmodel-exposed-mutable-state'));
  assert.equal(forFile(ins, 'b/VM.kt').filter((i) => i.ruleId === 'android-viewmodel-exposed-mutable-state').length, 0);
});

test('new rules do not fire on non-Kotlin languages', () => {
  const dart = { path: 'lib/x.dart', content: "import 'package:flutter/material.dart';\nclass S extends StatelessWidget {}" };
  const ins = insightsFor([dart]);
  assert.ok(ins.every((i) => i.ecosystem !== 'Kotlin/Android'));
});

test('a non-Android Kotlin project is not analyzed by Android rules', () => {
  // No androidx anywhere -> not an Android project.
  const src = 'import kotlinx.coroutines.flow.*\nclass VM { val items = MutableStateFlow(0) }';
  assert.deepEqual(ruleIds(insightsFor([{ path: 'VM.kt', content: src }])), []);
});

test('catalog + learning topics are wired for the new rules', () => {
  const map = {
    'android-viewmodel-exposed-mutable-state': 'android-ui-state',
    'android-flow-collect-without-lifecycle': 'android-lifecycle-flow',
    'android-unstructured-coroutine-scope': 'kotlin-coroutine-scope',
    'android-hardcoded-dispatcher': 'kotlin-dispatcher-injection',
  };
  for (const [id, topic] of Object.entries(map)) {
    const rule = Parser.getArchitectureRule(id);
    assert.ok(rule, id + ' in catalog');
    assert.equal(rule.ecosystem, 'kotlin');
    assert.equal(rule.learnTopicId, topic);
    assert.ok(Parser.getLearningTopic(topic), topic + ' exists');
    assert.ok(rule.docUrl && /^https:\/\//.test(rule.docUrl) && rule.goodExample && rule.badExample);
  }
  const topics = Parser.getLearningTopics('kotlin').map((t) => t.topicId);
  assert.ok(topics.includes('android-ui-state') && topics.includes('android-lifecycle-flow') && topics.includes('kotlin-dispatcher-injection'));
});

test('Phase C findings flow through buildAnalysisData', async () => {
  const src = 'import androidx.lifecycle.ViewModel\nimport kotlinx.coroutines.flow.*\nclass VM: ViewModel(){ val items = MutableStateFlow(0) }';
  const files = [ANDROID_MARKER, { path: 'vm/VM.kt', content: src }];
  const analyzed = files.map((f) => ({ path: f.path, name: basename(f.path), folder: 'x', content: f.content, functions: [], lines: f.content.split('\n').length, layer: Parser.detectLayer(f.path), churn: 0, isCode: true }));
  const data = await buildAnalysisData({ analyzed, allFns: [], excludePatterns: [], progress() {}, yieldFn: async () => {} });
  assert.ok(data.architectureInsights.some((i) => i.ruleId === 'android-viewmodel-exposed-mutable-state'));
});

test('the Kotlin Phase C analyzer lives in the shared browser/worker block', () => {
  assert.ok(analyzerBlock.includes('android-viewmodel-exposed-mutable-state'));
  assert.ok(analyzerBlock.includes('function detectKotlinConstructs'));
  assert.ok(analyzerBlock.includes('function kotlinFunctionBodyRanges'));
});
