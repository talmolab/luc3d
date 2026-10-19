/**
 * test-frame-identity-map.mjs — `FrameIdentityMap` (pose/pose-data.js), the
 * typed-array storage behind `Session.frameIdentityMap`.
 *
 * It replaces a plain Map whose packed keys (`frameIdx * 2^23 + ...`) each cost
 * a heap Number, so it must BE a Map in every observable way — above all in
 * ITERATION ORDER, which `exportFrameIdentityEntries` writes to disk. The oracle
 * is a real Map driven through the same random operations in lockstep; after
 * every step the two must agree on size, every lookup tried, and the full
 * ordered entry list.
 *
 * Run:  node tests/test-frame-identity-map.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PD = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const { FrameIdentityMap, Session, Camera, Skeleton } = PD;

let passed = 0, failed = 0;
const failures = [];
function ok(cond, msg) {
    if (cond) passed++;
    else { failed++; failures.push(msg); console.error('  ✗ ' + msg); }
}
function group(name) { console.log('\n• ' + name); }
const sameEntries = (a, b) => {
    const x = [...a], y = [...b];
    if (x.length !== y.length) return false;
    for (let i = 0; i < x.length; i++) if (!Object.is(x[i][0], y[i][0]) || !Object.is(x[i][1], y[i][1])) return false;
    return true;
};

let seed = 12345;
const rnd = () => ((seed = (seed * 1664525 + 1013904223) >>> 0) / 4294967296);
const FIM_CAM = 2 ** 23, FIM_TRK = 2 ** 17;
const packed = () => Math.floor(rnd() * 200000) * FIM_CAM + Math.floor(rnd() * 8) * FIM_TRK + Math.floor(rnd() * 900);
const keyPool = [];
for (let i = 0; i < 400; i++) keyPool.push(packed());
keyPool.push('12:camA:null', '13:camB:null', NaN, 0, -0, 1.5, -7, 2 ** 53 - 1);
const anyKey = () => rnd() < 0.85 ? keyPool[Math.floor(rnd() * 400)] : keyPool[400 + Math.floor(rnd() * 8)];
const anyVal = () => { const r = rnd(); return r < 0.8 ? Math.floor(rnd() * 6) - 1 : r < 0.85 ? -0 : r < 0.9 ? null : r < 0.95 ? 'x' : NaN; };

group('it is a Map');
{
    const m = new FrameIdentityMap();
    ok(m instanceof Map && m instanceof FrameIdentityMap, 'instanceof Map');
    ok(Object.prototype.toString.call(m) === '[object Map]', 'toString tag');
    m.set(3 * FIM_CAM + 2, 7);
    ok(new Map(m).get(3 * FIM_CAM + 2) === 7, 'new Map(fim) copies it');
    ok([...m.keys()].length === 1 && [...m.values()][0] === 7 && [...m][0][1] === 7, 'keys/values/entries/spread');
    let n = 0; m.forEach(function (v, k, mm) { n++; ok(v === 7 && k === 3 * FIM_CAM + 2 && mm === m && this === 'T', 'forEach (value, key, map) with thisArg'); }, 'T');
    ok(n === 1, 'forEach visits each entry');
    ok(m.set(1, 2) === m, 'set returns the map');
}

group('random operations agree with a real Map, step by step (incl. order)');
{
    const A = new FrameIdentityMap(), B = new Map();
    let agree = true, steps = 0, compactions = 0, lastN = 0;
    for (let step = 0; step < 60000 && agree; step++) {
        const r = rnd(), k = anyKey();
        if (r < 0.55) { const v = anyVal(); A.set(k, v); B.set(k, v); }
        else if (r < 0.85) { ok(A.delete(k) === B.delete(k), 'delete agrees'); }
        else if (r < 0.9995) { if (!Object.is(A.get(k), B.get(k)) || A.has(k) !== B.has(k)) agree = false; }
        else { A.clear(); B.clear(); }
        if (A._n < lastN && A.size > 0) compactions++;
        lastN = A._n;
        if (A.size !== B.size) agree = false;
        if (step % 997 === 0 && !sameEntries(A, B)) agree = false;
        steps++;
    }
    ok(agree && sameEntries(A, B), `60,000 mixed set/delete/get/clear steps agree (size ${A.size})`);
    ok(compactions > 0, `the run exercised compaction (${compactions}x)`);
}

group('growth to a large, packed-key map keeps insertion order and lookups');
{
    const A = new FrameIdentityMap(), B = new Map();
    for (let f = 0; f < 60000; f++) for (let c = 0; c < 3; c++) {
        const k = f * FIM_CAM + c * FIM_TRK + (f % 5) + 1;
        A.set(k, f % 4); B.set(k, f % 4);
    }
    // re-setting existing keys keeps their position
    for (let f = 0; f < 60000; f += 7) { const k = f * FIM_CAM + (f % 5) + 1; A.set(k, 99); B.set(k, 99); }
    ok(A.size === 180000 && sameEntries(A, B), '180,000 entries, same order after in-place updates');
    let miss = 0;
    for (let f = 0; f < 60000; f += 13) { const k = f * FIM_CAM + 2 * FIM_TRK + (f % 5) + 1; if (A.get(k) !== B.get(k)) miss++; }
    ok(miss === 0, 'lookups agree');
    ok(A.get(123456789012345) === undefined && !A.has(-5), 'absent keys absent');
}

group('live iteration semantics');
{
    const A = new FrameIdentityMap(), B = new Map();
    for (let i = 0; i < 50; i++) { A.set(i * FIM_CAM, i); B.set(i * FIM_CAM, i); }
    const seenA = [], seenB = [];
    for (const [k, v] of A) { seenA.push(v); if (v % 3 === 0) A.delete(k); if (v === 10) A.delete(11 * FIM_CAM); if (v === 20) A.set(999 * FIM_CAM, 999); }
    for (const [k, v] of B) { seenB.push(v); if (v % 3 === 0) B.delete(k); if (v === 10) B.delete(11 * FIM_CAM); if (v === 20) B.set(999 * FIM_CAM, 999); }
    ok(JSON.stringify(seenA) === JSON.stringify(seenB), 'delete-during-iteration and add-during-iteration visit exactly what a Map visits');
    ok(sameEntries(A, B), '...and leave the same map');
    // clear during iteration ends it quietly, as a Map's does
    const C = new FrameIdentityMap([[1, 1], [2, 2], [3, 3]]);
    const seen = []; for (const [k] of C) { seen.push(k); if (k === 1) C.clear(); }
    ok(seen.length === 1 && C.size === 0, 'clear() during iteration ends it');
}

group('Session.frameIdentityMap is a FrameIdentityMap — and stays one');
{
    const cams = ['a', 'b'].map(n => new Camera(n, [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [10, 10]));
    const s = new Session(cams, new Skeleton('s', ['n'], []), ['t'], 'S');
    ok(s.frameIdentityMap instanceof FrameIdentityMap, 'a new Session has one');
    s.setFrameIdentity(500, 'b', 3, 2);
    ok(s.getFrameIdentityValue(500, 'b', 3) === 2 && s.hasFrameIdentity(500, 'b', 3), 'set/get/has through the Session');
    s.frameIdentityMap = new Map([[s._fimKey(1, 'a', 0), 4], ['9:b:null', 5]]);
    ok(s.frameIdentityMap instanceof FrameIdentityMap && s.frameIdentityMap.size === 2, 'assigning a plain Map converts it (order kept)');
    ok([...s.frameIdentityMap][1][0] === '9:b:null', 'legacy string keys survive');
    const exp = s.exportFrameIdentityEntries();
    ok(JSON.stringify(exp) === JSON.stringify([['1:a:0', 4]]), 'export: packed decoded, legacy null-track skipped (as before)');
    s.ingestFrameIdentityEntries([['700:a:2', 1], ['3:b:-1', -1]]);
    ok(s.frameIdentityMap instanceof FrameIdentityMap && s.getFrameIdentityValue(700, 'a', 2) === 1 && s.getFrameIdentityValue(3, 'b', -1) === -1,
        'ingest builds one');
    s.frameIdentityMap = null;
    ok(s.frameIdentityMap === null, 'null stays null');
}

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
