/**
 * test-loading-progress-modal-api.js — Feature: LoadingProgressModal API contract.
 *
 * Per prompts.md "Per-video loading progress modal" → "UI: modular progress
 * modal", the LoadingProgressModal class lives at ui/loading-progress-modal.js
 * and is the contract the future SLP project loader will plug into. The
 * class must expose:
 *
 *   new LoadingProgressModal({ title, autoDismissMs, minVisibleMs })
 *   modal.addTask({ label }) -> taskId
 *   modal.updateTask(taskId, { phase, ratio })
 *   modal.completeTask(taskId)
 *   modal.failTask(taskId, error)
 *   modal.show()       // idempotent
 *   modal.dismiss()
 *
 * Behavior:
 *   - Min visible duration ~300 ms; if all tasks complete sooner, dismiss
 *     is delayed until the floor is reached.
 *   - Auto-dismiss ~500 ms after all rows hit 100%.
 *   - Stays open on error until the user dismisses.
 *
 * This test does NOT import any video-specific module — that's the whole
 * point of the modal being reusable. It runs in both the Node sandbox
 * (which provides DOM stubs in tests/run-node.js) and the browser sandbox.
 *
 * Pre-fix: ALL assertions fail because ui/loading-progress-modal.js does
 * not yet exist — the import / global resolution throws.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertEqual = TF.assertEqual;
    var assertNotNull = TF.assertNotNull;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;

    function getModalClass() {
        if (typeof LoadingProgressModal === 'function') return LoadingProgressModal;
        if (typeof window !== 'undefined' && typeof window.LoadingProgressModal === 'function') {
            return window.LoadingProgressModal;
        }
        throw new Error('LoadingProgressModal not loaded into sandbox ' +
            '(expected ui/loading-progress-modal.js to export it)');
    }

    function delay(ms) {
        return new Promise(function (r) { setTimeout(r, ms); });
    }

    // Use small timings so the test runs fast.
    var AUTO_DISMISS_MS = 60;
    var MIN_VISIBLE_MS = 80;

    describe('LoadingProgressModal API contract', function () {
        it('constructs without throwing', function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Loading videos',
                autoDismissMs: AUTO_DISMISS_MS,
                minVisibleMs: MIN_VISIBLE_MS,
            });
            assertNotNull(modal, 'Constructor returned null/undefined');
        });

        it('addTask returns a unique id per call', function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Loading',
                autoDismissMs: AUTO_DISMISS_MS,
                minVisibleMs: MIN_VISIBLE_MS,
            });
            var id1 = modal.addTask({ label: 'cam_front.mp4' });
            var id2 = modal.addTask({ label: 'cam_back.mp4' });
            assertNotNull(id1, 'addTask should return a non-null id');
            assertNotNull(id2, 'addTask should return a non-null id');
            assertTrue(id1 !== id2,
                'addTask should return distinct ids on repeated calls; got ' +
                JSON.stringify(id1) + ' twice');
        });

        it('updateTask updates the task state observable via getTaskState() or DOM', function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Loading',
                autoDismissMs: AUTO_DISMISS_MS,
                minVisibleMs: MIN_VISIBLE_MS,
            });
            var id = modal.addTask({ label: 'cam.mp4' });
            modal.updateTask(id, { phase: 'mp4box', ratio: 0.42 });

            // Accept either an explicit getter or DOM-based introspection.
            // At least one of: getTaskState exists OR the modal's root
            // element has a discoverable progress-bar width / aria-valuenow
            // reflecting ~42%.
            var observed = null;
            if (typeof modal.getTaskState === 'function') {
                observed = modal.getTaskState(id);
                assertNotNull(observed, 'getTaskState(id) returned null');
                assertEqual(observed.phase, 'mp4box',
                    'getTaskState(id).phase should reflect updateTask({phase})');
                assertTrue(
                    Math.abs(observed.ratio - 0.42) < 1e-6,
                    'getTaskState(id).ratio should reflect updateTask({ratio}); got ' +
                    observed.ratio
                );
            } else {
                // Fallback: look for a DOM element exposing the ratio.
                // This is intentionally permissive — solver-agent picks
                // the inspection path. If neither getTaskState NOR a
                // discoverable DOM signal exists, assertion fails.
                var root = (typeof modal.root === 'object' && modal.root) ||
                           (typeof modal.element === 'object' && modal.element) ||
                           null;
                assertNotNull(
                    root,
                    'updateTask cannot be observed: no getTaskState() and no ' +
                    'modal.root / modal.element to inspect. Pick one.'
                );
                // Either an aria-valuenow or width set to ~42%.
                var html = (root.outerHTML || root.innerHTML || '');
                var hasSignal =
                    /aria-valuenow=["']?42(\.0+)?["']?/.test(html) ||
                    /width:\s*42(\.\d+)?%/.test(html) ||
                    /width:\s*42(\.\d+)?px/.test(html);
                assertTrue(
                    hasSignal,
                    'After updateTask({phase:"mp4box", ratio:0.42}), expected the ' +
                    'modal DOM to expose 42% via aria-valuenow or width:42%. Got: ' +
                    html.slice(0, 200)
                );
            }
        });

        it('completeTask marks the task complete', function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Loading',
                autoDismissMs: AUTO_DISMISS_MS,
                minVisibleMs: MIN_VISIBLE_MS,
            });
            var id = modal.addTask({ label: 'cam.mp4' });
            modal.completeTask(id);
            if (typeof modal.getTaskState === 'function') {
                var s = modal.getTaskState(id);
                assertNotNull(s, 'getTaskState(id) returned null after completeTask');
                // Accept either status === 'complete' or ratio === 1.
                var done = (s.status === 'complete' || s.status === 'completed' || s.ratio === 1);
                assertTrue(
                    done,
                    'After completeTask(id), expected status "complete"/"completed" ' +
                    'or ratio === 1; got ' + JSON.stringify(s)
                );
            }
        });

        it('failTask records the error message somewhere observable', function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Loading',
                autoDismissMs: AUTO_DISMISS_MS,
                minVisibleMs: MIN_VISIBLE_MS,
            });
            var id = modal.addTask({ label: 'cam.mp4' });
            var err = new Error('boom');
            modal.failTask(id, err);

            var found = false;
            if (typeof modal.getTaskState === 'function') {
                var s = modal.getTaskState(id);
                if (s && (s.status === 'error' || s.status === 'failed' || s.error)) {
                    var msg = (s.error && (s.error.message || s.error)) || '';
                    if (typeof msg === 'string' && msg.indexOf('boom') >= 0) found = true;
                    if (s.status === 'error' || s.status === 'failed') found = true;
                }
            }
            if (!found) {
                // Fall back to scanning DOM for the error text.
                var root = (typeof modal.root === 'object' && modal.root) ||
                           (typeof modal.element === 'object' && modal.element) ||
                           null;
                if (root) {
                    var html = (root.outerHTML || root.innerHTML || '') +
                               (root.textContent || '');
                    if (html.indexOf('boom') >= 0) found = true;
                }
            }
            assertTrue(
                found,
                'failTask(id, new Error("boom")) must record the error ' +
                'observably (via getTaskState, DOM hover/aria text, etc.). ' +
                'Solver-agent can pick the path; the test accepts any of them.'
            );
        });

        it('show() is idempotent', function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Loading',
                autoDismissMs: AUTO_DISMISS_MS,
                minVisibleMs: MIN_VISIBLE_MS,
            });
            modal.addTask({ label: 'cam.mp4' });
            modal.show();
            modal.show();

            // Inspect via document body or modal.root: the modal element
            // must appear at most once.
            var root = (typeof modal.root === 'object' && modal.root) ||
                       (typeof modal.element === 'object' && modal.element) ||
                       null;
            assertNotNull(root, 'modal must expose root/element after show()');

            // Count occurrences in document.body.children if present; else
            // assert the modal itself was not double-mounted (no duplicate
            // children of its own type).
            if (typeof document !== 'undefined' && document.body && document.body.children) {
                var count = 0;
                for (var i = 0; i < document.body.children.length; i++) {
                    if (document.body.children[i] === root) count++;
                }
                assertTrue(count <= 1,
                    'show() called twice mounted the modal more than once ' +
                    '(found ' + count + ' instances in document.body.children)');
            }
        });

        it('dismiss() removes the modal; show() after dismiss re-creates it', function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Loading',
                autoDismissMs: AUTO_DISMISS_MS,
                minVisibleMs: MIN_VISIBLE_MS,
            });
            modal.addTask({ label: 'cam.mp4' });
            modal.show();
            modal.dismiss();

            // After dismiss, the modal's root should not be in document.body.
            var root = (typeof modal.root === 'object' && modal.root) ||
                       (typeof modal.element === 'object' && modal.element) ||
                       null;
            if (typeof document !== 'undefined' && document.body && document.body.children && root) {
                var found = false;
                for (var i = 0; i < document.body.children.length; i++) {
                    if (document.body.children[i] === root) { found = true; break; }
                }
                assertFalse(found, 'dismiss() should remove the modal from the DOM');
            }

            // show() after dismiss should not throw.
            modal.show();
            // Best-effort presence check.
            var rootAfter = (typeof modal.root === 'object' && modal.root) ||
                            (typeof modal.element === 'object' && modal.element) ||
                            null;
            assertNotNull(rootAfter, 'show() after dismiss() must re-create the modal root');
        });

        it('auto-dismisses after autoDismissMs once all tasks complete', async function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Loading',
                autoDismissMs: AUTO_DISMISS_MS, // 60 ms
                minVisibleMs: 1, // bypass min-visible floor for this test
            });
            var id = modal.addTask({ label: 'cam.mp4' });
            modal.show();
            var t0 = Date.now();
            modal.completeTask(id);

            // Wait long enough for auto-dismiss to fire.
            await delay(AUTO_DISMISS_MS + 80);
            var elapsed = Date.now() - t0;

            // After auto-dismiss, modal.isOpen() / modal.dismissed flag /
            // DOM presence should reflect dismissal. Accept any of those.
            var dismissed = false;
            if (typeof modal.isOpen === 'function') {
                dismissed = !modal.isOpen();
            } else if (typeof modal.dismissed === 'boolean') {
                dismissed = modal.dismissed;
            } else {
                var root = (typeof modal.root === 'object' && modal.root) ||
                           (typeof modal.element === 'object' && modal.element) ||
                           null;
                if (root && typeof document !== 'undefined' && document.body && document.body.children) {
                    var found = false;
                    for (var i = 0; i < document.body.children.length; i++) {
                        if (document.body.children[i] === root) { found = true; break; }
                    }
                    dismissed = !found;
                }
            }
            assertTrue(
                dismissed,
                'Modal should auto-dismiss within ' + AUTO_DISMISS_MS + ' ms ' +
                'of all tasks completing (waited ' + elapsed + ' ms).'
            );
        });

        it('respects minVisibleMs floor — does not dismiss before the floor even if tasks complete instantly', async function () {
            var ModalClass = getModalClass();
            var FLOOR = 120;
            var modal = new ModalClass({
                title: 'Loading',
                autoDismissMs: 1, // immediate auto-dismiss, but...
                minVisibleMs: FLOOR, // ...floor must hold the modal open this long.
            });
            var id = modal.addTask({ label: 'cam.mp4' });
            modal.show();
            var t0 = Date.now();
            modal.completeTask(id); // instant complete

            // Sleep less than the floor — modal must still be open.
            await delay(40);
            var early = false;
            if (typeof modal.isOpen === 'function') {
                early = modal.isOpen();
            } else if (typeof modal.dismissed === 'boolean') {
                early = !modal.dismissed;
            } else {
                var root = (typeof modal.root === 'object' && modal.root) ||
                           (typeof modal.element === 'object' && modal.element) ||
                           null;
                if (root && typeof document !== 'undefined' && document.body && document.body.children) {
                    for (var i = 0; i < document.body.children.length; i++) {
                        if (document.body.children[i] === root) { early = true; break; }
                    }
                }
            }
            assertTrue(
                early,
                'Modal dismissed at ' + (Date.now() - t0) + ' ms — before ' +
                'minVisibleMs floor of ' + FLOOR + ' ms. The min-visible ' +
                'floor must hold the modal open even when autoDismissMs is small.'
            );
        });
    });
})();
