# Architecture Analysis & Intelligent Suggestions

CodeFlow is a general-purpose, multi-language analyzer. On top of its existing
graph, dependency, pattern, duplication and security analysis, it adds a small,
high-confidence set of **architecture insights** for three priority ecosystems:
**Kotlin/Android**, **Swift/SwiftUI** and **React**.

The design goal is trustworthiness: a smaller number of correct, evidence-based
rules rather than many superficial keyword matches. Every finding is anchored to
real source with a one-based line number and the triggering expression, and
carries a problem explanation, remediation and an official documentation link.

## Supported languages

Architecture insights are additive and never reduce existing support. All
previously supported languages, file extensions, Tree-sitter grammars, language
detection, security rules, code-quality rules, graph/dependency analysis, and
suggestions continue to work unchanged. The three ecosystems below receive
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
| `swiftui-observedobject-ownership` | high / high | `@ObservedObject var x = Model()` — an owned model should be `@StateObject`. `@ObservedObject` passed in (no initializer) is fine | [StateObject](https://developer.apple.com/documentation/swiftui/stateobject) |
| `swiftui-state-not-private` | low / medium (recommendation) | A non-private `@State` property | [State](https://developer.apple.com/documentation/swiftui/state) |

See Apple's [SwiftUI documentation](https://developer.apple.com/documentation/swiftui).
Android MVVM conventions are not imposed on SwiftUI.

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
