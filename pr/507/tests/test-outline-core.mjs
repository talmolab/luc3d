/**
 * test-outline-core.mjs — pose/outline-core.js, the idtracker.ai-style animal
 * outlines (Romero-Ferrero et al. 2019): blobs against an empty arena with
 * hysteresis, open/close, minimum area and filled holes; the single-animal area
 * model; per-animal assignment (whole individual blobs, crossings split by
 * nearest BODY skeleton, the nearest animal for a blob nobody's pose is in);
 * tail tracing that stops at another animal's body core; small bright pieces
 * re-attached; contours; what one animal looks like learnt from blobs holding
 * one pose, and something bright touching an animal (its reflection, a lit
 * wall) kept off it. Synthetic images with exact answers. ESM, so
 * tests/run-mjs-tests.mjs picks it up.
 */
import {
    OUTLINE_PARAMS, outlineParams, rgbaToGray, medianImage, ellipseElement, morph, components, fillHoles,
    segmentBlobs, areaModel, computeOutlines, traceBoundary, pointInPolygon, tailChain, animalFromInstance, normalizeAnimal,
    keypointCheck, outlineSuspects, smoothTail, maskedMedian, poseMask, convexHull, singlePoseBlobs, poseAreaModel, tubeReach,
    mirrorEvidence, reflectingSurfaces,
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

console.log('\n2b. An animal that rests in one place is left out by its poses');
{
    // in 7 of 9 frames a mouse rests at (60, 60) (so the plain median keeps it); in 2 it is elsewhere
    const frames = [], poses = [];
    for (let i = 0; i < 9; i++) {
        const cx = i < 7 ? 60 : 160 + 30 * (i - 7);
        frames.push(frame(ellipse(cx, 60, 26, 12), hline(60, cx - 26, cx - 60)));
        poses.push([mouse(cx, 60, 1, 40)]);
    }
    const plain = medianImage(frames);
    check(plain[60 * W + 60] === 200, 'the plain median keeps the resting mouse (the ghost)');
    const masks = poses.map(p => poseMask(W, H, p));
    check(masks[0][60 * W + 60] === 1 && masks[0][60 * W + 30] === 1 && masks[0][20 * W + 200] === 0, 'the pose mask covers its body and tail, not the floor');
    const med = maskedMedian(frames, masks);
    let off = 0; for (let i = 0; i < W * H; i++) if (med[i] !== BG[i]) off++;
    check(off === 0, `with the poses, the empty arena is the floor everywhere (${off} pixels off)`);
    check(maskedMedian(frames, [null, null]) .length === W * H && convexHull([0, 0, 2, 0, 1, 1, 2, 2, 0, 2]).length === 8, 'no masks: the plain median; convex hull');
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

console.log('\n7b. …and never takes from a blob that is another animal\'s alone (topC 6,250 again)');
{
    // A and B apart; A's tail keypoints run across B's upper edge (the keypoints are wrong)
    const img = frame(ellipse(60, 60, 26, 12), hline(60, 34, 14), ellipse(150, 70, 30, 14));
    const A = mouse(60, 60, 1, 46);
    const Awrong = { body: A.body, segments: A.segments, tail: [38, 60, 14, 60, 100, 57, 185, 57] };   // …then on along B's top
    const r = computeOutlines(img, BG, W, H, [Awrong, mouse(150, 70, -1, 10)], { median: 1100, sd: 60, hi: 1400 });
    let stolen = 0;
    for (let y = 50; y < 64; y++) for (let x = 120; x < 181; x++) if (at(r, x, y) === 1) stolen++;
    check(r.blobs.filter(b => b.kind === 'individual').length === 2 && stolen === 0, `B's upper edge stays B's (${stolen} px taken)`);
    check(at(r, 20, 60) === 1, 'A\'s own tail is still traced');
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
    check(a.tailPts.length === 6 && a.tailPts[0] === 30, 'tail keypoints alone (for the check): Tail_0, Tail_1, TailTip');
    check(normalizeAnimal({ body: [1, 2, NaN, 3], segments: [0, 0, 1, NaN], tail: [1, 1] }).body.length === 2, 'normalizeAnimal drops non-finite points, short tails');
}

console.log('\n12. The DoublePoke skeleton: every tail node hangs off TTI (no tail path)');
{
    const dp = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
    const e = [[3, 5], [3, 7], [3, 8], [3, 9], [3, 12], [3, 13], [3, 6], [3, 4], [5, 0], [5, 14], [5, 10], [5, 11], [5, 1], [5, 2]];
    const ch = tailChain(dp, e);
    check(ch.tail.map(k => dp[k]).join() === 'TTI,Tail_0,Tail_1,Tail_2,TailTip', 'ordered by name: ' + ch.tail.map(k => dp[k]).join());
    const ch2 = tailChain(['b', 'tail_tip', 'tail_mid', 'tail_base'], [[0, 1], [0, 2], [0, 3]]);
    check(ch2.tail.map(k => ['b', 'tail_tip', 'tail_mid', 'tail_base'][k]).join() === 'b,tail_base,tail_mid,tail_tip', 'base, mid, tip by name');
}

console.log('\n13. A dim tail is still traced (tailThr below the bright level)');
{
    // 1 px wide and 17 over the floor: the open drops it from the blob, so only tracing can take it
    const dimTail = (x, y) => (y === 60 && x >= 6 && x <= 34 ? floor(x, y) + 17 : null);
    const img = frame(ellipse(60, 60, 26, 12), dimTail);
    const A = mouse(60, 60, 1, 50);
    const r = computeOutlines(img, BG, W, H, [A], null);
    check(at(r, 20, 60) === 1, 'the dim tail is the mouse\'s');
    const r2 = computeOutlines(img, BG, W, H, [A], null, { tailThr: 22 });
    check(at(r2, 20, 60) === 0, 'and not at the bright level');
}

console.log('\n14. Keypoints that disagree with the outline');
{
    const img = frame(ellipse(60, 60, 26, 12), ellipse(170, 110, 26, 12));
    const A = mouse(60, 60, 1, 40), B = mouse(170, 110, -1, 40);
    const r = computeOutlines(img, BG, W, H, [A, B], null);
    const animals = [{ body: A.body, tailPts: [30, 60, 20, 60] }, { body: B.body.concat([60, 60, 70, 60]), tailPts: [200, 110] }];
    const chk = keypointCheck(r.labels, W, H, animals, 3);
    check(chk[0].tail === 2 && chk[0].tailOut === 2 && chk[0].bodyOut === 0, 'A: its two tail keypoints are off its outline (no tail in the image)');
    check(chk[1].bodyOther === 2 && chk[1].tailOut === 1, 'B: two body keypoints on A\'s outline; one tail keypoint off');
    const sus = outlineSuspects(chk, r.animals.map(a => a.area), ['A', 'B']);
    check(sus.length === 2 && sus[0].reason === 'tail' && /2 of 2 tail keypoints outside A/.test(sus[0].detail), 'A suspect: ' + (sus[0] && sus[0].detail));
    check(sus[1] && sus[1].reason === 'split' && /on A/.test(sus[1].detail), 'B suspect: ' + (sus[1] && sus[1].detail));
    const none = outlineSuspects(keypointCheck(r.labels, W, H, [{ body: [60, 60, 70, 60, 50, 60], tailPts: [] }, { body: [], tailPts: [] }], 3), [100, 0], ['A', 'B']);
    check(none.length === 0, 'a pose its outline covers is no suspect');
    const miss = outlineSuspects([{ body: 5, bodyOut: 5, bodyOther: 0, tail: 0, tailOut: 0, tailOther: 0, out: [] }], [0], ['C']);
    check(miss.length === 1 && miss[0].reason === 'missed', 'a pose with no outline: missed animal');
}

console.log('\n15. Only visible misses count; a bent tail is followed (smooth curve)');
{
    const img = frame(ellipse(60, 60, 26, 12), ellipse(170, 110, 26, 12), hline(110, 196, 236));
    const A = mouse(60, 60, 1, 40), B = mouse(170, 110, -1, 40);
    A.tailPts = [30, 60, 20, 60];                    // over plain floor: no tail in the image
    B.tailPts = [205, 110, 225, 110];
    const r = computeOutlines(img, BG, W, H, [A, B], null);
    check(r.check && r.check[0].tail === 2 && r.check[0].tailOut === 0, 'tail keypoints over plain floor are not the outline\'s fault');
    check(r.check[1].tailOut === 0, 'a traced tail covers its keypoints');
    const A2 = mouse(60, 60, 1, 40); A2.tailPts = [205, 110, 225, 110];          // on B's tail: visible, someone else's
    const r2 = computeOutlines(img, BG, W, H, [A2, B], null);
    check(r2.check[0].tailOut === 2 && r2.check[0].tailOther === 2, 'tail keypoints on another animal\'s tail count');
    const A3h = mouse(60, 60, 1, 40); A3h.tailPts = [165, 110, 175, 110];        // deep in B's body: hidden behind it
    const r3h = computeOutlines(img, BG, W, H, [A3h, B], null);
    check(r3h.check[0].tailOut === 0, 'tail keypoints deep inside another animal\'s body are a hidden tail, not counted');
    // five keypoints on a circle (centre (40,36), radius 26, every 40 degrees): between two of
    // them the tail runs 1.6 px outside the straight chord; the smoothed tail stays on it
    const onArc = (deg) => [40 + 26 * Math.cos(deg * Math.PI / 180), 36 + 26 * Math.sin(deg * Math.PI / 180)];
    const sm = smoothTail([110, 150, 190, 230, 270].map(onArc).flat(), 16);
    const mid = onArc(170);
    let near = Infinity;
    for (let i = 0; i < sm.length; i += 2) near = Math.min(near, Math.hypot(sm[i] - mid[0], sm[i + 1] - mid[1]));
    check(near < 0.5, `the smoothed tail follows the bend: ${near.toFixed(2)} px from the arc (the chord: 1.57)`);
    check(smoothTail([0, 0, 10, 0, 20, 0], 4).length === 2 + 2 * 2 * 4, 'smoothTail samples each segment');
}

console.log('\n16. What one animal looks like, from blobs holding one pose (reflections and crossings don\'t count)');
{
    // A alone; B and C touching (two poses, one blob); a reflection with no pose
    const img = frame(ellipse(60, 40, 26, 12), hline(40, 34, 14), ellipse(150, 40, 26, 12), ellipse(200, 40, 26, 12), ellipse(100, 120, 26, 12));
    const seg = segmentBlobs(img, BG, W, H);
    const A = mouse(60, 40, 1, 40), B = mouse(150, 40, 1, 0), C = mouse(200, 40, -1, 0);
    const s1 = singlePoseBlobs(seg, W, H, [A, B, C]);
    check(s1.length === 1 && s1[0].animal === 0, `only the blob holding one pose counts (${s1.length}: not the crossing, not the reflection)`);
    check(s1[0].reach >= 9 && s1[0].reach <= 14, `its reach is the body's half width, tail included as tail (${s1[0].reach.toFixed(1)} px)`);
    const apart = segmentBlobs(frame(ellipse(60, 40, 26, 12), ellipse(140, 40, 26, 12), ellipse(210, 40, 26, 12), ellipse(100, 120, 26, 12)), BG, W, H);
    check(apart.n === 4 && areaModel([Array.from(apart.area.slice(1))], 3) === null, 'counting blobs, a camera that also sees a reflection has no frame with as many blobs as animals, even with all apart');
    const singles = [{ frame: 0, area: 1000, reach: 12 }, { frame: 1, area: 1050, reach: 13 }, { frame: 2, area: 980, reach: 11 }, { frame: 2, area: 5000, reach: 60 }];
    const m = poseAreaModel(singles);
    check(m && m.median === 1025 && m.reach === 12.5 && m.frames === 3 && m.n === 4 && m.source === 'poses', 'median area and reach over the blobs, frames counted');
    check(m.sd < 100 && m.hi < 1500, `a blob with something attached does not widen the model (robust s.d. ${m.sd.toFixed(0)})`);
    check(poseAreaModel(singles.slice(0, 2)) === null && poseAreaModel(null) === null, 'fewer than 3 blobs: no model');
}

console.log('\n17. Something bright touching an animal is not the animal (its reflection, a lit wall)');
{
    const model = { median: 900, sd: 60, lo: 660, hi: 4000, reach: 12 };          // lim = 1.5 x 12 = 18 px
    const A = mouse(100, 60, 1, 40);                                              // body x 80..122 on y = 60
    const reflection = ellipse(100, 83, 26, 12);                                 // overlaps the body's edge at y = 71
    const lit = (x, y) => (x >= 126 && x <= 200 && y >= 40 && y <= 80 ? floor(x, y) + 15 : null);   // dim, joined by hysteresis
    const img = frame(ellipse(100, 60, 26, 12), hline(60, 74, 40), reflection, lit);
    const seg = segmentBlobs(img, BG, W, H);
    check(seg.n === 1 && seg.blob[84 * W + 100] === seg.blob[60 * W + 100] && seg.blob[60 * W + 180] === seg.blob[60 * W + 100], 'mouse, reflection and lit wall are one blob');
    const r0 = computeOutlines(img, BG, W, H, [A], null);
    check(at(r0, 100, 90) === 1 && at(r0, 180, 60) === 1, 'without a model (no reach known) the blob is the mouse\'s whole, as before');
    const r = computeOutlines(img, BG, W, H, [A], model);
    check(at(r, 100, 62) === 1 && at(r, 100, 70) === 1 && at(r, 124, 60) === 1, 'the body stays the mouse\'s');
    check(at(r, 100, 90) === 0 && at(r, 100, 94) === 0, 'the reflection beyond its reach is not');
    check(at(r, 180, 60) === 0 && at(r, 160, 45) === 0, 'nor the lit wall beyond it');
    check(at(r, 45, 60) === 1 && at(r, 60, 60) === 1, 'the tail along its line stays (beyond the body\'s reach)');
    check(r.blobs[0].beyond > 1500 && r.animals[0].area < seg.area[1] - 1500, `pixels beyond reach are counted, not given (${r.blobs[0].beyond})`);
    check(r.unassigned.length >= 1, 'an animal-sized part beyond reach is shown as nobody\'s');
    const r2 = computeOutlines(img, BG, W, H, [A], model, { envelope: 0 });
    check(at(r2, 100, 90) === 1, 'envelope 0 turns the limit off');
}

console.log('\n18. In a crossing too: each animal\'s part, and nothing beyond');
{
    const model = { median: 900, sd: 60, lo: 660, hi: 4000, reach: 12 };
    const A = mouse(70, 60, 1, 0), B = mouse(130, 60, -1, 0);
    const img = frame(ellipse(70, 60, 26, 12), ellipse(130, 60, 26, 12), ellipse(100, 83, 56, 12));   // both reflected below
    const r = computeOutlines(img, BG, W, H, [A, B], model);
    check(r.blobs[0].kind === 'crossing' && at(r, 60, 60) === 1 && at(r, 140, 60) === 2, 'the crossing is split between the two');
    check(at(r, 100, 92) === 0 && at(r, 70, 92) === 0 && at(r, 130, 92) === 0, 'their reflection is nobody\'s');
}

console.log('\n19. With the 3D pose: the body as it is in 3D, projected (a reflection beside it falls outside)');
{
    check(Math.abs(tubeReach([0, 0, 2, 10, 0, 4], 5, 6) - 2) < 1e-9, 'distance to the projected edge over the scale where it is closest (6 px at 3 px per unit = 2)');
    check(tubeReach([0, 0, 2, 10, 0, 4], 14, 0) === 1 && tubeReach([], 1, 1) === Infinity, 'past the end: the end\'s scale; no edges: Infinity');
    // the body x 80..122 on y = 60 at 1 px per unit; its reflection touches it below (section 17)
    const tubes = [80, 60, 1, 101, 60, 1, 101, 60, 1, 122, 60, 1];
    const A = Object.assign(mouse(100, 60, 1, 40), { tubes, tubeError: 0 });
    const img = frame(ellipse(100, 60, 26, 12), hline(60, 74, 40), ellipse(100, 83, 26, 12));
    const m2 = { median: 900, sd: 60, lo: 660, hi: 4000, reach: 12 };            // 2D: 18 px
    const m3 = Object.assign({}, m2, { reach3d: 10 });                          // 3D: 12.5 units = 12.5 px here
    const r2 = computeOutlines(img, BG, W, H, [A], m2), r3 = computeOutlines(img, BG, W, H, [A], m3);
    check(at(r2, 100, 76) === 1 && at(r3, 100, 76) === 0, 'the band of reflection the 2D limit keeps (16 px from the skeleton) is cut with 3D');
    check(at(r3, 100, 70) === 1 && at(r3, 122, 62) === 1 && at(r3, 45, 60) === 1, 'the body and the tail stay');
    check(r3.animals[0].by3d === true && r2.animals[0].by3d === false, 'the result says which rule each animal used');
    const bad = Object.assign({}, A, { tubeError: 40 });                        // 3D 40 px off the 2D pose
    const rb = computeOutlines(img, BG, W, H, [bad], m3);
    check(rb.animals[0].by3d === false && at(rb, 100, 76) === 1, '3D that disagrees with the 2D pose (more than half the limit) is not used: the 2D rule');
    const r0 = computeOutlines(img, BG, W, H, [A], m3, { envelope3d: 0 });
    check(r0.animals[0].by3d === false && at(r0, 100, 76) === 1, 'envelope3d 0: the 2D rule');
    // a projected body twice as large at its head end (nearer the camera) reaches further there
    const near = Object.assign(mouse(100, 60, 1, 0), { tubes: [80, 60, 1, 122, 60, 2], tubeError: 0 });
    const rn = computeOutlines(frame(ellipse(100, 60, 30, 20)), BG, W, H, [near], m3);
    check(rn.blob === undefined && at(rn, 114, 77) === 1 && at(rn, 86, 77) === 0, 'the limit follows the image scale along the body (17 px below it: kept near the near end, cut near the far end)');
    // learning: the blob's 3D half-width, tail pixels left out
    const seg = segmentBlobs(frame(ellipse(60, 40, 26, 12), hline(40, 34, 14)), BG, W, H);
    const one = Object.assign(mouse(60, 40, 1, 40), { tubes: [40, 40, 1, 82, 40, 1], tubeError: 0 });
    const s3 = singlePoseBlobs(seg, W, H, [one]);
    check(s3.length === 1 && s3[0].reach3d >= 9 && s3[0].reach3d <= 13, `a blob holding one pose with 3D gives the body's half-width in units (${s3[0].reach3d && s3[0].reach3d.toFixed(1)})`);
    const s3b = singlePoseBlobs(seg, W, H, [Object.assign({}, one, { tubeError: 30 })]);
    check(s3b.length === 1 && s3b[0].reach3d === undefined, 'with 3D off the 2D pose, no 3D half-width from it');
    const ms = poseAreaModel([{ frame: 0, area: 1000, reach: 12, reach3d: 10 }, { frame: 1, area: 1000, reach: 12, reach3d: 11 }, { frame: 2, area: 1000, reach: 12 }, { frame: 3, area: 1000, reach: 12, reach3d: 30 }]);
    check(ms.reach3d === 11 && ms.n3d === 3, 'the model takes the median 3D half-width over the blobs that had 3D');
    check(poseAreaModel([{ frame: 0, area: 1000, reach: 12, reach3d: 10 }, { frame: 1, area: 1000, reach: 12 }, { frame: 2, area: 1000, reach: 12 }]).reach3d === undefined, 'fewer than 3 with 3D: none (the 2D rule)');
}

console.log('\n20. A reflection touching the animal, where the arena\'s wall is known (campy cage)');
{
    // the body x 80..122 on y = 60 (1 px per unit); it touches its mirror image below,
    // whose mirrored body lies on y = 83 (the mirror line at y = 71.5, the body's edge)
    const tubes = [80, 60, 1, 101, 60, 1, 101, 60, 1, 122, 60, 1];
    const mirror = [80, 83, 1, 101, 83, 1, 101, 83, 1, 122, 83, 1];
    const A = Object.assign(mouse(100, 60, 1, 40), { tubes, tubeError: 0, mirrors: [{ plane: 2, tubes: mirror }] });
    const img = frame(ellipse(100, 60, 26, 12), hline(60, 74, 40), ellipse(100, 83, 26, 12));
    const m = { median: 900, sd: 60, lo: 660, hi: 4000, reach: 12, reach3d: 16 };    // 3D limit 20 units: the band passes it
    const r0 = computeOutlines(img, BG, W, H, [A], m);
    check(at(r0, 100, 76) === 1 && at(r0, 100, 79) === 1, 'without the wall known to reflect, the band near the body is the mouse\'s');
    const mm = Object.assign({}, m, { mirrors: [{ plane: 2, n: 40, hits: 38 }] });
    const r = computeOutlines(img, BG, W, H, [A], mm);
    check(at(r, 100, 76) === 0 && at(r, 100, 79) === 0, 'with it, the reflection\'s pixels nearer its mirror image than the body are nobody\'s');
    check(at(r, 100, 68) === 1 && at(r, 100, 70) === 1 && at(r, 45, 60) === 1, 'the body up to its edge, and the tail, stay the mouse\'s');
    check(r.blobs[0].mirrored > 300, `pixels left to the reflection are counted (${r.blobs[0].mirrored})`);
    const other = Object.assign({}, mm, { mirrors: [{ plane: 4, n: 40, hits: 38 }] });
    check(at(computeOutlines(img, BG, W, H, [A], other), 100, 76) === 1, 'a surface that reflects is needed: another surface\'s images do nothing here');
    // which surfaces reflect: the images on bright pixels, or on floor
    const ev = mirrorEvidence(img, BG, W, H, [Object.assign({}, A, { mirrors: [{ plane: 2, tubes: mirror }, { plane: 3, tubes: [150, 130, 1, 200, 130, 1] }] })], 16);
    check(ev[2] && ev[2].n >= 2 && ev[2].hits === ev[2].n, `plane 2's images land on the reflection (${ev[2] && ev[2].hits} of ${ev[2] && ev[2].n})`);
    check(ev[3] && ev[3].n === 2 && ev[3].hits === 0, 'plane 3\'s land on floor');
    check(JSON.stringify(reflectingSurfaces({ 2: { n: 40, hits: 30 }, 3: { n: 40, hits: 2 }, 4: { n: 5, hits: 5 } }).map((x) => x.plane)) === '[2]',
        'a surface reflects with at least 20 images to judge by and half of them on something bright');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
