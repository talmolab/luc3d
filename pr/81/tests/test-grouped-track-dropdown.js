/**
 * test-grouped-track-dropdown.js
 *
 * Regression tests for the "Track / Identity dropdown hides on mouseup"
 * bug in the Grouped and Ungrouped Instances tables.
 *
 * Root cause: the parent <tr>'s click handler called `updateFrameInfo()`,
 * which rebuilt the whole instance table mid-interaction and destroyed
 * the open <select>. Fix: `isInteractiveClickTarget(target)` (in
 * interaction.js) bails the row handler out when the click originated
 * inside a form control; each <select> also stops mousedown/mouseup/click
 * propagation as belt-and-suspenders.
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assertEqual = TestFramework.assertEqual;
    var assertTrue = TestFramework.assertTrue;
    var assertFalse = TestFramework.assertFalse;

    describe('isInteractiveClickTarget', function () {
        it('returns true for form-control targets and their descendants, false otherwise', function () {
            assertTrue(typeof isInteractiveClickTarget === 'function',
                'isInteractiveClickTarget should be defined globally');

            // All interactive tags are recognized, case-insensitive.
            var interactiveTags = ['SELECT', 'OPTION', 'INPUT', 'BUTTON', 'TEXTAREA', 'LABEL',
                'select', 'Input'];
            for (var i = 0; i < interactiveTags.length; i++) {
                assertTrue(isInteractiveClickTarget({ tagName: interactiveTags[i] }),
                    interactiveTags[i] + ' must be interactive');
            }

            // Non-form tags are not interactive.
            assertFalse(isInteractiveClickTarget({ tagName: 'TR' }));
            assertFalse(isInteractiveClickTarget({ tagName: 'TD' }));
            assertFalse(isInteractiveClickTarget(null));
            assertFalse(isInteractiveClickTarget(undefined));

            // Walks up through ancestors to find a SELECT.
            var select = { tagName: 'SELECT', parentNode: null };
            assertTrue(isInteractiveClickTarget({ tagName: 'SPAN', parentNode: select }),
                'descendant of a SELECT must be treated as interactive');

            // Bounded walk — cyclic parentNode chains must not hang.
            var a = { tagName: 'DIV' };
            var b = { tagName: 'DIV', parentNode: a };
            a.parentNode = b;
            assertFalse(isInteractiveClickTarget(a),
                'cyclic ancestor chain of non-interactive nodes returns false');
        });

        it('guards the tr click handler from rebuilding while a SELECT is active', function () {
            // Mimic the production <tr> click handler after the fix:
            //   handler = (ev) => { if (isInteractive(ev.target)) return; rebuild(); }
            var rebuilds = 0;
            var handler = function (ev) {
                if (isInteractiveClickTarget(ev && ev.target)) return;
                rebuilds++;
            };
            handler({ target: { tagName: 'SELECT' } });
            handler({ target: { tagName: 'OPTION' } });
            assertEqual(rebuilds, 0,
                'clicks on a SELECT or OPTION must not rebuild the DOM');
            handler({ target: { tagName: 'TD' } });
            handler({ target: { tagName: 'TR' } });
            assertEqual(rebuilds, 2,
                'plain row clicks still trigger the rebuild');
        });
    });
})();
