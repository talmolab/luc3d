/**
 * test-instance-rotate.js - Alt + mouse-wheel rotation of a whole instance
 * about the node under the cursor (issue #198, SLEAP parity).
 *
 * Drives the real `InteractionManager` with real `WheelEvent`s rather than
 * re-deriving the arithmetic, so the hit test, the pivot choice, the
 * zoom-suppression contract and the deferred commit are all under test.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertTrue, assertFalse,
        assertApprox, assertNotNull, assertNull } = TestFramework;

    // One wheel notch in Chrome's pixel delta mode.
    const NOTCH_PX = 100;

    function makeCanvas(w, h) {
        const canvas = document.createElement('canvas');
        canvas.width = w;
        canvas.height = h;
        canvas.style.width = w + 'px';
        canvas.style.height = h + 'px';
        canvas.style.position = 'fixed';
        canvas.style.top = '0';
        canvas.style.left = '0';
        document.body.appendChild(canvas);
        return canvas;
    }

    function cleanupCanvases() {
        document.querySelectorAll('canvas[style*="position: fixed"]').forEach(function (c) {
            c.remove();
        });
    }

    /**
     * A one-camera session holding one grouped user instance with three
     * nodes: a pivot at (100, 100) and two arms 40 px out along +x and +y.
     * The third node is left null so "absent stays absent" is covered.
     */
    function makeFixture() {
        const skeleton = new Skeleton('test', ['pivot', 'armX', 'armY', 'ghost'],
            [[0, 1], [0, 2]]);
        const cameras = [
            new Camera('cam1', [[1, 0, 0], [0, 1, 0], [0, 0, 1]], [0, 0, 0, 0, 0],
                [0, 0, 0], [0, 0, 0], [640, 480]),
        ];
        const session = new Session(cameras, skeleton, ['track_0']);

        const inst = new Instance([[100, 100], [140, 100], [100, 140], null], 0, 'user', 1);
        const group = new InstanceGroup(1, 0);
        group.addInstance('cam1', inst);
        session.instanceGroups.set(0, [group]);

        const fg = new FrameGroup(0);
        fg.addInstance('cam1', inst);
        session.addFrameGroup(fg);

        const state = {
            currentFrame: 0,
            session: session,
            views: [{
                name: 'cam1',
                overlayCanvas: makeCanvas(640, 480),
                videoWidth: 640,
                videoHeight: 480,
            }],
        };

        const moved = [];
        const manager = new InteractionManager({
            getState: function () { return state; },
            getInstanceGroups: function () { return [group]; },
            onNodeMoved: function (viewName, g, nodeIdx, pos) {
                moved.push({ viewName: viewName, group: g, nodeIdx: nodeIdx, pos: pos });
            },
            requestRedraw: function () {},
        });
        manager.attach(state.views);

        return { state: state, session: session, group: group, inst: inst,
            manager: manager, moved: moved, canvas: state.views[0].overlayCanvas };
    }

    /**
     * Dispatch a wheel event at a video-space point on the overlay canvas.
     * At 1:1 with the canvas pinned to (0, 0), video coords are client coords.
     */
    function wheelAt(canvas, vx, vy, deltaY, opts) {
        const o = opts || {};
        const e = new WheelEvent('wheel', {
            clientX: vx,
            clientY: vy,
            deltaY: deltaY,
            deltaMode: o.deltaMode || 0,
            altKey: o.altKey !== false,
            bubbles: true,
            cancelable: true,
        });
        canvas.dispatchEvent(e);
        return e;
    }

    /** Wait past the rotation gesture's idle-commit window. */
    function afterCommit() {
        return new Promise(function (resolve) { setTimeout(resolve, 320); });
    }

    // ==================================================================
    describe('Instance Rotate - transform math', function () {
        let fx;
        beforeEach(function () { cleanupCanvases(); fx = makeFixture(); });

        it('rotates clockwise on screen for a positive angle (y-down coords)', function () {
            const pts = fx.inst.toPointsArray();
            fx.manager._applyInstanceTransform(fx.inst, pts, [100, 100], 90, 0, 0);
            // +x arm swings to +y; +y arm swings to -x. That is clockwise when
            // y points down the screen.
            assertApprox(fx.inst.getX(1), 100, 1e-6, 'armX x');
            assertApprox(fx.inst.getY(1), 140, 1e-6, 'armX y');
            assertApprox(fx.inst.getX(2), 60, 1e-6, 'armY x');
            assertApprox(fx.inst.getY(2), 100, 1e-6, 'armY y');
        });

        it('leaves the pivot fixed and absent points absent', function () {
            const pts = fx.inst.toPointsArray();
            fx.manager._applyInstanceTransform(fx.inst, pts, [100, 100], 37, 0, 0);
            assertApprox(fx.inst.getX(0), 100, 1e-6, 'pivot x');
            assertApprox(fx.inst.getY(0), 100, 1e-6, 'pivot y');
            assertFalse(fx.inst.hasPoint(3), 'null node stays null');
        });

        it('preserves inter-node distances (rigid body)', function () {
            const pts = fx.inst.toPointsArray();
            fx.manager._applyInstanceTransform(fx.inst, pts, [100, 100], 23.5, 17, -9);
            const dx = fx.inst.getX(1) - fx.inst.getX(2);
            const dy = fx.inst.getY(1) - fx.inst.getY(2);
            // armX and armY started 40*sqrt(2) apart.
            assertApprox(Math.sqrt(dx * dx + dy * dy), 40 * Math.SQRT2, 1e-6,
                'arm separation unchanged');
        });

        it('composes rotation then translation', function () {
            const pts = fx.inst.toPointsArray();
            fx.manager._applyInstanceTransform(fx.inst, pts, [100, 100], 90, 10, 20);
            assertApprox(fx.inst.getX(0), 110, 1e-6, 'pivot follows the translation');
            assertApprox(fx.inst.getY(0), 120, 1e-6, 'pivot follows the translation');
            assertApprox(fx.inst.getX(1), 110, 1e-6, 'armX x');
            assertApprox(fx.inst.getY(1), 160, 1e-6, 'armX y');
        });
    });

    // ==================================================================
    describe('Instance Rotate - Alt + wheel over a node', function () {
        let fx;
        beforeEach(function () { cleanupCanvases(); fx = makeFixture(); });

        it('turns 6 degrees clockwise per notch scrolled up, matching SLEAP', function () {
            // Scroll up == negative deltaY.
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            // armX at +40 on x rotates 6 degrees clockwise about the pivot.
            const rad = 6 * Math.PI / 180;
            assertApprox(fx.inst.getX(1), 100 + 40 * Math.cos(rad), 1e-6, 'armX x');
            assertApprox(fx.inst.getY(1), 100 + 40 * Math.sin(rad), 1e-6, 'armX y');
        });

        it('turns counter-clockwise when scrolled down', function () {
            wheelAt(fx.canvas, 100, 100, NOTCH_PX);
            assertTrue(fx.inst.getY(1) < 100, 'armX should rise above the pivot');
        });

        it('accumulates across notches without drifting the pivot', function () {
            for (let i = 0; i < 15; i++) wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            // 15 notches * 6 degrees = 90 degrees.
            assertApprox(fx.inst.getX(1), 100, 1e-6, 'armX x after 90 degrees');
            assertApprox(fx.inst.getY(1), 140, 1e-6, 'armX y after 90 degrees');
            assertApprox(fx.inst.getX(0), 100, 1e-9, 'pivot x never drifts');
            assertApprox(fx.inst.getY(0), 100, 1e-9, 'pivot y never drifts');
        });

        it('normalizes line-mode deltas to the same 6 degrees per notch', function () {
            wheelAt(fx.canvas, 100, 100, -3, { deltaMode: 1 });
            const rad = 6 * Math.PI / 180;
            assertApprox(fx.inst.getY(1), 100 + 40 * Math.sin(rad), 1e-6,
                'one line-mode notch == one pixel-mode notch');
        });

        it('scales sub-notch trackpad deltas proportionally', function () {
            wheelAt(fx.canvas, 100, 100, -10); // a tenth of a notch
            const rad = 0.6 * Math.PI / 180;
            assertApprox(fx.inst.getY(1), 100 + 40 * Math.sin(rad), 1e-6,
                'a tenth of a notch turns 0.6 degrees');
        });

        it('pivots on the node under the cursor, not the first node', function () {
            wheelAt(fx.canvas, 140, 100, -NOTCH_PX * 15); // armX, 90 degrees
            assertApprox(fx.inst.getX(1), 140, 1e-6, 'armX is the pivot and holds still');
            assertApprox(fx.inst.getY(1), 100, 1e-6, 'armX is the pivot and holds still');
            assertApprox(fx.inst.getX(0), 140, 1e-6, 'pivot node swung round to armX');
            assertApprox(fx.inst.getY(0), 60, 1e-6, 'pivot node swung round to armX');
        });

        it('consumes the event so the view does not also zoom', function () {
            const e = wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            assertTrue(e.defaultPrevented, 'Alt+wheel on a node must preventDefault');
        });

        it('selects the instance it is turning', function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            assertEqual(fx.manager.selectedInstanceGroup, fx.group,
                'the rotated group becomes the selection');
        });
    });

    // ==================================================================
    // Holding Alt hands the wheel to rotation for as long as the key is
    // down. Zoom stands aside even where there is nothing to turn, so a
    // scroll that strays off the skeleton mid-gesture cannot yank the view
    // out from under it. Releasing Alt gives zoom straight back.
    describe('Instance Rotate - Alt suspends wheel-to-zoom', function () {
        let fx;
        beforeEach(function () { cleanupCanvases(); fx = makeFixture(); });

        it('ignores a wheel with no Alt so plain scroll still zooms', function () {
            const e = wheelAt(fx.canvas, 100, 100, -NOTCH_PX, { altKey: false });
            assertFalse(e.defaultPrevented, 'plain wheel must reach the zoom handler');
            assertApprox(fx.inst.getX(1), 140, 1e-9, 'nothing moved');
            assertApprox(fx.inst.getY(1), 100, 1e-9, 'nothing moved');
        });

        it('swallows Alt+wheel over empty space rather than zooming', function () {
            const e = wheelAt(fx.canvas, 400, 400, -NOTCH_PX);
            assertTrue(e.defaultPrevented,
                'Alt+wheel must not reach the zoom handler, even off-skeleton');
            assertApprox(fx.inst.getX(1), 140, 1e-9, 'and nothing moved');
        });

        it('keeps rotating, and never zooms, when the cursor strays off the skeleton', function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX * 15); // 90 degrees
            // The cursor wanders far off the skeleton, Alt still down. The
            // gesture is latched, so this keeps turning the same instance
            // about the same pivot — as in SLEAP, where the wheel reaches the
            // armed node wherever the pointer happens to be. What it must
            // never do is fall through to zoom.
            const e = wheelAt(fx.canvas, 600, 460, -NOTCH_PX);
            assertTrue(e.defaultPrevented, 'no zoom mid-gesture');
            const rad = 96 * Math.PI / 180; // 90 + one more notch
            assertApprox(fx.inst.getX(1), 100 + 40 * Math.cos(rad), 1e-6,
                'the latched gesture carried on turning');
            assertApprox(fx.inst.getY(1), 100 + 40 * Math.sin(rad), 1e-6,
                'the latched gesture carried on turning');
            assertApprox(fx.inst.getX(0), 100, 1e-9, 'pivot still the same node');
            assertApprox(fx.inst.getY(0), 100, 1e-9, 'pivot still the same node');
        });

        it('does not start a rotation off-skeleton once the gesture has lapsed', async function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            await afterCommit(); // gesture commits, latch released
            const turned = [fx.inst.getX(1), fx.inst.getY(1)];
            const e = wheelAt(fx.canvas, 600, 460, -NOTCH_PX);
            assertTrue(e.defaultPrevented, 'Alt still owns the wheel');
            assertApprox(fx.inst.getX(1), turned[0], 1e-9, 'nothing turned');
            assertApprox(fx.inst.getY(1), turned[1], 1e-9, 'nothing turned');
        });

        it('will not turn a reprojected instance, and will not zoom either', function () {
            fx.inst.type = 'reprojected';
            const e = wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            assertTrue(e.defaultPrevented, 'Alt still owns the wheel');
            assertApprox(fx.inst.getX(1), 140, 1e-9,
                'reprojected instances are not editable');
        });
    });

    // ==================================================================
    describe('Instance Rotate - commit', function () {
        let fx;
        beforeEach(function () { cleanupCanvases(); fx = makeFixture(); });

        it('defers onNodeMoved to the end of the wheel burst', async function () {
            for (let i = 0; i < 5; i++) wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            assertEqual(fx.moved.length, 0,
                'no commit while the wheel is still turning');
            await afterCommit();
            assertEqual(fx.moved.length, 1, 'exactly one commit for the burst');
            assertEqual(fx.moved[0].viewName, 'cam1');
            assertEqual(fx.moved[0].nodeIdx, 0, 'reports the pivot node');
            assertTrue(fx.inst.modified, 'instance marked modified');
            assertEqual(fx.inst.type, 'user', 'instance is a user instance');
        });

        it('banks the gesture immediately on the next click', function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            assertEqual(fx.moved.length, 0);
            fx.canvas.dispatchEvent(new MouseEvent('mousedown', {
                clientX: 400, clientY: 400, button: 0, bubbles: true, cancelable: true,
            }));
            assertEqual(fx.moved.length, 1, 'a click flushes the pending rotation');
        });

        it('banks the gesture before a key that may change the frame', function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            document.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'ArrowRight', bubbles: true }));
            assertEqual(fx.moved.length, 1,
                'the edit is attributed to the frame it was made on');
        });

        it('does not bank on the Alt keydown that starts the gesture', function () {
            document.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Alt', altKey: true, bubbles: true }));
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            document.dispatchEvent(new KeyboardEvent('keydown',
                { key: 'Alt', altKey: true, bubbles: true }));
            assertEqual(fx.moved.length, 0,
                'holding Alt must not chop the gesture into pieces');
            assertNotNull(fx.manager._rotateGesture, 'gesture still latched');
        });

        it('banks the gesture on detach', function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX);
            fx.manager.detach();
            assertEqual(fx.moved.length, 1, 'detach must not drop the edit');
        });
    });

    // ==================================================================
    // Turning the skeleton must not turn its lettering with it. The points
    // move; the text that names them stays horizontal on screen, as it already
    // does for a rotated VIEW (issue #162). These drive the real
    // `drawInstanceLabels` and read the canvas transform that was in force at
    // each `fillText`, so they fail if anything ever starts rotating the text
    // frame along with the instance.
    describe('Instance Rotate - node names stay horizontal', function () {
        let fx;
        beforeEach(function () { cleanupCanvases(); fx = makeFixture(); });

        /**
         * Draw the labels for the (already-posed) fixture instance and return
         * one entry per piece of text: what it said, and the angle it came out
         * at ON SCREEN — the canvas transform's rotation plus the view's own
         * rotation, which is the number that has to be zero.
         */
        function drawnText(labelRotationDeg) {
            const canvas = makeCanvas(640, 480);
            const ctx = canvas.getContext('2d');
            const out = [];
            const record = function (text) {
                const m = ctx.getTransform();
                out.push({
                    text: text,
                    screenDeg: (Math.atan2(m.b, m.a) * 180 / Math.PI) + (labelRotationDeg || 0),
                });
            };
            const realFill = ctx.fillText.bind(ctx);
            const realStroke = ctx.strokeText.bind(ctx);
            ctx.fillText = function (t, x, y) { record(t); return realFill(t, x, y); };
            ctx.strokeText = function (t, x, y) { record(t); return realStroke(t, x, y); };

            drawInstanceLabels(ctx, [fx.inst], fx.session.skeleton, 'cam1', {
                trackNames: fx.session.tracks,
                selectedInstanceIdx: 0,
                labelRotation: labelRotationDeg || 0,
            });
            return out;
        }

        const worstDeg = (drawn) => drawn.reduce(
            (w, d) => Math.max(w, Math.abs(((d.screenDeg + 180) % 360) - 180)), 0);

        it('draws the node names before any rotation', function () {
            const drawn = drawnText(0);
            const texts = drawn.map(function (d) { return d.text; });
            assertTrue(texts.indexOf('pivot') >= 0, 'pivot label drawn: ' + texts.join(','));
            assertTrue(texts.indexOf('armX') >= 0, 'armX label drawn: ' + texts.join(','));
        });

        it('keeps every label horizontal after the instance is turned', function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX * 7); // 42 degrees
            const drawn = drawnText(0);
            assertTrue(drawn.length > 0, 'something was drawn');
            assertApprox(worstDeg(drawn), 0, 1e-9,
                'no label may pick up the instance rotation');
        });

        it('still names every node once the instance has turned', function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX * 15); // 90 degrees
            const texts = drawnText(0).map(function (d) { return d.text; });
            assertTrue(texts.indexOf('pivot') >= 0, 'pivot label survives the turn');
            assertTrue(texts.indexOf('armX') >= 0, 'armX label survives the turn');
        });

        it('stays horizontal when a turned instance sits in a rotated view', function () {
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX * 7); // 42 degrees
            // The view itself is rotated 90 degrees (issue #162). The label
            // frame must cancel exactly that and nothing else.
            const drawn = drawnText(90);
            assertTrue(drawn.length > 0, 'something was drawn');
            assertApprox(worstDeg(drawn), 0, 1e-9,
                'view rotation is cancelled, instance rotation never applied');
        });

        it('moves the labels with their nodes even though they do not turn', function () {
            const before = fx.inst.getY(1);
            wheelAt(fx.canvas, 100, 100, -NOTCH_PX * 15); // 90 degrees
            assertTrue(Math.abs(fx.inst.getY(1) - before) > 1,
                'the armX node really did move, so this is not a no-op check');
        });
    });

    // ==================================================================
    describe('Instance Rotate - during an Alt+drag (SLEAP gesture)', function () {
        let fx;
        beforeEach(function () { cleanupCanvases(); fx = makeFixture(); });

        it('rotates about the grabbed node while the button is held', function () {
            fx.canvas.dispatchEvent(new MouseEvent('mousedown', {
                clientX: 100, clientY: 100, button: 0, altKey: true,
                bubbles: true, cancelable: true,
            }));
            assertTrue(fx.manager.isDragging, 'Alt+mousedown starts an instance drag');
            assertEqual(fx.manager.dragInfo.mode, 'instance');

            // The cursor need not stay on the node: dispatch on the document.
            const e = new WheelEvent('wheel', {
                clientX: 500, clientY: 500, deltaY: -NOTCH_PX * 15,
                bubbles: true, cancelable: true,
            });
            document.dispatchEvent(e);

            assertApprox(fx.inst.getX(1), 100, 1e-6, 'armX swung 90 degrees');
            assertApprox(fx.inst.getY(1), 140, 1e-6, 'armX swung 90 degrees');
            assertTrue(e.defaultPrevented, 'zoom is suppressed mid-drag');
        });

        it('commits a rotation that never cleared the drag deadzone', function () {
            fx.canvas.dispatchEvent(new MouseEvent('mousedown', {
                clientX: 100, clientY: 100, button: 0, altKey: true,
                bubbles: true, cancelable: true,
            }));
            document.dispatchEvent(new WheelEvent('wheel', {
                clientX: 100, clientY: 100, deltaY: -NOTCH_PX * 15,
                bubbles: true, cancelable: true,
            }));
            document.dispatchEvent(new MouseEvent('mouseup', {
                clientX: 100, clientY: 100, button: 0, bubbles: true, cancelable: true,
            }));

            assertFalse(fx.manager.isDragging, 'drag ended');
            assertEqual(fx.moved.length, 1,
                'a pure rotation is an edit even with no mouse movement');
            assertApprox(fx.inst.getY(1), 140, 1e-6, 'rotation survived the release');
        });

        it('composes with the drag translation', function () {
            fx.canvas.dispatchEvent(new MouseEvent('mousedown', {
                clientX: 100, clientY: 100, button: 0, altKey: true,
                bubbles: true, cancelable: true,
            }));
            document.dispatchEvent(new WheelEvent('wheel', {
                clientX: 100, clientY: 100, deltaY: -NOTCH_PX * 15,
                bubbles: true, cancelable: true,
            }));
            document.dispatchEvent(new MouseEvent('mousemove', {
                clientX: 130, clientY: 100, bubbles: true, cancelable: true,
            }));
            document.dispatchEvent(new MouseEvent('mouseup', {
                clientX: 130, clientY: 100, button: 0, bubbles: true, cancelable: true,
            }));

            // 90 degrees about (100,100), then +30 on x.
            assertApprox(fx.inst.getX(0), 130, 1e-6, 'pivot translated');
            assertApprox(fx.inst.getY(0), 100, 1e-6, 'pivot translated');
            assertApprox(fx.inst.getX(1), 130, 1e-6, 'armX rotated then translated');
            assertApprox(fx.inst.getY(1), 140, 1e-6, 'armX rotated then translated');
        });

        it('leaves the wheel alone during a plain single-node drag', function () {
            fx.canvas.dispatchEvent(new MouseEvent('mousedown', {
                clientX: 100, clientY: 100, button: 0,
                bubbles: true, cancelable: true,
            }));
            assertEqual(fx.manager.dragInfo.mode, 'node');
            const e = new WheelEvent('wheel', {
                clientX: 100, clientY: 100, deltaY: -NOTCH_PX,
                bubbles: true, cancelable: true,
            });
            document.dispatchEvent(e);
            assertFalse(e.defaultPrevented, 'nothing to rotate, so zoom still works');
        });
    });
})();
