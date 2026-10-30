// ui/video-codec-notice.js — tell the user, in a note they can't miss, why a
// project's videos won't play in this browser and what to change.
//
// The loaders already put the codec diagnosis (loading/video-codec-diagnosis.js)
// in the status line, but on an 8-camera project that line is long and runs off
// the window, so the cause and the fix were cut off. Measured case: H.265
// recordings in Chrome on a Windows virtual machine with no GPU. The poses
// loaded, every view stayed black, and the status line's advice ("open the
// project in Chrome") was the browser already in use.
//
// It opens only for a diagnosis that carries `steps` (the H.265 kinds today), so
// a corrupt file or an undiagnosed failure keeps the status line alone. One note
// per load, for the first such diagnosis; the other files with the same kind are
// counted, not repeated. One dismiss button, Esc closes it, and it changes
// nothing. It waits for any other modal (skeleton import, calibration notice) to
// close rather than stacking on top of it.

var OVERLAY_ID = 'videoCodecNoticeOverlay';

function plural(count, word) {
    return count.toLocaleString('en-US') + ' ' + word + (count === 1 ? '' : 's');
}

/** A short list of names that does not run off the modal. */
function names(list, cap) {
    if (list.length <= cap) return list.join(', ');
    return list.slice(0, cap).join(', ') + ' and ' + (list.length - cap).toLocaleString('en-US') + ' more';
}

/** A step's text, with the ffmpeg command (if it holds it) as code. */
function stepItem(text, command) {
    var li = document.createElement('li');
    var at = command ? text.indexOf(command) : -1;
    if (at < 0) {
        li.textContent = text;
        return li;
    }
    li.appendChild(document.createTextNode(text.slice(0, at)));
    var code = document.createElement('code');
    code.className = 'video-codec-notice-command';
    code.textContent = command;
    li.appendChild(code);
    var rest = text.slice(at + command.length);
    if (rest) li.appendChild(document.createTextNode(rest));
    return li;
}

/**
 * Show the note for one diagnosis.
 * @param {{title: string, why: string, steps: string[], command?: string}} diag
 * @param {string[]} fileNames - the videos it applies to
 * @param {number} [totalVideos] - videos in the load, for "N of M"
 * @returns {HTMLElement} the overlay
 */
export function showVideoCodecNotice(diag, fileNames, totalVideos) {
    var overlay = document.createElement('div');
    overlay.className = 'plane-confirm-overlay';
    overlay.id = OVERLAY_ID;

    var modal = document.createElement('div');
    modal.className = 'plane-confirm-modal video-codec-notice-modal';

    var h = document.createElement('h3');
    h.textContent = diag.title;
    modal.appendChild(h);

    var files = document.createElement('div');
    files.className = 'origin-rebase-block-note';
    files.id = 'videoCodecNoticeFiles';
    var n = fileNames.length;
    files.textContent = (totalVideos && totalVideos > n
        ? n.toLocaleString('en-US') + ' of ' + plural(totalVideos, 'video')
        : plural(n, 'video')) + ' could not be played: ' + names(fileNames, 4) + '.';
    modal.appendChild(files);

    var why = document.createElement('p');
    why.id = 'videoCodecNoticeWhy';
    why.textContent = diag.why;
    modal.appendChild(why);

    var stepsTitle = document.createElement('div');
    stepsTitle.className = 'origin-rebase-block-title';
    stepsTitle.textContent = 'What to change';
    modal.appendChild(stepsTitle);
    var ol = document.createElement('ol');
    ol.id = 'videoCodecNoticeSteps';
    ol.className = 'video-codec-notice-steps';
    // The example command names the first file; the steps say "the videos".
    diag.steps.forEach(function (s) { ol.appendChild(stepItem(s, diag.command)); });
    modal.appendChild(ol);

    var actions = document.createElement('div');
    actions.className = 'modal-actions';
    function close() {
        document.removeEventListener('keydown', onKey, true);
        if (overlay.parentNode) overlay.remove();
    }
    function onKey(e) {
        if (e.key !== 'Escape') return;
        e.preventDefault();
        e.stopPropagation();
        close();
    }
    var ok = document.createElement('button');
    ok.id = 'btnVideoCodecNoticeOk';
    ok.className = 'primary';
    ok.textContent = 'Got it';
    ok.addEventListener('click', close);
    actions.appendChild(ok);
    modal.appendChild(actions);

    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    document.addEventListener('keydown', onKey, true);
    return overlay;
}

/** Run `fn` once no other modal overlay is open. */
function whenNoOtherModal(fn) {
    function busy() {
        // Every dialog here is a body-level overlay (`.plane-confirm-overlay`,
        // `.multi-frame-modal-overlay`, …), plus the static loading overlay.
        // getClientRects, not offsetParent: a position:fixed element has none.
        return Array.prototype.some.call(
            document.querySelectorAll('.plane-confirm-overlay, [class*="modal-overlay"], .loading-overlay'),
            function (el) { return el.id !== OVERLAY_ID && el.getClientRects().length > 0; });
    }
    if (!busy()) { fn(); return; }
    var obs = new MutationObserver(function () {
        if (busy()) return;
        obs.disconnect();
        fn();
    });
    obs.observe(document.body, { childList: true, subtree: true, attributes: true, attributeFilter: ['style', 'class'] });
}

/**
 * After a load: if any video failed with a diagnosis that says what to change,
 * show the note. Call it where the loader reports its failures.
 *
 * @param {Array<{name: string, error: any}>} failures - the failed videos
 * @param {number} [totalVideos] - videos the load tried
 * @returns {Object|null} the diagnosis shown (or queued), else null
 */
export function noteUnplayableVideos(failures, totalVideos) {
    try {
        var first = null;
        (failures || []).forEach(function (f) {
            var d = f && f.error && f.error.codecDiagnosis;
            if (!first && d && d.steps && d.steps.length) first = d;
        });
        if (!first) return null;
        var same = failures.filter(function (f) {
            var d = f && f.error && f.error.codecDiagnosis;
            return d && d.kind === first.kind;
        }).map(function (f) { return String(f.name || '').replace(/^.*[\/\\]/, ''); });
        if (document.getElementById(OVERLAY_ID)) return first;   // one note at a time
        console.warn('[video-codec-notice] ' + first.kind + ': ' + same.length + ' video(s)');
        whenNoOtherModal(function () {
            if (!document.getElementById(OVERLAY_ID)) showVideoCodecNotice(first, same, totalVideos);
        });
        return first;
    } catch (e) {
        // A load must never fail because of a note that only gives advice.
        console.warn('[video-codec-notice] failed:', e);
        return null;
    }
}
