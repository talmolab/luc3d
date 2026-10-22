// ui/seekbar-markers.js — possible-ID-switch ticks on the transport seekbar
// (Tracks ▸ Check ID Switches; the ID Switches tab lists the same change points).
//
// One tick per marker at its frame, on the same frame -> position mapping the
// seekbar's thumb uses (`frame / (totalFrames - 1)`): amber for the body-size
// check, cyan for images, violet for coat brightness, both colours for a change
// point two checks found ("Both" — drawn once, on the earlier check's marker:
// size, then images, then brightness); a follow-on is fainter, a
// still-swapped repeat a short faint tick, and one ticked "reviewed" in the tab
// is dimmed. The ticks never take the pointer: the seekbar's own handlers stay
// in charge, and `seekbarMarkerAt` lets them snap a click / the hover tooltip to
// the tick under the cursor so the frame shown is the frame a click seeks to.
//
// Dependency-free (imports NO project modules), like ui/seekbar-tooltip.js:
// ui/ui-wiring.js installs it on `#seekbarMarks` and keeps the frame count in
// step; ui/id-switch-modal.js sets the markers for the active session.

var _layer = null;        // #seekbarMarks
var _markers = [];        // sorted by frame
var _total = 0;           // the session's frame count the ticks are laid out for

/** Attach to the seekbar's marker layer element (`#seekbarMarks`). */
export function installSeekbarMarkers(layerEl, totalFrames) {
    _layer = layerEl || null;
    if (totalFrames > 0) _total = totalFrames;
    render();
}

/**
 * Show possible-switch markers (`[]` clears): `[{frame, nameA, nameB, score, cue?,
 * agree?, continues?, followOf?, kind?, reviewed?}]` — the shapes
 * pose/id-switch-check.js returns, tagged by ui/id-switch-review.js.
 */
export function setSeekbarSwitchMarkers(markers, totalFrames) {
    _markers = (markers || []).slice().sort(function (a, b) { return a.frame - b.frame; });
    if (totalFrames > 0) _total = totalFrames;
    render();
}

/** @returns {Array} the markers currently shown (a copy). */
export function getSeekbarSwitchMarkers() {
    return _markers.slice();
}

/** Keep the ticks in step with the frame count (cheap when unchanged; called with every seekbar update). */
export function setSeekbarMarkerFrames(totalFrames) {
    if (totalFrames > 0 && totalFrames !== _total) { _total = totalFrames; render(); }
}

var CUES = ['size', 'image', 'brightness'];   // precedence, as ui/id-switch-review.js ID_SWITCH_CUES
var CUE_NAME = { size: 'size', image: 'image', brightness: 'brightness' };
function cueOf(m) { return CUES.indexOf(m.cue) >= 0 ? m.cue : 'size'; }

/** A "Both" pair is drawn once, on the earlier check's marker. */
function drawn(m) { return !(m.agree && CUES.indexOf(cueOf(m)) > CUES.indexOf(cueOf(m.agree))); }

function fraction(frame) { return _total > 1 ? frame / (_total - 1) : 0; }

/**
 * The marker nearest a point on the bar, within `tolPx` pixels, or null. A change
 * point beats a repeat at the same distance.
 * @param {number} frac  0..1 along the bar
 * @param {number} widthPx  the bar's width
 */
export function seekbarMarkerAt(frac, widthPx, tolPx) {
    if (!_markers.length || !(widthPx > 0) || !(_total > 1)) return null;
    var tol = tolPx == null ? 5 : tolPx, best = null, bestD = Infinity;
    for (var i = 0; i < _markers.length; i++) {
        var m = _markers[i];
        if (!drawn(m)) continue;
        var d = Math.abs(fraction(m.frame) - frac) * widthPx + (m.continues ? 0.5 : 0);
        if (d <= tol + (m.continues ? 0.5 : 0) && d < bestD) { bestD = d; best = m; }
    }
    return best;
}

/** "possible ID switch: id_1 ↔ id_3 (size score -50, still swapped, reviewed)". */
export function describeSwitchMarker(m) {
    var cue = m.agree ? CUE_NAME[cueOf(m)] + ' and ' + CUE_NAME[cueOf(m.agree)] + ' agree; ' + CUE_NAME[cueOf(m)] + ' score ' +
            Math.round(m.score) + ', ' + CUE_NAME[cueOf(m.agree)] + ' ' + Math.round(m.agree.score)
        : CUE_NAME[cueOf(m)] + ' score ' + Math.round(m.score);
    return 'possible ID switch: ' + m.nameA + ' ↔ ' + m.nameB + ' (' + cue +
        (m.continues ? ', still swapped' : m.followOf != null ? ', follows an earlier switch'
            : m.kind === 'end' ? ', labelling changes here' : '') + (m.reviewed ? ', reviewed' : '') + ')';
}

function render() {
    if (!_layer) return;
    if (!_markers.length || !(_total > 1)) { _layer.innerHTML = ''; return; }
    var html = '';
    for (var i = 0; i < _markers.length; i++) {
        var m = _markers[i];
        if (!drawn(m)) continue;
        var cls = 'seekbar-mark cue-' + (m.agree ? 'both cue-both-' + cueOf(m) + '-' + cueOf(m.agree) : cueOf(m)) +
            (m.continues ? ' is-repeat' : m.followOf != null ? ' is-follow' : '') + (m.reviewed ? ' is-reviewed' : '');
        html += '<div class="' + cls + '" data-frame="' + m.frame + '" style="left:' + (100 * fraction(m.frame)).toFixed(4) + '%"></div>';
    }
    _layer.innerHTML = html;
}
