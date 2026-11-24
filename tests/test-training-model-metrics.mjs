/**
 * test-training-model-metrics.mjs — pose/training-model-metrics.js (View Metrics, DOM-free) on a REAL
 * sleap-nn run (tests/fixtures/sleap-nn-training/run.full: metrics.val.0.json, metrics.train.0.json and
 * training_config.yaml of a 3-epoch single-instance run through the Rust path, paths rewritten):
 *   1. a row: run name, timestamp from the run name, model type, architecture, node names, the headline numbers;
 *   2. the split order: test, then val, then train; a run without metrics JSON (an older sleap-nn, or only
 *      the .npz) gives "—" (null summary), never a throw; a broken JSON becomes `row.error`;
 *   3. VOC keys read flat (sleap-nn) and nested; the detailed list keeps classic SLEAP's order;
 *   4. boxplots: per-node five-number summaries, numpy's percentile; the axis maximum.
 */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
    buildModelMetricsRow, normalizeMetrics, labeledMetrics, computeNodeBoxplots, distanceAxisMax, percentileSorted,
    parseTimestampFromRunName, runDirName, joinPath,
} from '../pose/training-model-metrics.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const RUN = path.join(root, 'tests', 'fixtures', 'sleap-nn-training', 'run.full');
const yamlPath = path.join(root, 'lib', 'yaml', 'browser', 'index.js');
const YAML = fs.existsSync(yamlPath) ? await import(pathToFileURL(yamlPath).href) : null;
const parseYaml = YAML ? (YAML.parse || YAML.default.parse) : (t) => { throw new Error('no yaml package'); };
const io = (files) => ({
    exists: async (p) => (files ? p in files : fs.existsSync(p)),
    readText: async (p) => (files ? files[p] : fs.readFileSync(p, 'utf8')),
    parseYaml,
});

// §1 the real run.
const row = await buildModelMetricsRow(RUN, io());
assert.equal(row.error, undefined, String(row.error));
assert.equal(row.metrics.split, 'val', 'no test split: val is next');
assert.equal(row.metrics.mode, 'oks');
const s = row.summary;
for (const k of ['oksMAP', 'mOKS', 'visPrecision', 'visRecall', 'distAvg', 'distP75', 'distP95', 'mPCK']) assert.ok(Number.isFinite(s[k]), k + ' ' + s[k]);
const raw = JSON.parse(fs.readFileSync(path.join(RUN, 'metrics.val.0.json'), 'utf8'));
assert.equal(s.oksMAP, raw.voc_metrics['oks_voc.mAP']);
assert.equal(s.distP95, raw.distance_metrics.p95);
if (YAML) {
    assert.equal(row.modelType, 'Single Instance');
    assert.match(row.architecture, /^UNet, max stride: \d+, filters: \d+$/);
    assert.ok(Array.isArray(row.nodeNames) && row.nodeNames.length >= 1, 'node names from the skeleton');
    assert.equal(row.runName, 'run.full');
} else {
    console.log('test-training-model-metrics: (offline yaml package not installed: config not parsed)');
}
assert.equal(parseTimestampFromRunName('261123_142211.centroid.n=12'), '2026-11-23 14:22:11');
assert.equal(parseTimestampFromRunName('run.full'), null);
assert.equal(runDirName('/a/b/run.x/'), 'run.x');
assert.equal(joinPath('C:\\m', 'x.json'), 'C:\\m\\x.json');

// §2 split order, missing and broken files.
const tv = { '/r/metrics.test.0.json': JSON.stringify({ mOKS: { mOKS: 0.9 } }), '/r/metrics.val.0.json': JSON.stringify({ mOKS: { mOKS: 0.1 } }) };
const r2 = await buildModelMetricsRow('/r', io(tv));
assert.equal(r2.metrics.split, 'test');
assert.equal(r2.summary.mOKS, 0.9);
const none = await buildModelMetricsRow('/n', io({ '/n/metrics.val.0.npz': 'PK' }));
assert.equal(none.summary, null, 'only the .npz: no numbers, no unpickling');
assert.equal(none.error, undefined);
assert.equal(none.runName, 'n');
const bad = await buildModelMetricsRow('/b', io({ '/b/metrics.val.0.json': '{not json' }));
assert.ok(bad.error && bad.summary === null, 'a broken file is an error on the row');

// §3 VOC flat and nested; the detailed list.
const nested = normalizeMetrics({ voc_metrics: { oks_voc: { mAP: 0.5, mAR: 0.6 }, pck_voc: { mAP: 0.7 } } });
assert.deepEqual([nested.voc.oksMAP, nested.voc.oksMAR, nested.voc.pckMAP], [0.5, 0.6, 0.7]);
const flat = normalizeMetrics({ voc_metrics: { 'oks_voc.mAP': 0.25, 'oks_voc.mAR': NaN } });
assert.deepEqual([flat.voc.oksMAP, flat.voc.oksMAR], [0.25, null], 'NaN is no value');
const list = labeledMetrics(row.metrics).map((x) => x.label);
assert.equal(list[0], 'Visibility - True Positives');
assert.ok(list.indexOf('Mean Object Keypoint Similarity (OKS)') > list.indexOf('Average Distance (ground truth vs prediction)'));
assert.deepEqual(labeledMetrics(null), []);

// §4 boxplots.
assert.equal(percentileSorted([1, 2, 3, 4], 50), 2.5);
assert.equal(percentileSorted([5], 95), 5);
const bx = computeNodeBoxplots([[1, null], [3, 2], [2, NaN]], ['head', 'tail']);
assert.deepEqual(bx.map((b) => [b.node, b.count, b.min, b.median, b.max]), [['head', 3, 1, 2, 3], ['tail', 1, 2, 2, 2]]);
assert.equal(computeNodeBoxplots([[null]], null)[0].count, 0);
const real = computeNodeBoxplots(row.metrics.distance.dists, row.nodeNames);
assert.equal(real.length, row.metrics.distance.dists[0].length, 'one box per node');
assert.equal(distanceAxisMax([]), 5);
assert.equal(distanceAxisMax([[12, 3]]), 20);

console.log('test-training-model-metrics: ok');
