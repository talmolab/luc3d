// pose/qc.js — Quality-Control metrics engine for multi-view 3D pose labels.
//
// Ported and modernized from the old `eric/qc-control` engine (luc3d PR #8). Key
// difference vs the old engine: this one is a pure ES module and it READS the
// per-camera reprojection errors already cached in `state.triangulationResults`
// (populated by `triangulateAndReproject`) instead of recomputing reprojections
// on the main thread every run — which is what made the old engine slow. It only
// (re)triangulates a group when the caller explicitly opts in AND the group is
// missing/stale (`points3d == null || group.dirty`).
//
// Fully manual: nothing here runs until the UI (ui/qc-panel.js) invokes it.
//
// Metrics: reprojection error, epipolar distance, node-switch/inversion, identity
// swap (cross-instance, symmetric), IOU duplicate-instance (2D, pre-grouping),
// low-node-count (2D), completeness/miss, limb-length consistency, temporal jitter.
//
// The engine separates METRICS (threshold-independent, computed once) from
// CLASSIFICATION (thresholded → issues). `classify()` re-runs cheaply on threshold
// drag without recomputing any geometry.

import { state } from '../ui/app-state.js';
import {
    computeFundamentalMatrix,
    triangulateAndReproject,
    getInstanceGroupsForFrame,
    ensureGroupsFromIdentities,
} from './triangulation.js';

// ---------------------------------------------------------------------------
// Defaults / config
// ---------------------------------------------------------------------------

export const QC_DEFAULTS = {
    reprojLow: 2,          // px — green
    reprojMed: 5,          // px — yellow
    reprojHigh: 10,        // px — red / outlier (overridden by auto P95 at runtime)
    epiThresh: 10,         // px — epipolar-distance outlier (auto P95)
    velThresh: null,       // 3D units/frame — jitter (auto P95)
    limbCV: 0.15,          // coefficient-of-variation flag for limb length
    limbZ: 3.0,            // per-frame limb-length z-score outlier
    minCameras: 2,         // a node visible in < this many cams => "miss"
    // Swap (cross-instance identity) detection.
    swapMarginRatio: 0.8,  // a kp "crosses" if d(own reproj) beats d(other reproj) by this
    swapMinErr: 5,         // px — only consider kps whose own fit is already this poor
    swapHighCount: 3,      // >= this many crossed kps => high severity
    // IOU duplicate-instance (2D, per view).
    iouThresh: 0.9,        // bbox IOU above this => duplicate candidate
    dupPx: 5,              // mean per-node distance below this => duplicate candidate
    dupNodeFrac: 0.6,      // ... over at least this fraction of shared visible nodes
    // Low-node-count.
    minNodesAbs: 2,        // absolute floor
    minNodesFrac: 0.3,     // ... or this fraction of the skeleton, whichever is larger
    // Auto-thresholding / sampling.
    autoPercentile: 95,
    epiSampleMax: 5000,    // cap frames scanned for epipolar (stride + subsample)
    histSampleMax: 10000,  // cap distribution arrays fed to histograms
    // Composite-score weights.
    weights: { reprojection: 0.35, completeness: 0.25, limbLength: 0.20, temporal: 0.20 },
};

export function makeThresholds(overrides) {
    return Object.assign({}, QC_DEFAULTS, overrides || {});
}

// ---------------------------------------------------------------------------
// Small math utilities
// ---------------------------------------------------------------------------

function dist2d(a, b) { const dx = a[0] - b[0], dy = a[1] - b[1]; return Math.sqrt(dx * dx + dy * dy); }
function dist3d(a, b) { const dx = a[0] - b[0], dy = a[1] - b[1], dz = a[2] - b[2]; return Math.sqrt(dx * dx + dy * dy + dz * dz); }
function mean(arr) { if (!arr.length) return null; let s = 0; for (let i = 0; i < arr.length; i++) s += arr[i]; return s / arr.length; }
function stddev(arr) { if (arr.length < 2) return 0; const m = mean(arr); let s = 0; for (let i = 0; i < arr.length; i++) { const d = arr[i] - m; s += d * d; } return Math.sqrt(s / (arr.length - 1)); }
function sortedCopy(arr) { return arr.slice().sort(function (a, b) { return a - b; }); }
function median(arr) { if (!arr.length) return 0; const s = sortedCopy(arr); const n = s.length; return n % 2 ? s[(n - 1) / 2] : (s[n / 2 - 1] + s[n / 2]) / 2; }
// Percentile over an ALREADY-SORTED ascending array (linear interpolation).
function percentileSorted(s, p) {
    if (!s.length) return Infinity;
    if (s.length === 1) return s[0];
    const idx = (p / 100) * (s.length - 1);
    const lo = Math.floor(idx), hi = Math.ceil(idx);
    if (lo === hi) return s[lo];
    return s[lo] + (s[hi] - s[lo]) * (idx - lo);
}
export function percentile(arr, p) { return percentileSorted(sortedCopy(arr), p); }

// Stride-subsample an array down to at most `maxN`, preserving distribution shape.
function subsample(arr, maxN) {
    if (arr.length <= maxN) return arr.slice();
    const out = [];
    const stride = arr.length / maxN;
    for (let i = 0; i < maxN; i++) out.push(arr[Math.floor(i * stride)]);
    return out;
}

// Axis-aligned bbox over visible (non-null) points; null if < 1 point.
function bboxOf(points) {
    let minx = Infinity, miny = Infinity, maxx = -Infinity, maxy = -Infinity, n = 0;
    for (let i = 0; i < points.length; i++) {
        const p = points[i];
        if (p == null) continue;
        n++;
        if (p[0] < minx) minx = p[0];
        if (p[1] < miny) miny = p[1];
        if (p[0] > maxx) maxx = p[0];
        if (p[1] > maxy) maxy = p[1];
    }
    return n ? { minx, miny, maxx, maxy } : null;
}

function bboxIOU(a, b) {
    if (!a || !b) return 0;
    const ix = Math.max(0, Math.min(a.maxx, b.maxx) - Math.max(a.minx, b.minx));
    const iy = Math.max(0, Math.min(a.maxy, b.maxy) - Math.max(a.miny, b.miny));
    const inter = ix * iy;
    const areaA = Math.max(0, a.maxx - a.minx) * Math.max(0, a.maxy - a.miny);
    const areaB = Math.max(0, b.maxx - b.minx) * Math.max(0, b.maxy - b.miny);
    const union = areaA + areaB - inter;
    return union > 1e-9 ? inter / union : (inter > 0 ? 1 : 0);
}

function nodeLabel(session, k) {
    const nodes = session && session.skeleton && session.skeleton.nodes;
    return (nodes && nodes[k]) ? nodes[k] : ('kp' + k);
}
function trackLabel(session, trackIdx) {
    if (trackIdx == null || trackIdx < 0) return 'untracked';
    const t = session && session.tracks && session.tracks[trackIdx];
    return t != null ? String(t) : ('track ' + trackIdx);
}

// ---------------------------------------------------------------------------
// Per-frame RAW metric extraction (threshold-independent)
// ---------------------------------------------------------------------------
//
// Produces a compact `FrameRaw` capturing only candidate signals, so `classify()`
// can threshold without recompute and memory stays bounded (clean frames store
// nothing). Reads cached reprojection errors; runs 2D detectors on raw per-view
// instances (works before identities/grouping/triangulation exist).

// Collect every 2D Instance in a given camera view (grouped + unlinked).
function instancesInView(frameGroup, camName) {
    const out = [];
    const linked = frameGroup.instances.get(camName);
    if (linked) for (let i = 0; i < linked.length; i++) out.push(linked[i]);
    const unlinked = frameGroup.unlinkedInstances.get(camName);
    if (unlinked) for (let i = 0; i < unlinked.length; i++) out.push(unlinked[i].instance);
    return out;
}

function countVisible(points) {
    let n = 0;
    for (let i = 0; i < points.length; i++) if (points[i] != null) n++;
    return n;
}

// 2D detectors over a FrameGroup: duplicates (IOU + node-distance) and low-node-count.
function extract2D(session, frameGroup, numNodes) {
    const cameras = session.cameras;
    const duplicates = [];
    const lowNodes = [];
    for (let c = 0; c < cameras.length; c++) {
        const camName = cameras[c].name;
        const insts = instancesInView(frameGroup, camName);
        // Low-node-count.
        for (let i = 0; i < insts.length; i++) {
            const vis = countVisible(insts[i].points);
            lowNodes.push({ view: camName, trackIdx: insts[i].trackIdx, visibleNodes: vis, numNodes: numNodes });
        }
        // Duplicate detection — pairwise within the view.
        for (let a = 0; a < insts.length; a++) {
            for (let b = a + 1; b < insts.length; b++) {
                const pa = insts[a].points, pb = insts[b].points;
                // Shared visible nodes.
                let shared = 0, sumd = 0;
                const len = Math.min(pa.length, pb.length);
                for (let k = 0; k < len; k++) {
                    if (pa[k] != null && pb[k] != null) { shared++; sumd += dist2d(pa[k], pb[k]); }
                }
                if (shared === 0) continue;
                const meanNodeDist = sumd / shared;
                const totalVis = Math.min(countVisible(pa), countVisible(pb));
                const sharedFrac = totalVis ? shared / totalVis : 0;
                const iou = bboxIOU(bboxOf(pa), bboxOf(pb));
                duplicates.push({
                    view: camName,
                    trackA: insts[a].trackIdx, trackB: insts[b].trackIdx,
                    iou: iou, meanNodeDist: meanNodeDist, sharedFrac: sharedFrac,
                });
            }
        }
    }
    return { duplicates, lowNodes };
}

// Per-group reprojection raw signals from a cached triangulation result entry.
// `entry` = { group, errors:{cam:[err|null]}, meanError, ... }.
function extractReprojGroup(entry, reprojLowFloor) {
    const errors = entry.errors;
    if (!errors) return null;
    const camNames = Object.keys(errors);
    let numKp = 0;
    for (let c = 0; c < camNames.length; c++) numKp = Math.max(numKp, errors[camNames[c]].length);
    const perNode = new Array(numKp).fill(null);
    const perNodeCam = new Array(numKp).fill(null); // only for candidate nodes
    const camSeen = new Array(numKp).fill(0);
    for (let k = 0; k < numKp; k++) {
        const vals = [];
        const camErrs = [];
        for (let c = 0; c < camNames.length; c++) {
            const e = errors[camNames[c]][k];
            if (e != null) { vals.push(e); camErrs.push({ cam: camNames[c], err: e }); }
        }
        camSeen[k] = camErrs.length;
        if (vals.length) {
            const m = mean(vals);
            perNode[k] = m;
            if (m > reprojLowFloor) perNodeCam[k] = camErrs; // bound memory
        }
    }
    return {
        trackIdx: entry.group ? entry.group.instances.values().next().value?.trackIdx ?? null : null,
        identityId: entry.group ? entry.group.identityId : -1,
        meanError: entry.meanError != null ? entry.meanError : mean(perNode.filter(function (v) { return v != null; })),
        perNode: perNode,
        perNodeCam: perNodeCam,
        camSeen: camSeen,
        numKp: numKp,
    };
}

// Symmetric cross-instance swap raw margins for a frame's triangulation entries.
// Uses cached `group.reprojectedInstances` (observed vs each group's reprojection).
function extractSwaps(entries, minErr) {
    const swaps = [];
    for (let a = 0; a < entries.length; a++) {
        for (let b = a + 1; b < entries.length; b++) {
            const gA = entries[a].group, gB = entries[b].group;
            if (!gA || !gB) continue;
            const repA = entries[a].reprojections || gA.reprojections;
            const repB = entries[b].reprojections || gB.reprojections;
            if (!repA || !repB) continue;
            const kpMargins = [];
            const cams = Object.keys(repA);
            for (let ci = 0; ci < cams.length; ci++) {
                const cam = cams[ci];
                if (!repB[cam]) continue;
                const instA = gA.getInstance(cam), instB = gB.getInstance(cam);
                if (!instA || !instB || !instA.points || !instB.points) continue;
                const nk = Math.min(instA.points.length, instB.points.length, repA[cam].length, repB[cam].length);
                for (let k = 0; k < nk; k++) {
                    const dA = instA.points[k], dB = instB.points[k];
                    const rA = repA[cam][k], rB = repB[cam][k];
                    if (!dA || !dB || !rA || !rB) continue;
                    const dAA = dist2d(dA, rA), dAB = dist2d(dA, rB);
                    const dBB = dist2d(dB, rB), dBA = dist2d(dB, rA);
                    if (dAA <= minErr && dBB <= minErr) continue; // both fits already good
                    kpMargins.push({ kp: k, cam: cam, dAA, dAB, dBB, dBA });
                }
            }
            if (kpMargins.length) {
                swaps.push({
                    trackA: gA.instances.values().next().value?.trackIdx ?? null,
                    trackB: gB.instances.values().next().value?.trackIdx ?? null,
                    kpMargins: kpMargins,
                });
            }
        }
    }
    return swaps;
}

// ---------------------------------------------------------------------------
// Classification (threshold-dependent) — cheap, re-runnable on drag
// ---------------------------------------------------------------------------

function classifyFrame(session, fr, th) {
    const issues = [];
    const nodeNames = session.skeleton ? session.skeleton.nodes : [];

    // --- 3D-derived issues (reprojection, inversion, epipolar, miss) ---
    if (fr.groups) {
        for (let gi = 0; gi < fr.groups.length; gi++) {
            const g = fr.groups[gi];
            // Missing nodes.
            const missing = [];
            for (let k = 0; k < g.numKp; k++) {
                if (g.camSeen[k] > 0 && g.camSeen[k] < th.minCameras) missing.push(k);
            }
            if (missing.length) {
                issues.push({
                    type: 'miss', severity: 'medium', frameIdx: fr.frameIdx, trackIdx: g.trackIdx,
                    keypoints: missing,
                    description: missing.map(function (k) { return nodeNames[k] || ('kp' + k); }).join(', ') +
                        ' — visible in < ' + th.minCameras + ' cameras',
                });
            }
            // Reprojection outliers → reprojection vs inversion.
            for (let k = 0; k < g.numKp; k++) {
                const m = g.perNode[k];
                if (m == null || m <= th.reprojHigh) continue;
                const camErrs = g.perNodeCam[k];
                let isInversion = false, desc;
                const kpName = nodeNames[k] || ('kp' + k);
                if (camErrs && camErrs.length >= 2) {
                    const sorted = camErrs.slice().sort(function (x, y) { return y.err - x.err; });
                    const worst = sorted[0];
                    const otherMed = median(sorted.slice(1).map(function (c) { return c.err; }));
                    if (worst.err > otherMed * 3 && otherMed < 3) isInversion = true;
                    desc = kpName + ': ' + worst.err.toFixed(1) + 'px in ' + worst.cam +
                        ' (vs ' + sorted.slice(1).map(function (c) { return c.cam + ': ' + c.err.toFixed(1); }).join(', ') + ')';
                } else {
                    desc = kpName + ': ' + m.toFixed(1) + 'px reprojection error';
                }
                issues.push({
                    type: isInversion ? 'inversion' : 'reprojection', severity: 'high',
                    frameIdx: fr.frameIdx, trackIdx: g.trackIdx, keypoints: [k],
                    description: desc + (isInversion ? ' — possible mislabel' : ''),
                });
            }
            // Epipolar (only present on sampled frames).
            if (g.epiPerNode) {
                const flagged = [];
                for (let k = 0; k < g.epiPerNode.length; k++) {
                    if (g.epiPerNode[k] != null && g.epiPerNode[k] > th.epiThresh) flagged.push(k);
                }
                if (flagged.length) {
                    issues.push({
                        type: 'epipolar', severity: 'medium', frameIdx: fr.frameIdx, trackIdx: g.trackIdx,
                        keypoints: flagged,
                        description: flagged.map(function (k) { return nodeNames[k] || ('kp' + k); }).join(', ') +
                            ' — high epipolar distance',
                    });
                }
            }
        }
    }

    // --- Swap ---
    if (fr.swaps) {
        for (let si = 0; si < fr.swaps.length; si++) {
            const sw = fr.swaps[si];
            const crossed = [];
            for (let m = 0; m < sw.kpMargins.length; m++) {
                const km = sw.kpMargins[m];
                // Symmetric: A's detection nearer B's reprojection AND B's nearer A's.
                if (km.dAB < km.dAA * th.swapMarginRatio && km.dBA < km.dBB * th.swapMarginRatio) {
                    if (crossed.indexOf(km.kp) < 0) crossed.push(km.kp);
                }
            }
            if (crossed.length) {
                issues.push({
                    type: 'swap', severity: crossed.length >= th.swapHighCount ? 'high' : 'medium',
                    frameIdx: fr.frameIdx, trackA: sw.trackA, trackB: sw.trackB, keypoints: crossed,
                    description: 'Possible identity swap between ' + trackLabel(session, sw.trackA) +
                        ' and ' + trackLabel(session, sw.trackB) + ' (' + crossed.length + ' keypoint(s) crossed)',
                });
            }
        }
    }

    // --- Duplicate (2D) ---
    if (fr.duplicates) {
        for (let di = 0; di < fr.duplicates.length; di++) {
            const d = fr.duplicates[di];
            const iouHit = d.iou >= th.iouThresh;
            const distHit = d.meanNodeDist <= th.dupPx && d.sharedFrac >= th.dupNodeFrac;
            if (iouHit || distHit) {
                issues.push({
                    type: 'duplicate', severity: (iouHit && distHit) ? 'high' : 'medium',
                    frameIdx: fr.frameIdx, view: d.view, trackA: d.trackA, trackB: d.trackB,
                    values: { iou: d.iou, meanNodeDist: d.meanNodeDist },
                    description: 'Duplicate instances in ' + d.view + ' (IOU ' + d.iou.toFixed(2) +
                        ', mean node dist ' + d.meanNodeDist.toFixed(1) + 'px)',
                });
            }
        }
    }

    // --- Low node count (2D) ---
    if (fr.lowNodes) {
        const numNodes = fr.lowNodes.length ? fr.lowNodes[0].numNodes : 0;
        const minNodes = Math.max(th.minNodesAbs, Math.floor(th.minNodesFrac * numNodes));
        for (let li = 0; li < fr.lowNodes.length; li++) {
            const ln = fr.lowNodes[li];
            if (ln.visibleNodes < minNodes) {
                issues.push({
                    type: 'low_nodes', severity: ln.visibleNodes <= th.minNodesAbs ? 'high' : 'medium',
                    frameIdx: fr.frameIdx, trackIdx: ln.trackIdx, view: ln.view,
                    values: { visibleNodes: ln.visibleNodes, minNodes: minNodes },
                    description: trackLabel(session, ln.trackIdx) + ' in ' + ln.view + ': only ' +
                        ln.visibleNodes + '/' + numNodes + ' nodes',
                });
            }
        }
    }

    // --- Temporal jitter (per track in 2D; per identity in 3D) ---
    if (fr.temporal && th.velThresh != null && isFinite(th.velThresh)) {
        for (let ti = 0; ti < fr.temporal.length; ti++) {
            const t = fr.temporal[ti];
            if (t.velocity > th.velThresh) {
                issues.push({
                    type: 'jitter', severity: 'medium', frameIdx: fr.frameIdx, trackIdx: t.trackIdx, view: t.view,
                    keypoints: [],
                    description: 'High ' + t.space + ' displacement' + (t.view ? (' in ' + t.view) : '') +
                        ' for ' + t.label + ' (v=' + t.velocity.toFixed(2) + (t.space === '2d' ? ' px/f)' : ' u/f)'),
                });
            }
        }
    }

    // --- Limb-length outlier (per track in 2D; per identity in 3D) ---
    if (fr.limb) {
        for (let li = 0; li < fr.limb.length; li++) {
            const lb = fr.limb[li];
            const bad = lb.edges.filter(function (e) { return e.z > th.limbZ; });
            if (bad.length) {
                issues.push({
                    type: 'limb_outlier', severity: bad.some(function (e) { return e.z > 5; }) ? 'high' : 'medium',
                    frameIdx: fr.frameIdx, trackIdx: lb.trackIdx, view: lb.view, keypoints: [],
                    description: 'Abnormal ' + lb.space + ' limb length' + (lb.view ? (' in ' + lb.view) : '') +
                        ' (' + lb.label + '): ' + bad.map(function (e) { return 'edge ' + e.edge + ' (z=' + e.z.toFixed(1) + ')'; }).join(', '),
                });
            }
        }
    }

    return issues;
}

// Re-run classification over stored raw per-frame data (no geometry recompute).
export function classify(rawResult, thresholds) {
    const session = rawResult.session;
    const th = thresholds || rawResult.thresholds;
    const frameIssues = new Map();
    const flaggedFrames = new Set();
    const sortedIssues = [];
    const issuesByType = {};
    for (const [frameIdx, fr] of rawResult.raw.perFrame) {
        const issues = classifyFrame(session, fr, th);
        if (issues.length) {
            frameIssues.set(frameIdx, issues);
            flaggedFrames.add(frameIdx);
            for (let i = 0; i < issues.length; i++) {
                sortedIssues.push(issues[i]);
                issuesByType[issues[i].type] = (issuesByType[issues[i].type] || 0) + 1;
            }
        }
    }
    const sevRank = { high: 0, medium: 1, low: 2 };
    sortedIssues.sort(function (a, b) {
        const s = (sevRank[a.severity] || 3) - (sevRank[b.severity] || 3);
        return s !== 0 ? s : a.frameIdx - b.frameIdx;
    });
    const globalStats = {
        totalFrames: rawResult.coverage.total,
        triangulatedFrames: rawResult.coverage.triangulated,
        flaggedFrameCount: flaggedFrames.size,
        totalIssues: sortedIssues.length,
        meanReprojError: rawResult.globalStats ? rawResult.globalStats.meanReprojError : null,
        errorP95: rawResult.globalStats ? rawResult.globalStats.errorP95 : null,
        issuesByType: issuesByType,
        score: rawResult.globalStats ? rawResult.globalStats.score : null,
    };
    rawResult.frameIssues = frameIssues;
    rawResult.flaggedFrames = flaggedFrames;
    rawResult.sortedIssues = sortedIssues;
    rawResult.issuesByType = issuesByType;
    rawResult.globalStats = globalStats;
    rawResult.thresholds = th;
    return rawResult;
}

// ---------------------------------------------------------------------------
// Single-frame analysis (Tier A — instant, current frame)
// ---------------------------------------------------------------------------

export function analyzeFrame(session, frameIdx, thresholds) {
    const th = thresholds || makeThresholds();
    const numNodes = session.skeleton ? session.skeleton.nodes.length : 0;
    const fr = { frameIdx: frameIdx };

    const frameGroup = session.frameGroups.get(frameIdx);
    if (frameGroup) {
        const two = extract2D(session, frameGroup, numNodes);
        fr.duplicates = two.duplicates;
        fr.lowNodes = two.lowNodes;
    }
    const entries = state.triangulationResults.get(frameIdx);
    let triangulated = false;
    if (entries && entries.length) {
        fr.groups = [];
        for (let i = 0; i < entries.length; i++) {
            const g = extractReprojGroup(entries[i], th.reprojLow);
            if (g) { fr.groups.push(g); triangulated = true; }
        }
        fr.swaps = extractSwaps(entries, th.swapMinErr);
    }

    const issues = classifyFrame(session, fr, th);
    const meanError = entries && entries.length ? mean(entries.map(function (e) { return e.meanError; }).filter(function (v) { return v != null; })) : null;
    return {
        frameIdx: frameIdx,
        issues: issues,
        meanError: meanError,
        coverage: { triangulated: triangulated ? 1 : 0, total: 1 },
    };
}

// ---------------------------------------------------------------------------
// Project sweep (Tier B — distributions, histograms, global metrics)
// ---------------------------------------------------------------------------

export async function runProjectQC(session, opts, onProgress) {
    opts = opts || {};
    const th = opts.thresholds || makeThresholds();
    const triangulateMissing = !!opts.triangulateMissing;
    const method = opts.method || 'dlt';
    const numNodes = session.skeleton ? session.skeleton.nodes.length : 0;

    // Frame set = union of frames that have raw 2D groups or triangulation groups.
    const frameSet = new Set();
    for (const f of session.frameGroups.keys()) frameSet.add(f);
    for (const f of session.instanceGroups.keys()) frameSet.add(f);
    const frames = Array.from(frameSet).sort(function (a, b) { return a - b; });

    // Precompute fundamental matrices for all camera pairs (epipolar).
    const cameras = session.cameras || [];
    const Fcache = {};
    for (let i = 0; i < cameras.length; i++) {
        for (let j = i + 1; j < cameras.length; j++) {
            try { Fcache[cameras[i].name + '|' + cameras[j].name] = computeFundamentalMatrix(cameras[i], cameras[j]); } catch (e) { /* degenerate */ }
        }
    }
    // Epipolar subsample set.
    const epiSet = new Set();
    if (frames.length <= th.epiSampleMax) {
        for (let i = 0; i < frames.length; i++) epiSet.add(frames[i]);
    } else {
        const stride = frames.length / th.epiSampleMax;
        for (let i = 0; i < th.epiSampleMax; i++) epiSet.add(frames[Math.floor(i * stride)]);
    }

    const perFrame = new Map();
    const distributions = { reproj: [], epipolar: [], velocity: [], limbZ: [], iou: [] };
    let triangulatedCount = 0;
    let triCalls = 0; // spy: how many times we actually (re)triangulated

    // Time series for temporal jitter + limb length:
    //   series2d: "view|trackIdx" -> [{frameIdx, points, view, trackIdx}]  (always, needs tracks)
    //   series3d: identityId       -> [{frameIdx, points3d, identityId}]    (only when identities exist)
    const series2d = new Map();
    const series3d = new Map();
    const YIELD_EVERY = 500;
    for (let fi = 0; fi < frames.length; fi++) {
        const frameIdx = frames[fi];
        const fr = { frameIdx: frameIdx };

        // 2D detectors.
        const frameGroup = session.frameGroups.get(frameIdx);
        if (frameGroup) {
            const two = extract2D(session, frameGroup, numNodes);
            fr.duplicates = two.duplicates;
            fr.lowNodes = two.lowNodes;
            for (let d = 0; d < two.duplicates.length; d++) distributions.iou.push(two.duplicates[d].iou);
            // Accumulate 2D per-track series (one pose per view+track per frame).
            for (let c = 0; c < cameras.length; c++) {
                const camName = cameras[c].name;
                const insts = instancesInView(frameGroup, camName);
                const seenTrack = new Set();
                for (let i = 0; i < insts.length; i++) {
                    const tk = insts[i].trackIdx;
                    if (tk == null || tk < 0) continue;
                    const key = camName + '|' + tk;
                    if (seenTrack.has(key)) continue;
                    seenTrack.add(key);
                    let arr = series2d.get(key);
                    if (!arr) { arr = []; series2d.set(key, arr); }
                    arr.push({ frameIdx: frameIdx, points: insts[i].points, view: camName, trackIdx: tk });
                }
            }
        }

        // 3D metrics from cache (optionally triangulate missing/dirty).
        let entries = state.triangulationResults.get(frameIdx);
        if ((!entries || !entries.length) && triangulateMissing) {
            entries = triangulateFrameForQC(session, frameIdx, method);
            if (entries && entries.length) triCalls += entries.length;
        } else if (triangulateMissing && entries) {
            // Re-triangulate any dirty/missing group in-place, updating the cache.
            const groups = getInstanceGroupsForFrame(frameIdx);
            let changed = false;
            for (let gi = 0; gi < groups.length; gi++) {
                if (groups[gi].points3d != null && !groups[gi].dirty) continue;
                const res = triangulateAndReproject(groups[gi], cameras, { method: method });
                triCalls++;
                groups[gi].points3d = res.points3d;
                groups[gi].reprojections = res.reprojections;
                if (groups[gi].markClean) groups[gi].markClean();
                const newEntry = { group: groups[gi], points3d: res.points3d, reprojections: res.reprojections, errors: res.errors, errorsUndistorted: res.errorsUndistorted, meanError: res.meanError, method: method };
                let matched = false;
                for (let ei = 0; ei < entries.length; ei++) {
                    if (entries[ei].group === groups[gi]) { entries[ei] = newEntry; matched = true; break; }
                }
                if (!matched) entries.push(newEntry);
                changed = true;
            }
            if (changed) state.triangulationResults.set(frameIdx, entries);
        }

        if (entries && entries.length) {
            fr.groups = [];
            for (let i = 0; i < entries.length; i++) {
                const g = extractReprojGroup(entries[i], th.reprojLow);
                if (!g) continue;
                fr.groups.push(g);
                if (g.meanError != null) distributions.reproj.push(g.meanError);
                // Epipolar per node on sampled frames.
                if (epiSet.has(frameIdx) && entries[i].group) {
                    g.epiPerNode = epipolarPerNode(entries[i].group, cameras, Fcache);
                    if (g.epiPerNode) for (let k = 0; k < g.epiPerNode.length; k++) if (g.epiPerNode[k] != null) distributions.epipolar.push(g.epiPerNode[k]);
                }
            }
            fr.swaps = extractSwaps(entries, th.swapMinErr);
            if (fr.groups.length) triangulatedCount++;
            // Accumulate 3D per-identity series (only when the group carries an identity).
            for (let i = 0; i < entries.length; i++) {
                const eg = entries[i].group;
                if (!eg || eg.identityId == null || eg.identityId < 0 || !entries[i].points3d) continue;
                let arr = series3d.get(eg.identityId);
                if (!arr) { arr = []; series3d.set(eg.identityId, arr); }
                arr.push({ frameIdx: frameIdx, points3d: entries[i].points3d, identityId: eg.identityId });
            }
        }

        // Store only frames that carry any candidate signal.
        if ((fr.groups && fr.groups.length) || (fr.duplicates && fr.duplicates.length) ||
            (fr.lowNodes && fr.lowNodes.length) || (fr.swaps && fr.swaps.length)) {
            perFrame.set(frameIdx, fr);
        }

        if (onProgress && (fi % YIELD_EVERY === 0)) onProgress(fi, frames.length);
        if (fi % YIELD_EVERY === 0) await new Promise(function (r) { setTimeout(r, 0); });
    }
    if (onProgress) onProgress(frames.length, frames.length);

    // Temporal jitter + limb-length: 2D per track (always), 3D per identity (if any).
    const edges = session.skeleton ? session.skeleton.edges : [];
    const tl2d = analyzeSeries(series2d, edges, '2d');
    const tl3d = analyzeSeries(series3d, edges, '3d');
    series2d.clear();
    series3d.clear();
    for (let i = 0; i < tl2d.velDist.length; i++) distributions.velocity.push(tl2d.velDist[i]);
    for (let i = 0; i < tl3d.velDist.length; i++) distributions.velocity.push(tl3d.velDist[i]);
    for (let i = 0; i < tl2d.limbZDist.length; i++) distributions.limbZ.push(tl2d.limbZDist[i]);
    for (let i = 0; i < tl3d.limbZDist.length; i++) distributions.limbZ.push(tl3d.limbZDist[i]);
    mergeTemporal(perFrame, tl2d, session, '2d');
    mergeTemporal(perFrame, tl3d, session, '3d');

    // Auto-thresholds (P95) — seed thresholds the user can then drag.
    const auto = computeAutoThresholds(distributions, th.autoPercentile);
    const effective = makeThresholds(Object.assign({}, th, {
        reprojHigh: isFinite(auto.reproj) ? auto.reproj : th.reprojHigh,
        epiThresh: isFinite(auto.epipolar) ? auto.epipolar : th.epiThresh,
        velThresh: isFinite(auto.velocity) ? auto.velocity : th.velThresh,
    }));

    const sortedReproj = sortedCopy(distributions.reproj);
    const result = {
        session: session,
        raw: { perFrame: perFrame },
        distributions: {
            reproj: subsample(distributions.reproj, th.histSampleMax),
            epipolar: subsample(distributions.epipolar, th.histSampleMax),
            velocity: subsample(distributions.velocity, th.histSampleMax),
            limbZ: subsample(distributions.limbZ, th.histSampleMax),
            iou: subsample(distributions.iou, th.histSampleMax),
        },
        autoThresholds: auto,
        coverage: { triangulated: triangulatedCount, total: frames.length },
        thresholds: effective,
        triCalls: triCalls,
        globalStats: {
            meanReprojError: mean(distributions.reproj),
            errorP95: percentileSorted(sortedReproj, 95),
        },
    };
    // Composite 0–100 score: 100·(1 − meanErr/high), clamped.
    const me = result.globalStats.meanReprojError;
    result.globalStats.score = me == null ? null : Math.max(0, Math.min(100, Math.round(100 * (1 - me / (effective.reprojHigh || 10)))));

    classify(result, effective);
    return result;
}

// Triangulate all groups of a frame for QC (opt-in path); returns entry array.
function triangulateFrameForQC(session, frameIdx, method) {
    ensureGroupsFromIdentities(session, frameIdx);
    const groups = getInstanceGroupsForFrame(frameIdx);
    const cameras = session.cameras;
    const entries = [];
    for (let i = 0; i < groups.length; i++) {
        const res = triangulateAndReproject(groups[i], cameras, { method: method });
        groups[i].points3d = res.points3d;
        groups[i].reprojections = res.reprojections;
        groups[i].markClean && groups[i].markClean();
        entries.push({ group: groups[i], points3d: res.points3d, reprojections: res.reprojections, errors: res.errors, errorsUndistorted: res.errorsUndistorted, meanError: res.meanError, method: method });
    }
    state.triangulationResults.set(frameIdx, entries);
    return entries;
}

// Per-node epipolar distance for a group: mean point-to-epiline over camera pairs.
function epipolarPerNode(group, cameras, Fcache) {
    const camNames = group.cameraNames;
    if (camNames.length < 2) return null;
    let numKp = 0;
    for (let c = 0; c < camNames.length; c++) {
        const inst = group.getInstance(camNames[c]);
        if (inst && inst.points) { numKp = inst.points.length; break; }
    }
    if (!numKp) return null;
    const out = new Array(numKp).fill(null);
    for (let k = 0; k < numKp; k++) {
        const dists = [];
        for (let i = 0; i < camNames.length; i++) {
            for (let j = i + 1; j < camNames.length; j++) {
                const key = camNames[i] + '|' + camNames[j];
                let F = Fcache[key], swap = false;
                if (!F) { F = Fcache[camNames[j] + '|' + camNames[i]]; swap = true; }
                if (!F) continue;
                const ia = group.getInstance(camNames[i]), ib = group.getInstance(camNames[j]);
                if (!ia || !ib || !ia.points[k] || !ib.points[k]) continue;
                const p1 = swap ? ib.points[k] : ia.points[k];
                const p2 = swap ? ia.points[k] : ib.points[k];
                const la = F[0][0] * p1[0] + F[0][1] * p1[1] + F[0][2];
                const lb = F[1][0] * p1[0] + F[1][1] * p1[1] + F[1][2];
                const lc = F[2][0] * p1[0] + F[2][1] * p1[1] + F[2][2];
                const den = Math.sqrt(la * la + lb * lb);
                if (den > 1e-12) dists.push(Math.abs(p2[0] * la + p2[1] * lb + lc) / den);
            }
        }
        if (dists.length) out[k] = mean(dists);
    }
    return out;
}

// ---------------------------------------------------------------------------
// Temporal jitter + limb length (per-series analysis)
// ---------------------------------------------------------------------------

// Mean per-node displacement between two poses, normalized by the frame gap.
function meanNodeVelocity(cur, prev, space, dt) {
    let s = 0, n = 0;
    const len = Math.min(cur.length, prev.length);
    for (let k = 0; k < len; k++) {
        const a = cur[k], b = prev[k];
        if (a == null || b == null) continue;
        s += (space === '3d') ? dist3d(a, b) : dist2d(a, b);
        n++;
    }
    return n ? (s / n) / dt : null;
}

// Analyze a set of time series (one per track/identity). Returns velocity events,
// limb-length z-score events, and their distributions. `space` = '2d' | '3d'.
function analyzeSeries(seriesMap, edges, space) {
    const getPoints = (space === '3d') ? function (it) { return it.points3d; } : function (it) { return it.points; };
    const velEvents = [], limbEvents = [], velDist = [], limbZDist = [];
    for (const [, seq] of seriesMap) {
        if (seq.length < 2) continue;
        seq.sort(function (a, b) { return a.frameIdx - b.frameIdx; });
        const meta = { view: seq[0].view, trackIdx: seq[0].trackIdx, identityId: seq[0].identityId };
        // Velocity (frame-to-frame).
        for (let i = 1; i < seq.length; i++) {
            const dt = seq[i].frameIdx - seq[i - 1].frameIdx;
            if (dt <= 0) continue;
            const v = meanNodeVelocity(getPoints(seq[i]), getPoints(seq[i - 1]), space, dt);
            if (v != null) { velEvents.push({ frameIdx: seq[i].frameIdx, velocity: v, meta: meta }); velDist.push(v); }
        }
        // Limb length: per-edge running stats -> per-frame z-score.
        if (edges.length) {
            const stat = edges.map(function () { return { sum: 0, sumSq: 0, count: 0 }; });
            const lengthsByFrame = [];
            for (let si = 0; si < seq.length; si++) {
                const pts = getPoints(seq[si]);
                const lens = new Array(edges.length).fill(null);
                for (let ei = 0; ei < edges.length; ei++) {
                    const a = pts[edges[ei][0]], b = pts[edges[ei][1]];
                    if (a == null || b == null) continue;
                    const L = (space === '3d') ? dist3d(a, b) : dist2d(a, b);
                    lens[ei] = L;
                    stat[ei].sum += L; stat[ei].sumSq += L * L; stat[ei].count++;
                }
                lengthsByFrame.push({ frameIdx: seq[si].frameIdx, lens: lens });
            }
            const ms = stat.map(function (s) {
                if (s.count < 2) return null;
                const m = s.sum / s.count;
                const varr = Math.max(0, s.sumSq / s.count - m * m);
                return { mean: m, std: Math.sqrt(varr) };
            });
            for (let fi = 0; fi < lengthsByFrame.length; fi++) {
                const lens = lengthsByFrame[fi].lens;
                const flagged = [];
                for (let ei = 0; ei < lens.length; ei++) {
                    const m = ms[ei];
                    if (lens[ei] == null || !m || m.std <= 1e-9) continue;
                    const z = Math.abs(lens[ei] - m.mean) / m.std;
                    limbZDist.push(z);
                    if (z > 1.0) flagged.push({ edge: ei, length: lens[ei], z: z }); // store candidates only
                }
                if (flagged.length) limbEvents.push({ frameIdx: lengthsByFrame[fi].frameIdx, edges: flagged, meta: meta });
            }
        }
    }
    return { velEvents: velEvents, limbEvents: limbEvents, velDist: velDist, limbZDist: limbZDist };
}

function identityLabel(session, id) {
    const idt = session && session.getIdentity ? session.getIdentity(id) : null;
    return idt && idt.name ? idt.name : ('id ' + id);
}

function getOrCreateFr(perFrame, f) {
    let fr = perFrame.get(f);
    if (!fr) { fr = { frameIdx: f }; perFrame.set(f, fr); }
    return fr;
}

// Fold temporal/limb events into the per-frame raw store (threshold-independent
// values; classify() applies velThresh / limbZ later so drag re-classifies).
function mergeTemporal(perFrame, tl, session, space) {
    for (let i = 0; i < tl.velEvents.length; i++) {
        const ev = tl.velEvents[i];
        const fr = getOrCreateFr(perFrame, ev.frameIdx);
        if (!fr.temporal) fr.temporal = [];
        fr.temporal.push({
            velocity: ev.velocity, view: ev.meta.view, space: space,
            trackIdx: space === '3d' ? null : ev.meta.trackIdx,
            label: space === '3d' ? identityLabel(session, ev.meta.identityId) : trackLabel(session, ev.meta.trackIdx),
        });
    }
    for (let i = 0; i < tl.limbEvents.length; i++) {
        const ev = tl.limbEvents[i];
        const fr = getOrCreateFr(perFrame, ev.frameIdx);
        if (!fr.limb) fr.limb = [];
        fr.limb.push({
            edges: ev.edges, view: ev.meta.view, space: space,
            trackIdx: space === '3d' ? null : ev.meta.trackIdx,
            label: space === '3d' ? identityLabel(session, ev.meta.identityId) : trackLabel(session, ev.meta.trackIdx),
        });
    }
}

// ---------------------------------------------------------------------------
// Thresholds / histograms / navigation (UI helpers)
// ---------------------------------------------------------------------------

export function computeAutoThresholds(distributions, pct) {
    pct = pct || 95;
    return {
        reproj: percentile(distributions.reproj || [], pct),
        epipolar: percentile(distributions.epipolar || [], pct),
        velocity: percentile(distributions.velocity || [], pct),
        limbZ: percentile(distributions.limbZ || [], pct),
    };
}

// Histogram bin data (no drawing). Clamps long tails at P99.
export function buildHistogram(values, threshold, binCount) {
    binCount = binCount || 40;
    if (!values || !values.length) return { bins: [], counts: [], max: 0, displayMax: 1, threshBin: -1, outlierCount: 0 };
    const s = sortedCopy(values);
    const displayMax = Math.max(percentileSorted(s, 99), 1e-6);
    const counts = new Array(binCount).fill(0);
    for (let i = 0; i < values.length; i++) {
        let b = Math.floor((values[i] / displayMax) * binCount);
        if (b < 0) b = 0; if (b >= binCount) b = binCount - 1;
        counts[b]++;
    }
    let maxCount = 0;
    for (let i = 0; i < binCount; i++) if (counts[i] > maxCount) maxCount = counts[i];
    const threshBin = threshold != null && isFinite(threshold) ? Math.floor((threshold / displayMax) * binCount) : -1;
    let outlierCount = 0;
    for (let i = 0; i < values.length; i++) if (threshold != null && values[i] > threshold) outlierCount++;
    return { bins: binCount, counts: counts, max: maxCount, displayMax: displayMax, threshBin: threshBin, outlierCount: outlierCount };
}

// Group consecutive same-(type,track,severity) flagged frames into runs.
export function groupConsecutiveIssues(sortedIssues, gap, cap) {
    gap = gap == null ? 2 : gap;
    cap = cap || 200;
    // Sort a copy by (type, track, frame).
    const key = function (i) { return i.type + '|' + (i.trackIdx != null ? i.trackIdx : (i.trackA + '_' + i.trackB)) + '|' + i.severity; };
    const byKey = new Map();
    for (let i = 0; i < sortedIssues.length; i++) {
        const k = key(sortedIssues[i]);
        if (!byKey.has(k)) byKey.set(k, []);
        byKey.get(k).push(sortedIssues[i]);
    }
    const runs = [];
    for (const [, list] of byKey) {
        list.sort(function (a, b) { return a.frameIdx - b.frameIdx; });
        let start = 0;
        for (let i = 1; i <= list.length; i++) {
            if (i === list.length || list[i].frameIdx - list[i - 1].frameIdx > gap) {
                const seg = list.slice(start, i);
                runs.push({
                    type: seg[0].type, severity: seg[0].severity,
                    startFrame: seg[0].frameIdx, endFrame: seg[seg.length - 1].frameIdx,
                    count: seg.length, representative: seg[Math.floor(seg.length / 2)].frameIdx,
                    description: seg[0].description, issue: seg[0],
                });
                start = i;
            }
        }
    }
    runs.sort(function (a, b) { return a.startFrame - b.startFrame; });
    return runs.slice(0, cap);
}

export function nextFlaggedFrame(flaggedFrames, current) {
    const arr = Array.from(flaggedFrames).sort(function (a, b) { return a - b; });
    if (!arr.length) return null;
    for (let i = 0; i < arr.length; i++) if (arr[i] > current) return arr[i];
    return arr[0];
}
export function prevFlaggedFrame(flaggedFrames, current) {
    const arr = Array.from(flaggedFrames).sort(function (a, b) { return a - b; });
    if (!arr.length) return null;
    for (let i = arr.length - 1; i >= 0; i--) if (arr[i] < current) return arr[i];
    return arr[arr.length - 1];
}
