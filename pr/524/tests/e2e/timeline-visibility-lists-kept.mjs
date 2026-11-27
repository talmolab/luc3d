/**
 * timeline-visibility-lists-kept.mjs — the Visibility tab's Timeline lists
 * (Views / Tracks / Identities) are rebuilt only when what they show changed.
 *
 * Every `updateInfoPanel` rebuilt them: ~6 ms on an 8-camera project with 863
 * tracks, twice at the end of a Track All. Now `populateTimelineVisibility`
 * compares names, on/off and swatch colours with its last build:
 *
 * §1  Nothing changed: the same row elements stay.
 * §2  A row's toggle (a real click) hides the track, and the lists are rebuilt
 *     with it off; the next unchanged call keeps them.
 * §3  Color by ID / Tracks: the track swatches change (rebuilt).
 * §4  A new track: its row appears.
 * §5  Another session with the same names: rebuilt, and a toggle acts on the
 *     NEW session, not the one the old rows were built for.
 *
 * Run: node tests/e2e/timeline-visibility-lists-kept.mjs
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
    await page.evaluate(async () => {
        window.__IP = await import(new URL('ui/info-panel.js', document.baseURI).href);
        window.__populate = () => window.__IP.populateTimelineVisibility(window.__lucid.state.session);
        window.__rows = (id) => [...document.querySelectorAll('#' + id + ' .vis-toggle-row')];
        // The Visibility section on screen, so a click lands on a real toggle.
        (await import(new URL('ui/panel-rail.js', document.baseURI).href)).showPanelTab('tabVisibility');
    });
    const tracks = await page.evaluate(() => window.__lucid.state.session.tracks.length);
    check(tracks >= 1, `precondition: the demo has a track (${tracks})`);

    console.log('\n§1 nothing changed: the rows stay');
    const kept = await page.evaluate(() => {
        window.__populate();
        const before = [...window.__rows('visTimelineCameras'), ...window.__rows('visTimelineTracks'), ...window.__rows('visTimelineIdentities')];
        window.__populate();
        window.__populate();
        const after = [...window.__rows('visTimelineCameras'), ...window.__rows('visTimelineTracks'), ...window.__rows('visTimelineIdentities')];
        return { n: before.length, same: before.length === after.length && before.every((r, i) => r === after[i] && r.isConnected) };
    });
    check(kept.n > 0 && kept.same, `${kept.n} rows, the same elements after two more calls`);

    console.log('\n§2 a toggle hides the track and rebuilds the lists');
    const t = await page.evaluate(() => {
        const row = window.__rows('visTimelineTracks')[0];
        const name = row.querySelector('input').getAttribute('data-name');
        row.querySelector('.toggle-switch').click();
        const s = window.__lucid.state.session;
        const now = window.__rows('visTimelineTracks')[0];
        return { name, hidden: s._hiddenTracks.has(name), rebuilt: now !== row,
                 checked: now.querySelector('input').checked };
    });
    check(t.hidden, `the click hid ${t.name} in the session`);
    check(t.rebuilt && t.checked === false, 'the lists were rebuilt with it off');
    check(await page.evaluate(() => { const r = window.__rows('visTimelineTracks')[0]; window.__populate(); return window.__rows('visTimelineTracks')[0] === r; }),
        'the next unchanged call keeps them');
    await page.evaluate(() => window.__rows('visTimelineTracks')[0].querySelector('.toggle-switch').click());
    check(await page.evaluate(n => !window.__lucid.state.session._hiddenTracks.has(n), t.name), 'clicking again shows it again');

    console.log('\n§3 Color by ID / Tracks changes the swatches');
    const sw = await page.evaluate(async () => {
        const CB = await import(new URL('ui/color-by.js', document.baseURI).href);
        const read = () => window.__rows('visTimelineTracks').map(r => r.querySelector('.vis-color-swatch').style.background).join('|');
        const st = window.__lucid.state;
        CB.setColorByIdentity(st, false); window.__populate();
        const a = read();
        CB.setColorByIdentity(st, true); window.__populate();
        const b = read();
        CB.setColorByIdentity(st, false); window.__populate();
        return { a, b, back: read() };
    });
    check(sw.a !== sw.b && sw.back === sw.a, 'the swatches follow the mode and come back');

    console.log('\n§4 a new track gets its row');
    const added = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        s.tracks.push('zz_new_track');
        window.__populate();
        const names = window.__rows('visTimelineTracks').map(r => r.querySelector('input').getAttribute('data-name'));
        s.tracks.pop();
        window.__populate();
        const after = window.__rows('visTimelineTracks').map(r => r.querySelector('input').getAttribute('data-name'));
        return { had: names.includes('zz_new_track'), gone: !after.includes('zz_new_track') };
    });
    check(added.had && added.gone, 'the row appears, and goes when the track does');

    console.log('\n§5 another session: rebuilt, and its toggles act on it');
    const other = await page.evaluate(() => {
        const st = window.__lucid.state;
        const s1 = st.session;
        // A second session showing exactly the same names.
        const s2 = Object.assign(Object.create(Object.getPrototypeOf(s1)), s1,
            { _hiddenCameras: new Set(), _hiddenTracks: new Set(), _hiddenIdentities: new Set() });
        const row = window.__rows('visTimelineTracks')[0];
        window.__IP.populateTimelineVisibility(s2);
        const now = window.__rows('visTimelineTracks')[0];
        const name = now.querySelector('input').getAttribute('data-name');
        now.querySelector('.toggle-switch').click();
        const r = { rebuilt: now !== row, onNew: s2._hiddenTracks.has(name), onOld: s1._hiddenTracks.has(name) };
        window.__populate();
        return r;
    });
    check(other.rebuilt, 'the rows were rebuilt for the other session');
    check(other.onNew && !other.onOld, 'a toggle hides the track in the new session only');
} finally {
    if (browser) await browser.close();
    server.kill();
}

console.log(fails === 0 ? '\nPASS' : `\nFAIL (${fails})`);
process.exit(fails === 0 ? 0 : 1);
