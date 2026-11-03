/**
 * ui/tail-mark-reader.js — the video side of the tail-mark pass
 * (`pose/tail-mark.js`): decode a sampled frame in every camera and score each
 * identity's tail's brightness profile there. Keyframes are read in order through a streaming reader;
 * a change's exact frame is then found with single-frame reads.
 *
 * On a lazy project a group's members hold no 2D unless the frame is resident, so
 * each read is bracketed by `hydrateFrameMembers2d` / `releaseFrameMembers2d`.
 */

import { state } from './app-state.js?v=5e0b8612229e';
import { keyframeIndices, streamingReader, canStream, identityGroupsAt } from './image-embedder.js?v=5e0b8612229e';
import { hydrateFrameMembers2d, releaseFrameMembers2d } from '../pose/lazy-residency.js?v=5e0b8612229e';
import { tailMarkNodeIndices, readTailProfile, normalizeTailProfile, planTailMarkSamples } from '../pose/tail-mark.js?v=5e0b8612229e';

/**
 * @param {Object} session
 * @param {number} fps
 * @returns {?Object}  the reader `resolveTailMarks` takes, with `failed` set instead
 *   when it cannot run (no videos, or no tail nodes)
 */
export function createTailMarkReader(session, fps) {
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

    function profileOf(poly) {
        var x0 = Infinity, y0 = Infinity, x1 = -Infinity, y1 = -Infinity, n = 0;
        for (var i = 0; i + 1 < poly.length; i += 2) {
            if (!isFinite(poly[i]) || !isFinite(poly[i + 1])) continue;
            x0 = Math.min(x0, poly[i]); x1 = Math.max(x1, poly[i]);
            y0 = Math.min(y0, poly[i + 1]); y1 = Math.max(y1, poly[i + 1]);
            n++;
        }
        if (n < 2) return null;
        var pad = 24, W = canvas.width, H = canvas.height;
        var left = Math.max(0, Math.floor(x0) - pad), top = Math.max(0, Math.floor(y0) - pad);
        var right = Math.min(W, Math.ceil(x1) + pad), bottom = Math.min(H, Math.ceil(y1) + pad);
        var w = right - left, h = bottom - top;
        if (w <= 0 || h <= 0) return null;
        var rgba = ctx.getImageData(left, top, w, h).data;
        var gray = new Uint8Array(w * h);
        for (var p = 0; p < gray.length; p++) {
            gray[p] = (77 * rgba[p * 4] + 150 * rgba[p * 4 + 1] + 29 * rgba[p * 4 + 2]) >> 8;
        }
        var local = poly.map(function (v, i2) { return v - (i2 % 2 ? top : left); });
        var res = readTailProfile(gray, w, h, local);
        return res ? normalizeTailProfile(res.profile, res.background) : null;
    }

    function addScores(into, image, cam, frame) {
        if (!image) return;
        var iw = image.displayWidth || image.width || image.videoWidth, ih = image.displayHeight || image.height || image.videoHeight;
        if (!canvas) {
            canvas = new OffscreenCanvas(iw, ih);
            ctx = canvas.getContext('2d', { willReadFrequently: true });
        } else if (canvas.width !== iw || canvas.height !== ih) { canvas.width = iw; canvas.height = ih; }
        ctx.drawImage(image, 0, 0);
        tailsAt(cam, frame).forEach(function (t) {
            var s = profileOf(t.poly);
            if (!s) return;
            if (!into.has(t.identityId)) into.set(t.identityId, []);
            into.get(t.identityId).push(s);
        });
    }

    function camOf(v) { return v.cameraName || v.name; }

    return {
        plan: async function (frames) {
            var keys = await keyframeIndices(views[0].decoder);
            return planTailMarkSamples(frames, keys, fps);
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
