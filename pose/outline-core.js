// pose/outline-core.js — animal outlines the idtracker.ai way (Romero-Ferrero et
// al. 2019, Nat Methods; https://idtracker.ai/latest/), per camera and frame,
// split between the animals by their poses. DOM-free and allocation-light: it
// runs in `pose/outline-worker.js` and in Node tests.
//
// 1. Blobs. Each camera's empty-arena image is the per-pixel median of frames
//    sampled across the video (`medianImage`). A pixel is foreground when it is
//    brighter than that image (animals light on a dark floor), with hysteresis:
//    pixels more than `thrLow` grey levels brighter, joined to pixels more than
//    `thrHigh` brighter, so an animal's dim, shadowed parts stay with its bright
//    ones while the floor and its shadows, never brighter than the empty arena,
//    stay out. Then a morphological open (3 px ellipse) and close (5 px),
//    8-connected components, a minimum area, and holes filled (`segmentBlobs`).
// 2. A single-animal area model per video (`areaModel`): the median and s.d. of
//    blob areas in sampled frames whose blob count equals the number of animals.
//    A blob more than `areaSigmas` s.d. over the median is a crossing
//    (idtracker.ai's test is one-sided: a small blob is an animal's fragment).
// 3. Per animal (`computeOutlines`): an animal is IN a blob when at least a
//    quarter of its body keypoints (at least one) lie in it. A blob with one
//    animal in it is that animal's, whole. A crossing (two or more animals in
//    it, or one animal in a blob the area model calls a crossing) is split by
//    nearest body skeleton. A blob nobody is in goes to the animal whose body
//    keypoints come within `reach` px of it, else to nobody. Poses come from
//    the camera's own 2D detection, else from the animal's 3D projected into it
//    (the caller supplies whichever it has).
// 4. Tails, traced: bright pixels within `tailWidth` px of an animal's tail
//    polyline (its tail keypoints from the body point they hang from) become
//    that animal's, unless they lie in another animal's body core (its mask
//    eroded by `coreErode` px; a tail does not survive that, a body does).
// 5. Small bright pieces (a forepaw cut off by the open) within `reattach` px of
//    exactly one animal join it; pieces of an animal under `minPiece` px go.
//
// Tails and the split use BODY skeletons only: an animal's tail lying across
// another animal would otherwise pull that animal's back pixels to it.

export const OUTLINE_PARAMS = Object.freeze({
    thrLow: 8,          // grey levels over the empty arena: joined to a bright pixel
    thrHigh: 22,        // grey levels over the empty arena: bright
    openSize: 3,        // px, elliptical element (cv2.MORPH_ELLIPSE)
    closeSize: 5,
    minArea: 150,       // px: smaller blobs are not animals
    areaSigmas: 4,      // single-animal area model: median + k s.d.
    reach: 15,          // px: a blob nobody is in goes to an animal this close
    tailWidth: 7,       // px each side of a tail polyline
    coreErode: 4,       // px: another animal's body core blocks tail tracing
    reattach: 6,        // px: a small bright piece this close to one animal joins it (0 = off)
    reattachMin: 6,     // px: smaller bright pieces are noise
    minPiece: 60,       // px: an animal's pieces smaller than this go
    inFraction: 0.25,   // share of an animal's body keypoints that puts it in a blob
});

/** Merged parameters: `p` over the defaults, unknown keys ignored. */
export function outlineParams(p) {
    var out = {};
    for (var k in OUTLINE_PARAMS) {
        var v = p && p[k];
        out[k] = (typeof v === 'number' && isFinite(v)) ? v : OUTLINE_PARAMS[k];
    }
    return out;
}

/** RGBA bytes -> grey (BT.601 luma, integer); a mono video gives its own value back. */
export function rgbaToGray(rgba, out) {
    var n = rgba.length >> 2;
    out = out || new Uint8Array(n);
    for (var i = 0, j = 0; i < n; i++, j += 4) {
        out[i] = (rgba[j] * 77 + rgba[j + 1] * 150 + rgba[j + 2] * 29 + 128) >> 8;
    }
    return out;
}

/**
 * Per-pixel median of `frames` (equal-length Uint8Arrays): the empty arena when
 * the animals move. The lower median for an even count.
 */
export function medianImage(frames) {
    var F = frames.length;
    if (!F) throw new Error('medianImage: no frames');
    var n = frames[0].length;
    var out = new Uint8Array(n);
    if (F === 1) { out.set(frames[0]); return out; }
    var k = (F - 1) >> 1;
    var a = new Uint8Array(F);
    for (var i = 0; i < n; i++) {
        for (var f = 0; f < F; f++) a[f] = frames[f][i];
        out[i] = select(a, F, k);
    }
    return out;
}

// k-th smallest of a[0..n) (Hoare's selection, in place).
function select(a, n, k) {
    var lo = 0, hi = n - 1;
    while (hi > lo) {
        var mid = (lo + hi) >> 1;
        // median of three as the pivot
        var x = a[lo], y = a[mid], z = a[hi];
        var piv = x < y ? (y < z ? y : (x < z ? z : x)) : (x < z ? x : (y < z ? z : y));
        var i = lo, j = hi;
        while (i <= j) {
            while (a[i] < piv) i++;
            while (a[j] > piv) j--;
            if (i <= j) { var t = a[i]; a[i] = a[j]; a[j] = t; i++; j--; }
        }
        if (k <= j) hi = j;
        else if (k >= i) lo = i;
        else return a[k];
    }
    return a[k];
}

/**
 * OpenCV's elliptical structuring element (`cv2.getStructuringElement(
 * MORPH_ELLIPSE, (size, size))`) as row runs `[{dy, x0, x1}]` around the centre.
 */
export function ellipseElement(size) {
    var r = size >> 1, c = size >> 1;
    var inv = r ? 1 / (r * r) : 0;
    var rows = [];
    for (var i = 0; i < size; i++) {
        var dy = i - r;
        var j1 = 0, j2 = 0;
        if (Math.abs(dy) <= r) {
            var dx = Math.round(c * Math.sqrt((r * r - dy * dy) * inv));
            j1 = Math.max(c - dx, 0);
            j2 = Math.min(c + dx + 1, size);
        }
        if (j2 > j1) rows.push({ dy: dy, x0: j1 - c, x1: j2 - 1 - c });
    }
    return rows;
}

// Row prefix counts of set pixels: P[y*(w+1)+x] = set pixels in row y before x.
function rowPrefix(src, w, h, P) {
    var W1 = w + 1;
    P = P && P.length >= W1 * h ? P : new Int32Array(W1 * h);
    for (var y = 0; y < h; y++) {
        var o = y * W1, s = y * w, acc = 0;
        P[o] = 0;
        for (var x = 0; x < w; x++) { acc += src[s + x]; P[o + x + 1] = acc; }
    }
    return P;
}

/**
 * Binary erosion (`erode` true) or dilation with an element from
 * `ellipseElement`, OpenCV's border rule: pixels outside the image never erode
 * and never dilate. `src`/`dst` are 0/1 Uint8Arrays (may not alias).
 */
export function morph(src, w, h, element, erode, dst, scratch) {
    dst = dst || new Uint8Array(w * h);
    var P = rowPrefix(src, w, h, scratch);
    var W1 = w + 1, R = element.length;
    var dyMin = element[0].dy, dyMax = element[R - 1].dy;
    for (var y = 0; y < h; y++) {
        // a row with nothing set in reach dilates to nothing; an empty row erodes to nothing
        var any = 0;
        for (var ry = Math.max(0, y + dyMin); ry <= Math.min(h - 1, y + dyMax) && !any; ry++) any = P[ry * W1 + w];
        if (!any || (erode && !P[y * W1 + w])) { dst.fill(0, y * w, y * w + w); continue; }
        for (var x = 0; x < w; x++) {
            // the element holds its centre: erosion keeps only set pixels, dilation keeps every set one
            var sv = src[y * w + x];
            if (erode ? !sv : sv) { dst[y * w + x] = sv; continue; }
            var hit = erode ? 1 : 0;
            for (var r = 0; r < R; r++) {
                var e = element[r], yy = y + e.dy;
                if (yy < 0 || yy >= h) continue;
                var x0 = x + e.x0, x1 = x + e.x1;
                if (x0 < 0) x0 = 0;
                if (x1 > w - 1) x1 = w - 1;
                var o = yy * W1;
                var ones = P[o + x1 + 1] - P[o + x0];
                if (erode) { if (ones !== x1 - x0 + 1) { hit = 0; break; } }
                else if (ones > 0) { hit = 1; break; }
            }
            dst[y * w + x] = hit;
        }
    }
    return dst;
}

/**
 * 8-connected components of the set pixels of `mask` (any nonzero), or — with
 * `sameValue` — of runs of equal nonzero values (so touching animals stay
 * apart). -> { lab: Int32Array (0 = none, 1..n), n, area: Int32Array(n+1),
 * first: Int32Array(n+1) (raster-first pixel of each) }.
 */
export function components(mask, w, h, sameValue) {
    var N = w * h;
    var lab = new Int32Array(N);
    var parent = [0];
    function find(a) {
        while (parent[a] !== a) { parent[a] = parent[parent[a]]; a = parent[a]; }
        return a;
    }
    function union(a, b) {
        a = find(a); b = find(b);
        if (a === b) return a;
        if (a < b) { parent[b] = a; return a; }
        parent[a] = b; return b;
    }
    var next = 1;
    for (var y = 0; y < h; y++) {
        for (var x = 0; x < w; x++) {
            var i = y * w + x, v = mask[i];
            if (!v) continue;
            var l = 0;
            // already-visited neighbours: W, NW, N, NE
            if (x > 0 && mask[i - 1] && (!sameValue || mask[i - 1] === v)) l = lab[i - 1];
            if (y > 0) {
                var up = i - w;
                if (x > 0 && mask[up - 1] && (!sameValue || mask[up - 1] === v)) l = l ? union(l, lab[up - 1]) : lab[up - 1];
                if (mask[up] && (!sameValue || mask[up] === v)) l = l ? union(l, lab[up]) : lab[up];
                if (x < w - 1 && mask[up + 1] && (!sameValue || mask[up + 1] === v)) l = l ? union(l, lab[up + 1]) : lab[up + 1];
            }
            if (!l) { l = next++; parent.push(l); }
            lab[i] = l;
        }
    }
    // flatten to consecutive ids
    var map = new Int32Array(next);
    var n = 0;
    for (var a = 1; a < next; a++) {
        var r = find(a);
        if (!map[r]) map[r] = ++n;
        map[a] = map[r];
    }
    var area = new Int32Array(n + 1), first = new Int32Array(n + 1).fill(-1);
    for (var p = 0; p < N; p++) {
        var q = lab[p];
        if (!q) continue;
        q = map[q];
        lab[p] = q;
        area[q]++;
        if (first[q] < 0) first[q] = p;
    }
    return { lab: lab, n: n, area: area, first: first };
}

// Bounding boxes of the labels in `lab` (0..n): Int32Array [x0,y0,x1,y1] each.
function boxes(lab, w, h, n) {
    var b = new Int32Array((n + 1) * 4);
    for (var k = 0; k <= n; k++) { b[4 * k] = w; b[4 * k + 1] = h; b[4 * k + 2] = -1; b[4 * k + 3] = -1; }
    for (var y = 0, i = 0; y < h; y++) {
        for (var x = 0; x < w; x++, i++) {
            var l = lab[i];
            if (!l) continue;
            var o = 4 * l;
            if (x < b[o]) b[o] = x;
            if (y < b[o + 1]) b[o + 1] = y;
            if (x > b[o + 2]) b[o + 2] = x;
            if (y > b[o + 3]) b[o + 3] = y;
        }
    }
    return b;
}

/**
 * Fill the holes of label `v` in `lab` (a Uint8Array or Int32Array label map)
 * inside its box: pixels not reachable from the box's border without crossing
 * `v` become `v`, where they are 0 (another label inside it is kept). Returns
 * the number of pixels filled.
 */
export function fillHoles(lab, w, h, v, box) {
    var x0 = Math.max(0, box[0] - 1), y0 = Math.max(0, box[1] - 1);
    var x1 = Math.min(w - 1, box[2] + 1), y1 = Math.min(h - 1, box[3] + 1);
    var bw = x1 - x0 + 1, bh = y1 - y0 + 1;
    if (bw <= 2 || bh <= 2) return 0;
    var seen = new Uint8Array(bw * bh);
    var stack = new Int32Array(bw * bh);
    var sp = 0;
    function push(x, y) {
        var j = (y - y0) * bw + (x - x0);
        if (seen[j] || lab[y * w + x] === v) return;
        seen[j] = 1; stack[sp++] = j;
    }
    for (var x = x0; x <= x1; x++) { push(x, y0); push(x, y1); }
    for (var y = y0; y <= y1; y++) { push(x0, y); push(x1, y); }
    while (sp) {
        var j = stack[--sp], cx = (j % bw) + x0, cy = ((j / bw) | 0) + y0;
        if (cx > x0) push(cx - 1, cy);
        if (cx < x1) push(cx + 1, cy);
        if (cy > y0) push(cx, cy - 1);
        if (cy < y1) push(cx, cy + 1);
    }
    var filled = 0;
    for (var yy = y0; yy <= y1; yy++) {
        for (var xx = x0; xx <= x1; xx++) {
            var i = yy * w + xx;
            if (!seen[(yy - y0) * bw + (xx - x0)] && lab[i] === 0) { lab[i] = v; filled++; }
        }
    }
    return filled;
}

/**
 * idtracker.ai blobs of one frame against its camera's empty arena.
 * -> { blob: Int32Array (0 = none, 1..n), n, area: Int32Array(n+1),
 *      box: Int32Array(4(n+1)), bright: Uint8Array (d > thrHigh, raw) }
 */
export function segmentBlobs(gray, bg, w, h, params) {
    var P = outlineParams(params);
    var N = w * h;
    var lo = new Uint8Array(N), bright = new Uint8Array(N);
    var tl = P.thrLow, th = P.thrHigh;
    for (var i = 0; i < N; i++) {
        var d = gray[i] - bg[i];
        if (d > tl) lo[i] = 1;
        if (d > th) bright[i] = 1;
    }
    var scratch = new Int32Array((w + 1) * h);
    var tmp = new Uint8Array(N);
    var eOpen = ellipseElement(P.openSize), eClose = ellipseElement(P.closeSize);
    morph(lo, w, h, eOpen, true, tmp, scratch);
    morph(tmp, w, h, eOpen, false, lo, scratch);
    morph(lo, w, h, eClose, false, tmp, scratch);
    morph(tmp, w, h, eClose, true, lo, scratch);
    var cc = components(lo, w, h, false);
    var keep = new Int32Array(cc.n + 1);
    var hasHi = new Uint8Array(cc.n + 1);
    for (var p = 0; p < N; p++) if (bright[p] && cc.lab[p]) hasHi[cc.lab[p]] = 1;
    var n = 0;
    for (var k = 1; k <= cc.n; k++) if (hasHi[k] && cc.area[k] >= P.minArea) keep[k] = ++n;
    var blob = cc.lab;
    for (var q = 0; q < N; q++) if (blob[q]) blob[q] = keep[blob[q]];
    var box = boxes(blob, w, h, n);
    var area = new Int32Array(n + 1);
    for (var b = 1; b <= n; b++) fillHoles(blob, w, h, b, box.subarray(4 * b, 4 * b + 4));
    for (var z = 0; z < N; z++) if (blob[z]) area[blob[z]]++;
    return { blob: blob, n: n, area: area, box: box, bright: bright };
}

/**
 * The single-animal area model from sampled frames' blob areas (`samples`: an
 * array of number arrays, one per frame) and the number of animals: the median
 * and s.d. of the areas in frames with exactly `nAnimals` blobs. null with
 * fewer than 3 such areas. `hi` is the crossing threshold.
 */
export function areaModel(samples, nAnimals, params) {
    var P = outlineParams(params);
    var areas = [];
    var frames = 0;
    if (nAnimals >= 1) {
        for (var i = 0; i < samples.length; i++) {
            var s = samples[i];
            if (s && s.length === nAnimals) { frames++; for (var j = 0; j < s.length; j++) areas.push(s[j]); }
        }
    }
    if (areas.length < 3) return null;
    areas.sort(function (a, b) { return a - b; });
    var m = areas.length;
    var median = m % 2 ? areas[(m - 1) >> 1] : (areas[m / 2 - 1] + areas[m / 2]) / 2;
    var mean = 0;
    for (var k = 0; k < m; k++) mean += areas[k];
    mean /= m;
    var v = 0;
    for (var t = 0; t < m; t++) v += (areas[t] - mean) * (areas[t] - mean);
    var sd = Math.sqrt(v / m);
    return { median: median, sd: sd, lo: median - P.areaSigmas * sd, hi: median + P.areaSigmas * sd, n: m, frames: frames };
}

// Squared distance from (px,py) to segment (ax,ay)-(bx,by).
function segDist2(px, py, ax, ay, bx, by) {
    var vx = bx - ax, vy = by - ay;
    var L = vx * vx + vy * vy;
    var t = L > 0 ? ((px - ax) * vx + (py - ay) * vy) / L : 0;
    if (t < 0) t = 0; else if (t > 1) t = 1;
    var dx = ax + t * vx - px, dy = ay + t * vy - py;
    return dx * dx + dy * dy;
}

// Squared distance from a pixel to an animal's body skeleton (segments, else points).
function bodyDist2(a, x, y) {
    var best = Infinity, s = a.segments, p = a.body, i;
    if (s && s.length >= 4) {
        for (i = 0; i + 3 < s.length; i += 4) {
            var d = segDist2(x, y, s[i], s[i + 1], s[i + 2], s[i + 3]);
            if (d < best) best = d;
        }
        return best;
    }
    for (i = 0; i + 1 < p.length; i += 2) {
        var dx = p[i] - x, dy = p[i + 1] - y, e = dx * dx + dy * dy;
        if (e < best) best = e;
    }
    return best;
}

function finitePts(arr) {
    var out = [];
    if (!arr) return out;
    for (var i = 0; i + 1 < arr.length; i += 2) {
        if (isFinite(arr[i]) && isFinite(arr[i + 1])) out.push(arr[i], arr[i + 1]);
    }
    return out;
}

/**
 * Normalise an animal for `computeOutlines`: `{body, segments, tail}` as flat
 * number arrays (points [x,y,...], segments [x0,y0,x1,y1,...], tail polyline
 * [x,y,...]); non-finite points dropped, a segment kept only with both ends.
 */
export function normalizeAnimal(a) {
    var body = finitePts(a && a.body);
    var segs = [];
    var s = a && a.segments;
    if (s) for (var i = 0; i + 3 < s.length; i += 4) {
        if (isFinite(s[i]) && isFinite(s[i + 1]) && isFinite(s[i + 2]) && isFinite(s[i + 3])) segs.push(s[i], s[i + 1], s[i + 2], s[i + 3]);
    }
    var tail = finitePts(a && a.tail);
    return { body: body, segments: segs, tail: tail.length >= 4 ? tail : null };
}

/**
 * Outlines of one camera frame.
 *
 * @param {Uint8Array} gray - the frame, grey
 * @param {Uint8Array} bg - the camera's empty arena
 * @param {number} w @param {number} h
 * @param {Array<{body:number[], segments:number[], tail:number[]|null}>} animals
 *   each animal's pose in this camera (from `normalizeAnimal`, or raw: it is
 *   normalised here)
 * @param {object|null} model - `areaModel`'s result
 * @param {object} [params]
 * @returns {{labels: Uint8Array, blobs: Array, animals: Array, contours: Array,
 *   unassigned: Array}} `labels`: 0 = no animal, k = animals[k-1]; `contours[k]`
 *   the outer boundaries of animal k's pieces (Float32Array polygons, pixel
 *   centres); `unassigned`: polygons of animal-sized blobs nobody was given.
 */
export function computeOutlines(gray, bg, w, h, animals, model, params) {
    var P = outlineParams(params);
    var N = w * h;
    var A = (animals || []).map(normalizeAnimal);
    if (A.length > 254) A = A.slice(0, 254);
    var seg = segmentBlobs(gray, bg, w, h, P);
    var blob = seg.blob, nb = seg.n;
    var labels = new Uint8Array(N);

    // body keypoints in each blob, per animal
    var inCount = [];
    for (var a = 0; a < A.length; a++) {
        var row = new Int32Array(nb + 1), pts = A[a].body;
        for (var i = 0; i + 1 < pts.length; i += 2) {
            var x = Math.round(pts[i]), y = Math.round(pts[i + 1]);
            if (x < 0 || y < 0 || x >= w || y >= h) continue;
            row[blob[y * w + x]]++;
        }
        inCount.push(row);
    }
    var isIn = function (a, b) {
        var nPts = A[a].body.length >> 1;
        return inCount[a][b] >= Math.max(1, Math.ceil(P.inFraction * nPts));
    };
    var housed = new Uint8Array(A.length);
    for (var aa = 0; aa < A.length; aa++) for (var bb = 1; bb <= nb; bb++) if (isIn(aa, bb)) { housed[aa] = 1; break; }

    var blobInfo = [];
    var reach2 = P.reach * P.reach;
    for (var b = 1; b <= nb; b++) {
        var box = seg.box.subarray(4 * b, 4 * b + 4);
        var cand = [];
        for (var k = 0; k < A.length; k++) if (isIn(k, b)) cand.push(k);
        var byArea = !!(model && seg.area[b] > model.hi);
        var kind;
        if (cand.length === 1 && byArea) {
            // the area says two or more: an animal not in any blob, close by, may be the other
            for (var u = 0; u < A.length; u++) {
                if (housed[u] || cand.indexOf(u) >= 0) continue;
                if (nearBlob(A[u], blob, w, h, b, box, reach2)) cand.push(u);
            }
            kind = cand.length > 1 ? 'crossing' : 'oversized';
        } else if (cand.length > 1) {
            kind = 'crossing';
        } else if (cand.length === 1) {
            kind = 'individual';
        } else {
            var best = -1, bestD = reach2;
            for (var c = 0; c < A.length; c++) {
                var d = blobDist2(A[c], blob, w, h, b, box, bestD);
                if (d <= bestD) { bestD = d; best = c; }
            }
            if (best >= 0) { cand.push(best); kind = 'near'; }
            else kind = 'unassigned';
        }
        blobInfo.push({ area: seg.area[b], kind: kind, animals: cand.slice(), byArea: byArea });
        if (!cand.length) continue;
        var x0 = box[0], y0 = box[1], x1 = box[2], y1 = box[3];
        if (cand.length === 1) {
            var v = cand[0] + 1;
            for (var yy = y0; yy <= y1; yy++) for (var xx = x0, p = yy * w + x0; xx <= x1; xx++, p++) if (blob[p] === b) labels[p] = v;
        } else {
            for (var y2 = y0; y2 <= y1; y2++) {
                for (var x2 = x0, p2 = y2 * w + x0; x2 <= x1; x2++, p2++) {
                    if (blob[p2] !== b) continue;
                    var bk = cand[0], bd = Infinity;
                    for (var ci = 0; ci < cand.length; ci++) {
                        var dd = bodyDist2(A[cand[ci]], x2, y2);
                        if (dd < bd) { bd = dd; bk = cand[ci]; }
                    }
                    labels[p2] = bk + 1;
                }
            }
        }
    }

    // tails
    var traced = new Int32Array(A.length + 1);
    if (P.tailWidth > 0 && A.some(function (z) { return z.tail; })) {
        var core = cores(labels, w, h, A.length, P.coreErode);
        var tw2 = P.tailWidth * P.tailWidth;
        for (var t = 0; t < A.length; t++) {
            var L = A[t].tail;
            if (!L) continue;
            var tv = t + 1;
            var bx0 = Infinity, by0 = Infinity, bx1 = -Infinity, by1 = -Infinity;
            for (var li = 0; li + 1 < L.length; li += 2) {
                if (L[li] < bx0) bx0 = L[li]; if (L[li] > bx1) bx1 = L[li];
                if (L[li + 1] < by0) by0 = L[li + 1]; if (L[li + 1] > by1) by1 = L[li + 1];
            }
            var tx0 = Math.max(0, Math.floor(bx0 - P.tailWidth)), ty0 = Math.max(0, Math.floor(by0 - P.tailWidth));
            var tx1 = Math.min(w - 1, Math.ceil(bx1 + P.tailWidth)), ty1 = Math.min(h - 1, Math.ceil(by1 + P.tailWidth));
            for (var ty = ty0; ty <= ty1; ty++) {
                for (var tx = tx0, tp = ty * w + tx0; tx <= tx1; tx++, tp++) {
                    if (!seg.bright[tp] || labels[tp] === tv) continue;
                    var cv = core[tp];
                    if (cv && cv !== tv) continue;
                    var near = false;
                    for (var sj = 0; sj + 3 < L.length; sj += 2) {
                        if (segDist2(tx, ty, L[sj], L[sj + 1], L[sj + 2], L[sj + 3]) <= tw2) { near = true; break; }
                    }
                    if (near) { labels[tp] = tv; traced[tv]++; }
                }
            }
        }
    }

    // small bright pieces near exactly one animal (a forepaw the open cut off)
    var reattached = new Int32Array(A.length + 1);
    var rePx = null;                                // pixels re-attached: never dropped as small pieces
    if (P.reattach > 0 && A.length) {
        var free = new Uint8Array(N);
        for (var f = 0; f < N; f++) if (seg.bright[f] && !labels[f] && !blob[f]) free[f] = 1;
        var fc = components(free, w, h, false);
        if (fc.n) {
            var fbox = boxes(fc.lab, w, h, fc.n);
            var R = P.reattach | 0;
            for (var q = 1; q <= fc.n; q++) {
                if (fc.area[q] < P.reattachMin || fc.area[q] >= P.minArea) continue;
                var who = neighbourLabel(fc.lab, labels, w, h, q, fbox.subarray(4 * q, 4 * q + 4), R);
                if (who > 0) {
                    var qb = fbox.subarray(4 * q, 4 * q + 4);
                    if (!rePx) rePx = new Uint8Array(N);
                    for (var qy = qb[1]; qy <= qb[3]; qy++) for (var qx = qb[0], qp = qy * w + qb[0]; qx <= qb[2]; qx++, qp++) if (fc.lab[qp] === q) { labels[qp] = who; rePx[qp] = 1; }
                    reattached[who] += fc.area[q];
                }
            }
        }
    }

    // pieces: drop small ones, trace the rest
    var pc = components(labels, w, h, true);
    var pbox = boxes(pc.lab, w, h, pc.n);
    var contours = [];
    var areas = new Int32Array(A.length + 1);
    for (var z = 0; z <= A.length; z++) contours.push([]);
    for (var pi = 1; pi <= pc.n; pi++) {
        var v2 = labels[pc.first[pi]];
        if (pc.area[pi] < P.minPiece && !(rePx && rePx[pc.first[pi]])) {
            var pb = pbox.subarray(4 * pi, 4 * pi + 4);
            for (var py = pb[1]; py <= pb[3]; py++) for (var px = pb[0], pq = py * w + pb[0]; px <= pb[2]; px++, pq++) if (pc.lab[pq] === pi) labels[pq] = 0;
            continue;
        }
        areas[v2] += pc.area[pi];
        contours[v2].push(traceBoundary(pc.lab, w, h, pc.first[pi], pi));
    }

    // animal-sized blobs nobody was given (an animal with no pose here)
    var unassigned = [];
    var minUn = model ? Math.max(P.minArea, model.median / 2) : P.minArea;
    for (var ub = 1; ub <= nb; ub++) {
        var info = blobInfo[ub - 1];
        if (info.kind === 'unassigned' && info.area >= minUn) unassigned.push(traceBoundary(blob, w, h, firstPixel(blob, w, seg.box, ub), ub));
    }

    var animalsOut = [];
    for (var ai = 0; ai < A.length; ai++) {
        var kinds = [];
        for (var bi = 0; bi < blobInfo.length; bi++) if (blobInfo[bi].animals.indexOf(ai) >= 0) kinds.push(blobInfo[bi].kind);
        animalsOut.push({ area: areas[ai + 1], blobs: kinds, tail: traced[ai + 1], reattached: reattached[ai + 1], posed: (A[ai].body.length >> 1) });
    }
    contours.shift();
    return { labels: labels, blobs: blobInfo, animals: animalsOut, contours: contours, unassigned: unassigned };
}

// Raster-first pixel of label `v` inside its box.
function firstPixel(lab, w, box, v) {
    var o = 4 * v;
    for (var y = box[o + 1]; y <= box[o + 3]; y++) for (var x = box[o], p = y * w + box[o]; x <= box[o + 2]; x++, p++) if (lab[p] === v) return p;
    return -1;
}

// Squared distance from blob b to an animal's nearest body keypoint, early-out above `cap`.
function blobDist2(a, blob, w, h, b, box, cap) {
    var pts = a.body;
    if (!pts.length) return Infinity;
    var best = Infinity;
    for (var i = 0; i + 1 < pts.length; i += 2) {
        var px = pts[i], py = pts[i + 1];
        // box test first
        var dx = px < box[0] ? box[0] - px : (px > box[2] ? px - box[2] : 0);
        var dy = py < box[1] ? box[1] - py : (py > box[3] ? py - box[3] : 0);
        if (dx * dx + dy * dy > Math.min(cap, best)) continue;
        var r = Math.ceil(Math.sqrt(Math.min(cap, best)));
        var x0 = Math.max(box[0], Math.floor(px - r)), x1 = Math.min(box[2], Math.ceil(px + r));
        var y0 = Math.max(box[1], Math.floor(py - r)), y1 = Math.min(box[3], Math.ceil(py + r));
        for (var y = y0; y <= y1; y++) {
            for (var x = x0, p = y * w + x0; x <= x1; x++, p++) {
                if (blob[p] !== b) continue;
                var ex = x - px, ey = y - py, d = ex * ex + ey * ey;
                if (d < best) best = d;
            }
        }
    }
    return best;
}

function nearBlob(a, blob, w, h, b, box, cap) {
    return blobDist2(a, blob, w, h, b, box, cap) <= cap;
}

// Body cores: each animal's mask eroded by `r` px, as a label map.
function cores(labels, w, h, nA, r) {
    var N = w * h;
    var core = new Uint8Array(N);
    if (!(r > 0)) { core.set(labels); return core; }
    var bx = boxes(labels, w, h, nA);
    var el = ellipseElement(2 * r + 1);
    for (var v = 1; v <= nA; v++) {
        var o = 4 * v;
        if (bx[o + 2] < 0) continue;
        var x0 = Math.max(0, bx[o] - r - 1), y0 = Math.max(0, bx[o + 1] - r - 1);
        var x1 = Math.min(w - 1, bx[o + 2] + r + 1), y1 = Math.min(h - 1, bx[o + 3] + r + 1);
        var sw = x1 - x0 + 1, sh = y1 - y0 + 1;
        var sub = new Uint8Array(sw * sh);
        for (var y = y0; y <= y1; y++) for (var x = x0; x <= x1; x++) sub[(y - y0) * sw + (x - x0)] = labels[y * w + x] === v ? 1 : 0;
        // pixels outside the image never erode (OpenCV), but inside the box an edge does
        var er = morph(sub, sw, sh, el, true);
        for (var yy = 0; yy < sh; yy++) for (var xx = 0; xx < sw; xx++) if (er[yy * sw + xx] && sub[yy * sw + xx]) core[(yy + y0) * w + (xx + x0)] = v;
    }
    return core;
}

// The one animal label within `R` px of component q (0 when none or several).
function neighbourLabel(lab, labels, w, h, q, box, R) {
    var who = 0;
    var x0 = Math.max(0, box[0] - R), y0 = Math.max(0, box[1] - R);
    var x1 = Math.min(w - 1, box[2] + R), y1 = Math.min(h - 1, box[3] + R);
    var R2 = R * R;
    // pixels of q, then a window around each: components are small (< minArea)
    for (var y = box[1]; y <= box[3]; y++) {
        for (var x = box[0], p = y * w + box[0]; x <= box[2]; x++, p++) {
            if (lab[p] !== q) continue;
            var wy0 = Math.max(y0, y - R), wy1 = Math.min(y1, y + R), wx0 = Math.max(x0, x - R), wx1 = Math.min(x1, x + R);
            for (var yy = wy0; yy <= wy1; yy++) {
                var dy = yy - y;
                for (var xx = wx0, pp = yy * w + wx0; xx <= wx1; xx++, pp++) {
                    var v = labels[pp];
                    if (!v || v === who) continue;
                    var dx = xx - x;
                    if (dx * dx + dy * dy > R2) continue;
                    if (who && v !== who) return 0;
                    who = v;
                }
            }
        }
    }
    return who;
}

// 8-neighbour offsets, clockwise in image coordinates from west.
var DX = [-1, -1, 0, 1, 1, 1, 0, -1];
var DY = [0, -1, -1, -1, 0, 1, 1, 1];

/**
 * Outer boundary of the 8-connected piece of `lab` with value `v` that holds
 * pixel `start` (its raster-first pixel), by Moore-neighbour tracing; it stops
 * when the start pixel would step to the same second pixel again (which also
 * ends one-pixel-wide pieces, where Jacob's rule can loop).
 * -> Float32Array [x0,y0,x1,y1,...] of pixel centres.
 */
export function traceBoundary(lab, w, h, start, v) {
    if (start < 0) return new Float32Array(0);
    var sx = start % w, sy = (start / w) | 0;
    var out = [sx + 0.5, sy + 0.5];
    // the raster-first pixel's west neighbour is outside: backtrack = west (dir 0)
    var cx = sx, cy = sy, back = 0;
    var fx = -1, fy = -1;                          // the second pixel
    var guard = 0, cap = 8 * w * h + 16;
    for (;;) {
        var found = -1;
        for (var k = 1; k <= 8; k++) {
            var d = (back + k) & 7;
            var nx = cx + DX[d], ny = cy + DY[d];
            if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
            if (lab[ny * w + nx] === v) { found = d; break; }
        }
        if (found < 0) break;                       // a single pixel
        var tx = cx + DX[found], ty = cy + DY[found];
        if (cx === sx && cy === sy) {
            if (fx < 0) { fx = tx; fy = ty; }
            else if (tx === fx && ty === fy) { out.length -= 2; break; }   // drop the repeated start
        }
        // new backtrack: the neighbour checked just before `found`, seen from the new pixel
        var pd = (found + 7) & 7;
        var bx = cx + DX[pd], by = cy + DY[pd];
        cx = tx; cy = ty;
        back = dirOf(bx - cx, by - cy);
        out.push(cx + 0.5, cy + 0.5);
        if (++guard > cap) break;
    }
    return Float32Array.from(out);
}

function dirOf(dx, dy) {
    for (var d = 0; d < 8; d++) if (DX[d] === dx && DY[d] === dy) return d;
    return 0;
}

/**
 * Point-in-polygon test for hit-testing an outline (even-odd rule).
 * @param {Float32Array} poly [x0,y0,...] @returns {boolean}
 */
export function pointInPolygon(poly, x, y) {
    var inside = false;
    for (var i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) {
        var xi = poly[i], yi = poly[i + 1], xj = poly[j], yj = poly[j + 1];
        if ((yi > y) !== (yj > y) && x < ((xj - xi) * (y - yi)) / (yj - yi) + xi) inside = !inside;
    }
    return inside;
}

/**
 * Which of a skeleton's nodes are the tail, and the tail polyline's node order:
 * nodes named like /tail/i, ordered along the skeleton's edges from the body
 * node they hang from (e.g. TTI → Tail_0 → … → TailTip). -> { tail: number[]
 * (node indices, the body node first when there is one), isTail: boolean[] }.
 */
export function tailChain(nodeNames, edges) {
    var n = nodeNames.length;
    var isTail = nodeNames.map(function (s) { return /tail/i.test(String(s || '')); });
    var tailIdx = [];
    for (var i = 0; i < n; i++) if (isTail[i]) tailIdx.push(i);
    if (!tailIdx.length) return { tail: [], isTail: isTail };
    var adj = [];
    for (var a = 0; a < n; a++) adj.push([]);
    (edges || []).forEach(function (e) {
        var u = e[0], v = e[1];
        if (u >= 0 && v >= 0 && u < n && v < n) { adj[u].push(v); adj[v].push(u); }
    });
    // start: a tail node touching a body node
    var base = -1, start = -1;
    for (var t = 0; t < tailIdx.length && start < 0; t++) {
        var nb = adj[tailIdx[t]];
        for (var j = 0; j < nb.length; j++) if (!isTail[nb[j]]) { start = tailIdx[t]; base = nb[j]; break; }
    }
    if (start < 0) return { tail: tailIdx.slice(), isTail: isTail };   // no edges: skeleton order
    var order = [start], seen = new Uint8Array(n);
    seen[start] = 1;
    var cur = start;
    for (;;) {
        var nxt = -1;
        for (var k = 0; k < adj[cur].length; k++) { var c = adj[cur][k]; if (isTail[c] && !seen[c]) { nxt = c; break; } }
        if (nxt < 0) break;
        seen[nxt] = 1; order.push(nxt); cur = nxt;
    }
    // tail nodes off the chain follow in skeleton order
    for (var r = 0; r < tailIdx.length; r++) if (!seen[tailIdx[r]]) order.push(tailIdx[r]);
    return { tail: [base].concat(order), isTail: isTail };
}

/**
 * An animal's pose in a camera for `computeOutlines`, from an instance-like
 * object (`numNodes`, `hasPoint(k)`, `getX(k)`, `getY(k)`) and the skeleton:
 * body keypoints, body edges, and the tail polyline (tail nodes in chain order,
 * from the body node they hang from; missing nodes skipped).
 */
export function animalFromInstance(inst, edges, chain) {
    var n = inst ? inst.numNodes : 0;
    var body = [], segments = [], tail = [];
    var has = function (k) { return k >= 0 && k < n && inst.hasPoint(k) && isFinite(inst.getX(k)) && isFinite(inst.getY(k)); };
    for (var k = 0; k < n; k++) if (!chain.isTail[k] && has(k)) body.push(inst.getX(k), inst.getY(k));
    (edges || []).forEach(function (e) {
        var u = e[0], v = e[1];
        if (chain.isTail[u] || chain.isTail[v] || !has(u) || !has(v)) return;
        segments.push(inst.getX(u), inst.getY(u), inst.getX(v), inst.getY(v));
    });
    chain.tail.forEach(function (k) { if (has(k)) tail.push(inst.getX(k), inst.getY(k)); });
    return { body: body, segments: segments, tail: tail.length >= 4 ? tail : null };
}

/**
 * Contours of a label image (0 = none, k = animal k, k <= n): per animal its
 * pieces' outer boundaries, as `computeOutlines` returns them. For a label
 * image painted by hand (pose/outline-edits.js). -> [[Float32Array]] (n lists)
 */
export function labelImageContours(labels, w, h, n) {
    var out = [];
    for (var k = 0; k < n; k++) out.push([]);
    var pc = components(labels, w, h, true);
    for (var pi = 1; pi <= pc.n; pi++) {
        var v = labels[pc.first[pi]];
        if (v >= 1 && v <= n) out[v - 1].push(traceBoundary(pc.lab, w, h, pc.first[pi], pi));
    }
    return out;
}
