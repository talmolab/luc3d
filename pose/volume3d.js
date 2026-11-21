/**
 * pose/volume3d.js — a session's volumetric-model output, loaded by File ▸ Load Volume 3D
 * (import-export/volume3d-file.js), and the volume-fusion setting. `volumeForFrame` hands one frame of it
 * to the triangulation solve as `options.volume` (pose/volume-fusion.js describes what the solve does).
 *
 * In memory only: the volume is never written to the .slp (a reopened project needs the file again).
 * The 3D a fused solve produces is saved like any other 3D; such groups carry `group.volumeFused`
 * (in memory) so the display reprojects their stored 3D instead of re-solving them without the volume.
 *
 * The setting (Triangulate ▸ "Fuse with volume") is browser-local (localStorage `lucidVolumeFusion`), like
 * every display/workflow preference; a session without a loaded volume is solved as before.
 *
 * Skeleton chains: when Triangulate's skeleton check is on (pose/skeleton-check-run.js) and the group matches a
 * volume animal, the check uses the file's chains (`data.chains`, by node name; its exporter names them, e.g. the
 * tail and the head) instead of the skeleton's: each bone's usual length is measured once, from the file's own
 * means (`chainBoneMedians`), with the +-50 % range the volfuse study validated. A chain with a node the file or
 * the skeleton lacks, or a bone measured on too few rows, is left out. No chains = the skeleton's are checked.
 */
import { mapVolumeNodes, chainBoneMedians, VOLUME_DEFAULTS } from './volume-fusion.js';

const STORAGE_KEY = 'lucidVolumeFusion';
const DEFAULT_SETTINGS = Object.freeze({
    enabled: true,
    gateFloorPx: VOLUME_DEFAULTS.gateFloorPx,
    gateK: VOLUME_DEFAULTS.gateK,
    matchMaxMm: VOLUME_DEFAULTS.matchMaxMm,
    fuse: true,
    covScale: null,          // null = the file's own (its exporter measured it)
    chainAgreeMm: VOLUME_DEFAULTS.chainAgreeMm,   // the skeleton check never changes a point the two agree on
});
let _settings = null;

/** The volume-fusion settings (defaults merged with what this browser stored). */
export function getVolumeSettings() {
    if (_settings) return _settings;
    let stored = null;
    try {
        const raw = (typeof localStorage !== 'undefined') ? localStorage.getItem(STORAGE_KEY) : null;
        stored = raw ? JSON.parse(raw) : null;
    } catch (e) { stored = null; }
    _settings = Object.assign({}, DEFAULT_SETTINGS, stored && typeof stored === 'object' ? stored : {});
    return _settings;
}

/** Update and persist (best effort) some of the settings. */
export function setVolumeSettings(patch) {
    _settings = Object.assign({}, getVolumeSettings(), patch || {});
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(_settings));
    } catch (e) { /* storage blocked: the setting still holds for this page */ }
    return _settings;
}

/**
 * Attach a parsed volume file to a session (replacing any earlier one).
 * `data`: { nodeNames: string[], frameIndices: Int32Array(R), means: Float32Array(R*J*3),
 *           covs: Float32Array(R*J*6), covScale: number, source?: string, fileName?: string }
 */
export function setSessionVolume(session, data) {
    if (!session) return null;
    const J = data.nodeNames.length;
    const R = data.frameIndices.length;
    if (data.means.length !== R * J * 3 || data.covs.length !== R * J * 6) {
        throw new Error('volume file: means/covs do not match ' + R + ' rows x ' + J + ' nodes');
    }
    const rowsByFrame = new Map();
    for (let r = 0; r < R; r++) {
        const f = data.frameIndices[r];
        let list = rowsByFrame.get(f);
        if (!list) { list = []; rowsByFrame.set(f, list); }
        list.push(r);
    }
    session.volume3d = { data: data, rowsByFrame: rowsByFrame, nodeMap: null, nodeMapKey: null,
        chains: fileChains(data), chainsMapped: null };
    return session.volume3d;
}

/**
 * The file's chains in FILE node indices, with each bone's usual length: [{ name, bones: Int32Array,
 * nodes: Int32Array, medians: Float64Array }] (usable) and `skipped` [{ name, reason }].
 * `data.chains`: [{ name, bones: [[a, b], ...], nodes: [...] }] by node name (import-export/volume3d-file.js).
 */
function fileChains(data) {
    const out = [];
    out.skipped = [];
    const raw = Array.isArray(data.chains) ? data.chains : [];
    const J = data.nodeNames.length;
    const at = new Map();
    data.nodeNames.forEach(function (n, j) { at.set(String(n), j); });
    raw.forEach(function (ch, c) {
        const name = String((ch && ch.name) || ('chain ' + (c + 1)));
        const bones = ch && Array.isArray(ch.bones) ? ch.bones : [];
        const nodes = ch && Array.isArray(ch.nodes) ? ch.nodes : [];
        const missing = [];
        const look = function (n) {
            const j = at.get(String(n));
            if (j == null) missing.push(String(n));
            return j == null ? -1 : j;
        };
        const b = new Int32Array(bones.length * 2);
        bones.forEach(function (pair, i) {
            b[2 * i] = look(pair && pair[0]); b[2 * i + 1] = look(pair && pair[1]);
        });
        const nd = Int32Array.from(nodes, look);
        if (!bones.length || !nodes.length) { out.skipped.push({ name: name, reason: 'no bones or no nodes' }); return; }
        if (missing.length) { out.skipped.push({ name: name, reason: 'not in the file: ' + missing.join(', ') }); return; }
        const medians = chainBoneMedians(b, data.means, J);
        if (!medians.every(Number.isFinite)) { out.skipped.push({ name: name, reason: 'too few rows to measure its bones' }); return; }
        out.push({ name: name, bones: b, nodes: nd, medians: medians });
    });
    return out;
}

/** The loaded volume's chains in the SKELETON's node indices (cached per skeleton); `skipped` lists the
 *  file's chains left out (with why). */
export function volumeChains(session) {
    const v = sessionVolume(session);
    if (!v) { const none = []; none.skipped = []; return none; }
    const names = skeletonNodeNames(session);
    const key = names.join('\u0001');
    if (v.nodeMapKey !== key) { v.nodeMap = mapVolumeNodes(v.data.nodeNames, names); v.nodeMapKey = key; v.chainsMapped = null; }
    if (v.chainsMapped) return v.chainsMapped;
    const inv = new Int32Array(v.data.nodeNames.length).fill(-1);
    v.nodeMap.forEach(function (j, k) { if (j >= 0) inv[j] = k; });
    const fc = v.chains || fileChains(v.data);
    const out = [];
    out.skipped = (fc.skipped || []).slice();
    fc.forEach(function (ch) {
        const b = Int32Array.from(ch.bones, function (j) { return inv[j]; });
        const nd = Int32Array.from(ch.nodes, function (j) { return inv[j]; });
        if (b.some(function (k) { return k < 0; }) || nd.some(function (k) { return k < 0; })) {
            out.skipped.push({ name: ch.name, reason: 'a node is not in the skeleton' });
            return;
        }
        // pose/skeleton-check.js's chain form: anchors = the bones' ends outside the chain; the +-50 % range
        const inChain = new Set(nd), anchors = new Set();
        for (const k of b) if (!inChain.has(k)) anchors.add(k);
        const nb = ch.medians.length;
        out.push({ name: ch.name, bones: b, nodes: nd, anchors: Int32Array.from(anchors), medians: ch.medians,
                   lo: new Float64Array(nb).fill(0.5), hi: new Float64Array(nb).fill(1.5) });
    });
    v.chainsMapped = out;
    return out;
}

export function clearSessionVolume(session) {
    if (session) session.volume3d = null;
}

/** The session's loaded volume ({ data, rowsByFrame }) or null. */
export function sessionVolume(session) {
    return (session && session.volume3d) || null;
}

function skeletonNodeNames(session) {
    const sk = session && session.skeleton;
    if (!sk || !sk.nodes) return [];
    return sk.nodes.map(function (n) { return (n && n.name != null) ? n.name : String(n); });
}

/** Skeleton nodes the loaded volume has (by name). */
export function volumeNodeCoverage(session) {
    const v = sessionVolume(session);
    if (!v) return { matched: 0, total: 0, missing: [] };
    const names = skeletonNodeNames(session);
    const map = mapVolumeNodes(v.data.nodeNames, names);
    const missing = names.filter(function (n, k) { return map[k] < 0; });
    return { matched: names.length - missing.length, total: names.length, missing: missing };
}

/**
 * One frame of the session's volume for the solve (`options.volume`), in the skeleton's node order, or
 * null (setting off, no volume loaded, or no volume row at this frame).
 */
export function volumeForFrame(session, frameIdx) {
    const s = getVolumeSettings();
    const v = sessionVolume(session);
    if (!s.enabled || !v) return null;
    const rows = v.rowsByFrame.get(frameIdx);
    if (!rows || !rows.length) return null;
    const names = skeletonNodeNames(session);
    const chains = volumeChains(session);   // also (re)builds the node map
    const N = names.length, J = v.data.nodeNames.length, map = v.nodeMap;
    const means = new Float64Array(rows.length * N * 3).fill(NaN);
    const covs = new Float64Array(rows.length * N * 6).fill(NaN);
    for (let a = 0; a < rows.length; a++) {
        const r = rows[a];
        for (let k = 0; k < N; k++) {
            const j = map[k];
            if (j < 0) continue;
            const si = (r * J + j), di = (a * N + k);
            means[3 * di] = v.data.means[3 * si]; means[3 * di + 1] = v.data.means[3 * si + 1];
            means[3 * di + 2] = v.data.means[3 * si + 2];
            for (let q = 0; q < 6; q++) covs[6 * di + q] = v.data.covs[6 * si + q];
        }
    }
    return {
        n: rows.length, nNodes: N, means: means, covs: covs,
        covScale: s.covScale != null ? s.covScale : (v.data.covScale != null ? v.data.covScale : 1),
        gateFloorPx: s.gateFloorPx, gateK: s.gateK, fuse: s.fuse !== false, matchMaxMm: s.matchMaxMm,
        chains: chains.slice(), chainAgreeMm: s.chainAgreeMm,
    };
}
