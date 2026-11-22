/**
 * size-check-worker.js — scores the body-size ID-switch check off the main
 * thread (module worker, spawned by pose/size-check-pool.js).
 *
 * The main thread samples the session (`buildGrid`, which needs its
 * InstanceGroups) and sends the grid's numbers and names
 * (`sizeGridMessage`); this runs `scoreSizeGrid` on them — the SAME code the
 * page runs without a worker, on the same numbers, so the result is the same.
 *
 * Messages:
 *   out, once loaded:  { type: 'ready' }
 *   in:   { type: 'score', grid: sizeGridMessage(grid), o: sizeScoreOptions(o) }
 *   out:  { type: 'scored', res }   (checkSizeSwitches' result)
 *      or { type: 'error', message }
 *
 * Imports only pose/id-switch-check.js (and through it pose/pose-data.js),
 * both DOM-free.
 */
import { gridFromMessage, scoreSizeGrid } from './id-switch-check.js?v=eb53293de371';

self.onmessage = async function (ev) {
    var m = ev.data;
    if (!m || m.type !== 'score') return;
    try {
        var res = await scoreSizeGrid(gridFromMessage(m.grid), m.o);
        self.postMessage({ type: 'scored', res: res });
    } catch (e) {
        self.postMessage({ type: 'error', message: String((e && e.message) || e) });
    }
};

self.postMessage({ type: 'ready' });
