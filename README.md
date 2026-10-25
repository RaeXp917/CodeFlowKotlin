# CodeFlowKotlin

Local-only source-code exploration, dependency analysis, security checks and offline
architecture learning. Source stays on this computer. GitHub hosts this tool's Git
repository; it is not an application data source.

## Start

Requires Node.js 18+; no package installation or build is needed. From this repository:

```powershell
node server/projects-server.mjs "C:\Users\MainPc\AndroidStudioProjects"
```

The server binds only `127.0.0.1:4173` and opens the local app. `npm start` uses the
current directory as the discovery parent. Browser dependencies are pinned under
`vendor/` and load offline. No remote repository, PR, authentication, share-link,
standalone analysis launcher or Card product is included.

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
folder picking requires an interactive Windows desktop. Open Folder and Open ZIP
are local browser inputs; ZIP archives are never downloaded from a remote service.

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
official documentation opens only when clicked. No source is uploaded or edited.
Watch changes require **Re-analyze** before showing refreshed guide analysis;
project switches and exclusions clear invalid context. Older caches need a
Re-analyze to populate component metadata.

See [the Guide implementation and verification notes](docs/architecture-analysis.md#interactive-architecture-guide-phase-e)
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
- `.github/workflows/`: legitimate Git CI testing and CodeQL, outside app runtime.

The removed Card Action and standalone analyzer have no runtime consumers. A small
VM loader remains under `tests/helpers/` solely to test the analyzer embedded in the
browser; no alternative production analyzer or command-line analysis mode exists.

## License

MIT. See [LICENSE](LICENSE) and [third-party notices](vendor/THIRD_PARTY_NOTICES.md).
