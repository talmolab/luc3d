/**
 * pose/skeleton-check-run.js — the project side of Triangulate's skeleton check (pose/skeleton-check.js): the
 * browser-local setting, the chains of the session's skeleton, their bones measured from the session's own 3D,
 * and which groups a check pass has to re-solve.
 *
 * - The setting (Triangulate ▸ "Skeleton check", `ui/skeleton-check-field.js`) is browser-local
 *   (`localStorage.lucidSkeletonCheck`), off by default; nothing is written to the `.slp`. The 3D a checked solve
 *   produces is saved like any other 3D (a dropped point as missing 3D).
 * - The chains come from the skeleton's edges (`skeletonChains`); the usual lengths and ranges from every group's
 *   stored 3D in the session (`session.instanceGroups`, never evicted, so lazy projects are measured whole). A run
 *   measures again at its start (`invalidateSkeletonCheck` drops the cache), so the check follows the data.
 * - Without enough 3D (a bone seen in fewer than MIN_BONE_SAMPLES poses) the check does nothing; Triangulate All
 *   measures after its own solve, so its check pass always has the run's 3D to measure.
 *
 * DOM-free (localStorage guarded); imported by pose/triangulation.js and ui/skeleton-check-field.js.
 */
import { skeletonChains, measureBones, chainBadness, SKELETON_CHECK_DEFAULTS } from './skeleton-check.js';

const STORAGE_KEY = 'lucidSkeletonCheck';
const DEFAULT_SETTINGS = Object.freeze({ enabled: false });
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

/** The session skeleton's chains, each with a `name` (its nodes' names joined by '+'). Cached per skeleton. */
export function sessionSkeletonChains(session) {
    const sk = session && session.skeleton;
    if (!sk) return [];
    const names = nodeNames(sk);
    const sig = names.join('\u0001') + '\u0002' + JSON.stringify(sk.edges || []);
    const cache = session._skeletonCheckChains;
    if (cache && cache.sig === sig) return cache.chains;
    const chains = skeletonChains(names.length, sk.edges || []).chains.map(function (ch) {
        return Object.assign(ch, { name: Array.from(ch.nodes, function (k) { return names[k]; }).join('+') });
    });
    session._skeletonCheckChains = { sig: sig, chains: chains };
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
        skipped: m.measured.skipped.map(function (s) { return { name: s.chain.name, reason: s.reason }; }),
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
