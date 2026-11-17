// ui/progress-delta.js — every progress bar lights up the stretch it just gained.
//
// When a bar moves forward, the length it added on that update is drawn in a
// brighter shade of the bar's own colour, with a short flash as it appears, the
// way a game's health bar lights up the chunk a hit took off. It stays lit until
// the next update replaces it, so a glance says how far the bar moved on its
// last step — and so how fast the operation is going.
//
// One call per update, after the bar's own fill is set:
//
//     fill.style.width = pct + '%';
//     noteProgress(fill, pct / 100);
//
// The brighter stretch is a `.progress-delta` element placed in the fill's
// parent (the track, which already clips the fill), from the previous fraction
// to the new one, drawn over the fill as a translucent white tint — so it is a
// brighter version of whatever colour the bar is, with no colour per bar. It
// grows with the same transition the fill's own width / transform uses (read
// from the fill's computed style), so its leading edge and the fill's move
// together rather than the tint running ahead of the bar. A bar that moves
// back, resets or snaps (`animate: false`, or a fill with no transition and a
// zero fraction) has no gained stretch: the tint is removed.
//
// Two kinds of fill are handled, both read from the fill's style, never from
// a per-bar setting: a `width` fill (most bars) and a full-width fill scaled
// with `transform: scaleX(f)` (the loading overlay's). Position bars — the
// video seekbar, an ID-switch row's playhead, range sliders — are not progress
// and do not call this.

var DELTA_CLASS = 'progress-delta';

/** The delta element for `fill`, created in its track on first use. */
function deltaFor(fill) {
    var track = fill.parentNode;
    // A real element in a real track only (unit tests drive some bars on a stand-in DOM).
    if (!track || fill.nodeType !== 1 || track.nodeType !== 1 || typeof document.createElement !== 'function') return null;
    var el = fill._progressDelta;
    if (el && el.parentNode === track) return el;
    el = document.createElement('div');
    el.className = DELTA_CLASS;
    el.setAttribute('aria-hidden', 'true');
    // Positioned in the track: give a static track a containing block.
    if (typeof getComputedStyle === 'function' && getComputedStyle(track).position === 'static') {
        track.style.position = 'relative';
    }
    track.appendChild(el);
    fill._progressDelta = el;
    return el;
}

/** The transition the fill moves with (duration + timing function of its `width` or `transform`). */
function fillTransition(fill) {
    if (typeof getComputedStyle !== 'function') return null;
    var cs = getComputedStyle(fill);
    var props = (cs.transitionProperty || '').split(',').map(function (s) { return s.trim(); });
    var durs = (cs.transitionDuration || '').split(',').map(function (s) { return s.trim(); });
    var fns = (cs.transitionTimingFunction || '').split(',').map(function (s) { return s.trim(); });
    for (var i = 0; i < props.length; i++) {
        if (props[i] === 'width' || props[i] === 'transform' || props[i] === 'all') {
            var d = durs[i % durs.length] || '0s';
            var ms = /ms$/.test(d) ? parseFloat(d) : parseFloat(d) * 1000;
            if (!(ms > 0)) return null;
            return { ms: ms, fn: fns[i % fns.length] || 'ease' };
        }
    }
    return null;
}

/**
 * Light up the stretch `fill` gained since its previous `noteProgress` call.
 *
 * @param {HTMLElement} fill   the bar's fill, already set to `frac`
 * @param {number} frac        the fill's new fraction, 0..1
 * @param {Object} [opts]
 * @param {boolean} [opts.animate=true]  false: the fill snapped (a new stage,
 *        a reset) — no gained stretch is shown, and the next update grows from here.
 */
export function noteProgress(fill, frac, opts) {
    if (!fill || typeof document === 'undefined') return;
    frac = Math.max(0, Math.min(1, Number(frac) || 0));
    var prev = fill._progressFrac;
    fill._progressFrac = frac;
    var animate = !(opts && opts.animate === false);
    var el = deltaFor(fill);
    if (!el) return;
    if (!animate || prev == null || !(frac > prev)) {
        el.classList.remove('is-on');
        el.style.width = '0';
        return;
    }
    // Restart: place it at the old edge, collapsed, with no transition…
    el.classList.remove('is-on');
    el.style.transition = 'none';
    el.style.left = (100 * prev) + '%';
    el.style.width = (100 * (frac - prev)) + '%';
    el.style.transform = 'scaleX(0)';
    void el.offsetWidth;   // commit that state, so the change below transitions
    // …then grow it with the fill's own transition, and flash it on.
    var tr = fillTransition(fill);
    el.style.transition = tr ? 'transform ' + tr.ms + 'ms ' + tr.fn : 'none';
    el.style.transform = 'scaleX(1)';
    el.classList.add('is-on');
}

/** Forget a fill's last fraction (its bar is being reused from zero); hides the stretch. */
export function resetProgress(fill) {
    if (!fill) return;
    fill._progressFrac = null;
    if (fill._progressDelta) {
        fill._progressDelta.classList.remove('is-on');
        fill._progressDelta.style.width = '0';
    }
}
