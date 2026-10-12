// ui/loading-overlay.js — the full-window loading overlay (#loadingOverlay) and
// its determinate progress bar, shared by every long-running bulk operation
// (Track All, Triangulate All, Group by Identity, …).
//
// Two pieces:
//   - `showLoading` / `showLoadingProgress` / `hideLoading` own the overlay DOM.
//     `showLoading(msg)` is the indeterminate form (spinner + text) and hides
//     the bar; `showLoadingProgress(label, done, total)` writes the standard
//     "<label>: done/total frames (pct%)…" line and drives the bar.
//   - `createProgressPacer()` decides WHEN a chunked main-thread loop should
//     report and yield. It is time-based, not every-N-frames: a frame count is
//     either too chatty on fast work (each yield waits for a paint) or too
//     sparse on slow work (the bar sits still), while a clock check costs the
//     same tens of nanoseconds per iteration whatever the work is.
//
// Why the bar moves smoothly between infrequent updates: the fill is scaled
// with `transform` under a CSS transition about as long as the pacer interval.
// Transform transitions run on the compositor thread, so the bar keeps gliding
// while the main thread is busy computing the next chunk — the same reason the
// spinner keeps spinning.

/** Default pacer interval. Each yield waits for one paint (~one display frame),
 *  so this bounds the overhead at roughly frame-time / interval (a few %). The
 *  `.loading-progress-fill` transition in styles.css is matched to it. */
export var PROGRESS_INTERVAL_MS = 250;

/** Time-remaining estimate (the second text line, #loadingEta).
 *  The rate is measured over the last ETA_WINDOW_MS of the current stage, so
 *  the estimate follows the work if it speeds up or slows down part-way (a
 *  whole-run average would lag), while 10 s of samples is still long enough
 *  that one slow chunk does not make the number jump. Nothing is shown until
 *  the stage has run ETA_MIN_ELAPSED_MS and covered ETA_MIN_FRACTION —
 *  before that the rate is mostly start-up noise. */
var ETA_WINDOW_MS = 10000;
var ETA_MIN_ELAPSED_MS = 1500;
var ETA_MIN_FRACTION = 0.01;

var _clock = function () {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
};
/** Test hook: replace the clock the ETA reads (pass null to restore). */
export function __setLoadingOverlayClock(fn) {
    _clock = fn || function () {
        return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
    };
}

// The stage the ETA samples belong to; a new label/step/total, or progress
// moving backwards, starts a new one.
var _eta = null;

function _etaReset() { _eta = null; }

/**
 * Estimated ms left in the current stage, or null while still estimating.
 * Exported for tests.
 */
export function estimateRemainingMs(samples, done, total) {
    if (!samples.length || total <= 0) return null;
    var first = samples[0], last = samples[samples.length - 1];
    if (last.t - first.t < ETA_MIN_ELAPSED_MS) return null;
    if (done / total < ETA_MIN_FRACTION) return null;
    // Base = the oldest sample inside the window (or the stage start).
    var base = first;
    for (var i = samples.length - 1; i >= 0; i--) {
        if (last.t - samples[i].t > ETA_WINDOW_MS) break;
        base = samples[i];
    }
    var dt = last.t - base.t, dd = last.done - base.done;
    if (dt <= 0 || dd <= 0) {
        // Stalled inside the window: fall back to the whole-stage rate.
        dt = last.t - first.t; dd = last.done - first.done;
        if (dt <= 0 || dd <= 0) return null;
    }
    return Math.max(0, (total - done) * dt / dd);
}

/**
 * "About 1 min 10 s remaining"-style text. Rounded so the line does not
 * flicker through every second: to 5 s under 10 min, to the minute above.
 */
export function formatRemaining(ms) {
    var sec = ms / 1000;
    if (sec < 10) return 'Less than 10 s remaining';
    if (sec < 600) {
        var r = Math.round(sec / 5) * 5;
        var m = Math.floor(r / 60), ss = r % 60;
        return 'About ' + (m ? m + ' min' + (ss ? ' ' + ss + ' s' : '') : ss + ' s') + ' remaining';
    }
    var mins = Math.round(sec / 60);
    if (mins < 60) return 'About ' + mins + ' min remaining';
    return 'About ' + Math.floor(mins / 60) + ' h ' + (mins % 60) + ' min remaining';
}

function _setEta(text, ms) {
    var el = _el('loadingEta');
    if (!el) return;
    el.textContent = text || '';
    el.classList.toggle('hidden', !text);
    if (el.dataset) {
        if (ms != null) el.dataset.ms = String(Math.round(ms));
        else delete el.dataset.ms;
    }
}

function _el(id) {
    return (typeof document !== 'undefined' && document.getElementById)
        ? document.getElementById(id) : null;
}

function _setBarVisible(on) {
    var wrap = _el('loadingProgress');
    if (wrap) wrap.classList.toggle('hidden', !on);
    var sub = _el('loadingSubstatus');
    if (sub && !on) { sub.textContent = ''; sub.classList.add('hidden'); }
    if (!on) { _setEta(''); _etaReset(); }
}

export function showLoading(msg) {
    var overlay = _el('loadingOverlay');
    if (overlay) overlay.classList.remove('hidden');
    var status = _el('loadingStatus');
    if (status) status.textContent = msg || 'Loading...';
    _setBarVisible(false);
}

export function hideLoading() {
    var overlay = _el('loadingOverlay');
    if (overlay) overlay.classList.add('hidden');
    _setBarVisible(false);
    _setFill(0, false);
}

function _setFill(frac, animate) {
    var fill = _el('loadingProgressFill');
    if (!fill) return;
    // Snap (no transition) when starting a new stage or resetting, so the bar
    // does not visibly rewind from the previous stage's 100%.
    fill.classList.toggle('no-anim', !animate);
    fill.style.transform = 'scaleX(' + frac + ')';
    fill.dataset.fraction = String(frac);
    var wrap = _el('loadingProgress');
    if (wrap) wrap.setAttribute('aria-valuenow', String(Math.round(frac * 100)));
}

/**
 * Show the overlay with a determinate progress bar.
 *
 * @param {string} label   stage name, e.g. 'Assigning identities'
 * @param {number} done    units completed
 * @param {number} total   units in this stage
 * @param {Object} [opts]
 * @param {number} [opts.step]   1-based stage number — shown only when `steps > 1`
 * @param {number} [opts.steps]  how many stages the operation has
 * @param {string} [opts.detail] extra context for the line under the bar
 *                               (method, counts) — kept off the main line so it
 *                               always reads "<label>: done/total frames (pct%)…"
 * @param {string} [opts.unit]   default 'frames'
 *
 * A second text line (#loadingEta) estimates the time remaining in the CURRENT
 * stage (see `estimateRemainingMs`); in a multi-stage run it says so.
 */
export function showLoadingProgress(label, done, total, opts) {
    opts = opts || {};
    var frac = total > 0 ? Math.max(0, Math.min(1, done / total)) : 0;
    var pct = Math.floor(frac * 100);
    var overlay = _el('loadingOverlay');
    if (overlay) overlay.classList.remove('hidden');
    var status = _el('loadingStatus');
    if (status) {
        status.textContent = label + ': ' + done + '/' + total + ' ' +
            (opts.unit || 'frames') + ' (' + pct + '%)…';
    }
    var wrap = _el('loadingProgress');
    // A stage starting over (bar hidden, or moving backwards) snaps; otherwise animate.
    var fill = _el('loadingProgressFill');
    var prev = fill ? parseFloat(fill.dataset.fraction) : NaN;
    var animate = !!(wrap && !wrap.classList.contains('hidden') &&
        Number.isFinite(prev) && frac >= prev);
    _setBarVisible(true);
    _setFill(frac, animate);
    _updateEta(label, done, total, opts);
    var sub = _el('loadingSubstatus');
    if (sub) {
        var parts = [];
        if (opts.steps > 1 && opts.step) parts.push('Step ' + opts.step + ' of ' + opts.steps);
        if (opts.detail) parts.push(opts.detail);
        sub.textContent = parts.join(' · ');
        sub.classList.toggle('hidden', parts.length === 0);
    }
}

function _updateEta(label, done, total, opts) {
    var key = label + '|' + (opts.step || 1) + '|' + total;
    var now = _clock();
    if (!_eta || _eta.key !== key ||
        done < _eta.samples[_eta.samples.length - 1].done) {
        _eta = { key: key, samples: [] };
    }
    var s = _eta.samples;
    s.push({ t: now, done: done });
    // Bounded: keep the stage's first sample (the fallback base) plus enough
    // recent ones to span the window several times over at ~4 updates/s.
    if (s.length > 200) s.splice(1, s.length - 150);
    if (total > 0 && done >= total) { _setEta(''); return; }
    var ms = estimateRemainingMs(s, done, total);
    if (ms == null) { _setEta('Estimating time remaining…'); return; }
    var text = formatRemaining(ms);
    if (opts.steps > 1) text += ' in this step';
    _setEta(text, ms);
}

/**
 * Wait until the browser has had a chance to PAINT, then resume.
 *
 * `setTimeout(0)` alone does not guarantee a paint — the timer can fire before
 * the next display frame is due, and the loop then runs another whole chunk
 * with the overlay unpainted. So when the page is visible this waits for the
 * next animation frame and resumes in a task queued after it (rAF callbacks run
 * just before that frame's paint). The fallback timer keeps a throttled rAF
 * (occluded window) from stalling the operation. A hidden tab needs no paint,
 * so it yields through a MessageChannel, which — unlike chained timers — is not
 * throttled to 1/s in background tabs.
 */
export function yieldToPaint() {
    return new Promise(function (resolve) {
        var settled = false;
        function go() { if (!settled) { settled = true; resolve(); } }
        var visible = typeof document !== 'undefined' && document.visibilityState === 'visible';
        if (visible && typeof requestAnimationFrame === 'function') {
            requestAnimationFrame(function () { setTimeout(go, 0); });
            setTimeout(go, 100);
        } else if (typeof MessageChannel === 'function') {
            var ch = new MessageChannel();
            ch.port1.onmessage = function () { ch.port1.close(); go(); };
            ch.port2.postMessage(0);
        } else {
            setTimeout(go, 0);
        }
    });
}

/**
 * Time-based throttle for chunked main-thread loops.
 *
 *     var pacer = createProgressPacer();
 *     for (...) {
 *         work();
 *         if (pacer.due()) { showLoadingProgress(...); await pacer.yield(); }
 *     }
 *
 * `due()` is true at most once per `intervalMs` (it resets the clock when it
 * returns true). `yield()` is `yieldToPaint`.
 */
export function createProgressPacer(intervalMs) {
    var interval = intervalMs != null ? intervalMs : PROGRESS_INTERVAL_MS;
    var now = (typeof performance !== 'undefined' && performance.now)
        ? function () { return performance.now(); } : Date.now;
    var last = now();
    return {
        due: function () {
            var t = now();
            if (t - last < interval) return false;
            last = t;
            return true;
        },
        yield: function () {
            return yieldToPaint().then(function () { last = now(); });
        },
    };
}
