// Local-project server states — the selected project is re-validated against
// disk, so a deleted/moved project is reported honestly instead of surfacing as
// an empty "no code files" failure (the screenshot bug). Also asserts that a
// real nested Android project enumerates its Kotlin source.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createProjectsServer } from '../cli/projects-server.mjs';

const __dirname = dirname(fileURLToPath(import.meta.url));

async function withServer(projectsRoot, fn) {
  const app = createProjectsServer({ projectsRoot, persist: false });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = 'http://127.0.0.1:' + port;
  try { await fn(app, base); } finally { await app.close(); }
}

async function makeProjectsRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-projects-'));
  return root;
}

test('a real nested Android project enumerates its Kotlin source', async () => {
  const root = await makeProjectsRoot();
  const proj = path.join(root, 'demo-app');
  await fs.mkdir(path.join(proj, 'app', 'src', 'main', 'java', 'com', 'demo'), { recursive: true });
  await fs.writeFile(path.join(proj, 'app', 'src', 'main', 'java', 'com', 'demo', 'MainActivity.kt'), 'class MainActivity');
  await fs.writeFile(path.join(proj, 'app', 'build.gradle.kts'), 'plugins {}');
  await withServer(root, async (app, base) => {
    await app.changeProject('demo-app');
    const res = await fetch(base + '/__codeflow/files');
    assert.equal(res.status, 200);
    const body = await res.json();
    const kt = body.files.filter((f) => f.name.endsWith('.kt'));
    assert.equal(kt.length, 1, 'nested .kt not found');
    assert.equal(kt[0].path, 'app/src/main/java/com/demo/MainActivity.kt');
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('a deleted/moved selected project is reported as missing, not empty', async () => {
  const root = await makeProjectsRoot();
  const proj = path.join(root, 'temp-proj');
  await fs.mkdir(path.join(proj, 'lib'), { recursive: true });
  await fs.writeFile(path.join(proj, 'lib', 'main.dart'), 'void main(){}');
  await withServer(root, async (app, base) => {
    await app.changeProject('temp-proj');
    let res = await fetch(base + '/__codeflow/status');
    let st = await res.json();
    assert.equal(st.ok, true);
    assert.equal(st.missing, false);

    // Remove the project folder out from under the running server.
    await fs.rm(proj, { recursive: true, force: true });

    res = await fetch(base + '/__codeflow/status');
    st = await res.json();
    assert.equal(st.ok, false, 'status must not claim ok for a missing project');
    assert.equal(st.missing, true, 'status must flag the project as missing');

    res = await fetch(base + '/__codeflow/files');
    assert.equal(res.status, 410, 'files must report 410 for a missing project');
    const body = await res.json();
    assert.equal(body.code, 'project-missing');
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('no project selected yields a neutral 409, not an error analysis', async () => {
  const root = await makeProjectsRoot();
  await withServer(root, async (app, base) => {
    const res = await fetch(base + '/__codeflow/files');
    assert.equal(res.status, 409);
    const body = await res.json();
    assert.equal(body.code, 'no-project');
    const st = await (await fetch(base + '/__codeflow/status')).json();
    assert.equal(st.ok, false);
    assert.equal(st.missing, false);
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('index.html no longer shows the misleading CLI/watched-folder copy', async () => {
  const html = await readFile(join(__dirname, '..', 'index.html'), 'utf8');
  assert.doesNotMatch(html, /CLI analysis failed/);
  assert.doesNotMatch(html, /No code files found in the watched folder/);
  assert.doesNotMatch(html, /Restart the CLI in that folder/);
  // Accurate local-project messages are present.
  assert.match(html, /The selected project folder is missing or was moved/);
  assert.match(html, /No supported source files found in the selected project/);
});
