/**
 * pose/training-data.js — the DOM-free rules behind a training file: the validation split
 * by MOMENT and the checks a project must pass before training. The file itself is built by
 * `import-export/training-slp.js`.
 *
 * Node tests: tests/test-training-data.mjs.
 *
 * Split by moment: sleap-nn's own `validation_fraction` picks labelled FRAMES at random, so
 * camera A's view of frame 1200 can land in training while camera B's view of the same moment
 * lands in validation: the validation loss then measures a pose the model has already seen.
 * All views of a session share frame numbers (`ui/inference-panel.js`: "targets are per
 * session"), so a moment is (session, frame index) and every labelled view of it goes to the
 * same side. Sizes follow sleap-io's `make_training_splits` (a fraction of the units, at least
 * one on each side when there are two or more).
 */

export const DEFAULT_VALIDATION_FRACTION = 0.1;
export const DEFAULT_SPLIT_SEED = 0;

/** A moment's key: unique across sessions (frame indices restart at 0 in every session). */
export function momentKey(sessionIndex, frameIdx) {
    return sessionIndex + ':' + frameIdx;
}

function parseMoment(k) {
    const i = String(k).indexOf(':');
    return [Number(String(k).slice(0, i)), Number(String(k).slice(i + 1))];
}

/** Deterministic 32-bit PRNG (mulberry32): the same seed gives the same split on every machine. */
export function seededRandom(seed) {
    let a = (Number(seed) >>> 0) || 0;
    return function () {
        a = (a + 0x6D2B79F5) >>> 0;
        let t = a;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}

/**
 * Split moments into train and validation.
 * @param {Iterable<string>} keys - `momentKey`s (duplicates are fine)
 * @param {{fraction?: number, seed?: number|null, overfit?: boolean}} [opts]
 * @returns {{train: Set<string>, val: Set<string>, sameAsTrain: boolean, reason: string|null}}
 *   `sameAsTrain`: validation is the training data (overfit mode, or fewer than two moments).
 */
export function splitMoments(keys, opts) {
    const o = opts || {};
    const uniq = Array.from(new Set(Array.from(keys || [], String)));
    // Sort numerically by (session, frame) so the split does not depend on the order frames
    // were visited (resident window first, store rows after, …).
    uniq.sort(function (a, b) {
        const pa = parseMoment(a), pb = parseMoment(b);
        return pa[0] - pb[0] || pa[1] - pb[1];
    });
    if (o.overfit) {
        return { train: new Set(uniq), val: new Set(uniq), sameAsTrain: true, reason: 'overfit' };
    }
    if (uniq.length < 2) {
        return { train: new Set(uniq), val: new Set(uniq), sameAsTrain: true, reason: 'too-few' };
    }
    let fraction = Number(o.fraction);
    if (!Number.isFinite(fraction) || fraction <= 0) fraction = DEFAULT_VALIDATION_FRACTION;
    if (fraction >= 1) fraction = 0.5;
    const nVal = Math.min(uniq.length - 1, Math.max(1, Math.round(uniq.length * fraction)));
    const rand = seededRandom(o.seed == null ? DEFAULT_SPLIT_SEED : o.seed);
    const order = uniq.slice();
    for (let i = order.length - 1; i > 0; i--) {          // Fisher–Yates
        const j = Math.floor(rand() * (i + 1));
        const t = order[i]; order[i] = order[j]; order[j] = t;
    }
    const val = new Set(order.slice(0, nVal));
    const train = new Set(uniq.filter(function (k) { return !val.has(k); }));
    return { train: train, val: val, sameAsTrain: false, reason: null };
}

/**
 * A name that would start an OmegaConf interpolation once sleap-nn copies it into the run's
 * `training_config.yaml` (skeleton node names → `part_names`, track names → `classes`). A later
 * load resolves `${oc.env:SECRET}` there, so such names are refused before training.
 * @param {{kind: string, names: string[]}[]} lists
 * @returns {string|null} the problem, or null
 */
export function interpolationProblem(lists) {
    for (const l of lists || []) {
        for (const n of l.names || []) {
            if (String(n).indexOf('${') !== -1) {
                return 'The ' + l.kind + ' name "' + n + '" contains "${", which training configs treat as a variable. Rename it first.';
            }
        }
    }
    return null;
}

/** sleap-app's model types (`TrainingPanel.tsx` MODEL_TYPE_OPTIONS). */
export const ID_MODEL_TYPES = Object.freeze(['top_down_id', 'bottom_up_id']);
export const BOX_MODEL_TYPES = Object.freeze(['bbox', 'top_down_bbox']);

/** An auto-named identity is exported as `track_<n>` (`Session.identityTrackPlan`). */
const AUTO_TRACK_RE = /^track_\d+(_\d+)?$/;

/**
 * Why an identity ("+ ID") model cannot train on these sessions, or null.
 *
 * sleap-nn's ID heads learn one class per track name, so every training instance needs a track
 * that means the same animal everywhere it appears in the file:
 *   - identities (LUC3D's cross-view tracks) are the same animal in every view of a session;
 *   - plain per-camera tracks are only consistent within one camera of one session;
 *   - an auto-named identity is exported by its POSITION (`track_0`, …), so `track_0` can be a
 *     different animal in another session.
 *
 * @param {{name: string, fromIdentity: boolean, trackNames: string[], userInstances: number,
 *          trackless: number, predictedWithIdentity?: number}[]} sessions - one entry per
 *   session in the file (only the views of this group counted)
 * @param {{views: number}} shape - how many distinct views the file holds
 * @returns {string|null}
 */
export function idModelProblem(sessions, shape) {
    const list = (sessions || []).filter(function (s) { return s.userInstances > 0; });
    if (list.length === 0) return 'Label at least one frame before training.';
    for (const s of list) {
        if (s.trackless > 0) {
            if (s.trackless === s.userInstances && (s.predictedWithIdentity || 0) > 0) {
                return 'Identities are only on predicted instances in ' + s.name + '. Propagate identities onto your labelled instances first.';
            }
            return s.trackless.toLocaleString('en-US') + ' labelled instance' + (s.trackless === 1 ? '' : 's') +
                ' in ' + s.name + ' ha' + (s.trackless === 1 ? 's' : 've') + ' no identity. ID models need an identity on every labelled instance.';
        }
    }
    const multiView = (shape && shape.views > 1);
    for (const s of list) {
        if (!s.fromIdentity && (multiView || list.length > 1)) {
            return s.name + ' has tracks but no identities. Tracks differ per camera, so an ID model across ' +
                (multiView ? 'views' : 'sessions') + ' needs identities: assign them across views first.';
        }
    }
    if (list.length > 1) {
        for (const s of list) {
            if (s.trackNames.some(function (n) { return AUTO_TRACK_RE.test(n); })) {
                return 'Identities in ' + s.name + ' have no names, so the same number can be a different animal in another session. Name the identities (the same names in every session) first.';
            }
        }
        const first = list[0].trackNames.slice().sort().join('\u0000');
        for (const s of list.slice(1)) {
            if (s.trackNames.slice().sort().join('\u0000') !== first) {
                return 'Sessions name their identities differently (' + list[0].name + ' vs ' + s.name + '). Use the same identity names in every session.';
            }
        }
    }
    return null;
}

/** Is this one of sleap-app's identity model types? */
export function isIdModelType(t) { return ID_MODEL_TYPES.indexOf(t) !== -1; }
/** Is this one of sleap-app's box-detector model types (no box labels in LUC3D)? */
export function isBoxModelType(t) { return BOX_MODEL_TYPES.indexOf(t) !== -1; }
