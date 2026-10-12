/**
 * test-modal-geometry.js — remembered size/position for resizable modals.
 *
 * Pins `ui/modal-geometry.js`. The interesting half is `clampGeometry`: a
 * remembered rect is restored into a viewport that may be nothing like the one
 * it was recorded in — a smaller window, a laptop screen after the external
 * monitor is gone — and restoring it blindly is how a modal ends up off-screen
 * with its header (drag handle AND close button) out of reach. Every assertion
 * below is about that: the card always lands fully inside the viewport.
 *
 * `installModalGeometry` itself is DOM/pointer wiring and is covered end to end
 * by `tests/e2e/settings-modal-geometry.mjs`.
 */

(function () {
    const { describe, it, assertEqual, assertNull, assertNotNull,
        assertTrue, assertFalse, assertDeepEqual } = TestFramework;

    function pick(name) {
        if (typeof window !== 'undefined' && window[name] !== undefined) return window[name];
        if (typeof globalThis !== 'undefined' && globalThis[name] !== undefined) return globalThis[name];
        return undefined;
    }
    function MG() {
        return {
            clampGeometry: pick('clampGeometry'),
            centerGeometry: pick('centerGeometry'),
            readGeometry: pick('readGeometry'),
            writeGeometry: pick('writeGeometry'),
            clearGeometry: pick('clearGeometry'),
            DEFAULT_MIN_W: pick('DEFAULT_MIN_W'),
            DEFAULT_MIN_H: pick('DEFAULT_MIN_H'),
        };
    }

    /** A localStorage stand-in — the real one isn't available in the sandbox. */
    function fakeStorage(seed) {
        const map = Object.assign({}, seed || {});
        return {
            getItem: function (k) { return Object.prototype.hasOwnProperty.call(map, k) ? map[k] : null; },
            setItem: function (k, v) { map[k] = String(v); },
            removeItem: function (k) { delete map[k]; },
            _map: map,
        };
    }
    /** A storage that refuses to write, like a full quota or blocked site data. */
    function hostileStorage() {
        return {
            getItem: function () { throw new Error('blocked'); },
            setItem: function () { throw new Error('blocked'); },
        };
    }

    const VIEW = { width: 1400, height: 900 };

    describe('Modal geometry - clamping keeps the card on screen', function () {
        it('a rect that already fits is returned unchanged', function () {
            const g = MG().clampGeometry({ x: 100, y: 80, w: 880, h: 620 }, VIEW);
            assertDeepEqual(g, { x: 100, y: 80, w: 880, h: 620 });
        });

        it('a card remembered from a BIGGER window shrinks to fit', function () {
            // Recorded on a 2560x1440 display, restored on a 1400x900 one.
            const g = MG().clampGeometry({ x: 1800, y: 1100, w: 1900, h: 1200 }, VIEW);
            assertEqual(g.w, VIEW.width, 'width capped at the viewport');
            assertEqual(g.h, VIEW.height, 'height capped at the viewport');
            assertEqual(g.x, 0, 'pushed back to the left edge');
            assertEqual(g.y, 0, 'pushed back to the top edge');
        });

        it('a card dragged off the right/bottom is pulled back fully into view', function () {
            const g = MG().clampGeometry({ x: 1300, y: 850, w: 880, h: 620 }, VIEW);
            assertEqual(g.x + g.w, VIEW.width, 'right edge flush with the viewport');
            assertEqual(g.y + g.h, VIEW.height, 'bottom edge flush with the viewport');
        });

        it('negative coordinates are pulled back too, so the header stays grabbable', function () {
            const g = MG().clampGeometry({ x: -400, y: -200, w: 600, h: 400 }, VIEW);
            assertEqual(g.x, 0, 'x');
            assertEqual(g.y, 0, 'y');
        });

        it('a too-small rect is grown to the minimum', function () {
            const mg = MG();
            const g = mg.clampGeometry({ x: 10, y: 10, w: 50, h: 40 }, VIEW);
            assertEqual(g.w, mg.DEFAULT_MIN_W, 'min width');
            assertEqual(g.h, mg.DEFAULT_MIN_H, 'min height');
        });

        it('an explicit minimum overrides the default', function () {
            const g = MG().clampGeometry({ x: 0, y: 0, w: 100, h: 100 }, VIEW,
                { minW: 700, minH: 500 });
            assertEqual(g.w, 700, 'min width');
            assertEqual(g.h, 500, 'min height');
        });

        it('a viewport SMALLER than the minimum yields the viewport, not the minimum', function () {
            // A phone-width window must still produce a fully visible card —
            // honouring minW here would push the right edge off screen.
            const tiny = { width: 360, height: 640 };
            const g = MG().clampGeometry({ x: 0, y: 0, w: 880, h: 620 }, tiny, { minW: 520, minH: 320 });
            assertEqual(g.w, 360, 'width is the viewport');
            assertEqual(g.x, 0, 'and it starts at the left edge');
            assertTrue(g.x + g.w <= tiny.width, 'fully on screen');
        });

        it('a margin keeps a gutter between the card and the viewport edges', function () {
            // Without this the card lands flush against an edge whenever the
            // remembered rect is bigger than the screen.
            const g = MG().clampGeometry({ x: 5000, y: 5000, w: 5000, h: 5000 }, VIEW,
                { minW: 520, minH: 320, margin: 24 });
            assertEqual(g.x, 24, 'left gutter');
            assertEqual(g.y, 24, 'top gutter');
            assertEqual(g.w, VIEW.width - 48, 'width leaves both gutters');
            assertEqual(g.h, VIEW.height - 48, 'height leaves both gutters');
        });

        it('a margin too big for the viewport is dropped, not inverted', function () {
            const g = MG().clampGeometry({ x: 0, y: 0, w: 200, h: 200 },
                { width: 100, height: 100 }, { minW: 50, minH: 50, margin: 90 });
            assertEqual(g.x, 0, 'x');
            assertEqual(g.w, 100, 'w is the whole viewport');
        });

        it('junk is rejected rather than half-applied', function () {
            const mg = MG();
            assertNull(mg.clampGeometry(null, VIEW), 'null geometry');
            assertNull(mg.clampGeometry({ x: 0, y: 0, w: 100 }, VIEW), 'missing h');
            assertNull(mg.clampGeometry({ x: NaN, y: 0, w: 100, h: 100 }, VIEW), 'NaN x');
            assertNull(mg.clampGeometry({ x: 0, y: 0, w: 0, h: 100 }, VIEW), 'zero width');
            assertNull(mg.clampGeometry({ x: 0, y: 0, w: 10, h: 10 }, null), 'no viewport');
        });
    });

    describe('Modal geometry - centering the first open', function () {
        it('centres the card in the viewport', function () {
            const g = MG().centerGeometry(880, 620, VIEW);
            assertEqual(g.x, (1400 - 880) / 2, 'x');
            assertEqual(g.y, (900 - 620) / 2, 'y');
            assertEqual(g.w, 880, 'w');
            assertEqual(g.h, 620, 'h');
        });

        it('a card too big to centre is still fully on screen', function () {
            const g = MG().centerGeometry(2000, 1500, VIEW);
            assertEqual(g.x, 0, 'x');
            assertEqual(g.y, 0, 'y');
            assertEqual(g.w, VIEW.width, 'w');
            assertEqual(g.h, VIEW.height, 'h');
        });
    });

    describe('Modal geometry - the remembered record', function () {
        it('a write round-trips through a read', function () {
            const mg = MG();
            const st = fakeStorage();
            assertTrue(mg.writeGeometry('settings', { x: 120, y: 40, w: 1180, h: 800 }, st), 'wrote');
            assertDeepEqual(mg.readGeometry('settings', st), { x: 120, y: 40, w: 1180, h: 800 });
        });

        it('values are rounded — sub-pixel drag noise is not worth storing', function () {
            const mg = MG();
            const st = fakeStorage();
            mg.writeGeometry('settings', { x: 120.4, y: 40.6, w: 1180.5, h: 800.49 }, st);
            assertDeepEqual(mg.readGeometry('settings', st), { x: 120, y: 41, w: 1181, h: 800 });
        });

        it('ids are independent, so one modal cannot clobber another', function () {
            const mg = MG();
            const st = fakeStorage();
            mg.writeGeometry('settings', { x: 1, y: 2, w: 300, h: 400 }, st);
            mg.writeGeometry('export', { x: 9, y: 9, w: 500, h: 600 }, st);
            assertDeepEqual(mg.readGeometry('settings', st), { x: 1, y: 2, w: 300, h: 400 });
            assertDeepEqual(mg.readGeometry('export', st), { x: 9, y: 9, w: 500, h: 600 });
        });

        it('an unknown id reads as null, so the caller centres instead', function () {
            assertNull(MG().readGeometry('never-seen', fakeStorage()));
        });

        it('a corrupt or partial record reads as null rather than throwing', function () {
            const mg = MG();
            assertNull(mg.readGeometry('settings', fakeStorage({
                'lucid.modalGeometry.v1': 'not json {{{',
            })), 'unparseable JSON');
            assertNull(mg.readGeometry('settings', fakeStorage({
                'lucid.modalGeometry.v1': '{"settings":{"x":1,"y":2}}',
            })), 'missing w/h');
            assertNull(mg.readGeometry('settings', fakeStorage({
                'lucid.modalGeometry.v1': '{"settings":"nonsense"}',
            })), 'wrong type');
        });

        it('blocked storage degrades to "forgets", never to a throw', function () {
            const mg = MG();
            const st = hostileStorage();
            assertNull(mg.readGeometry('settings', st), 'read survives');
            assertFalse(mg.writeGeometry('settings', { x: 0, y: 0, w: 1, h: 1 }, st), 'write reports failure');
        });

        it('clearGeometry forgets one id and leaves the others', function () {
            const mg = MG();
            const st = fakeStorage();
            mg.writeGeometry('settings', { x: 1, y: 2, w: 300, h: 400 }, st);
            mg.writeGeometry('export', { x: 9, y: 9, w: 500, h: 600 }, st);
            mg.clearGeometry('settings', st);
            assertNull(mg.readGeometry('settings', st), 'settings forgotten');
            assertNotNull(mg.readGeometry('export', st), 'export kept');
        });

        it('a stored rect is NOT clamped on read — the caller clamps to the live viewport', function () {
            // Storing the clamped value would let one small window permanently
            // shrink the remembered size.
            const mg = MG();
            const st = fakeStorage();
            mg.writeGeometry('settings', { x: 4000, y: 3000, w: 2400, h: 1600 }, st);
            assertDeepEqual(mg.readGeometry('settings', st), { x: 4000, y: 3000, w: 2400, h: 1600 });
        });
    });
})();
