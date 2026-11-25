/**
 * test-inference-args.mjs — ui/inference-args.js (sleap-nn predict argv for one
 * view, ported from sleap-app's inferenceArgs.ts) and ui/inference-jobs.js
 * (per-view job planning + the job queue).
 */
import assert from 'node:assert/strict';
import {
    defaultInferenceConfig, buildInferenceArgs, framesToSpec, targetFrames, pickInferenceSubcommand,
    parseProgressLine, modelsForView, sampleFrames, formatDuration, formatEta,
} from '../ui/inference-args.js';
import { planInferenceJobs, runJobQueue, joinPath, safeFilePart } from '../ui/inference-jobs.js';

// --- framesToSpec ---
assert.equal(framesToSpec([5, 0, 1, 2, 7, 8, 8]), '0,1,2,5,7,8', 'sleap-nn takes no mixed ranges');
assert.equal(framesToSpec([4, 2, 3, 3]), '2-4');
assert.equal(framesToSpec([]), '');
assert.equal(framesToSpec([3]), '3');

// --- default argv: same order and defaults as sleap-app ---
const cfg = defaultInferenceConfig();
const base = buildInferenceArgs(cfg, { dataPath: '/v/cam1.mp4', outputPath: '/o/cam1.slp', modelPaths: ['/m/a', '/m/b'] });
assert.deepEqual(base, [
    'predict', '--gui', '--data_path', '/v/cam1.mp4', '--model_paths', '/m/a', '--model_paths', '/m/b',
    '--output_path', '/o/cam1.slp', '--batch_size', '4', '--device', 'auto', '--peak_threshold', '0.2',
    '--integral_refinement', 'integral', '--integral_patch_size', '5',
]);
assert.ok(!base.includes('--video_index'), 'a video input never gets --video_index');

// --- frames, tracking, filters, bottom-up, runtime ---
const c2 = Object.assign(defaultInferenceConfig(), {
    pipeline: 'bottom-up', runtime: 'onnx', maxInstances: 3, tracking: true, trackerMethod: 'kalman',
    kfNodeIndices: [0, 2], similarityMethod: 'centroids', maxTracks: 2, connectSingleBreaks: true,
    trackingPreCullToTarget: true, trackingCleanInstanceCount: 2, filterOverlapping: true,
    filterMinVisibleNodes: 1, filterMinCentroidDistance: 10, ensureChannels: 'grayscale',
});
const a2 = buildInferenceArgs(c2, { dataPath: 'd', outputPath: 'o.slp', modelPaths: ['m'], frames: [0, 1, 2, 9] });
const after = (f) => a2[a2.indexOf(f) + 1];
assert.equal(after('--frames'), '0,1,2,9');
assert.equal(after('--runtime'), 'onnx');
assert.equal(after('--max_instances'), '3');
assert.equal(after('--n_points'), '10');
assert.ok(a2.includes('--ensure_grayscale') && a2.includes('--use_kalman') && a2.includes('--post_connect_single_breaks'));
assert.equal(after('--kf_node_indices'), '0,2');
assert.equal(after('--features'), 'centroids');
assert.equal(after('--scoring_method'), 'euclidean_dist');
assert.equal(after('--tracking_pre_cull_to_target'), '1');
assert.equal(after('--filter_overlapping_method'), 'iou');
assert.equal(after('--filter_min_centroid_distance'), '10');
// legacy `track` never gets --runtime
assert.ok(!buildInferenceArgs(c2, { dataPath: 'd', outputPath: 'o.slp', modelPaths: ['m'], subcommand: 'track' }).includes('--runtime'));
assert.throws(() => buildInferenceArgs(cfg, { dataPath: 'd', outputPath: 'o', modelPaths: [], frames: [] }), /No frames/);

// --- targets ---
assert.equal(targetFrames({ frameRange: 'video' }, { currentFrame: 3 }), null);
assert.deepEqual(targetFrames({ frameRange: 'frame' }, { currentFrame: 3 }), [3]);
assert.deepEqual(targetFrames({ frameRange: 'custom', frameStart: 2, frameEnd: 4 }, {}), [2, 3, 4]);
assert.throws(() => targetFrames({ frameRange: 'custom', frameStart: 5, frameEnd: 4 }, {}));
assert.deepEqual(targetFrames({ frameRange: 'user_labeled' }, { labeledFrames: [7, 1] }), [7, 1]);
assert.throws(() => targetFrames({ frameRange: 'suggestions' }, {}), /Unhandled/);
const s = sampleFrames(100, 10, () => 0.5 - Math.random() * 0.5);
assert.equal(s.length, 10);
assert.deepEqual(sampleFrames(3, 10), [0, 1, 2]);

// --- version gate (sleap-app's) ---
assert.equal(pickInferenceSubcommand('0.3.5'), 'predict');
assert.equal(pickInferenceSubcommand('0.3.1'), 'track');
assert.equal(pickInferenceSubcommand(null), 'predict');
assert.equal(pickInferenceSubcommand('dev'), 'predict');

// --- progress ---
assert.deepEqual(parseProgressLine('{"n_processed": 5, "n_total": 10, "rate": 2.5, "eta": 2}\n'),
    { nProcessed: 5, nTotal: 10, rate: 2.5, eta: 2 });
assert.equal(parseProgressLine('INFO loading'), null);
assert.equal(parseProgressLine('{"status": "x"}'), null);
assert.equal(formatDuration(61000), '1m 1s');
assert.equal(formatEta(5), '5s');

// --- per-view model slot (future) ---
const pv = defaultInferenceConfig();
pv.modelPaths = ['/m/shared'];
pv.perViewModels = { cam2: ['/m/cam2'] };
assert.deepEqual(modelsForView(pv, 'cam1'), ['/m/shared']);
assert.deepEqual(modelsForView(pv, 'cam2'), ['/m/cam2']);

// --- job planning ---
assert.equal(joinPath('/a/b/', 'predictions'), '/a/b/predictions');
assert.equal(joinPath('C:\\rec', 'cam1/0.mp4'), 'C:\\rec\\cam1\\0.mp4');
assert.equal(safeFilePart('cam 1/../x'), 'cam_1_.._x');
const plan = planInferenceJobs(pv, [
    { view: 'cam1', videoPath: '/r/cam1/0.mp4', frames: null },
    { view: 'cam2', videoPath: '/r/cam2/0.mp4', frames: [1, 2] },
    { view: 'cam3', videoPath: null, frames: null },
    { view: 'cam4', videoPath: '/r/cam4/0.mp4', frames: [] },
], { outputDir: '/r/predictions', stamp: 'T' });
assert.equal(plan.jobs.length, 2);
assert.deepEqual(plan.skipped.map((x) => x.view), ['cam3', 'cam4']);
assert.equal(plan.jobs[0].outputPath, '/r/predictions/cam1.T.predictions.slp');
assert.deepEqual(plan.jobs[1].modelPaths, ['/m/cam2']);
assert.ok(plan.jobs[1].args.includes('--frames'));
assert.notEqual(plan.jobs[0].id, plan.jobs[1].id);
assert.match(plan.jobs[0].id, /^[A-Za-z0-9_.:-]{1,64}$/, 'job id passes the native job-id rule');

// --- queue: order, stop on failure, concurrency ---
{
    const seen = [];
    const r = await runJobQueue([{ id: 1 }, { id: 2 }, { id: 3 }], async (j) => { seen.push(j.id); return j.id !== 2; });
    assert.deepEqual(seen, [1, 2]);
    assert.deepEqual(r.notRun.map((j) => j.id), [3]);
    assert.deepEqual(r.failed.map((j) => j.id), [2]);
}
{
    let live = 0, peak = 0;
    const r = await runJobQueue([1, 2, 3, 4].map((id) => ({ id })), async () => {
        live++; peak = Math.max(peak, live);
        await new Promise((res) => setTimeout(res, 5));
        live--; return true;
    }, { concurrency: 2 });
    assert.equal(peak, 2);
    assert.equal(r.done.length, 4);
}
{
    let cancelled = false;
    const r = await runJobQueue([{ id: 1 }, { id: 2 }], async () => { cancelled = true; return true; },
        { isCancelled: () => cancelled });
    assert.equal(r.done.length, 1);
    assert.equal(r.notRun.length, 1);
}
console.log('test-inference-args: all passed');
