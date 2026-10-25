<div align="center">

# CodeFlow

### Visualize Your Codebase Architecture in Seconds

**Local-first. No accounts, no tokens, no external services. Analyze your local projects in the browser.**

[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](https://opensource.org/licenses/MIT)
[![PRs Welcome](https://img.shields.io/badge/PRs-welcome-brightgreen.svg)](http://makeapullrequest.com)

[**Try it Now**](https://codeflow-five.vercel.app/) · [Report Bug](https://github.com/braedonsaunders/codeflow/issues) · [Request Feature](https://github.com/braedonsaunders/codeflow/issues)

<img src="./screenshot.png" alt="CodeFlow Screenshot" width="100%"/>

</div>

---

## Why CodeFlow?

Ever opened a new codebase and felt completely lost? **CodeFlowKotlin** turns a local codebase into an interactive architecture map in seconds — entirely on your machine, with no external services.

- **No installation required** — runs entirely in your browser
- **No data collection** — your code never leaves your machine
- **No accounts** — just paste a URL or select local files and go
- **Works offline** — analyze local files without internet

```
Paste URL / Select Files -> See Architecture -> Make Better Decisions
```

---

## Features

### Interactive Dependency Graph
See how your files connect at a glance. Click any node to highlight its dependencies. Drag, zoom, and explore. The **Code** view keeps that map and opens the selected file plus its connected files as full-file cards on the canvas, grouped by directory.

### Blast Radius Analysis
*"If I change this file, what breaks?"* — CodeFlow answers this instantly. Select any file and see exactly how many files would be affected by changes.

### Code Ownership
Know who owns what. See the top contributors for any file based on git history. Perfect for code reviews and knowing who to ask.

### Security Scanner
Automatic detection of:
- Hardcoded secrets & API keys
- SQL injection vulnerabilities
- Dangerous `eval()` usage
- Debug statements in production code
- Command/process execution:
  - JavaScript/TypeScript `child_process` exec/spawn
  - Python `eval`/`exec`, `os.system`/`os.popen`, `subprocess(..., shell=True)`
  - Kotlin/Java `Runtime.getRuntime().exec(...)` and `ProcessBuilder(...).start()` — including a builder stored in a variable and started on a later line
  - VBA `Shell()`, `WScript.Shell`, `SendKeys`, `Application.Run`

The command/process-execution and `Shell()` checks are **language-aware**: each language's rule runs only on that language's files, and detection is performed on a copy of the source with comments, KDoc/Javadoc, and string/char literals masked out (line numbers preserved). A Kotlin comment such as `// ... the header shell (...)`, a KDoc mention of `Shell()`, an identifier like `ShellHeader`, or a command-shaped string literal therefore does not produce a finding, while a genuine call does — reported with its one-based line number and the triggering source line.

**Known limitations:** masking is lexical, not a full parse (the Kotlin/Java Tree-sitter grammars are vendored but not loaded in the synchronous scan path). ProcessBuilder identity tracking covers chained `.start()` and a builder assigned to a local variable and started later in the same file; builders passed across functions or returned and started elsewhere are not followed. Detection is intraprocedural and does not perform taint analysis, so it flags the execution site, not whether the argument is actually attacker-controlled.

For JavaScript and TypeScript, a standalone `console.log`, `console.debug`, `console.info`, or `debugger` statement can be downloaded as a unified diff (`.patch`) and applied from the repo root with `git apply`. The JSON report adds a `patch` field on that debug-statement finding when a safe removal exists. Statements inside an expression, or in a one-line `if` or arrow without braces, stay report-only. Codeflow never writes to your files.

Test files, fixtures, `docs/`, and common tooling directories (`.github/`, `.claude/`, `scripts/`) are excluded from the XSS/shell-execution and command-execution checks, since findings there don't reflect the shipped product's attack surface. The hardcoded-secret check exempts only tests, fixtures, and docs: CI workflows, hooks, and deploy scripts are executable code, so a real credential there is still a real leak.

**Running the security regression tests:** `npm test` runs the full suite; the security rules are covered by `tests/security-precision.test.mjs` (precision/recall, including the Kotlin/Java command-execution and VBA `Shell()` cases) and `tests/security-selfscan.test.mjs` (self-scan exemption). Run just those with `node --test tests/security-precision.test.mjs tests/security-selfscan.test.mjs`.

### Pattern Detection
Automatically identifies:
- Singleton patterns
- Factory patterns
- Observer/Event patterns
- React custom hooks
- Anti-patterns (God Objects, high coupling)

### Architecture Intelligence (Kotlin/Android, Swift/SwiftUI, React, Flutter/Dart)
CodeFlow stays a general-purpose, multi-language analyzer, and adds focused, evidence-based architecture checks for four priority ecosystems. Each rule runs on a comment/string-masked copy of the source (so comments, KDoc/Javadoc, doc comments and string literals never trigger it), is gated by project-level ecosystem detection, and reports the exact file, one-based line, triggering snippet, a problem explanation, remediation and an official documentation link. Findings appear in the existing **Actions** panel with their evidence and a clickable **View source** location; the full list is also on `data.architectureInsights`.

- **Kotlin/Android** — unstructured concurrency (`GlobalScope.launch/async` and ad-hoc `CoroutineScope(...)/MainScope()` launches with no managed, cancelled scope), ViewModels holding a `Context`/`Activity`/`Fragment`/`View` reference, ViewModels exposing **public** `MutableStateFlow`/`MutableLiveData` (encapsulation / single-source-of-truth), `mutableStateOf` inside a `@Composable` without `remember`, `collectAsState()` where `collectAsStateWithLifecycle()` is preferred (low-severity recommendation), UI-layer files constructing the data layer directly (`Retrofit.Builder()`, `Room.databaseBuilder()`), and hardcoded `withContext/flowOn(Dispatchers.X)` in a repository/service (testability recommendation). Recognition classifies Activities, Fragments, Composables, ViewModels, repositories, services, Room DAOs, Retrofit APIs, Hilt/Koin DI, StateFlow/Flow usage and coroutine scopes from source — `private`/`asStateFlow()`, managed scopes, injected dispatchers and multiline `remember` are deliberately not flagged.
- **Swift/SwiftUI** — `@ObservedObject` that owns (initializes) its model where `@StateObject` is intended, and non-private `@State` properties.
- **React** (JS/JSX/TS/TSX) — list items keyed by the array index.
- **Flutter/Dart** — a `BuildContext` used after an `await` without a `mounted`/`context.mounted` guard, an owned controller/subscription in a `State` that is never released in `dispose()`, and a widget that directly constructs a concrete data source (`http.Client()`, `Dio()`, …) when the project already has a repository boundary. Flutter is detected from `package:flutter/` imports; recognition classifies widgets, `State` classes, view-models/controllers, repositories, services and the state-management library (Provider/Riverpod/BLoC/ChangeNotifier) without requiring any particular library or MVVM naming. Dart has no vendored AST, so these rules use a dedicated comment/string-aware Dart masker — conservative by design.

See [docs/architecture-analysis.md](docs/architecture-analysis.md) for the full rule catalog, severity/confidence semantics, parser/fallback behavior, limitations, and how to run the regression tests.

### Health Score
Get an instant A-F grade for your codebase based on:
- Dead code percentage
- Circular dependencies
- Coupling metrics
- Security issues

### Activity Heatmap
Color files by commit frequency to see which parts of your codebase are most actively developed.

### PR Impact Analysis
Paste a PR URL to see exactly which files it affects and calculate the blast radius of proposed changes.

### CodeFlow Card (GitHub Action)
Health grade, scale, fragility, and hidden costs as a self-updating SVG on your README — recomputed every merge, with optional thermal-receipt PR comments. See [card/](./card/).

### Markdown & Wiki-Link Graph
Point CodeFlow at an Obsidian vault or any markdown directory to see notes as a connected graph. Both `[[wiki-links]]` and `[text](./relative.md)` links become edges; each note is a `note`-layer node (distinct color) with a `dependencies[]` array in the JSON export.

### Local File Analysis
Analyze code directly from your computer without uploading to GitHub:
- **Privacy First:** Your code never leaves your machine
- **Offline Support:** Works without internet connection
- **Drag & Drop:** Simply drag files or folders to analyze
- **Folder Scanning:** Recursively analyze entire project structures
- **Exclude Patterns:** Skip attachments, caches, generated assets, and other irrelevant paths before scanning
- **Instant Results:** All processing happens in your browser

---

## CodeFlow Card

A GitHub Action that drops an auto-updating SVG card on your README, recomputed on every merge by the same analyzer as the web app. Five styles, accent presets, opt-in PR receipts, and a privacy mode for public repos. The card adapts to the viewer's light/dark theme automatically.

<p align="center">
  <img src="./card/examples/compact.svg" alt="CodeFlow card — compact style" width="100%" />
</p>

See [card/](./card/) for setup, or jump to the [style gallery](#card-style-gallery) below.

---

## Privacy First

**Your code stays on your machine.** CodeFlow:

- Analyzes your selected local project in the browser; a local-only server on `127.0.0.1` serves the app and reads just that project
- Never uploads your local project source anywhere
- Requires **no accounts, tokens or GitHub login** of any kind
- Makes **no external network requests** when analyzing a local project; there is no remote repository analysis
- Stores project configuration locally (`~/.codeflowkotlin-projects.json`: manual folder registrations, per-project exclusions, hidden projects and the current selection) and the analysis cache, so your projects and selection persist across restarts — nothing is uploaded and no paths are committed to Git
- No analytics or tracking

---

## Quick Start

### Option 1: Self-Host (Recommended)
```bash
# Clone the repo
git clone https://github.com/braedonsaunders/codeflow.git

# That's it! Just open index.html in your browser
open index.html
```

No build process. No npm install. Clone the whole repository: `index.html` loads pinned,
checked-in browser dependencies from `vendor/`, so a fresh local launch works without a network connection.

### Option 2: Local project server
Run the local CodeFlowKotlin application server over a folder that contains your
projects (each immediate subfolder is offered in the Project dropdown):

```
node cli/projects-server.mjs "C:\Users\You\AndroidStudioProjects"
```

It binds `127.0.0.1:4173` (localhost only), serves the same `index.html` UI, and
lets you pick, analyze, watch and re-analyze a single local project. `npm start`
runs the same server against the current directory. The old standalone
`npx codeflow .` CLI has been removed in favour of this project server.

### Option 3: Analyze Local Files
You can now analyze code directly from your local machine without uploading to GitHub:

1. Open CodeFlow in your browser
2. Click the "Open Folder" button
3. Select the folder or files you want to analyze
4. CodeFlow will process them entirely in your browser

**Perfect for:**
- Private projects you don't want to upload
- Offline development
- Quick local analysis before committing
- Working with sensitive code

---

## Usage

### Local projects (primary)
Open the app at `http://127.0.0.1:4173/` and pick a project from the **Project
dropdown** in the topbar. It lists the local projects discovered by the project
server and runs the one unified local pipeline:

**Selected project → read local source files → existing parser/analyzer → Code view.**

> **Source-code only.** CodeFlow is a source-code analyzer. A single shared
> eligibility policy (mirroring the analyzer's own code extensions) governs
> enumeration, direct file reads, the Code canvas, the file tree, the watcher,
> re-analyze and Global Search. **Only actual programming-language source is
> enumerated, read, parsed, visualized and searched** — Markdown, documentation,
> `.txt`, JSON/YAML/TOML data, CSS, SQL, images, PDFs, archives, datasets, logs
> and generated build output are never read for analysis (the `/__codeflow/file`
> endpoint refuses them even inside the project). This keeps large data assets out
> of the pipeline: on a real project with 21 MB+ of bundled GeoJSON and many
> Markdown plans, dropping non-code files cut the files read from ~1,056 to ~726
> and the bytes read from ~37 MB to ~7 MB. Folder names are still listed for Add
> Folder / Exclusions without reading any non-code content.
>
> *Framework-detection note:* ecosystem detection now prefers evidence from actual
> source imports/declarations (e.g. a `package:flutter/` import, `androidx.*`
> imports, an `import react`) rather than bulk-reading config files such as
> `pubspec.yaml`, `package.json` or `AndroidManifest.xml`, which are no longer read
> for analysis. Detection that depended solely on those files may be slightly less
> certain.

The analysis is keyed to a stable project identity (the canonical project root),
not just the folder name. Switching projects cancels the previous project's work,
clears its files/cards and loads only the newly selected project — projects are
never mixed. Use the **Re-analyze** button in the topbar to re-read the current
project's files and rebuild the graph, security and architecture findings; file
changes mark the analysis stale so you can re-analyze on demand. If the selected
folder was deleted or moved, the app says so instead of failing silently; with no
project selected it shows a neutral empty state. (The legacy `?cli=1` URL still
resolves but is no longer required or a separate mode.)

### Managing projects (Add Folder, Remove, Exclusions)
The Project dropdown lists both **auto-discovered** Android Studio projects (the
immediate subfolders of the directory the server was started with) and
**manually registered** external folders. Three actions sit next to it:

- **Add Folder…** opens the **native Windows folder picker**
  (`FolderBrowserDialog`, shown on your interactive desktop with no visible
  PowerShell window). Pick any permitted folder — it may live outside
  `AndroidStudioProjects`, on any local drive, and its path may contain spaces or
  Unicode. The folder is validated, registered permanently, added to the
  dropdown, and selected/loaded automatically. Cancelling does nothing; an
  invalid or inaccessible path shows an error. A drive root (`C:\`) or a system
  directory (e.g. `C:\Windows`) is refused. The same canonical folder cannot be
  registered twice (paths differing only by case or separators are treated as one).
- **Remove** unregisters the **manually registered** project that is selected —
  it only removes it from CodeFlow and **never deletes the folder, source files
  or Git history**. For an **auto-discovered** project, Remove instead **hides**
  it from the dropdown (it stays on disk and can be unhidden from **Excludes →
  Manage**). Removing/hiding the active project clears the selection rather than
  silently jumping to an unrelated project.
- **Excludes** opens a per-project **Manage** panel: add/remove excluded folders
  (type a relative path or pick from the project folder tree), reset custom
  exclusions, and remove/hide the project. Exclusions are stored **per project**
  (so `wms-vicko` excluding `screenshots/`, `generated/`, `old-source/` does not
  affect any other project) and are applied consistently to **file enumeration,
  analysis, re-analyze, direct file reads, and file-watch notifications**.
  Changing exclusions invalidates that project's cached analysis and re-analyzes.

**Project identity.** Each project has a **stable id derived from its canonical
absolute root** (not its name), so two projects called `app` in different parents
stay distinct. Selection, removal and exclusion requests use that id; the display
name is never the identity. Where two visible projects share a name, the dropdown
appends the parent folder to tell them apart.

**Where configuration lives.** The registry (manual registrations, per-project
exclusions, hidden auto projects, and the current selection) is stored locally in
`~/.codeflowkotlin-projects.json` (your Windows user profile). Writes are atomic,
a corrupt file is quarantined and recreated rather than crashing, and an older
single-selection config is migrated automatically. **No project source code or
project paths are committed to Git** — only this local user file holds them.

**Local-only permissions & security.** These privileged actions are only
reachable from the trusted local UI: the folder picker and every
registry/exclusion mutation require a same-origin request plus a per-session CSRF
token, so an arbitrary website cannot open the picker, register folders or change
your configuration even though the server listens on `127.0.0.1`. File reads and
enumeration are confined to the active project's real root (no `..` traversal, no
symlink/junction escape), excluded folders are not readable through the file
endpoint, and only the active project has a live watcher.

**Windows dialog limitations.** The picker needs an interactive Windows desktop
session (it is launched STA via `powershell.exe`). If it cannot be shown (for
example a non-interactive/headless context), CodeFlow reports that precisely
instead of claiming success. Recursive Windows watchers may still observe events
inside an excluded subtree at the OS level; those events are reliably filtered
out before they reach analysis or the UI.

**Tests.** Stage 5 is covered by `tests/project-registry.test.mjs` (identity,
migration, dedup, atomic/corrupt-config, exclusion normalization),
`tests/native-picker.test.mjs` (mocked picker: success/cancel/error/non-JSON,
non-Windows, fixed-arg launch), `tests/project-management.test.mjs` (HTTP:
picker endpoint + concurrency, CSRF/same-origin guards, add/remove/hide,
persistence across restart, migration, exclusions across files/reads/status/dirs,
isolation), `tests/project-selector-actions.test.mjs` (overlay wiring) and the
exclusion/guard cases in `tests/server-utils.test.mjs`.

### Project-wide search (Find in Files)
A local, VS Code-style **Find in Files** for the **currently selected project**.

- **Where:** a search field sits next to the Project dropdown (desktop and mobile)
  with placeholder `Search current project... (Ctrl+Shift+F)`, and a dedicated
  **Search** tab in the left sidebar (**Overview | Files | Search | Recents**).
- **Shortcut:** `Ctrl+Shift+F` opens the Search tab and focuses the field (a
  visible **Search** button is the fallback when the browser reserves the
  shortcut). Typing is debounced; **Enter** runs immediately; **Esc** clears the
  query or blurs the field; the **×** control clears it.
- **Scope:** search covers only the active project's files, resolved from the
  server's authorized project root — never the whole `AndroidStudioProjects`
  directory and never an arbitrary path from the client. Switching projects
  invalidates and clears the previous project's results (requests are tagged with
  the stable **project id**, so a Project-A response can never appear under
  Project B).
- **What matches:**
  - **Content** — the actual matching line and column across the project's source
    and text files, with accurate **one-based** line numbers (CRLF/LF/CR and
    Unicode handled). Matches are grouped by file, with highlighted ranges.
  - **Filename / path** — files whose name or project-relative path matches are
    shown with a **name** badge and no invented line number.
- **Options:** match **case**, **whole word**, and optional **regular
  expression** mode (regex is bounded: it skips very long lines to avoid runaway
  backtracking). **Include**/**Exclude** glob filters are *temporary* search-only
  filters and never change a project's persistent exclusions.
- **Glob syntax (include/exclude):** `*` matches any run of characters except
  `/`; `**` matches across `/`; `?` matches one character except `/`. A pattern
  **without** `/` matches the file's basename (so `*.kt` matches `a/b/C.kt`); a
  pattern **with** `/` matches the whole relative path (e.g. `src/**`,
  `**/test/**`). Patterns are comma- or newline-separated and case-insensitive.
- **File types (source code only):** search covers exactly the same
  **source-code** files the analyzer loads — every supported programming language
  (Kotlin/Java/Swift/Dart first, plus JS/TS and all the others), Gradle Kotlin/
  Groovy scripts (`.kts`/`.gradle`), and the script-container markup the analyzer
  parses for embedded code (`.html`/`.vue`/`.svelte`). It does **not** search
  Markdown, documentation, `.txt`, JSON/YAML/TOML data, CSS, SQL, images, PDFs,
  logs, datasets, generated build output or other non-code content. Binaries,
  caches and dependency directories are skipped, and files over the per-file size
  limit are not read.
- **Exclusions:** per-project Stage 5 exclusions fully apply — excluded folders
  never appear in results, never contribute to counts, are never read by the
  scanner, and are not reachable via result navigation. Changing exclusions
  invalidates results.
- **Limits (reported, never silent):** query length, files scanned, per-file size,
  total bytes examined, total matches, matches per file, and an overall time
  budget. When any limit trims output the Search tab shows a truncation notice
  naming the reason; superseded searches are aborted.
- **Navigation:** clicking a content match opens the real file at that line in the
  existing line-aware **source preview** (scrolled and highlighted); the group's
  **→** opens/focuses the file (a Code card when Code view is active) via
  `goToFile`. Navigation reuses the existing viewers — no duplicate source viewer.
- **Freshness:** when the active project's watched files change, the Search tab
  marks results **potentially stale** and offers **Refresh Search** (a reliable
  full rescan of the current project). Search is not a live incremental index;
  refresh is explicit so stale snippets are never shown as current.
- **Privacy/security:** all search runs on the local server; results are rendered
  as React text (never injected as HTML), the endpoint is same-origin-guarded like
  the other local read endpoints, payloads are bounded, and no content leaves your
  machine. **Tests:** `tests/project-search.test.mjs` (matching/globs/limits) and
  `tests/search-endpoint.test.mjs` (HTTP scope/isolation/exclusions/security).

### Local Files
Click the "Open Folder" button to analyze code from your computer:
- **Folder Analysis:** Select a folder to analyze all supported files recursively
- **File Selection:** Choose specific files to analyze
- **Drag & Drop:** Drag files or folders directly onto the page
- **Custom Excludes:** Add patterns like `uploads/**`, `**/cache/**`, or `*.png` before scanning

Generated dependencies, caches, build output, local worktrees, and test artifacts are pruned automatically (for example `node_modules`, `.next`, `.turbo`, `.local`, `dist`, and `playwright-report`). Individual files over 2 MB remain visible in results but their contents are not parsed.

All processing happens locally in your browser - nothing is uploaded.

### Shareable Links
After analysis, click the "Share" button to copy a shareable link. Anyone can re-run the same analysis.

### Export Reports
Export your analysis in multiple formats for further processing:

- **JSON Report** - Complete analysis data including:
  - Repository metadata and health score
  - All files with functions, dependencies, and churn data
  - Complete function statistics with callers and usage metrics
  - Security issues, patterns, and architecture issues
  - Duplicate code detection and layer violations
  - Suggestions and recommendations
  - Language breakdown and folder structure
  
  Perfect for programmatic analysis, CI/CD integration, or custom reporting tools.

- **Markdown Report** - Human-readable formatted report
- **Plain Text Report** - Simple text format
- **SVG Image** - Export the dependency graph visualization
- **PDF Document** - Export the dependency graph as a printable PDF
- **Raw JSON** - Simplified data export

Click the "Export" button in the top bar after analysis to access all export options.

---

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

## Visualization Modes

| Mode | Description |
|------|-------------|
| **Folder** | Color by directory structure |
| **Layer** | Color by architectural layer (UI, Services, Utils, etc.) |
| **Churn** | Color by commit frequency (hot spots) |
| **Blast** | Color by impact when a file is selected |
| **Code** | Same graph, with selected and connected files as full-file cards grouped by directory |

### Views

Switch the active view with the visualization selector. **Code is the default
view** on load and when a project is selected (a valid saved per-project
preference, when available, takes precedence). Any unknown or removed saved view
falls back safely to Code.

| View | Description |
|------|-------------|
| **Code** | Default. Full-file cards for selected and connected files, grouped by directory |
| **Graph** | Force-directed dependency graph |
| **3D Graph** | Dependency graph in 3D |
| **Tree** | Hierarchical dendrogram |
| **Flow** | Sankey flow of folder-to-folder connections |
| **Bundle** | Circular hierarchical edge bundling |

> The **Cluster**, **Matrix**, **Tree Map** and **Block Diagram** views have been
> removed to focus the interface on code exploration. This removes only the
> *visualizations*: the underlying analysis is unchanged. Dependency
> relationships, security findings, code metrics, impact analysis and the
> architecture model/insights (`buildArchitectureDiagram`, architecture insight
> cards, etc.) all remain and are surfaced in the relevant panels (e.g. the
> Actions/Insights and impact-analysis panels). There is no separate Metrics view.

---

## Keyboard Shortcuts

| Key | Action |
|-----|--------|
| `Enter` | Analyze repository |
| `Ctrl+Shift+F` | Open project-wide Search and focus the field |
| `+` / `-` | Zoom in/out |
| `Escape` | Close modal / clear search |

---

## Source selection

CodeFlowKotlin is **local-only**. The primary control in the topbar is the
**Project dropdown**, which lists the local projects discovered by the project
server and switches analysis to a single selected project. Analysis is always
scoped to one project at a time. You can also **Open Folder** or **Open ZIP** to
analyze a local tree directly in the browser.

> There is **no GitHub integration**: no remote repository analysis, no GitHub
> URL input, no accounts or tokens, and no external network requests when
> analyzing a local project. Your source code is never uploaded. Official
> Android/Apple/Flutter/Dart documentation links open only when you click them.

---

## Architecture

```
┌─────────────────────────────────────────────────┐
│                   CodeFlow                      │
├─────────────────────────────────────────────────┤
│  ┌──────────┐  ┌──────────┐  ┌──────────┐       │
│  │  Parser  │  │  GitHub  │  │    D3    │       │
│  │  Module  │  │   API    │  │  Graph   │       │
│  └──────────┘  └──────────┘  └──────────┘       │
│        │              │              │          │
│        └──────────────┼──────────────┘          │
│                       │                         │
│              ┌────────▼────────┐                │
│              │   React App     │                │
│              │ (Static Assets) │                │
│              └─────────────────┘                │
└─────────────────────────────────────────────────┘
```

**Zero build dependencies to install.** Browser libraries and required Tree-sitter WASM files are
pinned under `vendor/`, with source URLs, SHA-256 digests, and license notices. To refresh them:

```bash
node scripts/vendor-browser-deps.mjs
```

The vendored runtime includes:
- React 18
- D3.js 7
- Babel (for JSX)

---

## Contributing

We love contributions! Here's how:

1. Fork the repo
2. Make your changes to `index.html`
3. Test locally (just open in browser)
4. Submit a PR

Node.js unit tests live under `tests/` and run with no dependencies:

```bash
node --test tests/*.test.mjs tests/*.smoke.js
```

`tests/verify-brain-vault.mjs` is an optional end-to-end script that always verifies the bundled fixtures and will also scan a real local vault when you explicitly set `BRAIN_VAULT=/path/to/vault`.

### Ideas for Contributions
- [ ] Add support for more languages
- [ ] Improve function extraction regex
- [ ] Add more design pattern detection
- [ ] Export to different formats (PNG, PDF)
- [ ] Add code complexity metrics

---

## FAQ

**Q: How does it work without a backend?**
> CodeFlow runs entirely in your browser. It calls the GitHub API directly from your browser and processes everything client-side.

**Q: Is my code safe?**
> Yes. Your code is fetched directly from GitHub to your browser. Nothing is sent to any server we control. The app and its pinned browser dependencies are checked into this repository for inspection.

**Q: Can I use it offline?**
> Yes, entirely. All required browser and parser assets are checked in, so a cold first load works without internet, and analyzing a local project makes no external network requests at all.

**Q: Does it analyze GitHub repositories?**
> No. CodeFlowKotlin is local-only — it analyzes a selected local project (or an opened folder/ZIP) on your machine. There is no GitHub repository analysis, URL input, or API usage. GitHub is used only as the version-control host for CodeFlowKotlin itself.

**Q: How accurate is the dependency analysis?**
> It's heuristic: unique functions are matched by name, while duplicate function names are scoped by file and explicit imports before edges are created. It may still miss dynamic imports or renamed runtime references, so it's designed for a quick overview, not 100% accuracy.

---

## Card Style Gallery

All examples below are real cards rendered by the [CodeFlow Card Action](./card/) against this very repo. Pick one and drop it on your README.

### `style: compact` — default

<img src="./card/examples/compact.svg" alt="compact" width="100%" />

### `style: compact` with `show-grade: false, show-score: false`

For public READMEs where you'd rather show data than a letter grade. The card stays informational — files, functions, LOC, languages, tests — without the judgmental bits.

<img src="./card/examples/compact-private.svg" alt="compact private" width="100%" />

### `accent` — any preset or CSS color

The accent recolors the sparklines, links, and pin. Presets: `purple` (default), `teal`, `cyan`, `green`, `pink`, `blue`, `amber`, `red`. Or pass any CSS color (e.g. `#ff6b6b`).

<img src="./card/examples/compact-teal.svg" alt="compact teal" width="100%" />
<img src="./card/examples/compact-pink.svg" alt="compact pink" width="100%" />

### `style: row` — status-bar strip

<img src="./card/examples/row.svg" alt="row" width="100%" />

### `style: minimal` — single text line

<img src="./card/examples/minimal.svg" alt="minimal" width="100%" />

### `style: hero` — splashy gradient

<img src="./card/examples/hero.svg" alt="hero" width="100%" />

`hero` with `show-grade: false`:

<img src="./card/examples/hero-private.svg" alt="hero private" width="100%" />

### `style: detailed` — information-rich

Everything: grade, scale, language breakdown, composition (connections, tests, folders, function stats, patterns), top folders, fragility, hidden costs.

<img src="./card/examples/detailed.svg" alt="detailed" width="100%" />

`detailed` with `show-grade: false`:

<img src="./card/examples/detailed-private.svg" alt="detailed private" width="100%" />

---

## Star History

If you find CodeFlow useful, please star the repo.

---

## License

[MIT License](./LICENSE) — use it however you want.

---

<div align="center">

**Built by developers, for developers**

*Stop guessing. Start seeing.*

</div>
