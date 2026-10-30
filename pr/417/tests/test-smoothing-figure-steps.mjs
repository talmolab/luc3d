/**
 * test-smoothing-figure-steps.mjs — the docs' step figures make claims about the
 * made-up trace (`scripts/smoothing-wiki-figures.mjs`). These hold them to what the
 * real filter does to it, so a change to the trace cannot quietly make them false.
 */
import { stageSketch, gapSketch, TRACE_FRAMES } from '../ui/smoothing-windows-figure.js';

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const SPIKE = TRACE_FRAMES.spike, PEAK = TRACE_FRAMES.fast;
const median = (w) => stageSketch('median', w);
const gaussian = (w) => stageSketch('gaussian', w, { medianWindow: 3 });
const lost = (s) => s.truth[PEAK] - s.out[PEAK];
const same = (a, b) => a.every((v, i) => v === b[i]);
// How far a trace strays from the true movement, away from the fast move and the spike.
const stray = (s) => {
    let sum = 0, n = 0;
    s.out.forEach((v, t) => {
        if (Math.abs(t - PEAK) > 8 && Math.abs(t - SPIKE) > 3) { sum += (v - s.truth[t]) ** 2; n++; }
    });
    return Math.sqrt(sum / n);
};

console.log('Median');
const raw = median(0);
check(raw.raw[SPIKE] - raw.truth[SPIKE] === 28, 'the spike is 28 mm off the true movement');
check(same(median(1).out, raw.raw), '1 frame changes nothing');
const m3 = median(3), m11 = median(11);
check(Math.abs(m3.out[SPIKE] - m3.truth[SPIKE]) < 8, `3 frames remove the spike (${(m3.out[SPIKE] - m3.truth[SPIKE]).toFixed(1)} mm left)`);
check(lost(m3) < 8, `3 frames keep the fast move (${lost(m3).toFixed(1)} of 30 mm lost)`);
check(lost(m11) > 25, `11 frames flatten the fast move (${lost(m11).toFixed(1)} of 30 mm lost)`);

console.log('Gaussian, on the 3-frame median');
const g0 = gaussian(0), g1 = gaussian(1), g5 = gaussian(5), g15 = gaussian(15);
check(same(g0.medOut, m3.out), 'its input is the 3-frame median');
check(same(g1.out, g0.medOut), '1 frame changes nothing');
const m3Stray = stray(m3);
check(stray(g5) < m3Stray, `5 frames reduce the jitter (${m3Stray.toFixed(2)} → ${stray(g5).toFixed(2)} mm)`);
check(lost(g5) < 8, `5 frames keep the fast move (${lost(g5).toFixed(1)} of 30 mm lost)`);
check(lost(g15) > 15, `15 frames damp the fast move by over half (${lost(g15).toFixed(1)} of 30 mm lost)`);

console.log('Gaps, at a 3-frame median and a 9-frame Gaussian');
const gaps = (maxGap, minSegment) => gapSketch({ median: 3, gaussian: 9, maxGap, minSegment });
const sizes = (s) => s.segments.map((g) => g.end - g.start).join('+');
const d55 = gaps(5, 5), d52 = gaps(5, 2), d75 = gaps(7, 5);
check(sizes(d55) === '20+3+24', `the defaults cut three segments (${sizes(d55)})`);
check(same(d55.out.subarray(27, 30), d55.raw.subarray(27, 30)), 'the 3-frame segment is left as it is');
check(sizes(d52) === '20+3+24', `minimum segment 2 keeps them (${sizes(d52)})`);
check(d52.out[27] === d52.raw[27] && d52.out[29] === d52.raw[29], 'its ends have no room for a window');
check(Math.abs(d52.out[28] - d52.raw[28]) > 1, `its middle frame changes (${Math.abs(d52.out[28] - d52.raw[28]).toFixed(1)} mm)`);
check(sizes(d75) === '60', `max gap 7 makes one segment (${sizes(d75)})`);
check(d75.out.every((v, t) => Number.isNaN(v) === Number.isNaN(d75.raw[t])), 'the missing frames are still not filled in');

const FIRST_BACK = 36;
const off = (s) => s.out[FIRST_BACK] - s.truth[FIRST_BACK];
check(Math.abs(off(d55)) < 1.5, `at the defaults the first frame back stays on the true movement (${off(d55).toFixed(1)} mm)`);
check(off(d75) > 4, `max gap 7 pulls it ahead of the true movement (${off(d75).toFixed(1)} mm)`);
const d75g15 = gapSketch({ median: 3, gaussian: 15, maxGap: 7, minSegment: 5 });
check(off(d75g15) > 6, `more so with the 15-frame Gaussian the Settings text suggests (${off(d75g15).toFixed(1)} mm)`);

console.log(fails ? `\n${fails} FAILED` : '\nPASS');
process.exit(fails ? 1 : 0);
