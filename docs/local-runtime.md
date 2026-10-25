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
