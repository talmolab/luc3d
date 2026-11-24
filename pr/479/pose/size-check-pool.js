/**
 * size-check-pool.js — the body-size ID-switch check's scoring on a worker
 * (pose/size-check-worker.js).
 *
 * WHY: at the end of Track All the size check held the page in two tasks
 * (~0.2 s sampling, ~0.3 s fitting and scoring, on an 8-camera, 108,000-frame
 * project). Sampling reads the session's InstanceGroups and stays here; the
 * scoring reads only the grid's numbers, so it moves to a worker and the page
 * keeps painting meanwhile. Same code on the same numbers: the same result.
 *
 * Usage (ui/id-switch-modal.js): `checkSizeSwitches(session, { fps,
 * scoreGrid: scoreSizeGridOffThread })`.
 *
 * The grid is COPIED to the worker (structured clone, a few ms), not
 * transferred, so the page still holds it if the worker cannot help: no
 * `Worker`, `window.LUCID_SIZE_CHECK_WORKER === 0` (kill switch / A-B), a
 * worker that fails to load or does not say `ready` within
 * SIZE_WORKER_READY_MS, or one that fails while scoring — each scores in the
 * page instead (`scoreSizeGrid`), so a worker never costs a check. An abort
 * (`o.signal`) stops the worker and rejects with an AbortError.
 */
import { scoreSizeGrid, sizeGridMessage, sizeScoreOptions } from './id-switch-check.js?v=2d3d0e744de2';

/** How long a new worker has to load before the page scores instead. */
export const SIZE_WORKER_READY_MS = 10000;

/** Where each check was scored, for tests and the console: worker / in the page / in the page after the worker failed. */
export const sizeCheckRuns = { worker: 0, inPage: 0, fellBack: 0 };

/** Whether to try the worker (`window.LUCID_SIZE_CHECK_WORKER = 0` turns it off). */
export function sizeCheckWorkerWanted() {
    if (typeof Worker !== 'function' || typeof document === 'undefined') return false;
    var forced = typeof window !== 'undefined' ? window.LUCID_SIZE_CHECK_WORKER : undefined;
    return forced == null || !!forced;
}

function abortError() {
    var e = new Error('Cancelled'); e.name = 'AbortError'; return e;
}

/**
 * `checkSizeSwitches`' `scoreGrid`: score `grid` on a worker, or here when the
 * worker cannot (see above).
 * @param {object} grid  from buildGrid
 * @param {object} o     the check's options
 * @returns {Promise<object>} checkSizeSwitches' result
 */
export function scoreSizeGridOffThread(grid, o) {
    if (!sizeCheckWorkerWanted()) {
        sizeCheckRuns.inPage++;
        return scoreSizeGrid(grid, o);
    }
    if (o.signal && o.signal.aborted) return Promise.reject(abortError());
    return new Promise(function (resolve, reject) {
        var worker = null, settled = false, readyTimer = null;
        var onAbort = function () {
            if (settled) return;
            settled = true; cleanup(); reject(abortError());
        };
        var cleanup = function () {
            if (readyTimer) clearTimeout(readyTimer);
            if (o.signal) o.signal.removeEventListener('abort', onAbort);
            if (worker) { worker.onmessage = worker.onerror = worker.onmessageerror = null; worker.terminate(); }
        };
        var inPage = function (why) {
            if (settled) return;
            settled = true; cleanup();
            sizeCheckRuns.fellBack++;
            console.warn('[size-check] scoring in the page: ' + why);
            scoreSizeGrid(grid, o).then(resolve, reject);
        };
        if (o.signal) o.signal.addEventListener('abort', onAbort);
        try {
            worker = new Worker(new URL('pose/size-check-worker.js?v=2d3d0e744de2', document.baseURI), { type: 'module' });
        } catch (e) {
            inPage('the worker could not start (' + ((e && e.message) || e) + ')');
            return;
        }
        worker.onerror = function (ev) {
            if (ev && ev.preventDefault) ev.preventDefault();
            inPage('the worker failed (' + ((ev && ev.message) || 'error') + ')');
        };
        worker.onmessageerror = function () { inPage('a message could not be read'); };
        worker.onmessage = function (ev) {
            var m = ev.data || {};
            if (m.type === 'ready') {
                clearTimeout(readyTimer); readyTimer = null;
                worker.postMessage({ type: 'score', grid: sizeGridMessage(grid), o: sizeScoreOptions(o) });
            } else if (m.type === 'scored') {
                if (settled) return;
                settled = true; cleanup();
                sizeCheckRuns.worker++;
                resolve(m.res);
            } else if (m.type === 'error') {
                inPage('the worker failed while scoring (' + m.message + ')');
            }
        };
        readyTimer = setTimeout(function () { inPage('the worker did not start within ' + SIZE_WORKER_READY_MS + ' ms'); }, SIZE_WORKER_READY_MS);
    });
}
