# Local runtime

CodeFlowKotlin has one local runtime: `server/projects-server.mjs`. It serves the
existing browser application, discovered and registered projects, source reads,
watch events, search and native Add Folder. `npm start` points to that server.

Legacy remote analysis, the Card GitHub Action/gallery, standalone headless
analysis, ownership display, remote source cache compatibility and unused signing
and Mermaid browser packages were removed. Generic architecture modeling remains;
only the old Card-specific self-model and synthetic Card edges were retired.
Git history, remotes, licenses for retained dependencies and Git CI are preserved.

Browser requests go to `/__codeflow/*` or checked-in assets on the same local
origin. Worker source comes from the local page and all parser assets are local.
Official lesson links are user initiated. No GitHub API or source upload runs.

Watch and hydration helpers use project terminology. Existing local cache records
are preserved; obsolete source modes are rejected and purged from the recents
store when enumerated. Local Folder/ZIP input is retained as local-only reading;
source editing is restricted to registered projects.

Verification: `node --test tests/local-only-runtime.test.mjs`, project/server/search
regression tests, `npm test`, and inline-script syntax checks. HTTP checks alone do
not establish visual or interactive browser correctness.

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

Root cause: the old Code listener deliberately mapped ordinary wheel to pan,
while D3's Code filter rejected wheel. The listener now calls the existing
pointer-anchored `scaleBy` for ordinary wheel too. Executable listener tests plus
the real vendored D3 verify anchoring, limits and native editor scrolling:
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
  the current server/project generation.
- POST requires exact HTTP same-origin, per-session CSRF, `projectId`, `path`,
  `version` and `content`. It validates payload and decoded/encoded byte limits,
  active canonical root, generation, source eligibility and exclusions. Absolute
  paths, traversal, Windows ADS syntax, links, hard links and inaccessible files
  are refused. UTF-8 text source across supported languages uses the same path;
  binary source containers, invalid Unicode and unsupported encodings are refused.
- Existing bytes are compared to the opened version. Conflict (409) leaves disk
  and the draft alone; there is no automatic force overwrite. Reload is explicit
  and confirms before replacing a draft. Permission/read-only failures return 403,
  unavailable files 404, oversized content 413 and unsupported text formats 422.
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

## Verification for cleanup, zoom and editing (2026-10-25)

Base inspected: Phase E `f814463a759e5467b9a52c97ce41aa8fba3f3ed0` on clean main.
Cleanup focused checks: 76 passed; full suite after removal: 465 tests, 451 passed,
14 established baseline failures. Zoom/canvas/Guide/syntax checks: 155 passed.
Final combined editor/local-only/zoom/canvas/Guide/architecture/security/project/
Search/syntax checks: 259 passed. Final complete `npm test`: 494 tests, 480 passed,
14 failed, none skipped. The 14 failure names exactly match the pre-existing
Windows baseline: 13 debug-patch path/newline tests and one untouched vendored 3D
asset hash mismatch. Node syntax checks and `git diff --check` passed.

Editor HTTP tests save and re-read real files on disk in temporary projects and
verify that local search, source revisions and the shared analyzer see saved text.
Registered application projects are not modified. GUI inventory returned no apps
or browsers; handler/React-element/D3 tests are executable but do not constitute
visual or real browser interaction verification. Native clipboard/Undo UX and
custom Windows ACL configurations still need interactive verification. Draft text
survives a card remount, but native textarea Undo history is limited to its mount.


## Manual Windows desktop launcher

Use the **CodeFlowKotlin** desktop shortcut or `Open CodeFlow.cmd`. Both call
`scripts/start-codeflow.ps1`; the desktop shortcut hides the helper window.
The script serializes concurrent launches, checks `/__codeflow/runtime` to ensure
port 4173 belongs to this checkout, starts the one Node server hidden and detached
if needed, waits for readiness and opens the default browser. It never stops an
unknown process. Logs are under `%LOCALAPPDATA%/CodeFlowKotlin/`. Its default
project discovery parent is `%USERPROFILE%/AndroidStudioProjects`; registered
projects and the saved selection are restored as before.

The Node server no longer opens the browser automatically. There is no IDE or
Windows-login auto-start registration added by this launcher. Android Studio
shortcuts, startup tasks, global settings and registered project IDE settings
were checked; no CodeFlow auto-launch hook was found. The previous server had
been started manually during development. A direct server start now also remains
browser-silent, so browser opening is controlled by the manual launcher.

For a noninteractive launch/reuse check, run
`powershell.exe -NoProfile -File scripts/start-codeflow.ps1 -NoBrowser`.
A token is not needed by this launcher: project management and source-writing
CSRF protections remain within the local application.
