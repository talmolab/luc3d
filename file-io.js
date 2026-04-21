/**
 * file-io.js - File loading for calibration, videos, and sessions.
 *
 * Provides:
 *   - pickFiles(): Generic file picker
 *   - parseCalibrationTOML(text): Parse sleap-io TOML calibration → Camera[]
 *   - parseCalibrationJSON(text): Parse JSON calibration → Camera[]
 *   - loadCalibrationFile(): Full flow: pick file → parse → return Camera[]
 *   - pickVideoFiles(): Pick multiple .mp4 files
 *
 * Depends on pose-data.js (Camera class).
 * All functions are vanilla JS globals -- no imports/exports.
 */

// ============================================
// Generic file picker
// ============================================

/**
 * Open a file picker dialog and return selected files.
 *
 * @param {Object} [options]
 * @param {string} [options.accept] - Accept attribute (e.g. ".toml,.json")
 * @param {boolean} [options.multiple] - Allow multiple file selection
 * @returns {Promise<File[]>} Array of selected files (empty if cancelled)
 */
function pickFiles(options) {
    options = options || {};
    return new Promise(function (resolve) {
        var resolved = false;
        const input = document.createElement('input');
        input.type = 'file';
        if (options.accept) input.accept = options.accept;
        if (options.multiple) input.multiple = true;

        function done(files) {
            if (resolved) return;
            resolved = true;
            resolve(files);
        }

        input.addEventListener('change', function () {
            done(input.files ? Array.from(input.files) : []);
        });

        // Handle cancel — 'cancel' event + focus fallback for browsers that don't fire it
        input.addEventListener('cancel', function () {
            done([]);
        });

        // Fallback: if window regains focus and no change event fired, assume cancel
        var focusTimer = null;
        function onFocus() {
            clearTimeout(focusTimer);
            focusTimer = setTimeout(function () {
                window.removeEventListener('focus', onFocus);
                done([]);
            }, 500);
        }
        // Small delay before attaching focus listener so it doesn't fire immediately
        setTimeout(function () {
            if (!resolved) window.addEventListener('focus', onFocus);
        }, 100);

        input.click();
    });
}

/**
 * Pick a folder using webkitdirectory. Returns an array of File objects
 * with webkitRelativePath set (e.g., "folder/videos/back.mp4").
 */
function pickFolder() {
    return new Promise(function (resolve) {
        var resolved = false;
        var input = document.createElement('input');
        input.type = 'file';
        input.webkitdirectory = true;
        // Firefox compat
        input.setAttribute('directory', '');
        input.setAttribute('mozdirectory', '');

        function done(files) {
            if (resolved) return;
            resolved = true;
            resolve(files);
        }

        input.addEventListener('change', function () {
            console.log('[pickFolder] change event, files:', input.files ? input.files.length : 0);
            done(input.files ? Array.from(input.files) : []);
        });

        input.addEventListener('cancel', function () {
            console.log('[pickFolder] cancel event');
            done([]);
        });

        // No focus-based cancel detection — folder dialogs can take a long time
        // and the focus event fires too early, causing premature cancellation.

        input.click();
    });
}

// ============================================
// TOML calibration parser
// ============================================

/**
 * Parse a sleap-io format TOML calibration string into Camera objects.
 *
 * TOML format (per camera section):
 *   [cam_N]
 *   name = "back"
 *   size = [ 1280, 1024,]
 *   matrix = [ [ fx, 0.0, cx,], [ 0.0, fy, cy,], [ 0.0, 0.0, 1.0,],]
 *   distortions = [ k1, k2, p1, p2, k3,]
 *   rotation = [ rx, ry, rz,]
 *   translation = [ tx, ty, tz,]
 *
 * @param {string} text - TOML file content
 * @returns {Camera[]} Array of Camera objects
 */
function parseCalibrationTOML(text) {
    const cameras = [];

    // Split into sections by [section_name] headers
    // Match lines like [cam_0], [cam_1], [metadata], etc.
    const sectionRegex = /^\[([^\]]+)\]\s*$/gm;
    const sections = [];
    let match;
    while ((match = sectionRegex.exec(text)) !== null) {
        sections.push({ name: match[1], start: match.index + match[0].length });
    }

    for (let i = 0; i < sections.length; i++) {
        const section = sections[i];
        // Skip non-camera sections (e.g. [metadata])
        if (!section.name.startsWith('cam_')) continue;

        const end = i + 1 < sections.length ? sections[i + 1].start : text.length;
        const body = text.substring(section.start, end);

        // Parse key-value pairs from the section body
        const props = parseTOMLSection(body);

        const name = props.name || section.name;
        const size = props.size || [640, 480];
        const matrix = props.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const dist = props.distortions || [0, 0, 0, 0, 0];
        const rvec = props.rotation || [0, 0, 0];
        const tvec = props.translation || [0, 0, 0];

        cameras.push(new Camera(name, matrix, dist, rvec, tvec, size));
    }

    return cameras;
}

/**
 * Parse key-value pairs from a TOML section body.
 * Handles strings, arrays, and nested arrays with trailing commas.
 *
 * @param {string} body - Section text (lines after [section_name])
 * @returns {Object} Key-value map
 */
function parseTOMLSection(body) {
    const result = {};
    const lines = body.split('\n');

    for (let i = 0; i < lines.length; i++) {
        const line = lines[i].trim();
        if (!line || line.startsWith('#') || line.startsWith('[')) continue;

        const eqIdx = line.indexOf('=');
        if (eqIdx === -1) continue;

        const key = line.substring(0, eqIdx).trim();
        let value = line.substring(eqIdx + 1).trim();

        // Remove quotes for string values
        if (value.startsWith('"') && value.endsWith('"')) {
            result[key] = value.slice(1, -1);
            continue;
        }

        // Clean trailing commas inside arrays (TOML allows them, JSON doesn't)
        // Replace ",]" with "]" and ", ]" with "]"
        value = value.replace(/,\s*\]/g, ']');

        // Try to parse as JSON (arrays, numbers, booleans)
        try {
            result[key] = JSON.parse(value);
        } catch (e) {
            // Store as string if can't parse
            result[key] = value;
        }
    }

    return result;
}

// ============================================
// JSON calibration parser
// ============================================

/**
 * Parse a JSON calibration object into Camera objects.
 *
 * Expected format:
 *   { "cameras": [
 *       { "name": "back", "size": [w,h], "matrix": [[...]], "dist": [...],
 *         "rvec": [...], "tvec": [...] },
 *       ...
 *   ]}
 *
 * Or the export format from mv-gui:
 *   { "cameras": [
 *       { "name": "...", "matrix": [[...]], "dist": [...],
 *         "rvec": [...], "tvec": [...], "size": [...] },
 *       ...
 *   ]}
 *
 * @param {string} text - JSON file content
 * @returns {Camera[]} Array of Camera objects
 */
function parseCalibrationJSON(text) {
    const data = JSON.parse(text);
    const cameras = [];

    const camArray = data.cameras || data;
    if (!Array.isArray(camArray)) {
        throw new Error('JSON calibration must contain a "cameras" array or be an array');
    }

    for (let i = 0; i < camArray.length; i++) {
        const c = camArray[i];
        const name = c.name || ('cam_' + i);
        const matrix = c.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
        const dist = c.dist || c.distortions || [0, 0, 0, 0, 0];
        const rvec = c.rvec || c.rotation || [0, 0, 0];
        const tvec = c.tvec || c.translation || [0, 0, 0];
        const size = c.size || [640, 480];

        cameras.push(new Camera(name, matrix, dist, rvec, tvec, size));
    }

    return cameras;
}

// ============================================
// High-level file loading flows
// ============================================

/**
 * Open a file picker for calibration files (.toml, .json) and parse them.
 *
 * @returns {Promise<Camera[]|null>} Array of cameras, or null if cancelled/error
 */
async function loadCalibrationFile() {
    const files = await pickFiles({ accept: '.toml,.json' });
    if (files.length === 0) return null;

    const file = files[0];
    const text = await file.text();

    var cameras;
    if (file.name.endsWith('.toml')) {
        cameras = parseCalibrationTOML(text);
    } else if (file.name.endsWith('.json')) {
        cameras = parseCalibrationJSON(text);
    } else {
        throw new Error('Unsupported calibration format: ' + file.name);
    }
    return { cameras: cameras, fileName: file.name };
}

/**
 * Open a file picker for video files (.mp4, .avi, .webm).
 *
 * @returns {Promise<File[]>} Array of video files (empty if cancelled)
 */
async function pickVideoFiles() {
    return pickFiles({ accept: '.mp4,.avi,.webm,.mov', multiple: true });
}

/**
 * Match video files to camera names by filename.
 * Tries to match the filename stem (without extension) to camera names.
 *
 * @param {File[]} files - Video files
 * @param {Camera[]} cameras - Camera objects with .name
 * @returns {Map<string, File>} camera name -> File
 */
function matchVideosToCameras(files, cameras) {
    const result = new Map();
    const cameraNames = cameras.map(function (c) { return c.name; });

    for (let i = 0; i < files.length; i++) {
        const file = files[i];
        // Get filename without extension
        const stem = file.name.replace(/\.[^.]+$/, '');

        // Try exact match
        if (cameraNames.indexOf(stem) >= 0) {
            result.set(stem, file);
            continue;
        }

        // Try case-insensitive match
        const lower = stem.toLowerCase();
        for (let j = 0; j < cameraNames.length; j++) {
            if (cameraNames[j].toLowerCase() === lower) {
                result.set(cameraNames[j], file);
                break;
            }
        }
    }

    return result;
}

/**
 * Build a dynamic video grid in the given container for the specified camera names.
 * Creates video cells with canvases and overlay canvases.
 *
 * @param {HTMLElement} gridElement - The .video-grid container
 * @param {string[]} cameraNames - Array of camera names
 * @returns {Object[]} Array of { name, canvas, overlayCanvas, cell } for each camera
 */
function buildVideoGrid(gridElement, cameraNames) {
    // Clear existing cells
    gridElement.innerHTML = '';

    // Compute grid layout
    const count = cameraNames.length;
    const cols = Math.ceil(Math.sqrt(count));
    const rows = Math.ceil(count / cols);
    gridElement.style.gridTemplateColumns = 'repeat(' + cols + ', 1fr)';
    gridElement.style.gridTemplateRows = 'repeat(' + rows + ', 1fr)';

    const views = [];
    for (let i = 0; i < cameraNames.length; i++) {
        const name = cameraNames[i];

        const cell = document.createElement('div');
        cell.className = 'video-cell';
        cell.id = 'cell-' + name;

        const label = document.createElement('span');
        label.className = 'view-label';
        label.textContent = name;

        const wrapper = document.createElement('div');
        wrapper.className = 'canvas-wrapper';

        const canvas = document.createElement('canvas');
        canvas.id = 'canvas-' + name;

        const overlayCanvas = document.createElement('canvas');
        overlayCanvas.className = 'overlay-canvas';
        overlayCanvas.id = 'overlay-' + name;

        wrapper.appendChild(canvas);
        wrapper.appendChild(overlayCanvas);
        cell.appendChild(label);
        cell.appendChild(wrapper);
        gridElement.appendChild(cell);

        views.push({
            name: name,
            canvas: canvas,
            overlayCanvas: overlayCanvas,
            cell: cell,
            wrapper: wrapper,
        });
    }

    return views;
}

// ============================================
// Calibration TOML export
// ============================================

/**
 * Export cameras as a SLEAP-3d compatible calibration TOML string.
 *
 * Format:
 *   [cam_N]
 *   name = "camera_name"
 *   size = [width, height]
 *   matrix = [[fx, 0.0, cx], [0.0, fy, cy], [0.0, 0.0, 1.0]]
 *   distortions = [k1, k2, p1, p2, k3]
 *   rotation = [rx, ry, rz]
 *   translation = [tx, ty, tz]
 *
 * @param {Camera[]} cameras
 * @returns {string} TOML content
 */
function exportCalibrationTOML(cameras) {
    let toml = '';
    for (let i = 0; i < cameras.length; i++) {
        const c = cameras[i];
        toml += '[cam_' + i + ']\n';
        toml += 'name = "' + c.name + '"\n';
        toml += 'size = ' + JSON.stringify(c.size) + '\n';
        toml += 'matrix = ' + JSON.stringify(c.matrix) + '\n';
        toml += 'distortions = ' + JSON.stringify(c.dist) + '\n';
        toml += 'rotation = ' + JSON.stringify(c.rvec) + '\n';
        toml += 'translation = ' + JSON.stringify(c.tvec) + '\n';
        toml += '\n';
    }
    return toml;
}

// ============================================
// SLEAP skeleton serialization
// ============================================

/**
 * Serialize a Skeleton into the SLEAP metadata JSON format.
 * Follows the jsonpickle-style encoding used by sleap-io.
 *
 * @param {Skeleton} skeleton
 * @returns {{ skeletons: Object[], nodes: Object[] }}
 */
function serializeSkeleton(skeleton) {
    // Global node list with names (matches SLEAP-io nodes_dicts format)
    const nodes = skeleton.nodes.map(function (name) {
        return { name: name, weight: 1.0 };
    });

    // Build links with proper py/reduce and py/id edge type format
    const links = skeleton.edges.map(function (edge, i) {
        var edgeType;
        if (i === 0) {
            edgeType = {
                'py/reduce': [
                    {'py/type': 'sleap.skeleton.EdgeType'},
                    {'py/tuple': [1]}
                ]
            };
        } else {
            edgeType = {'py/id': 1};
        }
        return {
            edge_insert_idx: i,
            key: 0,
            source: edge[0],
            target: edge[1],
            type: edgeType,
        };
    });

    // Skeleton node indices (matches SLEAP-io skeleton_dicts format)
    const skelNodes = skeleton.nodes.map(function (name, i) {
        return { id: i };
    });

    const skeletons = [{
        directed: true,
        graph: { name: skeleton.name, num_edges_inserted: skeleton.edges.length },
        links: links,
        multigraph: true,
        nodes: skelNodes,
    }];

    return { skeletons: skeletons, nodes: nodes };
}

// ============================================
// SLP-compatible JSON export
// ============================================

/**
 * Export the full session as a SLEAP-compatible JSON file.
 * This is a JSON representation of the SLP HDF5 structure that can be
 * converted to a real .slp file via a Python script.
 *
 * The JSON includes:
 * - metadata (skeleton, version, provenance)
 * - videos (references)
 * - tracks
 * - frames, instances, points (structured arrays)
 * - sessions (calibration + 3D data)
 *
 * @param {Session} session
 * @param {Object[]} views - View objects with name, videoWidth, videoHeight
 * @returns {Object} The full export data object
 */
function buildSlpExportData(session, views, videoFiles) {
    const skelData = serializeSkeleton(session.skeleton);

    // Metadata
    const metadata = {
        version: '2.0.0',
        skeletons: skelData.skeletons,
        nodes: skelData.nodes,
        provenance: { source: 'mv-gui', exported_at: new Date().toISOString() },
    };

    // Videos — use videoPath from videoFiles if available
    const videos = views.map(function (v, i) {
        var videoPath = v.name + '.mp4';
        if (videoFiles) {
            for (var vi = 0; vi < videoFiles.length; vi++) {
                var vf = videoFiles[vi];
                if ((vf.name === v.name || vf.assignedCamera === v.name) && vf.videoPath) {
                    videoPath = vf.videoPath;
                    break;
                }
            }
        }
        var shape = [v.frameCount || 0, v.videoHeight || 0, v.videoWidth || 0, 1];
        return {
            filename: videoPath,
            backend: {
                type: 'MediaVideo',
                shape: shape,
                filename: videoPath,
                grayscale: false,
                bgr: false,
                dataset: '',
                input_format: '',
            },
            source_video: {
                filename: videoPath,
                backend: {
                    type: 'MediaVideo',
                    shape: shape,
                    filename: videoPath,
                    grayscale: false,
                    bgr: false,
                },
            },
        };
    });

    // Tracks
    const tracks = session.tracks.slice();

    // Build frames, instances, points arrays
    const frames = [];
    const instances = [];
    const points = [];
    const predPoints = [];

    let frameId = 0;
    let instanceId = 0;

    // Map camera name → video index
    const camToVideoIdx = {};
    session.cameras.forEach(function (cam, i) {
        camToVideoIdx[cam.name] = i;
    });

    // Iterate all frame groups (sorted by frame index)
    const sortedFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

    for (let fi = 0; fi < sortedFrameIndices.length; fi++) {
        const frameIdx = sortedFrameIndices[fi];
        const fg = session.frameGroups.get(frameIdx);

        // Build combined per-camera instance list (grouped + ungrouped)
        const combinedInstances = new Map();
        for (const [camName, camInsts] of fg.instances) {
            combinedInstances.set(camName, camInsts.slice());
        }
        for (const [camName, ulList] of fg.unlinkedInstances) {
            if (!combinedInstances.has(camName)) combinedInstances.set(camName, []);
            const arr = combinedInstances.get(camName);
            for (let u = 0; u < ulList.length; u++) arr.push(ulList[u].instance);
        }

        // For each camera that has instances in this frame
        for (const [camName, camInstances] of combinedInstances) {
            const videoIdx = camToVideoIdx[camName] !== undefined ? camToVideoIdx[camName] : 0;

            const instIdStart = instanceId;

            for (let ii = 0; ii < camInstances.length; ii++) {
                const inst = camInstances[ii];
                const isUser = inst.type === 'user';
                const pointIdStart = isUser ? points.length : predPoints.length;

                // Write points
                const numNodes = session.skeleton.nodes.length;
                for (let n = 0; n < numNodes; n++) {
                    const pt = inst.points[n];
                    const entry = {
                        x: pt ? pt[0] : NaN,
                        y: pt ? pt[1] : NaN,
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

                const pointIdEnd = isUser ? points.length : predPoints.length;

                instances.push({
                    instance_id: instanceId,
                    instance_type: isUser ? 0 : 1,
                    frame_id: frameId,
                    skeleton: 0,
                    track: inst.trackIdx >= 0 ? inst.trackIdx : -1,
                    from_predicted: -1,
                    score: inst.score || 0,
                    point_id_start: pointIdStart,
                    point_id_end: pointIdEnd,
                    tracking_score: 0,
                });

                instanceId++;
            }

            frames.push({
                frame_id: frameId,
                video: videoIdx,
                frame_idx: frameIdx,
                instance_id_start: instIdStart,
                instance_id_end: instanceId,
            });

            frameId++;
        }
    }

    // Sessions JSON (calibration + 3D data)
    const calibration = {};
    session.cameras.forEach(function (cam, i) {
        calibration['camera_' + i] = {
            name: cam.name,
            matrix: cam.matrix,
            distortions: cam.dist,
            rotation: cam.rvec,
            translation: cam.tvec,
        };
    });

    const camcorderToVideoIdxMap = {};
    session.cameras.forEach(function (cam, i) {
        camcorderToVideoIdxMap['camera_' + i] = i;
    });

    // Build frame_group_dicts with 3D triangulated data
    const frameGroupDicts = [];
    for (const [frameIdx, groups] of session.instanceGroups) {
        const instanceGroupsData = [];
        for (const group of groups) {
            const camToLfAndInst = {};
            for (const [camName, inst] of group.instances) {
                const camIdx = session.cameras.findIndex(function (c) { return c.name === camName; });
                if (camIdx >= 0) {
                    camToLfAndInst[String(camIdx)] = [frameIdx, 0];
                }
            }
            var igData = {
                camcorder_to_lf_and_inst_idx_map: camToLfAndInst,
                score: 1.0,
            };
            if (group.points3d) {
                igData.points = group.points3d;
            }
            if (group.identityId != null && group.identityId >= 0) {
                // Map identityId to index in session.identities array
                var idIdx = session.identities.findIndex(function (id) { return id.id === group.identityId; });
                if (idIdx >= 0) {
                    igData.identity_idx = idIdx;
                } else {
                    console.warn('[export] InstanceGroup has identityId ' + group.identityId + ' not found in session.identities — identity will be dropped from export');
                }
            }
            instanceGroupsData.push(igData);
        }

        const labeledFrameByCamera = {};
        session.cameras.forEach(function (cam, i) {
            labeledFrameByCamera[String(i)] = frameIdx;
        });

        frameGroupDicts.push({
            frame_idx: frameIdx,
            instance_groups: instanceGroupsData,
            labeled_frame_by_camera: labeledFrameByCamera,
        });
    }

    const sessions = [{
        calibration: calibration,
        camcorder_to_video_idx_map: camcorderToVideoIdxMap,
        frame_group_dicts: frameGroupDicts,
    }];

    // Serialize identities
    var identitiesJson = [];
    if (session.identities && session.identities.length > 0) {
        for (var ii2 = 0; ii2 < session.identities.length; ii2++) {
            var sid = session.identities[ii2];
            var idObj = { name: sid.name };
            if (sid.color) idObj.color = sid.color;
            identitiesJson.push(idObj);
        }
    }

    var hasIdentities = identitiesJson.length > 0;

    return {
        format_id: hasIdentities ? 1.9 : 1.4,
        metadata: metadata,
        videos: videos,
        tracks: tracks,
        suggestions: [],
        sessions: sessions,
        frames: frames,
        instances: instances,
        points: points,
        pred_points: predPoints,
        identities_json: identitiesJson.length > 0 ? identitiesJson : undefined,
    };
}

/**
 * Export 3D triangulated points as a JSON representation of the points3d.h5 structure.
 * Can be converted to HDF5 via a Python script.
 *
 * @param {Session} session
 * @returns {Object} { points_3d, frame_indices, track_names, node_names, reprojection_errors }
 */
function buildPoints3dExportData(session) {
    const nodeNames = session.skeleton.nodes.slice();
    const trackNames = (session.identities && session.identities.length > 0)
        ? session.identities.map(function (id) { return id.name; })
        : session.tracks.slice();
    const numNodes = nodeNames.length;
    const numTracks = Math.max(
        (session.identities ? session.identities.length : 0),
        session.tracks.length
    );

    const frameIndices = [];
    const points3dFrames = [];
    const errorFrames = [];

    // Collect frames that have triangulated data, sorted
    const sortedFrameIndices = Array.from(session.instanceGroups.keys()).sort(function (a, b) { return a - b; });

    for (let fi = 0; fi < sortedFrameIndices.length; fi++) {
        const frameIdx = sortedFrameIndices[fi];
        const groups = session.instanceGroups.get(frameIdx);

        // Build a per-track array for this frame
        const framePts = new Array(numTracks);
        const frameErr = new Array(numTracks);
        let hasData = false;

        for (let t = 0; t < numTracks; t++) {
            framePts[t] = new Array(numNodes);
            frameErr[t] = new Array(numNodes);
            for (let n = 0; n < numNodes; n++) {
                framePts[t][n] = [NaN, NaN, NaN];
                frameErr[t][n] = NaN;
            }
        }

        if (groups) {
            for (const group of groups) {
                const idIdx = group.identityId;
                if (idIdx < 0 || idIdx >= numTracks) continue;
                if (group.points3d) {
                    hasData = true;
                    for (let n = 0; n < Math.min(numNodes, group.points3d.length); n++) {
                        framePts[idIdx][n] = group.points3d[n];
                    }
                }
            }
        }

        if (hasData) {
            frameIndices.push(frameIdx);
            points3dFrames.push(framePts);
            errorFrames.push(frameErr);
        }
    }

    return {
        points_3d: points3dFrames,
        frame_indices: frameIndices,
        track_names: trackNames,
        node_names: nodeNames,
        reprojection_errors: errorFrames,
    };
}

/**
 * Download data as a JSON file.
 * @param {Object} data - Data to serialize
 * @param {string} filename - Download filename
 */
function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Download data as a TOML file.
 * @param {string} tomlContent - TOML string
 * @param {string} filename - Download filename
 */
function downloadTOML(tomlContent, filename) {
    const blob = new Blob([tomlContent], { type: 'text/plain' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

// ============================================
// h5wasm initialization
// ============================================

/** @type {Promise|null} */
let _h5wasmReady = null;

/**
 * Initialize h5wasm (loads WASM binary once).
 * @returns {Promise<Object>} The h5wasm module
 */
async function initH5wasm() {
    if (typeof h5wasm === 'undefined') {
        throw new Error('h5wasm script not loaded — check CDN script tag');
    }
    if (!_h5wasmReady) {
        // Add timeout so we don't hang forever
        _h5wasmReady = Promise.race([
            h5wasm.ready,
            new Promise(function(_, reject) {
                setTimeout(function() { reject(new Error('h5wasm init timed out (15s)')); }, 15000);
            })
        ]);
    }
    await _h5wasmReady;
    return h5wasm;
}

/**
 * Read file bytes from the h5wasm virtual filesystem and return as Blob.
 * @param {string} filename
 * @returns {Blob}
 */
function h5FileToBlob(filename) {
    var bytes = h5wasm.FS.readFile(filename);
    return new Blob([bytes], { type: 'application/x-hdf5' });
}

/**
 * Build a per-camera SLP export data object (for conversion to .slp via server or json_to_slp.py).
 *
 * @param {Session} session
 * @param {string} cameraName - The camera/view to export
 * @param {boolean} reprojAsUser - If true, export ReprojectedInstances as user (type=0)
 * @param {Object} videoFileInfo - Entry from state.videoFiles with videoWidth/videoHeight
 * @returns {Object} SLP export data object
 */
function buildPerCameraSlpJson(session, cameraName, reprojAsUser, videoFileInfo) {
    // Skeleton metadata
    var skelData = serializeSkeleton(session.skeleton);
    var metadata = {
        version: '2.0.0',
        skeletons: skelData.skeletons,
        nodes: skelData.nodes,
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    };

    // Single video entry for this camera
    var vw = videoFileInfo.videoWidth || 0;
    var vh = videoFileInfo.videoHeight || 0;
    var videoFilename = videoFileInfo.videoPath
        || (videoFileInfo.file ? videoFileInfo.file.name : (cameraName + '.mp4'));
    var videos = [{
        filename: videoFilename,
        backend: {
            type: 'MediaVideo',
            shape: [videoFileInfo.frameCount || 0, vh, vw, 1],
            filename: videoFilename,
            grayscale: false,
            bgr: false,
            dataset: '',
            input_format: '',
        },
        source_video: {
            filename: videoFilename,
            backend: {
                type: 'MediaVideo',
                shape: [videoFileInfo.frameCount || 0, vh, vw, 1],
                filename: videoFilename,
                grayscale: false,
                bgr: false,
            },
        },
    }];

    // Tracks
    var tracks = session.tracks.slice();

    // Build frames, instances, points arrays for this camera only
    var frames = [];
    var instances = [];
    var points = [];
    var predPoints = [];
    var frameId = 0;
    var instanceId = 0;
    var numNodes = session.skeleton.nodes.length;

    // Get all frame indices, sorted
    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

    for (var fi = 0; fi < allFrameIndices.length; fi++) {
        var frameIdx = allFrameIndices[fi];
        var fg = session.frameGroups.get(frameIdx);
        var camInstances = (fg.instances.get(cameraName) || []).slice();

        // Also include ungrouped (unlinked) UserInstances — export identically to grouped
        var ulInstances = fg.getUnlinkedInstances(cameraName);
        for (var ui = 0; ui < ulInstances.length; ui++) {
            camInstances.push(ulInstances[ui].instance);
        }

        // Also collect reprojected instances for this frame+camera
        var reprojInstances = [];
        var groups = session.instanceGroups.get(frameIdx);
        if (groups) {
            for (var gi = 0; gi < groups.length; gi++) {
                var reprojInst = groups[gi].getReprojectedInstance(cameraName);
                if (reprojInst) {
                    reprojInstances.push(reprojInst);
                }
            }
        }

        // Skip frames with no instances for this camera
        if (camInstances.length === 0 && reprojInstances.length === 0) continue;

        var instIdStart = instanceId;

        // Write user and predicted instances
        for (var ii = 0; ii < camInstances.length; ii++) {
            var inst = camInstances[ii];
            var isUser = (inst.type === 'user');
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

        // Write reprojected instances
        for (var ri = 0; ri < reprojInstances.length; ri++) {
            var rInst = reprojInstances[ri];
            var asUser = reprojAsUser;
            var rPointIdStart = asUser ? points.length : predPoints.length;

            for (var rn = 0; rn < numNodes; rn++) {
                var rpt = rInst.points[rn];
                var rEntry = {
                    x: rpt ? rpt[0] : null,
                    y: rpt ? rpt[1] : null,
                    visible: rpt != null,
                    complete: rpt != null,
                };
                if (asUser) {
                    points.push(rEntry);
                } else {
                    rEntry.score = rInst.score || 1.0;
                    predPoints.push(rEntry);
                }
            }

            var rPointIdEnd = asUser ? points.length : predPoints.length;

            instances.push({
                instance_id: instanceId,
                instance_type: asUser ? 0 : 1,
                frame_id: frameId,
                skeleton: 0,
                track: rInst.trackIdx >= 0 ? rInst.trackIdx : -1,
                from_predicted: -1,
                score: asUser ? 0 : (rInst.score || 1.0),
                point_id_start: rPointIdStart,
                point_id_end: rPointIdEnd,
                tracking_score: 0,
            });
            instanceId++;
        }

        frames.push({
            frame_id: frameId,
            video: 0,  // Single video, always index 0
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

// ============================================
// Client-side SLP export via sleap-io.js
// ============================================

/**
 * Build a sleap-io.js Labels object for a single camera, ready for saveSlpToBytes().
 *
 * @param {Session} session
 * @param {string} cameraName
 * @param {boolean} reprojAsUser - Export ReprojectedInstances as user instances
 * @param {Object} videoFileInfo - { videoWidth, videoHeight, frameCount, videoPath, file }
 * @returns {Object} sleap-io.js Labels instance
 */
function buildSlpLabels(session, cameraName, reprojAsUser, videoFileInfo, instanceFilter) {
    var SIO = window.SleapIO;
    if (!SIO) throw new Error('sleap-io.js not loaded');

    // 1. Build skeleton
    var nodeNames = session.skeleton.nodes.map(function (n) {
        return typeof n === 'string' ? n : (n.name || '');
    });
    var sioNodes = nodeNames.map(function (name) { return new SIO.Node(name); });
    var sioEdges = (session.skeleton.edges || []).map(function (e) {
        return new SIO.Edge(sioNodes[e[0]], sioNodes[e[1]]);
    });
    var skeleton = new SIO.Skeleton({
        nodes: sioNodes,
        edges: sioEdges,
        name: session.skeleton.name || 'skeleton',
    });

    // 2. Build tracks — start with grouped tracks, extend for ungrouped later
    var tracks = session.tracks.map(function (name) { return new SIO.Track(name); });

    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

    // 3. Build video
    var videoFilename = videoFileInfo.videoPath
        || (videoFileInfo.file ? videoFileInfo.file.name : (cameraName + '.mp4'));
    var vw = videoFileInfo.videoWidth || 0;
    var vh = videoFileInfo.videoHeight || 0;
    var fc = videoFileInfo.frameCount || 0;
    var video = new SIO.Video({
        filename: videoFilename,
        backendMetadata: {
            type: 'MediaVideo',
            shape: [fc, vh, vw, 1],
            filename: videoFilename,
            grayscale: false,
            bgr: false,
        },
        openBackend: false,
    });
    video.shape = [fc, vh, vw, 1];

    // 4. Build labeled frames
    var labeledFrames = [];
    var numNodes = session.skeleton.nodes.length;

    for (var fi = 0; fi < allFrameIndices.length; fi++) {
        var frameIdx = allFrameIndices[fi];
        var fg = session.frameGroups.get(frameIdx);

        // Separate grouped instances from ungrouped for this camera
        // Apply instanceFilter if provided: { user: bool, predicted: bool, reprojected: bool }
        var groupedInstances = [];
        var rawGrouped = fg.instances.get(cameraName) || [];
        for (var gi2 = 0; gi2 < rawGrouped.length; gi2++) {
            var gType = rawGrouped[gi2].type || 'user';
            if (!instanceFilter || instanceFilter[gType] !== false) {
                groupedInstances.push(rawGrouped[gi2]);
            }
        }

        var ungroupedInstances = [];
        if (!instanceFilter || instanceFilter.user !== false || instanceFilter.predicted !== false) {
            var ulInstances = fg.getUnlinkedInstances(cameraName);
            for (var ui = 0; ui < ulInstances.length; ui++) {
                var ulType = ulInstances[ui].instance.type || 'user';
                if (!instanceFilter || instanceFilter[ulType] !== false) {
                    ungroupedInstances.push(ulInstances[ui].instance);
                }
            }
        }

        // Collect reprojected instances with their group's trackIdx
        var reprojInstances = [];
        if (!instanceFilter || instanceFilter.reprojected !== false) {
            var groups = session.instanceGroups.get(frameIdx);
            if (groups) {
                for (var gi = 0; gi < groups.length; gi++) {
                    var reprojInst = groups[gi].getReprojectedInstance(cameraName);
                    if (reprojInst) {
                        // Find track from the group's instance for this camera (or any camera)
                        var grpTrackIdx = -1;
                        var grpCamInst = groups[gi].getInstance(cameraName);
                        if (grpCamInst && grpCamInst.trackIdx >= 0) {
                            grpTrackIdx = grpCamInst.trackIdx;
                        } else {
                            for (var [, gInst] of groups[gi].instances) {
                                if (gInst.trackIdx >= 0) { grpTrackIdx = gInst.trackIdx; break; }
                            }
                        }
                        reprojInst._groupTrackIdx = grpTrackIdx;
                        reprojInstances.push(reprojInst);
                    }
                }
            }
        }

        if (groupedInstances.length === 0 && ungroupedInstances.length === 0 && reprojInstances.length === 0) continue;

        var frameInstances = [];

        // 1. Grouped UserInstances first (retain their track)
        for (var ii = 0; ii < groupedInstances.length; ii++) {
            var inst = groupedInstances[ii];
            var instIsPred = inst.type === 'predicted';
            var instScore = inst.score != null ? inst.score : 1.0;
            var pts = _buildSioPoints(inst, numNodes, instIsPred ? instScore : undefined);
            var track = (inst.trackIdx >= 0 && inst.trackIdx < tracks.length) ? tracks[inst.trackIdx] : null;

            if (inst.type === 'user') {
                frameInstances.push(new SIO.Instance({
                    points: pts,
                    skeleton: skeleton,
                    track: track,
                }));
            } else {
                frameInstances.push(new SIO.PredictedInstance({
                    points: pts,
                    skeleton: skeleton,
                    track: track,
                    score: instScore,
                }));
            }
        }

        // 2. Ungrouped UserInstances next (no track assigned)
        for (var ugi = 0; ugi < ungroupedInstances.length; ugi++) {
            var ugInst = ungroupedInstances[ugi];
            var ugIsPred = ugInst.type === 'predicted';
            var ugScore = ugInst.score != null ? ugInst.score : 1.0;
            var ugPts = _buildSioPoints(ugInst, numNodes, ugIsPred ? ugScore : undefined);

            if (ugInst.type === 'user') {
                frameInstances.push(new SIO.Instance({
                    points: ugPts,
                    skeleton: skeleton,
                    track: null,
                }));
            } else {
                frameInstances.push(new SIO.PredictedInstance({
                    points: ugPts,
                    skeleton: skeleton,
                    track: null,
                    score: ugScore,
                }));
            }
        }

        // 3/4. Reprojections — same track as their associated group
        if (reprojAsUser !== null) {
            for (var ri = 0; ri < reprojInstances.length; ri++) {
                var rInst = reprojInstances[ri];
                var rScore = rInst.score != null ? rInst.score : 1.0;
                var rPts = _buildSioPoints(rInst, numNodes, reprojAsUser ? undefined : rScore);
                var rTrackIdx = rInst._groupTrackIdx;
                var rTrack = (rTrackIdx >= 0 && rTrackIdx < tracks.length) ? tracks[rTrackIdx] : null;

                if (reprojAsUser) {
                    frameInstances.push(new SIO.Instance({
                        points: rPts,
                        skeleton: skeleton,
                        track: rTrack,
                    }));
                } else {
                    frameInstances.push(new SIO.PredictedInstance({
                        points: rPts,
                        skeleton: skeleton,
                        track: rTrack,
                        score: rScore,
                    }));
                }
            }
        }

        labeledFrames.push(new SIO.LabeledFrame({
            video: video,
            frameIdx: frameIdx,
            instances: frameInstances,
        }));
    }

    // 5. Create Labels. Do NOT pass identities — the sleap-io.js
    // serializer bumps format_id to 1.9 when labels.identities is
    // non-empty, and sleap-io Python <=0.6.x cannot read format 1.9.
    // Identities are a lucid-internal concept; losing the color/name
    // metadata in the Export output is acceptable (Export is a flat
    // per-camera dump, not a lucid-project round-trip).
    return new SIO.Labels({
        labeledFrames: labeledFrames,
        videos: [video],
        skeletons: [skeleton],
        tracks: tracks,
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    });
}

/**
 * Convert a LUCID instance's points to sleap-io.js Point array.
 * @param {Instance} inst
 * @param {number} numNodes
 * @returns {Array} Point array
 */
function _buildSioPoints(inst, numNodes, perPointScore) {
    // perPointScore: optional. When set, each Point carries `score` so
    // sleap-io.js writes a non-zero `pred_points.score` for predicted
    // instances. SLEAP GUI hides predicted points below a small score
    // threshold — a lucid reprojection exported as a PredictedInstance
    // without a per-point score would render as `score=0.0` in the SLP
    // file and disappear in the GUI even though the xy is valid.
    // sleap-io.js ignores the `score` field when serializing a plain
    // Instance (non-predicted), so attaching it unconditionally is safe.
    var pts = [];
    var nulledNodes = inst.nulledNodes || null;
    for (var n = 0; n < numNodes; n++) {
        var pt = inst.points[n];
        var isNulled = nulledNodes && nulledNodes.has(n);
        var entry;
        if (pt == null || isNulled) {
            entry = { xy: [NaN, NaN], visible: false, complete: false };
        } else {
            var occ = inst.occluded && inst.occluded[n];
            entry = { xy: [pt[0], pt[1]], visible: !occ, complete: true };
        }
        if (perPointScore != null) entry.score = perPointScore;
        pts.push(entry);
    }
    return pts;
}

/**
 * Export SLP for a single camera using sleap-io.js (fully client-side).
 *
 * @param {Session} session
 * @param {string} cameraName
 * @param {boolean} reprojAsUser
 * @param {Object} videoFileInfo
 * @param {string} outputFilename
 * @returns {Promise<Blob>} SLP file as a Blob
 */
async function exportSlpClientSide(session, cameraName, reprojAsUser, videoFileInfo, outputFilename, instanceFilter) {
    var SIO = window.SleapIO;
    if (!SIO) throw new Error('sleap-io.js not loaded');

    var labels = buildSlpLabels(session, cameraName, reprojAsUser, videoFileInfo, instanceFilter);
    var bytes = await SIO.saveSlpToBytes(labels);
    var compatBytes = await _convertSlpToV06Compatible(bytes);
    return new Blob([compatBytes], { type: 'application/x-hdf5' });
}

// ==========================================================================
// v0.6.x SLP compatibility pass for lucid SLP writes
//
// sleap-io.js 0.2.x writes the per-record datasets (`instances`, `frames`,
// `points`, `pred_points`) as plain 2-D matrices with `field_names` stored
// as a string attribute. sleap-io Python <=0.6.5 — the last pre-format-1.9
// release and the newest version a SLEAP GUI install will pull today —
// expects HDF5 compound (structured) datatypes and crashes at
// `skeletons[skeleton_id]` in `read_instances` because the unpacked field
// lands as a `numpy.float32` rather than an int. This post-pass reopens the
// freshly-written bytes, copies every dataset into a clean output file with
// the four record datasets rewritten as compound dtypes matching sleap-io
// Python's `instance_dtype` / `frame_dtype` / `point_dtype` schema, strips
// the format-1.9-only `identities_json` / `sessions_json` payloads, and
// pins `metadata.format_id = 1.4`.
//
// Applied to both paths: `exportSlpClientSide` (File → Export 2D SLP) and
// `buildSlpBytes` (Ctrl+S / Save / Save As). Stripping `sessions_json` means
// lucid projects lose their rich multi-view state (RecordingSession,
// FrameGroup, InstanceGroup, Instance3D) on save — the trade-off is
// SLEAP-GUI compatibility. Per-view LabeledFrames + tracks survive; lucid
// re-import reconstructs multi-view structure from track indices, the same
// way it handles external SLEAP SLPs.
// ==========================================================================

var _SLP_INSTANCE_FIELDS = [
    { name: 'instance_id',     type: 0, size: 8, signed: 1 }, // i8
    { name: 'instance_type',   type: 0, size: 1, signed: 0 }, // u1
    { name: 'frame_id',        type: 0, size: 8, signed: 0 }, // u8
    { name: 'skeleton',        type: 0, size: 4, signed: 0 }, // u4
    { name: 'track',           type: 0, size: 4, signed: 1 }, // i4
    { name: 'from_predicted',  type: 0, size: 8, signed: 1 }, // i8
    { name: 'score',           type: 1, size: 4, signed: 1 }, // f4
    { name: 'point_id_start',  type: 0, size: 8, signed: 0 }, // u8
    { name: 'point_id_end',    type: 0, size: 8, signed: 0 }, // u8
    { name: 'tracking_score',  type: 1, size: 4, signed: 1 }, // f4
];
var _SLP_FRAME_FIELDS = [
    { name: 'frame_id',          type: 0, size: 8, signed: 0 },
    { name: 'video',             type: 0, size: 4, signed: 0 },
    { name: 'frame_idx',         type: 0, size: 8, signed: 0 },
    { name: 'instance_id_start', type: 0, size: 8, signed: 0 },
    { name: 'instance_id_end',   type: 0, size: 8, signed: 0 },
];
var _SLP_POINT_FIELDS = [
    { name: 'x',        type: 1, size: 8, signed: 1 }, // f8
    { name: 'y',        type: 1, size: 8, signed: 1 }, // f8
    { name: 'visible',  type: 0, size: 1, signed: 0 }, // u1 (stores bool 0/1)
    { name: 'complete', type: 0, size: 1, signed: 0 }, // u1
];
var _SLP_PRED_POINT_FIELDS = _SLP_POINT_FIELDS.concat([
    { name: 'score', type: 1, size: 8, signed: 1 }, // f8
]);

// The CDN-loaded h5wasm@0.8.8 (global `h5wasm`) predates
// `create_compound_dataset`. The *local* bundle under
// `lib/h5wasm/hdf5_hl.js` (shipped with sleap-io.js) is newer and exposes
// the method we need. The import map in `index.html` resolves
// `import('h5wasm')` to that local bundle; we memoize the ESM instance
// here. This intentionally uses a separate h5wasm runtime from
// `initH5wasm()` — they share no state and each owns its own virtual
// filesystem, which is fine for this post-pass.
var _localH5wasmReady = null;
async function _initLocalH5wasm() {
    if (!_localH5wasmReady) {
        _localH5wasmReady = import('h5wasm').then(async function (mod) {
            await mod.ready;
            return { File: mod.File, FS: mod.FS };
        });
    }
    return _localH5wasmReady;
}

async function _convertSlpToV06Compatible(rawBytes) {
    var h5 = await _initLocalH5wasm();
    var stamp = Date.now().toString(16) + '-' + Math.random().toString(16).slice(2, 10);
    var srcPath = '/lucid-export-src-' + stamp + '.h5';
    var dstPath = '/lucid-export-dst-' + stamp + '.h5';
    h5.FS.writeFile(srcPath, new Uint8Array(rawBytes));
    var outBytes;
    try {
        var src = new h5.File(srcPath, 'r');
        var dst = new h5.File(dstPath, 'w');
        try {
            _copyMetadataGroupAs14(src, dst);
            var names = src.keys();
            for (var i = 0; i < names.length; i++) {
                var name = names[i];
                if (name === 'metadata') continue;
                if (name === 'identities_json') continue; // format 1.9 payload, drop
                if (name === 'sessions_json') continue;   // v0.6.5 KeyErrors on lucid's shape
                if (name === 'instances') {
                    _writeCompoundFromMatrix(src, dst, 'instances', _SLP_INSTANCE_FIELDS);
                } else if (name === 'frames') {
                    _writeCompoundFromMatrix(src, dst, 'frames', _SLP_FRAME_FIELDS);
                } else if (name === 'points') {
                    _writeCompoundFromMatrix(src, dst, 'points', _SLP_POINT_FIELDS);
                } else if (name === 'pred_points') {
                    _writeCompoundFromMatrix(src, dst, 'pred_points', _SLP_PRED_POINT_FIELDS);
                } else {
                    _copyDatasetAsIs(src, dst, name);
                }
            }
        } finally {
            try { src.close(); } catch (e) {}
            try { dst.close(); } catch (e) {}
        }
        outBytes = h5.FS.readFile(dstPath);
    } finally {
        try { h5.FS.unlink(srcPath); } catch (e) {}
        try { h5.FS.unlink(dstPath); } catch (e) {}
    }
    return outBytes;
}

function _copyMetadataGroupAs14(src, dst) {
    var srcMeta = src.get('metadata');
    var dstMeta = dst.create_group('metadata');
    // Copy every attribute except format_id (which we override to 1.4).
    var attrNames = Object.keys(srcMeta.attrs || {});
    for (var i = 0; i < attrNames.length; i++) {
        var aname = attrNames[i];
        if (aname === 'format_id') continue;
        var aval = srcMeta.get_attribute(aname);
        _cloneAttribute(dstMeta, aname, aval);
    }
    // Pin format_id to 1.4 explicitly as float32 to match sleap-io Python's writer.
    dstMeta.create_attribute('format_id', new Float32Array([1.4]), [], '<f4');
}

function _cloneAttribute(target, name, value) {
    if (typeof value === 'string') {
        // Fixed-length string (S<byteLen>) — sleap-io Python v0.6.5's
        // read_metadata calls `.decode()` on the attr payload, which
        // only works if h5py returns it as bytes. Vlen-string ('S')
        // round-trips as Python `str` and breaks `.decode()`.
        var byteLen = new TextEncoder().encode(value).length;
        target.create_attribute(name, value, null, 'S' + byteLen);
    } else if (typeof value === 'number') {
        target.create_attribute(name, new Float64Array([value]), [], '<f8');
    } else if (value && value.buffer instanceof ArrayBuffer) {
        target.create_attribute(name, value);
    } else if (Array.isArray(value)) {
        target.create_attribute(name, value);
    } else {
        // Fallback: serialize as JSON fixed-length string.
        var s = JSON.stringify(value);
        var sLen = new TextEncoder().encode(s).length;
        target.create_attribute(name, s, null, 'S' + sLen);
    }
}

function _writeCompoundFromMatrix(src, dst, name, fields) {
    var ds = src.get(name);
    if (!ds) return;
    var shape = ds.shape;
    var nrows = (shape && shape[0]) ? Number(shape[0]) : 0;
    var ncols = fields.length;
    var rowSize = fields.reduce(function (a, f) { return a + f.size; }, 0);
    if (nrows === 0) {
        // Empty dataset — sleap-io.js writes shape [0, ncols]. Create a
        // zero-length compound dataset so the reader sees the same shape.
        var empty = new ArrayBuffer(0);
        dst.create_compound_dataset({
            name: name,
            data: empty,
            fieldNames: fields.map(function (f) { return f.name; }),
            fieldTypes: fields.map(function (f) { return f.type; }),
            fieldSizes: fields.map(function (f) { return f.size; }),
            fieldSigns: fields.map(function (f) { return f.signed; }),
            nrows: 0,
            rowSize: rowSize,
        });
        return;
    }
    // Read the plain matrix. `.value` gives a flat typed array (e.g. a
    // Float32Array of length nrows*ncols). `.slice()` is nicer but not
    // always present — .value is universal.
    var flat = ds.value;
    if (flat.length !== nrows * ncols) {
        throw new Error('unexpected ' + name + ' buffer length: ' + flat.length +
            ' (expected ' + (nrows * ncols) + ')');
    }
    var buf = new ArrayBuffer(nrows * rowSize);
    var dv = new DataView(buf);
    for (var r = 0; r < nrows; r++) {
        var off = r * rowSize;
        for (var c = 0; c < ncols; c++) {
            var v = flat[r * ncols + c];
            var field = fields[c];
            _writeField(dv, off, field, v);
            off += field.size;
        }
    }
    dst.create_compound_dataset({
        name: name,
        data: buf,
        fieldNames: fields.map(function (f) { return f.name; }),
        fieldTypes: fields.map(function (f) { return f.type; }),
        fieldSizes: fields.map(function (f) { return f.size; }),
        fieldSigns: fields.map(function (f) { return f.signed; }),
        nrows: nrows,
        rowSize: rowSize,
    });
}

function _writeField(dv, off, field, value) {
    // type 0 = H5T_INTEGER, type 1 = H5T_FLOAT. signed per-field.
    if (field.type === 1) {
        if (field.size === 4) dv.setFloat32(off, Number(value), true);
        else dv.setFloat64(off, Number(value), true);
        return;
    }
    // Integer. NaN from source float matrix must not propagate into integers.
    var n = Number(value);
    if (!isFinite(n)) n = 0;
    n = Math.trunc(n);
    if (field.size === 1) {
        if (field.signed) dv.setInt8(off, n);
        else dv.setUint8(off, n & 0xff);
    } else if (field.size === 4) {
        if (field.signed) dv.setInt32(off, n, true);
        else dv.setUint32(off, n >>> 0, true);
    } else if (field.size === 8) {
        if (field.signed) dv.setBigInt64(off, BigInt(n), true);
        else dv.setBigUint64(off, BigInt(Math.max(0, n)), true);
    } else {
        throw new Error('unsupported integer size ' + field.size);
    }
}

function _copyDatasetAsIs(src, dst, name) {
    var ds = src.get(name);
    if (!ds) return;
    var meta = ds.metadata;
    var value = ds.value;
    // String datasets (type class 3 = H5T_STRING) carry vlen strings.
    // `.value` returns a plain JS array of strings; forward shape + dtype.
    if (meta && meta.type === 3) {
        dst.create_dataset({
            name: name,
            data: value,
            shape: ds.shape ? ds.shape.map(Number) : [value.length],
            dtype: 'S',
        });
        return;
    }
    // Numeric datasets: re-emit with same shape + a compatible dtype
    // inferred from metadata. For the flat-matrix helpers sleap-io.js
    // emits, this preserves `tracks_json` (object), `suggestions_json`
    // (<i4), etc. byte-for-byte.
    var dtype = _metadataToDtypeString(meta);
    dst.create_dataset({
        name: name,
        data: value,
        shape: ds.shape.map(Number),
        dtype: dtype,
    });
}

function _metadataToDtypeString(meta) {
    // Mirrors h5wasm's internal metadata_to_dtype just enough for the
    // datasets lucid's Export actually emits.
    if (!meta) return null;
    if (meta.type === 1) {
        // float
        return meta.size === 4 ? '<f4' : '<f8';
    }
    if (meta.type === 0) {
        // integer
        var prefix = meta.signed ? '<i' : '<u';
        return prefix + meta.size;
    }
    if (meta.type === 3) return 'S';
    return '<f8';
}

/**
 * Build a sleap-io.js Labels object for all camera views.
 *
 * @param {Session} session
 * @param {Array} views - Array of view objects with .name, .videoWidth, .videoHeight, .frameCount
 * @param {Array} videoFiles - Array of videoFile objects
 * @returns {Object} sleap-io.js Labels instance
 */
function buildSlpLabelsAllViews(session, views, videoFiles) {
    var SIO = window.SleapIO;
    if (!SIO) throw new Error('sleap-io.js not loaded');

    // 1. Build skeleton
    var nodeNames = session.skeleton.nodes.map(function (n) {
        return typeof n === 'string' ? n : (n.name || '');
    });
    var sioNodes = nodeNames.map(function (name) { return new SIO.Node(name); });
    var sioEdges = (session.skeleton.edges || []).map(function (e) {
        return new SIO.Edge(sioNodes[e[0]], sioNodes[e[1]]);
    });
    var skeleton = new SIO.Skeleton({
        nodes: sioNodes,
        edges: sioEdges,
        name: session.skeleton.name || 'skeleton',
    });

    // 2. Build tracks
    var tracks = session.tracks.map(function (name) { return new SIO.Track(name); });

    // 3. Build sleap-io Identity objects
    var sioIdentities = [];
    var lucidIdToSioId = new Map(); // lucid identity.id → SIO.Identity
    if (session.identities && session.identities.length > 0) {
        for (var iid = 0; iid < session.identities.length; iid++) {
            var lucidId = session.identities[iid];
            var sioId = new SIO.Identity({ name: lucidId.name, color: lucidId.color });
            sioIdentities.push(sioId);
            lucidIdToSioId.set(lucidId.id, sioId);
        }
    }

    // 4. Build sleap-io Cameras and Videos — one per camera
    var sioCameras = [];
    var sioVideos = [];
    var lucidCamToSioCam = new Map(); // camName → SIO.Camera
    session.cameras.forEach(function (cam, i) {
        var sioCam = new SIO.Camera({
            name: cam.name,
            rvec: cam.rvec || [0, 0, 0],
            tvec: cam.tvec || [0, 0, 0],
            matrix: cam.matrix,
            distortions: cam.dist,
            size: cam.size,
        });
        sioCameras.push(sioCam);
        lucidCamToSioCam.set(cam.name, sioCam);

        var videoPath = cam.name + '.mp4';
        var vw = 0, vh = 0, fc = 0;
        for (var vi = 0; vi < (views || []).length; vi++) {
            var v = views[vi];
            if (v.name === cam.name) {
                vw = v.videoWidth || 0;
                vh = v.videoHeight || 0;
                fc = v.frameCount || 0;
                break;
            }
        }
        if (videoFiles) {
            for (var vfi = 0; vfi < videoFiles.length; vfi++) {
                var vf = videoFiles[vfi];
                if ((vf.name === cam.name || vf.assignedCamera === cam.name) && vf.videoPath) {
                    videoPath = vf.videoPath;
                    break;
                }
            }
        }
        var video = new SIO.Video({
            filename: videoPath,
            backendMetadata: {
                type: 'MediaVideo',
                shape: [fc, vh, vw, 1],
                filename: videoPath,
            },
            openBackend: false,
        });
        video.shape = [fc, vh, vw, 1];
        sioVideos.push(video);
    });

    // 5. Build RecordingSession with CameraGroup
    var cameraGroup = new SIO.CameraGroup({ cameras: sioCameras });
    var sioSession = new SIO.RecordingSession({ cameraGroup: cameraGroup });

    // Attach lucid-specific session metadata
    sioSession.metadata = sioSession.metadata || {};
    console.log('[buildSlpLabelsAllViews] Saving session name:', session.name);
    sioSession.metadata.lucid = {
        sessionName: session.name || null,
        trustTracks: session.trustTracks || false,
        trackIdentityMap: Array.from(session.trackIdentityMap.entries()),
        frameIdentityMap: session.frameIdentityMap
            ? Array.from(session.frameIdentityMap.entries())
            : [],
        skeleton: {
            name: session.skeleton.name || 'skeleton',
            nodes: session.skeleton.nodes,
            edges: session.skeleton.edges,
        },
        tracks: session.tracks,
    };
    session.cameras.forEach(function (cam, i) {
        sioSession.addVideo(sioVideos[i], sioCameras[i]);
    });

    // 6. Build labeled frames and session FrameGroups
    //    Key optimization: create each SIO.Instance once and share between
    //    LabeledFrames and InstanceGroups to avoid doubling memory usage.
    var labeledFrames = [];
    var numNodes = session.skeleton.nodes.length;
    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

    // Map to look up labeled frames by (videoIdx, frameIdx)
    var lfLookup = new Map(); // "videoIdx:frameIdx" → LabeledFrame

    for (var fi = 0; fi < allFrameIndices.length; fi++) {
        var frameIdx = allFrameIndices[fi];
        var fg = session.frameGroups.get(frameIdx);

        // Build SIO instances once per lucid instance, keyed by object identity
        // so we can reuse them in both LabeledFrames and InstanceGroups
        var lucidToSio = new Map(); // lucid Instance → SIO Instance

        function _getOrCreateSioInst(inst) {
            var existing = lucidToSio.get(inst);
            if (existing) return existing;
            var pts = _buildSioPoints(inst, numNodes);
            var track = (inst.trackIdx >= 0 && inst.trackIdx < tracks.length) ? tracks[inst.trackIdx] : null;
            var sioInst;
            if (inst.type === 'user') {
                sioInst = new SIO.Instance({ points: pts, skeleton: skeleton, track: track });
            } else {
                sioInst = new SIO.PredictedInstance({ points: pts, skeleton: skeleton, track: track, score: inst.score || 0 });
            }
            lucidToSio.set(inst, sioInst);
            return sioInst;
        }

        // Create per-camera LabeledFrames from grouped + ungrouped instances
        var lfByCamera = new Map();
        for (var [camName3, camInstances] of fg.instances) {
            var sioCam = lucidCamToSioCam.get(camName3);
            var camIdx = session.cameras.findIndex(function (c) { return c.name === camName3; });
            var video = sioVideos[camIdx];
            if (!video || !sioCam) continue;

            var frameInstances = [];
            for (var ii = 0; ii < camInstances.length; ii++) {
                frameInstances.push(_getOrCreateSioInst(camInstances[ii]));
            }

            // Also add ungrouped instances for this camera
            var ulList = fg.getUnlinkedInstances(camName3);
            for (var ui = 0; ui < ulList.length; ui++) {
                frameInstances.push(_getOrCreateSioInst(ulList[ui].instance));
            }

            if (frameInstances.length > 0) {
                var lf = new SIO.LabeledFrame({ video: video, frameIdx: frameIdx, instances: frameInstances });
                labeledFrames.push(lf);
                lfByCamera.set(sioCam, lf);
                lfLookup.set(camIdx + ':' + frameIdx, lf);
            }
        }
        // Handle ungrouped instances for cameras that had no grouped instances
        for (var [ulCam, ulInstList] of fg.unlinkedInstances) {
            if (fg.instances.has(ulCam)) continue; // already handled above
            var ulSioCam = lucidCamToSioCam.get(ulCam);
            var ulCamIdx = session.cameras.findIndex(function (c) { return c.name === ulCam; });
            var ulVideo = sioVideos[ulCamIdx];
            if (!ulVideo || !ulSioCam) continue;
            var ulFrameInsts = [];
            for (var ui2 = 0; ui2 < ulInstList.length; ui2++) {
                ulFrameInsts.push(_getOrCreateSioInst(ulInstList[ui2].instance));
            }
            if (ulFrameInsts.length > 0) {
                var ulLf = new SIO.LabeledFrame({ video: ulVideo, frameIdx: frameIdx, instances: ulFrameInsts });
                labeledFrames.push(ulLf);
                lfByCamera.set(ulSioCam, ulLf);
                lfLookup.set(ulCamIdx + ':' + frameIdx, ulLf);
            }
        }

        // Build sleap-io InstanceGroups — reuse SIO instances from above
        var sioInstanceGroups = [];
        var lucidGroups = session.instanceGroups.get(frameIdx) || [];
        for (var gi = 0; gi < lucidGroups.length; gi++) {
            var group = lucidGroups[gi];
            var instanceByCamera = new Map();
            for (var [gCamName, gInst] of group.instances) {
                var gSioCam = lucidCamToSioCam.get(gCamName);
                if (!gSioCam) continue;
                // Reuse the SIO instance already created for the LabeledFrame
                instanceByCamera.set(gSioCam, _getOrCreateSioInst(gInst));
            }

            // Build Instance3D from group.points3d
            var instance3d = undefined;
            if (group.points3d && group.points3d.length > 0) {
                instance3d = new SIO.Instance3D({ points: group.points3d, skeleton: skeleton });
            }

            // Resolve identity
            var identity = undefined;
            if (group.identityId != null && group.identityId >= 0) {
                identity = lucidIdToSioId.get(group.identityId);
            }

            // Collect full per-instance lucid metadata for precise round-trip
            var igLucidMeta = { instanceMeta: {} };
            for (var [metaCam, metaInst] of group.instances) {
                var instMeta = {
                    trackIdx: metaInst.trackIdx,
                    type: metaInst.type || 'user',
                    score: metaInst.score || 0,
                    modified: metaInst.modified || false,
                };
                if (metaInst.nulledNodes && metaInst.nulledNodes.size > 0) {
                    instMeta.nulledNodes = Array.from(metaInst.nulledNodes);
                }
                if (metaInst.occluded) {
                    var hasAnyOcc = false;
                    for (var ok in metaInst.occluded) { if (metaInst.occluded[ok]) { hasAnyOcc = true; break; } }
                    if (hasAnyOcc) instMeta.occluded = metaInst.occluded;
                }
                igLucidMeta.instanceMeta[metaCam] = instMeta;
            }

            var igMetadata = { lucid: igLucidMeta };

            sioInstanceGroups.push(new SIO.InstanceGroup({
                instanceByCamera: instanceByCamera,
                instance3d: instance3d,
                identity: identity,
                metadata: igMetadata,
            }));
        }

        // Release per-frame map to free memory as we go
        lucidToSio = null;

        if (sioInstanceGroups.length > 0 || lfByCamera.size > 0) {
            sioSession.frameGroups.set(frameIdx, new SIO.FrameGroup({
                frameIdx: frameIdx,
                instanceGroups: sioInstanceGroups,
                labeledFrameByCamera: lfByCamera,
            }));
        }
    }

    return new SIO.Labels({
        labeledFrames: labeledFrames,
        videos: sioVideos,
        skeletons: [skeleton],
        tracks: tracks,
        identities: sioIdentities,
        sessions: [sioSession],
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    });
}

// ============================================
// Points3d HDF5 export (in-browser)
// ============================================

/**
 * Build a points3d.h5 HDF5 file as a Blob.
 * Ports json_to_h5.py logic to JavaScript using h5wasm.
 *
 * @param {Session} session
 * @returns {Promise<Blob>} The .h5 file as a Blob
 */
async function buildPoints3dH5(session) {
    const mod = await initH5wasm();
    const fname = 'export_points3d.h5';

    // Build JSON intermediate
    const data = buildPoints3dExportData(session);

    const frameIndices = data.frame_indices;
    const trackNames = data.track_names;
    const nodeNames = data.node_names;
    const pts3dRaw = data.points_3d;
    const reprojRaw = data.reprojection_errors;

    const nFrames = frameIndices.length;
    const nTracks = trackNames.length;
    const nNodes = nodeNames.length;

    // Build 4D flat array: (n_frames, n_tracks, n_nodes, 3)
    const pts3d = new Float64Array(nFrames * nTracks * nNodes * 3);
    pts3d.fill(NaN);
    for (var fi = 0; fi < nFrames; fi++) {
        if (!pts3dRaw[fi]) continue;
        for (var ti = 0; ti < nTracks; ti++) {
            if (!pts3dRaw[fi][ti]) continue;
            for (var ni = 0; ni < nNodes; ni++) {
                var pt = pts3dRaw[fi][ti][ni];
                if (pt && pt.length === 3) {
                    var base = ((fi * nTracks + ti) * nNodes + ni) * 3;
                    pts3d[base] = pt[0];
                    pts3d[base + 1] = pt[1];
                    pts3d[base + 2] = pt[2];
                }
            }
        }
    }

    // Build 3D flat array: (n_frames, n_tracks, n_nodes)
    const reprojErr = new Float64Array(nFrames * nTracks * nNodes);
    reprojErr.fill(NaN);
    for (var fi2 = 0; fi2 < nFrames; fi2++) {
        if (!reprojRaw[fi2]) continue;
        for (var ti2 = 0; ti2 < nTracks; ti2++) {
            if (!reprojRaw[fi2][ti2]) continue;
            for (var ni2 = 0; ni2 < nNodes; ni2++) {
                var val = reprojRaw[fi2][ti2][ni2];
                if (val != null && !isNaN(val)) {
                    reprojErr[(fi2 * nTracks + ti2) * nNodes + ni2] = val;
                }
            }
        }
    }

    const f = new mod.File(fname, 'w');
    try {
        f.create_dataset({name: 'points_3d', data: pts3d, shape: [nFrames, nTracks, nNodes, 3]});
        f.create_dataset({name: 'frame_indices', data: new Float64Array(frameIndices)});
        f.create_dataset({name: 'reprojection_error', data: reprojErr, shape: [nFrames, nTracks, nNodes]});
        f.create_dataset({name: 'track_names', data: trackNames});
        f.create_dataset({name: 'node_names', data: nodeNames});

        f.close();
        return h5FileToBlob(fname);
    } catch (err) {
        f.close();
        throw err;
    }
}

// ============================================
// Reprojections HDF5 export (in-browser)
// ============================================

/**
 * Build a reprojections.h5 HDF5 file as a Blob.
 * Contains 2D reprojected points per camera.
 * Shape: (n_frames, n_tracks, n_cameras, n_nodes, 2)
 *
 * @param {Session} session
 * @returns {Promise<Blob>} The .h5 file as a Blob
 */
async function buildReprojH5(session) {
    const mod = await initH5wasm();
    const fname = 'export_reprojections.h5';

    const cameras = session.cameras;
    const nodeNames = session.skeleton.nodes;
    const trackNames = (session.identities && session.identities.length > 0)
        ? session.identities.map(function (id) { return id.name; })
        : session.tracks.slice();
    const nCameras = cameras.length;
    const nNodes = nodeNames.length;
    const nTracks = Math.max(
        (session.identities ? session.identities.length : 0),
        session.tracks.length
    );
    const cameraNames = cameras.map(function (c) { return c.name; });

    // Collect frames sorted
    const sortedFrameIndices = Array.from(session.instanceGroups.keys()).sort(function (a, b) { return a - b; });
    const nFrames = sortedFrameIndices.length;

    // Build 5D flat array: (n_frames, n_tracks, n_cameras, n_nodes, 2)
    const reproj = new Float64Array(nFrames * nTracks * nCameras * nNodes * 2);
    reproj.fill(NaN);

    for (var fi = 0; fi < nFrames; fi++) {
        var frameIdx = sortedFrameIndices[fi];
        var groups = session.instanceGroups.get(frameIdx);
        if (!groups) continue;

        for (var group of groups) {
            var idIdx = group.identityId;
            if (idIdx < 0 || idIdx >= nTracks) continue;
            if (!group.reprojections) continue;
            for (var ci = 0; ci < nCameras; ci++) {
                var camName = cameraNames[ci];
                var reprojPts = group.reprojections[camName];
                if (!reprojPts) continue;
                for (var ni = 0; ni < Math.min(nNodes, reprojPts.length); ni++) {
                    var rpt = reprojPts[ni];
                    if (rpt) {
                        var rbase = (((fi * nTracks + idIdx) * nCameras + ci) * nNodes + ni) * 2;
                        reproj[rbase] = rpt[0];
                        reproj[rbase + 1] = rpt[1];
                    }
                }
            }
        }
    }

    const f = new mod.File(fname, 'w');
    try {
        f.create_dataset({name: 'reprojections', data: reproj, shape: [nFrames, nTracks, nCameras, nNodes, 2]});
        f.create_dataset({name: 'frame_indices', data: new Float64Array(sortedFrameIndices)});
        f.create_dataset({name: 'track_names', data: trackNames});
        f.create_dataset({name: 'node_names', data: nodeNames.slice()});
        f.create_dataset({name: 'camera_names', data: cameraNames});

        f.close();
        return h5FileToBlob(fname);
    } catch (err) {
        f.close();
        throw err;
    }
}

// ============================================
// SLP HDF5 import (in-browser)
// ============================================
// Adapted from slp-viewer/slp-worker.js — proven to work with real SLEAP .slp files.

/**
 * Normalize a compound dataset value from h5wasm to columnar format.
 * h5wasm can return compound datasets as:
 *   - Array of arrays (tuples): [[v1,v2,...], [v1,v2,...], ...]
 *   - Object with typed arrays (columnar): { field1: TypedArray, field2: TypedArray, ... }
 *
 * @param {*} raw - dataset.value
 * @param {string[]} fieldNames - expected field names
 * @returns {Object|null} Columnar object { field: array, ... } or null
 */
function _normalizeCompound(raw, fieldNames) {
    if (!raw || raw.length === 0) return null;

    // Already columnar (object with named arrays)
    if (!Array.isArray(raw) && typeof raw === 'object' && raw[fieldNames[0]] !== undefined) {
        return raw;
    }

    // Array of tuples → convert to columnar
    if (Array.isArray(raw) && raw.length > 0 && Array.isArray(raw[0])) {
        var data = {};
        for (var i = 0; i < fieldNames.length; i++) {
            data[fieldNames[i]] = raw.map(function(row) { return row[i]; });
        }
        return data;
    }

    console.warn('[_normalizeCompound] Unexpected format:', typeof raw, Array.isArray(raw),
        raw.length > 0 ? typeof raw[0] : 'empty');
    return null;
}

/**
 * Read an HDF5 object (dataset or group) into columnar format.
 * Handles:
 *   - Compound dataset: calls _normalizeCompound on .value
 *   - Group with sub-datasets: reads each field as a sub-dataset
 *
 * @param {Object} obj - h5wasm Dataset or Group
 * @param {string[]} fieldNames - Expected field names
 * @returns {Object|null} Columnar object { field: array, ... } or null
 */
function _readColumnar(obj, fieldNames) {
    console.log('[_readColumnar] Reading fields:', fieldNames.join(','),
        'obj type:', obj.constructor ? obj.constructor.name : typeof obj,
        'has .value:', obj.value !== undefined,
        'has .keys:', typeof obj.keys === 'function');

    // Try as compound dataset first
    if (obj.value !== undefined) {
        var raw = obj.value;
        console.log('[_readColumnar] .value type:', typeof raw, 'isArray:', Array.isArray(raw),
            'length:', raw && raw.length !== undefined ? raw.length : 'N/A');
        if (Array.isArray(raw) && raw.length > 0) {
            console.log('[_readColumnar] First element type:', typeof raw[0], 'isArray:', Array.isArray(raw[0]));
        }
        var result = _normalizeCompound(raw, fieldNames);
        if (result) {
            console.log('[_readColumnar] Normalized as compound dataset, length:', result[fieldNames[0]] ? result[fieldNames[0]].length : 0);
            return result;
        }
    }

    // Try as group with sub-datasets
    if (typeof obj.keys === 'function') {
        var keys = obj.keys();
        console.log('[_readColumnar] Reading as group, keys:', keys);
        var data = {};
        var length = 0;
        for (var i = 0; i < fieldNames.length; i++) {
            var name = fieldNames[i];
            if (keys.indexOf(name) >= 0) {
                var subDs = obj.get(name);
                data[name] = subDs.value ? Array.from(subDs.value) : [];
                if (data[name].length > length) length = data[name].length;
            }
        }
        // Fill missing fields with zeros
        for (var j = 0; j < fieldNames.length; j++) {
            if (!data[fieldNames[j]]) {
                data[fieldNames[j]] = new Array(length).fill(0);
            }
        }
        if (length > 0) {
            console.log('[_readColumnar] Read as group, length:', length);
            return data;
        }
    }

    console.error('[_readColumnar] Failed to read data');
    return null;
}

/**
 * Parse a SLEAP .slp HDF5 file using a Web Worker.
 * The worker uses h5wasm with WORKERFS (zero-copy file mounting)
 * so the main thread stays responsive during parsing.
 *
 * @param {File} file - The .slp file
 * @param {Function} [onProgress] - Optional progress callback
 * @returns {Promise<Object>} Raw parsed data from worker
 */
function parseSlpH5(file, onProgress) {
    return new Promise(function (resolve, reject) {
        var worker = new Worker('slp-import-worker.js?v=' + Date.now());

        worker.onmessage = function (e) {
            var msg = e.data;
            if (msg.type === 'progress') {
                console.log('[slp-import]', msg.message);
                if (onProgress) onProgress(msg.message);
            } else if (msg.type === 'result') {
                worker.terminate();
                resolve(msg.data);
            } else if (msg.type === 'error') {
                worker.terminate();
                reject(new Error(msg.message));
            }
        };

        worker.onerror = function (err) {
            worker.terminate();
            reject(new Error('SLP worker error: ' + (err.message || 'unknown')));
        };

        worker.postMessage({ type: 'parse', file: file });
    });
}

// ============================================
// Points3d HDF5 import (in-browser)
// ============================================

/**
 * Parse a points3d.h5 HDF5 file and return 3D point data.
 *
 * @param {ArrayBuffer} arrayBuffer - File contents
 * @returns {Promise<Object>} { nodeNames, trackNames, frameIndices, points3d }
 *   points3d: Map<frameIdx, Map<trackIdx, number[][]>>
 */
async function parsePoints3dH5(arrayBuffer) {
    var mod = await initH5wasm();
    var fname = '_import_pts3d_' + Date.now() + '.h5';

    mod.FS.writeFile(fname, new Uint8Array(arrayBuffer));
    var f = new mod.File(fname, 'r');

    try {
        var nodeNamesDs = f.get('node_names');
        var trackNamesDs = f.get('track_names');
        var frameIndicesDs = f.get('frame_indices');
        var pts3dDs = f.get('points_3d');

        if (!pts3dDs) throw new Error('Missing /points_3d dataset');
        if (!frameIndicesDs) throw new Error('Missing /frame_indices dataset');

        var nodeNames = nodeNamesDs ? Array.from(nodeNamesDs.value) : [];
        var trackNames = trackNamesDs ? Array.from(trackNamesDs.value) : [];
        var frameIndices = Array.from(frameIndicesDs.value);

        var pts3dFlat = pts3dDs.value;
        var shape = pts3dDs.shape; // [n_frames, n_tracks, n_nodes, 3]

        var nFrames = shape[0];
        var nTracks = shape[1];
        var nNodes = shape[2];

        var points3d = new Map();

        for (var fi = 0; fi < nFrames; fi++) {
            var frameIdx = Number(frameIndices[fi]);
            var trackMap = new Map();
            var hasData = false;

            for (var ti = 0; ti < nTracks; ti++) {
                var nodePts = [];
                var trackHasData = false;

                for (var ni = 0; ni < nNodes; ni++) {
                    var base = ((fi * nTracks + ti) * nNodes + ni) * 3;
                    var x = pts3dFlat[base];
                    var y = pts3dFlat[base + 1];
                    var z = pts3dFlat[base + 2];

                    if (isNaN(x) || isNaN(y) || isNaN(z)) {
                        nodePts.push([NaN, NaN, NaN]);
                    } else {
                        nodePts.push([x, y, z]);
                        trackHasData = true;
                    }
                }

                if (trackHasData) {
                    trackMap.set(ti, nodePts);
                    hasData = true;
                }
            }

            if (hasData) {
                points3d.set(frameIdx, trackMap);
            }
        }

        f.close();
        try { mod.FS.unlink(fname); } catch(e) {}

        return {
            nodeNames: nodeNames,
            trackNames: trackNames,
            frameIndices: frameIndices,
            points3d: points3d,
        };
    } catch(err) {
        f.close();
        try { mod.FS.unlink(fname); } catch(e) {}
        throw err;
    }
}

/**
 * Approximate points-array comparison used during SLP load to detect
 * pass-1 / pass-2 duplicate Instance objects. The loader first creates
 * raw Instance objects from `slpData.frames[*].instances` (pass 1) and
 * later, when lucid session metadata is present, creates a second
 * Instance for each grouped entry. Before adding the metadata-driven
 * one to `fg.instances`, the caller uses this helper to find and drop
 * the pass-1 duplicate — otherwise the pass-1 instance keeps its
 * original `trackIdx` (raw SLP value) and ends up drawn in the old
 * track's color AND contributing a phantom track bar on the timeline.
 *
 * Two instances match if their points arrays have the same length and
 * the first non-null point pair agrees within 0.5 pixels. That's tight
 * enough to avoid collisions between different instances and loose
 * enough to tolerate round-trip float noise.
 *
 * @param {Array<number[]|null>} ptsA
 * @param {Array<number[]|null>} ptsB
 * @returns {boolean}
 */
function instancePointsMatch(ptsA, ptsB) {
    if (!ptsA || !ptsB) return false;
    if (ptsA.length !== ptsB.length) return false;
    // Compare every node position where both sides are non-null. Any
    // disagreement beyond the tolerance rules out a match. If at least
    // one node pair lines up (and no pair mismatches), the two arrays
    // are considered the same instance — this tolerates pass-1 /
    // pass-2 divergence on which nodes happen to be nulled.
    var haveMatch = false;
    for (var i = 0; i < ptsA.length; i++) {
        var a = ptsA[i], b = ptsB[i];
        if (a == null || b == null) continue;
        if (Math.abs(a[0] - b[0]) > 0.5 || Math.abs(a[1] - b[1]) > 0.5) return false;
        haveMatch = true;
    }
    return haveMatch;
}

if (typeof window !== 'undefined') {
    window.instancePointsMatch = instancePointsMatch;
}
