# Local runtime

CodeFlowKotlin has one local runtime: `server/projects-server.mjs`. It serves the
existing browser application, discovered and registered projects, source reads,
watch events, search and native Add Folder. `npm start` points to that server.

Register or select a local project, read its eligible source, analyze and visualize
it, then search or edit existing source. Add Folder uses the native picker. Project
identity, exclusions and saved selection live in the local registry.

Browser requests use `/__codeflow/*` and checked-in assets on the same origin.
Worker source comes from the local page. Lessons are bundled; documentation links
open only on user interaction. Cached analysis belongs to a registered project and
is usable only when that project is selected. Source reads require its active id.
Search requests also retain the active project and exclusion generation; a switch
or exclusion change during a scan returns a scope conflict instead of old results.

Verification uses project/server/search tests, the full `npm test` suite and
inline-script syntax checks. HTTP checks alone do not establish visual browser
correctness.

## Code canvas wheel zoom

Wheel over empty canvas zooms around the pointer through the existing D3 zoom
transform (Code scale limits 0.08–5). Delta modes and trackpads use bounded
exponential steps. The same transform positions cards, SVG links and the minimap;
drag panning, card movement, zoom buttons, Fit and reset retain their existing path.
Inside scrollable source bodies, symbol lists and source editors, ordinary wheel
input stays native, including horizontal scrolling. Ctrl+Wheel (also Meta+Wheel)
overrides that to zoom the canvas. The non-passive canvas listener prevents page
scrolling only when it handles canvas zoom; it does not intercept ordinary browser
wheel events outside the Code canvas.

The existing pointer-anchored D3 `scaleBy` handles wheel input. Executable
listener and transform checks:
`node --test tests/code-wheel-zoom.test.mjs tests/code-canvas.test.mjs`.

## Source editing

`SourceCardEditor` replaces the read-only source inside an existing Code card
only after Edit. It uses a textarea with Save, Cancel, focused Ctrl/Meta+S,
unsaved/success/error status and conflict Reload. It keeps native Undo/Redo,
selection, clipboard and multiline behavior. Resize the existing card; no editor
package, second viewer, analyzer or canvas is added. Pointer/key propagation keeps
editing separate from dragging; ordinary wheel remains native inside the editor.

App owns an in-memory map of buffers. Each session captures the registered project
ID and relative path; saving never derives a target from the current selection.
Different cards/folders cannot share buffers accidentally. Navigation can preserve
drafts, and a compact return strip reopens hidden editing cards. Dirty/saving checks
protect project changes, removal, exclusions, analysis resets and page unload.
Source version checks remain necessary even after a server restart. A late initial
load cannot replace a newer remounted editor buffer. Buffer text is not persisted
to localStorage, general settings, IndexedDB or cloud services. Reloading the page
therefore discards buffers only after the browser's native unload confirmation.

The local endpoint is `/__codeflow/edit-source`:

- GET requires `pid` and a project-relative `path`; returns UTF-8 text normalized
  to LF for the textarea, BOM/EOL metadata and an opaque SHA-256 version bound to
  the current server/project generation, path, file identity, timestamps and bytes.
- POST requires exact HTTP same-origin, per-session CSRF, `projectId`, `path`,
  `version` and `content`. It validates payload and decoded/encoded byte limits,
  active canonical root, generation, source eligibility and exclusions. Absolute
  paths, traversal, Windows ADS syntax, links, hard links and inaccessible files
  are refused. UTF-8 text source across supported languages uses the same path;
  binary source containers, invalid Unicode and unsupported encodings are refused.
- Existing bytes and file metadata are compared to the opened version. Conflict
  (409) leaves disk and the draft alone; there is no automatic force overwrite.
  Reload is explicit and confirms before replacing a draft. Permission/read-only
  failures return 403, unavailable files 404, oversized content 413 and
  unsupported text formats 422.
- The source limit is 2 MiB, including BOM and re-encoded CRLF. The JSON transport
  limit is bounded at six times that limit plus 4 KiB for escaping/metadata; source
  content still cannot exceed 2 MiB. Oversized requests stop accumulating data and
  receive 413. Existing registry mutations retain their smaller JSON limit.

Save checks original write permission without truncation. It copies the existing
file to an exclusive UUID-named `.tmp` sibling, writes only that copy, flushes it,
retains mode bits, checks target identity/hash/root/exclusions again, and replaces
via same-directory rename. Errors before replacement leave original bytes intact;
temporary files are cleaned. Copying rather than creating a blank replacement
also retains platform file metadata where supported; Windows CopyFile preserves
file attributes and supported security resource properties ([Microsoft reference](https://learn.microsoft.com/en-us/windows/win32/api/winbase/nf-winbase-copyfilew)).
Special ACL/encryption configurations and non-local filesystems are not fully
validated. The implementation uses portable Node filesystem operations, not an OS
transaction: hostile external directory changes or a concurrent write in the tiny
interval after the final comparison cannot be excluded absolutely. Normal external
edits, including changes during temporary preparation, are tested and rejected.
No executable source is run as part of saving.

A successful Save refreshes live displayed text and any open source preview, then
marks analysis stale. It aborts/invalidates in-flight Search responses and clears
old search snippets. The analyzer baseline remains intact until Re-analyze, so
watch comparisons cannot falsely declare the saved dependency graph current.
Explicit save and OS watcher events may both arrive; existing per-path watch
coalescing handles them without resaving/reload loops. Other drafts remain intact.

```powershell
node --test tests/source-editor.test.mjs tests/source-editor-ui.test.mjs
node --test tests/code-wheel-zoom.test.mjs tests/code-canvas.test.mjs tests/architecture-guide*.test.mjs
npm test
node --check server/source-editor.mjs
node --check server/projects-server.mjs
```

Tests save and re-read real temporary Windows source fixtures (including spaces
and Unicode), not registered application projects. They cover source/version
isolation, external conflicts, excluded/missing/binary/large files, traversal,
junctions, origin/CSRF, LF/CRLF/BOM, modes/read-only files, write/flush/rename failure,
watch/Search freshness, analyzer parsing of saved source, keyboard/Cancel/dirty
handlers, multiple buffers, unload protection and late response rejection.

## Manual Windows desktop launcher

Use the **CodeFlowKotlin** desktop shortcut or `Open CodeFlow.cmd`. Both call
`scripts/start-codeflow.ps1`; the desktop shortcut hides the helper window.
The script serializes concurrent launches, checks `/__codeflow/runtime` to ensure
port 4173 belongs to this checkout, starts the one Node server hidden and detached
if needed, waits for readiness and opens the default browser. It never stops an
unknown process. Logs are under `%LOCALAPPDATA%/CodeFlowKotlin/`. Its default
project discovery parent is `%USERPROFILE%/AndroidStudioProjects`; registered
projects and the saved selection are restored as before.

The Node server starts without opening a browser. Browser opening belongs to the
manual launcher; it creates no IDE or Windows-login startup registration.

For a noninteractive launch/reuse check, run
`powershell.exe -NoProfile -File scripts/start-codeflow.ps1 -NoBrowser`.
A token is not needed by this launcher: project management and source-writing
CSRF protections remain within the local application.
