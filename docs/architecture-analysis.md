# Architecture Analysis & Intelligent Suggestions

CodeFlow is a general-purpose, multi-language analyzer. On top of its existing
graph, dependency, pattern, duplication and security analysis, it adds a small,
high-confidence set of **architecture insights** for four priority ecosystems:
**Kotlin/Android**, **Swift/SwiftUI**, **Flutter/Dart** and **React**.

The design goal is trustworthiness: a smaller number of correct, evidence-based
rules rather than many superficial keyword matches. Every finding is anchored to
real source with a one-based line number and the triggering expression, and
carries a problem explanation, remediation and an official documentation link.

## Supported languages

Architecture insights are additive and never reduce existing support. All
previously supported languages, file extensions, Tree-sitter grammars, language
detection, security rules, code-quality rules, graph/dependency analysis, and
suggestions continue to work unchanged. The ecosystems below receive
*additional* specialized analysis; everything else is untouched.

## How detection works (and how false positives are avoided)

1. **Project-level ecosystem detection** (`detectProjectEcosystems`) decides which
   ecosystems are present, from reliable evidence. Because CodeFlow is
   **source-code only** (see the note below), detection prefers evidence from
   actual source imports/declarations rather than reading configuration files:
   - **Kotlin/Android** — `.kt`/`.kts` files that import `androidx.*` /
     `android.*`.
   - **Swift/SwiftUI** — `.swift` files that `import SwiftUI`.
   - **React** — a `.jsx`/`.tsx` file importing `react`, or a `.js`/`.ts` file
     importing `react`.
   - **Flutter / Dart** — a `.dart` file marks a **Dart** project; **Flutter** is
     claimed only with explicit source evidence: a `package:flutter/` import. A
     plain Dart package is therefore detected as Dart but **not** Flutter.
   A plain JavaScript/TypeScript project with no React dependency is **not**
   treated as React, so its files are never flagged by React rules. The detector
   (`detectProjectEcosystems`) returns `{android, swiftui, react, flutter, dart}`.

   > **Source-code-only limitation.** CodeFlow no longer bulk-reads non-code files
   > (`pubspec.yaml`, `package.json`, `AndroidManifest.xml`, Gradle catalogs, …)
   > for ecosystem identification, because those files are not read for analysis at
   > all. Detection therefore relies on source imports and declarations. For the
   > common cases above this is equally reliable (imports are definitive); a
   > project whose only evidence lived in a config file — e.g. Flutter declared via
   > `sdk: flutter` in `pubspec.yaml` but with no `package:flutter/` import yet, or
   > React present only in `package.json` dependencies with no `import react` — may
   > be detected with lower confidence (as plain Dart, or not as React). This is an
   > intentional trade-off for a source-code-only analyzer, reported here honestly
   > rather than pretending the config metadata is still consulted.

2. **Per-file, per-language rules** run only for the detected ecosystems and the
   matching file extension. Build output (`build/`, `dist/`, `.next/`, …) and
   non-production paths (tests, fixtures, docs, dev tooling) are excluded.

3. **Syntax-aware masking.** Before any rule runs, the source is copied with all
   comments, KDoc/Javadoc/Swift doc comments, and string/char/template literals
   replaced by spaces while preserving newlines and offsets
   (`maskKotlinJavaLiterals` for Kotlin/Java/Swift, `maskJsLiterals` for
   JS/TS/JSX). Detection runs on the masked copy, so an architectural keyword in
   a comment or a string literal cannot produce a finding, yet reported line
   numbers and snippets come from the original source.

4. **Scope awareness.** Where a rule depends on *where* code appears, scope is
   resolved structurally rather than by keyword. For example, the Compose state
   rule only fires for `mutableStateOf` inside a `@Composable` function body
   (brace-matched), so idiomatic `var x by mutableStateOf(...)` **ViewModel
   properties** are correctly left alone.

### Parser / fallback behavior

The Kotlin and Swift (and Java) Tree-sitter grammars are vendored, but the
synchronous scan path does not load them, so these rules use the documented
lexical masking fallback above. This is **not** full AST precision: it is
comment/string-aware token matching with structural brace/paren matching where
needed. The rules are written conservatively so that, when evidence is
insufficient, they stay silent rather than guess.

**Dart has no Tree-sitter grammar vendored.** `.dart` files are recognized as
code and analyzed with the same comment/string-aware heuristic parsing; CodeFlow
does **not** advertise full syntax-aware (AST) Dart support. The Flutter/Dart
architecture rules use a dedicated Dart literal masker (`maskDartLiterals`:
`//`/`///` line comments, nested `/* */` blocks, `'…'`/`"…"`/`'''…'''`/`"""…"""`
and raw `r'…'` strings, with interpolation masked conservatively) plus
brace-matched structural scope resolution. This is heuristic token+brace matching,
not an AST, and is written conservatively so weak evidence stays silent. No Flutter
SDK or network access is required, and analyzed project code is never executed.

### Shared rule & learning catalog

The architecture analyzer reads from a single in-file catalog, bundled with the
app and available offline:

- **`ARCHITECTURE_RULE_CATALOG`** — keyed by stable `ruleId`. Each entry carries
  `ecosystem`, `languages`, `frameworks`, `kind`, `severity`, `confidence`,
  `title`, `explanation`, `evidence`, a short `badExample`/`goodExample`,
  `exclusions` (false-positive guards), an official `docUrl`, and an optional
  `learnTopicId`. `pushArchInsight` enriches each emitted finding from this
  catalog (e.g. `docUrl`, `topicId`), so there is one source of truth rather than
  a competing analyzer.
- **`LEARNING_TOPICS`** — keyed by stable `topicId`. Each is a small offline
  teaching card: `title`, `ecosystem`, related architectural `roles`, an
  `explanation`, a short illustrative `example`, an official `docUrl`, and
  `relatedRuleIds`. These power the interactive Architecture Guide.

Accessors are exposed on `Parser`: `detectProjectEcosystems`,
`getArchitectureRule(ruleId)`, `getLearningTopic(topicId)` and
`getLearningTopics(ecosystem)`. Documentation links point at official sites
(developer.android.com, developer.apple.com, react.dev, docs.flutter.dev,
dart.dev) and open only when the user chooses; nothing is fetched at analysis
time.

## Severity and confidence semantics

Each insight has three independent fields:

- **`kind`** — `issue` (a confirmed problem), `potential` (a likely problem that
  can be legitimate in some cases), or `recommendation` (a style/best-practice
  improvement).
- **`severity`** — `high` / `medium` / `low`. This is an *architecture* severity
  and is intentionally separate from security severities; architectural
  preferences are never reported as high-severity security vulnerabilities.
- **`confidence`** — `high` / `medium` / `low`, reflecting how certain the static
  evidence is.

In the **Actions** panel, `severity` maps to the card priority
(`high` → high, `medium` → medium, `low` → low). Each card shows the problem,
the remediation, the rule id, the confidence, a clickable `path:line`
(**View source**) and a **Docs** link. The complete, uncapped list is available
programmatically on `data.architectureInsights`.

## Rule catalog

Each finding object: `{ ruleId, ecosystem, severity, confidence, kind, title,
problem, remediation, docUrl, file, path, line, code }`.

### Kotlin / Android

| Rule id | Severity / confidence | What it flags | Reference |
| --- | --- | --- | --- |
| `android-globalscope-usage` | high / high | `GlobalScope.launch` / `GlobalScope.async` — a coroutine with no lifecycle owner | [Coroutines best practices](https://developer.android.com/kotlin/coroutines/coroutines-best-practices) |
| `android-viewmodel-holds-ui-reference` | high / high | A `ViewModel`/`AndroidViewModel` with a `Context`/`Activity`/`Fragment`/`View` (etc.) field — a leak. `Application` in `AndroidViewModel` is allowed | [ViewModel best practices](https://developer.android.com/topic/libraries/architecture/viewmodel#best-practices) |
| `compose-state-without-remember` | high / medium | `mutableStateOf(...)` **inside a `@Composable`** without `remember`/`rememberSaveable` — state resets every recomposition. ViewModel state properties are not flagged | [State in Compose](https://developer.android.com/develop/ui/compose/state#state-in-composables) |
| `android-ui-builds-data-layer` | medium / medium | A UI/presentation file constructing the data layer directly (`Retrofit.Builder()`, `Room.databaseBuilder()`) | [Data layer](https://developer.android.com/topic/architecture/data-layer) |
| `android-viewmodel-exposed-mutable-state` | medium / high | A ViewModel exposing a **public** `MutableStateFlow`/`MutableLiveData` property (breaks single-source-of-truth). Private backing state + `asStateFlow()` and function-locals are not flagged | [UI state](https://developer.android.com/topic/architecture/ui-layer#define-ui-state) |
| `android-flow-collect-without-lifecycle` | low / medium (recommendation) | `collectAsState()` inside a `@Composable` when the file does not use `collectAsStateWithLifecycle()`. A preference for screen-level state, never a high-severity issue | [Lifecycle-aware collection](https://developer.android.com/topic/libraries/architecture/coroutines#lifecycle-aware) |
| `android-unstructured-coroutine-scope` | medium / medium (potential) | An ad-hoc `CoroutineScope(...).launch/async` or `MainScope().launch/async` with no retained, cancelled scope. `viewModelScope`/`lifecycleScope`/`rememberCoroutineScope` are not flagged | [Coroutines best practices](https://developer.android.com/kotlin/coroutines/coroutines-best-practices) |
| `android-hardcoded-dispatcher` | low / medium (recommendation) | `withContext(Dispatchers.X)` / `flowOn(Dispatchers.X)` inside a repository/service/data-source — a testability recommendation. An **injected** dispatcher default (`= Dispatchers.IO`) and non-data-layer code are not flagged | [Inject dispatchers](https://developer.android.com/kotlin/coroutines/coroutines-best-practices#inject-dispatchers) |

Android guidance intentionally avoids dogma: CodeFlow does not require Clean
Architecture, UseCases or a fixed layer stack, and does not flag a ViewModel
merely for being large. The Phase C rules are deliberately conservative — they
honour `private`/`asStateFlow()` encapsulation, managed coroutine scopes, injected
dispatchers, and multiline `remember`/`rememberSaveable` — and lifecycle/dispatcher
preferences are reported as low-severity recommendations, never as confirmed bugs.
Construct recognition (`Parser.detectKotlinConstructs`) identifies Activities,
Fragments, Composables, ViewModels, repositories, services, Room DAOs, Retrofit
APIs, Hilt/Koin DI, StateFlow/SharedFlow usage, suspend functions and coroutine
scopes from source evidence. See the official
[architecture recommendations](https://developer.android.com/topic/architecture/recommendations),
[state hoisting](https://developer.android.com/develop/ui/compose/state-hoisting) and
[side effects](https://developer.android.com/develop/ui/compose/side-effects).

### Swift / SwiftUI

| Rule id | Severity / confidence | What it flags | Reference |
| --- | --- | --- | --- |
| `swiftui-observedobject-ownership` | high / high | `@ObservedObject var x = Model()` — a view that **constructs** its model should own it with `@StateObject`. An injected (no-initializer) `@ObservedObject`, and `@StateObject`, are fine | [StateObject](https://developer.apple.com/documentation/swiftui/stateobject) |
| `swiftui-observableobject-in-state` | high / medium | A legacy `ObservableObject` type stored in `@State` (it needs `@StateObject` to observe `@Published`). Modern `@Observable` in `@State` is correct and not flagged. Requires resolved project type evidence | [StateObject](https://developer.apple.com/documentation/swiftui/stateobject) |
| `swiftui-observedobject-on-observable-type` | high / medium | `@ObservedObject` on a type the project defines with the `@Observable` macro (not `ObservableObject`) — the wrong wrapper for modern Observation. Never inferred from a name or `import Observation`; needs type evidence | [Migrating to @Observable](https://developer.apple.com/documentation/SwiftUI/Migrating-from-the-observable-object-protocol-to-the-observable-macro) |
| `swiftui-state-not-private` | low / medium (recommendation) | A non-private `@State` property | [State](https://developer.apple.com/documentation/swiftui/state) |
| `swiftui-blocking-work-in-body` | medium / medium (potential) | Synchronous I/O (`Data/String(contentsOf:)`, `contentsOfFile:`) or `Thread.sleep` **directly** in a `var body: some View { }` scope. Calls inside `.task`/`onAppear`/button actions and nested closures are not flagged | [View.task](https://developer.apple.com/documentation/swiftui/view/task(priority:_:)) |
| `swift-detached-task-captures-self` | medium / medium (potential) | A `Task.detached { }` closure that captures `self` — it inherits no actor isolation, so touching `self`'s (often `@MainActor`) state crosses the boundary. Structured `Task { }`, `.task`, `MainActor.run` and self-free detached work are not flagged | [Swift concurrency](https://docs.swift.org/swift-book/documentation/the-swift-programming-language/concurrency/) |

Construct recognition (`Parser.detectSwiftConstructs`) identifies SwiftUI `View`/
`App`/`Scene` types, legacy `ObservableObject` classes and `@Published`, modern
`@Observable` types, the property wrappers (`@State`/`@Binding`/`@StateObject`/
`@ObservedObject`/`@Environment`/`@EnvironmentObject`/`@Bindable`), `actor`
declarations, `@MainActor`, async/await and task patterns, services/repositories
and `@Model`/SwiftData — all from source, never from filenames alone.

**Both Observation systems are supported.** Legacy `ObservableObject` is **not**
treated as incorrect — a project targeting older OS versions, or mid-migration,
may legitimately use it, and a project may mix both. The wrapper/type-mismatch
rules (B and C) fire only when the model type's conformance is actually resolved
from project source (ObservableObject vs `@Observable`), so a name, an `import`,
or an unresolved external type never produces a finding. See Apple's
[SwiftUI documentation](https://developer.apple.com/documentation/swiftui) and
[Managing model data](https://developer.apple.com/documentation/SwiftUI/Managing-model-data-in-your-app).

**Version/compatibility & concurrency caveats.** CodeFlow is **source-code only**
and does not read project configuration, so it cannot know the deployment target,
Swift language mode or compiler actor-isolation settings. It therefore avoids
definitive version-specific or isolation-certain claims: concurrency findings are
limited to the demonstrable `Task.detached`-captures-`self` case (reported as
*potential*, not a confirmed data race), and it does **not** flag a ViewModel
merely for lacking `@MainActor`, nor legitimate `@MainActor`, `MainActor.run`,
structured concurrency or SwiftUI `.task`. Android MVVM conventions are not imposed
on SwiftUI.

### React

| Rule id | Severity / confidence | What it flags | Reference |
| --- | --- | --- | --- |
| `react-array-index-key` | medium / medium (potential) | A list rendered with `key={index}` where `index` is the `.map` index parameter | [Rendering lists / keys](https://react.dev/learn/rendering-lists#why-does-react-need-keys) |

Normal React hooks (`useState`, `useEffect`, custom `useX` hooks), large
components, and stable keys (`key={item.id}`) are deliberately **not** flagged.
See the official [React docs](https://react.dev/learn). Android-style MVVM is not
imposed on React.

### Flutter / Dart

Flutter rules run only when the project is detected as **Flutter** (a
`package:flutter/` import in a `.dart` file — detection is source-based; see the
framework-detection note above). Plain Dart packages are detected as Dart but get
no Flutter rules. Recognition (`Parser.detectDartConstructs`) classifies widgets
(`extends StatelessWidget/StatefulWidget`), `State<T>` classes, view-models/state
controllers (`extends ChangeNotifier/StateNotifier/Cubit/Bloc`, or
`…ViewModel/Controller/Notifier`), repositories, services, and the state-management
library in use (Provider / Riverpod / BLoC / ChangeNotifier) — no particular
library or MVVM naming is required.

| Rule id | Severity / confidence | What it flags | Reference |
| --- | --- | --- | --- |
| `flutter-buildcontext-across-async-gap` | high / medium (potential) | A `BuildContext` used after an `await` in the same block with no `mounted` / `context.mounted` guard in between | [use_build_context_synchronously](https://dart.dev/tools/linter-rules/use_build_context_synchronously) |
| `flutter-missing-dispose` | high / high (no dispose) · high / medium (dispose misses the field) | A `State<T>` that **constructs** a controller/subscription (`AnimationController`, `TextEditingController`, `…`, or `x.listen(...)`) and never releases it in `dispose()` | [State.dispose](https://api.flutter.dev/flutter/widgets/State/dispose.html) |
| `flutter-widget-builds-data-layer` | medium / medium (potential) | A widget/`State` that directly constructs a concrete data source (`http.Client()`, `Dio()`, `HttpClient()`, `FirebaseFirestore.instance`) **when the project already defines a `*Repository` boundary** | [Flutter app architecture](https://docs.flutter.dev/app-architecture/guide) |

These rules are deliberately conservative to avoid false positives: a guarded
`context` after `await`, a field that is **passed in** (not constructed by the
class), a controller released with `.dispose()/.cancel()/.close()`, idiomatic
`ChangeNotifier`/`setState`/Provider/Riverpod/BLoC usage, and a project without a
repository boundary are all left alone. CodeFlow does not require MVVM class names
or a UseCase layer. References: the Flutter
[architecture guide](https://docs.flutter.dev/app-architecture/guide),
[recommendations](https://docs.flutter.dev/app-architecture/recommendations),
[case study](https://docs.flutter.dev/app-architecture/case-study) and Dart
[analysis tooling](https://dart.dev/tools/analysis).

## Known limitations / unsupported cases

- Detection is **intraprocedural and lexical**, not a full type-resolved AST or
  taint analysis. Rules flag the site of a pattern, not whether a value is truly
  attacker-controlled or whether a cross-file abstraction exists.
- Cross-file layer inference (e.g. "a repository boundary exists elsewhere") is
  not resolved; `android-ui-builds-data-layer` keys off direct construction in a
  UI file, which is the demonstrable case.
- `react-array-index-key` ties the key to the `.map` index parameter within a
  window after the callback; unusual formatting may be missed (a false negative,
  by design, rather than a false positive).
- These rules do not run for Android generated/build output, tests, fixtures,
  docs, or dev tooling.
- AI "skills" documentation (e.g. Kotlin's
  [AI skills](https://kotlinlang.org/docs/kotlin-ai-skills.html)) is about agent
  guidance and does **not** provide static-analysis capabilities; these rules are
  plain static analysis.

## One project at a time

Analysis is always scoped to the single selected project. The Android project
selector keeps one-project-at-a-time analysis; independent Android Studio
projects are never combined into one dependency graph.

## Running the tests

```bash
npm test                                            # full suite
node --test tests/architecture-insights.test.mjs    # architecture insights only
node --test tests/security-precision.test.mjs       # security precision/recall
```

`tests/architecture-insights.test.mjs` covers ecosystem detection (Kotlin,
`.kts`, mixed Kotlin/Java, Swift, SwiftUI, React JS, React TS/TSX, non-React
TS, and unrelated languages), each architecture rule's precision and recall,
false-positive guards (comments, strings, idiomatic patterns), identical
filenames in different directories, accurate line numbers and snippets, and
integration into `data.suggestions` and `data.architectureInsights`.

## Interactive Architecture Guide

The **GUIDE** tab lives in the existing right-hand details panel. Select a Code
card, retained visualization node, Files entry, search match, or finding source
reference. All use the existing file selection and navigation callbacks. GUIDE
stays active when selecting another file. With no selection it asks you to select
a source file and offers lessons for detected ecosystems; it creates no component.
On mobile use the existing Details panel control. Native buttons, disclosure
summaries, focus outlines and a horizontally scrollable tab strip support keyboard
and narrow-screen use; examples scroll horizontally.

### Supported components and teaching

- Kotlin: Activity, Fragment, Composable, ViewModel, Repository, Room DAO,
  Retrofit API, Service and optional UseCase. Lessons cover state hoisting,
  immutable StateFlow/UI state, lifecycle-aware collection, scope ownership,
  viewModelScope, repository boundaries and dispatcher injection.
- Swift: SwiftUI View, ObservableObject, @Observable models and actors, plus
  inferred repositories/services. State ownership, legacy versus modern
  Observation, @Binding versus @Bindable, task lifetime and actor isolation are
  taught without assuming deployment targets or compiler isolation settings.
- Flutter/Dart: Widget/View, State object, ViewModel/state controller,
  ChangeNotifier, StateNotifier, Riverpod Notifier/AsyncNotifier, BLoC/Cubit,
  repository and service. Guidance respects detected Provider/Riverpod/BLoC
  imports and state management. Data-only Dart files in a detected Flutter
  project receive explicitly inferred project framework context. Plain Dart
  without Flutter evidence receives no Flutter lessons.

Multiple declarations remain separate. Each component has responsibility,
framework context, appropriate dependencies, mistakes and exceptions. Syntax
recognition has high confidence **within the documented lexical heuristic**;
naming/partial evidence is medium confidence and explicitly inferred. An unknown
role stays unknown. No compiler verification or runtime behavior is claimed.

### Data ownership, evidence and navigation

`describeGuideFile` calls the existing Kotlin/Swift/Dart construct recognizers
inside `buildAnalysisData`, before contents are discarded. Compact `file.guide`
metadata contains component names, roles, real declaration/import lines, framework
context and import names/targets. It contains no copied source snippets. Worker,
browser and test analysis use this same pass. Old cache entries without this
metadata display an unavailable message and ask for Re-analyze.

`buildGuideIndex` indexes existing files, `data.connections` and the **full**
`data.architectureInsights`. The memoized index is keyed by analysis result
references, scope and exclusions; hydrating a card's source does not reconstruct
it. GUIDE does not read source, run the analyzer on selection, create a second
graph, or use inferred/synthetic diagram edges.

Existing call edges store definition → caller; GUIDE reverses this for outgoing
**Depends on** and incoming **Used by**. A function key is required and the label
is **Function call (heuristic)**. These are existing analyzer name/import matches,
not compiler-resolved receiver dispatch or runtime traces. Definition navigation
uses `fnStats`' real line; navigating to a caller without call-site metadata opens
the file with no invented line. Imports recognized from uncommented source are
shown as **Imported module**; local targets resolved by the existing import
resolver are separately labeled **Imported file**. Kotlin package imports,
Swift modules and most Dart package imports do not resolve to local types in the
current resolver. GUIDE explicitly reports this limitation instead of fabricating
type associations. Architectural layer labels are inferred context on actual
edges, not separate verified edges.

Explore one relationship explicitly to navigate using `goToFile` and existing
Code cards. Previous returns along the walkthrough. Repeated paths are disabled,
depth is capped at 12, and no bulk traversal runs. Components, relationships,
imports and findings initially render at most 20 each, with explicit controls to
reach further entries; function lists show 20 with a full-source action.

Findings retain exact path matching, one-based lines, expression text, severity,
confidence and issue/potential/recommendation classification. Explanations,
remediation, linked `LEARNING_TOPICS` and controlled official URLs reuse the
catalog. No findings means only that the implemented rules reported none. All
lessons are bundled original content, filtered by selected ecosystem and ranked
by findings, roles and bounded related component context. Examples are labeled
**Illustrative example — not project code**. External pages are never downloaded
or scraped automatically. Source and examples render as React text; official
HTTPS links use an explicit hostname allowlist and open only on user interaction.

### Project lifecycle and security

Guide selection resolves against the current analysis, source-code eligibility
and current exclusions. Missing/excluded/unsafe paths cannot be selected, previewed
or opened as cards through navigation. Registered-project caches for another
active root cannot provide GUIDE content or live source reads. Project/session
and analysis revisions reset walkthrough state; fresh analysis clears selection
and replaces findings/relationships. Watched edits conservatively hide GUIDE
analysis until Re-analyze. This avoids treating old findings as current.

Superseded analysis runs and late previews are rejected by generation/identity
checks. A slower preview cannot replace a newer file preview. Registered-project
file enumeration and reads carry the selected project id (`pid`); the server
rejects mismatches with 409, snapshots root/exclusions, and rejects a scope change
while resolving/enumerating. Reads retain existing root, symlink, source-code-only
and exclusion enforcement. No analyzed files are changed, no external calls run,
and no source is saved to general settings. Existing analysis-cache behavior is
preserved; new guide metadata adds no source snippets.

### Tests and read-only smoke verification

```sh
node --test tests/architecture-guide.test.mjs tests/architecture-guide-scope.test.mjs
node --test tests/architecture-insights.test.mjs tests/architecture-foundation.test.mjs tests/kotlin-architecture-phase-c.test.mjs tests/swift-architecture-phase-d.test.mjs tests/flutter-architecture.test.mjs tests/security-precision.test.mjs tests/security-selfscan.test.mjs tests/local-only-runtime.test.mjs
npm test
node --test tests/inline-babel-parse.smoke.js tests/html-inline-script-analysis.smoke.js
node --check server/projects-server.mjs
node tests/verify-architecture-guide.mjs
```

The optional last command reads only the currently registered/selected project's
source endpoints on `127.0.0.1:4173`. It runs the shared analyzer, verifies findings
against source, selects a real Kotlin component, follows an existing relationship,
checks source navigation, and reports timing/counts without printing source or
changing registry/project data. It requires a real Kotlin project selected first.
Unit tests execute classification, React element rendering and handlers, actual
selection/search/preview callbacks, stale analyzer/preview rejection, scope and
exclusion HTTP guards, cycles, uncapped findings, language separation, official
URLs, and bounded large-project rendering. They require no packages or network.
They do not substitute for visual/browser verification.

Known limits: heuristic declarations may miss multiline/qualified bases, custom
base types, complex annotations, extension/macro-generated components or generated
Riverpod classes. Type/receiver resolution, DI wiring and complete execution paths
are unavailable; these are not guessed. Other source languages keep the existing
canvas, functions and findings but have no specialized Guide role curriculum.
This phase does not add a compiler, parser grammar or analyzer pipeline.
