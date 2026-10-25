// Stage 5 — project-management HTTP integration: native-picker endpoint, CSRF /
// same-origin mutation guards, the persistent registry (add / remove / hide),
// per-project exclusions enforced across enumeration, reads, watch and the
// directory picker, and config migration across a restart.
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectsServer } from '../server/projects-server.mjs';
import { projectId } from '../server/project-registry.mjs';

function rawRequest(port, method, pathname, { headers = {}, body } = {}) {
  return new Promise((resolve, reject) => {
    const data = body !== undefined ? Buffer.from(JSON.stringify(body), 'utf8') : null;
    const h = Object.assign({}, headers);
    if (data) { h['Content-Type'] = 'application/json'; h['Content-Length'] = data.length; }
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers: h }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => {
        let json = null;
        try { json = JSON.parse(text); } catch {}
        resolve({ status: res.statusCode, json, text });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

async function makeProjectsRoot() {
  return fs.mkdtemp(path.join(os.tmpdir(), 'cfk-pm-'));
}

function okPicker(chosenPath) {
  return async () => ({ status: 'ok', path: chosenPath });
}

async function withServer(opts, fn) {
  const app = createProjectsServer(opts);
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const base = 'http://127.0.0.1:' + port;
  const csrf = app._registry.csrf;
  const mutHeaders = { Host: '127.0.0.1:' + port, Origin: 'http://127.0.0.1:' + port, 'X-Codeflow-CSRF': csrf };
  const post = (p, body, extra) => rawRequest(port, 'POST', p, { headers: Object.assign({}, mutHeaders, extra), body });
  const get = (p) => rawRequest(port, 'GET', p, { headers: { Host: '127.0.0.1:' + port } });
  try { await fn({ app, base, port, csrf, mutHeaders, post, get }); } finally { await app.close(); }
}

test('mutation endpoints require POST, same-origin and the CSRF token', async () => {
  const root = await makeProjectsRoot();
  await fs.mkdir(path.join(root, 'alpha'));
  await withServer({ projectsRoot: root, persist: false }, async ({ port }) => {
    // Missing CSRF.
    let r = await rawRequest(port, 'POST', '/__codeflow/select-project', {
      headers: { Host: '127.0.0.1:' + port, Origin: 'http://127.0.0.1:' + port }, body: { id: 'x' },
    });
    assert.equal(r.status, 403, 'no CSRF token must be rejected');
    // Missing Origin (mandatory for mutations).
    r = await rawRequest(port, 'POST', '/__codeflow/select-project', {
      headers: { Host: '127.0.0.1:' + port, 'X-Codeflow-CSRF': 'anything' }, body: { id: 'x' },
    });
    assert.equal(r.status, 403, 'missing Origin must be rejected');
    // Cross-port Origin is not same-origin.
    r = await rawRequest(port, 'POST', '/__codeflow/select-project', {
      headers: { Host: '127.0.0.1:' + port, Origin: 'http://127.0.0.1:1', 'X-Codeflow-CSRF': 'anything' }, body: { id: 'x' },
    });
    assert.equal(r.status, 403, 'cross-origin (port) must be rejected');
    // GET on a mutation endpoint.
    r = await rawRequest(port, 'GET', '/__codeflow/pick-folder', { headers: { Host: '127.0.0.1:' + port } });
    assert.equal(r.status, 405);
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('a forged project id is rejected on selection', async () => {
  const root = await makeProjectsRoot();
  await fs.mkdir(path.join(root, 'alpha'));
  await withServer({ projectsRoot: root, persist: false }, async ({ post }) => {
    const r = await post('/__codeflow/select-project', { id: 'p_deadbeefdeadbeef' });
    assert.equal(r.status, 400);
    assert.equal(r.json.error, 'Unknown project');
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('native picker endpoint returns the mocked result and blocks concurrent dialogs', async () => {
  const root = await makeProjectsRoot();
  let release;
  const gate = new Promise((r) => { release = r; });
  const slowPicker = async () => { await gate; return { status: 'cancel' }; };
  await withServer({ projectsRoot: root, persist: false, pickFolderFn: slowPicker }, async ({ post }) => {
    const first = post('/__codeflow/pick-folder', {});
    // Give the first request time to mark the picker busy.
    await new Promise((r) => setTimeout(r, 20));
    const second = await post('/__codeflow/pick-folder', {});
    assert.equal(second.status, 409, 'a second concurrent picker must be refused');
    assert.equal(second.json.status, 'busy');
    release();
    const firstRes = await first;
    assert.equal(firstRes.json.status, 'cancel');
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('Add Folder registers an external project, selects it, and persists across restart', async () => {
  const root = await makeProjectsRoot();
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-ext-'));
  await fs.mkdir(path.join(external, 'src'), { recursive: true });
  await fs.writeFile(path.join(external, 'src', 'Main.kt'), 'class Main');
  const configPath = path.join(root, 'cfg.json');

  await withServer({ projectsRoot: root, persist: true, configPath, pickFolderFn: okPicker(external) }, async ({ post, get }) => {
    const pick = await post('/__codeflow/pick-folder', {});
    assert.equal(pick.json.status, 'ok');
    const add = await post('/__codeflow/add-project', { path: pick.json.path });
    assert.equal(add.status, 200);
    const id = add.json.id;
    assert.equal(add.json.selected, id, 'the new project becomes the selection');
    const list = (await get('/__codeflow/projects')).json;
    const entry = list.projects.find((p) => p.id === id);
    assert.ok(entry && entry.source === 'manual');
    // Its files load (external folder, outside AndroidStudioProjects).
    const files = (await get('/__codeflow/files')).json;
    assert.ok(files.files.some((f) => f.name === 'Main.kt'));
  });

  // Fresh server, same config file: the registration + selection survive.
  await withServer({ projectsRoot: root, persist: true, configPath, pickFolderFn: okPicker(external) }, async ({ app, get }) => {
    await app.restore();
    const list = (await get('/__codeflow/projects')).json;
    const entry = list.projects.find((p) => p.root && p.root.toLowerCase().includes('cfk-ext-'));
    assert.ok(entry, 'manual registration must survive a restart');
    assert.equal(list.selected, entry.id, 'selection must survive a restart');
  });

  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(external, { recursive: true, force: true });
});

test('registering the same canonical folder twice is refused', async () => {
  const root = await makeProjectsRoot();
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-ext-'));
  await withServer({ projectsRoot: root, persist: false, pickFolderFn: okPicker(external) }, async ({ post }) => {
    const first = await post('/__codeflow/add-project', { path: external });
    assert.equal(first.status, 200);
    // Same path with different case / a trailing separator must be seen as a dup.
    const dup = await post('/__codeflow/add-project', { path: external.toUpperCase() + path.sep });
    assert.equal(dup.status, 409);
    assert.equal(dup.json.error, 'already-registered');
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(external, { recursive: true, force: true });
});

test('Add Folder rejects a nonexistent path and a drive root', async () => {
  const root = await makeProjectsRoot();
  await withServer({ projectsRoot: root, persist: false }, async ({ post }) => {
    const gone = await post('/__codeflow/add-project', { path: path.join(root, 'does-not-exist') });
    assert.equal(gone.status, 400);
    assert.equal(gone.json.error, 'not-found');
    const drive = await post('/__codeflow/add-project', { path: 'C:\\' });
    assert.equal(drive.status, 400);
    assert.ok(['unsafe-root', 'not-found', 'not-a-directory'].includes(drive.json.error));
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('Remove unregisters a manual project without deleting the folder', async () => {
  const root = await makeProjectsRoot();
  const external = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-ext-'));
  await fs.writeFile(path.join(external, 'keep.kt'), 'val keep = 1');
  await withServer({ projectsRoot: root, persist: false, pickFolderFn: okPicker(external) }, async ({ post, get }) => {
    const add = await post('/__codeflow/add-project', { path: external });
    const id = add.json.id;
    const rm = await post('/__codeflow/remove-project', { id });
    assert.equal(rm.status, 200);
    const list = (await get('/__codeflow/projects')).json;
    assert.ok(!list.projects.some((p) => p.id === id), 'manual project must be unregistered');
    assert.equal(list.selected, null, 'removing the active project clears the selection');
    // The real folder and its source are untouched.
    const stat = await fs.stat(path.join(external, 'keep.kt'));
    assert.ok(stat.isFile(), 'remove must never delete source files');
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(external, { recursive: true, force: true });
});

test('auto-discovered projects can be hidden and unhidden', async () => {
  const root = await makeProjectsRoot();
  await fs.mkdir(path.join(root, 'alpha'));
  await withServer({ projectsRoot: root, persist: false }, async ({ post, get }) => {
    const id = projectId((await get('/__codeflow/projects')).json.projects[0].root);
    // Removing an auto project is not allowed (hide instead).
    const rm = await post('/__codeflow/remove-project', { id });
    assert.equal(rm.status, 400);
    assert.equal(rm.json.error, 'not-manual');
    let hide = await post('/__codeflow/set-hidden', { id, hidden: true });
    assert.equal(hide.status, 200);
    let entry = (await get('/__codeflow/projects')).json.projects.find((p) => p.id === id);
    assert.equal(entry.hidden, true);
    hide = await post('/__codeflow/set-hidden', { id, hidden: false });
    entry = (await get('/__codeflow/projects')).json.projects.find((p) => p.id === id);
    assert.equal(entry.hidden, false);
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('per-project exclusions are enforced across files, reads, status and dirs', async () => {
  const root = await makeProjectsRoot();
  const proj = path.join(root, 'app');
  await fs.mkdir(path.join(proj, 'screenshots'), { recursive: true });
  await fs.mkdir(path.join(proj, 'src'), { recursive: true });
  await fs.writeFile(path.join(proj, 'src', 'Main.kt'), 'class Main');
  await fs.writeFile(path.join(proj, 'screenshots', 'shot.kt'), 'class Shot');
  await withServer({ projectsRoot: root, persist: false }, async ({ app, post, get }) => {
    await app.changeProject('app');
    const id = projectId((await get('/__codeflow/projects')).json.projects.find((p) => p.name === 'app').root);
    // Before exclusion both files enumerate.
    let files = (await get('/__codeflow/files')).json.files.map((f) => f.path);
    assert.ok(files.includes('screenshots/shot.kt'));
    // Exclude the screenshots folder (traversal entry is silently dropped).
    const set = await post('/__codeflow/set-exclusions', { id, exclusions: ['screenshots/', '../escape'] });
    assert.equal(set.status, 200);
    assert.deepEqual(set.json.exclusions, ['screenshots']);
    // Enumeration no longer lists excluded files.
    files = (await get('/__codeflow/files')).json.files.map((f) => f.path);
    assert.ok(!files.some((p) => p.startsWith('screenshots/')), 'excluded files must not enumerate');
    assert.ok(files.includes('src/Main.kt'));
    // Direct read of an excluded file is blocked.
    const blocked = await get('/__codeflow/file?path=' + encodeURIComponent('screenshots/shot.kt'));
    assert.equal(blocked.status, 404);
    const okRead = await get('/__codeflow/file?path=' + encodeURIComponent('src/Main.kt'));
    assert.equal(okRead.status, 200);
    // Status reflects exclusions (this drives client cache invalidation).
    const status = (await get('/__codeflow/status')).json;
    assert.deepEqual(status.exclusions, ['screenshots']);
    // The dirs picker hides excluded folders.
    const dirs = (await get('/__codeflow/dirs?id=' + encodeURIComponent(id))).json;
    assert.ok(!dirs.dirs.includes('screenshots'));
    assert.ok(dirs.dirs.includes('src'));
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('exclusions are isolated per project', async () => {
  const root = await makeProjectsRoot();
  await fs.mkdir(path.join(root, 'app1', 'gen'), { recursive: true });
  await fs.mkdir(path.join(root, 'app2', 'gen'), { recursive: true });
  await fs.writeFile(path.join(root, 'app1', 'gen', 'A.kt'), 'class A');
  await fs.writeFile(path.join(root, 'app2', 'gen', 'B.kt'), 'class B');
  await withServer({ projectsRoot: root, persist: false }, async ({ app, post, get }) => {
    const list = (await get('/__codeflow/projects')).json.projects;
    const id1 = list.find((p) => p.name === 'app1').id;
    await post('/__codeflow/set-exclusions', { id: id1, exclusions: ['gen'] });
    // app2 is unaffected.
    await app.changeProject('app2');
    const files2 = (await get('/__codeflow/files')).json.files.map((f) => f.path);
    assert.ok(files2.includes('gen/B.kt'), 'app1 exclusions must not affect app2');
    // app1 keeps its exclusion.
    await app.changeProject('app1');
    const files1 = (await get('/__codeflow/files')).json.files.map((f) => f.path);
    assert.ok(!files1.some((p) => p.startsWith('gen/')));
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('a v1 config is migrated and the saved selection is retained', async () => {
  const root = await makeProjectsRoot();
  await fs.mkdir(path.join(root, 'legacy-app'));
  const configPath = path.join(root, 'cfg.json');
  // The v1 format was a flat map of rootKey -> selected project name.
  const rootKeyLower = path.resolve(root).replace(/[\\/]+$/, '').toLowerCase();
  await fs.writeFile(configPath, JSON.stringify({ [rootKeyLower]: 'legacy-app' }));
  await withServer({ projectsRoot: root, persist: true, configPath }, async ({ app, get }) => {
    await app.restore();
    const status = (await get('/__codeflow/status')).json;
    assert.equal(status.ok, true);
    assert.equal(status.name, 'legacy-app', 'migrated selection must be retained');
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('/dirs rejects a forged project id', async () => {
  const root = await makeProjectsRoot();
  await withServer({ projectsRoot: root, persist: false }, async ({ get }) => {
    const r = await get('/__codeflow/dirs?id=p_forged0000000000');
    assert.equal(r.status, 404);
  });
  await fs.rm(root, { recursive: true, force: true });
});
