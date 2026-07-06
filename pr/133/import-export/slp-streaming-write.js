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
 * (sleap-io.js #208). The output layout is deterministic — `appendStore` emits camera
 * c's store rows in order — so a grouped frame's output index is
 * `cameraBase[c] + storeRow`, computed up front from the columnar store.
 *
 * v1 scope: predictions + full grouping (identities + 3D). Per-frame 2D user
 * *corrections* on visited frames are NOT yet overlaid here — see
 * `buildSessionSlpBytesStreaming` notes and the phase-5 plan.
 */

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
    // Deterministic output layout: cameras in session.cameras order; each camera's
    // store rows appended in order, so output lf-index = cameraBase[c] + storeRow.
    var sioCameras = [];
    var sioVideos = [];
    var lucidCamToSioCam = new Map();
    var allTracks = [];
    var cam = [];           // per-camera: { name, sioCam, store, framesData, instancesData, rowMap, nFrames, cameraBase, trackBase }
    var runningFrameBase = 0;
    var runningTrackBase = 0;

    for (var ci = 0; ci < session.cameras.length; ci++) {
        var c = session.cameras[ci];
        var labels = loader.labelsByCam.get(c.name);
        var store = labels && labels._lazyDataStore;
        if (!store) throw new Error('lazy store missing for camera ' + c.name);
        var framesData = store.framesData || {};
        var instancesData = store.instancesData || {};
        var rowMap = loader.frameRowByCam.get(c.name) || new Map();
        var nFrames = (framesData.frame_idx || framesData.frame_id || []).length;

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

        // Concatenate this camera's tracks into the combined header list. The store's
        // `instancesData.track` ids index into this camera's own tracks; appendStore's
        // trackOffset rebases them into the combined list.
        var camTracks = (labels.tracks || []);
        for (var ti = 0; ti < camTracks.length; ti++) {
            allTracks.push(new SIO.Track(camTracks[ti].name));
        }

        cam.push({
            name: c.name, sioCam: sioCam, framesData: framesData, instancesData: instancesData,
            rowMap: rowMap, nFrames: nFrames, cameraBase: runningFrameBase, trackBase: runningTrackBase,
            _labels: labels,
        });
        runningFrameBase += nFrames;
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
    for (var av = 0; av < cam.length; av++) sioSession.addVideo(sioVideos[av], sioCameras[av]);

    var camByName = new Map();
    for (var cbi = 0; cbi < cam.length; cbi++) camByName.set(cam[cbi].name, cam[cbi]);

    // Find the output [lfIndex, instIndex] for a grouped LUCID instance in camera
    // `camName` at `frameIdx`. Returns null if the frame/instance isn't in that
    // camera's store (e.g. camera not labeled in that frame).
    function refFor(camName, frameIdx, trackIdx) {
        var ci = camByName.get(camName);
        if (!ci) return null;
        var row = ci.rowMap.get(frameIdx);
        if (row === undefined) return null;
        var lfIndex = ci.cameraBase + row;
        var start = numAt(ci.framesData.instance_id_start, row);
        var end = numAt(ci.framesData.instance_id_end, row);
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
                var ref = refFor(gCamName, frameIdx, gInst.trackIdx);
                if (!ref) continue;
                instanceRefsByCamera.set(sioCamRef, ref);
                labeledFrameRefsByCamera.set(sioCamRef, ref[0]);
                refCount++;
                var instMeta = {
                    trackIdx: gInst.trackIdx, type: gInst.type || 'user',
                    score: gInst.score || 0, modified: gInst.modified || false,
                };
                if (gInst.nulledNodes && gInst.nulledNodes.size > 0) instMeta.nulledNodes = Array.from(gInst.nulledNodes);
                if (gInst.occluded) {
                    var hasAnyOcc = false;
                    for (var ok in gInst.occluded) { if (gInst.occluded[ok]) { hasAnyOcc = true; break; } }
                    if (hasAnyOcc) instMeta.occluded = gInst.occluded;
                }
                igLucidMeta.instanceMeta[gCamName] = instMeta;
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
        for (var ai = 0; ai < cam.length; ai++) {
            var camInfo = cam[ai];
            var camStore = loader.labelsByCam.get(camInfo.name)._lazyDataStore;
            writer.appendStore(camStore, { videoIndexOffset: ai, trackOffset: camInfo.trackBase });
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
