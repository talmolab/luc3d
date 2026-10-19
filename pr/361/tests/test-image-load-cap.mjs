/**
 * test-image-load-cap.mjs — the image ID-switch check's compute guardrail
 * (ui/image-embedder.js `paceRestMs`, the `imageCheckMaxLoad` setting): after
 * each model run the check rests long enough that the model is busy at most the
 * set share of the time, busy / (busy + rest) = max load. 100 is the unpaced check.
 *
 * The real embedder pacing real model runs, and a rest ended by releaseFrames:
 * tests/e2e/image-check-cpu.mjs §6.
 *
 * Run:  node tests/test-image-load-cap.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ui = (f) => pathToFileURL(path.join(HERE, '..', 'ui', f)).href;
globalThis.window = globalThis;
const { paceRestMs, IMAGE_MAX_LOAD_MIN, formatEmbedTiming } = await import(ui('image-embedder.js'));
const { getTrackingThresholdDefs } = await import(ui('settings.js'));
const { IMAGE_CHECK_IDS } = await import(ui('track-setup-modal.js'));

let passed = 0, failed = 0; const failures = [];
function ok(c, m) {
    if (c) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}
const near = (a, e) => Math.abs(a - e) < 1e-9;

// ---- the rule: busy / (busy + rest) = max load ------------------------------
for (const pct of [10, 25, 50, 75, 90]) {
    const run = 120, rest = paceRestMs(run, pct);
    ok(near(100 * run / (run + rest), pct), `${pct}%: a ${run} ms run rests ${rest.toFixed(1)} ms, busy ${(100 * run / (run + rest)).toFixed(3)}%`);
}
ok(near(paceRestMs(100, 50), 100), '50%: rest as long as the run');
ok(near(paceRestMs(100, 75), 100 / 3), '75%: rest a third of the run');

// ---- 100% and anything unusable is the unpaced check: no rest ---------------
for (const pct of [100, 150, 0, -5, NaN, undefined, null, 'x']) {
    ok(paceRestMs(100, pct) === 0, `max load ${String(pct)} rests 0 ms (unpaced)`);
}
ok(paceRestMs(0, 50) === 0 && paceRestMs(-3, 50) === 0 && paceRestMs(NaN, 50) === 0, 'a zero / negative / NaN run rests 0 ms');

// ---- below the minimum it holds at the minimum, never longer ----------------
ok(IMAGE_MAX_LOAD_MIN === 10, 'the minimum max load is 10%');
ok(near(paceRestMs(100, 1), paceRestMs(100, IMAGE_MAX_LOAD_MIN)), '1% is treated as the 10% minimum (a 9x rest, not 99x)');

// ---- the setting: default 75, range matches the embedder's -------------------
const def = getTrackingThresholdDefs().find(d => d.id === 'imageCheckMaxLoad');
ok(!!def, 'imageCheckMaxLoad is a Tracking Wizard setting');
ok(def && def.default === 75 && def.value === 75, `defaults to 75% (default ${def && def.default}, value ${def && def.value})`);
ok(def && def.min === IMAGE_MAX_LOAD_MIN && def.max === 100, `range ${def && def.min}..${def && def.max} = IMAGE_MAX_LOAD_MIN..100`);
ok(IMAGE_CHECK_IDS.includes('imageCheckMaxLoad'), 'the Track All / Track Frame Range dialogs offer it with the image check');

// ---- the run summary says when the load was capped --------------------------
const t = { crops: 90, cropsPerS: 9, seconds: 10, gpuBusyPct: 74, batches: 5, avgBatch: 18, modelMsPerCrop: 80,
    decodeMsPerFrame: 1, cropMsPerFrame: 40, queueMsPerFrame: 900, backend: 'webgpu', dtype: 'fp16' };
ok(/ · load capped at 75% \(2 s resting\)$/.test(formatEmbedTiming(Object.assign({}, t, { maxLoadPct: 75, restS: 2.4 }))),
    'a capped run\'s summary ends "load capped at 75% (2 s resting)"');
ok(!/capped/.test(formatEmbedTiming(Object.assign({}, t, { maxLoadPct: 100, restS: 0 }))), 'an unpaced run\'s summary says nothing about a cap');
ok(!/capped/.test(formatEmbedTiming(t)), 'nor does a summary with no cap recorded');

console.log(`\ntest-image-load-cap: ${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
