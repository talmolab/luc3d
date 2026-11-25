/**
 * ui/anchor-crop-preview.js — the Training panel's crop preview: a dashed orange square of the centered-instance
 * crop around every animal on the current frame, in every view (sleap-app `renderAnchorCropPreview`,
 * `src/canvas/SkeletonRenderer.ts`, and VideoPlayer's "Persistent anchor crop preview").
 *
 * LUCID changes: the square is centred where sleap-nn centres the crop (the anchor node when it is placed and
 * visible, else the centre of mass of the visible nodes; sleap-app draws Auto at the bounding-box centre), and
 * its side is the crop in size-matched pixels divided by that view's size-matcher scale, so a view whose video is
 * smaller than the largest one shows the native pixels the crop covers; with one model per view each view shows its
 * own model's crop, and a view no model trains on shows none. Drawn by `drawAllOverlays` (`ui/rendering.js`) after
 * the planes, through the same transform; the panel sets and clears it.
 */
import { makeVideoToCanvasTransform } from './overlays.js?v=e37e05d05839';
import { overlayDrawSize } from './overlay-window.js?v=e37e05d05839';
import { cropCentre, frameScale } from '../pose/training-crop-size.js?v=e37e05d05839';

const COLOR = '#f97316';

/**
 * @type {{anchor: string|null, byView: Object<string, {cropSize: number, target: {height: number|null, width: number|null}}>,
 *         key: string}|null}
 */
let preview = null;

/**
 * Show the preview (or clear it with null). Returns true when it changed, so the caller redraws only then.
 * @param {{anchor: string|null,
 *          byView: Object<string, {cropSize: number, target?: {height: number|null, width: number|null},
 *                                  centroid?: {method: string, fallback: string}}>,
 *          isShown?: function(): boolean}|null} p
 *   each view's crop (size-matched px), its model's size-matcher target and centring rule (`configCentroid`);
 *   `isShown` false draws nothing (the Training panel is closed or folded: sleap-app drops the preview when its
 *   field goes away)
 */
export function setAnchorCropPreview(p) {
    let next = null;
    if (p && p.byView) {
        const byView = {};
        for (const v of Object.keys(p.byView)) {
            const e = p.byView[v];
            if (e && Number(e.cropSize) > 0) {
                byView[v] = { cropSize: Number(e.cropSize), target: e.target || { height: null, width: null }, centroid: e.centroid || null };
            }
        }
        if (Object.keys(byView).length) {
            next = { anchor: p.anchor || null, byView: byView, key: JSON.stringify([p.anchor || null, byView]),
                isShown: typeof p.isShown === 'function' ? p.isShown : null };
        }
    }
    const same = (next === null && preview === null) || (next !== null && preview !== null && next.key === preview.key);
    preview = next;
    return !same;
}

/** The preview being drawn, or null (tests). */
export function anchorCropPreview() { return preview; }

function nodeNames(session) {
    const nodes = (session && session.skeleton && session.skeleton.nodes) || [];
    return nodes.map(function (n) { return typeof n === 'string' ? n : (n && n.name) || ''; });
}

/** An instance's points as `[x, y, visible]` (a nulled or occluded node is not visible). */
function instancePoints(inst) {
    const out = [];
    const n = inst.numNodes || 0;
    for (let k = 0; k < n; k++) {
        const has = inst.hasPoint(k);
        out.push([has ? inst.getX(k) : NaN, has ? inst.getY(k) : NaN, has && !inst.isOccluded(k)]);
    }
    return out;
}

/**
 * The squares for one view on one frame, in video pixels (tests and the drawing): one per instance the view shows
 * (`shown.showUser` / `shown.showPredicted`, the toolbar's User / Predictions; both when left out).
 * @returns {Array<{x: number, y: number, side: number}>}
 */
export function previewSquares(view, frameGroup, session, shown) {
    if (!preview || !frameGroup || !view) return [];
    if (preview.isShown && !preview.isShown()) return [];
    const mine = preview.byView[view.name];
    if (!mine) return [];                                       // a view no model trains on
    const names = nodeNames(session);
    const ai = preview.anchor ? names.indexOf(preview.anchor) : -1;
    const side = mine.cropSize / frameScale({ width: view.videoWidth, height: view.videoHeight }, mine.target);
    const user = !shown || shown.showUser !== false, predicted = !shown || shown.showPredicted !== false;
    const insts = (frameGroup.instances.get(view.name) || []).filter(Boolean)
        .concat((frameGroup.getUnlinkedInstances(view.name) || []).map(function (u) { return u && u.instance; }).filter(Boolean))
        .filter(function (inst) { return inst.type === 'predicted' ? predicted : user; });
    const out = [];
    for (const inst of insts) {
        const c = cropCentre(instancePoints(inst), ai >= 0 ? ai : null, mine.centroid);
        if (c) out.push({ x: c[0], y: c[1], side: side });
    }
    return out;
}

/** Draw the preview on a view's overlay (called by `drawAllOverlays` with the window transform in place). */
export function drawAnchorCropPreview(view, frameGroup, session, shown) {
    if (!preview || !view || !view.overlayCtx) return;
    const squares = previewSquares(view, frameGroup, session, shown);
    if (!squares.length) return;
    const size = overlayDrawSize(view);
    const vw = view.videoWidth || size.width, vh = view.videoHeight || size.height;
    if (!vw || !vh) return;
    const tf = makeVideoToCanvasTransform(vw, vh, size.width, size.height);
    const ctx = view.overlayCtx;
    // sleap-app: 2 screen px, dashes 6 / 4 (its canvas divides by zoom; the overlay backing store is device px).
    const dpr = (typeof window !== 'undefined' && window.devicePixelRatio) || 1;
    ctx.save();
    ctx.strokeStyle = COLOR;
    ctx.lineWidth = 2 * dpr;
    ctx.setLineDash([6 * dpr, 4 * dpr]);
    for (const s of squares) {
        const p = tf(s.x - s.side / 2, s.y - s.side / 2);
        ctx.strokeRect(p.x, p.y, s.side * tf.scale, s.side * tf.scale);
    }
    ctx.restore();
}
