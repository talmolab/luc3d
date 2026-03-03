// slp-export.js - Build per-camera .slp HDF5 files in-browser using h5wasm
// Depends on globals from file-io.js: initH5wasm(), h5FileToBlob(), serializeSkeleton()
// Depends on global from index.html: downloadBlob()

/**
 * Write a 2D float64 matrix dataset to an h5wasm File.
 * Each row is an array of numbers. A `field_names` attribute is added
 * so that the import worker can reconstruct named columns.
 *
 * @param {Object} file - h5wasm File handle
 * @param {string} name - Dataset name (e.g. 'frames')
 * @param {number[][]} rows - Array of row arrays
 * @param {string[]} fieldNames - Column names
 */
function _writeMatrixDataset(file, name, rows, fieldNames) {
    var nRows = rows.length;
    var nCols = fieldNames.length;

    if (nRows === 0) {
        // Create empty dataset with correct column count
        var empty = new Float64Array(0);
        var ds = file.create_dataset({ name: name, data: empty, shape: [0, nCols], dtype: '<f8' });
        ds.create_attribute('field_names', fieldNames);
        return;
    }

    // Flatten rows into a contiguous Float64Array (row-major)
    var flat = new Float64Array(nRows * nCols);
    for (var r = 0; r < nRows; r++) {
        var row = rows[r];
        for (var c = 0; c < nCols; c++) {
            flat[r * nCols + c] = row[c];
        }
    }

    var ds = file.create_dataset({ name: name, data: flat, shape: [nRows, nCols], dtype: '<f8' });
    ds.create_attribute('field_names', fieldNames);
}


/**
 * Build a per-camera .slp HDF5 file as a Blob using h5wasm.
 *
 * The HDF5 structure matches SLEAP's .slp format:
 *   /metadata          group with format_id (float attr) and json (string attr)
 *   /videos_json       string dataset (1 entry)
 *   /tracks_json       string dataset (1 per track)
 *   /suggestions_json  string dataset (1 empty entry)
 *   /sessions_json     string dataset (1 empty entry)
 *   /frames            float64 matrix [N, 5] with field_names attr
 *   /instances         float64 matrix [N, 10] with field_names attr
 *   /points            float64 matrix [N, 4] with field_names attr
 *   /pred_points       float64 matrix [N, 5] with field_names attr
 *
 * @param {Session} session
 * @param {string} cameraName - Which camera view to export
 * @param {string} instanceType - 'user' or 'predicted'
 * @param {Object} videoFileInfo - Entry from state.videoFiles with videoWidth/videoHeight/file/frameCount
 * @returns {Promise<Blob>} The .slp file as a Blob
 */
async function buildSlpH5(session, cameraName, instanceType, videoFileInfo) {
    var mod = await initH5wasm();
    var fname = 'export_' + cameraName + '_' + instanceType + '.slp';

    var f = new mod.File(fname, 'w');
    try {
        // ---- /metadata group ----
        var metaGroup = f.create_group('metadata');
        metaGroup.create_attribute('format_id', 1.4, null, '<f8');

        var skelData = serializeSkeleton(session.skeleton);
        var metadataObj = {
            version: '2.0.0',
            skeletons: skelData.skeletons,
            nodes: skelData.nodes,
            provenance: { source: 'lucid', exported_at: new Date().toISOString() },
        };
        metaGroup.create_attribute('json', JSON.stringify(metadataObj));

        // ---- /videos_json ----
        var vw = videoFileInfo.videoWidth || 0;
        var vh = videoFileInfo.videoHeight || 0;
        var videoFilename = videoFileInfo.file ? videoFileInfo.file.name : (cameraName + '.mp4');
        var videoEntry = {
            filename: videoFilename,
            backend: {
                type: 'MediaVideo',
                shape: [videoFileInfo.frameCount || 0, vh, vw, 1],
                filename: videoFilename,
            },
        };
        f.create_dataset({ name: 'videos_json', data: [JSON.stringify(videoEntry)] });

        // ---- /tracks_json ----
        var trackJsons = [];
        for (var ti = 0; ti < session.tracks.length; ti++) {
            trackJsons.push(JSON.stringify([0, session.tracks[ti]]));
        }
        if (trackJsons.length > 0) {
            f.create_dataset({ name: 'tracks_json', data: trackJsons });
        } else {
            f.create_dataset({ name: 'tracks_json', data: [''] });
        }

        // ---- /suggestions_json ----
        f.create_dataset({ name: 'suggestions_json', data: [''] });

        // ---- /sessions_json ----
        f.create_dataset({ name: 'sessions_json', data: [''] });

        // ---- Build columnar arrays ----
        var frameRows = [];
        var instanceRows = [];
        var pointRows = [];
        var predPointRows = [];
        var frameId = 0;
        var instanceId = 0;
        var numNodes = session.skeleton.nodes.length;

        // Iterate frame groups sorted by frameIdx
        var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

        for (var fi = 0; fi < allFrameIndices.length; fi++) {
            var frameIdx = allFrameIndices[fi];
            var fg = session.frameGroups.get(frameIdx);
            var camInstances = fg.instances.get(cameraName) || [];

            // Filter to the requested instance type
            var filtered = [];
            for (var ci = 0; ci < camInstances.length; ci++) {
                if (camInstances[ci].type === instanceType) {
                    filtered.push(camInstances[ci]);
                }
            }

            // Skip frames with no matching instances for this camera
            if (filtered.length === 0) continue;

            var instIdStart = instanceId;

            for (var ii = 0; ii < filtered.length; ii++) {
                var inst = filtered[ii];
                var isUser = (instanceType === 'user');
                var pointIdStart = isUser ? pointRows.length : predPointRows.length;

                for (var n = 0; n < numNodes; n++) {
                    var pt = inst.points[n];
                    var x = pt ? pt[0] : NaN;
                    var y = pt ? pt[1] : NaN;
                    var visible = (pt != null && !(inst.occluded && inst.occluded[n])) ? 1.0 : 0.0;
                    var complete = (pt != null) ? 1.0 : 0.0;

                    if (isUser) {
                        // points: [x, y, visible, complete]
                        pointRows.push([x, y, visible, complete]);
                    } else {
                        // pred_points: [x, y, visible, complete, score]
                        predPointRows.push([x, y, visible, complete, inst.score || 0]);
                    }
                }

                var pointIdEnd = isUser ? pointRows.length : predPointRows.length;

                // instance row: [instance_id, instance_type, frame_id, skeleton, track,
                //                from_predicted, score, point_id_start, point_id_end, tracking_score]
                instanceRows.push([
                    instanceId,
                    isUser ? 0 : 1,
                    frameId,
                    0,  // skeleton index
                    inst.trackIdx >= 0 ? inst.trackIdx : -1,
                    -1, // from_predicted
                    isUser ? 0 : (inst.score || 0),
                    pointIdStart,
                    pointIdEnd,
                    0,  // tracking_score
                ]);
                instanceId++;
            }

            // frame row: [frame_id, video, frame_idx, instance_id_start, instance_id_end]
            frameRows.push([frameId, 0, frameIdx, instIdStart, instanceId]);
            frameId++;
        }

        // ---- Write matrix datasets ----
        _writeMatrixDataset(f, 'frames', frameRows,
            ['frame_id', 'video', 'frame_idx', 'instance_id_start', 'instance_id_end']);

        _writeMatrixDataset(f, 'instances', instanceRows,
            ['instance_id', 'instance_type', 'frame_id', 'skeleton', 'track',
             'from_predicted', 'score', 'point_id_start', 'point_id_end', 'tracking_score']);

        _writeMatrixDataset(f, 'points', pointRows,
            ['x', 'y', 'visible', 'complete']);

        _writeMatrixDataset(f, 'pred_points', predPointRows,
            ['x', 'y', 'visible', 'complete', 'score']);

        f.close();

        var blob = h5FileToBlob(fname);
        try { mod.FS.unlink(fname); } catch (e) { /* ignore cleanup errors */ }
        return blob;
    } catch (err) {
        try { f.close(); } catch (e) { /* ignore */ }
        try { mod.FS.unlink(fname); } catch (e) { /* ignore */ }
        throw err;
    }
}


/**
 * Export .slp files for all cameras.
 * Downloads one file per camera: {camName}_labels.slp (user) or {camName}_predictions.slp (predicted).
 *
 * @param {Object} state - App state with session and videoFiles
 * @param {string} instanceType - 'user' or 'predicted'
 * @param {Function} [setStatus] - Optional status callback
 */
async function exportSlpPerCamera(state, instanceType, setStatus) {
    var session = state.session;
    if (!session) {
        if (setStatus) setStatus('No session loaded');
        return;
    }

    var cameras = session.cameras;
    if (!cameras || cameras.length === 0) {
        if (setStatus) setStatus('No cameras in session');
        return;
    }

    var suffix = (instanceType === 'predicted') ? '_predictions.slp' : '_labels.slp';

    for (var ci = 0; ci < cameras.length; ci++) {
        var cam = cameras[ci];
        var camName = cam.name;

        if (setStatus) setStatus('Exporting ' + camName + ' (' + (ci + 1) + '/' + cameras.length + ')...');

        // Find matching videoFileInfo
        var videoFileInfo = null;
        for (var vi = 0; vi < state.videoFiles.length; vi++) {
            var vf = state.videoFiles[vi];
            if (vf.assignedCamera === camName || vf.name === camName) {
                videoFileInfo = vf;
                break;
            }
        }

        // Fallback: create a minimal videoFileInfo if no video file is loaded
        if (!videoFileInfo) {
            videoFileInfo = {
                file: null,
                videoWidth: cam.size ? cam.size[0] : 0,
                videoHeight: cam.size ? cam.size[1] : 0,
                frameCount: 0,
            };
        }

        var blob = await buildSlpH5(session, camName, instanceType, videoFileInfo);
        downloadBlob(blob, camName + suffix);
    }

    if (setStatus) setStatus('Exported ' + cameras.length + ' .slp files');
}
