/**
 * slp-streaming-write.js — memory-bounded SLP *save* for large LAZY sessions
 * (phase-5 full pipeline), the write-side companion to `SioLazyLoader`.
 *
 * The eager builder (`buildSlpLabelsAllViews` + `saveSlpToBytes`) materializes one
 * `Labels` holding every `LabeledFrame`/`Instance` — fine for hand-labeled projects,
 * but on a lazy prediction session (≈108k frames × 3 cameras) it both re-OOMs and,
 * because it only iterates the resident `session.frameGroups`, silently drops every
 * unvisited frame. This builds the file **incrementally** instead.
 *
 * ## Multi-session two-pass design
 *
 * `SIO.openSlpWriter()` serializes `sessions_json`/`identities_json`
 * **synchronously at open time** (it does not re-read those arrays at
 * `close()`) — so every session's ref-based `RecordingSession` graph (with
 * final, file-GLOBAL `lf_idx`/`inst_idx` values — sleap-io resolves refs
 * against one flat, file-wide labeled-frames table, never per-session) must
 * be complete *before* the writer opens, which is *before* any frame data can
 * be streamed. For ONE lazy session that's naturally already true (the ref
 * graph is built, then the writer opens, then frames stream — see the single-
 * session wrapper below). For MULTIPLE large lazy sessions that can never all
 * be resident at once, this forces two passes, each holding only one
 * session's data at a time:
 *
 *   PASS 1 (compute + ref-graph): for each session — reopen its lazy loader,
 *   run Track All/Triangulate All (peak ~3.7 GB for a 108k-frame×3-camera
 *   session), then `buildSessionRefGraph()` against a shared running
 *   output-frame counter carried across sessions (never reset per session).
 *   The result kept resident per session is small (a ref-only
 *   `RecordingSession` + the materialized user-edit overlay instances) — the
 *   caller evicts everything else (lazy loader, `frameGroups`,
 *   `instanceGroups`) before moving to the next session.
 *
 *   PASS 2 (stream): once every session's ref graph is final, `openSlpWriter`
 *   is called ONCE with the complete `videos`/`tracks`/`skeletons`/
 *   `identities`/`sessions`. Then for each session again — reopen its lazy
 *   loader (cheap: `appendStore` reads straight from the columnar store, no
 *   Track All/Triangulate needed, ~1.2 GB not ~3.7 GB), stream its frames via
 *   `streamSessionIntoWriter()`, evict again.
 *
 * `appendStore` streams each camera's columnar `LazyDataStore` window-by-window
 * into resizable HDF5 datasets, constructing zero per-frame JS objects — so
 * nothing more than one internal window is ever resident. The 2D pose comes
 * straight from the lazy stores the loader already holds (no re-read).
 *
 * 2D user *corrections* on visited frames ARE overlaid: any resident frameGroup
 * carrying a user instance in a camera is a corrected/added `(camera, frameIdx)`.
 * Those camera-frames are materialized into `LabeledFrame`s and `appendFrames`d
 * FIRST, so #208's first-write-wins dedup shadows the store's original predicted
 * row; the grouping refs and every store frame's output index are then recomputed
 * to account for the prepended overlays plus the skipped store rows. Only edited
 * camera-frames are materialized (minimal at prediction scale); every other frame
 * streams from the columnar store untouched.
 */

import { _buildSioPoints } from './file-io.js';

function numAt(arr, i, dflt) {
    if (!arr || i < 0 || i >= arr.length) return dflt === undefined ? 0 : dflt;
    var v = Number(arr[i]);
    return isNaN(v) ? (dflt === undefined ? 0 : dflt) : v;
}

/** Resolve the output video path for a camera (mirrors buildSlpLabelsAllViews). */
function resolveVideoPath(cam, views, videoFiles) {
    var videoPath = cam.name + '.mp4';
    if (videoFiles) {
        for (var i = 0; i < videoFiles.length; i++) {
            var vf = videoFiles[i];
            if ((vf.name === cam.name || vf.assignedCamera === cam.name) && vf.videoPath) {
                return vf.videoPath;
            }
        }
    }
    return videoPath;
}

/**
 * Create a fresh cross-session writer context. Shared by every
 * `buildSessionRefGraph`/`openProjectWriter` call in one save so every
 * session's frame refs stay file-global (see module docstring). Reused
 * as-is for a single-session save (one session's `buildSessionRefGraph`
 * call against a context nobody else touches).
 */
export function createProjectWriterContext() {
    return {
        runningOut: 0,
        allSkeletons: [],          // SIO.Skeleton[], deduped by name across sessions
        skeletonByName: new Map(),
        allVideos: [],             // SIO.Video[], global index = videoIndexOffset for appendStore
        allTracks: [],             // SIO.Track[], global index = trackOffset for appendStore
        allIdentities: [],         // SIO.Identity[], concatenated across sessions
    };
}

/**
 * PASS 1, per session: build this session's ref-based `RecordingSession`
 * graph (skeleton/cameras/videos/tracks contribution, overlay plan,
 * instance-group refs) against the shared `ctx`. Requires `session.lazyLoader`
 * open and Track All/Triangulate All already run (needs `frameGroups`/
 * `instanceGroups`). Touches no writer — safe to call before
 * `openProjectWriter`. The caller may evict the session's lazy loader and
 * clear `frameGroups`/`instanceGroups` immediately after this returns; only
 * the small returned result needs to survive until pass 2.
 *
 * @returns {{ sioSession: Object, overlayLfs: Array, cam: Array<{name:string, videoIndex:number, trackBase:number}> }}
 */
export function buildSessionRefGraph(session, views, videoFiles, ctx) {
    var SIO = window.SleapIO;
    var loader = session.lazyLoader;
    if (!loader) throw new Error('buildSessionRefGraph requires a lazy session with a lazyLoader');
    // Reopened single-file project (`SioLazyLoader.openProjectSlp`): every camera
    // shares ONE `_lazyDataStore`, so its tracks + frames must be added/appended
    // exactly ONCE (not once per camera) or the re-save duplicates them.
    var _sharedStore = !!loader._sharedStore;
    var _sharedTrackBase = -1;

    // MEMORY (#134 follow-up): "Track All" materializes EVERY frame into
    // `frameGroups` (the cross-view tracker is sequential), so a
    // fully-triangulated 108k-frame session can hold multiple GB of 2D there
    // by the time this runs. The overlay plan below only ever looks at
    // user-edited frames (`camHasUserInstance` skips the rest), so free
    // every resident frame that carries NO user instance FIRST — before the
    // camera/instance-group loops below run — so GC can reclaim the bulk of
    // it while the rest of this function executes. The triangulated 3D
    // grouping is unaffected: it lives in `session.instanceGroups`, resolved
    // below against the (unpruned) lazy store.
    var _prunedFG = new Map();
    var _prunedCount = 0;
    for (var _fgEntry of session.frameGroups) {
        var _fIdx = _fgEntry[0], _fgObj = _fgEntry[1];
        var _hasUser = false;
        if (_fgObj.instances) {
            for (var _ci of _fgObj.instances) {
                var _list = _ci[1];
                for (var _li = 0; _li < _list.length; _li++) {
                    if (_list[_li] && _list[_li].type === 'user') { _hasUser = true; break; }
                }
                if (_hasUser) break;
            }
        }
        if (!_hasUser && _fgObj.unlinkedInstances) {
            for (var _ui of _fgObj.unlinkedInstances) {
                var _uls = _ui[1];
                for (var _uli = 0; _uli < _uls.length; _uli++) {
                    if (_uls[_uli] && _uls[_uli].instance && _uls[_uli].instance.type === 'user') { _hasUser = true; break; }
                }
                if (_hasUser) break;
            }
        }
        if (_hasUser) _prunedFG.set(_fIdx, _fgObj);
        else _prunedCount++;
    }
    session.frameGroups = _prunedFG;
    console.log('[slp-streaming-write] session', session.name || '(unnamed)', '- freed', _prunedCount,
        'non-edited resident frames before building its ref graph');

    // ---- Skeleton (dedup by name — sessions in one project typically share one) ----
    var skelName = session.skeleton.name || 'skeleton';
    var skeleton = ctx.skeletonByName.get(skelName);
    if (!skeleton) {
        var nodeNames = session.skeleton.nodes.map(function (n) {
            return typeof n === 'string' ? n : (n.name || '');
        });
        var sioNodes = nodeNames.map(function (name) { return new SIO.Node(name); });
        var sioEdges = (session.skeleton.edges || []).map(function (e) {
            return new SIO.Edge(sioNodes[e[0]], sioNodes[e[1]]);
        });
        skeleton = new SIO.Skeleton({ nodes: sioNodes, edges: sioEdges, name: skelName });
        ctx.skeletonByName.set(skelName, skeleton);
        ctx.allSkeletons.push(skeleton);
    }
    var numNodes = session.skeleton.nodes.length;

    // ---- Identities (session-scoped in LUCID; concatenated into ctx like tracks) ----
    var lucidIdToSioId = new Map();
    if (session.identities && session.identities.length > 0) {
        for (var iid = 0; iid < session.identities.length; iid++) {
            var lucidId = session.identities[iid];
            var sioId = new SIO.Identity({ name: lucidId.name, color: lucidId.color });
            ctx.allIdentities.push(sioId);
            lucidIdToSioId.set(lucidId.id, sioId);
        }
    }

    // ---- Per-camera stores, cameras, videos, and concatenated tracks ----
    // The header carries a Camera + Video for EVERY session camera (calibration
    // round-trip) — including calibration-only cameras with no loaded lazy store
    // (they just contribute no frames). Only cameras WITH a store go into `cam[]`
    // (the appendStore list). Every video/track index pushed here is GLOBAL
    // (position in `ctx.allVideos`/`ctx.allTracks`), not session-local, so a later
    // session's cameras/tracks never collide with an earlier one's.
    var sioCameras = [];
    var lucidCamToSioCam = new Map();
    var sessionVideoIndices = [];  // parallel to session.cameras / sioCameras
    var cam = [];                  // loaded cameras only: { name, sioCam, videoIndex, framesData, instancesData, rowMap, nFrames, trackBase }

    for (var ci = 0; ci < session.cameras.length; ci++) {
        var c = session.cameras[ci];

        var sioCam = new SIO.Camera({
            name: c.name, rvec: c.rvec || [0, 0, 0], tvec: c.tvec || [0, 0, 0],
            matrix: c.matrix, distortions: c.dist, size: c.size,
        });
        sioCameras.push(sioCam);
        lucidCamToSioCam.set(c.name, sioCam);

        var vw = 0, vh = 0, fc = 0;
        for (var vi = 0; vi < (views || []).length; vi++) {
            if (views[vi].name === c.name) {
                vw = views[vi].videoWidth || 0; vh = views[vi].videoHeight || 0;
                fc = views[vi].frameCount || 0; break;
            }
        }
        var videoPath = resolveVideoPath(c, views, videoFiles);
        var video = new SIO.Video({
            filename: videoPath,
            backendMetadata: { type: 'MediaVideo', shape: [fc, vh, vw, 1], filename: videoPath },
            openBackend: false,
        });
        video.shape = [fc, vh, vw, 1];
        var videoIndex = ctx.allVideos.length;
        ctx.allVideos.push(video);
        sessionVideoIndices.push(videoIndex);

        // Calibration-only camera (no loaded lazy store): header entry only, no
        // frames/tracks.
        var labels = loader.labelsByCam.get(c.name);
        var store = labels && labels._lazyDataStore;
        if (!store) continue;
        var framesData = store.framesData || {};
        var instancesData = store.instancesData || {};
        var rowMap = loader.frameRowByCam.get(c.name) || new Map();
        var nFrames = (framesData.frame_idx || framesData.frame_id || []).length;

        // Concatenate this camera's tracks into the GLOBAL header list. The
        // store's `instancesData.track` ids index into this camera's own tracks;
        // appendStore's trackOffset rebases them into the combined list. For a
        // shared store every camera has the SAME `labels.tracks`, so add them
        // ONCE and reuse one trackBase (else 2357 tracks × N cameras).
        var trackBase;
        if (_sharedStore) {
            if (_sharedTrackBase < 0) {
                _sharedTrackBase = ctx.allTracks.length;
                var camTracksS = (labels.tracks || []);
                for (var tiS = 0; tiS < camTracksS.length; tiS++) ctx.allTracks.push(new SIO.Track(camTracksS[tiS].name));
            }
            trackBase = _sharedTrackBase;
        } else {
            trackBase = ctx.allTracks.length;
            var camTracks = (labels.tracks || []);
            for (var ti = 0; ti < camTracks.length; ti++) {
                ctx.allTracks.push(new SIO.Track(camTracks[ti].name));
            }
        }

        cam.push({
            name: c.name, sioCam: sioCam, videoIndex: videoIndex, framesData: framesData, instancesData: instancesData,
            rowMap: rowMap, nFrames: nFrames, trackBase: trackBase,
        });
    }

    // ---- RecordingSession (ref-based grouping) ----
    var cameraGroup = new SIO.CameraGroup({ cameras: sioCameras });
    var sioSession = new SIO.RecordingSession({ cameraGroup: cameraGroup });
    sioSession.metadata = sioSession.metadata || {};
    var sessIdentitiesJson = [];
    if (session.identities) {
        for (var sidi = 0; sidi < session.identities.length; sidi++) {
            var sIdent = session.identities[sidi];
            var sIdentObj = { name: sIdent.name };
            if (sIdent.color) sIdentObj.color = sIdent.color;
            sessIdentitiesJson.push(sIdentObj);
        }
    }
    sioSession.metadata.lucid = {
        sessionName: session.name || null,
        trustTracks: session.trustTracks || false,
        frameIdentityMap: session.frameIdentityMap ? Array.from(session.frameIdentityMap.entries()) : [],
        identities: sessIdentitiesJson,
        skeleton: { name: session.skeleton.name || 'skeleton', nodes: session.skeleton.nodes, edges: session.skeleton.edges },
        tracks: session.tracks,
    };
    for (var av = 0; av < sioCameras.length; av++) sioSession.addVideo(ctx.allVideos[sessionVideoIndices[av]], sioCameras[av]);

    var camByName = new Map();
    for (var cbi = 0; cbi < cam.length; cbi++) camByName.set(cam[cbi].name, cam[cbi]);

    // ---- 2D user-correction overlay plan ----
    // A resident frameGroup carrying a user instance in camera `c` means `(c,
    // frameIdx)` was corrected or added after lazy-load, so its columnar store
    // row (the original prediction) is stale. Materialize the current per-camera
    // frame (grouped + unlinked instances, mirroring buildSlpLabelsAllViews) and
    // append it FIRST; #208's first-write-wins dedup then skips the store row.
    var overlayLfs = [];           // SIO.LabeledFrame[], appended before the stores
    var overlayByKey = new Map();  // "camName:frameIdx" -> { lfIndex, byInst, byTrack }
    var overlaidKeys = new Set();  // "camName:frameIdx" a store row must skip

    function camHasUserInstance(fg, camName) {
        var linked = fg.getInstances(camName);
        for (var li = 0; li < linked.length; li++) if (linked[li] && linked[li].type === 'user') return true;
        var ul = fg.getUnlinkedInstances(camName);
        for (var ui = 0; ui < ul.length; ui++) if (ul[ui] && ul[ui].instance && ul[ui].instance.type === 'user') return true;
        return false;
    }

    // Build one overlay SIO instance, resolving its track into the GLOBAL
    // header list (this camera's tracks start at `trackBase`). Carry a
    // per-point score on predicted siblings (SLEAP's GUI hides low-score
    // predicted points) so they don't visually vanish.
    function buildOverlayInstance(inst, trackBase) {
        var isPredicted = inst.type !== 'user';
        var perPointScore = isPredicted ? (inst.score != null ? inst.score : 1.0) : undefined;
        var pts = _buildSioPoints(inst, numNodes, perPointScore);
        var track = null;
        if (inst.trackIdx != null && inst.trackIdx >= 0) {
            var combinedIdx = trackBase + inst.trackIdx;
            if (combinedIdx >= 0 && combinedIdx < ctx.allTracks.length) track = ctx.allTracks[combinedIdx];
        }
        if (isPredicted) {
            return new SIO.PredictedInstance({ points: pts, skeleton: skeleton, track: track, score: inst.score || 0 });
        }
        return new SIO.Instance({ points: pts, skeleton: skeleton, track: track });
    }

    for (var [fgIdx, fg] of session.frameGroups) {
        for (var oc = 0; oc < cam.length; oc++) {
            var ocInfo = cam[oc];
            if (!camHasUserInstance(fg, ocInfo.name)) continue;
            var lucidInsts = [];
            var grouped = fg.getInstances(ocInfo.name);
            for (var gg = 0; gg < grouped.length; gg++) lucidInsts.push(grouped[gg]);
            var uls = fg.getUnlinkedInstances(ocInfo.name);
            for (var uu = 0; uu < uls.length; uu++) if (uls[uu] && uls[uu].instance) lucidInsts.push(uls[uu].instance);
            if (lucidInsts.length === 0) continue;
            var sioInsts = [];
            var byInst = new Map();
            var byTrack = new Map();
            for (var lii = 0; lii < lucidInsts.length; lii++) {
                var linst = lucidInsts[lii];
                sioInsts.push(buildOverlayInstance(linst, ocInfo.trackBase));
                byInst.set(linst, lii);
                var lt = (linst.trackIdx != null && linst.trackIdx >= 0) ? linst.trackIdx : -1;
                if (lt >= 0 && !byTrack.has(lt)) byTrack.set(lt, lii);
            }
            var okey = ocInfo.name + ':' + fgIdx;
            overlayByKey.set(okey, { lfIndex: overlayLfs.length, byInst: byInst, byTrack: byTrack });
            overlaidKeys.add(okey);
            overlayLfs.push(new SIO.LabeledFrame({ video: ctx.allVideos[ocInfo.videoIndex], frameIdx: fgIdx, instances: sioInsts }));
        }
    }

    // Output frame index of each store row, continuing the SHARED running
    // counter (never resetting per session — refs are file-global). Overlays
    // for THIS session occupy [ctx.runningOut, overlayBase+E); then each of
    // this session's cameras' non-skipped rows continue in camera/row order.
    var overlayBase = ctx.runningOut;
    var E = overlayLfs.length;
    var runningOut = overlayBase + E;
    if (_sharedStore && cam.length > 0) {
        // Shared multi-camera store, appended ONCE: build a SINGLE store-row →
        // output-lf map that every camera reuses. A store row belongs to one
        // camera via its video id (which matches the header camera order for a
        // fresh single-session reopen, so appendStore offset 0 is correct); skip
        // rows overlaid by a user correction for that camera.
        var sInfo = cam[0];
        var sharedOut = new Map();
        var sFidx = sInfo.framesData.frame_idx || sInfo.framesData.frame_id || [];
        var sVideo = sInfo.framesData.video || [];
        var videoToCam = new Map();
        for (var vci = 0; vci < cam.length; vci++) videoToCam.set(cam[vci].videoIndex, cam[vci].name);
        for (var srow = 0; srow < sInfo.nFrames; srow++) {
            var sCamName = videoToCam.get(numAt(sVideo, srow));
            if (sCamName && overlaidKeys.has(sCamName + ':' + numAt(sFidx, srow))) continue;
            sharedOut.set(srow, runningOut++);
        }
        for (var aci = 0; aci < cam.length; aci++) cam[aci].storeOutIndex = sharedOut;
    } else {
        for (var so = 0; so < cam.length; so++) {
            var soInfo = cam[so];
            soInfo.storeOutIndex = new Map();
            var soFidx = soInfo.framesData.frame_idx || soInfo.framesData.frame_id || [];
            for (var row = 0; row < soInfo.nFrames; row++) {
                if (overlaidKeys.has(soInfo.name + ':' + numAt(soFidx, row))) continue;
                soInfo.storeOutIndex.set(row, runningOut++);
            }
        }
    }
    ctx.runningOut = runningOut;

    // Adjust overlay lfIndex values (currently local to this session's
    // `overlayLfs`, i.e. 0-based) to the shared/global numbering.
    for (var [, ov] of overlayByKey) ov.lfIndex += overlayBase;

    // Diagnostic counters for the non-overlay ref-resolution path (#158
    // investigation) — logged once at the end of this function. `ambiguous`
    // counts frames where the OLD trackIdx-guess heuristic could not have
    // disambiguated (>1 raw instance in range, no unique trackIdx match) —
    // i.e. cases that were silently wrong before `_rawInstIndex` tagging.
    var _refStats = { total: 0, tagged: 0, fallback: 0, ambiguous: 0 };

    // Find the output [lfIndex, instIndex] for a grouped LUCID instance `gInst`
    // in camera `camName` at `frameIdx`.
    function refFor(camName, frameIdx, gInst) {
        var ov = overlayByKey.get(camName + ':' + frameIdx);
        if (ov) {
            var oi = ov.byInst.get(gInst);
            if (oi === undefined) {
                var gt = (gInst && gInst.trackIdx != null && gInst.trackIdx >= 0) ? gInst.trackIdx : -1;
                if (gt >= 0) oi = ov.byTrack.get(gt);
            }
            if (oi === undefined) oi = 0;
            return [ov.lfIndex, oi];
        }
        var ci2 = camByName.get(camName);
        if (!ci2) return null;
        var row = ci2.rowMap.get(frameIdx);
        if (row === undefined) return null;
        var lfIndex = ci2.storeOutIndex ? ci2.storeOutIndex.get(row) : undefined;
        if (lfIndex === undefined) return null;
        var start = numAt(ci2.framesData.instance_id_start, row);
        var end = numAt(ci2.framesData.instance_id_end, row);
        var instIndex = 0;
        // Prefer the exact row offset tagged when this Instance was first
        // materialized from the lazy store (`_rawInstIndex` — see
        // ensureLazyFrameData/buildLazyFrameGroupSync/batchLoadLazyFrames in
        // pose/triangulation.js). Track-based matching below is ambiguous
        // whenever a camera-frame has more than one raw instance and the
        // grouped one is trackless (or its trackIdx collides/doesn't match a
        // row) — it silently fell back to `instIndex = 0`, which is wrong for
        // any frame with >1 instance and misattributes 2D pose/track data on
        // reload (#158). Fall back to the old heuristic only for instances
        // that never went through that tagging path (e.g. pre-existing
        // frameGroups from an older in-memory session state).
        _refStats.total++;
        if (gInst && gInst._rawInstIndex != null && gInst._rawInstIndex >= 0 && (start + gInst._rawInstIndex) < end) {
            instIndex = gInst._rawInstIndex;
            _refStats.tagged++;
        } else {
            _refStats.fallback++;
            var trackIdx = (gInst && gInst.trackIdx != null) ? gInst.trackIdx : null;
            var matched = false;
            if (trackIdx != null && trackIdx >= 0) {
                for (var j = start; j < end; j++) {
                    if (numAt(ci2.instancesData.track, j, -1) === trackIdx) { instIndex = j - start; matched = true; break; }
                }
            }
            if ((end - start) > 1 && !matched) _refStats.ambiguous++;
        }
        return [lfIndex, instIndex];
    }

    var groupedFrameIdxs = Array.from(session.instanceGroups.keys()).sort(function (a, b) { return a - b; });
    for (var gf = 0; gf < groupedFrameIdxs.length; gf++) {
        var frameIdx = groupedFrameIdxs[gf];
        var groups = session.instanceGroups.get(frameIdx) || [];
        var sioInstanceGroups = [];
        for (var gi = 0; gi < groups.length; gi++) {
            var group = groups[gi];
            var instanceRefsByCamera = new Map();
            var labeledFrameRefsByCamera = new Map();
            var igLucidMeta = {
                instanceMeta: {},
                identityId: (group.identityId != null && group.identityId >= 0) ? group.identityId : -1,
            };
            var refCount = 0;
            for (var entry of group.instances) {
                var gCamName = entry[0];
                var gInst = entry[1];
                var sioCamRef = lucidCamToSioCam.get(gCamName);
                if (!sioCamRef) continue;
                var ref = refFor(gCamName, frameIdx, gInst);
                if (!ref) continue;
                instanceRefsByCamera.set(sioCamRef, ref);
                labeledFrameRefsByCamera.set(sioCamRef, ref[0]);
                refCount++;
                // Slim metadata (#134): only non-reconstructable fields, only
                // when set (trackIdx/type/score/occluded derive from the
                // standard instance on load).
                var instMeta = {};
                var hasMeta = false;
                if (gInst.modified) { instMeta.modified = true; hasMeta = true; }
                if (gInst.nulledNodes && gInst.nulledNodes.size > 0) { instMeta.nulledNodes = Array.from(gInst.nulledNodes); hasMeta = true; }
                if (hasMeta) igLucidMeta.instanceMeta[gCamName] = instMeta;
            }
            if (refCount === 0) continue;

            var instance3d = undefined;
            if (group.points3d && group.points3d.length > 0) {
                instance3d = new SIO.Instance3D({ points: group.points3d, skeleton: skeleton });
            }
            var identity = undefined;
            if (group.identityId != null && group.identityId >= 0) identity = lucidIdToSioId.get(group.identityId);

            sioInstanceGroups.push(new SIO.InstanceGroup({
                instanceRefsByCamera: instanceRefsByCamera,
                instance3d: instance3d,
                identity: identity,
                metadata: { lucid: igLucidMeta },
            }));
        }
        if (sioInstanceGroups.length === 0) continue;
        var fgRefs = new Map();
        for (var ig2 = 0; ig2 < sioInstanceGroups.length; ig2++) {
            var m = sioInstanceGroups[ig2]._instanceRefsByCamera;
            if (m) for (var e2 of m) fgRefs.set(e2[0], e2[1][0]);
        }
        sioSession.frameGroups.set(frameIdx, new SIO.FrameGroup({
            frameIdx: frameIdx, instanceGroups: sioInstanceGroups, labeledFrameRefsByCamera: fgRefs,
        }));
    }

    console.log('[slp-streaming-write] session', session.name || '(unnamed)', '- ref resolution:',
        _refStats.total, 'refs,', _refStats.tagged, 'via _rawInstIndex,', _refStats.fallback,
        'via trackIdx fallback (', _refStats.ambiguous, 'of those genuinely ambiguous — >1 raw instance, no track match; would have silently defaulted to instIndex=0 before this fix)');

    // Returned `cam` is intentionally slim — no `framesData`/`instancesData`/
    // `rowMap` references, so the caller's eviction of `session.lazyLoader`
    // actually frees that memory instead of it surviving via this result.
    var camOut = cam.map(function (c) { return { name: c.name, videoIndex: c.videoIndex, trackBase: c.trackBase }; });

    return { sioSession: sioSession, overlayLfs: overlayLfs, cam: camOut };
}

/**
 * Open the project writer once every session's ref graph is final (§
 * module docstring — `sessions`/`identities`/`videos`/`tracks`/`skeletons`
 * must be complete at this point; `openSlpWriter` serializes them
 * synchronously).
 */
export async function openProjectWriter(ctx, allSioSessions, provenance) {
    var SIO = window.SleapIO;
    if (!SIO || typeof SIO.openSlpWriter !== 'function') {
        throw new Error('sleap-io.js streaming writer (openSlpWriter) not available');
    }
    return await SIO.openSlpWriter({
        skeletons: ctx.allSkeletons,
        videos: ctx.allVideos,
        tracks: ctx.allTracks,
        identities: ctx.allIdentities,
        sessions: allSioSessions,
        provenance: provenance || { source: 'lucid', exported_at: new Date().toISOString() },
    });
}

/**
 * PASS 2, per session: stream this session's 2D data into an already-open
 * writer, using the offsets computed for it in pass 1
 * (`refGraphResult.cam[i].videoIndex`/`.trackBase`). Requires
 * `session.lazyLoader` to be (re)opened — Track All/Triangulate All are NOT
 * needed here; `appendStore` reads straight from the columnar store.
 */
export function streamSessionIntoWriter(writer, session, refGraphResult) {
    var loader = session.lazyLoader;
    if (!loader) throw new Error('streamSessionIntoWriter requires session.lazyLoader to be (re)opened');
    if (refGraphResult.overlayLfs.length > 0) writer.appendFrames(refGraphResult.overlayLfs);
    if (loader._sharedStore) {
        // Reopened single-file project: ONE store holds every camera's frames with
        // their native video ids (aligned to the header camera order). Append it
        // ONCE — appending per camera rewrites the whole store N times (duplicate
        // frames + tracks). offset 0 = identity video map; trackBase is shared.
        var anyCam = refGraphResult.cam[0];
        if (anyCam) {
            var sLabels = loader.labelsByCam.get(anyCam.name);
            var sStore = sLabels && sLabels._lazyDataStore;
            if (sStore) writer.appendStore(sStore, { videoIndexOffset: 0, trackOffset: anyCam.trackBase });
        }
        return;
    }
    for (var i = 0; i < refGraphResult.cam.length; i++) {
        var camInfo = refGraphResult.cam[i];
        var labels = loader.labelsByCam.get(camInfo.name);
        var store = labels && labels._lazyDataStore;
        if (!store) continue;
        writer.appendStore(store, { videoIndexOffset: camInfo.videoIndex, trackOffset: camInfo.trackBase });
    }
}

/** Finalize the writer (bytes in memory, or streamed to `opts.sink`). */
export async function finalizeProjectWriter(writer, opts) {
    opts = opts || {};
    if (opts.sink) {
        await writer.writeToSink(opts.sink, { chunkBytes: opts.chunkBytes });
        return null;
    }
    return writer.close();
}

/**
 * Build the `.slp` bytes for ONE lazy session, memory-bounded — thin wrapper
 * around the pass-1/pass-2 primitives above for the single-session case
 * (existing callers/tests).
 *
 * @param {Object} session       LUCID Session (must have `.lazyLoader`).
 * @param {Array}  views         state.views (for video dimensions).
 * @param {Array}  videoFiles    state.videoFiles (for filenames).
 * @param {Object} [opts]        { sink, chunkBytes } — if `sink` is given, streams
 *                               the output via `writeToSink` and resolves to null;
 *                               otherwise resolves to the Uint8Array.
 * @returns {Promise<Uint8Array|null>}
 */
export async function buildSessionSlpBytesStreaming(session, views, videoFiles, opts) {
    var ctx = createProjectWriterContext();
    var refGraph = buildSessionRefGraph(session, views, videoFiles, ctx);
    var writer = await openProjectWriter(ctx, [refGraph.sioSession], (opts || {}).provenance);
    try {
        streamSessionIntoWriter(writer, session, refGraph);
        return await finalizeProjectWriter(writer, opts);
    } catch (err) {
        try { if (typeof writer.dispose === 'function') writer.dispose(); } catch (e) { /* ignore */ }
        throw err;
    }
}
