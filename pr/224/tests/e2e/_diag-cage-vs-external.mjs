/**
 * Does the ~4 GB pointer-compressed cage cap apply to typed-array backing
 * stores? The whole "move it into typed arrays" plan rests on the answer.
 *
 * Not a test — a sizing experiment for the luc3d #189 follow-up.
 */
import { chromium } from 'playwright';

const page = await (await chromium.launch({
    args: ['--js-flags=--expose-gc', '--enable-precise-memory-info'],
})).newPage();
await page.goto('about:blank');
page.on('console', m => console.log('  [page]', m.text()));

const res = await page.evaluate(async () => {
    const MB = 1048576;
    const gc = () => { for (let i = 0; i < 4; i++) window.gc && window.gc(); };
    const used = () => performance.memory.usedJSHeapSize / MB;
    const limit = performance.memory.jsHeapSizeLimit / MB;
    const out = { limit: +limit.toFixed(0), steps: [] };

    // (1) Does usedJSHeapSize count an external backing store?
    gc(); await new Promise(r => setTimeout(r, 100));
    const b0 = used();
    const big = new Float64Array(64 * MB / 8); // 64 MB of data
    big[0] = 1;
    gc(); await new Promise(r => setTimeout(r, 100));
    out.steps.push({ what: '64 MB Float64Array -> usedJSHeapSize delta', mb: +(used() - b0).toFixed(1) });
    big[1] = 2;

    // (2) Can typed arrays exceed the cage limit in total?
    const keep = [];
    let allocatedMB = 0;
    let crashedAt = null;
    try {
        // Push well past the reported limit, 128 MB at a time.
        while (allocatedMB < Math.ceil(limit) + 2048) {
            const a = new Float64Array(128 * MB / 8);
            a[0] = allocatedMB; a[a.length - 1] = allocatedMB; // force real commit
            keep.push(a);
            allocatedMB += 128;
        }
    } catch (e) {
        crashedAt = { mb: allocatedMB, err: String(e && e.message) };
    }
    out.typedTotalMB = allocatedMB;
    out.typedThrewAt = crashedAt;
    out.usedAtPeak = +used().toFixed(0);
    // checksum so nothing is elided
    let sum = 0; for (const a of keep) sum += a[0];
    out.checksum = sum;
    return out;
});

console.log(`\njsHeapSizeLimit reported: ${res.limit} MB`);
for (const s of res.steps) console.log(`  ${s.what}: +${s.mb} MB`);
console.log(`\nTyped-array total allocated: ${res.typedTotalMB} MB` +
    (res.typedThrewAt ? `  (threw at ${res.typedThrewAt.mb} MB: ${res.typedThrewAt.err})` : '  (no failure)'));
console.log(`usedJSHeapSize at peak: ${res.usedAtPeak} MB (vs limit ${res.limit} MB)`);
console.log(res.typedTotalMB > res.limit
    ? '\n=> Backing stores are OUTSIDE the cage cap. Typed storage buys real headroom.'
    : '\n=> Backing stores appear to count against the cap. Re-plan.');
process.exit(0);
