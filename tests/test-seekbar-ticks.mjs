/**
 * test-seekbar-ticks.mjs — the seekbar's time ruler (ui/seekbar-ticks.js):
 * label format and the choice of steps. The DOM half is covered by
 * tests/e2e/seekbar-ticks.mjs.
 *
 * Run:  node tests/test-seekbar-ticks.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const T = await import(pathToFileURL(path.join(HERE, '..', 'ui', 'seekbar-ticks.js')).href);
const { formatTickLabel, seekbarTimeTicks, TICK_STEPS, MIN_LABEL_SPACING_PX, MIN_MINOR_SPACING_PX, MAX_MINOR_PER_MAJOR, DEFAULT_CHAR_PX } = T;

let passed = 0, failed = 0; const failures = [];
function ok(c, m) {
    if (c) passed++;
    else { failed++; failures.push(m); console.error('  ✗ ' + m); }
}
function eq(a, e, m) { ok(a === e, `${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); }

// ---- formatTickLabel ---------------------------------------------------------------
eq(formatTickLabel(0, 0), '00:00', 'zero');
eq(formatTickLabel(300, 0), '05:00', 'five minutes');
eq(formatTickLabel(59.6, 0), '01:00', 'rounds BEFORE splitting (no 00:60)');
eq(formatTickLabel(59.96, 1), '01:00.0', 'rounds before splitting at one decimal too');
eq(formatTickLabel(0.30000000000000004, 1), '00:00.3', 'float drift of k × 0.1 does not show');
eq(formatTickLabel(3600, 0), '1:00:00', 'hours are unpadded, like the readout');
eq(formatTickLabel(5400, 0), '1:30:00', 'an hour and a half');
eq(formatTickLabel(-1, 0), '00:00', 'negative clamps to zero');

// ---- nothing to draw -----------------------------------------------------------------
for (const [args, why] of [
    [[0, 30, 700], 'no frames'], [[1, 30, 700], 'one frame'],
    [[1000, 0, 700], 'fps 0 (no video yet)'], [[1000, NaN, 700], 'fps NaN'],
    [[1000, Infinity, 700], 'fps Infinity'], [[1000, undefined, 700], 'fps missing'],
    [[1000, 30, 0], 'zero width'], [[1000, 30, 20], 'a bar too narrow for two labels'],
]) {
    const t = seekbarTimeTicks(...args);
    ok(t.step === 0 && t.majors.length === 0 && t.minors.length === 0, `${why}: no ruler`);
}

// ---- the user's case: 30 min at 60 fps -----------------------------------------------
{
    const t = seekbarTimeTicks(108000, 60, 700);
    eq(t.step, 300, '30 min on 700 px: a label every 5:00');
    eq(t.minorStep, 60, '  minor ticks every minute');
    eq(t.majors.map(m => m.label).join(' '), '00:00 05:00 10:00 15:00 20:00 25:00', '  labels');
    eq(t.majors[0].align, 'start', '  the first label is left-aligned');
    ok(t.majors.slice(1).every(m => m.align === 'center'), '  the rest are centred');
    eq(t.minors.length, 24, '  four minors between each pair of majors, none on a major');
    // Same frame -> position mapping as the thumb: time × fps / (total − 1).
    ok(t.majors.every(m => Math.abs(m.frac - m.seconds * 60 / 107999) < 1e-12), '  positions are time × fps / (total − 1)');
}

// ---- the properties, over a grid of recordings and widths ---------------------------
const charPx = DEFAULT_CHAR_PX;
const isStep = (s) => TICK_STEPS.includes(s);
let grid = 0;
for (const fps of [5, 25, 29.97, 30, 60, 150]) {
    for (const seconds of [0.5, 2, 10, 45, 90, 600, 1200, 1800, 3600, 3 * 3600, 26 * 3600]) {
        const total = Math.round(seconds * fps) + 1;
        const endSec = (total - 1) / fps;
        for (const width of [120, 300, 700, 1200, 2400]) {
            const t = seekbarTimeTicks(total, fps, width, { charPx });
            if (!t.step) continue;
            grid++;
            const where = `${seconds} s @ ${fps} fps on ${width} px`;
            const pxPerSec = width / endSec;
            ok(isStep(t.step), `${where}: step ${t.step} is a nice step`);
            ok(t.step >= 1 / fps - 1e-9, `${where}: the step is at least one frame`);
            const labelled = t.majors.filter(m => m.label);
            const widest = Math.max(...labelled.map(m => m.label.length)) * charPx;
            ok(labelled.length < 2 || t.step * pxPerSec >= Math.max(MIN_LABEL_SPACING_PX, widest * 1.75) - 1e-6,
                `${where}: labels are far enough apart`);
            // The CHOSEN step is the smallest that fits: the next smaller one (at
            // least a frame long) would have crowded the labels.
            const i = TICK_STEPS.indexOf(t.step);
            if (i > 0 && TICK_STEPS[i - 1] >= 1 / fps - 1e-9) {
                const smaller = TICK_STEPS[i - 1];
                const lastLabel = formatTickLabel(Math.floor(endSec / smaller + 1e-9) * smaller, smaller >= 1 ? 0 : 1);
                ok(smaller * pxPerSec < Math.max(MIN_LABEL_SPACING_PX, 1.75 * lastLabel.length * charPx),
                    `${where}: the step ${t.step} is the smallest that fits`);
            }
            ok(t.majors.every((m, k) => Math.abs(m.seconds - k * t.step) < 1e-9 && m.frac >= 0 && m.frac <= 1),
                `${where}: majors every ${t.step} s from 0, within the bar`);
            ok(t.majors[t.majors.length - 1].seconds <= endSec + 1e-9 && t.majors[t.majors.length - 1].seconds + t.step > endSec,
                `${where}: majors run to the end and not past it`);
            // A centred label never hangs off the right end; one that would is dropped.
            ok(t.majors.every(m => !m.label || m.align === 'start' || m.frac * width + m.label.length * charPx / 2 <= width + 1e-9),
                `${where}: no label hangs off the right end`);
            if (t.minorStep) {
                const ratio = t.step / t.minorStep;
                ok(isStep(t.minorStep) && Math.abs(ratio - Math.round(ratio)) < 1e-6 && Math.round(ratio) <= MAX_MINOR_PER_MAJOR,
                    `${where}: minor ${t.minorStep} divides major ${t.step} into ≤ ${MAX_MINOR_PER_MAJOR}`);
                ok(t.minorStep * pxPerSec >= MIN_MINOR_SPACING_PX && t.minorStep >= 1 / fps - 1e-9,
                    `${where}: minors are ${MIN_MINOR_SPACING_PX}+ px and a frame+ apart`);
                const majorSet = t.majors.map(m => m.frac);
                ok(t.minors.every(f => majorSet.every(g => Math.abs(f - g) * width > 1)), `${where}: no minor sits on a major`);
            }
        }
    }
}
ok(grid > 200, `the grid covered ${grid} cases`);

// ---- longer -> longer steps; wider -> shorter ones ------------------------------------
{
    const stepFor = (seconds, width) => seekbarTimeTicks(seconds * 30 + 1, 30, width).step;
    const lengths = [10, 60, 600, 1800, 3600, 4 * 3600];
    const steps = lengths.map(s => stepFor(s, 700));
    ok(steps.every((s, i) => i === 0 || s >= steps[i - 1]) && steps[steps.length - 1] > steps[0],
        `at 700 px, steps never shrink as the recording grows: ${steps.join(' / ')}`);
    const widths = [200, 400, 800, 1600];
    const byWidth = widths.map(w => stepFor(1800, w));
    ok(byWidth.every((s, i) => i === 0 || s <= byWidth[i - 1]) && byWidth[byWidth.length - 1] < byWidth[0],
        `30 min, steps never grow as the bar widens: ${byWidth.join(' / ')}`);
}

// ---- short clips get sub-second labels, never finer than a frame ---------------------
{
    const t = seekbarTimeTicks(31, 30, 700);   // one second
    ok(t.step < 1 && t.majors.every(m => /^\d\d:\d\d\.\d$/.test(m.label || '00:00.0')), `1 s clip: tenths (${t.majors.map(m => m.label).join(' ')})`);
    const slow = seekbarTimeTicks(11, 5, 700);  // 2 s at 5 fps: a frame is 0.2 s
    ok(slow.step >= 0.2 && (!slow.minorStep || slow.minorStep >= 0.2), `5 fps: no step under a frame (${slow.step} / ${slow.minorStep})`);
}

console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.slice(0, 20).map(f => '  - ' + f).join('\n')); process.exit(1); }
