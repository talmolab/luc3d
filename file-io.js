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
            instanceGroupsData.push({
                camcorder_to_lf_and_inst_idx_map: camToLfAndInst,
                score: 1.0,
                points: group.points3d || [],
            });
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

    return {
        format_id: 1.4,
        metadata: metadata,
        videos: videos,
        tracks: tracks,
        suggestions: [],
        sessions: sessions,
        frames: frames,
        instances: instances,
        points: points,
        pred_points: predPoints,
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
                        reprojInst._groupIdentityId = groups[gi].identityId;
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
            var pts = _buildSioPoints(inst, numNodes);
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
                    score: inst.score || 0,
                }));
            }
        }

        // 2. Ungrouped UserInstances next (no track assigned)
        for (var ugi = 0; ugi < ungroupedInstances.length; ugi++) {
            var ugInst = ungroupedInstances[ugi];
            var ugPts = _buildSioPoints(ugInst, numNodes);

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
                    score: ugInst.score || 0,
                }));
            }
        }

        // 3/4. Reprojections — same track as their associated group
        if (reprojAsUser !== null) {
            for (var ri = 0; ri < reprojInstances.length; ri++) {
                var rInst = reprojInstances[ri];
                var rPts = _buildSioPoints(rInst, numNodes);
                var rIdentityId = rInst._groupIdentityId;
                var rTrack = (rIdentityId >= 0 && rIdentityId < tracks.length) ? tracks[rIdentityId] : null;

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
                        score: rInst.score || 1.0,
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

    // 5. Create Labels
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
function _buildSioPoints(inst, numNodes) {
    var pts = [];
    var nulledNodes = inst.nulledNodes || null;
    for (var n = 0; n < numNodes; n++) {
        var pt = inst.points[n];
        var isNulled = nulledNodes && nulledNodes.has(n);
        if (pt == null || isNulled) {
            pts.push({ xy: [NaN, NaN], visible: false, complete: false });
        } else {
            var occ = inst.occluded && inst.occluded[n];
            pts.push({ xy: [pt[0], pt[1]], visible: !occ, complete: true });
        }
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
    return new Blob([bytes], { type: 'application/x-hdf5' });
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

    // 3. Build videos — one per camera
    var camToVideoIdx = {};
    var sioVideos = [];
    session.cameras.forEach(function (cam, i) {
        camToVideoIdx[cam.name] = i;
        var videoPath = cam.name + '.mp4';
        var vw = 0, vh = 0, fc = 0;
        // Find matching view and videoFile info
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
                grayscale: false,
                bgr: false,
            },
            openBackend: false,
        });
        video.shape = [fc, vh, vw, 1];
        sioVideos.push(video);
    });

    // 4. Build labeled frames — one per camera per frame group
    var labeledFrames = [];
    var numNodes = session.skeleton.nodes.length;
    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

    for (var fi = 0; fi < allFrameIndices.length; fi++) {
        var frameIdx = allFrameIndices[fi];
        var fg = session.frameGroups.get(frameIdx);

        // Build combined per-camera instance list (grouped + ungrouped)
        var combinedInstances = new Map();
        for (var [camName, camInsts] of fg.instances) {
            combinedInstances.set(camName, camInsts.slice());
        }
        for (var [camName2, ulList] of fg.unlinkedInstances) {
            if (!combinedInstances.has(camName2)) combinedInstances.set(camName2, []);
            var arr = combinedInstances.get(camName2);
            for (var u = 0; u < ulList.length; u++) arr.push(ulList[u].instance);
        }

        for (var [camName3, camInstances] of combinedInstances) {
            var videoIdx = camToVideoIdx[camName3] !== undefined ? camToVideoIdx[camName3] : 0;
            var video = sioVideos[videoIdx];
            if (!video) continue;

            var frameInstances = [];
            for (var ii = 0; ii < camInstances.length; ii++) {
                var inst = camInstances[ii];
                var isUser = (inst.type === 'user');
                var pts = _buildSioPoints(inst, numNodes);
                var track = (inst.trackIdx >= 0 && inst.trackIdx < tracks.length) ? tracks[inst.trackIdx] : null;

                if (isUser) {
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
                        score: inst.score || 0,
                    }));
                }
            }

            if (frameInstances.length > 0) {
                labeledFrames.push(new SIO.LabeledFrame({
                    video: video,
                    frameIdx: frameIdx,
                    instances: frameInstances,
                }));
            }
        }
    }

    return new SIO.Labels({
        labeledFrames: labeledFrames,
        videos: sioVideos,
        skeletons: [skeleton],
        tracks: tracks,
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
