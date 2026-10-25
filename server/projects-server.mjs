#!/usr/bin/env node
/**
 * CodeFlowKotlin local multi-project server.
 * The original CodeFlow index.html and all existing views are served unchanged.
 * Adds only a project dropdown (+ Add Folder / Remove / Exclusions) via the
 * optional project-selector.js runtime overlay.
 * Start: node server/projects-server.mjs "C:\\Users\\MainPc\\AndroidStudioProjects"
 */
import http from 'node:http';
import { createSourceEditor, SourceEditError, EDIT_BODY_MAX_BYTES } from './source-editor.mjs';
import path from 'node:path';
import os from 'node:os';
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isAllowedProjectRequest, isSameOriginMutation, isValidCsrf,
  safeRequestPath, resolveSafeExistingPath, resolveSafeProjectPath,
  startFileWatchers, listWatchFiles, openBrowser, makeExcludeMatcher,
  bumpWatchRev, currentWatchRev, SOURCE_FILE_MAX_BYTES, shouldSkipName,
  isSourceCodeFile,
} from './server-utils.mjs';
import {
  loadConfig, saveConfig, getRootRecord, buildProjectList, projectId,
  normalizeExclusions, isReasonableProjectRoot, rootKey,
} from './project-registry.mjs';
import { pickFolder } from './pick-folder.mjs';
import { searchProjectRoot, SEARCH_LIMITS } from './project-search.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, '..');
const SELECTOR_FILENAME = 'project-selector.js';
const STATE_FILE = path.join(os.homedir(), '.codeflowkotlin-projects.json');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const MAX_JSON_BYTES = 16 * 1024;
const MAX_PROJECTS = 500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const MAX_EXCLUSIONS = 200;
const SKIP_PROJECT_NAMES = new Set(['.git', 'node_modules', 'build', 'dist', 'out', '.gradle', '.idea', '.cache', '.vscode']);

const makeKey = rootKey;
// A selected project can be deleted/moved while the server runs, so the live
// selection is re-validated against disk before it is reported or enumerated.
async function dirExists(p) {
  try { return !!p && (await fs.stat(p)).isDirectory(); } catch { return false; }
}
const mime = (p) => ({
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8', '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8', '.wasm': 'application/wasm',
  '.woff2': 'font/woff2', '.png': 'image/png', '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon', '.map': 'application/json; charset=utf-8',
})[path.extname(p).toLowerCase()] || 'application/octet-stream';

function json(res, status, data) {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(JSON.stringify(data));
}
function plain(res, status, value) {
  res.writeHead(status, { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-store' });
  res.end(value);
}
async function sendFile(res, fullPath, { contentType, maxBytes, revision } = {}) {
  let fd;
  try {
    fd = await fs.open(fullPath, 'r');
    const st = await fd.stat();
    if (!st.isFile()) return plain(res, 404, 'Not found');
    if (st.size > (maxBytes ?? MAX_BODY_BYTES)) return plain(res, 413, 'File too large');
    const buf = Buffer.alloc(st.size);
    let offset = 0;
    while (offset < buf.length) {
      const { bytesRead } = await fd.read(buf, offset, buf.length - offset, offset);
      if (bytesRead <= 0) break;
      offset += bytesRead;
    }
    const body = buf.subarray(0, offset);
    const headers = {
      'Content-Type': contentType || mime(fullPath),
      'Content-Length': String(body.length),
      'Cache-Control': 'no-store',
    };
    if (revision !== undefined) headers['X-Codeflow-Rev'] = String(revision);
    res.writeHead(200, headers);
    res.end(body);
  } catch {
    if (!res.headersSent) plain(res, 404, 'Not found');
  } finally {
    if (fd) await fd.close().catch(() => {});
  }
}

function parseJson(req, limit = MAX_JSON_BYTES) {
  return new Promise((resolve, reject) => {
    const buffers = []; let size = 0, rejected = false;
    req.on('data', (chunk) => {
      if (rejected) return;
      size += chunk.length;
      if (size > limit) { rejected = true; buffers.length = 0; reject(new Error('Payload too large')); return; }
      buffers.push(chunk);
    });
    req.on('end', () => {
      if (rejected) return;
      try { resolve(JSON.parse(Buffer.concat(buffers).toString('utf8'))); } catch (error) { reject(error); }
    });
    req.on('error', reject);
    req.on('aborted', () => reject(new Error('Request aborted')));
  });
}

export function parseArguments(argv) {
  const args = argv.slice(2);
  let projectsRoot = null;
  let port = DEFAULT_PORT;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--port' && args[i + 1]) port = Number(args[++i]);
    else if (args[i] === '--help' || args[i] === '-h') return { help: true };
    else if (!args[i].startsWith('-') && projectsRoot == null) projectsRoot = args[i];
    else throw new Error('Unknown argument: ' + args[i]);
  }
  if (!projectsRoot) throw new Error('Supply the parent AndroidStudioProjects directory');
  if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('Invalid --port');
  return { projectsRoot: path.resolve(projectsRoot), port };
}

export async function discoverProjects(projectsRoot) {
  const entries = await fs.readdir(projectsRoot, { withFileTypes: true });
  const dirs = entries
    .filter((e) => e.isDirectory() && !e.name.startsWith('.') && !shouldSkipName(e.name) && !SKIP_PROJECT_NAMES.has(e.name.toLowerCase()))
    .map((e) => e.name)
    .sort((a, b) => a.localeCompare(b));
  return dirs.slice(0, MAX_PROJECTS);
}

// Resolve the canonical root for an auto-discovered project name (immediate
// child of projectsRoot only — no traversal, no symlink escape).
export async function resolveProject(projectsRoot, projectName) {
  if (typeof projectName !== 'string' || !projectName || projectName === '.' || projectName === '..' ||
      projectName.includes('/') || projectName.includes('\\') || projectName.includes('\0')) return null;
  const projects = await discoverProjects(projectsRoot);
  if (!projects.includes(projectName)) return null;
  const folder = path.join(projectsRoot, projectName);
  const st = await fs.lstat(folder);
  if (!st.isDirectory() || st.isSymbolicLink()) return null;
  const realBase = await fs.realpath(projectsRoot);
  const realFolder = await fs.realpath(folder);
  if (path.dirname(realFolder) !== realBase) return null;
  return realFolder;
}

export function createProjectsServer({ projectsRoot, uiRoot = UI_ROOT, persist = true, configPath = STATE_FILE, pickFolderFn = pickFolder } = {}) {
  const clients = new Set();
  const csrfToken = crypto.randomBytes(18).toString('hex');
  let config = { version: 2, roots: {} };
  let currentId = null;
  let currentProject = null;
  let currentRoot = null;
  let currentExclusions = [];
  let watcher = null;
  let generation = 0;
  let revisions = new Map();
  let switching = Promise.resolve();
  let pickerBusy = false;
  const sourceEditor = createSourceEditor(() => ({ projectId: currentId, root: currentRoot, exclusions: currentExclusions, generation }));

  async function persistConfig() {
    if (!persist) return;
    await saveConfig(configPath, config).catch((e) => console.error('CodeFlowKotlin: could not save config:', e && e.message));
  }

  // Compose the live list: auto-discovered children + manual registrations.
  async function listProjects() {
    let autoNames = [];
    try { autoNames = await discoverProjects(projectsRoot); } catch {}
    let realBase = null;
    try { realBase = await fs.realpath(projectsRoot); } catch {}
    const autoRoots = [];
    for (const name of autoNames) {
      const folder = path.join(projectsRoot, name);
      try {
        const st = await fs.lstat(folder);
        if (!st.isDirectory() || st.isSymbolicLink()) continue;
        const realFolder = await fs.realpath(folder);
        if (realBase && path.dirname(realFolder) !== realBase) continue;
        autoRoots.push({ name, root: realFolder });
      } catch {}
    }
    const record = getRootRecord(config, projectsRoot);
    const existsSet = new Set();
    for (const m of record.manual) {
      if (await dirExists(m.root)) existsSet.add(makeKey(m.root));
    }
    return buildProjectList({
      config, projectsRoot, autoRoots,
      manualExists: (root) => existsSet.has(makeKey(root)),
    });
  }

  async function resolveSelection(idOrName) {
    const list = await listProjects();
    let entry = list.find((p) => p.id === idOrName);
    if (!entry) entry = list.find((p) => p.source === 'auto' && p.name === idOrName);
    return entry || null;
  }

  function closeWatch() {
    generation++;
    if (watcher) watcher.close();
    watcher = null;
    revisions = new Map();
  }
  function openWatch() {
    const thisGeneration = generation;
    const isExcluded = makeExcludeMatcher(currentExclusions);
    watcher = startFileWatchers(currentRoot, (rel) => {
      if (thisGeneration !== generation) return;
      const file = String(rel).replace(/\\/g, '/');
      const rev = bumpWatchRev(revisions, file);
      const event = 'data: ' + JSON.stringify({ type: 'change', path: file, rev }) + '\n\n';
      for (const client of clients) {
        try { client.write(event); } catch { clients.delete(client); }
      }
    }, undefined, isExcluded);
  }

  function dropClients() {
    for (const client of clients) {
      try { client.end(); } catch {}
    }
    clients.clear();
  }

  async function changeProject(idOrName) {
    // Serialize changes, so a quick second selection cannot create 2 watchers.
    const task = switching.then(async () => {
      const entry = await resolveSelection(idOrName);
      if (!entry) throw new Error('Project not found');
      const realRoot = await fs.realpath(entry.root).catch(() => null);
      if (!realRoot || !(await dirExists(realRoot))) throw new Error('Project folder is missing');
      if (currentId === entry.id && currentRoot === realRoot) {
        // Still refresh exclusions in case they changed.
        currentExclusions = normalizeExclusions(entry.exclusions);
        return;
      }
      closeWatch();
      currentId = entry.id;
      currentProject = entry.name;
      currentRoot = realRoot;
      currentExclusions = normalizeExclusions(entry.exclusions);
      openWatch();
      dropClients();
      getRootRecord(config, projectsRoot).selected = entry.id;
      await persistConfig();
      console.log('Watching project: ' + realRoot);
    });
    switching = task.catch(() => {});
    return task;
  }

  function clearActive() {
    closeWatch();
    currentId = null;
    currentProject = null;
    currentRoot = null;
    currentExclusions = [];
    dropClients();
  }

  // ---- Registry mutations (always update in-memory config; persist if enabled)
  async function addManualProject(folderPath) {
    if (typeof folderPath !== 'string' || !folderPath) return { error: 'invalid-path' };
    let canonical;
    try { canonical = await fs.realpath(folderPath); } catch { return { error: 'not-found' }; }
    const st = await fs.stat(canonical).catch(() => null);
    if (!st || !st.isDirectory()) return { error: 'not-a-directory' };
    if (!isReasonableProjectRoot(canonical)) return { error: 'unsafe-root' };
    const id = projectId(canonical);
    const list = await listProjects();
    if (list.some((p) => p.id === id)) return { error: 'already-registered', id };
    const record = getRootRecord(config, projectsRoot);
    record.manual.push({ id, root: canonical, name: path.basename(canonical) || canonical, exclusions: [] });
    await persistConfig();
    return { id, root: canonical, name: path.basename(canonical) || canonical };
  }

  async function removeProject(id) {
    const record = getRootRecord(config, projectsRoot);
    const idx = record.manual.findIndex((m) => m.id === id);
    if (idx < 0) return { error: 'not-manual' };
    record.manual.splice(idx, 1);
    delete record.autoExclusions[id];
    if (record.selected === id) record.selected = null;
    if (currentId === id) clearActive();
    await persistConfig();
    return { ok: true };
  }

  async function setHidden(id, hidden) {
    const entry = (await listProjects()).find((p) => p.id === id);
    if (!entry || entry.source !== 'auto') return { error: 'not-auto' };
    const record = getRootRecord(config, projectsRoot);
    const set = new Set(record.hiddenAuto);
    if (hidden) set.add(id); else set.delete(id);
    record.hiddenAuto = [...set];
    if (hidden && record.selected === id) record.selected = null;
    if (hidden && currentId === id) clearActive();
    await persistConfig();
    return { ok: true, hidden: !!hidden };
  }

  async function setExclusions(id, exclusions) {
    const entry = (await listProjects()).find((p) => p.id === id);
    if (!entry) return { error: 'unknown-project' };
    const norm = normalizeExclusions(exclusions).slice(0, MAX_EXCLUSIONS);
    for (const ex of norm) {
      if (!resolveSafeProjectPath(entry.root, ex)) return { error: 'unsafe-exclusion', value: ex };
    }
    const record = getRootRecord(config, projectsRoot);
    if (entry.source === 'manual') {
      const m = record.manual.find((x) => x.id === id);
      if (m) m.exclusions = norm;
    } else if (norm.length) {
      record.autoExclusions[id] = norm;
    } else {
      delete record.autoExclusions[id];
    }
    if (currentId === id) {
      currentExclusions = norm;
      closeWatch();
      openWatch();
      dropClients();
    }
    await persistConfig();
    return { ok: true, exclusions: norm };
  }

  function mutationGuard(req, res) {
    if (req.method !== 'POST') { plain(res, 405, 'Method not allowed'); return false; }
    if (!isSameOriginMutation(req) || !isValidCsrf(req, csrfToken)) { plain(res, 403, 'Forbidden'); return false; }
    return true;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedProjectRequest(req)) return plain(res, 403, 'Forbidden');
      const parsed = safeRequestPath(req.url);
      if (!parsed.ok) return plain(res, parsed.status, 'Invalid request');
      const { url, pathname } = parsed;

      if (pathname === '/__codeflow/projects') {
        if (req.method !== 'GET') return plain(res, 405, 'Method not allowed');
        return json(res, 200, {
          root: projectsRoot,
          projects: await listProjects(),
          selected: currentId,
          csrf: csrfToken,
        });
      }

      if (pathname === '/__codeflow/select-project') {
        if (!mutationGuard(req, res)) return;
        let data;
        try { data = await parseJson(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        const idOrName = typeof data.id === 'string' ? data.id : data.project;
        try {
          await changeProject(idOrName);
          return json(res, 200, { ok: true, selected: currentId });
        } catch { return json(res, 400, { error: 'Unknown project' }); }
      }

      if (pathname === '/__codeflow/pick-folder') {
        if (!mutationGuard(req, res)) return;
        if (pickerBusy) return json(res, 409, { status: 'busy' });
        pickerBusy = true;
        try {
          const result = await pickFolderFn({});
          return json(res, 200, result);
        } finally {
          pickerBusy = false;
        }
      }

      if (pathname === '/__codeflow/add-project') {
        if (!mutationGuard(req, res)) return;
        let data;
        try { data = await parseJson(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        const result = await addManualProject(data && data.path);
        if (result.error) return json(res, result.error === 'already-registered' ? 409 : 400, result);
        try { await changeProject(result.id); } catch {}
        return json(res, 200, { ok: true, id: result.id, selected: currentId, projects: await listProjects() });
      }

      if (pathname === '/__codeflow/remove-project') {
        if (!mutationGuard(req, res)) return;
        let data;
        try { data = await parseJson(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        const result = await removeProject(data && data.id);
        if (result.error) return json(res, 400, result);
        return json(res, 200, { ok: true, selected: currentId, projects: await listProjects() });
      }

      if (pathname === '/__codeflow/set-hidden') {
        if (!mutationGuard(req, res)) return;
        let data;
        try { data = await parseJson(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        const result = await setHidden(data && data.id, !!(data && data.hidden));
        if (result.error) return json(res, 400, result);
        return json(res, 200, { ok: true, selected: currentId, projects: await listProjects() });
      }

      if (pathname === '/__codeflow/set-exclusions') {
        if (!mutationGuard(req, res)) return;
        let data;
        try { data = await parseJson(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        const result = await setExclusions(data && data.id, data && data.exclusions);
        if (result.error) return json(res, 400, result);
        return json(res, 200, { ok: true, exclusions: result.exclusions, selected: currentId });
      }

      if (pathname === '/__codeflow/dirs') {
        // Read-only directory listing for the project-scoped exclusion picker.
        if (req.method !== 'GET') return plain(res, 405, 'Method not allowed');
        const id = url.searchParams.get('id') || '';
        const rel = url.searchParams.get('rel') || '';
        const entry = (await listProjects()).find((p) => p.id === id);
        if (!entry) return json(res, 404, { error: 'unknown-project' });
        const base = await fs.realpath(entry.root).catch(() => null);
        if (!base) return json(res, 410, { error: 'project-missing' });
        const dir = rel ? await resolveSafeExistingPath(base, rel) : base;
        if (!dir) return json(res, 404, { error: 'not-found' });
        const isExcluded = makeExcludeMatcher(entry.exclusions);
        let entries = [];
        try { entries = await fs.readdir(dir, { withFileTypes: true }); } catch { return json(res, 404, { error: 'not-found' }); }
        const dirs = entries
          .filter((e) => e.isDirectory() && !shouldSkipName(e.name))
          .map((e) => (rel ? rel.replace(/\/+$/, '') + '/' + e.name : e.name).replace(/\\/g, '/'))
          .filter((childRel) => !isExcluded(childRel))
          .sort((a, b) => a.localeCompare(b));
        return json(res, 200, { rel, dirs });
      }

      if (pathname === '/__codeflow/edit-source') {
        if (req.method !== 'GET' && req.method !== 'POST') return plain(res, 405, 'Method not allowed');
        if (req.method === 'POST' && !mutationGuard(req, res)) return;
        try {
          if (req.method === 'GET') return json(res, 200, sourceEditor.read(url.searchParams.get('pid'), url.searchParams.get('path')));
          let input;
          try { input = await parseJson(req, EDIT_BODY_MAX_BYTES); }
          catch (error) { return json(res, error.message === 'Payload too large' ? 413 : 400, { error: 'Invalid or oversized source payload' }); }
          const saved = sourceEditor.save(input);
          const rev = bumpWatchRev(revisions, saved.path);
          const event = 'data: ' + JSON.stringify({ type: 'change', path: saved.path, rev }) + '\n\n';
          for (const client of clients) { try { client.write(event); } catch { clients.delete(client); } }
          return json(res, 200, saved);
        } catch (error) {
          if (error instanceof SourceEditError) return json(res, error.status, { code: error.code, error: error.message });
          throw error;
        }
      }

      if (pathname === '/__codeflow/status') {
        const live = await dirExists(currentRoot);
        return json(res, 200, {
          ok: live, root: currentRoot, name: currentProject,
          id: live ? makeKey(currentRoot) : null, // stable identity (canonical root), not the display name
          pid: live ? currentId : null,
          exclusions: live ? currentExclusions : [],
          watch: !!(watcher && watcher.watching) && live,
          missing: !!currentProject && !live,
        });
      }

      if (pathname === '/__codeflow/files') {
        if (!currentProject || !currentRoot) return json(res, 409, { error: 'No project selected', code: 'no-project' });
        const root = currentRoot, pid = currentId, exclusions = currentExclusions;
        const wantPid = url.searchParams.get('pid');
        if (wantPid && wantPid !== pid) return json(res, 409, { error: 'Active project changed', code: 'project-changed' });
        if (!(await dirExists(root))) return json(res, 410, { error: 'Project folder is missing', code: 'project-missing' });
        const files = await listWatchFiles(root, makeExcludeMatcher(exclusions));
        if (pid !== currentId || exclusions !== currentExclusions) return json(res, 409, { error: 'Project scope changed', code: 'project-changed' });
        return json(res, 200, { files, exclusions, pid });
      }

      if (pathname === '/__codeflow/search') {
        // Read-only, same-origin-guarded (top-level isAllowedProjectRequest) content
        // search scoped to the ACTIVE project only. The root is never taken from
        // the client — it is the authorized currentRoot — and the active project's
        // exclusions are enforced, so excluded files never appear or are read.
        if (req.method !== 'GET') return plain(res, 405, 'Method not allowed');
        if (!currentProject || !currentRoot) return json(res, 409, { error: 'No project selected', code: 'no-project' });
        if (!(await dirExists(currentRoot))) return json(res, 410, { error: 'Project folder is missing', code: 'project-missing' });
        const wantPid = url.searchParams.get('pid');
        if (wantPid && wantPid !== currentId) return json(res, 409, { error: 'Active project changed', code: 'project-changed', pid: currentId });
        const query = url.searchParams.get('q') || '';
        const options = {
          query,
          caseSensitive: url.searchParams.get('case') === '1',
          wholeWord: url.searchParams.get('word') === '1',
          regex: url.searchParams.get('regex') === '1',
          include: url.searchParams.get('include') || '',
          exclude: url.searchParams.get('exclude') || '',
        };
        let aborted = false;
        req.on('close', () => { aborted = true; });
        const outcome = await searchProjectRoot(currentRoot, Object.assign({}, options, {
          isExcluded: makeExcludeMatcher(currentExclusions),
          isAborted: () => aborted,
          limits: SEARCH_LIMITS,
        }));
        if (outcome.error) return json(res, 400, { error: outcome.error, code: outcome.error });
        return json(res, 200, {
          pid: currentId,
          query,
          options: { caseSensitive: options.caseSensitive, wholeWord: options.wholeWord, regex: options.regex, include: options.include, exclude: options.exclude },
          rev: url.searchParams.get('rev') || null,
          results: outcome.results,
          stats: outcome.stats,
          truncated: outcome.truncated,
          reasons: outcome.reasons,
          limits: SEARCH_LIMITS,
        });
      }

      if (pathname === '/__codeflow/file') {
        if (!currentRoot) return plain(res, 409, 'Select a project');
        const root = currentRoot, pid = currentId, exclusions = currentExclusions;
        const wantPid = url.searchParams.get('pid');
        if (wantPid && wantPid !== pid) return plain(res, 409, 'Active project changed');
        const rel = url.searchParams.get('path') || '';
        // Source-code only: never read Markdown/docs/data/binary content, even if
        // the path is inside the authorized project.
        if (!isSourceCodeFile(String(rel).split('/').pop())) return plain(res, 404, 'Not found');
        const isExcluded = makeExcludeMatcher(exclusions);
        if (isExcluded(rel)) return plain(res, 404, 'Not found'); // excluded files are not readable
        const file = await resolveSafeExistingPath(root, rel);
        if (!file) return plain(res, 404, 'Not found');
        if (pid !== currentId || exclusions !== currentExclusions) return plain(res, 409, 'Project scope changed');
        // Sampling the revision before opening matches CodeFlow's existing watcher semantics.
        const rev = currentWatchRev(revisions, rel);
        return sendFile(res, file, { contentType: 'text/plain; charset=utf-8', maxBytes: SOURCE_FILE_MAX_BYTES, revision: rev });
      }

      if (pathname === '/__codeflow/events') {
        if (!currentRoot) return plain(res, 409, 'Select a project');
        res.writeHead(200, {
          'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive',
        });
        res.write(': connected\n\n');
        clients.add(res);
        req.on('close', () => clients.delete(res));
        return;
      }

      if (pathname === '/__codeflow/project-selector.js') {
        const file = path.join(HERE, SELECTOR_FILENAME);
        return sendFile(res, file, { contentType: 'text/javascript; charset=utf-8' });
      }

      const rel = pathname === '/' ? 'index.html' : pathname.replace(/^\/+/, '');
      const file = await resolveSafeExistingPath(uiRoot, rel);
      if (!file) return plain(res, 404, 'Not found');
      if (rel === 'index.html') {
        let html = await fs.readFile(file, 'utf8');
        // Do not edit index.html or its visualizations. Inject only the project dropdown controller.
        const script = '<script defer src="/__codeflow/project-selector.js"></script>';
        if (!/<\/body\s*>/i.test(html)) return plain(res, 500, 'Missing HTML body');
        html = html.replace(/<\/body\s*>/i, script + '\n</body>');
        const body = Buffer.from(html, 'utf8');
        res.writeHead(200, {
          'Content-Type': 'text/html; charset=utf-8', 'Content-Length': String(body.length),
          'Cache-Control': 'no-store',
        });
        res.end(body);
        return;
      }
      return sendFile(res, file, { maxBytes: 100 * 1024 * 1024 });
    } catch (error) {
      console.error('CodeFlowKotlin request error:', error && error.message);
      if (!res.headersSent) plain(res, 500, 'Internal server error');
      else if (!res.writableEnded) res.end();
    }
  });

  return {
    server,
    changeProject,
    // Exposed for tests / tooling.
    _registry: {
      listProjects, addManualProject, removeProject, setHidden, setExclusions,
      get config() { return config; },
      get csrf() { return csrfToken; },
    },
    async restore() {
      config = await loadConfig(configPath);
      const record = getRootRecord(config, projectsRoot);
      let selected = record.selected;
      if (!selected && record.selectedName) {
        const byName = (await listProjects()).find((p) => p.source === 'auto' && p.name === record.selectedName);
        if (byName) selected = byName.id;
      }
      if (selected) await changeProject(selected).catch(() => {});
    },
    async close() {
      clearActive();
      if (server.listening) await new Promise((resolve) => server.close(resolve));
    },
  };
}

async function main() {
  const parsed = parseArguments(process.argv);
  if (parsed.help) {
    console.log('Usage: node server/projects-server.mjs "C:\\Users\\MainPc\\AndroidStudioProjects" [--port 4173]');
    return;
  }
  const st = await fs.stat(parsed.projectsRoot).catch(() => null);
  if (!st || !st.isDirectory()) throw new Error('Folder does not exist: ' + parsed.projectsRoot);
  const app = createProjectsServer({ projectsRoot: await fs.realpath(parsed.projectsRoot) });
  await app.restore();
  await new Promise((resolve, reject) => {
    app.server.once('error', reject);
    app.server.listen(parsed.port, HOST, resolve);
  });
  const url = 'http://' + HOST + ':' + parsed.port + '/';
  console.log('CodeFlowKotlin: ' + url);
  console.log('Projects directory: ' + parsed.projectsRoot);
  console.log('Use the Project dropdown in the existing CodeFlow header.');
  openBrowser(url);
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch((e) => { console.error(e.message); process.exitCode = 1; });
}
