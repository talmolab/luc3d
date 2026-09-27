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

/*
 * ---------------------------------------------------------------------------
 * Frame numbering: 0-based inside, 1-based on screen
 * ---------------------------------------------------------------------------
 * Every frame number LUCID shows the user is 1-based — the `#currentFrame`
 * readout is `frameIdx + 1`, so are the copy/paste status lines, and Export
 * Video Overlays' range modal does the same `+ 1` on its inputs. Every index
 * it stores is 0-based.
 *
 * This modal originally showed raw indices, so it was the one dialog in the
 * app disagreeing with the transport by one: the toolbar said frame 683 and
 * this said 682.
 *
 * Both conversions live here, and the rule for the rest of the file is: the
 * number inputs and the endpoint labels hold DISPLAY values, everything else
 * (the range sliders, `bounds`, whatever goes to `trackFrameRange`) holds
 * indices. `readForm` is the single crossing point.
 */
function toDisplay(frameIdx) { return frameIdx + 1; }
function toIndex(displayValue) { return displayValue - 1; }

/**
 * Show the Track Frame Range dialog. Cancel / Esc close it with no side
 * effects; Continue / Enter validate the range and hand off to
 * `trackFrameRange`, which shows the Track All loading overlay.
 *
 * @param {{onTracked?: (frameIdx:number)=>void}} [opts]
 *   `onTracked` is called with the LAST frame tracked once a run succeeds, so
 *   the viewer can be parked on the run's own result. It is injected rather
 *   than imported: the navigator lives in `pose/initialization.js`, which
 *   imports `ui/ui-wiring.js`, which imports this module — importing it here
 *   would close that loop. `ui-wiring.js` already holds both ends, so it passes
 *   `navigateToFrame` in and this module stays a leaf.
 */
export function showTrackRangeModal(opts) {
    var onTracked = (opts && opts.onTracked) || null;
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
        // Dual slider, mirroring Export Video Overlays' "Choose Frames for
        // Triangulation" (`.range-slider-container`, ui/export-modals.js). Two
        // stacked <input type=range> with pointer-events only on the thumbs,
        // over a shared track plus a fill div spanning the selection.
        '<div class="range-slider-container">' +
        '  <div class="range-slider-track"></div>' +
        '  <div class="range-slider-fill" id="trackRangeFill"></div>' +
        '  <input type="range" id="trackRangeSliderStart" min="' + bounds.min +
        '" max="' + bounds.max + '" value="' + defStart + '">' +
        '  <input type="range" id="trackRangeSliderEnd" min="' + bounds.min +
        '" max="' + bounds.max + '" value="' + defEnd + '">' +
        '</div>' +
        '<div class="track-range-bounds">' +
        '  <span>' + toDisplay(bounds.min).toLocaleString() + '</span>' +
        '  <span>' + toDisplay(bounds.max).toLocaleString() + '</span>' +
        '</div>' +
        '<div class="track-range-fields">' +
        '<label class="track-range-field">' +
        '<span>Start frame</span>' +
        '<input type="number" id="trackRangeStart" step="1" min="' + toDisplay(bounds.min) +
        '" max="' + toDisplay(bounds.max) + '" value="' + toDisplay(defStart) + '">' +
        '</label>' +
        '<label class="track-range-field">' +
        '<span>End frame</span>' +
        '<input type="number" id="trackRangeEnd" step="1" min="' + toDisplay(bounds.min) +
        '" max="' + toDisplay(bounds.max) + '" value="' + toDisplay(defEnd) + '">' +
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
    var sliderStart = modal.querySelector('#trackRangeSliderStart');
    var sliderEnd = modal.querySelector('#trackRangeSliderEnd');
    var sliderFill = modal.querySelector('#trackRangeFill');

    // Parsed, validated form state. `error` non-null ⇒ Continue is disabled and
    // the message is shown inline; the dialog never closes on bad input.
    //
    // THE display→index crossing point: the fields hold 1-based numbers, and
    // `start`/`end` come back as 0-based indices ready for `trackFrameRange`.
    function readForm() {
        var s = toIndex(parseInt(startInput.value, 10));
        var e = toIndex(parseInt(endInput.value, 10));
        if (!isFinite(s) || !isFinite(e)) {
            return { error: 'Enter a start and end frame.' };
        }
        if (s < bounds.min || e < bounds.min || s > bounds.max || e > bounds.max) {
            return {
                error: 'Frames must be between ' + toDisplay(bounds.min).toLocaleString() +
                    ' and ' + toDisplay(bounds.max).toLocaleString() + '.',
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

    // Paint the fill bar between the two thumbs. Percentages are taken across
    // [bounds.min, bounds.max], NOT [0, max]: a session's first frame is not
    // always 0 (a sparse non-lazy project starts wherever its first labelled
    // frame is), and assuming 0 would misplace the bar on exactly those.
    function updateSliderFill() {
        var span = bounds.max - bounds.min;
        var lo = parseInt(sliderStart.value, 10);
        var hi = parseInt(sliderEnd.value, 10);
        var leftPct = span > 0 ? ((lo - bounds.min) / span) * 100 : 0;
        var rightPct = span > 0 ? ((hi - bounds.min) / span) * 100 : 100;
        sliderFill.style.left = leftPct + '%';
        sliderFill.style.width = Math.max(0, rightPct - leftPct) + '%';
    }

    function refresh() {
        var f = readForm();
        errorEl.textContent = f.error || '';
        continueBtn.disabled = !!f.error;
        summaryEl.textContent = f.error
            ? ''
            : plural(f.end - f.start + 1, 'frame') + ' · ' +
              (f.animals != null ? plural(f.animals, 'animal') : 'animal count auto-detected');
        updateSliderFill();
    }

    // Slider -> number fields. The two thumbs share one track, so a drag can
    // carry one past the other. Each thumb STOPS at the other instead: the
    // start thumb cannot go beyond the current end, and vice versa. (It used
    // to push the other thumb along, which silently moved an endpoint the user
    // had already set — dragging start rightwards would drag end with it and
    // quietly extend the range past where they had placed it.)
    function onSliderInput(which) {
        var lo = parseInt(sliderStart.value, 10);
        var hi = parseInt(sliderEnd.value, 10);
        if (lo > hi) {
            if (which === 'start') sliderStart.value = hi; else sliderEnd.value = lo;
        }
        startInput.value = toDisplay(parseInt(sliderStart.value, 10));
        endInput.value = toDisplay(parseInt(sliderEnd.value, 10));
        refresh();
    }

    // Number fields -> slider. Typed values can be anything, so clamp to the
    // session extent before they reach the slider (an out-of-range value would
    // be silently clamped by the range input and the two would disagree).
    function syncSlidersFromInputs() {
        var f = readForm();
        if (f.error) { refresh(); return; }
        sliderStart.value = Math.min(Math.max(f.start, bounds.min), bounds.max);
        sliderEnd.value = Math.min(Math.max(f.end, bounds.min), bounds.max);
        refresh();
    }

    function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    }

    async function proceed() {
        var f = readForm();
        if (f.error) { refresh(); return; }
        // A blank Animals field is an explicit auto-detect, so write it through
        // either way — otherwise clearing the field would silently keep the
        // previously-set count.
        setTrackerNumAnimals(f.animals);
        close();
        // trackFrameRange owns the loading overlay and reports its own outcome
        // through setStatus, exactly as the Track All button does.
        var res = await trackFrameRange(f.start, f.end);
        // Park the viewer on the LAST frame tracked, so the run ends looking at
        // its own result instead of wherever the user happened to be. Uses the
        // range the tracker reports rather than `f.end`, since the request is
        // clamped to the project extent and reversed input is normalized — the
        // frame actually reached is not always the one that was typed. Skipped
        // when the run bailed, so a failed range leaves the viewer put.
        if (res && res.ok && res.end != null && onTracked) onTracked(res.end);
    }

    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); close(); }
        else if (e.key === 'Enter') { e.preventDefault(); proceed(); }
    }
    document.addEventListener('keydown', onKey);

    animalsInput.addEventListener('input', refresh);
    [startInput, endInput].forEach(function (el) {
        el.addEventListener('input', syncSlidersFromInputs);
    });
    sliderStart.addEventListener('input', function () { onSliderInput('start'); });
    sliderEnd.addEventListener('input', function () { onSliderInput('end'); });
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
