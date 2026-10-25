/* CodeFlowKotlin UI extension: renders the local Project dropdown and the
   project-management actions (Add Folder…, Remove / Hide, Manage Exclusions)
   into the React-provided mount slot(s). It adds only these controls and never
   changes any existing view. Mounting is idempotent across React re-renders.

   All state-changing requests send the per-session CSRF token (from
   /__codeflow/projects) and are same-origin; the server rejects anything else. */
(function () {
  'use strict';
  // Marks a select this script owns, so mounting is idempotent per slot and the
  // dropdown never duplicates across React re-renders.
  var OWNED = 'data-codeflow-project-select';
  var OWNED_ROW = 'data-codeflow-project-actions';
  var model = null;
  var changing = false;

  function ownedSelects() {
    if (!document.querySelectorAll) return [];
    return Array.prototype.slice.call(document.querySelectorAll('select[' + OWNED + ']'));
  }

  function statusError(message) {
    console.error('[CodeFlowKotlin]', message);
    ownedSelects().forEach(function (sel) {
      sel.title = message;
      if (sel.style) sel.style.borderColor = 'var(--red)';
    });
    if (typeof window !== 'undefined' && window.alert) window.alert('CodeFlowKotlin: ' + message);
  }

  // Normalize both the rich server model ({projects:[{id,name,...}]}) and the
  // legacy string-array model used by the unit tests into a common item list.
  function items() {
    var list = (model && model.projects) || [];
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var p = list[i];
      if (typeof p === 'string') {
        out.push({ id: p, name: p, parent: '', source: 'auto', missing: false, hidden: false, exclusions: [] });
      } else if (p && typeof p === 'object') {
        out.push({
          id: p.id, name: p.name || p.id, parent: p.parent || '',
          source: p.source || 'auto', missing: !!p.missing, hidden: !!p.hidden,
          exclusions: p.exclusions || [],
        });
      }
    }
    return out;
  }

  function itemById(id) {
    var all = items();
    for (var i = 0; i < all.length; i++) if (all[i].id === id) return all[i];
    return null;
  }

  function parentLabel(parent) {
    var p = String(parent || '').replace(/\\/g, '/').replace(/\/+$/, '');
    var seg = p.split('/').filter(Boolean);
    return seg.length ? seg[seg.length - 1] : p;
  }

  // Disambiguate identical display names by appending their parent folder.
  function labelFor(item, all) {
    var dup = 0;
    for (var i = 0; i < all.length; i++) if (all[i].name === item.name) dup++;
    var label = item.name;
    if (dup > 1 && item.parent) label += ' — ' + parentLabel(item.parent);
    if (item.missing) label += ' (missing)';
    return label;
  }

  function csrf() { return (model && model.csrf) || ''; }

  function mutate(path, body) {
    return fetch(path, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'X-Codeflow-CSRF': csrf() },
      credentials: 'same-origin',
      body: JSON.stringify(body || {}),
    });
  }

  function pickProject(event) {
    var id = event.target.value;
    if (!id || changing) return Promise.resolve();
    changing = true;
    event.target.disabled = true;
    return mutate('/__codeflow/select-project', { id: id }).then(function (response) {
      if (!response.ok) throw new Error('Could not switch project');
      // Hard reload resets existing CodeFlow analysis, cards, filters and watchers
      // to exactly the newly selected project. No other view is altered.
      window.location.assign('/');
    }).catch(function (error) {
      changing = false;
      statusError((error && error.message) || 'Project switch failed');
      event.target.disabled = false;
      event.target.value = model && model.selected ? model.selected : '';
    });
  }

  function buildSelect() {
    var all = items();
    var sel = document.createElement('select');
    sel.className = 'project-select'; // reuse the existing topbar select styling
    sel.setAttribute(OWNED, '1');
    sel.setAttribute('aria-label', 'Local project');
    sel.title = 'Projects in ' + ((model && model.root) || '');
    sel.style.maxWidth = '240px';
    sel.style.minWidth = '140px';
    var placeholder = document.createElement('option');
    placeholder.value = '';
    placeholder.textContent = 'Project: Select';
    sel.appendChild(placeholder);
    for (var i = 0; i < all.length; i++) {
      if (all[i].hidden) continue; // hidden auto-discovered projects stay out of the list
      var item = document.createElement('option');
      item.value = all[i].id;
      item.textContent = labelFor(all[i], all);
      sel.appendChild(item);
    }
    sel.value = (model && model.selected) || '';
    sel.addEventListener('change', pickProject);
    return sel;
  }

  function actionButton(label, title, onClick) {
    var btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'top-btn';
    btn.textContent = label;
    btn.title = title;
    btn.style.marginLeft = '6px';
    btn.addEventListener('click', onClick);
    return btn;
  }

  function selectedId() {
    var sel = ownedSelects()[0];
    return (sel && sel.value) || (model && model.selected) || '';
  }

  function onAddFolder() {
    if (changing) return;
    changing = true;
    mutate('/__codeflow/pick-folder', {}).then(function (res) {
      return res.json().catch(function () { return { status: 'error', message: 'Picker failed' }; });
    }).then(function (result) {
      if (!result || result.status === 'cancel') { changing = false; return; }
      if (result.status !== 'ok' || !result.path) {
        changing = false;
        statusError((result && result.message) || 'The folder picker could not be opened.');
        return;
      }
      return mutate('/__codeflow/add-project', { path: result.path }).then(function (res) {
        return res.json().then(function (body) { return { ok: res.ok, body: body }; });
      }).then(function (r) {
        if (!r.ok) {
          changing = false;
          var msg = r.body && r.body.error === 'already-registered'
            ? 'That folder is already in CodeFlow.'
            : 'Could not register the selected folder.';
          statusError(msg);
          return;
        }
        window.location.assign('/'); // load the newly registered + selected project
      });
    }).catch(function (error) {
      changing = false;
      statusError((error && error.message) || 'Add Folder failed');
    });
  }

  function onRemove() {
    var id = selectedId();
    var item = itemById(id);
    if (!item) { statusError('Select a project to remove first.'); return; }
    if (item.source === 'manual') {
      if (window.confirm && !window.confirm('Remove "' + item.name + '" from CodeFlow?\n\nThis only unregisters it — no files are deleted.')) return;
      mutate('/__codeflow/remove-project', { id: id }).then(function (res) {
        if (!res.ok) throw new Error('Could not remove the project');
        window.location.assign('/');
      }).catch(function (e) { statusError((e && e.message) || 'Remove failed'); });
    } else {
      if (window.confirm && !window.confirm('Hide "' + item.name + '" from the project list?\n\nIt stays on disk and can be unhidden from Manage.')) return;
      mutate('/__codeflow/set-hidden', { id: id, hidden: true }).then(function (res) {
        if (!res.ok) throw new Error('Could not hide the project');
        window.location.assign('/');
      }).catch(function (e) { statusError((e && e.message) || 'Hide failed'); });
    }
  }

  // ---- Exclusions / manage modal -------------------------------------------
  function ensureStyles() {
    if (!document.head || document.getElementById('cfk-selector-styles')) return;
    var style = document.createElement('style');
    style.id = 'cfk-selector-styles';
    style.textContent =
      '.cfk-overlay{position:fixed;inset:0;background:rgba(0,0,0,.55);z-index:99999;display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.cfk-modal{background:var(--bg1,#1c1c22);color:var(--t1,#eee);border:1px solid var(--border,#333);border-radius:12px;max-width:560px;width:100%;max-height:85vh;overflow:auto;padding:20px;font-size:13px}' +
      '.cfk-modal h2{font-size:15px;margin:0 0 4px}.cfk-modal h3{font-size:12px;margin:16px 0 6px;color:var(--t2,#aaa)}' +
      '.cfk-row{display:flex;gap:8px;align-items:center;flex-wrap:wrap}' +
      '.cfk-chip{display:inline-flex;align-items:center;gap:6px;font-size:11px;padding:4px 8px;background:var(--bg0,#121216);border:1px solid var(--border,#333);border-radius:999px;margin:3px 4px 0 0}' +
      '.cfk-chip button{background:none;border:none;color:var(--red,#e66);cursor:pointer;font-size:13px;line-height:1;padding:0}' +
      '.cfk-modal input[type=text]{flex:1;min-width:160px;background:var(--bg0,#121216);border:1px solid var(--border,#333);border-radius:6px;color:inherit;padding:6px 8px;font-size:12px}' +
      '.cfk-modal .cfk-tree{max-height:180px;overflow:auto;border:1px solid var(--border,#333);border-radius:8px;padding:6px;margin-top:6px}' +
      '.cfk-tree-item{display:flex;align-items:center;gap:6px;padding:2px 0;font-family:monospace;font-size:11px}' +
      '.cfk-tree-item button{background:none;border:1px solid var(--border,#333);border-radius:5px;color:inherit;cursor:pointer;font-size:10px;padding:1px 6px}' +
      '.cfk-actions{display:flex;justify-content:flex-end;gap:8px;margin-top:18px}' +
      '.cfk-actions button{padding:7px 14px;border-radius:7px;border:1px solid var(--border,#333);background:var(--bg0,#121216);color:inherit;cursor:pointer}' +
      '.cfk-actions .cfk-primary{background:var(--acc,#6a7bff);border-color:var(--acc,#6a7bff);color:#fff}';
    document.head.appendChild(style);
  }

  function closeModal() {
    var ov = document.getElementById('cfk-overlay');
    if (ov && ov.parentNode) ov.parentNode.removeChild(ov);
  }

  function openManage() {
    if (!document.body) return;
    var id = selectedId();
    var item = itemById(id);
    if (!item) { statusError('Select a project first to manage its exclusions.'); return; }
    ensureStyles();
    closeModal();

    var working = (item.exclusions || []).slice();

    var overlay = document.createElement('div');
    overlay.id = 'cfk-overlay';
    overlay.className = 'cfk-overlay';
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeModal(); });

    var modal = document.createElement('div');
    modal.className = 'cfk-modal';
    overlay.appendChild(modal);

    var h = document.createElement('h2');
    h.textContent = 'Manage: ' + item.name;
    modal.appendChild(h);
    var sub = document.createElement('div');
    sub.style.color = 'var(--t2,#aaa)';
    sub.style.fontSize = '11px';
    sub.textContent = item.root || '';
    modal.appendChild(sub);

    // Exclusions section
    var exH = document.createElement('h3');
    exH.textContent = 'Excluded folders (not analyzed, read or watched)';
    modal.appendChild(exH);
    var chips = document.createElement('div');
    modal.appendChild(chips);

    function renderChips() {
      chips.textContent = '';
      if (!working.length) {
        var none = document.createElement('span');
        none.style.color = 'var(--t3,#888)';
        none.style.fontSize = '11px';
        none.textContent = 'No custom exclusions.';
        chips.appendChild(none);
        return;
      }
      working.forEach(function (ex) {
        var chip = document.createElement('span');
        chip.className = 'cfk-chip';
        chip.appendChild(document.createTextNode(ex));
        var x = document.createElement('button');
        x.type = 'button';
        x.textContent = '×';
        x.title = 'Remove exclusion';
        x.addEventListener('click', function () {
          working = working.filter(function (v) { return v !== ex; });
          renderChips();
        });
        chip.appendChild(x);
        chips.appendChild(chip);
      });
    }
    renderChips();

    function addExclusion(raw) {
      var rel = String(raw || '').replace(/\\/g, '/').replace(/^\/+|\/+$/g, '').trim();
      if (!rel || rel.split('/').indexOf('..') >= 0 || /^[a-zA-Z]:/.test(rel)) return;
      if (working.indexOf(rel) < 0) { working.push(rel); working.sort(); renderChips(); }
    }

    var addRow = document.createElement('div');
    addRow.className = 'cfk-row';
    addRow.style.marginTop = '8px';
    var input = document.createElement('input');
    input.type = 'text';
    input.placeholder = 'relative/folder (e.g. screenshots)';
    input.addEventListener('keydown', function (e) { if (e.key === 'Enter') { addExclusion(input.value); input.value = ''; } });
    var addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'top-btn';
    addBtn.textContent = 'Add';
    addBtn.addEventListener('click', function () { addExclusion(input.value); input.value = ''; });
    addRow.appendChild(input);
    addRow.appendChild(addBtn);
    modal.appendChild(addRow);

    // Lightweight folder tree (immediate children) for picking exclusions.
    var treeH = document.createElement('h3');
    treeH.textContent = 'Project folders';
    modal.appendChild(treeH);
    var tree = document.createElement('div');
    tree.className = 'cfk-tree';
    modal.appendChild(tree);

    function loadDirs(rel) {
      tree.textContent = 'Loading…';
      fetch('/__codeflow/dirs?id=' + encodeURIComponent(id) + '&rel=' + encodeURIComponent(rel || ''), { cache: 'no-store' })
        .then(function (r) { return r.ok ? r.json() : { dirs: [] }; })
        .then(function (data) {
          tree.textContent = '';
          if (rel) {
            var up = document.createElement('div');
            up.className = 'cfk-tree-item';
            var upBtn = document.createElement('button');
            upBtn.textContent = '↑ up';
            upBtn.addEventListener('click', function () {
              var parent = rel.split('/').slice(0, -1).join('/');
              loadDirs(parent);
            });
            up.appendChild(upBtn);
            up.appendChild(document.createTextNode(rel + '/'));
            tree.appendChild(up);
          }
          (data.dirs || []).forEach(function (d) {
            var row = document.createElement('div');
            row.className = 'cfk-tree-item';
            var openBtn = document.createElement('button');
            openBtn.textContent = 'open';
            openBtn.addEventListener('click', function () { loadDirs(d); });
            var exBtn = document.createElement('button');
            exBtn.textContent = 'exclude';
            exBtn.addEventListener('click', function () { addExclusion(d); });
            row.appendChild(openBtn);
            row.appendChild(exBtn);
            row.appendChild(document.createTextNode(d));
            tree.appendChild(row);
          });
          if (!(data.dirs || []).length && !rel) tree.appendChild(document.createTextNode('No subfolders.'));
        })
        .catch(function () { tree.textContent = 'Could not list folders.'; });
    }
    loadDirs('');

    // Danger / registry actions
    var regH = document.createElement('h3');
    regH.textContent = item.source === 'manual' ? 'Registration' : 'Visibility';
    modal.appendChild(regH);
    var regRow = document.createElement('div');
    regRow.className = 'cfk-row';
    if (item.source === 'manual') {
      var rm = document.createElement('button');
      rm.type = 'button';
      rm.className = 'top-btn';
      rm.textContent = 'Remove from CodeFlow';
      rm.title = 'Unregister this folder (no files are deleted)';
      rm.addEventListener('click', function () {
        if (window.confirm && !window.confirm('Remove "' + item.name + '" from CodeFlow? No files are deleted.')) return;
        mutate('/__codeflow/remove-project', { id: id }).then(function (res) {
          if (!res.ok) throw new Error('Remove failed'); window.location.assign('/');
        }).catch(function (e) { statusError((e && e.message) || 'Remove failed'); });
      });
      regRow.appendChild(rm);
    } else {
      var hd = document.createElement('button');
      hd.type = 'button';
      hd.className = 'top-btn';
      hd.textContent = 'Hide from list';
      hd.addEventListener('click', function () {
        mutate('/__codeflow/set-hidden', { id: id, hidden: true }).then(function (res) {
          if (!res.ok) throw new Error('Hide failed'); window.location.assign('/');
        }).catch(function (e) { statusError((e && e.message) || 'Hide failed'); });
      });
      regRow.appendChild(hd);
    }
    modal.appendChild(regRow);

    // Footer actions
    var actions = document.createElement('div');
    actions.className = 'cfk-actions';
    var reset = document.createElement('button');
    reset.type = 'button';
    reset.textContent = 'Reset custom exclusions';
    reset.addEventListener('click', function () { working = []; renderChips(); });
    var cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', closeModal);
    var save = document.createElement('button');
    save.type = 'button';
    save.className = 'cfk-primary';
    save.textContent = 'Save & re-analyze';
    save.addEventListener('click', function () {
      mutate('/__codeflow/set-exclusions', { id: id, exclusions: working }).then(function (res) {
        if (!res.ok) throw new Error('Could not save exclusions');
        // If the edited project is the active one, reload to re-read (now filtered)
        // files and re-analyze; otherwise just close.
        if (model && model.selected === id) window.location.assign('/');
        else { closeModal(); }
      }).catch(function (e) { statusError((e && e.message) || 'Save failed'); });
    });
    actions.appendChild(reset);
    actions.appendChild(cancel);
    actions.appendChild(save);
    modal.appendChild(actions);

    document.body.appendChild(overlay);
  }

  // Build the actions row (Add / Remove / Excludes) appended directly after the
  // select inside a slot. Appended as direct slot children so existing mount
  // tests (which read slot.children[0] as the select) keep working.
  function appendActions(slot) {
    slot.appendChild(actionButton('Add Folder…', 'Register a folder via the native Windows picker', onAddFolder));
    slot.appendChild(actionButton('Remove', 'Remove the selected manual project, or hide an auto-discovered one', onRemove));
    slot.appendChild(actionButton('Excludes', 'Manage excluded folders for the selected project', openManage));
    slot.setAttribute(OWNED_ROW, '1');
  }

  // Mount one dropdown into every slot that does not already own one. Returns the
  // number of dropdowns added (0 when everything is already mounted).
  function mountAll() {
    if (!model || !document.querySelectorAll) return 0;
    var slots = document.querySelectorAll('.project-selector-slot');
    var added = 0;
    for (var i = 0; i < slots.length; i++) {
      var slot = slots[i];
      if (slot.querySelector && slot.querySelector('select[' + OWNED + ']')) continue;
      slot.appendChild(buildSelect());
      try { appendActions(slot); } catch (e) {}
      added++;
    }
    return added;
  }

  function setModel(m) { model = m; }

  function init() {
    fetch('/__codeflow/projects', { cache: 'no-store' })
      .then(function (response) {
        if (!response.ok) throw new Error('Could not load local projects');
        return response.json();
      })
      .then(function (data) {
        setModel(data);
        mountAll();
        // CodeFlow is React-based; if it re-renders the topbar, put the dropdown
        // back into any slot that lost it — without touching any React view.
        var root = document.getElementById('root') || document.body;
        if (!root || typeof MutationObserver === 'undefined') return;
        var scheduled = false;
        var observer = new MutationObserver(function () {
          if (scheduled) return;
          scheduled = true;
          queueMicrotask(function () { scheduled = false; mountAll(); });
        });
        observer.observe(root, { childList: true, subtree: true });
      })
      .catch(function (error) { statusError((error && error.message) || 'Project dropdown failed'); });
  }

  // Test hook: expose the pure pieces so they can be exercised without a browser.
  var g = typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this);
  if (g) g.CodeFlowProjectSelector = { buildSelect: buildSelect, mountAll: mountAll, setModel: setModel, pickProject: pickProject, openManage: openManage };

  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})();
