/**
 * pose/training-crop-size.js — the crop a centered-instance model trains on (Training panel: Anchor Part's
 * Crop Size line and crop preview, Full Configuration's Crop Size), and sleap-app's crop warnings. DOM-free.
 *
 * Sources: sleap-nn 0.3.5 `sleap_nn/data/instance_cropping.py` (`find_instance_crop_size`,
 * `iter_required_crop_sizes`, `find_max_instance_bbox_size`, `compute_augmentation_padding`),
 * `sleap_nn/training/model_trainer.py` (`_compute_crop_padding`, `_setup_preprocessing_config`),
 * `sleap_nn/data/resizing.py` (`compute_eff_scale`), `sleap_nn/data/instance_centroids.py` (`generate_centroids`);
 * sleap-app `src/lib/modelStats.ts` (`computeAugmentationPadding`, `resolveEffectiveCropSize`) and
 * `src/lib/cropWarnings.ts` (`cropSizeWarnings`).
 *
 * LUCID changes: Auto is measured the way sleap-nn 0.3.5 measures it when `crop_size` is null: around each
 * instance's crop centre (the anchor node, or the centre of mass of its visible nodes when there is no anchor or
 * the anchor is not visible), twice the largest per-axis reach, in the size-matched pixels the crop is taken in,
 * plus the rotation / scale padding. sleap-app's estimate (largest bounding box + padding) under-sizes it: on a real
 * 5-mouse project it says 672 px where sleap-nn trained on 752.
 */

/** sleap-nn's `min_crop_size` default (and sleap-app's MIN_CROP_SIZE). */
export const MIN_CROP_SIZE = 100;
/** sleap-app: below this many pixels (after input scaling) centered-instance models do poorly. */
export const MIN_EFFECTIVE_CROP_PX = 100;

/**
 * sleap-nn `compute_augmentation_padding` (verbatim): the worst-case growth of a square box of side `bboxSize`
 * under rotation up to `rotationMax` degrees and scaling up to `scaleMax`, in pixels (total, not per side).
 */
export function augmentationPadding(bboxSize, rotationMax, scaleMax) {
    const rot = Math.abs(Number(rotationMax) || 0);
    const sc = Number(scaleMax);
    const scale = Number.isFinite(sc) ? sc : 1;
    if (rot === 0 && scale <= 1) return 0;
    const rad = Math.min(rot, 90) * Math.PI / 180;
    let factor = Math.abs(Math.cos(rad)) + Math.abs(Math.sin(rad));
    if (rot >= 45) factor = Math.SQRT2;
    return Math.ceil(bboxSize * factor * Math.max(scale, 1) - bboxSize);
}

function num(v, dflt) { const n = Number(v); return v == null || !Number.isFinite(n) ? dflt : n; }

function get(doc, path) {
    let o = doc;
    for (const k of path.split('.')) { if (!o || typeof o !== 'object') return undefined; o = o[k]; }
    return o;
}

/** The backbone's `max_stride` (the one backbone a config sets; sleap-nn rounds the crop up to it). */
export function configMaxStride(doc) {
    const bb = get(doc, 'model_config.backbone_config') || {};
    for (const k of Object.keys(bb)) {
        const s = bb[k] && typeof bb[k] === 'object' ? Number(bb[k].max_stride) : NaN;
        if (Number.isFinite(s) && s > 0) return s;
    }
    return 16;
}

/**
 * The rotation / scale a config augments with, as sleap-nn's `_compute_crop_padding` reads them: a probability
 * left out takes `GeometricConfig`'s default (rotation_p 1.0, scale_p 1.0, translate_p null, affine_p 0.0), and
 * `affine_p` counts only when none of the three is set.
 * @returns {{rotationMax: number, scaleMax: number}|null} null when augmentation adds no padding
 */
export function configAugmentation(doc) {
    const use = get(doc, 'data_config.use_augmentations_train');
    if (use != null && !use) return null;                      // sleap-nn default: True
    const geo = get(doc, 'data_config.augmentation_config.geometric');
    if (!geo || typeof geo !== 'object') return null;
    const has = function (k) { return Object.prototype.hasOwnProperty.call(geo, k); };
    const rotP = has('rotation_p') ? geo.rotation_p : 1.0;
    const scaleP = has('scale_p') ? geo.scale_p : 1.0;
    const transP = has('translate_p') ? geo.translate_p : null;
    const affineP = num(geo.affine_p, 0);
    const bundled = rotP == null && scaleP == null && transP == null && affineP > 0;
    const rotOn = (rotP != null && Number(rotP) > 0) || bundled;
    const scaleOn = (scaleP != null && Number(scaleP) > 0) || bundled;
    if (!rotOn && !scaleOn) return null;
    return {
        rotationMax: rotOn ? Math.max(Math.abs(num(geo.rotation_min, -15)), Math.abs(num(geo.rotation_max, 15))) : 0,
        scaleMax: scaleOn ? num(geo.scale_max, 1.1) : 1,
    };
}

/**
 * The size-matcher target sleap-nn crops in: the config's `max_height` / `max_width`, else the largest video height
 * and width among the labelled frames (sleap-nn's pass 1).
 * @param {Array<{width?: number, height?: number}>} frames
 */
export function sizeMatchTarget(doc, frames) {
    let h = get(doc, 'data_config.preprocessing.max_height');
    let w = get(doc, 'data_config.preprocessing.max_width');
    if (h == null || w == null) {
        // sleap-nn pass 1: either one missing replaces BOTH with the labelled videos' maxima.
        let mh = 0, mw = 0;
        for (const f of frames || []) { mh = Math.max(mh, Number(f.height) || 0); mw = Math.max(mw, Number(f.width) || 0); }
        h = mh || null;
        w = mw || null;
    }
    return { height: h == null ? null : Number(h), width: w == null ? null : Number(w) };
}

/** sleap-nn `compute_eff_scale`: the size matcher's scale for a frame of this size (1 when unknown or equal). */
export function frameScale(frame, target) {
    const fh = Number(frame && frame.height) || 0, fw = Number(frame && frame.width) || 0;
    if (!fh || !fw || !target) return 1;
    const th = target.height == null ? fh : target.height;
    const tw = target.width == null ? fw : target.width;
    if (fh === th && fw === tw) return 1;
    return Math.min(th / fh, tw / fw);
}

/** sleap-nn's whole-instance reductions (`REDUCE_METHODS`); the default fallback is the centre of mass. */
export const REDUCE_METHODS = Object.freeze(['center_of_mass', 'bbox_center', 'geometric_median']);

function visiblePoints(pts) {
    const out = [];
    for (const p of pts) if (p && p[2] && Number.isFinite(p[0]) && Number.isFinite(p[1])) out.push(p);
    return out;
}

/** sleap-nn `reduce_points` over the visible points: mean, box midpoint, or Weiszfeld's geometric median. */
export function reducePoints(pts, method) {
    const v = visiblePoints(pts);
    if (!v.length) return null;
    if (method === 'bbox_center') {
        let x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
        for (const p of v) { x0 = Math.min(x0, p[0]); x1 = Math.max(x1, p[0]); y0 = Math.min(y0, p[1]); y1 = Math.max(y1, p[1]); }
        return [(x0 + x1) * 0.5, (y0 + y1) * 0.5];
    }
    let ex = 0, ey = 0;
    for (const p of v) { ex += p[0]; ey += p[1]; }
    ex /= v.length; ey /= v.length;
    if (method !== 'geometric_median') return [ex, ey];
    // find_points_geometric_median: from the mean, inverse-distance reweighting, 100 steps, tol 1e-6, eps 1e-12.
    for (let it = 0; it < 100; it++) {
        let wx = 0, wy = 0, ws = 0;
        for (const p of v) {
            const d = Math.hypot(p[0] - ex, p[1] - ey);
            if (d <= 1e-12) continue;
            wx += p[0] / d; wy += p[1] / d; ws += 1 / d;
        }
        if (!(ws > 0)) break;
        const nx = wx / Math.max(ws, 1e-12), ny = wy / Math.max(ws, 1e-12);
        const shift = Math.hypot(nx - ex, ny - ey);
        ex = nx; ey = ny;
        if (shift < 1e-6) break;
    }
    return [ex, ey];
}

/**
 * How a config centres its crops (sleap-nn `resolve_centroid_method`): with an anchor, the anchor node and, when it
 * is not visible, `centroid_fallback` (default the centre of mass); without one, `centroid_method` (default the
 * centre of mass). Read from the cropping head's `confmaps` (centered_instance or multi_class_topdown).
 * @returns {{method: string, fallback: string}}
 */
export function configCentroid(doc) {
    const heads = get(doc, 'model_config.head_configs') || {};
    let leaf = null;
    for (const h of ['centered_instance', 'multi_class_topdown']) if (heads[h] && heads[h].confmaps) { leaf = heads[h].confmaps; break; }
    const pick = function (v, ok) { return typeof v === 'string' && ok.indexOf(v) !== -1 ? v : null; };
    return {
        method: pick(leaf && leaf.centroid_method, REDUCE_METHODS) || 'center_of_mass',
        fallback: pick(leaf && leaf.centroid_fallback, REDUCE_METHODS) || 'center_of_mass',
    };
}

/**
 * Where sleap-nn centres an instance's crop: the anchor node when it is visible, else (no anchor, or a hidden one)
 * the reduction of the visible nodes (`centroid` from `configCentroid`; the centre of mass by default); null when
 * none is visible.
 * @param {Array<[number, number, boolean]>} pts
 * @param {number|null} anchorIndex
 * @param {{method?: string, fallback?: string}} [centroid]
 * @returns {[number, number]|null}
 */
export function cropCentre(pts, anchorIndex, centroid) {
    const c = centroid || {};
    if (anchorIndex != null && anchorIndex >= 0) {
        const a = pts[anchorIndex];
        if (a && a[2] && Number.isFinite(a[0]) && Number.isFinite(a[1])) return [a[0], a[1]];
        return reducePoints(pts, c.fallback || 'center_of_mass');
    }
    return reducePoints(pts, c.method || 'center_of_mass');
}

/**
 * The labels' crop measurements in size-matched pixels: the largest bounding-box side (sleap-nn
 * `find_max_instance_bbox_size`) and the largest crop an instance needs around its crop centre
 * (`iter_required_crop_sizes`).
 * @param {Array<{instances: Array<Array<[number, number, boolean]>>, width?: number, height?: number}>} frames
 * @param {{height: number|null, width: number|null}} target
 * @param {number|null} anchorIndex
 * @returns {{instances: number, maxBboxDim: number, required: number}}
 */
export function measureInstances(frames, target, anchorIndex, centroid) {
    let count = 0, maxBbox = 0, required = 0;
    for (const fr of frames || []) {
        const s = frameScale(fr, target);
        for (const pts of fr.instances || []) {
            let minX = Infinity, minY = Infinity, maxX = -Infinity, maxY = -Infinity, valid = 0;
            for (const p of pts) {
                if (!p || !p[2] || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
                minX = Math.min(minX, p[0]); maxX = Math.max(maxX, p[0]);
                minY = Math.min(minY, p[1]); maxY = Math.max(maxY, p[1]);
                valid++;
            }
            if (!valid) continue;
            count++;
            maxBbox = Math.max(maxBbox, (maxX - minX) * s, (maxY - minY) * s);
            const c = cropCentre(pts, anchorIndex, centroid);
            if (!c) continue;
            let reach = 0;
            for (const p of pts) {
                if (!p || !p[2] || !Number.isFinite(p[0]) || !Number.isFinite(p[1])) continue;
                reach = Math.max(reach, Math.abs(p[0] - c[0]) * s, Math.abs(p[1] - c[1]) * s);
            }
            required = Math.max(required, 2 * reach);
        }
    }
    return { instances: count, maxBboxDim: maxBbox, required: required };
}

/**
 * The crop size a centered-instance config trains on: its `crop_size`, or (null = Auto) what sleap-nn 0.3.5
 * computes from these labels.
 * @param {Object} doc  the model's training config
 * @param {Array<{instances: Array<Array<[number, number, boolean]>>, width?: number, height?: number}>} frames
 *   one entry per labelled (view, frame) the model trains on, each user instance's points as `[x, y, visible]`
 * @param {number|null} anchorIndex  the anchor node's index in the points, or null for Auto
 * @returns {{cropSize: number|null, auto: boolean, required: number, padding: number, maxBboxDim: number,
 *            maxStride: number, instances: number}}  cropSize null: Auto with no labelled instance
 */
export function effectiveCropSize(doc, frames, anchorIndex) {
    const stride = configMaxStride(doc);
    const target = sizeMatchTarget(doc, frames);
    const m = measureInstances(frames, target, anchorIndex, configCentroid(doc));
    const given = get(doc, 'data_config.preprocessing.crop_size');
    const base = { required: m.required, maxBboxDim: m.maxBboxDim, maxStride: stride, instances: m.instances };
    if (given != null && Number.isFinite(Number(given))) {
        return Object.assign({ cropSize: Number(given), auto: false, padding: 0 }, base);
    }
    if (!m.instances) return Object.assign({ cropSize: null, auto: true, padding: 0 }, base);
    // sleap-nn: `min_crop_size` left out = 100; null = no floor for the size, but 100 for the padding's box.
    const rawMin = get(doc, 'data_config.preprocessing.min_crop_size');
    const minCrop = rawMin === undefined ? MIN_CROP_SIZE : num(rawMin, 0);
    const aug = configAugmentation(doc);
    const setPad = get(doc, 'data_config.preprocessing.crop_padding');    // sleap-nn: a set crop_padding wins
    const padding = setPad != null && Number.isFinite(Number(setPad)) ? Number(setPad)
        : aug ? augmentationPadding(Math.max(m.maxBboxDim, minCrop || MIN_CROP_SIZE), aug.rotationMax, aug.scaleMax) : 0;
    const length = Math.max(minCrop - padding, m.required, 0) + padding;
    return Object.assign({ cropSize: Math.ceil(length / stride) * stride, auto: true, padding: padding }, base);
}

/**
 * sleap-app's crop warnings (PyQt SLEAP's `get_config_warnings`): the crop the model sees after input scaling is
 * under 100 px, or a crop size set by hand is smaller than the largest labelled animal.
 * @param {{cropSize: number|null, auto: boolean, maxBboxDim: number}} crop  from `effectiveCropSize`
 * @param {number} scale  the config's input scaling
 * @returns {string[]}
 */
export function cropSizeWarnings(crop, scale) {
    const out = [];
    if (!crop || crop.cropSize == null) return out;
    const s = Number(scale) > 0 ? Number(scale) : 1;
    const effective = Math.floor(crop.cropSize * s);
    if (effective < MIN_EFFECTIVE_CROP_PX) {
        out.push('The centered instance model’s input crop will be only ' + effective + 'px after input scaling, ' +
            'but these models perform poorly below 100px. Set Input Scaling to 1.0 and Crop Size to Auto.');
    }
    if (!crop.auto && crop.maxBboxDim > 0 && crop.cropSize < crop.maxBboxDim) {
        out.push('Crop size (' + Math.floor(crop.cropSize) + 'px) is smaller than the largest labeled instance (' +
            Math.round(crop.maxBboxDim) + 'px), so instances will be clipped. Increase the crop size or set it to Auto.');
    }
    return out;
}

/**
 * How visible each node is across the labelled instances (sleap-app's Anchor Part dropdown percentages).
 * @param {Array<{instances: Array<Array<[number, number, boolean]>>}>} frames
 * @param {number} nodeCount
 * @returns {number[]} whole percentages, one per node (0 with no instances)
 */
export function nodeVisibility(frames, nodeCount) {
    const seen = new Array(nodeCount).fill(0);
    let total = 0;
    for (const fr of frames || []) {
        for (const pts of fr.instances || []) {
            total++;
            for (let k = 0; k < nodeCount; k++) if (pts[k] && pts[k][2]) seen[k]++;
        }
    }
    return seen.map(function (n) { return total ? Math.round(100 * n / total) : 0; });
}
