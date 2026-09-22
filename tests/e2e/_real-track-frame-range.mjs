/**
 * _real-track-frame-range.mjs — real-data acceptance run for Track Frame Range
 * (#212). An investigation tool, not a suite assertion (the `_real-` prefix
 * excludes it from suite runs), because it needs a real multi-camera project on
 * disk. It is the `lucid-e2e` Stage 3 check for this feature: the synthetic
 * `track-frame-range.mjs` proves the logic, this proves it against a real
 * proofread recording with real calibration, real predictions and real tracks.
 *
 * It reopens the project lazily (the windowed `SioLazyLoader` path — the one
 * where a range run's `start`/`end` actually have to be threaded through
 * `sweepLazyFrameWindows`), runs a full Track All to establish a baseline over
 * every frame, then runs Track Frame Range over a narrow window and asserts the
 * two properties that cannot be eyeballed:
 *
 *   1. every frame OUTSIDE the window is byte-identical afterwards, and
 *   2. the identity list did not grow, across two consecutive range runs.
 *
 * Run:
 *   SLP=/abs/path/to/project.slp node tests/e2e/_real-track-frame-range.mjs
 *   SLP=... LO=1200 HI=1260 ANIMALS=2 node tests/e2e/_real-track-frame-range.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8144);
const SLP = process.env.SLP;
const ANIMALS = process.env.ANIMALS ? Number(process.env.ANIMALS) : null;
let LO = process.env.LO ? Number(process.env.LO) : null;
let HI = process.env.HI ? Number(process.env.HI) : null;

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };
const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';

if (!SLP || !fs.existsSync(SLP)) {
    console.error('Set SLP=/abs/path/to/project.slp (a real multi-view LUCID/SLEAP project).');
    process.exit(2);
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log(`  [${el()}] [pageerror] ` + String(e).slice(0, 300)); fails++; });
    page.on('crash', () => { console.log(`  [${el()}] *** RENDERER CRASHED ***`); fails++; });
    // Track All asks for the animal count with a native prompt(). Playwright
    // AUTO-DISMISSES an unhandled dialog, so prompt() returns null,
    // promptNumAnimals() returns false, and trackAll() returns silently with no
    // status change and no work done — which is exactly how the baseline below
    // came back empty on the first attempt at this harness. Accept it instead.
    // (Track Frame Range needs no handler: its modal collects the count, which
    // is the reason runTrackingPass skips the prompt on that path.)
    page.on('dialog', async d => { await d.accept(ANIMALS != null ? String(ANIMALS) : ''); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO, { timeout: 30000 });

    // The lazy project loader ends in an interactive attach-videos modal that
    // never resolves headlessly, so dismiss modals on a timer and poll the
    // resulting state instead of awaiting the whole chain (same approach as
    // `_real-roundtrip.mjs`).
    await page.evaluate(() => {
        setInterval(() => {
            for (const b of Array.from(document.querySelectorAll('button'))) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t.startsWith('Skip') || t === 'Cancel' || t === 'Close')
                    && b.offsetParent !== null) b.click();
            }
        }, 250);
    });

    // Hand the loader a DISK-BACKED File through a real <input type=file>, the
    // way the user's picker does — not a fetched ArrayBuffer, which would pin
    // the whole project in renderer memory for the run.
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file';
        inp.id = '__slpPicker';
        inp.style.cssText = 'position:fixed;left:-9999px';
        document.body.appendChild(inp);
    });
    await page.setInputFiles('#__slpPicker', SLP);
    await page.evaluate(() => {
        window.__load = { done: false, err: null };
        (async () => {
            try {
                const sl = await import('/loading/session-loader.js');
                const f = document.getElementById('__slpPicker').files[0];
                sl.handleLoadProjectSlpLazy(f)
                    .then(() => { window.__load.done = true; })
                    .catch(e => { window.__load.err = String((e && e.stack) || e).slice(0, 400); });
            } catch (e) { window.__load.err = String((e && e.stack) || e).slice(0, 400); }
        })();
    });

    console.log(`[${el()}] loading ${path.basename(SLP)} …`);
    await page.waitForFunction(() => {
        const s = window.__lucid.state.session;
        return !!(s && s.cameras && s.cameras.length >= 2 && s.lazyLoader) || window.__load.err;
    }, { timeout: 300000 });

    const info = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        const loader = s.lazyLoader;
        return {
            err: window.__load.err,
            cameras: s.cameras.map(c => c.name),
            nFrames: loader ? loader.nFrames : 0,
            windowed: !!(loader && loader.isSync && typeof loader.releaseWindow === 'function'),
            nodes: s.skeleton && s.skeleton.nodes ? s.skeleton.nodes.length : 0,
            tracks: s.tracks.length,
        };
    });
    if (info.err) { console.log('  load error:', info.err); fails++; throw new Error('load failed'); }
    console.log(`[${el()}] loaded:`, JSON.stringify(info));
    check(info.cameras.length >= 2, `real project has ${info.cameras.length} cameras (${info.cameras.join(', ')})`);
    check(info.windowed, 'precondition: reopened lazily on the WINDOWED loader path (where range start/end must be threaded through sweepLazyFrameWindows)');
    check(info.nFrames > 0, `precondition: loader reports ${info.nFrames.toLocaleString()} frames`);

    // Default the window to a 60-frame span in the middle of the recording.
    if (LO == null) LO = Math.max(0, Math.floor(info.nFrames / 2));
    if (HI == null) HI = Math.min(info.nFrames - 1, LO + 59);
    console.log(`[${el()}] range under test: ${LO}–${HI} (${HI - LO + 1} frames of ${info.nFrames.toLocaleString()})`);

    // Baseline: a full Track All over the real project.
    console.log(`[${el()}] Track All …`);
    const baseline = await page.evaluate(async (animals) => {
        const tracker = await import('/pose/tracker.js');
        tracker.setTrackerNumAnimals(animals);
        const t = performance.now();
        await tracker.trackAll();
        const s = window.__lucid.state.session;
        return {
            ms: Math.round(performance.now() - t),
            status: document.getElementById('statusText').textContent,
            identities: s.identities.length,
            identityNames: s.identities.map(i => i.name),
            fim: s.frameIdentityMap.size,
            groupFrames: s.instanceGroups.size,
            effectiveAnimals: tracker.getTrackerNumAnimals(),
        };
    }, ANIMALS);
    console.log(`[${el()}] Track All:`, JSON.stringify(baseline));
    check(!/error/i.test(baseline.status), `Track All on real data reported no error ("${baseline.status}")`);
    check(baseline.identities > 0, `Track All assigned ${baseline.identities} identities (${baseline.identityNames.join(', ')})`);
    check(baseline.fim > 0, `Track All populated frameIdentityMap (${baseline.fim.toLocaleString()} entries)`);

    // Snapshot everything outside the window, run the range, and diff.
    console.log(`[${el()}] Track Frame Range ${LO}–${HI} …`);
    const r = await page.evaluate(async ({ lo, hi }) => {
        const tracker = await import('/pose/tracker.js');
        const s = window.__lucid.state.session;

        const snap = (keep) => {
            const ids = [];
            for (const rec of s.frameIdentityEntries()) {
                if (!keep(rec.frameIdx)) continue;
                ids.push(rec.frameIdx + '|' + rec.camName + '|' + rec.trackIdx + '=' + rec.identityId);
            }
            ids.sort();
            const groups = [];
            for (const [fi, list] of s.instanceGroups) {
                if (!keep(fi)) continue;
                groups.push(fi + '=' + list.map(g => g.identityId).sort().join(','));
            }
            groups.sort();
            return { ids, groups };
        };
        const outside = (f) => f < lo || f > hi;
        const inside = (f) => f >= lo && f <= hi;

        const outBefore = snap(outside);
        const inBefore = snap(inside);
        const idsBefore = s.identities.length;

        const t = performance.now();
        await tracker.trackFrameRange(lo, hi);
        const ms1 = Math.round(performance.now() - t);
        const status = document.getElementById('statusText').textContent;
        const outAfter = snap(outside);
        const inAfter = snap(inside);
        const idsAfterRun1 = s.identities.length;

        // A second identical run: this is the #212 workflow (tweak a setting,
        // re-run the same window) and the thing the identity pool exists for.
        await tracker.trackFrameRange(lo, hi);
        const idsAfterRun2 = s.identities.length;
        const outAfterRun2 = snap(outside);

        return {
            ms1, status, idsBefore, idsAfterRun1, idsAfterRun2,
            outsideUnchanged: JSON.stringify(outBefore) === JSON.stringify(outAfter),
            outsideUnchangedRun2: JSON.stringify(outBefore) === JSON.stringify(outAfterRun2),
            outsideIdCount: outBefore.ids.length,
            outsideGroupFrames: outBefore.groups.length,
            inIdsBefore: inBefore.ids.length,
            inIdsAfter: inAfter.ids.length,
            inGroupFramesBefore: inBefore.groups.length,
            inGroupFramesAfter: inAfter.groups.length,
            identityNames: s.identities.map(i => i.name),
        };
    }, { lo: LO, hi: HI });

    console.log(`[${el()}] Track Frame Range:`, JSON.stringify(r, null, 2));
    check(!/error/i.test(r.status), `Track Frame Range on real data reported no error ("${r.status}")`);
    // Status text is 1-based, like every frame number the app shows.
    check(new RegExp('\\(' + (LO + 1) + '\\D+' + (HI + 1) + '\\)').test(r.status),
        `status names the real range it tracked, 1-based (expected ${LO + 1}-${HI + 1} in: "${r.status}")`);
    check(r.outsideUnchanged,
        `every frame outside ${LO}–${HI} is byte-identical after the range run ` +
        `(${r.outsideIdCount.toLocaleString()} identity entries across ${r.outsideGroupFrames.toLocaleString()} grouped frames)`);
    check(r.outsideUnchangedRun2,
        'still byte-identical outside the window after a SECOND consecutive range run');
    check(r.inIdsAfter > 0 && r.inGroupFramesAfter > 0,
        `frames inside the window were re-tracked (${r.inIdsAfter} identity entries, ${r.inGroupFramesAfter} grouped frames)`);
    check(r.idsAfterRun1 === r.idsBefore,
        `the identity list did not grow on the first range run (${r.idsBefore} -> ${r.idsAfterRun1})`);
    check(r.idsAfterRun2 === r.idsBefore,
        `nor on the second (${r.idsBefore} -> ${r.idsAfterRun2}; ${r.identityNames.join(', ')})`);

    await browser.close();
} catch (e) {
    console.log('  [harness error]', String((e && e.stack) || e).slice(0, 600));
    fails++;
} finally {
    server.kill('SIGTERM');
}

console.log(fails ? `\nFAIL — ${fails} check(s) failed` : '\nPASS');
process.exit(fails ? 1 : 0);
