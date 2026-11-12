/**
 * test-seekbar-tooltip.mjs — text of the seekbar hover tooltip (#142,
 * ui/seekbar-tooltip.js). The DOM half is covered by
 * tests/e2e/seekbar-tooltip.mjs.
 *
 * Run:  node tests/test-seekbar-tooltip.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { formatTimestamp, seekbarTooltipText } =
    await import(pathToFileURL(path.join(HERE, '..', 'ui', 'seekbar-tooltip.js')).href);

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    if (a === e) passed++;
    else { failed++; failures.push(`${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); console.error('  ✗ ' + m); }
}

// formatTimestamp
eq(formatTimestamp(0), '00:00.000', 'zero');
eq(formatTimestamp(41.1333), '00:41.133', 'sub-minute, milliseconds');
eq(formatTimestamp(61.5), '01:01.500', 'over a minute');
eq(formatTimestamp(59.9996), '01:00.000', 'rounds to ms BEFORE splitting (no 00:60.000)');
eq(formatTimestamp(3599.9999), '1:00:00.000', 'rounds up into the hour');
eq(formatTimestamp(3723.25), '1:02:03.250', 'hours are unpadded, minutes padded');
eq(formatTimestamp(-1), '00:00.000', 'negative clamps to zero');

// seekbarTooltipText — frames are shown 1-based, like #currentFrame
eq(seekbarTooltipText(0, 30), 'Frame 1 · 00:00.000', 'first frame');
eq(seekbarTooltipText(1233, 30), 'Frame 1,234 · 00:41.100', 'thousands separator, frame start time');
eq(seekbarTooltipText(180209, 150), 'Frame 180,210 · 20:01.393', 'long 150 fps recording (Mimica)');
eq(seekbarTooltipText(9, 0), 'Frame 10', 'fps 0 (no video yet): no timestamp');
eq(seekbarTooltipText(9, undefined), 'Frame 10', 'fps missing: no timestamp');
eq(seekbarTooltipText(9, NaN), 'Frame 10', 'fps NaN: no timestamp');
eq(seekbarTooltipText(9, Infinity), 'Frame 10', 'fps Infinity: no timestamp');

console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
