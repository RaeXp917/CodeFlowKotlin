/* CodeFlowKotlin UI extension: renders the local Project dropdown into the
   React-provided mount slot(s). It adds only this dropdown and never changes
   any existing view. The mount is independent of GitHub authentication, which
   no longer exists in the topbar. */
(function () {
  'use strict';
  // Marks a select this script owns, so mounting is idempotent per slot and the
  // dropdown never duplicates across React re-renders.
  var OWNED = 'data-codeflow-project-select';
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

  function pickProject(event) {
    var project = event.target.value;
    if (!project || changing) return Promise.resolve();
    changing = true;
    event.target.disabled = true;
    return fetch('/__codeflow/select-project', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ project }),
    }).then(function (response) {
      if (!response.ok) throw new Error('Could not switch to ' + project);
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
    var projects = (model && model.projects) || [];
    for (var i = 0; i < projects.length; i++) {
      var item = document.createElement('option');
      item.value = projects[i];
      item.textContent = projects[i];
      sel.appendChild(item);
    }
    sel.value = (model && model.selected) || '';
    sel.addEventListener('change', pickProject);
    return sel;
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
  if (g) g.CodeFlowProjectSelector = { buildSelect: buildSelect, mountAll: mountAll, setModel: setModel, pickProject: pickProject };

  if (typeof document !== 'undefined' && document.addEventListener) {
    if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
    else init();
  }
})();
