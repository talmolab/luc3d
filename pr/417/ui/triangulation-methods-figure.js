// ui/triangulation-methods-figure.js
// The Settings ▸ Default Triangulation choice: two cards, DLT and Refined, each
// a diagram of how that method works, and a third card on the reprojection error
// threshold. Clicking a method card picks the method; the caller
// (`ui/settings-modal.js`) wires that up through each card's `data-method`
// (`'dlt'` | `'ba'`). The cards are `role="radio"` in a `radiogroup`, so the
// caller also handles Enter/Space.
//
// Every sketch is the SAME scene from above: four cameras, one node. Each
// camera's 2D prediction (white) sits on its image plane, with the camera's line
// of sight through it (dashed, from the camera on, so it is clear whose it is:
// grey if the camera is a little off, orange if stray), the projection (the 3D
// answer: white ring, translucent blue, so the cross shows through it), the line
// from the camera to it, the reprojection, where it lands back in each camera (blue
// ring), and the reprojection error between the two (red). A legend at the
// bottom-left of each card names them, and bars at the bottom-right (`errorTotals`,
// one scale for every sketch) stack each camera's reprojection error above their
// sum. A dark red line, over every other line and under the markers, is the ground
// truth error: how far the projection is from the target, in 3D (the bar counts the
// part out of the page, which the top-down line cannot show). The target, a green
// cross, marks the true position. Cameras 0, 1 and 2 are 10-16 px off, as real
// predictions can be; camera 3 is a stray. DLT is pulled well away. Refined counts the
// stray less and lands closer, with the stray still counted (two marker diameters
// from the target); the threshold removes it, which brings the projection closer
// still, but set too low it also drops a camera that was only a little off.
//
// The answers are NOT hand-drawn. `FIGURE_SCENE` holds the layout and the 2D
// points; its `solves` are the real `triangulateAndReproject`'s output for that
// layout, for every set of cameras the figure reaches (image x and pixel error
// per camera, 3D answer in sketch units at 2 px per unit). The test re-solves the
// scene and fails if they drift; change the layout and it prints the new numbers.
//
// The threshold card (Tracking Wizard ▸ "Reprojection error threshold (px)",
// `reprojErrorThreshold`) has up to three more sketches of the scene: the first
// solve, then the solve again after each dropped camera. On each image plane
// still checked, a band `threshold` px either side of the detection is where the
// answer may land; it is green, grey or orange as that camera is within, over, or
// over and dropped. `thresholdPasses` decides what is dropped: it restates the
// rule in `triangulateAndReproject`, and the test holds the two together.
//
// **Trying a value never changes a setting** (`ui/figure-try-controls.js`). The
// card's slider, text box and DLT/Refined switch only redraw the sketch. Only its
// Use and Turn off buttons change the threshold (`onThreshold`, which sets the
// panel's working value; Apply saves it), and "Your setting" says what the setting
// is. `update({ method, threshold, saved })` follows the picked method and the
// setting; the sketch jumps to a value set elsewhere, and opens at the setting. The
// slider's left end is off: every camera counts, no band is drawn and nothing is
// dropped.
//
// In a re-solve, each camera dropped so far is drawn faded (`.tm-dropped`).
//
// The card never changes size: every step keeps its place (a faded scene when not
// reached), and each line whose wording changes is a `stack`.
//
// Colours come from the theme variables in `styles.css` (`.tri-methods`).
//
// Depends on: ui/figure-try-controls.js.

import { tryStrip, tryControl, wireTryControl, settingRow, wireSettingRow } from './figure-try-controls.js?v=a3d823fd6cb7';

var PX_PER_UNIT = 3;             // image pixels per sketch unit on an image plane
var PLANE_HALF = 29;             // image plane half-width, sketch units

/**
 * The scene and the real solvers' answers for it (see the header). Cameras:
 * `at` and the viewing direction `rot` (degrees) from above, `plane` its focal
 * distance in sketch units. `detections`: each camera's 2D point in image pixels
 * (x along the plane, y out of the top-down view). `solves[method][cameras]`:
 * `point` in sketch units, `z` the part of it out of the page, `x` image x of the landing and `errors` in px per camera.
 */
export var FIGURE_SCENE = {
    cameras: [
        { name: 'Camera 0', at: [24, 22], rot: 32.8, plane: 44 },
        { name: 'Camera 1', at: [14, 132], rot: -13.7, plane: 44 },
        { name: 'Camera 2', at: [145, 232], rot: -90, plane: 44 },
        { name: 'Camera 3', at: [278, 112], rot: -174.8, plane: 44 },
    ],
    detections: [[-15.98, 2], [13.94, 3], [14, -3], [-84, 0]],
    truth: [145, 100],
    solves: {
        dlt: {
            '0,1,2,3': { point: [191.5, 123.9], z: 1.16, x: [-3.45, 25.86, 56.83, -30.54], errors: [12.6, 12.1, 43.1, 53.5] },
            '0,1,2': { point: [165.2, 101.6], z: 1, x: [-7.81, 5.37, 20.43, 0.16], errors: [8.3, 8.8, 7.6, 84.2] },
            '0,2': { point: [160.3, 88.2], z: -0.5, x: [-15.97, -6.88, 14, 14.44], errors: [2.4, 21.1, 2.5, 98.4] },
        },
        ba: {
            '0,1,2,3': { point: [157.7, 115.3], z: -1.97, x: [4.89, 16.4, 14.35, -15.71], errors: [21.2, 5.4, 0.8, 68.3] },
            '0,1,2': { point: [158.8, 103.9], z: -2.56, x: [-3.53, 6.26, 14.26, -3.01], errors: [13.1, 9.3, 0.4, 81] },
            '1,2': { point: [157.6, 112.7], z: -2.62, x: [3.17, 14.03, 14, -12.84], errors: [19.6, 5.4, 0.1, 71.2] },
        },
    },
};
var CAMS = FIGURE_SCENE.cameras;
var ALL = [0, 1, 2, 3];
// Where the stray's label goes, beside its own line of sight: `y` is the first
// line of the label, or with `up` the last.
var STRAY_LABELS = { 3: { x: 240, y: 148 } };

function fmt(v) { return Math.round(v * 10) / 10; }

// Each camera's viewing direction and image-right direction, from above.
var FORWARD = CAMS.map(function (c) { var a = c.rot * Math.PI / 180; return [Math.cos(a), Math.sin(a)]; });
var RIGHT = FORWARD.map(function (f) { return [-f[1], f[0]]; });

/** The point `imageX` px along camera `i`'s image plane, in sketch units. */
function onPlane(i, imageX) {
    var c = CAMS[i], f = FORWARD[i], r = RIGHT[i], u = imageX / PX_PER_UNIT;
    return [c.at[0] + f[0] * c.plane + r[0] * u, c.at[1] + f[1] * c.plane + r[1] * u];
}
var DETECTIONS = FIGURE_SCENE.detections.map(function (d, i) { return onPlane(i, d[0]); });

function line(a, b, cls) {
    return '<line x1="' + fmt(a[0]) + '" y1="' + fmt(a[1]) + '" x2="' + fmt(b[0]) + '" y2="' + fmt(b[1]) + '" class="' + cls + '"/>';
}

// Each camera's number, on its body (centred 6 units behind its origin), so the
// totals' rows can be matched to it.
var CAMERA_NUMBERS = CAMS.map(function (c, i) {
    return '<text x="' + fmt(c.at[0] - FORWARD[i][0] * 6) + '" y="' + fmt(c.at[1] - FORWARD[i][1] * 6 + 3.2)
        + '" text-anchor="middle" class="tm-camera-number">' + i + '</text>';
});

// Shared by every sketch: each camera's line of sight through its detection and
// on, then the cameras.
var RAY_HEAD_LEN = 5, RAY_HEAD_HALF = 2.2;
var RAY_LIST = DETECTIONS.map(function (d, i) {
    var at = CAMS[i].at, dx = d[0] - at[0], dy = d[1] - at[1], len = Math.hypot(dx, dy);
    // Only as far as just past the target (the stray's, which misses it, as far as the
    // target), to keep the middle of the sketch clear.
    var reach = Math.hypot(FIGURE_SCENE.truth[0] - at[0], FIGURE_SCENE.truth[1] - at[1]) + (STRAY_LABELS[i] ? 0 : 40);
    // An arrowhead at the tip gives the line its direction, away from the camera.
    var ux = dx / len, uy = dy / len, tip = [at[0] + ux * reach, at[1] + uy * reach];
    var base = [tip[0] - ux * RAY_HEAD_LEN, tip[1] - uy * RAY_HEAD_LEN];
    var stray = STRAY_LABELS[i] ? ' tm-ray-stray' : '';
    return line(at, base, 'tm-ray' + stray)
        + '<polygon points="' + fmt(tip[0]) + ',' + fmt(tip[1]) + ' '
        + fmt(base[0] - uy * RAY_HEAD_HALF) + ',' + fmt(base[1] + ux * RAY_HEAD_HALF) + ' '
        + fmt(base[0] + uy * RAY_HEAD_HALF) + ',' + fmt(base[1] - ux * RAY_HEAD_HALF) + '" class="tm-ray-head' + stray + '"/>';
});
var RAYS = RAY_LIST.join('');
var CAMERA_BODY = '<rect x="-13" y="-7" width="14" height="14" rx="2" class="tm-cam"/>'
    + '<path d="M1 -4 L7 -7 L7 7 L1 4 Z" class="tm-cam"/>';
var CAMERA_LIST = CAMS.map(function (c, i) {
    return line(onPlane(i, -PLANE_HALF * PX_PER_UNIT), onPlane(i, PLANE_HALF * PX_PER_UNIT), 'tm-plane')
        + '<g transform="translate(' + c.at[0] + ' ' + c.at[1] + ') rotate(' + c.rot + ')">' + CAMERA_BODY + '</g>' + CAMERA_NUMBERS[i];
});
var CAMERA_MARKS = CAMERA_LIST.join('');
var TRUE_MARK = (function () {
    var t = FIGURE_SCENE.truth, s = 5;
    return line([t[0] - s, t[1]], [t[0] + s, t[1]], 'tm-true') + line([t[0], t[1] - s], [t[0], t[1] + s], 'tm-true');
})();
var DOTS = DETECTIONS.map(function (d) {
    return '<circle cx="' + fmt(d[0]) + '" cy="' + fmt(d[1]) + '" r="3" class="tm-det"/>';
}).join('');
var VIEW_BOX = '-6 5 301 245';   // room at the bottom for the legend and the bars, clear of the scene

// Names the sketch's marks. Its own small SVG, pinned to the left edge of the card
// (`.tm-sketch`), so it stays clear of the scene, which is centred in a wide card.
var SKETCH_LEGEND = '<svg viewBox="8 137 102 69" class="tm-legend" aria-hidden="true">' + [
    [line([11, 0], [19, 0], 'tm-true') + line([15, -4], [15, 4], 'tm-true'), 'target'],
    ['<circle cx="15" cy="0" r="4" class="tm-point"/>', 'projection'],
    ['<circle cx="15" cy="0" r="3" class="tm-det"/>', 'prediction'],
    ['<circle cx="15" cy="0" r="3.2" class="tm-proj"/>', 'reprojection'],
    [line([10, 0], [20, 0], 'tm-gap'), 'reprojection error'],
    [line([10, 0], [20, 0], 'tm-truth-gap'), 'ground truth error'],
].map(function (row, i) {
    return '<g transform="translate(0 ' + (143 + 11 * i) + ')">' + row[0]
        + '<text x="25" y="3" class="tm-note tm-legend-text">' + row[1] + '</text></g>';
}).join('') + '</svg>';

var TOTAL_BAR_X = 58, TOTAL_BAR_SCALE = 0.2;   // units per pixel: one scale for every sketch
var TRUTH_BAR_SCALE = 0.44;                         // units per sketch unit, likewise

/** How far a solve's projection is from the target, in 3D. */
function groundTruthError(solve) {
    var t = FIGURE_SCENE.truth;
    return Math.hypot(solve.point[0] - t[0], solve.point[1] - t[1], solve.z);
}

/**
 * The reprojection errors of one solve as bars: a row per camera, then a row for
 * their sum, made of the same bars end to end. A camera not `counted` is named as
 * left out and adds nothing. Under them, the ground truth error on its own scale, in
 * the scene's units. Its own small SVG, pinned to the card's right edge.
 */
function errorTotals(solve, counted) {
    function bar(x, px, cls) {
        return '<rect x="' + fmt(x) + '" y="-4" width="' + fmt(px * TOTAL_BAR_SCALE) + '" height="4" class="' + cls + '"/>';
    }
    function row(y, label, bars, value, cls) {
        return '<g transform="translate(0 ' + y + ')"' + (cls ? ' class="' + cls + '"' : '') + '>'
            + '<text x="0" y="0" class="tm-note tm-legend-text">' + label + '</text>' + bars
            + '<text x="122" y="0" text-anchor="end" class="tm-note tm-legend-text">' + value + '</text></g>';
    }
    var s = '', x = TOTAL_BAR_X, sum = 0, sumBars = '';
    CAMS.forEach(function (c, i) {
        var used = counted.indexOf(i) >= 0, err = solve.errors[i];
        s += used ? row(19 + 11 * i, 'camera ' + i, bar(TOTAL_BAR_X, err, 'tm-total-bar'), fmt(err) + ' px')
            : row(19 + 11 * i, 'camera ' + i, '', 'left out', 'tm-total-out');
        if (!used) return;
        sum += err;
        sumBars += bar(x, err, 'tm-total-bar');
        x += err * TOTAL_BAR_SCALE;
    });
    var truth = groundTruthError(solve);
    return '<svg viewBox="0 0 122 80" class="tm-totals" aria-hidden="true">'
        + '<text x="0" y="8" class="tm-note tm-legend-text">reprojection error</text>' + s
        + '<line x1="0" y1="55.5" x2="122" y2="55.5" class="tm-total-rule"/>'
        + row(65, 'sum', sumBars, fmt(sum) + ' px', 'tm-total-sum')
        + row(76, 'ground truth', '<rect x="' + TOTAL_BAR_X + '" y="-4" width="' + fmt(truth * TRUTH_BAR_SCALE)
            + '" height="4" class="tm-truth-bar"/>', fmt(truth) + ' mm', 'tm-total-truth') + '</svg>';
}

/**
 * One sketch: the scene, the 3D answer `solve.point` and, for each camera in
 * `counted`, the line back to it, where the answer lands and the reprojection error.
 * `overlay` (optional) is drawn over the image planes, under the points.
 */
function sketch(solve, counted, extra, strayLabel, overlay) {
    // A camera the solve no longer counts is drawn faded: it is out of the math.
    function faded(i, html) { return counted.indexOf(i) >= 0 ? html : '<g class="tm-dropped">' + html + '</g>'; }
    var p = solve.point, s = RAY_LIST.map(function (ray, i) { return faded(i, ray); }).join('');
    counted.forEach(function (i) { s += line(CAMS[i].at, p, 'tm-back'); });
    s += CAMERA_LIST.map(function (mark, i) { return faded(i, mark); }).join('') + (overlay || '') + extra;
    counted.forEach(function (i) { s += line(DETECTIONS[i], onPlane(i, solve.x[i]), 'tm-gap'); });
    // Over every other line, under the markers.
    s += line(p, FIGURE_SCENE.truth, 'tm-truth-gap') + TRUE_MARK;
    DETECTIONS.forEach(function (d, i) {
        var used = counted.indexOf(i) >= 0, q = used ? onPlane(i, solve.x[i]) : null;
        s += faded(i, '<circle cx="' + fmt(d[0]) + '" cy="' + fmt(d[1]) + '" r="3" class="tm-det' + (used ? '' : ' tm-det-out') + '"/>');
        if (q) s += '<circle cx="' + fmt(q[0]) + '" cy="' + fmt(q[1]) + '" r="3.6" class="tm-proj"/>';
    });
    s += '<circle cx="' + p[0] + '" cy="' + p[1] + '" r="5" class="tm-point"/>' + strayLabel;
    return '<div class="tm-sketch"><svg viewBox="' + VIEW_BOX + '" role="img" aria-hidden="true">'
        + '<defs><marker id="tm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">'
        + '<path d="M0 0 L8 4 L0 8 Z" class="tm-arrowhead"/></marker></defs>'
        + s + '</svg>' + SKETCH_LEGEND + errorTotals(solve, counted) + '</div>';
}

function note(lines, x, y) {
    return lines.map(function (text, i) {
        return '<text x="' + x + '" y="' + (y + 11 * i) + '" text-anchor="end" class="tm-note">' + text + '</text>';
    }).join('');
}
function strayNote(i, lines, lastCls) {
    var at = STRAY_LABELS[i];
    return lines.map(function (text, n) {
        var cls = n && lastCls ? lastCls : 'tm-note-stray';
        var y = at.up ? at.y - 11 * (lines.length - 1 - n) : at.y + 11 * n;
        return '<text x="' + at.x + '" y="' + y + '"' + (at.anchor ? ' text-anchor="' + at.anchor + '"' : '')
            + ' class="tm-note ' + cls + '">' + text + '</text>';
    }).join('');
}

var DLT_ALL = FIGURE_SCENE.solves.dlt['0,1,2,3'];
var BA_ALL = FIGURE_SCENE.solves.ba['0,1,2,3'];

// A note in the empty space above the scene, with a line to `p`.
// A note beside the sketch's point, with no line to it. A note of three lines grows
// upward, into the free space above.
function noteAt(lines) {
    var y = lines.length > 2 ? 82 - 11 * lines.length : 60;
    return lines.map(function (text, i) { return '<text x="170" y="' + (y + 11 * i) + '" class="tm-note">' + text + '</text>'; }).join('');
}

var DLT_SKETCH = sketch(DLT_ALL, ALL, noteAt(['Projection gets pulled', 'toward the stray line', 'of Camera 3']), strayNote(3, ['stray']));
var REFINED_SKETCH = sketch(BA_ALL, ALL,
    '<circle cx="' + DLT_ALL.point[0] + '" cy="' + DLT_ALL.point[1] + '" r="4" class="tm-start"/>'
    + (function () {
        // From the DLT point to Refined's, stopping short of both markers.
        var a = DLT_ALL.point, b = BA_ALL.point, dx = b[0] - a[0], dy = b[1] - a[1], len = Math.hypot(dx, dy);
        return line([a[0] + dx / len * 4.5, a[1] + dy / len * 4.5], [b[0] - dx / len * 6, b[1] - dy / len * 6], 'tm-move" marker-end="url(#tm-arrow)');
    })()
    + '<text x="' + DLT_ALL.point[0] + '" y="' + (DLT_ALL.point[1] + 14) + '" text-anchor="middle" class="tm-note">DLT start</text>',
    strayNote(3, ['stray']));

/** One selectable card: indicator, name, tagline, sketch, caption, optional note. */
function card(method, name, tagline, sketchSvg, caption, cardNote) {
    return '<div class="tri-methods-col tri-method-choice" data-method="' + method + '"'
        + ' role="radio" aria-checked="false" tabindex="0">'
        + '<div class="tri-methods-head"><span class="settings-radio"></span>'
        + '<span class="tri-methods-name">' + name + '<small>' + tagline + '</small></span></div>'
        + sketchSvg
        + '<p>' + caption + '</p>'
        + (cardNote ? '<p class="tri-methods-note">' + cardNote + '</p>' : '')
        + '</div>';
}

// --- The reprojection error threshold card ------------------------------

var THRESHOLD_MAX = 640;         // px, half of a 1280 px monitor; the setting's own top (`ui/settings.js`)
var THRESHOLD_MIN = 1;           // px, the slider's right end
var SLIDER_POSITIONS = 1000;     // the slider's right end, as a position
var SLIDER_HIGHEST = 100;        // where off ends and THRESHOLD_MAX starts

// The slider runs from off, then from THRESHOLD_MAX down to THRESHOLD_MIN on a log
// scale, so moving it right makes the check stricter.
/** The slider position of a threshold in px (0 = off). */
export function thresholdSliderPos(px) {
    if (!(px > 0)) return 0;
    var v = Math.min(THRESHOLD_MAX, Math.max(THRESHOLD_MIN, px));
    return Math.round(SLIDER_HIGHEST + (SLIDER_POSITIONS - SLIDER_HIGHEST) * Math.log(THRESHOLD_MAX / v) / Math.log(THRESHOLD_MAX / THRESHOLD_MIN));
}
/** The threshold in px at a slider position (0 = off). */
export function thresholdFromSliderPos(pos) {
    if (pos < SLIDER_HIGHEST / 2) return 0;
    if (pos <= SLIDER_HIGHEST) return THRESHOLD_MAX;
    return Math.max(THRESHOLD_MIN, Math.round(THRESHOLD_MAX * Math.pow(THRESHOLD_MIN / THRESHOLD_MAX, (pos - SLIDER_HIGHEST) / (SLIDER_POSITIONS - SLIDER_HIGHEST))));
}
var WIDEST_ERROR = 88.8;         // stands in for the error in the hidden wordings
var STEP_METHODS = ['DLT', 'Refined'];

// Every wording of a re-solve's title, so it keeps the height of the longest. Each
// solve uses the same method as the first, so the title names it.
function stepTitles(i) {
    var out = [];
    STEP_METHODS.forEach(function (m) {
        ALL.forEach(function (c) {
            out.push((i + 1) + (i === 1 ? ' · Second solve (' : ' · Third solve (') + m + '), without camera'
                + (i === 1 ? ' ' + c : 's 3 and ' + c));
        });
    });
    return out.concat((i + 1) + ' · Not reached');
}
function stepTitleIndex(methodName, drop) { return STEP_METHODS.indexOf(methodName) * ALL.length + drop; }

var STEP_COUNT = 3;              // four cameras: at most two drops, so three solves

/**
 * The reprojection-error-threshold rule of `triangulateAndReproject`
 * (`pose/triangulation-core.js`), for one node: after a solve, while more than
 * two cameras are left, drop the single camera whose error is largest AND over
 * `threshold`, then solve again; once none is dropped, a node with any camera
 * still over the threshold gets no 3D point. An error equal to the threshold
 * is not over it.
 *
 * @param {number[]} cameras  indices of the cameras that see the node
 * @param {function(number[]): number[]} solve  errors (px) per camera index
 *   after solving from those cameras
 * @param {number} threshold  px, > 0
 * @returns {{passes: Array<{cameras: number[], errors: number[], drop: number}>, kept: boolean}}
 *   one pass per solve (`drop` = the camera dropped after it, or -1), and
 *   whether the node keeps a 3D point
 */
export function thresholdPasses(cameras, solve, threshold) {
    var passes = [];
    var left = cameras.slice();
    for (var guard = 0; guard < cameras.length; guard++) {
        var errors = solve(left), worst = -1, worstErr = threshold;
        left.forEach(function (c) { if (errors[c] > worstErr) { worstErr = errors[c]; worst = c; } });
        var drop = worst >= 0 && left.length > 2 ? worst : -1;
        passes.push({ cameras: left, errors: errors, drop: drop });
        if (drop < 0) break;
        left = left.filter(function (c) { return c !== drop; });
    }
    var last = passes[passes.length - 1];
    return {
        passes: passes,
        kept: last.cameras.every(function (c) { return !(last.errors[c] > threshold); }),
    };
}

/**
 * The threshold on camera `i`'s image plane: where the 3D answer may land and
 * be within `threshold` px of the detection, that far either side of it (cut at
 * the plane's ends, with an end mark where it is not cut), coloured by the
 * camera's verdict (`state`).
 */
function band(i, threshold, state) {
    var at = FIGURE_SCENE.detections[i][0] / PX_PER_UNIT, half = threshold / PX_PER_UNIT, edge = PLANE_HALF;
    var u0 = Math.max(-edge, at - half), u1 = Math.min(edge, at + half), r = RIGHT[i];
    function end(u) {
        var p = onPlane(i, u * PX_PER_UNIT);
        return line([p[0] - r[1] * 5, p[1] + r[0] * 5], [p[0] + r[1] * 5, p[1] - r[0] * 5], 'tm-band-end is-' + state);
    }
    return line(onPlane(i, u0 * PX_PER_UNIT), onPlane(i, u1 * PX_PER_UNIT), 'tm-band is-' + state)
        + (at - half >= -edge ? end(u0) : '') + (at + half <= edge ? end(u1) : '');
}

/** Camera `c`'s verdict in a pass: 'in', 'over', 'drop', or 'out' (no longer counts). */
function verdict(pass, c, threshold) {
    if (pass.cameras.indexOf(c) < 0) return 'out';
    if (pass.drop === c) return 'drop';
    return pass.errors[c] > threshold ? 'over' : 'in';
}

/** A step's sketch: the scene, the step's 3D answer and a band on every image plane still checked. */
function stepSketch(solve, cameras, states, threshold, stepNote) {
    var bands = '', strays = '';
    states.forEach(function (st, i) {
        if (st !== 'out' && st !== 'off') bands += band(i, threshold, st);
        if (!STRAY_LABELS[i]) return;
        // Once it is out, the faded camera says so.
        strays += st === 'drop' ? strayNote(i, ['stray,', 'dropped'], 'tm-note-drop')
            : st === 'out' ? ''
            : strayNote(i, ['stray']);
    });
    return sketch(solve, cameras, stepNote, strays, bands);
}

// A step's place while the rule does not reach it: the bare scene, faded.
var IDLE_SKETCH = '<div class="tm-sketch"><svg viewBox="' + VIEW_BOX + '" class="tm-idle" aria-hidden="true">' + RAYS + CAMERA_MARKS + DOTS + '</svg></div>';

/**
 * Text that keeps the size of its longest wording, so the card does not grow or
 * shrink as the threshold moves: every wording in `variants` is laid in the
 * same grid cell and only the one at `on` is visible (`.tri-thr-stack`).
 */
function stack(variants, on) {
    return '<span class="tri-thr-stack">' + variants.map(function (v, i) {
        return '<span' + (i === on ? ' class="on"' : '') + '>' + v + '</span>';
    }).join('') + '</span>';
}

var VERDICT_STATES = ['in', 'over', 'two', 'drop', 'out', 'off'];

/** The cameras' verdicts under a step's sketch. */
function verdictList(pass, states) {
    return states.map(function (st, c) {
        var shown = st === 'over' && pass.drop < 0 ? 'two' : st;
        var say = VERDICT_STATES.map(function (v) {
            var err = (v === shown ? pass.errors[c] : WIDEST_ERROR) + ' px · ';
            return v === 'off' ? err + 'counted'
                : v === 'in' ? err + 'within'
                : v === 'over' ? err + 'over, checked again'
                : v === 'two' ? err + 'over, only two left'
                : v === 'drop' ? err + 'the worst: dropped'
                : 'left out';
        });
        return '<li class="is-' + st + '"><span>' + CAMS[c].name + '</span>'
            + stack(say, VERDICT_STATES.indexOf(shown)) + '</li>';
    }).join('');
}

var THRESHOLD_CONTROL = {
    name: 'Threshold', aria: 'Reprojection error threshold (px)', min: 0, max: THRESHOLD_MAX, step: 1, unit: 'px',
    sliderMin: 0, sliderMax: SLIDER_POSITIONS, sliderStep: 1,
    toSlider: thresholdSliderPos, fromSlider: thresholdFromSliderPos,
    ticks: [[0, 'off'], [thresholdSliderPos(THRESHOLD_MAX), String(THRESHOLD_MAX)], [thresholdSliderPos(100), '100'],
        [thresholdSliderPos(15), '15'], [thresholdSliderPos(THRESHOLD_MIN), String(THRESHOLD_MIN)]],
    zone: { from: thresholdSliderPos(100), to: thresholdSliderPos(15), label: 'recommended' },
};

var RESULT_KINDS = ['lost', 'far', 'close', 'one', 'two', 'offFar', 'offClose'];

/** What becomes of the node with `threshold` px; `second` names the second camera dropped. */
function resultText(kind, threshold, second) {
    var lead = 'With ' + threshold + ' px, ';
    if (kind === 'offFar' || kind === 'offClose') {
        return 'With the threshold off, every camera counts, whatever its error. The first solve stands, '
            + (kind === 'offFar' ? 'far from the target (the cross).'
                : 'closer to the target (the cross) than DLT\'s, with the stray still counted.');
    }
    return kind === 'lost'
        ? lead + 'this node gets no 3D point in this frame: only two cameras are left and they still miss by more '
            + 'than that, and a node is never solved from fewer than two.'
        : kind === 'far'
            ? lead + 'every camera lands within the threshold, so nothing is dropped. The first solve stands, far '
                + 'from the target (the cross).'
            : kind === 'close'
                ? lead + 'every camera lands within the threshold, so nothing is dropped. The first solve stands, closer '
                    + 'to the target (the cross) than DLT\'s, with the stray still counted.'
                : kind === 'one'
                    ? lead + 'camera 3 is left out for this node, and the projection comes from the three cameras that '
                        + 'are only a little off: near the target, but still a little wrong.'
                    : lead + 'camera 3 and then ' + second + ' are left out for this node. A threshold this low also '
                        + 'drops a camera that was only a little off, so the projection rests on just two cameras.';
}

/**
 * Build the figure. Static markup for the two method cards (text is HTML so it
 * wraps with the panel); the threshold card is redrawn by `update`.
 * @param {{onThreshold?: function(number): void}} [opts] `onThreshold(px)` is
 *   called when the threshold card's Use or Turn off button sets the threshold,
 *   so the panel can set its working value and the Tracking Wizard field. The
 *   slider and the DLT/Refined switch never call it.
 * @returns {{el: HTMLElement, update: function({method?: string, threshold?: number, saved?: number}): void}}
 *   `update` takes the picked method, the working threshold, and the threshold
 *   stored when Settings opened (for "not saved until Apply"). `opts.examples` is
 *   an optional `buildThresholdExamples` panel, shown last in the card and told what is
 *   being tried.
 */
export function buildTriangulationMethodsFigure(opts) {
    opts = opts || {};
    var fig = document.createElement('figure');
    fig.className = 'tri-methods';
    fig.innerHTML =
        '<p class="tri-methods-lead">Both methods triangulate each node of the skeleton on its own (the sketches '
        + 'show one node, from above) and start the same way: each camera\'s 2D prediction is a line of sight, '
        + 'and the projection, the 3D point, is where those lines meet. Real detections never meet exactly. Here camera 3\'s 2D '
        + 'prediction is badly wrong: an outlier, marked stray. The other three are off too, by less, as real predictions '
        + 'always are. The green cross is the target: the true position. The reprojection is where the '
        + 'projection lands back in a camera\'s 2D image, and the reprojection error is the distance on that 2D image '
        + 'between the prediction and the reprojection. The bars at the bottom right of each sketch add up those errors: Refined\'s sum '
        + 'is lower than DLT\'s, even though its error in the stray camera is larger. The dark red line is the ground '
        + 'truth error, how far the projection is from the target, which shrinks from DLT to Refined. A sketch can show '
        + 'it because it knows the target; on a real recording only the reprojection error can be measured.</p>'
        + '<div class="tri-methods-cols" role="radiogroup" aria-label="Default triangulation method">'
        + card('dlt', 'Direct Linear Transformation (DLT), per node', 'one direct solve · fast', DLT_SKETCH,
            'Solves one set of linear equations (algebraic least squares) for the point that fits every '
            + 'line at once, treating every camera alike. Fast, but an outlier pulls the projection, so every '
            + 'camera ends up off.')
        + card('ba', 'Refined (Bundle adjustment), per node', 'slower', REFINED_SKETCH,
            'Bundle adjustment: starts at the DLT point, projects it back into every camera and moves it to '
            + 'shrink the reprojection errors. A camera that disagrees a lot counts less, which helps when one '
            + 'view\'s 2D prediction is clearly wrong: here the projection lands closer to the target than DLT\'s, though the '
            + 'outlier, still counted a little, keeps it off. The '
            + 'reprojection error threshold below removes the outlier altogether. When the views roughly agree, it '
            + 'gives about the same point as DLT, '
            + 'sometimes slightly worse. The cameras stay fixed; only the point moves. Slower.',
            '<strong>Per node:</strong> a camera is counted less only for the node where its 2D '
            + 'point disagrees. If one camera misplaces the nose, it still counts for every other node it '
            + 'sees well.')
        + '</div>'
        + '<div class="tri-methods-col tri-thr">'
        + '<div class="tri-thr-intro">'
        + '<div class="tri-methods-name">Reprojection error threshold (RPE), per node<span class="fig-big"></span></div>'
        + '<p>Optional, for either method, and off (0) by default. Refined only counts a bad camera less; this '
        + 'removes it. After the solve, each camera\'s reprojection error for the node ('
        + 'the distance on the camera\'s 2D image between the prediction and the reprojection) is compared with the threshold, '
        + 'drawn as a band on the camera\'s image plane: the reprojection must land within that many pixels either side '
        + 'of the prediction. If it lands outside any band, the camera that misses by most is dropped for this '
        + 'node and the node is solved again from the rest; this repeats while more than two cameras are left. A '
        + 'node whose last two cameras still miss gets no 3D point in this frame. Moving the slider right makes the check '
        + 'stricter. Past the recommended zone (100 to 15 px) it can start dropping good views too.</p>'
        + '</div>'
        + '<div class="tri-thr-steps">'
        + [1, 2, 3].map(function (n) {
            return '<div class="tri-thr-step" data-step="' + n + '"><div class="tri-thr-step-name"></div>'
                + '<div class="tri-thr-sketch"></div><div class="tri-thr-verdict-box"><ul class="tri-thr-verdicts"></ul>'
                + '<p class="tri-thr-idle-note">Not reached: no camera is dropped.</p></div></div>';
        }).join('')
        + '</div>'
        + '<p class="tri-thr-result"></p>'
        + '<div class="tri-methods-legend">'
        + '<span><i class="tm-key-sight"></i><i class="tm-key-sight tm-key-sight-stray"></i>line of sight: grey if the camera is a little off, orange if stray</span>'
        + '<span><i class="tm-key-back"></i>line from the camera to the projection</span>'
        + '<span><i class="tm-key-band"></i>threshold: where the reprojection may land in that camera</span>'
        + '</div>'
        // Between the sketches and the session's examples, since it drives both.
        + '<div class="tri-thr-controls">'
        + tryStrip(tryControl('threshold', THRESHOLD_CONTROL)
            + '<div class="tri-thr-demo-method" role="group" aria-label="First solve to try in the sketch">'
            + '<span>First solve</span>'
            + '<button type="button" data-demo-method="dlt">DLT</button>'
            + '<button type="button" data-demo-method="ba">Refined</button></div>')
        + settingRow('threshold')
        + '</div>'
        + '<p class="tri-methods-note"><strong>Where to set it:</strong> the Use button here, the toolbar\'s '
        + 'Triangulate menu or the Tracking Wizard. <strong>Per node:</strong> a dropped camera still counts for every '
        + 'other node it sees well. It applies to every Triangulate (this frame, all frames, after an edit), '
        + 'not to how Track All matches animals across cameras. Set it too low and nodes lose their 3D '
        + '(gaps in the tracks).</p>'
        + '<div class="tri-thr-session"></div>'
        + '</div>';

    var thr = fig.querySelector('.tri-thr');
    if (opts.examples) thr.querySelector('.tri-thr-session').appendChild(opts.examples.el);
    var demoButtons = thr.querySelectorAll('[data-demo-method]');
    // `method` / `setting` / `saved` are real; `tryMethod` / `tryThreshold` are the sketch's.
    var current = { method: 'dlt', setting: 0, saved: 0, tryMethod: 'dlt', tryThreshold: 0 };

    var control = wireTryControl(thr, 'threshold', THRESHOLD_CONTROL, function (v) {
        current.tryThreshold = v;
        render();
    });
    demoButtons.forEach(function (b) {
        b.addEventListener('click', function () {
            current.tryMethod = b.getAttribute('data-demo-method');
            render();
        });
    });
    var showSetting = wireSettingRow(thr, 'threshold', {
        use: function () { commit(current.tryThreshold); },
        off: function () { commit(0); },
        reset: function () {
            current.tryThreshold = current.setting;
            current.tryMethod = current.method;
            render();
        },
    });
    function commit(value) {
        current.setting = value;
        render();
        if (opts.onThreshold) opts.onThreshold(value);
    }

    function update(next) {
        next = next || {};
        if (next.method != null) current.tryMethod = current.method = next.method === 'ba' ? 'ba' : 'dlt';
        if (next.saved != null) current.saved = Math.max(0, +next.saved || 0);
        if (next.threshold != null) {
            current.setting = Math.max(0, +next.threshold || 0);
            current.tryThreshold = current.setting;
        }
        render();
    }

    function render() {
        var t = current.tryThreshold, set = current.setting, off = !(t > 0);
        // Off: nothing is over, so the rule stops after the first solve.
        var limit = off ? Infinity : t;
        var methodName = current.tryMethod === 'ba' ? 'Refined' : 'DLT';
        var table = FIGURE_SCENE.solves[current.tryMethod];

        control.set(fmt(t));
        thr.querySelector('.fig-big').textContent = off ? 'off' : fmt(t) + ' px';
        demoButtons.forEach(function (b) {
            b.setAttribute('aria-pressed', b.getAttribute('data-demo-method') === current.tryMethod ? 'true' : 'false');
        });
        showSetting({
            label: 'Your setting',
            now: set > 0 ? fmt(set) + ' px' : 'off',
            unsaved: set !== current.saved,
            use: !off && t !== set ? 'Use ' + fmt(t) + ' px' : null,
            off: set > 0,
            reset: t !== set || current.tryMethod !== current.method,
        });

        if (opts.examples) opts.examples.update({ threshold: t, method: current.tryMethod });

        var run = thresholdPasses(ALL, function (cams) { return table[cams.join(',')].errors; }, limit);
        var steps = thr.querySelectorAll('.tri-thr-step');
        // This method's solves, in the order the rule drops cameras.
        var FALLBACK = Object.keys(table).map(function (k) { return k.split(',').map(Number); });
        for (var i = 0; i < STEP_COUNT; i++) {
            var pass = run.passes[i], el = steps[i], idle = !pass;
            // A step the rule does not reach keeps its rows (hidden), so it keeps its height.
            var shown = pass || { cameras: FALLBACK[i], errors: table[FALLBACK[i].join(',')].errors, drop: -1 };
            var states = ALL.map(function (c) { return off ? (shown.cameras.indexOf(c) < 0 ? 'out' : 'off') : verdict(shown, c, t); });
            el.classList.toggle('is-idle', idle);
            el.querySelector('.tri-thr-step-name').innerHTML = i === 0
                ? stack(STEP_METHODS.map(function (m) { return '1 · First solve (' + m + '), all four cameras'; }),
                    STEP_METHODS.indexOf(methodName))
                : stack(stepTitles(i), idle ? stepTitles(i).length - 1 : stepTitleIndex(methodName, run.passes[i - 1].drop));
            el.querySelector('.tri-thr-sketch').innerHTML = idle ? IDLE_SKETCH
                : stepSketch(table[shown.cameras.join(',')], shown.cameras, states, t,
                    i === 0 ? noteAt(current.tryMethod === 'dlt' ? ['Projection gets pulled', 'toward the stray line', 'of Camera 3'] : ['closer to', 'the target'])
                        : i === 2 ? noteAt(['cross from above,', 'just miss in 3D']) : '');
            el.querySelector('.tri-thr-verdicts').innerHTML = verdictList(shown, states);
        }

        var kind = off ? (current.tryMethod === 'ba' ? 'offClose' : 'offFar')
            : !run.kept ? 'lost' : run.passes.length === 1 ? (current.tryMethod === 'ba' ? 'close' : 'far')
            : run.passes.length === 2 ? 'one' : 'two';
        var second = run.passes.length > 1 && run.passes[1].drop >= 0 ? 'camera ' + run.passes[1].drop : 'camera 0';
        var res = thr.querySelector('.tri-thr-result');
        // Every kind at its widest number, then the one shown.
        res.innerHTML = stack(RESULT_KINDS.map(function (k) { return resultText(k, WIDEST_ERROR, 'camera 0'); })
            .concat(resultText(kind, fmt(t), second)), RESULT_KINDS.length);
        res.classList.toggle('tri-thr-lost', !run.kept);
        res.dataset.kind = kind;
        res.dataset.method = methodName;
    }

    render();
    return { el: fig, update: update };
}
