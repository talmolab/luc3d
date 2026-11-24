// ui/demo-entry.js — the ways into the demo project (`loading/demo-project.js`):
// File ▸ Open Demo (wired in `ui/ui-wiring.js`), the "Open the demo" button on the empty video dock, and
// `?demo` in the page's URL (luc3d.sleap.ai/?demo opens straight into it).
//
// The dock button is for a first visit: it shows only while nothing is
// loaded, so closing every video panel of a project does not offer it.

import { state } from './app-state.js?v=7690799bebe1';
import { loadDemoProject } from '../loading/demo-project.js?v=7690799bebe1';

/** Whether the page was opened with `?demo`. */
export function demoRequested(search) {
    try { return new URLSearchParams(search).has('demo'); } catch (e) { return false; }
}

/**
 * Wire the dock button; open the demo now if the URL asks. (The File menu
 * item is wired in `setupMenus`, next to the other File items.)
 */
export function setupDemoEntry() {
    var btn = document.getElementById('dockDemoBtn');
    var empty = document.getElementById('videoDockEmpty');
    if (btn) {
        btn.addEventListener('click', function () { loadDemoProject(); });
        var sync = function () { btn.hidden = !!(state.session || state.views.length > 0); };
        sync();
        if (empty && typeof MutationObserver !== 'undefined') {
            new MutationObserver(sync).observe(empty, { attributes: true, attributeFilter: ['class'] });
        }
    }

    if (demoRequested(location.search)) loadDemoProject();
}
