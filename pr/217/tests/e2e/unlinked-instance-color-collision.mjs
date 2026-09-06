/**
 * unlinked-instance-color-collision.mjs — real-browser regression test.
 *
 * Bug: two DIFFERENT unlinked instances (no group, no identity — e.g. two
 * animals each visible in only 1 camera this frame, so commitTrackedFrame's
 * `members.length < 2` check never groups them) that happen to share the
 * same raw per-camera trackIdx render with the EXACT SAME color in the 2D
 * viewer, with nothing to tell them apart. Unlike grouped/linked instances
 * (which have `group.identityId` as an unambiguous fallback — see
 * getGroupColor and commitTrackedFrame's writtenThisFrame guard), an
 * unlinked instance has no group at all, so `getInstanceColor` colors it
 * purely by the raw trackIdx — a property of the original prediction data,
 * not something LUCID's tracker resolves.
 *
 * Fix: `drawUnlinkedInstances` (ui/overlays.js) now precomputes, per draw
 * call, which unlinked instances share a trackIdx and darkens every
 * occurrence after the first so they stay visually distinguishable.
 *
 * Run: node unlinked-instance-color-collision.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8094);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    page.on('console', msg => { if (msg.type() === 'error') console.log('  [console.error]', msg.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const r = await page.evaluate(async () => {
        const pd = await import('/pose/pose-data.js');
        const overlays = await import('/ui/overlays.js');
        const { Instance, UnlinkedInstance } = pd;

        // Two DIFFERENT unlinked instances (no group/identity) sharing the
        // same raw trackIdx=0 on the same camera — the scenario with no
        // fallback signal available at all.
        const instA = new Instance([[10, 10]], 0, 'predicted', 1);
        const instB = new Instance([[50, 50]], 0, 'predicted', 1);
        // A third, DIFFERENT trackIdx instance — must be entirely unaffected.
        const instC = new Instance([[90, 90]], 1, 'predicted', 1);
        const ulA = new UnlinkedInstance(instA, 'camA');
        const ulB = new UnlinkedInstance(instB, 'camA');
        const ulC = new UnlinkedInstance(instC, 'camA');
        const unlinkedInstances = [ulA, ulB, ulC];

        function capturePrimaryColors() {
            const canvas = document.createElement('canvas');
            canvas.width = 200; canvas.height = 200;
            const ctx = canvas.getContext('2d');
            const recorded = [];
            const proto = CanvasRenderingContext2D.prototype;
            for (const prop of ['fillStyle', 'strokeStyle']) {
                const desc = Object.getOwnPropertyDescriptor(proto, prop);
                Object.defineProperty(ctx, prop, {
                    get() { return desc.get.call(this); },
                    set(v) { recorded.push(v); desc.set.call(this, v); },
                });
            }
            overlays.drawUnlinkedInstances(ctx, unlinkedInstances, { nodes: ['a'], edges: [] }, {
                typeFilter: 'predicted',
                colorByIdentity: false,
                session: null,
                frameIdx: 0,
            });
            // Each instance's very first recorded style is its primary
            // skeleton color (before any shadow/selection-chrome styling).
            const hexOnly = recorded.filter(c => typeof c === 'string' && c.startsWith('#'));
            // 3 instances drawn in order -> primary colors at positions
            // 0, 3, 6 (each instance emits [primary, shadow-rgba (filtered
            // out above), secondary] — i.e. every 2nd hex entry starting at 0).
            return { hexOnly };
        }

        return capturePrimaryColors();
    });

    console.log('  measured:', JSON.stringify(r, null, 2));
    // Instances drawn in order A, B, C — each contributes 2 hex colors
    // (primary "fill", secondary "stroke"/shadow-adjacent) before the next
    // instance's colors begin.
    const colorA = r.hexOnly[0];
    const colorB = r.hexOnly[2];
    const colorC = r.hexOnly[4];
    check(!!colorA && !!colorB && !!colorC, `captured a primary color for all 3 instances (got ${JSON.stringify(r.hexOnly)})`);
    check(colorA !== colorB, `colliding instances A (trackIdx=0) and B (trackIdx=0) get DISTINCT colors (A=${colorA}, B=${colorB})`);
    check(colorA !== colorC, `non-colliding instance C (trackIdx=1) is unaffected and distinct from A (A=${colorA}, C=${colorC})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
process.exit(fails ? 1 : 0);
