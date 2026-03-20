/**
 * slp-import-worker.js - Web Worker for parsing SLP HDF5 files
 *
 * Runs h5wasm in a worker thread so the main thread stays responsive.
 * Uses WORKERFS to mount File objects directly (no memory duplication).
 *
 * Messages IN:
 *   { type: 'parse', file: File }
 *
 * Messages OUT:
 *   { type: 'progress', message: string }
 *   { type: 'result', data: { skeleton, tracks, frames, videos, embeddedVideos, sessions } }
 *   { type: 'error', message: string }
 */

importScripts('https://cdn.jsdelivr.net/npm/h5wasm@0.8.8/dist/iife/h5wasm.js');

var h5wasmReady = false;
var FS = null;
var pendingMessages = [];

// Initialize h5wasm, then drain any queued messages
(async function () {
    try {
        await h5wasm.ready;
        FS = h5wasm.FS;
        h5wasmReady = true;
        progress('h5wasm initialized');

        // Process any messages that arrived during init
        while (pendingMessages.length > 0) {
            var msg = pendingMessages.shift();
            await handleMessage(msg);
        }
    } catch (err) {
        postMessage({ type: 'error', message: 'Failed to init h5wasm: ' + err.message });
    }
})();

async function handleMessage(data) {
    if (data.type === 'parse' && data.file) {
        await parseSlp(data.file);
    }
}

onmessage = async function (e) {
    if (!h5wasmReady) {
        pendingMessages.push(e.data);
        return;
    }
    await handleMessage(e.data);
};

function progress(msg) {
    postMessage({ type: 'progress', message: msg });
}

async function parseSlp(file) {
    try {
        progress('Mounting file (' + (file.size / 1048576).toFixed(1) + ' MB)...');

        // Mount file via WORKERFS (zero-copy, worker-only)
        try { FS.mkdir('/work'); } catch (e) { /* exists */ }
        try { FS.unmount('/work'); } catch (e) { /* not mounted */ }
        FS.mount(FS.filesystems.WORKERFS, { files: [file] }, '/work');

        var h5path = '/work/' + file.name;
        var f = new h5wasm.File(h5path, 'r');

        progress('Reading metadata...');

        // --- Detect analysis H5 format ---
        // Analysis H5 files have a top-level 'tracks' dataset but no 'metadata' group.
        var hasTracksDs = false;
        var hasMetadata = false;
        try { hasTracksDs = !!f.get('tracks'); } catch (e) { }
        try { hasMetadata = !!f.get('metadata'); } catch (e) { }
        if (hasTracksDs && !hasMetadata) {
            progress('Detected SLEAP analysis H5 format');
            parseAnalysisH5(f, file.name);
            return;
        }

        // --- Metadata ---
        var metadataGroup = null;
        try { metadataGroup = f.get('metadata'); } catch (e) {
            progress('Warning: no metadata group: ' + e.message);
        }
        var jsonAttr = null;
        if (metadataGroup) {
            try { jsonAttr = metadataGroup.attrs['json']; } catch (e) {
                progress('Warning: no json attr: ' + e.message);
            }
        }
        var metadataJson = {};
        if (jsonAttr) {
            var jsonStr = typeof jsonAttr.value === 'string'
                ? jsonAttr.value
                : new TextDecoder().decode(jsonAttr.value);
            metadataJson = JSON.parse(jsonStr);
        }

        // --- Skeleton ---
        // IMPORTANT: metadataJson.nodes is the GLOBAL node list (arbitrary order).
        // skeletons[0].nodes defines the SKELETON ordering via id fields.
        // Points in the HDF5 dataset are stored in skeleton order.
        // We must reorder node names and remap edge indices to skeleton order.
        var nodes = [];
        var edges = [];
        var skelName = 'skeleton';

        // Get global node names first
        var globalNodes = [];
        if (metadataJson.nodes) {
            globalNodes = metadataJson.nodes.map(function (n) { return n.name || n; });
        }

        if (metadataJson.skeletons && metadataJson.skeletons.length > 0) {
            var skel = metadataJson.skeletons[0];
            skelName = (skel.graph && skel.graph.name) || skel.name || 'skeleton';

            // Build global-ID → skeleton-position map from skeleton's node ordering
            // skel.nodes[i].id = global node ID at skeleton position i
            var idToPos = {};
            var hasIdMapping = skel.nodes && skel.nodes.length > 0
                && skel.nodes[0] && typeof skel.nodes[0].id === 'number';

            if (hasIdMapping) {
                for (var ni = 0; ni < skel.nodes.length; ni++) {
                    idToPos[skel.nodes[ni].id] = ni;
                }
                // Reorder node names to match skeleton ordering
                nodes = [];
                for (var ni2 = 0; ni2 < skel.nodes.length; ni2++) {
                    var gid = skel.nodes[ni2].id;
                    nodes.push(gid < globalNodes.length ? globalNodes[gid] : 'node_' + ni2);
                }
            } else {
                // No id mapping, use global order directly
                nodes = globalNodes;
            }

            // Extract edges, remapping from global IDs to skeleton positions
            if (skel.links) {
                for (var li = 0; li < skel.links.length; li++) {
                    var link = skel.links[li];
                    if (typeof link.source === 'number' && typeof link.target === 'number') {
                        // Skip symmetry edges (type 2), keep regular edges (type 1)
                        var isSymmetry = false;
                        if (link.type) {
                            var typeVal = link.type['py/tuple'];
                            if (!typeVal && link.type['py/reduce']) {
                                var ra = link.type['py/reduce'];
                                if (Array.isArray(ra) && ra.length >= 2) typeVal = ra[1]['py/tuple'];
                            }
                            if (typeVal && typeVal[0] === 2) isSymmetry = true;
                        }
                        if (!isSymmetry) {
                            // Remap from global node IDs to skeleton positions
                            var srcPos = hasIdMapping ? idToPos[link.source] : link.source;
                            var dstPos = hasIdMapping ? idToPos[link.target] : link.target;
                            if (srcPos !== undefined && dstPos !== undefined) {
                                edges.push([srcPos, dstPos]);
                            }
                        }
                    }
                }
            }
        } else {
            nodes = globalNodes;
        }

        progress('Skeleton: ' + nodes.length + ' nodes, ' + edges.length + ' edges');

        // --- Tracks ---
        // Format: each entry is JSON "[spawned_frame, \"track_name\"]"
        var tracks = [];
        try {
            var tracksDs = f.get('tracks_json');
            if (tracksDs && tracksDs.shape[0] > 0) {
                var tracksVal = tracksDs.value;
                for (var ti = 0; ti < tracksDs.shape[0]; ti++) {
                    var tv = tracksVal[ti];
                    if (typeof tv === 'string') {
                        try {
                            var parsed = JSON.parse(tv);
                            if (Array.isArray(parsed) && parsed.length >= 2) {
                                tracks.push(String(parsed[1]));
                            } else if (parsed && parsed.name) {
                                tracks.push(parsed.name);
                            } else {
                                tracks.push(String(parsed));
                            }
                        } catch (e2) { tracks.push(tv); }
                    } else {
                        tracks.push(String(tv));
                    }
                }
            }
        } catch (e) { /* no tracks */ }

        progress('Tracks: ' + tracks.length);

        // --- Videos metadata ---
        var videos = [];
        try {
            var videosDs = f.get('videos_json');
            if (videosDs && videosDs.shape[0] > 0) {
                var videosVal = videosDs.value;
                for (var vi = 0; vi < videosDs.shape[0]; vi++) {
                    try {
                        var vj = JSON.parse(videosVal[vi]);
                        var backend = vj.backend || {};
                        var isEmbedded = !!backend.dataset || backend.filename === '.';
                        var sourceFilename = null;
                        if (isEmbedded && vj.source_video) {
                            sourceFilename = vj.source_video.filename ||
                                (vj.source_video.backend && vj.source_video.backend.filename) || null;
                        }
                        videos.push({
                            index: vi,
                            filename: backend.filename || vj.filename || null,
                            sourceFilename: sourceFilename,
                            backendType: isEmbedded ? 'HDF5Video' : 'MediaVideo',
                            shape: backend.shape || null,
                            embedded: isEmbedded,
                            dataset: backend.dataset || null,
                        });
                    } catch (e2) { /* skip bad entry */ }
                }
            }
        } catch (e) { /* no videos */ }

        progress('Videos: ' + videos.length);

        // --- Frames dataset ---
        progress('Reading frames & instances...');
        var framesData = readColumnar(f, 'frames',
            ['frame_id', 'video', 'frame_idx', 'instance_id_start', 'instance_id_end']);

        var instancesData = readColumnar(f, 'instances',
            ['instance_id', 'instance_type', 'frame_id', 'skeleton', 'track',
                'from_predicted', 'score', 'point_id_start', 'point_id_end', 'tracking_score']);

        var pointsData = readPoints(f, 'points', ['x', 'y', 'visible', 'complete']);
        var predPointsData = readPoints(f, 'pred_points', ['x', 'y', 'visible', 'complete', 'score']);

        progress('Frames: ' + (framesData ? framesData.frame_id.length : 0) +
            ', Points: ' + (pointsData ? pointsData.x.length : 0) +
            ', PredPoints: ' + (predPointsData ? predPointsData.x.length : 0));

        // Diagnostic: show instances dataset structure and instance_type values
        if (instancesData) {
            progress('instances fields: ' + Object.keys(instancesData).join(', '));
            var numInst = instancesData.instance_type ? instancesData.instance_type.length : 0;
            progress('Total instances: ' + numInst);
            // Show first few instance_type values to verify type detection
            var typePreview = [];
            for (var _ti2 = 0; _ti2 < Math.min(10, numInst); _ti2++) {
                typePreview.push(instancesData.instance_type[_ti2]);
            }
            progress('instance_type values (first 10): [' + typePreview.join(', ') + ']');
            // Count types
            var typeCountMap = {};
            for (var _ti3 = 0; _ti3 < numInst; _ti3++) {
                var tv = instancesData.instance_type[_ti3];
                typeCountMap[tv] = (typeCountMap[tv] || 0) + 1;
            }
            progress('instance_type distribution: ' + JSON.stringify(typeCountMap));
        }

        // Diagnostic: show actual field names and first 3 frames
        if (framesData) {
            progress('frames fields: ' + Object.keys(framesData).join(', '));
            for (var _di = 0; _di < Math.min(3, framesData.frame_id.length); _di++) {
                progress('  frame[' + _di + ']: frame_id=' + framesData.frame_id[_di] +
                    ' video=' + framesData.video[_di] +
                    ' frame_idx=' + framesData.frame_idx[_di] +
                    ' inst_range=' + framesData.instance_id_start[_di] + '-' + framesData.instance_id_end[_di]);
            }
            // Also show a frame from the middle
            var midI = Math.floor(framesData.frame_id.length / 2);
            progress('  frame[' + midI + ']: frame_id=' + framesData.frame_id[midI] +
                ' video=' + framesData.video[midI] +
                ' frame_idx=' + framesData.frame_idx[midI] +
                ' inst_range=' + framesData.instance_id_start[midI] + '-' + framesData.instance_id_end[midI]);
        }

        // --- Build frame array ---
        var numNodes = nodes.length;
        var frames = [];
        if (framesData && instancesData) {
            for (var fi = 0; fi < framesData.frame_id.length; fi++) {
                var frameIdx = Number(framesData.frame_idx[fi]);
                var videoIdx = Number(framesData.video[fi]);
                var instStart = Number(framesData.instance_id_start[fi]);
                var instEnd = Number(framesData.instance_id_end[fi]);

                var instances = [];
                for (var ji = instStart; ji < instEnd; ji++) {
                    if (ji >= instancesData.instance_type.length) break;
                    var instType = Number(instancesData.instance_type[ji]);
                    var trackIdx = Number(instancesData.track[ji]);
                    var score = Number(instancesData.score[ji]);
                    var ptStart = Number(instancesData.point_id_start[ji]);
                    var ptEnd = Number(instancesData.point_id_end[ji]);

                    var pts = instType === 1 ? (predPointsData || pointsData) : pointsData;
                    if (!pts) continue;

                    var points = [];
                    var occludedFlags = [];
                    for (var ki = ptStart; ki < ptEnd && ki < ptStart + numNodes; ki++) {
                        if (ki >= pts.x.length) { points.push(null); occludedFlags.push(false); continue; }
                        var px = Number(pts.x[ki]);
                        var py = Number(pts.y[ki]);
                        var pv = pts.visible[ki];
                        if (!isNaN(px) && !isNaN(py)) {
                            points.push([px, py]);
                            occludedFlags.push(!pv);  // visible=false with valid coords = occluded
                        } else {
                            points.push(null);
                            occludedFlags.push(false);
                        }
                    }
                    while (points.length < numNodes) { points.push(null); occludedFlags.push(false); }

                    instances.push({
                        trackIdx: trackIdx,
                        score: score,
                        type: instType === 1 ? 'predicted' : 'user',
                        points: points,
                        occluded: occludedFlags,
                    });
                }

                if (instances.length > 0) {
                    frames.push({ frameIdx: frameIdx, videoIdx: videoIdx, instances: instances });
                }
            }
        }

        progress('Built ' + frames.length + ' frames with pose data');

        // --- Sessions JSON ---
        var sessionsArr = [];
        try {
            var sessDs = f.get('sessions_json');
            if (sessDs && sessDs.shape[0] > 0) {
                var sessParsed = JSON.parse(sessDs.value[0]);
                sessionsArr = Array.isArray(sessParsed) ? sessParsed : [sessParsed];
            }
        } catch (e) { /* no sessions */ }

        // NOTE: Embedded video frame bytes are NOT extracted here.
        // A separate frame-worker.js handles on-demand frame extraction
        // using SLPPackageReader, which avoids loading all frames into memory.

        f.close();
        try { FS.unmount('/work'); } catch (e) { /* ignore */ }

        // Count instances by type
        var userCount = 0, predCount = 0;
        for (var _ci = 0; _ci < frames.length; _ci++) {
            for (var _cj = 0; _cj < frames[_ci].instances.length; _cj++) {
                if (frames[_ci].instances[_cj].type === 'predicted') predCount++;
                else userCount++;
            }
        }
        progress('Instance types: ' + userCount + ' user, ' + predCount + ' predicted');

        progress('Done! Sending results...');

        postMessage({
            type: 'result',
            data: {
                skeleton: { name: skelName, nodes: nodes, edges: edges },
                tracks: tracks,
                frames: frames,
                videos: videos,
                sessions: sessionsArr,
            }
        });

    } catch (err) {
        try { FS.unmount('/work'); } catch (e) { }
        var errMsg = (err.message || String(err));
        if (err.stack) errMsg += '\n' + err.stack.split('\n').slice(0, 5).join('\n');
        postMessage({ type: 'error', message: errMsg });
    }
}

// --- Analysis H5 parsing ---

function parseAnalysisH5(f, filename) {
    try {
        // --- Read node names ---
        var nodeNamesDs = f.get('node_names');
        var nodeNames = [];
        if (nodeNamesDs) {
            var nnVal = nodeNamesDs.value;
            for (var i = 0; i < nnVal.length; i++) {
                nodeNames.push(String(nnVal[i]));
            }
        }
        var nNodes = nodeNames.length;
        progress('Nodes: ' + nNodes + ' — ' + nodeNames.slice(0, 5).join(', ') + (nNodes > 5 ? '...' : ''));

        // --- Read track names ---
        var trackNamesDs = f.get('track_names');
        var trackNames = [];
        if (trackNamesDs) {
            var tnVal = trackNamesDs.value;
            for (var ti = 0; ti < tnVal.length; ti++) {
                trackNames.push(String(tnVal[ti]));
            }
        }
        // nTracks will be determined from the tracks dataset shape below,
        // since track_names can be empty for single-instance models
        progress('Track names: ' + (trackNames.length > 0 ? trackNames.join(', ') : '(none — single instance)'));

        // --- Read edges ---
        var edges = [];
        try {
            var edgeIndsDs = f.get('edge_inds');
            if (edgeIndsDs) {
                var eiVal = edgeIndsDs.value;
                var eiShape = edgeIndsDs.shape;
                // Stored as [2, n_edges] (transposed) or [n_edges, 2]
                if (eiShape.length === 2) {
                    if (eiShape[0] === 2 && eiShape[1] !== 2) {
                        // Transposed: [2, n_edges]
                        var nEdges = eiShape[1];
                        for (var ei = 0; ei < nEdges; ei++) {
                            edges.push([Number(eiVal[ei]), Number(eiVal[nEdges + ei])]);
                        }
                    } else {
                        // Normal: [n_edges, 2]
                        var nEdges2 = eiShape[0];
                        for (var ei2 = 0; ei2 < nEdges2; ei2++) {
                            edges.push([Number(eiVal[ei2 * 2]), Number(eiVal[ei2 * 2 + 1])]);
                        }
                    }
                }
            }
        } catch (e) {
            progress('Warning: could not read edge_inds: ' + e.message);
        }
        progress('Edges: ' + edges.length);

        // --- Read tracks data ---
        var tracksDs = f.get('tracks');
        if (!tracksDs) {
            throw new Error('No tracks dataset found in analysis H5');
        }
        var tracksVal = tracksDs.value;
        var tracksShape = tracksDs.shape; // Expected: [n_tracks, 2, n_nodes, n_frames] (transposed)
        progress('tracks shape: [' + tracksShape.join(', ') + ']');

        // Determine orientation and extract dimensions
        // nTracks is derived from the shape, not track_names (which can be empty)
        var nTracks, nFrames, transposed;
        if (tracksShape.length === 4) {
            if (tracksShape[1] === 2 && tracksShape[2] === nNodes) {
                // Transposed (MATLAB/default): [n_tracks, 2, n_nodes, n_frames]
                transposed = true;
                nTracks = tracksShape[0];
                nFrames = tracksShape[3];
            } else if (tracksShape[2] === 2 && tracksShape[1] === nNodes) {
                // Non-transposed: [n_frames, n_nodes, 2, n_tracks]
                transposed = false;
                nTracks = tracksShape[3];
                nFrames = tracksShape[0];
            } else {
                // Fallback: assume transposed
                transposed = true;
                nTracks = tracksShape[0];
                nFrames = tracksShape[3];
                progress('Warning: unexpected tracks shape, assuming transposed layout');
            }
        } else {
            throw new Error('Unexpected tracks dimensionality: ' + tracksShape.length);
        }
        progress('nTracks: ' + nTracks + ', nFrames: ' + nFrames + ', transposed: ' + transposed);

        // Backfill track names if empty
        if (trackNames.length === 0) {
            for (var tni = 0; tni < nTracks; tni++) {
                trackNames.push(nTracks === 1 ? 'track' : 'track_' + tni);
            }
        }

        // --- Read point scores (optional) ---
        var pointScores = null;
        var pointScoresShape = null;
        try {
            var psDs = f.get('point_scores');
            if (psDs) {
                pointScores = psDs.value;
                pointScoresShape = psDs.shape;
            }
        } catch (e) { }

        // --- Read instance scores (optional) ---
        var instanceScores = null;
        try {
            var isDs = f.get('instance_scores');
            if (isDs) { instanceScores = isDs.value; }
        } catch (e) { }

        // --- Read track occupancy (optional) ---
        var trackOccupancy = null;
        var trackOccShape = null;
        try {
            var toDs = f.get('track_occupancy');
            if (toDs) {
                trackOccupancy = toDs.value;
                trackOccShape = toDs.shape;
            }
        } catch (e) { }

        // --- Build frames array ---
        progress('Building frame data...');
        var frames = [];
        for (var fr = 0; fr < nFrames; fr++) {
            var instances = [];
            for (var tr = 0; tr < nTracks; tr++) {
                // Check occupancy if available
                if (trackOccupancy) {
                    // track_occupancy shape: [n_frames, n_tracks]
                    var occIdx = fr * nTracks + tr;
                    if (occIdx < trackOccupancy.length && !trackOccupancy[occIdx]) {
                        continue;
                    }
                }

                var points = [];
                var hasAnyPoint = false;
                for (var nd = 0; nd < nNodes; nd++) {
                    var x, y;
                    if (transposed) {
                        // Shape [n_tracks, 2, n_nodes, n_frames]
                        // index(t, c, n, f) = t*(2*N*F) + c*(N*F) + n*F + f
                        var baseT = tr * (2 * nNodes * nFrames);
                        x = Number(tracksVal[baseT + 0 * (nNodes * nFrames) + nd * nFrames + fr]);
                        y = Number(tracksVal[baseT + 1 * (nNodes * nFrames) + nd * nFrames + fr]);
                    } else {
                        // Shape [n_frames, n_nodes, 2, n_tracks]
                        // index(f, n, c, t) = f*(N*2*T) + n*(2*T) + c*T + t
                        var baseF = fr * (nNodes * 2 * nTracks);
                        x = Number(tracksVal[baseF + nd * (2 * nTracks) + 0 * nTracks + tr]);
                        y = Number(tracksVal[baseF + nd * (2 * nTracks) + 1 * nTracks + tr]);
                    }

                    if (!isNaN(x) && !isNaN(y)) {
                        points.push([x, y]);
                        hasAnyPoint = true;
                    } else {
                        points.push(null);
                    }
                }

                if (!hasAnyPoint) continue;

                // Get instance score if available
                var instScore = 0;
                if (instanceScores) {
                    // instance_scores shape: [n_tracks, n_frames] (transposed)
                    var scoreIdx = tr * nFrames + fr;
                    if (scoreIdx < instanceScores.length) {
                        instScore = Number(instanceScores[scoreIdx]);
                        if (isNaN(instScore)) instScore = 0;
                    }
                }

                instances.push({
                    trackIdx: tr,
                    score: instScore,
                    type: 'predicted',
                    points: points,
                });
            }

            if (instances.length > 0) {
                frames.push({ frameIdx: fr, videoIdx: 0, instances: instances });
            }
        }

        progress('Built ' + frames.length + ' frames with pose data');

        // --- Build video entry from filename ---
        // Strip .analysis.h5 or .h5 to get a base name
        var vidName = filename;
        vidName = vidName.replace(/\.analysis\.h5$/i, '').replace(/\.h5$/i, '');
        // Try to extract the original video filename from SLEAP's naming convention:
        // model_name.predictions.ORIGINAL_VIDEO_NAME.analysis.h5
        var predIdx = vidName.indexOf('.predictions.');
        var sourceVideo = null;
        if (predIdx >= 0) {
            sourceVideo = vidName.substring(predIdx + '.predictions.'.length);
        }
        var videos = [{
            index: 0,
            filename: sourceVideo || vidName,
            sourceFilename: sourceVideo ? vidName : null,
            backendType: 'AnalysisH5',
            shape: null,
            embedded: false,
            dataset: null,
        }];

        // --- Build skeleton ---
        var skelName = 'skeleton';
        var skeleton = { name: skelName, nodes: nodeNames, edges: edges };

        f.close();
        try { FS.unmount('/work'); } catch (e) { /* ignore */ }

        progress('Done! Sending results...');

        postMessage({
            type: 'result',
            data: {
                skeleton: skeleton,
                tracks: trackNames,
                frames: frames,
                videos: videos,
                sessions: [],
            }
        });

    } catch (err) {
        try { f.close(); } catch (e) { }
        try { FS.unmount('/work'); } catch (e) { }
        var errMsg = (err.message || String(err));
        if (err.stack) errMsg += '\n' + err.stack.split('\n').slice(0, 5).join('\n');
        postMessage({ type: 'error', message: errMsg });
    }
}

// --- Dataset reading helpers ---

function readColumnar(h5file, name, fields) {
    var ds;
    try { ds = h5file.get(name); } catch (e) { return null; }
    if (!ds) return null;

    // Group (split-field format from mv-gui export)
    if (ds.type === 'Group') {
        var result = {};
        for (var i = 0; i < fields.length; i++) {
            try {
                var sub = h5file.get(name + '/' + fields[i]);
                result[fields[i]] = sub ? sub.value : [];
            } catch (e) {
                result[fields[i]] = [];
            }
        }
        return result;
    }

    // Compound dataset
    var raw;
    try { raw = ds.value; } catch (e) { return null; }
    if (!raw) return null;

    // Already columnar object with typed array fields
    if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw[fields[0]] !== undefined) {
        return raw;
    }

    // Helper: unwrap single-element TypedArrays from compound dataset reads
    function unwrap(v) {
        if (v && typeof v === 'object' && v.length === 1) return v[0];
        return v;
    }

    // Array of tuples (compound datasets return TypedArray members)
    if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
        var data = {};
        for (var j = 0; j < fields.length; j++) {
            data[fields[j]] = raw.map(function (row) { return unwrap(row[j]); });
        }
        return data;
    }

    // Array of objects
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && raw[0][fields[0]] !== undefined) {
        var data2 = {};
        for (var k = 0; k < fields.length; k++) {
            var fld = fields[k];
            data2[fld] = raw.map(function (row) { return unwrap(row[fld]); });
        }
        return data2;
    }

    return null;
}

function readPoints(h5file, name, fields) {
    try {
        var ds = h5file.get(name);
        if (!ds) return null;

        if (ds.type === 'Group') {
            var result = {};
            for (var i = 0; i < fields.length; i++) {
                try {
                    var sub = h5file.get(name + '/' + fields[i]);
                    result[fields[i]] = sub ? sub.value : [];
                } catch (e) { result[fields[i]] = []; }
            }
            if (result.x && result.x.length > 0) return result;
            return null;
        }

        var raw = ds.value;
        if (!raw) return null;

        if (raw && typeof raw === 'object' && !Array.isArray(raw) && raw.x !== undefined) {
            return raw;
        }

        // Helper: unwrap single-element TypedArrays from compound dataset reads
        function unwrap(v) {
            if (v && typeof v === 'object' && v.length === 1) return v[0];
            return v;
        }

        if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
            var data = {};
            for (var j = 0; j < fields.length; j++) {
                data[fields[j]] = raw.map(function (row) { return unwrap(row[j]); });
            }
            return data;
        }

        if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && raw[0].x !== undefined) {
            var data2 = {};
            for (var k = 0; k < fields.length; k++) {
                var fld = fields[k];
                data2[fld] = raw.map(function (row) { return unwrap(row[fld]); });
            }
            return data2;
        }
    } catch (e) { /* no dataset */ }
    return null;
}
