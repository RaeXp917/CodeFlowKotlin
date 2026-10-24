// Stage 1 — Visualization cleanup and Tree Map default.
// Verifies: Cluster (disjoint) removed from UI and unreachable; Metrics view
// absent while internal metrics are preserved; Tree Map is the initial default;
// a previously saved/unsupported view falls back safely to Tree Map; Block
// Diagram and the other retained visualizations remain available.
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import vm from 'node:vm';

const __dirname = dirname(fileURLToPath(import.meta.url));
const html = await readFile(join(__dirname, '..', 'index.html'), 'utf8');

// Load the canvas helper block (where the viz-type helpers live) in a sandbox.
const startMarker = '// ===== CODEFLOW_CANVAS_START =====';
const endMarker = '// ===== CODEFLOW_CANVAS_END =====';
const start = html.indexOf(startMarker);
const end = html.indexOf(endMarker, start);
if (start < 0 || end < 0) throw new Error('Could not locate canvas helpers in index.html');
const context = { console };
vm.createContext(context);
vm.runInContext(html.slice(start, end + endMarker.length), context);

test('supported viz types exclude the removed Cluster (disjoint)', () => {
  assert.ok(Array.isArray(context.SUPPORTED_VIZ_TYPES), 'SUPPORTED_VIZ_TYPES missing');
  assert.equal(context.SUPPORTED_VIZ_TYPES.indexOf('disjoint'), -1, 'disjoint must not be a supported view');
  assert.equal(context.isSupportedVizType('disjoint'), false);
  // Retained views remain supported.
  ['graph', 'code', 'graph3d', 'treemap', 'matrix', 'dendro', 'sankey', 'bundle', 'architecture'].forEach((v) => {
    assert.equal(context.isSupportedVizType(v), true, v);
  });
});

test('Tree Map is the initial default visualization', () => {
  assert.equal(context.DEFAULT_VIZ_TYPE, 'treemap');
  // The React state initializer uses the shared default constant.
  assert.match(html, /viewMode:'force',vizType:DEFAULT_VIZ_TYPE/);
});

test('a previously saved / unsupported view falls back safely to Tree Map', () => {
  assert.equal(context.normalizeVizType('disjoint'), 'treemap', 'removed Cluster must fall back to Tree Map');
  assert.equal(context.normalizeVizType('metrics'), 'treemap', 'an unknown saved view must fall back');
  assert.equal(context.normalizeVizType(undefined), 'treemap');
  assert.equal(context.normalizeVizType(''), 'treemap');
  assert.equal(context.normalizeVizType(null), 'treemap');
  // A valid saved preference is preserved, not overridden.
  assert.equal(context.normalizeVizType('graph'), 'graph');
  assert.equal(context.normalizeVizType('architecture'), 'architecture');
  assert.equal(context.normalizeVizType('treemap'), 'treemap');
});

test('Cluster is removed from the selector, rendering and state', () => {
  assert.doesNotMatch(html, /value:'disjoint'/, 'Cluster option still present in selector');
  assert.doesNotMatch(html, /vizType==='disjoint'/, 'Cluster rendering branch still present');
  assert.doesNotMatch(html, /disjointRef/, 'disjoint ref still present');
  assert.doesNotMatch(html, /class','disjoint-/, 'disjoint D3 classes still present');
  assert.doesNotMatch(html, /'cluster-bg'/, 'cluster-bg helper still present');
  // The generic unused "cluster" icon case was dropped.
  assert.doesNotMatch(html, /case 'cluster':/, 'dead cluster icon case still present');
});

test('the viz selector no longer wires an unthickened Cluster view', () => {
  assert.equal(context.vizUsesLineThickness('disjoint'), false);
});

test('Block Diagram (architecture) is retained', () => {
  assert.match(html, /React\.createElement\('option',\{value:'architecture'\},'Block Diagram'\)/);
  assert.match(html, /vizType==='architecture'&&renderArchitectureView\(\)/);
});

test('all other retained visualizations remain selectable', () => {
  const retained = [
    ["value:'graph'", 'Graph'],
    ["value:'code'", 'Code'],
    ["value:'graph3d'", '3D Graph'],
    ["value:'treemap'", 'Treemap'],
    ["value:'matrix'", 'Matrix'],
    ["value:'dendro'", 'Tree'],
    ["value:'sankey'", 'Flow'],
    ["value:'bundle'", 'Bundle'],
  ];
  retained.forEach(([needle]) => assert.ok(html.includes(needle), 'missing option ' + needle));
});

test('no standalone Metrics view exists, but internal metrics are preserved', () => {
  // There is no user-visible "Metrics" view/panel option to navigate to.
  assert.doesNotMatch(html, /value:'metrics'/);
  assert.doesNotMatch(html, /React\.createElement\('option',\{value:'[^']*'\},'Metrics'\)/);
  // Internal metrics computation and the impact-analysis metrics card remain.
  assert.ok(html.includes('function codeCardContentMetrics('), 'internal code metrics removed');
  assert.ok(html.includes('Impact Metrics'), 'impact-analysis metrics card removed');
});
