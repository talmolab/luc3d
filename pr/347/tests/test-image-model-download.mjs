/**
 * test-image-model-download.mjs — what the image ID-switch check says when its
 * model cannot be downloaded (ui/image-embedder.js `asModelDownloadFailure`,
 * `cannotRun`, `MODEL_OFFLINE_REASON`), and how the Track All summary box shows it.
 *
 * Offline, both downloads reject with a bare TypeError that names no cause, worded
 * differently by each browser; every wording must become the reason, and nothing
 * else may. The real app, offline, on the GPU and CPU paths:
 * tests/e2e/image-check-offline.mjs.
 *
 * Run:  node tests/test-image-model-download.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ui = (f) => pathToFileURL(path.join(HERE, '..', 'ui', f)).href;
globalThis.window = globalThis;
const { asModelDownloadFailure, cannotRun, MODEL_OFFLINE_REASON } = await import(ui('image-embedder.js'));
const { summarizeTrackedIdentities, describeSwitchCheck, planTrackSummary } = await import(ui('track-summary.js'));

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    if (a === e) passed++;
    else { failed++; failures.push(`${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); console.error('  ✗ ' + m); }
}
function ok(c, m) { eq(!!c, true, m); }

const URL_ = 'https://cdn.jsdelivr.net/npm/@huggingface/transformers@4.3.0/+esm';

// ---- every browser's wording of a failed download becomes the reason --------
const NETWORK = [
    ['Chrome, runtime', new TypeError('Failed to fetch dynamically imported module: ' + URL_)],
    ['Chrome, weights', new TypeError('Failed to fetch')],
    ['Firefox, runtime', new TypeError('error loading dynamically imported module: ' + URL_)],
    ['Firefox, weights', new TypeError('NetworkError when attempting to fetch resource.')],
    ['Safari, runtime', new TypeError('Importing a module script failed.')],
    ['Safari, weights', new TypeError('Load failed')],
    // onnxruntime wraps a failed fetch of its own .wasm in a plain Error
    ['onnxruntime backend', new Error('no available backend found. ERR: [wasm] TypeError: Failed to fetch dynamically imported module: https://cdn.jsdelivr.net/npm/onnxruntime-web/dist/ort-wasm-simd-threaded.jsep.mjs')],
];
for (const [what, err] of NETWORK) {
    const e = asModelDownloadFailure(err);
    ok(e.cannotRun === true && e.message === MODEL_OFFLINE_REASON, what + ': becomes the reason');
    ok(e.cause === err, what + ': keeps the original as `cause`');
}

// ---- anything else is left alone ------------------------------------------
const OTHER = [
    new Error('no available backend found. ERR: [webgpu] Error: GPU device was lost'),
    new Error('Could not locate file: "https://huggingface.co/onnx-community/dinov2-small/resolve/main/onnx/model_fp16.onnx".'),
    new RangeError('Array buffer allocation failed'),
    new SyntaxError('Unexpected token'),
];
for (const err of OTHER) ok(asModelDownloadFailure(err) === err, 'not a failed download, returned unchanged: ' + err.message.slice(0, 60));
eq(asModelDownloadFailure(null), null, 'null passes through');
const already = cannotRun('needs Nose and TTI nodes in the skeleton to align crops');
ok(asModelDownloadFailure(already) === already, 'an error that is already a reason is not rewritten');

// ---- cannotRun ----------------------------------------------------------------
const c = cannotRun('some reason');
ok(c instanceof Error && c.cannotRun === true && c.message === 'some reason' && c.cause === undefined, 'cannotRun: an Error carrying the reason, no cause');

// ---- the reason itself, and the summary box row -----------------------------
ok(/^needs an internet connection/.test(MODEL_OFFLINE_REASON), 'reads after "skipped — " like the other reasons');
ok(MODEL_OFFLINE_REASON.includes('huggingface.co') && MODEL_OFFLINE_REASON.includes('cdn.jsdelivr.net'), 'names both hosts (what a firewall must allow)');
ok(!/fetch/i.test(MODEL_OFFLINE_REASON), 'says nothing about "fetch"');
const two = summarizeTrackedIdentities({
    identities: [{ id: 0, name: 'id_0', color: '#f00' }, { id: 1, name: 'id_1', color: '#0f0' }],
    instanceGroups: new Map([[0, [{ identityId: 0 }, { identityId: 1 }]]]),
}, { frames: 1, animals: 2 });
const image = describeSwitchCheck(true, { ok: false, reason: MODEL_OFFLINE_REASON, elapsedMs: 900 }, 2);
eq(image.state, 'skipped', 'summary: a skip, not a failure');
const p = planTrackSummary(two, { size: { state: 'clear', switches: 0, encounters: 40 }, image });
eq(p.checks[1].text, 'Skipped — needs an internet connection to download the image model', 'summary row: up to the parenthesis');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.join('\n')); process.exit(1); }
