/**
 * ui/track-range-modal.js — the "Track Frame Range" dialog (#212).
 *
 * The middle ground between Track Frame (this frame only) and Track All (the
 * whole video): pick a start/end frame, hit Continue, and the same loading
 * overlay Track All uses counts the range down. Its reason for existing is
 * iteration — re-running a narrow window around a known ID switch after
 * changing node weights / camera views / the 3D correspondence weight in the
 * Tracking Wizard, without paying for a full pass over a long recording.
 *
 * Collects the animal count too. `pose/tracker.js` otherwise asks for it with a
 * native `prompt()`, which would pop up ON TOP of this dialog the first time
 * anyone used it; here a blank field is an explicit "auto-detect" and the
 * prompt never fires.
 *
 * Depends on: pose/tracker.js (the run itself), ui/app-state.js, save-load.js.
 */

import { state, getActiveSession } from './app-state.js';
import { setStatus } from '../import-export/save-load.js';
import {
    trackFrameRange, trackableFrameBounds,
    getTrackerNumAnimals, setTrackerNumAnimals,
} from '../pose/tracker.js';

// Frames pre-filled into the End field, measured from the current frame. The
// feature is for narrow windows around a suspected switch, so the default is a
// window rather than "everything from here on".
var DEFAULT_RANGE_LENGTH = 100;

/**
 * Show the Track Frame Range dialog. Cancel / Esc close it with no side
 * effects; Continue / Enter validate the range and hand off to
 * `trackFrameRange`, which shows the Track All loading overlay.
 */
export function showTrackRangeModal() {
    var session = getActiveSession();
    if (!session || !session.cameras || session.cameras.length === 0) {
        setStatus('No session with cameras loaded', 'error');
        return;
    }
    var bounds = trackableFrameBounds(session);
    if (!bounds) {
        setStatus('No frames to track', 'error');
        return;
    }

    var cur = Math.min(Math.max(state.currentFrame || 0, bounds.min), bounds.max);
    var defStart = cur;
    var defEnd = Math.min(bounds.max, cur + DEFAULT_RANGE_LENGTH - 1);
    var animals = getTrackerNumAnimals();

    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal';
    modal.innerHTML =
        '<h3>Track Frame Range</h3>' +
        '<p>Assign identities across a contiguous span of frames. Tracking ' +
        'restarts at the first frame of the range and carries no history in ' +
        'from before it, so identities inside the range are assigned ' +
        'independently of the frames around it.</p>' +
        '<div class="track-range-fields">' +
        '<label class="track-range-field">' +
        '<span>Start frame</span>' +
        '<input type="number" id="trackRangeStart" step="1" min="' + bounds.min +
        '" max="' + bounds.max + '" value="' + defStart + '">' +
        '</label>' +
        '<label class="track-range-field">' +
        '<span>End frame</span>' +
        '<input type="number" id="trackRangeEnd" step="1" min="' + bounds.min +
        '" max="' + bounds.max + '" value="' + defEnd + '">' +
        '</label>' +
        '<label class="track-range-field">' +
        '<span>Animals</span>' +
        '<input type="number" id="trackRangeAnimals" step="1" min="1" ' +
        'placeholder="auto" value="' + (animals != null ? animals : '') + '">' +
        '</label>' +
        '</div>' +
        '<div class="track-range-summary" id="trackRangeSummary"></div>' +
        '<div class="modal-error" id="trackRangeError"></div>' +
        '<div class="modal-actions">' +
        '<button id="trackRangeCancel">Cancel</button>' +
        '<button class="primary" id="trackRangeContinue">Continue</button>' +
        '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);

    var startInput = modal.querySelector('#trackRangeStart');
    var endInput = modal.querySelector('#trackRangeEnd');
    var animalsInput = modal.querySelector('#trackRangeAnimals');
    var summaryEl = modal.querySelector('#trackRangeSummary');
    var errorEl = modal.querySelector('#trackRangeError');
    var continueBtn = modal.querySelector('#trackRangeContinue');

    // Parsed, validated form state. `error` non-null ⇒ Continue is disabled and
    // the message is shown inline; the dialog never closes on bad input.
    function readForm() {
        var s = parseInt(startInput.value, 10);
        var e = parseInt(endInput.value, 10);
        if (!isFinite(s) || !isFinite(e)) {
            return { error: 'Enter a start and end frame.' };
        }
        if (s < bounds.min || e < bounds.min || s > bounds.max || e > bounds.max) {
            return {
                error: 'Frames must be between ' + bounds.min.toLocaleString() +
                    ' and ' + bounds.max.toLocaleString() + '.',
            };
        }
        if (e < s) return { error: 'The end frame must not be before the start frame.' };
        var raw = animalsInput.value.trim();
        var n = null;
        if (raw !== '') {
            n = parseInt(raw, 10);
            if (!isFinite(n) || n < 1) return { error: 'Animals must be 1 or more, or blank for auto-detect.' };
        }
        return { start: s, end: e, animals: n, error: null };
    }

    function plural(n, word) {
        return n.toLocaleString() + ' ' + word + (n === 1 ? '' : 's');
    }

    function refresh() {
        var f = readForm();
        errorEl.textContent = f.error || '';
        continueBtn.disabled = !!f.error;
        summaryEl.textContent = f.error
            ? ''
            : plural(f.end - f.start + 1, 'frame') + ' · ' +
              (f.animals != null ? plural(f.animals, 'animal') : 'animal count auto-detected');
    }

    function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    }

    function proceed() {
        var f = readForm();
        if (f.error) { refresh(); return; }
        // A blank Animals field is an explicit auto-detect, so write it through
        // either way — otherwise clearing the field would silently keep the
        // previously-set count.
        setTrackerNumAnimals(f.animals);
        close();
        // Not awaited: trackFrameRange owns the loading overlay and reports its
        // own outcome through setStatus, exactly as the Track All button does.
        trackFrameRange(f.start, f.end);
    }

    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter') { e.preventDefault(); proceed(); }
    }
    document.addEventListener('keydown', onKey);

    [startInput, endInput, animalsInput].forEach(function (el) {
        el.addEventListener('input', refresh);
    });
    modal.querySelector('#trackRangeCancel').addEventListener('click', close);
    continueBtn.addEventListener('click', proceed);
    // Clicking the backdrop (not the dialog) dismisses, like the other modals.
    overlay.addEventListener('click', function (e) {
        if (e.target === overlay) close();
    });

    refresh();
    startInput.focus();
    startInput.select();
}
