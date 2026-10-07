/**
 * ui/id-switch-modal.js — Tracks ▸ "Check ID Switches (Body Size)…" / "(Images)…",
 * and the same checks run automatically after Track All / Track Frame Range.
 *
 * Runs the size and/or image check (pose/id-switch-check.js) over the active
 * session's tracked identities, puts every flagged close encounter on the
 * seekbar as a possible-switch tick (amber = size, cyan = images), and lists
 * the CHANGE POINTS in the right panel's "ID Switches" tab as a checklist —
 * click a row to jump there, tick it once reviewed, "Next unreviewed" walks the
 * list. Results (and what was reviewed) are kept per session until the check
 * runs again or "Clear". A change point both checks found (same pair, within
 * 1 s) is shown once as "Both". Repeats (other encounters of a pair that is
 * still swapped) are counted and can be shown.
 *
 * The size check only reads the tracker's 3D skeletons (seconds, no video). The
 * image check decodes video and embeds crops on the GPU (ui/image-embedder.js):
 * minutes, needs the session's videos and WebGPU, and runs under its own
 * cancellable progress dialog (Cancel / Esc).
 *
 * Kept a leaf: `navigateToFrame` is registered by ui-wiring
 * (setIdSwitchNavigator), so this module never imports pose/initialization.js.
 *
 * Depends on: pose/id-switch-check.js, ui/image-embedder.js, ui/app-state.js,
 * ui/loading-overlay.js, ui/settings.js (getTrackingThreshold),
 * import-export/save-load.js (setStatus).
 */

import { state, getActiveSession } from './app-state.js?v=892883cc9bc5';
import { setSeekbarSwitchMarkers } from './seekbar-markers.js?v=892883cc9bc5';
import { setIdSwitchHighlight, updateIdSwitchHighlight, refreshIdSwitchHighlight, ID_SWITCH_SECTION_RGB } from './id-switch-highlight.js?v=892883cc9bc5';
import { setStatus, markDirty } from '../import-export/save-load.js?v=892883cc9bc5';
import { showLoadingProgress, hideLoading, yieldToPaint } from './loading-overlay.js?v=892883cc9bc5';
import { getTrackingThreshold } from './settings.js?v=892883cc9bc5';
import { checkSizeSwitches, checkImageSwitches } from '../pose/id-switch-check.js?v=892883cc9bc5';
import { hasWebGPU, createImageEmbedder, IMAGE_MODEL_MB, formatEmbedTiming } from './image-embedder.js?v=892883cc9bc5';
import { idSwitchRowKey as rowKey, idSwitchPrimary as primaryOf, idSwitchMarkers as markersOf, idSwitchOnsets as countOnsets,
         idSwitchEncounterCount as encounterCount, linkIdSwitchResults as tagAndLink,
         idSwitchFixPlan, idSwitchFixFor, idSwitchRenameForFix } from './id-switch-review.js?v=892883cc9bc5';

const CUE_LABEL = { size: 'body size', image: 'images' };

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}

function ordinal(n) {
    var s = ['th', 'st', 'nd', 'rd'], v = n % 100;
    return n + (s[(v - 20) % 10] || s[v] || s[0]);
}

/** Seconds of lead-in before an encounter starts: a row lands here so pressing play shows the whole interaction. */
export const ID_SWITCH_LEAD_IN_SECONDS = 1;

/** Where a row lands: `ID_SWITCH_LEAD_IN_SECONDS` before its close spell starts (its end frame if the start is unknown). */
export function idSwitchLeadInFrame(m, fps) {
    var start = m.startFrame != null && m.startFrame <= m.frame ? m.startFrame : m.frame;
    return Math.max(0, start - Math.round(ID_SWITCH_LEAD_IN_SECONDS * (fps > 0 ? fps : 30)));
}

/** "2:00.3" from a 0-based frame index at the app's frame rate (tenths of a second). */
function fmtTenths(frame) {
    var t = Math.floor(10 * frame / (state.fps || 30)) / 10;
    var m = Math.floor(t / 60), s = t - 60 * m;
    return m + ':' + (s < 10 ? '0' : '') + s.toFixed(1);
}

/** "12:34" from a 0-based frame index at the app's frame rate. */
function fmtTime(frame) {
    var sec = frame / (state.fps || 30);
    var m = Math.floor(sec / 60), s = Math.floor(sec % 60);
    return m + ':' + (s < 10 ? '0' : '') + s;
}

function fmtDuration(sec) {
    if (!isFinite(sec)) return '';
    if (sec < 90) return Math.max(1, Math.round(sec)) + ' s';
    return Math.round(sec / 60) + ' min';
}

/** True when at least one tracked frame has a 3D skeleton with an identity. */
function hasTrackedIdentities(session) {
    if (!session || !session.instanceGroups || !(session.identities || []).length) return false;
    for (var groups of session.instanceGroups.values()) {
        for (var i = 0; i < groups.length; i++) if (groups[i].points3d && groups[i].identityId >= 0) return true;
    }
    return false;
}

// The viewer's frame navigation, registered once by ui-wiring (setIdSwitchNavigator) so that a
// check started by a tracking pass (pose/tracker.js, which cannot import pose/initialization.js) still
// gets clickable rows.
var _navigate = null;

/** Register `navigateToFrame` for result rows (called once from ui/ui-wiring.js). */
export function setIdSwitchNavigator(fn) { _navigate = fn; }

// What the app repaints after a fix changed identities (overlays, 3D, info panel, timeline), registered
// once by ui-wiring for the same reason as the navigator: this module stays a leaf.
var _refresh = null;

/** Register the repaint run after a fix / undo changes identities (called once from ui/ui-wiring.js). */
export function setIdSwitchRefresher(fn) { _refresh = fn; }

/**
 * The recording's frame rate, and whether it was measured from the video. The
 * checks convert their time settings (and weight their scores) with it, so a
 * wrong value shifts every score — without video the rate is whatever the fps box
 * holds (30 by default), which the dialog calls out.
 */
function recordingFps(session) {
    var fromVideo = (state.views || []).some(function (v) {
        return v && v.decoder && v.decoder.samples && v.decoder.samples.length > 0;
    });
    var fps = state.fps > 0 ? state.fps : (session && session.fps > 0 ? session.fps : 0);
    return { fps: fps, fromVideo: fromVideo };
}

// ---------------------------------------------------------------------------
// A small cancellable progress dialog for the (long) image check
// ---------------------------------------------------------------------------

function openProgressDialog(title) {
    var ctl = new AbortController();
    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';
    overlay.innerHTML = '<div class="multi-frame-modal id-switch-progress"><h3>' + escapeHtml(title) + '</h3>' +
        '<div class="id-switch-progress-text">Starting…</div>' +
        '<div class="id-switch-progress-bar"><div class="id-switch-progress-fill"></div></div>' +
        '<div class="modal-actions"><button id="idSwitchCancel">Cancel</button></div></div>';
    document.body.appendChild(overlay);
    var textEl = overlay.querySelector('.id-switch-progress-text'), fill = overlay.querySelector('.id-switch-progress-fill');
    var cancel = function () { if (!ctl.signal.aborted) { ctl.abort(); textEl.textContent = 'Cancelling…'; } };
    var onKey = function (e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); cancel(); } };
    overlay.querySelector('#idSwitchCancel').addEventListener('click', cancel);
    document.addEventListener('keydown', onKey);
    return {
        signal: ctl.signal,
        update: function (text, frac) {
            if (ctl.signal.aborted) return;
            if (text != null) textEl.textContent = text;
            if (frac != null) fill.style.width = Math.round(100 * Math.min(1, Math.max(0, frac))) + '%';
        },
        close: function () { document.removeEventListener('keydown', onKey); overlay.remove(); },
    };
}

// ---------------------------------------------------------------------------
// Running the checks
// ---------------------------------------------------------------------------

async function runSize(session, rate) {
    var label = 'Checking ID switches (body size)';
    showLoadingProgress(label, 0, 1);
    await yieldToPaint();
    try {
        return await checkSizeSwitches(session, {
            fps: rate.fps,
            onProgress: async function (done, total) { showLoadingProgress(label, done, total); await yieldToPaint(); },
        });
    } finally { hideLoading(); }
}

async function runImage(session, rate, inject) {
    inject = inject || {};
    var views = (state.views || []).filter(function (v) { return v && v.decoder; });
    if (!views.length && !inject.createEmbedder) return { ok: false, reason: 'needs the session\'s videos to be loaded' };
    if (!(await (inject.hasWebGPU || hasWebGPU)())) return { ok: false, reason: 'needs WebGPU (current Chrome or Edge) — on the CPU it would take hours' };
    var prog = openProgressDialog('Checking ID switches (images)');
    var t0 = 0;
    try {
        var embedder = await (inject.createEmbedder || createImageEmbedder)(session, { onStatus: function (t) { prog.update(t, 0); },
            maxViewsPerAnimal: getTrackingThreshold('imageCheckMaxViews'),
            webnn: getTrackingThreshold('imageCheckWebNN') > 0 });
        t0 = performance.now();
        var res = await checkImageSwitches(session, {
            fps: rate.fps,
            imageHz: getTrackingThreshold('imageCheckHz') || 2,
            threshold: getTrackingThreshold('imageCheckThreshold'),
            getEmbeddings: embedder.getEmbeddings,
            prepareFrames: embedder.prepareFrames,
            inFlight: embedder.inFlight || 2,
            releaseFrames: embedder.releaseFrames,
            signal: prog.signal,
            onProgress: async function (stage, done, total) {
                if (stage === 'embed') {
                    var el = (performance.now() - t0) / 1000, left = done ? el * (total - done) / done : NaN;
                    prog.update('Cropping and embedding ' + embedder.views.length + ' views: frame ' + done.toLocaleString() +
                        ' of ' + total.toLocaleString() + (done > 3 ? ' — about ' + fmtDuration(left) + ' left' : ''), 0.9 * done / total);
                } else {
                    prog.update('Learning each animal\'s appearance (' + done + ' / ' + total + ')…', 0.9 + 0.1 * done / Math.max(1, total));
                }
                await yieldToPaint();
            },
        });
        if (res && embedder.backend) res.model = embedder.backend();   // after releaseFrames: the final word
        if (res && embedder.stats) {
            res.timing = embedder.stats();                 // where the time went, on THIS machine
            console.log('[ID switches, images] ' + formatEmbedTiming(res.timing), res.timing);
        }
        return res;
    } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false, reason: 'cancelled', cancelled: true };
        throw e;
    } finally { prog.close(); }
}

/**
 * Run the selected checks, mark the results on the seekbar and report them.
 *
 * From the menu (`auto` false) the ID Switches tab always opens. After Track All
 * or Track Frame Range (`auto: true`, pose/tracker.js) the results are appended
 * to the pass's own status line (`statusPrefix`), the tab opens only when a
 * possible switch was found, and a check that cannot run is reported as skipped —
 * never as an error of the tracking pass.
 *
 * @param {{size?: boolean, image?: boolean, auto?: boolean, statusPrefix?: string,
 *          navigateToFrame?: function(number), inject?: {createEmbedder?, hasWebGPU?}}} opts
 *   `inject` replaces the image model and the WebGPU probe — for tests only
 *   (tests/e2e/id-switch-image-check.mjs), so they need no GPU or model download.
 * @returns {Promise<{size?: object, image?: object}|null>}
 */
export async function runIdSwitchChecks(opts) {
    opts = opts || {};
    var auto = !!opts.auto, cues = ['size', 'image'].filter(function (c) { return opts[c]; });
    if (!cues.length) return null;
    var deps = { navigateToFrame: opts.navigateToFrame || null };
    var session = getActiveSession();
    var head = function (cue) { return auto ? 'ID-switch check (' + CUE_LABEL[cue] + ')' : (cue === 'size' ? 'Check ID Switches' : 'Check ID Switches (images)'); };
    if (!hasTrackedIdentities(session)) {
        if (auto) setStatus((opts.statusPrefix ? opts.statusPrefix + ' · ' : '') + head(cues[0]) + ': skipped — no tracked 3D skeletons', 'success');
        else setStatus('Check ID Switches needs tracked identities with 3D — run Track All first', 'warning');
        return null;
    }
    var rate = recordingFps(session), results = {}, parts = [], level = 'success';
    for (var cue of cues) {
        var res;
        try { res = cue === 'size' ? await runSize(session, rate) : await runImage(session, rate, opts.inject); }
        catch (e) {
            console.error('[id-switch-check:' + cue + ']', e);
            res = { ok: false, reason: 'failed — ' + e.message, failed: true };
        }
        results[cue] = res;
        if (!res.ok) {
            parts.push(head(cue) + ': ' + (auto && !res.failed && !res.cancelled ? 'skipped — ' : '') + res.reason);
            if (!auto && !res.cancelled) level = 'warning';
            continue;
        }
        res.fpsFromVideo = rate.fromVideo;
        var n = countOnsets(res);
        parts.push(head(cue) + ': ' + (n
            ? n + ' possible switch' + (n === 1 ? '' : 'es') + ' in ' + res.encounters.length + ' close encounters'
            : 'no possible switches in ' + res.encounters.length + ' close encounters'));
        if (n) level = 'warning';
    }
    var ran = cues.filter(function (c) { return results[c] && results[c].ok; });
    if (ran.length) {
        // A cue that ran replaces its own earlier results; a cue that didn't run (or failed) keeps them.
        var st = session._idSwitch || (session._idSwitch = { results: {}, reviewed: new Set(), fixes: [], showRepeats: false, current: null });
        ran.forEach(function (c) { st.results[c] = results[c]; });
        // Fixes are now part of the identities this run analysed, so they cannot be undone from its rows
        // (an undo would also rename rows that were scored on the fixed labels). The swaps themselves stay.
        st.fixes = [];
        if (deps.navigateToFrame) st.navigate = deps.navigateToFrame;
        tagAndLink(st.results);
        var live = new Set(listRows(st, true).map(rowKey));
        st.reviewed.forEach(function (k) { if (!live.has(k)) st.reviewed.delete(k); });   // keep ticks that still apply
        markDirty();                                       // new results: the .slp's checklist is out of date
    }
    refreshIdSwitchPanel(session);      // also when nothing ran: the tab and markers always show this session's results
    var anyFound = ran.some(function (c) { return countOnsets(results[c]) > 0; });
    setStatus((auto && opts.statusPrefix ? opts.statusPrefix + ' · ' : '') + parts.join('; ') +
        (anyFound ? ' — listed in the ID Switches tab' : ''), level);
    if ((!auto && ran.length) || anyFound) openIdSwitchPanel();
    return results;
}

/** Back-compat: the size check alone. */
export function runSizeSwitchCheck(opts) {
    return runIdSwitchChecks(Object.assign({}, opts || {}, { size: true, image: false }));
}

// ---------------------------------------------------------------------------
// The ID Switches tab (right panel): a per-session review checklist
// ---------------------------------------------------------------------------

function isReviewed(st, m) { return st.reviewed.has(rowKey(m)) || (m.agree ? st.reviewed.has(rowKey(m.agree)) : false); }

/** The rows to list: change points (plus repeats when shown); a "Both" pair appears once, on its size row. */
function listRows(st, withRepeats) {
    var rows = [];
    ['size', 'image'].forEach(function (c) {
        var r = st.results[c];
        if (!(r && r.ok)) return;
        (withRepeats ? markersOf(r) : primaryOf(r)).forEach(function (m) { if (!(c === 'image' && m.agree)) rows.push(m); });
    });
    return rows.sort(function (a, b) { return a.frame - b.frame; });
}

/** Put the session's markers on the seekbar (ui/seekbar-markers.js), reviewed ones dimmed (`reviewed`). */
function syncMarkers(session) {
    var st = session && session._idSwitch, all = [];
    if (st) ['size', 'image'].forEach(function (c) {
        var r = st.results[c];
        if (r && r.ok) markersOf(r).forEach(function (m) { m.reviewed = isReviewed(st, m); all.push(m); });
    });
    setSeekbarSwitchMarkers(all, state.totalFrames);
}

/** Show the right panel (if hidden) on the ID Switches tab. */
export function openIdSwitchPanel() {
    var wrap = document.getElementById('infoPanelWrapper');
    if (wrap && wrap.classList.contains('collapsed')) { var t = document.getElementById('infoPanelToggleBtn'); if (t) t.click(); }
    var tab = document.querySelector('.panel-tab[data-tab="tabIdSwitches"]');
    if (tab) tab.click();
}

/** Forget a session's results (a new tracking pass relabels everything) and clear its markers. */
export function clearIdSwitchResults(session) {
    session = session || getActiveSession();
    if (session && session._idSwitch) { delete session._idSwitch; markDirty(); }
    refreshIdSwitchPanel(session);
}

function aboutHtml(st, ran) {
    var r0 = st.results[ran[0]], im = st.results.image;
    return '<p>Each close encounter between two identities is scored by whether the animals leaving it look like the ' +
        'identities they now carry — by 3D body size' + (im && im.ok ? ' and/or by appearance in the videos' : '') +
        ', learned from the tracker\'s own labels. Flags are leads to review, not certainties: size cannot tell apart ' +
        'animals of near-equal size, and images struggle with animals that look alike.' +
        (ran.length === 2 ? ' <b>Review "Both" rows first</b> — when both checks flag the same encounter it was a real swap ' +
            'far more often (in calibration: 98% vs 79% for images alone, and none on a 30-min recording with no switches).' : '') + '</p>' +
        '<p class="id-switch-rate">Analysed ' + r0.sampleHz.toFixed(1) + ' samples/s (every ' +
        (r0.step === 1 ? 'frame' : ordinal(r0.step) + ' frame') + ' at ' + r0.fps.toFixed(2).replace(/\.?0+$/, '') + ' fps' +
        (im && im.ok ? '; images at ' + im.imageHz.toFixed(1) + '/s, ' + im.crops.toLocaleString() + ' crops from ' + im.cameras.length + ' views' +
            (im.model && im.model.note ? ' (' + escapeHtml(im.model.note) + ')' : '') : '') +
        (r0.fpsFromVideo ? ', measured from the video)'
            : ') — <b>no video is loaded, so this frame rate was not measured</b>. If the recording ran at a ' +
              'different rate, set it in the fps box and run the check again: scores are evidence per second.') + '</p>' +
        (im && im.ok && im.timing && im.timing.crops ? '<p class="id-switch-rate">Image check speed on this machine: ' +
            escapeHtml(formatEmbedTiming(im.timing)) + '. GPU busy well under 100% means it waited on video decoding, ' +
            'cropping or the browser\'s main thread rather than computing.</p>' : '');
}

// ---- The selected row's progress bar ------------------------------------------------
// Driven by the viewer's frame (ui-wiring's updateSeekbarVisual -> updateIdSwitchProgress):
// 0% at the row's landing frame (1 s before the animals come close), the close spell —
// where a swap would happen — red in the middle, 100% at 1 s after they separate; the
// lead-in and lead-out are orange. The box in the views wears the colour of the section
// the frame is in (ID_SWITCH_SECTION_RGB, shared with ui/id-switch-highlight.js). A playhead
// line marks the current frame (the fill's leading edge), standing proud of the bar so it reads
// at a glance — which is why the coloured track is an inner element: the bar itself must not
// clip, while the track keeps its rounded ends.
var _prog = null, _progStale = true;        // {fill, head, p0, p1} of the selected row's bar
var _scrubbing = false, _scrubTo = null;    // a press on the bar is in progress / the frame it last sent

/** A row's interval: p0 (landing, 1 s before the close spell) .. s (close starts) .. f.frame (close ends) .. p1 (1 s after). */
function rowRange(f) {
    var fps = state.fps > 0 ? state.fps : 30, lead = Math.round(ID_SWITCH_LEAD_IN_SECONDS * fps);
    var s = f.startFrame != null && f.startFrame <= f.frame ? f.startFrame : f.frame;
    return { p0: idSwitchLeadInFrame(f, fps), s: s, p1: f.frame + lead };
}

/** Highlight a row's two animals in the views over its interval (ui/id-switch-highlight.js), or stop. */
function highlightRow(f) {
    if (!f) { setIdSwitchHighlight(null); return; }
    var r = rowRange(f);
    setIdSwitchHighlight({ nameA: f.nameA, nameB: f.nameB, p0: r.p0, s: r.s, e: f.frame, p1: r.p1 });
}

/** The bar for a row (the selected one). */
function progressHtml(f) {
    var r = rowRange(f), s = r.s, p0 = r.p0, p1 = r.p1, span = Math.max(1, p1 - p0);
    var pct = function (x) { return (100 * Math.min(1, Math.max(0, (x - p0) / span))).toFixed(2) + '%'; };
    var cur = state.currentFrame != null ? state.currentFrame : p0;
    var lead = 'rgba(' + ID_SWITCH_SECTION_RGB.lead + ', 0.5)';
    // the track: orange lead-in | (band) | orange lead-out, hard stops at the close spell's edges
    var track = 'linear-gradient(to right, ' + lead + ' 0 ' + pct(s) + ', transparent ' + pct(s) + ' ' + pct(f.frame) +
        ', ' + lead + ' ' + pct(f.frame) + ' 100%)';
    return '<div class="id-switch-pbar" data-p0="' + p0 + '" data-p1="' + p1 + '" title="' +
        ID_SWITCH_LEAD_IN_SECONDS + ' s before (orange) → close ' + fmtTenths(s) + '–' + fmtTenths(f.frame) + ' (red) → ' + ID_SWITCH_LEAD_IN_SECONDS + ' s after (orange) — click or drag to go to a frame">' +
        '<div class="id-switch-ptrack" style="background-image:' + track + '">' +
        // fill first, band over it: the red close spell stays visible as the fill passes it
        '<div class="id-switch-pfill" style="width:' + pct(cur) + '"></div>' +
        '<div class="id-switch-pband" style="left:' + pct(s) + ';width:calc(' + pct(f.frame) + ' - ' + pct(s) + ' + 2px);background:rgba(' +
        ID_SWITCH_SECTION_RGB.close + ', 0.75)"></div></div>' +
        '<div class="id-switch-phead" style="left:' + pct(cur) + '"></div></div>';
}

/** Move the selected row's bar to `frame` (called on every frame change; a no-op without a selected row). */
export function updateIdSwitchProgress(frame) {
    updateIdSwitchHighlight(frame);                 // the box around the pair in the views (same interval)
    if (_progStale) {
        _progStale = false;
        var el = typeof document !== 'undefined' && document.querySelector('#idSwitchPanel .id-switch-row.is-current .id-switch-pbar');
        _prog = el ? { fill: el.querySelector('.id-switch-pfill'), head: el.querySelector('.id-switch-phead'),
                       p0: +el.dataset.p0, p1: +el.dataset.p1 } : null;
    }
    if (!_prog) return;
    if (!_prog.fill.isConnected) { _prog = null; return; }
    var f = Math.min(1, Math.max(0, (frame - _prog.p0) / Math.max(1, _prog.p1 - _prog.p0)));
    _prog.fill.style.width = _prog.head.style.left = (100 * f).toFixed(2) + '%';
}

// ---- Fixing a switch ---------------------------------------------------------------
// "Fix switch…" on the selected row swaps the pair's identities over the stretch the detector says was
// crossed (idSwitchFixPlan, ui/id-switch-review.js), after a confirmation that names the frames. The
// row then stays, ticked and marked Fixed, and the view returns to its lead-in so playing it shows the
// corrected labels. Undo (the latest fix only — later fixes may build on it) swaps the same frames back.

function identityIdByName(session, name) {
    var ids = (session && session.identities) || [];
    for (var i = 0; i < ids.length; i++) if (ids[i] && ids[i].name === name) return ids[i].id;
    return null;
}

/** Repaint everything that shows identities, then this tab and the box in the views. */
function afterIdentityChange(session) {
    if (_refresh) _refresh();
    refreshIdSwitchPanel(session);
    refreshIdSwitchHighlight();
}

/** The confirmation dialog for fixing row `f`. Cancel / Esc change nothing. */
function openFixDialog(session, st, f) {
    var res = st.results[f.cue] || st.results.size;
    var rr = rowRange(f);                          // the row's window: its progress bar, lead-in .. 1 s after
    var plan = idSwitchFixPlan(f, res, { currentFrame: state.currentFrame, totalFrames: state.totalFrames, window: [rr.p0, rr.p1] });
    if (!plan) { setStatus('Nothing to fix here: the stretch this switch covers is empty', 'warning'); return; }
    var idA = identityIdByName(session, plan.nameA), idB = identityIdByName(session, plan.nameB);
    if (idA == null || idB == null) {
        setStatus('Cannot fix: identity "' + (idA == null ? plan.nameA : plan.nameB) + '" is not in this session', 'error');
        return;
    }
    var fr = function (x) { return 'frame ' + (x + 1).toLocaleString(); };
    var startWhy, endWhy;
    if (f.kind === 'end') {
        startWhy = plan.edge == null ? 'the start of the video, where the swapped stretch begins'
            : 'just after their encounter at ' + fmtTenths(plan.edge) + ', where the labels first look swapped';
        endWhy = plan.start === 'current' ? 'just before the frame you are on'
            : 'where they separate (the end of the red section) — the frame you are on is outside this switch';
    } else {
        startWhy = plan.start === 'current' ? 'the frame you are on' : 'where they separate (just after the red section) — the frame you are on is outside this switch';
        endWhy = plan.edge == null ? 'the end of the video'
            : 'the end of their next encounter (' + fmtTenths(plan.edge) + '), after which the labels look right again';
    }
    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';
    overlay.innerHTML = '<div class="multi-frame-modal id-switch-fix-modal" role="dialog" aria-labelledby="idSwitchFixTitle">' +
        '<h3 id="idSwitchFixTitle">Fix ID switch</h3>' +
        '<p>Swap ' + idName(session, plan.nameA) + ' ↔ ' + idName(session, plan.nameB) + ' on <b>frames ' +
        (plan.from + 1).toLocaleString() + '–' + (plan.to + 1).toLocaleString() + '</b> (' + fmtTenths(plan.from) + '–' +
        fmtTenths(plan.to) + '), in every camera view.</p>' +
        '<ul class="id-switch-fix-why"><li>Starts at ' + fr(plan.from) + ': ' + startWhy + '.</li>' +
        '<li>Ends at ' + fr(plan.to) + ': ' + endWhy + '.</li></ul>' +
        (f.followOf != null ? '<p class="id-switch-fix-warn">This flag follows the switch at ' + fmtTime(f.followOf) +
            ', and is often a side effect of it. Fix that one first if you have not.</p>' : '') +
        '<p class="id-switch-fix-tip">To ' + (f.kind === 'end' ? 'end' : 'start') + ' somewhere else, go to that frame on the row\'s ' +
        'progress bar (click it, step or play) and click Fix switch again.</p>' +
        '<div class="modal-actions"><button id="idSwitchFixCancel">Cancel</button>' +
        '<button id="idSwitchFixOk" class="primary">Swap identities</button></div></div>';
    document.body.appendChild(overlay);
    var close = function () { document.removeEventListener('keydown', onKey, true); overlay.remove(); };
    // Capture phase, and every key stops here: the app's shortcuts must not act under an open dialog.
    // Enter / Space still press the focused button (a default action, not a listener).
    var onKey = function (e) {
        e.stopPropagation();
        if (e.key === 'Escape') { e.preventDefault(); close(); }
    };
    document.addEventListener('keydown', onKey, true);
    overlay.querySelector('#idSwitchFixCancel').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    overlay.querySelector('#idSwitchFixOk').addEventListener('click', function () {
        close();
        applyFix(session, st, f, plan, idA, idB);
    });
    overlay.querySelector('#idSwitchFixOk').focus();
}

/** Swap, record, rename the rows the swap re-labels, then replay the row from its lead-in. */
function applyFix(session, st, f, plan, idA, idB) {
    var r = session.swapIdentitiesInRange(plan.from, plan.to, idA, idB);
    var fix = { key: plan.key, partnerKey: plan.partnerKey, nameA: plan.nameA, nameB: plan.nameB,
                from: plan.from, to: plan.to, idA: idA, idB: idB };
    (st.fixes || (st.fixes = [])).push(fix);
    idSwitchRenameForFix(st, fix);
    st.reviewed.add(fix.key);
    st.current = fix.key;
    markDirty();
    var nav = st.navigate || _navigate;
    if (nav) nav(idSwitchLeadInFrame(f, state.fps));          // back to the lead-in: play to see the fixed labels
    afterIdentityChange(session);
    updateIdSwitchProgress(state.currentFrame);
    setStatus('Fixed: swapped ' + plan.nameA + ' ↔ ' + plan.nameB + ' on frames ' + (plan.from + 1).toLocaleString() + '–' +
        (plan.to + 1).toLocaleString() + ' (' + r.frames.toLocaleString() + ' tracked frames changed) — press play to check it', 'success');
}

/** Swap the latest fix's frames back (the swap is its own inverse) and forget it. */
function undoLastFix(session, st) {
    var fix = st.fixes && st.fixes[st.fixes.length - 1];
    if (!fix) return;
    var idA = identityIdByName(session, fix.nameA), idB = identityIdByName(session, fix.nameB);
    if (idA == null || idB == null) { setStatus('Cannot undo: identity "' + (idA == null ? fix.nameA : fix.nameB) + '" is gone', 'error'); return; }
    session.swapIdentitiesInRange(fix.from, fix.to, idA, idB);
    idSwitchRenameForFix(st, fix);
    st.fixes.pop();
    markDirty();
    afterIdentityChange(session);
    updateIdSwitchProgress(state.currentFrame);
    setStatus('Undid the fix: ' + fix.nameA + ' ↔ ' + fix.nameB + ' swapped back on frames ' + (fix.from + 1).toLocaleString() + '–' +
        (fix.to + 1).toLocaleString(), 'success');
}

/** An identity name in that identity's colour (the one the overlays and timeline use), when the session knows it. */
function idName(session, name) {
    var ids = (session && session.identities) || [], hit = null;
    for (var i = 0; i < ids.length; i++) if (ids[i] && ids[i].name === name) { hit = ids[i]; break; }
    var col = hit && typeof hit.color === 'string' && /^#[0-9a-f]{3,8}$|^rgb/i.test(hit.color) ? hit.color : null;
    return '<span class="id-switch-id"' + (col ? ' style="color:' + col + '"' : '') + '>' + escapeHtml(name) + '</span>';
}

function rowHtml(session, st, f, both) {
    var cue = f.agree ? 'both' : f.cue, key = rowKey(f), rev = isReviewed(st, f);
    var score = f.agree ? Math.round(f.score) + ' / ' + Math.round(f.agree.score) : Math.round(f.score);
    var note = f.continues ? 'still swapped'
        : f.followOf != null ? 'follows the switch at ' + fmtTime(f.followOf)
        : f.kind === 'end' ? 'labelling changes here; earlier encounters look swapped' : '';
    var fixed = idSwitchFixFor(st, f);
    return '<div class="id-switch-row cue-' + cue + (f.continues || f.followOf != null ? ' is-repeat' : '') + (rev ? ' is-reviewed' : '') +
        (fixed ? ' is-fixed' : '') +
        (st.current === key ? ' is-current' : '') + '" data-frame="' + f.frame + '" data-go="' + idSwitchLeadInFrame(f, state.fps) +
        '" data-key="' + escapeHtml(key) + '">' +
        '<input type="checkbox" class="id-switch-tick" title="Reviewed"' + (rev ? ' checked' : '') + '>' +
        '<div class="id-switch-main"><div class="id-switch-line1"><span class="id-switch-time">' + fmtTime(f.frame) + '</span>' +
        '<span class="id-switch-pair">' + idName(session, f.nameA) + ' ↔ ' + idName(session, f.nameB) + '</span>' +
        '<span class="id-switch-score" title="Score' + (f.agree ? ' (size / images)' : '') + '">' + score + '</span></div>' +
        '<div class="id-switch-line2">' + spanHtml(f) +
        (both ? ' · ' + (cue === 'both' ? '<b>Both</b>' : cue === 'size' ? 'size' : 'images') : '') +
        (fixed ? ' · <span class="id-switch-fixed">Fixed</span>' : '') +
        (note ? ' · ' + note : '') + '</div>' + (st.current === key ? selectedHtml(st, f) : '') + '</div></div>';
}

/** What the selected row shows under its lines: the progress bar, then Fix switch… (or what was fixed, and Undo). */
function selectedHtml(st, f) {
    var fix = idSwitchFixFor(st, f), last = st.fixes && st.fixes.length ? st.fixes[st.fixes.length - 1] : null;
    var act;
    if (fix) {
        act = '<span class="id-switch-fixed-note">Fixed: ' + escapeHtml(fix.nameA) + ' ↔ ' + escapeHtml(fix.nameB) +
            ' swapped on frames ' + (fix.from + 1).toLocaleString() + '–' + (fix.to + 1).toLocaleString() + '</span>' +
            (fix === last ? '<button class="panel-btn id-switch-undo" title="Swap the same frames back">Undo fix</button>' : '');
    } else if (!f.continues) {
        act = '<button class="panel-btn id-switch-fix" title="Swap these two identities over the frames this switch covers — ' +
            'a dialog shows exactly which, before anything changes">Fix switch…</button>';
    } else return progressHtml(f);
    return progressHtml(f) + '<div class="id-switch-actions">' + act + '</div>';
}

/** "close 2:00.3–2:01.2 (frames 7,218–7,317) [end ⇥]": the encounter, and a jump to its end. */
function spanHtml(f) {
    var s = f.startFrame != null && f.startFrame <= f.frame ? f.startFrame : null;
    var end = '<button class="id-switch-end" title="Jump to frame ' + (f.frame + 1).toLocaleString() +
        ', the end of the encounter — where the animals separate and their labels are read">end ⇥</button>';
    if (s == null || s === f.frame) return 'close at ' + fmtTenths(f.frame) + ' (frame ' + (f.frame + 1).toLocaleString() + ') ' + end;
    return 'close ' + fmtTenths(s) + '–' + fmtTenths(f.frame) + ' (frames ' + (s + 1).toLocaleString() + '–' + (f.frame + 1).toLocaleString() + ') ' + end;
}

/**
 * (Re)render the ID Switches tab for `session` (default: the active one) and put
 * its markers on the seekbar. Cheap; called after a check, on every info-panel
 * refresh and on session switch.
 */
export function refreshIdSwitchPanel(session) {
    session = session || getActiveSession();
    syncMarkers(session);
    var host = typeof document !== 'undefined' && document.getElementById('idSwitchPanel');
    if (!host) return;
    var st = session && session._idSwitch;
    var ran = st ? ['size', 'image'].filter(function (c) { return st.results[c] && st.results[c].ok; }) : [];
    if (!ran.length) {
        host.innerHTML = '<div class="info-section"><h3>Possible ID switches</h3><p class="table-empty id-switch-empty">' +
            (hasTrackedIdentities(session) ? 'No ID-switch check has run on this session yet.' : 'Run Track All first: the checks need tracked identities with 3D.') +
            '</p><div class="id-switch-run"><button class="panel-btn" data-run="menuCheckSizeSwitches">Check by body size</button>' +
            '<button class="panel-btn" data-run="menuCheckImageSwitches">Check by images…</button></div></div>';
        setIdSwitchHighlight(null);
        host.querySelectorAll('[data-run]').forEach(function (b) {
            b.addEventListener('click', function () { var m = document.getElementById(b.dataset.run); if (m) m.click(); });
        });
        return;
    }
    var both = ran.length === 2, primary = listRows(st, false), all = listRows(st, true);
    var repeats = all.length - primary.length, done = primary.filter(function (m) { return isReviewed(st, m); }).length;
    var rows = st.showRepeats ? all : primary;
    host.innerHTML =
        '<div class="info-section id-switch-head"><h3>Possible ID switches</h3>' +
        ran.map(function (c) {
            var r = st.results[c], n = countOnsets(r);
            return '<div class="id-switch-summary">' + (both ? '<b>' + (c === 'size' ? 'Body size' : 'Images') + ':</b> ' : '') +
                encounterCount(r).toLocaleString() + ' close encounters · <b>' + n + '</b> possible switch' + (n === 1 ? '' : 'es') + '</div>';
        }).join('') +
        '<details class="id-switch-about"><summary>About these flags</summary>' + aboutHtml(st, ran) + '</details>' +
        '</div>' +
        '<div class="id-switch-toolbar">' +
        '<span class="id-switch-done"><b>' + done + '</b> of ' + primary.length + ' reviewed</span>' +
        '<button class="panel-btn id-switch-next" id="idSwitchNext"' + (done < primary.length ? '' : ' disabled') + '>Next unreviewed ▸</button>' +
        '<button class="panel-btn" id="idSwitchClear" title="Forget these results and remove their seekbar markers">Clear</button>' +
        (repeats ? '<label class="id-switch-repeats"><input type="checkbox" id="idSwitchRepeats"' + (st.showRepeats ? ' checked' : '') +
            '> Show ' + repeats + ' later encounter' + (repeats === 1 ? '' : 's') + ' that still look swapped</label>' : '') +
        '</div>' +
        '<div class="id-switch-list" id="idSwitchList">' +
        (rows.length ? rows.map(function (f) { return rowHtml(session, st, f, both); }).join('')
            : '<p class="table-empty">No encounter scored below the threshold.</p>') + '</div>';
    _progStale = true;                               // the list was rebuilt: re-find the selected row's bar
    highlightRow(rows.filter(function (f) { return rowKey(f) === st.current; })[0] || null);
    var nav = st.navigate || _navigate;
    // A row lands ID_SWITCH_LEAD_IN_SECONDS before the animals come close (data-go), so pressing play
    // shows the whole interaction — the swap happens WHILE they are close, and the encounter's own
    // frame (its end, data-frame) is after it. "end ⇥" jumps to that end instead.
    var byKey = new Map(rows.map(function (f) { return [rowKey(f), f]; }));
    var go = function (row, toEnd) {
        st.current = row.dataset.key;
        host.querySelectorAll('.id-switch-row.is-current').forEach(function (r) { r.classList.remove('is-current'); });
        host.querySelectorAll('.id-switch-pbar').forEach(function (b) { b.remove(); });
        row.classList.add('is-current');
        var f = byKey.get(row.dataset.key);
        host.querySelectorAll('.id-switch-actions').forEach(function (b) { b.remove(); });
        if (f) row.querySelector('.id-switch-main').insertAdjacentHTML('beforeend', selectedHtml(st, f));   // pops up at the selected row
        _progStale = true;
        highlightRow(f);
        if (nav) nav(parseInt(toEnd ? row.dataset.frame : row.dataset.go, 10));
        updateIdSwitchProgress(state.currentFrame);
    };
    host.querySelector('#idSwitchList').addEventListener('click', function (e) {
        var row = e.target.closest('.id-switch-row');
        if (!row || e.target.closest('.id-switch-pbar') || _scrubbing) return;    // the bar seeks (below), not re-lands
        if (e.target.closest('.id-switch-fix')) { var fr = byKey.get(row.dataset.key); if (fr) openFixDialog(session, st, fr); return; }
        if (e.target.closest('.id-switch-undo')) { undoLastFix(session, st); return; }
        if (e.target.classList.contains('id-switch-tick')) {
            if (e.target.checked) st.reviewed.add(row.dataset.key); else st.reviewed.delete(row.dataset.key);
            st.current = row.dataset.key;
            markDirty();                                   // the checklist is saved in the .slp
            refreshIdSwitchPanel(session);
            return;
        }
        go(row, e.target.classList.contains('id-switch-end'));
    });
    // Click or drag on the selected row's bar: go to that frame, like the transport seekbar. Moves
    // re-find the bar each time rather than holding the element, so a panel rebuilt mid-drag (an
    // info-panel refresh) cannot strand the drag on a detached node; the interval is fixed at the press.
    host.querySelector('#idSwitchList').addEventListener('pointerdown', function (e) {
        var bar = e.target.closest('.id-switch-pbar');
        if (!bar || e.button !== 0 || !nav) return;
        e.preventDefault();                                // no text selection while dragging
        var p0 = +bar.dataset.p0, p1 = +bar.dataset.p1;
        var seek = function (ev) {
            var b = host.querySelector('.id-switch-row.is-current .id-switch-pbar') || bar, r = b.getBoundingClientRect();
            if (!(r.width > 0)) return;
            var x = Math.min(1, Math.max(0, (ev.clientX - r.left) / r.width));
            var fr = Math.round(p0 + x * (p1 - p0));
            if (fr === _scrubTo) return;
            _scrubTo = fr;
            nav(fr);
            updateIdSwitchProgress(fr);                     // the bar follows the pointer, not the decode
        };
        var up = function () {
            window.removeEventListener('pointermove', seek);
            window.removeEventListener('pointerup', up);
            window.removeEventListener('pointercancel', up);
            setTimeout(function () { _scrubbing = false; }, 0);   // swallow the click that ends this press
        };
        _scrubbing = true; _scrubTo = null;
        seek(e);
        window.addEventListener('pointermove', seek);
        window.addEventListener('pointerup', up);
        window.addEventListener('pointercancel', up);
    });
    host.querySelector('#idSwitchNext').addEventListener('click', function () {
        var list = Array.from(host.querySelectorAll('.id-switch-row')), at = list.findIndex(function (r) { return r.dataset.key === st.current; });
        for (var i = 1; i <= list.length; i++) {
            var r = list[(at + i + list.length) % list.length];
            if (!r.classList.contains('is-reviewed')) {        // the next listed row not yet ticked, wrapping
                go(r); r.scrollIntoView({ block: 'nearest' }); return;
            }
        }
    });
    host.querySelector('#idSwitchClear').addEventListener('click', function () {
        clearIdSwitchResults(session);
        setStatus('Cleared the ID-switch results and markers', 'success');
    });
    var rep = host.querySelector('#idSwitchRepeats');
    if (rep) rep.addEventListener('change', function () { st.showRepeats = rep.checked; refreshIdSwitchPanel(session); });
}
