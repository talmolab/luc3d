/**
 * ui/video-table-counts.js — the Videos table's per-camera counts (Labeled,
 * Groups, Score), in ONE pass over the session. DOM-free and import-free, so
 * Node tests can load it.
 *
 * The table used to walk `frameGroups` once per video row and every group
 * member with `for...of` (a Map lookup and a Map write per member): ~205 ms
 * at the end of a Triangulate All on the 8-camera, 539,852-group project.
 * Here each frame and each group member is read once, and a member's camera
 * finds its counter by comparing names with the camera the previous member
 * of the same group matched (members come in camera order), not by a hash.
 */

/**
 * Per-camera counts for the Videos table.
 * - `labeled`: frames with at least one linked or unlinked instance on that
 *   camera (resident frames only on a lazy project, as before).
 * - `groups`: instance groups with a member on that camera.
 * - `scoreSum` / `scoreCount`: the linked instances with a score above 0.
 *
 * @param {object|null} session
 * @returns {Map<string, {labeled:number, groups:number, scoreSum:number, scoreCount:number}>}
 *   keyed by camera name; a camera with nothing is absent.
 */
export function videoTableCounts(session) {
    const out = new Map();
    if (!session) return out;

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

    // Labeled frames and scores: one pass over the frames, not one per camera.
    if (session.frameGroups) {
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
        session.frameGroups.forEach(function (fg) {
            frameKey++;
            if (fg.instances) fg.instances.forEach(visitLinked);
            if (fg.unlinkedInstances) fg.unlinkedInstances.forEach(visitUnlinked);
        });
    }

    // Groups per camera: every member once, Map.forEach (no entry pairs).
    if (session.instanceGroups) {
        let last = -1;
        const visitMember = function (inst, cam) {
            if (!inst) return;
            let k = last + 1;
            if (!(k < names.length && names[k] === cam)) k = slotOf(cam);
            rows[k].groups++;
            last = k;
        };
        session.instanceGroups.forEach(function (groups) {
            for (let gi = 0; gi < groups.length; gi++) {
                const g = groups[gi];
                if (!g || !g.instances) continue;
                last = -1;
                g.instances.forEach(visitMember);
            }
        });
    }

    for (let k = 0; k < names.length; k++) out.set(names[k], rows[k]);
    return out;
}
