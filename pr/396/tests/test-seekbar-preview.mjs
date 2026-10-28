/**
 * test-seekbar-preview.mjs — the pure half of the seekbar's hover thumbnail
 * (ui/seekbar-preview.js): where the box goes and its thumbnail LRU. The DOM
 * half (and that hovering never moves playback) is covered by
 * tests/e2e/seekbar-preview.mjs.
 *
 * Run:  node tests/test-seekbar-preview.mjs
 */
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const { previewLeft, createThumbCache, PREVIEW_WIDTH, THUMB_CACHE } =
    await import(pathToFileURL(path.join(HERE, '..', 'ui', 'seekbar-preview.js')).href);

let passed = 0, failed = 0; const failures = [];
function eq(a, e, m) {
    if (a === e) passed++;
    else { failed++; failures.push(`${m} (expected ${JSON.stringify(e)}, got ${JSON.stringify(a)})`); console.error('  ✗ ' + m); }
}

// previewLeft — centred over the cursor, clamped over the bar
eq(previewLeft(500, 1000, 200), 500, 'mid-bar: over the cursor');
eq(previewLeft(10, 1000, 200), 100, 'left end: clamped so the box starts at the bar');
eq(previewLeft(990, 1000, 200), 900, 'right end: clamped so the box ends at the bar');
eq(previewLeft(100, 1000, 200), 100, 'exactly at the left clamp');
eq(previewLeft(50, 150, 200), 75, 'bar narrower than the box: centred on the bar');
eq(previewLeft(140, 200, 200), 100, 'bar exactly the box: centred');

// createThumbCache — LRU, evicted bitmaps are closed
function bmp(name) { return { name, closed: false, close() { this.closed = true; } }; }
const c = createThumbCache(3);
const a = bmp('a'), b = bmp('b'), d = bmp('d'), e = bmp('e');
c.set('a', a); c.set('b', b); c.set('d', d);
eq(c.size, 3, 'fills to max');
eq(c.get('a'), a, 'get returns the entry');            // a is now newest: order b, d, a
c.set('e', e);
eq(c.has('b'), false, 'the least recently USED entry is evicted (b, not a)');
eq(b.closed, true, 'an evicted bitmap is closed');
eq(a.closed, false, 'a refreshed entry survives');
eq(c.size, 3, 'stays at max');
const a2 = bmp('a2');
c.set('a', a2);
eq(a.closed, true, 'replacing a key closes the old bitmap');
eq(c.get('a'), a2, 'and keeps the new one');
c.clear();
eq(c.size, 0, 'clear empties it');
eq(d.closed && e.closed && a2.closed, true, 'clear closes every bitmap');

eq(PREVIEW_WIDTH > 0 && THUMB_CACHE > 0, true, 'constants are positive');

console.log(`${passed} passed, ${failed} failed`);
if (failed) { console.error(failures.map(f => '  - ' + f).join('\n')); process.exit(1); }
