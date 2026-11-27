// pose/cage-mirrors.js — the arena's walls and floor as mirrors, from a campy
// cage (`<calibration>.cage.json`, written by campy's `campy-cage` from the
// box's printed grid, in the calibration's units). Import-free and DOM-free, so
// Node tests load it.
//
// An animal near a glossy wall or floor shows a mirror image of itself there,
// as bright as the animal. Where the image touches the animal (a mouse at the
// edge of the floor and its reflection in the front wall), brightness cannot
// tell them apart, and the image's pixels near the animal pass any distance
// limit wide enough for the animal itself. Its 3D pose mirrored across the
// wall and projected says exactly where the image is: `ui/animal-outlines.js`
// projects each animal's mirrored body (`mirroredPoint`, kept only where the
// line of sight meets the wall's own rectangle, `reflectionVisible`) and
// `pose/outline-core.js` leaves a pixel nobody's when it lies nearer a visible
// reflection than the animal's own body. Which surfaces reflect, in which
// camera, the sampled frames decide (`mirrorEvidence`): a mirror's predicted
// images land on bright pixels; a matt surface's on floor.
//
// The cage: `corners` (the floor's 4 corners, in order around it), `up` (unit,
// from the floor into the box), `height` (the walls' height). Planes: the
// floor, then one wall per floor edge, each {name, point, normal (into the
// box), quad: 4 corners}.

/** Is `name` a campy cage file (`*.cage.json`)? Never a calibration. */
export function isCampyCageName(name) {
    return /\.cage\.json$/i.test(String(name || ''));
}

/**
 * Parse a campy cage file's text. -> {corners: [[x,y,z] x4], up: [x,y,z]
 * (unit), height, units} or null when it is not one (wrong kind, missing or
 * non-finite corners, no up direction, no height).
 */
export function parseCampyCage(text) {
    var j;
    try { j = typeof text === 'string' ? JSON.parse(text) : text; } catch (e) { return null; }
    if (!j || typeof j !== 'object') return null;
    if (j.kind && j.kind !== 'campy cage') return null;
    var c = j.corners;
    if (!Array.isArray(c) || c.length !== 4) return null;
    for (var i = 0; i < 4; i++) {
        if (!Array.isArray(c[i]) || c[i].length !== 3 || !c[i].every(isFinite)) return null;
    }
    var u = j.up;
    if (!Array.isArray(u) || u.length !== 3 || !u.every(isFinite)) return null;
    var n = Math.hypot(u[0], u[1], u[2]);
    if (!(n > 0)) return null;
    var h = +j.height;
    if (!(h > 0)) return null;
    return { corners: c.map(function (p) { return p.map(Number); }), up: [u[0] / n, u[1] / n, u[2] / n], height: h, units: j.units || null };
}

function sub(a, b) { return [a[0] - b[0], a[1] - b[1], a[2] - b[2]]; }
function add(a, b) { return [a[0] + b[0], a[1] + b[1], a[2] + b[2]]; }
function mul(a, s) { return [a[0] * s, a[1] * s, a[2] * s]; }
function dot(a, b) { return a[0] * b[0] + a[1] * b[1] + a[2] * b[2]; }
function cross(a, b) { return [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]]; }
function unit(a) { var n = Math.hypot(a[0], a[1], a[2]); return n > 0 ? mul(a, 1 / n) : a; }

/**
 * The cage's surfaces as planes: the floor (normal = up), then a wall per
 * floor edge (corners i, i+1), normal pointing into the box. Each {name,
 * point, normal, quad}.
 */
export function cagePlanes(cage) {
    if (!cage) return [];
    var c = cage.corners, up = cage.up, top = mul(up, cage.height);
    var mid = mul(add(add(c[0], c[1]), add(c[2], c[3])), 0.25);
    var planes = [{ name: 'floor', point: c[0], normal: up, quad: c.slice() }];
    for (var i = 0; i < 4; i++) {
        var a = c[i], b = c[(i + 1) % 4];
        var n = unit(cross(sub(b, a), up));
        if (dot(sub(mid, a), n) < 0) n = mul(n, -1);
        planes.push({ name: 'wall ' + i, point: a, normal: n, quad: [a, b, add(b, top), add(a, top)] });
    }
    return planes;
}

/** `X` mirrored across `plane`. */
export function mirroredPoint(X, plane) {
    var d = dot(sub(X, plane.point), plane.normal);
    return sub(X, mul(plane.normal, 2 * d));
}

// Is point P (on the plane) inside the convex quad (its corners in order)?
function inQuad(P, quad, n) {
    var sign = 0;
    for (var i = 0; i < quad.length; i++) {
        var a = quad[i], b = quad[(i + 1) % quad.length];
        var s = dot(cross(sub(b, a), sub(P, a)), n);
        if (Math.abs(s) < 1e-9) continue;
        if (!sign) sign = s > 0 ? 1 : -1;
        else if ((s > 0 ? 1 : -1) !== sign) return false;
    }
    return true;
}

/**
 * Can a camera at `C` see the mirror image `Xm` of a point inside the box in
 * `plane`? Both the camera and the point are on the box's side of the plane
 * (the caller passes the real point as `X`), and the line from the camera to
 * the image crosses the plane inside the surface's own rectangle.
 */
export function reflectionVisible(C, X, Xm, plane) {
    var n = plane.normal;
    var sc = dot(sub(C, plane.point), n), sx = dot(sub(X, plane.point), n);
    if (!(sc > 0) || !(sx > 0)) return false;
    var sm = dot(sub(Xm, plane.point), n);
    if (!(sm < 0)) return false;
    var t = sc / (sc - sm);
    var P = add(C, mul(sub(Xm, C), t));
    return inQuad(P, plane.quad, n);
}
