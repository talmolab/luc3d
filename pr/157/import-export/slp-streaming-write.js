/**
 * slp-streaming-write.js — memory-bounded SLP *save* for large LAZY sessions
 * (phase-5 full pipeline), the write-side companion to `SioLazyLoader`.
 *
 * The eager builder (`buildSlpLabelsAllViews` + `saveSlpToBytes`) materializes one
 * `Labels` holding every `LabeledFrame`/`Instance` — fine for hand-labeled projects,
 * but on a lazy prediction session (≈108k frames × 3 cameras) it both re-OOMs and,
 * because it only iterates the resident `session.frameGroups`, silently drops every
 * unvisited frame. This builds the file **incrementally** instead:
 *
 *   openSlpWriter({ skeletons, videos, tracks, sessions, provenance })
 *     → appendStore(perCameraLazyStore, { videoIndexOffset, trackOffset })   // ×N cameras
 *     → close()  /  writeToSink()
 *
 * `appendStore` streams each camera's columnar `LazyDataStore` window-by-window into
 * resizable HDF5 datasets, constructing zero per-frame JS objects — so nothing more
 * than one internal window is ever resident. The 2D pose comes straight from the
 * lazy stores the loader already holds (no re-read).
 *
 * The triangulated 3D grouping (`session.instanceGroups`) is carried as a **ref-based**
 * `RecordingSession`: each `FrameGroup`/`InstanceGroup` references its frames/instances
 * by output index (`labeledFrameRefsByCamera` / `instanceRefsByCamera`) rather than by
 * object, so the session graph stays compact (indices + `Instance3D` + metadata, no
 * frame objects) and `sessions_json` serializes with zero frame materialization
 * (sleap-io.js #208). The output layout is deterministic — overlays (below) occupy
 * output frames `[0, E)`, then `appendStore` emits each camera's non-skipped store
 * rows in order — so a grouped frame's output index is computed up front from the
 * columnar store into a per-camera `storeOutIndex` map (see `refFor`).
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
 * Build the `.slp` bytes for ONE lazy session, memory-bounded.
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
    var SIO = window.SleapIO;
    if (!SIO || typeof SIO.openSlpWriter !== 'function') {
        throw new Error('sleap-io.js streaming writer (openSlpWriter) not available');
    }
    var loader = session.lazyLoader;
    if (!loader) throw new Error('buildSessionSlpBytesStreaming requires a lazy session');
    opts = opts || {};

    // ---- Skeleton ----
    var nodeNames = session.skeleton.nodes.map(function (n) {
        return typeof n === 'string' ? n : (n.name || '');
    });
    var sioNodes = nodeNames.map(function (name) { return new SIO.Node(name); });
    var sioEdges = (session.skeleton.edges || []).map(function (e) {
        return new SIO.Edge(sioNodes[e[0]], sioNodes[e[1]]);
    });
    var skeleton = new SIO.Skeleton({
        nodes: sioNodes, edges: sioEdges, name: session.skeleton.name || 'skeleton',
    });

    // ---- Identities ----
    var lucidIdToSioId = new Map();
    var sioIdentities = [];
    if (session.identities && session.identities.length > 0) {
        for (var iid = 0; iid < session.identities.length; iid++) {
            var lucidId = session.identities[iid];
            var sioId = new SIO.Identity({ name: lucidId.name, color: lucidId.color });
            sioIdentities.push(sioId);
            lucidIdToSioId.set(lucidId.id, sioId);
        }
    }

    // ---- Per-camera stores, cameras, videos, and concatenated tracks ----
    // The header carries a Camera + Video for EVERY session camera (calibration
    // round-trip), matching the eager `buildSlpLabelsAllViews` — including
    // calibration-only cameras that have no loaded lazy store (they just contribute
    // no frames). Only cameras WITH a store go into `cam[]` (the appendStore list),
    // each tagged with its `videoIndex` (position in the full `sioVideos`) so the
    // appendStore video offset + the overlay's video reference stay correct even
    // when some cameras are skipped. Output frame layout: overlays first, then each
    // `cam[]` camera's non-skipped store rows in order (see `storeOutIndex`/`refFor`).
    var sioCameras = [];
    var sioVideos = [];
    var lucidCamToSioCam = new Map();
    var allTracks = [];
    var cam = [];           // loaded cameras only: { name, sioCam, videoIndex, framesData, instancesData, rowMap, nFrames, trackBase, storeOutIndex }
    var runningTrackBase = 0;

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
        sioVideos.push(video);

        // Calibration-only camera (no loaded lazy store): header entry only, no
        // frames/tracks. The eager builder tolerates this; the streaming one must too.
        var labels = loader.labelsByCam.get(c.name);
        var store = labels && labels._lazyDataStore;
        if (!store) continue;
        var framesData = store.framesData || {};
        var instancesData = store.instancesData || {};
        var rowMap = loader.frameRowByCam.get(c.name) || new Map();
        var nFrames = (framesData.frame_idx || framesData.frame_id || []).length;

        // Concatenate this camera's tracks into the combined header list. The store's
        // `instancesData.track` ids index into this camera's own tracks; appendStore's
        // trackOffset rebases them into the combined list.
        var camTracks = (labels.tracks || []);
        for (var ti = 0; ti < camTracks.length; ti++) {
            allTracks.push(new SIO.Track(camTracks[ti].name));
        }

        cam.push({
            name: c.name, sioCam: sioCam, videoIndex: ci, framesData: framesData, instancesData: instancesData,
            rowMap: rowMap, nFrames: nFrames, trackBase: runningTrackBase,
            _labels: labels,
        });
        runningTrackBase += camTracks.length;
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
    for (var av = 0; av < session.cameras.length; av++) sioSession.addVideo(sioVideos[av], sioCameras[av]);

    var camByName = new Map();
    for (var cbi = 0; cbi < cam.length; cbi++) camByName.set(cam[cbi].name, cam[cbi]);
    var numNodes = session.skeleton.nodes.length;

    // ---- 2D user-correction overlay plan ----
    // A resident frameGroup carrying a user instance in camera `c` means `(c,
    // frameIdx)` was corrected or added after lazy-load, so its columnar store row
    // (the original prediction) is stale. Materialize the current per-camera frame
    // (grouped + unlinked instances, mirroring buildSlpLabelsAllViews) and append
    // it FIRST; #208's first-write-wins dedup then skips the store row. Detection
    // and materialization are per (camera, frameIdx) — only edited camera-frames
    // are built; every other frame streams straight from the store.
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

    // Build one overlay SIO instance, resolving its track into the combined header
    // list (this camera's tracks start at `trackBase`) — mirrors _getOrCreateSioInst.
    // The whole store row is skipped for an edited camera-frame, so its untouched
    // PREDICTED siblings are re-materialized here too. Carry a per-point score on
    // them (the frameGroup keeps only the instance-level score) so SLEAP's GUI —
    // which hides predicted points below a small score threshold — still shows
    // them; without it the streamed store row's real scores would be lost to 0 and
    // those animals would vanish. Mirrors the eager per-camera export (buildSlpLabels).
    function buildOverlayInstance(inst, trackBase) {
        var isPredicted = inst.type !== 'user';
        var perPointScore = isPredicted ? (inst.score != null ? inst.score : 1.0) : undefined;
        var pts = _buildSioPoints(inst, numNodes, perPointScore);
        var track = null;
        if (inst.trackIdx != null && inst.trackIdx >= 0) {
            var combinedIdx = trackBase + inst.trackIdx;
            if (combinedIdx >= 0 && combinedIdx < allTracks.length) track = allTracks[combinedIdx];
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
            // Full per-camera instance set: grouped first, then unlinked (matches
            // buildSlpLabelsAllViews). The store row is skipped as a whole, so the
            // overlay must also carry the frame's untouched predicted siblings.
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
            overlayLfs.push(new SIO.LabeledFrame({ video: sioVideos[ocInfo.videoIndex], frameIdx: fgIdx, instances: sioInsts }));
        }
    }
    var E = overlayLfs.length;

    // Output frame index of each store row, accounting for the E prepended overlays
    // and any store rows shadowed by an overlay (skipped by appendStore). Mirrors
    // the writer's running frame counter: overlays occupy [0, E); then each camera's
    // NON-skipped rows continue in camera/row order.
    var runningOut = E;
    for (var so = 0; so < cam.length; so++) {
        var soInfo = cam[so];
        soInfo.storeOutIndex = new Map();
        var soFidx = soInfo.framesData.frame_idx || soInfo.framesData.frame_id || [];
        for (var row = 0; row < soInfo.nFrames; row++) {
            if (overlaidKeys.has(soInfo.name + ':' + numAt(soFidx, row))) continue;
            soInfo.storeOutIndex.set(row, runningOut++);
        }
    }

    // Find the output [lfIndex, instIndex] for a grouped LUCID instance `gInst` in
    // camera `camName` at `frameIdx`. Resolves to the prepended overlay when that
    // camera-frame was user-edited, else to the (shifted) store row. Returns null if
    // the frame isn't present in that camera.
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
        var ci = camByName.get(camName);
        if (!ci) return null;
        var row = ci.rowMap.get(frameIdx);
        if (row === undefined) return null;
        var lfIndex = ci.storeOutIndex ? ci.storeOutIndex.get(row) : undefined;
        if (lfIndex === undefined) return null;
        var start = numAt(ci.framesData.instance_id_start, row);
        var end = numAt(ci.framesData.instance_id_end, row);
        var trackIdx = (gInst && gInst.trackIdx != null) ? gInst.trackIdx : null;
        var instIndex = 0; // default: first instance in the frame
        if (trackIdx != null && trackIdx >= 0) {
            for (var j = start; j < end; j++) {
                if (numAt(ci.instancesData.track, j, -1) === trackIdx) { instIndex = j - start; break; }
            }
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
                // when set (trackIdx/type/score/occluded derive from the standard
                // instance on load). Mirrors buildSlpLabelsAllViews.
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
        // A frame group's own labeled-frame refs: union of its instance groups' refs.
        var fgRefs = new Map();
        for (var ig2 = 0; ig2 < sioInstanceGroups.length; ig2++) {
            var m = sioInstanceGroups[ig2]._instanceRefsByCamera;
            if (m) for (var e2 of m) fgRefs.set(e2[0], e2[1][0]);
        }
        sioSession.frameGroups.set(frameIdx, new SIO.FrameGroup({
            frameIdx: frameIdx, instanceGroups: sioInstanceGroups, labeledFrameRefsByCamera: fgRefs,
        }));
    }

    // ---- Write incrementally ----
    var writer = await SIO.openSlpWriter({
        skeletons: [skeleton],
        videos: sioVideos,
        tracks: allTracks,
        identities: sioIdentities,
        sessions: [sioSession],
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    });
    try {
        // Overlays FIRST — their (video, frameIdx) keys win #208's dedup so the
        // matching store rows below are skipped (recomputed in storeOutIndex).
        if (overlayLfs.length > 0) writer.appendFrames(overlayLfs);
        for (var ai = 0; ai < cam.length; ai++) {
            var camInfo = cam[ai];
            var camStore = loader.labelsByCam.get(camInfo.name)._lazyDataStore;
            writer.appendStore(camStore, { videoIndexOffset: camInfo.videoIndex, trackOffset: camInfo.trackBase });
        }
        if (opts.sink) {
            await writer.writeToSink(opts.sink, { chunkBytes: opts.chunkBytes });
            return null;
        }
        return writer.close();
    } catch (err) {
        try { if (typeof writer.dispose === 'function') writer.dispose(); } catch (e) { /* ignore */ }
        throw err;
    }
}
