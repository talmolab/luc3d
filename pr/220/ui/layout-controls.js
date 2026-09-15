// ui/layout-controls.js — Pass 3e-2 extraction
//
// Owns the resizable split-handle bar between the video grid, the 3D
// viewport, the info panel, and the timeline. Each handle wires a
// mousedown drag interaction (via setupDragHandle) and updates layout
// CSS based on cursor delta.

import { viewport3d, timeline } from './app-state.js';
import { syncTimelineToggleButton, updateInfoPanelToggleBtn, toggleInfoPanel } from './ui-wiring.js';


// ============================================
// Split Handles
// ============================================

export function setupDragHandle(handle, onDrag) {
    handle.addEventListener('mousedown', function (e) {
        e.preventDefault();
        var startX = e.clientX;
        handle.classList.add('dragging');

        // Create ghost line
        var ghost = document.createElement('div');
        ghost.className = 'split-ghost-line';
        ghost.style.left = e.clientX + 'px';
        ghost.style.top = '0';
        ghost.style.height = '100vh';
        document.body.appendChild(ghost);

        function onMouseMove(ev) {
            ghost.style.left = ev.clientX + 'px';
        }

        function onMouseUp(ev) {
            handle.classList.remove('dragging');
            ghost.remove();
            document.removeEventListener('mousemove', onMouseMove);
            document.removeEventListener('mouseup', onMouseUp);
            var totalDeltaX = ev.clientX - startX;
            onDrag(totalDeltaX);
        }

        document.addEventListener('mousemove', onMouseMove);
        document.addEventListener('mouseup', onMouseUp);
    });
}

export function setupSplitHandles() {
    var viewport3dEl = document.getElementById('viewport3dContainer');
    var handle1 = document.getElementById('splitHandle1');
    var handle2 = document.getElementById('splitHandle2');

    setupDragHandle(handle1, function (totalDeltaX) {
        if (viewport3dEl.classList.contains('collapsed')) return;
        var currentWidth = viewport3dEl.offsetWidth;
        var newWidth = Math.max(150, currentWidth - totalDeltaX);
        viewport3dEl.style.width = newWidth + 'px';
        if (viewport3d) {
            setTimeout(function () { viewport3d.resize(); }, 0);
        }
    });

    setupDragHandle(handle2, function (totalDeltaX) {
        var wrapperEl = document.getElementById('infoPanelWrapper');
        if (wrapperEl.classList.contains('collapsed')) return;
        var panelEl = document.getElementById('infoPanel');
        var currentWidth = panelEl.offsetWidth;
        var newWidth = Math.max(200, currentWidth - totalDeltaX);
        panelEl.style.width = newWidth + 'px';
        panelEl.style.minWidth = newWidth + 'px';
    });

    // Timeline resize handle (vertical drag).
    // Dragging the top edge resizes the timeline. Dragging it below
    // a small snap threshold fully hides the timeline (equivalent
    // to clicking the Timeline toolbar button).
    var timelineHandle = document.getElementById('timelineResizeHandle');
    var timelineEl = document.getElementById('timelineContainer');
    if (timelineHandle && timelineEl) {
        timelineHandle.addEventListener('mousedown', function (e) {
            e.preventDefault();
            var startY = e.clientY;
            var wasCollapsed = timelineEl.classList.contains('collapsed');
            // When starting from collapsed, treat current height as 0
            // so pulling the handle up immediately grows the timeline.
            var startH = wasCollapsed ? 0 : timelineEl.offsetHeight;
            timelineHandle.classList.add('dragging');

            var COLLAPSE_SNAP = 20;
            var MIN_H = 40;
            var MAX_H = 600;

            function onMove(ev) {
                var delta = startY - ev.clientY;
                var target = startH + delta;
                if (target < COLLAPSE_SNAP) {
                    // Snap to fully hidden.
                    timelineEl.classList.add('collapsed');
                    timelineEl.style.height = '';
                } else {
                    timelineEl.classList.remove('collapsed');
                    var newH = Math.max(MIN_H, Math.min(MAX_H, target));
                    timelineEl.style.height = newH + 'px';
                }
                if (timeline) timeline.resize();
                syncTimelineToggleButton();
            }
            function onUp() {
                timelineHandle.classList.remove('dragging');
                document.removeEventListener('mousemove', onMove);
                document.removeEventListener('mouseup', onUp);
            }
            document.addEventListener('mousemove', onMove);
            document.addEventListener('mouseup', onUp);
        });
    }

    var infoPanelWrapper = document.getElementById('infoPanelWrapper');

    function updateHandleVisibility() {
        var vpCollapsed = viewport3dEl.classList.contains('collapsed');
        var wrapperCollapsed = infoPanelWrapper.classList.contains('collapsed');
        handle1.classList.toggle('hidden', vpCollapsed);
        handle2.classList.toggle('hidden', wrapperCollapsed);
        updateInfoPanelToggleBtn();
    }

    var observer = new MutationObserver(updateHandleVisibility);
    observer.observe(viewport3dEl, { attributes: true, attributeFilter: ['class'] });
    observer.observe(infoPanelWrapper, { attributes: true, attributeFilter: ['class'] });
    updateHandleVisibility();

    // Wire up the toggle button
    document.getElementById('infoPanelToggleBtn').addEventListener('click', toggleInfoPanel);
}
