// Persistent project registry for the CodeFlowKotlin local server.
//
// Extends the original ~/.codeflowkotlin-projects.json (which stored only a
// per-root selected project name) into a versioned store that also holds
// manually-registered external folders, per-project exclusions and hidden
// auto-discovered projects. All logic here is pure/fs-light so it can be unit
// tested without an HTTP server.
//
// Identity: a project's stable id is derived from the *canonical* absolute root
// (realpath, trailing separators stripped, lower-cased for comparison). Two
// folders named `app` in different parents therefore get different ids, and the
// same folder — however the path is spelled (case, redundant separators) — maps
// to one id. Ids are opaque tokens, never an authorization to read an arbitrary
// path: an id is honoured only when it resolves to a registered/auto project.

import { promises as fs } from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';

export const CONFIG_VERSION = 2;

// Canonical comparison key for a filesystem root (case/separator-insensitive).
export function rootKey(p) {
  return path.resolve(String(p || '')).replace(/[\\/]+$/, '').toLowerCase();
}

// Stable, opaque project id derived from the canonical root.
export function projectId(root) {
  return 'p_' + crypto.createHash('sha1').update(rootKey(root)).digest('hex').slice(0, 16);
}

// Normalize a user-supplied exclusion into a safe relative POSIX path, or null
// if it escapes the project (absolute, drive-letter, `..`, empty).
export function normalizeExclusion(input) {
  let rel = String(input == null ? '' : input).replace(/\\/g, '/').trim();
  rel = rel.replace(/^\/+/, '').replace(/\/+$/, '');
  if (!rel) return null;
  if (/^[a-zA-Z]:/.test(rel)) return null; // drive-letter absolute
  const parts = rel.split('/').filter(Boolean);
  if (!parts.length) return null;
  for (const part of parts) {
    if (part === '.' || part === '..' || part.includes('\0')) return null;
  }
  return parts.join('/');
}

export function normalizeExclusions(list) {
  const out = [];
  for (const item of Array.isArray(list) ? list : []) {
    const norm = normalizeExclusion(item);
    if (norm && !out.includes(norm)) out.push(norm);
  }
  out.sort();
  return out;
}

function emptyRootRecord() {
  return { selected: null, selectedName: null, manual: [], autoExclusions: {}, hiddenAuto: [] };
}

// Parse + migrate a raw config object into the v2 shape. Never throws.
export function migrateConfig(raw) {
  const config = { version: CONFIG_VERSION, roots: {} };
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return config;

  if (raw.version === CONFIG_VERSION && raw.roots && typeof raw.roots === 'object') {
    for (const [key, rec] of Object.entries(raw.roots)) {
      config.roots[key] = sanitizeRootRecord(rec);
    }
    return config;
  }

  // v1 (or unknown): a flat map of rootKey -> selected project *name* string.
  for (const [key, value] of Object.entries(raw)) {
    if (key === 'version' || key === 'roots') continue;
    const rec = emptyRootRecord();
    if (typeof value === 'string' && value) rec.selectedName = value;
    config.roots[key] = rec;
  }
  return config;
}

function sanitizeRootRecord(rec) {
  const out = emptyRootRecord();
  if (!rec || typeof rec !== 'object') return out;
  out.selected = typeof rec.selected === 'string' ? rec.selected : null;
  out.selectedName = typeof rec.selectedName === 'string' ? rec.selectedName : null;
  out.hiddenAuto = Array.isArray(rec.hiddenAuto) ? rec.hiddenAuto.filter((x) => typeof x === 'string') : [];
  out.manual = [];
  for (const entry of Array.isArray(rec.manual) ? rec.manual : []) {
    if (!entry || typeof entry !== 'object') continue;
    const root = typeof entry.root === 'string' ? entry.root : '';
    if (!root) continue;
    out.manual.push({
      id: typeof entry.id === 'string' && entry.id ? entry.id : projectId(root),
      root,
      name: typeof entry.name === 'string' && entry.name ? entry.name : path.basename(root),
      exclusions: normalizeExclusions(entry.exclusions),
    });
  }
  out.autoExclusions = {};
  if (rec.autoExclusions && typeof rec.autoExclusions === 'object') {
    for (const [id, list] of Object.entries(rec.autoExclusions)) {
      const norm = normalizeExclusions(list);
      if (norm.length) out.autoExclusions[id] = norm;
    }
  }
  return out;
}

export function getRootRecord(config, projectsRoot) {
  const key = rootKey(projectsRoot);
  if (!config.roots[key]) config.roots[key] = emptyRootRecord();
  return config.roots[key];
}

// Load + migrate the config file. Corrupt files are backed up and treated as
// empty (controlled recovery) rather than crashing the server.
export async function loadConfig(configPath) {
  let text;
  try {
    text = await fs.readFile(configPath, 'utf8');
  } catch {
    return { version: CONFIG_VERSION, roots: {} };
  }
  try {
    return migrateConfig(JSON.parse(text));
  } catch {
    try {
      await fs.rename(configPath, configPath + '.corrupt-' + Date.now());
    } catch {}
    return { version: CONFIG_VERSION, roots: {} };
  }
}

// Atomic write: write to a temp sibling then rename over the target.
export async function saveConfig(configPath, config) {
  const payload = JSON.stringify({ version: CONFIG_VERSION, roots: config.roots || {} }, null, 2);
  const tmp = configPath + '.tmp-' + process.pid + '-' + Date.now();
  await fs.writeFile(tmp, payload, { mode: 0o600 });
  try {
    await fs.rename(tmp, configPath);
  } catch (err) {
    await fs.rm(tmp, { force: true }).catch(() => {});
    throw err;
  }
}

// A drive root (`C:\`, `/`) or the Windows directory is never a project root.
export function isReasonableProjectRoot(p) {
  const resolved = path.resolve(String(p || ''));
  const parsed = path.parse(resolved);
  if (resolved === parsed.root) return false; // bare drive / filesystem root
  const lower = resolved.toLowerCase().replace(/[\\/]+$/, '');
  const windir = (process.env.SystemRoot || process.env.windir || 'C:\\Windows').toLowerCase().replace(/[\\/]+$/, '');
  if (lower === windir) return false;
  const banned = ['c:\\windows', 'c:\\program files', 'c:\\program files (x86)', 'c:\\programdata'];
  if (banned.includes(lower)) return false;
  return true;
}

// Compose the live project list: auto-discovered + manually registered, with
// per-project exclusions/hidden flags merged in. `autoRoots` is a list of
// { name, root } for the auto-discovered projects (caller resolves disk).
export function buildProjectList({ config, projectsRoot, autoRoots = [], manualExists = () => true }) {
  const record = getRootRecord(config, projectsRoot);
  const seen = new Set();
  const projects = [];

  for (const { name, root } of autoRoots) {
    const id = projectId(root);
    if (seen.has(id)) continue;
    seen.add(id);
    projects.push({
      id,
      name,
      root,
      parent: path.dirname(root),
      source: 'auto',
      missing: false,
      hidden: record.hiddenAuto.includes(id),
      exclusions: normalizeExclusions(record.autoExclusions[id]),
    });
  }

  for (const entry of record.manual) {
    if (seen.has(entry.id)) continue; // a manual dup of an auto project: auto wins
    seen.add(entry.id);
    projects.push({
      id: entry.id,
      name: entry.name,
      root: entry.root,
      parent: path.dirname(entry.root),
      source: 'manual',
      missing: !manualExists(entry.root),
      hidden: false,
      exclusions: normalizeExclusions(entry.exclusions),
    });
  }

  projects.sort((a, b) => a.name.localeCompare(b.name) || a.root.localeCompare(b.root));
  return projects;
}

export function findProject(list, id) {
  return list.find((p) => p.id === id) || null;
}
