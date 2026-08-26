/**
 * test-visibility-metadata.js — the session-scoped Visibility-panel settings
 * that persist into a `.slp` (`metadata.lucid`).
 *
 * `test-video-contrast.js` already pins video CONTRAST end to end. This file
 * pins the rest of the session-scoped panel state that followed it:
 *
 *   * per-camera video BRIGHTNESS — previously parked on the transient
 *     `view._brightness`, which reset on every session switch;
 *   * per-camera video ROTATION — the one setting that is not display-only,
 *     since the renderer and hit-testing read `view.rotation`;
 *   * the timeline HIDDEN SETS (cameras / tracks / identities);
 *
 * plus the `import-export/visibility-metadata.js` mapping that carries all of
 * them (contrast included) into and out of a `metadata.lucid` dict.
 *
 * Two invariants get the most attention here, because they are the ones a
 * future edit is most likely to break silently:
 *
 *   1. **Defaults are never written.** A project nobody adjusted must produce a
 *      `metadata.lucid` with none of these keys, so its bytes are identical to
 *      one saved before the settings existed (`tests/e2e/save-golden-digest.mjs`
 *      is the byte-level half of this).
 *   2. **Nothing else in `metadata.lucid` is touched.** The writer may only add
 *      its own keys — `sessionName` / `tracks` / `identities` / `skeleton` /
 *      `frameIdentityMap` / `trustTracks` must come through untouched.
 */

(function () {
    const { describe, it, assertEqual, assertNull, assertNotNull,
        assertTrue, assertFalse, assertDeepEqual } = TestFramework;

    // Dual-runner resolution, with one extra hop beyond test-video-contrast.js.
    //
    // `ui/video-filters.js` is SPREAD onto `window` by the browser runner, so
    // its exports resolve as bare globals. `ui/timeline-visibility.js` and
    // `import-export/visibility-metadata.js` are instead NAMESPACED there
    // (`window.__TimelineVisibility` / `window.__VisibilityMetadata`) because
    // names like `ensureHiddenSets` are too generic to own a global. The `vm`
    // sandbox has no such distinction — it strips `export` and leaves every
    // declaration on its own global. Check the namespaces after the bare name so
    // one lookup path serves both runners.
    var NAMESPACES = ['__VisibilityMetadata', '__TimelineVisibility'];

    function pick(name) {
        var g = (typeof window !== 'undefined') ? window
            : (typeof globalThis !== 'undefined') ? globalThis : null;
        if (g && g[name] !== undefined) return g[name];
        if (typeof globalThis !== 'undefined' && globalThis[name] !== undefined) return globalThis[name];
        for (var i = 0; g && i < NAMESPACES.length; i++) {
            var ns = g[NAMESPACES[i]];
            if (ns && ns[name] !== undefined) return ns[name];
        }
        return undefined;
    }

    function M() {
        return {
            clampRotation: pick('clampRotation'),
            clampRotationSetting: pick('clampRotationSetting'),
            getSessionContrast: pick('getSessionContrast'),
            setSessionContrast: pick('setSessionContrast'),
            getSessionBrightness: pick('getSessionBrightness'),
            setSessionBrightness: pick('setSessionBrightness'),
            serializeVideoBrightness: pick('serializeVideoBrightness'),
            ingestVideoBrightness: pick('ingestVideoBrightness'),
            getSessionRotation: pick('getSessionRotation'),
            setSessionRotation: pick('setSessionRotation'),
            serializeVideoRotation: pick('serializeVideoRotation'),
            ingestVideoRotation: pick('ingestVideoRotation'),
            serializeHiddenSets: pick('serializeHiddenSets'),
            ingestHiddenSets: pick('ingestHiddenSets'),
            writeVisibilityMetadata: pick('writeVisibilityMetadata'),
            readVisibilityMetadata: pick('readVisibilityMetadata'),
            VISIBILITY_METADATA_KEYS: pick('VISIBILITY_METADATA_KEYS'),
            BRIGHTNESS_DEFAULT: pick('BRIGHTNESS_DEFAULT'),
            ROTATION_DEFAULT: pick('ROTATION_DEFAULT'),
            ROTATION_MIN: pick('ROTATION_MIN'),
            ROTATION_MAX: pick('ROTATION_MAX'),
        };
    }

    /** Minimal stand-in for a Session — only the fields these helpers touch. */
    function fakeSession(name) {
        return {
            name: name || 'S',
            videoContrast: {},
            videoBrightness: {},
            videoRotation: {},
        };
    }

    /** A `metadata.lucid` dict with the keys a real writer always emits. */
    function fakeLucid() {
        return {
            sessionName: 'S',
            trustTracks: false,
            frameIdentityMap: [],
            identities: [{ name: 'mouse1' }],
            skeleton: { name: 'sk', nodes: ['a', 'b'], edges: [[0, 1]] },
            tracks: ['track_0', 'track_1'],
        };
    }

    // ---- Bridge ----

    describe('Visibility metadata - module bridge', function () {
        it('the brightness / rotation / hidden-set helpers are bridged', function () {
            var m = M();
            assertEqual(typeof m.getSessionBrightness, 'function', 'getSessionBrightness bridged');
            assertEqual(typeof m.setSessionRotation, 'function', 'setSessionRotation bridged');
            assertEqual(typeof m.serializeHiddenSets, 'function', 'serializeHiddenSets bridged');
            assertEqual(typeof m.ingestHiddenSets, 'function', 'ingestHiddenSets bridged');
        });
        it('the metadata mapping is bridged', function () {
            var m = M();
            assertEqual(typeof m.writeVisibilityMetadata, 'function', 'writeVisibilityMetadata bridged');
            assertEqual(typeof m.readVisibilityMetadata, 'function', 'readVisibilityMetadata bridged');
            assertTrue(Array.isArray(m.VISIBILITY_METADATA_KEYS), 'the key list is exported');
        });
    });

    // ---- Brightness store ----

    describe('Visibility metadata - brightness store', function () {
        it('an unset camera reads the 100% default', function () {
            var m = M(), s = fakeSession();
            assertEqual(m.getSessionBrightness(s, 'camA'), 100, 'unset -> 100');
            assertEqual(m.getSessionBrightness(null, 'camA'), 100, 'null session -> 100');
            assertEqual(m.getSessionBrightness(s, ''), 100, 'no camera name -> 100');
        });
        it('values clamp into [0, 200]', function () {
            var m = M(), s = fakeSession();
            assertEqual(m.setSessionBrightness(s, 'camA', 500), 200, 'over max clamps');
            assertEqual(m.setSessionBrightness(s, 'camA', -40), 0, 'under min clamps');
            assertEqual(m.setSessionBrightness(s, 'camA', '150'), 150, 'slider strings coerce');
            assertEqual(m.setSessionBrightness(s, 'camA', NaN), 100, 'NaN -> default');
        });
        it('the default is deleted, not stored', function () {
            var m = M(), s = fakeSession();
            m.setSessionBrightness(s, 'camA', 140);
            assertTrue(Object.keys(s.videoBrightness).indexOf('camA') >= 0, 'entry present at 140');
            m.setSessionBrightness(s, 'camA', 100);
            assertEqual(Object.keys(s.videoBrightness).length, 0, 'back to 100 -> no entry');
        });
        it('sessions do not share a map', function () {
            var m = M(), s1 = fakeSession('s1'), s2 = fakeSession('s2');
            m.setSessionBrightness(s1, 'camA', 40);
            assertEqual(m.getSessionBrightness(s2, 'camA'), 100, 's2 unaffected');
        });
    });

    // ---- Rotation clamp ----

    describe('Visibility metadata - rotation clamp', function () {
        it('clampRotation still wraps exactly as before the move', function () {
            var m = M();
            // Moved verbatim out of ui/sessions-panes.js — these are the same
            // cases test-rotation.js asserts, repeated here so a regression is
            // caught at the module that now owns the function.
            assertEqual(m.clampRotation(0), 0, '0');
            assertEqual(m.clampRotation(180), 180, '180 stays 180');
            assertEqual(m.clampRotation(181), -179, '181 wraps');
            assertEqual(m.clampRotation(-180), 180, '-180 wraps to 180');
            assertEqual(m.clampRotation(360), 0, '360 -> 0');
        });
        it('clampRotation keeps sub-degree precision for the animation loop', function () {
            var m = M();
            // The hold-to-rotate loop advances by a fractional `60 * dt`; if this
            // rounded, the animation would visibly step.
            assertEqual(m.clampRotation(12.25), 12.25, 'fraction preserved');
        });
        it('clampRotationSetting always yields an integer in range', function () {
            var m = M();
            assertEqual(m.clampRotationSetting(12.25), 12, 'rounds down');
            assertEqual(m.clampRotationSetting(12.75), 13, 'rounds up');
            assertEqual(m.clampRotationSetting('90'), 90, 'strings coerce');
            assertEqual(m.clampRotationSetting(NaN), 0, 'NaN -> default');
            assertEqual(m.clampRotationSetting(undefined), 0, 'undefined -> default');
        });
        it('rounds BEFORE wrapping, so the result can never land out of range', function () {
            var m = M();
            // clampRotation maps into (-180, 180] — an OPEN lower bound. An input
            // just under -179 comes back as ~180.9999; rounding that AFTER the
            // wrap would give 181, one past the max. Rounding first is closed.
            var raw = m.clampRotation(-179.0001);
            assertTrue(raw > 180, 'precondition: the raw wrap really does exceed 180 (got ' + raw + ')');
            var v = m.clampRotationSetting(-179.0001);
            assertTrue(v >= m.ROTATION_MIN && v <= m.ROTATION_MAX,
                'settled value is in [-179, 180] (got ' + v + ')');
            assertEqual(v, Math.round(v), 'and it is an integer');
        });
    });

    // ---- Rotation store ----

    describe('Visibility metadata - rotation store', function () {
        it('an unset camera reads 0', function () {
            var m = M(), s = fakeSession();
            assertEqual(m.getSessionRotation(s, 'camA'), 0, 'unset -> 0');
        });
        it('stores the rounded degree', function () {
            var m = M(), s = fakeSession();
            assertEqual(m.setSessionRotation(s, 'camA', 89.6), 90, 'rounds on the way in');
            assertEqual(m.getSessionRotation(s, 'camA'), 90, 'reads back the rounded value');
        });
        it('the default is deleted, not stored', function () {
            var m = M(), s = fakeSession();
            m.setSessionRotation(s, 'camA', 90);
            assertEqual(Object.keys(s.videoRotation).length, 1, 'entry present at 90');
            m.setSessionRotation(s, 'camA', 0);
            assertEqual(Object.keys(s.videoRotation).length, 0, 'back to 0 -> no entry');
        });
    });

    // ---- Hidden sets ----

    describe('Visibility metadata - hidden sets', function () {
        function hidden(cams, tracks, ids) {
            return {
                _hiddenCameras: new Set(cams || []),
                _hiddenTracks: new Set(tracks || []),
                _hiddenIdentities: new Set(ids || []),
            };
        }

        it('nothing hidden serializes to null', function () {
            var m = M();
            assertNull(m.serializeHiddenSets(hidden()), 'all-visible -> null');
            assertNull(m.serializeHiddenSets(fakeSession()), 'a session with no Sets at all -> null');
        });
        it('only the non-empty sets contribute keys', function () {
            var m = M();
            var out = m.serializeHiddenSets(hidden(['camB'], [], []));
            assertDeepEqual(Object.keys(out), ['hiddenCameras'], 'empty track/identity sets omitted');
            assertDeepEqual(out.hiddenCameras, ['camB'], 'camera name carried');
        });
        it('names are sorted, so click order cannot change the bytes', function () {
            var m = M();
            var a = m.serializeHiddenSets(hidden(['z', 'a', 'm']));
            var b = m.serializeHiddenSets(hidden(['m', 'z', 'a']));
            assertDeepEqual(a.hiddenCameras, ['a', 'm', 'z'], 'sorted');
            assertDeepEqual(a, b, 'insertion order does not matter');
        });
        it('round-trips all three sets', function () {
            var m = M();
            var src = hidden(['camB'], ['track_1'], ['mouse2']);
            var payload = m.serializeHiddenSets(src);
            var dst = fakeSession();
            var n = m.ingestHiddenSets(dst, payload);
            assertEqual(n, 3, 'three names applied');
            assertTrue(dst._hiddenCameras.has('camB'), 'camera restored');
            assertTrue(dst._hiddenTracks.has('track_1'), 'track restored');
            assertTrue(dst._hiddenIdentities.has('mouse2'), 'identity restored');
        });
        it('ingest tolerates absence and garbage', function () {
            var m = M(), s = fakeSession();
            assertEqual(m.ingestHiddenSets(s, null), 0, 'null payload');
            assertEqual(m.ingestHiddenSets(s, {}), 0, 'no keys');
            assertEqual(m.ingestHiddenSets(s, { hiddenTracks: 'nope' }), 0, 'non-array ignored');
            assertEqual(m.ingestHiddenSets(s, { hiddenTracks: [1, null, '', 't'] }), 1,
                'only usable strings applied');
            assertNotNull(s._hiddenTracks, 'Sets still initialized');
            assertTrue(s._hiddenTracks.has('t'), 'the good entry landed');
        });
        it('ingest is additive and idempotent', function () {
            var m = M(), s = fakeSession();
            m.ingestHiddenSets(s, { hiddenTracks: ['a'] });
            m.ingestHiddenSets(s, { hiddenTracks: ['a', 'b'] });
            assertEqual(s._hiddenTracks.size, 2, 'no duplicates, both present');
        });
    });

    // ---- The metadata.lucid mapping ----

    describe('Visibility metadata - metadata.lucid mapping', function () {
        it('an untouched session adds NO keys', function () {
            var m = M();
            var lucid = fakeLucid();
            var before = Object.keys(lucid).slice().sort();
            m.writeVisibilityMetadata(lucid, fakeSession());
            assertDeepEqual(Object.keys(lucid).slice().sort(), before,
                'a default project writes nothing — this is what keeps the saved bytes unchanged');
        });

        it('never touches a key it does not own', function () {
            var m = M();
            var lucid = fakeLucid();
            var s = fakeSession();
            m.setSessionBrightness(s, 'camA', 140);
            m.setSessionRotation(s, 'camA', 90);
            s._hiddenTracks = new Set(['track_1']);
            m.writeVisibilityMetadata(lucid, s);

            var pristine = fakeLucid();
            for (var k in pristine) {
                if (!Object.prototype.hasOwnProperty.call(pristine, k)) continue;
                assertDeepEqual(lucid[k], pristine[k], k + ' came through untouched');
            }
        });

        it('only ever adds keys from the declared list', function () {
            var m = M();
            var lucid = fakeLucid();
            var known = Object.keys(lucid);
            var s = fakeSession();
            m.setSessionBrightness(s, 'camA', 140);
            m.setSessionContrast(s, 'camA', -30);
            m.setSessionRotation(s, 'camA', 90);
            s._hiddenCameras = new Set(['camB']);
            s._hiddenTracks = new Set(['track_1']);
            s._hiddenIdentities = new Set(['mouse2']);
            m.writeVisibilityMetadata(lucid, s);

            var added = Object.keys(lucid).filter(function (k) { return known.indexOf(k) < 0; });
            for (var i = 0; i < added.length; i++) {
                assertTrue(m.VISIBILITY_METADATA_KEYS.indexOf(added[i]) >= 0,
                    added[i] + ' is a declared visibility key');
            }
            assertEqual(added.length, 6, 'all six settings landed (got ' + added.join(',') + ')');
        });

        it('round-trips every setting through a lucid dict', function () {
            var m = M();
            var src = fakeSession('src');
            m.setSessionBrightness(src, 'camA', 140);
            m.setSessionBrightness(src, 'camB', 60);
            m.setSessionContrast(src, 'camA', -30);
            m.setSessionRotation(src, 'camB', -90);
            src._hiddenCameras = new Set(['camC']);
            src._hiddenTracks = new Set(['track_1']);
            src._hiddenIdentities = new Set(['mouse2']);

            var lucid = m.writeVisibilityMetadata(fakeLucid(), src);
            var dst = fakeSession('dst');
            m.readVisibilityMetadata(dst, lucid);

            assertEqual(m.getSessionBrightness(dst, 'camA'), 140, 'camA brightness');
            assertEqual(m.getSessionBrightness(dst, 'camB'), 60, 'camB brightness');
            assertEqual(m.getSessionContrast(dst, 'camA'), -30, 'camA contrast');
            assertEqual(m.getSessionRotation(dst, 'camB'), -90, 'camB rotation');
            assertTrue(dst._hiddenCameras.has('camC'), 'hidden camera');
            assertTrue(dst._hiddenTracks.has('track_1'), 'hidden track');
            assertTrue(dst._hiddenIdentities.has('mouse2'), 'hidden identity');
        });

        it('reading a .slp that predates these settings is a no-op', function () {
            var m = M();
            var s = fakeSession();
            m.readVisibilityMetadata(s, fakeLucid());     // no visibility keys at all
            assertEqual(Object.keys(s.videoBrightness).length, 0, 'no brightness');
            assertEqual(Object.keys(s.videoRotation).length, 0, 'no rotation');
            assertEqual(s._hiddenCameras.size, 0, 'no hidden cameras');
        });

        it('reading tolerates a missing or garbage lucid dict', function () {
            var m = M();
            m.readVisibilityMetadata(fakeSession(), null);
            m.readVisibilityMetadata(fakeSession(), undefined);
            m.readVisibilityMetadata(fakeSession(), 'not an object');
            m.readVisibilityMetadata(fakeSession(), { videoBrightness: 7, videoRotation: [] });
            assertTrue(true, 'no throw on any malformed payload');
        });

        it('writing tolerates a missing lucid dict or session', function () {
            var m = M();
            assertNull(m.writeVisibilityMetadata(null, fakeSession()), 'null lucid returns null');
            var lucid = fakeLucid();
            assertEqual(m.writeVisibilityMetadata(lucid, null), lucid, 'null session returns the dict');
        });
    });

    // ---- Session integration ----

    describe('Visibility metadata - Session integration', function () {
        it('a fresh Session declares empty brightness and rotation maps', function () {
            var Session = pick('Session'), Skeleton = pick('Skeleton');
            if (typeof Session !== 'function' || typeof Skeleton !== 'function') return;
            var s = new Session([], new Skeleton('sk', ['a'], []), []);
            assertNotNull(s.videoBrightness, 'Session declares videoBrightness');
            assertEqual(Object.keys(s.videoBrightness).length, 0, 'and it starts empty');
            assertNotNull(s.videoRotation, 'Session declares videoRotation');
            assertEqual(Object.keys(s.videoRotation).length, 0, 'and it starts empty');
        });
        it('each Session gets its own maps', function () {
            var Session = pick('Session'), Skeleton = pick('Skeleton');
            if (typeof Session !== 'function' || typeof Skeleton !== 'function') return;
            var sk = new Skeleton('sk', ['a'], []);
            var a = new Session([], sk, []), b = new Session([], sk, []);
            a.videoBrightness.camA = 40;
            assertEqual(b.videoBrightness.camA, undefined, 'no shared object between Sessions');
        });
    });
})();
