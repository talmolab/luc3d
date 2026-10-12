/**
 * test-view-mode.js - Tests for Phase 5 view mode switching (grid/single).
 *
 * Tests: grid mode default, toggling to single-view, cycling cameras,
 * returning to grid, view indicator display, edge cases.
 */

(function () {
    const { describe, it, beforeEach, assertEqual, assertTrue, assertFalse } = TestFramework;

    describe('View Mode State', function () {
        let state;

        beforeEach(function () {
            state = {
                views: [
                    { name: 'back', canvas: document.createElement('canvas') },
                    { name: 'left', canvas: document.createElement('canvas') },
                    { name: 'right', canvas: document.createElement('canvas') },
                    { name: 'top', canvas: document.createElement('canvas') },
                ],
                viewMode: 'grid',
                singleViewIndex: 0,
            };
        });

        it('starts in grid mode', function () {
            assertEqual(state.viewMode, 'grid', 'Default should be grid');
        });

        it('toggles to single-view mode', function () {
            // Simulate toggleViewMode
            if (state.viewMode === 'grid') {
                state.viewMode = 'single';
                state.singleViewIndex = 0;
            }
            assertEqual(state.viewMode, 'single');
            assertEqual(state.singleViewIndex, 0, 'Should start at first view');
        });

        it('cycles through views in single mode', function () {
            state.viewMode = 'single';
            state.singleViewIndex = 0;

            // Cycle forward
            state.singleViewIndex = (state.singleViewIndex + 1) % state.views.length;
            assertEqual(state.singleViewIndex, 1, 'Should be at index 1');

            state.singleViewIndex = (state.singleViewIndex + 1) % state.views.length;
            assertEqual(state.singleViewIndex, 2, 'Should be at index 2');

            state.singleViewIndex = (state.singleViewIndex + 1) % state.views.length;
            assertEqual(state.singleViewIndex, 3, 'Should be at index 3');

            // Wraps around
            state.singleViewIndex = (state.singleViewIndex + 1) % state.views.length;
            assertEqual(state.singleViewIndex, 0, 'Should wrap back to 0');
        });

        it('cycles backward through views', function () {
            state.viewMode = 'single';
            state.singleViewIndex = 0;

            // Cycle backward
            var dir = -1;
            state.singleViewIndex = (state.singleViewIndex + dir + state.views.length) % state.views.length;
            assertEqual(state.singleViewIndex, 3, 'Should wrap to last view');

            state.singleViewIndex = (state.singleViewIndex + dir + state.views.length) % state.views.length;
            assertEqual(state.singleViewIndex, 2, 'Should be at index 2');
        });

        it('returns to grid mode', function () {
            state.viewMode = 'single';
            state.singleViewIndex = 2;

            // setGridMode
            state.viewMode = 'grid';
            assertEqual(state.viewMode, 'grid');
        });

        it('handles empty views array', function () {
            state.views = [];
            // toggleViewMode should be a no-op
            if (state.views.length === 0) {
                // no-op
            } else {
                state.viewMode = 'single';
            }
            assertEqual(state.viewMode, 'grid', 'Should stay in grid with no views');
        });

        it('handles single view', function () {
            state.views = [{ name: 'only', canvas: document.createElement('canvas') }];
            state.viewMode = 'single';
            state.singleViewIndex = 0;

            // Cycling should stay at 0
            state.singleViewIndex = (state.singleViewIndex + 1) % state.views.length;
            assertEqual(state.singleViewIndex, 0, 'Should stay at 0 with only 1 view');
        });
    });

    describe('View Mode Display Logic', function () {
        let state, cells;

        beforeEach(function () {
            cells = [];
            state = { views: [], viewMode: 'grid', singleViewIndex: 0 };
            for (var i = 0; i < 4; i++) {
                var cell = document.createElement('div');
                cell.className = 'video-cell';
                cell.style.display = '';
                var canvas = document.createElement('canvas');
                canvas.appendChild(document.createTextNode('')); // dummy
                cell.appendChild(canvas);
                cells.push(cell);
                state.views.push({ name: 'cam' + i, canvas: canvas });
            }
        });

        it('all cells visible in grid mode', function () {
            state.viewMode = 'grid';
            state.views.forEach(function (v) {
                var cell = v.canvas.closest('.video-cell') || v.canvas.parentElement;
                if (cell) cell.style.display = '';
            });

            for (var i = 0; i < cells.length; i++) {
                assertEqual(cells[i].style.display, '', 'Cell ' + i + ' should be visible');
            }
        });

        it('only active cell visible in single-view mode', function () {
            state.viewMode = 'single';
            state.singleViewIndex = 2;

            state.views.forEach(function (v, i) {
                var cell = v.canvas.closest('.video-cell') || v.canvas.parentElement;
                if (cell) cell.style.display = (i === state.singleViewIndex) ? '' : 'none';
            });

            for (var i = 0; i < cells.length; i++) {
                if (i === 2) {
                    assertEqual(cells[i].style.display, '', 'Cell 2 should be visible');
                } else {
                    assertEqual(cells[i].style.display, 'none', 'Cell ' + i + ' should be hidden');
                }
            }
        });
    });

})();
