// Project-wide "Find in Files" for the CodeFlowKotlin local server.
//
// Pure, dependency-free content/filename search over the files of a single
// already-authorized project root. The server resolves the root from the active
// project id and passes in the project's exclusion matcher; this module never
// accepts an absolute root from the client and never reaches outside the files
// it is handed. All matching is bounded (query length, files, bytes, matches,
// time) and every limit that trims output is reported, never silently applied.
//
// Glob syntax for include/exclude filters (documented in README):
//   *   matches any run of characters except "/"
//   **  matches any characters including "/"
//   ?   matches a single character except "/"
//   A pattern WITHOUT "/" matches against the file's basename (so "*.kt" matches
//   "a/b/C.kt"); a pattern WITH "/" matches against the whole project-relative
//   POSIX path. Patterns are comma- or newline-separated and case-insensitive.

import { promises as fsp } from 'node:fs';
import path from 'node:path';
import { listWatchFiles } from './server-utils.mjs';

export const SEARCH_LIMITS = Object.freeze({
  maxQueryLen: 200,
  maxFiles: 5000,
  maxFileBytes: 1024 * 1024,        // skip individual files larger than this
  maxTotalBytes: 64 * 1024 * 1024,  // stop reading content past this budget
  maxMatches: 2000,                 // total content matches returned
  maxMatchesPerFile: 50,
  maxResults: 1000,                 // total files in the result list
  timeBudgetMs: 8000,
  previewMaxLen: 240,
  maxRegexLineLen: 5000,            // skip regex matching on lines longer than this
});

export function escapeRegExp(s) {
  return String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

export function parseGlobList(input) {
  if (Array.isArray(input)) input = input.join('\n');
  return String(input || '')
    .split(/[\n,]/)
    .map((s) => s.trim())
    .filter(Boolean)
    .slice(0, 64);
}

// Convert a single glob to an anchored, case-insensitive RegExp source body.
export function globToRegExpSource(glob) {
  let out = '';
  const g = String(glob);
  for (let i = 0; i < g.length; i++) {
    const c = g[i];
    if (c === '*') {
      if (g[i + 1] === '*') { out += '.*'; i++; } // ** -> any incl. /
      else out += '[^/]*';                         // *  -> any except /
    } else if (c === '?') {
      out += '[^/]';
    } else {
      out += escapeRegExp(c);
    }
  }
  return out;
}

// Build a matcher over project-relative POSIX paths. `emptyMatches` is returned
// when there are no patterns (true for include = "match all", false for exclude).
export function buildGlobMatcher(patterns, emptyMatches) {
  const list = parseGlobList(patterns);
  if (!list.length) return () => emptyMatches;
  const compiled = list.map((p) => {
    const hasSlash = p.includes('/');
    return { re: new RegExp('^' + globToRegExpSource(p) + '$', 'i'), hasSlash };
  });
  return (rel) => {
    const relPath = String(rel || '').replace(/\\/g, '/');
    const base = relPath.split('/').pop();
    for (const { re, hasSlash } of compiled) {
      if (re.test(hasSlash ? relPath : base)) return true;
    }
    return false;
  };
}

// Compile the query into a reusable matcher. Literal queries are escaped (no
// backtracking risk); regex mode compiles the user pattern and is only applied
// to reasonably short lines to bound worst-case cost.
export function makeMatcher({ query, caseSensitive, wholeWord, regex }, limits = SEARCH_LIMITS) {
  const q = String(query == null ? '' : query);
  if (!q) return { error: 'empty-query' };
  if (q.length > limits.maxQueryLen) return { error: 'query-too-long' };
  const flags = caseSensitive ? 'g' : 'gi';
  let re;
  if (regex) {
    try { re = new RegExp(q, flags); } catch { return { error: 'invalid-regex' }; }
  } else {
    let body = escapeRegExp(q);
    if (wholeWord) body = '(?<![A-Za-z0-9_])' + body + '(?![A-Za-z0-9_])';
    re = new RegExp(body, flags);
  }
  const isRegex = !!regex;
  function findInLine(line, maxPerLine) {
    if (isRegex && line.length > limits.maxRegexLineLen) return [];
    const out = [];
    re.lastIndex = 0;
    let m;
    while ((m = re.exec(line)) !== null) {
      const len = m[0].length;
      if (len === 0) { re.lastIndex++; continue; } // avoid zero-width loop
      out.push({ index: m.index, length: len });
      if (out.length >= maxPerLine) break;
    }
    return out;
  }
  function testString(s) {
    re.lastIndex = 0;
    const r = re.test(String(s || ''));
    re.lastIndex = 0;
    return r;
  }
  return { regex: re, findInLine, testString };
}

// Split text into lines, preserving one-based numbers and handling CRLF/LF/CR.
export function splitLines(text) {
  return String(text == null ? '' : text).split(/\r\n|\r|\n/);
}

// Scan file text for content matches. Pure and fs-free so it is unit-testable.
export function scanContent(text, matcher, limits = SEARCH_LIMITS) {
  const lines = splitLines(text);
  const matches = [];
  let truncatedFile = false;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const found = matcher.findInLine(line, limits.maxMatchesPerFile - matches.length);
    for (const f of found) {
      matches.push({
        line: i + 1,                 // one-based
        col: f.index,                // zero-based column within the line
        length: f.length,
        preview: line.length > limits.previewMaxLen ? line.slice(0, limits.previewMaxLen) : line,
      });
      if (matches.length >= limits.maxMatchesPerFile) { truncatedFile = true; break; }
    }
    if (matches.length >= limits.maxMatchesPerFile) break;
  }
  return { matches, truncatedFile };
}

// Search an already-authorized project root. `isExcluded` is the project's
// exclusion matcher; `isAborted`/time budget allow superseded searches to stop.
export async function searchProjectRoot(root, opts = {}) {
  const limits = opts.limits || SEARCH_LIMITS;
  const isExcluded = typeof opts.isExcluded === 'function' ? opts.isExcluded : () => false;
  const isAborted = typeof opts.isAborted === 'function' ? opts.isAborted : () => false;
  // readFile receives the resolved ABSOLUTE path of each candidate file.
  const readFile = opts.readFile || ((abs) => fsp.readFile(abs, 'utf8'));
  // Search uses the same source-code enumeration as analysis (code-only policy).
  const enumerate = opts.enumerate || ((r, ex) => listWatchFiles(r, ex));

  const matcher = makeMatcher(opts, limits);
  if (matcher.error) return { error: matcher.error };

  const includeMatcher = buildGlobMatcher(opts.include, true);
  const excludeMatcher = buildGlobMatcher(opts.exclude, false);

  const reasons = new Set();
  let all = await enumerate(root, isExcluded);
  if (all.length > limits.maxFiles) { reasons.add('max-files'); all = all.slice(0, limits.maxFiles); }
  const candidates = all.filter((f) => includeMatcher(f.path) && !excludeMatcher(f.path));

  const results = [];
  const stats = { filesTotal: all.length, filesConsidered: candidates.length, filesScanned: 0, filesMatched: 0, totalMatches: 0, bytesScanned: 0 };
  const start = Date.now();
  let truncated = reasons.size > 0;

  for (let i = 0; i < candidates.length; i++) {
    if (isAborted()) { reasons.add('aborted'); truncated = true; break; }
    if (Date.now() - start > limits.timeBudgetMs) { reasons.add('time'); truncated = true; break; }
    if (results.length >= limits.maxResults) { reasons.add('max-results'); truncated = true; break; }
    if (stats.totalMatches >= limits.maxMatches) { reasons.add('max-matches'); truncated = true; break; }

    const f = candidates[i];
    const fileMatch = matcher.testString(f.path);
    let contentMatches = [];

    if (f.size <= limits.maxFileBytes) {
      if (stats.bytesScanned < limits.maxTotalBytes) {
        let text = '';
        const abs = f.absolute || path.join(root, f.path);
        try { text = await readFile(abs, 'utf8'); } catch { text = ''; }
        if (typeof text !== 'string') text = String(text);
        stats.bytesScanned += text.length;
        stats.filesScanned += 1;
        const remaining = limits.maxMatches - stats.totalMatches;
        const perFileLimit = Math.min(limits.maxMatchesPerFile, remaining);
        const scan = scanContent(text, matcher, Object.assign({}, limits, { maxMatchesPerFile: perFileLimit }));
        contentMatches = scan.matches;
        if (scan.truncatedFile) { reasons.add('matches-per-file'); truncated = true; }
      } else {
        reasons.add('total-bytes');
        truncated = true;
      }
    } else {
      reasons.add('file-too-large');
    }

    if (fileMatch || contentMatches.length) {
      results.push({
        path: f.path,
        name: f.name,
        folder: f.folder || 'root',
        fileMatch,
        matches: contentMatches,
      });
      stats.filesMatched += 1;
      stats.totalMatches += contentMatches.length;
    }
  }

  // Deterministic order: files with content matches first, then by path.
  results.sort((a, b) => (b.matches.length > 0) - (a.matches.length > 0) || a.path.localeCompare(b.path));
  return { results, stats, truncated, reasons: [...reasons] };
}
