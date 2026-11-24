/**
 * pose/training-model-metrics.js — a trained model's evaluation metrics, DOM-free: port of sleap-app's
 * `src/lib/metrics/loadModelMetrics.ts` + `boxplot.ts` (@ c97c6a5), for the Training panel's View Metrics
 * (`ui/training-metrics-dialog.js`).
 *
 * sleap-nn writes `metrics.{split}.{idx}.npz` AND a JSON sibling `metrics.{split}.{idx}.json`. Only the JSON
 * is read: the `.npz` holds pickled object arrays, and nothing here ever unpickles. A run without the JSON
 * (an older sleap-nn) shows "—" cells, as in sleap-app.
 *
 * File access is injected (`{exists(path), readText(path)}`) so Node tests run it on fixture folders
 * (tests/test-training-model-metrics.mjs).
 *
 * LUCID changes: the YAML parser is injected too (`parseYaml`, the importmap's `yaml`); `voc_metrics` is read
 * both as sleap-nn's flat keys (`"oks_voc.mAP"`) and nested (`oks_voc: {mAP}`).
 */

function num(v) { return typeof v === 'number' && Number.isFinite(v) ? v : null; }
function count(v) { return typeof v === 'number' && Number.isFinite(v) ? v : 0; }
function obj(v) { return v && typeof v === 'object' && !Array.isArray(v) ? v : null; }

/** Join a directory and a name with the directory's separator. */
export function joinPath(dir, name) {
    const sep = String(dir).indexOf('\\') !== -1 && String(dir).indexOf('/') === -1 ? '\\' : '/';
    return String(dir).replace(/[/\\]+$/, '') + sep + name;
}

/** The last part of a run folder's path (the table's Path column). */
export function runDirName(runDir) {
    const parts = String(runDir).replace(/[/\\]+$/, '').split(/[/\\]/);
    return parts[parts.length - 1] || String(runDir);
}

/** One VOC value, flat (`"oks_voc.mAP"`) or nested (`oks_voc.mAP`). */
function voc(v, family, key) {
    if (!v) return undefined;
    if ((family + '.' + key) in v) return v[family + '.' + key];
    const f = obj(v[family]);
    return f ? f[key] : undefined;
}

function normalizeDistance(raw) {
    if (!raw) return undefined;
    const dists = (Array.isArray(raw.dists) ? raw.dists : []).map(function (row) { return Array.isArray(row) ? row.map(num) : []; });
    return {
        avg: num(raw.avg), p50: num(raw.p50), p75: num(raw.p75), p90: num(raw.p90), p95: num(raw.p95), p99: num(raw.p99),
        dists: dists,
        frame_idxs: (Array.isArray(raw.frame_idxs) ? raw.frame_idxs : []).map(count),
        video_paths: (Array.isArray(raw.video_paths) ? raw.video_paths : []).map(String),
    };
}

/** sleap-app `normalizeMetrics`: tolerant of missing sections; `raw` kept. */
export function normalizeMetrics(raw, split) {
    const o = obj(raw) || {};
    const vocRaw = obj(o.voc_metrics);
    const distRaw = obj(o.distance_metrics);
    const mode = vocRaw ? 'oks' : o.mask_metrics ? 'mask' : o.semantic_metrics ? 'semantic' : distRaw ? 'centroid' : 'unknown';
    const pck = obj(o.pck_metrics);
    const vis = obj(o.visibility_metrics);
    let mOKS;
    if ('mOKS' in o) mOKS = obj(o.mOKS) ? num(o.mOKS.mOKS) : num(o.mOKS);
    return {
        mode: mode,
        split: split || 'val',
        voc: vocRaw ? {
            oksMAP: num(voc(vocRaw, 'oks_voc', 'mAP')), oksMAR: num(voc(vocRaw, 'oks_voc', 'mAR')),
            pckMAP: num(voc(vocRaw, 'pck_voc', 'mAP')), pckMAR: num(voc(vocRaw, 'pck_voc', 'mAR')),
        } : undefined,
        mOKS: mOKS,
        distance: normalizeDistance(distRaw),
        pck: pck ? { mPCK: num(pck.mPCK), pck5: num(pck['PCK@5']), pck10: num(pck['PCK@10']) } : undefined,
        visibility: vis ? { tp: count(vis.tp), fp: count(vis.fp), tn: count(vis.tn), fn: count(vis.fn), precision: num(vis.precision), recall: num(vis.recall) } : undefined,
        raw: o,
    };
}

/** sleap-app `summarizeMetrics`: the table's headline numbers. */
export function summarizeMetrics(m) {
    if (!m) return null;
    const v = m.voc || {}, d = m.distance || {}, p = m.pck || {}, s = m.visibility || {};
    return {
        oksMAP: num(v.oksMAP), oksMAR: num(v.oksMAR), pckMAP: num(v.pckMAP), mOKS: m.mOKS != null ? m.mOKS : null,
        mPCK: num(p.mPCK), pck5: num(p.pck5), pck10: num(p.pck10), visPrecision: num(s.precision), visRecall: num(s.recall),
        distAvg: num(d.avg), distP50: num(d.p50), distP75: num(d.p75), distP90: num(d.p90), distP95: num(d.p95), distP99: num(d.p99),
    };
}

export const MODEL_TYPE_LABELS = Object.freeze({
    single_instance: 'Single Instance', centroid: 'Centroid', centered_instance: 'Centered Instance',
    bottomup: 'Bottom-Up', multi_class_bottomup: 'Multi-Class Bottom-Up', multi_class_topdown: 'Multi-Class Top-Down',
});
const BACKBONE_LABELS = { unet: 'UNet', convnext: 'ConvNeXt', swint: 'Swin-T' };
function titleCase(k) { return String(k).split(/[_\s]+/).map(function (w) { return w ? w[0].toUpperCase() + w.slice(1) : w; }).join(' '); }

/** sleap-app `parseTimestampFromRunName`: `YYMMDD_HHMMSS` (LUCID's run names), else `YYYYMMDD[_-]HHMMSS`. */
export function parseTimestampFromRunName(runName) {
    if (!runName) return null;
    const m2 = String(runName).match(/(?<!\d)(\d{2})(\d{2})(\d{2})_(\d{2})(\d{2})(\d{2})\b/);
    if (m2) return '20' + m2[1] + '-' + m2[2] + '-' + m2[3] + ' ' + m2[4] + ':' + m2[5] + ':' + m2[6];
    const m4 = String(runName).match(/(\d{4})(\d{2})(\d{2})[_-]?(\d{2})?(\d{2})?(\d{2})?/);
    if (m4) {
        const day = m4[1] + '-' + m4[2] + '-' + m4[3];
        return m4[4] && m4[5] ? day + ' ' + m4[4] + ':' + m4[5] + (m4[6] ? ':' + m4[6] : '') : day;
    }
    return null;
}

/** sleap-app `parseTrainingConfig` on an already parsed `training_config.yaml`. */
export function trainingConfigInfo(doc) {
    const d = obj(doc) || {};
    const model = obj(d.model_config) || {};
    const trainer = obj(d.trainer_config) || obj(d.trainer) || {};
    const data = obj(d.data_config) || {};
    const heads = obj(model.head_configs) || {};
    const headKey = Object.keys(heads).find(function (k) { return heads[k] != null; }) || null;
    const bbs = obj(model.backbone_config) || {};
    const bbKey = Object.keys(bbs).find(function (k) { return bbs[k] != null; });
    let architecture = null;
    if (bbKey) {
        architecture = BACKBONE_LABELS[bbKey] || titleCase(bbKey);
        const bb = obj(bbs[bbKey]);
        if (bb && typeof bb.max_stride === 'number') architecture += ', max stride: ' + bb.max_stride;
        if (bb && typeof bb.filters === 'number') architecture += ', filters: ' + bb.filters;
    }
    let nodeNames = null;
    const sk = Array.isArray(data.skeletons) && data.skeletons.length ? obj(data.skeletons[0]) : null;
    if (sk && Array.isArray(sk.nodes)) {
        const names = sk.nodes.map(function (n) { return obj(n) ? n.name : n; }).filter(function (n) { return typeof n === 'string'; });
        if (names.length) nodeNames = names;
    }
    const runName = typeof trainer.run_name === 'string' ? trainer.run_name : null;
    return { runName: runName, headKey: headKey, modelType: headKey ? (MODEL_TYPE_LABELS[headKey] || titleCase(headKey)) : null,
        architecture: architecture, nodeNames: nodeNames, timestamp: parseTimestampFromRunName(runName) };
}

const SPLIT_ORDER = ['test', 'val', 'train'];

/**
 * One table row for a run folder (sleap-app `buildModelMetricsRow`): the metrics JSON of the preferred split
 * (test, then val, then train; dataset 0) and the run's config. Failures become `row.error`, never a throw.
 * @param {string} runDir
 * @param {{exists: (p: string) => Promise<boolean>, readText: (p: string) => Promise<string>, parseYaml: (t: string) => any, split?: string}} io
 */
export async function buildModelMetricsRow(runDir, io) {
    try {
        let metrics = null;
        const want = io.split || 'test';
        const order = [want].concat(SPLIT_ORDER.filter(function (s) { return s !== want; }));
        for (const split of order) {
            const p = joinPath(runDir, 'metrics.' + split + '.0.json');
            if (await io.exists(p)) { metrics = normalizeMetrics(JSON.parse(await io.readText(p)), split); break; }
        }
        let info = null;
        const cfg = joinPath(runDir, 'training_config.yaml');
        if (await io.exists(cfg)) info = trainingConfigInfo(io.parseYaml(await io.readText(cfg)));
        return {
            path: runDir, runName: (info && info.runName) || runDirName(runDir), timestamp: info ? info.timestamp : null,
            modelType: info ? info.modelType : null, architecture: info ? info.architecture : null, nodeNames: info ? info.nodeNames : null,
            metrics: metrics, summary: summarizeMetrics(metrics),
        };
    } catch (e) {
        return { path: runDir, runName: runDirName(runDir), timestamp: null, modelType: null, architecture: null, nodeNames: null,
            metrics: null, summary: null, error: (e && e.message) || String(e) };
    }
}

/** sleap-app's detailed list: classic SLEAP `METRICS_KEY_LABELS`, in order. */
export function labeledMetrics(m) {
    if (!m) return [];
    const v = m.voc, d = m.distance, p = m.pck, s = m.visibility;
    return [
        ['Visibility - True Positives', s ? s.tp : null], ['Visibility - False Positives', s ? s.fp : null],
        ['Visibility - True Negatives', s ? s.tn : null], ['Visibility - False Negatives', s ? s.fn : null],
        ['Visibility - Precision', s ? s.precision : null], ['Visibility - Recall', s ? s.recall : null],
        ['Average Distance (ground truth vs prediction)', d ? d.avg : null],
        ['Distance for 50th percentile', d ? d.p50 : null], ['Distance for 75th percentile', d ? d.p75 : null],
        ['Distance for 90th percentile', d ? d.p90 : null], ['Distance for 95th percentile', d ? d.p95 : null],
        ['Distance for 99th percentile', d ? d.p99 : null],
        ['Mean Percentage of Correct Keypoints (PCK)', p ? p.mPCK : null],
        ['Mean Object Keypoint Similarity (OKS)', m.mOKS != null ? m.mOKS : null],
        ['VOC with OKS scores - mean Average Precision (mAP)', v ? v.oksMAP : null],
        ['VOC with OKS scores - mean Average Recall (mAR)', v ? v.oksMAR : null],
        ['VOC with PCK scores - mean Average Precision (mAP)', v ? v.pckMAP : null],
        ['VOC with PCK scores - mean Average Recall (mAR)', v ? v.pckMAR : null],
    ].filter(function (r) { return r[1] != null; }).map(function (r) { return { label: r[0], value: r[1] }; });
}

/** Linear-interpolated percentile of an ascending array (numpy's default). */
export function percentileSorted(sorted, p) {
    const n = sorted.length;
    if (!n) return NaN;
    if (n === 1) return sorted[0];
    const rank = (p / 100) * (n - 1), lo = Math.floor(rank), hi = Math.ceil(rank);
    return lo === hi ? sorted[lo] : sorted[lo] + (sorted[hi] - sorted[lo]) * (rank - lo);
}

/** sleap-app `computeNodeBoxplots`: per node, the five-number summary (+ p95) of its distances. */
export function computeNodeBoxplots(dists, nodeNames) {
    const rows = Array.isArray(dists) ? dists : [];
    let n = 0;
    rows.forEach(function (r) { if (Array.isArray(r)) n = Math.max(n, r.length); });
    if (!n && nodeNames) n = nodeNames.length;
    const out = [];
    for (let j = 0; j < n; j++) {
        const col = [];
        rows.forEach(function (r) { const v = Array.isArray(r) ? r[j] : undefined; if (typeof v === 'number' && Number.isFinite(v)) col.push(v); });
        col.sort(function (a, b) { return a - b; });
        const node = (nodeNames && nodeNames[j]) || 'node ' + j;
        if (!col.length) { out.push({ node: node, count: 0, min: NaN, q1: NaN, median: NaN, q3: NaN, p95: NaN, max: NaN }); continue; }
        out.push({ node: node, count: col.length, min: col[0], q1: percentileSorted(col, 25), median: percentileSorted(col, 50),
            q3: percentileSorted(col, 75), p95: percentileSorted(col, 95), max: col[col.length - 1] });
    }
    return out;
}

/** sleap-app `distanceAxisMax`: the 95th percentile of every distance, rounded up to 5 px, plus 5. */
export function distanceAxisMax(dists) {
    const flat = [];
    (Array.isArray(dists) ? dists : []).forEach(function (r) {
        if (Array.isArray(r)) r.forEach(function (v) { if (typeof v === 'number' && Number.isFinite(v)) flat.push(v); });
    });
    if (!flat.length) return 5;
    flat.sort(function (a, b) { return a - b; });
    return Math.max(5, Math.ceil(Math.ceil(percentileSorted(flat, 95) / 5) + 1) * 5);
}
