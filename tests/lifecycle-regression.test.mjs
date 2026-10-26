import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, sep } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { createProjectsServer } from '../server/projects-server.mjs';

const { loadAnalyzer } = createRequire(import.meta.url)('./helpers/analyzer.cjs');
const { Parser } = loadAnalyzer(new URL('../index.html', import.meta.url));

test('registered projects survive integrated search, edit, exclusion, restart and removal', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfk-lifecycle-'));
  assert.ok(root.startsWith(tmpdir() + sep));
  const discovery = join(root, 'discovery'), a = join(root, 'A'), b = join(root, 'B');
  let app;
  async function start() {
    app = createProjectsServer({ projectsRoot: discovery, configPath: join(root, 'registry.json') });
    await app.restore();
    await new Promise(resolve => app.server.listen(0, '127.0.0.1', resolve));
    const base = 'http://127.0.0.1:' + app.server.address().port;
    const get = path => fetch(base + path);
    const post = (path, body) => fetch(base + path, {
      method: 'POST',
      headers: { Origin: base, 'X-Codeflow-CSRF': app._registry.csrf, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    return { get, post };
  }
  try {
    await mkdir(discovery);
    for (const dir of [a, b]) {
      await mkdir(join(dir, 'src'), { recursive: true });
      await mkdir(join(dir, 'private'), { recursive: true });
    }
    const source = join(a, 'src', 'Main.kt');
    await writeFile(source, 'fun originalA() = 1\n');
    await writeFile(join(a, 'private', 'Hidden.kt'), 'fun secretFixture() = 1\n');
    await writeFile(join(a, 'dataset.json'), '{"secretFixture":true}\n');
    await writeFile(join(b, 'src', 'Main.kt'), 'fun originalB() = 2\n');

    let { get, post } = await start();
    const addA = await post('/__codeflow/add-project', { path: a });
    assert.equal(addA.status, 200);
    const pidA = (await addA.json()).id;
    const addB = await post('/__codeflow/add-project', { path: b });
    assert.equal(addB.status, 200);
    const pidB = (await addB.json()).id;
    assert.equal((await post('/__codeflow/select-project', { id: pidA })).status, 200);

    const files = await (await get('/__codeflow/files?pid=' + encodeURIComponent(pidA))).json();
    assert.deepEqual(files.files.map(f => f.path).sort(), ['private/Hidden.kt', 'src/Main.kt']);
    const editUrl = '/__codeflow/edit-source?pid=' + encodeURIComponent(pidA) + '&path=src%2FMain.kt';
    const opened = await (await get(editUrl)).json();
    const edited = 'fun savedA() = 3\n';
    assert.equal((await post('/__codeflow/edit-source', { ...opened, content: edited })).status, 200);
    assert.equal(await readFile(source, 'utf8'), edited);
    assert.equal(await (await get('/__codeflow/file?pid=' + encodeURIComponent(pidA) + '&path=src%2FMain.kt')).text(), edited);
    assert.ok(Parser.extract(edited, 'src/Main.kt').some(fn => fn.name === 'savedA'));
    let search = await (await get('/__codeflow/search?pid=' + encodeURIComponent(pidA) + '&q=savedA')).json();
    assert.equal(search.results.find(r => r.path === 'src/Main.kt').matches[0].line, 1);

    await writeFile(source, 'fun externalA() = 4\n');
    assert.equal((await post('/__codeflow/edit-source', { ...opened, content: 'stale draft\n' })).status, 409);
    search = await (await get('/__codeflow/search?pid=' + encodeURIComponent(pidA) + '&q=externalA')).json();
    assert.ok(search.results.some(r => r.path === 'src/Main.kt'));
    assert.equal((await post('/__codeflow/set-exclusions', { id: pidA, exclusions: ['private'] })).status, 200);
    search = await (await get('/__codeflow/search?pid=' + encodeURIComponent(pidA) + '&q=secretFixture')).json();
    assert.equal(search.results.length, 0);

    assert.equal((await post('/__codeflow/select-project', { id: pidB })).status, 200);
    assert.equal((await get('/__codeflow/search?pid=' + encodeURIComponent(pidA) + '&q=externalA')).status, 409);
    assert.equal((await post('/__codeflow/select-project', { id: pidA })).status, 200);
    const rapid = await Promise.all(Array.from({ length: 6 }, () => get('/__codeflow/search?pid=' + encodeURIComponent(pidA) + '&q=externalA')));
    assert.ok(rapid.every(r => r.status === 200));
    assert.ok((await Promise.all(rapid.map(r => r.json()))).every(r => r.pid === pidA && r.results.some(hit => hit.path === 'src/Main.kt')));

    await app.close(); app = null;
    ({ get, post } = await start());
    assert.equal((await (await get('/__codeflow/status')).json()).pid, pidA);
    assert.equal((await (await get('/__codeflow/search?pid=' + encodeURIComponent(pidA) + '&q=secretFixture')).json()).results.length, 0);
    assert.equal((await post('/__codeflow/remove-project', { id: pidA })).status, 200);
    assert.equal((await (await get('/__codeflow/status')).json()).pid, null);
    assert.equal(await readFile(source, 'utf8'), 'fun externalA() = 4\n');
    assert.equal((await post('/__codeflow/select-project', { id: pidB })).status, 200);
    await rename(b, join(root, 'B-moved'));
    assert.equal((await (await get('/__codeflow/status')).json()).missing, true);
    assert.equal((await get('/__codeflow/search?q=originalB')).status, 410);
  } finally {
    if (app) await app.close();
    await rm(root, { recursive: true, force: true });
  }
});
