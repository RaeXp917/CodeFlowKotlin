import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { basename, dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { promisify } from 'node:util';
import vm from 'node:vm';

const execFileAsync = promisify(execFile);
const __dirname = fileURLToPath(new URL('.', import.meta.url));
const repoRoot = join(__dirname, '..');
const htmlSource = await readFile(join(repoRoot, 'index.html'), 'utf8');
const startMarker = '// ===== CODEFLOW_ANALYZER_START =====';
const endMarker = '// ===== CODEFLOW_ANALYZER_END =====';
const parserStart = htmlSource.indexOf(startMarker);
const parserEnd = htmlSource.indexOf(endMarker, parserStart);

if (parserStart < 0 || parserEnd < 0) {
  throw new Error('Could not locate analyzer source in index.html');
}

const context = {
  console,
  TreeSitter: undefined,
  Babel: undefined,
  acorn: undefined,
  getSecurityScanContent(file) {
    return file && file.content ? file.content : '';
  },
  isSanitizedPreviewRenderer() {
    return false;
  },
};

vm.createContext(context);
vm.runInContext(
  `${htmlSource.slice(parserStart, parserEnd)}\nthis.Parser = Parser; this.buildAnalysisData = buildAnalysisData;`,
  context
);

const { Parser, buildAnalysisData } = context;

async function analyzeSyntheticFiles(fileDescs) {
  const analyzed = [];
  const allFns = [];

  for (const file of fileDescs) {
    const path = file.path;
    const name = basename(path);
    const folder = path.includes('/') ? path.slice(0, path.lastIndexOf('/')) : 'root';
    const content = file.content;
    const layer = Parser.detectLayer(path);
    const actualIsCode = Parser.isCode(name) !== false && (!Parser.isScriptContainer(path) || Parser.hasEmbeddedCode(content, path));
    const functions = actualIsCode ? Parser.extract(content, path) : [];
    analyzed.push({
      path,
      name,
      folder,
      content,
      functions,
      lines: content ? content.split('\n').length : 0,
      layer,
      churn: 0,
      isCode: actualIsCode,
    });
    if (actualIsCode) {
      functions.forEach((fn) => allFns.push(Object.assign({}, fn, { folder, layer })));
    }
  }

  return buildAnalysisData({
    analyzed,
    allFns,
    excludePatterns: [],
    progress() {},
    yieldFn: async () => {},
  });
}

async function applyPatch(files, patch) {
  const dir = await mkdtemp(join(tmpdir(), 'codeflow-patch-'));
  try {
    await execFileAsync('git', ['init'], { cwd: dir });
    for (const file of files) {
      const full = join(dir, file.path);
      await mkdir(dirname(full), { recursive: true });
      await writeFile(full, file.content);
    }
    await writeFile(join(dir, 'change.patch'), patch);
    await execFileAsync('git', ['apply', '--check', 'change.patch'], { cwd: dir });
    await execFileAsync('git', ['apply', 'change.patch'], { cwd: dir });
    const applied = {};
    for (const file of files) {
      applied[file.path] = await readFile(join(dir, file.path), 'utf8');
    }
    return applied;
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
}

const simpleSource = [
  'function main() {',
  '  const x = 1;',
  '  console.log(x);',
  '  debugger;',
  '  return x;',
  '}',
  '',
].join('\n');

test('simple debug statements download as a repo-relative patch that git apply accepts', async () => {
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/app.js', content: simpleSource },
  ]);
  const patch = suggestions.filePatches['src/app.js'];
  assert.equal(suggestions.combinedPatch, patch);
  assert.match(patch, /^diff --git a\/src\/app\.js b\/src\/app\.js\n/);
  assert.match(patch, /^--- a\/src\/app\.js\n/m);
  assert.match(patch, /^\+\+\+ b\/src\/app\.js\n/m);
  assert.match(patch, /^@@ -1,6 \+1,4 @@\n/m);
  assert.equal(patch.includes('\r'), false);
  assert.equal(suggestions.sites.filter((site) => site.status === 'appliable').length, 2);
  suggestions.sites.forEach((site) => {
    assert.equal(site.transformId, 'remove-debug-statement');
    assert.equal(site.filePath, 'src/app.js');
    assert.match(site.patch, /^diff --git a\/src\/app\.js /);
  });

  const applied = await applyPatch([{ path: 'src/app.js', content: simpleSource }], patch);
  assert.equal(applied['src/app.js'], 'function main() {\n  const x = 1;\n  return x;\n}\n');

  const again = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/app.js', content: simpleSource },
  ]);
  assert.equal(again.combinedPatch, patch);
});

test('risky debug statements stay report-only and are left out of the patch', async () => {
  const source = [
    'function f(cond) {',
    '  if (cond) console.log(cond);',
    '  console.log("safe");',
    '  const g = () => console.log(1);',
    '  debugger;',
    '  return console.log(cond);',
    '}',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/risky.js', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));

  assert.equal(byLine[2].status, 'report-only');
  assert.equal(byLine[2].reason, 'inside a one-line if without braces');
  assert.equal(byLine[2].patch, undefined);
  assert.equal(byLine[4].status, 'report-only');
  assert.equal(byLine[4].reason, 'inside a one-line arrow without braces');
  assert.equal(byLine[6].status, 'report-only');
  assert.equal(byLine[6].reason, 'part of an expression');
  assert.equal(byLine[3].status, 'appliable');
  assert.equal(byLine[5].status, 'appliable');

  const removed = suggestions.combinedPatch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  assert.deepEqual(removed, ['-  console.log("safe");', '-  debugger;']);

  const applied = await applyPatch([{ path: 'src/risky.js', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/risky.js'], /if \(cond\) console\.log\(cond\);/);
  assert.match(applied['src/risky.js'], /const g = \(\) => console\.log\(1\);/);
  assert.match(applied['src/risky.js'], /return console\.log\(cond\);/);
  assert.doesNotMatch(applied['src/risky.js'], /console\.log\("safe"\)/);
  assert.doesNotMatch(applied['src/risky.js'], /^\s*debugger;/m);
});

test('a combined patch applies every safe statement and skips other languages', async () => {
  const files = [
    { path: 'src/a.js', content: 'console.log(1);\nkeep();\n' },
    { path: 'src/b.ts', content: 'debugger;\nkeep();\n' },
    { path: 'notes.py', content: 'console.log(1)\nconsole.log(2)\nconsole.log(3)\nconsole.log(4)\n' },
  ];
  const suggestions = Parser.collectRemoveDebugStatementSuggestions(files);
  const python = suggestions.sites.find((site) => site.filePath === 'notes.py');
  assert.equal(python.status, 'report-only');
  assert.equal(python.reason, 'unsupported language');
  assert.equal(suggestions.filePatches['notes.py'], undefined);
  assert.match(suggestions.combinedPatch, /a\/src\/a\.js/);
  assert.match(suggestions.combinedPatch, /a\/src\/b\.ts/);
  assert.doesNotMatch(suggestions.combinedPatch, /notes\.py/);

  const applied = await applyPatch(files.slice(0, 2), suggestions.combinedPatch);
  assert.equal(applied['src/a.js'], 'keep();\n');
  assert.equal(applied['src/b.ts'], 'keep();\n');
});

test('existing debug-statement analysis and export fields stay unchanged', async () => {
  const data = await analyzeSyntheticFiles([
    { path: 'server/telemetry.ts', content: 'console.log(1);\nconsole.log(2);\nconsole.log(3);\nconsole.log(4);\n' },
    { path: 'app/widget.ts', content: 'var f=new Function("return 1;");\n' },
    { path: 'lib/db-query.ts', content: 'function findUser(id){ return db.query(`SELECT * FROM users WHERE id = ${id}`); }\n' },
  ]);
  const debugIssue = data.securityIssues.find((issue) => issue.title === 'Debug Statements');
  assert.equal(debugIssue.severity, 'info');
  assert.equal(debugIssue.path, 'server/telemetry.ts');
  assert.equal(debugIssue.desc, '4 console statements found. Remove before production.');
  assert.equal(debugIssue.code, '');
  assert.equal(debugIssue.line, undefined);
  assert.deepEqual(Object.keys(debugIssue).sort(), ['code', 'desc', 'file', 'path', 'severity', 'title']);
  assert.deepEqual(Array.from(data.securityIssues, (issue) => issue.severity), ['high', 'medium', 'info']);

  const exportedDebug = Parser.formatSecurityIssueExport(debugIssue, data.refactorSuggestions);
  assert.equal(exportedDebug.severity, debugIssue.severity);
  assert.equal(exportedDebug.title, debugIssue.title);
  assert.equal(exportedDebug.description, debugIssue.desc);
  assert.equal(exportedDebug.file, debugIssue.file);
  assert.equal(exportedDebug.path, debugIssue.path);
  assert.equal(exportedDebug.line, debugIssue.line);
  assert.equal(exportedDebug.code, debugIssue.code);
  assert.equal(exportedDebug.patch, data.refactorSuggestions.filePatches['server/telemetry.ts']);

  const other = data.securityIssues.find((issue) => issue.title !== 'Debug Statements');
  const exportedOther = Parser.formatSecurityIssueExport(other, data.refactorSuggestions);
  assert.equal(Object.prototype.hasOwnProperty.call(exportedOther, 'patch'), false);
  assert.deepEqual(Object.keys(exportedOther).sort(), ['code', 'description', 'file', 'line', 'path', 'severity', 'title']);

  const applied = await applyPatch(
    [{ path: 'server/telemetry.ts', content: 'console.log(1);\nconsole.log(2);\nconsole.log(3);\nconsole.log(4);\n' }],
    exportedDebug.patch
  );
  assert.equal(applied['server/telemetry.ts'], '');
});

test('shared-line debug statements are report-only and do not change the finding', async () => {
  const content = 'console.log(1);console.log(2);console.log(3);console.log(4);\n';
  const data = await analyzeSyntheticFiles([{ path: 'app/widget.ts', content }]);
  const issue = data.securityIssues.find((entry) => entry.title === 'Debug Statements');
  assert.equal(issue.severity, 'low');
  assert.equal(issue.desc, '4 console statements found. Remove before production.');
  assert.equal(data.refactorSuggestions.filePatches['app/widget.ts'], undefined);
  assert.equal(data.refactorSuggestions.combinedPatch, '');
  assert.ok(data.refactorSuggestions.sites.every((site) => site.status === 'report-only'));
  assert.ok(data.refactorSuggestions.sites.every((site) => site.reason === 'sharing a line with other code'));
  const exported = Parser.formatSecurityIssueExport(issue, data.refactorSuggestions);
  assert.equal(Object.prototype.hasOwnProperty.call(exported, 'patch'), false);
});

test('for await sole body stays report-only and is left out of the patch', async () => {
  const source = [
    'async function run(xs) {',
    '  console.log("safe");',
    '  for await (const item of xs)',
    '    console.log(item);',
    '  for await (const item of xs) console.debug(item);',
    '  for await (const item of xs)',
    '    debugger;',
    '  for await (const item of xs) {',
    '    console.info(item);',
    '  }',
    '  return xs;',
    '}',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/async.js', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));

  assert.equal(byLine[2].status, 'appliable');
  assert.equal(byLine[4].status, 'report-only');
  assert.equal(byLine[4].reason, 'inside a one-line loop without braces');
  assert.equal(byLine[4].patch, undefined);
  assert.equal(byLine[5].status, 'report-only');
  assert.equal(byLine[5].reason, 'inside a one-line loop without braces');
  assert.equal(byLine[7].status, 'report-only');
  assert.equal(byLine[7].reason, 'inside a one-line loop without braces');
  assert.equal(byLine[9].status, 'appliable');

  const removed = suggestions.combinedPatch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  assert.deepEqual(removed, ['-  console.log("safe");', '-    console.info(item);']);

  const applied = await applyPatch([{ path: 'src/async.js', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/async.js'], /for await \(const item of xs\)\n    console\.log\(item\);/);
  assert.match(applied['src/async.js'], /for await \(const item of xs\) console\.debug\(item\);/);
  assert.match(applied['src/async.js'], /for await \(const item of xs\)\n    debugger;/);
  assert.doesNotMatch(applied['src/async.js'], /console\.log\("safe"\)/);
  assert.doesNotMatch(applied['src/async.js'], /console\.info\(item\)/);
});

test('shadowed console bindings stay report-only while the global console can be removed', async () => {
  const source = [
    'import consoleLogger, { write as consoleWrite, type Ignored } from "./logger";',
    'import * as audit from "./audit";',
    'function save(console) {',
    '  console.log(record);',
    '}',
    'function auditRecord(record) {',
    '  const console = audit;',
    '  console.info(record);',
    '  console.log(record);',
    '}',
    'const wrapped = (console) => {',
    '  console.debug(console);',
    '};',
    'function take(record) {',
    '  console.log(record);',
    '  try {',
    '    risky();',
    '  } catch (console) {',
    '    console.log(console);',
    '  }',
    '  for (const console of rows) {',
    '    console.log(console);',
    '  }',
    '  logger.console.log(record);',
    '  return record;',
    '}',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/shadow.js', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));

  assert.equal(byLine[4].status, 'report-only');
  assert.equal(byLine[4].reason, 'shadowed by a local console binding');
  assert.equal(byLine[4].patch, undefined);
  assert.equal(byLine[8].status, 'report-only');
  assert.equal(byLine[8].reason, 'shadowed by a local console binding');
  assert.equal(byLine[9].status, 'report-only');
  assert.equal(byLine[12].status, 'report-only');
  assert.equal(byLine[12].reason, 'shadowed by a local console binding');
  assert.equal(byLine[15].status, 'appliable');
  assert.equal(byLine[19].status, 'report-only');
  assert.equal(byLine[19].reason, 'shadowed by a local console binding');
  assert.equal(byLine[22].status, 'report-only');
  assert.equal(byLine[22].reason, 'shadowed by a local console binding');
  assert.equal(byLine[24].status, 'report-only');
  assert.equal(byLine[24].reason, 'not the global console');

  const removed = suggestions.combinedPatch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  assert.deepEqual(removed, ['-  console.log(record);']);

  const applied = await applyPatch([{ path: 'src/shadow.js', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/shadow.js'], /function save\(console\) \{\n  console\.log\(record\);/);
  assert.match(applied['src/shadow.js'], /console\.info\(record\);/);
  assert.match(applied['src/shadow.js'], /logger\.console\.log\(record\);/);
  assert.doesNotMatch(applied['src/shadow.js'], /function take\(record\) \{\n  console\.log\(record\);/);
});

test('a console parameter on a class method is report-only and a sibling call stays appliable', async () => {
  const source = [
    'class Foo extends Bar {',
    '  run() {',
    '    console.log(1);',
    '  }',
    '  save(console) {',
    '    console.log(record);',
    '  }',
    '}',
    'console.log(2);',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/types.ts', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));
  assert.equal(byLine[3].status, 'appliable');
  assert.equal(byLine[6].status, 'report-only');
  assert.equal(byLine[6].reason, 'shadowed by a local console binding');
  assert.equal(byLine[6].patch, undefined);
  assert.equal(byLine[9].status, 'appliable');

  const exported = [
    'export default class console {',
    '  run() {',
    '    console.log(3);',
    '  }',
    '}',
    'console.log(4);',
    '',
  ].join('\n');
  const exportedSuggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/default.ts', content: exported },
  ]);
  const exportedByLine = Object.fromEntries(exportedSuggestions.sites.map((site) => [site.line, site]));
  assert.equal(exportedSuggestions.combinedPatch, '');
  assert.equal(exportedByLine[3].status, 'report-only');
  assert.equal(exportedByLine[3].reason, 'shadowed by a local console binding');
  assert.equal(exportedByLine[6].status, 'report-only');
  assert.equal(exportedByLine[6].reason, 'shadowed by a local console binding');

  const applied = await applyPatch([{ path: 'src/types.ts', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/types.ts'], /save\(console\) \{\n    console\.log\(record\);/);
  assert.doesNotMatch(applied['src/types.ts'], /console\.log\(1\)/);
  assert.doesNotMatch(applied['src/types.ts'], /console\.log\(2\)/);
});

test('imported and declared console bindings are not removed', () => {
  const cases = [
    ['import console from "./logger";\nconsole.log(record);\n', 'shadowed by a local console binding'],
    ['import { console } from "./logger";\nconsole.log(record);\n', 'shadowed by a local console binding'],
    ['import { log as console } from "./logger";\nconsole.log(record);\n', 'shadowed by a local console binding'],
    ['import * as console from "./logger";\nconsole.log(record);\n', 'shadowed by a local console binding'],
    ['const console = logger;\nconsole.log(record);\n', 'shadowed by a local console binding'],
    ['let console = logger;\nconsole.debug(record);\n', 'shadowed by a local console binding'],
    ['var console = logger;\nconsole.info(record);\n', 'shadowed by a local console binding'],
    ['function console() { return 1; }\nconsole.log(record);\n', 'shadowed by a local console binding'],
    ['class console { run() { console.log(record); } }\n', 'shadowed by a local console binding'],
  ];
  for (const [content, reason] of cases) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/local.js', content },
    ]);
    assert.equal(suggestions.combinedPatch, '', content);
    assert.ok(suggestions.sites.length >= 1, content);
    assert.ok(suggestions.sites.every((site) => site.status === 'report-only' && site.reason === reason), content);
  }
});

test('CRLF and mixed line endings survive in a patch git apply accepts', async () => {
  const crlf = 'function main() {\r\n  const x = 1;\r\n  console.log(x);\r\n  debugger;\r\n  return x;\r\n}\r\n';
  const mixed = 'keepA();\r\nconsole.log(1);\nkeepB();\r\n';
  const noFinalNewline = 'console.log(1);\r\nkeep();';
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/crlf.js', content: crlf },
    { path: 'src/mixed.js', content: mixed },
    { path: 'src/nonew.js', content: noFinalNewline },
  ]);

  const crlfPatch = suggestions.filePatches['src/crlf.js'];
  const crlfBody = crlfPatch.split('\n').filter((line) => line.startsWith(' ') || (line.startsWith('-') && !line.startsWith('---')));
  assert.deepEqual(
    crlfBody.filter((line) => line.startsWith('-')),
    ['-  console.log(x);\r', '-  debugger;\r']
  );
  assert.ok(crlfBody.every((line) => line.endsWith('\r')));

  const mixedBody = suggestions.filePatches['src/mixed.js'].split('\n');
  assert.deepEqual(
    mixedBody.filter((line) => line.startsWith('-') && !line.startsWith('---')),
    ['-console.log(1);']
  );
  assert.ok(mixedBody.includes(' keepA();\r'));
  assert.ok(mixedBody.includes(' keepB();\r'));

  const applied = await applyPatch(
    [
      { path: 'src/crlf.js', content: crlf },
      { path: 'src/mixed.js', content: mixed },
      { path: 'src/nonew.js', content: noFinalNewline },
    ],
    suggestions.combinedPatch
  );
  assert.equal(applied['src/crlf.js'], 'function main() {\r\n  const x = 1;\r\n  return x;\r\n}\r\n');
  assert.equal(applied['src/mixed.js'], 'keepA();\r\nkeepB();\r\n');
  assert.equal(applied['src/nonew.js'], 'keep();');

  const oneSite = suggestions.sites.find((site) => site.filePath === 'src/crlf.js' && site.kind === 'console.log');
  const appliedSite = await applyPatch([{ path: 'src/crlf.js', content: crlf }], oneSite.patch);
  assert.equal(appliedSite['src/crlf.js'], 'function main() {\r\n  const x = 1;\r\n  debugger;\r\n  return x;\r\n}\r\n');
});

test('a bare CR line ending stays report-only because git apply cannot match it', () => {
  const source = 'console.log(1);\rkeep();\r';
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/cr.js', content: source },
  ]);
  assert.equal(suggestions.combinedPatch, '');
  assert.equal(suggestions.filePatches['src/cr.js'], undefined);
  assert.equal(suggestions.sites.length, 1);
  assert.equal(suggestions.sites[0].status, 'report-only');
  assert.equal(suggestions.sites[0].reason, 'using line endings git apply cannot match');
  assert.equal(suggestions.sites[0].patch, undefined);
});

test('TypeScript namespace, module, and enum named console stay report-only', async () => {
  const cases = [
    'namespace console {\n  export function log(x) { return x; }\n}\nconsole.log(record);\n',
    'export namespace console {\n  export function log(x) { return x; }\n}\nconsole.log(record);\n',
    'declare namespace console {\n  export function log(x): void;\n}\nconsole.log(record);\n',
    'module console {\n  export function log(x) { return x; }\n}\nconsole.log(record);\n',
    'export module console {\n  export function log(x) { return x; }\n}\nconsole.log(record);\n',
    'enum console {\n  log = 1\n}\nconsole.log(record);\n',
    'export enum console {\n  log = 1\n}\nconsole.log(record);\n',
    'const enum console {\n  log = 1\n}\nconsole.log(record);\n',
    'export const enum console {\n  log = 1\n}\nconsole.debug(record);\n',
    'declare enum console {\n  log = 1\n}\nconsole.info(record);\n',
    'declare const enum console {\n  log = 1\n}\nconsole.log(record);\n',
    'namespace console.Inner {\n  export const ready = true;\n}\nconsole.log(record);\n',
    'namespace console {\n  export function log(x) { return x; }\n  console.log(record);\n}\n',
  ];
  for (const content of cases) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/ns.ts', content },
    ]);
    assert.equal(suggestions.combinedPatch, '', content);
    assert.ok(suggestions.sites.length >= 1, content);
    assert.ok(
      suggestions.sites.every((site) => site.status === 'report-only' && site.reason === 'shadowed by a local console binding'),
      content + '\n' + JSON.stringify(suggestions.sites.map((site) => [site.line, site.status, site.reason]))
    );
  }

  const source = [
    'namespace Other {',
    '  export function run() {',
    '    console.log(1);',
    '  }',
    '}',
    'namespace App {',
    '  export namespace console {',
    '    export function log(x) { return x; }',
    '  }',
    '  console.log(record);',
    '}',
    'console.log(2);',
    'namespace Foo.console {',
    '  export function log(x) { return x; }',
    '  console.debug(x);',
    '}',
    'enum Color { red = 1 }',
    'console.info(Color.red);',
    'declare namespace Lib {',
    '  export function ready(): void;',
    '}',
    'console.log(3);',
    'module.exports = App;',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/ns.ts', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));
  assert.equal(byLine[3].status, 'appliable');
  assert.equal(byLine[10].status, 'report-only');
  assert.equal(byLine[10].reason, 'shadowed by a local console binding');
  assert.equal(byLine[10].patch, undefined);
  assert.equal(byLine[12].status, 'appliable');
  assert.equal(byLine[15].status, 'report-only');
  assert.equal(byLine[15].reason, 'shadowed by a local console binding');
  assert.equal(byLine[18].status, 'appliable');
  assert.equal(byLine[22].status, 'appliable');

  const applied = await applyPatch([{ path: 'src/ns.ts', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/ns.ts'], /export namespace console \{\n    export function log\(x\) \{ return x; \}\n  \}\n  console\.log\(record\);/);
  assert.match(applied['src/ns.ts'], /console\.debug\(x\);/);
  assert.doesNotMatch(applied['src/ns.ts'], /console\.log\(1\)/);
  assert.doesNotMatch(applied['src/ns.ts'], /console\.log\(2\)/);
  assert.doesNotMatch(applied['src/ns.ts'], /console\.info\(Color\.red\)/);
  assert.doesNotMatch(applied['src/ns.ts'], /console\.log\(3\)/);
});

test('tagged templates and other expression continuations stay report-only', async () => {
  const source = [
    'function tag(strings) { return strings.raw.join(""); }',
    'console.log("safe");',
    'console.log("x")',
    '`tag`',
    'console.log(',
    '  "multi"',
    ')',
    '`also ${name}`',
    'console.log("y") // still a tag',
    '`after-comment`',
    'console.log("z");',
    '`separate`',
    'console.debug("kept")',
    'keep();',
    'debugger',
    '`not-a-tag`',
    'console.info("typed")',
    'as string',
    'console.info("checked")',
    'satisfies Logger',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/continue.ts', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));

  assert.equal(byLine[2].status, 'appliable');
  assert.equal(byLine[3].status, 'report-only');
  assert.equal(byLine[3].reason, 'part of an expression');
  assert.equal(byLine[3].patch, undefined);
  assert.equal(byLine[5].status, 'report-only');
  assert.equal(byLine[5].reason, 'part of an expression');
  assert.equal(byLine[9].status, 'report-only');
  assert.equal(byLine[9].reason, 'part of an expression');
  assert.equal(byLine[11].status, 'report-only');
  assert.equal(byLine[11].reason, 'separating statements that would join');
  assert.equal(byLine[11].patch, undefined);
  assert.equal(byLine[13].status, 'appliable');
  assert.equal(byLine[15].status, 'appliable');
  assert.equal(byLine[15].kind, 'debugger');
  assert.equal(byLine[17].status, 'report-only');
  assert.equal(byLine[17].reason, 'part of an expression');
  assert.equal(byLine[19].status, 'report-only');
  assert.equal(byLine[19].reason, 'part of an expression');

  const removed = suggestions.combinedPatch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  assert.deepEqual(removed, [
    '-console.log("safe");',
    '-console.debug("kept")',
    '-debugger',
  ]);

  const applied = await applyPatch([{ path: 'src/continue.ts', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/continue.ts'], /console\.log\("x"\)\n`tag`/);
  assert.match(applied['src/continue.ts'], /console\.log\(\n  "multi"\n\)\n`also \$\{name\}`/);
  assert.match(applied['src/continue.ts'], /console\.log\("y"\) \/\/ still a tag\n`after-comment`/);
  assert.match(applied['src/continue.ts'], /console\.info\("typed"\)\nas string/);
  assert.match(applied['src/continue.ts'], /console\.info\("checked"\)\nsatisfies Logger/);
  assert.doesNotMatch(applied['src/continue.ts'], /console\.log\("safe"\)/);
  assert.match(applied['src/continue.ts'], /`after-comment`\nconsole\.log\("z"\);\n`separate`/);
  assert.doesNotMatch(applied['src/continue.ts'], /console\.debug\("kept"\)/);
  assert.doesNotMatch(applied['src/continue.ts'], /^debugger$/m);
  assert.match(applied['src/continue.ts'], /^`not-a-tag`$/m);
});

test('escaped console bindings stay report-only', async () => {
  const shadowed = [
    'const \\u0063onsole = audit;\nconsole.log(record);\n',
    'const \\u{63}onsole = audit;\nconsole.log(record);\n',
    'const conso\\u006ce = audit;\nconsole.log(record);\n',
    'import \\u0063onsole from "./logger";\nconsole.log(record);\n',
    'function \\u0063onsole() { return 1; }\nconsole.log(record);\n',
    'class \\u0063onsole { static log(x) { return x; } }\nconsole.log(record);\n',
    'try {\n  risky();\n} catch (\\u0063onsole) {\n  console.log(record);\n}\n',
    'const { \\u0063onsole } = audit;\nconsole.log(record);\n',
    'const { log: \\u0063onsole } = audit;\nconsole.log(record);\n',
    'const [\\u0063onsole] = rows;\nconsole.log(record);\n',
    'function save(\\u0063onsole) {\n  console.log(record);\n}\n',
    'const \\u0063onsole = audit;\n\\u0063onsole.log(record);\n',
    'console.\\u006cog(record);\nconst \\u0063onsole = audit;\n',
  ];
  for (const content of shadowed) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/escape.js', content },
    ]);
    assert.equal(suggestions.combinedPatch, '', content);
    assert.ok(suggestions.sites.length >= 1, content);
    assert.ok(
      suggestions.sites.every((site) => site.status === 'report-only' && site.reason === 'shadowed by a local console binding'),
      content + '\n' + JSON.stringify(suggestions.sites.map((site) => [site.line, site.status, site.reason]))
    );
  }

  const unsafe = [
    '\\u0063onst x = 1;\nconsole.log(record);\n',
    'const \\u002b = 1;\nconsole.log(record);\n',
    'const good\\ = 1;\nconsole.log(record);\n',
  ];
  for (const content of unsafe) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/escape.js', content },
    ]);
    assert.equal(suggestions.combinedPatch, '', content);
    assert.ok(suggestions.sites.length >= 1, content);
    assert.ok(
      suggestions.sites.every((site) => site.status === 'report-only' && site.reason === 'in a file with an escaped identifier'),
      content + '\n' + JSON.stringify(suggestions.sites.map((site) => [site.line, site.status, site.reason]))
    );
  }

  const stillGlobal = [
    'const label = "\\u0063onsole";\nconsole.log(label);\n',
    'const label = `\\u0063onsole`;\nconsole.log(label);\n',
    '// const \\u0063onsole = audit\nconsole.log(record);\n',
    'const re = /\\u0063onsole/;\nconsole.log(re);\n',
    'const caf\\u00e9 = 1;\nconsole.log(caf\\u00e9);\n',
    '\\u0063onsole.log(record);\nkeep();\n',
  ];
  for (const content of stillGlobal) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/escape.js', content },
    ]);
    assert.ok(suggestions.sites.some((site) => site.status === 'appliable'), content);
    assert.equal(
      suggestions.sites.filter((site) => site.kind === 'console.log').every((site) => site.status === 'appliable'),
      true,
      content
    );
  }

  const scoped = [
    '{',
    '  const \\u0063onsole = audit;',
    '  console.log(record);',
    '}',
    'console.log(1);',
    'function save(\\u0063onsole) {',
    '  console.debug(record);',
    '}',
    'console.info(2);',
    '',
  ].join('\n');
  const scopedSuggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/escape.js', content: scoped },
  ]);
  const byLine = Object.fromEntries(scopedSuggestions.sites.map((site) => [site.line, site]));
  assert.equal(byLine[3].status, 'report-only');
  assert.equal(byLine[3].reason, 'shadowed by a local console binding');
  assert.equal(byLine[3].patch, undefined);
  assert.equal(byLine[5].status, 'appliable');
  assert.equal(byLine[7].status, 'report-only');
  assert.equal(byLine[7].reason, 'shadowed by a local console binding');
  assert.equal(byLine[9].status, 'appliable');

  const withSource = [
    'with ({ console: audit }) {',
    '  console.log(record);',
    '  function inner() {',
    '    console.debug(record);',
    '  }',
    '}',
    'console.info(1);',
    '',
  ].join('\n');
  const withSuggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/with.js', content: withSource },
  ]);
  const withByLine = Object.fromEntries(withSuggestions.sites.map((site) => [site.line, site]));
  assert.equal(withByLine[2].status, 'report-only');
  assert.equal(withByLine[2].reason, 'shadowed by a local console binding');
  assert.equal(withByLine[2].patch, undefined);
  assert.equal(withByLine[4].status, 'report-only');
  assert.equal(withByLine[4].reason, 'shadowed by a local console binding');
  assert.equal(withByLine[7].status, 'appliable');

  const moduleBindings = [
    ['export default function console(x) { return x; }\nconsole.log(record);\n', 'src/fn.js'],
    ['export default class console {\n  static log(x) { return x; }\n}\nconsole.log(record);\n', 'src/cls.ts'],
    ['export default function* console() { yield 1; }\nconsole.log(record);\n', 'src/gen.js'],
  ];
  for (const [content, path] of moduleBindings) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([{ path, content }]);
    assert.equal(suggestions.combinedPatch, '', content);
    assert.ok(
      suggestions.sites.every((site) => site.status === 'report-only' && site.reason === 'shadowed by a local console binding'),
      content + '\n' + JSON.stringify(suggestions.sites.map((site) => [site.line, site.status, site.reason]))
    );
  }

  const notConsole = [
    'export default function notConsole() { return 1; }\nconsole.log(5);\n',
    'export default class NotConsole {}\nconsole.log(6);\n',
  ];
  for (const content of notConsole) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/other.ts', content },
    ]);
    assert.equal(suggestions.sites.length, 1, content);
    assert.equal(suggestions.sites[0].status, 'appliable', content);
  }

  const applied = await applyPatch(
    [
      { path: 'src/escape.js', content: scoped },
      { path: 'src/with.js', content: withSource },
      { path: 'src/other.ts', content: notConsole[0] },
    ],
    scopedSuggestions.combinedPatch + withSuggestions.combinedPatch + Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/other.ts', content: notConsole[0] },
    ]).combinedPatch
  );
  assert.match(applied['src/escape.js'], /const \\u0063onsole = audit;\n  console\.log\(record\);/);
  assert.doesNotMatch(applied['src/escape.js'], /console\.log\(1\)/);
  assert.match(applied['src/escape.js'], /console\.debug\(record\);/);
  assert.doesNotMatch(applied['src/escape.js'], /console\.info\(2\)/);
  assert.match(applied['src/with.js'], /with \(\{ console: audit \}\) \{\n  console\.log\(record\);/);
  assert.match(applied['src/with.js'], /console\.debug\(record\);/);
  assert.doesNotMatch(applied['src/with.js'], /console\.info\(1\)/);
  assert.doesNotMatch(applied['src/other.ts'], /console\.log\(5\)/);
});

function lineOf(source, exact) {
  const idx = source.split('\n').findIndex((line) => line === exact);
  if (idx < 0) throw new Error('missing line: ' + exact);
  return idx + 1;
}

test('trailing comments and directive comments stay report-only', async () => {
  const source = [
    'function run(x) {',
    '  console.log(x);',
    '  console.log(x); // @ts-ignore',
    '  const broken: number = "no";',
    '  console.debug(x); // eslint-disable-next-line no-console',
    '  debugger; // @ts-expect-error',
    '  console.info(x); // prettier-ignore',
    '  console.log(x); // biome-ignore lint: debug',
    '  console.log(x); // istanbul ignore next',
    '  console.log(x); /* eslint-disable-next-line */',
    '  // @ts-ignore',
    '  console.log(x);',
    '  /* eslint-disable-next-line no-console */',
    '  console.debug(x);',
    '  /* c8 ignore next */',
    '  console.info(x);',
    '  // @ts-nocheck',
    '  console.log(x);',
    '  // note only',
    '  console.log(x);',
    '  // @ts-ignore',
    '',
    '  console.log(x);',
    '  console.log(',
    '    x // value',
    '  );',
    '  console.log(',
    '    // @ts-nocheck',
    '    x',
    '  );',
    '  console.log(x);',
    '  // @ts-ignore',
    '  keep(x);',
    '  return x;',
    '}',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/directives.ts', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));
  const at = (exact) => byLine[lineOf(source, exact)];

  assert.equal(at('  console.log(x);').status, 'appliable');
  assert.equal(at('  console.log(x); // @ts-ignore').status, 'report-only');
  assert.equal(at('  console.log(x); // @ts-ignore').reason, 'carrying a trailing comment');
  assert.equal(at('  console.log(x); // @ts-ignore').patch, undefined);
  assert.equal(at('  console.debug(x); // eslint-disable-next-line no-console').reason, 'carrying a trailing comment');
  assert.equal(at('  debugger; // @ts-expect-error').reason, 'carrying a trailing comment');
  assert.equal(at('  console.info(x); // prettier-ignore').reason, 'carrying a trailing comment');
  assert.equal(at('  console.log(x); // biome-ignore lint: debug').reason, 'carrying a trailing comment');
  assert.equal(at('  console.log(x); // istanbul ignore next').reason, 'carrying a trailing comment');
  assert.equal(at('  console.log(x); /* eslint-disable-next-line */').status, 'report-only');
  assert.equal(at('  console.log(x); /* eslint-disable-next-line */').patch, undefined);

  const preceded = source.split('\n');
  const ignoreNext = preceded.findIndex((line, index) => line === '  console.log(x);' && preceded[index - 1] === '  // @ts-ignore');
  assert.equal(byLine[ignoreNext + 1].status, 'report-only');
  assert.equal(byLine[ignoreNext + 1].reason, 'governed by a directive comment');
  assert.equal(byLine[ignoreNext + 1].patch, undefined);
  const eslintNext = preceded.findIndex((line, index) => line === '  console.debug(x);' && preceded[index - 1] === '  /* eslint-disable-next-line no-console */');
  assert.equal(byLine[eslintNext + 1].reason, 'governed by a directive comment');
  const c8Next = preceded.findIndex((line, index) => line === '  console.info(x);' && preceded[index - 1] === '  /* c8 ignore next */');
  assert.equal(byLine[c8Next + 1].reason, 'governed by a directive comment');

  const nocheck = preceded.findIndex((line, index) => line === '  console.log(x);' && preceded[index - 1] === '  // @ts-nocheck');
  assert.equal(byLine[nocheck + 1].status, 'appliable');
  const note = preceded.findIndex((line, index) => line === '  console.log(x);' && preceded[index - 1] === '  // note only');
  assert.equal(byLine[note + 1].status, 'appliable');
  const blank = preceded.findIndex((line, index) => line === '  console.log(x);' && preceded[index - 1] === '' && preceded[index - 2] === '  // @ts-ignore');
  assert.equal(byLine[blank + 1].status, 'appliable');
  assert.equal(at('  console.log(').status, 'appliable');
  assert.equal(byLine[lineOf(source, '    // @ts-nocheck')], undefined);
  const nocheckCall = preceded.findIndex((line, index) => line === '  console.log(' && preceded[index + 1] === '    // @ts-nocheck');
  assert.equal(byLine[nocheckCall + 1].status, 'report-only');
  assert.equal(byLine[nocheckCall + 1].reason, 'governed by a directive comment');

  const removed = suggestions.combinedPatch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  assert.ok(removed.some((line) => line === '-  console.log(x);'));
  assert.ok(!removed.some((line) => line.includes('@ts-ignore')));
  assert.ok(!removed.some((line) => line.includes('eslint-disable')));
  assert.ok(!removed.some((line) => line.includes('@ts-nocheck')));
  assert.ok(!removed.some((line) => line.includes('debugger;')));

  const applied = await applyPatch([{ path: 'src/directives.ts', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/directives.ts'], /console\.log\(x\); \/\/ @ts-ignore/);
  assert.match(applied['src/directives.ts'], /eslint-disable-next-line no-console/);
  assert.match(applied['src/directives.ts'], /debugger; \/\/ @ts-expect-error/);
  assert.match(applied['src/directives.ts'], /\/\* c8 ignore next \*\//);
  assert.match(applied['src/directives.ts'], /console\.log\(\n {4}\/\/ @ts-nocheck\n {4}x\n {2}\);/);
  assert.doesNotMatch(applied['src/directives.ts'], /\/\/ note only\n {2}console\.log\(x\);/);
  assert.match(applied['src/directives.ts'], /\/\/ @ts-ignore\n {2}keep\(x\);/);
});

test('direct eval and other dynamic scope injection stay report-only', async () => {
  const source = [
    'function sloppy(record) {',
    '  eval("var console = audit");',
    '  console.log(record);',
    '}',
    'function clean(record) {',
    '  console.log(record);',
    '}',
    'function parent(record) {',
    '  eval("var console = audit");',
    '  function child() {',
    '    console.debug(record);',
    '  }',
    '  const arrow = () => console.info(record);',
    '}',
    'function paren(record) {',
    '  (eval)("var console = audit");',
    '  console.info(record);',
    '}',
    'function wrapped(record) {',
    '  ((eval))("var console = audit");',
    '  console.log(record);',
    '}',
    'function arrowHost(record) {',
    '  console.log(record);',
    '  const run = () => {',
    '    eval("var console = audit");',
    '    console.debug(record);',
    '  };',
    '}',
    'function strictFn(record) {',
    '  "use strict";',
    '  eval("var console = audit");',
    '  console.log(record);',
    '}',
    'function notDirective(record) {',
    '  ;',
    '  "use strict";',
    '  eval("var console = audit");',
    '  console.info(record);',
    '}',
    'function defaults(record, value = eval("var console = audit")) {',
    '  console.log(record);',
    '}',
    'function header(record) {',
    '  for (eval("var console = audit"); false; ) {}',
    '  console.debug(record);',
    '}',
    'class Box {',
    '  run(record) {',
    '    eval("var console = audit");',
    '    console.log(record);',
    '  }',
    '  static {',
    '    eval("var console = audit");',
    '    console.debug(record);',
    '  }',
    '}',
    'console.log("top");',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/eval.js', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));
  const at = (exact) => byLine[lineOf(source, exact)];

  assert.equal(at('  console.log(record);').status, 'report-only');
  assert.equal(at('  console.log(record);').reason, 'in a scope where direct eval may shadow console');
  assert.equal(at('  console.log(record);').patch, undefined);
  assert.equal(at('  console.log(record);').filePath, 'src/eval.js');
  const lines = source.split('\n');
  const clean = lines.findIndex((line, index) => line === '  console.log(record);' && lines[index - 1] === 'function clean(record) {');
  assert.equal(byLine[clean + 1].status, 'appliable');
  const childLine = lines.findIndex((line, index) => line === '    console.debug(record);' && lines[index - 2] === '  eval("var console = audit");');
  assert.equal(byLine[childLine + 1].status, 'report-only');
  assert.equal(byLine[childLine + 1].reason, 'in a scope where direct eval may shadow console');
  const arrowSees = lines.findIndex((line) => line === '  const arrow = () => console.info(record);');
  assert.equal(byLine[arrowSees + 1].status, 'report-only');
  assert.equal(byLine[arrowSees + 1].reason, 'in a scope where direct eval may shadow console');
  assert.equal(byLine[arrowSees + 1].patch, undefined);
  const parenLine = lines.findIndex((line, index) => line === '  console.info(record);' && lines[index - 2] === 'function paren(record) {');
  assert.equal(byLine[parenLine + 1].reason, 'in a scope where direct eval may shadow console');
  const wrappedLine = lines.findIndex((line, index) => line === '  console.log(record);' && lines[index - 2] === 'function wrapped(record) {');
  assert.equal(byLine[wrappedLine + 1].reason, 'in a scope where direct eval may shadow console');
  const arrowHost = lines.findIndex((line, index) => line === '  console.log(record);' && lines[index - 1] === 'function arrowHost(record) {');
  assert.equal(byLine[arrowHost + 1].status, 'appliable');
  const arrowInnerLine = lines.findIndex((line, index) => line === '    console.debug(record);' && lines[index - 1] === '    eval("var console = audit");');
  assert.equal(byLine[arrowInnerLine + 1].reason, 'in a scope where direct eval may shadow console');
  const strictLine = lines.findIndex((line, index) => line === '  console.log(record);' && lines[index - 2] === '  "use strict";');
  assert.equal(byLine[strictLine + 1].status, 'appliable');
  const notDirective = lines.findIndex((line, index) => line === '  console.info(record);' && lines[index - 4] === 'function notDirective(record) {');
  assert.equal(byLine[notDirective + 1].reason, 'in a scope where direct eval may shadow console');
  const defaultsLine = lines.findIndex((line, index) => line === '  console.log(record);' && lines[index - 1].startsWith('function defaults'));
  assert.equal(byLine[defaultsLine + 1].reason, 'in a scope where direct eval may shadow console');
  const headerLine = lines.findIndex((line, index) => line === '  console.debug(record);' && lines[index - 1].startsWith('  for (eval'));
  assert.equal(byLine[headerLine + 1].reason, 'in a scope where direct eval may shadow console');
  const classLine = lines.findIndex((line, index) => line === '    console.log(record);' && lines[index - 2] === '  run(record) {');
  assert.equal(byLine[classLine + 1].status, 'appliable');
  const staticLine = lines.findIndex((line, index) => line === '    console.debug(record);' && lines[index - 2] === '  static {');
  assert.equal(byLine[staticLine + 1].status, 'appliable');
  assert.equal(at('console.log("top");').status, 'appliable');

  const removed = suggestions.combinedPatch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  assert.ok(removed.some((line) => line === '-  console.log(record);'));
  assert.ok(!removed.some((line) => line.includes('eval(')));
  const applied = await applyPatch([{ path: 'src/eval.js', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/eval.js'], /function sloppy\(record\) \{\n {2}eval\("var console = audit"\);\n {2}console\.log\(record\);/);
  assert.doesNotMatch(applied['src/eval.js'], /function clean\(record\) \{\n {2}console\.log\(record\);/);
  assert.doesNotMatch(applied['src/eval.js'], /console\.log\("top"\)/);

  const dynamic = [
    'function f(record) {\n  eval?.("var console = audit");\n  console.log(record);\n}\nconsole.log(1);\n',
    'function f(record) {\n  (0, eval)("var console = audit");\n  console.log(record);\n}\nconsole.log(1);\n',
    'function f(record) {\n  ((0, eval))("var console = audit");\n  console.log(record);\n}\nconsole.log(1);\n',
    'function f(record) {\n  window.eval("var console = audit");\n  console.log(record);\n}\nconsole.log(1);\n',
    'function f(record) {\n  (window.eval)("var console = audit");\n  console.log(record);\n}\nconsole.log(1);\n',
    'function f(record) {\n  eval.call(null, "var console = audit");\n  console.log(record);\n}\nconsole.log(1);\n',
    'function f(record) {\n  new Function("console = audit");\n  console.log(record);\n}\nconsole.log(1);\n',
    'function f(record) {\n  Function("console = audit");\n  console.log(record);\n}\nconsole.log(1);\n',
    'function f(record) {\n  \\u0065val("var console = audit");\n  console.log(record);\n}\n',
  ];
  for (const content of dynamic) {
    const result = Parser.collectRemoveDebugStatementSuggestions([{ path: 'src/dynamic.js', content }]);
    assert.equal(result.combinedPatch, '', content);
    assert.ok(result.sites.length >= 1, content);
    const escaped = content.includes('\\u0065val');
    assert.ok(result.sites.every((site) => site.status === 'report-only' && site.reason === (escaped
      ? 'in a scope where direct eval may shadow console'
      : 'in a file where dynamic code may shadow console')), content + '\n' + JSON.stringify(result.sites.map((site) => [site.line, site.reason])));
  }

  const stillGlobal = [
    ['"use strict";\neval("var console = audit");\nconsole.log(record);\n', 'src/strict.js'],
    ['export function f(record) {\n  eval("var console = audit");\n  console.log(record);\n}\n', 'src/mod.js'],
    ['eval("var console = audit");\nconsole.log(record);\n', 'src/app.mjs'],
    ['// eval("var console = audit")\nconsole.log(record);\n', 'src/note.js'],
    ['const s = "eval(\'var console = audit\')";\nconsole.log(s);\n', 'src/string.js'],
    ['import("x");\nfunction f(record) {\n  console.log(record);\n}\n', 'src/dyn-import.js'],
  ];
  for (const [content, path] of stillGlobal) {
    const result = Parser.collectRemoveDebugStatementSuggestions([{ path, content }]);
    assert.ok(result.sites.some((site) => site.status === 'appliable'), content + '\n' + JSON.stringify(result.sites.map((site) => [site.line, site.status, site.reason])));
  }

  const topSloppy = 'eval("var console = audit");\nconsole.log(record);\nfunction later() {\n  console.debug(record);\n}\n';
  const top = Parser.collectRemoveDebugStatementSuggestions([{ path: 'src/top.js', content: topSloppy }]);
  assert.equal(top.combinedPatch, '');
  assert.ok(top.sites.every((site) => site.status === 'report-only' && site.reason === 'in a scope where direct eval may shadow console'));
});

test('deleting a statement must not join the surrounding lines', async () => {
  const source = [
    'function calls() {',
    '  foo();',
    '  console.log("debug");',
    '  (bar)();',
    '  foo()',
    '  console.log("debug");',
    '  (bar)();',
    '  foo()',
    '  debugger;',
    '  (bar)();',
    '  foo()',
    '  console.log(1);',
    '  console.debug(2);',
    '  (bar)();',
    '  foo();',
    '  console.log(1);',
    '  console.debug(2);',
    '  (bar)();',
    '  value',
    '  console.log(1);',
    '  [0].join();',
    '  tag',
    '  console.log(1);',
    '  `tmpl`;',
    '  expr',
    '  console.info(1);',
    '  /re/g;',
    '  left',
    '  console.log(1);',
    '  +right;',
    '  left',
    '  console.log(1);',
    '  -right;',
    '  left',
    '  console.log(1);',
    '  *right;',
    '  left',
    '  console.log(1);',
    '  / right;',
    '  left',
    '  console.log(1);',
    '  % right;',
    '  left',
    '  console.log(1);',
    '  , right;',
    '  obj',
    '  console.log(1);',
    '  .method();',
    '  obj',
    '  console.log(1);',
    '  ?.method();',
    '  cond',
    '  console.log(1);',
    '  ? yes : no;',
    '  item',
    '  console.log(1);',
    '  in bag;',
    '  item',
    '  console.log(1);',
    '  instanceof Bag;',
    '  typed',
    '  console.log(1);',
    '  as string;',
    '  checked',
    '  console.log(1);',
    '  satisfies Logger;',
    '  name',
    '  console.log(1);',
    '  = value;',
    '  name',
    '  console.log(1);',
    '  += value;',
    '  bits',
    '  console.log(1);',
    '  & mask;',
    '  bits',
    '  console.log(1);',
    '  | mask;',
    '  bits',
    '  console.log(1);',
    '  < limit;',
    '  x = { a: 1 }',
    '  console.log(1);',
    '  (0);',
    '  let Ctor = class { }',
    '  console.log(1);',
    '  (0);',
    '  foo()',
    '  console.log(1);',
    '  ++bar;',
    '  foo()',
    '  console.log(1);',
    '  !bar;',
    '}',
    'class Decl {',
    '  m() { return 1; }',
    '}',
    'console.log("after-class");',
    '(bar)();',
    'function block() {',
    '  console.log("first");',
    '  (bar)();',
    '  ready();',
    '  console.log("later");',
    '  (bar)();',
    '}',
    'function nested() {',
    '  class Inner<T> { }',
    '  console.log("after-generic");',
    '  (bar)();',
    '}',
    '',
  ].join('\n');
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/asi.js', content: source },
  ]);
  const byLine = Object.fromEntries(suggestions.sites.map((site) => [site.line, site]));
  const at = (exact) => {
    const line = lineOf(source, exact);
    const site = byLine[line];
    if (!site) throw new Error('no site for ' + JSON.stringify(exact));
    return site;
  };

  assert.equal(at('  console.log("debug");').status, 'appliable');
  const joined = source.split('\n');
  const unsafeLog = joined.findIndex((line, index) => line === '  console.log("debug");' && joined[index - 1] === '  foo()');
  assert.equal(byLine[unsafeLog + 1].status, 'report-only');
  assert.equal(byLine[unsafeLog + 1].reason, 'separating statements that would join');
  assert.equal(byLine[unsafeLog + 1].patch, undefined);
  assert.equal(at('  debugger;').status, 'report-only');
  assert.equal(at('  debugger;').reason, 'separating statements that would join');
  assert.equal(at('  console.log(1);').status, 'report-only');
  assert.equal(at('  console.debug(2);').status, 'report-only');
  assert.equal(at('  console.debug(2);').reason, 'separating statements that would join');
  const safePair = joined.findIndex((line, index) => line === '  console.log(1);' && joined[index - 1] === '  foo();');
  assert.equal(byLine[safePair + 1].status, 'appliable');
  assert.equal(byLine[safePair + 2].status, 'appliable');
  assert.equal(at('  console.info(1);').reason, 'separating statements that would join');
  assert.equal(at('console.log("after-class");').status, 'appliable');
  assert.equal(at('  console.log("first");').status, 'report-only');
  assert.equal(at('  console.log("first");').reason, 'separating statements that would join');
  assert.equal(at('  console.log("later");').status, 'appliable');
  assert.equal(at('  console.log("after-generic");').status, 'appliable');

  const removed = suggestions.combinedPatch.split('\n').filter((line) => line.startsWith('-') && !line.startsWith('---'));
  assert.ok(removed.some((line) => line === '-  console.log("debug");'));
  assert.ok(!removed.some((line) => line === '-  debugger;'));
  assert.ok(removed.some((line) => line === '-console.log("after-class");'));
  assert.ok(!removed.some((line) => line === '-  console.log("first");'));
  assert.ok(removed.some((line) => line === '-  console.log("later");'));

  const applied = await applyPatch([{ path: 'src/asi.js', content: source }], suggestions.combinedPatch);
  assert.match(applied['src/asi.js'], /foo\(\);\n {2}\(bar\)\(\);/);
  assert.match(applied['src/asi.js'], /foo\(\)\n {2}console\.log\("debug"\);\n {2}\(bar\)\(\);/);
  assert.match(applied['src/asi.js'], /foo\(\)\n {2}debugger;\n {2}\(bar\)\(\);/);
  assert.match(applied['src/asi.js'], /foo\(\)\n {2}console\.log\(1\);\n {2}console\.debug\(2\);\n {2}\(bar\)\(\);/);
  assert.match(applied['src/asi.js'], /class Decl \{\n {2}m\(\) \{ return 1; \}\n\}\n\(bar\)\(\);/);
  assert.match(applied['src/asi.js'], /function block\(\) \{\n {2}console\.log\("first"\);\n {2}\(bar\)\(\);/);
  assert.doesNotMatch(applied['src/asi.js'], /console\.log\("later"\)/);
  assert.doesNotMatch(applied['src/asi.js'], /console\.log\("after-generic"\)/);
  assert.doesNotMatch(applied['src/asi.js'], /console\.log\("after-class"\)/);
});

test('writes that replace console stay report-only', async () => {
  const rewritten = [
    'console = audit;\nconsole.log(record);\n',
    'console.log = audit;\nconsole.log(record);\n',
    'console.debug = audit;\nconsole.log(record);\n',
    'console.info &&= audit;\nconsole.info(record);\n',
    'console ||= audit;\nconsole.log(record);\n',
    'console.log ??= audit;\nconsole.debug(record);\n',
    'globalThis.console = audit;\nconsole.log(record);\n',
    'window.console = audit;\nconsole.log(record);\n',
    'self.console = audit;\nconsole.log(record);\n',
    'global.console = audit;\nconsole.log(record);\n',
    'this.console = audit;\nconsole.log(record);\n',
    'globalThis.console.log = audit;\nconsole.log(record);\n',
    'window["console"] = audit;\nconsole.log(record);\n',
    "globalThis['console'] = audit;\nconsole.log(record);\n",
    'self[`console`] = audit;\nconsole.log(record);\n',
    'console["log"] = audit;\nconsole.log(record);\n',
    "console['debug'] = audit;\nconsole.debug(record);\n",
    'console[method] = audit;\nconsole.log(record);\n',
    'delete console.log;\nconsole.log(record);\n',
    'delete globalThis.console;\nconsole.log(record);\n',
    'delete window["console"];\nconsole.log(record);\n',
    '++console.log;\nconsole.log(record);\n',
    'console.log++;\nconsole.log(record);\n',
    'delete (console.log);\nconsole.log(record);\n',
    '++(console.log);\nconsole.log(record);\n',
    'const c = console;\n++c.log;\nconsole.log(record);\n',
    '({ log: console.log } = audit);\nconsole.log(record);\n',
    '[console.log] = [audit];\nconsole.log(record);\n',
    '[console] = [audit];\nconsole.log(record);\n',
    '({ console } = globalThis);\nconsole.log(record);\n',
    '({ log: globalThis.console.log } = audit);\nconsole.log(record);\n',
    'for (console of rows) {}\nconsole.log(record);\n',
    'for (console.log of rows) {}\nconsole.log(record);\n',
    'Object.assign(console, { log: audit });\nconsole.log(record);\n',
    'Object.assign(globalThis, extras);\nconsole.log(record);\n',
    'Object.defineProperty(console, "log", { value: audit });\nconsole.log(record);\n',
    'Object.defineProperty(globalThis, "console", { value: audit });\nconsole.log(record);\n',
    'Object.defineProperties(console, { log: { value: audit } });\nconsole.log(record);\n',
    'Object.setPrototypeOf(console, other);\nconsole.log(record);\n',
    'Reflect.defineProperty(console, "log", { value: audit });\nconsole.log(record);\n',
    'Reflect.set(window, "console", audit);\nconsole.log(record);\n',
    'Reflect.deleteProperty(self, "console");\nconsole.log(record);\n',
    'const c = console;\nc.log = audit;\nconsole.log(record);\n',
    'const { console: c } = globalThis;\nc.log = audit;\nconsole.log(record);\n',
    'const { console: c } = globalThis;\nconsole.log(record);\n',
    'const { console: c } = window;\nconsole.log(record);\n',
    'let { console: c } = self;\nconsole.log(record);\n',
    'var { console: c } = global;\nconsole.log(record);\n',
    '({ console: c } = this);\nconsole.log(record);\n',
    'const { "console": c } = globalThis;\nconsole.log(record);\n',
    "const { 'console': c } = window;\nconsole.log(record);\n",
    'const { ["console"]: c } = globalThis;\nconsole.log(record);\n',
    "const { ['console']: c } = self;\nconsole.log(record);\n",
    'const { console: c = fallback } = globalThis;\nconsole.log(record);\n',
    'const [{ console: c }] = [globalThis];\nconsole.log(record);\n',
    'for (const { console: c } of [globalThis]) {}\nconsole.log(record);\n',
    'for ({ console: c } of [globalThis]) {}\nconsole.log(record);\n',
    'function installAlias({ console: c }) {\n  c.log = audit;\n}\nconsole.log(record);\n',
    'function installAlias({ console: c } = globalThis) {\n  c.log = audit;\n}\nconsole.log(record);\n',
    'const { console: { log: nested } } = globalThis;\nconsole.log(record);\n',
    'const c = globalThis.console;\nconsole.log(record);\n',
    'const c = window["console"];\nconsole.log(record);\n',
    'const { log: taken } = console;\nconsole.log(record);\n',
    'const c = (0, globalThis.console);\nconsole.log(record);\n',
    'const c = console?.log;\nconsole.log(1);\n',
    'Reflect.get(globalThis, "console");\nconsole.log(record);\n',
    'Object.getOwnPropertyDescriptor(window, "console");\nconsole.log(record);\n',
    'const { console: c, ...rest } = globalThis;\nconsole.log(record);\n',
    'window[name];\nconsole.log(record);\n',
    'globalThis["con" + "sole"];\nconsole.log(record);\n',
    '(globalThis).console;\nconsole.log(record);\n',
    '((window))["console"];\nconsole.log(record);\n',
    '(0, globalThis).console.log;\nconsole.log(record);\n',
    '(self)["console"] = audit;\nconsole.log(record);\n',
    'const c = console;\nconsole.log(c);\n',
    'const kept = console.log;\nconsole.log(1);\n',
    '({ console: saved } = globalThis);\nconsole.log(saved);\n',
    '({ log } = console);\nconsole.log(1);\n',
    'const c = console.log;\nc = audit;\nconsole.log(1);\n',
    'let c = window.console;\nc["info"] = audit;\nconsole.info(record);\n',
    'const c = globalThis.console;\nconst d = c;\nd.log = audit;\nconsole.log(record);\n',
    'const c = (console);\nc.log = audit;\nconsole.log(record);\n',
    'const c = (0, console);\nc.log = audit;\nconsole.log(record);\n',
    'const c = console;\nObject.assign(c, { log: audit });\nconsole.log(record);\n',
    'const c = console;\ndelete c.log;\nconsole.log(record);\n',
    'const c = console;\nObject.defineProperty(c, "log", { value: audit });\nconsole.log(record);\n',
    'function install(c = console) {\n  c.log = audit;\n}\nconsole.log(record);\n',
    'function later() {\n  console = audit;\n}\nconsole.log(record);\n',
    '\\u0063onsole = audit;\nconsole.log(record);\n',
    'window["\\u0063onsole"] = audit;\nconsole.log(record);\n',
    'console.__defineSetter__("log", audit);\nconsole.log(record);\n',
    'globalThis.__defineSetter__("console", audit);\nconsole.log(record);\n',
    'const c = console as Console;\nc.log = audit;\nconsole.log(record);\n',
  ];
  for (const content of rewritten) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/rewrite.js', content },
    ]);
    assert.equal(suggestions.combinedPatch, '', content);
    assert.ok(suggestions.sites.length >= 1, content);
    assert.ok(
      suggestions.sites.every((site) => site.kind === 'debugger' || (site.status === 'report-only' && site.reason === 'in a file that reassigns console')),
      content + '\n' + JSON.stringify(suggestions.sites.map((site) => [site.line, site.kind, site.status, site.reason]))
    );
  }

  const untouched = [
    'console == audit;\nconsole.log(1);\n',
    'console === audit;\nconsole.log(1);\n',
    'const note = "console = audit";\nconsole.log(note);\n',
    'logger.console = audit;\nconsole.log(1);\n',
    'logger.console.log = audit;\nconsole.log(1);\n',
    'const note = { console: audit };\nconsole.log(note);\n',
    'import { console as renamed } from "./logger";\nconsole.log(1);\n',
    'function take(console) {\n  console.log(console);\n}\nconsole.log(1);\n',
    'Object.defineProperty(window, "name", { value: "app" });\nconsole.log(1);\n',
    'window.__defineSetter__("onclick", hide);\nconsole.log(1);\n',
    'Object.getOwnPropertyDescriptor(window, "name");\nconsole.log(1);\n',
    'i++;\nconsole.log(1);\n',
    'i++\nconsole.log(1);\n',
    '++console.log(1);\nconsole.log(2);\n',
    'delete console.log();\nconsole.log(1);\n',
  ];
  for (const content of untouched) {
    const suggestions = Parser.collectRemoveDebugStatementSuggestions([
      { path: 'src/keep.js', content },
    ]);
    assert.ok(
      suggestions.sites.some((site) => site.status === 'appliable'),
      content + '\n' + JSON.stringify(suggestions.sites.map((site) => [site.line, site.status, site.reason]))
    );
  }

  const mixed = [
    'console = audit;',
    'console.log(record);',
    'debugger;',
    'function other() {',
    '  console.debug(record);',
    '}',
    '',
  ].join('\n');
  const mixedSuggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/mixed.js', content: mixed },
    { path: 'src/other.js', content: 'console.log(1);\n' },
  ]);
  const mixedByLine = Object.fromEntries(
    mixedSuggestions.sites.filter((site) => site.filePath === 'src/mixed.js').map((site) => [site.line, site])
  );
  assert.equal(mixedByLine[2].status, 'report-only');
  assert.equal(mixedByLine[2].reason, 'in a file that reassigns console');
  assert.equal(mixedByLine[2].patch, undefined);
  assert.equal(mixedByLine[3].status, 'appliable');
  assert.equal(mixedByLine[3].kind, 'debugger');
  assert.equal(mixedByLine[5].status, 'report-only');
  assert.equal(mixedByLine[5].reason, 'in a file that reassigns console');
  const other = mixedSuggestions.sites.find((site) => site.filePath === 'src/other.js');
  assert.equal(other.status, 'appliable');
  assert.match(mixedSuggestions.combinedPatch, /src\/other\.js/);
  assert.ok(mixedSuggestions.combinedPatch.includes('-debugger;'));
  assert.ok(!mixedSuggestions.combinedPatch.includes('-console = audit'));
  assert.ok(!mixedSuggestions.combinedPatch.includes('-console.log(record)'));

  const applied = await applyPatch(
    [
      { path: 'src/mixed.js', content: mixed },
      { path: 'src/other.js', content: 'console.log(1);\n' },
    ],
    mixedSuggestions.combinedPatch
  );
  assert.match(applied['src/mixed.js'], /console = audit;\nconsole\.log\(record\);\nfunction other\(\) \{\n {2}console\.debug\(record\);/);
  assert.doesNotMatch(applied['src/mixed.js'], /debugger/);
  assert.equal(applied['src/other.js'], '');
});

test('patch paths use git C quoting and still apply', async () => {
  const weird = 'src/a\nb\tc"d\u0001e\u0007f café.js';
  const spaced = 'src/my file.js';
  const source = 'console.log(1);\nkeep();\n';
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: weird, content: source },
    { path: spaced, content: source },
  ]);
  const weirdPatch = suggestions.filePatches[weird];
  const weirdLines = weirdPatch.split('\n');
  const quoted = '"a/src/a\\nb\\tc\\"d\\001e\\af caf\\303\\251.js"';
  assert.equal(weirdLines[0], 'diff --git ' + quoted + ' ' + quoted.replace('a/', 'b/'));
  assert.equal(weirdLines[1], '--- ' + quoted);
  assert.equal(weirdLines[2], '+++ ' + quoted.replace('a/', 'b/'));
  assert.equal(weirdLines[0].includes('\t'), false);
  assert.equal(weirdLines[0].includes('\u0001'), false);
  assert.equal(weirdLines[0].includes('café'), false);

  const spacedPatch = suggestions.filePatches[spaced];
  assert.match(spacedPatch, /^diff --git a\/src\/my file\.js b\/src\/my file\.js\n/);
  assert.match(spacedPatch, /^--- a\/src\/my file\.js\n/m);
  assert.match(spacedPatch, /^\+\+\+ b\/src\/my file\.js\n/m);

  const applied = await applyPatch(
    [
      { path: weird, content: source },
      { path: spaced, content: source },
    ],
    suggestions.combinedPatch
  );
  assert.equal(applied[weird], 'keep();\n');
  assert.equal(applied[spaced], 'keep();\n');
});

test('a few thousand debug statements stay linear to analyze', () => {
  const lines = [];
  for (let i = 0; i < 5000; i++) lines.push('console.log(' + i + ');');
  lines.push('keep();');
  const content = lines.join('\n') + '\n';
  const started = Date.now();
  const suggestions = Parser.collectRemoveDebugStatementSuggestions([
    { path: 'src/lots.js', content },
  ]);
  const elapsed = Date.now() - started;
  assert.equal(suggestions.sites.length, 5000);
  assert.equal(suggestions.sites.every((site) => site.status === 'appliable' && site.patch), true);
  assert.match(suggestions.filePatches['src/lots.js'], /^diff --git a\/src\/lots\.js /);
  assert.ok(elapsed < 2000, 'analysis took ' + elapsed + 'ms');
});

test('index.html does not gain a write path for debug patches', () => {
  assert.equal(htmlSource.includes('createWritable'), false);
  assert.equal(htmlSource.includes('showSaveFilePicker'), false);
  assert.equal(htmlSource.includes('Enable Write Access'), false);
  assert.equal(htmlSource.includes('FileSystemWritableFileStream'), false);
});
