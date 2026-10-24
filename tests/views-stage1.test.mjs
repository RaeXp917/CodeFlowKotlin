// Visualization views — current supported set and Code default.
// (Stage 1 removed Cluster and defaulted to Tree Map; the Stage 2 follow-up
// removed Matrix, Tree Map and Block Diagram and made Code the default. This
// file tracks the current, authoritative behavior.)
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

const REMOVED = ['disjoint', 'treemap', 'matrix', 'architecture'];
const RETAINED = ['graph', 'code', 'graph3d', 'dendro', 'sankey', 'bundle'];

test('supported viz types are exactly the retained set', () => {
  assert.deepEqual([...context.SUPPORTED_VIZ_TYPES].sort(), [...RETAINED].sort());
  REMOVED.forEach((v) => assert.equal(context.isSupportedVizType(v), false, v + ' should be unsupported'));
  RETAINED.forEach((v) => assert.equal(context.isSupportedVizType(v), true, v + ' should be supported'));
});

test('Code is the default visualization', () => {
  assert.equal(context.DEFAULT_VIZ_TYPE, 'code');
  assert.match(html, /viewMode:'force',vizType:DEFAULT_VIZ_TYPE/);
});

test('removed/unknown views normalize to Code; valid views are preserved', () => {
  REMOVED.forEach((v) => assert.equal(context.normalizeVizType(v), 'code', v + ' must normalize to code'));
  ['metrics', 'cluster', undefined, null, ''].forEach((v) =>
    assert.equal(context.normalizeVizType(v), 'code'));
  RETAINED.forEach((v) => assert.equal(context.normalizeVizType(v), v, v + ' must be preserved'));
});

test('Matrix, Tree Map and Block Diagram are gone from the selector and rendering', () => {
  ['treemap', 'matrix', 'architecture'].forEach((v) => {
    assert.ok(!html.includes("value:'" + v + "'"), v + ' option still present');
    assert.ok(!html.includes("vizType==='" + v + "'"), v + ' render/branch still present');
  });
  assert.doesNotMatch(html, /renderArchitectureView/);
  assert.doesNotMatch(html, /treemapRef|matrixRef|architectureRenderRef/);
  // No dedicated styling for the removed views remains.
  assert.doesNotMatch(html, /\.treemap-container\b/);
  assert.doesNotMatch(html, /\.matrix-container\b/);
  assert.doesNotMatch(html, /\.architecture-view\b/);
});

test('the retained visualizations remain selectable and renderable', () => {
  const opts = {
    code: 'Code', graph: 'Graph', graph3d: '3D Graph',
    dendro: 'Tree', sankey: 'Flow', bundle: 'Bundle',
  };
  Object.entries(opts).forEach(([v, label]) => {
    assert.ok(html.includes("React.createElement('option',{value:'" + v + "'}," + "'" + label + "')"),
      'missing option ' + v);
  });
  assert.match(html, /vizType==='code'&&renderCodeView\(\)/);
  assert.match(html, /vizType==='graph'&&React\.createElement\('svg'/);
});

test('architecture/security/metrics analysis capabilities are preserved', () => {
  // Block Diagram view is gone, but the architecture findings/model remain.
  assert.match(html, /function buildArchitectureDiagram\(/);
  assert.match(html, /function generateMermaidBlockDiagram\(/);
  assert.match(html, /architectureDiagram:architectureDiagram/);
  assert.match(html, /detectArchitectureInsights:function/);
  assert.match(html, /function computeArchitectureInsights\(/);
  // Security + internal metrics stay.
  assert.match(html, /detectSecurity/);
  assert.match(html, /function codeCardContentMetrics\(/);
  assert.match(html, /Impact Metrics/);
});
