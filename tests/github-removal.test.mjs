// Stage 4 — complete GitHub runtime removal.
// Negative: no GitHub adapter, scanning, URL input, ZIP download, PR analysis,
// rate-limit handling, or api.github.com requests remain anywhere in the browser
// runtime. Positive: the local-project pipeline and the shared analyzer/security/
// architecture engines are preserved and run offline.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(__dirname, '..', 'index.html'), 'utf8');

test('no GitHub API adapter or request helpers remain', () => {
  assert.doesNotMatch(html, /var GitHub=\{/);
  assert.doesNotMatch(html, /buildGitHubApiUrl/);
  assert.doesNotMatch(html, /buildRepoApiUrl/);
  assert.doesNotMatch(html, /\bGitHub\.(scan|getFile|getCommits|getPR|getRateLimit|getBlame|request|fetch)\b/);
  assert.doesNotMatch(html, /generateJWT|authenticateApp|getInstallationToken/);
});

test('no remote analysis entrypoints, source modes or share links remain', () => {
  assert.doesNotMatch(html, /function analyze\(forceRefresh/);
  assert.doesNotMatch(html, /function analyzePR\(/);
  assert.doesNotMatch(html, /function parseUrl\(/);
  assert.doesNotMatch(html, /startGithubZipDownload|downloadCurrentGithubZip|githubZipDownloadUrl/);
  assert.doesNotMatch(html, /githubCacheSourceKey|githubSourceKeyForLoadedAnalysis/);
  assert.doesNotMatch(html, /function buildAppUrl/);
  assert.doesNotMatch(html, /function copyLink/);
});

test('no GitHub URL / PR / Share controls remain in either topbar', () => {
  assert.doesNotMatch(html, /github-url-input/);
  assert.doesNotMatch(html, /Open GitHub URL/);
  assert.doesNotMatch(html, /Analyze Pull Request/);
  assert.doesNotMatch(html, /'Copy share link'/);
  assert.doesNotMatch(html, /Download GitHub ZIP/);
  assert.doesNotMatch(html, /PR Impact Analyzer/);
});

test('the runtime makes no request to GitHub endpoints', () => {
  assert.doesNotMatch(html, /api\.github\.com/);
  assert.doesNotMatch(html, /github\.com\/[^'"]*\/archive/);
  assert.doesNotMatch(html, /Rate limited.*GitHub token/);
});

test('GitHub query parameters cannot trigger remote analysis on startup', () => {
  // The startup effect no longer reads ?repo / ?run.
  assert.doesNotMatch(html, /params\.get\('repo'\)/);
  assert.doesNotMatch(html, /params\.get\('run'\)/);
});

test('the local-project pipeline and shared analyzer are preserved', () => {
  assert.match(html, /function analyzeLocalProject\(/);
  assert.match(html, /function loadActiveProject\(/);
  assert.match(html, /\/__codeflow\/file\?path=/);// local source reads, not GitHub
  assert.match(html, /const Parser=\{/);
  assert.match(html, /runAnalysisData/);
  assert.match(html, /detectSecurity/);
  assert.match(html, /function computeArchitectureInsights\(/);
  assert.match(html, /function buildArchitectureDiagram\(/);
  assert.match(html, /function calcBlast\(/);
});

test('the analyzer engine loads and runs offline (no network needed)', () => {
  const s = '// ===== CODEFLOW_ANALYZER_START =====';
  const e = '// ===== CODEFLOW_ANALYZER_END =====';
  const a = html.indexOf(s);
  const b = html.indexOf(e, a);
  const block = html.slice(a, b);
  // No remote/GitHub calls inside the shared analyzer block.
  assert.doesNotMatch(block, /api\.github\.com|githubusercontent|github\.com\/[^'"]*\/archive/);
  const ctx = { console, getSecurityScanContent: (f) => (f && f.content ? f.content : ''), isSanitizedPreviewRenderer: () => false };
  vm.createContext(ctx);
  vm.runInContext(block + '\nthis.Parser=Parser;', ctx);
  // Analyze a tiny in-memory project with no network access at all.
  const files = [
    { path: 'app/src/main/kotlin/Main.kt', name: 'Main.kt', content: 'class Main { fun run() {} }', isCode: true },
  ];
  const insights = ctx.Parser.detectArchitectureInsights(files);
  assert.ok(Array.isArray(insights));
  assert.equal(ctx.Parser.detectProjectEcosystems(files).android === undefined, false);
});

test('privacy copy states there are no external services', () => {
  assert.match(html, /No External Services/);
  assert.match(html, /no remote repository analysis/);
  assert.match(html, /makes no external network requests/);
});
