/**
 * ui/brightness-sampler.js — the vector provider behind Tracks ▸ Check ID
 * Switches (Coat Brightness) (pose/id-switch-check.js `checkBrightnessSwitches`).
 *
 * For each animal in each view, the grey level of its coat: the mean brightness
 * in a small disc at every body (non-tail) keypoint, summarised as the 10th,
 * 50th and 90th percentile and the mean, log-scaled — `brightnessFeatures`.
 * Percentiles over whatever body nodes the skeleton has, so it needs no node
 * names. Mice of different coat colour (white / brown / black, under IR) differ
 * mostly in this, and an image embedder trained to ignore brightness (DINOv2)
 * picks it up only indirectly; here it is measured directly, with no model and
 * no GPU — only the decoded video, read the way the image check reads it
 * (`streamingReader` / keyframe plans from ui/image-embedder.js).
 *
 * Disc radius: 1/35 of the animal's body extent (the largest distance between
 * two of its body keypoints), 1–8 px — 4 px for the ~140 px mice it was
 * calibrated on. Missing and occluded keypoints are skipped; an animal with
 * fewer than 4 sampled keypoints in a view gives no vector there.
 *
 * Depends on: ui/app-state.js (state.views), ui/image-embedder.js,
 * pose/id-switch-check.js (planKeyframeSamples).
 */

import { state } from './app-state.js?v=3b23de5d012e';
import { skeletonIndex, mapFrameInstances, streamingReader, keyframeIndices } from './image-embedder.js?v=3b23de5d012e';
import { planKeyframeSamples } from '../pose/id-switch-check.js?v=3b23de5d012e';

/** Percentiles of the body keypoints' brightness that make up the vector (plus their mean). */
export const BRIGHTNESS_QUANTILES = [0.1, 0.5, 0.9];
/** Fewest sampled body keypoints for a vector. */
export const MIN_BRIGHTNESS_POINTS = 4;
/** Frames kept in flight (decoding is the only cost, so a few overlap it). */
export const BRIGHTNESS_IN_FLIGHT = 4;

/** Disc radius (px) for an animal whose body keypoints span `extent` px. */
export function discRadius(extent) {
    return Math.max(1, Math.min(8, Math.round(extent / 35)));
}

/**
 * The vector for one animal in one view, from its keypoints' disc brightness
 * (0–255, any order): [q10, q50, q90, mean] as log(1 + x), or null with fewer
 * than MIN_BRIGHTNESS_POINTS values.
 * @param {number[]} values
 * @returns {Float64Array|null}
 */
export function brightnessFeatures(values) {
    var v = values.filter(function (x) { return x === x; }).sort(function (a, b) { return a - b; });
    if (v.length < MIN_BRIGHTNESS_POINTS) return null;
    var out = new Float64Array(BRIGHTNESS_QUANTILES.length + 1), sum = 0;
    BRIGHTNESS_QUANTILES.forEach(function (q, i) { out[i] = Math.log(1 + v[Math.round(q * (v.length - 1))]); });
    for (var i = 0; i < v.length; i++) sum += v[i];
    out[BRIGHTNESS_QUANTILES.length] = Math.log(1 + sum / v.length);
    return out;
}

/** An animal's sampled body keypoints in a view ([x, y] list, missing / occluded skipped) and its disc radius. */
export function bodyPoints(inst, body) {
    var pts = [];
    for (var i = 0; i < body.length; i++) {
        var k = body[i];
        if (!inst.hasPoint(k) || (inst.isOccluded && inst.isOccluded(k))) continue;
        var x = inst.getX(k), y = inst.getY(k);
        if (isFinite(x) && isFinite(y)) pts.push([x, y]);
    }
    if (pts.length < MIN_BRIGHTNESS_POINTS) return null;
    var ext = 0;
    for (var a = 0; a < pts.length; a++) for (var b = a + 1; b < pts.length; b++) {
        var d = Math.hypot(pts[a][0] - pts[b][0], pts[a][1] - pts[b][1]);
        if (d > ext) ext = d;
    }
    return { pts: pts, r: discRadius(ext) };
}

/**
 * Mean grey level (0.299 R + 0.587 G + 0.114 B, as the image crops) in a disc of
 * radius `r` around (x, y), read from an RGBA buffer `px` covering the image
 * region [x0, x0 + w) x [y0, y0 + h). Pixels outside the region are skipped;
 * NaN when none is inside.
 */
export function discMean(px, w, h, x0, y0, x, y, r) {
    var cx = Math.round(x) - x0, cy = Math.round(y) - y0, sum = 0, n = 0;
    for (var dy = -r; dy <= r; dy++) for (var dx = -r; dx <= r; dx++) {
        if (dx * dx + dy * dy > r * r) continue;
        var u = cx + dx, v = cy + dy;
        if (u < 0 || v < 0 || u >= w || v >= h) continue;
        var o = (v * w + u) * 4;
        sum += 0.299 * px[o] + 0.587 * px[o + 1] + 0.114 * px[o + 2]; n++;
    }
    return n ? sum / n : NaN;
}

/**
 * Brightness vectors for several animals in ONE decoded image: one read of the
 * region covering all their discs. `animals[i]` = bodyPoints(...) or null.
 * @returns {Array<Float64Array|null>}
 */
export function sampleAnimals(image, animals, canvas) {
    var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity;
    animals.forEach(function (a) {
        if (!a) return;
        a.pts.forEach(function (p) {
            x0 = Math.min(x0, p[0] - a.r); y0 = Math.min(y0, p[1] - a.r);
            x1 = Math.max(x1, p[0] + a.r); y1 = Math.max(y1, p[1] + a.r);
        });
    });
    if (!(x1 >= x0)) return animals.map(function () { return null; });
    var iw = image.displayWidth || image.videoWidth || image.width, ih = image.displayHeight || image.videoHeight || image.height;
    x0 = Math.max(0, Math.floor(x0)); y0 = Math.max(0, Math.floor(y0));
    x1 = Math.min(iw - 1, Math.ceil(x1)); y1 = Math.min(ih - 1, Math.ceil(y1));
    var w = x1 - x0 + 1, h = y1 - y0 + 1;
    if (!(w > 0 && h > 0)) return animals.map(function () { return null; });
    if (canvas.width < w) canvas.width = w;
    if (canvas.height < h) canvas.height = h;
    var ctx = canvas.getContext('2d', { willReadFrequently: true });
    ctx.clearRect(0, 0, w, h);
    ctx.drawImage(image, x0, y0, w, h, 0, 0, w, h);
    var px = ctx.getImageData(0, 0, w, h).data;
    return animals.map(function (a) {
        if (!a) return null;
        return brightnessFeatures(a.pts.map(function (p) { return discMean(px, w, h, x0, y0, p[0], p[1], a.r); }));
    });
}

/**
 * The provider `checkBrightnessSwitches` needs over the active session's loaded
 * videos: `getEmbeddings(frame, items)` -> per item [{camera, vector}], with
 * `prepareFrames(frames)` / `releaseFrames()` streaming each view's frames in
 * order (as the image check does) and `inFlight`. Every view the animal is
 * sampled in contributes (the check fits one classifier per view).
 * @param {Session} session  the session the check reads (a single-camera stand-in is fine)
 * @param {{keyframes?: boolean|function}} [opts]  as for createImageEmbedder
 */
export function createBrightnessSampler(session, opts) {
    opts = opts || {};
    var views = (state.views || []).filter(function (v) { return v && v.decoder && typeof v.decoder.getFrame === 'function'; });
    if (!views.length) throw new Error('needs the session\'s videos to be loaded');
    var body = skeletonIndex((session.skeleton && session.skeleton.nodes) || []).body;
    if (body.length < MIN_BRIGHTNESS_POINTS) throw new Error('needs at least ' + MIN_BRIGHTNESS_POINTS + ' body (non-tail) nodes in the skeleton');
    var cams = views.map(function (v) { return v.cameraName || v.name; });
    var canvas = new OffscreenCanvas(64, 64), readers = null, samples = 0;
    var useKeyframes = opts.keyframes !== false && !(typeof window !== 'undefined' && window.LUCID_IMAGE_KEYFRAMES === 0);
    return {
        inFlight: BRIGHTNESS_IN_FLIGHT,
        views: cams,
        prepareFrames: async function (frames) {
            var tracked = function (f) { return !!(session.instanceGroups && session.instanceGroups.has(f)); };
            var plans = await Promise.all(views.map(async function (v) {
                var kf = !useKeyframes ? null
                    : typeof opts.keyframes === 'function' ? await opts.keyframes(v.decoder) : await keyframeIndices(v.decoder);
                return planKeyframeSamples(frames, kf, tracked);
            }));
            readers = views.map(function (v, vi) { return streamingReader(v.decoder, frames, plans[vi].decode); });
        },
        releaseFrames: function () {
            if (readers) readers.forEach(function (r) { if (r) r.close(); });
            readers = null;
        },
        getEmbeddings: async function (frame, items) {
            var at = views.map(function (v, vi) { var r = readers && readers[vi]; return r ? r.decodedFrame(frame) : frame; });
            var animals = mapFrameInstances(session, frame, items, cams, at, function (inst) { return bodyPoints(inst, body); });
            var out = items.map(function () { return []; });
            await Promise.all(views.map(async function (v, vi) {
                if (!animals[vi].some(Boolean)) return;
                var r = readers && readers[vi], img = null;
                try { img = r ? await r.get(frame) : await v.decoder.getFrame(frame); } catch (e) { img = null; }
                if (!img) return;
                try {
                    sampleAnimals(img, animals[vi], canvas).forEach(function (vec, ii) {
                        if (vec) { out[ii].push({ camera: cams[vi], vector: vec }); samples++; }
                    });
                } finally {
                    if (r && img.close) img.close();          // a streamed frame is ours; a cached one is the decoder's
                }
            }));
            return out;
        },
        stats: function () { return { samples: samples }; },
    };
}
