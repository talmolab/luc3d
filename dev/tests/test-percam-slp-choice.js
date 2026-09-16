/**
 * test-percam-slp-choice.js — `chooseCameraSlp`, the rule that decides which
 * `.slp` a camera directory is loaded from.
 *
 * A camera dir accumulates successive exports: "Export SLEAP File By Cam"
 * writes `<stem>_v<N+1>.slp` every time, so after a few rounds a directory
 * holds several files and only one of them reflects current state. Parsing all
 * of them stacks every version's instances into the same (frame, camera) slot;
 * parsing the wrong one silently shows stale annotations for that view while
 * its siblings are correct — which is one of the ways "reload after replacing
 * the .slp files only brought back some of the views" happens.
 *
 * The rule is "highest `_vN`, unversioned counts as 0", and these tests exist
 * mostly to pin that it STAYS that way. `lastModified` is the more intuitive
 * signal and is deliberately NOT authoritative: it survives neither copying nor
 * syncing reliably, so a folder moved between machines would start loading a
 * different file than the one it loaded at home. mtime only breaks a tie the
 * old code settled by folder-enumeration order, i.e. arbitrarily.
 *
 * What the fix adds beyond the pick itself is `newer`: the candidate that IS
 * the most recently written, when that is not the one being loaded. That is the
 * case the user cannot otherwise see — they overwrote `<stem>.slp` and a
 * leftover `<stem>_v1.slp` outranks it — so the loader can say so.
 *
 * Bridged via `loading/percam-slp-choice.js` (dependency-free; session-loader
 * itself pulls app.js and cannot be loaded here).
 */

(function () {
    const { describe, it, assertEqual, assertNull, assertNotNull } = TestFramework;

    // Resolved lazily inside the callbacks: the module bridge that defines
    // `window.__PerCamSlpChoice` is a deferred <script type="module">, so it has
    // NOT run yet while this classic script's body executes. Touching it here
    // throws, and a throw at this point takes the whole file's describe blocks
    // with it — the suite then silently reports the same total as before.
    const choose = (files) => window.__PerCamSlpChoice.chooseCameraSlp(files);

    // Minimal stand-in for a File: the rule reads `name` and `lastModified`.
    const OLD = 1000, MID = 2000, NEW = 3000;
    function f(name, lastModified) {
        return { name: name, lastModified: lastModified };
    }
    const pick = (files) => choose(files).file.name;

    describe('chooseCameraSlp — version is authoritative', function () {

        it('a lone file is chosen unconditionally', function () {
            const r = choose([f('only.slp', OLD)]);
            assertEqual(r.file.name, 'only.slp', 'the only candidate wins');
            assertEqual(r.version, 0, 'an unversioned name is version 0');
            assertNull(r.newer, 'nothing else exists to be newer');
        });

        it('the highest _vN wins', function () {
            assertEqual(pick([f('a_v1.slp', NEW), f('a_v3.slp', OLD), f('a_v2.slp', MID)]), 'a_v3.slp');
        });

        it('a versioned file outranks an unversioned one', function () {
            assertEqual(pick([f('a.slp', NEW), f('a_v1.slp', OLD)]), 'a_v1.slp',
                'v1 > v0 — this is the stale-leftover case, and it is deliberate');
        });

        it('order of the candidates does not matter', function () {
            const forward = pick([f('a_v1.slp', OLD), f('a_v2.slp', OLD)]);
            const reverse = pick([f('a_v2.slp', OLD), f('a_v1.slp', OLD)]);
            assertEqual(forward, 'a_v2.slp', 'highest wins listed first');
            assertEqual(reverse, 'a_v2.slp', 'and listed last');
        });

        it('version beats mtime, however stale', function () {
            assertEqual(pick([f('a_v9.slp', OLD), f('a_v1.slp', NEW)]), 'a_v9.slp',
                'a newer v1 must NOT displace v9 — mtime is not authoritative');
        });

        it('the _3D_vN naming variant parses as a version', function () {
            assertEqual(pick([f('a_3D_v5.slp', OLD), f('a_v2.slp', NEW)]), 'a_3D_v5.slp');
            assertEqual(choose([f('a_3D_v5.slp', OLD)]).version, 5, 'and reports the number');
        });

        it('multi-digit versions compare numerically, not as strings', function () {
            assertEqual(pick([f('a_v9.slp', OLD), f('a_v10.slp', OLD)]), 'a_v10.slp',
                '"10" > "9" numerically, though "10" < "9" as a string');
        });

        it('a version-looking substring that is not a suffix does not count', function () {
            // `_v2` only counts anchored at the end of the stem.
            assertEqual(choose([f('a_v2_final.slp', OLD)]).version, 0,
                'mid-name "_v2" is not a version suffix');
        });

        it('the extension is stripped before matching', function () {
            assertEqual(choose([f('a_v4.slp', OLD)]).version, 4);
            assertEqual(choose([f('a_v4.h5', OLD)]).version, 4, 'analysis .h5 too');
        });
    });

    describe('chooseCameraSlp — mtime breaks ties only', function () {

        it('the newer of two unversioned files wins', function () {
            assertEqual(pick([f('a.slp', OLD), f('b.slp', NEW)]), 'b.slp');
            assertEqual(pick([f('b.slp', NEW), f('a.slp', OLD)]), 'b.slp', 'regardless of order');
        });

        it('the newer of two equally-versioned files wins', function () {
            assertEqual(pick([f('a_v3.slp', NEW), f('b_v3.slp', OLD)]), 'a_v3.slp');
        });

        it('a missing lastModified is treated as oldest, not as a crash', function () {
            // Not every File-like object carries one (test doubles, some
            // pickers); it must degrade to the old first-wins rather than
            // producing NaN comparisons.
            assertEqual(pick([{ name: 'a.slp' }, f('b.slp', NEW)]), 'b.slp',
                'the timestamped file wins over the untimed one');
            assertEqual(pick([{ name: 'a.slp' }, { name: 'b.slp' }]), 'a.slp',
                'and with neither timed, the first is kept');
        });
    });

    describe('chooseCameraSlp — reporting a newer file it did not load', function () {

        it('flags the leftover-version case', function () {
            const r = choose([f('cam1.slp', NEW), f('cam1_v1.slp', OLD)]);
            assertEqual(r.file.name, 'cam1_v1.slp', 'still loads the highest version');
            assertNotNull(r.newer, 'but reports that something newer exists');
            assertEqual(r.newer.name, 'cam1.slp', 'and names it');
        });

        it('stays quiet when the chosen file IS the newest', function () {
            assertNull(choose([f('a_v2.slp', NEW), f('a_v1.slp', OLD)]).newer);
        });

        it('stays quiet on equal timestamps', function () {
            // A whole folder copied in one go lands with identical mtimes;
            // warning there would be noise nobody can act on.
            assertNull(choose([f('a.slp', NEW), f('a_v1.slp', NEW)]).newer,
                'equal is not "newer" — the comparison is strict');
        });

        it('reports the newest of several, not merely one that is newer', function () {
            const r = choose([f('a_v5.slp', OLD), f('b.slp', MID), f('c.slp', NEW)]);
            assertEqual(r.file.name, 'a_v5.slp', 'version still decides');
            assertEqual(r.newer.name, 'c.slp', 'and the single most recent is named');
        });

        it('does not flag a tie-break winner against its own losers', function () {
            // b.slp won ON mtime, so by construction nothing is newer than it.
            const r = choose([f('a.slp', OLD), f('b.slp', NEW)]);
            assertEqual(r.file.name, 'b.slp');
            assertNull(r.newer, 'the mtime winner cannot be out-dated by a loser');
        });
    });
})();
