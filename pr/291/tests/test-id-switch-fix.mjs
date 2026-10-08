/**
 * test-id-switch-fix.mjs — fixing a flagged ID switch from the ID Switches tab.
 *
 *  1. `markChangePoints` names the other edge of every change point's swapped
 *     stretch: an onset's `switchBackAt` (the pair's encounter after the run, or
 *     null at the session end), an 'end''s `switchedAt` (the run's first
 *     encounter, or null when the run starts the session) — including a LONE
 *     middle flag, whose switch-back encounter is not itself a change point.
 *  2. `idSwitchFixPlan` turns a row into frames: the boundary is the current frame
 *     anywhere in the row's window (lead-in .. 1 s after), else e+1; an onset reaches its switch-back
 *     encounter's last close frame or the last frame; an 'end' covers the stretch
 *     before it. Partner rows are paired. Results restored from an older file
 *     (no link) fall back to the nearest change point of the same pair.
 *  3. `Session.swapIdentitiesInRange` swaps both structures inside the range and
 *     nothing outside it, is its own inverse, and `swapIdentitiesForward` (the
 *     1-9 keys) still reaches the end of the project.
 *  4. `idSwitchRenameForFix` renames other pairs' rows inside the stretch, leaves
 *     the fixed pair and rows outside alone, follows keys, and is an involution.
 *  5. The fixes and the links survive `serializeIdSwitchReview` →
 *     `ingestIdSwitchReview`, and garbage is ignored.
 *  6. `momentChangePoints`: one swapped stretch keeps ONE row, so one fix. A
 *     candidate moment's row takes over the encounter rows of its stretch (the
 *     run's onset after it — the 5-mouse topC case, where the moment's fix
 *     stopped at that onset and a second fix was needed — or just before it; the
 *     run's 'end' row for an 'end' moment), links to the stretch's real far
 *     edge, skips a moment that contradicts a run, and re-links follow-ons.
 *
 * Run: node tests/test-id-switch-fix.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(HERE, '..');
const PD = await import(pathToFileURL(path.join(ROOT, 'pose', 'pose-data.js')).href);
const SC = await import(pathToFileURL(path.join(ROOT, 'pose', 'id-switch-check.js')).href);
const RV = await import(pathToFileURL(path.join(ROOT, 'ui', 'id-switch-review.js')).href);

let passed = 0, failed = 0;
function ok(c, m) { if (c) { passed++; console.log('  ✓ ' + m); } else { failed++; console.error('  ✗ ' + m); } }

const O = { threshold: -50, continueBelow: 0, followSeconds: 60, fps: 30 };
// One pair (ids 0/1) meeting at frames 100, 200, … ; `bad` = indices scored as swapped.
function encounters(n, bad, pair = [0, 1], names = ['a', 'b']) {
    return Array.from({ length: n }, (_, i) => ({
        frame: 100 * (i + 1), startFrame: 100 * (i + 1) - 20, identityA: pair[0], identityB: pair[1],
        nameA: names[0], nameB: names[1], score: bad.includes(i) ? -80 : 30,
    }));
}
function resultOf(scored) {
    const changes = SC.markChangePoints(scored, O);
    return { ok: true, flags: scored.filter(s => s.flagged), changes, encounters: scored, fps: 30, sampleHz: 15, step: 2 };
}

// ---- 1. links -------------------------------------------------------------------------------
console.log('1. markChangePoints links each change point to the other edge of its stretch');
{
    let r = resultOf(encounters(6, [3, 4, 5]));                     // run reaches the end
    let on = r.flags.find(f => f.kind === 'onset');
    ok(on && on.frame === 400 && on.switchBackAt === null, `onset to the session end: switchBackAt null (${on && on.switchBackAt})`);

    r = resultOf(encounters(6, [0, 1]));                            // run starts the session
    let end = r.changes[0];
    ok(end && end.kind === 'end' && end.frame === 300 && end.switchedAt === null, `'end' from the session start: switchedAt null`);

    r = resultOf(encounters(6, [2, 3]));                            // middle run of 2
    on = r.flags.find(f => f.kind === 'onset'); end = r.changes[0];
    ok(on.frame === 300 && on.switchBackAt === 500, `middle run: onset 300 switches back at 500 (${on.switchBackAt})`);
    ok(end.frame === 500 && end.switchedAt === 300, `middle run: 'end' 500 was switched at 300 (${end.switchedAt})`);

    r = resultOf(encounters(6, [2]));                               // a lone middle flag
    on = r.flags.find(f => f.kind === 'onset');
    ok(on.frame === 300 && on.switchBackAt === 400 && r.changes.length === 0,
        `lone middle flag: switches back at the next encounter (400), which is no change point (${on.switchBackAt})`);

    const again = encounters(6, [2]); SC.markChangePoints(again, O); again.forEach(s => { s.score = 30; });
    SC.markChangePoints(again, O);
    ok(again.every(s => s.switchBackAt === undefined), 're-applying a threshold clears stale links');
}

// ---- 2. plans -------------------------------------------------------------------------------
console.log('2. idSwitchFixPlan');
{
    const r = resultOf(encounters(6, [2, 3]));                      // onset 300 (close 280..300), end 500 (480..500)
    RV.linkIdSwitchResults({ size: r });
    const on = r.flags.find(f => f.kind === 'onset'), end = r.changes[0];
    const W = [250, 330], WE = [450, 530];                         // each row's window: 1 s (30 fr) either side
    const plan = (m, cur, window) => RV.idSwitchFixPlan(m, r, { currentFrame: cur, totalFrames: 1000, window });
    let p = plan(on, 50, W);
    ok(p.from === 301 && p.to === 500 && p.start === 'separate', `onset, current frame outside its window: 301..500 (${p.from}..${p.to})`);
    ok(p.partnerKey === RV.idSwitchRowKey(end), 'onset is paired with its \'end\' row');
    for (const [cur, where] of [[290, 'in the close spell'], [260, 'in the lead-in, before the red section'],
                                [320, 'in the lead-out, after it'], [250, 'on the window\'s first frame'], [330, 'on its last']]) {
        p = plan(on, cur, W);
        ok(p.from === cur && p.to === 500 && p.start === 'current', `onset, current frame ${cur} ${where}: starts there (${p.from})`);
    }
    p = plan(on, 331, W);
    ok(p.start === 'separate' && p.from === 301, 'one frame past the window falls back to where they separate');
    p = plan(on, 260, undefined);
    ok(p.start === 'separate', 'without a window, only the close spell counts');

    p = plan(end, 0, WE);
    ok(p.from === 301 && p.to === 500, `'end': the same stretch, 301..500 (${p.from}..${p.to})`);
    ok(p.partnerKey === RV.idSwitchRowKey(on), '\'end\' is paired with its onset');
    p = plan(end, 490, WE);
    ok(p.to === 489 && p.start === 'current', `'end', current frame 490: ends just before it (${p.to})`);
    p = plan(end, 460, WE);
    ok(p.to === 459, `'end', current frame 460 in its lead-in: ends just before it (${p.to})`);

    const toEnd = resultOf(encounters(6, [4, 5]));
    const on2 = toEnd.flags.find(f => f.kind === 'onset');
    p = RV.idSwitchFixPlan(on2, toEnd, { currentFrame: 0, totalFrames: 1000 });
    ok(p.from === 501 && p.to === 999 && p.partnerKey === '', `onset reaching the end: 501..last frame 999 (${p.from}..${p.to})`);

    const fromStart = resultOf(encounters(6, [0, 1]));
    p = RV.idSwitchFixPlan(fromStart.changes[0], fromStart, { currentFrame: 0, totalFrames: 1000 });
    ok(p.from === 0 && p.to === 300, `'end' from the session start: 0..300 (${p.from}..${p.to})`);

    // restored from an older file: no links -> nearest change point of the same pair
    const legacy = { ok: true, flags: [
        { frame: 300, startFrame: 280, nameA: 'a', nameB: 'b', score: -80 },
        { frame: 500, startFrame: 480, nameA: 'b', nameB: 'a', score: 20, kind: 'end' },
        { frame: 400, nameA: 'a', nameB: 'c', score: -80 },
    ], changes: [] };
    p = RV.idSwitchFixPlan(legacy.flags[0], legacy, { currentFrame: 0, totalFrames: 1000 });
    ok(p.from === 301 && p.to === 500 && p.partnerKey === RV.idSwitchRowKey(legacy.flags[1]),
        `legacy onset pairs with the same pair's later 'end', either name order (${p.from}..${p.to})`);
    p = RV.idSwitchFixPlan(legacy.flags[2], legacy, { currentFrame: 0, totalFrames: 1000 });
    ok(p.to === 999 && p.partnerKey === '', 'legacy onset with no later \'end\' of its pair runs to the end');

    const empty = { frame: 0, startFrame: 0, nameA: 'a', nameB: 'b', score: 20, kind: 'end', switchedAt: null };
    ok(RV.idSwitchFixPlan(empty, { flags: [empty], changes: [] }, { currentFrame: 0, totalFrames: 10 }) === null,
        'an empty stretch plans nothing');
}

// ---- 3. the swap ------------------------------------------------------------------------------
console.log('3. Session.swapIdentitiesInRange');
{
    const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
    const cams = ['c0', 'c1'].map((n, i) => new PD.Camera(n, K, [0, 0, 0, 0, 0], [0, 0, 0], [10 * i, 0, 0], [640, 480]));
    const build = () => {
        const s = new PD.Session(cams, new PD.Skeleton('m', ['n0', 'n1'], []), ['t0', 't1', 't2'], 'S');
        const ids = ['a', 'b', 'c'].map(n => s.addIdentity(n).id);
        for (let f = 0; f < 20; f++) {
            s.instanceGroups.set(f, ids.map((id, k) => new PD.InstanceGroup(100 * f + k, id)));
            for (const c of cams) for (let t = 0; t < 3; t++) s.setFrameIdentity(f, c.name, t, ids[t]);
        }
        return { s, ids };
    };
    const snap = s => JSON.stringify({
        g: Array.from(s.instanceGroups, ([f, gs]) => [f, gs.map(g => g.identityId)]),
        m: Array.from(s.frameIdentityMap.entries()).sort((x, y) => (x[0] < y[0] ? -1 : 1)),
    });
    const idAt = (s, f, t) => s.getIdentityIdForTrack('c1', t, f);
    const { s, ids } = build();
    const before = snap(s);
    const r = s.swapIdentitiesInRange(5, 9, ids[0], ids[1]);
    ok(r.frames === 5 && r.groups === 10 && r.entries === 20, `frames 5..9: 5 frames, 10 groups, 20 per-frame entries (${JSON.stringify(r)})`);
    ok(idAt(s, 4, 0) === ids[0] && idAt(s, 5, 0) === ids[1] && idAt(s, 9, 1) === ids[0] && idAt(s, 10, 0) === ids[0],
        'swapped inside, untouched on both sides');
    ok(s.instanceGroups.get(7)[0].identityId === ids[1] && s.instanceGroups.get(10)[0].identityId === ids[0] &&
        s.instanceGroups.get(7)[2].identityId === ids[2], 'group-level identity follows; a third identity is untouched');
    s.swapIdentitiesInRange(5, 9, ids[0], ids[1]);
    ok(snap(s) === before, 'applying it again restores both structures exactly (undo)');
    const f = build();
    f.s.swapIdentitiesForward(15, f.ids[0], f.ids[1]);
    ok(idAt(f.s, 14, 0) === f.ids[0] && idAt(f.s, 19, 0) === f.ids[1], 'swapIdentitiesForward still reaches the end');
}

// ---- 4. renaming rows -------------------------------------------------------------------------
console.log('4. idSwitchRenameForFix');
{
    const rows = [
        { frame: 100, nameA: 'a', nameB: 'c', score: -80 },          // before the stretch
        { frame: 300, nameA: 'a', nameB: 'b', score: -80 },          // the fixed pair
        { frame: 350, nameA: 'a', nameB: 'c', score: -80 },          // inside: a -> b
        { frame: 360, nameA: 'c', nameB: 'b', score: -80 },          // inside: b -> a
        { frame: 370, nameA: 'c', nameB: 'd', score: -80 },          // inside, other animals
        { frame: 600, nameA: 'b', nameB: 'c', score: -80 },          // after
    ];
    const st = { results: { size: { ok: true, flags: rows, changes: [] } }, reviewed: new Set(), fixes: [], current: null };
    RV.linkIdSwitchResults(st.results);
    st.reviewed.add('size:350:a:c'); st.current = 'size:360:c:b';
    const fix = { key: 'size:300:a:b', partnerKey: '', nameA: 'a', nameB: 'b', from: 301, to: 500 };
    st.fixes.push(fix);
    const names = () => rows.map(m => m.nameA + m.nameB).join(' ');
    const orig = names();
    RV.idSwitchRenameForFix(st, fix);
    ok(names() === 'ac ab bc ca cd bc', `renamed inside the stretch only (${names()})`);
    ok(st.reviewed.has('size:350:b:c') && !st.reviewed.has('size:350:a:c'), 'a reviewed tick follows its row');
    ok(st.current === 'size:360:c:a', `the selection follows its row (${st.current})`);
    RV.idSwitchRenameForFix(st, fix);
    ok(names() === orig && st.reviewed.has('size:350:a:c') && st.current === 'size:360:c:b', 'applying it again restores names and keys');
    ok(RV.idSwitchFixFor(st, rows[1]) === fix && RV.idSwitchFixFor(st, rows[2]) === null, 'idSwitchFixFor finds the fixed row only');
}

// ---- 5. persistence ---------------------------------------------------------------------------
console.log('5. serialize / ingest');
{
    const r = resultOf(encounters(6, [2, 3]));
    const session = { _idSwitch: { results: { size: r }, reviewed: new Set(['size:300:a:b']), current: null,
        fixes: [{ key: 'size:300:a:b', partnerKey: 'size:500:a:b', nameA: 'a', nameB: 'b', from: 301, to: 500, idA: 0, idB: 1 }] } };
    RV.linkIdSwitchResults(session._idSwitch.results);
    const payload = JSON.parse(JSON.stringify(RV.serializeIdSwitchReview(session)));
    ok(JSON.stringify(payload.fixes) === JSON.stringify([['size:300:a:b', 'size:500:a:b', 'a', 'b', 301, 500]]), 'fixes are written');
    const back = RV.ingestIdSwitchReview({}, payload)._idSwitch;
    const on = back.results.size.flags.find(m => m.frame === 300), end = back.results.size.flags.find(m => m.frame === 500);
    ok(on.switchBackAt === 500 && end.switchedAt === 300, 'links come back');
    ok(back.fixes.length === 1 && back.fixes[0].from === 301 && back.fixes[0].to === 500 && back.fixes[0].partnerKey === 'size:500:a:b',
        'the fix comes back');
    const p = RV.idSwitchFixPlan(on, back.results.size, { currentFrame: 0, totalFrames: 1000 });
    ok(p.from === 301 && p.to === 500, 'a reopened row plans the same frames');
    ok(RV.idSwitchFixFor(back, end) === back.fixes[0], 'its partner row reads as fixed after a reopen');

    const none = RV.serializeIdSwitchReview({ _idSwitch: { results: { size: r }, reviewed: new Set(), fixes: [] } });
    ok(!('fixes' in none), 'no fixes key when nothing was fixed');
    payload.fixes.push('junk', [1, 2], ['k', '', 'a', 'b', 9, 3]);
    ok(RV.ingestIdSwitchReview({}, payload)._idSwitch.fixes.length === 1, 'malformed fixes are ignored');
}

// ---- 6. moments merge with the stretch they start or end ----------------------------------------
console.log('6. momentChangePoints: one row (and one fix) per swapped stretch');
{
    const OM = Object.assign({}, O, { momentThreshold: -200 });    // fps 30: rows within 90 frames stand
    const moment = (frame, side) => ({ frame, startFrame: frame - 5, identityA: 0, identityB: 1, nameA: 'a', nameB: 'b',
                                       score: -300, side, look: ['tracklet'] });
    const run = (scored, moments) => {
        scored.sort((x, y) => x.frame - y.frame);
        const changes = SC.markChangePoints(scored, OM), added = SC.momentChangePoints(moments, scored, changes, OM);
        const byFrame = (x, y) => x.frame - y.frame;
        const r = { ok: true, flags: scored.filter(s => s.flagged).concat(added.filter(m => m.kind !== 'end')).sort(byFrame),
                    changes: changes.concat(added.filter(m => m.kind === 'end')).sort(byFrame), encounters: scored, fps: 30 };
        r.rows = RV.idSwitchPrimary(r).filter(x => x.nameA === 'a');
        return r;
    };
    const desc = r => JSON.stringify(r.rows.map(x => [x.frame, x.kind, x.look ? 'M' : 'E']));
    const plan = (r, m) => RV.idSwitchFixPlan(m, r, { currentFrame: null, totalFrames: 1000 });

    // the topC case: a moment, then the pair's next encounter starts a flagged run that reaches the end
    let sc = encounters(6, [3, 4, 5]);
    let before = resultOf(encounters(6, [3, 4, 5]));
    ok(before.flags.find(f => f.kind === 'onset').frame === 400, 'without the moment, the run\'s onset row is the encounter at 400');
    let r = run(sc, [moment(305, 'after')]);
    ok(r.rows.length === 1 && r.rows[0].look && r.rows[0].frame === 305, `one row, the moment's: ${desc(r)}`);
    ok(sc.find(e => e.frame === 400).continues && sc.find(e => e.frame === 400).flagged, '…the encounter at 400 is now a repeat (still flagged)');
    let p = plan(r, r.rows[0]);
    ok(r.rows[0].switchBackAt === null && p.from === 306 && p.to === 999,
        `the moment's fix covers the whole stretch, 306..999 (${p.from}..${p.to}); before this it stopped at 400`);

    // a middle run: the moment takes over its onset row and pairs with its 'end' row
    sc = encounters(8, [3, 4]);
    r = run(sc, [moment(305, 'after')]);
    const endRow = r.changes.find(c => !c.look);
    ok(r.rows.length === 2 && r.rows[0].frame === 305 && endRow && endRow.frame === 600, `moment + the run's 'end' row: ${desc(r)}`);
    ok(r.rows[0].switchBackAt === 600 && endRow.switchedAt === 305, `linked both ways (${r.rows[0].switchBackAt}, ${endRow.switchedAt})`);
    p = plan(r, r.rows[0]);
    let pe = plan(r, endRow);
    ok(p.from === 306 && p.to === 600 && p.partnerKey === RV.idSwitchRowKey(endRow) && pe.from === 306 && pe.to === 600,
        `both rows plan the same fix, 306..600 (${p.from}..${p.to} / ${pe.from}..${pe.to}), as partners`);

    // the run's first encounter is just BEFORE the moment: its window ran across the moment, the moment's row takes over
    sc = encounters(6, [3, 4, 5]);
    r = run(sc, [moment(495, 'after')]);
    ok(r.rows.length === 1 && r.rows[0].frame === 495 && r.rows[0].switchBackAt === null && sc.find(e => e.frame === 400).continues,
        `moment after the run's first encounter: one row, the moment's (${desc(r)})`);

    // a moment two encounters into a run contradicts it: the encounters stand
    sc = encounters(8, [2, 3, 4, 5]);
    r = run(sc, [moment(495, 'after')]);
    ok(r.rows.length === 2 && !r.rows.some(x => x.look) && r.rows[0].frame === 300 && r.rows[0].switchBackAt === 700,
        `an onset deep inside a run adds nothing: ${desc(r)}`);

    // 'end' (the stretch BEFORE the moment is the odd one): it closes the run's onset row, the run's 'end' row goes
    sc = encounters(8, [2, 3]);
    r = run(sc, [moment(405, 'before')]);
    const on = r.rows.find(x => x.kind === 'onset'), mEnd = r.rows.find(x => x.look);
    ok(r.rows.length === 2 && on.frame === 300 && mEnd && mEnd.frame === 405 && !r.changes.some(c => c.frame === 500),
        `onset 300 + the moment's 'end' 405; the encounter 'end' at 500 is dropped: ${desc(r)}`);
    p = plan(r, on); pe = plan(r, mEnd);
    ok(on.switchBackAt === 405 && mEnd.switchedAt === 300 && p.to === 405 && pe.from === 301 && pe.to === 405 && p.partnerKey === RV.idSwitchRowKey(mEnd),
        `paired: one fix, 301..405 (${p.from}..${p.to} / ${pe.from}..${pe.to})`);
    sc = encounters(6, [0, 1]);                                     // swapped from the session start
    r = run(sc, [moment(205, 'before')]);
    ok(r.rows.length === 1 && r.rows[0].frame === 205 && r.rows[0].switchedAt === null,
        `swapped from the start: the moment's 'end' is the only row, from frame 0 (${desc(r)})`);
    sc = encounters(8, [2, 3, 4]);                                  // the run is still flagged after it: contradicts it
    r = run(sc, [moment(305, 'before')]);
    ok(!r.rows.some(x => x.look), `an 'end' inside a run adds nothing: ${desc(r)}`);

    // an encounter scoring exactly 0 had no samples: it neither ends nor continues a stretch
    sc = encounters(8, [3, 5, 6, 7]); sc[4].score = 0;            // runs 400 and 600..800, a no-evidence encounter at 500
    before = resultOf(encounters(8, [3, 5, 6, 7]).map((e, i) => i === 4 ? Object.assign(e, { score: 0 }) : e));
    ok(RV.idSwitchPrimary(before).length === 2, 'without the moment, the no-evidence encounter at 500 splits the swap into two onset rows');
    r = run(sc, [moment(305, 'after')]);
    ok(r.rows.length === 1 && r.rows[0].frame === 305 && r.rows[0].switchBackAt === null,
        `the moment's row runs through it to the end: ${desc(r)}, switchBackAt ${r.rows[0].switchBackAt}`);
    sc = encounters(6, [0]); sc[1].score = 0;                       // swapped from the start; its 'end' row sits on 200, no evidence
    before = resultOf(encounters(6, [0]).map((e, i) => i === 1 ? Object.assign(e, { score: 0 }) : e));
    ok(before.changes.length === 1 && before.changes[0].frame === 200, 'without the moment, the encounter \'end\' row is the no-evidence encounter at 200');
    r = run(sc, [moment(295, 'before')]);                          // > 3 s (90 frames) from that row, or it would stand
    ok(r.rows.length === 1 && r.rows[0].frame === 295 && r.rows[0].switchedAt === null && plan(r, r.rows[0]).from === 0,
        `the moment's 'end' covers the stretch from frame 0, and that row is dropped: ${desc(r)}`);

    // two moments of the pair with only clean encounters around them pair with each other
    sc = encounters(6, []);
    r = run(sc, [moment(130, 'after'), moment(170, 'before')]);
    ok(r.rows.length === 2 && r.rows[0].switchBackAt === 170 && r.rows[1].switchedAt === 130,
        `onset 130 and 'end' 170 are one stretch (${r.rows[0].switchBackAt}, ${r.rows[1].switchedAt})`);

    // follow-ons are re-linked: another pair's row that followed the replaced encounter row now follows the moment
    sc = encounters(6, [3, 4, 5]).concat(encounters(1, [0], [0, 2], ['a', 'c']).map(e => Object.assign(e, { frame: 450, startFrame: 430 })));
    r = run(sc, [moment(305, 'after')]);
    const follow = sc.find(e => e.identityB === 2);
    ok(follow.kind === 'onset' && follow.followOf === 305, `the other pair's onset follows the moment now (${follow.followOf}; was 400)`);
}

console.log(`\n${passed} passed, ${failed} failed`);
process.exit(failed ? 1 : 0);
