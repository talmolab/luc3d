/**
 * sleap-multiview-frames.mjs — a real SLEAP multi-view file opens with every group on its
 * own frame. Its frame groups store no frame number, so they all used to land on frame 0,
 * each overwriting the last: 2 groups instead of 6, 14 extra detections on frame 0, and a
 * save made that permanent. Patch `(session frame numbers)`.
 *
 * The numbers are what Python sleap-io reads from the file (tests/fixtures/sleap-multiview).
 *
 * Run: node tests/e2e/sleap-multiview-frames.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import fs from 'node:fs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;
const bytes = fs.readFileSync(path.join(repoRoot, 'tests/fixtures/sleap-multiview/multiview.slp'));

let fails = 0;
const check = (c, m, extra) => {
    console.log((c ? '  ✓ ' : '  ✗ ') + m + (!c && extra !== undefined ? '  ' + JSON.stringify(extra).slice(0, 700) : ''));
    if (!c) fails++;
};


let browser;
try {
    browser = await launchBrowser({ headless: true });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm && window.__lucid, null, { timeout: 120000 });

    await page.evaluate(async (b64) => {
        const fileio = await import('/import-export/file-io.js');
        window.__file = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        window.__dump = () => {
            const s = window.__lucid.state.session;
            const byFrame = {};
            for (const [f, gs] of s.instanceGroups) byFrame[f] = gs.map((g) => g.instances.size);
            let detections = 0;
            const perFrame = {};
            for (const [f, fg] of s.frameGroups) {
                let n = 0;
                for (const list of fg.instances.values()) n += list.length;
                for (const list of fg.unlinkedInstances.values()) n += list.length;
                perFrame[f] = n;
                detections += n;
            }
            return { byFrame, detections, perFrame, lazy: !!s.lazyLoader };
        };
        window.__saveEager = async () => {
            const AS = await import('/ui/app-state.js');
            window.__file = await window.SleapIO.saveSlpToBytes(
                fileio.buildSlpLabelsAllViews(AS.state.session, AS.state.views, AS.state.videoFiles));
        };
        window.__typedGroups = async () => {
            const labels = await window.SleapIO.readSlpStreaming(new File([window.__file], 'x.slp'), {
                openVideos: false, h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href,
            });
            const out = {};
            for (const [f, fg] of labels.sessions[0].frameGroups) {
                out[f] = fg.instanceGroups.map((g) => g.instanceByCamera.size);
                for (const lf of fg.labeledFrames) if (lf.frameIdx !== f) out.wrong = (out.wrong || 0) + 1;
            }
            return out;
        };
    }, bytes.toString('base64'));

    async function waitLoad() {
        for (let i = 0; i < 400; i++) {
            const s = await page.evaluate(() => {
                const b = [...document.querySelectorAll('button')].find(x => /Skip|Later/i.test(x.textContent || ''));
                if (b) b.click();
                return { done: window.__loadDone, prompt: !!document.getElementById('videoSelectOverlay') };
            });
            if (s.prompt) await page.keyboard.press('Escape');
            if (s.done) return s.done;
            await page.waitForTimeout(100);
        }
        return 'timeout';
    }
    const loadEager = async () => {
        await page.evaluate(async () => {
            const imp = await import('/import-export/slp-import.js');
            window.__loadDone = false;
            imp.handleLoadSlpFile(new File([window.__file], 'multiview.slp'))
                .then(() => { window.__loadDone = true; }, (e) => { window.__loadDone = 'ERR ' + (e && e.stack || e); });
        });
        return waitLoad();
    };
    const loadLazy = async () => {
        await page.evaluate(() => {
            window.__loadDone = false;
            (async () => {
                try {
                    const sl = await import('/loading/session-loader.js');
                    await sl.handleLoadProjectSlpLazy(new File([window.__file], 'multiview.slp'));
                    window.__loadDone = true;
                } catch (e) { window.__loadDone = 'ERR ' + String(e && e.stack || e).slice(0, 500); }
            })();
        });
        return waitLoad();
    };
    const eq = (a, b, m) => check(JSON.stringify(a) === JSON.stringify(b), m, { got: a, want: b });
    const GROUPS = { 0: [8, 6], 1: [8, 6], 2: [8, 6] };
    // 84 in the file: every detection is there twice, a prediction and the user's copy at
    // the same points, and LUC3D keeps the grouped copy (`restoreGroupingAndUnlink`).
    const DETECTIONS = 42;

    console.log('\n-- the file as sleap-io reads it --');
    eq(await page.evaluate(() => window.__typedGroups()), GROUPS, 'each frame has its 2 groups, members on that frame');

    console.log('\n-- Load SLP --');
    check((await loadEager()) === true, 'loads');
    let d = await page.evaluate(() => window.__dump());
    eq(d.byFrame, GROUPS, 'each frame has its 2 groups');
    eq(d.detections, DETECTIONS, 'and no extra detections');

    console.log('\n-- lazy reopen --');
    check((await loadLazy()) === true, 'loads');
    d = await page.evaluate(() => window.__dump());
    check(d.lazy, 'the route is lazy');
    eq(d.byFrame, GROUPS, 'each frame has its 2 groups');

    console.log('\n-- LUC3D save, read back --');
    check((await loadEager()) === true, 'loads');
    await page.evaluate(() => window.__saveEager());
    eq(await page.evaluate(() => window.__typedGroups()), GROUPS, 'a save keeps them');
    check((await loadEager()) === true, 'reopens');
    d = await page.evaluate(() => window.__dump());
    eq(d.byFrame, GROUPS, 'each frame has its 2 groups');
    eq(d.detections, DETECTIONS, 'and no extra detections');

    check(errs.length === 0, 'no page errors', errs);
} catch (e) {
    console.error(e);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill();
}
console.log(fails ? `\n${fails} check(s) failed` : '\nAll checks passed');
process.exit(fails ? 1 : 0);
