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

                    var pts = instType === 1 ? predPointsData : pointsData;
                    if (!pts) continue;

                    var points = [];
                    for (var ki = ptStart; ki < ptEnd && ki < ptStart + numNodes; ki++) {
                        if (ki >= pts.x.length) { points.push(null); continue; }
                        var px = Number(pts.x[ki]);
                        var py = Number(pts.y[ki]);
                        var pv = pts.visible[ki];
                        if (pv && !isNaN(px) && !isNaN(py)) {
                            points.push([px, py]);
                        } else {
                            points.push(null);
                        }
                    }
                    while (points.length < numNodes) points.push(null);

                    instances.push({
                        trackIdx: trackIdx,
                        score: score,
                        type: instType === 1 ? 'predicted' : 'user',
                        points: points,
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
        try { FS.unmount('/work'); } catch (e) {}
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

    // Array of tuples
    if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
        var data = {};
        for (var j = 0; j < fields.length; j++) {
            data[fields[j]] = raw.map(function (row) { return row[j]; });
        }
        return data;
    }

    // Array of objects
    if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && raw[0][fields[0]] !== undefined) {
        var data2 = {};
        for (var k = 0; k < fields.length; k++) {
            var fld = fields[k];
            data2[fld] = raw.map(function (row) { return row[fld]; });
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

        if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
            var data = {};
            for (var j = 0; j < fields.length; j++) {
                data[fields[j]] = raw.map(function (row) { return row[j]; });
            }
            return data;
        }

        if (Array.isArray(raw) && raw.length > 0 && typeof raw[0] === 'object' && raw[0].x !== undefined) {
            var data2 = {};
            for (var k = 0; k < fields.length; k++) {
                var fld = fields[k];
                data2[fld] = raw.map(function (row) { return row[fld]; });
            }
            return data2;
        }
    } catch (e) { /* no dataset */ }
    return null;
}
