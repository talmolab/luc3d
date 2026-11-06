/**
 * ui/compact-save-modal.js — the warning File ▸ Save Compact Copy shows before
 * anything is written (import-export/compact-save.js).
 *
 * Rounding is permanent in the copy, so the dialog says plainly what is rounded
 * and by how much, what is lost, what is not touched, and that the open project
 * stays as it is. Cancel has the focus; Esc and a backdrop click cancel too.
 *
 * The save picker must open INSIDE the click on the dialog's button (the browser
 * refuses it without that user activation), so the button opens it and the dialog
 * resolves with the chosen handle.
 *
 * A leaf: imports only the rounding steps.
 */

import { COMPACT_STEPS } from '../import-export/compact-save.js?v=f6f489b0283e';

/**
 * @param {{suggestedName?: string, startIn?: Object, pickFile?: function(Object): Promise<Object>}} [opts]
 *   `startIn`: where the picker opens (the recording's folder or the project file; see `saveStartFolder`).
 *   `pickFile` stands in for `window.showSaveFilePicker` (tests).
 * @returns {Promise<?Object>} the FileSystemFileHandle to write, or null (cancelled)
 */
export function showCompactSaveModal(opts) {
    opts = opts || {};
    if (document.querySelector('.compact-save-modal')) return Promise.resolve(null);
    var pick = opts.pickFile || function (o) { return window.showSaveFilePicker(o); };
    var xyMax = (COMPACT_STEPS.xy / 2).toFixed(4), p3dMax = (COMPACT_STEPS.p3d / 2).toFixed(4);

    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay';
        var modal = document.createElement('div');
        modal.className = 'multi-frame-modal compact-save-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'compactSaveTitle');

        var h = document.createElement('h3');
        h.id = 'compactSaveTitle';
        h.textContent = 'Save a compact copy';
        modal.appendChild(h);

        function para(text, cls) {
            var p = document.createElement('p');
            p.className = 'compact-save-text' + (cls ? ' ' + cls : '');
            p.textContent = text;
            modal.appendChild(p);
            return p;
        }
        para('This writes a smaller copy of the project by rounding numbers that are stored with more precision ' +
            'than tracking can deliver. The rounding is permanent in the copy:');
        var list = document.createElement('ul');
        list.className = 'compact-save-list';
        [
            'Predicted 2D keypoints: to 1/' + Math.round(1 / COMPACT_STEPS.xy) + ' pixel (each moves by at most ' + xyMax + ' px).',
            'Prediction scores: to 1/' + Math.round(1 / COMPACT_STEPS.score) + '.',
            '3D points: to 1/' + Math.round(1 / COMPACT_STEPS.p3d) + ' of the calibration unit, usually mm (at most ' + p3dMax + ' mm).',
            'Hand-placed (user) keypoints, identities, groups and settings are kept exactly.',
        ].forEach(function (t) {
            var li = document.createElement('li');
            li.textContent = t;
            list.appendChild(li);
        });
        modal.appendChild(list);
        para('What is lost: the exact numbers the model produced. A tool that compares poses by exact equality ' +
            '(for example, merging fresh predictions back into the project) may treat the rounded poses as different ones.',
            'compact-save-warning');
        para('The project you have open is not changed and stays linked to its current file. The copy is marked as ' +
            'rounded, and LUC3D says so whenever it is opened. Typically 40-45% smaller.');

        var errorEl = document.createElement('div');
        errorEl.className = 'modal-error';
        errorEl.id = 'compactSaveError';
        modal.appendChild(errorEl);

        var actions = document.createElement('div');
        actions.className = 'modal-actions';
        var cancelBtn = document.createElement('button');
        cancelBtn.id = 'compactSaveCancel';
        cancelBtn.textContent = 'Cancel';
        var saveBtn = document.createElement('button');
        saveBtn.id = 'compactSaveContinue';
        saveBtn.className = 'primary';
        saveBtn.textContent = 'Choose where to save…';
        actions.appendChild(cancelBtn);
        actions.appendChild(saveBtn);
        modal.appendChild(actions);
        overlay.appendChild(modal);

        var done = false;
        function finish(handle) {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(handle);
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
        }
        document.addEventListener('keydown', onKey, true);
        cancelBtn.addEventListener('click', function () { finish(null); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) finish(null); });
        saveBtn.addEventListener('click', function () {
            // Synchronously inside the click: the picker needs its user activation.
            var p;
            try {
                var pickOpts = { suggestedName: opts.suggestedName || 'project_compact.slp',
                    types: [{ description: 'SLEAP Labels', accept: { 'application/x-hdf5': ['.slp'] } }] };
                if (opts.startIn) pickOpts.startIn = opts.startIn;
                p = pick(pickOpts);
            } catch (e) { p = Promise.reject(e); }
            Promise.resolve(p).then(finish, function (e) {
                if (e && e.name === 'AbortError') return;   // picker closed: the dialog stays, to cancel or retry
                errorEl.textContent = 'Could not choose a file: ' + ((e && e.message) || e);
            });
        });

        document.body.appendChild(overlay);
        cancelBtn.focus();
    });
}
