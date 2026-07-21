// ui/qc-panel.js — Quality-Control tab in the info panel.
//
// Fully manual: QC compute runs only when the user clicks the QC toolbar button
// / "Check Frame" / "Run Project QC", or presses the QC hotkey. On run we reveal
// and activate the QC tab (showQCTab). Threshold histograms are draggable and
// re-classify live WITHOUT recomputing geometry (qc.classify).
//
// Compute lives in pose/qc.js; this module is pure DOM + wiring.

import { state, videoController, paneManager, interactionManager } from './app-state.js';
import { drawAllOverlays } from './rendering.js';
import { getInstanceGroupsForFrame } from '../pose/triangulation.js';
import {
    analyzeFrame,
    runProjectQC,
    classify,
    makeThresholds,
    buildHistogram,
    groupConsecutiveIssues,
    nextFlaggedFrame,
    prevFlaggedFrame,
} from '../pose/qc.js';

// Metric definitions for the draggable histograms (only the ones with data /
// that the user asked to tune interactively).
const HIST_METRICS = [
    { key: 'reproj', thKey: 'reprojHigh', label: 'Reprojection error (px, per node)', color: '#4f9dff' },
    { key: 'epipolar', thKey: 'epiThresh', label: 'Epipolar distance (px)', color: '#c084fc' },
    // 2D velocity only matters when 2D jitter is enabled (else dragging it does nothing).
    { key: 'velocity', thKey: 'velThresh2d', label: '2D temporal velocity (px/frame)', color: '#22c55e', needs2dJitter: true },
    { key: 'velocity3d', thKey: 'velThresh3d', label: '3D temporal velocity (units/frame)', color: '#10b981' },
    { key: 'limbZ', thKey: 'limbZ', label: 'Limb-length z-score (robust)', color: '#ec4899' },
    { key: 'iou', thKey: 'iouThresh', label: 'Duplicate IOU', color: '#f59e0b' },
];

let _typeFilter = 'all';
let _sevFilter = 'all';

function el(id) { return document.getElementById(id); }

// Full roster of QC issue types, in display order, with a friendly label and a
// one-line explanation (shown as a chip tooltip). Rendered ALWAYS — a type with
// zero issues still shows "0" so the user can see e.g. "0 ID switches".
const ISSUE_TYPES = [
    { type: 'reprojection', label: 'reprojection', tip: 'A triangulated node reprojects far from its 2D detection — geometric inconsistency across views.' },
    { type: 'inversion', label: 'inversion', tip: 'A reprojection error concentrated in ONE camera — usually a left/right or node mislabel (the node is "inverted") in that view.' },
    { type: 'epipolar', label: 'epipolar', tip: 'A node violates the epipolar geometry between a pair of cameras.' },
    { type: 'miss', label: 'missing', tip: 'A node is visible in fewer than the required number of cameras.' },
    { type: 'node_swap', label: 'node swap / chimera', tip: 'Within a frame, some nodes of one animal are fused into another animal’s instance (a chimera).' },
    { type: 'id_switch', label: 'ID switch', tip: 'Across frames, two identities appear to have exchanged labels.' },
    { type: 'duplicate', label: 'duplicate', tip: 'Two instances in the same view sit on top of each other.' },
    { type: 'low_nodes', label: 'low nodes', tip: 'An instance has too few visible nodes.' },
    { type: 'jitter', label: 'jitter', tip: 'A sudden large frame-to-frame displacement (2D is opt-in; 3D per identity).' },
    { type: 'limb_outlier', label: 'limb length', tip: 'A bone length far from its typical value for that track/identity.' },
];
const TYPE_INFO = {};
ISSUE_TYPES.forEach(function (t) { TYPE_INFO[t.type] = t; });
function prettyType(t) { return (TYPE_INFO[t] && TYPE_INFO[t].label) || t; }
function typeTip(t) { return (TYPE_INFO[t] && TYPE_INFO[t].tip) || ''; }

// The whole app numbers frames 1-indexed (frame counter, timeline); QC stores raw
// 0-indexed frameIdx. Display +1 so labels match the counter — but SEEK the raw idx.
function fLabel(idx) { return 'F' + (idx + 1); }

// ---------------------------------------------------------------------------
// Reveal / activate the QC tab (used by every entry point)
// ---------------------------------------------------------------------------

export function showQCTab() {
    const wrapper = el('infoPanelWrapper');
    if (wrapper && wrapper.classList.contains('collapsed')) {
        const toggle = el('infoPanelToggleBtn');
        if (toggle) toggle.click();
    }
    const tabBtn = document.querySelector('.panel-tab[data-tab="tabQC"]');
    if (tabBtn) tabBtn.click();
}

// ---------------------------------------------------------------------------
// Entry points
// ---------------------------------------------------------------------------

// Fold the 2D jitter/limb opt-in checkboxes into a thresholds object.
function apply2dOpts(th) {
    th.enable2dJitter = !!(el('qcEnable2dJitter') && el('qcEnable2dJitter').checked);
    th.enable2dLimb = !!(el('qcEnable2dLimb') && el('qcEnable2dLimb').checked);
    return th;
}

export function runQCCurrentFrame() {
    showQCTab(); // always reveal the tab, even with no session yet
    state.qcHighlight = null;
    const session = state.session;
    if (!session) { renderNoSession(); return; }
    const th = apply2dOpts(state.qcResults ? state.qcResults.thresholds : makeThresholds());
    const frameRes = analyzeFrame(session, state.currentFrame, th);
    renderCurrentFrameResult(frameRes);
    updateQCBadge();
}

export async function runQCProject() {
    showQCTab(); // always reveal the tab, even with no session yet
    state.qcHighlight = null;
    const session = state.session;
    if (!session) { renderNoSession(); return; }
    const progress = el('qcProgress');
    const btn = el('qcRunProjectBtn');
    if (btn) btn.disabled = true;
    if (progress) { progress.style.display = ''; progress.textContent = 'Running QC…'; }
    const th = apply2dOpts(state.qcResults ? state.qcResults.thresholds : makeThresholds());
    try {
        const result = await runProjectQC(session, {
            thresholds: th,
        }, function (done, total) {
            if (progress) progress.textContent = 'Running QC… ' + done + ' / ' + total + ' frames';
        });
        state.qcResults = result;
        renderQC();
    } catch (e) {
        if (progress) progress.textContent = 'QC failed: ' + (e && e.message ? e.message : e);
        // eslint-disable-next-line no-console
        console.error('QC error', e);
    } finally {
        if (btn) btn.disabled = false;
        if (progress) setTimeout(function () { progress.style.display = 'none'; }, 800);
    }
    updateQCBadge();
}

// --- Locate-the-error helpers ---------------------------------------------

function instancesInView(fg, viewName) {
    const out = [];
    const linked = fg.instances.get(viewName);
    if (linked) for (let i = 0; i < linked.length; i++) out.push(linked[i]);
    const ul = fg.getUnlinkedInstances ? fg.getUnlinkedInstances(viewName) : [];
    for (let i = 0; i < ul.length; i++) out.push(ul[i].instance);
    return out;
}
function pickInstance(insts, trackIdx) {
    if (trackIdx != null) {
        const m = insts.find(function (i) { return i.trackIdx === trackIdx; });
        if (m) return m;
    }
    return insts.length ? insts[0] : null;
}
function bboxOfInstance(inst) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, n = 0;
    for (let i = 0; i < inst.points.length; i++) {
        const p = inst.points[i];
        if (!p) continue;
        n++; minx = Math.min(minx, p[0]); miny = Math.min(miny, p[1]);
        maxx = Math.max(maxx, p[0]); maxy = Math.max(maxy, p[1]);
    }
    return n ? { minx: minx, miny: miny, maxx: maxx, maxy: maxy } : null;
}

// Resolve WHERE a flagged issue is → orange box(es) + node arrow(s), in video px.
// Best-effort: falls back to boxing the whole instance when node-level resolution
// isn't possible, and returns null (no overlay) if nothing can be located.
function buildHighlight(session, issue) {
    if (!session) return null;
    const fg = session.getFrameGroup ? session.getFrameGroup(issue.frameIdx) : (session.frameGroups && session.frameGroups.get(issue.frameIdx));
    if (!fg) return null;
    const allViews = (session.cameras || []).map(function (c) { return c.name; });
    const views = issue.view ? [issue.view] : allViews;
    const boxes = [], nodes = [];
    const kps = (issue.keypoints && issue.keypoints.length) ? issue.keypoints : null;

    // ID switch: box BOTH identities' instances in every view.
    if (issue.type === 'id_switch') {
        const groups = getInstanceGroupsForFrame(issue.frameIdx) || [];
        groups.forEach(function (grp) {
            if (grp.identityId !== issue.identityA && grp.identityId !== issue.identityB) return;
            allViews.forEach(function (vn) {
                const inst = grp.getInstance && grp.getInstance(vn);
                const bb = inst && bboxOfInstance(inst);
                if (bb) boxes.push({ view: vn, minx: bb.minx, miny: bb.miny, maxx: bb.maxx, maxy: bb.maxy });
            });
        });
        return boxes.length ? { frameIdx: issue.frameIdx, boxes: boxes, nodes: nodes } : null;
    }

    // node_swap / duplicate: two tracks; box both, mark crossed nodes if present.
    const trackList = (issue.trackA != null || issue.trackB != null) ? [issue.trackA, issue.trackB] : [issue.trackIdx];
    views.forEach(function (vn) {
        const insts = instancesInView(fg, vn);
        trackList.forEach(function (tk) {
            const inst = pickInstance(insts, tk);
            if (!inst) return;
            const bb = bboxOfInstance(inst);
            if (bb) boxes.push({ view: vn, minx: bb.minx, miny: bb.miny, maxx: bb.maxx, maxy: bb.maxy });
            if (kps) kps.forEach(function (k) { const p = inst.points[k]; if (p) nodes.push({ view: vn, x: p[0], y: p[1] }); });
        });
    });
    if (!boxes.length && !nodes.length) return null;
    return { frameIdx: issue.frameIdx, boxes: boxes, nodes: nodes };
}

// Seek to a flagged frame, focus the relevant camera pane, and draw the orange
// location indicator (box + node arrows) so the user SEES where the error is.
function seekToIssue(issue) {
    const frameIdx = issue.frameIdx;
    try { state.qcHighlight = buildHighlight(state.session, issue); } catch (e) { state.qcHighlight = null; }
    if (videoController) videoController.seekToFrame(frameIdx);
    const view = issue.view || (state.qcHighlight && state.qcHighlight.boxes && state.qcHighlight.boxes[0] && state.qcHighlight.boxes[0].view);
    if (view && paneManager && typeof paneManager.addVideoPanel === 'function') {
        paneManager.addVideoPanel(view);   // activates the pane if docked, else docks it
        if (interactionManager) interactionManager.lastInteractedView = view;
    }
    // Force an overlay redraw so the indicator appears even when the frame didn't change.
    if (typeof drawAllOverlays === 'function') { try { drawAllOverlays(frameIdx); } catch (e) { /* view not ready */ } }
}

// ---------------------------------------------------------------------------
// Navigation (hotkeys + buttons)
// ---------------------------------------------------------------------------

function seekToFlaggedFrame(f) {
    if (f == null) return;
    const r = state.qcResults;
    const issues = r && r.frameIssues ? r.frameIssues.get(f) : null;
    if (issues && issues.length) { seekToIssue(issues[0]); return; }   // seek + highlight
    if (videoController) videoController.seekToFrame(f);
}
export function qcNext() {
    const r = state.qcResults;
    if (!r || !r.flaggedFrames || !r.flaggedFrames.size) return;
    seekToFlaggedFrame(nextFlaggedFrame(r.flaggedFrames, state.currentFrame));
}
export function qcPrev() {
    const r = state.qcResults;
    if (!r || !r.flaggedFrames || !r.flaggedFrames.size) return;
    seekToFlaggedFrame(prevFlaggedFrame(r.flaggedFrames, state.currentFrame));
}

// ---------------------------------------------------------------------------
// Rendering
// ---------------------------------------------------------------------------

function renderNoSession() {
    const summary = el('qcSummary');
    if (summary) summary.innerHTML = '<div class="qc-muted">Load a session with calibrated cameras to run Quality Control.</div>';
    if (el('qcThresholdsSection')) el('qcThresholdsSection').style.display = 'none';
    if (el('qcIssuesSection')) el('qcIssuesSection').style.display = 'none';
}

function scoreClass(score) {
    if (score == null) return '';
    if (score >= 80) return 'good';
    if (score >= 50) return 'warn';
    return 'bad';
}

function renderCurrentFrameResult(frameRes) {
    const summary = el('qcSummary');
    if (!summary) return;
    const covered = frameRes.coverage.triangulated ? 'triangulated' : 'not triangulated (reproj/node-swap/epipolar unavailable)';
    const meanErr = frameRes.meanError != null ? frameRes.meanError.toFixed(2) + ' px' : '—';
    summary.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'qc-frame-head';
    head.innerHTML = '<strong>Frame ' + (frameRes.frameIdx + 1) + '</strong> · ' +
        frameRes.issues.length + ' issue(s) · mean reproj ' + meanErr +
        ' · <span class="qc-muted">' + covered + '</span>';
    summary.appendChild(head);

    const list = document.createElement('div');
    list.className = 'qc-issue-list';
    if (!frameRes.issues.length) {
        const ok = document.createElement('div');
        ok.className = 'qc-ok';
        ok.textContent = 'No issues on this frame.';
        list.appendChild(ok);
    } else {
        frameRes.issues.forEach(function (iss) { list.appendChild(issueRow(iss, true)); });
    }
    summary.appendChild(list);
    // Hide the project-level sections in single-frame mode.
    if (el('qcThresholdsSection')) el('qcThresholdsSection').style.display = 'none';
    if (el('qcIssuesSection')) el('qcIssuesSection').style.display = 'none';
}

export function renderQC() {
    const r = state.qcResults;
    if (!r) return;
    renderSummary(r);
    renderHistograms(r);
    renderTypeFilter(r);
    renderIssueList(r);
}

function renderSummary(r) {
    const summary = el('qcSummary');
    if (!summary) return;
    const g = r.globalStats;
    summary.innerHTML = '';
    const grid = document.createElement('div');
    grid.className = 'qc-stat-grid';
    function stat(label, value, cls) {
        const d = document.createElement('div');
        d.className = 'qc-stat';
        d.innerHTML = '<div class="qc-stat-val ' + (cls || '') + '">' + value + '</div><div class="qc-stat-lbl">' + label + '</div>';
        return d;
    }
    grid.appendChild(stat('QC score', g.score != null ? g.score : '—', scoreClass(g.score)));
    grid.appendChild(stat('Flagged frames', g.flaggedFrameCount + ' / ' + g.totalFrames));
    grid.appendChild(stat('Total issues', g.totalIssues));
    grid.appendChild(stat('Mean reproj', g.meanReprojError != null ? g.meanReprojError.toFixed(2) + 'px' : '—'));
    grid.appendChild(stat('P95 reproj', g.errorP95 != null && isFinite(g.errorP95) ? g.errorP95.toFixed(2) + 'px' : '—'));
    summary.appendChild(grid);

    const cov = document.createElement('div');
    cov.className = 'qc-muted qc-coverage';
    cov.textContent = 'Coverage: ' + r.coverage.triangulated + ' / ' + r.coverage.total +
        ' frames triangulated (2D duplicate/low-node checks cover all frames).';
    summary.appendChild(cov);

    // Issues-by-type chips (click to filter). Show the FULL roster so a type with
    // zero issues still reads "0 ID switches", "0 node swaps", etc. Hover for a
    // one-line explanation of each check (e.g. what an "inversion" is).
    const chips = document.createElement('div');
    chips.className = 'qc-type-chips';
    const allChip = document.createElement('button');
    allChip.className = 'qc-chip' + (_typeFilter === 'all' ? ' active' : '');
    allChip.textContent = 'all (' + g.totalIssues + ')';
    allChip.title = 'Show all issue types';
    allChip.onclick = function () { _typeFilter = 'all'; renderIssueList(r); renderSummary(r); };
    chips.appendChild(allChip);
    ISSUE_TYPES.forEach(function (info) {
        const t = info.type;
        const n = g.issuesByType[t] || 0;
        const c = document.createElement('button');
        c.className = 'qc-chip qc-type-' + t + (_typeFilter === t ? ' active' : '') + (n === 0 ? ' qc-chip-zero' : '');
        c.textContent = info.label + ' (' + n + ')';
        c.title = info.tip;
        c.onclick = function () { if (n === 0 && _typeFilter !== t) return; _typeFilter = (_typeFilter === t ? 'all' : t); renderIssueList(r); renderSummary(r); };
        chips.appendChild(c);
    });
    summary.appendChild(chips);
}

function renderHistograms(r) {
    const section = el('qcThresholdsSection');
    const host = el('qcHistograms');
    if (!section || !host) return;
    host.innerHTML = '';
    let anyData = false;
    HIST_METRICS.forEach(function (m) {
        // Don't show a slider that can't change anything (2D velocity while 2D
        // jitter is disabled) — it just looks broken when dragging does nothing.
        if (m.needs2dJitter && !r.thresholds.enable2dJitter) return;
        const values = r.distributions[m.key] || [];
        if (!values.length) return;
        anyData = true;
        const wrap = document.createElement('div');
        wrap.className = 'qc-hist';
        const label = document.createElement('div');
        label.className = 'qc-hist-label';
        const th = r.thresholds[m.thKey];
        label.innerHTML = '<span>' + m.label + '</span><span class="qc-hist-th" id="qcHistTh_' + m.key + '">' +
            (isFinite(th) ? th.toFixed(m.key === 'iou' ? 2 : 1) : '—') + '</span>';
        wrap.appendChild(label);
        const canvas = document.createElement('canvas');
        canvas.className = 'qc-hist-canvas';
        canvas.width = 300; canvas.height = 70;
        canvas.dataset.metric = m.key;
        canvas.dataset.thkey = m.thKey;
        wrap.appendChild(canvas);
        host.appendChild(wrap);
        drawHistogram(canvas, values, r.thresholds[m.thKey], m.color);
        wireHistogramDrag(canvas, r, m);
    });
    section.style.display = anyData ? '' : 'none';
}

function drawHistogram(canvas, values, threshold, color) {
    const ctx = canvas.getContext('2d');
    const W = canvas.width, H = canvas.height;
    ctx.clearRect(0, 0, W, H);
    const h = buildHistogram(values, threshold, 40);
    if (!h.bins) return;
    canvas._histLayout = { displayMax: h.displayMax };
    const barW = W / h.bins;
    for (let i = 0; i < h.bins; i++) {
        const bh = h.max ? (h.counts[i] / h.max) * (H - 12) : 0;
        ctx.fillStyle = (h.threshBin >= 0 && i >= h.threshBin) ? '#ef4444' : color;
        ctx.globalAlpha = (h.threshBin >= 0 && i >= h.threshBin) ? 0.85 : 0.55;
        ctx.fillRect(i * barW, H - bh - 10, Math.max(1, barW - 0.5), bh);
    }
    ctx.globalAlpha = 1;
    // Threshold line.
    if (threshold != null && isFinite(threshold)) {
        const x = Math.max(0, Math.min(W, (threshold / h.displayMax) * W));
        ctx.strokeStyle = '#f97316';
        ctx.setLineDash([4, 3]);
        ctx.beginPath(); ctx.moveTo(x, 0); ctx.lineTo(x, H); ctx.stroke();
        ctx.setLineDash([]);
    }
    // Outlier count label.
    ctx.fillStyle = '#f97316';
    ctx.font = '10px sans-serif';
    ctx.textAlign = 'right';
    ctx.fillText(h.outlierCount + ' out', W - 3, 10);
}

function wireHistogramDrag(canvas, r, metric) {
    let dragging = false;
    let lastTick = 0;
    function valueFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, (e.clientX - rect.left)));
        const layout = canvas._histLayout || { displayMax: 1 };
        return (x / rect.width) * layout.displayMax;
    }
    // Live (throttled) re-classify so the "Flagged frames" / "Total issues" stats
    // and the per-type chip counts move AS the user drags — makes it obvious the
    // threshold is doing something. Only the cheap summary re-renders here; the
    // (heavier) flagged-frames list waits for mouse-up.
    function liveReclassify() {
        const now = (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
        if (now - lastTick < 150) return;
        lastTick = now;
        classify(r, r.thresholds);
        renderSummary(r);
        updateQCBadge();
    }
    function apply(e, live) {
        const v = valueFromEvent(e);
        r.thresholds[metric.thKey] = v;
        const lbl = el('qcHistTh_' + metric.key);
        if (lbl) lbl.textContent = v.toFixed(metric.key === 'iou' ? 2 : 1);
        drawHistogram(canvas, r.distributions[metric.key], v, metric.color);
        if (live) liveReclassify();
    }
    canvas.addEventListener('mousedown', function (e) { dragging = true; apply(e, true); e.preventDefault(); });
    window.addEventListener('mousemove', function (e) { if (dragging) apply(e, true); });
    window.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        // Final re-classify + full re-render against the dragged thresholds.
        classify(r, r.thresholds);
        renderSummary(r);
        renderTypeFilter(r);
        renderIssueList(r);
        updateQCBadge();
    });
}

function renderTypeFilter(r) {
    const sel = el('qcTypeFilter');
    if (!sel) return;
    const cur = sel.value || 'all';
    sel.innerHTML = '';
    const optAll = document.createElement('option'); optAll.value = 'all'; optAll.textContent = 'All types';
    sel.appendChild(optAll);
    Object.keys(r.issuesByType).sort().forEach(function (t) {
        const o = document.createElement('option'); o.value = t; o.textContent = prettyType(t) + ' (' + r.issuesByType[t] + ')';
        sel.appendChild(o);
    });
    sel.value = (r.issuesByType[cur] || cur === 'all') ? cur : 'all';
}

function issueRow(iss, clickable) {
    const row = document.createElement('div');
    row.className = 'qc-issue qc-sev-' + iss.severity;
    const dot = document.createElement('span');
    dot.className = 'qc-sev-dot qc-sev-dot-' + iss.severity;
    row.appendChild(dot);
    const body = document.createElement('div');
    body.className = 'qc-issue-body';
    body.innerHTML = '<span class="qc-issue-type qc-type-' + iss.type + '">' + prettyType(iss.type) + '</span> ' +
        '<span class="qc-issue-frame">' + fLabel(iss.frameIdx) + '</span> ' +
        '<span class="qc-issue-desc">' + escapeHtml(iss.description || '') + '</span>';
    row.appendChild(body);
    if (clickable && videoController) {
        row.classList.add('qc-clickable');
        row.onclick = function () { seekToIssue(iss); };
    }
    return row;
}

function renderIssueList(r) {
    const section = el('qcIssuesSection');
    const host = el('qcIssueList');
    if (!section || !host) return;
    section.style.display = '';
    host.innerHTML = '';
    const typeSel = el('qcTypeFilter');
    const sevSel = el('qcSevFilter');
    const typeF = typeSel ? typeSel.value : _typeFilter;
    const sevF = sevSel ? sevSel.value : _sevFilter;
    let issues = r.sortedIssues;
    // Summary chips drive _typeFilter too; the dropdown wins if set to non-all.
    const effType = (typeF && typeF !== 'all') ? typeF : _typeFilter;
    if (effType && effType !== 'all') issues = issues.filter(function (i) { return i.type === effType; });
    if (sevF && sevF !== 'all') issues = issues.filter(function (i) { return i.severity === sevF; });

    const runs = groupConsecutiveIssues(issues, 2, 200);
    if (!runs.length) {
        const none = document.createElement('div'); none.className = 'qc-ok'; none.textContent = 'No flagged frames match the filter.';
        host.appendChild(none);
        return;
    }
    runs.forEach(function (run) {
        const row = document.createElement('div');
        row.className = 'qc-issue qc-clickable qc-sev-' + run.severity;
        const dot = document.createElement('span'); dot.className = 'qc-sev-dot qc-sev-dot-' + run.severity; row.appendChild(dot);
        const body = document.createElement('div');
        body.className = 'qc-issue-body';
        const frameLabel = run.startFrame === run.endFrame ? fLabel(run.startFrame) : (fLabel(run.startFrame) + '–' + fLabel(run.endFrame));
        body.innerHTML = '<span class="qc-issue-type qc-type-' + run.type + '">' + prettyType(run.type) + '</span> ' +
            '<span class="qc-issue-frame">' + frameLabel + '</span> ' +
            '<span class="qc-issue-desc">' + escapeHtml(run.description || '') + '</span>' +
            (run.count > 1 ? ' <span class="qc-muted">(' + run.count + ' frames)</span>' : '');
        row.appendChild(body);
        row.onclick = function () { seekToIssue(run.issue || { frameIdx: run.representative, type: run.type, view: run.issue && run.issue.view }); };
        host.appendChild(row);
    });
}

// ---------------------------------------------------------------------------
// Toolbar badge
// ---------------------------------------------------------------------------

export function updateQCBadge() {
    const badge = el('qcBadge');
    if (!badge) return;
    const r = state.qcResults;
    if (!r || !r.globalStats) { badge.style.display = 'none'; return; }
    const n = r.globalStats.flaggedFrameCount;
    badge.style.display = '';
    badge.textContent = n + ' flagged';
    badge.className = 'qc-badge ' + scoreClass(r.globalStats.score);
}

// ---------------------------------------------------------------------------
// Setup / wiring (called once at app init, after setupPanelTabs)
// ---------------------------------------------------------------------------

export function setupQCPanel() {
    // Toolbar QC button: open the QC tab and check the current frame (fast).
    const tbQC = el('tbQC');
    if (tbQC) tbQC.onclick = runQCCurrentFrame;
    const frameBtn = el('qcRunFrameBtn');
    if (frameBtn) frameBtn.onclick = runQCCurrentFrame;
    const projBtn = el('qcRunProjectBtn');
    if (projBtn) projBtn.onclick = runQCProject;
    const prevBtn = el('qcPrevBtn');
    if (prevBtn) prevBtn.onclick = qcPrev;
    const nextBtn = el('qcNextBtn');
    if (nextBtn) nextBtn.onclick = qcNext;
    const typeSel = el('qcTypeFilter');
    if (typeSel) typeSel.onchange = function () { if (state.qcResults) renderIssueList(state.qcResults); };
    const sevSel = el('qcSevFilter');
    if (sevSel) sevSel.onchange = function () { if (state.qcResults) renderIssueList(state.qcResults); };
    // 2D jitter/limb opt-in: toggling after a run re-classifies live (the events are
    // already in the raw store, so no geometry recompute — same as a threshold drag).
    function on2dToggle() {
        const r = state.qcResults;
        if (!r) return;
        apply2dOpts(r.thresholds);
        classify(r, r.thresholds);
        renderSummary(r);
        renderTypeFilter(r);
        renderIssueList(r);
        updateQCBadge();
    }
    const j2d = el('qcEnable2dJitter');
    if (j2d) j2d.onchange = on2dToggle;
    const l2d = el('qcEnable2dLimb');
    if (l2d) l2d.onchange = on2dToggle;
}

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
