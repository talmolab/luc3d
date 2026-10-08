/**
 * test-track-summary.mjs — what the Track All summary box says
 * (ui/track-summary.js): the per-identity counts, how each ID-switch check's
 * outcome is described, how long tracking and each check took, and the next
 * step recommended for each case. The DOM
 * half is covered by tests/e2e/track-all-summary.mjs.
 *
 * Run:  node tests/test-track-summary.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ui = (f) => pathToFileURL(path.join(HERE, '..', 'ui', f)).href;
const { formatShare, formatDuration, formatTrackingSpeed, summarizeTrackedIdentities, describeSwitchCheck, planTrackSummary, MAX_IDENTITY_ROWS } =
    await import(ui('track-summary.js'));

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    if (a === e) passed++;
    else { failed++; failures.push(`${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); console.error('  ✗ ' + m); }
}
function ok(c, m) { eq(!!c, true, m); }

// ---- formatShare: never overstates ------------------------------------------
eq(formatShare(0, 0), '—', 'no denominator');
eq(formatShare(1000, 1000), '100%', 'a full count is 100%');
eq(formatShare(9997, 10000), '99.9%', '99.97% is floored, never rounded up to 100%');
eq(formatShare(500, 1000), '50.0%', 'half');
eq(formatShare(1, 100000), '<0.1%', 'a non-zero share too small to show');
eq(formatShare(0, 10), '0.0%', 'zero');

// ---- formatDuration ---------------------------------------------------------
eq(formatDuration(undefined), '', 'no time: empty');
eq(formatDuration(NaN), '', 'invalid time: empty');
eq(formatDuration(40), '<0.1 s', 'under a tenth of a second');
eq(formatDuration(430), '0.4 s', 'tenths below 10 s');
eq(formatDuration(8349), '8.3 s', '8.3 s');
eq(formatDuration(9960), '10 s', 'just under 10 s rounds to whole seconds, never "10.0 s"');
eq(formatDuration(42400), '42 s', 'whole seconds below a minute');
eq(formatDuration(59600), '1 min', '59.6 s is a minute, never "60 s"');
eq(formatDuration(185000), '3 min 5 s', 'minutes and seconds');
eq(formatDuration(120000), '2 min', 'whole minutes drop "0 s"');
eq(formatDuration(4320000), '1 h 12 min', 'hours and minutes');
eq(formatDuration(7200000), '2 h', 'whole hours drop "0 min"');

// ---- formatTrackingSpeed: throughput, and how many times faster than real time
let sp = formatTrackingSpeed(54000, 180000, 30);       // 30 min of 30 fps video tracked in 3 min
eq(sp.fps + ' · ' + sp.realtime, '300 fps · 10×', '30 min tracked in 3 min: 300 fps, 10× real time');
sp = formatTrackingSpeed(108000, 83400, 30);
eq(sp.fps + ' · ' + sp.realtime, '1,295 fps · 43×', 'thousands separator; whole numbers from 10 up');
sp = formatTrackingSpeed(1950, 600, 30);
eq(sp.realtime, '108×', 'a short clip tracked very fast');
sp = formatTrackingSpeed(9000, 2000000, 150);            // 150 fps camera, slower than real time
eq(sp.fps + ' · ' + sp.realtime, '4.5 fps · <0.1×', 'one decimal below 10, "<0.1" below a tenth');
sp = formatTrackingSpeed(36000, 400000, 30);
eq(sp.realtime, '3.0×', 'one decimal below 10×');
sp = formatTrackingSpeed(1000, 5000, 0);
eq(sp.fps + '|' + sp.realtime, '200 fps|', 'unknown recording rate: fps only, no multiplier');
sp = formatTrackingSpeed(0, 5000, 30);
eq(sp.fps + '|' + sp.realtime, '|', 'nothing swept: nothing to show');
sp = formatTrackingSpeed(100, 0, 30);
eq(sp.fps + '|' + sp.realtime, '|', 'no time measured: nothing to show');

// ---- summarizeTrackedIdentities ---------------------------------------------
// Three identities with non-contiguous ids (ids come from a global counter),
// over 5 frames, 2 animals expected.
const session = {
    identities: [{ id: 10, name: 'id_0', color: '#ff0000' }, { id: 11, name: 'id_1', color: '#00ff00' },
                 { id: 12, name: 'id_2', color: '#0000ff' }],
    instanceGroups: new Map([
        [0, [{ identityId: 10 }, { identityId: 11 }]],                     // both animals
        [1, [{ identityId: 10 }, { identityId: 11 }]],                     // both animals
        [2, [{ identityId: 10 }, { identityId: 10 }]],                     // one identity twice: one animal
        [3, [{ identityId: -1 }]],                                          // no identity: not tracked
        [4, [{ identityId: 12 }, { identityId: 11 }]],                     // a new identity + id_1
        [5, []],                                                            // empty frame
    ]),
};
const s = summarizeTrackedIdentities(session, { frames: 6, animals: 2 });
eq(s.frames, 6, 'frames swept is the denominator passed in');
eq(s.trackedFrames, 4, 'frames with at least one identity (not the -1 or empty frames)');
eq(s.completeFrames, 3, 'frames with every animal (an identity listed twice counts once)');
eq(s.identities.map(i => i.frames).join(','), '3,3,1', 'frames per identity, in session order');
eq(s.identities[2].name, 'id_2', 'identity names carried through');
eq(s.animalsAuto, false, 'animalsAuto defaults to false');

const empty = summarizeTrackedIdentities({ identities: [], instanceGroups: new Map() }, { frames: 10, animals: 3 });
eq(empty.trackedFrames, 0, 'no identities: nothing tracked');
eq(empty.identities.length, 0, 'no identities listed');

// ---- describeSwitchCheck ----------------------------------------------------
const flag = (frame, extra) => Object.assign({ frame, nameA: 'id_0', nameB: 'id_1' }, extra || {});
const found = { ok: true, flags: [flag(10), flag(90, { continues: true }), flag(200, { followOf: 10 })],
                changes: [flag(300, { kind: 'end' })], encounters: new Array(42) };
const clear = { ok: true, flags: [], changes: [], encounters: new Array(17) };

eq(describeSwitchCheck(true, found, 1).state, 'na', 'one identity: the check does not apply');
eq(describeSwitchCheck(false, null, 3).state, 'off', 'disabled in the Tracking Wizard');
let d = describeSwitchCheck(true, null, 3, 'no tracked 3D skeletons');
eq(d.state + '|' + d.reason, 'skipped|no tracked 3D skeletons', 'enabled but never started: skipped, with the reason');
d = describeSwitchCheck(true, found, 3);
eq(d.state, 'found', 'flags found');
eq(d.switches, 2, 'switches = independent change points (continues and follow-ons excluded, ends included)');
eq(d.encounters, 42, 'close encounters scored');
d = describeSwitchCheck(true, clear, 3);
eq(d.state + '|' + d.switches + '|' + d.encounters, 'clear|0|17', 'nothing flagged');
eq(describeSwitchCheck(true, { ok: false, cancelled: true, reason: 'cancelled' }, 3).state, 'cancelled', 'cancelled');
d = describeSwitchCheck(true, { ok: false, failed: true, reason: 'failed — boom' }, 3);
eq(d.state + '|' + d.reason, 'failed|failed — boom', 'failed, with the reason');
d = describeSwitchCheck(true, { ok: false, reason: 'needs at least 60 s of tracking to learn the animals (has 12 s)' }, 3);
eq(d.state, 'skipped', 'a check that could not run is skipped, not failed');
eq(describeSwitchCheck(true, Object.assign({ elapsedMs: 3210 }, clear), 3).elapsedMs, 3210, 'the check\'s time is carried through');
eq(describeSwitchCheck(true, Object.assign({ elapsedMs: 900 }, found), 1).elapsedMs, undefined, 'not applicable: no time');

// ---- planTrackSummary: the next step for each case ---------------------------
const two = summarizeTrackedIdentities({
    identities: [{ id: 0, name: 'id_0', color: '#f00' }, { id: 1, name: 'id_1', color: '#0f0' }],
    instanceGroups: new Map([[0, [{ identityId: 0 }, { identityId: 1 }]], [1, [{ identityId: 0 }]]]),
}, { frames: 4, animals: 2 });
const C = (state, extra) => Object.assign({ state }, extra || {});
const plan = (sum, size, image) => planTrackSummary(sum, { size, image });

// switches found -> review first
let p = plan(two, C('found', { switches: 3, encounters: 40 }), C('off'));
eq(p.primary.action, 'review', 'switches found: the recommended step is reviewing them');
ok(p.next.steps.some(t => /Triangulate All/.test(t)), 'switches found: Triangulate All is still listed, after review');
eq(p.checks[0].text, '3 possible switches in 40 close encounters', 'check row: found');
eq(p.checks[1].text, 'Not run', 'check row: image check off');
eq(p.secondary.length, 0, 'switches found: no alternative checks offered');
p = plan(two, C('clear', { switches: 0, encounters: 40 }), C('found', { switches: 1, encounters: 40 }));
eq(p.primary.action, 'review', 'found by images alone still means review');

// size clear, images not run -> say what "clear" means, offer the image check, recommend triangulating
p = plan(two, C('clear', { switches: 0, encounters: 40 }), C('off'));
eq(p.primary.action, 'triangulate', 'nothing flagged: the recommended step is Triangulate All');
ok(/similar size/.test(p.next.caveat || ''), 'nothing flagged by size alone: says size cannot separate similar animals');
eq(p.secondary.map(b => b.action).join(','), 'imageCheck', 'nothing flagged by size alone: offers the image check');
eq(p.checks[0].text, 'No possible switches in 40 close encounters', 'check row: clear');
eq(p.checks[0].state, 'clear', 'check row carries its state (for colour)');
eq(plan(two, C('clear', { switches: 0, encounters: 0 }), C('off')).checks[0].text, 'No close encounters to check',
    'nothing to score: says so rather than "0 close encounters"');

// both clear -> no caveat, no alternatives
p = plan(two, C('clear', { switches: 0, encounters: 40 }), C('clear', { switches: 0, encounters: 40 }));
eq(p.next.headline, 'Neither check flagged an ID switch.', 'both clear: headline');
eq(p.next.caveat, null, 'both clear: no caveat');
eq(p.secondary.length, 0, 'both clear: nothing else to run');

// image check could not run (e.g. no WebGPU): do not push it
p = plan(two, C('clear', { switches: 0, encounters: 40 }), C('skipped', { reason: 'needs WebGPU' }));
eq(p.next.caveat, null, 'image check skipped: no caveat pointing at a check that cannot run');
eq(p.secondary.length, 0, 'image check skipped: not offered again');
eq(p.checks[1].text, 'Skipped — needs WebGPU', 'check row: skipped, with the reason');

// a cancelled image check can be run again
p = plan(two, C('clear', { switches: 0, encounters: 40 }), C('cancelled'));
eq(p.secondary.map(b => b.action).join(','), 'imageCheck', 'image check cancelled: offered again');

// no check ran at all -> say so; offer the size check when it is off
p = plan(two, C('off'), C('off'));
eq(p.next.headline, 'Identities were not checked for switches.', 'neither ran: says so, rather than implying "none found"');
eq(p.primary.action, 'triangulate', 'neither ran: still recommends Triangulate All');
eq(p.secondary.map(b => b.action).join(','), 'sizeCheck,imageCheck', 'neither ran: offers both checks');
p = plan(two, C('skipped', { reason: 'needs at least 60 s of tracking' }), C('off'));
eq(p.next.headline, 'Identities were not checked for switches.', 'size skipped: not checked');
eq(p.secondary.map(b => b.action).join(','), 'imageCheck', 'size skipped: not re-offered (it would skip again)');
p = plan(two, C('failed', { reason: 'failed — boom' }), C('off'));
eq(p.checks[0].text, 'Failed — boom', 'check row: failed, prefix not doubled');
eq(p.checks[0].full, 'boom', 'the full reason is kept for the tooltip');
const SKEL = 'The skeleton has too few of the size nodes (need at least 4 of: Ear_L–Ear_R, Nose–Ear_L, Nose–Ear_R, ' +
    'Nose–Head, Head–Neck, Neck–Trunk, Trunk–TTI)';
p = plan(two, C('skipped', { reason: SKEL }), C('off'));
eq(p.checks[0].text, 'Skipped — The skeleton has too few of the size nodes', 'a long reason is cut at its parenthesis');
eq(p.checks[0].full, SKEL, '…and kept whole for the tooltip');
p = plan(two, C('skipped', { reason: 'needs at least 60 s of tracking to learn the animals (has 12 s)' }), C('off'));
eq(p.checks[0].text, 'Skipped — needs at least 60 s of tracking to learn the animals (has 12 s)', 'a short reason is shown whole');
p = plan(two, C('skipped', { reason: 'x'.repeat(100) }), C('off'));
eq(p.checks[0].text.length, 'Skipped — '.length + 70, 'a long reason with no parenthesis is cut with an ellipsis');

// nothing tracked
const none = summarizeTrackedIdentities({ identities: [], instanceGroups: new Map() }, { frames: 50, animals: 2 });
p = plan(none, C('na'), C('na'));
eq(p.primary.action, 'wizard', 'nothing tracked: points at the Tracking Wizard');
eq(p.next.headline, 'Nothing was tracked.', 'nothing tracked: headline');
eq(p.checks.length, 0, 'nothing tracked: no check rows');
eq(p.stats.map(r => r.label).join(','), 'Identities,Frames tracked', 'nothing tracked: no "all animals" row');

// one identity
const one = summarizeTrackedIdentities({ identities: [{ id: 0, name: 'id_0' }], instanceGroups: new Map([[0, [{ identityId: 0 }]]]) },
    { frames: 1, animals: 1 });
p = plan(one, C('na'), C('na'));
eq(p.next.headline, 'One identity, so there is nothing to switch.', 'one identity: headline');
eq(p.primary.action, 'triangulate', 'one identity: Triangulate All next');
eq(p.checks.length, 0, 'one identity: no check rows');

// stats rows
p = plan(two, C('clear', { switches: 0, encounters: 1 }), C('off'));
eq(p.stats[0].value + ' ' + p.stats[0].detail, '2 for 2 animals', 'Identities row');
eq(p.stats[1].value + ' ' + p.stats[1].detail, '2 of 4 50.0%', 'Frames tracked row');
eq(p.stats[2].label + ': ' + p.stats[2].value + ' ' + p.stats[2].detail, 'All 2 animals: 1 frame 25.0%', 'All-animals row');
eq(planTrackSummary(Object.assign({}, two, { animalsAuto: true }), { size: C('off'), image: C('off') }).stats[0].detail,
    'for 2 animals (auto-detected)', 'an auto-detected animal count says so');

// durations: tracking, and each check that spent real time
const timed = Object.assign({}, two, { elapsedMs: 83000 });
p = plan(timed, C('clear', { switches: 0, encounters: 9, elapsedMs: 3200 }), C('found', { switches: 1, encounters: 9, elapsedMs: 305000 }));
const tRow = p.stats.find(r => r.label === 'Tracking time');
eq(tRow && tRow.value, '1 min 23 s', 'a Tracking time row');
eq(tRow && tRow.detail, '<0.1 fps', 'its detail is the tracking speed (no multiplier without a recording rate)');
const big = Object.assign({}, two, { frames: 54000, elapsedMs: 180000, fps: 30 });
const bigRow = plan(big, C('off'), C('off')).stats.find(r => r.label === 'Tracking time');
eq(bigRow.value + ' | ' + bigRow.detail, '3 min | 300 fps · 10×', 'Tracking time row: time, then fps and the real-time multiplier');
ok(/how many times faster than the recording plays at 30 fps/.test(bigRow.title), 'its tooltip explains the multiplier');
eq(summarizeTrackedIdentities(session, { frames: 6, animals: 2, fps: 59.94 }).fps, 59.94, 'the recording rate is carried through');
eq(summarizeTrackedIdentities(session, { frames: 6, animals: 2 }).fps, 0, 'no recording rate: 0');
eq(p.stats[p.stats.length - 1].label, 'Tracking time', 'listed after the counts');
eq(p.checks[0].time + '|' + p.checks[1].time, '3.2 s|5 min 5 s', 'each check row has its own time');
p = plan(timed, C('skipped', { reason: 'needs WebGPU', elapsedMs: 2 }), C('off'));
eq(p.checks[0].time + '|' + p.checks[1].time, '|', 'a skipped or unrun check shows no time');
p = plan(timed, C('failed', { reason: 'failed — x', elapsedMs: 1500 }), C('cancelled', { elapsedMs: 61000 }));
eq(p.checks[0].time + '|' + p.checks[1].time, '1.5 s|1 min 1 s', 'failed and cancelled checks show the time they spent');
eq(plan(two, C('off'), C('off')).stats.some(r => r.label === 'Tracking time'), false, 'no time measured: no row');

// identity notes
const mkIds = (k) => Array.from({ length: k }, (_, i) => ({ id: i, name: 'id_' + i, color: '#888' }));
const extra = summarizeTrackedIdentities({ identities: mkIds(4), instanceGroups: new Map([[0, [{ identityId: 0 }, { identityId: 1 }]]]) },
    { frames: 1, animals: 2 });
p = plan(extra, C('clear', { switches: 0, encounters: 1 }), C('off'));
ok(p.notes.length === 1 && /More identities than animals/.test(p.notes[0]), 'more identities than animals: a note');
const fewer = summarizeTrackedIdentities({ identities: mkIds(2), instanceGroups: new Map([[0, [{ identityId: 0 }, { identityId: 1 }]]]) },
    { frames: 1, animals: 3 });
p = plan(fewer, C('clear', { switches: 0, encounters: 1 }), C('off'));
ok(p.notes.length === 1 && /one animal was never matched/.test(p.notes[0]), 'one identity short: a note in the singular');
eq(plan(two, C('off'), C('off')).notes.length, 0, 'identities match animals: no note');

// identity rows are capped (no scroller in the modal)
const many = summarizeTrackedIdentities({ identities: mkIds(MAX_IDENTITY_ROWS + 5), instanceGroups: new Map() },
    { frames: 10, animals: 2 });
p = plan(many, C('off'), C('off'));
eq(p.identities.length, MAX_IDENTITY_ROWS, 'identity rows capped');
eq(p.moreIdentities, 5, 'the rest are counted');
p = plan(two, C('off'), C('off'));
eq(p.identities[0].share + '|' + p.identities[0].frac, '50.0%|0.5', 'identity share and bar fraction');

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach(f => console.error('  ✗ ' + f)); process.exit(1); }
