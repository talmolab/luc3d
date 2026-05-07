/**
 * test-predicted-visibility-on-load.js — Predicted-instance visibility
 * after SLP load.
 *
 * The visibility toolbar (`visUser`, `visPredicted`, `visReprojections`,
 * `visErrors`) is persisted in `localStorage` (index.html:5167-5240).
 * If the user previously unchecked `visPredicted`, the toggle stays
 * unchecked across page reloads, so predicted instances loaded from a
 * fresh SLP file would silently fail to render — even though they
 * appear in the info panel. The fix in `handleLoadSlpFile` forces the
 * toggle on when the loaded SLP contains predicted instances.
 *
 * `handleLoadSlpFile` lives inside index.html's inline script, so we
 * mirror the small force-on snippet here and exercise the underlying
 * filter contracts (`drawAllOverlays`'s `viewUnlinked` filter and
 * `drawFrameOverlays`'s `showPredicted` gate) end-to-end.
 */

(function () {
    var describe   = TestFramework.describe;
    var it         = TestFramework.it;
    var beforeEach = TestFramework.beforeEach;
    var assertEqual    = TestFramework.assertEqual;
    var assertTrue     = TestFramework.assertTrue;
    var assertFalse    = TestFramework.assertFalse;
    var assertNotNull  = TestFramework.assertNotNull;
    var assertGreaterThan = TestFramework.assertGreaterThan;

    /**
     * Mirror of the load-time force-on snippet from
     * `index.html:14076` (just before drawAllOverlays).
     */
    function forceVisPredictedIfNeeded(slpPredCount, visPredEl) {
        if (slpPredCount > 0) {
            if (visPredEl && !visPredEl.checked) {
                visPredEl.checked = true;
            }
        }
    }

    /**
     * Mirror of the `viewUnlinked` filter at index.html:2934-2943.
     * Production renders only entries that pass this filter.
     */
    function buildViewUnlinked(unlinkedList, vis) {
        var out = [];
        if (!unlinkedList) return out;
        if (!vis.showUser && !vis.showPredicted) return out;
        for (var i = 0; i < unlinkedList.length; i++) {
            var t = unlinkedList[i].instance.type || 'user';
            if (t === 'predicted' && vis.showPredicted) out.push(unlinkedList[i]);
            else if (t !== 'predicted' && vis.showUser) out.push(unlinkedList[i]);
        }
        return out;
    }

    function makeCheckbox(initial) {
        return { checked: !!initial };
    }

    function buildSessionWithPredicted() {
        var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
        var cameras = [
            new Camera('cam1', [[600,0,320],[0,600,240],[0,0,1]],
                [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
            new Camera('cam2', [[600,0,320],[0,600,240],[0,0,1]],
                [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
        ];
        var session = new Session(cameras, skeleton, ['track_0']);

        // Mirror the post-import state for a non-LUCID SLP: every
        // predicted instance ends up in fg.unlinkedInstances.
        var fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        var pred1 = new Instance([[100,100],[150,150]], 0, 'predicted', 0.85);
        var pred2 = new Instance([[200,200],[250,250]], 0, 'predicted', 0.92);
        fg.addUnlinkedInstance('cam1', new UnlinkedInstance(pred1, 'cam1'));
        fg.addUnlinkedInstance('cam2', new UnlinkedInstance(pred2, 'cam2'));
        return session;
    }

    function buildSessionWithUserOnly() {
        var skeleton = new Skeleton('mouse', ['nose', 'head'], [[0, 1]]);
        var cameras = [
            new Camera('cam1', [[600,0,320],[0,600,240],[0,0,1]],
                [0,0,0,0,0], [0,0,0], [0,0,0], [640,480]),
        ];
        var session = new Session(cameras, skeleton, ['track_0']);
        var fg = new FrameGroup(0);
        session.addFrameGroup(fg);
        var u = new Instance([[100,100],[150,150]], 0, 'user', 1.0);
        fg.addUnlinkedInstance('cam1', new UnlinkedInstance(u, 'cam1'));
        return session;
    }

    // ================================================================
    // Suite 1 — load-time force-on
    // ================================================================

    describe('Predicted visibility — force-on at SLP load', function () {

        it('flips visPredicted on when toggle was off and predicted exist', function () {
            var visPred = makeCheckbox(false);
            forceVisPredictedIfNeeded(/*slpPredCount*/ 17, visPred);
            assertTrue(visPred.checked, 'must force toggle on');
        });

        it('leaves visPredicted alone when already on', function () {
            var visPred = makeCheckbox(true);
            forceVisPredictedIfNeeded(50, visPred);
            assertTrue(visPred.checked, 'still on (was on, stays on)');
        });

        it('does NOT force toggle on when no predicted instances loaded', function () {
            // User has visPredicted off and the file contains no predicted
            // instances — leave the toggle alone (respect user preference).
            var visPred = makeCheckbox(false);
            forceVisPredictedIfNeeded(0, visPred);
            assertFalse(visPred.checked, 'no predicted → no force');
        });

        it('safe when checkbox element is null', function () {
            // Defensive — the live DOM lookup could return null in tests.
            var threw = false;
            try { forceVisPredictedIfNeeded(5, null); } catch (e) { threw = true; }
            assertFalse(threw, 'must not throw on null element');
        });
    });

    // ================================================================
    // Suite 2 — render filter consequences
    // ================================================================

    describe('Predicted visibility — viewUnlinked filter contract', function () {

        it('predicted instances pass the filter when showPredicted is true', function () {
            var session = buildSessionWithPredicted();
            var fg = session.getFrameGroup(0);
            var vis = { showUser: true, showPredicted: true };

            var cam1Out = buildViewUnlinked(fg.getUnlinkedInstances('cam1'), vis);
            var cam2Out = buildViewUnlinked(fg.getUnlinkedInstances('cam2'), vis);

            assertEqual(cam1Out.length, 1, 'cam1 predicted shown');
            assertEqual(cam2Out.length, 1, 'cam2 predicted shown');
            assertEqual(cam1Out[0].instance.type, 'predicted');
        });

        it('predicted instances are filtered out when showPredicted is false', function () {
            // This is the regression: data exists, showPredicted=false → empty.
            var session = buildSessionWithPredicted();
            var fg = session.getFrameGroup(0);
            var vis = { showUser: true, showPredicted: false };

            var cam1Out = buildViewUnlinked(fg.getUnlinkedInstances('cam1'), vis);
            var cam2Out = buildViewUnlinked(fg.getUnlinkedInstances('cam2'), vis);

            assertEqual(cam1Out.length, 0, 'cam1 predicted filtered out');
            assertEqual(cam2Out.length, 0, 'cam2 predicted filtered out');
        });

        it('user instances pass the filter independently of showPredicted', function () {
            var session = buildSessionWithUserOnly();
            var fg = session.getFrameGroup(0);
            // Mimics post-fix state: user toggle on, predicted toggle off.
            var vis = { showUser: true, showPredicted: false };

            var cam1Out = buildViewUnlinked(fg.getUnlinkedInstances('cam1'), vis);
            assertEqual(cam1Out.length, 1, 'user instance still shown');
        });

        it('end-to-end: force-on toggle yields visible predicted instances', function () {
            // Reproduce the failure mode: visPredicted persisted as off
            // from a prior session.
            var visPred = makeCheckbox(false);

            // Simulate the count produced inside handleLoadSlpFile.
            var session = buildSessionWithPredicted();
            var fg = session.getFrameGroup(0);
            var slpPredCount = 0;
            for (var [, list] of fg.unlinkedInstances) {
                for (var i = 0; i < list.length; i++) {
                    if (list[i].instance.type === 'predicted') slpPredCount++;
                }
            }
            assertEqual(slpPredCount, 2, 'fixture should have 2 predicted');

            // Pre-fix snapshot: would render nothing.
            var visBefore = { showUser: true, showPredicted: visPred.checked };
            assertEqual(buildViewUnlinked(fg.getUnlinkedInstances('cam1'), visBefore).length,
                0, 'pre-fix: predicted hidden');

            // Apply the load-time fix.
            forceVisPredictedIfNeeded(slpPredCount, visPred);

            // Post-fix snapshot: predicted now pass through.
            var visAfter = { showUser: true, showPredicted: visPred.checked };
            assertEqual(buildViewUnlinked(fg.getUnlinkedInstances('cam1'), visAfter).length,
                1, 'post-fix: predicted shown');
            assertEqual(buildViewUnlinked(fg.getUnlinkedInstances('cam2'), visAfter).length,
                1, 'post-fix: predicted shown');
        });
    });

    // ================================================================
    // Suite 3 — Instance.type preservation through a non-LUCID SLP load
    // ================================================================

    describe('Predicted visibility — type field is preserved', function () {

        it('Instance constructed with type="predicted" round-trips through UnlinkedInstance', function () {
            var inst = new Instance([[100,100]], 0, 'predicted', 0.7);
            var ul = new UnlinkedInstance(inst, 'cam1');
            assertEqual(ul.instance.type, 'predicted',
                'UnlinkedInstance must not coerce the type');
        });

        it('FrameGroup.getUnlinkedInstances returns instances with original type', function () {
            var fg = new FrameGroup(0);
            var inst = new Instance([[100,100]], 0, 'predicted', 0.7);
            fg.addUnlinkedInstance('cam1', new UnlinkedInstance(inst, 'cam1'));

            var list = fg.getUnlinkedInstances('cam1');
            assertEqual(list.length, 1);
            assertEqual(list[0].instance.type, 'predicted');
        });
    });

})();
