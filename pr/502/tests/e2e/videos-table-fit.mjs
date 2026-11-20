/**
 * videos-table-fit.mjs — the Videos panel's `#videosTable` fits the 300px
 * info panel with realistic values, in Chromium AND WebKit (the desktop app is
 * WKWebView).
 *
 * With seven columns (Name, Path, Frames, Size, Labeled, Groups, Score) the
 * table measured ~570px and the panel's `overflow-x: hidden` clipped it.
 *
 * §1  With long names and paths, 108,000-frame videos, 1280x1024 and
 *     five-digit labeled/group counts, every header and body cell of
 *     `#videosTable` lies inside `#infoPanel`'s box, and `#infoPanel` does not
 *     scroll sideways. Fails on the 7-column table.
 * §2  One row per video; counts are compact (`108k`, `98.8k`), never clipped,
 *     with the exact comma-grouped count as each cell's title.
 * §3  Name is the widest column, with at least a third of the table
 *     (`Camera0_sideR` shows whole in macOS fonts; reported, not asserted); a
 *     longer name ellipsizes with name + path in its title. A click selects the row,
 *     and the selected-video detail shows the path and resolution that left
 *     the table (the long path stays inside the panel).
 *
 * The session is a stub (Maps of frame groups / instance groups answering the
 * calls `populateVideosTable` makes); no video is decoded.
 *
 * Run: node tests/e2e/videos-table-fit.mjs
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

const LONG_PATH = '/Volumes/talmo/joshua/recordings/2026-11-04_cohort3_five_mice_arena/session_0007/Camera0_sideR/0.mp4';

async function runIn(browser, label) {
    console.log(`\n== ${label} ==`);
    try {
        const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
        page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
        await page.goto(`http://localhost:${PORT}/index.html`);
        await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
        await page.waitForTimeout(600);
        await page.evaluate(() => {
            document.querySelector('.panel-rail-btn[data-tab="tabVideos"]').click();
        });
        await page.waitForTimeout(200);

        await page.evaluate(async (longPath) => {
            const s = window.__lucid.state;
            const names = ['Camera0_sideR', 'Camera1_sideL', 'Camera2_topDown', 'Camera3_backCorner'];
            // 98,765 labeled frames per camera and 87,654 groups: five-digit
            // counts with thousands separators.
            // The shape `createVideoTableCounter` reads: per frame, Maps of
            // camera -> instance list; per group, a Map of camera -> member.
            // `showVideoFileDetail` asks the frame through its methods.
            const inst = [{ score: 0.87, type: 'predicted' }];
            const fg = { instances: new Map(names.map(n => [n, inst])), unlinkedInstances: new Map(),
                getInstances: () => inst, getUnlinkedInstances: () => [] };
            const frameGroups = new Map();
            for (let f = 0; f < 98765; f++) frameGroups.set(f, fg);
            const grp = [{ instances: new Map(names.map(n => [n, inst[0]])) }];
            const instanceGroups = new Map();
            for (let f = 0; f < 87654; f++) instanceGroups.set(f, grp);
            s.videoFiles = names.map(n => ({
                name: n, assignedCamera: n, videoPath: longPath.replace('Camera0_sideR', n),
                videoWidth: 1280, videoHeight: 1024, frameCount: 108000,
            }));
            s.session = Object.assign(Object.create(null), { frameGroups, instanceGroups });
            const mod = await import(new URL('ui/info-panel.js', document.baseURI).href);
            mod.populateVideosTable();
        }, LONG_PATH);
        // The counts fill in over a few tasks (`countVideosInSlices`).
        await page.waitForFunction(() => {
            const tds = [...document.querySelectorAll('#videosTable tbody td')];
            return tds.length > 0 && tds.every(td => td.textContent !== '\u2026' && td.textContent !== '');
        }, null, { timeout: 30000 });

        // ---- §1 every cell inside the panel ----
        const geo = await page.evaluate(() => {
            const panel = document.getElementById('infoPanel').getBoundingClientRect();
            const table = document.getElementById('videosTable');
            const cells = [...table.querySelectorAll('th, td')].map(c => {
                const r = c.getBoundingClientRect();
                return { text: c.textContent.trim(), left: r.left, right: r.right };
            });
            const ip = document.getElementById('infoPanel');
            return {
                panelLeft: panel.left, panelRight: panel.right, panelWidth: panel.width,
                tableWidth: table.getBoundingClientRect().width,
                rows: table.querySelectorAll('tbody tr').length,
                cells,
                hScroll: ip.scrollWidth - ip.clientWidth,
            };
        });
        console.log(`\n§1 table ${geo.tableWidth.toFixed(0)}px in a ${geo.panelWidth.toFixed(0)}px panel`);
        check(geo.rows === 4, 'one row per video');
        const outside = geo.cells.filter(c => !(c.left >= geo.panelLeft - 0.5 && c.right <= geo.panelRight + 0.5));
        check(outside.length === 0, 'every #videosTable cell is inside #infoPanel'
            + (outside.length ? ': ' + outside.slice(0, 4).map(c => `"${c.text}" ${c.left.toFixed(0)}–${c.right.toFixed(0)}`).join(', ') : ''));
        check(geo.hScroll <= 1, '#infoPanel does not scroll sideways (overflow ' + geo.hScroll + 'px)');

        // ---- §2 compact counts, exact in the title ----
        console.log('\n§2 counts readable');
        const counts = await page.evaluate(() => {
            const row = document.querySelector('#videosTable tbody tr');
            return [...row.querySelectorAll('td.mono')].map(td => ({
                text: td.textContent.trim(), title: td.title,
                clipped: td.scrollWidth > td.clientWidth + 1,
            }));
        });
        const texts = counts.map(c => c.text + (c.title ? ' [' + c.title + ']' : ''));
        for (const [want, exact] of [['108k', '108,000'], ['98.8k', '98,765'], ['87.7k', '87,654']]) {
            check(counts.some(c => c.text === want && c.title === exact),
                `a cell reads ${want} with title ${exact} (cells: ${texts.join(' | ')})`);
        }
        check(counts.some(c => c.text === '0.87'), 'the score cell reads 0.87');
        check(counts.every(c => !c.clipped), 'no count cell is clipped');

        // ---- §3 name width, tooltip, selection, detail ----
        console.log('\n§3 name, tooltip and detail');
        const detail = await page.evaluate(() => {
            const rows = document.querySelectorAll('#videosTable tbody tr');
            const short = rows[0].querySelector('td.video-name');
            const long = rows[3].querySelector('td.video-name');
            rows[3].click();
            return {
                nameWidth: short.getBoundingClientRect().width,
                tableWidth: document.getElementById('videosTable').getBoundingClientRect().width,
                widest: Math.max(...[...rows[0].children].map(td => td.getBoundingClientRect().width)),
                shortShown: short.scrollWidth <= short.clientWidth + 1,
                longTitle: long.title,
                detail: document.getElementById('videoDetail').textContent,
                selected: [...document.querySelectorAll('#videosTable tbody tr.selected')].indexOf(rows[3]) === 0
                    && document.querySelectorAll('#videosTable tbody tr.selected').length === 1,
            };
        });
        console.log(`  (Name column ${detail.nameWidth.toFixed(0)}px of ${detail.tableWidth.toFixed(0)}px)`);
        // Font-independent: Name is the widest column and has a third of the
        // table. Whether a given name fits depends on the platform's fonts
        // (CI's Linux fonts are wider), so that is reported, not asserted.
        check(detail.nameWidth >= detail.widest - 0.5 && detail.nameWidth >= detail.tableWidth / 3,
            'Name is the widest column, with at least a third of the table');
        console.log('  ' + (detail.shortShown ? '(Camera0_sideR shows whole here)' : '(Camera0_sideR is ellipsized with these fonts)'));
        check(detail.longTitle.includes('Camera3_backCorner') && detail.longTitle.includes('/0.mp4'),
            'a name cell\'s title carries the full name and the path');
        check(detail.selected, 'clicking a row selects that row only');
        check(detail.detail.includes('Camera3_backCorner/0.mp4'), 'the selected-video detail shows the path');
        check(detail.detail.includes('1280 x 1024'), 'the selected-video detail shows the resolution');
        const detailOverflow = await page.evaluate(() => {
            const panel = document.getElementById('infoPanel').getBoundingClientRect();
            return [...document.querySelectorAll('#videoDetail *')]
                .filter(el => el.getBoundingClientRect().right > panel.right + 0.5).length;
        });
        check(detailOverflow === 0, 'the detail block (with the long path) stays inside #infoPanel');
    } finally {
        await browser.close();
    }
}

try {
    await runIn(await launchBrowser(), 'Chromium');
    // WebKit is the desktop app's engine (WKWebView). CI installs Chromium
    // only, so this half runs where Playwright's WebKit is installed.
    let wk = null;
    try { wk = await (await import('playwright')).webkit.launch(); } catch { wk = null; }
    if (wk) await runIn(wk, 'WebKit');
    else console.log('\n(Playwright WebKit not installed: the WebKit half did not run)');
} finally {
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
