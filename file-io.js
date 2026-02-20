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
        const input = document.createElement('input');
        input.type = 'file';
        if (options.accept) input.accept = options.accept;
        if (options.multiple) input.multiple = true;

        input.addEventListener('change', function () {
            const files = input.files ? Array.from(input.files) : [];
            resolve(files);
        });

        // Handle cancel (no change event fires)
        input.addEventListener('cancel', function () {
            resolve([]);
        });

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

    if (file.name.endsWith('.toml')) {
        return parseCalibrationTOML(text);
    } else if (file.name.endsWith('.json')) {
        return parseCalibrationJSON(text);
    } else {
        throw new Error('Unsupported calibration format: ' + file.name);
    }
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
    const nodes = skeleton.nodes.map(function (name) {
        return { name: name };
    });

    const links = skeleton.edges.map(function (edge) {
        return {
            source: edge[0],
            target: edge[1],
            type: { 'py/tuple': [1] },
        };
    });

    const skeletons = [{
        links: links,
        name: skeleton.name,
        graph: { name: skeleton.name },
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
function buildSlpExportData(session, views) {
    const skelData = serializeSkeleton(session.skeleton);

    // Metadata
    const metadata = {
        version: '2.0.0',
        skeletons: skelData.skeletons,
        nodes: skelData.nodes,
        provenance: { source: 'mv-gui', exported_at: new Date().toISOString() },
    };

    // Videos
    const videos = views.map(function (v, i) {
        return {
            filename: v.name + '.mp4',
            backend: {
                type: 'MediaVideo',
                shape: [0, v.videoHeight || 0, v.videoWidth || 0, 1],
                filename: v.name + '.mp4',
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

        // For each camera that has instances in this frame
        for (const [camName, camInstances] of fg.instances) {
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
                        visible: pt != null,
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
    for (const [frameIdx, trackMap] of session.instanceGroups) {
        const instanceGroupsData = [];
        for (const [trackIdx, groups] of trackMap) {
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
    const trackNames = session.tracks.slice();
    const numNodes = nodeNames.length;
    const numTracks = trackNames.length;

    const frameIndices = [];
    const points3dFrames = [];
    const errorFrames = [];

    // Collect frames that have triangulated data, sorted
    const sortedFrameIndices = Array.from(session.instanceGroups.keys()).sort(function (a, b) { return a - b; });

    for (let fi = 0; fi < sortedFrameIndices.length; fi++) {
        const frameIdx = sortedFrameIndices[fi];
        const trackMap = session.instanceGroups.get(frameIdx);

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

        if (trackMap) {
            for (const [trackIdx, groups] of trackMap) {
                if (trackIdx >= numTracks) continue;
                for (const group of groups) {
                    if (group.points3d) {
                        hasData = true;
                        for (let n = 0; n < Math.min(numNodes, group.points3d.length); n++) {
                            framePts[trackIdx][n] = group.points3d[n];
                        }
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
    if (!_h5wasmReady) {
        _h5wasmReady = h5wasm.ready;
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

// ============================================
// SLP HDF5 export (in-browser)
// ============================================

/**
 * Build a SLEAP .slp HDF5 file as a Blob.
 * Ports json_to_slp.py logic to JavaScript using h5wasm.
 *
 * @param {Session} session
 * @param {Object[]} views - View objects with name, videoWidth, videoHeight
 * @returns {Promise<Blob>} The .slp file as a Blob
 */
async function buildSlpH5(session, views) {
    const mod = await initH5wasm();
    const fname = 'export_labels.slp';

    // Build the JSON intermediate data (reuse existing function)
    const data = buildSlpExportData(session, views);

    // Create an in-memory HDF5 file
    const f = new mod.File(fname, 'w');

    try {
        // /metadata group with attributes
        const metaGroup = f.create_group('metadata');
        metaGroup.create_attribute('format_id', data.format_id || 1.4, null, '<d');
        metaGroup.create_attribute('json', JSON.stringify(data.metadata));

        // JSON string datasets
        f.create_dataset({name: 'videos_json', data: [JSON.stringify(data.videos || [])]});
        f.create_dataset({name: 'tracks_json', data: [JSON.stringify(data.tracks || [])]});
        f.create_dataset({name: 'suggestions_json', data: [JSON.stringify(data.suggestions || [])]});
        f.create_dataset({name: 'sessions_json', data: [JSON.stringify(data.sessions || [])]});

        // /frames - split into separate datasets per field
        var frames = data.frames || [];
        if (frames.length > 0) {
            var framesGroup = f.create_group('frames');
            var fFrameId = new Float64Array(frames.length);
            var fVideo = new Float64Array(frames.length);
            var fFrameIdx = new Float64Array(frames.length);
            var fInstStart = new Float64Array(frames.length);
            var fInstEnd = new Float64Array(frames.length);
            for (var i = 0; i < frames.length; i++) {
                fFrameId[i] = frames[i].frame_id;
                fVideo[i] = frames[i].video;
                fFrameIdx[i] = frames[i].frame_idx;
                fInstStart[i] = frames[i].instance_id_start;
                fInstEnd[i] = frames[i].instance_id_end;
            }
            framesGroup.create_dataset({name: 'frame_id', data: fFrameId});
            framesGroup.create_dataset({name: 'video', data: fVideo});
            framesGroup.create_dataset({name: 'frame_idx', data: fFrameIdx});
            framesGroup.create_dataset({name: 'instance_id_start', data: fInstStart});
            framesGroup.create_dataset({name: 'instance_id_end', data: fInstEnd});
        }

        // /instances - split into separate datasets per field
        var instances = data.instances || [];
        if (instances.length > 0) {
            var instGroup = f.create_group('instances');
            var iId = new Float64Array(instances.length);
            var iType = new Float64Array(instances.length);
            var iFrameId = new Float64Array(instances.length);
            var iSkeleton = new Float64Array(instances.length);
            var iTrack = new Float64Array(instances.length);
            var iFromPred = new Float64Array(instances.length);
            var iScore = new Float64Array(instances.length);
            var iPtStart = new Float64Array(instances.length);
            var iPtEnd = new Float64Array(instances.length);
            var iTrackScore = new Float64Array(instances.length);
            for (var j = 0; j < instances.length; j++) {
                var inst = instances[j];
                iId[j] = inst.instance_id;
                iType[j] = inst.instance_type;
                iFrameId[j] = inst.frame_id;
                iSkeleton[j] = inst.skeleton;
                iTrack[j] = inst.track;
                iFromPred[j] = inst.from_predicted;
                iScore[j] = inst.score;
                iPtStart[j] = inst.point_id_start;
                iPtEnd[j] = inst.point_id_end;
                iTrackScore[j] = inst.tracking_score;
            }
            instGroup.create_dataset({name: 'instance_id', data: iId});
            instGroup.create_dataset({name: 'instance_type', data: iType});
            instGroup.create_dataset({name: 'frame_id', data: iFrameId});
            instGroup.create_dataset({name: 'skeleton', data: iSkeleton});
            instGroup.create_dataset({name: 'track', data: iTrack});
            instGroup.create_dataset({name: 'from_predicted', data: iFromPred});
            instGroup.create_dataset({name: 'score', data: iScore});
            instGroup.create_dataset({name: 'point_id_start', data: iPtStart});
            instGroup.create_dataset({name: 'point_id_end', data: iPtEnd});
            instGroup.create_dataset({name: 'tracking_score', data: iTrackScore});
        }

        // /points
        var points = data.points || [];
        if (points.length > 0) {
            var ptGroup = f.create_group('points');
            var ptX = new Float64Array(points.length);
            var ptY = new Float64Array(points.length);
            var ptVisible = new Uint8Array(points.length);
            var ptComplete = new Uint8Array(points.length);
            for (var pi = 0; pi < points.length; pi++) {
                ptX[pi] = isNaN(points[pi].x) ? NaN : points[pi].x;
                ptY[pi] = isNaN(points[pi].y) ? NaN : points[pi].y;
                ptVisible[pi] = points[pi].visible ? 1 : 0;
                ptComplete[pi] = points[pi].complete ? 1 : 0;
            }
            ptGroup.create_dataset({name: 'x', data: ptX});
            ptGroup.create_dataset({name: 'y', data: ptY});
            ptGroup.create_dataset({name: 'visible', data: ptVisible});
            ptGroup.create_dataset({name: 'complete', data: ptComplete});
        }

        // /pred_points
        var predPoints = data.pred_points || [];
        if (predPoints.length > 0) {
            var ppGroup = f.create_group('pred_points');
            var ppX = new Float64Array(predPoints.length);
            var ppY = new Float64Array(predPoints.length);
            var ppVisible = new Uint8Array(predPoints.length);
            var ppComplete = new Uint8Array(predPoints.length);
            var ppScore = new Float64Array(predPoints.length);
            for (var ppi = 0; ppi < predPoints.length; ppi++) {
                ppX[ppi] = isNaN(predPoints[ppi].x) ? NaN : predPoints[ppi].x;
                ppY[ppi] = isNaN(predPoints[ppi].y) ? NaN : predPoints[ppi].y;
                ppVisible[ppi] = predPoints[ppi].visible ? 1 : 0;
                ppComplete[ppi] = predPoints[ppi].complete ? 1 : 0;
                ppScore[ppi] = predPoints[ppi].score || 0;
            }
            ppGroup.create_dataset({name: 'x', data: ppX});
            ppGroup.create_dataset({name: 'y', data: ppY});
            ppGroup.create_dataset({name: 'visible', data: ppVisible});
            ppGroup.create_dataset({name: 'complete', data: ppComplete});
            ppGroup.create_dataset({name: 'score', data: ppScore});
        }

        f.close();
        return h5FileToBlob(fname);
    } catch (err) {
        f.close();
        throw err;
    }
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
    const trackNames = session.tracks;
    const nCameras = cameras.length;
    const nNodes = nodeNames.length;
    const nTracks = trackNames.length;
    const cameraNames = cameras.map(function (c) { return c.name; });

    // Collect frames sorted
    const sortedFrameIndices = Array.from(session.instanceGroups.keys()).sort(function (a, b) { return a - b; });
    const nFrames = sortedFrameIndices.length;

    // Build 5D flat array: (n_frames, n_tracks, n_cameras, n_nodes, 2)
    const reproj = new Float64Array(nFrames * nTracks * nCameras * nNodes * 2);
    reproj.fill(NaN);

    for (var fi = 0; fi < nFrames; fi++) {
        var frameIdx = sortedFrameIndices[fi];
        var trackMap = session.instanceGroups.get(frameIdx);
        if (!trackMap) continue;

        for (var [trackIdx, groups] of trackMap) {
            if (trackIdx >= nTracks) continue;
            for (var group of groups) {
                if (!group.reprojections) continue;
                for (var ci = 0; ci < nCameras; ci++) {
                    var camName = cameraNames[ci];
                    var reprojPts = group.reprojections[camName];
                    if (!reprojPts) continue;
                    for (var ni = 0; ni < Math.min(nNodes, reprojPts.length); ni++) {
                        var rpt = reprojPts[ni];
                        if (rpt) {
                            var rbase = (((fi * nTracks + trackIdx) * nCameras + ci) * nNodes + ni) * 2;
                            reproj[rbase] = rpt[0];
                            reproj[rbase + 1] = rpt[1];
                        }
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
