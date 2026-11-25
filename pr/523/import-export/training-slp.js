/**
 * import-export/training-slp.js — the training and validation `.slp` files of one training group
 * (the Training panel; rules in `pose/training-data.js`, models in `pose/training-models.js`).
 *
 * sleap-app hands sleap-nn the saved project file. LUC3D builds a dedicated file instead,
 * because the project holds predictions, 3D, several sessions and lazy stores:
 *   - one video per (session, view) of the group, in selection order; the caller names each
 *     video (a placeholder the local backend replaces with `--video-paths`, or the worker path
 *     a remote job reads). The train and validation files share the same video table, so one
 *     `--video-paths` list fits both;
 *   - USER instances only: no predictions, no reprojections (`buildSlpLabelsMultiSession`'s
 *     default would add reprojected 3D), no instance without a visible point, no empty frame;
 *   - tracks = identities, exactly as every LUC3D export names them (`exportTrackSource`), for
 *     resident and lazy rows alike;
 *   - the CURRENT in-memory edits (nothing has to be saved first);
 *   - the validation split by moment (`splitMoments`).
 *
 * Lazy sessions: resident frames come from `session.frameGroups` (they hold the edits; deletes
 * already edited the store); every other frame with a user row is read from the store through
 * `loader.getFrameSync` + `lazyRowInstance` (the visibility rule hydration uses) and released
 * again, so a long recording is never hydrated as a whole.
 *
 * Occluded / nulled nodes are written `visible: false` with their position (`_buildSioPoints`);
 * sleap-nn reads points with `invisible_as_nan=True` (sleap-io `Instance.numpy`), so they are
 * masked, not trained on.
 */
import { _buildSioPoints, cameraExportVideo, exportTrackSource } from './file-io.js?v=e37e05d05839';
import { validateSkeletonCompatibility } from './slp-merge.js?v=e37e05d05839';
import { lazyRowInstance } from '../pose/lazy-residency.js?v=e37e05d05839';
import { momentKey, splitMoments, interpolationProblem } from '../pose/training-data.js?v=e37e05d05839';

function nodeNames(skeleton) {
    return ((skeleton && skeleton.nodes) || []).map(function (n) { return typeof n === 'string' ? n : (n && n.name) || ''; });
}

function lazyBacksCamera(session, cam) {
    const loader = session && session.lazyLoader;
    return !!(loader && loader.labelsByCam && typeof loader.labelsByCam.has === 'function' && loader.labelsByCam.has(cam)
        && typeof loader.forEachInstanceRow === 'function' && typeof loader.getFrameSync === 'function');
}

/**
 * Camera `cam`'s user instances, frame by frame, resident and lazy.
 * @returns {Map<number, Object[]>} frameIdx -> Instance[] (only frames with at least one)
 */
export function userInstancesByFrame(session, cam) {
    const out = new Map();
    for (const [f, fg] of session.frameGroups) {
        const list = [];
        for (const inst of (fg.instances.get(cam) || [])) if (inst && inst.type === 'user') list.push(inst);
        for (const u of fg.getUnlinkedInstances(cam)) if (u && u.instance && u.instance.type === 'user') list.push(u.instance);
        if (list.length) out.set(f, list);
    }
    if (!lazyBacksCamera(session, cam)) return out;
    const loader = session.lazyLoader;
    const frames = new Set();
    loader.forEachInstanceRow(function (c, f, trk, info) {
        if (info && info.type === 'user' && !session.frameGroups.has(f)) frames.add(f);
    }, { camera: cam });
    const sorted = Array.from(frames).sort(function (a, b) { return a - b; });
    for (const f of sorted) {
        const wasCached = !!(loader.cache && typeof loader.cache.has === 'function' && loader.cache.has(f));
        const data = loader.getFrameSync(f);
        const rows = data && typeof data.get === 'function' ? data.get(cam) : null;
        const list = [];
        (rows || []).forEach(function (d, k) {
            if (!d || d.type !== 'user') return;
            const trk = (typeof d.trackIdx === 'number' && d.trackIdx >= 0) ? d.trackIdx : null;
            const inst = lazyRowInstance(d, trk);
            inst._rawInstIndex = k;
            list.push(inst);
        });
        if (list.length) out.set(f, list);
        if (!wasCached && typeof loader.releaseFrame === 'function') loader.releaseFrame(f);
    }
    return out;
}

/**
 * How many frames and instances of each camera are user-labelled, without building instances
 * for lazy rows (the Training panel's checklist).
 * @param {Object} session
 * @param {string[]} cams
 * @returns {Map<string, {frames: number, instances: number}>}
 */
export function countUserLabels(session, cams) {
    const out = new Map();
    for (const cam of cams) {
        const frames = new Set();
        let instances = 0;
        for (const [f, fg] of session.frameGroups) {
            let n = 0;
            for (const inst of (fg.instances.get(cam) || [])) if (inst && inst.type === 'user') n++;
            for (const u of fg.getUnlinkedInstances(cam)) if (u && u.instance && u.instance.type === 'user') n++;
            if (n) { frames.add(f); instances += n; }
        }
        if (lazyBacksCamera(session, cam)) {
            session.lazyLoader.forEachInstanceRow(function (c, f, trk, info) {
                if (!info || info.type !== 'user' || session.frameGroups.has(f)) return;
                frames.add(f); instances++;
            }, { camera: cam });
        }
        out.set(cam, { frames: frames.size, instances: instances });
    }
    return out;
}

/**
 * Collect the group's user instances and their tracks, selection by selection.
 * @param {Array<{sessionIndex: number, session: Object, cameraName: string}>} selections
 * @returns {{frames: Array<{sel: number, frameIdx: number, items: Array<{inst: Object, track: string|null}>}>,
 *            sessions: Map<number, {name: string, fromIdentity: boolean, trackNames: string[], userInstances: number, trackless: number}>}}
 */
export function collectGroupLabels(selections) {
    const frames = [];
    const sessions = new Map();
    const sources = new Map();
    selections.forEach(function (s, si) {
        let src = sources.get(s.session);
        if (!src) { src = exportTrackSource(s.session); sources.set(s.session, src); }
        let rep = sessions.get(s.sessionIndex);
        if (!rep) {
            rep = { name: s.session.name || ('session ' + (s.sessionIndex + 1)), fromIdentity: src.fromIdentity, trackNames: [], userInstances: 0, trackless: 0 };
            sessions.set(s.sessionIndex, rep);
        }
        const byFrame = userInstancesByFrame(s.session, s.cameraName);
        const order = Array.from(byFrame.keys()).sort(function (a, b) { return a - b; });
        for (const f of order) {
            const used = {};
            const items = [];
            for (const inst of byFrame.get(f)) {
                let ti = src.resolve(inst, s.cameraName, f);
                // One track per frame and camera: a second instance claiming it goes trackless,
                // as every LUC3D export does.
                if (ti != null && used[ti]) ti = null;
                if (ti != null) used[ti] = true;
                const name = ti != null ? src.names[ti] : null;
                rep.userInstances++;
                if (name == null) rep.trackless++;
                else if (rep.trackNames.indexOf(name) === -1) rep.trackNames.push(name);
                items.push({ inst: inst, track: name });
            }
            frames.push({ sel: si, frameIdx: f, items: items });
        }
    });
    return { frames: frames, sessions: sessions };
}

/**
 * Build the training and validation Labels of one group.
 *
 * @param {Array<{sessionIndex: number, session: Object, cameraName: string, videoFileInfo?: Object,
 *                videoFilename: string}>} selections - one per (session, view) of the group, in
 *   the order the video table (and `--video-paths`) must follow
 * @param {{split?: {fraction?: number, seed?: number|null, overfit?: boolean}, SIO?: Object,
 *          collected?: ReturnType<typeof collectGroupLabels>}} [opts]
 * @returns {{train: Object, val: Object, split: ReturnType<typeof splitMoments>,
 *            stats: {frames: number, instances: number, moments: number, trainMoments: number,
 *                    valMoments: number, videos: number, skipped: number}}}
 * @throws {Error} on a skeleton mismatch, a `${` name, or no labelled instance at all
 */
export function buildTrainingLabels(selections, opts) {
    const o = opts || {};
    const SIO = o.SIO || (typeof window !== 'undefined' ? window.SleapIO : null);
    if (!SIO) throw new Error('sleap-io.js not loaded');
    if (!selections || selections.length === 0) throw new Error('No views to train on.');

    const baseNames = nodeNames(selections[0].session.skeleton);
    const nodeOrders = selections.map(function (s) {
        const names = nodeNames(s.session.skeleton);
        const compat = validateSkeletonCompatibility({ nodes: baseNames }, { nodes: names });
        if (compat.error) throw new Error('Skeleton of ' + (s.session.name || 'a session') + ' differs: ' + compat.error);
        if (!compat.reorderMap) return null;
        const order = new Array(baseNames.length);
        for (let i = 0; i < compat.reorderMap.length; i++) order[compat.reorderMap[i]] = i;
        return order;
    });

    const collected = o.collected || collectGroupLabels(selections);
    const trackNames = [];
    for (const rep of collected.sessions.values()) {
        for (const n of rep.trackNames) if (trackNames.indexOf(n) === -1) trackNames.push(n);
    }
    trackNames.sort();
    const problem = interpolationProblem([
        { kind: 'node', names: baseNames },
        { kind: 'identity / track', names: trackNames },
        { kind: 'video', names: selections.map(function (s) { return s.videoFilename; }) },
    ]);
    if (problem) throw new Error(problem);

    const skel = selections[0].session.skeleton;
    const sioNodes = baseNames.map(function (n) { return new SIO.Node(n); });
    const skeleton = new SIO.Skeleton({
        nodes: sioNodes,
        edges: (skel.edges || []).map(function (e) { return new SIO.Edge(sioNodes[e[0]], sioNodes[e[1]]); }),
        name: skel.name || 'skeleton',
    });
    const tracks = trackNames.map(function (n) { return new SIO.Track(n); });
    const trackByName = {};
    trackNames.forEach(function (n, i) { trackByName[n] = tracks[i]; });

    function makeVideos() {
        return selections.map(function (s) {
            const cv = cameraExportVideo(s.session, s.cameraName, s.videoFileInfo || {});
            const shape = [cv.frames, cv.height, cv.width, 1];
            const v = new SIO.Video({
                filename: s.videoFilename,
                backendMetadata: { type: 'MediaVideo', shape: shape, filename: s.videoFilename, grayscale: false, bgr: false },
                openBackend: false,
            });
            v.shape = shape;
            return v;
        });
    }
    const trainVideos = makeVideos();
    const valVideos = makeVideos();

    const numNodes = baseNames.length;
    let skipped = 0;
    const built = [];                       // {key, sel, frameIdx, instances: [{pts, track}]}
    for (const fr of collected.frames) {
        const s = selections[fr.sel];
        const insts = [];
        for (const it of fr.items) {
            const pts = _buildSioPoints(it.inst, numNodes, undefined, nodeOrders[fr.sel]);
            if (!pts.some(function (p) { return p.visible; })) { skipped++; continue; }
            insts.push({ pts: pts, track: it.track });
        }
        if (insts.length) built.push({ key: momentKey(s.sessionIndex, fr.frameIdx), sel: fr.sel, frameIdx: fr.frameIdx, instances: insts });
    }
    if (built.length === 0) throw new Error('No labelled instances in these views. Label at least one frame before training.');

    const split = splitMoments(built.map(function (b) { return b.key; }), o.split);
    function labelsFor(videos, keep) {
        const lfs = [];
        for (const b of built) {
            if (!keep.has(b.key)) continue;
            lfs.push(new SIO.LabeledFrame({
                video: videos[b.sel],
                frameIdx: b.frameIdx,
                instances: b.instances.map(function (x) {
                    return new SIO.Instance({ points: x.pts, skeleton: skeleton, track: x.track != null ? (trackByName[x.track] || null) : null });
                }),
            }));
        }
        return new SIO.Labels({
            labeledFrames: lfs,
            videos: videos,
            skeletons: [skeleton],
            tracks: tracks,
            provenance: { source: 'lucid-training', exported_at: new Date().toISOString() },
        });
    }
    const train = labelsFor(trainVideos, split.train);
    const val = labelsFor(valVideos, split.val);
    let instances = 0;
    for (const b of built) instances += b.instances.length;
    return {
        train: train,
        val: val,
        split: split,
        stats: {
            frames: built.length,
            instances: instances,
            moments: new Set(built.map(function (b) { return b.key; })).size,
            trainMoments: split.train.size,
            valMoments: split.val.size,
            videos: selections.length,
            skipped: skipped,
        },
    };
}

/** The bytes of a training Labels object (no embedded frames). */
export async function trainingSlpBytes(labels, SIO) {
    const lib = SIO || (typeof window !== 'undefined' ? window.SleapIO : null);
    if (!lib) throw new Error('sleap-io.js not loaded');
    return await lib.saveSlpToBytes(labels);
}
