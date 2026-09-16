/**
 * test-video-contrast.js — Visibility ▸ Video Contrast (issue #149).
 *
 * Pins `ui/video-filters.js`: the slider -> CSS-filter math in BOTH directions
 * (negative = less contrast, positive = more), the combined brightness+contrast
 * filter string (they share `canvas.style.filter`, so emitting them separately
 * would have one erase the other), the per-session store, and the
 * serialize/ingest pair that carries the setting through a `.slp` round trip.
 *
 * The store lives on the SESSION, not the view: `state.views` is rebuilt from
 * scratch on every session switch, so a per-view field would silently reset.
 * The per-session isolation assertions below are what guard that.
 */

(function () {
    const { describe, it, assertEqual, assertApprox, assertNull, assertNotNull,
        assertTrue, assertFalse, assertDeepEqual } = TestFramework;

    // `ui/video-filters.js` reaches the tests two different ways: the browser
    // runner bridges its exports onto `window`, while the `vm` sandbox runner
    // strips `export` and leaves the declarations on the sandbox's own global
    // (its `window` is only a stub). Resolve each name through both so one
    // lookup path serves both runners.
    function pick(name) {
        if (typeof window !== 'undefined' && window[name] !== undefined) return window[name];
        if (typeof globalThis !== 'undefined' && globalThis[name] !== undefined) return globalThis[name];
        return undefined;
    }

    function VF() {
        return {
            clampContrast: pick('clampContrast'),
            clampBrightness: pick('clampBrightness'),
            contrastFactor: pick('contrastFactor'),
            brightnessFactor: pick('brightnessFactor'),
            buildVideoFilter: pick('buildVideoFilter'),
            getSessionContrast: pick('getSessionContrast'),
            setSessionContrast: pick('setSessionContrast'),
            serializeVideoContrast: pick('serializeVideoContrast'),
            ingestVideoContrast: pick('ingestVideoContrast'),
            CONTRAST_MIN: pick('CONTRAST_MIN'),
            CONTRAST_MAX: pick('CONTRAST_MAX'),
            CONTRAST_DEFAULT: pick('CONTRAST_DEFAULT'),
            BRIGHTNESS_DEFAULT: pick('BRIGHTNESS_DEFAULT'),
        };
    }

    /** Minimal stand-in for a Session — only `videoContrast` is read/written. */
    function fakeSession(name) {
        return { name: name || 'S', videoContrast: {} };
    }

    /**
     * The transfer function CSS `contrast(k)` implements, applied to a
     * normalized channel value. Used to assert the DIRECTION of the effect
     * rather than just the numeric factor.
     */
    function applyContrast(channel, k) {
        return k * channel + (0.5 - 0.5 * k);
    }

    // ---- Bridge ----

    describe('Video contrast - module bridge', function () {
        it('ui/video-filters.js is bridged into the test runner', function () {
            var vf = VF();
            assertEqual(typeof vf.buildVideoFilter, 'function', 'buildVideoFilter must be bridged');
            assertEqual(typeof vf.clampContrast, 'function', 'clampContrast must be bridged');
            assertEqual(typeof vf.getSessionContrast, 'function', 'getSessionContrast must be bridged');
            assertEqual(typeof vf.serializeVideoContrast, 'function', 'serializeVideoContrast must be bridged');
        });

        it('slider range is -100..100 with default 0', function () {
            var vf = VF();
            assertEqual(vf.CONTRAST_MIN, -100, 'min is -100');
            assertEqual(vf.CONTRAST_MAX, 100, 'max is +100');
            assertEqual(vf.CONTRAST_DEFAULT, 0, 'default is 0');
        });
    });

    // ---- Clamping / coercion ----

    describe('Video contrast - clamping', function () {
        it('clamps out-of-range values to the slider bounds', function () {
            var vf = VF();
            assertEqual(vf.clampContrast(500), 100, '+500 clamps to +100');
            assertEqual(vf.clampContrast(-500), -100, '-500 clamps to -100');
            assertEqual(vf.clampContrast(100), 100, '+100 is in range');
            assertEqual(vf.clampContrast(-100), -100, '-100 is in range');
        });

        it('coerces slider strings (the DOM hands back strings)', function () {
            var vf = VF();
            assertEqual(vf.clampContrast('40'), 40, '"40" -> 40');
            assertEqual(vf.clampContrast('-40'), -40, '"-40" -> -40');
            assertEqual(vf.clampContrast('0'), 0, '"0" -> 0');
        });

        it('falls back to the default for junk, not to NaN', function () {
            var vf = VF();
            assertEqual(vf.clampContrast(undefined), 0, 'undefined -> 0');
            assertEqual(vf.clampContrast(null), 0, 'null -> 0');
            assertEqual(vf.clampContrast(NaN), 0, 'NaN -> 0');
            assertEqual(vf.clampContrast('abc'), 0, '"abc" -> 0');
            assertEqual(vf.clampContrast(Infinity), 0, 'Infinity -> 0');
        });

        it('rounds fractional values to whole steps', function () {
            var vf = VF();
            assertEqual(vf.clampContrast(12.4), 12, '12.4 -> 12');
            assertEqual(vf.clampContrast(-12.6), -13, '-12.6 -> -13');
        });

        it('brightness keeps its own 0..200 range and 100 default', function () {
            var vf = VF();
            assertEqual(vf.clampBrightness(undefined), 100, 'missing -> 100');
            assertEqual(vf.clampBrightness(999), 200, 'clamps high');
            assertEqual(vf.clampBrightness(-5), 0, 'clamps low');
            assertEqual(vf.clampBrightness('150'), 150, 'coerces strings');
        });
    });

    // ---- The math, both directions ----

    describe('Video contrast - factor mapping', function () {
        it('0 is the identity factor', function () {
            var vf = VF();
            assertApprox(vf.contrastFactor(0), 1.0, 1e-9, 'contrast 0 -> k=1');
        });

        it('positive values INCREASE contrast (k > 1, up to 2 at +100)', function () {
            var vf = VF();
            assertApprox(vf.contrastFactor(50), 1.5, 1e-9, '+50 -> k=1.5');
            assertApprox(vf.contrastFactor(100), 2.0, 1e-9, '+100 -> k=2');
            assertTrue(vf.contrastFactor(10) < vf.contrastFactor(20),
                'k must rise monotonically with the slider');
        });

        it('negative values DECREASE contrast (k < 1, down to 0 at -100)', function () {
            var vf = VF();
            assertApprox(vf.contrastFactor(-50), 0.5, 1e-9, '-50 -> k=0.5');
            assertApprox(vf.contrastFactor(-100), 0.0, 1e-9, '-100 -> k=0 (flat mid-grey)');
            assertTrue(vf.contrastFactor(-20) < vf.contrastFactor(-10),
                'k must keep falling as the slider goes more negative');
        });

        it('the mapping is symmetric about 0', function () {
            var vf = VF();
            for (var s = 0; s <= 100; s += 25) {
                assertApprox(vf.contrastFactor(s) - 1, 1 - vf.contrastFactor(-s), 1e-9,
                    '+' + s + ' and -' + s + ' are equal and opposite in k');
            }
        });

        it('positive contrast pushes pixels AWAY from mid-grey', function () {
            var vf = VF();
            var k = vf.contrastFactor(50);
            // A dark pixel gets darker, a bright pixel gets brighter.
            assertTrue(applyContrast(0.25, k) < 0.25, 'dark pixel darkens');
            assertTrue(applyContrast(0.75, k) > 0.75, 'bright pixel brightens');
            assertApprox(applyContrast(0.5, k), 0.5, 1e-9, 'mid-grey is the pivot');
        });

        it('negative contrast pulls pixels TOWARD mid-grey', function () {
            var vf = VF();
            var k = vf.contrastFactor(-50);
            assertTrue(applyContrast(0.25, k) > 0.25, 'dark pixel lightens toward 0.5');
            assertTrue(applyContrast(0.75, k) < 0.75, 'bright pixel darkens toward 0.5');
            assertApprox(applyContrast(0.5, k), 0.5, 1e-9, 'mid-grey is the pivot');
        });

        it('-100 flattens every pixel to mid-grey', function () {
            var vf = VF();
            var k = vf.contrastFactor(-100);
            assertApprox(applyContrast(0.0, k), 0.5, 1e-9, 'black -> mid-grey');
            assertApprox(applyContrast(1.0, k), 0.5, 1e-9, 'white -> mid-grey');
        });
    });

    // ---- Combined filter string ----

    describe('Video contrast - buildVideoFilter', function () {
        it('emits nothing when both settings are at their defaults', function () {
            var vf = VF();
            assertEqual(vf.buildVideoFilter(100, 0), '', 'identity -> empty filter');
            assertEqual(vf.buildVideoFilter(undefined, undefined), '', 'missing -> empty filter');
        });

        it('emits brightness alone when contrast is 0 (pre-#149 behavior)', function () {
            var vf = VF();
            assertEqual(vf.buildVideoFilter(150, 0), 'brightness(1.5)', 'brightness only');
            assertEqual(vf.buildVideoFilter(0, 0), 'brightness(0)', 'brightness 0 %');
        });

        it('emits contrast alone when brightness is 100', function () {
            var vf = VF();
            assertEqual(vf.buildVideoFilter(100, 40), 'contrast(1.4)', 'positive contrast only');
            assertEqual(vf.buildVideoFilter(100, -40), 'contrast(0.6)', 'negative contrast only');
            assertEqual(vf.buildVideoFilter(100, -100), 'contrast(0)', 'flat-grey extreme');
            assertEqual(vf.buildVideoFilter(100, 100), 'contrast(2)', 'max extreme');
        });

        it('emits BOTH when both are non-default (they share style.filter)', function () {
            var vf = VF();
            assertEqual(vf.buildVideoFilter(120, -30), 'brightness(1.2) contrast(0.7)',
                'brightness first, then contrast');
            assertEqual(vf.buildVideoFilter(80, 55), 'brightness(0.8) contrast(1.55)',
                'both components present');
        });

        it('produces no floating-point noise in the CSS string', function () {
            var vf = VF();
            for (var s = -100; s <= 100; s++) {
                var css = vf.buildVideoFilter(100, s);
                assertFalse(/e-/.test(css), 'no exponent notation at ' + s);
                assertFalse(/\d{6,}/.test(css), 'no long float tail at ' + s + ' (' + css + ')');
            }
        });

        it('clamps through the filter builder too', function () {
            var vf = VF();
            assertEqual(vf.buildVideoFilter(100, 9999), 'contrast(2)', 'over-range clamps');
            assertEqual(vf.buildVideoFilter(100, -9999), 'contrast(0)', 'under-range clamps');
        });
    });

    // ---- Per-session store ----

    describe('Video contrast - per-session store', function () {
        it('defaults to 0 for an unknown camera / missing session', function () {
            var vf = VF();
            var s = fakeSession();
            assertEqual(vf.getSessionContrast(s, 'camA'), 0, 'unset camera -> 0');
            assertEqual(vf.getSessionContrast(null, 'camA'), 0, 'no session -> 0');
            assertEqual(vf.getSessionContrast(s, ''), 0, 'no camera name -> 0');
        });

        it('stores and reads back per camera', function () {
            var vf = VF();
            var s = fakeSession();
            vf.setSessionContrast(s, 'camA', 40);
            vf.setSessionContrast(s, 'camB', -25);
            assertEqual(vf.getSessionContrast(s, 'camA'), 40, 'camA keeps +40');
            assertEqual(vf.getSessionContrast(s, 'camB'), -25, 'camB keeps -25');
            assertEqual(vf.getSessionContrast(s, 'camC'), 0, 'untouched camera stays 0');
        });

        it('returns the clamped value that was actually stored', function () {
            var vf = VF();
            var s = fakeSession();
            assertEqual(vf.setSessionContrast(s, 'camA', 400), 100, 'returns clamped');
            assertEqual(vf.getSessionContrast(s, 'camA'), 100, 'stores clamped');
        });

        it('resetting to 0 deletes the entry (keeps the saved map empty)', function () {
            var vf = VF();
            var s = fakeSession();
            vf.setSessionContrast(s, 'camA', 40);
            assertTrue(Object.keys(s.videoContrast).indexOf('camA') >= 0, 'entry present at +40');
            vf.setSessionContrast(s, 'camA', 0);
            assertEqual(Object.keys(s.videoContrast).length, 0, 'back to 0 -> no entry');
            assertEqual(vf.getSessionContrast(s, 'camA'), 0, 'still reads as 0');
        });

        it('creates the map lazily on a session that lacks one', function () {
            var vf = VF();
            var s = { name: 'legacy' };            // e.g. a session from an old code path
            assertEqual(vf.getSessionContrast(s, 'camA'), 0, 'no map -> default');
            vf.setSessionContrast(s, 'camA', 15);
            assertEqual(vf.getSessionContrast(s, 'camA'), 15, 'map created on write');
        });

        it('sessions are isolated — each keeps its own per-camera values', function () {
            var vf = VF();
            var s1 = fakeSession('one');
            var s2 = fakeSession('two');
            vf.setSessionContrast(s1, 'camA', 60);
            vf.setSessionContrast(s2, 'camA', -60);
            assertEqual(vf.getSessionContrast(s1, 'camA'), 60, 'session 1 unaffected by session 2');
            assertEqual(vf.getSessionContrast(s2, 'camA'), -60, 'session 2 unaffected by session 1');
            vf.setSessionContrast(s1, 'camA', 0);
            assertEqual(vf.getSessionContrast(s2, 'camA'), -60, 'clearing session 1 leaves session 2');
        });

        it('the same camera NAME in two sessions is two independent settings', function () {
            var vf = VF();
            // Multi-session projects routinely reuse camera names across sessions.
            var s1 = fakeSession('day1');
            var s2 = fakeSession('day2');
            vf.setSessionContrast(s1, 'cam_0', 33);
            assertEqual(vf.getSessionContrast(s2, 'cam_0'), 0,
                'a value set in day1 must not leak into day2');
        });
    });

    // ---- Save / load round trip ----

    describe('Video contrast - serialize / ingest', function () {
        it('serializes to null when nothing was changed', function () {
            var vf = VF();
            assertNull(vf.serializeVideoContrast(fakeSession()), 'empty map -> null');
            assertNull(vf.serializeVideoContrast({}), 'no map -> null');
            assertNull(vf.serializeVideoContrast(null), 'no session -> null');
        });

        it('serializes only non-default entries', function () {
            var vf = VF();
            var s = fakeSession();
            vf.setSessionContrast(s, 'camA', 40);
            vf.setSessionContrast(s, 'camB', 0);       // default -> not stored
            vf.setSessionContrast(s, 'camC', -70);
            var out = vf.serializeVideoContrast(s);
            assertNotNull(out, 'has a payload');
            assertDeepEqual(out, { camA: 40, camC: -70 }, 'only the adjusted cameras');
        });

        it('round-trips a whole project: every session keeps its own values', function () {
            var vf = VF();
            // Save side: three sessions, different per-camera contrast in each.
            var saved = [];
            var setups = [
                { camA: 40, camB: -40 },
                { camA: -100, camC: 100 },
                {},                                   // session with nothing set
            ];
            for (var i = 0; i < setups.length; i++) {
                var s = fakeSession('sess' + i);
                var keys = Object.keys(setups[i]);
                for (var k = 0; k < keys.length; k++) {
                    vf.setSessionContrast(s, keys[k], setups[i][keys[k]]);
                }
                saved.push(vf.serializeVideoContrast(s));
            }
            assertNull(saved[2], 'an untouched session writes no payload at all');

            // Load side: fresh sessions ingest their own payload.
            var loaded = [];
            for (var j = 0; j < saved.length; j++) {
                var fresh = fakeSession('reload' + j);
                vf.ingestVideoContrast(fresh, saved[j]);
                loaded.push(fresh);
            }
            assertEqual(vf.getSessionContrast(loaded[0], 'camA'), 40, 'sess0 camA');
            assertEqual(vf.getSessionContrast(loaded[0], 'camB'), -40, 'sess0 camB');
            assertEqual(vf.getSessionContrast(loaded[0], 'camC'), 0, 'sess0 has no camC');
            assertEqual(vf.getSessionContrast(loaded[1], 'camA'), -100, 'sess1 camA extreme low');
            assertEqual(vf.getSessionContrast(loaded[1], 'camC'), 100, 'sess1 camC extreme high');
            assertEqual(vf.getSessionContrast(loaded[1], 'camB'), 0, 'sess1 has no camB');
            assertEqual(Object.keys(loaded[2].videoContrast).length, 0, 'sess2 loads empty');
        });

        it('re-serializing an ingested payload is stable', function () {
            var vf = VF();
            var payload = { camA: 40, camB: -70 };
            var s = fakeSession();
            vf.ingestVideoContrast(s, payload);
            assertDeepEqual(vf.serializeVideoContrast(s), payload, 'save -> load -> save is a fixpoint');
        });

        it('tolerates a missing or malformed payload (older .slp files)', function () {
            var vf = VF();
            assertEqual(vf.ingestVideoContrast(fakeSession(), undefined), 0, 'undefined -> 0 applied');
            assertEqual(vf.ingestVideoContrast(fakeSession(), null), 0, 'null -> 0 applied');
            assertEqual(vf.ingestVideoContrast(fakeSession(), 'nope'), 0, 'string -> 0 applied');
            assertEqual(vf.ingestVideoContrast(fakeSession(), [1, 2, 3]), 0, 'array -> 0 applied');
            var s = fakeSession();
            vf.ingestVideoContrast(s, undefined);
            assertNotNull(s.videoContrast, 'map still initialized');
        });

        it('sanitizes garbage values on the way in', function () {
            var vf = VF();
            var s = fakeSession();
            var applied = vf.ingestVideoContrast(s, {
                camA: 40,
                camB: 'abc',        // junk -> dropped
                camC: 9999,         // clamped
                camD: 0,            // default -> dropped
                camE: '-55',        // numeric string
            });
            assertEqual(applied, 3, 'three usable entries');
            assertEqual(vf.getSessionContrast(s, 'camA'), 40, 'camA kept');
            assertEqual(vf.getSessionContrast(s, 'camB'), 0, 'junk falls back to default');
            assertEqual(vf.getSessionContrast(s, 'camC'), 100, 'over-range clamped');
            assertEqual(vf.getSessionContrast(s, 'camD'), 0, 'explicit default dropped');
            assertEqual(vf.getSessionContrast(s, 'camE'), -55, 'numeric string parsed');
        });

        it('ingest merges into, rather than replaces, an existing map', function () {
            var vf = VF();
            var s = fakeSession();
            vf.setSessionContrast(s, 'camA', 10);
            vf.ingestVideoContrast(s, { camB: 20 });
            assertEqual(vf.getSessionContrast(s, 'camA'), 10, 'pre-existing entry survives');
            assertEqual(vf.getSessionContrast(s, 'camB'), 20, 'ingested entry lands');
        });
    });

    // ---- The Session model carries the field ----

    describe('Video contrast - Session integration', function () {
        it('a fresh Session starts with an empty videoContrast map', function () {
            if (typeof Session !== 'function' || typeof Skeleton !== 'function') return;
            var s = new Session([], new Skeleton('sk', ['a'], []), ['track_0'], 'S');
            assertNotNull(s.videoContrast, 'Session declares videoContrast');
            assertEqual(Object.keys(s.videoContrast).length, 0, 'and it starts empty');
        });

        it('a real Session round-trips through the store helpers', function () {
            var vf = VF();
            if (typeof Session !== 'function' || typeof Skeleton !== 'function') return;
            var s = new Session([], new Skeleton('sk', ['a'], []), ['track_0'], 'S');
            vf.setSessionContrast(s, 'cam_0', -35);
            assertEqual(vf.getSessionContrast(s, 'cam_0'), -35, 'stored on a real Session');
            assertDeepEqual(vf.serializeVideoContrast(s), { cam_0: -35 }, 'serializes');
        });

        it('two real Sessions do not share the map', function () {
            var vf = VF();
            if (typeof Session !== 'function' || typeof Skeleton !== 'function') return;
            var skel = new Skeleton('sk', ['a'], []);
            var s1 = new Session([], skel, ['track_0'], 'A');
            var s2 = new Session([], skel, ['track_0'], 'B');
            vf.setSessionContrast(s1, 'cam_0', 50);
            assertEqual(vf.getSessionContrast(s2, 'cam_0'), 0,
                'each Session constructs its own videoContrast object');
        });
    });
})();
