/**
 * ui/video-table-counts.js — the Videos table's per-camera counts (Labeled,
 * Groups, Score), in ONE pass over the session, which can be run in slices.
 * DOM-free and import-free, so Node tests can load it.
 *
 * The table used to walk `frameGroups` once per video row and every group
 * member with `for...of` (a Map lookup and a Map write per member): ~205 ms
 * at the end of a Triangulate All on the 8-camera, 539,852-group project.
 * Here each frame and each group member is read once, and a member's camera
 * finds its counter by comparing names with the slot after the one the
 * previous member of the same group matched, not by a hash. That pass is
 * still ~165 ms there (bound by reading the members from memory), so the
 * table runs it in slices of a few milliseconds (`createVideoTableCounter`).
 */

/** Frames between two looks at the clock. */
const CLOCK_EVERY = 256;

/**
 * A resumable count. `step(budgetMs)` counts until the budget is spent (the
 * clock is read every `CLOCK_EVERY` frames) and returns true once everything
 * is counted; `result()` then gives the counts:
 * - `labeled`: frames with at least one linked or unlinked instance on that
 *   camera (resident frames only on a lazy project, as before).
 * - `groups`: group members on that camera (a null member does not count).
 * - `scoreSum` / `scoreCount`: the linked instances with a score above 0,
 *   added in frame order (the same order as the per-camera loop it replaced).
 *
 * The frames are read through the session's Map iterators, which follow a
 * Map changed between two steps; a caller that needs counts for a changed
 * session starts a new counter. `globalThis.__lucidVideoCountSliceFrames`
 * (tests) makes each step count exactly that many frames, clock or not.
 *
 * @param {object|null} session
 * @returns {{ step(budgetMs:number): boolean,
 *   result(): Map<string, {labeled:number, groups:number, scoreSum:number, scoreCount:number}> }}
 */
export function createVideoTableCounter(session) {
    const names = [];
    const rows = [];
    const seenFrame = [];
    function slotOf(cam) {
        let k = names.indexOf(cam);
        if (k < 0) {
            k = names.length;
            names.push(cam);
            rows.push({ labeled: 0, groups: 0, scoreSum: 0, scoreCount: 0 });
            seenFrame.push(-1);
        }
        return k;
    }

    // Labeled frames and scores, from `frameGroups`.
    let frameKey = 0;
    const markLabeled = function (cam) {
        const k = slotOf(cam);
        if (seenFrame[k] !== frameKey) { seenFrame[k] = frameKey; rows[k].labeled++; }
        return rows[k];
    };
    const visitLinked = function (list, cam) {
        if (!list || list.length === 0) return;
        const r = markLabeled(cam);
        for (let j = 0; j < list.length; j++) {
            const s = list[j].score;
            if (s > 0) { r.scoreSum += s; r.scoreCount++; }
        }
    };
    const visitUnlinked = function (list, cam) {
        if (list && list.length > 0) markLabeled(cam);
    };
    function countFrame(fg) {
        frameKey++;
        if (!fg) return;
        if (fg.instances) fg.instances.forEach(visitLinked);
        if (fg.unlinkedInstances) fg.unlinkedInstances.forEach(visitUnlinked);
    }

    // Groups per camera, from `instanceGroups`: every member once, with
    // Map.forEach (no entry pairs).
    let last = -1;
    const visitMember = function (inst, cam) {
        if (!inst) return;
        let k = last + 1;
        if (!(k < names.length && names[k] === cam)) k = slotOf(cam);
        rows[k].groups++;
        last = k;
    };
    function countGroups(groups) {
        if (!groups) return;
        for (let gi = 0; gi < groups.length; gi++) {
            const g = groups[gi];
            if (!g || !g.instances) continue;
            last = -1;
            g.instances.forEach(visitMember);
        }
    }

    // Phases: the frames, then the groups. Each is one Map iterator.
    const phases = [];
    if (session && session.frameGroups) phases.push({ map: session.frameGroups, fn: countFrame });
    if (session && session.instanceGroups) phases.push({ map: session.instanceGroups, fn: countGroups });
    let phase = 0;
    let it = null;
    let done = phases.length === 0;

    function step(budgetMs) {
        if (done) return true;
        const fixed = typeof globalThis !== 'undefined' && globalThis.__lucidVideoCountSliceFrames > 0
            ? globalThis.__lucidVideoCountSliceFrames : 0;
        const clock = typeof performance !== 'undefined' ? performance : Date;
        const deadline = fixed ? 0 : clock.now() + (budgetMs >= 0 ? budgetMs : Infinity);
        let n = 0;
        while (phase < phases.length) {
            const p = phases[phase];
            if (!it) it = p.map.values();
            for (;;) {
                const r = it.next();
                if (r.done) break;
                p.fn(r.value);
                n++;
                if (fixed) { if (n >= fixed) return false; }
                else if (n % CLOCK_EVERY === 0 && clock.now() >= deadline) return false;
            }
            phase++;
            it = null;
        }
        done = true;
        return true;
    }

    function result() {
        const out = new Map();
        for (let k = 0; k < names.length; k++) out.set(names[k], rows[k]);
        return out;
    }

    return { step, result };
}

/**
 * The whole count at once (see `createVideoTableCounter`).
 * @param {object|null} session
 * @returns {Map<string, {labeled:number, groups:number, scoreSum:number, scoreCount:number}>}
 *   keyed by camera name; a camera with nothing is absent.
 */
export function videoTableCounts(session) {
    const c = createVideoTableCounter(session);
    c.step(Infinity);
    return c.result();
}

/**
 * A count short enough for the Videos table's narrow columns: exact below
 * 1,000, then thousands with one decimal below 100,000 (`98.8k`; `12k`, not
 * `12.0k`), whole thousands below a million (`108k`), then millions the same
 * way (`1.2M`, `540M`). The table puts the exact count in the cell's title.
 * Rounds half up; a value that rounds up to the next unit moves to it
 * (999,950 → `1M`, not `1000k`).
 *
 * @param {number} n  a count (0 or more)
 * @returns {string}
 */
export function compactCount(n) {
    if (!(n >= 0) || !Number.isFinite(n)) return '-';
    if (n < 1000) return String(Math.round(n));
    const units = [[1e3, 'k'], [1e6, 'M'], [1e9, 'B']];
    for (let u = 0; u < units.length; u++) {
        const [size, suffix] = units[u];
        const v = n / size;
        const digits = v < 100 ? 1 : 0;
        const r = Math.round(v * 10 ** digits) / 10 ** digits;
        if (r < 1000 || u === units.length - 1) return String(r) + suffix;
    }
    return String(n);
}
