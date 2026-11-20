/**
 * videos-table-counts.mjs — the Videos table counts (Labeled, Groups, Score)
 * only while its section is on screen.
 *
 * The counts read every frame and every group member; at the end of a
 * Triangulate All on the 8-camera, 108,000-frame project that was ~205 ms in
 * the run's last task, with the Videos section not even open (by default only
 * Instances is). Now:
 *
 * §1  Videos closed: a rebuild lists the videos but leaves the three count
 *     cells empty, and does not count.
 * §2  Opening it (`showPanelTab`) fills them, with the numbers the old
 *     per-camera loops gave.
 * §3  Folded: a rebuild empties them again; unfolding fills them.
 * §4  Open: a rebuild of a small project counts at once.
 * §5  A count too big for one slice (forced with `__lucidVideoCountSliceFrames`)
 *     shows "…" and finishes in later tasks, with the same numbers.
 * §6  A rebuild during a count stops the older count.
 *
 * Run: node tests/e2e/videos-table-counts.mjs
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const server = await startServer(repoRoot);
const PORT = server.port;

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

let browser;
try {
    browser = await launchBrowser();
    const page = await browser.newPage({ viewport: { width: 1600, height: 1000 } });
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async () => {
        await (await import(new URL('pose/initialization.js', document.baseURI).href)).loadDemoSession();
    });
    await page.waitForFunction(() => window.__lucid.state.session, null, { timeout: 60000 });
    // The demo's instances are all unlinked: on even frames, link the first
    // one of each view into a group (only one view on every third frame) and
    // score it.
    await page.evaluate(async () => {
        const { InstanceGroup } = await import(new URL('pose/pose-data.js', document.baseURI).href);
        const s = window.__lucid.state.session;
        let id = 900000;
        for (const [f, fg] of s.frameGroups) {
            if (f % 2) continue;
            const g = new InstanceGroup(id++, 0);
            fg.unlinkedInstances.forEach((list, cam) => {
                if (!list[0] || (f % 3 === 0 && g.instances.size)) return;
                const inst = list[0].instance;
                inst.score = 0.5 + (f % 5) / 10;
                fg.addInstance(cam, inst);
                g.instances.set(cam, inst);
            });
            if (g.instances.size) s.instanceGroups.set(f, (s.instanceGroups.get(f) || []).concat([g]));
        }
    });

    // The table's rows as [name, labeled, groups, score], and what the old
    // per-camera loops gave for each row's camera.
    const read = () => page.evaluate(() => {
        const { state } = window.__lucid;
        // Each video is a name row over a counts row (Frames, Labeled, Groups, Score).
        const rows = [...document.querySelectorAll('#videosTable tbody tr.video-name-row')].map(tr =>
            [tr.children[0].textContent].concat([1, 2, 3].map(i => tr.nextElementSibling.children[i].textContent)));
        const list = state.videoFiles.length ? state.videoFiles : state.views;
        const expected = list.map(vf => {
            const cam = vf.assignedCamera || vf.name;
            let labeled = 0, groups = 0, sum = 0, n = 0;
            for (const [, fg] of state.session.frameGroups) {
                const a = fg.getInstances(cam), u = fg.getUnlinkedInstances(cam);
                if (a.length || u.length) labeled++;
                for (const i of a) if (i.score > 0) { sum += i.score; n++; }
            }
            for (const [, gs] of state.session.instanceGroups) {
                for (const g of gs) for (const [c, i] of g.instances) if (i && c === cam) groups++;
            }
            return [vf.name, labeled.toLocaleString('en-US'), groups.toLocaleString('en-US'), n > 0 ? (sum / n).toFixed(2) : '-'];
        });
        return { rows, expected };
    });
    const ip = () => page.evaluate(async () => {
        (await import(new URL('ui/info-panel.js', document.baseURI).href)).populateVideosTable();
    });
    const rail = (fn) => page.evaluate(async (fn) => {
        (await import(new URL('ui/panel-rail.js', document.baseURI).href))[fn]('tabVideos');
        await new Promise(r => setTimeout(r, 50));   // the MutationObserver
    }, fn);

    console.log('\n§1 Videos closed: rows listed, counts left empty');
    const open0 = await page.evaluate(async () =>
        (await import(new URL('ui/panel-rail.js', document.baseURI).href)).getOpenPanelTabs().map(p => p.tab));
    check(open0.indexOf('tabVideos') < 0, 'precondition: Videos is not open (' + open0.join() + ')');
    await ip();
    let r = await read();
    check(r.rows.length > 0 && r.rows.length === r.expected.length, r.rows.length + ' video rows');
    check(r.expected.some(e => e[2] !== '0'), 'precondition: the demo has groups to count');
    check(r.rows.every(row => row[1] === '' && row[2] === '' && row[3] === ''),
        'Labeled / Groups / Score are empty: ' + JSON.stringify(r.rows[0]));

    console.log('\n§2 opening Videos fills them in');
    await rail('showPanelTab');
    r = await read();
    check(JSON.stringify(r.rows) === JSON.stringify(r.expected),
        'the counts match the old per-camera loops: ' + JSON.stringify(r.rows) + ' vs ' + JSON.stringify(r.expected));

    console.log('\n§3 folded: a rebuild empties them, unfolding fills them');
    await rail('togglePanelSection');
    await ip();
    r = await read();
    check(r.rows.every(row => row[1] === '' && row[2] === '' && row[3] === ''), 'empty while folded');
    await rail('togglePanelSection');
    r = await read();
    check(JSON.stringify(r.rows) === JSON.stringify(r.expected), 'filled again on unfolding');

    console.log('\n§4 open: a rebuild counts at once');
    await ip();
    r = await read();
    check(JSON.stringify(r.rows) === JSON.stringify(r.expected), 'counted in the same call');

    console.log('\n§5 a count too big for one slice shows "…" and finishes in later tasks');
    await page.evaluate(() => { globalThis.__lucidVideoCountSliceFrames = 2; });
    await ip();
    r = await read();
    check(r.rows.every(row => row[1] === '…' && row[2] === '…' && row[3] === '…'),
        'right after the rebuild: "…" ' + JSON.stringify(r.rows[0]));
    await page.waitForFunction(() => [...document.querySelectorAll('#videosTable tbody tr.video-counts-row')]
        .every(tr => tr.children[2].textContent !== '…'), null, { timeout: 10000 });
    r = await read();
    check(JSON.stringify(r.rows) === JSON.stringify(r.expected), 'then the same counts: ' + JSON.stringify(r.rows));

    console.log('\n§6 a rebuild during a count: the older count stops, the newer one fills the table');
    await ip();
    const firstCells = await page.evaluateHandle(() => [...document.querySelectorAll('#videosTable tbody tr.video-counts-row')].map(tr => tr.children[2]));
    await ip();
    await page.waitForFunction(() => [...document.querySelectorAll('#videosTable tbody tr.video-counts-row')]
        .every(tr => tr.children[2].textContent !== '…'), null, { timeout: 10000 });
    await page.waitForTimeout(200);
    check(await page.evaluate(cells => cells.every(td => td.textContent === '…'), firstCells),
        'the replaced rows were never filled');
    r = await read();
    check(JSON.stringify(r.rows) === JSON.stringify(r.expected), 'the table has the counts');
    await page.evaluate(() => { delete globalThis.__lucidVideoCountSliceFrames; });
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
