/**
 * test-trail-presets.mjs — node-trail presets are TIME, drawn as frames
 * (ui/trail-presets.js): ¼ s / ½ s / 1 s / 2 s is 15/30/60/120 frames at 60 fps
 * and 25/50/100/200 at 100 fps, and `state.trailLength` follows `state.fps` without
 * being told (ui/app-state.js). The menus are covered by
 * tests/e2e/node-trails-toolbar.mjs.
 *
 * Run:  node tests/test-trail-presets.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ui = (f) => pathToFileURL(path.join(HERE, '..', 'ui', f)).href;
const { TRAIL_PRESETS, MAX_TRAIL_FRAMES, trailFrames, trailLabel, trailSecondsName, trailPresetFor, parseTrailSeconds } =
    await import(ui('trail-presets.js'));
const { state } = await import(ui('app-state.js'));
const { LAZY_KEEP_BEHIND } = await import(pathToFileURL(path.join(HERE, '..', 'pose', 'lazy-residency.js')).href);

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    if (a === e) passed++;
    else { failed++; failures.push(`${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); console.error('  ✗ ' + m); }
}
function ok(c, m) { eq(!!c, true, m); }

// ---- the presets ------------------------------------------------------------
eq(TRAIL_PRESETS.map(p => p.seconds).join(','), '0,0.25,0.5,1,2', 'Off, ¼ s, ½ s, 1 s, 2 s');
const framesAt = (fps) => TRAIL_PRESETS.map(p => trailFrames(p.seconds, fps)).join('/');
eq(framesAt(60), '0/15/30/60/120', '60 fps → 15/30/60/120 frames');
eq(framesAt(100), '0/25/50/100/200', '100 fps → 25/50/100/200 frames');
eq(framesAt(30), '0/8/15/30/60', '30 fps → 8/15/30/60 (7.5 rounds up)');
eq(framesAt(29.97), '0/7/15/30/60', '29.97 fps rounds each preset (7.49 → 7)');

// ---- edges --------------------------------------------------------------------
eq(trailFrames(0, 60), 0, 'off is 0 frames at any rate');
eq(trailFrames(0.25, 0), 8, 'no known rate (fps 0, before a video) falls back to 30 fps');
eq(trailFrames(0.25, NaN), 8, 'a non-numeric rate falls back too');
eq(trailFrames(0.25, 2), 1, 'a trail that is on is at least 1 frame (0.5 → 1)');
eq(trailFrames(1, 1000), MAX_TRAIL_FRAMES, '1 s at 1,000 fps is capped');
eq(framesAt(250), '0/63/125/250/500', '2 s at 250 fps is exactly the cap');
eq(framesAt(300), '0/75/150/300/500', '2 s at 300 fps is capped at 500');
ok(LAZY_KEEP_BEHIND > MAX_TRAIL_FRAMES,
    `the cap stays under LAZY_KEEP_BEHIND (${MAX_TRAIL_FRAMES} < ${LAZY_KEEP_BEHIND}) — trails draw resident frames only`);

// ---- labels -------------------------------------------------------------------
eq(trailLabel(0, 60), 'Off', 'Off has no frame count');
eq(trailLabel(0.25, 60), '¼ second (15 frames)', '¼ s at 60 fps');
eq(trailLabel(1, 100), '1 second (100 frames)', '1 s at 100 fps');
eq(trailLabel(2, 60), '2 seconds (120 frames)', '2 s at 60 fps');
eq(trailLabel(0.25, 2), '¼ second (1 frame)', 'singular');

// ---- custom lengths -------------------------------------------------------------
eq(trailPresetFor(0.5) && trailPresetFor(0.5).key, 'Half', 'a preset length finds its preset');
eq(trailPresetFor(1.5), null, 'a custom length finds none');
eq(trailSecondsName(1.5), '1.5 seconds', 'a custom length is named in seconds');
eq(trailSecondsName(10 / 60), '0.167 seconds', '…to at most 3 decimals');
eq(trailSecondsName(3), '3 seconds', 'a whole custom length');
eq(trailLabel(1.5, 60), '1.5 seconds (90 frames)', 'custom 1.5 s at 60 fps');
eq(trailLabel(0.75, 100), '0.75 seconds (75 frames)', 'custom 0.75 s at 100 fps');
eq(parseTrailSeconds('1.5'), 1.5, 'parses a decimal');
eq(parseTrailSeconds(' 3 '), 3, 'trims');
eq(parseTrailSeconds('1,5'), 1.5, 'accepts a decimal comma');
eq(parseTrailSeconds('.5'), 0.5, 'a leading point');
eq(parseTrailSeconds('2.'), 2, 'a trailing point');
for (const bad of ['', '0', '0.0', '-1', 'abc', '1.5s', '1e3', 'Infinity', '1.2.3', null]) {
    eq(parseTrailSeconds(bad), null, `rejects ${JSON.stringify(bad)}`);
}

// ---- state.trailLength is derived, and follows fps ------------------------------
const fps0 = state.fps;
state.trailSeconds = 0.5;
state.fps = 60;
eq(state.trailLength, 30, '½ s at 60 fps');
state.fps = 100;
eq(state.trailLength, 50, 'changing fps alone changes the frame count');
state.trailSeconds = 0;
eq(state.trailLength, 0, 'off');
// Setting a frame count (tests, benches) stores the same span in seconds.
state.fps = 60;
state.trailLength = 10;
eq(state.trailLength, 10, 'setting 10 frames reads back 10 frames');
ok(Math.abs(state.trailSeconds - 10 / 60) < 1e-12, '…stored as 1/6 s at 60 fps');
state.fps = 120;
eq(state.trailLength, 20, '…so it doubles when the rate does');
for (const n of [1, 7, 50, 100, 333, 500]) for (const f of [24, 29.97, 30, 59.94, 100, 250]) {
    state.fps = f; state.trailLength = n;
    if (state.trailLength !== n) eq(state.trailLength, n, `round trip ${n} frames at ${f} fps`);
}
passed++;
state.fps = 0;
state.trailLength = 15;
eq(state.trailLength, 15, 'with no known rate, a frame count still round-trips (30 fps fallback on both sides)');
state.trailLength = 0;
eq(state.trailSeconds, 0, 'setting 0 frames turns trails off');
state.fps = fps0;

console.log(`\n${passed} passed, ${failed} failed`);
if (failed) { failures.forEach(f => console.error('  ✗ ' + f)); process.exit(1); }
