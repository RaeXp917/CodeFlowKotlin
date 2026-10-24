// Shared local-server utilities for the CodeFlowKotlin local application server
// (cli/projects-server.mjs): secure path resolution, project source enumeration,
// file watching, revision tracking, localhost request validation and the browser
// launcher. These were previously housed in the now-removed standalone CLI.

import { promises as fs, watch } from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const IGNORE = new Set([
  'node_modules', '.git', 'vendor', 'dist', 'build', 'out', 'coverage',
  '.next', '.nuxt', '.cache', '.parcel-cache', '.turbo', '.vercel', '.local',
  '.artifacts', '.playwright-cli', 'playwright-report', 'test-results',
  '.claude', '.codex', '.idea', '.vscode', '.pnpm-store', '.yarn', 'tmp',
  'temp', 'target', 'bin', 'obj', '__pycache__', '.venv', 'venv', 'env',
  '.tox', '.mypy_cache', '.pytest_cache', '.ruff_cache', '__pypackages__',
  '.eggs', '__macosx'
]);

const TEXT_EXT = new Set([
  'js', 'jsx', 'ts', 'tsx', 'mjs', 'cjs', 'py', 'java', 'go', 'rb', 'php',
  'vue', 'svelte', 'rs', 'c', 'h', 'cpp', 'cc', 'cxx', 'hpp', 'hh', 'hxx',
  'cs', 'swift', 'kt', 'kts', 'scala', 'sc', 'groovy', 'gvy', 'ex', 'exs',
  'erl', 'hrl', 'hs', 'lhs', 'lua', 'r', 'jl', 'dart', 'pl', 'pm', 'sh',
  'bash', 'zsh', 'fish', 'ps1', 'psm1', 'psd1', 'fs', 'fsi', 'fsx', 'ml',
  'mli', 'clj', 'cljs', 'cljc', 'elm', 'vba', 'bas', 'cls', 'pas', 'pp',
  'dpr', 'dpk', 'lpr', 'inc', 'html', 'htm', 'xhtml', 'md', 'markdown',
  'json', 'yml', 'yaml', 'toml', 'css', 'scss', 'sql'
]);

const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '::ffff:127.0.0.1']);

export function pathStaysInRoot(root, candidate) {
  const rootPath = path.resolve(String(root || ''));
  const full = path.resolve(String(candidate || ''));
  const prefix = rootPath.endsWith(path.sep) ? rootPath : rootPath + path.sep;
  return full === rootPath || full.startsWith(prefix);
}

export function resolveSafeCliPath(root, relPath) {
  const rootPath = path.resolve(String(root || ''));
  const rel = String(relPath || '').replace(/\\/g, '/');
  if (!rel || rel.startsWith('/') || rel.split('/').includes('..')) return null;
  const full = path.resolve(rootPath, rel);
  if (!pathStaysInRoot(rootPath, full)) return null;
  return full;
}

export async function resolveSafeExistingPath(root, relPath) {
  const lexical = resolveSafeCliPath(root, relPath);
  if (!lexical) return null;
  try {
    const realRoot = await fs.realpath(root);
    const realFile = await fs.realpath(lexical);
    if (!pathStaysInRoot(realRoot, realFile)) return null;
    return realFile;
  } catch {
    return null;
  }
}

export function loopbackHostName(hostHeader) {
  let host = String(hostHeader || '').trim().toLowerCase();
  if (!host) return '';
  if (host.startsWith('[')) {
    const end = host.indexOf(']');
    if (end < 0) return '';
    host = host.slice(1, end);
  } else {
    const colon = host.lastIndexOf(':');
    if (colon > 0 && host.indexOf(':') === colon) host = host.slice(0, colon);
  }
  if (host.endsWith('.')) host = host.slice(0, -1);
  return host;
}

export function isLoopbackHost(hostHeader) {
  return LOOPBACK_HOSTS.has(loopbackHostName(hostHeader));
}

export function isAllowedCliRequest(req) {
  const headers = req && req.headers ? req.headers : (req || {});
  if (!isLoopbackHost(headers.host || headers.Host)) return false;
  const origin = headers.origin || headers.Origin;
  if (origin == null || origin === '') return true;
  try {
    return isLoopbackHost(new URL(String(origin)).host);
  } catch {
    return false;
  }
}

export function shouldSkipName(name) {
  const base = String(name || '').toLowerCase();
  return !base || base === '.ds_store' || IGNORE.has(base);
}

export function isWatchableFile(name) {
  const ext = String(name || '').split('.').pop().toLowerCase();
  return TEXT_EXT.has(ext);
}

export async function listWatchFiles(root) {
  const files = [];
  async function walk(dir, rel) {
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch (e) {
      return;
    }
    for (const entry of entries) {
      if (shouldSkipName(entry.name)) continue;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      const childPath = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(childPath, childRel);
      } else if (entry.isFile() && isWatchableFile(entry.name)) {
        let size = 0;
        try {
          size = (await fs.stat(childPath)).size;
        } catch (e) {}
        files.push({
          path: childRel,
          name: entry.name,
          folder: rel || 'root',
          size
        });
      }
    }
  }
  await walk(root, '');
  return files;
}

export const CLI_FILE_MAX_BYTES = 2 * 1024 * 1024;

export function isMissingFsError(err) {
  const code = err && err.code;
  return code === 'ENOENT' || code === 'ENOTDIR' || code === 'EISDIR';
}

export function normalizeWatchRel(rel) {
  return String(rel || '').replace(/\\/g, '/').replace(/^\/+/, '');
}

export function bumpWatchRev(revs, rel) {
  const key = normalizeWatchRel(rel);
  if (!key) return 0;
  const next = (Number(revs.get(key)) || 0) + 1;
  revs.set(key, next);
  return next;
}

export function currentWatchRev(revs, rel) {
  const key = normalizeWatchRel(rel);
  if (!key) return 0;
  return Number(revs.get(key)) || 0;
}

export async function readOpenedSnapshot(fh, size) {
  const n = Number(size) || 0;
  const buf = Buffer.alloc(n);
  let offset = 0;
  while (offset < n) {
    const { bytesRead } = await fh.read(buf, offset, n - offset, offset);
    if (!bytesRead) break;
    offset += bytesRead;
  }
  return offset === n ? buf : buf.subarray(0, offset);
}

export function safeRequestPath(rawUrl) {
  let url;
  try {
    url = new URL(rawUrl || '/', 'http://127.0.0.1');
  } catch {
    return { ok: false, status: 400 };
  }
  let pathname;
  try {
    pathname = decodeURIComponent(url.pathname);
  } catch {
    return { ok: false, status: 400 };
  }
  return { ok: true, url, pathname };
}

export function startFileWatchers(root, onRelPath, watchFn) {
  const run = typeof watchFn === 'function' ? watchFn : watch;
  const watched = new Map();
  let watching = false;
  let closed = false;

  function emit(rel) {
    if (closed || !rel) return;
    const norm = String(rel).replace(/\\/g, '/');
    if (norm.split('/').some(shouldSkipName)) return;
    onRelPath(norm);
  }

  function forgetTree(dir) {
    const key = path.resolve(String(dir || ''));
    const prefix = key + path.sep;
    for (const childKey of [...watched.keys()]) {
      if (childKey !== key && !childKey.startsWith(prefix)) continue;
      const rec = watched.get(childKey);
      try { if (rec && rec.watcher) rec.watcher.close(); } catch {}
      watched.delete(childKey);
    }
  }

  function add(dir, rel, recursive) {
    if (closed) return false;
    const key = path.resolve(String(dir || ''));
    if (watched.has(key)) return true;
    try {
      const w = run(dir, recursive ? { recursive: true } : {}, (_event, filename) => {
        if (!filename) return;
        const childRel = rel ? rel + '/' + String(filename).replace(/\\/g, '/') : String(filename).replace(/\\/g, '/');
        emit(childRel);
        if (!recursive) {
          const childPath = path.join(dir, String(filename));
          fs.stat(childPath).then((st) => {
            if (closed || shouldSkipName(path.basename(childPath))) return;
            if (!st.isDirectory()) return;
            forgetTree(childPath);
            add(childPath, childRel, false);
            watchExistingTree(childPath, childRel);
          }).catch((err) => {
            if (closed) return;
            if (err && (err.code === 'ENOENT' || err.code === 'ENOTDIR')) forgetTree(childPath);
          });
        }
      });
      watched.set(key, { watcher: w, rel });
      watching = true;
      return true;
    } catch {
      return false;
    }
  }

  async function watchExistingTree(dir, rel) {
    if (closed || !dir) return;
    let entries;
    try {
      entries = await fs.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (closed) return;
      if (!entry.isDirectory() || shouldSkipName(entry.name)) continue;
      const childRel = rel ? rel + '/' + entry.name : entry.name;
      const childPath = path.join(dir, entry.name);
      add(childPath, childRel, false);
      await watchExistingTree(childPath, childRel);
    }
  }

  if (!add(root, '', true)) {
    add(root, '', false);
    watchExistingTree(root, '');
  }

  return {
    get watching() {
      return watching && !closed;
    },
    close() {
      closed = true;
      for (const rec of watched.values()) {
        try { if (rec && rec.watcher) rec.watcher.close(); } catch {}
      }
      watched.clear();
      watching = false;
    }
  };
}

export function openBrowser(url, spawnFn) {
  const platform = process.platform;
  const cmd = platform === 'darwin' ? 'open' : platform === 'win32' ? 'cmd' : 'xdg-open';
  const args = platform === 'win32' ? ['/c', 'start', '', url] : [url];
  const run = typeof spawnFn === 'function' ? spawnFn : spawn;
  try {
    const child = run(cmd, args, { detached: true, stdio: 'ignore' });
    child.on('error', () => {
      console.log('Could not open a browser automatically. Open this URL manually: ' + url);
    });
    if (typeof child.unref === 'function') child.unref();
  } catch {
    console.log('Could not open a browser automatically. Open this URL manually: ' + url);
  }
}
