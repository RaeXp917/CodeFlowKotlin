// Native Windows folder-picker wrapper. Spawns the fixed pick-folder.ps1 under a
// hidden, STA PowerShell host and parses its single JSON line. The subprocess is
// launched only in response to an explicit, CSRF-protected user action by the
// server; nothing here interpolates user input into a shell command.
//
// Returns one of:
//   { status: 'ok', path }      a folder was chosen
//   { status: 'cancel' }        the user dismissed the dialog
//   { status: 'error', message} the dialog could not be shown / subprocess failed
//
// `spawnFn` is injectable so tests can exercise ok/cancel/error/non-JSON paths
// without a real dialog.

import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
export const PICK_SCRIPT = path.join(HERE, 'pick-folder.ps1');
const MAX_OUTPUT_BYTES = 64 * 1024;

function resolvePowershell() {
  // Prefer Windows PowerShell (ships with the OS); pwsh is a fine fallback.
  return process.env.COMSPEC ? 'powershell.exe' : 'powershell';
}

export async function pickFolder({ spawnFn, platform = process.platform, timeoutMs = 5 * 60 * 1000 } = {}) {
  if (platform !== 'win32') {
    return { status: 'error', message: 'The native folder picker is only available on Windows.' };
  }
  const run = typeof spawnFn === 'function' ? spawnFn : spawn;
  const args = [
    '-NoProfile', '-NonInteractive', '-STA',
    '-ExecutionPolicy', 'Bypass', '-WindowStyle', 'Hidden',
    '-File', PICK_SCRIPT,
  ];

  return await new Promise((resolve) => {
    let child;
    try {
      child = run(resolvePowershell(), args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      resolve({ status: 'error', message: 'Could not launch the folder picker: ' + (err && err.message) });
      return;
    }

    let out = '';
    let errOut = '';
    let overflow = false;
    let settled = false;
    const finish = (value) => { if (!settled) { settled = true; resolve(value); } };

    const timer = setTimeout(() => {
      try { child.kill(); } catch {}
      finish({ status: 'error', message: 'The folder picker timed out.' });
    }, timeoutMs);
    if (typeof timer.unref === 'function') timer.unref();

    if (child.stdout) child.stdout.on('data', (chunk) => {
      if (overflow) return;
      out += chunk.toString('utf8');
      if (out.length > MAX_OUTPUT_BYTES) { overflow = true; out = out.slice(0, MAX_OUTPUT_BYTES); }
    });
    if (child.stderr) child.stderr.on('data', (chunk) => { errOut += chunk.toString('utf8'); });

    child.on('error', (err) => {
      clearTimeout(timer);
      finish({ status: 'error', message: 'Could not launch the folder picker: ' + (err && err.message) });
    });

    child.on('close', (code) => {
      clearTimeout(timer);
      const text = out.trim();
      if (!text) {
        finish({ status: 'error', message: errOut.trim() || ('Folder picker exited with code ' + code) });
        return;
      }
      let parsed;
      try {
        parsed = JSON.parse(text);
      } catch {
        finish({ status: 'error', message: 'Unexpected folder-picker output.' });
        return;
      }
      if (parsed && parsed.status === 'ok' && typeof parsed.path === 'string' && parsed.path) {
        finish({ status: 'ok', path: parsed.path });
      } else if (parsed && parsed.status === 'cancel') {
        finish({ status: 'cancel' });
      } else if (parsed && parsed.status === 'error') {
        finish({ status: 'error', message: String(parsed.message || 'Folder picker failed.') });
      } else {
        finish({ status: 'error', message: 'Unexpected folder-picker result.' });
      }
    });
  });
}
