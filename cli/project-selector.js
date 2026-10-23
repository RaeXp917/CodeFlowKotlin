/* CodeFlowKotlin UI extension: adds ONE dropdown; never changes existing views. */
(function () {
  'use strict';
  const ID = 'codeflow-kotlin-project-select';
  let model = null;
  let changing = false;
  let errorText = '';

  function statusError(message) {
    errorText = message;
    console.error('[CodeFlowKotlin]', message);
    const dropdown = document.getElementById(ID);
    if (dropdown) {
      dropdown.title = message;
      dropdown.style.borderColor = 'var(--red)';
    }
    window.alert('CodeFlowKotlin: ' + message);
  }

  async function pickProject(event) {
    const project = event.target.value;
    if (!project || changing) return;
    changing = true;
    event.target.disabled = true;
    try {
      const response = await fetch('/__codeflow/select-project', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ project }),
      });
      if (!response.ok) throw new Error('Could not switch to ' + project);
      // Hard reload resets existing CodeFlow analysis, cards, filters and watchers
      // to precisely the newly selected project. No other view is altered.
      window.location.assign('/?cli=1');
    } catch (error) {
      changing = false;
      statusError(error.message || 'Project switch failed');
      event.target.disabled = false;
      event.target.value = model && model.selected ? model.selected : '';
    }
  }

  function mount() {
    if (!model || document.getElementById(ID)) return;
    // Add a second dropdown immediately after the existing Auth select.
    const auth = document.querySelector('.topbar .repo-input-group select.auth-select');
    if (!auth || !auth.parentElement) return;
    const sel = document.createElement('select');
    sel.id = ID;
    sel.className = 'auth-select'; // reuse original theme, height, typography
    sel.setAttribute('aria-label', 'Local Android Studio project');
    sel.title = 'Projects in ' + model.root;
    sel.style.maxWidth = '220px';
    sel.style.minWidth = '128px';
    sel.style.flex = '0 1 190px';
    const opt = document.createElement('option');
    opt.value = '';
    opt.textContent = 'Project: Select';
    sel.appendChild(opt);
    for (const project of model.projects) {
      const item = document.createElement('option');
      item.value = project;
      item.textContent = project;
      sel.appendChild(item);
    }
    sel.value = model.selected || '';
    sel.addEventListener('change', pickProject);
    auth.insertAdjacentElement('afterend', sel);
  }

  async function init() {
    try {
      const response = await fetch('/__codeflow/projects', { cache: 'no-store' });
      if (!response.ok) throw new Error('Could not load local projects');
      model = await response.json();
      mount();
      // Existing CodeFlow is React-based. If it re-mounts the header, put the
      // same dropdown back, without touching any React view or component.
      const root = document.getElementById('root') || document.body;
      let scheduled = false;
      const observer = new MutationObserver(function () {
        if (scheduled || document.getElementById(ID)) return;
        scheduled = true;
        queueMicrotask(function () { scheduled = false; mount(); });
      });
      observer.observe(root, { childList: true, subtree: true });
    } catch (error) { statusError(error.message || 'Project dropdown failed'); }
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
