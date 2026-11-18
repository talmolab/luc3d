/**
 * test-frame-readout.mjs — text of the controls bar's frame readout
 * (ui/frame-readout.js): "time / duration" above "frame / total". The DOM half
 * is covered by tests/e2e/frame-readout.mjs.
 *
 * Run:  node tests/test-frame-readout.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ui = (f) => pathToFileURL(path.join(HERE, '..', 'ui', f)).href;
const { formatFrameNumber, frameReadoutText, NO_TIME } = await import(ui('frame-readout.js'));
const { seekbarTooltipText } = await import(ui('seekbar-tooltip.js'));

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    if (a === e) passed++;
    else { failed++; failures.push(`${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); console.error('  ✗ ' + m); }
}

// formatFrameNumber — a comma every three digits, nothing below 1,000
eq(formatFrameNumber(0), '0', 'zero');
eq(formatFrameNumber(999), '999', 'no separator below a thousand');
eq(formatFrameNumber(3833), '3,833', 'thousands');
eq(formatFrameNumber(36000), '36,000', 'tens of thousands');
eq(formatFrameNumber(180210), '180,210', 'hundreds of thousands');
eq(formatFrameNumber(1234567), '1,234,567', 'millions');

// frameReadoutText — the screenshot's project: frame 3,833 of 36,000 at 30 fps
let t = frameReadoutText(3832, 36000, 30);
eq(t.frame, '3,833', 'current frame is 1-based, with a separator');
eq(t.total, '36,000', 'total frames, with a separator');
eq(t.time, '02:07.733', 'current time is the frame START time, (idx) / fps');
eq(t.duration, '20:00.000', 'duration is totalFrames / fps');

t = frameReadoutText(0, 36000, 30);
eq(t.frame, '1', 'first frame');
eq(t.time, '00:00.000', 'first frame starts at zero');

t = frameReadoutText(35999, 36000, 30);
eq(t.frame, '36,000', 'last frame');
eq(t.time, '19:59.967', 'last frame starts one frame before the end');

t = frameReadoutText(180209, 180210, 150);
eq(t.time, '20:01.393', '150 fps (Mimica)');
eq(t.duration, '20:01.400', '150 fps duration');

t = frameReadoutText(400000, 540000, 120);
eq(t.time, '55:33.333', 'under an hour stays mm:ss');
eq(t.duration, '1:15:00.000', 'an hour or more gains an hours field');

// unknown frame rate: placeholder times, frames still shown
for (const fps of [0, undefined, NaN, Infinity, -30]) {
    t = frameReadoutText(1233, 2000, fps);
    eq(t.frame + '|' + t.total, '1,234|2,000', `fps ${fps}: frames still shown`);
    eq(t.time + '|' + t.duration, NO_TIME + '|' + NO_TIME, `fps ${fps}: placeholder times`);
}

// the empty state reads "0 / 0", as before the time line existed
t = frameReadoutText(null, 0, 30);
eq([t.time, t.duration, t.frame, t.total].join(' '), '00:00.000 00:00.000 0 0', 'empty state');
eq(frameReadoutText(null, -5, 30).total, '0', 'a negative count reads 0');

// same language as the seekbar tooltip, so a click puts its text in the readout
for (const [idx, fps] of [[0, 30], [1233, 30], [180209, 150], [9, 0]]) {
    t = frameReadoutText(idx, 200000, fps);
    const expected = 'Frame ' + t.frame + (fps > 0 ? ' · ' + t.time : '');
    eq(seekbarTooltipText(idx, fps), expected, `matches the seekbar tooltip at frame ${idx} / ${fps} fps`);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
