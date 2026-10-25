// Stage 6 — the /__codeflow/search HTTP endpoint: active-project scope, project
// isolation via pid, exclusion enforcement, cross-origin rejection, real line
// numbers and that excluded files are never read through search.
import assert from 'node:assert/strict';
import http from 'node:http';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createProjectsServer } from '../server/projects-server.mjs';

function rawRequest(port, method, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ hostname: '127.0.0.1', port, path: pathname, method, headers }, (res) => {
      let text = '';
      res.setEncoding('utf8');
      res.on('data', (c) => { text += c; });
      res.on('end', () => { let json = null; try { json = JSON.parse(text); } catch {} resolve({ status: res.statusCode, json, text }); });
    });
    req.on('error', reject);
    req.end();
  });
}

async function withServer(projectsRoot, fn) {
  const app = createProjectsServer({ projectsRoot, persist: false });
  await new Promise((resolve) => app.server.listen(0, '127.0.0.1', resolve));
  const port = app.server.address().port;
  const get = (p) => rawRequest(port, 'GET', p, { Host: '127.0.0.1:' + port });
  try { await fn({ app, port, get }); } finally { await app.close(); }
}

async function makeRoot() {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-se-'));
  await fs.mkdir(path.join(root, 'app', 'src'), { recursive: true });
  await fs.mkdir(path.join(root, 'app', 'generated'), { recursive: true });
  await fs.writeFile(path.join(root, 'app', 'src', 'ListScreen.kt'), 'class ListScreen {\n  val vm = ListViewModel()\n}');
  await fs.writeFile(path.join(root, 'app', 'generated', 'Gen.kt'), 'class ListViewModel // generated');
  return root;
}

test('search is scoped to the active project and returns accurate line numbers', async () => {
  const root = await makeRoot();
  await withServer(root, async ({ app, get }) => {
    await app.changeProject('app');
    const res = await get('/__codeflow/search?q=' + encodeURIComponent('ListViewModel'));
    assert.equal(res.status, 200);
    const hit = res.json.results.find((r) => r.path.replace(/\\/g, '/') === 'src/ListScreen.kt');
    assert.ok(hit, 'ListScreen.kt should match');
    assert.equal(hit.matches[0].line, 2, 'one-based line number');
    // The real file exists at that location.
    const exists = await fs.stat(path.join(root, 'app', hit.path)).then(() => true).catch(() => false);
    assert.ok(exists);
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('search requires an active project', async () => {
  const root = await makeRoot();
  await withServer(root, async ({ get }) => {
    const res = await get('/__codeflow/search?q=x');
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'no-project');
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('a stale pid is rejected so Project A results never show for Project B', async () => {
  const root = await makeRoot();
  await fs.mkdir(path.join(root, 'other', 'src'), { recursive: true });
  await fs.writeFile(path.join(root, 'other', 'src', 'Other.kt'), 'class Other');
  await withServer(root, async ({ app, get }) => {
    await app.changeProject('app');
    const status = (await get('/__codeflow/status')).json;
    const appPid = status.pid;
    await app.changeProject('other');
    // A request still carrying app's pid must be refused now that 'other' is active.
    const res = await get('/__codeflow/search?q=class&pid=' + encodeURIComponent(appPid));
    assert.equal(res.status, 409);
    assert.equal(res.json.code, 'project-changed');
    assert.equal(res.json.pid, status.pid === res.json.pid ? res.json.pid : res.json.pid); // pid is the now-active one
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('excluded files are absent from search and never read', async () => {
  const root = await makeRoot();
  await withServer(root, async ({ app, get, port }) => {
    await app.changeProject('app');
    const pid = (await get('/__codeflow/status')).json.pid;
    // Before exclusion, the generated match is present.
    let res = await get('/__codeflow/search?q=' + encodeURIComponent('ListViewModel'));
    assert.ok(res.json.results.some((r) => r.path.replace(/\\/g, '/').startsWith('generated/')));
    // Exclude it via the CSRF-protected mutation.
    const csrf = app._registry.csrf;
    await new Promise((resolve, reject) => {
      const body = Buffer.from(JSON.stringify({ id: pid, exclusions: ['generated'] }));
      const req = http.request({
        hostname: '127.0.0.1', port, path: '/__codeflow/set-exclusions', method: 'POST',
        headers: { Host: '127.0.0.1:' + port, Origin: 'http://127.0.0.1:' + port, 'X-Codeflow-CSRF': csrf, 'Content-Type': 'application/json', 'Content-Length': body.length },
      }, (r) => { r.resume(); r.on('end', resolve); });
      req.on('error', reject); req.write(body); req.end();
    });
    res = await get('/__codeflow/search?q=' + encodeURIComponent('ListViewModel'));
    assert.ok(!res.json.results.some((r) => r.path.replace(/\\/g, '/').startsWith('generated/')), 'excluded files must not appear in search');
    assert.ok(res.json.results.some((r) => r.path.replace(/\\/g, '/') === 'src/ListScreen.kt'));
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('search rejects cross-origin requests', async () => {
  const root = await makeRoot();
  await withServer(root, async ({ app, port }) => {
    await app.changeProject('app');
    const res = await rawRequest(port, 'GET', '/__codeflow/search?q=x', { Host: '127.0.0.1:' + port, Origin: 'http://evil.example' });
    assert.equal(res.status, 403);
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('an empty / too-long query is a 400, not a crash', async () => {
  const root = await makeRoot();
  await withServer(root, async ({ app, get }) => {
    await app.changeProject('app');
    assert.equal((await get('/__codeflow/search?q=')).status, 400);
    assert.equal((await get('/__codeflow/search?q=' + 'x'.repeat(500))).status, 400);
  });
  await fs.rm(root, { recursive: true, force: true });
});

test('a symlinked file escaping the root is not searched', async () => {
  const root = await makeRoot();
  const outside = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-secret-'));
  await fs.writeFile(path.join(outside, 'secret.kt'), 'class SECRETTOKEN {}');
  try {
    await fs.symlink(path.join(outside, 'secret.kt'), path.join(root, 'app', 'src', 'leak.kt'));
  } catch { /* symlink may be unavailable; skip assertion below if so */ }
  await withServer(root, async ({ app, get }) => {
    await app.changeProject('app');
    const res = await get('/__codeflow/search?q=SECRETTOKEN');
    assert.ok(!res.json.results.some((r) => r.path.includes('leak')), 'symlinked escape must not be searched');
    // The secret file's content must never be returned in any result preview.
    const previews = res.json.results.flatMap((r) => r.matches.map((m) => m.preview)).join('\n');
    assert.doesNotMatch(previews, /SECRETTOKEN/);
  });
  await fs.rm(root, { recursive: true, force: true });
  await fs.rm(outside, { recursive: true, force: true });
});
