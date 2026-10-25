// Local-project server states — the selected project is re-validated against
// disk, so a deleted/moved project is reported honestly instead of surfacing as
// an empty "no code files" failure (the screenshot bug). Also asserts that a
// real nested Android project enumerates its Kotlin source.
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { createProjectsServer } from '../server/projects-server.mjs';

// Issue a raw request with custom Host/Origin (fetch forbids setting Origin).
function rawRequest(port, pathname, headers) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, headers }, (res) => {
      res.resume();
      res.on('end', () => resolve(res.statusCode));
    });
    req.on('error', reject);
    req.end();
  });
}

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

test('the project file endpoint does not follow symlinks escaping the root', async () => {
  const root = await makeProjectsRoot();
  const proj = path.join(root, 'app');
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-secret-'));
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.writeFile(path.join(proj, 'src', 'app.kt'), 'val ok = 1');
  await fs.writeFile(path.join(outside, 'id_rsa'), 'SECRET');
  await fs.symlink(path.join(outside, 'id_rsa'), path.join(proj, 'src', 'leak.kt'));
  await withServer(root, async (app, base) => {
    await app.changeProject('app');
    const leak = await fetch(base + '/__codeflow/file?path=src/leak.kt');
    assert.equal(leak.status, 404);
    assert.doesNotMatch(await leak.text(), /SECRET/);
    const ok = await fetch(base + '/__codeflow/file?path=src/app.kt');
    assert.equal(ok.status, 200);
    assert.match(await ok.text(), /val ok/);
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});

test('the project file endpoint rejects oversized files', async () => {
  const root = await makeProjectsRoot();
  const proj = path.join(root, 'big');
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(path.join(proj, 'huge.kt'), Buffer.alloc(2 * 1024 * 1024 + 1, 97));
  await withServer(root, async (app, base) => {
    await app.changeProject('big');
    const huge = await fetch(base + '/__codeflow/file?path=huge.kt');
    assert.equal(huge.status, 413);
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('state-changing + read endpoints reject cross-origin and non-loopback hosts', async () => {
  const root = await makeProjectsRoot();
  const proj = path.join(root, 'secure');
  await fs.mkdir(proj, { recursive: true });
  await fs.writeFile(path.join(proj, 'a.kt'), 'val a = 1');
  await withServer(root, async (app, base) => {
    await app.changeProject('secure');
    const port = app.server.address().port;
    assert.equal(await rawRequest(port, '/__codeflow/files', { Host: 'evil.example', Origin: 'http://evil.example' }), 403);
    assert.equal(await rawRequest(port, '/__codeflow/file?path=a.kt', { Host: '127.0.0.1:' + port, Origin: 'http://evil.example' }), 403);
    // Same-origin loopback is allowed.
    assert.equal(await rawRequest(port, '/__codeflow/file?path=a.kt', { Host: '127.0.0.1:' + port, Origin: 'http://127.0.0.1:' + port }), 200);
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('switching projects never mixes files from the previous project', async () => {
  const root = await makeProjectsRoot();
  await fs.mkdir(path.join(root, 'alpha', 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'beta', 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'alpha', 'src', 'Alpha.kt'), 'class Alpha');
  await fs.writeFile(path.join(root, 'beta', 'src', 'Beta.kt'), 'class Beta');
  await withServer(root, async (app, base) => {
    await app.changeProject('alpha');
    let files = (await (await fetch(base + '/__codeflow/files')).json()).files;
    assert.ok(files.some((f) => f.name === 'Alpha.kt'));
    assert.ok(!files.some((f) => f.name === 'Beta.kt'));
    await app.changeProject('beta');
    files = (await (await fetch(base + '/__codeflow/files')).json()).files;
    assert.ok(files.some((f) => f.name === 'Beta.kt'));
    assert.ok(!files.some((f) => f.name === 'Alpha.kt'), 'previous project leaked into the new selection');
  });
  await fs.rm(root, { recursive: true, force: true });
});
