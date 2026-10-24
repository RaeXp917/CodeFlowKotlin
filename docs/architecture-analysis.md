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
   ecosystems are present, from reliable evidence:
   - **Kotlin/Android** — an `AndroidManifest.xml`, or `.kt`/`.kts` files that
     import `androidx.*` / `android.*`.
   - **Swift/SwiftUI** — `.swift` files that `import SwiftUI`.
   - **React** — a `package.json` depending on `react`/`react-dom`/`next`, a
     `.jsx`/`.tsx` file importing `react`, or a `.js`/`.ts` file importing `react`.
   - **Flutter / Dart** — a `.dart` file or a `pubspec.yaml` marks a **Dart**
     project; **Flutter** is claimed only with explicit evidence: a flutter SDK
     dependency in `pubspec.yaml` (`sdk: flutter`) or a `package:flutter/` import.
     A plain Dart package is therefore detected as Dart but **not** Flutter.
   A plain JavaScript/TypeScript project with no React dependency is **not**
   treated as React, so its files are never flagged by React rules. The detector
   (`detectProjectEcosystems`) returns `{android, swiftui, react, flutter, dart}`.

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
does **not** advertise full syntax-aware (AST) Dart support. Flutter/Dart
architecture rules (added in a later phase) are built on this heuristic basis and
are written conservatively for the same reason.

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

Android guidance intentionally avoids dogma: CodeFlow does not require Clean
Architecture, UseCases or a fixed layer stack, and does not flag a ViewModel
merely for being large. See the official
[architecture recommendations](https://developer.android.com/topic/architecture/recommendations).

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
