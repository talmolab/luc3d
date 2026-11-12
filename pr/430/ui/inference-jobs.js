/**
 * ui/inference-jobs.js — turn one Inference run into per-view JOBS and run
 * them through a queue.
 *
 * A job is one `sleap-nn` process on one camera view's video:
 *   { id, kind: 'inference', view, videoPath, modelPaths, frames, outputPath, args }
 * Today every view gets the same models (`modelsForView` falls back to the
 * shared list) and the queue runs one job at a time. Both are seams for later:
 *   - per-view models: fill `config.perViewModels[view]`; nothing else changes;
 *   - parallel jobs (several GPUs, a remote worker): raise `concurrency`; the
 *     desktop side already keys running processes by job id (up to 4).
 * A Training job would be another `kind` with its own args builder.
 *
 * Import-free except `./inference-args.js` (Node tests: tests/test-inference-jobs.mjs).
 */
import { buildInferenceArgs, modelsForView } from './inference-args.js?v=82449baaa3c2';

/** Filesystem-safe piece of a view name for an output file name. */
export function safeFilePart(name) {
    var s = String(name == null ? '' : name).replace(/[^A-Za-z0-9._-]+/g, '_').replace(/^\.+/, '');
    return s || 'view';
}

/** `20261109_142530` (local time), for output file names (sleap-app's predictions naming). */
export function predictionsTimestamp(d) {
    var t = d || new Date();
    var p = function (n) { return String(n).padStart(2, '0'); };
    return t.getFullYear() + p(t.getMonth() + 1) + p(t.getDate()) + '_' +
        p(t.getHours()) + p(t.getMinutes()) + p(t.getSeconds());
}

/** Join path pieces with the separator the root already uses. */
export function joinPath(root, rel) {
    var sep = /\\/.test(root) && !/\//.test(root) ? '\\' : '/';
    var r = String(root).replace(/[\\/]+$/, '');
    return r + sep + String(rel).split(/[\\/]+/).filter(Boolean).join(sep);
}

/**
 * One job per view that has a video path.
 *
 * @param {Object} config  inference config (`defaultInferenceConfig`)
 * @param {Array<{view:string, videoPath:string|null, frames:number[]|null}>} views
 *   `frames`: that view's frame list (null = whole video); a view whose list
 *   is EMPTY (nothing left after exclusions) is skipped with a reason.
 * @param {{outputDir:string, subcommand?:string, stamp?:string}} opts
 * @returns {{jobs:Array, skipped:Array<{view:string, reason:string}>}}
 */
export function planInferenceJobs(config, views, opts) {
    var jobs = [], skipped = [];
    var stamp = opts.stamp || predictionsTimestamp();
    views.forEach(function (v, i) {
        if (!v.videoPath) { skipped.push({ view: v.view, reason: 'no video file on disk' }); return; }
        if (v.frames != null && v.frames.length === 0) { skipped.push({ view: v.view, reason: 'no frames to run' }); return; }
        var models = modelsForView(config, v.view);
        if (models.length === 0) { skipped.push({ view: v.view, reason: 'no model' }); return; }
        var outputPath = joinPath(opts.outputDir, safeFilePart(v.view) + '.' + stamp + '.predictions.slp');
        jobs.push({
            id: 'inference-' + i + '-' + safeFilePart(v.view),
            kind: 'inference',
            view: v.view,
            videoPath: v.videoPath,
            modelPaths: models,
            frames: v.frames,
            outputPath: outputPath,
            args: buildInferenceArgs(config, {
                dataPath: v.videoPath, outputPath: outputPath, modelPaths: models,
                frames: v.frames, subcommand: opts.subcommand,
            }),
        });
    });
    return { jobs: jobs, skipped: skipped };
}

/**
 * Run `jobs` with at most `concurrency` at once, in order.
 *
 * @param {Array} jobs
 * @param {(job:Object) => Promise<boolean>} runJob  resolves true on success
 * @param {{concurrency?:number, onStart?:Function, onDone?:(job, ok:boolean, err?:Error)=>(void|Promise<void>),
 *          isCancelled?:() => boolean, stopOnFailure?:boolean}} [opts]
 * @returns {Promise<{done:Object[], failed:Object[], notRun:Object[]}>}
 */
export async function runJobQueue(jobs, runJob, opts) {
    var o = opts || {};
    var concurrency = Math.max(1, o.concurrency || 1);
    var stopOnFailure = o.stopOnFailure !== false;
    var done = [], failed = [], started = new Set();
    var next = 0, halted = false;

    async function worker() {
        while (!halted && next < jobs.length) {
            if (o.isCancelled && o.isCancelled()) { halted = true; break; }
            var job = jobs[next++];
            started.add(job);
            if (o.onStart) o.onStart(job);
            var ok = false, err;
            try { ok = await runJob(job); } catch (e) { err = e; ok = false; }
            (ok ? done : failed).push(job);
            if (o.onDone) await o.onDone(job, ok, err);
            if (!ok && stopOnFailure) halted = true;
        }
    }
    var workers = [];
    for (var w = 0; w < Math.min(concurrency, jobs.length); w++) workers.push(worker());
    await Promise.all(workers);
    return { done: done, failed: failed, notRun: jobs.filter(function (j) { return !started.has(j); }) };
}

/**
 * Why `view` cannot get an inference job right now, or null.
 *
 * TEMPORARY: a view whose poses are LAZY-loaded (a camera backed by the
 * project's columnar store, `session.lazyLoader.labelsByCam`) is blocked.
 * Merging into a lazy view works (`ui/inference-merge.js`, e2e
 * desktop-inference §8) but keeps every predicted frame resident until saved,
 * which a long recording cannot afford. Later a chosen SUBSET of lazy views
 * (and their frames) will be allowed; the panel's per-view selection is
 * already in place, so lifting this means changing only this function.
 */
export function viewInferenceBlocker(session, view) {
    var loader = session && session.lazyLoader;
    if (loader && loader.labelsByCam && typeof loader.labelsByCam.has === 'function' && loader.labelsByCam.has(view)) {
        return 'lazy-loaded — not supported yet';
    }
    return null;
}
