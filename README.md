# CodeFlowKotlin

Local-only source-code exploration, dependency analysis, security checks and offline
architecture learning for registered projects. Source stays on this computer.

## Start

Requires Node.js 18+; no package installation or build is needed. From this repository:

```powershell
node server/projects-server.mjs "C:\Users\MainPc\AndroidStudioProjects"
```

Double-click **CodeFlowKotlin** on the Windows desktop (or `Open CodeFlow.cmd` in
this folder) to open it without any IDE. The launcher starts a hidden, detached
server when needed and reuses it on later clicks. It opens your default browser.
Closing Android Studio or the launcher does not stop CodeFlow.

The server binds only `127.0.0.1:4173`. Starting the Node server directly never
opens a browser; browser opening is an explicit launcher action. `npm start` uses the
current directory as the discovery parent. Browser dependencies are pinned under
`vendor/` and load offline.

## Local projects

Use the Project dropdown to select one registered project. **Add Folder** uses the
native Windows folder picker; manual registrations persist alongside discovered
projects. **Remove** unregisters or hides a project and never deletes its files.
**Excludes** manages per-project folders. The registry is stored in
`~/.codeflowkotlin-projects.json`; it is not committed or uploaded.

The server resolves paths within the active canonical root and rejects traversal,
symlink/junction escapes, excluded folders and non-source files. Source-only filtering
is shared by enumeration, reads, watchers and Global Search. Different project IDs
never share analyzed state. Add Folder can register this repository too.

**Search** (`Ctrl+Shift+F`) supports case, whole-word, regex and include/exclude globs.
Results navigate to real one-based source locations. Watching marks analysis/search
stale; **Re-analyze** refreshes dependency, security and architecture results. Native
folder picking requires an interactive Windows desktop.

## Explore

Code is the default view. Select files to open full-file cards, follow dependency
links, drag cards, pan, resize panels, use zoom buttons and Fit. Graph, 3D Graph,
Tree, Flow and Bundle are retained. Removed views remain removed.

FILE/ISSUES, PATTERNS, SECURITY, ACTIONS and GUIDE share the existing right panel.
Security scanning includes source-anchored secret, shell/process, injection and
language-specific checks. Architecture rules cover Kotlin/Android, Swift/SwiftUI,
Flutter/Dart and React. Rules are conservative lexical heuristics, not a compiler,
taint analysis or proof that a project is safe. Reports export locally as JSON,
Markdown, text, SVG or PDF. Debug-removal patches are downloadable for review.

### Architecture Guide (GUIDE)
Select a source file on the Code canvas, in **Files**, or from **Global Search**,
then open **GUIDE** in the existing right-hand panel. Selecting another file keeps
GUIDE open and updates its context. Source previews and architecture findings
also select their file. The other panel tabs remain available; the tab strip
scrolls horizontally on narrow screens.

GUIDE explains Kotlin/Android, Swift/SwiftUI and Flutter/Dart component roles,
responsibilities, dependency boundaries, common mistakes and valid alternatives.
Expand **Relationships** to follow one analyzed dependency at a time, use
**Previous component** to return, or open the existing source preview at a real
line. Static call matches are labeled heuristic; imports do not prove runtime
calls, and unresolved relationships are reported honestly. Naming-based roles
are labeled inferred. No fixed MVVM chain is fabricated.

**Architecture findings** uses the complete per-file insight list, with severity,
confidence, classification, source expression, remediation and linked lessons.
**Learn** contains bundled offline explanations and clearly illustrative examples;
official documentation opens only when clicked. GUIDE never uploads or edits source.
Watch changes require **Re-analyze** before showing refreshed guide analysis;
project switches and exclusions clear invalid context. Older caches need a
Re-analyze to populate component metadata.

See [the Guide implementation and verification notes](docs/architecture-analysis.md#interactive-architecture-guide)
for supported roles, evidence limits and executable tests.


## Supported Languages

CodeFlow extracts functions and analyzes dependencies for:

| Language | Extensions |
|----------|------------|
| JavaScript | `.js`, `.jsx` |
| TypeScript | `.ts`, `.tsx` |
| HTML (inline scripts) | `.html`, `.htm`, `.xhtml` |
| Python | `.py` |
| Java | `.java` |
| Go | `.go` |
| Ruby | `.rb` |
| PHP | `.php` |
| Vue | `.vue` |
| Svelte | `.svelte` |
| Rust | `.rs` |
| C | `.c`, `.h` |
| C++ | `.cpp`, `.cc`, `.cxx`, `.hpp`, `.hh`, `.hxx` |
| C# | `.cs` |
| Swift | `.swift` |
| Kotlin | `.kt`, `.kts` |
| Scala | `.scala`, `.sc` |
| Groovy | `.groovy`, `.gvy` |
| Elixir | `.ex`, `.exs` |
| Erlang | `.erl`, `.hrl` |
| Haskell | `.hs`, `.lhs` |
| Lua | `.lua` |
| R | `.r`, `.R` |
| Julia | `.jl` |
| Dart | `.dart` |
| Perl | `.pl`, `.pm` |
| Shell | `.sh`, `.bash`, `.zsh`, `.fish` |
| PowerShell | `.ps1`, `.psm1`, `.psd1` |
| F# | `.fs`, `.fsi`, `.fsx` |
| OCaml | `.ml`, `.mli` |
| Clojure | `.clj`, `.cljs`, `.cljc` |
| Elm | `.elm` |
| VBA | `.vba`, `.bas`, `.cls`, `.xlsm`, `.xlsb`, `.xlam` |
| Delphi / FreePascal / Object Pascal | `.pas`, `.pp`, `.dpr`, `.dpk`, `.lpr`, `.inc` |

Pascal support is heuristic. It recognizes routines and `uses` unit dependencies while filtering
strings and Pascal comment forms; unsupported language features fall back gracefully.

---


## Edit existing source in a Code card

Select a file in a registered local project and click **Edit** on its existing
Code card. The card switches to a plain multiline textarea. Use **Save** or
**Ctrl+S** while focused to write that real file; **Cancel** leaves disk unchanged.
Native text selection, clipboard and Undo/Redo remain available. Resize the card
for more editing space. Ordinary wheel scrolls its editor; Ctrl+Wheel zooms.

Unsaved buffers show an indicator and remain separate per path, including across
card/view navigation. Return controls reopen hidden editing cards. Navigation
warns while drafts exist; project changes, exclusions, Re-analyze and page unload
protect unsaved work. Saving is explicit. Draft text is kept only in memory.

The server requires the active registered project ID, same-origin/CSRF protection,
an eligible relative source path and the opened file version. External changes
produce a conflict and keep your draft; **Reload from disk** asks before discarding
it. Writes prepare a complete same-directory temporary copy, flush it, recheck
version/path/scope, then replace the original. Only existing UTF-8 source files up
to 2 MiB are editable. UTF-8 BOM and consistent LF/CRLF are retained. Binary
containers, mixed/CR-only line endings, hard links and symlinks/junctions are refused.
Use Add Folder to register projects for analysis and editing.

After saving, source previews update and Search/dependency/security/architecture
analysis becomes stale. Use Refresh Search or **Re-analyze** to recompute it. Other
unsaved buffers survive watch events. No source is compiled, executed, formatted,
renamed, created or deleted by Save. See [write safety and limitations](docs/local-runtime.md#source-editing).

## Tests and architecture

```powershell
npm test
node --test tests/architecture-guide*.test.mjs tests/security-precision.test.mjs
node --test tests/inline-babel-parse.smoke.js tests/html-inline-script-analysis.smoke.js
node --check server/projects-server.mjs
```

See [architecture and Guide documentation](docs/architecture-analysis.md) and
[local runtime notes](docs/local-runtime.md). Tests use temporary fixture projects;
real registered source is not modified by tests. Official learning links open only
when clicked. The application does not automatically fetch external documentation.

## Runtime layout

- `index.html`: React UI, Code canvas, shared analyzer and worker source, offline topics.
- `server/`: one local Node runtime for projects, native picker, exclusions, source,
  search and watchers. Mutations require same-origin requests and a session CSRF token.
- `vendor/`: pinned browser runtime assets, manifest and required licenses.
- `tests/`: executable analyzer, UI helper, server and source-policy regression tests.
- CI workflows run the test suite and CodeQL for development changes.

A VM loader under `tests/helpers/` tests the same analyzer embedded in the browser.

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](vendor/THIRD_PARTY_NOTICES.md).
