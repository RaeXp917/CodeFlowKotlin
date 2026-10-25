// Stage 6 addendum — CodeFlow is source-code only. One shared eligibility policy
// governs enumeration, direct reads, search and the watcher; Markdown / docs /
// data / media are never enumerated, read or searched.
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  isSourceCodeFile, isWatchableFile, listWatchFiles, startFileWatchers,
} from '../server/server-utils.mjs';
import { searchProjectRoot } from '../server/project-search.mjs';
import { createProjectsServer } from '../server/projects-server.mjs';

test('the eligibility policy includes source code and excludes docs/data/media', () => {
  for (const f of ['Main.kt', 'build.gradle.kts', 'App.java', 'View.swift', 'main.dart', 'a.js', 'b.ts', 'c.tsx', 'd.py', 'e.go', 'f.rs', 'index.html', 'App.vue']) {
    assert.equal(isSourceCodeFile(f), true, f + ' should be source code');
  }
  for (const f of ['README.md', 'notes.markdown', 'data.json', 'conf.yaml', 'conf.yml', 'cfg.toml', 'style.css', 'q.sql', 'notes.txt', 'shot.png', 'doc.pdf', 'data.csv', 'archive.zip', 'app.log']) {
    assert.equal(isSourceCodeFile(f), false, f + ' should NOT be source code');
  }
  // isWatchableFile is an alias of the same policy.
  assert.equal(isWatchableFile('Main.kt'), isSourceCodeFile('Main.kt'));
  assert.equal(isWatchableFile('README.md'), false);
});

async function makeMixedTree() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-only-'));
  await fs.mkdir(path.join(root, 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'docs'), { recursive: true });
  await fs.writeFile(path.join(root, 'src', 'RecordScreen.kt'), 'class RecordScreen // RecordScreen marker');
  await fs.writeFile(path.join(root, 'src', 'main.dart'), 'void main(){ /* RecordScreen */ }');
  await fs.writeFile(path.join(root, 'docs', 'PLAN.md'), '# RecordScreen plan\nRecordScreen everywhere');
  await fs.writeFile(path.join(root, 'data.json'), '{"RecordScreen": true}');
  await fs.writeFile(path.join(root, 'notes.txt'), 'RecordScreen notes');
  await fs.writeFile(path.join(root, 'README.md'), 'RecordScreen readme');
  return root;
}

test('enumeration returns only source files from a mixed tree', async () => {
  const root = await makeMixedTree();
  const files = (await listWatchFiles(root)).map((f) => f.path.replace(/\\/g, '/')).sort();
  assert.deepEqual(files, ['src/RecordScreen.kt', 'src/main.dart']);
  await fs.rm(root, { recursive: true, force: true });
});

test('search never returns non-code matches and never reads non-code files', async () => {
  const root = await makeMixedTree();
  const readPaths = [];
  const out = await searchProjectRoot(root, {
    query: 'RecordScreen',
    // Spy on every content read to prove non-code files are never opened.
    readFile: (abs) => { readPaths.push(abs.replace(/\\/g, '/')); return fs.readFile(abs, 'utf8'); },
  });
  const hitPaths = out.results.map((r) => r.path.replace(/\\/g, '/')).sort();
  assert.deepEqual(hitPaths, ['src/RecordScreen.kt', 'src/main.dart']);
  // No doc/data file was ever read.
  assert.ok(!readPaths.some((p) => /\.(md|json|txt|markdown|yaml|yml)$/i.test(p)), 'non-code files must not be read: ' + readPaths.join(','));
  assert.ok(readPaths.every((p) => /\.(kt|dart)$/i.test(p)));
  await fs.rm(root, { recursive: true, force: true });
});

test('the watcher emits source-code changes and ignores non-code changes', () => {
  const seen = [];
  const fakeWatch = (dir, opts, cb) => { fakeWatch._cb = cb; return { close() {} }; };
  const w = startFileWatchers('/proj', (rel) => seen.push(rel), fakeWatch);
  fakeWatch._cb('change', 'src/RecordScreen.kt');
  fakeWatch._cb('change', 'docs/PLAN.md');
  fakeWatch._cb('change', 'data.json');
  fakeWatch._cb('change', 'src/main.dart');
  w.close();
  assert.deepEqual(seen, ['src/RecordScreen.kt', 'src/main.dart'], 'only code changes notify');
});

function rawGet(port, pathname) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method: 'GET', headers: { Host: '127.0.0.1:' + port } }, (res) => {
      let text = ''; res.setEncoding('utf8'); res.on('data', (c) => { text += c; });
      res.on('end', () => resolve({ status: res.statusCode, text }));
    });
    req.on('error', reject); req.end();
  });
}

test('/__codeflow/file reads source code but rejects non-code inside the project', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-only-'));
  const proj = path.join(root, 'app');
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(path.join(proj, 'Main.kt'), 'val secret = 1');
  await fs.writeFile(path.join(proj, 'README.md'), 'SECRET DOC CONTENT');
  await fs.writeFile(path.join(proj, 'data.json'), '{"secret":"DOC"}');
  const app = createProjectsServer({ projectsRoot: root, persist: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  const port = app.server.address().port;
  try {
    await app.changeProject('app');
    const kt = await rawGet(port, '/__codeflow/file?path=Main.kt');
    assert.equal(kt.status, 200);
    assert.match(kt.text, /val secret/);
    const md = await rawGet(port, '/__codeflow/file?path=README.md');
    assert.equal(md.status, 404, 'Markdown must not be readable');
    assert.doesNotMatch(md.text, /DOC CONTENT/);
    const json = await rawGet(port, '/__codeflow/file?path=data.json');
    assert.equal(json.status, 404, 'JSON must not be readable');
    // /files enumerates only the source file.
    const files = JSON.parse((await rawGet(port, '/__codeflow/files')).text).files.map((f) => f.path);
    assert.deepEqual(files, ['Main.kt']);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
