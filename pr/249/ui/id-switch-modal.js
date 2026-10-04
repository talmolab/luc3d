/**
 * ui/id-switch-modal.js — Tracks ▸ "Check ID Switches (Body Size)…" / "(Images)…",
 * and the same checks run automatically after Track All / Track Frame Range.
 *
 * Runs the size and/or image check (pose/id-switch-check.js) over the active
 * session's tracked identities, puts every flagged close encounter on the
 * timeline as a possible-switch marker (amber = size, cyan = images), and lists
 * the CHANGE POINTS in a dialog — click a row to jump there. A change point both
 * checks found (same pair, within 1 s) is shown once as "Both". Repeats (other
 * encounters of a pair that is still swapped) are counted and can be shown.
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

import { state, timeline, getActiveSession } from './app-state.js';
import { setStatus } from '../import-export/save-load.js';
import { showLoadingProgress, hideLoading, yieldToPaint } from './loading-overlay.js';
import { getTrackingThreshold } from './settings.js';
import { checkSizeSwitches, checkImageSwitches } from '../pose/id-switch-check.js';
import { hasWebGPU, createImageEmbedder, IMAGE_MODEL_MB } from './image-embedder.js';

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

/** Change points to review: switch onsets plus 'end' points (where an early swapped stretch stops). */
function primaryOf(res) {
    return res.flags.filter(function (f) { return !f.continues; }).concat(res.changes || [])
        .sort(function (a, b) { return a.frame - b.frame; });
}

/** Everything drawn on the timeline: change points at full strength, repeats faint. */
function markersOf(res) {
    return res.flags.concat(res.changes || []);
}

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

/** Tag a result's markers with their cue, and link change points both checks found. */
function tagAndLink(results) {
    ['size', 'image'].forEach(function (cue) {
        var r = results[cue];
        if (r && r.ok) markersOf(r).forEach(function (m) { m.cue = cue; });
    });
    var s = results.size, im = results.image;
    if (!(s && s.ok && im && im.ok)) return;
    var tol = Math.max(1, Math.round(s.fps || 30));
    var samePair = function (a, b) {
        return (a.identityA === b.identityA && a.identityB === b.identityB) || (a.identityA === b.identityB && a.identityB === b.identityA);
    };
    primaryOf(im).forEach(function (m) {
        var hit = primaryOf(s).find(function (x) { return samePair(x, m) && Math.abs(x.frame - m.frame) <= tol; });
        if (hit) { m.agree = hit; hit.agree = m; }
    });
}

function countOnsets(res) {
    return primaryOf(res).filter(function (f) { return f.followOf == null; }).length;
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
        return res;
    } catch (e) {
        if (e && e.name === 'AbortError') return { ok: false, reason: 'cancelled', cancelled: true };
        throw e;
    } finally { prog.close(); }
}

/**
 * Run the selected checks, mark the results on the timeline and report them.
 *
 * From the menu (`auto` false) the dialog always opens. After Track All or Track
 * Frame Range (`auto: true`, pose/tracker.js) the results are appended to the
 * pass's own status line (`statusPrefix`), the dialog opens only when a possible
 * switch was found, and a check that cannot run is reported as skipped — never as
 * an error of the tracking pass.
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
    var deps = { navigateToFrame: opts.navigateToFrame || _navigate };
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
            ? n + ' possible switch' + (n === 1 ? '' : 'es') + ' in ' + res.encounters.length + ' close encounters — marked on the timeline'
            : 'no possible switches in ' + res.encounters.length + ' close encounters'));
        if (n) level = 'warning';
    }
    tagAndLink(results);
    var ran = cues.filter(function (c) { return results[c] && results[c].ok; });
    if (timeline && ran.length) {
        // A cue that ran replaces its own old markers; a cue that didn't keeps them.
        var keep = timeline.getSwitchMarkers().filter(function (m) { return ran.indexOf(m.cue || 'size') < 0; });
        timeline.setSwitchMarkers(keep.concat.apply(keep, ran.map(function (c) { return markersOf(results[c]); })));
    }
    setStatus((auto && opts.statusPrefix ? opts.statusPrefix + ' · ' : '') + parts.join('; '), level);
    var anyFound = ran.some(function (c) { return countOnsets(results[c]) > 0; });
    if ((!auto && ran.length) || anyFound) showIdSwitchModal(results, deps);
    return results;
}

/** Back-compat: the size check alone. */
export function runSizeSwitchCheck(opts) {
    return runIdSwitchChecks(Object.assign({}, opts || {}, { size: true, image: false }));
}

// ---------------------------------------------------------------------------
// The results dialog
// ---------------------------------------------------------------------------

/**
 * The results dialog. Esc / Close / backdrop close it; markers stay on the
 * timeline until "Clear markers".
 */
export function showIdSwitchModal(results, deps) {
    var showRepeats = false;
    var ran = ['size', 'image'].filter(function (c) { return results[c] && results[c].ok; });
    var overlay = document.createElement('div');
    overlay.className = 'multi-frame-modal-overlay';
    var modal = document.createElement('div');
    modal.className = 'multi-frame-modal size-switch-modal';
    var repeats = 0;
    ran.forEach(function (c) { repeats += results[c].flags.filter(function (f) { return f.continues; }).length; });
    var title = ran.length === 2 ? 'Possible ID Switches' : ran[0] === 'image' ? 'Possible ID Switches (Images)' : 'Possible ID Switches (Body Size)';
    var summary = ran.map(function (c) {
        var r = results[c], n = countOnsets(r);
        return '<div class="track-range-summary">' + (ran.length === 2 ? '<b>' + (c === 'size' ? 'Body size' : 'Images') + ':</b> ' : '') +
            r.encounters.length + ' close encounters checked · <b>' + n + '</b> possible switch' + (n === 1 ? '' : 'es') + '</div>';
    }).join('');
    var r0 = results[ran[0]];
    modal.innerHTML =
        '<h3>' + title + '</h3>' +
        '<p>Each close encounter between two identities is scored by whether the animals leaving it look like the ' +
        'identities they now carry — by 3D body size' + (results.image && results.image.ok ? ' and/or by appearance in the videos' : '') +
        ', learned from the tracker\'s own labels. Flags are leads to review, not certainties: size cannot tell apart ' +
        'animals of near-equal size, and images struggle with animals that look alike.' +
        (ran.length === 2 ? ' <b>Review "Both" rows first</b> — when both checks flag the same encounter it was a real swap ' +
            'far more often (in calibration: 98% vs 79% for images alone, and none on a 30-min recording with no switches).' : '') + '</p>' +
        summary +
        (repeats ? '<div class="track-range-summary">' + repeats + ' later encounter' + (repeats === 1 ? '' : 's') + ' still look swapped</div>' : '') +
        '<div class="size-switch-rate">Analysed ' + r0.sampleHz.toFixed(1) + ' samples/s (every ' +
        (r0.step === 1 ? 'frame' : ordinal(r0.step) + ' frame') + ' at ' + r0.fps.toFixed(2).replace(/\.?0+$/, '') + ' fps' +
        (results.image && results.image.ok ? '; images at ' + results.image.imageHz.toFixed(1) + '/s, ' +
            results.image.crops.toLocaleString() + ' crops from ' + results.image.cameras.length + ' views' +
            (results.image.model && results.image.model.note ? ' (' + escapeHtml(results.image.model.note) + ')' : '') : '') +
        (r0.fpsFromVideo ? ', measured from the video)'
            : ') — <b>no video is loaded, so this frame rate was not measured</b>. If the recording ran at a ' +
              'different rate, set it in the fps box and run the check again: scores are evidence per second.') +
        '</div>' +
        (repeats ? '<label class="size-switch-repeats"><input type="checkbox" id="sizeSwitchRepeats"> Show repeats</label>' : '') +
        '<div class="size-switch-list" id="sizeSwitchList"></div>' +
        '<div class="modal-actions">' +
        '<button id="sizeSwitchClear">Clear markers</button>' +
        '<button class="primary" id="sizeSwitchClose">Close</button>' +
        '</div>';
    overlay.appendChild(modal);
    document.body.appendChild(overlay);
    var listEl = modal.querySelector('#sizeSwitchList');

    function rowsToShow() {
        var rows = [];
        ran.forEach(function (c) {
            var list = showRepeats ? markersOf(results[c]) : primaryOf(results[c]);
            list.forEach(function (m) {
                if (c === 'image' && m.agree) return;      // shown once, on the size row, as "Both"
                rows.push(m);
            });
        });
        return rows.sort(function (a, b) { return a.frame - b.frame; });
    }
    function render() {
        var rows = rowsToShow();
        if (!rows.length) { listEl.innerHTML = '<p class="size-switch-empty">No encounter scored below the threshold.</p>'; return; }
        var both = ran.length === 2;
        listEl.innerHTML = '<table class="align-views-table"><thead><tr><th>Time</th><th>Frame</th><th>Identities</th>' +
            (both ? '<th>Check</th>' : '') + '<th class="align-views-num">Score</th></tr></thead><tbody>' +
            rows.map(function (f) {
                var cue = f.agree ? 'both' : f.cue;
                var score = f.agree ? Math.round(f.score) + ' / ' + Math.round(f.agree.score) : Math.round(f.score);
                return '<tr class="size-switch-row' + (f.continues || f.followOf != null ? ' is-repeat' : '') + ' cue-' + cue + '" data-frame="' + f.frame + '">' +
                    '<td>' + fmtTime(f.frame) + '</td><td>' + (f.frame + 1).toLocaleString() + '</td>' +
                    '<td>' + escapeHtml(f.nameA) + ' ↔ ' + escapeHtml(f.nameB) +
                    (f.continues ? ' (still swapped)'
                        : f.followOf != null ? ' (follows the switch at ' + fmtTime(f.followOf) + ')'
                        : f.kind === 'end' ? ' (labelling changes here; earlier encounters look swapped)' : '') + '</td>' +
                    (both ? '<td>' + (cue === 'both' ? '<b>Both</b>' : cue === 'size' ? 'Size' : 'Images') + '</td>' : '') +
                    '<td class="align-views-num">' + score + '</td></tr>';
            }).join('') + '</tbody></table>';
    }

    function close() {
        document.removeEventListener('keydown', onKey);
        overlay.remove();
    }
    function onKey(e) {
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); close(); }
    }
    listEl.addEventListener('click', function (e) {
        var row = e.target.closest('.size-switch-row');
        if (!row) return;
        listEl.querySelectorAll('.size-switch-row.is-current').forEach(function (r) { r.classList.remove('is-current'); });
        row.classList.add('is-current');
        if (deps && deps.navigateToFrame) deps.navigateToFrame(parseInt(row.dataset.frame, 10));
    });
    var rep = modal.querySelector('#sizeSwitchRepeats');
    if (rep) rep.addEventListener('change', function () { showRepeats = rep.checked; render(); });
    modal.querySelector('#sizeSwitchClear').addEventListener('click', function () {
        if (timeline) timeline.setSwitchMarkers([]);
        setStatus('Cleared ID-switch markers', 'success');
        close();
    });
    modal.querySelector('#sizeSwitchClose').addEventListener('click', close);
    overlay.addEventListener('mousedown', function (e) { if (e.target === overlay) close(); });
    document.addEventListener('keydown', onKey);
    render();
}

/** Back-compat name. */
export var showSizeSwitchModal = showIdSwitchModal;
