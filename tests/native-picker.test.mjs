// Stage 5 — native Windows folder picker wrapper. The real dialog is mocked by
// injecting a fake spawn; these tests prove the ok/cancel/error/non-JSON and
// non-Windows paths without opening a window, and that no user value is ever
// interpolated into a shell command (the script is launched with fixed args).
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import test from 'node:test';
import { pickFolder, PICK_SCRIPT } from '../server/pick-folder.mjs';

// Build a fake child process whose stdout emits `stdoutText`, then closes with
// `code`. Records the (cmd, args, opts) it was launched with.
function fakeSpawn(stdoutText, { code = 0, failLaunch = false, stderrText = '' } = {}) {
  const calls = [];
  const spawnFn = (cmd, args, opts) => {
    calls.push({ cmd, args, opts });
    const child = new EventEmitter();
    child.stdout = new EventEmitter();
    child.stderr = new EventEmitter();
    child.kill = () => {};
    if (failLaunch) {
      queueMicrotask(() => child.emit('error', Object.assign(new Error('spawn ENOENT'), { code: 'ENOENT' })));
      return child;
    }
    queueMicrotask(() => {
      if (stdoutText) child.stdout.emit('data', Buffer.from(stdoutText, 'utf8'));
      if (stderrText) child.stderr.emit('data', Buffer.from(stderrText, 'utf8'));
      child.emit('close', code);
    });
    return child;
  };
  spawnFn.calls = calls;
  return spawnFn;
}

test('non-Windows platforms report the limitation precisely', async () => {
  const res = await pickFolder({ platform: 'linux', spawnFn: fakeSpawn('{"status":"ok","path":"/x"}') });
  assert.equal(res.status, 'error');
  assert.match(res.message, /only available on Windows/i);
});

test('a successful selection returns the chosen path (spaces + Unicode)', async () => {
  const chosen = 'C:\\Users\\me\\Android Studio Projects\\café-app';
  const spawnFn = fakeSpawn(JSON.stringify({ status: 'ok', path: chosen }));
  const res = await pickFolder({ platform: 'win32', spawnFn });
  assert.deepEqual(res, { status: 'ok', path: chosen });
  // The fixed script is launched by -File with no interpolated user input.
  const call = spawnFn.calls[0];
  assert.ok(call.args.includes('-File'));
  assert.equal(call.args[call.args.indexOf('-File') + 1], PICK_SCRIPT);
  assert.ok(call.args.includes('-STA'), 'STA is required for the Forms dialog');
  assert.equal(call.opts.windowsHide, true);
});

test('user cancellation is reported as cancel', async () => {
  const res = await pickFolder({ platform: 'win32', spawnFn: fakeSpawn('{"status":"cancel"}') });
  assert.deepEqual(res, { status: 'cancel' });
});

test('a dialog error (non-interactive desktop) is surfaced, not hidden', async () => {
  const res = await pickFolder({ platform: 'win32', spawnFn: fakeSpawn('{"status":"error","message":"no desktop"}') });
  assert.equal(res.status, 'error');
  assert.equal(res.message, 'no desktop');
});

test('a subprocess that fails to launch is an error', async () => {
  const res = await pickFolder({ platform: 'win32', spawnFn: fakeSpawn('', { failLaunch: true }) });
  assert.equal(res.status, 'error');
  assert.match(res.message, /Could not launch/i);
});

test('non-JSON output is treated as an error, never as a path', async () => {
  const res = await pickFolder({ platform: 'win32', spawnFn: fakeSpawn('garbage not json') });
  assert.equal(res.status, 'error');
  assert.match(res.message, /Unexpected/i);
});

test('empty output with a nonzero exit reports stderr/exit code', async () => {
  const res = await pickFolder({ platform: 'win32', spawnFn: fakeSpawn('', { code: 1, stderrText: 'boom' }) });
  assert.equal(res.status, 'error');
  assert.match(res.message, /boom/);
});
