// ui/data-file-chooser.js — the "which data file does each camera load?"
// dialog (#413 / #414).
//
// Shown by the per-camera folder loaders (`loading/data-file-resolve.js`) when
// a camera folder holds files the loader will not choose between on its own —
// several `.slp` files none of which LUC3D exported, a LUC3D export with a
// newer SLEAP file beside it, a mix of `.slp` and `.h5` — or when a file saved
// for a camera last time is gone. One row per camera (its video, and a
// drop-down of that folder's data files plus "None"); a multi-session load
// gets one tab per session. "Save Options" returns the choices (the caller
// remembers them, `loading/data-file-choices.js`); Cancel or Esc abandons the
// load.
//
// The rule for which rows need the user, and the pre-selected default, live in
// the DOM-free `loading/percam-slp-choice.js` (`planCameraDataFile`); this
// module only draws what it is handed.

/** A short label for a data file's kind, for the drop-down. */
export function dataFileKindLabel(option) {
    switch (option.kind) {
        case 'lucid-export': {
            // Local time: the user compares it with when they exported.
            var t = option.exportedAt;
            var when = '';
            if (typeof t === 'number' && isFinite(t)) {
                var d = new Date(t);
                var p2 = function (n) { return (n < 10 ? '0' : '') + n; };
                when = ', ' + d.getFullYear() + '-' + p2(d.getMonth() + 1) + '-' + p2(d.getDate())
                    + ' ' + p2(d.getHours()) + ':' + p2(d.getMinutes());
            }
            return 'LUC3D export' + when;
        }
        case 'proofread': return 'proofread';
        case 'predictions': return 'predictions';
        case 'analysis-h5': return 'analysis .h5';
        case 'reprojections': return 'reprojections';
        case 'derived': return 'copy of ' + option.derivedFrom;
        default: return 'SLEAP file';
    }
}

function esc(v) {
    return String(v).replace(/&/g, '&amp;').replace(/</g, '&lt;')
        .replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Show the chooser.
 *
 * @param {Array<{key: string, title: string, rows: Array<{
 *     camName: string, videoName: string|null,
 *     options: Array<{value: string, label: string}>, value: string,
 *     attention: boolean, missingName: string|null}>}>} sessions
 *   `value` is the pre-selected option (`''` = None); `attention` marks a row
 *   the loader would not decide on its own; `missingName` is a saved file that
 *   is no longer in the folder (the row is drawn in red).
 * @returns {Promise<Object|null>} `{ [sessionKey]: { [camName]: value } }` on
 *   Save Options; null on Cancel / Esc.
 */
export function showDataFileChooser(sessions) {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay data-file-chooser-overlay';
        var modal = document.createElement('div');
        modal.className = 'multi-frame-modal data-file-chooser';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'dfcTitle');

        var firstAttention = 0;
        for (var fa = 0; fa < sessions.length; fa++) {
            if (sessions[fa].rows.some(function (r) { return r.attention || r.missingName; })) { firstAttention = fa; break; }
        }

        var html = '<h3 id="dfcTitle">Choose data files</h3>'
            + '<p class="dfc-note">Some camera folders hold more than one data file. Choose the one each camera loads.</p>';
        if (sessions.length > 1) {
            html += '<div class="dfc-tabs" role="tablist">';
            sessions.forEach(function (s, i) {
                var needs = s.rows.some(function (r) { return r.attention || r.missingName; });
                html += '<button type="button" class="dfc-tab' + (i === firstAttention ? ' active' : '') + '"'
                    + ' role="tab" data-tab="' + i + '" aria-selected="' + (i === firstAttention) + '">'
                    + esc(s.title) + (needs ? ' <span class="dfc-dot" aria-label="needs a choice"></span>' : '')
                    + '</button>';
            });
            html += '</div>';
        }
        sessions.forEach(function (s, i) {
            html += '<div class="dfc-panel" data-panel="' + i + '"' + (i === firstAttention ? '' : ' hidden') + '>'
                + '<table class="data-table dfc-table"><thead><tr>'
                + '<th>Camera</th><th>Video</th><th>Data file</th></tr></thead><tbody>';
            s.rows.forEach(function (r, ri) {
                var cls = r.missingName ? ' class="dfc-missing"' : (r.attention ? ' class="dfc-attention"' : '');
                html += '<tr' + cls + '>'
                    + '<td class="dfc-cam">' + esc(r.camName) + '</td>'
                    + '<td class="dfc-video" title="' + esc(r.videoName || '') + '">' + esc(r.videoName || '—') + '</td>'
                    + '<td class="dfc-file"><select class="dfc-select" data-session="' + i + '" data-row="' + ri + '" aria-label="'
                    + esc('Data file for ' + r.camName) + '">';
                r.options.forEach(function (o) {
                    html += '<option value="' + esc(o.value) + '"' + (o.value === r.value ? ' selected' : '')
                        + '>' + esc(o.label) + '</option>';
                });
                html += '<option value=""' + (r.value === '' ? ' selected' : '') + '>None (no annotations)</option>'
                    + '</select>'
                    + (r.missingName ? '<div class="dfc-missing-note">Saved file not found: ' + esc(r.missingName) + '</div>' : '')
                    + '</td></tr>';
            });
            html += '</tbody></table></div>';
        });
        html += '<div class="modal-actions">'
            + '<button type="button" id="dfcCancel">Cancel</button>'
            + '<button type="button" class="primary" id="dfcSave">Save Options</button>'
            + '</div>';
        modal.innerHTML = html;
        overlay.appendChild(modal);
        document.body.appendChild(overlay);

        // A clipped drop-down keeps its whole label in the tooltip.
        modal.querySelectorAll('.dfc-select').forEach(function (sel) {
            var sync = function () {
                var o = sel.options[sel.selectedIndex];
                sel.title = o ? o.textContent : '';
            };
            sync();
            sel.addEventListener('change', sync);
        });

        modal.querySelectorAll('.dfc-tab').forEach(function (tab) {
            tab.addEventListener('click', function () {
                var idx = tab.getAttribute('data-tab');
                modal.querySelectorAll('.dfc-tab').forEach(function (t) {
                    var on = t === tab;
                    t.classList.toggle('active', on);
                    t.setAttribute('aria-selected', String(on));
                });
                modal.querySelectorAll('.dfc-panel').forEach(function (p) {
                    p.hidden = p.getAttribute('data-panel') !== idx;
                });
            });
        });

        function close(result) {
            document.removeEventListener('keydown', onKeydown, true);
            overlay.remove();
            resolve(result);
        }
        function onKeydown(e) {
            if (e.key !== 'Escape') return;
            e.preventDefault();
            e.stopPropagation();
            close(null);
        }
        document.addEventListener('keydown', onKeydown, true);
        modal.querySelector('#dfcCancel').addEventListener('click', function () { close(null); });
        modal.querySelector('#dfcSave').addEventListener('click', function () {
            var out = {};
            sessions.forEach(function (s) { out[s.key] = {}; });
            modal.querySelectorAll('.dfc-select').forEach(function (sel) {
                var s = sessions[Number(sel.getAttribute('data-session'))];
                var r = s.rows[Number(sel.getAttribute('data-row'))];
                out[s.key][r.camName] = sel.value;
            });
            close(out);
        });
        var firstSelect = modal.querySelector('.dfc-panel:not([hidden]) tr.dfc-missing .dfc-select, .dfc-panel:not([hidden]) tr.dfc-attention .dfc-select')
            || modal.querySelector('#dfcSave');
        if (firstSelect) firstSelect.focus();
    });
}
