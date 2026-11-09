/**
 * ui/tail-mark-reader.js — the video side of the tail-mark pass
 * (`pose/tail-mark.js`): decode a sampled frame in every camera and score each
 * identity's tail's brightness profile there. Keyframes are read in order through a streaming reader;
 * a change's exact frame is then found with single-frame reads.
 *
 * On a lazy project a group's members hold no 2D unless the frame is resident, so
 * each read is bracketed by `hydrateFrameMembers2d` / `releaseFrameMembers2d`.
 */

import { state } from './app-state.js?v=124c9ab03307';
import { keyframeIndices, streamingReader, canStream, identityGroupsAt } from './image-embedder.js?v=124c9ab03307';
import { hydrateFrameMembers2d, releaseFrameMembers2d } from '../pose/lazy-residency.js?v=124c9ab03307';
import { tailMarkNodeIndices, readTailProfile, normalizeTailProfile, planTailMarkSamples } from '../pose/tail-mark.js?v=124c9ab03307';

/**
 * @param {Object} session
 * @param {number} fps
 * @param {Object} [read]  a second, sharper read of each tail (`TAIL_BAND_READ`, for counting
 *   bands): `baseExtension` starts its line this share of the first tail segment before the tail
 *   base; `percentile` and `widthShare` go to `readTailProfile`. With it, each view's feature is
 *   `{wide, sharp}` (`wide`: the two-animal pass's read, as without it; `sharp` may be null);
 *   without it, the wide profile alone.
 * @returns {?Object}  the reader `resolveTailMarks` takes, with `failed` set instead
 *   when it cannot run (no videos, or no tail nodes)
 */
export function createTailMarkReader(session, fps, read) {
    var views = (state.views || []).filter(function (v) { return v && v.decoder && typeof v.decoder.getFrame === 'function'; });
    if (!views.length) return { failed: 'needs the session\'s videos to be loaded' };
    var nodes = tailMarkNodeIndices((session.skeleton && session.skeleton.nodes) || []);
    if (!nodes) return { failed: 'needs a tail-base node (TTI) and numbered tail nodes (Tail_0, Tail_1) in the skeleton' };

    var canvas = null, ctx = null, readers = null;

    // Each identity's tail in this view, from the keypoints of the frame it decoded.
    function tailsAt(cam, frame) {
        var hydrated = hydrateFrameMembers2d(session, frame) > 0;
        try {
            var out = [];
            identityGroupsAt(session, frame).forEach(function (group, identityId) {
                var inst = group.instances && group.instances.get(cam);
                if (!inst) return;
                var poly = [];
                nodes.forEach(function (n) {
                    var p = inst.getPoint(n);
                    poly.push(p ? p[0] : NaN, p ? p[1] : NaN);
                });
                out.push({ identityId: identityId, poly: poly });
            });
            return out;
        } finally {
            if (hydrated) releaseFrameMembers2d(session, frame);
        }
    }

    // The tail's profile in this view, for each read (`opts` per read: null = the default).
    function profilesOf(poly, reads) {
        var lines = reads.map(function (r) { return r && r.baseExtension ? extendBase(poly, r.baseExtension) : poly; });
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
        lines.forEach(function (line) {
            for (var i = 0; i + 1 < line.length; i += 2) {
                if (!isFinite(line[i]) || !isFinite(line[i + 1])) continue;
                x0 = Math.min(x0, line[i]); x1 = Math.max(x1, line[i]);
                y0 = Math.min(y0, line[i + 1]); y1 = Math.max(y1, line[i + 1]);
                n++;
            }
        });
        if (n < 2) return reads.map(function () { return null; });
        var pad = 24, W = canvas.width, H = canvas.height;
        var left = Math.max(0, Math.floor(x0) - pad), top = Math.max(0, Math.floor(y0) - pad);
        var right = Math.min(W, Math.ceil(x1) + pad), bottom = Math.min(H, Math.ceil(y1) + pad);
        var w = right - left, h = bottom - top;
        if (w <= 0 || h <= 0) return reads.map(function () { return null; });
        var rgba = ctx.getImageData(left, top, w, h).data;
        var gray = new Uint8Array(w * h);
        for (var p = 0; p < gray.length; p++) {
            gray[p] = (77 * rgba[p * 4] + 150 * rgba[p * 4 + 1] + 29 * rgba[p * 4 + 2]) >> 8;
        }
        return lines.map(function (line, k) {
            var local = line.map(function (v, i2) { return v - (i2 % 2 ? top : left); });
            var res = readTailProfile(gray, w, h, local, undefined, reads[k] || undefined);
            return res ? normalizeTailProfile(res.profile, res.background) : null;
        });
    }

    function addScores(into, image, cam, frame) {
        if (!image) return;
        var iw = image.displayWidth || image.width || image.videoWidth, ih = image.displayHeight || image.height || image.videoHeight;
        if (!canvas) {
            canvas = new OffscreenCanvas(iw, ih);
            ctx = canvas.getContext('2d', { willReadFrequently: true });
        } else if (canvas.width !== iw || canvas.height !== ih) { canvas.width = iw; canvas.height = ih; }
        ctx.drawImage(image, 0, 0);
        var reads = read ? [null, read] : [null];
        tailsAt(cam, frame).forEach(function (t) {
            var got = profilesOf(t.poly, reads);
            if (!got[0]) return;
            var s = read ? { wide: got[0], sharp: got[1] } : got[0];
            if (!into.has(t.identityId)) into.set(t.identityId, []);
            into.get(t.identityId).push(s);
        });
    }

    function camOf(v) { return v.cameraName || v.name; }

    return {
        // maxGapSeconds: see planTailMarkSamples
        plan: async function (frames, maxGapSeconds) {
            var keys = await keyframeIndices(views[0].decoder);
            return planTailMarkSamples(frames, keys, fps, maxGapSeconds);
        },
        open: async function (samples) {
            readers = views.map(function (v) {
                return canStream(v.decoder, samples) ? streamingReader(v.decoder, samples, samples) : null;
            });
        },
        // Decoding is parallel across the cameras; scoring is one view at a time, on one canvas.
        next: async function (frame) {
            var images = await Promise.all(views.map(function (v, vi) {
                var r = readers && readers[vi];
                return (r ? r.get(frame) : v.decoder.getFrame(frame)).catch(function () { return null; });
            }));
            var scores = new Map();
            images.forEach(function (img, vi) {
                try { addScores(scores, img, camOf(views[vi]), frame); }
                finally { if (img && readers && readers[vi] && img.close) img.close(); }
            });
            return { scores: scores };
        },
        at: async function (frame) {
            var scores = new Map();
            var images = await Promise.all(views.map(function (v) {
                return Promise.resolve(v.decoder.getFrame(frame)).catch(function () { return null; });
            }));
            images.forEach(function (img, vi) { addScores(scores, img, camOf(views[vi]), frame); });
            return { scores: scores };
        },
        close: function () {
            (readers || []).forEach(function (r) { if (r) r.close(); });
            readers = null;
        },
    };
}

// The line started `share` of the first tail segment before the tail base, away from the
// tail: where the base keypoint lands varies by a band's width, and a band right at the
// base is lost when it lands past it. Unchanged without a base and a next point.
function extendBase(poly, share) {
    var x0 = poly[0], y0 = poly[1];
    if (!isFinite(x0) || !isFinite(y0)) return poly;
    for (var i = 2; i + 1 < poly.length; i += 2) {
        if (!isFinite(poly[i]) || !isFinite(poly[i + 1])) continue;
        return [x0 + share * (x0 - poly[i]), y0 + share * (y0 - poly[i + 1])].concat(poly);
    }
    return poly;
}
