/**
 * test-outline-core.mjs — pose/outline-core.js, the idtracker.ai-style animal
 * outlines (Romero-Ferrero et al. 2019): blobs against an empty arena with
 * hysteresis, open/close, minimum area and filled holes; the single-animal area
 * model; per-animal assignment (whole individual blobs, crossings split by
 * nearest BODY skeleton, the nearest animal for a blob nobody's pose is in);
 * tail tracing that stops at another animal's body core; small bright pieces
 * re-attached; contours. Synthetic images with exact answers. ESM, so
 * tests/run-mjs-tests.mjs picks it up.
 */
import {
    OUTLINE_PARAMS, outlineParams, rgbaToGray, medianImage, ellipseElement, morph, components, fillHoles,
    segmentBlobs, areaModel, computeOutlines, traceBoundary, pointInPolygon, tailChain, animalFromInstance, normalizeAnimal,
} from '../pose/outline-core.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

const W = 240, H = 160;
const floor = (x, y) => 30 + Math.round(12 * Math.sin(x / 9) * Math.cos(y / 11));
function bgImage() { const g = new Uint8Array(W * H); for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) g[y * W + x] = floor(x, y); return g; }
const BG = bgImage();
// a frame: the floor plus painted shapes, each fn(x, y) -> brightness or null
function frame(...shapes) {
    const g = BG.slice();
    for (let y = 0; y < H; y++) for (let x = 0; x < W; x++) for (const s of shapes) { const v = s(x, y); if (v != null) g[y * W + x] = v; }
    return g;
}
const ellipse = (cx, cy, a, b, v = 200) => (x, y) => (((x - cx) / a) ** 2 + ((y - cy) / b) ** 2 < 1 ? v : null);
const hline = (y0, x0, x1, v = 190, half = 1) => (x, y) => (Math.abs(y - y0) <= half && x >= Math.min(x0, x1) && x <= Math.max(x0, x1) ? v : null);
const rect = (x0, y0, x1, y1, v) => (x, y) => (x >= x0 && x <= x1 && y >= y0 && y <= y1 ? v : null);
// a mouse pose along y = cy: head toward `dir`; tail behind, `tailLen` px
function mouse(cx, cy, dir, tailLen = 40) {
    const p = (d) => [cx + dir * d, cy];
    const body = [p(22), p(10), p(0), p(-12), p(-20)].flat();
    const segs = [];
    for (let i = 0; i + 3 < body.length; i += 2) segs.push(body[i], body[i + 1], body[i + 2], body[i + 3]);
    return { body, segments: segs, tail: [p(-20), p(-20 - tailLen / 2), p(-20 - tailLen)].flat() };
}
const at = (r, x, y) => r.labels[y * W + x];

console.log('\n1. Building blocks');
{
    check(JSON.stringify(ellipseElement(3).map(e => [e.dy, e.x0, e.x1])) === '[[-1,0,0],[0,-1,1],[1,0,0]]', 'the 3 px ellipse is OpenCV\'s cross');
    check(JSON.stringify(ellipseElement(5).map(e => [e.dy, e.x0, e.x1])) === '[[-2,0,0],[-1,-2,2],[0,-2,2],[1,-2,2],[2,0,0]]', 'the 5 px ellipse is OpenCV\'s');
    const one = new Uint8Array(25); one[12] = 1;
    const d = morph(one, 5, 5, ellipseElement(3), false);
    check(Array.from(d).join('') === '0000000100011100010000000', 'dilating a pixel by the 3 px ellipse gives the cross');
    const e = morph(d, 5, 5, ellipseElement(3), true);
    check(Array.from(e).join('') === Array.from(one).join(''), 'eroding the cross gives the pixel back');
    const edge = new Uint8Array(9).fill(1);
    check(morph(edge, 3, 3, ellipseElement(3), true).every(v => v === 1), 'pixels outside the image never erode (OpenCV\'s border)');
    const two = new Uint8Array([1, 1, 0, 2, 2, 0, 0, 0, 0, 0]);
    const cc = components(two, 5, 2, false), cs = components(two, 5, 2, true);
    check(cc.n === 2 && cs.n === 2, 'components: separate runs are separate');
    const touch = new Uint8Array([1, 1, 2, 2]);
    check(components(touch, 4, 1, false).n === 1 && components(touch, 4, 1, true).n === 2, 'touching labels join unless split by value');
    const ring = new Int32Array(25);
    for (let y = 0; y < 5; y++) for (let x = 0; x < 5; x++) if (x === 0 || y === 0 || x === 4 || y === 4) ring[y * 5 + x] = 1;
    check(fillHoles(ring, 5, 5, 1, [0, 0, 4, 4]) === 9 && ring.every(v => v === 1), 'fillHoles fills the inside of a ring');
    const rgba = new Uint8Array([100, 100, 100, 255, 255, 0, 0, 255]);
    const g = rgbaToGray(rgba);
    check(g[0] === 100 && g[1] === 77, 'grey: a grey pixel keeps its value; red is luma-weighted');
    check(outlineParams({ thrHigh: 30, bogus: 1 }).thrHigh === 30 && outlineParams(null).minArea === OUTLINE_PARAMS.minArea, 'parameters merge over the defaults');
}

console.log('\n2. Empty arena: the per-pixel median');
{
    const frames = [];
    for (let i = 0; i < 9; i++) frames.push(frame(ellipse(20 + i * 22, 40 + (i % 3) * 30, 18, 9)));
    const med = medianImage(frames);
    let off = 0; for (let i = 0; i < W * H; i++) if (med[i] !== BG[i]) off++;
    check(off === 0, `animals that move leave the empty arena behind (${off} pixels off)`);
    check(medianImage([new Uint8Array([1, 9]), new Uint8Array([5, 3])])[0] === 1, 'an even count takes the lower median');
}

console.log('\n3. Blobs: hysteresis, open/close, minimum area, holes, shadows');
{
    const dimAttached = (x, y) => (x >= 120 && x <= 135 && y >= 77 && y <= 83 ? floor(x, y) + 14 : null);   // 14 over: low, not high
    const dimAlone = (x, y) => (x >= 40 && x <= 70 && y >= 120 && y <= 140 ? floor(x, y) + 14 : null);
    const speck = rect(200, 20, 206, 26, 210);                     // 49 px: under the minimum area
    const shadow = (x, y) => (x >= 150 && x <= 190 && y >= 110 && y <= 140 ? 5 : null);   // darker than the floor
    const holed = (x, y) => { const v = ellipse(100, 80, 22, 12)(x, y); if (v == null) return null; return Math.hypot(x - 100, y - 80) < 4 ? floor(x, y) : v; };
    const seg = segmentBlobs(frame(holed, dimAttached, dimAlone, speck, shadow), BG, W, H);
    check(seg.n === 1, `one blob (the mouse); the dim patch alone, the speck and the shadow are not blobs (${seg.n})`);
    check(seg.blob[80 * W + 130] === 1, 'a dim part joined to a bright one stays (hysteresis)');
    check(seg.blob[80 * W + 100] === 1, 'a hole inside the blob is filled');
    check(seg.blob[125 * W + 170] === 0, 'a shadow (darker than the empty arena) is never foreground');
}

console.log('\n4. The single-animal area model');
{
    const m = areaModel([[1000, 1100], [1050, 950], [2100], [1000, 1020, 30]], 2);
    check(m && m.n === 4 && m.frames === 2, 'only frames with as many blobs as animals count');
    check(m && m.median === 1025 && Math.abs(m.hi - (m.median + 4 * m.sd)) < 1e-9, `median ${m && m.median}, crossing above median + 4 s.d.`);
    check(areaModel([[1000, 1100]], 2) === null, 'fewer than 3 areas: no model');
    check(areaModel([[1000, 1100], [1000, 1100]], 0) === null, 'no number of animals: no model');
}

console.log('\n5. Apart: each blob whole to its animal, tails traced');
{
    const img = frame(ellipse(60, 60, 26, 12), hline(60, 34, 0), ellipse(170, 110, 26, 12), hline(110, 196, 236));
    const r = computeOutlines(img, BG, W, H, [mouse(60, 60, 1), mouse(170, 110, -1)], { median: 1000, sd: 50, hi: 1200 });
    check(r.blobs.length === 2 && r.blobs.every(b => b.kind === 'individual'), 'two individual blobs');
    check(at(r, 60, 60) === 1 && at(r, 170, 110) === 2, 'bodies');
    check(at(r, 10, 60) === 1 && at(r, 225, 110) === 2, 'tails');
    check(at(r, 120, 20) === 0, 'floor');
    check(r.contours[0].length === 1 && r.contours[1].length === 1, 'one outline piece each');
    const poly = r.contours[0][0];
    let a2 = 0; for (let i = 0, j = poly.length - 2; i < poly.length; j = i, i += 2) a2 += (poly[j] + poly[i]) * (poly[j + 1] - poly[i + 1]);
    check(Math.abs(Math.abs(a2 / 2) - r.animals[0].area) < 0.25 * r.animals[0].area, `the outline encloses about the animal's area (${Math.abs(a2 / 2).toFixed(0)} vs ${r.animals[0].area} px)`);
    check(pointInPolygon(poly, 60, 60) && !pointInPolygon(poly, 170, 110), 'pointInPolygon hits its own animal');
}

console.log('\n6. Touching: a crossing split by nearest body skeleton');
{
    const img = frame(ellipse(100, 70, 26, 12), ellipse(140, 82, 26, 12), hline(70, 74, 34), hline(82, 166, 206));
    const r = computeOutlines(img, BG, W, H, [mouse(100, 70, 1), mouse(140, 82, -1)], { median: 1000, sd: 50, hi: 1200 });
    check(r.blobs.length === 1 && r.blobs[0].kind === 'crossing' && r.blobs[0].animals.length === 2, 'one crossing blob holding both');
    check(at(r, 82, 70) === 1 && at(r, 158, 82) === 2, 'each rear stays with its mouse');
    check(at(r, 50, 70) === 1 && at(r, 190, 82) === 2, 'each tail stays with its mouse');
    // the area alone calls a crossing too: one pose in an oversized blob, the other animal with no blob of its own nearby
    const r2 = computeOutlines(img, BG, W, H, [mouse(100, 70, 1)], { median: 400, sd: 20, hi: 480 });
    check(r2.blobs[0].kind === 'oversized' && at(r2, 140, 82) === 1, 'one pose in an oversized blob: all of it, marked oversized');
}

console.log('\n7. Tail tracing stops at another animal\'s body core (the topC 6,250 failure)');
{
    // mouse A's tail line runs across mouse B's back; the bright pixels there are B's body
    const img = frame(ellipse(70, 60, 26, 12), ellipse(150, 64, 30, 16), hline(60, 44, 120));
    const A = mouse(70, 60, 1, 140);                 // its tail polyline crosses B
    const B = mouse(150, 64, -1, 30);
    B.tail = null;
    const r = computeOutlines(img, BG, W, H, [A, B], { median: 1200, sd: 60, hi: 1500 });
    check(at(r, 150, 61) === 2 && at(r, 140, 60) === 2, 'B\'s back is B\'s, though A\'s tail line runs across it');
    check(at(r, 105, 60) === 1, 'A\'s tail up to B is A\'s');
    // the split uses body skeletons only: a tail lying over the other animal does not pull its pixels
    const img2 = frame(ellipse(100, 70, 26, 12), ellipse(140, 72, 26, 12));
    const A2 = mouse(100, 70, 1, 90);                // tail polyline back across... (behind A, away from B)
    const B2 = mouse(140, 72, -1, 10);
    B2.tail = [140 + 20, 72, 100, 70, 80, 70];       // B's tail line drawn across A's body
    const r3 = computeOutlines(img2, BG, W, H, [A2, B2], { median: 1000, sd: 50, hi: 1200 });
    check(at(r3, 100, 70) === 1 && at(r3, 95, 70) === 1, 'a tail line over another animal does not take its body');
}

console.log('\n8. A stray keypoint does not make a crossing; nobody\'s blob goes to a near animal or nobody');
{
    const img = frame(ellipse(60, 60, 26, 12), ellipse(170, 110, 26, 12), ellipse(200, 30, 20, 10));
    const A = mouse(60, 60, 1), B = mouse(170, 110, -1);
    A.body.push(165, 110);                           // one of A's keypoints wrongly on B
    const r = computeOutlines(img, BG, W, H, [A, B], { median: 700, sd: 40, hi: 900 });
    const kinds = r.blobs.map(b => b.kind);
    check(!kinds.includes('crossing') && at(r, 170, 110) === 2, 'B\'s blob stays B\'s whole: ' + kinds.join());
    check(at(r, 200, 30) === 0 && r.unassigned.length === 1, 'an animal-sized blob with no pose near it is nobody\'s, and listed');
    const near = { body: [200, 44], segments: [], tail: null };   // a pose just off the blob
    const r2 = computeOutlines(img, BG, W, H, [A, B, near], { median: 700, sd: 40, hi: 900 });
    check(at(r2, 200, 30) === 3 && r2.blobs.some(b => b.kind === 'near'), 'a pose within reach of it takes it');
}

console.log('\n9. A small bright piece next to one animal joins it (a forepaw the open cut off)');
{
    const paw = rect(91, 58, 96, 63, 200);           // 36 px, 5 px off the body (past what the close bridges)
    const img = frame(ellipse(60, 60, 26, 12), paw);
    const r = computeOutlines(img, BG, W, H, [mouse(60, 60, 1)], null);
    check(at(r, 94, 60) === 1 && r.animals[0].reattached > 0, `the paw is the mouse's (${r.animals[0].reattached} px)`);
    const r0 = computeOutlines(img, BG, W, H, [mouse(60, 60, 1)], null, { reattach: 0 });
    check(at(r0, 94, 60) === 0, 'reattach 0 turns it off');
}

console.log('\n10. Contours');
{
    const sq = new Uint8Array(W * H);
    for (let y = 10; y < 20; y++) for (let x = 10; x < 20; x++) sq[y * W + x] = 1;
    const p = traceBoundary(sq, W, H, 10 * W + 10, 1);
    check(p.length / 2 === 36, `a 10x10 square's boundary has 36 pixels (${p.length / 2})`);
    const dot = new Uint8Array(W * H); dot[5 * W + 5] = 1;
    check(traceBoundary(dot, W, H, 5 * W + 5, 1).length === 2, 'a single pixel');
    const line = new Uint8Array(W * H); for (let x = 30; x < 40; x++) line[50 * W + x] = 1;
    const lp = traceBoundary(line, W, H, 50 * W + 30, 1);
    check(lp.length / 2 === 18, `a one-pixel line is traced out and back (${lp.length / 2})`);
}

console.log('\n11. Skeletons: the tail chain and an animal from an instance');
{
    const slap = ['Nose', 'Ear_L', 'Ear_R', 'Neck', 'Trunk', 'TTI', 'Tail_0', 'Tail_1', 'Tail_2', 'TailTip'];
    const edges = [[0, 3], [1, 3], [2, 3], [3, 4], [4, 5], [5, 6], [6, 7], [7, 8], [8, 9]];
    const ch = tailChain(slap, edges);
    check(ch.tail.map(k => slap[k]).join() === 'TTI,Tail_0,Tail_1,Tail_2,TailTip', 'SLAP: TTI then Tail_0 … TailTip');
    check(!ch.isTail[5] && ch.isTail[6], 'TTI is body, Tail_0 is tail');
    const other = ['nose', 'spine', 'tail_tip', 'tail_base', 'tail_mid'];
    const ch2 = tailChain(other, [[0, 1], [1, 3], [3, 4], [4, 2]]);
    check(ch2.tail.map(k => other[k]).join() === 'spine,tail_base,tail_mid,tail_tip', 'tail_base … tail_tip, ordered by edges');
    check(tailChain(['a', 'b'], []).tail.length === 0, 'no tail nodes: no tail');
    const xy = [[10, 10], [12, 9], [12, 11], [15, 10], [20, 10], [25, 10], [30, 10], [35, 10], [NaN, NaN], [45, 10]];
    const inst = { numNodes: 10, hasPoint: k => !isNaN(xy[k][0]), getX: k => xy[k][0], getY: k => xy[k][1] };
    const a = animalFromInstance(inst, edges, ch);
    check(a.body.length === 12 && a.segments.length === 5 * 4, 'body: 6 points, 5 body edges (none into the tail)');
    check(a.tail.length === 8 && a.tail[0] === 25 && a.tail[6] === 45, 'tail: TTI, Tail_0, Tail_1, TailTip (the missing Tail_2 skipped)');
    check(normalizeAnimal({ body: [1, 2, NaN, 3], segments: [0, 0, 1, NaN], tail: [1, 1] }).body.length === 2, 'normalizeAnimal drops non-finite points, short tails');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
