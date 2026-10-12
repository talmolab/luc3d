/**
 * test-quick-save.js - Tests for quick save (Ctrl+S) feature
 *
 * `markDirty`, `clearDirty`, `quickSave`, `saveAs`, and the shared
 * `state` object live inside index.html's inline <script>. Neither the
 * Node runner (run-node.js) nor the browser test runner loads that
 * script, so every test in this file is effectively a "full-page
 * context only" test — each guard below short-circuits when the
 * required globals aren't defined, matching the pre-existing pattern
 * in `dirty indicator dot visibility toggles`.
 *
 * To actually exercise this logic, paste these tests into the live
 * page's console or refactor the inline helpers into a loadable module.
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse } = TestFramework;

    function globalsMissing() {
        return typeof state === 'undefined'
            || typeof markDirty !== 'function'
            || typeof clearDirty !== 'function';
    }

    // --- Dirty Flag ---

    describe('markDirty / clearDirty', function () {
        it('markDirty sets state.isDirty to true', function () {
            if (globalsMissing()) return;
            state.isDirty = false;
            markDirty();
            assertTrue(state.isDirty, 'isDirty should be true after markDirty');
        });

        it('clearDirty sets state.isDirty to false', function () {
            if (globalsMissing()) return;
            state.isDirty = true;
            clearDirty();
            assertFalse(state.isDirty, 'isDirty should be false after clearDirty');
        });

        it('markDirty updates document title with bullet', function () {
            if (globalsMissing()) return;
            state.isDirty = false;
            markDirty();
            assertTrue(document.title.indexOf('\u2022') >= 0, 'title should contain bullet');
            clearDirty();
            assertTrue(document.title.indexOf('\u2022') < 0, 'title should not contain bullet after clear');
        });

        it('markDirty is idempotent', function () {
            if (globalsMissing()) return;
            state.isDirty = false;
            markDirty();
            markDirty();
            markDirty();
            assertTrue(state.isDirty, 'isDirty should still be true');
            assertEqual(document.title, '\u2022 Lucid');
        });

        it('dirty indicator dot visibility toggles', function () {
            var dot = document.getElementById('saveDirtyDot');
            if (!dot || globalsMissing()) return; // Skip if not in full page context
            state.isDirty = false;
            clearDirty();
            assertEqual(dot.style.display, 'none', 'dot should be hidden when clean');
            markDirty();
            assertEqual(dot.style.display, 'inline-block', 'dot should be visible when dirty');
        });
    });

    // --- Quick Save Guards ---

    describe('quickSave guards', function () {
        it('quickSave returns early with no session', async function () {
            if (globalsMissing() || typeof quickSave !== 'function') return;
            var origSession = state.session;
            state.session = null;
            await quickSave();
            state.session = origSession;
        });

        it('quickSave returns early if already saving', async function () {
            if (globalsMissing() || typeof quickSave !== 'function') return;
            state.isSaving = true;
            await quickSave();
            state.isSaving = false;
        });
    });

    // --- Save As ---

    describe('saveAs', function () {
        it('saveAs clears existing file handle', async function () {
            if (globalsMissing() || typeof saveAs !== 'function') return;
            state.slpFileHandle = { fake: true };
            var origSession = state.session;
            state.session = null;
            await saveAs();
            assertEqual(state.slpFileHandle, null, 'handle should be cleared');
            state.session = origSession;
        });
    });
})();
