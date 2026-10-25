// Stage 2 — Remove GitHub authentication; local Project selection is primary.
// Verifies: no credential-collection UI (desktop or mobile), the Private Key
// modal is gone, the GitHub adapter keeps only its anonymous public surface,
// anonymous public analysis still works, the rate-limit guidance no longer
// recommends auth, and the Project selector mounts on a stable, auth-independent
// anchor exactly once per slot.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(__dirname, '..', 'index.html'), 'utf8');
const selectorSrc = await readFile(join(__dirname, '..', 'server', 'project-selector.js'), 'utf8');

test('no GitHub authentication controls remain (desktop or mobile)', () => {
  assert.doesNotMatch(html, /auth-select/, 'auth-select class still present');
  assert.doesNotMatch(html, /auth-inputs/, 'auth-inputs still present');
  assert.doesNotMatch(html, /private-key-btn/, 'private-key button still present');
  assert.doesNotMatch(html, /'No Auth'/, 'No Auth option still present');
  assert.doesNotMatch(html, /Token \(PAT\)/, 'Token (PAT) option still present');
  assert.doesNotMatch(html, /value:'github_app'/, 'GitHub App option still present');
  assert.doesNotMatch(html, /Personal Access Token/, 'PAT input/placeholder still present');
});

test('no auth React state or handlers remain', () => {
  assert.doesNotMatch(html, /authMethod/);
  assert.doesNotMatch(html, /setAuthMethod/);
  assert.doesNotMatch(html, /\bappId\b/);
  assert.doesNotMatch(html, /privateKey/);
  assert.doesNotMatch(html, /showKeyModal/);
  assert.doesNotMatch(html, /setToken/);
});

test('the Private Key modal and its styling are removed', () => {
  assert.doesNotMatch(html, /GitHub App Private Key/);
  assert.doesNotMatch(html, /key-modal/);
  assert.doesNotMatch(html, /key-info/);
  assert.doesNotMatch(html, /Private Key \(PEM format\)/);
});

// GitHub runtime removal is covered in depth by tests/github-removal.test.mjs.
// The remaining auth-focused assertions confirm no credential UI ever returns.
test('the Privacy modal describes local-only behavior (no GitHub claims)', () => {
  assert.doesNotMatch(html, /Nothing Persisted/);
  assert.doesNotMatch(html, /Your Token Stays Local/);
  assert.doesNotMatch(html, /No GitHub Login/);
  assert.doesNotMatch(html, /Optional, Direct GitHub Calls/);
  assert.match(html, /Local-Only Analysis/);
  assert.match(html, /No External Services/);
  assert.match(html, /offline-capable/);
});

test('local source is never uploaded to GitHub (no PUT/POST of file contents)', () => {
  // The GitHub adapter only ever issues reads for public analysis; selecting a
  // project triggers a local reload, never a GitHub upload.
  assert.doesNotMatch(selectorSrc, /api\.github\.com/);
  assert.match(selectorSrc, /\/__codeflow\/select-project/);
});

test('the default view is driven by the shared constant and retained views exist', () => {
  assert.match(html, /viewMode:'force',vizType:DEFAULT_VIZ_TYPE/);
  ["value:'graph'", "value:'code'", "value:'bundle'"].forEach((n) =>
    assert.ok(html.includes(n), 'missing retained view ' + n));
});

// ---- Project selector: stable, auth-independent mount ----

test('project-selector.js no longer depends on .auth-select', () => {
  assert.doesNotMatch(selectorSrc, /auth-select/);
  assert.match(selectorSrc, /project-selector-slot/);
  assert.match(selectorSrc, /project-select/);
});

test('React renders stable Project mount slots for desktop and mobile', () => {
  assert.match(html, /className:'project-selector-slot','data-codeflow-project-slot':'desktop'/);
  assert.match(html, /className:'project-selector-slot','data-codeflow-project-slot':'mobile'/);
});

// A tiny DOM stub so we can exercise the real project-selector.js mount logic
// without a browser or any dependency.
function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(),
    className: '',
    style: {},
    _attrs: Object.create(null),
    children: [],
    value: '',
    title: '',
    disabled: false,
    textContent: '',
    setAttribute(k, v) { this._attrs[k] = String(v); },
    getAttribute(k) { return k in this._attrs ? this._attrs[k] : null; },
    appendChild(c) { this.children.push(c); return c; },
    addEventListener() {},
    querySelector(sel) {
      if (sel === 'select[data-codeflow-project-select]') {
        return this.children.find((c) => c.tagName === 'SELECT' && c._attrs['data-codeflow-project-select']) || null;
      }
      return null;
    },
  };
}

function loadSelector(slots) {
  const doc = {
    readyState: 'complete',
    createElement: (t) => makeEl(t),
    getElementById: () => null,
    addEventListener() {},
    querySelectorAll(sel) {
      if (sel === '.project-selector-slot') return slots;
      if (sel.indexOf('select[') === 0) {
        return slots.reduce((acc, s) => acc.concat(s.children.filter((c) => c.tagName === 'SELECT')), []);
      }
      return [];
    },
  };
  const ctx = {
    document: doc,
    window: { alert() {}, location: { assign() {} } },
    console,
    fetch: () => Promise.resolve({ ok: false }),
    MutationObserver: function () { this.observe = function () {}; },
    queueMicrotask: (fn) => fn(),
    Promise, Array, JSON,
  };
  ctx.window.document = doc;
  vm.createContext(ctx);
  vm.runInContext(selectorSrc, ctx);
  return ctx.window.CodeFlowProjectSelector;
}

test('project selector mounts exactly one dropdown per slot and is idempotent', () => {
  const slots = [makeEl('div'), makeEl('div')];
  const api = loadSelector(slots);
  assert.ok(api && typeof api.mountAll === 'function', 'test hook missing');
  api.setModel({ root: 'C:/proj', projects: ['alpha', 'beta', 'gamma'], selected: 'beta' });

  const added1 = api.mountAll();
  assert.equal(added1, 2, 'should mount into both slots');
  slots.forEach((slot) => {
    const owned = slot.children.filter((c) => c.tagName === 'SELECT' && c._attrs['data-codeflow-project-select']);
    assert.equal(owned.length, 1, 'exactly one dropdown per slot');
  });

  // Re-running (simulating a React re-render tick) must not duplicate.
  const added2 = api.mountAll();
  assert.equal(added2, 0, 'no duplicate dropdowns on re-render');
  slots.forEach((slot) => {
    assert.equal(slot.children.filter((c) => c.tagName === 'SELECT').length, 1);
  });
});

test('mounted dropdown uses project styling, lists projects, and preselects current', () => {
  const slots = [makeEl('div')];
  const api = loadSelector(slots);
  api.setModel({ root: 'C:/proj', projects: ['alpha', 'beta'], selected: 'alpha' });
  api.mountAll();
  const sel = slots[0].children[0];
  assert.equal(sel.className, 'project-select');
  assert.equal(sel._attrs['data-codeflow-project-select'], '1');
  // A valid selection means NO placeholder option: just the two real projects.
  assert.equal(sel.children.length, 2);
  assert.equal(sel.children[0].value, 'alpha');
  assert.equal(sel.children[1].value, 'beta');
  assert.equal(sel.value, 'alpha');
});
