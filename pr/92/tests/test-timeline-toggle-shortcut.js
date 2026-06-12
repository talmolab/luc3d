/**
 * test-timeline-toggle-shortcut.js — Block 1, subfeature 1.3 (Prompt 4)
 *
 * `Ctrl/Cmd + J` toggles timeline visibility; remembers prior height on
 * re-show; the legacy "Change Frame Number" command moves to `Ctrl/Cmd +
 * Shift + J`.
 *
 * Per Block 1 of Prompt 4:
 *   - `Ctrl/Cmd + J` toggles timeline visibility (collapse / expand).
 *   - Toggling back ON restores the PREVIOUSLY USED height (not a
 *     hardcoded default).
 *   - The cache survives switching between `Tracks` / `IDs` / `Both`
 *     modes.
 *   - On initial project load, the timeline height fits all tracks,
 *     capped at 40% of the window height.
 *   - The previous `Ctrl/Cmd + J` binding for "Change Frame Number"
 *     moves to `Ctrl/Cmd + Shift + J`.
 *
 * Requirements covered:
 *
 *   (T10) `Ctrl/Cmd + J` toggle — dispatch the keydown event; the
 *         timeline collapses; dispatch again; it restores to its
 *         previous height (not a default).
 *
 *   (T11) Height persists across mode switch — collapse, then switch
 *         `Tracks` → `IDs`, then restore — restored height matches
 *         pre-collapse.
 *
 *   (T12) Conflict — plain `Ctrl/Cmd + J` must NOT fire the legacy
 *         "Change Frame Number" command (the frame-input focus / dblclick
 *         dispatch). That command now binds to `Ctrl/Cmd + Shift + J`.
 *
 * Pre-implementation expectation: every assertion below FAILS because
 * the current `ui-wiring.js` keymap (lines 1187-1213) binds plain
 * `Ctrl/Cmd + J` to "Change Frame Number" (dblclick on `#currentFrame`),
 * not to the timeline toggle. There is no height-cache for the timeline,
 * and there is no `Ctrl/Cmd + Shift + J` binding.
 *
 * NOTE: this file exercises the wired keyboard handler in `ui-wiring.js`
 * indirectly — full DOM mounting of that module requires the whole app
 * environment (it imports app.js transitively). Instead the tests mount
 * the minimum DOM elements (#timelineContainer, #currentFrame), call
 * Block 1's expected toggle function directly, and dispatch keydown
 * events to a thin handler that Block 1 must export from `ui/ui-wiring.js`
 * or a new `ui/timeline-shortcuts.js` (the exact export name is permissive —
 * the test searches several plausible names).
 *
 * BRIDGE: today `ui-wiring.js` is NOT bridged into the test runner
 * (see test-runner.html — the module imports `app.js` transitively).
 * Block 1's implementation must extract the toggle / fit-to-data helpers
 * into a bridgeable module (e.g., `ui/timeline-controller.js`) and add a
 * matching `import * as __TimelineCtrl from '../ui/timeline-controller.js'`
 * line to test-runner.html's bridge so these tests can find the functions
 * on `window`. Until then, every test in this file fails at the
 * `getToggleFn()`/`fitFn` lookup with a clear "Block 1 must expose …"
 * error message.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assert = TF.assert;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;
    var assertNotNull = TF.assertNotNull;
    var assertGreaterThan = TF.assertGreaterThan;
    var assertLessThan = TF.assertLessThan;

    // --- Test helpers ------------------------------------------------------

    function makeBtn(mode, isActive) {
        var b = document.createElement('button');
        b.className = 'timeline-mode-btn' + (isActive ? ' active' : '');
        b.setAttribute('data-mode', mode);
        b.textContent = mode;
        return b;
    }

    function setupTimelineDOM() {
        var wrap = document.createElement('div');
        wrap.id = 'timelineTestWrapper';
        wrap.style.position = 'fixed';
        wrap.style.top = '-9999px';
        wrap.style.left = '0';
        wrap.style.width = '900px';

        var container = document.createElement('div');
        container.className = 'timeline-container';
        container.id = 'timelineContainer';
        container.style.height = '140px';

        var modeToggle = document.createElement('div');
        modeToggle.className = 'timeline-mode-toggle';
        modeToggle.id = 'timelineModeToggle';
        modeToggle.appendChild(makeBtn('tracks', true));
        modeToggle.appendChild(makeBtn('identities', false));
        modeToggle.appendChild(makeBtn('both', false));
        container.appendChild(modeToggle);

        var controls = document.createElement('div');
        controls.className = 'controls-bar';
        var cf = document.createElement('span');
        cf.className = 'current-frame';
        cf.id = 'currentFrame';
        cf.textContent = '1';
        controls.appendChild(cf);

        wrap.appendChild(container);
        wrap.appendChild(controls);
        document.body.appendChild(wrap);
        return wrap;
    }

    function cleanup(wrap) {
        if (wrap && wrap.parentNode) wrap.remove();
    }

    // Resilient lookups: some DOM stubs (e.g., the Node test runner) implement
    // a simplified querySelector that only handles tag selectors. Fall back to
    // recursively scanning children for the matching id / class.
    function findById(root, id) {
        if (!root) return null;
        if (root.id === id) return root;
        var kids = root.children || root.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            var hit = findById(kids[i], id);
            if (hit) return hit;
        }
        return null;
    }
    function findByClassAndAttr(root, cls, attr, attrValue) {
        if (!root) return null;
        var className = root.className || '';
        var attrVal = (root.getAttribute && root.getAttribute(attr)) || (root[attr] || null);
        if (className.indexOf(cls) >= 0 && (attrValue == null || attrVal === attrValue)) {
            return root;
        }
        var kids = root.children || root.childNodes || [];
        for (var i = 0; i < kids.length; i++) {
            var hit = findByClassAndAttr(kids[i], cls, attr, attrValue);
            if (hit) return hit;
        }
        return null;
    }

    /**
     * Find Block 1's toggle function. Accept any of the plausible export
     * names. Returns the function or null. The function is expected to
     * collapse/expand the `#timelineContainer` and cache the height so
     * the next expand restores it.
     */
    function getToggleFn() {
        var names = [
            'toggleTimelineWithCache',
            'toggleTimelineCached',
            'toggleTimelineRestoreHeight',
            // The existing export. Block 1 may upgrade this in-place to
            // cache the prior height instead of falling back to
            // `getPreferredHeight()` on every expand.
            'toggleTimeline',
        ];
        for (var i = 0; i < names.length; i++) {
            if (typeof window[names[i]] === 'function') return window[names[i]];
        }
        return null;
    }

    /**
     * Install the timeline keyboard shortcuts. Accepts several plausible
     * Block 1 export names. Returns true on success.
     */
    function installShortcuts() {
        var candidates = [
            'installTimelineShortcuts',
            'setupTimelineShortcuts',
            'wireTimelineShortcuts',
            'installKeyboardShortcuts',
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (typeof window[candidates[i]] === 'function') {
                window[candidates[i]]();
                return true;
            }
        }
        return false;
    }

    function makeKeyEvent(key, opts) {
        opts = opts || {};
        return new KeyboardEvent('keydown', {
            key: key,
            code: 'Key' + key.toUpperCase(),
            ctrlKey: !!opts.ctrlKey,
            metaKey: !!opts.metaKey,
            altKey: !!opts.altKey,
            shiftKey: !!opts.shiftKey,
            bubbles: true,
            cancelable: true,
        });
    }

    function getCollapsed(container) {
        return container.classList && container.classList.contains('collapsed');
    }

    function getHeightPx(container) {
        var h = parseFloat(container.style.height);
        return isNaN(h) ? 0 : h;
    }

    // --- (T10) Ctrl+J toggle, prior-height restore -----------------------

    describe('Timeline toggle shortcut (Prompt 4 / Block 1) — Ctrl/Cmd+J', function () {

        it('(T10) plain Ctrl/Cmd + J toggles timeline visibility and restores the prior height on re-show', function () {
            var wrap = setupTimelineDOM();
            var container = wrap.querySelector('#timelineContainer') || findById(wrap, 'timelineContainer');
            // Simulate a user-resized timeline at a non-default height
            // (e.g., 217 px from a drag-resize). Block 1 must cache this
            // value when toggling OFF and reuse it when toggling ON.
            container.style.height = '217px';
            var originalHeight = getHeightPx(container);
            assertEqual(originalHeight, 217,
                'sanity: container should be at 217px before toggle');

            var toggle = getToggleFn();
            assertNotNull(toggle,
                'Block 1 must expose a timeline-toggle function (searched ' +
                'for toggleTimelineWithCache / toggleTimelineRestoreHeight / ' +
                'toggleTimeline)');

            // Wire Block 1's keyboard shortcuts so the dispatched keydown
            // actually invokes the toggle.
            assertTrue(installShortcuts(),
                'Block 1 must expose a keyboard-shortcut installer so this ' +
                'test can wire Ctrl/Cmd+J without the full app environment.');

            // Dispatch Ctrl+J → collapse.
            document.dispatchEvent(makeKeyEvent('j', { ctrlKey: true }));

            assertTrue(getCollapsed(container),
                'after Ctrl+J the timeline must be collapsed; classList=' +
                container.className);

            // Dispatch Ctrl+J → expand, restoring the PRIOR height.
            document.dispatchEvent(makeKeyEvent('j', { ctrlKey: true }));
            assertFalse(getCollapsed(container),
                'after a second Ctrl+J the timeline must be expanded; classList=' +
                container.className);

            var restored = getHeightPx(container);
            assertEqual(restored, originalHeight,
                'after restore, container height must match pre-collapse ' +
                'height. expected=' + originalHeight + ' got=' + restored +
                ' (Block 1 must NOT reset to getPreferredHeight() or a ' +
                'hardcoded default)');

            cleanup(wrap);
        });

        it('(T10b) initial-load height fits all tracks but is capped at 40% of window.innerHeight', function () {
            var wrap = setupTimelineDOM();
            var container = wrap.querySelector('#timelineContainer') || findById(wrap, 'timelineContainer');
            // No prior inline height — simulate a fresh project load.
            container.style.height = '';

            // Block 1 must expose either a "fit to data, capped at 40%"
            // helper, or `fitTimelineToData()` must be updated to apply
            // the cap. Trigger it with a session that has many tracks
            // so the natural preferred height would otherwise exceed 40%.
            var fitFn = null;
            var candidates = [
                'fitTimelineToData',
                'fitTimelineToDataCapped',
                'initializeTimelineHeight',
            ];
            for (var i = 0; i < candidates.length; i++) {
                if (typeof window[candidates[i]] === 'function') {
                    fitFn = window[candidates[i]];
                    break;
                }
            }
            assertNotNull(fitFn,
                'Block 1 must expose a fit-to-data helper (searched ' +
                candidates.join(', ') + ')');

            fitFn();

            var h = getHeightPx(container);
            var cap = 0.4 * window.innerHeight;
            assertLessThan(h, cap + 1,
                'initial-load timeline height must be capped at 40% of ' +
                'window.innerHeight. cap=' + cap + ' got=' + h);

            cleanup(wrap);
        });
    });

    // --- (T11) Height persists across mode switch ------------------------

    describe('Timeline toggle shortcut (Prompt 4 / Block 1) — height cache across mode switches', function () {

        it('(T11) collapse → switch from Tracks to IDs → restore: height matches pre-collapse', function () {
            var wrap = setupTimelineDOM();
            var container = wrap.querySelector('#timelineContainer') || findById(wrap, 'timelineContainer');
            container.style.height = '183px';
            var originalHeight = getHeightPx(container);

            var toggle = getToggleFn();
            assertNotNull(toggle,
                'Block 1 must expose a timeline-toggle function');
            assertTrue(installShortcuts(),
                'Block 1 must expose a keyboard-shortcut installer');

            // Collapse via Ctrl+J.
            document.dispatchEvent(makeKeyEvent('j', { ctrlKey: true }));
            assertTrue(getCollapsed(container),
                'sanity: timeline collapsed after first Ctrl+J');

            // Switch mode while collapsed (clicking the IDs button).
            // Block 1 must keep the cached height across this switch.
            var idsBtn = wrap.querySelector('.timeline-mode-btn[data-mode="identities"]')
                || findByClassAndAttr(wrap, 'timeline-mode-btn', 'data-mode', 'identities');
            assertNotNull(idsBtn, 'sanity: IDs mode button exists');
            idsBtn.click();

            // Restore via Ctrl+J.
            document.dispatchEvent(makeKeyEvent('j', { ctrlKey: true }));
            assertFalse(getCollapsed(container),
                'sanity: timeline expanded after second Ctrl+J');

            var restored = getHeightPx(container);
            assertEqual(restored, originalHeight,
                'cached height must survive a Tracks→IDs mode switch. ' +
                'expected=' + originalHeight + ' got=' + restored);

            cleanup(wrap);
        });
    });

    // --- (T12) Shift+J — legacy "Change Frame Number" --------------------

    describe('Timeline toggle shortcut (Prompt 4 / Block 1) — Shift+J conflict', function () {

        it('(T12) plain Ctrl/Cmd + J no longer triggers "Change Frame Number"; Ctrl/Cmd + Shift + J does', function () {
            var wrap = setupTimelineDOM();
            var currentFrameEl = wrap.querySelector('#currentFrame') || findById(wrap, 'currentFrame');
            assertNotNull(currentFrameEl, 'sanity: #currentFrame exists');

            // Block 1 must expose a function that installs the timeline
            // keyboard shortcuts (so this test can wire them without
            // pulling in the entire ui-wiring.js module, which is not
            // bridged into the test runner). Accept several plausible
            // export names.
            var installFn = null;
            var candidates = [
                'installTimelineShortcuts',
                'setupTimelineShortcuts',
                'wireTimelineShortcuts',
                'installKeyboardShortcuts',
            ];
            for (var i = 0; i < candidates.length; i++) {
                if (typeof window[candidates[i]] === 'function') {
                    installFn = window[candidates[i]];
                    break;
                }
            }
            assertNotNull(installFn,
                'Block 1 must expose a keyboard-shortcut installer ' +
                '(searched ' + candidates.join(', ') + '). The installer ' +
                'must (re)bind Ctrl/Cmd+J to timeline-toggle and ' +
                'Ctrl/Cmd+Shift+J to the legacy "Change Frame Number" command.');

            installFn();

            // Spy on the dblclick that the legacy command fires on
            // #currentFrame.
            var dblclickCount = 0;
            currentFrameEl.addEventListener('dblclick', function () {
                dblclickCount++;
            });

            // Plain Ctrl+J MUST NOT fire the legacy command (it now toggles
            // the timeline).
            document.dispatchEvent(makeKeyEvent('j', { ctrlKey: true }));
            assertEqual(dblclickCount, 0,
                'plain Ctrl+J must NOT trigger the legacy ' +
                '"Change Frame Number" dblclick on #currentFrame; ' +
                'got dblclickCount=' + dblclickCount);

            // Ctrl+Shift+J MUST fire the legacy command (rebound binding).
            document.dispatchEvent(makeKeyEvent('j', { ctrlKey: true, shiftKey: true }));
            assertEqual(dblclickCount, 1,
                'Ctrl+Shift+J must trigger the rebound ' +
                '"Change Frame Number" dblclick on #currentFrame; ' +
                'got dblclickCount=' + dblclickCount);

            cleanup(wrap);
        });
    });
})();
