#!/usr/bin/env node
/**
 * CodeFlowKotlin local multi-project selector.
 * The original CodeFlow index.html and all existing views are served unchanged.
 * Adds only a dropdown via the optional project-selector.js runtime overlay.
 * Start: node cli/projects-server.mjs "C:\\Users\\MainPc\\AndroidStudioProjects"
 */
import http from 'node:http';
import path from 'node:path';
import os from 'node:os';
import { promises as fs } from 'node:fs';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  isAllowedCliRequest, safeRequestPath, resolveSafeExistingPath,
  startFileWatchers, listWatchFiles, openBrowser,
  bumpWatchRev, currentWatchRev, CLI_FILE_MAX_BYTES, shouldSkipName,
} from './server-utils.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const UI_ROOT = path.resolve(HERE, '..');
const SELECTOR_FILENAME = 'project-selector.js';
const STATE_FILE = path.join(os.homedir(), '.codeflowkotlin-projects.json');
const HOST = '127.0.0.1';
const DEFAULT_PORT = 4173;
const MAX_JSON_BYTES = 8192;
const MAX_PROJECTS = 500;
const MAX_BODY_BYTES = 2 * 1024 * 1024;
const SKIP_PROJECT_NAMES = new Set(['.git', 'node_modules', 'build', 'dist', 'out', '.gradle', '.idea', '.cache', '.vscode']);

const makeKey = (p) => path.resolve(p).replace(/[\\/]+$/, '').toLowerCase();
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

async function parseJson(req) {
  const buffers = [];
  let size = 0;
  for await (const chunk of req) {
    size += chunk.length;
    if (size > MAX_JSON_BYTES) throw new Error('Payload too large');
    buffers.push(chunk);
  }
  return JSON.parse(Buffer.concat(buffers).toString('utf8'));
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

async function savedSelection(root) {
  try {
    const obj = JSON.parse(await fs.readFile(STATE_FILE, 'utf8'));
    return typeof obj[makeKey(root)] === 'string' ? obj[makeKey(root)] : null;
  } catch { return null; }
}
async function rememberSelection(root, project) {
  let obj = {};
  try { obj = JSON.parse(await fs.readFile(STATE_FILE, 'utf8')); } catch {}
  if (!obj || typeof obj !== 'object' || Array.isArray(obj)) obj = {};
  obj[makeKey(root)] = project;
  await fs.writeFile(STATE_FILE, JSON.stringify(obj, null, 2), { mode: 0o600 });
}

export function createProjectsServer({ projectsRoot, uiRoot = UI_ROOT, persist = true } = {}) {
  const clients = new Set();
  let currentProject = null;
  let currentRoot = null;
  let watcher = null;
  let generation = 0;
  let revisions = new Map();
  let switching = Promise.resolve();

  function closeWatch() {
    generation++;
    if (watcher) watcher.close();
    watcher = null;
    revisions = new Map();
  }
  async function changeProject(project) {
    // Serialize changes, so a quick second selection cannot create 2 watchers.
    const task = switching.then(async () => {
      const nextRoot = await resolveProject(projectsRoot, project);
      if (!nextRoot) throw new Error('Project not found');
      if (currentProject === project && currentRoot === nextRoot) return;
      closeWatch();
      currentProject = project;
      currentRoot = nextRoot;
      const thisGeneration = generation;
      watcher = startFileWatchers(nextRoot, (rel) => {
        if (thisGeneration !== generation) return;
        const file = String(rel).replace(/\\/g, '/');
        const rev = bumpWatchRev(revisions, file);
        const event = 'data: ' + JSON.stringify({ type: 'change', path: file, rev }) + '\n\n';
        for (const client of clients) {
          try { client.write(event); } catch { clients.delete(client); }
        }
      });
      for (const client of clients) {
        try { client.end(); } catch {}
      }
      clients.clear();
      if (persist) await rememberSelection(projectsRoot, project).catch(() => {});
      console.log('Watching project: ' + nextRoot);
    });
    switching = task.catch(() => {});
    return task;
  }

  const server = http.createServer(async (req, res) => {
    try {
      if (!isAllowedCliRequest(req)) return plain(res, 403, 'Forbidden');
      const parsed = safeRequestPath(req.url);
      if (!parsed.ok) return plain(res, parsed.status, 'Invalid request');
      const { url, pathname } = parsed;
      if (pathname === '/__codeflow/projects') {
        if (req.method !== 'GET') return plain(res, 405, 'Method not allowed');
        return json(res, 200, { root: projectsRoot, projects: await discoverProjects(projectsRoot), selected: currentProject });
      }
      if (pathname === '/__codeflow/select-project') {
        if (req.method !== 'POST') return plain(res, 405, 'Method not allowed');
        let data;
        try { data = await parseJson(req); } catch { return json(res, 400, { error: 'Invalid JSON' }); }
        try {
          await changeProject(data.project);
          return json(res, 200, { ok: true, selected: currentProject });
        } catch { return json(res, 400, { error: 'Unknown project' }); }
      }
      if (pathname === '/__codeflow/status') {
        const live = await dirExists(currentRoot);
        return json(res, 200, {
          ok: live, root: currentRoot, name: currentProject,
          watch: !!(watcher && watcher.watching) && live,
          missing: !!currentProject && !live,
        });
      }
      if (pathname === '/__codeflow/files') {
        if (!currentProject || !currentRoot) return json(res, 409, { error: 'No project selected', code: 'no-project' });
        if (!(await dirExists(currentRoot))) return json(res, 410, { error: 'Project folder is missing', code: 'project-missing' });
        return json(res, 200, { files: await listWatchFiles(currentRoot) });
      }
      if (pathname === '/__codeflow/file') {
        if (!currentRoot) return plain(res, 409, 'Select a project');
        const rel = url.searchParams.get('path') || '';
        const file = await resolveSafeExistingPath(currentRoot, rel);
        if (!file) return plain(res, 404, 'Not found');
        // Sampling the revision before opening matches CodeFlow's existing watcher semantics.
        const rev = currentWatchRev(revisions, rel);
        return sendFile(res, file, { contentType: 'text/plain; charset=utf-8', maxBytes: CLI_FILE_MAX_BYTES, revision: rev });
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
    async restore() {
      if (persist) {
        const last = await savedSelection(projectsRoot);
        if (last) await changeProject(last).catch(() => {});
      }
    },
    async close() {
      closeWatch();
      for (const client of clients) {
        try { client.end(); } catch {}
      }
      clients.clear();
      if (server.listening) await new Promise(resolve => server.close(resolve));
    },
  };
}

async function main() {
  const parsed = parseArguments(process.argv);
  if (parsed.help) {
    console.log('Usage: node cli/projects-server.mjs "C:\\Users\\MainPc\\AndroidStudioProjects" [--port 4173]');
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
  const url = 'http://' + HOST + ':' + parsed.port + '/?cli=1';
  console.log('CodeFlowKotlin: ' + url);
  console.log('Projects directory: ' + parsed.projectsRoot);
  console.log('Use the Project dropdown in the existing CodeFlow header.');
  openBrowser(url);
  const shutdown = () => app.close().then(() => process.exit(0));
  process.on('SIGINT', shutdown);
  process.on('SIGTERM', shutdown);
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main().catch(e => { console.error(e.message); process.exitCode = 1; });
}
