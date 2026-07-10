// ui/qc-panel.js — Quality-Control tab in the info panel.
//
// Fully manual: QC compute runs only when the user clicks the QC toolbar button
// / "Check Frame" / "Run Project QC", or presses the QC hotkey. On run we reveal
// and activate the QC tab (showQCTab). Threshold histograms are draggable and
// re-classify live WITHOUT recomputing geometry (qc.classify).
//
// Compute lives in pose/qc.js; this module is pure DOM + wiring.

import { state, videoController, paneManager, interactionManager } from './app-state.js';
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
    { key: 'velocity', thKey: 'velThresh2d', label: '2D temporal velocity (px/frame)', color: '#22c55e' },
    { key: 'limbZ', thKey: 'limbZ', label: 'Limb-length z-score (robust)', color: '#ec4899' },
    { key: 'iou', thKey: 'iouThresh', label: 'Duplicate IOU', color: '#f59e0b' },
];

let _typeFilter = 'all';
let _sevFilter = 'all';

function el(id) { return document.getElementById(id); }

// Human-readable label for an issue type (the raw type stays the CSS class + filter key).
const TYPE_LABELS = {
    node_swap: 'node swap', id_switch: 'ID switch', low_nodes: 'low nodes',
    limb_outlier: 'limb outlier',
};
function prettyType(t) { return TYPE_LABELS[t] || t; }

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
    const session = state.session;
    if (!session) { renderNoSession(); return; }
    const th = apply2dOpts(state.qcResults ? state.qcResults.thresholds : makeThresholds());
    const frameRes = analyzeFrame(session, state.currentFrame, th);
    renderCurrentFrameResult(frameRes);
    updateQCBadge();
}

export async function runQCProject() {
    showQCTab(); // always reveal the tab, even with no session yet
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

// Seek to a flagged frame and, when the issue points at a specific camera view,
// activate that view's pane so the user lands on the exact 2D image being flagged
// (duplicate / low_nodes / 2D jitter / 2D limb all carry a `view`). Issues that
// aren't tied to one view (reprojection, swap, epipolar, 3D metrics) just seek.
function seekToIssue(frameIdx, view) {
    if (videoController) videoController.seekToFrame(frameIdx);
    if (view && paneManager && typeof paneManager.addVideoPanel === 'function') {
        // addVideoPanel activates the pane if the view is already docked, else docks it.
        paneManager.addVideoPanel(view);
        if (interactionManager) interactionManager.lastInteractedView = view;
    }
}

// ---------------------------------------------------------------------------
// Navigation (hotkeys + buttons)
// ---------------------------------------------------------------------------

export function qcNext() {
    const r = state.qcResults;
    if (!r || !r.flaggedFrames || !r.flaggedFrames.size) return;
    const f = nextFlaggedFrame(r.flaggedFrames, state.currentFrame);
    if (f != null && videoController) videoController.seekToFrame(f);
}
export function qcPrev() {
    const r = state.qcResults;
    if (!r || !r.flaggedFrames || !r.flaggedFrames.size) return;
    const f = prevFlaggedFrame(r.flaggedFrames, state.currentFrame);
    if (f != null && videoController) videoController.seekToFrame(f);
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
    head.innerHTML = '<strong>Frame ' + frameRes.frameIdx + '</strong> · ' +
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

    // Issues-by-type chips (click to filter).
    const chips = document.createElement('div');
    chips.className = 'qc-type-chips';
    const types = Object.keys(g.issuesByType).sort();
    if (types.length) {
        const allChip = document.createElement('button');
        allChip.className = 'qc-chip' + (_typeFilter === 'all' ? ' active' : '');
        allChip.textContent = 'all (' + g.totalIssues + ')';
        allChip.onclick = function () { _typeFilter = 'all'; renderIssueList(r); renderSummary(r); };
        chips.appendChild(allChip);
        types.forEach(function (t) {
            const c = document.createElement('button');
            c.className = 'qc-chip qc-type-' + t + (_typeFilter === t ? ' active' : '');
            c.textContent = prettyType(t) + ' (' + g.issuesByType[t] + ')';
            c.onclick = function () { _typeFilter = (_typeFilter === t ? 'all' : t); renderIssueList(r); renderSummary(r); };
            chips.appendChild(c);
        });
    }
    summary.appendChild(chips);
}

function renderHistograms(r) {
    const section = el('qcThresholdsSection');
    const host = el('qcHistograms');
    if (!section || !host) return;
    host.innerHTML = '';
    let anyData = false;
    HIST_METRICS.forEach(function (m) {
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
    function valueFromEvent(e) {
        const rect = canvas.getBoundingClientRect();
        const x = Math.max(0, Math.min(rect.width, (e.clientX - rect.left)));
        const layout = canvas._histLayout || { displayMax: 1 };
        return (x / rect.width) * layout.displayMax;
    }
    function apply(e) {
        const v = valueFromEvent(e);
        r.thresholds[metric.thKey] = v;
        const lbl = el('qcHistTh_' + metric.key);
        if (lbl) lbl.textContent = v.toFixed(metric.key === 'iou' ? 2 : 1);
        drawHistogram(canvas, r.distributions[metric.key], v, metric.color);
    }
    canvas.addEventListener('mousedown', function (e) { dragging = true; apply(e); e.preventDefault(); });
    window.addEventListener('mousemove', function (e) { if (dragging) apply(e); });
    window.addEventListener('mouseup', function () {
        if (!dragging) return;
        dragging = false;
        // Re-classify against the dragged thresholds (no geometry recompute).
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
        '<span class="qc-issue-frame">F' + iss.frameIdx + '</span> ' +
        '<span class="qc-issue-desc">' + escapeHtml(iss.description || '') + '</span>';
    row.appendChild(body);
    if (clickable && videoController) {
        row.classList.add('qc-clickable');
        row.onclick = function () { seekToIssue(iss.frameIdx, iss.view); };
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
        const frameLabel = run.startFrame === run.endFrame ? ('F' + run.startFrame) : ('F' + run.startFrame + '–F' + run.endFrame);
        body.innerHTML = '<span class="qc-issue-type qc-type-' + run.type + '">' + prettyType(run.type) + '</span> ' +
            '<span class="qc-issue-frame">' + frameLabel + '</span> ' +
            '<span class="qc-issue-desc">' + escapeHtml(run.description || '') + '</span>' +
            (run.count > 1 ? ' <span class="qc-muted">(' + run.count + ' frames)</span>' : '');
        row.appendChild(body);
        row.onclick = function () { seekToIssue(run.representative, run.issue && run.issue.view); };
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
