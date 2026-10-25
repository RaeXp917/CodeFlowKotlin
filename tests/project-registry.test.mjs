// Stage 5 — persistent project registry: identity, migration, dedup, exclusion
// normalization, atomic writes and corrupt-config recovery.
import assert from 'node:assert/strict';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import {
  rootKey, projectId, normalizeExclusion, normalizeExclusions, migrateConfig,
  loadConfig, saveConfig, isReasonableProjectRoot, buildProjectList, getRootRecord,
} from '../server/project-registry.mjs';

test('project id is stable and identity-based (not name-based)', () => {
  const a = projectId('C:/Users/me/AndroidStudioProjects/app');
  const b = projectId('C:\\Users\\me\\AndroidStudioProjects\\app\\'); // redundant sep + case-only diff
  const c = projectId('C:/Users/me/OtherPlace/app'); // same name, different parent
  assert.equal(a, b, 'same canonical folder must map to one id');
  assert.notEqual(a, c, 'same-name folders in different parents must differ');
  assert.match(a, /^p_[0-9a-f]{16}$/);
});

test('rootKey normalizes case and trailing separators', () => {
  assert.equal(rootKey('C:/A/B/'), rootKey('c:\\a\\b'));
});

test('normalizeExclusion rejects traversal, absolute and drive paths', () => {
  assert.equal(normalizeExclusion('screenshots/'), 'screenshots');
  assert.equal(normalizeExclusion('a\\b\\c'), 'a/b/c');
  assert.equal(normalizeExclusion('../escape'), null);
  assert.equal(normalizeExclusion('/abs'), 'abs'); // leading slash stripped -> relative
  assert.equal(normalizeExclusion('C:/windows'), null);
  assert.equal(normalizeExclusion('  '), null);
  assert.equal(normalizeExclusion('a/../b'), null);
  assert.deepEqual(normalizeExclusions(['b', 'a', 'a', '../x']), ['a', 'b']);
});

test('migrateConfig upgrades the v1 flat selection map', () => {
  const v1 = { 'c:/users/me/androidstudioprojects': 'wms-vicko', 'c:/other': 'thing' };
  const cfg = migrateConfig(v1);
  assert.equal(cfg.version, 2);
  assert.equal(cfg.roots['c:/users/me/androidstudioprojects'].selectedName, 'wms-vicko');
  assert.deepEqual(cfg.roots['c:/users/me/androidstudioprojects'].manual, []);
  assert.equal(cfg.roots['c:/other'].selectedName, 'thing');
});

test('migrateConfig preserves a v2 config and sanitizes bad entries', () => {
  const v2 = {
    version: 2,
    roots: {
      k: {
        selected: 'p_abc', manual: [{ root: 'C:/x/app', name: 'app', exclusions: ['gen/', '../bad'] }, { name: 'noRoot' }],
        hiddenAuto: ['p_hidden', 5], autoExclusions: { p_z: ['screens/'], p_empty: [] },
      },
    },
  };
  const cfg = migrateConfig(v2);
  const rec = cfg.roots.k;
  assert.equal(rec.manual.length, 1, 'entries without a root are dropped');
  assert.equal(rec.manual[0].id, projectId('C:/x/app'));
  assert.deepEqual(rec.manual[0].exclusions, ['gen']);
  assert.deepEqual(rec.hiddenAuto, ['p_hidden']);
  assert.deepEqual(rec.autoExclusions, { p_z: ['screens'] });
});

test('isReasonableProjectRoot rejects drive roots and system dirs', () => {
  assert.equal(isReasonableProjectRoot('C:/'), false);
  assert.equal(isReasonableProjectRoot('C:\\Windows'), false);
  assert.equal(isReasonableProjectRoot('C:/Program Files'), false);
  assert.equal(isReasonableProjectRoot('C:/Users/me/AndroidStudioProjects/app'), true);
});

test('saveConfig writes atomically and loadConfig round-trips', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-reg-'));
  const file = path.join(dir, 'cfg.json');
  const cfg = { version: 2, roots: {} };
  const rec = getRootRecord(cfg, 'C:/root');
  rec.manual.push({ id: projectId('C:/x/app'), root: 'C:/x/app', name: 'app', exclusions: ['gen'] });
  await saveConfig(file, cfg);
  // No temp files left behind.
  const leftover = (await fs.readdir(dir)).filter((n) => n.includes('.tmp-'));
  assert.equal(leftover.length, 0, 'atomic write must not leave temp files');
  const back = await loadConfig(file);
  assert.equal(back.roots[rootKey('C:/root')].manual[0].name, 'app');
  await fs.rm(dir, { recursive: true, force: true });
});

test('loadConfig recovers from a corrupt file by quarantining it', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'cfk-reg-'));
  const file = path.join(dir, 'cfg.json');
  await fs.writeFile(file, '{ this is not json ');
  const cfg = await loadConfig(file);
  assert.deepEqual(cfg, { version: 2, roots: {} });
  const quarantined = (await fs.readdir(dir)).filter((n) => n.includes('.corrupt-'));
  assert.equal(quarantined.length, 1, 'corrupt config must be backed up, not deleted');
  await fs.rm(dir, { recursive: true, force: true });
});

test('buildProjectList merges auto + manual and dedups by canonical identity', () => {
  const cfg = { version: 2, roots: {} };
  const rec = getRootRecord(cfg, 'C:/root');
  rec.manual.push({ id: projectId('D:/ext/app'), root: 'D:/ext/app', name: 'app', exclusions: ['gen'] });
  // A manual entry that duplicates an auto project (same canonical path) is dropped.
  rec.manual.push({ id: projectId('C:/root/alpha'), root: 'C:/root/alpha', name: 'alpha', exclusions: [] });
  rec.hiddenAuto.push(projectId('C:/root/beta'));
  const list = buildProjectList({
    config: cfg, projectsRoot: 'C:/root',
    autoRoots: [{ name: 'alpha', root: 'C:/root/alpha' }, { name: 'beta', root: 'C:/root/beta' }],
    manualExists: () => true,
  });
  const alpha = list.filter((p) => p.name === 'alpha');
  assert.equal(alpha.length, 1, 'duplicate canonical path must appear once');
  assert.equal(alpha[0].source, 'auto', 'auto wins over a manual duplicate');
  const beta = list.find((p) => p.name === 'beta');
  assert.equal(beta.hidden, true);
  const ext = list.find((p) => p.root === 'D:/ext/app');
  assert.equal(ext.source, 'manual');
  assert.deepEqual(ext.exclusions, ['gen']);
});

test('buildProjectList flags manual projects whose folder is gone', () => {
  const cfg = { version: 2, roots: {} };
  getRootRecord(cfg, 'C:/root').manual.push({ id: projectId('D:/gone'), root: 'D:/gone', name: 'gone', exclusions: [] });
  const list = buildProjectList({ config: cfg, projectsRoot: 'C:/root', autoRoots: [], manualExists: () => false });
  assert.equal(list[0].missing, true);
});
