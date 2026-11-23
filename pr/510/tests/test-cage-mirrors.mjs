/**
 * test-cage-mirrors.mjs — pose/cage-mirrors.js: a campy cage file read
 * (`<calibration>.cage.json`, campy's `campy-cage`), its floor and walls as
 * planes facing into the box, points mirrored across them, and whether a
 * camera sees a mirror image in a surface's own rectangle. The cage numbers are
 * DoublePoke's 2026-07-13 box (calibration mm).
 */
import { isCampyCageName, parseCampyCage, cagePlanes, mirroredPoint, reflectionVisible } from '../pose/cage-mirrors.js';

let passed = 0, failed = 0;
const check = (cond, msg) => { if (cond) { passed++; console.log('  ok   ' + msg); } else { failed++; console.log('  FAIL ' + msg); } };
const near = (a, b, e = 1e-6) => a.every((v, i) => Math.abs(v - b[i]) < e);
const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

const DP0713 = {
    kind: 'campy cage', version: 1, units: "the calibration's (mm)",
    corners: [[-253.145, 152.113, 717.528], [205.592, 160.022, 723.904], [210.367, -92.05, 693.036], [-248.37, -99.959, 686.661]],
    up: [0.011695, 0.121758, -0.992491], height: 317.5, margin: 30.0,
};

console.log('\n1. Reading a cage file');
{
    check(isCampyCageName('calibration.cage.json') && isCampyCageName('X.CAGE.JSON') && !isCampyCageName('calibration.json') && !isCampyCageName('cage.toml'), 'cage files are *.cage.json');
    const c = parseCampyCage(JSON.stringify(DP0713));
    check(c && c.corners.length === 4 && c.height === 317.5 && Math.abs(Math.hypot(...c.up) - 1) < 1e-12, 'a campy cage parses: 4 corners, a unit up, the height');
    check(parseCampyCage('{"kind": "something else", "corners": []}') === null && parseCampyCage('not json') === null, 'anything else is not a cage');
    check(parseCampyCage(JSON.stringify(Object.assign({}, DP0713, { corners: DP0713.corners.slice(0, 3) }))) === null, 'three corners is not a cage');
    check(parseCampyCage(JSON.stringify(Object.assign({}, DP0713, { height: 0 }))) === null, 'no height is not a cage');
}

console.log('\n2. The floor and four walls, facing into the box');
{
    const c = parseCampyCage(DP0713), planes = cagePlanes(c);
    check(planes.length === 5 && planes[0].name === 'floor' && planes[1].name === 'wall 0', 'floor first, then a wall per floor edge');
    const mid = c.corners.reduce((s, p) => s.map((v, i) => v + p[i] / 4), [0, 0, 0]);
    const inside = mid.map((v, i) => v + c.up[i] * 100);                        // 100 mm above the floor's middle
    check(planes.every((pl) => dot(inside.map((v, i) => v - pl.point[i]), pl.normal) > 0), 'a point inside the box is on every surface\'s inner side');
    check(planes.slice(1).every((pl) => Math.abs(dot(pl.normal, c.up)) < 1e-9), 'walls stand upright (their normals are level)');
    check(planes.slice(1).every((pl) => pl.quad.length === 4 && Math.abs(dot(pl.quad[3].map((v, i) => v - pl.quad[0][i]), c.up) - 317.5) < 1e-9), 'each wall is 317.5 high');
}

console.log('\n3. Mirroring and seeing a reflection');
{
    // a box 400 x 200 on z = 0, up +z, 300 high; a camera above it
    const box = { corners: [[0, 0, 0], [400, 0, 0], [400, 200, 0], [0, 200, 0]], up: [0, 0, 1], height: 300 };
    const planes = cagePlanes(box);
    const front = planes.find((p) => Math.abs(p.normal[1] - 1) < 1e-9);          // the wall at y = 0, facing +y
    check(!!front && near(mirroredPoint([100, 20, 30], front), [100, -20, 30]), 'mirrored across the wall at y = 0: y flips');
    check(near(mirroredPoint([100, 20, 30], planes[0]), [100, 20, -30]), 'mirrored across the floor: z flips');
    const cam = [200, 300, 500];                                                    // above, behind the back wall's line
    const X = [100, 20, 30], Xm = mirroredPoint(X, front);
    check(reflectionVisible(cam, X, Xm, front), 'a camera above the box sees a mouse\'s reflection in the front wall');
    check(reflectionVisible([200, 190, 5000], X, Xm, front) === false, 'from high above the far side, the line to the image crosses the wall\'s plane above its 300 top: not seen');
    check(reflectionVisible([200, 100, 1000], X, Xm, front) === true, 'from above the middle it crosses at 192: seen');
    check(reflectionVisible([200, -50, 100], X, Xm, front) === false, 'a camera outside that wall cannot see the reflection in it');
    check(reflectionVisible(cam, X, X, front) === false, 'a point not behind the plane is no mirror image');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
