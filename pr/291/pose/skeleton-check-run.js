/**
 * pose/skeleton-check-run.js — the project side of Triangulate's skeleton check (pose/skeleton-check.js): the
 * browser-local setting, the chains of the session's skeleton, their bones measured from the session's own 3D,
 * and which groups a check pass has to re-solve.
 *
 * - The setting (Triangulate ▸ "Skeleton check", `ui/skeleton-check-field.js`) is browser-local
 *   (`localStorage.lucidSkeletonCheck`), off by default; nothing is written to the `.slp`. The 3D a checked solve
 *   produces is saved like any other 3D (a dropped point as missing 3D).
 * - The chains come from the skeleton's edges (`skeletonChains`), or from custom parts built from node tiles in
 *   Settings ▸ Triangulation Wizard (ui/skeleton-chain-editor.js), stored as text (`settings.chains`, browser-local
 *   too): one part per line, its node names in order along the body, e.g. "TTI, Tail_0, Tail_1, Tail_2, TailTip".
 *   The check links each node of a part to the next and ignores the skeleton's links between two nodes of the same
 *   part; every other link stays (`checkLinks`). That is how a star skeleton's tail, whose points each link only to
 *   TTI and so are judged only by their distance from it, gets judged bone by bone along the tail. The skeleton
 *   itself is never changed.
 * - The usual lengths and ranges come from every group's stored 3D in the session (`session.instanceGroups`, never
 *   evicted, so lazy projects are measured whole). A run measures again at its start (`invalidateSkeletonCheck`
 *   drops the cache), so the check follows the data.
 * - Without enough 3D (a bone seen in fewer than MIN_BONE_SAMPLES poses) the check does nothing; Triangulate All
 *   measures after its own solve, so its check pass always has the run's 3D to measure.
 *
 * DOM-free (localStorage guarded); imported by pose/triangulation.js and ui/skeleton-check-field.js.
 */
import { skeletonChains, measureBones, chainBadness, SKELETON_CHECK_DEFAULTS } from './skeleton-check.js?v=29f895d644eb';

const STORAGE_KEY = 'lucidSkeletonCheck';
const DEFAULT_SETTINGS = Object.freeze({ enabled: false, chains: '' });
let _settings = null;

/** The skeleton-check settings (defaults merged with what this browser stored). */
export function getSkeletonCheckSettings() {
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
export function setSkeletonCheckSettings(patch) {
    _settings = Object.assign({}, getSkeletonCheckSettings(), patch || {});
    try {
        if (typeof localStorage !== 'undefined') localStorage.setItem(STORAGE_KEY, JSON.stringify(_settings));
    } catch (e) { /* storage blocked: the setting still holds for this page */ }
    return _settings;
}

function nodeNames(skeleton) {
    return (skeleton && skeleton.nodes || []).map(function (n) { return (n && n.name != null) ? n.name : String(n); });
}

/**
 * Custom parts as stored: one body part per line (or between ';'), its node names in order along the body, separated
 * by commas (or '→'). -> [[name, ...], ...], blank lines left out.
 */
export function parseChainText(text) {
    return String(text == null ? '' : text).split(/[\n;]+/)
        .map(function (line) { return line.split(/,|\u2192/).map(function (t) { return t.trim(); }).filter(Boolean); })
        .filter(function (line) { return line.length > 0; });
}

/**
 * Custom parts against a skeleton's node names: a name matches exactly, else ignoring case when only one node does.
 * -> { paths: [Int32Array of node indices, in the part's order], problems: [string] }. A part with a name no node
 * has, a node twice, or fewer than two nodes is left out, and says why in `problems`.
 */
export function resolveChainText(names, text) {
    const paths = [], problems = [];
    for (const line of parseChainText(text)) {
        const idx = [], unknown = [];
        for (const t of line) {
            let k = names.indexOf(t);
            if (k < 0) {
                const lower = t.toLowerCase();
                const hits = [];
                names.forEach(function (n, j) { if (String(n).toLowerCase() === lower) hits.push(j); });
                if (hits.length === 1) k = hits[0];
            }
            if (k < 0) unknown.push(t); else idx.push(k);
        }
        const said = line.join(', ');
        if (unknown.length) { problems.push(said + ': no node named ' + unknown.join(', ')); continue; }
        if (idx.length < 2) { problems.push(said + ': a part needs two nodes or more'); continue; }
        if (new Set(idx).size !== idx.length) { problems.push(said + ': a node is listed twice'); continue; }
        paths.push(Int32Array.from(idx));
    }
    return { paths: paths, problems: problems };
}

/**
 * The links the check builds its chains from: the skeleton's `edges`, minus every link between two nodes of one custom
 * part, plus each part's consecutive pairs. A part's direction does not matter. -> [[a, b], ...]
 */
export function checkLinks(edges, paths) {
    const key = function (a, b) { return a < b ? a + ',' + b : b + ',' + a; };
    const out = [], have = new Set();
    for (const e of edges || []) {
        const a = e[0], b = e[1];
        if (paths.some(function (p) { return p.indexOf(a) >= 0 && p.indexOf(b) >= 0; })) continue;
        if (have.has(key(a, b))) continue;
        have.add(key(a, b));
        out.push([a, b]);
    }
    for (const p of paths) {
        for (let i = 1; i < p.length; i++) {
            if (have.has(key(p[i - 1], p[i]))) continue;
            have.add(key(p[i - 1], p[i]));
            out.push([p[i - 1], p[i]]);
        }
    }
    return out;
}

/**
 * The session skeleton's chains for the check, each with a `name` (its nodes' names joined by '+', in the part's
 * order for a custom part, else by node index) and `custom` (true for a chain from a custom part). `text`: the custom
 * parts as stored (default: the setting's). The array carries `problems` (custom parts left out, and why). Cached per
 * skeleton and text.
 */
export function sessionSkeletonChains(session, text) {
    const sk = session && session.skeleton;
    if (!sk) return Object.assign([], { problems: [] });
    const custom = text == null ? (getSkeletonCheckSettings().chains || '') : String(text);
    const names = nodeNames(sk);
    const sig = names.join('\u0001') + '\u0002' + JSON.stringify(sk.edges || []) + '\u0002' + custom;
    let cache = session._skeletonCheckChains;
    if (!(cache instanceof Map)) cache = session._skeletonCheckChains = new Map();
    if (cache.has(sig)) return cache.get(sig);
    const resolved = resolveChainText(names, custom);
    const chains = skeletonChains(names.length, checkLinks(sk.edges || [], resolved.paths)).chains.map(function (ch) {
        const nodes = Array.from(ch.nodes);
        const path = resolved.paths.find(function (p) { return nodes.every(function (k) { return p.indexOf(k) >= 0; }); });
        if (path) nodes.sort(function (a, b) { return path.indexOf(a) - path.indexOf(b); });
        return Object.assign(ch, { name: nodes.map(function (k) { return names[k]; }).join('+'), custom: !!path });
    });
    chains.problems = resolved.problems;
    if (cache.size >= 4) cache.delete(cache.keys().next().value);   // the setting's and a few being built in Settings
    cache.set(sig, chains);
    return chains;
}

/** Call every group's stored 3D in the session (flat 3N). */
function forEachSessionPose(session) {
    return function (fn) {
        for (const groups of session.instanceGroups.values()) {
            for (const g of groups) if (g && g.points3d && g.points3d.length) fn(g.points3d);
        }
    };
}

/** Forget the measured bones (the session's 3D changed); the next run measures again. */
export function invalidateSkeletonCheck(session) {
    if (session) session._skeletonCheckMeasured = null;
}

/**
 * The skeleton check for a Triangulate run (`options.skeleton`), or null: setting off, no skeleton, no chains, or
 * nothing measurable yet. -> { chains (measured), subsetPx, maxCandidates, skipped: [{ name, reason }] }
 */
export function skeletonCheckForRun(session) {
    if (!getSkeletonCheckSettings().enabled || !session || !session.skeleton) return null;
    const chains = sessionSkeletonChains(session);
    if (!chains.length) return null;
    let m = session._skeletonCheckMeasured;
    if (!m || m.chains !== chains) {
        const measured = measureBones(chains, forEachSessionPose(session));
        m = { chains: chains, measured: measured };
        session._skeletonCheckMeasured = m;
    }
    if (!m.measured.length) return null;
    return {
        chains: m.measured,
        subsetPx: SKELETON_CHECK_DEFAULTS.subsetPx,
        maxCandidates: SKELETON_CHECK_DEFAULTS.maxCandidates,
        skipped: m.measured.skipped.map(function (s) { return { name: s.chain.name, reason: s.reason }; })
            .concat(chains.problems.map(function (p) { return { name: p, reason: 'custom part left out' }; })),
    };
}

/** Whether a group's stored 3D has a chain outside its ranges (what a check pass re-solves). */
export function groupNeedsSkeletonCheck(group, sk) {
    const P = group && group.points3d;
    if (!P || !P.length || !sk) return false;
    for (const ch of sk.chains) if (chainBadness(P, ch) > 0) return true;
    return false;
}

/** The frames with at least one group that needs the check, sorted. */
export function framesNeedingSkeletonCheck(session, sk) {
    const out = [];
    if (!session || !sk) return out;
    for (const [f, groups] of session.instanceGroups) {
        if (groups && groups.some(function (g) { return groupNeedsSkeletonCheck(g, sk); })) out.push(f);
    }
    return out.sort(function (a, b) { return a - b; });
}
