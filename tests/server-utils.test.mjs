// Shared local-server utilities (cli/server-utils.mjs) — the filesystem,
// path-security, watch-revision, request-guard and browser-launcher helpers used
// by the local project server. (Formerly tests/cli-codeflow.test.mjs; the
// standalone-CLI server tests were retired with the CLI and replaced by
// equivalents against the retained project server in local-project-states.)
import assert from 'node:assert/strict';
import { mkdtemp, writeFile, mkdir, rm, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import {
  isAllowedCliRequest,
  isLoopbackHost,
  isWatchableFile,
  listWatchFiles,
  resolveSafeCliPath,
  resolveSafeExistingPath,
  shouldSkipName,
  openBrowser,
  CLI_FILE_MAX_BYTES,
  isMissingFsError,
  bumpWatchRev,
  currentWatchRev,
} from '../cli/server-utils.mjs';

const slash = (p) => String(p).replace(/\\/g, '/');

test('file errors distinguish missing files from read failures', () => {
  assert.equal(CLI_FILE_MAX_BYTES, 2 * 1024 * 1024);
  const revs = new Map();
  assert.equal(bumpWatchRev(revs, 'src/app.js'), 1);
  assert.equal(bumpWatchRev(revs, 'src/app.js'), 2);
  assert.equal(currentWatchRev(revs, '/src/app.js'), 2);
  assert.equal(isMissingFsError({ code: 'ENOENT' }), true);
  assert.equal(isMissingFsError({ code: 'ENOTDIR' }), true);
  assert.equal(isMissingFsError({ code: 'EISDIR' }), true);
  assert.equal(isMissingFsError({ code: 'EACCES' }), false);
  assert.equal(isMissingFsError(null), false);
});

test('skips junk directories and binary-looking names', () => {
  assert.equal(shouldSkipName('node_modules'), true);
  assert.equal(shouldSkipName('.git'), true);
  assert.equal(isWatchableFile('app.js'), true);
  assert.equal(isWatchableFile('Main.kt'), true);
  assert.equal(isWatchableFile('main.dart'), true);
  assert.equal(isWatchableFile('photo.png'), false);
});

test('path resolver stays inside the project root', () => {
  assert.equal(resolveSafeCliPath('/tmp/proj', '../secret'), null);
  // Separator-agnostic so the assertion is correct on Windows and POSIX.
  assert.ok(slash(resolveSafeCliPath('/tmp/proj', 'src/app.js')).endsWith('/src/app.js'));
});

test('request guard only allows loopback Host and Origin', () => {
  assert.equal(isLoopbackHost('127.0.0.1:4173'), true);
  assert.equal(isLoopbackHost('localhost:4173'), true);
  assert.equal(isLoopbackHost('[::1]:4173'), true);
  assert.equal(isLoopbackHost('evil.example'), false);
  assert.equal(isAllowedCliRequest({ headers: { host: '127.0.0.1:4173' } }), true);
  assert.equal(isAllowedCliRequest({ headers: { host: '127.0.0.1:4173', origin: 'http://127.0.0.1:4173' } }), true);
  assert.equal(isAllowedCliRequest({ headers: { host: 'evil.example', origin: 'http://evil.example' } }), false);
  assert.equal(isAllowedCliRequest({ headers: { host: '127.0.0.1:4173', origin: 'http://evil.example' } }), false);
});

test('rejects escaping symlinks after resolving the real path', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfk-link-'));
  const outside = await mkdtemp(join(tmpdir(), 'cfk-secret-'));
  await mkdir(join(root, 'src'));
  await writeFile(join(root, 'src', 'app.js'), 'export const ok = 1;\n');
  await writeFile(join(outside, 'id_rsa'), 'SECRET\n');
  await symlink(join(outside, 'id_rsa'), join(root, 'src', 'config.js'));
  await symlink(join(root, 'src', 'app.js'), join(root, 'src', 'alias.js'));
  assert.equal(await resolveSafeExistingPath(root, 'src/config.js'), null);
  const inside = await resolveSafeExistingPath(root, 'src/alias.js');
  assert.ok(inside && inside.endsWith('app.js'));
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

test('lists source files from a folder and skips junk trees', async () => {
  const root = await mkdtemp(join(tmpdir(), 'cfk-list-'));
  await mkdir(join(root, 'src'));
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true });
  await writeFile(join(root, 'src', 'app.js'), 'export function go(){}\n');
  await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'export default 1\n');
  const files = await listWatchFiles(root);
  assert.deepEqual(files.map((f) => f.path), ['src/app.js']);
  await rm(root, { recursive: true, force: true });
});

test('openBrowser keeps running when the opener is missing', () => {
  const events = {};
  const fakeSpawn = () => ({
    on(name, fn) { events[name] = fn; return this; },
    unref() {},
  });
  assert.doesNotThrow(() => openBrowser('http://127.0.0.1:4173/', fakeSpawn));
  assert.equal(typeof events.error, 'function');
  assert.doesNotThrow(() => events.error(Object.assign(new Error('spawn xdg-open ENOENT'), { code: 'ENOENT' })));
});
