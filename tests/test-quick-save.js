/**
 * test-quick-save.js - Tests for quick save (Ctrl+S) feature
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse } = TestFramework;

    // --- Dirty Flag ---

    describe('markDirty / clearDirty', function () {
        it('markDirty sets state.isDirty to true', function () {
            // Reset state
            state.isDirty = false;
            markDirty();
            assertTrue(state.isDirty, 'isDirty should be true after markDirty');
        });

        it('clearDirty sets state.isDirty to false', function () {
            state.isDirty = true;
            clearDirty();
            assertFalse(state.isDirty, 'isDirty should be false after clearDirty');
        });

        it('markDirty updates document title with bullet', function () {
            state.isDirty = false;
            markDirty();
            assertTrue(document.title.indexOf('\u2022') >= 0, 'title should contain bullet');
            clearDirty();
            assertTrue(document.title.indexOf('\u2022') < 0, 'title should not contain bullet after clear');
        });

        it('markDirty is idempotent', function () {
            state.isDirty = false;
            markDirty();
            markDirty();
            markDirty();
            assertTrue(state.isDirty, 'isDirty should still be true');
            assertEqual(document.title, '\u2022 Lucid');
        });

        it('dirty indicator dot visibility toggles', function () {
            var dot = document.getElementById('saveDirtyDot');
            if (!dot) return; // Skip if not in full page context
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
            var origSession = state.session;
            state.session = null;
            await quickSave();
            // Should not throw, just set error status
            state.session = origSession;
        });

        it('quickSave returns early if already saving', async function () {
            state.isSaving = true;
            await quickSave();
            // Should not throw
            state.isSaving = false;
        });
    });

    // --- Save As ---

    describe('saveAs', function () {
        it('saveAs clears existing file handle', async function () {
            state.slpFileHandle = { fake: true };
            // saveAs will clear the handle and then try quickSave
            // which will fail gracefully (no session or no picker)
            var origSession = state.session;
            state.session = null;
            await saveAs();
            assertEqual(state.slpFileHandle, null, 'handle should be cleared');
            state.session = origSession;
        });
    });
})();
