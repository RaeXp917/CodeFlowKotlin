// Registered project analysis, stable identity and manual server startup.
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

test('registered projects use the shared analyzer and Re-analyze control', () => {
  assert.match(html, /function analyzeLocalProject\(/);
  assert.match(html, /function loadActiveProject\(/);
  assert.match(html, /'aria-label':'Re-analyze'/);
  assert.match(html, /onClick:refreshAnalysis/);
  assert.match(selector, /window\.location\.assign\('\/'\)/);
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

test('manual launcher can identify the local runtime independently of any IDE', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-launch-'));
  const app = createProjectsServer({ projectsRoot: root, persist: false });
  await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
  try {
    const response = await fetch('http://127.0.0.1:' + app.server.address().port + '/__codeflow/runtime');
    assert.equal(response.status, 200);
    const runtime = await response.json();
    assert.equal(runtime.app, 'CodeFlowKotlin');
    assert.equal(runtime.uiRoot, path.resolve(__dirname, '..'));
    assert.equal(runtime.projectsRoot, root);
    assert.equal(runtime.processId, process.pid);
  } finally {
    await app.close();
    await fs.rm(root, { recursive: true, force: true });
  }
});
