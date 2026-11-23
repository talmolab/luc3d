// ui/progress-delta.js — every progress bar lights up the stretch it just gained,
// and moves its fill, that stretch and its playhead as ONE.
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
// parent (the track, which already clips the fill), drawn over the fill as a
// translucent white tint — so it is a brighter version of whatever colour the
// bar is, with no colour per bar.
//
// Why this module also moves the fill (and the playhead, `opts.head`): the
// parts used to glide each with its own CSS transition, and the stretch was
// placed from the previous TARGET to the new one. When updates came faster than
// the transition (videos finishing in a burst), every update restarted each
// transition from wherever it had got to, so the fill lagged far behind the
// percentage, the playhead lagged by a different amount (its transition was
// restarted at a different moment), and the lit stretch sat ahead of both as a
// floating block. Now every update starts ONE glide for all of them, with the
// same start point (where the bar is drawn right now), end point, start time,
// length and linear timing (Web Animations, one explicit start time), so they cannot
// part. The lit stretch runs from where the fill was drawn when the update came
// to the new fraction, and its leading edge is the fill's.
//
// The glide lasts as long as the time since the previous update, at least
// MIN_GLIDE_MS and at most the fill's own CSS transition (read once from its
// computed style, then switched off inline): a pacer reporting every 250 ms
// glides 250 ms, as before, while a burst of updates moves the bar promptly
// instead of trailing the percentage by a quarter second per update.
//
// Two kinds of fill are handled, both read from the fill's style, never from
// a per-bar setting: a `width` fill (most bars; its playhead moves by `left`)
// and a full-width fill scaled with `transform: scaleX(f)` (the loading
// overlay's; its playhead is a full-width wrapper moved by `translateX`). Each
// part glides the same property as its fill, so a busy main thread holds them
// all (width) or none (transform). A bar that moves back, resets or snaps
// (`animate: false`) has no gained stretch: the tint is removed. Position bars
// — the video seekbar, an ID-switch row's playhead, range sliders — are not
// progress and do not call this.

var DELTA_CLASS = 'progress-delta';

/** The shortest glide (ms): a burst of updates still moves visibly, not in one jump. */
export var MIN_GLIDE_MS = 50;

function _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

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

/** The length (ms) of the fill's CSS transition of its `width` or `transform`; 0 when none. */
function fillTransitionMs(fill) {
    if (typeof getComputedStyle !== 'function') return 0;
    var cs = getComputedStyle(fill);
    var props = (cs.transitionProperty || '').split(',').map(function (s) { return s.trim(); });
    var durs = (cs.transitionDuration || '').split(',').map(function (s) { return s.trim(); });
    for (var i = 0; i < props.length; i++) {
        if (props[i] === 'width' || props[i] === 'transform' || props[i] === 'all') {
            var d = durs[i % durs.length] || '0s';
            var ms = /ms$/.test(d) ? parseFloat(d) : parseFloat(d) * 1000;
            return ms > 0 ? ms : 0;
        }
    }
    return 0;
}

function _kind(fill) {
    return /scaleX\(/.test(fill.style.transform || '') ? 'scale' : 'width';
}
function _fillFrame(kind, f) {
    return kind === 'scale' ? { transform: 'scaleX(' + f + ')' } : { width: (100 * f) + '%' };
}
function _headFrame(kind, f) {
    return kind === 'scale' ? { transform: 'translateX(' + (100 * f) + '%)' } : { left: (100 * f) + '%' };
}

/** The fill's glide state: { from, to, ms, at, anims, maxMs }. */
function _motion(fill) {
    return fill._progressMotion || (fill._progressMotion = { from: null, to: null, ms: 0, at: 0, anims: null, maxMs: 0 });
}

/**
 * Where the bar is drawn now: the running glide's position, from the glide's
 * own clock (a glide not started yet — no frame since it was asked for — is
 * still at its start).
 */
function _shownFrac(m) {
    if (m.to == null) return null;
    var a = m.anims && m.anims[0];
    if (!a || !(m.ms > 0) || a.playState === 'finished' || a.playState === 'idle') return m.to;
    var t = Number(a.currentTime);
    if (!(t > 0)) return m.from;
    var p = t / m.ms;
    if (!(p > 0)) return m.from;
    if (p >= 1) return m.to;
    return m.from + (m.to - m.from) * p;
}

function _cancel(m) {
    if (m.anims) m.anims.forEach(function (a) { try { a.cancel(); } catch (e) { /* already gone */ } });
    m.anims = null;
}

function _hideDelta(el) {
    if (!el) return;
    if (el._progressAnim) { try { el._progressAnim.cancel(); } catch (e) { /* already gone */ } el._progressAnim = null; }
    el.classList.remove('is-on');
    el.style.width = '0';
}

/**
 * Glide `fill` (and `opts.head`) to `frac`, lighting up the stretch it gained
 * since the previous call.
 *
 * @param {HTMLElement} fill   the bar's fill, already set to `frac`
 * @param {number} frac        the fill's new fraction, 0..1
 * @param {Object} [opts]
 * @param {boolean} [opts.animate=true]  false: the fill snapped (a new stage,
 *        a reset) — no gained stretch is shown, and the next update grows from here.
 * @param {HTMLElement} [opts.head]  the bar's playhead, already set to `frac`
 *        (`left` for a width fill, `translateX` of a full-width wrapper for a
 *        scaled one): it glides with the fill.
 */
export function noteProgress(fill, frac, opts) {
    if (!fill || typeof document === 'undefined') return;
    frac = Math.max(0, Math.min(1, Number(frac) || 0));
    var el = deltaFor(fill);
    if (!el) return;
    var m = _motion(fill), now = _now();
    var head = opts && opts.head && opts.head.nodeType === 1 ? opts.head : null;
    var animate = !(opts && opts.animate === false);
    // The fill's own transition sets the longest glide; from then on this
    // module moves it (and its playhead), so their CSS transitions are switched
    // off — a transition would outrank the glide in the cascade. (Without Web
    // Animations they keep their transitions, unsynchronised, as before.)
    var canGlide = typeof fill.animate === 'function';
    if (!m.maxMs) {
        m.maxMs = fillTransitionMs(fill);
        if (m.maxMs && canGlide) fill.style.transition = 'none';
    }
    if (m.maxMs && canGlide && head) head.style.transition = 'none';
    var shown = _shownFrac(m);
    if (animate && shown != null && frac === m.to) return;   // no move: the glide under way carries on
    var since = now - m.at;
    m.at = now;
    var canAnimate = canGlide && m.maxMs > 0;
    if (!animate || shown == null || !(frac > shown)) {
        // Snap: no glide, no gained stretch.
        _cancel(m);
        m.from = m.to = frac; m.ms = 0;
        _hideDelta(el);
        return;
    }
    var kind = _kind(fill), from = shown;
    var ms = canAnimate ? Math.min(m.maxMs, Math.max(MIN_GLIDE_MS, since)) : 0;
    _cancel(m);
    m.from = from; m.to = frac; m.ms = ms;
    // The stretch: from where the fill is drawn now to the new fraction.
    if (el._progressAnim) { try { el._progressAnim.cancel(); } catch (e) { /* already gone */ } el._progressAnim = null; }
    el.style.transition = 'none';
    el.style.left = (100 * from) + '%';
    el.style.width = (100 * (frac - from)) + '%';
    el.style.transform = '';
    // Restart the flash (`.is-on::after`): off, commit, on.
    el.classList.remove('is-on');
    void el.offsetWidth;
    el.classList.add('is-on');
    if (!ms) return;
    var timing = { duration: ms, easing: 'linear' };
    var anims = [fill.animate([_fillFrame(kind, from), _fillFrame(kind, frac)], timing)];
    if (head) anims.push(head.animate([_headFrame(kind, from), _headFrame(kind, frac)], timing));
    // The stretch grows with the fill, by the same property: its right edge IS the fill's.
    var grow = kind === 'scale'
        ? [{ transform: 'scaleX(0)' }, { transform: 'scaleX(1)' }]
        : [{ width: '0%' }, { width: (100 * (frac - from)) + '%' }];
    el._progressAnim = el.animate(grow, timing);
    anims.push(el._progressAnim);
    // One explicit start for all of them, now. Left pending, each would start
    // at the next frame, and Chrome tells the page a compositor animation's
    // start only a frame or two later: an update arriving before that read the
    // glide as not yet moving and restarted it from the old point, so a burst
    // of updates held the bar still while the percentage ran on.
    var t0 = document.timeline ? document.timeline.currentTime : null;
    if (t0 != null) anims.forEach(function (a) { a.startTime = t0; });
    m.anims = anims;
}

/** Forget a fill's last fraction (its bar is being reused from zero); hides the stretch. */
export function resetProgress(fill) {
    if (!fill) return;
    var m = fill._progressMotion;
    if (m) { _cancel(m); m.from = m.to = null; m.ms = 0; }
    _hideDelta(fill._progressDelta);
}
