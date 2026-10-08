/**
 * test-session-node-order.mjs — replacing the PROJECT skeleton must re-order
 * each session's keypoint data by node NAME, never just rename its columns.
 *
 * A project has one skeleton shared by every session, and every keypoint is
 * stored by column. Three ACROSS-session paths replaced that skeleton's node
 * names without touching any session's columns — the multi-session folder
 * load (the LAST session's first camera named every session), the "Import
 * skeleton for all sessions" prompt, and a `skeleton.json` (parent folder or
 * session folder) — plus Load Skeleton and the single-`.slp` folder load's
 * `skeleton.json`. A session stored in another node order was silently
 * mis-named: geometry by column fine, everything by name wrong.
 *
 * What is pinned (`pose/session-node-order.js`, `Instance.permuteNodes`,
 * `SioLazyLoader.setTargetNodeOrder` / `permuteNodes`):
 *   1. one Instance: coordinates (NaN included), occlusion as a Number (<= 32
 *      nodes) and as a Uint32Array (> 32), the backup, `nulledNodes` re-keyed,
 *      the shared lazy placeholder never written, a node-count mismatch
 *      skipped;
 *   2. a whole eager session: linked + unlinked instances, group members
 *      that ARE the linked instances, two Instances SHARING one `_xy` (the
 *      lazy hydration alias), pooled `points3d`, raw `reprojections`,
 *      `reprojectedInstances`, and `triangulationResults` entries sharing
 *      their group's arrays — every value lands under its own name, every
 *      shared buffer moved exactly ONCE (a double move is a wrong answer
 *      that looks plausible);
 *   3. adoption across sessions: same order untouched (bit-identical),
 *      another order re-ordered, other names reported and untouched, an
 *      empty session skipped, a lazy loader that refuses leaves its session
 *      wholly untouched; and the status text names each;
 *   4. `SioLazyLoader` (with stub stores): an explicit target re-orders every
 *      camera's store and survives later opens; `permuteNodes` composes;
 *      it refuses while a camera is loaded by column; `openProjectSlp`'s ONE
 *      shared store is re-ordered once, not once per camera.
 *
 * A negative control in §2 checks the by-name checker itself: renaming without
 * re-ordering (what the old code did) must FAIL it.
 *
 * The real-file half — the loaders, the prompt, Load Skeleton, the
 * multi-session save's re-open — is tests/e2e/multi-session-skeleton-order.mjs.
 */
import {
    Skeleton, Session, FrameGroup, Instance, InstanceGroup, UnlinkedInstance,
    lazyPlaceholderXY, pooledPoints3d,
} from '../pose/pose-data.js';
import {
    permuteSessionNodes, adoptSkeletonNodeOrder, describeSkeletonAdoption,
} from '../pose/session-node-order.js';
import { nodeOrderRemap } from '../loading/slp-skeleton.js';
import { SioLazyLoader } from '../loading/sio-lazy-loader.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const eq = (a, b) => JSON.stringify(a) === JSON.stringify(b);

// Every value encodes its node NAME: code(name) = position in NAMES + 1.
const NAMES = ['Nose', 'Ear_R', 'Ear_L', 'Head', 'Neck', 'Trunk'];
const code = n => NAMES.indexOf(n) + 1;
const OCCLUDED = new Set(['Ear_L', 'Trunk']);
const NULLED = new Set(['Neck']);
const MISSING = 'Head';   // no point (NaN) on every instance

function makeInstance(order, t, type) {
    const xy = new Float64Array(order.length * 2);
    order.forEach((n, k) => {
        xy[2 * k] = n === MISSING ? NaN : 100 * code(n) + t;
        xy[2 * k + 1] = n === MISSING ? NaN : code(n) + 0.5;
    });
    const inst = new Instance(xy, t, type || 'predicted', 0.9);
    order.forEach((n, k) => { if (OCCLUDED.has(n)) inst.setOccluded(k, true); });
    return inst;
}

/** Problems with `inst` read under `order` (empty = every node under its own name). */
function instProblems(inst, order, t, where) {
    const bad = [];
    order.forEach((n, k) => {
        const x = inst.getX(k), y = inst.getY(k);
        if (n === MISSING) { if (!Number.isNaN(x)) bad.push(`${where} ${n}: expected NaN, got ${x}`); return; }
        if (x !== 100 * code(n) + t || y !== code(n) + 0.5) bad.push(`${where} ${n} at (${x},${y})`);
        if (inst.isOccluded(k) !== OCCLUDED.has(n)) bad.push(`${where} ${n} occlusion ${inst.isOccluded(k)}`);
    });
    return bad;
}
const p3 = n => [10 * code(n), 10 * code(n) + 1, 10 * code(n) + 2];

console.log('\n1. Instance.permuteNodes');
{
    const from = NAMES.slice();
    const to = NAMES.slice().reverse();
    const perm = nodeOrderRemap(to, from).perm;

    const inst = makeInstance(from, 1);
    inst.backupPoints();
    inst.setPoint(0, -1, -1);   // an edit since the backup (Nose)
    inst.nulledNodes = new Set([from.indexOf('Neck')]);
    check(inst.permuteNodes(perm, new Set()), 'permutes an instance of the skeleton\'s length');
    const bad = instProblems(inst, to, 1, 'inst').filter(s => !/^inst Nose/.test(s));
    check(bad.length === 0, 'every node\'s coordinates, NaN and occlusion move with it' + (bad.length ? ' — ' + bad.join('; ') : ''));
    const k = to.indexOf('Nose');
    check(inst.getX(k) === -1, 'the edited node keeps its edit, at its new position');
    inst.restorePoints();
    check(instProblems(inst, to, 1, 'restored').length === 0, 'the BACKUP moved too: restorePoints() comes back in the new order');
    check(eq(Array.from(inst.nulledNodes), [to.indexOf('Neck')]), 'nulledNodes re-keyed to the node\'s new index');

    // > 32 nodes: occlusion is a Uint32Array.
    const big = Array.from({ length: 40 }, (_, i) => 'n' + i);
    const bigTo = big.slice().reverse();
    const bi = new Instance(new Float64Array(80).map((_, i) => i), 0, 'user', 1);
    bi.setOccluded(3, true); bi.setOccluded(35, true);
    bi.permuteNodes(nodeOrderRemap(bigTo, big).perm, new Set());
    check(bi.isOccluded(bigTo.indexOf('n3')) && bi.isOccluded(bigTo.indexOf('n35'))
        && [...Array(40).keys()].filter(i => bi.isOccluded(i)).length === 2,
        '40 nodes: a Uint32Array occlusion set moves its bits with the nodes');
    check(bi.getX(bigTo.indexOf('n7')) === 14, '40 nodes: coordinates move');

    const ph = new Instance(lazyPlaceholderXY(NAMES.length), 0, 'predicted', 1);
    const before = ph._xy;
    ph.permuteNodes(perm, new Set());
    check(ph._xy === before && ph._xy === lazyPlaceholderXY(NAMES.length) && ph._xy.every(Number.isNaN),
        'the shared lazy placeholder is never written');

    const short = makeInstance(NAMES.slice(0, 4), 0);
    check(!short.permuteNodes(perm, new Set()), 'an instance of another node count is skipped');

    const seen = new Set();
    const once = makeInstance(from, 2);
    once.permuteNodes(perm, seen);
    check(!once.permuteNodes(perm, seen) && instProblems(once, to, 2, 'once').length === 0,
        'the same Instance reached twice moves once');
}

console.log('\n2. permuteSessionNodes — a whole eager session');
function buildSession(name, order) {
    const s = new Session([], new Skeleton('sk', order.slice(), [[0, 1]]), ['t0', 't1'], name);
    const fg = new FrameGroup(0);
    s.addFrameGroup(fg);
    // Frame 0: one group over track 0 (camA + camB, linked), unlinked track 1.
    const a0 = makeInstance(order, 0), b0 = makeInstance(order, 0);
    fg.addInstance('camA', a0); fg.addInstance('camB', b0);
    fg.addUnlinkedInstance('camA', new UnlinkedInstance(makeInstance(order, 1), 'camA'));
    const g = new InstanceGroup(1, 0);
    g.addInstance('camA', a0); g.addInstance('camB', b0);
    g.points3d = pooledPoints3d(Float64Array.from(order.flatMap(p3)));
    const rep = n => [code(n) + 0.25, code(n) + 0.75];
    g.reprojections = { camA: order.map(rep), camB: order.map(rep) };
    g.addReprojectedInstance('camA', makeInstance(order, 0, 'reprojected'));
    s.instanceGroups.set(0, [g]);
    // Frame 1: a member on a NON-resident frame that shares its 2D with a
    // resident instance — the lazy hydration alias (`adoptPointsFrom`).
    const fg1 = new FrameGroup(1);
    s.addFrameGroup(fg1);
    const resident = makeInstance(order, 1);
    fg1.addUnlinkedInstance('camB', new UnlinkedInstance(resident, 'camB'));
    const g1 = new InstanceGroup(2, 1);
    const alias = new Instance(lazyPlaceholderXY(order.length), 1, 'predicted', 0.9);
    alias.adoptPointsFrom(resident);
    g1.addInstance('camB', alias);
    g1.points3d = Float64Array.from(order.flatMap(p3));
    s.instanceGroups.set(1, [g1]);
    // Results: frame 0 shares the group's points3d + reprojections; its own errors.
    const results = new Map([[0, [{
        group: g, points3d: g.points3d, reprojections: g.reprojections,
        errors: { camA: order.map(n => code(n) / 100) }, errorsUndistorted: { camA: order.map(n => code(n) / 1000) },
    }]]]);
    s.triangulationResults = results;
    return { s, g, g1, a0, b0, resident, alias, results };
}

/** Every per-node value of `s`, read under `order`: a list of problems. */
function sessionProblems(x, order) {
    const bad = [];
    const { s, g, g1, results } = x;
    for (const [f, fg] of s.frameGroups) {
        for (const [cam, list] of fg.instances) list.forEach(i => bad.push(...instProblems(i, order, i.trackIdx, `f${f} ${cam}`)));
        for (const [cam, list] of fg.unlinkedInstances) list.forEach(u => bad.push(...instProblems(u.instance, order, u.instance.trackIdx, `f${f} ${cam} unlinked`)));
    }
    for (const grp of [g, g1]) for (const [cam, i] of grp.instances) bad.push(...instProblems(i, order, i.trackIdx, `group ${grp.id} ${cam}`));
    bad.push(...instProblems(g.reprojectedInstances.get('camA'), order, 0, 'reprojected'));
    for (const grp of [g, g1]) order.forEach((n, k) => {
        if (!eq(Array.from(grp.points3d.subarray(3 * k, 3 * k + 3)), p3(n))) bad.push(`group ${grp.id} points3d ${n}`);
    });
    for (const cam of ['camA', 'camB']) order.forEach((n, k) => {
        if (!eq(g.reprojections[cam][k], [code(n) + 0.25, code(n) + 0.75])) bad.push(`reprojections ${cam} ${n}`);
    });
    const r = results.get(0)[0];
    order.forEach((n, k) => {
        if (r.errors.camA[k] !== code(n) / 100) bad.push('errors ' + n);
        if (r.errorsUndistorted.camA[k] !== code(n) / 1000) bad.push('errorsUndistorted ' + n);
    });
    return bad;
}
{
    const from = NAMES.slice();
    const to = ['Trunk', 'Nose', 'Neck', 'Ear_L', 'Ear_R', 'Head'];   // not an involution: a double move shows
    const x = buildSession('eager', from);
    check(sessionProblems(x, from).length === 0, 'fixture: every value reads correctly under its own order');
    // Negative control: renaming the columns without moving the data — what
    // the old code did — must fail the same checker.
    check(sessionProblems(x, to).length > 0, 'negative control: the data read under the NEW names without re-ordering is wrong');

    const perm = nodeOrderRemap(to, from).perm;
    // The ACTIVE session's results sit on `state.triangulationResults`, which
    // is usually the SAME Map — passing it twice must not move it twice.
    const res = permuteSessionNodes(x.s, perm, { triangulationResults: x.results });
    check(res.ok && res.groups === 2, `ok, both groups visited (${JSON.stringify(res)})`);
    const bad = sessionProblems(x, to);
    check(bad.length === 0, 'every instance, 3D point, reprojection and per-node error is under its own name' + (bad.length ? ' — ' + bad.slice(0, 5).join('; ') : ''));
    check(x.alias._xy === x.resident._xy, 'the hydration alias still shares ONE buffer with its resident instance');
    check(x.g.reprojections === x.results.get(0)[0].reprojections, 'the result entry still shares its group\'s reprojections');
}

console.log('\n3. adoptSkeletonNodeOrder — across sessions');
{
    const to = ['Trunk', 'Nose', 'Neck', 'Ear_L', 'Ear_R', 'Head'];
    const same = buildSession('same', to);
    const other = buildSession('other', NAMES.slice());
    const renamed = buildSession('renamed', NAMES.map(n => n === 'Nose' ? 'Snout' : n));
    const empty = new Session([], new Skeleton('sk', [], []), ['t0'], 'empty');
    const lazy = buildSession('lazy', NAMES.slice());
    lazy.s.lazyLoader = { permuteNodes: () => ({ ok: false, reason: 'cam3 loaded by column under other node names' }) };
    const snapshot = x => JSON.stringify([...x.s.frameGroups.values()].map(fg =>
        [...fg.instances.values(), ...[...fg.unlinkedInstances.values()].map(l => l.map(u => u.instance))]
            .flat().map(i => Array.from(i._xy, v => Number.isNaN(v) ? 'nan' : v))));
    const before = { same: snapshot(same), renamed: snapshot(renamed), lazy: snapshot(lazy) };

    const report = adoptSkeletonNodeOrder([same.s, other.s, renamed.s, empty, lazy.s, other.s], { nodes: to });
    check(eq(report.reordered.map(e => e.name), ['other']), `re-ordered: only "other" (${JSON.stringify(report.reordered.map(e => e.name))})`);
    check(sessionProblems(other, to).length === 0, '"other" now reads correctly under the new names');
    check(snapshot(same) === before.same, '"same" (already in that order) is bit-identical');
    check(eq(report.mismatched.map(e => [e.name, e.missing, e.extra]), [['renamed', ['Nose'], ['Snout']]]),
        'different names are reported with what is missing and extra');
    check(snapshot(renamed) === before.renamed, '... and that session is left as it was');
    check(eq(report.refused.map(e => e.name), ['lazy']) && /cam3/.test(report.refused[0].reason),
        'a lazy loader that refuses is reported with its reason');
    check(snapshot(lazy) === before.lazy && sessionProblems(lazy, NAMES).length === 0,
        '... and NOTHING of that session moves (no half re-order)');
    const d = describeSkeletonAdoption(report);
    check(d.warn && /re-ordered other into/.test(d.text) && /node names differ in renamed/.test(d.text)
        && /could not re-order lazy \(cam3/.test(d.text) && /node names may be wrong$/.test(d.text),
        `the status text names each (${d.text})`);
    check(eq(describeSkeletonAdoption(adoptSkeletonNodeOrder([same.s], { nodes: to })), { text: '', warn: false }),
        'nothing to say when every session is already in the order');
}

console.log('\n4. SioLazyLoader — stores re-ordered by name, the order recorded');
{
    // A stub lazy store: instance j of camera c has its 6 point rows encoded
    // by NAME (x = code, y = 10 * j), in the camera's own column order.
    function stubLabels(order, nInst) {
        const n = order.length;
        const x = new Float64Array(n * nInst), y = new Float64Array(n * nInst);
        for (let j = 0; j < nInst; j++) order.forEach((nm, k) => { x[j * n + k] = code(nm); y[j * n + k] = 10 * j; });
        let cleared = 0;
        return {
            _lazyDataStore: {
                instancesData: {
                    instance_type: new Float64Array(nInst).fill(1),
                    point_id_start: Float64Array.from({ length: nInst }, (_, j) => j * n),
                    point_id_end: Float64Array.from({ length: nInst }, (_, j) => (j + 1) * n),
                },
                pointsData: { x: new Float64Array(0), y: new Float64Array(0) },
                predPointsData: { x, y },
            },
            _lazyFrameList: { clearCache() { cleared++; } },
            get cleared() { return cleared; },
        };
    }
    const storeNames = (labels, j) => {
        const st = labels._lazyDataStore, n = NAMES.length, out = [];
        for (let k = 0; k < n; k++) out.push(NAMES[st.predPointsData.x[j * n + k] - 1]);
        return out;
    };
    // `open()` needs HDF5; register cameras the way it does.
    function fakeOpen(L, cam, order) {
        const labels = stubLabels(order, 2);
        L.labelsByCam.set(cam, labels);
        L._skeletonByCam.set(cam, { name: 'sk', nodes: order, edges: [] });
        L.skeleton = null;
        for (const c of [...L._skeletonByCam.keys()].sort()) if (!L.skeleton) { L.skeleton = L._skeletonByCam.get(c); L.skeletonCam = c; }
        L._nodeOrderByCam.set(cam, order.slice());
        L._unifyNodeOrder();
        return labels;
    }
    const REV = NAMES.slice().reverse();
    const ROT = NAMES.slice(2).concat(NAMES.slice(0, 2));

    const L = new SioLazyLoader();
    L.setTargetNodeOrder(REV);   // a later session of a multi-session load: the project's order
    const a = fakeOpen(L, 'a', NAMES), b = fakeOpen(L, 'b', ROT);
    check(eq(L.nodeOrder, REV), 'nodeOrder is the explicit target, not the first camera\'s');
    check(eq(storeNames(a, 0), REV) && eq(storeNames(a, 1), REV) && eq(storeNames(b, 1), REV),
        'every camera opened AFTER the target was set is re-ordered into it');
    check(a.cleared > 0 && b.cleared > 0, 're-ordered stores drop their materialized-frame cache');

    const perm = nodeOrderRemap(NAMES, REV).perm;   // adopt NAMES on top
    check(L.permuteNodes(perm).ok && eq(L.targetNodeOrder, NAMES) && eq(storeNames(a, 0), NAMES) && eq(storeNames(b, 0), NAMES),
        'permuteNodes composes with the current order and RECORDS the result (what the save re-open repeats)');

    const L2 = new SioLazyLoader();
    L2.setTargetNodeOrder(NAMES);
    fakeOpen(L2, 'a', NAMES);
    fakeOpen(L2, 'top', NAMES.map(n => n === 'Nose' ? 'Snout' : n));
    check(eq([...L2.nodeOrderMismatches.keys()], ['top']), 'a camera with other names is reported against the target');
    const refused = L2.permuteNodes(nodeOrderRemap(REV, NAMES).perm);
    check(!refused.ok && /top/.test(refused.reason) && eq(L2.targetNodeOrder, NAMES),
        'permuteNodes refuses while a camera is loaded by column, and changes nothing');
    check(!L2.permuteNodes([0, 1]).ok, 'permuteNodes refuses a permutation of another length');

    // openProjectSlp: every camera maps to ONE shared store.
    const P = new SioLazyLoader();
    const shared = stubLabels(NAMES, 3);
    P._sharedStore = true; P._projectLabels = shared;
    P.skeleton = { name: 'sk', nodes: NAMES, edges: [] };
    P._sharedNodeOrder = NAMES.slice();
    for (const cam of ['c0', 'c1', 'c2']) P.labelsByCam.set(cam, shared);
    check(P.permuteNodes(nodeOrderRemap(ROT, NAMES).perm).ok && eq(storeNames(shared, 2), ROT) && shared.cleared === 1,
        'a shared project store is re-ordered ONCE for all its cameras (three moves would be wrong)');

    L.close();
    check(L.targetNodeOrder === null, 'close() forgets the target');
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
