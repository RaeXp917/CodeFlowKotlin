// Stage 3 — one unified local-project analysis pipeline.
// Verifies the browser CLI terminology/mode is gone, the source identity is
// 'local-project', the app no longer depends on ?cli=1, the project server
// exposes a stable id, and the Re-analyze control is present.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createProjectsServer } from '../server/projects-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(__dirname, '..', 'index.html'), 'utf8');
const selector = await readFile(join(__dirname, '..', 'server', 'project-selector.js'), 'utf8');

test('the browser uses local-project functions, not CLI ones', () => {
  assert.doesNotMatch(html, /analyzeFromProject/);
  assert.doesNotMatch(html, /probeCodeflowProject/);
  assert.match(html, /function analyzeLocalProject\(/);
  assert.match(html, /function loadActiveProject\(/);
  // loadActiveProject is invoked on mount (replacing the old probe).
  assert.match(html, /loadActiveProject\(\)/);
});

test('the analysis source identity is local-project (not cli)', () => {
  assert.match(html, /sourceType:'local-project'/);
  assert.match(html, /localSourceKind==='local-project'/);
  // The only remaining 'cli' identity strings are the legacy cache-accept clauses.
  const stray = html.match(/sourceType:'cli'/g) || [];
  assert.equal(stray.length, 0, 'no new records should persist sourceType:cli');
});

test('no active Project analysis mode or ?cli=1 dependency remains', () => {
  assert.doesNotMatch(html, /cli=1/);
  assert.doesNotMatch(html, /Project analysis failed/);
  // project-selector reloads to the normal URL, not /?cli=1.
  assert.match(selector, /window\.location\.assign\('\/'\)/);
  assert.doesNotMatch(selector, /cli=1/);
});

test('a Re-analyze control is present and wired to the pipeline', () => {
  assert.match(html, /'aria-label':'Re-analyze'/);
  assert.match(html, /onClick:refreshAnalysis/);
  assert.match(html, /localSourceKind==='local-project'&&' Re-analyze'/);
});

test('the project server exposes a stable id (canonical root, not basename)', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-id-'));
  await fs.mkdir(path.join(root, 'proj', 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'proj', 'src', 'Main.kt'), 'class Main');
  const app = createProjectsServer({ projectsRoot: root, persist: false });
  await new Promise((r) => app.server.listen(0, '127.0.0.1', r));
  try {
    await app.changeProject('proj');
    const st = await (await fetch('http://127.0.0.1:' + app.server.address().port + '/__codeflow/status')).json();
    assert.equal(typeof st.id, 'string');
    assert.ok(st.id.length > 0);
    assert.ok(st.id.endsWith('proj'), 'id should be the canonical root path');
    assert.notEqual(st.id, st.name, 'id must not be just the display name');
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
