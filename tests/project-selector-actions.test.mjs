// Stage 5 — the project-selector overlay must wire Add Folder / Remove / Manage
// Exclusions to the server endpoints with the CSRF token, expose the manage
// hook, and keep mounting idempotent now that it also appends action buttons.
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const __dirname = dirname(fileURLToPath(import.meta.url));
const selectorSrc = await readFile(join(__dirname, '..', 'cli', 'project-selector.js'), 'utf8');

test('selector wires the privileged endpoints with the CSRF header', () => {
  assert.match(selectorSrc, /'X-Codeflow-CSRF'/);
  assert.match(selectorSrc, /\/__codeflow\/pick-folder/);
  assert.match(selectorSrc, /\/__codeflow\/add-project/);
  assert.match(selectorSrc, /\/__codeflow\/remove-project/);
  assert.match(selectorSrc, /\/__codeflow\/set-hidden/);
  assert.match(selectorSrc, /\/__codeflow\/set-exclusions/);
  // Selection now posts a project id, not the display name.
  assert.match(selectorSrc, /select-project[\s\S]{0,80}id/);
  assert.match(selectorSrc, /credentials: 'same-origin'/);
});

function makeEl(tag) {
  return {
    tagName: String(tag).toUpperCase(), className: '', style: {}, _attrs: Object.create(null),
    children: [], value: '', title: '', disabled: false, textContent: '',
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
    readyState: 'complete', createElement: (t) => makeEl(t), getElementById: () => null,
    addEventListener() {}, head: makeEl('head'), body: makeEl('body'),
    querySelectorAll(sel) {
      if (sel === '.project-selector-slot') return slots;
      if (sel.indexOf('select[') === 0) {
        return slots.reduce((acc, s) => acc.concat(s.children.filter((c) => c.tagName === 'SELECT')), []);
      }
      return [];
    },
  };
  const ctx = {
    document: doc, window: { alert() {}, confirm() { return true; }, location: { assign() {} } },
    console, fetch: () => Promise.resolve({ ok: false }),
    MutationObserver: function () { this.observe = function () {}; },
    queueMicrotask: (fn) => fn(), setTimeout, Promise, Array, JSON,
  };
  ctx.window.document = doc;
  vm.createContext(ctx);
  vm.runInContext(selectorSrc, ctx);
  return ctx.window.CodeFlowProjectSelector;
}

test('mounting the rich model keeps one dropdown per slot and adds action buttons', () => {
  const slots = [makeEl('div')];
  const api = loadSelector(slots);
  assert.equal(typeof api.openManage, 'function', 'manage hook exposed');
  api.setModel({
    root: 'C:/proj', csrf: 'tok', selected: 'p_1',
    projects: [
      { id: 'p_1', name: 'app', parent: 'C:/proj', source: 'auto', missing: false, hidden: false, exclusions: [] },
      { id: 'p_2', name: 'hidden', parent: 'C:/proj', source: 'auto', missing: false, hidden: true, exclusions: [] },
    ],
  });
  assert.equal(api.mountAll(), 1);
  const selects = slots[0].children.filter((c) => c.tagName === 'SELECT');
  assert.equal(selects.length, 1);
  assert.equal(slots[0].children[0].tagName, 'SELECT', 'select stays the first child for mount compatibility');
  // Valid selection => no placeholder; one visible project (the hidden one excluded).
  assert.equal(selects[0].children.length, 1);
  assert.equal(selects[0].children[0].value, 'p_1');
  assert.equal(selects[0].value, 'p_1');
  const buttons = slots[0].children.filter((c) => c.tagName === 'BUTTON');
  assert.equal(buttons.length, 3, 'Add Folder / Remove / Excludes');
  // Idempotent on a re-render tick.
  assert.equal(api.mountAll(), 0);
  assert.equal(slots[0].children.filter((c) => c.tagName === 'SELECT').length, 1);
});

test('duplicate names are disambiguated by parent folder', () => {
  const slots = [makeEl('div')];
  const api = loadSelector(slots);
  api.setModel({
    root: 'C:/', csrf: 'tok', selected: 'p_a',
    projects: [
      { id: 'p_a', name: 'app', parent: 'C:/one', source: 'auto', exclusions: [] },
      { id: 'p_b', name: 'app', parent: 'C:/two', source: 'manual', exclusions: [] },
    ],
  });
  api.mountAll();
  const opts = slots[0].children[0].children; // selection valid => no placeholder, 2 options
  assert.equal(opts.length, 2);
  assert.match(opts[0].textContent, /app — (one|two)/);
  assert.match(opts[1].textContent, /app — (one|two)/);
  assert.notEqual(opts[0].textContent, opts[1].textContent);
});

test('no placeholder is selectable when a project is active; it appears (disabled) only with no selection', () => {
  const slots = [makeEl('div')];
  const api = loadSelector(slots);
  // Active selection => no empty placeholder option at all.
  api.setModel({ root: 'C:/', csrf: 't', selected: 'p_1', projects: [{ id: 'p_1', name: 'app', source: 'auto', exclusions: [] }] });
  api.mountAll();
  var sel = slots[0].children[0];
  assert.ok(!sel.children.some((o) => o.value === ''), 'no empty placeholder option when selected');
  assert.equal(sel.value, 'p_1');
  // No selection => a disabled placeholder is shown and cannot be chosen.
  const slots2 = [makeEl('div')];
  const api2 = loadSelector(slots2);
  api2.setModel({ root: 'C:/', csrf: 't', selected: null, projects: [{ id: 'p_1', name: 'app', source: 'auto', exclusions: [] }] });
  api2.mountAll();
  var sel2 = slots2[0].children[0];
  var ph = sel2.children.find((o) => o.value === '');
  assert.ok(ph && ph.disabled, 'placeholder present and disabled when nothing is selected');
  assert.equal(sel2.value, '');
});
