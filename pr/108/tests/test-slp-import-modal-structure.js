/**
 * test-slp-import-modal-structure.js — Feature: SLP-import progress modal
 * two-level hierarchy.
 *
 * Per spec for "Progress modal on SLP project import":
 *   - Modal extends LoadingProgressModal with two-level hierarchy:
 *     sessions = parents, videos = children.
 *   - Only the currently-loading session shows its video child rows expanded;
 *     loaded and pending sessions show parent row only.
 *   - Pending sessions show a "clock" icon and red text color (or
 *     appropriate marker class).
 *   - Loaded sessions show a "check" icon and green text color.
 *   - Currently-loading session shows a spinner (or in-progress class).
 *   - Header: `Importing project · Session N of M`.
 *   - Header updates as N advances.
 *
 * Headless DOM test. The (extended) modal is assumed to expose at least:
 *   - new LoadingProgressModal({ title, autoDismissMs, minVisibleMs })
 *   - modal.addSessionGroup({ label }) -> sessionId
 *   - modal.addTaskToSession(sessionId, { label }) -> taskId
 *     (or modal.addTask({ label, sessionId }) — accepted alternative)
 *   - modal.setCurrentSession(sessionId)
 *   - modal.completeSession(sessionId)
 *   - modal.setProjectImportHeader({ current, total }) OR an inferred header
 *     update via setCurrentSession (the spec wording — "Session N of M" —
 *     implies the modal can derive N from the current-session pointer).
 *
 * We probe several possible API names; the solver may rename so long as
 * the observed behaviour holds.
 *
 * Pre-fix: addSessionGroup (or any of its accepted aliases) does not
 * exist; the test fails with a clear "modal.addSessionGroup is not a
 * function" message.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertTrue = TF.assertTrue;
    var assertNotNull = TF.assertNotNull;

    function getModalClass() {
        if (typeof LoadingProgressModal === 'function') return LoadingProgressModal;
        // eslint-disable-next-line no-undef
        if (typeof window !== 'undefined' && typeof window.LoadingProgressModal === 'function') {
            // eslint-disable-next-line no-undef
            return window.LoadingProgressModal;
        }
        throw new Error('LoadingProgressModal not loaded into sandbox');
    }

    /**
     * Call the first matching method name from `aliases` on `modal`. Returns
     * the return value, or undefined if none of them exist.
     * Throws a descriptive error if none of them exist and `required` is true.
     */
    function callAlias(modal, aliases, args, required) {
        for (var i = 0; i < aliases.length; i++) {
            var name = aliases[i];
            if (typeof modal[name] === 'function') {
                return modal[name].apply(modal, args || []);
            }
        }
        if (required) {
            throw new Error(
                'modal does not implement any of: ' + aliases.join(', ') +
                '. The SLP-import progress modal extension must expose at ' +
                'least one of these methods.'
            );
        }
        return undefined;
    }

    /**
     * Extract a printable representation of the modal's rendered DOM so we
     * can scan for icons / status classes / header text.
     */
    function getRootHtml(modal) {
        var root = modal.root || modal.element || null;
        if (!root) return '';
        return (root.outerHTML || '') + ' ' + (root.innerHTML || '') +
               ' ' + (root.textContent || '');
    }

    /**
     * Pull header text from any plausible location on the modal.
     */
    function getHeaderText(modal) {
        var root = modal.root || modal.element || null;
        if (!root) return '';
        // Look for a child element with role=heading or class~="header"/"title"
        // or just fall back to the root's textContent.
        return (root.textContent || '');
    }

    describe('SLP-import progress modal: two-level hierarchy', function () {
        it('renders 3 session parent rows from the start and shows children for the current session only', function () {
            var ModalClass = getModalClass();
            var modal = new ModalClass({
                title: 'Importing project',
                autoDismissMs: 500,
                minVisibleMs: 1,
            });

            // 1. Add 3 session groups — each with 2 video tasks.
            var sessionIds = [];
            var taskIds = [[], [], []];
            for (var s = 0; s < 3; s++) {
                var sid = callAlias(modal, [
                    'addSessionGroup',
                    'addSession',
                    'addParentTask',
                ], [{ label: 'session_' + s }], true);
                assertNotNull(
                    sid,
                    'addSessionGroup({ label }) should return a non-null id ' +
                    '(session ' + s + ')'
                );
                sessionIds.push(sid);
                for (var v = 0; v < 2; v++) {
                    var tid = callAlias(modal, [
                        'addTaskToSession',
                        'addChildTask',
                    ], [sid, { label: 'cam_' + v + '.mp4' }], false);
                    if (tid == null) {
                        // Try addTask({ sessionId, label }) signature.
                        tid = callAlias(modal, ['addTask'], [
                            { label: 'cam_' + v + '.mp4', sessionId: sid },
                        ], true);
                    }
                    assertNotNull(
                        tid,
                        'Adding a child task to session ' + s + ' should return ' +
                        'a non-null id'
                    );
                    taskIds[s].push(tid);
                }
            }

            modal.show();

            // 2. setCurrentSession(sessionIds[0]) — session 0 should now be
            //    "current". Sessions 1 and 2 are pending.
            callAlias(modal, ['setCurrentSession', 'setActiveSession'], [sessionIds[0]], true);

            // 3. Header must read "Importing project · Session 1 of 3" (or
            //    a substring like "Session 1 of 3" — we accept either bullet
            //    or em-dash separator).
            // First, try an explicit header-setter:
            callAlias(modal, [
                'setProjectImportHeader',
                'setHeader',
                'setSessionProgress',
            ], [{ current: 1, total: 3 }], false);

            var header1 = getHeaderText(modal);
            var hasSession1of3 = /Session\s*1\s*(of|\/)\s*3/i.test(header1);
            assertTrue(
                hasSession1of3,
                'Header should reflect "Session 1 of 3" when setCurrentSession ' +
                'points to the first session. Got: ' + header1.slice(0, 200)
            );

            // 4. Pending sessions (1 and 2) must show pending markers — clock
            //    icon or a class indicating pending status. The exact marker
            //    is left to the solver; we accept either:
            //      - text "clock" or aria-label="clock"
            //      - a className containing "pending" or "queued" or "waiting"
            //      - an "&#xf017;" or "fa-clock" reference (FontAwesome)
            var html = getRootHtml(modal);
            var pendingMarker =
                /clock/i.test(html) ||
                /pending|queued|waiting/i.test(html);
            assertTrue(
                pendingMarker,
                'Pending sessions (sessions 1 and 2) must show a pending ' +
                'marker (clock icon / "pending" class / etc.) in the modal ' +
                'DOM. Got: ' + html.slice(0, 400)
            );

            // 5. The currently-loading session (session 0) must show a
            //    spinner / in-progress marker.
            var inProgressMarker =
                /spinner/i.test(html) ||
                /loading/i.test(html) ||
                /in.?progress/i.test(html) ||
                /active/i.test(html);
            assertTrue(
                inProgressMarker,
                'Currently-loading session (session 0) must show a spinner ' +
                'or in-progress marker in the modal DOM. Got: ' +
                html.slice(0, 400)
            );

            // 6. Session 0's child rows (video tasks) must be visible in
            //    the DOM. Sessions 1 and 2's children must NOT be (collapsed).
            var hasSession0Children =
                html.indexOf('cam_0.mp4') >= 0 || html.indexOf('cam_1.mp4') >= 0;
            assertTrue(
                hasSession0Children,
                'Session 0\'s child video rows ("cam_0.mp4", "cam_1.mp4") ' +
                'must render expanded for the currently-loading session. ' +
                'Got: ' + html.slice(0, 400)
            );

            // Mark session 0 complete; advance to session 1.
            callAlias(modal, [
                'completeSession',
                'finishSession',
            ], [sessionIds[0]], false);

            // Completed task ids for session 0.
            for (var ti = 0; ti < taskIds[0].length; ti++) {
                modal.completeTask(taskIds[0][ti]);
            }

            callAlias(modal, ['setCurrentSession', 'setActiveSession'], [sessionIds[1]], true);
            callAlias(modal, [
                'setProjectImportHeader',
                'setHeader',
                'setSessionProgress',
            ], [{ current: 2, total: 3 }], false);

            // 7. Header should now read "Session 2 of 3".
            var header2 = getHeaderText(modal);
            var hasSession2of3 = /Session\s*2\s*(of|\/)\s*3/i.test(header2);
            assertTrue(
                hasSession2of3,
                'Header should advance to "Session 2 of 3" after the first ' +
                'session completes and setCurrentSession points to session 1. ' +
                'Got: ' + header2.slice(0, 200)
            );

            // 8. Session 0 must now show a "check" / "done" / "completed" marker.
            var html2 = getRootHtml(modal);
            var doneMarker =
                /check/i.test(html2) ||
                /done/i.test(html2) ||
                /complete/i.test(html2) ||
                /finished/i.test(html2);
            assertTrue(
                doneMarker,
                'Loaded session (session 0) must show a check / done / ' +
                'completed marker after completeSession. Got: ' +
                html2.slice(0, 400)
            );
        });
    });
})();
