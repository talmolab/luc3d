// ui/threshold-examples-panel.js — the reprojection error threshold card's right
// half: what the value being tried does to this session's own nodes.
//
// The card's last section, below its controls. Up to four small tiles and
// one large one, all at one scale so errors compare by eye: a crop of a camera's
// video around the node's prediction, the animal's skeleton as Predictions are
// drawn in the views (`drawSkeleton`, with the Visibility panel's style), the node's
// prediction (white dot, orange once outside the threshold and no longer used), the
// reprojection after the rule has run (blue ring), the
// reprojection error (red line), the threshold (dashed green ring) and, where a
// camera was dropped, the first solve's reprojection (grey ring). The tiles are the
// cameras with the largest errors (`pickShownCameras`), and a line names the rest.
// Clicking a tile enlarges it; the pick holds while that camera has a tile. Otherwise
// the one with the largest error is enlarged. Beside the large tile, the frame's
// animals in the app's own 3D viewer from the same solve (ui/threshold-examples-3d.js),
// which can be dragged to turn.
//
// The arrows walk a fixed set of examples, spread from small errors to large
// (`pickRepresentativeExamples`). The slider and the DLT / Refined switch never
// change what is on screen: same node, same cameras, same crops. Only the marks and
// the numbers move, so the effect of a value can be seen on one example. To hold
// that, the set, the tiles and the crops all come from a DLT solve with the threshold
// off (`baselineFor`), whatever is being tried. Everything here is read-only: the
// demo never changes a setting or the session.
//
// The session is solved once, a slice per task, when the panel is first shown
// (`start`), and once more for Refined's count if it is tried. Only the example on
// screen decodes video. A decoder's frame may be closed by the next decode, so each
// crop is copied at once, and only the newest request per camera runs.
//
// Depends on: pose/threshold-examples.js, ui/threshold-examples-3d.js,
// ui/app-state.js (state), ui/frame-readout.js (formatFrameNumber), ui/overlays.js
// (the Predictions drawing and colours), ui/rendering.js (getVisibilitySettings).

import {
    calibratedCameras,
    firstOverThreshold,
    frameFromPoints,
    pickRepresentativeExamples,
    scanThresholdExamples,
    solveExample,
    lineOfSight,
    pickShownCameras,
    solveExample3d,
    solveFrame3d,
    EXAMPLE_MIN_CAMERAS,
} from '../pose/threshold-examples.js?v=309b7bef753c';
import { state } from './app-state.js?v=309b7bef753c';
import { formatFrameNumber } from './frame-readout.js?v=309b7bef753c';
import { desaturateColor, drawSkeleton, getGroupColor, symmetryEdgesFor } from './overlays.js?v=309b7bef753c';
import { getVisibilitySettings } from './rendering.js?v=309b7bef753c';
import { build3dView } from './threshold-examples-3d.js?v=309b7bef753c';

/** Small tiles shown, at most. */
export const SMALL_TILES = 4;
/** Canvas sides, in device pixels. Marks keep their pixel size, so they read the same in both. */
const TILE_PX = 240, LARGE_PX = 640;
/** A crop's smallest side, in video pixels: a small error still shows its surroundings. */
const MIN_CROP = 80;
const DECODE_DELAY_MS = 90;
/** A set opens on the first example this bad, so trying the recommended range shows a drop. */
const START_ERROR_PX = 50;

const PREDICTION = '#fff', PREDICTION_UNUSED = '#f39c12', REPROJECTION = '#7c93ff', FIRST_SOLVE = '#b5b5b5', ERROR = '#e74c3c', RING = '#2ecc71';

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text != null) e.textContent = text;
    return e;
}

function count(n) { return Number(n).toLocaleString('en-US'); }
function px(e) { return e.toFixed(1) + ' px'; }
function thresholdText(t) { return count(t) + ' px'; }

/** "camA", "camA and camB", "camA, camB and camC", in the order they were dropped. */
function nameList(names) {
    if (names.length < 2) return names.join('');
    return names.slice(0, -1).join(', ') + ' and ' + names[names.length - 1];
}

/**
 * The sentence under the tiles.
 * @param {Object} solved  `solveExample`'s result
 * @param {number} threshold
 */
export function exampleResultText(solved, threshold) {
    const first = solved.passes[0], last = solved.passes[solved.passes.length - 1];
    const largest = function (pass) {
        return pass.cameras.reduce(function (m, c) { return pass.errors[c] != null && pass.errors[c] > m ? pass.errors[c] : m; }, 0);
    };
    if (!(threshold > 0)) return 'With the threshold off, every camera counts. The largest error here is ' + px(largest(first)) + '.';
    const at = 'At ' + thresholdText(threshold) + ', ';
    if (solved.lost) {
        const dropped = solved.dropped.length ? nameList(solved.dropped) + (solved.dropped.length > 1 ? ' are' : ' is') + ' dropped, but the ' : 'the ';
        return at + dropped + 'last cameras still miss, so this node gets no 3D point in this frame.';
    }
    if (!solved.dropped.length) return at + 'every camera is within the threshold, so nothing is dropped. The largest error is ' + px(largest(first)) + '.';
    return at + nameList(solved.dropped) + (solved.dropped.length > 1 ? ' are' : ' is') + ' dropped and the node is solved again from '
        + count(last.cameras.length) + ' cameras. The largest error goes from ' + px(largest(first)) + ' to ' + px(largest(last)) + '.';
}

/** One camera's text under its tile, and its state. */
export function tileVerdict(solved, name, threshold, included) {
    const first = solved.passes[0], last = solved.passes[solved.passes.length - 1];
    const dropped = solved.dropped.indexOf(name) >= 0;
    if (included && included.indexOf(name) < 0) return { state: 'out', text: 'not in tracking' };
    if (!solved.predictions.get(name)) return { state: 'out', text: 'no prediction' };
    const a = first.errors[name], b = last.errors[name];
    if (dropped) return { state: 'drop', text: px(a) + ' · dropped' };
    if (solved.lost && isFinite(b) && b > threshold) return { state: 'over', text: px(b) + ' · over' };
    if (b == null) return { state: 'out', text: 'no 3D' };
    const moved = solved.dropped.length > 0 && a != null;
    return { state: threshold > 0 ? 'in' : 'off', text: moved ? a.toFixed(1) + ' → ' + px(b) : px(b) };
}

/** The crop's side for an example: every tile at one scale, so errors compare by eye. */
export function cropSide(solved, names) {
    let worst = 0;
    solved.passes.forEach(function (pass) {
        names.forEach(function (name) {
            const e = pass.errors[name];
            if (e != null && isFinite(e) && e > worst) worst = e;
        });
    });
    return Math.max(MIN_CROP, Math.ceil(worst * 2.6));
}

/** The live views' Predictions style for an animal of colour `base` (`drawFrameOverlays`' section 3), at `sizeScale`. */
function predictionStyle(base, sizeScale, skeleton) {
    let vis = null;
    try { vis = getVisibilitySettings(); } catch (e) { /* controls not on the page */ }
    const o = (vis && vis.predictedOpts) || {};
    return {
        symmetryEdges: vis && vis.showSymmetryEdges && skeleton ? symmetryEdgesFor(skeleton) : null,
        symmetryLineWidth: ((vis && vis.symmetryEdgeWeight) || 1) * sizeScale,
        color: desaturateColor(base, 0.2),
        edgeColor: desaturateColor(base, 0.4),
        alpha: 0.85,
        nodeSize: (o.nodeSize || 6) * sizeScale,
        lineWidth: (o.lineWidth || 2) * sizeScale,
        lineStyle: o.postLineStyle || 'solid',
        nodeShape: o.nodeStyle || 'x',
        showLabels: false,
    };
}

function drawMarks(ctx, size, solved, name, box, threshold, skeleton, style) {
    const scale = size / box.side;
    const X = function (p) { return (p[0] - box.x) * scale; };
    const Y = function (p) { return (p[1] - box.y) * scale; };
    const pts = solved.skeletons.get(name);
    if (pts && skeleton) {
        drawSkeleton(ctx, {
            numNodes: pts.length,
            nulledNodes: solved.nulled.get(name),
            hasPoint: function (i) { return !!pts[i]; },
            getX: function (i) { return X(pts[i]); },
            getY: function (i) { return Y(pts[i]); },
        }, skeleton, style);
    }
    const pred = solved.predictions.get(name);
    const first = solved.passes[0].reprojections[name];
    const last = solved.passes[solved.passes.length - 1].reprojections[name];
    const ring = function (p, color, r, width) {
        ctx.strokeStyle = color; ctx.lineWidth = width;
        ctx.beginPath(); ctx.arc(X(p), Y(p), r, 0, 2 * Math.PI); ctx.stroke();
    };
    if (pred && threshold > 0) {
        ctx.setLineDash([7, 5]);
        ring(pred, RING, threshold * scale, 2);
        ctx.setLineDash([]);
    }
    if (first && solved.dropped.length && !solved.lost) ring(first, FIRST_SOLVE, 7, 2);
    const drawn = solved.lost ? first : last;
    if (pred && drawn) {
        ctx.strokeStyle = ERROR; ctx.lineWidth = 3; ctx.lineCap = 'round';
        ctx.beginPath(); ctx.moveTo(X(pred), Y(pred)); ctx.lineTo(X(drawn), Y(drawn)); ctx.stroke();
    }
    if (drawn) ring(drawn, REPROJECTION, 8, 3);
    if (pred) {
        // Orange once it falls outside the threshold: no solve left uses it.
        const lastErr = solved.passes[solved.passes.length - 1].errors[name];
        const unused = solved.dropped.indexOf(name) >= 0 || (solved.lost && lastErr != null && lastErr > threshold);
        ctx.fillStyle = unused ? PREDICTION_UNUSED : PREDICTION; ctx.strokeStyle = 'rgba(0, 0, 0, 0.7)'; ctx.lineWidth = 1.5;
        ctx.beginPath(); ctx.arc(X(pred), Y(pred), 6, 0, 2 * Math.PI); ctx.fill(); ctx.stroke();
    }
}

/**
 * @param {Object} opts
 * @param {?Object} opts.session
 * @param {function(string): boolean} [opts.isCameraIncluded]  the working Camera Views value
 * @returns {{el: HTMLElement, start: function(): void, update: function({threshold: number, method: string}): void,
 *   step: function(number): void, invalidate: function(): void, dispose: function(): void}}
 */
export function buildThresholdExamples(opts) {
    const session = opts.session;
    const root = el('div', 'thr-ex');
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-label', 'Examples from this session');

    const head = el('div', 'thr-ex-head');
    const titles = el('div', 'thr-ex-titles');
    titles.appendChild(el('div', 'thr-ex-title', 'In this session'));
    head.appendChild(titles);
    const nav = el('div', 'thr-ex-nav');
    const prev = el('button', 'thr-ex-arrow thr-ex-prev', '‹');
    const pos = el('span', 'thr-ex-pos');
    const next = el('button', 'thr-ex-arrow thr-ex-next', '›');
    prev.type = next.type = 'button';
    prev.setAttribute('aria-label', 'Smaller error');
    next.setAttribute('aria-label', 'Larger error');
    prev.title = 'Smaller error';
    next.title = 'Larger error';
    nav.append(prev, pos, next);
    head.appendChild(nav);
    root.appendChild(head);

    const where = el('div', 'thr-ex-where');
    titles.appendChild(where);
    const message = el('p', 'thr-ex-message');
    root.appendChild(message);
    const body = el('div', 'thr-ex-body');
    root.appendChild(body);
    const grid = el('div', 'thr-ex-grid');
    body.appendChild(grid);
    const large = el('figure', 'thr-ex-large');
    const largeCanvas = el('canvas');
    largeCanvas.width = largeCanvas.height = LARGE_PX;
    const largeCaption = el('figcaption', 'thr-ex-large-caption');
    const largeName = el('span', 'thr-ex-cam');
    const largeErr = el('span', 'thr-ex-err');
    largeCaption.append(largeName, largeErr);
    large.append(largeCanvas, largeCaption);
    body.appendChild(large);
    const solid = el('figure', 'thr-ex-3d');
    const solidHost = el('div', 'thr-ex-3d-host');
    const solidCaption = el('figcaption', 'thr-ex-large-caption');
    const solidName = el('span', 'thr-ex-cam', '3D, drag to turn');
    const solidNote = el('span', 'thr-ex-err');
    solidCaption.append(solidName, solidNote);
    solid.append(solidHost, solidCaption);
    body.appendChild(solid);
    const others = el('p', 'thr-ex-others');
    root.appendChild(others);
    const result = el('p', 'thr-ex-result');
    root.appendChild(result);
    const summary = el('p', 'thr-ex-summary');
    root.appendChild(summary);
    const legend = el('div', 'thr-ex-legend');
    legend.innerHTML = '<span><i class="thr-key-pred"></i>prediction</span><span><i class="thr-key-pred-out"></i>prediction no longer used</span>'
        + '<span><i class="thr-key-rep"></i>reprojection</span>'
        + '<span><i class="thr-key-first"></i>first solve</span><span><i class="thr-key-err"></i>reprojection error</span>'
        + '<span><i class="thr-key-ring"></i>threshold</span><span><i class="thr-key-proj"></i>projection</span>'
        + '<span><i class="thr-key-sight"></i><i class="thr-key-sight thr-key-sight-drop"></i>line of sight: orange if dropped</span>';
    root.appendChild(legend);

    const cameras = calibratedCameras(session);
    const names = cameras.map(function (c) { return c.name; });
    const tiles = names.slice(0, SMALL_TILES).map(function () {
        const tile = el('button', 'thr-ex-tile');
        tile.type = 'button';
        const canvas = el('canvas');
        canvas.width = canvas.height = TILE_PX;
        tile.append(canvas, el('span', 'thr-ex-cam'), el('span', 'thr-ex-err'));
        grid.appendChild(tile);
        tile.addEventListener('click', function () {
            if (!tile.dataset.camera) return;
            picked = tile.dataset.camera;
            if (view) { view.selected = picked; paintSelection(); }
        });
        return { tile: tile, canvas: canvas };
    });

    let started = false, disposed = false;
    let method = 'dlt', threshold = 0, index = -1;
    let scanToken = 0, showToken = 0, decodeTimer = 0;
    let scans = {};
    let exampleSet = null;  // the fixed examples the arrows walk
    const baselines = new Map();    // example -> what holds still for it
    let picked = null;      // the camera the user enlarged
    let view = null;        // what is on screen: { solved, boxes, verdicts, colors, shown, selected, scene3d }
    let view3d = null, view3dFailed = false, framedExample = null;
    const crops = new Map();        // camera name -> { key, crop }
    const decodeChains = new Map();

    function included() {
        return names.filter(function (n) { return !opts.isCameraIncluded || opts.isCameraIncluded(n); });
    }

    function setMessage(text) {
        message.textContent = text;
        message.hidden = !text;
        const showing = !text;
        where.hidden = body.hidden = others.hidden = result.hidden = summary.hidden = legend.hidden = !showing;
        pos.textContent = '';
        prev.disabled = next.disabled = true;
    }

    function nodeName(node) {
        const nodes = session.skeleton && session.skeleton.nodes;
        return nodes && nodes[node] != null ? (nodes[node].name || String(nodes[node])) : 'node ' + node;
    }

    function animalName(id) {
        const known = session.identities && session.identities[id];
        if (known && known.name) return known.name;
        return id != null && id >= 0 ? 'animal ' + id : 'an unnamed animal';
    }

    function viewFor(name) {
        return (state.views || []).filter(function (v) {
            return v && v.name === name && v.decoder && typeof v.decoder.getFrame === 'function';
        })[0];
    }

    function paint(canvas, size, name) {
        const ctx = canvas.getContext('2d');
        const entry = crops.get(name);
        ctx.fillStyle = '#111';
        ctx.fillRect(0, 0, size, size);
        if (entry && entry.crop) ctx.drawImage(entry.crop, 0, 0, size, size);
        // Sizes are the views' on-screen ones, less in a small tile.
        const shown = canvas.clientWidth > 0 ? size / canvas.clientWidth : 2;
        const style = predictionStyle(view.colors.get(name), shown * (size === TILE_PX ? 0.6 : 1), session.skeleton);
        drawMarks(ctx, size, view.solved, name, view.boxes.get(name), threshold, session.skeleton, style);
    }

    // The viewer holds a WebGL context, so it waits until the panel is first shown.
    function ensure3dView() {
        if (view3d || view3dFailed || !session) return view3d;
        try {
            view3d = build3dView(solidHost, {
                session: session,
                getGroupColor: function (g) {
                    return getGroupColor(g.source || g, session, state.colorByIdentity, view ? view.frame : 0);
                },
            });
        } catch (err) {
            view3dFailed = true;
            console.warn('[threshold examples] 3D view unavailable:', err);
            solidHost.textContent = '3D view unavailable (WebGL required)';
        }
        return view3d;
    }

    function paint3d() {
        if (!view || !view.scene3d || !ensure3dView()) return;
        if (view.example !== framedExample && view.scene3d.frame) {
            framedExample = view.example;
            view3d.setFraming(view.scene3d.frame);
        }
        view3d.setScene(view.scene3d);
    }

    function paintLarge() {
        const name = view.selected, verdict = view.verdicts.get(name);
        large.dataset.camera = name;
        large.dataset.state = verdict.state;
        largeName.textContent = name;
        largeErr.textContent = verdict.text;
        paint(largeCanvas, LARGE_PX, name);
    }

    function paintSelection() {
        tiles.forEach(function (t) {
            t.tile.setAttribute('aria-pressed', t.tile.dataset.camera === view.selected ? 'true' : 'false');
        });
        paintLarge();
    }

    function paintCamera(name) {
        if (!view) return;
        tiles.forEach(function (t) { if (t.tile.dataset.camera === name) paint(t.canvas, TILE_PX, name); });
        if (view.selected === name) paintLarge();
    }

    // What holds still for an example while values are tried: from a DLT solve with the
    // threshold off, every tile's camera and crop, and the 3D view's framing.
    function baselineFor(example, use) {
        let base = baselines.get(example);
        if (base) return base;
        const solved = solveExample(session, example, { method: 'dlt', threshold: 0, included: use });
        if (!solved) return null;
        const side = cropSide(solved, use);
        const picks = pickShownCameras(solved, names, SMALL_TILES);
        const boxes = new Map(), colors = new Map(), rays = [];
        const group = (session.instanceGroups.get(example.frame) || [])[example.group];
        names.forEach(function (name) {
            let color = '#888888';
            try { color = getGroupColor(group, session, state.colorByIdentity, example.frame, name) || color; } catch (e) { /* the default */ }
            colors.set(name, color);
        });
        picks.shown.forEach(function (name) {
            // Centred on its own prediction or, without one, its reprojection.
            const centre = solved.predictions.get(name) || solved.passes[0].reprojections[name];
            boxes.set(name, centre
                ? { x: centre[0] - side / 2, y: centre[1] - side / 2, side: side, hasCentre: true }
                : { x: 0, y: 0, side: side, hasCentre: false });
        });
        cameras.forEach(function (cam) {
            const pred = solved.predictions.get(cam.name);
            const ray = pred && use.indexOf(cam.name) >= 0 ? lineOfSight(cam, pred) : null;
            if (ray) rays.push({ name: cam.name, origin: ray.origin, dir: ray.dir });
        });
        const off3d = solveExample3d(session, example, { method: 'dlt', threshold: 0, included: use });
        base = {
            picks: picks, boxes: boxes, colors: colors, rays: rays,
            frame: off3d ? frameFromPoints(off3d) : null,
        };
        baselines.set(example, base);
        return base;
    }

    // The 3D view at what is being tried, in the example's fixed framing.
    function scene3dFor(example, base, solved, use) {
        const groups = solveFrame3d(session, example.frame, { method: method, threshold: threshold, included: use });
        const mine = groups[example.group];
        const k = example.node;
        const pointOf = function (pts) {
            return pts && isFinite(pts[3 * k]) && isFinite(pts[3 * k + 1]) && isFinite(pts[3 * k + 2]) ? [pts[3 * k], pts[3 * k + 1], pts[3 * k + 2]] : null;
        };
        let first = null;
        if (solved.dropped.length || solved.lost) {
            first = pointOf(solveExample3d(session, example, { method: method, threshold: 0, included: use }));
        }
        return {
            frame: base.frame, groups: groups, point: pointOf(mine && mine.points3d), first: first,
            rays: base.rays.map(function (r) {
                return { origin: r.origin, dir: r.dir, dropped: solved.dropped.indexOf(r.name) >= 0 };
            }),
        };
    }

    function summaryText() {
        const scan = scans[method];
        if (!scan) return 'Counting for Refined…';
        const list = scan.examples;
        const about = ' Nodes from ' + count(scan.frames) + ' frames, seen by ' + EXAMPLE_MIN_CAMERAS + ' or more cameras.';
        if (!(threshold > 0)) return 'A sample of the ' + count(list.length) + ' nodes solved here, from small errors to large.' + about;
        const over = list.length - firstOverThreshold(list, threshold);
        return 'At ' + thresholdText(threshold) + ', ' + count(over) + ' of ' + count(list.length) + ' nodes solved here '
            + (over === 1 ? 'has' : 'have') + ' a camera dropped.' + about;
    }

    function show() {
        const token = ++showToken;
        clearTimeout(decodeTimer);
        if (!session || !exampleSet) return;
        if (!exampleSet.length) {
            setMessage('No node here is predicted by ' + EXAMPLE_MIN_CAMERAS + ' or more cameras in one group. '
                + 'Group the predictions across cameras (Track All) to see them here.');
            return;
        }
        const example = exampleSet[index];
        const use = included();
        const base = baselineFor(example, use);
        const solved = solveExample(session, example, { method: method, threshold: threshold, included: use });
        if (!base || !solved) return;
        setMessage('');
        pos.textContent = 'Example ' + count(index + 1) + ' of ' + count(exampleSet.length);
        prev.disabled = index <= 0;
        next.disabled = index >= exampleSet.length - 1;
        where.textContent = 'Frame ' + formatFrameNumber(example.frame + 1) + ' · ' + animalName(solved.identityId) + ' · ' + nodeName(example.node);
        result.textContent = exampleResultText(solved, threshold);
        summary.textContent = summaryText();

        const picks = base.picks, verdicts = new Map(), toDecode = [];
        names.forEach(function (name) { verdicts.set(name, tileVerdict(solved, name, threshold, use)); });
        picks.shown.forEach(function (name) {
            const box = base.boxes.get(name);
            const key = example.frame + '|' + box.x + '|' + box.y + '|' + box.side;
            if (!crops.has(name) || crops.get(name).key !== key) {
                crops.set(name, { key: key, crop: null });
                if (box.hasCentre) toDecode.push({ name: name, box: box, key: key });
            }
        });
        view = {
            solved: solved, boxes: base.boxes, verdicts: verdicts, shown: picks.shown, colors: base.colors,
            selected: picks.shown.indexOf(picked) >= 0 ? picked : picks.first,
            scene3d: scene3dFor(example, base, solved, use),
            example: example, frame: example.frame,
        };
        solidNote.textContent = solved.lost ? 'no 3D point here' : '';
        paint3d();
        tiles.forEach(function (t, i) {
            const name = picks.shown[i];
            t.tile.dataset.camera = name;
            t.tile.dataset.state = verdicts.get(name).state;
            t.tile.querySelector('.thr-ex-cam').textContent = name;
            t.tile.querySelector('.thr-ex-err').textContent = verdicts.get(name).text;
            paint(t.canvas, TILE_PX, name);
        });
        paintSelection();
        const rest = picks.others.map(function (n) { return n + ' ' + verdicts.get(n).text; }).join(', ');
        others.textContent = rest ? 'Not shown: ' + rest : '';
        others.title = rest;
        if (toDecode.length) decodeTimer = setTimeout(function () { decodeTiles(token, example.frame, toDecode); }, DECODE_DELAY_MS);
    }

    function decodeTiles(token, frame, items) {
        items.forEach(function (it) {
            const decoderView = viewFor(it.name);
            if (!decoderView) return;
            const chain = decodeChains.get(it.name) || Promise.resolve();
            decodeChains.set(it.name, chain.then(async function () {
                if (token !== showToken || disposed) return;
                let image = null;
                try { image = await decoderView.decoder.getFrame(frame); } catch (e) { image = null; }
                if (!image || token !== showToken || disposed) return;
                const crop = new OffscreenCanvas(LARGE_PX, LARGE_PX);
                try {
                    crop.getContext('2d').drawImage(image, it.box.x, it.box.y, it.box.side, it.box.side, 0, 0, LARGE_PX, LARGE_PX);
                } catch (e) { return; /* a closed frame draws nothing */ }
                const entry = crops.get(it.name);
                if (!entry || entry.key !== it.key) return;
                entry.crop = crop;
                paintCamera(it.name);
            }));
        });
    }

    // The fixed set comes from DLT's scan alone; another method's only counts nodes.
    async function ensureScan() {
        if (disposed || !started || !session) return;
        if (cameras.length < EXAMPLE_MIN_CAMERAS) {
            setMessage('This needs a calibration with ' + EXAMPLE_MIN_CAMERAS + ' or more cameras.');
            return;
        }
        const token = ++scanToken;
        const scanOne = function (m, onProgress) {
            return scanThresholdExamples(session, {
                method: m,
                included: included(),
                isCancelled: function () { return disposed || token !== scanToken; },
                onProgress: onProgress,
            });
        };
        if (!scans.dlt) {
            setMessage('Solving this session’s frames…');
            const scan = await scanOne('dlt', function (done, total) {
                if (token === scanToken) setMessage('Solving this session’s frames… ' + count(done) + ' of ' + count(total));
            });
            if (!scan || token !== scanToken) return;
            scans.dlt = scan;
            exampleSet = pickRepresentativeExamples(scan.examples);
            const at = exampleSet.findIndex(function (e) { return e.worst >= START_ERROR_PX; });
            index = at >= 0 ? at : exampleSet.length - 1;
            show();
        }
        if (!scans[method]) {
            const scanMethod = method;
            const scan = await scanOne(scanMethod);
            if (!scan || token !== scanToken) return;
            scans[scanMethod] = scan;
            summary.textContent = summaryText();
        }
    }

    function step(by) {
        if (!exampleSet || !exampleSet.length) return;
        const nextIndex = Math.max(0, Math.min(exampleSet.length - 1, index + by));
        if (nextIndex === index) return;
        index = nextIndex;
        show();
    }

    prev.addEventListener('click', function () { step(-1); });
    next.addEventListener('click', function () { step(1); });

    setMessage(session ? 'Solving this session’s frames…' : 'Load a session to see this on its own predictions and reprojections.');

    return {
        el: root,
        /** Solve the session: call when the panel is first on screen, so opening Settings costs nothing. */
        start: function () {
            if (started) return;
            started = true;
            ensureScan();
        },
        update: function (next) {
            const m = next.method === 'ba' ? 'ba' : 'dlt', t = next.threshold > 0 ? next.threshold : 0;
            const methodChanged = m !== method, thresholdChanged = t !== threshold;
            if (!methodChanged && !thresholdChanged) return;
            method = m; threshold = t;
            if (!started) return;
            show();
            if (methodChanged) ensureScan();
        },
        step: step,
        /** Whether the panel is on screen: the 3D viewer draws continuously while it is. */
        setActive: function (active) {
            if (view3d) view3d.setVisible(active);
        },
        /** The working Camera Views changed: what was solved no longer stands. */
        invalidate: function () {
            scans = {};
            exampleSet = null;
            baselines.clear();
            framedExample = null;
            scanToken++;
            crops.clear();
            ensureScan();
        },
        dispose: function () {
            disposed = true;
            clearTimeout(decodeTimer);
            if (view3d) { view3d.dispose(); view3d = null; }
        },
    };
}
