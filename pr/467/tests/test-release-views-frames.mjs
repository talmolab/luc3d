/**
 * test-release-views-frames.mjs — a session going off screen drops its decoded frames.
 *
 * Every decoder caches decoded frames as ImageBitmaps for paused stepping
 * (`FRAME_CACHE_BUDGET_MB`, `loading/video.js`). `VideoController._shownViews`
 * releases them for a view that leaves the screen, but it only ever sees the
 * ACTIVE session's views: a session that another one was loaded over kept its
 * full caches. Measured on 3 open 8-camera sessions: 3.1 GB of bitmaps held for
 * the two not shown, which V8 counts as external memory, and Track All on the
 * third then took 79–96 s instead of ~24 s, most of it in back-to-back full GCs.
 *
 * 1. `releaseViewsFrames(views)` calls `releaseFrames()` once per decoder and
 *    tolerates views with no decoder, decoders without the method, and no views.
 * 2. Every place `session-loader.js` stashes an OUTGOING session's views
 *    (`<session>._views = state.views` for the old/previous session) also
 *    releases them. `session-loader.js` cannot be loaded by Node (CDN imports),
 *    so this reads its source. The active session's own stash
 *    (`state.session._views = state.views`) is not one: those views stay on screen.
 * ESM, so `tests/run-mjs-tests.mjs` picks it up.
 */
import { readFileSync } from 'node:fs';
import { releaseViewsFrames } from '../loading/video.js';

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};

console.log('\n1. releaseViewsFrames releases each decoder once');
{
    const mk = () => ({ released: 0, releaseFrames() { this.released++; } });
    const a = mk(), b = mk();
    const views = [{ decoder: a }, { decoder: b }, { decoder: null }, {}, null, { decoder: {} }];
    let threw = null;
    try { releaseViewsFrames(views); } catch (e) { threw = e; }
    check(!threw, 'views with no decoder, or a decoder without releaseFrames, are skipped' + (threw ? ` (threw ${threw.message})` : ''));
    check(a.released === 1 && b.released === 1, `each decoder released once (got ${a.released}, ${b.released})`);
    let threw2 = null;
    try { releaseViewsFrames(undefined); releaseViewsFrames([]); } catch (e) { threw2 = e; }
    check(!threw2, 'no views is a no-op');
}

console.log('\n2. session-loader.js releases every outgoing session\'s views');
{
    const src = readFileSync(new URL('../loading/session-loader.js', import.meta.url), 'utf8');
    const lines = src.split('\n');
    const stash = /^\s*(\w+)\._views\s*=\s*state\.views\s*;/;
    const sites = [];
    lines.forEach((line, i) => {
        const m = stash.exec(line);
        if (m && m[1] !== 'state') sites.push({ i, who: m[1] });   // `state.session._views = …` is the active session
    });
    check(sites.length >= 3, `found the outgoing-session stash sites (${sites.length}: ${sites.map((s) => s.who + '@' + (s.i + 1)).join(', ')})`);
    for (const s of sites) {
        const after = lines.slice(s.i + 1, s.i + 6).join('\n');
        check(/releaseViewsFrames\(\s*state\.views\s*\)/.test(after),
            `line ${s.i + 1} (${s.who}._views) is followed by releaseViewsFrames(state.views)`);
    }
}

console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
