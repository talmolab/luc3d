// ui/volume-fusion-field.js — the Triangulate menu's "Fuse with volume" checkbox (`#tbVolumeFusion`), like its
// Reprojection error field (`ui/reproj-threshold-field.js`).
//
// It edits the browser-local volume-fusion setting (pose/volume3d.js `getVolumeSettings().enabled`), which every
// Triangulate run reads per frame (`volumeForFrame`). It is greyed out while the active session has no volume
// loaded (File ▸ Load Volume 3D); the setting itself is kept, so loading a volume later uses it.
// Refreshed when a volume is loaded (`lucid:volume3d-changed`) and whenever the menu is opened (the active
// session may have changed).
//
// Not in Defining Plane Mode's toolbar lock: it is a setting a run reads when it starts, not an action.

import { state } from './app-state.js?v=eedba7e8f497';
import { getVolumeSettings, setVolumeSettings, sessionVolume } from '../pose/volume3d.js?v=eedba7e8f497';
import { setStatus } from '../import-export/save-load.js?v=eedba7e8f497';

function refresh(input, label) {
    var v = sessionVolume(state.session);
    input.checked = !!getVolumeSettings().enabled;
    input.disabled = !v;
    if (label) {
        label.classList.toggle('disabled', !v);
        label.title = v
            ? 'Fuse with volume: Triangulate uses this session\'s volume (' + (v.data.fileName || 'loaded') +
              '): each camera\'s 2D point enters only near the volume\'s 3D point projected into that camera, ' +
              'then the result is weighted with the volume by their uncertainties. Uncheck for plain triangulation.'
            : 'Fuse with volume: load a volumetric model\'s output first (File ▸ Load Volume 3D).';
    }
}

/** Wire the checkbox. Called once from `setupUI` (`ui/ui-wiring.js`). */
export function wireVolumeFusionField() {
    var input = document.getElementById('tbVolumeFusion');
    if (!input) return;
    var label = input.closest('label');
    refresh(input, label);
    input.addEventListener('change', function () {
        setVolumeSettings({ enabled: input.checked });
        setStatus('Fuse with volume ' + (input.checked ? 'on' : 'off') + ': used by the next Triangulate', 'info');
    });
    document.addEventListener('lucid:volume3d-changed', function () { refresh(input, label); });
    var menu = document.getElementById('triangulateDropdown');
    if (menu) {
        menu.addEventListener('mouseenter', function () { refresh(input, label); });
        menu.addEventListener('focusin', function () { refresh(input, label); });
    }
}
