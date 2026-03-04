// slp-export.js - Export per-camera .slp files via server-side conversion
// Depends on globals from file-io.js: serializeSkeleton()

function _downloadBlob(blob, filename) {
    return new Promise(function (resolve) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        // Small delay between downloads to avoid browser issues
        setTimeout(function () {
            URL.revokeObjectURL(url);
            resolve();
        }, 500);
    });
}

/**
 * Build per-camera SLP JSON data filtered by instance type.
 * Produces the JSON structure expected by json_to_slp.py.
 *
 * @param {Session} session
 * @param {string} cameraName - Which camera view to export
 * @param {string} instanceType - 'user' or 'predicted'
 * @param {Object} videoFileInfo - Entry from state.videoFiles
 * @returns {Object} SLP export data object
 */
function _buildSlpJson(session, cameraName, instanceType, videoFileInfo) {
    var skelData = serializeSkeleton(session.skeleton);
    var metadata = {
        version: '2.0.0',
        skeletons: skelData.skeletons,
        nodes: skelData.nodes,
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    };

    var vw = videoFileInfo.videoWidth || 0;
    var vh = videoFileInfo.videoHeight || 0;
    var videoFilename = videoFileInfo.file ? videoFileInfo.file.name : (cameraName + '.mp4');
    var videos = [{
        filename: videoFilename,
        backend: {
            type: 'MediaVideo',
            shape: [videoFileInfo.frameCount || 0, vh, vw, 1],
            filename: videoFilename,
        },
    }];

    var tracks = session.tracks.slice();

    var frames = [];
    var instances = [];
    var points = [];
    var predPoints = [];
    var frameId = 0;
    var instanceId = 0;
    var numNodes = session.skeleton.nodes.length;

    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

    for (var fi = 0; fi < allFrameIndices.length; fi++) {
        var frameIdx = allFrameIndices[fi];
        var fg = session.frameGroups.get(frameIdx);
        var camInstances = fg.instances.get(cameraName) || [];

        // Filter to requested instance type only (no reprojections)
        var filtered = [];
        for (var ci = 0; ci < camInstances.length; ci++) {
            if (camInstances[ci].type === instanceType) {
                filtered.push(camInstances[ci]);
            }
        }

        if (filtered.length === 0) continue;

        var instIdStart = instanceId;

        for (var ii = 0; ii < filtered.length; ii++) {
            var inst = filtered[ii];
            var isUser = (instanceType === 'user');
            var pointIdStart = isUser ? points.length : predPoints.length;

            for (var n = 0; n < numNodes; n++) {
                var pt = inst.points[n];
                var entry = {
                    x: pt ? pt[0] : null,
                    y: pt ? pt[1] : null,
                    visible: pt != null && !(inst.occluded && inst.occluded[n]),
                    complete: pt != null,
                };
                if (isUser) {
                    points.push(entry);
                } else {
                    entry.score = inst.score || 0;
                    predPoints.push(entry);
                }
            }

            var pointIdEnd = isUser ? points.length : predPoints.length;

            instances.push({
                instance_id: instanceId,
                instance_type: isUser ? 0 : 1,
                frame_id: frameId,
                skeleton: 0,
                track: inst.trackIdx >= 0 ? inst.trackIdx : -1,
                from_predicted: -1,
                score: isUser ? 0 : (inst.score || 0),
                point_id_start: pointIdStart,
                point_id_end: pointIdEnd,
                tracking_score: 0,
            });
            instanceId++;
        }

        frames.push({
            frame_id: frameId,
            video: 0,
            frame_idx: frameIdx,
            instance_id_start: instIdStart,
            instance_id_end: instanceId,
        });
        frameId++;
    }

    return {
        format_id: 1.4,
        metadata: metadata,
        videos: videos,
        tracks: tracks,
        suggestions: [],
        sessions: [],
        frames: frames,
        instances: instances,
        points: points,
        pred_points: predPoints,
    };
}

/**
 * Export .slp files for all cameras via server-side conversion.
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

    for (var ci = 0; ci < cameras.length; ci++) {
        var cam = cameras[ci];
        var camName = cam.name;

        // Find matching videoFileInfo
        var videoFileInfo = null;
        for (var vi = 0; vi < state.videoFiles.length; vi++) {
            var vf = state.videoFiles[vi];
            if (vf.assignedCamera === camName || vf.name === camName) {
                videoFileInfo = vf;
                break;
            }
        }

        if (!videoFileInfo) {
            videoFileInfo = {
                file: null,
                videoWidth: cam.size ? cam.size[0] : 0,
                videoHeight: cam.size ? cam.size[1] : 0,
                frameCount: 0,
            };
        }

        // Filename: video stem + .slp
        var videoName = videoFileInfo.file ? videoFileInfo.file.name : (camName + '.mp4');
        var outputName = videoName.replace(/\.[^.]+$/, '') + '.slp';

        if (setStatus) setStatus('Exporting ' + camName + ' (' + (ci + 1) + '/' + cameras.length + ')...');

        try {
            var jsonData = _buildSlpJson(session, camName, instanceType, videoFileInfo);
            var body = JSON.stringify(jsonData);

            var resp = await fetch('/convert-slp', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: body,
            });

            if (!resp.ok) {
                var errText = await resp.text();
                throw new Error('Server returned ' + resp.status + ': ' + errText);
            }

            var blob = await resp.blob();
            await _downloadBlob(blob, outputName);
        } catch (err) {
            console.error('[slp-export] Failed for ' + camName + ':', err);
            if (setStatus) setStatus('Export failed for ' + camName + ': ' + err.message, 'error');
            return;
        }
    }

    if (setStatus) setStatus('Exported ' + cameras.length + ' .slp files');
}
