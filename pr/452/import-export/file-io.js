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
 */

import { Camera, Skeleton, Instance, Identity,
         toBoxedPoints3d, hasPoint3d, points3dNodeCount } from '../pose/pose-data.js?v=ecdf4c85283a';
import { validateSkeletonCompatibility } from './slp-merge.js?v=ecdf4c85283a';
import { getOrComputeReprojectedInstance, sweepLazyFrameWindows, reprojectPointsCamera } from '../pose/triangulation.js?v=ecdf4c85283a';
import { createProgressPacer } from '../ui/loading-overlay.js?v=ecdf4c85283a';
// Only pulls in the two dependency-free `ui/` leaf modules — safe for this
// module's graph.
import { writeVisibilityMetadata } from './visibility-metadata.js?v=ecdf4c85283a';
import { writeFrameIdentityMetadata } from './frame-identity-metadata.js?v=ecdf4c85283a';
import { writePlaneMetadata } from './plane-metadata.js?v=ecdf4c85283a';
import { writeSmoothingMetadata, smoothingSourceFor } from './smoothing-metadata.js?v=ecdf4c85283a';

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
export function pickFiles(options) {
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
export function pickFolder() {
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
export function parseCalibrationTOML(text) {
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
export function parseCalibrationJSON(text) {
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
export async function loadCalibrationFile() {
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
    return { cameras: cameras, fileName: file.name, file: file };
}

/**
 * Open a file picker for video files (.mp4, .avi, .webm).
 *
 * @returns {Promise<File[]>} Array of video files (empty if cancelled)
 */
export async function pickVideoFiles() {
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
export function matchVideosToCameras(files, cameras) {
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
export function buildVideoGrid(gridElement, cameraNames) {
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
export function exportCalibrationTOML(cameras) {
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
export function serializeSkeleton(skeleton) {
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
export function buildSlpExportData(session, views, videoFiles) {
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
                    const hasPt = inst.hasPoint(n);
                    const entry = {
                        x: hasPt ? inst.getX(n) : NaN,
                        y: hasPt ? inst.getY(n) : NaN,
                        visible: hasPt && !inst.isOccluded(n),
                        complete: hasPt,
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
                igData.points = toBoxedPoints3d(group.points3d);
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
 * Can be converted to HDF5 via a Python script. Same frames, track axis
 * (`reprojTrackAxis`) and values as `buildPoints3dH5`, but boxed per node: for
 * tests and small sessions, not for a long recording.
 *
 * @param {Session} session
 * @returns {Object} { points_3d, frame_indices, track_names, node_names, reprojection_errors }
 */
export function buildPoints3dExportData(session) {
    const nodeNames = session.skeleton.nodes.slice();
    const axis = reprojTrackAxis(session);
    const numNodes = nodeNames.length;
    const numTracks = axis.names.length;
    const frameIndices = points3dExportFrames(session, axis);
    const points3dFrames = [];
    const errorFrames = [];
    const buf = new Float64Array(numTracks * numNodes * 3);

    for (let fi = 0; fi < frameIndices.length; fi++) {
        buf.fill(NaN);
        fillPoints3dFrame(buf, 0, session.instanceGroups.get(frameIndices[fi]), axis.index, numTracks, numNodes);
        const framePts = new Array(numTracks);
        const frameErr = new Array(numTracks);
        for (let t = 0; t < numTracks; t++) {
            framePts[t] = new Array(numNodes);
            frameErr[t] = new Array(numNodes);
            for (let n = 0; n < numNodes; n++) {
                const o = (t * numNodes + n) * 3;
                framePts[t][n] = [buf[o], buf[o + 1], buf[o + 2]];
                frameErr[t][n] = NaN;
            }
        }
        points3dFrames.push(framePts);
        errorFrames.push(frameErr);
    }

    return {
        points_3d: points3dFrames,
        frame_indices: frameIndices,
        track_names: axis.names,
        node_names: nodeNames,
        reprojection_errors: errorFrames,
    };
}

/** A group's row on the track axis (`reprojTrackAxis`), or -1 if it has none. */
function trackAxisRow(group, idIndex, nTracks) {
    var t = idIndex ? idIndex.get(group.identityId) : group.identityId;
    return (t == null || t < 0 || t >= nTracks) ? -1 : t;
}

/**
 * The frames the 3D export writes, sorted: those with a group that has 3D and
 * a row on the track axis.
 */
function points3dExportFrames(session, axis) {
    const nTracks = axis.names.length;
    const out = [];
    for (const [frameIdx, groups] of session.instanceGroups) {
        if (!groups) continue;
        for (const group of groups) {
            if (group.points3d && trackAxisRow(group, axis.index, nTracks) >= 0) { out.push(frameIdx); break; }
        }
    }
    return out.sort(function (a, b) { return a - b; });
}

/** One frame's 3D into `buf` at `base` (layout: track, node, xyz); missing nodes stay as they are (NaN). */
function fillPoints3dFrame(buf, base, groups, idIndex, nTracks, nNodes) {
    if (!groups) return;
    for (const group of groups) {
        const t = trackAxisRow(group, idIndex, nTracks);
        if (t < 0 || !group.points3d) continue;
        const pts = group.points3d;
        const n = Math.min(nNodes, points3dNodeCount(pts));
        const tbase = base + t * nNodes * 3;
        for (let k = 0; k < n; k++) {
            // A partly-NaN triple is a missing node (`hasPoint3d`).
            if (!hasPoint3d(pts, k)) continue;
            buf[tbase + k * 3] = pts[k * 3];
            buf[tbase + k * 3 + 1] = pts[k * 3 + 1];
            buf[tbase + k * 3 + 2] = pts[k * 3 + 2];
        }
    }
}

/**
 * Download data as a JSON file.
 * @param {Object} data - Data to serialize
 * @param {string} filename - Download filename
 */
export function downloadJSON(data, filename) {
    const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = filename;
    a.click();
    URL.revokeObjectURL(url);
}

/**
 * Download raw bytes as a file.
 *
 * The binary sibling of `downloadJSON` / `downloadTOML`, for formats that are
 * not text at all (binary STL, .glb). `bytes.buffer` is deliberately NOT
 * handed to the Blob: a typed array can be a VIEW onto a larger buffer, and
 * passing the whole buffer would silently write the neighbouring bytes too.
 *
 * @param {Uint8Array|ArrayBuffer} bytes
 * @param {string} filename
 * @param {string} [mime] - defaults to a generic binary stream
 */
export function downloadBytes(bytes, filename, mime) {
    const blob = new Blob([bytes], { type: mime || 'application/octet-stream' });
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
 * @param {string} filename - Target filename
 */
export function downloadTOML(tomlContent, filename) {
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
export function h5FileToBlob(filename) {
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
/**
 * The video one camera's exported file points at: filename and
 * [frames, height, width]. Taken from the attached video (`videoFileInfo`) when
 * there is one; a field it lacks comes from the video record of the project
 * file the session was reopened from (`session.lazyLoader.videos`), as the
 * project save does (`resolveVideoPath`, slp-streaming-write.js). Without that
 * fallback a reopened project exported before File ▸ Load Videos wrote
 * `<camera>.mp4` with 0 frames, and SLEAP's GUI fails to open a file whose
 * video it cannot find and has 0 frames (ZeroDivisionError in its status bar).
 *
 * @returns {{ filename: string, frames: number, height: number, width: number }}
 */
export function cameraExportVideo(session, cameraName, videoFileInfo) {
    var vfi = videoFileInfo || {};
    var loader = session && session.lazyLoader;
    var rec = (loader && loader.videos && typeof loader.videos.get === 'function')
        ? loader.videos.get(cameraName) : null;
    var shape = (rec && rec.shape && rec.shape.length >= 3) ? rec.shape : null;
    return {
        filename: vfi.videoPath || (vfi.file && vfi.file.name)
            || (rec && rec.filename) || (cameraName + '.mp4'),
        frames: vfi.frameCount || (shape && Number(shape[0])) || 0,
        height: vfi.videoHeight || (shape && Number(shape[1])) || 0,
        width: vfi.videoWidth || (shape && Number(shape[2])) || 0,
    };
}

export function buildPerCameraSlpJson(session, cameraName, reprojAsUser, videoFileInfo) {
    // Skeleton metadata
    var skelData = serializeSkeleton(session.skeleton);
    var metadata = {
        version: '2.0.0',
        skeletons: skelData.skeletons,
        nodes: skelData.nodes,
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    };

    // Single video entry for this camera
    var cv = cameraExportVideo(session, cameraName, videoFileInfo);
    var vw = cv.width;
    var vh = cv.height;
    var videoFilename = cv.filename;
    var videos = [{
        filename: videoFilename,
        backend: {
            type: 'MediaVideo',
            shape: [cv.frames, vh, vw, 1],
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
                shape: [cv.frames, vh, vw, 1],
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
                var reprojInst = getOrComputeReprojectedInstance(groups[gi], cameraName);
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
                var hasPt = inst.hasPoint(n);
                var entry = {
                    x: hasPt ? inst.getX(n) : null,
                    y: hasPt ? inst.getY(n) : null,
                    visible: hasPt && !inst.isOccluded(n),
                    complete: hasPt,
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
                var hasRpt = rInst.hasPoint(rn);
                var rEntry = {
                    x: hasRpt ? rInst.getX(rn) : null,
                    y: hasRpt ? rInst.getY(rn) : null,
                    visible: hasRpt,
                    complete: hasRpt,
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
/**
 * Which track each instance of `session` is exported on. With identities assigned
 * the file's tracks ARE the identities (`Session.identityTrackPlan`, the same
 * tracks "Propagate IDs → Tracks" makes), because an export has nowhere else to
 * keep them: without this a proofread identity is lost and `track_0` means a
 * different animal in each camera. The session is not changed. An instance with no
 * identity is trackless, as that command makes it. With no identities assigned,
 * each instance keeps its own track.
 *
 * Identity is resolved in the canvas's order (`getGroupColor`): the per-frame
 * entry for the instance's own track, then its group, then a trackless unlinked
 * instance's retained identity.
 *
 * @returns {{names: string[], fromIdentity: boolean,
 *            resolve: function(Object, string, number): (number|null)}}
 */
function _exportTrackSource(session) {
    var plan = typeof session.identityTrackPlan === 'function'
        ? session.identityTrackPlan() : { names: [], idToTrackIdx: new Map() };   // no identity model, no identities
    if (plan.names.length === 0) {
        var names = session.tracks;
        return {
            names: names, fromIdentity: false,
            // inst.trackIdx can be null (trackless UserInstance imported from a
            // 2D SLP with track=null). `null >= 0` is true in JS so we need the
            // explicit != null guard before the range check.
            resolve: function (inst) {
                return (inst.trackIdx != null && inst.trackIdx >= 0 && inst.trackIdx < names.length)
                    ? inst.trackIdx : null;
            },
        };
    }
    return {
        names: plan.names, fromIdentity: true,
        resolve: function (inst, camName, frameIdx) {
            var id = inst.trackIdx != null ? session.getIdentityIdForTrack(camName, inst.trackIdx, frameIdx) : null;
            if (id == null) {
                var groups = session.instanceGroups.get(frameIdx) || [];
                for (var g = 0; g < groups.length; g++) {
                    var member = groups[g].instances.get(camName);
                    // A lazy group's member is a separate object until its frame
                    // is hydrated, so also match by store row.
                    if (member && (member === inst || (inst._rawInstIndex != null && member._rawInstIndex === inst._rawInstIndex))) {
                        if (groups[g].identityId != null && groups[g].identityId >= 0) id = groups[g].identityId;
                        break;
                    }
                }
            }
            if (id == null && inst.trackIdx == null && inst.identityId != null && inst.identityId >= 0) id = inst.identityId;
            var ti = id != null ? plan.idToTrackIdx.get(id) : undefined;
            return ti != null ? ti : null;
        },
    };
}

/**
 * Build ONE camera's `SIO.LabeledFrame` for one frame — the per-frame half of
 * `buildSlpLabels`, extracted so the EAGER exporter (whole project resident, a
 * from-scratch session) and the STREAMING exporter (windowed, a lazily reopened
 * session) emit byte-identical frames from identical logic.
 *
 * Sharing this is the point, not a tidy-up: a from-scratch project exported fine
 * only because every frame was resident, so the eager builder saw the whole
 * project. Reimplementing the frame body for the lazy path would let the two
 * drift, which is how "export works on a new project but not a loaded one" got
 * here in the first place.
 *
 * @param {Object} env { skeleton, tracks, trackSource, video, numNodes, instanceFilter, reprojAsUser }
 * @returns {Object|null} the LabeledFrame, or null when this camera has nothing
 *   on this frame (the caller skips it, exactly as the eager loop's `continue` did).
 */
function _buildCameraLabeledFrame(session, cameraName, frameIdx, fg, env) {
    var SIO = window.SleapIO;
    var skeleton = env.skeleton, tracks = env.tracks, video = env.video;
    var trackSource = env.trackSource;
    var numNodes = env.numNodes, instanceFilter = env.instanceFilter;
    var reprojAsUser = env.reprojAsUser;
    if (!fg) return null;

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
                var reprojInst = getOrComputeReprojectedInstance(groups[gi], cameraName);
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

    if (groupedInstances.length === 0 && ungroupedInstances.length === 0 && reprojInstances.length === 0) return null;

    var frameInstances = [];
    // Tracks already placed in THIS frame, so an ungrouped instance never
    // duplicates a track a grouped instance holds (SLEAP forbids two
    // instances sharing a (frame, track) pair).
    var usedTrackIdx = {};
    // Each node's OWN score (CLAUDE.md "Per-node prediction scores"): a lazy
    // instance holds none, the store is the only copy, so ask the session, as
    // the project save does. Asking only the instance wrote the instance score
    // onto every node of every lazily loaded prediction.
    var nodeScoreOf = function (sinst) {
        // Resolved once per instance (its store row, on a lazy project), not
        // per node: same values as `predictedNodeScore`.
        if (typeof session.predictedNodeScorer === 'function') return session.predictedNodeScorer(cameraName, frameIdx, sinst);
        return function (k) { return session.predictedNodeScore(cameraName, frameIdx, sinst, k); };
    };

    // 1. Grouped UserInstances first (retain their track)
    for (var ii = 0; ii < groupedInstances.length; ii++) {
        var inst = groupedInstances[ii];
        var instIsPred = inst.type === 'predicted';
        var instScore = inst.score != null ? inst.score : 1.0;
        var pts = _buildSioPoints(inst, numNodes, instIsPred ? instScore : undefined, null, nodeScoreOf(inst));
        var trackIdx = trackSource.resolve(inst, cameraName, frameIdx);
        // Identities can collide in one view (SLEAP forbids two instances on a
        // track in a frame): the first keeps it.
        if (trackSource.fromIdentity && trackIdx != null && usedTrackIdx[trackIdx]) trackIdx = null;
        var track = trackIdx != null ? tracks[trackIdx] : null;
        if (track) usedTrackIdx[trackIdx] = true;

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

    // 2. Ungrouped (unlinked) instances next — keep their OWN track so a
    //    flat 2D project's tracks survive export. Skip a track already held
    //    by a grouped instance this frame (SLEAP forbids two instances on
    //    the same (frame, track)).
    for (var ugi = 0; ugi < ungroupedInstances.length; ugi++) {
        var ugInst = ungroupedInstances[ugi];
        var ugIsPred = ugInst.type === 'predicted';
        var ugScore = ugInst.score != null ? ugInst.score : 1.0;
        var ugPts = _buildSioPoints(ugInst, numNodes, ugIsPred ? ugScore : undefined, null, nodeScoreOf(ugInst));
        var ugTrackIdx = trackSource.resolve(ugInst, cameraName, frameIdx);
        var ugTrack = (ugTrackIdx != null && !usedTrackIdx[ugTrackIdx]) ? tracks[ugTrackIdx] : null;
        if (ugTrack) usedTrackIdx[ugTrackIdx] = true;

        if (ugInst.type === 'user') {
            frameInstances.push(new SIO.Instance({
                points: ugPts,
                skeleton: skeleton,
                track: ugTrack,
            }));
        } else {
            frameInstances.push(new SIO.PredictedInstance({
                points: ugPts,
                skeleton: skeleton,
                track: ugTrack,
                score: ugScore,
            }));
        }
    }

    // 3/4. Reprojections — track is ALWAYS null regardless of output type.
    //   - As UserInstance: SLEAP data model forbids two UserInstances on
    //     the same (view, track) pair, and step 1 above already put the
    //     grouped user instance on the group's track in this view.
    //   - As PredictedInstance: sharing the group's track causes two
    //     problems on LUCID re-import — the flat 2D SLP has no 3D points
    //     so reprojections can't be reconstructed as such, and the
    //     "group by trackIdx" import fallback buckets the prediction with
    //     the user instance (same cam, same track), where Map-keyed-by-
    //     camera-name means one overwrites the other.
    //   Dropping the track on both sides loses per-track color in SLEAP
    //   GUI but keeps the data safe for round-tripping.
    if (reprojAsUser !== null) {
        for (var ri = 0; ri < reprojInstances.length; ri++) {
            var rInst = reprojInstances[ri];
            var rScore = rInst.score != null ? rInst.score : 1.0;
            var rPts = _buildSioPoints(rInst, numNodes, reprojAsUser ? undefined : rScore);

            if (reprojAsUser) {
                frameInstances.push(new SIO.Instance({
                    points: rPts,
                    skeleton: skeleton,
                    track: null,
                }));
            } else {
                frameInstances.push(new SIO.PredictedInstance({
                    points: rPts,
                    skeleton: skeleton,
                    track: null,
                    score: rScore,
                }));
            }
        }
    }

    return new SIO.LabeledFrame({
        video: video,
        frameIdx: frameIdx,
        instances: frameInstances,
    });
}

export function buildSlpLabels(session, cameraName, reprojAsUser, videoFileInfo, instanceFilter) {
    var SIO = window.SleapIO;
    if (!SIO) throw new Error('sleap-io.js not loaded');
    // A lazy session before "Load Videos" (or a calibration-only camera) has
    // no attached video file — null/undefined is a real, reachable case, not
    // just a test artifact (mirrors slp-streaming-write.js's resolveVideoPath
    // fallback for the same scenario). Normalize so the property reads below
    // degrade to the cameraName + '.mp4' / zero-dimension fallback instead of
    // throwing.
    videoFileInfo = videoFileInfo || {};

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
    var trackSource = _exportTrackSource(session);
    var tracks = trackSource.names.map(function (name) { return new SIO.Track(name); });

    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });

    // 3. Build video
    var cv = cameraExportVideo(session, cameraName, videoFileInfo);
    var videoFilename = cv.filename;
    var vw = cv.width;
    var vh = cv.height;
    var fc = cv.frames;
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

        var _lf = _buildCameraLabeledFrame(session, cameraName, frameIdx, fg, {
            skeleton: skeleton, tracks: tracks, trackSource: trackSource, video: video, numNodes: numNodes,
            instanceFilter: instanceFilter, reprojAsUser: reprojAsUser,
        });
        if (_lf) labeledFrames.push(_lf);
    }

    // 5. Create Labels. Do NOT pass identities — the sleap-io.js
    // serializer bumps format_id to 1.9 when labels.identities is
    // non-empty, and sleap-io Python <=0.6.x cannot read format 1.9.
    // The identities travel as the tracks (`_exportTrackSource`); only their
    // color is lost (Export is a flat per-camera dump, not a lucid-project
    // round-trip).
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
 * @param {number} [perPointScore]
 * @param {Array<number|null>} [nodeOrder]
 * @param {(k: number) => number} [nodeScore] - the model's score for this
 *   instance's node `k`, NaN when it has none. Defaults to the instance's own
 *   (`Instance.pointScore`); the lazy writer passes one that reads the store.
 * @returns {Array} Point array
 */
export function _buildSioPoints(inst, numNodes, perPointScore, nodeOrder, nodeScore) {
    // nodeOrder: optional. When set, nodeOrder[canonicalIdx] = this instance's
    // local point index, so points stored in a session's own skeleton node
    // order are emitted in the canonical (first-session) order. Used by
    // buildSlpLabelsMultiSession when sessions share a skeleton whose nodes
    // are ordered differently per session (common in real SLEAP files).
    // perPointScore: optional. When set, each Point carries `score` so
    // sleap-io.js writes a non-zero `pred_points.score` for predicted
    // instances. SLEAP GUI hides predicted points below a small score
    // threshold — a lucid reprojection exported as a PredictedInstance
    // without a per-point score would render as `score=0.0` in the SLP
    // file and disappear in the GUI even though the xy is valid.
    // sleap-io.js ignores the `score` field when serializing a plain
    // Instance (non-predicted), so attaching it unconditionally is safe.
    // A node the model scored keeps ITS score (`nodeScore`) — writing the
    // instance score onto every node threw away the per-node confidence a
    // SLEAP prediction carries, so a reopened project showed one number for
    // every node of an instance. `perPointScore` is the fallback for a node
    // with no score of its own (a reprojection, a prediction built in LUCID).
    if (!nodeScore && typeof inst.pointScore === 'function') {
        nodeScore = function (k) { return inst.pointScore(k); };
    }
    var pts = [];
    var nulledNodes = inst.nulledNodes || null;
    for (var n = 0; n < numNodes; n++) {
        var src = nodeOrder ? nodeOrder[n] : n;   // canonical → local point index
        var hasPt = (src != null) && inst.hasPoint(src);
        var isNulled = nulledNodes && src != null && nulledNodes.has(src);
        var entry;
        if (!hasPt) {
            // Genuinely missing point → NaN / invisible.
            entry = { xy: [NaN, NaN], visible: false, complete: false };
        } else if (isNulled) {
            // Occluded-but-positioned (nulledNodes): KEEP the real position and
            // mark it invisible/occluded. The nulledNodes flag round-trips
            // separately via instance metadata (buildSlpLabelsAllViews /
            // slp-streaming-write.js), so on reload the node comes back BOTH
            // positioned and flagged occluded. Writing NaN here (the old
            // behavior) discarded the position, so an occluded node reloaded as
            // null and vanished from the skeleton (SLP round-trip occlusion loss).
            entry = { xy: [inst.getX(src), inst.getY(src)], visible: false, complete: true };
        } else {
            var occ = inst.isOccluded(src);
            entry = { xy: [inst.getX(src), inst.getY(src)], visible: !occ, complete: true };
        }
        if (perPointScore != null) {
            var own = (nodeScore && src != null) ? nodeScore(src) : NaN;
            entry.score = Number.isFinite(own) ? own : perPointScore;
        }
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
/**
 * If `session` is a lazy session with a materialized store for `cameraName`,
 * re-emit that camera's predictions via `saveSlpToBytes`'s lazy fast-path
 * (`writeSlpToFileLazy` — all frames, memory-bounded, zero per-frame objects).
 * Returns the `Uint8Array`, or `null` when not applicable. The per-camera SLP
 * exporters use this to avoid the eager `buildSlpLabels`/`buildSlpLabelsMultiSession`
 * path, which iterates only the resident `frameGroups` (silent-drop on a lazy
 * session) and would re-materialize the whole store.
 */
async function lazyCameraExportBytes(SIO, session, cameraName) {
    if (!lazyCameraFastPathUsable(SIO, session, cameraName)) return null;
    return await SIO.saveSlpToBytes(session.lazyLoader.labelsByCam.get(cameraName));
}

/** Whether `lazyCameraExportBytes` can re-emit this camera's store (see its guards). */
function lazyCameraFastPathUsable(SIO, session, cameraName) {
    var loader = session && session.lazyLoader;
    if (!loader || !loader.labelsByCam || typeof loader.labelsByCam.get !== 'function') return false;
    // A reopened project `.slp` keeps every camera in ONE store, and every
    // `labelsByCam` entry is that whole project (`SioLazyLoader._sharedStore`):
    // re-emitting it wrote ALL cameras (and the 3D session) into each camera's
    // file — and on a large project ran the renderer out of memory first.
    if (loader._sharedStore) return false;
    // With identities assigned, the store is only right if it already holds them.
    if (!_storeHoldsIdentityTracks(session)) return false;
    // Safety guard: this path re-emits the RAW columnar store verbatim — it
    // has no notion of a live, manually-corrected Instance object sitting in
    // a resident FrameGroup. If any resident frame carries a user-type
    // instance, that correction lives only in session.frameGroups and is
    // NOT yet reflected in the lazy store, so taking this fast path would
    // silently export the ORIGINAL uncorrected prediction for that frame
    // instead — a worse bug than the one this fast path exists to fix.
    // Mirrors the identical `frameGroupHasUserInstances` check in
    // pose/tracker.js / ui/export-modals.js (copied, not imported — this
    // file is deliberately import-free vanilla JS besides pose-data.js/
    // slp-merge.js).
    for (var fg of session.frameGroups.values()) {
        if (frameGroupHasUserInstances(fg)) return false;
    }
    var lazyLabels = loader.labelsByCam.get(cameraName);
    return !!(lazyLabels && lazyLabels.isLazy && SIO && typeof SIO.saveSlpToBytes === 'function');
}

/**
 * True when re-emitting the columnar store writes the tracks `_exportTrackSource`
 * would: no identities are assigned, or "Propagate IDs → Tracks" already rewrote
 * the store AND no identity switch has happened since (a switch changes
 * `frameIdentityMap` only, so an entry then disagrees with its track).
 */
function _storeHoldsIdentityTracks(session) {
    if (typeof session.identityTrackPlan !== 'function') return true;   // no identity model, no identities
    var plan = session.identityTrackPlan();
    if (plan.names.length === 0) return true;
    if (plan.names.length !== session.tracks.length) return false;
    for (var i = 0; i < plan.names.length; i++) {
        if (plan.names[i] !== session.tracks[i]) return false;
    }
    for (var rec of session.frameIdentityEntries()) {
        if (rec.identityId == null || rec.identityId < 0) continue;
        if (plan.idToTrackIdx.get(rec.identityId) !== rec.trackIdx) return false;
    }
    return true;
}

/**
 * Whether By Cam's camera `selection` (one session, one camera) would be
 * written by `lazyCameraExportBytes` (the camera's own store rewritten), the
 * route `exportSlpMultiSession` takes first, so the caller can hand every such
 * camera to `exportCamerasLazyRewrite` at once.
 */
export function cameraExportUsesLazyRewrite(selection, reprojAsUser, instanceFilter) {
    return !!(selection && !reprojAsUser && instanceFilterAllowsLazyFastPath(instanceFilter) &&
        lazyCameraFastPathUsable(window.SleapIO, selection.session, selection.cameraName));
}

/**
 * Whether By Cam's camera `selection` (one session, one camera) would be built
 * by `exportSlpMultiSession`'s eager route (`buildSlpLabelsMultiSession` +
 * `saveSlpToBytes`): a fully loaded camera — neither the store rewrite nor the
 * streaming sweep. Such cameras can go to `exportCamerasInWorkers` together.
 */
export function cameraExportUsesEagerBuild(selection, reprojAsUser, instanceFilter) {
    return !!(selection && selection.session && window.SleapIO &&
        !cameraExportUsesLazyRewrite(selection, reprojAsUser, instanceFilter) &&
        !_exportWouldTruncate(selection.session));
}

/**
 * Cameras of the per-camera rewrite in workers at once (each holds its tables until written).
 * 3, not 4: on the lab VM (8 cameras x 108,000 frames) 4 peaked Chrome at 8.1-9.4 GB for 7.9-8.5 s,
 * 3 at 7.5-7.8 GB for 10.4-10.6 s (one thread: 6.5 GB, 24.5 s).
 */
var LAZY_REWRITE_IN_FLIGHT = 3;

/**
 * By Cam's one-camera files for several cameras, the compression in workers.
 * Two kinds of camera go here, each written as `exportSlpMultiSession` would:
 *  - a folder-loaded camera (`cameraExportUsesLazyRewrite`), its own store
 *    rewritten: the file is written here without its big tables
 *    (`saveSlpToBytes`'s `lucidDeferTables`, bundle patch `(deferred tables)`),
 *    and its worker creates them with the same arguments;
 *  - a fully loaded camera (`cameraExportUsesEagerBuild`): its `Labels` are
 *    built here and written with the big 2D tables' rows held back
 *    (`lucidDivertTables`, bundle patch `(eager divert)`: the tables are created
 *    empty, same chunks and filters), and its worker appends the rows.
 * Each camera's worker (`import-export/slp-rows-worker.js`) gzips while the next
 * camera is built — at most LAZY_REWRITE_IN_FLIGHT at once. Same tables,
 * values, chunks, filters, dtypes and field_names as the one-thread file.
 *
 * @param {Array<{session, cameraName, videoFileInfo}>} selections
 * @param {Object} [opts] `{ onProgress(done, total) }` counts cameras finished
 *   (throwing aborts), `workers` as `exportCamerasFromSharedStore`'s, `kinds`
 *   (`['lazy', 'eager']` by default) which kinds to take.
 * @returns {Promise<Array<Uint8Array|null>>} bytes per selection; null for a
 *   camera this route does not write (the caller exports it as before).
 */
export async function exportCamerasInWorkers(selections, reprojAsUser, instanceFilter, opts) {
    var SIO = window.SleapIO;
    opts = opts || {};
    var kinds = opts.kinds || ['lazy', 'eager'];
    var out = selections.map(function () { return null; });
    var idx = [], kindOf = [];
    for (var i = 0; i < selections.length; i++) {
        var kind = cameraExportUsesLazyRewrite(selections[i], reprojAsUser, instanceFilter) ? 'lazy'
            : cameraExportUsesEagerBuild(selections[i], reprojAsUser, instanceFilter) ? 'eager' : null;
        if (kind && kinds.indexOf(kind) >= 0) { idx.push(i); kindOf.push(kind); }
    }
    if (!idx.length) return out;
    var nLazy = kindOf.filter(function (k) { return k === 'lazy'; }).length;
    var nWorkers = _storeCopyWorkerCount(idx.length, opts);
    var cap = Math.max(1, Math.min(nWorkers, LAZY_REWRITE_IN_FLIGHT));
    var live = [];   // { h, done } in flight
    var finished = 0;
    var t0 = performance.now();
    var report = async function () { if (opts.onProgress) await opts.onProgress(finished, idx.length); };
    // One camera's file: { bytes } when whole, else { shell, tables, rows } for its worker.
    var build = async function (k, toWorker) {
        var sel = selections[idx[k]];
        if (kindOf[k] === 'lazy') {
            var lazyLabels = sel.session.lazyLoader.labelsByCam.get(sel.cameraName);
            if (!toWorker) return { bytes: await SIO.saveSlpToBytes(lazyLabels) };
            var tables = [];
            var shell = await SIO.saveSlpToBytes(lazyLabels, { lucidDeferTables: tables });
            return tables.length ? { shell: shell, tables: tables, rows: [] } : { bytes: shell };
        }
        var labels = buildSlpLabelsMultiSession([sel], reprojAsUser, instanceFilter);
        if (!toWorker) return { bytes: await SIO.saveSlpToBytes(labels) };
        var rows = [];
        var eagerShell = await SIO.saveSlpToBytes(labels, {
            lucidDivertTables: function (name, data, n, cols) { rows.push([name, data, n, cols]); },
        });
        return rows.length ? { shell: eagerShell, tables: [], rows: rows } : { bytes: eagerShell };
    };
    try {
        await report();
        for (var k = 0; k < idx.length; k++) {
            if (!nWorkers) {
                out[idx[k]] = (await build(k, false)).bytes;
                finished++;
                await report();
                continue;
            }
            while (live.length >= cap) await Promise.race(live.map(function (x) { return x.done; }));
            var part = await build(k, true);
            if (part.bytes) {   // a small camera: nothing held back, the file is whole
                out[idx[k]] = part.bytes;
                finished++;
                await report();
                continue;
            }
            var h = null;
            try {
                h = _startRowsWorker(part.shell);   // a Worker that cannot be made throws here
                await h.ready;
            } catch (we) {
                if (h) h.terminate();
                if (finished > 0 || live.length) throw we;   // they ran for the cameras before
                console.warn('[export-slp-cameras] export workers unavailable, compressing on this thread:', we);
                nWorkers = 0;
                k--;   // this camera again, on this thread
                continue;
            }
            for (var t = 0; t < part.tables.length; t++) h.create(part.tables[t].spec, part.tables[t].data, part.tables[t].attrs);
            for (var r = 0; r < part.rows.length; r++) h.send(part.rows[r][0], part.rows[r][1], part.rows[r][2], part.rows[r][3]);
            part = null;
            (function (slot, handle) {
                var entry = { h: handle, done: null };
                entry.done = handle.finish().then(function (bytes) {
                    out[slot] = bytes;
                    handle.terminate();
                    live.splice(live.indexOf(entry), 1);
                    finished++;
                    return report();
                });
                live.push(entry);
            })(idx[k], h);
        }
        while (live.length) await Promise.race(live.map(function (x) { return x.done; }));
    } catch (err) {
        for (var d = 0; d < live.length; d++) { try { live[d].h.terminate(); } catch (e) { /* ignore */ } }
        throw err;
    }
    var how = nWorkers ? ' (up to ' + cap + ' worker' + (cap === 1 ? '' : 's') + ' at once)' : ' (this thread)';
    if (nLazy) console.log('[export-slp-lazy] ' + nLazy + ' camera(s) rewritten from their own stores in ' +
        Math.round(performance.now() - t0) + ' ms' + how);
    if (idx.length - nLazy) console.log('[export-slp-eager] ' + (idx.length - nLazy) + ' fully loaded camera(s) written in ' +
        Math.round(performance.now() - t0) + ' ms' + how);
    return out;
}

/**
 * `exportCamerasInWorkers` for folder-loaded cameras only (each rewritten from
 * its own store); other cameras get null.
 */
export function exportCamerasLazyRewrite(selections, reprojAsUser, instanceFilter, opts) {
    return exportCamerasInWorkers(selections, reprojAsUser, instanceFilter, Object.assign({}, opts || {}, { kinds: ['lazy'] }));
}

/** Copied from pose/tracker.js's identical helper — see that file's doc. */
function frameGroupHasUserInstances(fg) {
    for (var [, insts] of fg.instances) {
        for (var i = 0; i < insts.length; i++) {
            if (insts[i] && insts[i].type === 'user') return true;
        }
    }
    for (var [, uInsts] of fg.unlinkedInstances) {
        for (var j = 0; j < uInsts.length; j++) {
            if (uInsts[j] && uInsts[j].instance && uInsts[j].instance.type === 'user') return true;
        }
    }
    return false;
}

/**
 * True when `instanceFilter` doesn't require anything the lazy fast-path
 * (`lazyCameraExportBytes`, above — re-emits the columnar store verbatim,
 * whole project, no per-frame filtering) can't provide: no reprojections
 * requested (the raw store has none — those are LUCID-side derived data),
 * and predicted/user instances aren't being explicitly EXCLUDED.
 *
 * REGRESSION (reported: "Export SLEAP File Per Session"/"By Cam" — after
 * Propagate IDs → Tracks, the exported file only has track labels on the
 * first frame): every export-modal call site (`ui/export-modals.js`)
 * constructs a non-null `instanceFilter` object UNCONDITIONALLY — even at
 * default checkbox settings (`{ user: true, predicted: includePred,
 * reprojected: saveReproj }`) — to carry the Include-Predicted/Include-
 * Reprojections checkbox state. Gating the fast path on plain `!instanceFilter`
 * (as it originally was) meant that condition was NEVER true for these
 * modals, so every export silently fell through to the eager, `session.
 * frameGroups`-only builder (`buildSlpLabels`/`buildSlpLabelsMultiSession`)
 * — which only sees whatever's currently resident in memory on a lazy
 * session (a small scrubbed-to window, often just the current frame right
 * after Track All + Propagate), silently omitting every other frame from
 * the file entirely.
 */
function instanceFilterAllowsLazyFastPath(instanceFilter) {
    if (!instanceFilter) return true;
    return instanceFilter.reprojected !== true &&
        instanceFilter.predicted !== false &&
        instanceFilter.user !== false;
}

/**
 * Skeleton + tracks + video for a per-camera export. Shared by the eager
 * (`buildSlpLabels`) and streaming (`exportCameraSlpStreaming`) paths so their
 * headers cannot drift either.
 */
function _buildCameraExportHeader(session, cameraName, videoFileInfo) {
    var SIO = window.SleapIO;
    videoFileInfo = videoFileInfo || {};
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
    var trackSource = _exportTrackSource(session);
    var tracks = trackSource.names.map(function (name) { return new SIO.Track(name); });
    var cv = cameraExportVideo(session, cameraName, videoFileInfo);
    var videoFilename = cv.filename;
    var vw = cv.width;
    var vh = cv.height;
    var fc = cv.frames;
    var video = new SIO.Video({
        filename: videoFilename,
        backendMetadata: {
            type: 'MediaVideo', shape: [fc, vh, vw, 1],
            filename: videoFilename, grayscale: false, bgr: false,
        },
        openBackend: false,
    });
    video.shape = [fc, vh, vw, 1];
    return { skeleton: skeleton, tracks: tracks, trackSource: trackSource, video: video,
             numNodes: session.skeleton.nodes.length };
}

/**
 * Per-camera SLP export for a LAZILY REOPENED project — the whole project,
 * memory-bounded.
 *
 * ## Why this exists
 *
 * A from-scratch session exports correctly because every frame is RESIDENT, so
 * `buildSlpLabels`'s loop over `session.frameGroups` sees the whole project. A
 * reopened session materializes 2D on demand, so that same loop saw 5,447 of
 * 180,210 frames on the real project and wrote a structurally valid `.slp`
 * containing 3% of the labels. The `lazyCameraExportBytes` fast path avoids that
 * by re-emitting the columnar store verbatim, but it cannot be used when any
 * resident frame holds a manual correction (the store still has the original
 * prediction), when reprojections are requested, or for a multi-camera
 * selection — i.e. it is unavailable in exactly the situations that matter.
 *
 * ## The strategy
 *
 * Make the lazy path do what the resident path does, one window at a time:
 * `sweepLazyFrameWindows` hydrates a window of real 2D, each frame goes through
 * the SAME `_buildCameraLabeledFrame` the eager exporter uses, the frames are
 * appended to the streaming writer, and the window is released. Peak memory is
 * one window plus one batch of frames regardless of project size, and a
 * from-scratch project and a reopened project produce the same output because
 * they run the same frame builder over the same skeleton/tracks/video header.
 *
 * Corrections come along for free: the sweep hydrates the live 2D, including
 * resident user-edited frames, which is precisely what the verbatim fast path
 * could not express. `writer.appendFrames` dedups by `(video, frameIdx)`, so a
 * frame can never be written twice.
 *
 * Identities are deliberately NOT passed to the writer, matching
 * `buildSlpLabels`: a non-empty `identities` bumps the format to 1.9, which
 * sleap-io Python <= 0.6.x cannot read. They travel as the tracks
 * (`_exportTrackSource`). This is a flat per-camera dump, not a project round-trip.
 *
 * @param {Object} opts `{ sink }` streams straight to a
 *   `FileSystemWritableFileStream` instead of returning bytes; `{ onProgress }`.
 * @returns {Promise<Uint8Array|null>} bytes, or null when streamed to a sink.
 */
export async function exportCameraSlpStreaming(session, cameraName, reprojAsUser, videoFileInfo, instanceFilter, opts) {
    opts = opts || {};
    var out = await exportCamerasSlpStreaming(session, [{ cameraName: cameraName, videoFileInfo: videoFileInfo }],
        reprojAsUser, instanceFilter, { onProgress: opts.onProgress, sinks: opts.sink ? [opts.sink] : null, chunkBytes: opts.chunkBytes });
    return out[0];
}

/**
 * `exportCameraSlpStreaming` for several cameras of ONE session in ONE sweep:
 * one writer per camera, each frame hydrated once and built for every camera.
 * Hydrating is nearly all of a camera's cost (a sweep that builds nothing takes
 * as long as a one-camera export), so N cameras cost about one sweep instead of
 * N (By Cam's Download All on a lazy project).
 *
 * @param {Array<{cameraName: string, videoFileInfo: Object}>} cameras
 * @param {Object} [opts] `{ onProgress(done, total), sinks }` — `sinks[i]`
 *   streams camera i to a `FileSystemWritableFileStream` (its result is null).
 *   Throwing from `onProgress` aborts and disposes every writer.
 * @returns {Promise<Array<Uint8Array|null>>} bytes per camera, in order.
 */
export async function exportCamerasSlpStreaming(session, cameras, reprojAsUser, instanceFilter, opts) {
    var SIO = window.SleapIO;
    if (!SIO || typeof SIO.openSlpWriter !== 'function') {
        throw new Error('sleap-io.js streaming writer (openSlpWriter) not available');
    }
    opts = opts || {};
    // A reopened project keeps every camera in ONE store: copy each camera's
    // rows from it instead of hydrating every frame (`exportCamerasFromSharedStore`).
    // `opts.route` 'store' / 'sweep' forces one route (tests); the default picks
    // the store whenever it can write exactly what the sweep would.
    var route = opts.route || 'auto';
    if (route !== 'sweep') {
        var storeCtx = sharedStoreCopyContext(session, reprojAsUser, instanceFilter);
        if (storeCtx.blocker) {
            if (route === 'store') throw new Error('store copy unavailable: ' + storeCtx.blocker);
            if (session && session.lazyLoader && session.lazyLoader._sharedStore) {
                console.log('[export-slp-streaming] per-frame pass, not the store copy:', storeCtx.blocker);
            }
        } else {
            var copied = await exportCamerasFromSharedStore(session, cameras, storeCtx, instanceFilter,
                Object.assign({}, opts, { force: route === 'store' }));
            if (copied) return copied;
        }
    }
    var cams = [];
    try {
        for (var c = 0; c < cameras.length; c++) {
            var env = _buildCameraExportHeader(session, cameras[c].cameraName, cameras[c].videoFileInfo);
            env.instanceFilter = instanceFilter;
            env.reprojAsUser = reprojAsUser;
            var header = {
                skeletons: [env.skeleton],
                videos: [env.video],
                tracks: env.tracks,
                identities: [],
                sessions: [],
                provenance: { source: 'lucid', exported_at: new Date().toISOString() },
            };
            var writer = await SIO.openSlpWriter(header);
            // COVERAGE PRECONDITION. `sweepLazyFrameWindows` hydrates through
            // `batchLoadLazyFrames`, which operates on the ACTIVE `state.session`. For any
            // other session (a multi-session project's non-active sessions) nothing
            // hydrates, and this would emit a resident-only file — the very truncation it
            // exists to prevent, just harder to notice. So count the frames the sweep
            // actually offered and compare against the frames this camera HAS in the
            // store; short means hydration did not happen and the export must fail loudly
            // rather than write a plausible partial file.
            var rowMap = session.lazyLoader && session.lazyLoader.frameRowByCam
                ? session.lazyLoader.frameRowByCam.get(cameras[c].cameraName) : null;
            cams.push({ name: cameras[c].cameraName, env: env, header: header, writer: writer, batch: [], nFrames: 0,
                        expectedFrames: rowMap ? rowMap.size : 0, rw: null });
        }
        var tPass0 = performance.now();
        // Each camera's rows go to its own worker, which writes and gzips them
        // (`import-export/slp-rows-worker.js`, as the store copy does): gzip was
        // ~27% of this pass on one core, the rest is hydration and building.
        // Cameras past the worker count compress here.
        var nWorkers = _storeCopyWorkerCount(cams.length, opts);
        if (nWorkers) {
            try {
                await _attachRowsWorkers(SIO, cams.slice(0, nWorkers));
            } catch (we) {
                _detachRowsWorkers(cams);
                console.warn('[export-slp-streaming] export workers unavailable, compressing on this thread:', we);
                nWorkers = 0;
            }
        }
        var roomFor = function () {
            var waits = null;
            for (var q = 0; q < cams.length; q++) {
                var rq = cams[q].rw;
                if (rq && rq.inFlight >= ROWS_WORKER_QUEUE) (waits = waits || []).push(rq.room());
            }
            return waits ? Promise.all(waits) : undefined;
        };

        var BATCH = 256;
        var nVisited = 0;
        await sweepLazyFrameWindows(session, function (frameIdx, fg) {
            // `fg` is undefined for a frame with 3D grouping but no resident 2D
            // (the sweep's contract) — nothing to emit for a 2D export.
            if (!fg) return;
            nVisited++;
            for (var k = 0; k < cams.length; k++) {
                var cam = cams[k];
                var lf = _buildCameraLabeledFrame(session, cam.name, frameIdx, fg, cam.env);
                // A frame with no instances for THIS camera (or none surviving
                // `instanceFilter`) yields null — legitimately fewer written than
                // visited, which is why the coverage check below uses `nVisited`.
                if (!lf) continue;
                cam.batch.push(lf);
                cam.nFrames++;
                if (cam.batch.length >= BATCH) {
                    cam.writer.appendFrames(cam.batch);
                    cam.batch = [];
                }
            }
            return roomFor();   // a worker that falls behind holds the pass
        }, {
            onProgress: opts.onProgress,
        });
        var out = [];
        for (var j = 0; j < cams.length; j++) {
            var cj = cams[j];
            if (cj.batch.length > 0) { cj.writer.appendFrames(cj.batch); cj.batch = []; }
            console.log('[export-slp-streaming] camera', cj.name + ':', cj.nFrames.toLocaleString(),
                'labeled frames written,', nVisited.toLocaleString(), 'of', cj.expectedFrames.toLocaleString(),
                'store frames visited');
            if (cj.expectedFrames > 0 && nVisited < cj.expectedFrames) {
                throw new Error('Export aborted: only ' + nVisited.toLocaleString() + ' of ' +
                    cj.expectedFrames.toLocaleString() + ' frames could be read for camera "' + cj.name +
                    '", so the file would be incomplete. This happens when exporting a session that is ' +
                    'not the one currently open — switch to that session and export again.');
            }
        }
        var tPassed = performance.now();
        for (var w = 0; w < cams.length; w++) {
            var sink = opts.sinks && opts.sinks[w];
            var cw = cams[w];
            if (cw.rw) {
                var wbytes = await cw.rw.finish();
                if (!cw.writer.lucidOnlyTableRows()) {
                    throw new Error('Export aborted: ' + cw.name + '\'s file has annotations or empty frames the export workers do not write.');
                }
                cw.rw.terminate();
                cw.rw = null;
                cw.writer.dispose();
                if (sink) { await _writeBytesToSink(sink, wbytes, opts.chunkBytes); out.push(null); }
                else out.push(wbytes);
            } else if (sink) {
                await cw.writer.writeToSink(sink, { chunkBytes: opts.chunkBytes });
                out.push(null);
            } else {
                out.push(cw.writer.close());
            }
            cw.writer = null;   // closed: nothing left to dispose
        }
        console.log('[export-slp-streaming] ' + cams.length + ' camera(s) in one pass: ' +
            nVisited.toLocaleString() + ' frames in ' + Math.round(tPassed - tPass0) + ' ms' +
            (nWorkers ? ' (' + nWorkers + ' worker' + (nWorkers === 1 ? '' : 's') + ')' : ' (this thread)') +
            ', close ' + Math.round(performance.now() - tPassed) + ' ms');
        return out;
    } catch (err) {
        _detachRowsWorkers(cams);
        for (var d = 0; d < cams.length; d++) {
            var wr = cams[d].writer;
            try { if (wr && typeof wr.dispose === 'function') wr.dispose(); } catch (e) { /* ignore */ }
        }
        throw err;
    }
}

// ============================================
// Per-camera export copied straight from a reopened project's shared store
// ============================================
//
// A project reopened with Load Project keeps every camera in ONE columnar store
// (`SioLazyLoader._sharedStore`). The per-frame pass above hydrates every frame
// to export it — 56 s for 8 cameras x 108,000 frames on the lab VM, nearly all
// of it hydration. The store already holds every frame the pass would write, so
// `exportCamerasFromSharedStore` copies each camera's rows out of it instead,
// the way the project save copies the whole store, and builds only the frames
// the store cannot speak for with the pass's own `_buildCameraLabeledFrame`:
//   - RESIDENT frames (`session.frameGroups`): what is on screen, edits and
//     deletions included — the store still has the original rows there;
//   - frames whose in-memory group members disagree with their rows (track,
//     type, score, own per-node scores, edited 2D), or with two kept rows on one
//     track (the pass drops the later one's track): `storeCopyDriftFrames`.
//     They are hydrated through `sweepLazyFrameWindows`, as the pass would.
// Frames come out in frame order and each frame's instances in the pass's order
// (group members first, then the rest, each by row), with the values the pass
// would write: instance score `score || 0`, each node's own score or else the
// instance score, `complete` 1 for a placed node, no tracking score, no
// `from_predicted`, and the file's visibility (hydration applies it,
// `lazyRowInstance` in pose/lazy-residency.js, so the pass writes it too).
// Reprojections exist only in memory, so with Reprojections on the export keeps
// the per-frame pass (`sharedStoreCopyContext` says why it cannot copy).

/** A column value as a number (`dflt` when the column or value is absent). */
function _colNum(col, i, dflt) {
    var v = col ? col[i] : undefined;
    return v === undefined || v === null ? dflt : Number(v);
}

/**
 * What `exportCamerasFromSharedStore` reads, or `{ blocker }` saying why this
 * export cannot be copied from the store (the caller then runs the per-frame
 * pass). Copying needs ONE store behind every camera, read the way hydration
 * reads it: the session's skeleton and track list must still be the store's
 * (a skeleton edit re-shapes resident instances only), and no reprojections.
 */
export function sharedStoreCopyContext(session, reprojAsUser, instanceFilter) {
    var SIO = window.SleapIO;
    var loader = session && session.lazyLoader;
    if (!loader || !loader._sharedStore || !loader.labelsByCam || !loader.frameRowByCam) {
        return { blocker: 'not a project reopened from one file' };
    }
    if (reprojAsUser !== null && (!instanceFilter || instanceFilter.reprojected !== false)) {
        return { blocker: 'Reprojections are on (they exist only in memory)' };
    }
    if (!SIO || typeof SIO.openSlpWriter !== 'function') return { blocker: 'no streaming writer' };
    var labels = null, store = null;
    for (var lb of loader.labelsByCam.values()) {
        var st = lb && lb._lazyDataStore;
        if (!st) return { blocker: 'a camera has no store' };
        if (store && st !== store) return { blocker: 'cameras in different stores' };
        store = st;
        labels = lb;
    }
    if (!store) return { blocker: 'no store' };
    var fd = store.framesData || {}, idn = store.instancesData || {};
    var pts = store.pointsData || {}, pps = store.predPointsData || {};
    if (!fd.instance_id_start || !fd.instance_id_end || !idn.instance_type || !idn.point_id_start ||
        !idn.point_id_end || !pts.x || !pts.y || !pps.x || !pps.y) {
        return { blocker: 'the store lacks a column' };
    }
    // Format < 1.1 user points are shifted by -0.5 when materialized.
    if (store.formatId != null && store.formatId < 1.1) return { blocker: 'file format older than 1.1' };
    var names = _skelNodeNames(session.skeleton);
    var skels = store.skeletons || [];
    var storeNames = (skels.length === 1 && skels[0] && skels[0].nodeNames) || null;
    var sameSkel = !!storeNames && storeNames.length === names.length;
    for (var ni = 0; sameSkel && ni < names.length; ni++) sameSkel = storeNames[ni] === names[ni];
    if (sameSkel && loader.numNodesByCam) {
        for (var nn of loader.numNodesByCam.values()) if (nn !== names.length) sameSkel = false;
    }
    if (!sameSkel) return { blocker: 'the skeleton differs from the file\'s' };
    var storeTracks = store.tracks || labels.tracks || [];
    if (labels.tracks && storeTracks !== labels.tracks) return { blocker: 'the store has two track lists' };
    var sTracks = session.tracks || [];
    var sameTracks = storeTracks.length === sTracks.length;
    for (var ti = 0; sameTracks && ti < sTracks.length; ti++) {
        sameTracks = !!storeTracks[ti] && storeTracks[ti].name === sTracks[ti];
    }
    if (!sameTracks) return { blocker: 'the track list differs from the file\'s' };
    // The rows carry the file's tracks; with identities assigned they are only
    // right if the file already holds them (`_exportTrackSource`).
    if (!_storeHoldsIdentityTracks(session)) return { blocker: 'identities are not yet the file\'s tracks' };
    return {
        loader: loader, fd: fd, idn: idn, pts: pts, pps: pps,
        numNodes: names.length, nTracks: sTracks.length,
    };
}

/** The track the per-frame pass writes for store instance row `j` (-1: none). */
function _storeOutTrack(ctx, j) {
    var t = _colNum(ctx.idn.track, j, -1);
    return (t >= 0 && t < ctx.nTracks && t === Math.floor(t)) ? t : -1;
}

function _storeRowPredicted(ctx, j) { return _colNum(ctx.idn.instance_type, j, 0) !== 0; }

function _storeRowKept(ctx, j, filter) {
    return !filter || filter[_storeRowPredicted(ctx, j) ? 'predicted' : 'user'] !== false;
}

/**
 * The rows of `frameIdx`'s `n` store instances for `cam` that hydration seats
 * as group members (`finalizeLazyFrameGroup`: a member whose `_rawInstIndex`
 * names the row), as a Uint8Array mask, or null when none is. Members come
 * first in the per-frame pass's output.
 */
function _storeSeatedRows(session, frameIdx, cam, n) {
    var groups = session.instanceGroups ? session.instanceGroups.get(frameIdx) : null;
    if (!groups || groups.length === 0 || n === 0) return null;
    var seated = null;
    for (var gi = 0; gi < groups.length; gi++) {
        var m = groups[gi].instances.get(cam);
        var k = m ? m._rawInstIndex : null;
        if (k == null || !(k >= 0 && k < n) || k !== Math.floor(k)) continue;
        if (!seated) seated = new Uint8Array(n);
        seated[k] = 1;
    }
    return seated;
}

/**
 * Whether group member `m`, seated at store row `j`, would be written other
 * than the row says — its own track, type, score or per-node scores, or 2D it
 * holds that differs from the row (an edit). A member whose 2D went back to the
 * store (`_lazy2d`) is hydrated from the row, so only its other fields count.
 */
function _memberDiffersFromStore(m, ctx, j) {
    var pred = _storeRowPredicted(ctx, j);
    if (m.type !== (pred ? 'predicted' : 'user')) return true;
    var mt = (m.trackIdx != null && m.trackIdx >= 0 && m.trackIdx < ctx.nTracks) ? m.trackIdx : -1;
    if (mt !== _storeOutTrack(ctx, j)) return true;
    if (pred && (m.score != null ? m.score : 1.0) !== (_colNum(ctx.idn.score, j, 0) || 0)) return true;
    if (typeof m.hasPointScores === 'function' && m.hasPointScores()) return true;
    var nulled = m.nulledNodes && m.nulledNodes.size > 0 ? m.nulledNodes : null;
    if (m._lazy2d && !nulled) return false;
    if (m.numNodes !== ctx.numNodes) return true;
    var src = pred ? ctx.pps : ctx.pts;
    var pS = _colNum(ctx.idn.point_id_start, j, 0), pE = _colNum(ctx.idn.point_id_end, j, 0);
    for (var k = 0; k < ctx.numNodes; k++) {
        var p = pS + k, x = NaN, y = NaN;
        if (p < pE) { x = Number(src.x[p]); y = Number(src.y[p]); }
        var has = isFinite(x) && isFinite(y);
        var vis = has && !!(src.visible && Number(src.visible[p]));
        // A nulled node is written placed-but-invisible.
        if (nulled && nulled.has(k) && vis) return true;
        if (m._lazy2d) continue;
        if (m.hasPoint(k) !== has) return true;
        if (!has) continue;
        if (m.getX(k) !== x || m.getY(k) !== y) return true;
        // The per-frame pass writes a placed node visible unless it is nulled
        // or occluded; hydration gives a member the file's occlusion
        // (`lazyRowInstance`), so any other flag is an edit.
        if (vis === !!((nulled && nulled.has(k)) || m.isOccluded(k))) return true;
    }
    return false;
}

/** Whether `fg` holds any instance of `cam`, linked or not. */
function _fgHasCamera(fg, cam) {
    var linked = fg.instances.get(cam);
    if (linked && linked.length > 0) return true;
    var ul = fg.getUnlinkedInstances(cam);
    return !!(ul && ul.length > 0);
}

/**
 * The frames of `cam` the store cannot speak for, so they must be hydrated and
 * built like the per-frame pass does: a non-resident frame whose members
 * disagree with their rows, or that holds two kept rows on one track; and a
 * RESIDENT frame that never got this camera's rows (the pass's hydration would
 * add them). Exported for `tests/e2e/export-bycam-store-copy.mjs`.
 */
export function storeCopyDriftFrames(session, ctx, cam, filter) {
    var rowMap = ctx.loader.frameRowByCam.get(cam);
    var out = [];
    if (!rowMap) return out;
    var nFrames = ctx.loader.nFrames || 0;
    for (var [f, row] of rowMap) {
        if (!(f >= 0 && f < nFrames)) continue;
        var iS = _colNum(ctx.fd.instance_id_start, row, 0), iE = _colNum(ctx.fd.instance_id_end, row, 0);
        var fg = session.frameGroups.get(f);
        if (fg) {
            if (iE > iS && !_fgHasCamera(fg, cam)) out.push(f);
            continue;
        }
        if (_storeFrameDrifts(session, ctx, cam, f, iS, iE, filter)) out.push(f);
    }
    return out;
}

function _storeFrameDrifts(session, ctx, cam, f, iS, iE, filter) {
    var n = iE - iS;
    if (n <= 0) return false;
    var seenT = null;
    for (var j = iS; j < iE; j++) {
        if (!_storeRowKept(ctx, j, filter)) continue;
        var t = _storeOutTrack(ctx, j);
        if (t < 0) continue;
        if (!seenT) seenT = [];
        else if (seenT.indexOf(t) >= 0) return true;
        seenT.push(t);
    }
    var groups = session.instanceGroups ? session.instanceGroups.get(f) : null;
    if (!groups) return false;
    var taken = null;
    for (var gi = 0; gi < groups.length; gi++) {
        var m = groups[gi].instances.get(cam);
        var k = m ? m._rawInstIndex : null;
        if (k == null || !(k >= 0 && k < n) || k !== Math.floor(k)) continue;
        if (!taken) taken = new Uint8Array(n);
        if (taken[k]) return true;   // two members on one row: which one hydration seats is not ours to guess
        taken[k] = 1;
        if (_memberDiffersFromStore(m, ctx, iS + k)) return true;
    }
    return false;
}

/**
 * Build the raw table rows (`SlpStreamWriter.appendRawRows`, LUCID local patch
 * (raw rows)) for `count` store frames of one camera: `frames[e]` is the video
 * frame, `rows[e]` its store row. Ids are relative to the block; video 0.
 */
function _storeRowsBlock(session, ctx, cam, frames, rows, count, filter) {
    var fd = ctx.fd, idn = ctx.idn, nNodes = ctx.numNodes;
    var nF = 0, nU = 0, nP = 0;
    for (var e = 0; e < count; e++) {
        var iS0 = _colNum(fd.instance_id_start, rows[e], 0), iE0 = _colNum(fd.instance_id_end, rows[e], 0);
        var kept0 = 0;
        for (var j0 = iS0; j0 < iE0; j0++) {
            if (!_storeRowKept(ctx, j0, filter)) continue;
            if (_storeRowPredicted(ctx, j0)) nP++; else nU++;
            kept0++;
        }
        if (kept0) nF++;
    }
    var F = new Float64Array(nF * 5), I = new Float64Array((nU + nP) * 10);
    var P = new Float64Array(nU * nNodes * 4), Q = new Float64Array(nP * nNodes * 5);
    var fi = 0, ii = 0, pu = 0, pq = 0;
    var order = [];
    var ux = ctx.pts.x, uy = ctx.pts.y, uv = ctx.pts.visible;
    var qx = ctx.pps.x, qy = ctx.pps.y, qv = ctx.pps.visible, qs = ctx.pps.score;
    for (var e2 = 0; e2 < count; e2++) {
        var f = frames[e2];
        var iS = _colNum(fd.instance_id_start, rows[e2], 0), iE = _colNum(fd.instance_id_end, rows[e2], 0);
        var seated = _storeSeatedRows(session, f, cam, iE - iS);
        order.length = 0;
        // The pass's order: seated members (by row), then the rest (by row).
        for (var pass = seated ? 0 : 1; pass < 2; pass++) {
            for (var j = iS; j < iE; j++) {
                if (seated && !!seated[j - iS] !== (pass === 0)) continue;
                if (_storeRowKept(ctx, j, filter)) order.push(j);
            }
        }
        if (order.length === 0) continue;
        var o5 = fi * 5;
        F[o5] = fi; F[o5 + 1] = 0; F[o5 + 2] = f; F[o5 + 3] = ii; F[o5 + 4] = ii + order.length;
        for (var oi = 0; oi < order.length; oi++) {
            var jj = order[oi];
            var pred = _storeRowPredicted(ctx, jj);
            var s = pred ? (_colNum(idn.score, jj, 0) || 0) : 0;
            var pS = _colNum(idn.point_id_start, jj, 0), pE = _colNum(idn.point_id_end, jj, 0);
            var o = ii * 10;
            I[o] = ii; I[o + 1] = pred ? 1 : 0; I[o + 2] = fi; I[o + 3] = 0;
            I[o + 4] = _storeOutTrack(ctx, jj); I[o + 5] = -1; I[o + 6] = s;
            I[o + 7] = pred ? pq : pu; I[o + 8] = (pred ? pq : pu) + nNodes; I[o + 9] = 0;
            var X = pred ? qx : ux, Y = pred ? qy : uy, V = pred ? qv : uv;
            for (var k = 0; k < nNodes; k++) {
                var p = pS + k, inRange = p < pE;
                var x = inRange ? Number(X[p]) : NaN, y = inRange ? Number(Y[p]) : NaN;
                var has = isFinite(x) && isFinite(y);
                var vis = has && !!(V && Number(V[p])) ? 1 : 0;
                if (pred) {
                    var q = pq * 5;
                    var ns = inRange && qs ? Number(qs[p]) : NaN;
                    Q[q] = has ? x : NaN; Q[q + 1] = has ? y : NaN; Q[q + 2] = vis; Q[q + 3] = has ? 1 : 0;
                    Q[q + 4] = isFinite(ns) ? ns : s;
                    pq++;
                } else {
                    var u = pu * 4;
                    P[u] = has ? x : NaN; P[u + 1] = has ? y : NaN; P[u + 2] = vis; P[u + 3] = has ? 1 : 0;
                    pu++;
                }
            }
            ii++;
        }
        fi++;
    }
    return { frames: F, instances: I, points: P, predPoints: Q };
}

/**
 * `exportCamerasSlpStreaming` for a project reopened from one file: each
 * camera's rows are copied out of the shared store (see the section comment
 * above). Resolves to the same `[bytes|null]` per camera, or to null when too
 * many frames would need hydrating for the copy to pay (the caller then runs
 * the per-frame pass; `opts.force` copies anyway).
 *
 * `opts.onProgress(done, total)` counts video frames (total = the project's
 * frame count), the cameras' copies together; throwing from it aborts.
 * `opts.workers`: false copies on this thread, N uses N export workers; by
 * default one per camera up to the core count (`_storeCopyWorkerCount`), each
 * writing and gzipping its camera's file (`import-export/slp-rows-worker.js`).
 */
export async function exportCamerasFromSharedStore(session, cameras, ctx, instanceFilter, opts) {
    var SIO = window.SleapIO;
    opts = opts || {};
    var t0 = performance.now();
    var loader = ctx.loader;
    var nFrames = loader.nFrames || 0;

    // 1. Frames the store cannot speak for, all cameras together.
    var driftSet = new Set();
    for (var dc = 0; dc < cameras.length; dc++) {
        var dfs = storeCopyDriftFrames(session, ctx, cameras[dc].cameraName, instanceFilter);
        for (var di = 0; di < dfs.length; di++) driftSet.add(dfs[di]);
    }
    var drift = Array.from(driftSet).sort(function (a, b) { return a - b; });
    // Contiguous runs (gaps under 64 frames bridged), each hydrated by one sweep.
    var runs = [];
    for (var ri = 0; ri < drift.length; ri++) {
        var last = runs[runs.length - 1];
        if (last && drift[ri] - last[1] <= 64) last[1] = drift[ri];
        else runs.push([drift[ri], drift[ri]]);
    }
    var sweptFrames = 0;
    for (var rr = 0; rr < runs.length; rr++) sweptFrames += runs[rr][1] - runs[rr][0] + 1;
    if (!opts.force && sweptFrames > Math.max(2000, nFrames * 0.05)) {
        console.log('[export-slp-store] ' + drift.length.toLocaleString() + ' frames differ from the store (' +
            sweptFrames.toLocaleString() + ' to hydrate): using the per-frame pass');
        return null;
    }
    var tPlan = performance.now();

    var cams = [];
    try {
        for (var c = 0; c < cameras.length; c++) {
            var env = _buildCameraExportHeader(session, cameras[c].cameraName, cameras[c].videoFileInfo);
            env.instanceFilter = instanceFilter;
            env.reprojAsUser = null;   // the copy runs only without reprojections
            var header = {
                skeletons: [env.skeleton], videos: [env.video], tracks: env.tracks,
                identities: [], sessions: [],
                provenance: { source: 'lucid', exported_at: new Date().toISOString() },
            };
            var writer = await SIO.openSlpWriter(header);
            if (typeof writer.appendRawRows !== 'function') {
                try { writer.dispose(); } catch (e) { /* ignore */ }
                throw new Error('sleap-io.js writer lacks appendRawRows (LUCID local patch, raw rows)');
            }
            cams.push({ name: cameras[c].cameraName, env: env, header: header, writer: writer, swept: new Map(),
                        rowMap: loader.frameRowByCam.get(cameras[c].cameraName) || new Map(), nFrames: 0,
                        rw: null, bytes: null, done: null });
        }

        // 2. Hydrate the drift runs and build their frames exactly as the pass does.
        var sweptSet = new Set();
        for (var rn = 0; rn < runs.length; rn++) {
            for (var sf = runs[rn][0]; sf <= runs[rn][1]; sf++) sweptSet.add(sf);
            await sweepLazyFrameWindows(session, function (frameIdx, fg) {
                if (!fg) return;
                for (var k = 0; k < cams.length; k++) {
                    cams[k].swept.set(frameIdx, _buildCameraLabeledFrame(session, cams[k].name, frameIdx, fg, cams[k].env));
                }
            }, { start: runs[rn][0], end: runs[rn][1] });
        }
        // The sweep hydrates through the ACTIVE session only: a frame it should
        // have built but did not means the file would silently miss it.
        for (var dv = 0; dv < drift.length; dv++) {
            if (!cams[0] || cams[0].swept.has(drift[dv])) continue;
            throw new Error('Export aborted: frame ' + drift[dv].toLocaleString() + ' could not be read, so the ' +
                'file would be incomplete. This happens when exporting a session that is not the one currently ' +
                'open — switch to that session and export again.');
        }
        var tSwept = performance.now();

        // 3. Each camera, in frame order: swept and resident frames through the
        //    pass's builder, every other frame copied from the store. With
        //    workers (the default), a group of cameras is built in turns, one
        //    block each, and each camera's rows go to its own worker, which
        //    writes and gzips them (gzip was ~3/4 of the copy, on one core).
        //    Without, one camera after another on this thread, as before.
        var pacer = createProgressPacer();
        var BLOCK = 4096;
        for (var ci = 0; ci < cams.length; ci++) {
            cams[ci].copier = _storeCameraCopier(session, ctx, cams[ci], sweptSet, nFrames, instanceFilter, BLOCK);
        }
        var nWorkers = _storeCopyWorkerCount(cams.length, opts);
        var reportProgress = async function () {
            if (!opts.onProgress) return;
            var sum = 0;
            for (var pi = 0; pi < cams.length; pi++) sum += cams[pi].copier.fraction();
            await opts.onProgress(Math.floor(nFrames * sum / cams.length), nFrames);
        };
        var g0 = 0;
        while (g0 < cams.length) {
            var group = cams.slice(g0, g0 + Math.max(1, nWorkers));
            if (nWorkers) {
                try {
                    await _attachRowsWorkers(SIO, group);
                } catch (we) {
                    _detachRowsWorkers(group);
                    if (g0 > 0) throw we;   // they ran for the cameras before: this is a real failure
                    console.warn('[export-slp-store] export workers unavailable, compressing on this thread:', we);
                    nWorkers = 0;
                    continue;
                }
            }
            var live = group.slice();
            while (live.length) {
                for (var li = 0; li < live.length; li++) {
                    var cm = live[li];
                    if (cm.rw) await cm.rw.room();
                    if (cm.copier.step()) {
                        cm.swept = null;
                        console.log('[export-slp-store] camera', cm.name + ':', cm.nFrames.toLocaleString(), 'labeled frames written');
                        if (cm.rw) cm.done = cm.rw.finish();
                        live.splice(li, 1);
                        li--;
                    }
                }
                // Progress after every round (cheap: no paint) so the bar and
                // Esc keep up; a paint only when the pacer says so.
                await reportProgress();
                if (pacer.due()) await pacer.yield();
            }
            for (var gi = 0; gi < group.length; gi++) {
                var gc = group[gi];
                if (!gc.rw) continue;
                gc.bytes = await gc.done;
                // The worker's file is the whole file only if finishing the
                // working writer would have added nothing but rows.
                if (!gc.writer.lucidOnlyTableRows()) {
                    throw new Error('Export aborted: ' + gc.name + '\'s file has annotations or empty frames the export workers do not write.');
                }
                gc.rw.terminate();
                gc.rw = null;
                gc.writer.dispose();
                gc.writer = null;
            }
            g0 += group.length;
        }
        if (opts.onProgress) await opts.onProgress(nFrames, nFrames);
        var tCopied = performance.now();

        var out = [];
        for (var w = 0; w < cams.length; w++) {
            var sink = opts.sinks && opts.sinks[w];
            if (cams[w].bytes) {
                if (sink) {
                    await _writeBytesToSink(sink, cams[w].bytes, opts.chunkBytes);
                    out.push(null);
                } else {
                    out.push(cams[w].bytes);
                }
                cams[w].bytes = null;
            } else if (sink) {
                await cams[w].writer.writeToSink(sink, { chunkBytes: opts.chunkBytes });
                out.push(null);
            } else {
                out.push(cams[w].writer.close());
            }
            cams[w].writer = null;
        }
        console.log('[export-slp-store] ' + cams.length + ' camera(s) from the store: plan ' +
            Math.round(tPlan - t0) + ' ms, ' + drift.length.toLocaleString() + ' frames hydrated in ' +
            Math.round(tSwept - tPlan) + ' ms, copy ' + Math.round(tCopied - tSwept) + ' ms' +
            (nWorkers ? ' (' + nWorkers + ' worker' + (nWorkers === 1 ? '' : 's') + ')' : ' (this thread)') +
            ', close ' + Math.round(performance.now() - tCopied) + ' ms');
        return out;
    } catch (err) {
        _detachRowsWorkers(cams);
        for (var d = 0; d < cams.length; d++) {
            var wr = cams[d].writer;
            try { if (wr && typeof wr.dispose === 'function') wr.dispose(); } catch (e) { /* ignore */ }
        }
        throw err;
    }
}

/**
 * One camera's walk for `exportCamerasFromSharedStore` step 3: its frames in
 * order, swept and resident frames through the pass's builder (`appendFrames`),
 * every other frame copied from the store in blocks (`appendRawRows`).
 * `step()` walks up to `block` frames and returns true once the camera is
 * written (everything flushed); `fraction()` is how far it got.
 */
function _storeCameraCopier(session, ctx, cam, sweptSet, nFrames, instanceFilter, block) {
    var keySet = new Set();
    for (var rk of cam.rowMap.keys()) if (rk >= 0 && rk < nFrames) keySet.add(rk);
    for (var fk of session.frameGroups.keys()) if (fk >= 0 && fk < nFrames) keySet.add(fk);
    for (var sk of sweptSet) keySet.add(sk);
    var keys = Float64Array.from(keySet).sort();
    var bFrames = new Float64Array(block), bRows = new Float64Array(block), bn = 0;
    var lfs = [];
    var ki = 0;
    function flushRows() {
        if (!bn) return;
        var rows = _storeRowsBlock(session, ctx, cam.name, bFrames, bRows, bn, instanceFilter);
        cam.nFrames += rows.frames.length / 5;   // before the append: a worker takes the arrays
        cam.writer.appendRawRows(rows);
        bn = 0;
    }
    function flushLfs() {
        if (!lfs.length) return;
        cam.writer.appendFrames(lfs);
        cam.nFrames += lfs.length;
        lfs = [];
    }
    return {
        fraction: function () { return keys.length ? ki / keys.length : 1; },
        step: function () {
            var stop = Math.min(keys.length, ki + block);
            for (; ki < stop; ki++) {
                var f = keys[ki];
                var lf;
                if (sweptSet.has(f)) {
                    lf = cam.swept.get(f) || null;
                } else {
                    var fg = session.frameGroups.get(f);
                    lf = fg ? _buildCameraLabeledFrame(session, cam.name, f, fg, cam.env) : undefined;
                }
                if (lf !== undefined) {
                    if (lf) { flushRows(); lfs.push(lf); if (lfs.length >= 256) flushLfs(); }
                } else {
                    var row = cam.rowMap.get(f);
                    if (row !== undefined) {
                        flushLfs();
                        bFrames[bn] = f; bRows[bn] = row; bn++;
                        if (bn === block) flushRows();
                    }
                }
            }
            if (ki < keys.length) return false;
            flushLfs();
            flushRows();
            return true;
        },
    };
}

/**
 * How many cameras the store copy writes at once in workers (0 = this thread):
 * `opts.workers` (false/0 = none, a number = that many), else
 * `window.LUCID_EXPORT_WORKERS`, else one per camera up to the core count.
 */
function _storeCopyWorkerCount(nCams, opts) {
    if (opts.workers === false) return 0;
    if (typeof Worker !== 'function' || typeof document === 'undefined') return 0;
    var forced = typeof opts.workers === 'number' ? opts.workers
        : (typeof window !== 'undefined' ? window.LUCID_EXPORT_WORKERS : undefined);
    if (forced != null) return Math.max(0, Math.min(nCams, forced | 0));
    var hc = (typeof navigator !== 'undefined' && navigator.hardwareConcurrency) || 2;
    return Math.max(1, Math.min(nCams, hc, 16));
}

/** Row messages in flight per export worker (each one table's rows of one block). */
var ROWS_WORKER_QUEUE = 8;

/**
 * Start `import-export/slp-rows-worker.js` on `shell` (an empty writer's file)
 * and return its handle: `ready`, `send(name, data, rows, cols)` (transfers
 * `data`), `room()` (resolves while fewer than ROWS_WORKER_QUEUE messages are
 * unanswered), `finish()` → the file's bytes, `terminate()`. A failure rejects
 * every pending and later call.
 */
function _startRowsWorker(shell) {
    var w = new Worker(new URL('import-export/slp-rows-worker.js?v=ecdf4c85283a', document.baseURI), { type: 'module' });
    var h = { failed: null, inFlight: 0, waiters: [] };
    var readyFns, doneFns;
    h.ready = new Promise(function (res, rej) { readyFns = [res, rej]; });
    var done = new Promise(function (res, rej) { doneFns = [res, rej]; });
    h.ready.catch(function () { /* surfaced by the awaiting caller */ });
    done.catch(function () { /* surfaced by finish() */ });
    function wake() {
        var ws = h.waiters;
        h.waiters = [];
        for (var i = 0; i < ws.length; i++) ws[i]();
    }
    function fail(err) {
        if (h.failed) return;
        h.failed = err;
        readyFns[1](err);
        doneFns[1](err);
        wake();
    }
    w.onmessage = function (ev) {
        var m = ev.data;
        if (m.type === 'ready') readyFns[0]();
        else if (m.type === 'ack') { h.inFlight--; wake(); }
        else if (m.type === 'done') doneFns[0](m.bytes);
        else if (m.type === 'error') fail(new Error('export worker: ' + m.message));
    };
    w.onerror = function (e) {
        if (e && e.preventDefault) e.preventDefault();
        fail(new Error('export worker failed: ' + ((e && e.message) || 'it could not start')));
    };
    h.send = function (name, data, rows, cols) {
        if (h.failed) throw h.failed;
        var own = (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) ? data : data.slice();
        h.inFlight++;
        w.postMessage({ type: 'rows', name: name, data: own, rows: rows, cols: cols }, [own.buffer]);
    };
    h.create = function (spec, data, attrs) {
        if (h.failed) throw h.failed;
        var own = (data.byteOffset === 0 && data.byteLength === data.buffer.byteLength) ? data : data.slice();
        h.inFlight++;
        w.postMessage({ type: 'create', spec: spec, data: own, attrs: attrs }, [own.buffer]);
    };
    h.room = function () {
        if (h.failed) return Promise.reject(h.failed);
        if (h.inFlight < ROWS_WORKER_QUEUE) return Promise.resolve();
        return new Promise(function (res) { h.waiters.push(res); }).then(h.room);
    };
    h.finish = function () {
        if (!h.failed) w.postMessage({ type: 'finish' });
        return done;
    };
    h.terminate = function () { w.terminate(); };
    var buf = (shell.byteOffset === 0 && shell.byteLength === shell.buffer.byteLength) ? shell.buffer : shell.slice().buffer;
    w.postMessage({ type: 'open', shell: buf }, [buf]);
    return h;
}

/**
 * Give each camera of `group` an export worker holding its header (an empty
 * writer with the same header, closed at once) and send its writer's rows
 * there (`lucidDivertRows`, the bundle's `(row divert)` patch).
 */
async function _attachRowsWorkers(SIO, group) {
    for (var i = 0; i < group.length; i++) {
        var shellWriter = await SIO.openSlpWriter(group[i].header);
        if (typeof shellWriter.lucidDivertRows !== 'function' || typeof shellWriter.lucidOnlyTableRows !== 'function') {
            try { shellWriter.dispose(); } catch (e) { /* ignore */ }
            throw new Error('sleap-io.js writer lacks lucidDivertRows (LUCID local patch, row divert)');
        }
        group[i].rw = _startRowsWorker(shellWriter.close());
    }
    for (var r = 0; r < group.length; r++) await group[r].rw.ready;
    group.forEach(function (cm) {
        cm.writer.lucidDivertRows(function (name, data, rows, cols) { cm.rw.send(name, data, rows, cols); });
    });
}

/** Stop `cams`' export workers and send their writers' rows to their own files again. */
function _detachRowsWorkers(cams) {
    for (var i = 0; i < cams.length; i++) {
        var cm = cams[i];
        if (!cm.rw) continue;
        try { cm.rw.terminate(); } catch (e) { /* ignore */ }
        cm.rw = null;
        try { if (cm.writer && !cm.writer.closed) cm.writer.lucidDivertRows(null); } catch (e) { /* ignore */ }
    }
}

/** Write `bytes` to a FileSystemWritableFileStream-like `sink` in chunks, then close it. */
async function _writeBytesToSink(sink, bytes, chunkBytes) {
    var step = Math.max(1, Math.trunc(chunkBytes || 8 * 1024 * 1024));
    for (var pos = 0; pos < bytes.length; pos += step) {
        await sink.write(bytes.subarray(pos, Math.min(pos + step, bytes.length)));
    }
    if (sink.close) await sink.close();
}

/**
 * Whether By Cam's camera `selection` (one session, one camera) would be written
 * by the streaming sweep — the same routing as `exportSlpMultiSession` — so the
 * caller can put every such camera of a session into ONE `exportCamerasSlpStreaming`.
 */
export function cameraExportUsesSweep(selection, reprojAsUser, instanceFilter) {
    var session = selection && selection.session;
    if (!_exportWouldTruncate(session)) return false;
    if (!reprojAsUser && instanceFilterAllowsLazyFastPath(instanceFilter) &&
        lazyCameraFastPathUsable(window.SleapIO, session, selection.cameraName)) return false;
    return true;
}

export async function exportSlpClientSide(session, cameraName, reprojAsUser, videoFileInfo, outputFilename, instanceFilter) {
    var SIO = window.SleapIO;
    if (!SIO) throw new Error('sleap-io.js not loaded');

    // Lazy session, plain predicted export → lazy fast-path (all frames, bounded).
    // Skipped when a reprojection/instance transform is requested (the fast-path
    // re-emits the store verbatim and can't apply those) — see
    // instanceFilterAllowsLazyFastPath's doc for why this must NOT be a plain
    // `!instanceFilter` check.
    if (!reprojAsUser && instanceFilterAllowsLazyFastPath(instanceFilter)) {
        var lazyBytes = await lazyCameraExportBytes(SIO, session, cameraName);
        if (lazyBytes) return new Blob([lazyBytes], { type: 'application/x-hdf5' });
    }

    // The eager builder below is RESIDENT-ONLY, which is correct for a
    // from-scratch project (every frame resident) and silently truncating for a
    // lazily reopened one. When the fast path above could not be used and the
    // project would be truncated, stream the WHOLE project through the same
    // per-frame builder instead — see `exportCameraSlpStreaming`.
    if (_exportWouldTruncate(session)) {
        var streamBytes = await exportCameraSlpStreaming(
            session, cameraName, reprojAsUser, videoFileInfo, instanceFilter);
        return new Blob([streamBytes], { type: 'application/x-hdf5' });
    }
    var labels = buildSlpLabels(session, cameraName, reprojAsUser, videoFileInfo, instanceFilter);
    // PR 5.2: export sleap-io.js's raw bytes directly. SLEAP >= 1.6.0 (sleap-io
    // >= 0.7.0) reads the flat-matrix `field_names` layout natively (#378), so
    // the old v0.6-compat compound-rewrite post-pass is gone.
    var bytes = await SIO.saveSlpToBytes(labels);
    return new Blob([bytes], { type: 'application/x-hdf5' });
}

/**
 * Build a multi-session SLP Labels: one video per (session, camera) selection,
 * track list is the alphabetical union of track names across all selected sessions,
 * skeleton must match across sessions.
 *
 * @param {Array<{session, cameraName, videoFileInfo}>} selections
 * @param {boolean|null} reprojAsUser
 * @param {object} [instanceFilter]
 * @returns {SIO.Labels}
 */
/** Normalize a Skeleton's node list to an array of plain name strings. */
function _skelNodeNames(skeleton) {
    return (skeleton.nodes || []).map(function (n) {
        return typeof n === 'string' ? n : (n.name || '');
    });
}

/**
 * Validate that every selection in a multi-session export shares the same
 * skeleton. Compatibility is *set-based* — the same node names in a different
 * order are compatible (the export remaps each session's points into the
 * canonical order), matching `validateSkeletonCompatibility` used on import.
 * Only a differing node count or a missing/extra node name is a true mismatch.
 *
 * Returns `null` when the skeletons are compatible, otherwise a human-readable
 * mismatch message.
 *
 * Pure (no SleapIO dependency) so the UI can pre-flight a multi-view download
 * — and unit tests can assert the rule — without writing an SLP.
 *
 * Real SLEAP `.slp` files routinely store the same skeleton with the nodes in
 * a different order per file, so an order-sensitive check would spuriously
 * block legitimate cross-session exports.
 *
 * @param {Array<{session}>} selections
 * @returns {string|null}
 */
export function findSkeletonMismatch(selections) {
    if (!selections || selections.length < 2) return null;
    var baseNames = _skelNodeNames(selections[0].session.skeleton);
    for (var si = 1; si < selections.length; si++) {
        var names = _skelNodeNames(selections[si].session.skeleton);
        var compat = validateSkeletonCompatibility({ nodes: baseNames }, { nodes: names });
        if (compat.error) {
            return 'Skeleton mismatch: session ' + si + ' — ' + compat.error;
        }
    }
    return null;
}

export function buildSlpLabelsMultiSession(selections, reprojAsUser, instanceFilter) {
    var SIO = window.SleapIO;
    if (!SIO) throw new Error('sleap-io.js not loaded');
    if (!selections || selections.length === 0) throw new Error('No selections provided');

    // 1. Validate skeleton compatibility (throw on mismatch).
    var mismatch = findSkeletonMismatch(selections);
    if (mismatch) throw new Error(mismatch);

    var baseSkel = selections[0].session.skeleton;
    var baseNodes = baseSkel.nodes.map(function (n) {
        return typeof n === 'string' ? n : (n.name || '');
    });

    // 2. Build skeleton from first session.
    var sioNodes = baseNodes.map(function (name) { return new SIO.Node(name); });
    var sioEdges = (baseSkel.edges || []).map(function (e) {
        return new SIO.Edge(sioNodes[e[0]], sioNodes[e[1]]);
    });
    var skeleton = new SIO.Skeleton({
        nodes: sioNodes,
        edges: sioEdges,
        name: baseSkel.name || 'skeleton',
    });

    // 3. Build alphabetical union of track names.
    var trackNameSet = {};
    var trackSources = [];
    for (var sj = 0; sj < selections.length; sj++) {
        trackSources.push(_exportTrackSource(selections[sj].session));
        var st = trackSources[sj].names || [];
        for (var tj = 0; tj < st.length; tj++) trackNameSet[st[tj]] = true;
    }
    var unionNames = Object.keys(trackNameSet).sort();
    var unionTracks = unionNames.map(function (name) { return new SIO.Track(name); });
    var trackByName = {};
    for (var ut = 0; ut < unionNames.length; ut++) trackByName[unionNames[ut]] = unionTracks[ut];

    // 4. Per selection, build video + labeled frames, re-pointing track refs via name.
    var videos = [];
    var labeledFrames = [];
    var numNodes = baseNodes.length;

    for (var sel = 0; sel < selections.length; sel++) {
        var session = selections[sel].session;
        var cameraName = selections[sel].cameraName;
        var trackSource = trackSources[sel];
        // See buildSlpLabels's identical normalization: a lazy session before
        // "Load Videos" (or a calibration-only camera) has no attached video
        // file — a real, reachable case, not just a test artifact.
        var videoFileInfo = selections[sel].videoFileInfo || {};

        // Per-session node remap: when this session's skeleton has the same
        // node set as the canonical (first) skeleton but in a different order,
        // its instance points must be re-indexed into the canonical order
        // before they are written under the shared skeleton. nodeOrder[c] =
        // this session's local point index for canonical node c (null = no
        // remap needed, i.e. identical order or the first session).
        var nodeOrder = null;
        if (sel > 0) {
            var selNames = _skelNodeNames(session.skeleton);
            var compat = validateSkeletonCompatibility({ nodes: baseNodes }, { nodes: selNames });
            if (compat.error) throw new Error('Skeleton mismatch: session ' + sel + ' — ' + compat.error);
            if (compat.reorderMap) {
                nodeOrder = new Array(numNodes);
                for (var rm = 0; rm < compat.reorderMap.length; rm++) {
                    nodeOrder[compat.reorderMap[rm]] = rm;
                }
            }
        }

        var cv = cameraExportVideo(session, cameraName, videoFileInfo);
        var videoFilename = cv.filename;
        var vw = cv.width;
        var vh = cv.height;
        var fc = cv.frames;
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
        videos.push(video);

        var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });
        for (var fi = 0; fi < allFrameIndices.length; fi++) {
            var frameIdx = allFrameIndices[fi];
            var fg = session.frameGroups.get(frameIdx);

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

            var reprojInstances = [];
            if (!instanceFilter || instanceFilter.reprojected !== false) {
                var groups = session.instanceGroups.get(frameIdx);
                if (groups) {
                    for (var gi = 0; gi < groups.length; gi++) {
                        var reprojInst = getOrComputeReprojectedInstance(groups[gi], cameraName);
                        if (reprojInst) reprojInstances.push(reprojInst);
                    }
                }
            }

            if (groupedInstances.length === 0 && ungroupedInstances.length === 0 && reprojInstances.length === 0) continue;

            var frameInstances = [];
            // Tracks already placed in THIS frame (see buildSlpLabels).
            var usedTrackIdx = {};

            for (var ii = 0; ii < groupedInstances.length; ii++) {
                var inst = groupedInstances[ii];
                var instIsPred = inst.type === 'predicted';
                var instScore = inst.score != null ? inst.score : 1.0;
                var pts = _buildSioPoints(inst, numNodes, instIsPred ? instScore : undefined, nodeOrder);
                var instTrack = null;
                var instTrackIdx = trackSource.resolve(inst, cameraName, frameIdx);
                if (trackSource.fromIdentity && instTrackIdx != null && usedTrackIdx[instTrackIdx]) instTrackIdx = null;
                if (instTrackIdx != null) {
                    instTrack = trackByName[trackSource.names[instTrackIdx]] || null;
                }
                if (instTrack) usedTrackIdx[instTrackIdx] = true;

                if (inst.type === 'user') {
                    frameInstances.push(new SIO.Instance({ points: pts, skeleton: skeleton, track: instTrack }));
                } else {
                    frameInstances.push(new SIO.PredictedInstance({ points: pts, skeleton: skeleton, track: instTrack, score: instScore }));
                }
            }

            // Ungrouped (unlinked) instances keep their own track too (skip a
            // track a grouped instance already holds this frame).
            for (var ugi = 0; ugi < ungroupedInstances.length; ugi++) {
                var ugInst = ungroupedInstances[ugi];
                var ugIsPred = ugInst.type === 'predicted';
                var ugScore = ugInst.score != null ? ugInst.score : 1.0;
                var ugPts = _buildSioPoints(ugInst, numNodes, ugIsPred ? ugScore : undefined, nodeOrder);
                var ugTrack = null;
                var ugTrackIdx = trackSource.resolve(ugInst, cameraName, frameIdx);
                if (ugTrackIdx != null && !usedTrackIdx[ugTrackIdx]) {
                    ugTrack = trackByName[trackSource.names[ugTrackIdx]] || null;
                    if (ugTrack) usedTrackIdx[ugTrackIdx] = true;
                }

                if (ugInst.type === 'user') {
                    frameInstances.push(new SIO.Instance({ points: ugPts, skeleton: skeleton, track: ugTrack }));
                } else {
                    frameInstances.push(new SIO.PredictedInstance({ points: ugPts, skeleton: skeleton, track: ugTrack, score: ugScore }));
                }
            }

            if (reprojAsUser !== null) {
                for (var ri = 0; ri < reprojInstances.length; ri++) {
                    var rInst = reprojInstances[ri];
                    var rScore = rInst.score != null ? rInst.score : 1.0;
                    var rPts = _buildSioPoints(rInst, numNodes, reprojAsUser ? undefined : rScore, nodeOrder);

                    if (reprojAsUser) {
                        frameInstances.push(new SIO.Instance({ points: rPts, skeleton: skeleton, track: null }));
                    } else {
                        frameInstances.push(new SIO.PredictedInstance({ points: rPts, skeleton: skeleton, track: null, score: rScore }));
                    }
                }
            }

            labeledFrames.push(new SIO.LabeledFrame({
                video: video,
                frameIdx: frameIdx,
                instances: frameInstances,
            }));
        }
    }

    return new SIO.Labels({
        labeledFrames: labeledFrames,
        videos: videos,
        skeletons: [skeleton],
        tracks: unionTracks,
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    });
}

/**
 * Export a multi-session 2D SLP: one file containing multiple videos,
 * one per (session, camera) selection, with a unioned track list.
 *
 * @param {Array<{session, cameraName, videoFileInfo}>} selections
 * @param {boolean|null} reprojAsUser
 * @param {object} [instanceFilter]
 * @param {object} [opts]
 * @param {function(number, number): (Promise|void)} [opts.onProgress]  frames swept
 *   of total, only on the streaming path (a lazy project that would truncate); the
 *   other paths are one step each and never call it. Throwing from it aborts.
 * @returns {Promise<Blob>}
 */
export async function exportSlpMultiSession(selections, reprojAsUser, instanceFilter, opts) {
    var SIO = window.SleapIO;
    if (!SIO) throw new Error('sleap-io.js not loaded');

    // Single lazy-session camera (the per-camera Download-All case), plain export →
    // lazy fast-path (all frames, bounded) instead of the eager multi-session build.
    // See instanceFilterAllowsLazyFastPath's doc for why this must NOT be a plain
    // `!instanceFilter` check.
    if (selections && selections.length === 1 && !reprojAsUser && instanceFilterAllowsLazyFastPath(instanceFilter)) {
        var lazyBytes = await lazyCameraExportBytes(SIO, selections[0].session, selections[0].cameraName);
        if (lazyBytes) return new Blob([lazyBytes], { type: 'application/x-hdf5' });
    }

    // One selection = one (session, camera) = exactly what the streaming
    // per-camera exporter handles. This is the "Export Per Session" / "By Cam"
    // shape for a single-session project, which is the case that was truncating.
    if (selections.length === 1 && _exportWouldTruncate(selections[0].session)) {
        var oneBytes = await exportCameraSlpStreaming(
            selections[0].session, selections[0].cameraName, reprojAsUser,
            selections[0].videoFileInfo, instanceFilter,
            { onProgress: opts && opts.onProgress });
        return new Blob([oneBytes], { type: 'application/x-hdf5' });
    }
    // Multi-selection (several sessions/cameras into ONE file) still has no
    // streaming implementation — it needs a multi-video writer header and a
    // per-selection sweep. Refuse rather than truncate.
    assertExportCoversProject(selections);
    var labels = buildSlpLabelsMultiSession(selections, reprojAsUser, instanceFilter);
    var bytes = await SIO.saveSlpToBytes(labels);   // PR 5.2: raw output (no v0.6 post-pass)
    return new Blob([bytes], { type: 'application/x-hdf5' });
}

/**
 * Refuse an export that the eager builder would silently truncate.
 *
 * `buildSlpLabelsMultiSession` (and `buildSlpLabels`) iterate `session.frameGroups`
 * — the RESIDENT map. On a lazily-loaded project that is a handful of frames (31
 * of 180,210 measured), so the export writes a structurally valid `.slp` holding
 * ~0.02% of the labels and reports success. `lazyCameraExportBytes` above avoids
 * that by re-emitting the columnar store verbatim, but it only applies to a
 * single plain selection, and it deliberately bails whenever a resident frame
 * carries a USER instance — because the store has no notion of a live correction.
 *
 * That last case is the common one, not an edge case: correcting predictions is
 * what this app is for, so "export after correcting anything" fell straight
 * through to the truncating path. Worse, the large-project save warning in
 * `import-export/save-load.js` actively recommends these exporters as the safe
 * alternative to a merged save.
 *
 * The real fix is a streaming per-camera exporter that merges store predictions
 * with the resident user-correction overlay — the machinery
 * `slp-streaming-write.js` already runs for the project save, but it is built
 * around a whole-session ref graph and needs a camera filter to be reusable here.
 * Until that exists, refuse loudly rather than write a plausible, mostly-empty
 * file (the precedent set by `assertJsonSaveCoversProject` and the mixed-project
 * save guard).
 *
 * @param {Array<{session, cameraName}>} selections
 */
function _exportWouldTruncate(session) {
    var loader = session && session.lazyLoader;
    if (!loader) return false;                       // fully resident: nothing to lose
    var total = loader.nFrames || 0;
    var resident = session.frameGroups ? session.frameGroups.size : 0;
    return total > 0 && resident < total;
}

function assertExportCoversProject(selections) {
    var truncated = [];
    for (var i = 0; i < (selections || []).length; i++) {
        var session = selections[i] && selections[i].session;
        var loader = session && session.lazyLoader;
        if (!loader) continue;                       // fully resident: nothing to lose
        var total = loader.nFrames || 0;
        var resident = session.frameGroups ? session.frameGroups.size : 0;
        if (total > 0 && resident < total) {
            truncated.push('"' + (session.name || 'session ' + i) + '" / ' +
                selections[i].cameraName + ' (' + resident.toLocaleString() + ' of ' +
                total.toLocaleString() + ' frames in memory)');
        }
    }
    if (truncated.length === 0) return;
    throw new Error(
        'This export would only contain the frames currently in memory — ' +
        truncated.join('; ') + ' — because it cannot use the whole-project fast ' +
        'path. That happens when more than one camera/session is selected, when ' +
        'reprojections are included, or when any loaded frame has a manual ' +
        'correction. Export a single camera with reprojections turned off, or use ' +
        'File → Save As to write the whole project.'
    );
}

/** Keypoints per pooled column chunk in `makePooledSioInstances`. */
var SIO_POOL_CHUNK_POINTS = 65536;

/**
 * Make the sleap-io.js instances of one `buildSlpLabelsAllViews` build with
 * their keypoints in SHARED column chunks — one object per instance and
 * nothing else in V8's heap.
 *
 * A plain `new SIO.Instance({ points })` costs ~0.93 KB of V8 heap per 2D
 * instance (1,289 MB for the 1,390,390 of a 17-camera recording, held for the
 * whole save): an object with 17 fields, four typed arrays each with its own
 * ArrayBuffer, and a `_names` array of `undefined`s, because the points
 * `_buildSioPoints` hands it carry no `name`. Building those points first
 * allocated another ~3.7 KB of garbage per instance. Here the values go
 * straight into pooled `Float64Array`/`Uint8Array` chunks, and the instance is
 * an object holding its track, its score, its chunk and its offset; `_xy`,
 * `_visible`, `_complete` and `_score` are getters on the prototype that return
 * a view of its slice — what the vendored writer reads (`emitInstancePointsInto`,
 * LUCID local patch luc3d eager-save), and what `points`' PointViews read and
 * write through.
 *
 * The VALUES are exactly `_buildSioPoints`' followed by `Instance._ingest`, so
 * the written file is unchanged: a missing node is NaN/invisible/incomplete, a
 * nulled one keeps its position and is invisible but complete, and a
 * prediction's node carries its own score, else the instance score (1 when it
 * has none). A user instance has no score column, as before.
 *
 * The prototypes inherit from the real `SIO.Instance` / `SIO.PredictedInstance`
 * (so `instanceof` and every method work), and take every field default from a
 * real instance built with `new` — so a field a future sleap-io.js adds still
 * starts at its own default rather than `undefined`. Assigning one of the four
 * columns (a `points =` setter) gives that instance its own array, as usual.
 *
 * @returns {(inst: Instance, track: Object|null) => Object}
 */
export function makePooledSioInstances(SIO, skeleton, numNodes) {
    function viewProp(proto, name, get) {
        Object.defineProperty(proto, name, {
            configurable: true,
            get: get,
            set: function (v) {
                Object.defineProperty(this, name, { value: v, writable: true, enumerable: true, configurable: true });
            },
        });
    }
    function makeProto(Base, predicted) {
        var proto = Object.create(Base.prototype);
        var template = new Base({ points: [], skeleton: skeleton });
        var keys = Object.keys(template);
        for (var k = 0; k < keys.length; k++) proto[keys[k]] = template[keys[k]];
        proto.skeleton = skeleton;
        proto._n = numNodes;
        proto._names = null;
        viewProp(proto, '_xy', function () { var o = this._o; return this._c.xy.subarray(o << 1, (o + numNodes) << 1); });
        viewProp(proto, '_visible', function () { var o = this._o; return this._c.visible.subarray(o, o + numNodes); });
        viewProp(proto, '_complete', function () { var o = this._o; return this._c.complete.subarray(o, o + numNodes); });
        if (predicted) {
            viewProp(proto, '_score', function () { var o = this._o; return numNodes > 0 ? this._c.score.subarray(o, o + numNodes) : null; });
        } else {
            proto._score = null;
        }
        return proto;
    }
    var userProto = makeProto(SIO.Instance, false);
    var predProto = makeProto(SIO.PredictedInstance, true);

    var chunk = null;
    return function (inst, track) {
        var predicted = inst.type !== 'user';
        if (!chunk || chunk.used + numNodes > chunk.cap) {
            var cap = Math.max(SIO_POOL_CHUNK_POINTS, numNodes);
            chunk = {
                xy: new Float64Array(2 * cap), visible: new Uint8Array(cap),
                complete: new Uint8Array(cap), score: null, cap: cap, used: 0,
            };
        }
        if (predicted && !chunk.score) chunk.score = new Float64Array(chunk.cap);
        var off = chunk.used;
        chunk.used += numNodes;
        var xy = chunk.xy, vis = chunk.visible, comp = chunk.complete;
        var sc = predicted ? chunk.score : null;
        var nulled = inst.nulledNodes || null;
        var perPointScore = inst.score != null ? inst.score : 1.0;
        var ownScores = typeof inst.pointScore === 'function';
        for (var n = 0; n < numNodes; n++) {
            var p = off + n, j = p << 1;
            if (!inst.hasPoint(n)) {
                xy[j] = NaN; xy[j + 1] = NaN; vis[p] = 0; comp[p] = 0;
            } else {
                xy[j] = inst.getX(n); xy[j + 1] = inst.getY(n);
                vis[p] = (nulled && nulled.has(n)) || inst.isOccluded(n) ? 0 : 1;
                comp[p] = 1;
            }
            if (sc) {
                var own = ownScores ? inst.pointScore(n) : NaN;
                sc[p] = Number.isFinite(own) ? own : perPointScore;
            }
        }
        var out = Object.create(predicted ? predProto : userProto);
        out.track = track;
        if (predicted) out.score = inst.score || 0;
        out._c = chunk;
        out._o = off;
        return out;
    };
}

/**
 * Build a sleap-io.js Labels object for all camera views.
 *
 * @param {Session} session
 * @param {Array} views - Array of view objects with .name, .videoWidth, .videoHeight, .frameCount
 * @param {Array} videoFiles - Array of videoFile objects
 * @returns {Object} sleap-io.js Labels instance
 */
export function buildSlpLabelsAllViews(session, views, videoFiles) {
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
    // Per-session identities — see buildSlpBytes in save-load.js. The
    // file-level identities_json is a cross-session concatenation, so the
    // per-session list must be persisted here and preferred on import to keep
    // IDs scoped per session.
    var sessIdentitiesJson = [];
    if (session.identities && session.identities.length > 0) {
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
        frameIdentityMap: [],   // filled by writeFrameIdentityMetadata below
        identities: sessIdentitiesJson,
        skeleton: {
            name: session.skeleton.name || 'skeleton',
            nodes: session.skeleton.nodes,
            edges: session.skeleton.edges,
        },
        tracks: session.tracks,
    };
    // `frameIdentityMap`, minus what the instance groups already imply.
    writeFrameIdentityMetadata(sioSession.metadata.lucid, session);
    // Session-scoped Visibility-panel state. Every one of these is written ONLY
    // when it holds a non-default value, so an untouched project's bytes are
    // unchanged (tests/e2e/save-golden-digest.mjs).
    writeVisibilityMetadata(sioSession.metadata.lucid, session);
    // Define Planes state: the project-scoped pool/planes/origin (identical in
    // every session's dict) plus THIS session's per-view 2D. Same omit-the-
    // defaults rule, so a project that never opened the feature is unchanged.
    writePlaneMetadata(sioSession.metadata.lucid, session);
    // Temporal Smoothing's last run, only while something is smoothed.
    writeSmoothingMetadata(sioSession.metadata.lucid, session);
    session.cameras.forEach(function (cam, i) {
        sioSession.addVideo(sioVideos[i], sioCameras[i]);
    });

    // 6. Build labeled frames and session FrameGroups
    //    Key optimization: create each SIO.Instance once and share between
    //    LabeledFrames and InstanceGroups to avoid doubling memory usage.
    var labeledFrames = [];
    var numNodes = session.skeleton.nodes.length;
    var allFrameIndices = Array.from(session.frameGroups.keys()).sort(function (a, b) { return a - b; });
    var newSioInstance = makePooledSioInstances(SIO, skeleton, numNodes);

    for (var fi = 0; fi < allFrameIndices.length; fi++) {
        var frameIdx = allFrameIndices[fi];
        var fg = session.frameGroups.get(frameIdx);

        // Build SIO instances once per lucid instance, keyed by object identity
        // so we can reuse them in both LabeledFrames and InstanceGroups
        var lucidToSio = new Map(); // lucid Instance → SIO Instance

        function _getOrCreateSioInst(inst) {
            var existing = lucidToSio.get(inst);
            if (existing) return existing;
            // A prediction's points carry a score — each node's own, else the
            // instance score, as the other two writers do. Without one the
            // file stored 0 for every node, so a reopened project's node
            // tooltip said `(score: 0.00)` for every prediction.
            // `null >= 0` is true in JS; explicit guard prevents tracks[null]
            // = undefined leaking into SIO.Instance for trackless instances.
            var track = (inst.trackIdx != null && inst.trackIdx >= 0 && inst.trackIdx < tracks.length) ? tracks[inst.trackIdx] : null;
            var sioInst = newSioInstance(inst, track);
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
            // Shape-agnostic on purpose: LUCID always produces a flat
            // Float64Array now, and the vendored writer consumes that directly
            // (LUCID local patch, luc3d #189) with no boxing — but it still
            // accepts boxed rows, so don't reject them here.
            if (group.points3d && group.points3d.length > 0) {
                instance3d = new SIO.Instance3D({ points: group.points3d, skeleton: skeleton });
                // Temporal Smoothing's source (smoothing-metadata.js): the vendored
                // writer stores it row-parallel to `points_3d`.
                var unsmoothed = smoothingSourceFor(group);
                if (unsmoothed) instance3d.lucidUnsmoothed = unsmoothed;
            }

            // Resolve identity
            var identity = undefined;
            if (group.identityId != null && group.identityId >= 0) {
                identity = lucidIdToSioId.get(group.identityId);
            }

            // Collect per-instance lucid metadata for precise round-trip.
            // `identityId` is the PER-SESSION identity index (LUCID scopes
            // identities per session). It is persisted here — not relied upon
            // from the canonical `identity_idx`/`ig.identity`, which resolve
            // against the file-level (cross-session concat) identity list and so
            // mis-scope for multi-session files. The typed importer reads this
            // back (see reconstructInstanceGroupsFromSession).
            //
            // SLIM METADATA (#134): only NON-reconstructable per-instance fields
            // are written, and only when set. `trackIdx` (from the instance's
            // track ref), `type` (Instance vs PredictedInstance), `score`
            // (PredictedInstance.score), and `occluded` (from point visibility)
            // are ALL derivable from the standard SLP instance on load, so
            // writing them per instance per frame just bloated `sessions_json`
            // (the "invalid string length" cap). `modified` (LUCID edit flag,
            // absent from standard SLP) and `nulledNodes` are the only fields
            // kept — sparse, so most grouped instances now emit NO metadata.
            var igLucidMeta = {
                instanceMeta: {},
                identityId: (group.identityId != null && group.identityId >= 0) ? group.identityId : -1,
            };
            // Which solver produced this group's 3D. NOT reconstructable from the
            // file — `points_3d` is just numbers — so it must be persisted or a
            // reopened project has BA 3D with an unknown method. That breaks two
            // things: `ui/rendering.js`'s lazy fill re-derives reprojections with
            // DLT and then displays DLT's error for BA 3D, and `adoptPrior3d` can
            // never match, so every regroup needlessly re-solves. Written only when
            // 'ba'; absent means DLT, which keeps `sessions_json` slim (#134).
            if (group.triangulationMethod === 'ba') igLucidMeta.triangulationMethod = 'ba';
            for (var [metaCam, metaInst] of group.instances) {
                var instMeta = {};
                var hasMeta = false;
                if (metaInst.modified) { instMeta.modified = true; hasMeta = true; }
                if (metaInst.nulledNodes && metaInst.nulledNodes.size > 0) {
                    instMeta.nulledNodes = Array.from(metaInst.nulledNodes);
                    hasMeta = true;
                }
                if (hasMeta) igLucidMeta.instanceMeta[metaCam] = instMeta;
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
 * `points_3d` (n_frames, n_tracks, n_nodes, 3) and `reprojection_error`
 * (n_frames, n_tracks, n_nodes), float64, NaN = none; n_frames = the frames
 * with 3D, n_tracks = the identities (`reprojTrackAxis`).
 *
 * Written in windows of frames into chunked, gzip-1 datasets, like
 * `buildReprojH5`: building both arrays at once (and boxed per node first)
 * took a lazily opened 135,219-frame project from 2.3 to 3.8 GB of heap.
 *
 * @param {Session} session
 * @param {Object} [opts]
 * @param {function(number, number): (Promise|void)} [opts.onProgress]
 *        (framesDone, nFrames), awaited after each window (paint the card here)
 * @returns {Promise<Blob>} The .h5 file as a Blob
 */
export async function buildPoints3dH5(session, opts) {
    opts = opts || {};
    const mod = await initH5wasm();
    const fname = 'export_points3d.h5';

    const axis = reprojTrackAxis(session);
    const trackNames = axis.names;
    const nodeNames = session.skeleton.nodes.slice();
    const frameIndices = points3dExportFrames(session, axis);
    const nFrames = frameIndices.length;
    const nTracks = trackNames.length;
    const nNodes = nodeNames.length;
    const perFrame = nTracks * nNodes;   // reprojection_error; points_3d is 3×
    const ptsTail = [nTracks, nNodes, 3];
    const errTail = [nTracks, nNodes];

    const f = new mod.File(fname, 'w');
    try {
        if (perFrame === 0 || nFrames === 0) {
            // Nothing to chunk (HDF5 chunks cannot have a zero dimension).
            f.create_dataset({name: 'points_3d', data: new Float64Array(0), shape: [nFrames].concat(ptsTail)});
            f.create_dataset({name: 'frame_indices', data: new Float64Array(frameIndices)});
            f.create_dataset({name: 'reprojection_error', data: new Float64Array(0), shape: [nFrames].concat(errTail)});
        } else {
            const chunkFrames = Math.min(nFrames, reprojChunkFrames(perFrame * 3));
            // A window is whole chunks, so no chunk is compressed twice.
            const winFrames = chunkFrames * Math.max(1, Math.floor(4194304 / (chunkFrames * perFrame * 3)));
            const ptsDs = createFramesDataset(f, 'points_3d', nFrames, ptsTail, chunkFrames);
            f.create_dataset({name: 'frame_indices', data: new Float64Array(frameIndices)});
            const errDs = createFramesDataset(f, 'reprojection_error', nFrames, errTail, chunkFrames);
            const ptsWin = new Float64Array(winFrames * perFrame * 3);
            // No per-node error is kept, so the error dataset is all NaN.
            const errWin = new Float64Array(winFrames * perFrame).fill(NaN);
            const ptsSel = [[0, 0], [0, nTracks], [0, nNodes], [0, 3]];
            const errSel = [[0, 0], [0, nTracks], [0, nNodes]];
            for (var w0 = 0; w0 < nFrames; w0 += winFrames) {
                var w1 = Math.min(nFrames, w0 + winFrames);
                var buf = ptsWin.subarray(0, (w1 - w0) * perFrame * 3);
                buf.fill(NaN);
                for (var fi = w0; fi < w1; fi++) {
                    fillPoints3dFrame(buf, (fi - w0) * perFrame * 3, session.instanceGroups.get(frameIndices[fi]),
                        axis.index, nTracks, nNodes);
                }
                ptsSel[0] = [w0, w1];
                ptsDs.write_slice(ptsSel, buf);
                errSel[0] = [w0, w1];
                errDs.write_slice(errSel, errWin.subarray(0, (w1 - w0) * perFrame));
                if (opts.onProgress) await opts.onProgress(w1, nFrames);
            }
        }
        f.create_dataset({name: 'track_names', data: trackNames});
        f.create_dataset({name: 'node_names', data: nodeNames});

        f.close();
        return h5FileToBlob(fname);
    } catch (err) {
        try { f.close(); } catch (e) { /* already closed */ }
        throw err;
    } finally {
        // The finished file is in the Blob; don't keep a copy in h5wasm's MEMFS.
        try { mod.FS.unlink(fname); } catch (e) { /* not there */ }
    }
}

/**
 * A float64 dataset of `nFrames` × `tail`, chunked by `chunkFrames` frames and
 * gzip-1, for writing in windows of frames with `write_slice`.
 */
function createFramesDataset(f, name, nFrames, tail, chunkFrames) {
    f.create_dataset({
        name: name,
        data: new Float64Array(0),
        shape: [0].concat(tail),
        maxshape: [null].concat(tail),
        chunks: [chunkFrames].concat(tail),
        dtype: '<d',   // not '<f8': h5wasm reads that as float32
        compression: 'gzip',
        compression_opts: 1,
    });
    const ds = f.get(name);
    ds.resize([nFrames].concat(tail));
    return ds;
}

// ============================================
// Reprojections HDF5 export (in-browser)
// ============================================

/**
 * Frames per HDF5 chunk of `reprojections`: as many as fit in ~1 MB of float64
 * (436 for 2 animals × 5 cameras × 15 nodes), at least one.
 */
export function reprojChunkFrames(perFrame) {
    return Math.max(1, Math.floor(131072 / Math.max(1, perFrame)));
}

/**
 * The `reprojections` track axis: one entry per identity (a group is placed by
 * its identity), in `session.identities` order; without identities, the
 * session's tracks as before. `index` maps an identity id to its position.
 */
export function reprojTrackAxis(session) {
    var ids = session.identities || [];
    if (ids.length > 0) {
        var index = new Map();
        ids.forEach(function (id, i) { index.set(id.id, i); });
        return { names: ids.map(function (id) { return id.name; }), index: index };
    }
    var names = session.tracks.slice();
    return { names: names, index: null };
}

/**
 * Build a reprojections.h5 HDF5 file as a Blob.
 * Contains 2D reprojected points per camera.
 * Shape: (n_frames, n_tracks, n_cameras, n_nodes, 2), float64, NaN = none;
 * n_tracks = the identities (`reprojTrackAxis`).
 *
 * Written in windows of frames into a chunked, gzip-1 dataset, so neither the
 * JS heap nor h5wasm's 2 GB heap ever holds the whole array: a 135,181-frame,
 * 5-camera recording built it as one 4.7 GB Float64Array (sized by every
 * tracklet instead of the identities) and failed. Values, shape and dtype are
 * what any HDF5 reader expects; only the storage is chunked.
 *
 * @param {Session} session
 * @param {Object} [opts]
 * @param {function(number, number): (Promise|void)} [opts.onProgress]
 *        (framesDone, nFrames), awaited after each window (paint the card here)
 * @returns {Promise<Blob>} The .h5 file as a Blob
 */
export async function buildReprojH5(session, opts) {
    opts = opts || {};
    const mod = await initH5wasm();
    const fname = 'export_reprojections.h5';

    const cameras = session.cameras;
    const nodeNames = session.skeleton.nodes;
    const axis = reprojTrackAxis(session);
    const trackNames = axis.names;
    const nCameras = cameras.length;
    const nNodes = nodeNames.length;
    const nTracks = trackNames.length;
    const cameraNames = cameras.map(function (c) { return c.name; });

    // Collect frames sorted
    const sortedFrameIndices = Array.from(session.instanceGroups.keys()).sort(function (a, b) { return a - b; });
    const nFrames = sortedFrameIndices.length;
    const perFrame = nTracks * nCameras * nNodes * 2;
    const tail = [nTracks, nCameras, nNodes, 2];

    const f = new mod.File(fname, 'w');
    try {
        if (perFrame === 0 || nFrames === 0) {
            // Nothing to chunk (HDF5 chunks cannot have a zero dimension).
            f.create_dataset({name: 'reprojections', data: new Float64Array(0), shape: [nFrames].concat(tail)});
        } else {
            const chunkFrames = Math.min(nFrames, reprojChunkFrames(perFrame));
            // A window is whole chunks, so no chunk is compressed twice.
            const winFrames = chunkFrames * Math.max(1, Math.floor(4194304 / (chunkFrames * perFrame)));
            const ds = createFramesDataset(f, 'reprojections', nFrames, tail, chunkFrames);
            const win = new Float64Array(winFrames * perFrame);
            const sel = [[0, 0], [0, nTracks], [0, nCameras], [0, nNodes], [0, 2]];
            for (var w0 = 0; w0 < nFrames; w0 += winFrames) {
                var w1 = Math.min(nFrames, w0 + winFrames);
                var buf = win.subarray(0, (w1 - w0) * perFrame);
                buf.fill(NaN);
                for (var fi = w0; fi < w1; fi++) {
                    fillReprojFrame(buf, (fi - w0) * perFrame, session.instanceGroups.get(sortedFrameIndices[fi]),
                        axis.index, nTracks, cameras, cameraNames, nNodes);
                }
                sel[0] = [w0, w1];
                ds.write_slice(sel, buf);
                if (opts.onProgress) await opts.onProgress(w1, nFrames);
            }
        }
        f.create_dataset({name: 'frame_indices', data: new Float64Array(sortedFrameIndices)});
        f.create_dataset({name: 'track_names', data: trackNames});
        f.create_dataset({name: 'node_names', data: nodeNames.slice()});
        f.create_dataset({name: 'camera_names', data: cameraNames});

        f.close();
        return h5FileToBlob(fname);
    } catch (err) {
        try { f.close(); } catch (e) { /* already closed */ }
        throw err;
    } finally {
        // The finished file is in the Blob; don't keep a copy in h5wasm's MEMFS.
        try { mod.FS.unlink(fname); } catch (e) { /* not there */ }
    }
}

/** One frame's groups into `buf` at `base` (layout: track, camera, node, xy). */
function fillReprojFrame(buf, base, groups, idIndex, nTracks, cameras, cameraNames, nNodes) {
    if (!groups) return;
    const nCameras = cameras.length;
    for (var group of groups) {
        var idIdx = trackAxisRow(group, idIndex, nTracks);
        if (idIdx < 0) continue;
        // A group's reprojections are derived and kept only for frames
        // that have been shown (Triangulate All stores none — see
        // `sweepTriangulateAllFrames` in pose/triangulation.js), so
        // project its stored 3D for the rest rather than skipping them.
        var stored = group.reprojections;
        if (!stored && points3dNodeCount(group.points3d) === 0) continue;
        for (var ci = 0; ci < nCameras; ci++) {
            var reprojPts = stored ? stored[cameraNames[ci]]
                : (cameras[ci].projectionMatrix ? reprojectPointsCamera(group.points3d, cameras[ci]) : null);
            if (!reprojPts) continue;
            var cbase = base + ((idIdx * nCameras + ci) * nNodes) * 2;
            for (var ni = 0; ni < Math.min(nNodes, reprojPts.length); ni++) {
                var rpt = reprojPts[ni];
                if (rpt) {
                    buf[cbase + ni * 2] = rpt[0];
                    buf[cbase + ni * 2 + 1] = rpt[1];
                }
            }
        }
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
 * @param {{columnar?: boolean}} [opts] - `columnar: true` asks the worker for
 *   the pose data as flat TRANSFERRED typed arrays (`data.columnar`, see
 *   `buildColumnarFrames` in loading/slp-import-worker.js) instead of the nested
 *   `data.frames` objects, which are expensive to structured-clone. Only callers
 *   that read `data.columnar` should ask for it; `data.frames` is then empty.
 * @returns {Promise<Object>} Raw parsed data from worker
 */
export function parseSlpH5(file, onProgress, opts) {
    return new Promise(function (resolve, reject) {
        // Resolve worker URL relative to the document base so this works on
        // sub-path deployments (e.g. GitHub Pages /luc3d/, /luc3d/pr/N/) as well
        // as localhost. We use document.baseURI rather than `new URL(..., import.meta.url)`
        // (first because a since-retired vm test runner could not parse `import.meta`).
        // See ISSUES.md I-8.
        var workerUrl = new URL('loading/slp-import-worker.js?v=' + Date.now(), document.baseURI);
        var worker = new Worker(workerUrl, { type: 'module' });

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

        worker.postMessage({ type: 'parse', file: file, columnar: !!(opts && opts.columnar) });
    });
}

/**
 * Parse a SLEAP .slp file through sleap-io.js's streaming reader
 * (`readSlpStreaming`, PR #196) and adapt the typed `Labels` into the SAME
 * `slpData` shape that `parseSlpH5` (the raw-h5wasm worker) resolves to, so the
 * downstream importers (`slp-import.js`, `slp-merge.js`) are unchanged.
 *
 * This is the read-path half of the sleap-io.js migration (PR 5.1). The heavy
 * pose datasets (`points`/`pred_points`/`instances`/`frames`) are read by the
 * reader's own worker (off-thread) and materialized here via a single transform
 * (typed `Instance._xy`/`_visible` → LUCID `points[]` + parallel `occluded[]`,
 * NOT `numpy()` which zeroes invisible points to NaN — see
 * scratch/.../12-import-consumer-spec.md §3).
 *
 * Each `sessions[]` entry is the verbatim on-disk `sessions_json` dict (for the
 * direct calibration / video-map / `metadata.lucid` reads in handleLoadSlpFile)
 * PLUS a `_typedSession` ref (the typed `RecordingSession`). Grouping is rebuilt
 * from that typed session by `reconstructInstanceGroupsFromSession`, which reads
 * both LUCID's legacy and the new canonical `sessions_json` (the raw dict is kept
 * for the legacy per-group `identity_idx` fallback — see 13-pr51-probe-findings.md)
 * and a `_typedIdentities` ref (the file's typed `/identity` catalog, which the
 * typed groups' `identity` resolves into — the `identity_idx` fallback for files
 * written by other tools, e.g. campy-live-export).
 *
 * The reader's own HDF5 I/O worker loads `h5wasm` via `importScripts`, so it
 * needs an **IIFE** build — pointed at LUCID's LOCAL vendored `h5wasm.iife.js`
 * (0.10.3) via `h5wasmUrl`, so no h5wasm is fetched from a CDN (PR 5.2b h5wasm
 * consolidation). Passing the `File` directly lets the reader stream (range
 * reads) instead of buffering the whole file. Runs on the calling (main) thread —
 * the reader spins its OWN worker for HDF5 I/O, so this must NOT be called from
 * inside another worker (nested workers are unsupported on older Safari).
 *
 * NOTE: `loadAnalysisH5` (SLEAP `.analysis.h5`) and embedded-frame extraction
 * are NOT covered by `readSlpStreaming`; callers keep `parseSlpH5` for those
 * (this adapter is SLP-only, additive).
 *
 * @param {File} file - The .slp file
 * @param {Function} [onProgress] - Optional progress callback `(msg) => void`
 * @returns {Promise<Object>} `slpData` matching parseSlpH5's result shape
 */
export async function parseSlpViaSleapIO(file, onProgress) {
    var SIO = window.SleapIO;
    if (!SIO || typeof SIO.readSlpStreaming !== 'function') {
        throw new Error('sleap-io.js readSlpStreaming not available on window.SleapIO');
    }
    var PredictedInstance = SIO.PredictedInstance;

    var report = function (msg) { if (onProgress) onProgress(msg); };
    report('Reading SLP (streaming)...');

    var labels = await SIO.readSlpStreaming(file, {
        openVideos: false,
        rawSessions: true, // capture verbatim sessions_json (legacy-identity fallback)
        // Point the reader's importScripts I/O worker at LUCID's LOCAL h5wasm IIFE
        // (0.10.3) so it doesn't fetch h5wasm from a CDN. document.baseURI keeps
        // this correct on sub-path deployments (GitHub Pages /luc3d/...).
        h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js?v=ecdf4c85283a', document.baseURI).href,
        onProgress: function (n, total, message) {
            report((message || ('Reading SLP ' + n + '/' + total)) + '...');
        },
    });

    // --- skeleton ---
    var skel = (labels.skeletons && labels.skeletons[0]) || null;
    var skeleton = skel
        ? { name: skel.name || 'skeleton', nodes: skel.nodeNames, edges: skel.edgeIndices }
        : { name: 'skeleton', nodes: [], edges: [] };
    var numNodes = skeleton.nodes.length;

    // --- tracks ---
    var typedTracks = labels.tracks || [];
    var tracks = typedTracks.map(function (t) { return t.name; });

    // --- frames[] (pose transform) ---
    // Only frames that carry at least one pose instance, matching the worker
    // (SI-worker only emits frames with >=1 instance).
    var frames = [];
    var lfs = labels.labeledFrames || [];
    for (var li = 0; li < lfs.length; li++) {
        var lf = lfs[li];
        var lfInsts = lf.instances || [];
        if (lfInsts.length === 0) continue;
        var videoIdx = labels.videos.indexOf(lf.video);
        var instances = [];
        for (var ii = 0; ii < lfInsts.length; ii++) {
            instances.push(_typedInstanceToSlpData(lfInsts[ii], typedTracks, numNodes, PredictedInstance));
        }
        frames.push({ frameIdx: lf.frameIdx, videoIdx: videoIdx, instances: instances });
    }

    // --- videos[] ---
    var videos = (labels.videos || []).map(function (v, i) {
        var srcName = null;
        if (v.sourceVideo && v.sourceVideo.filename) srcName = v.sourceVideo.filename;
        else if (v.backendMetadata && v.backendMetadata.source_filename) srcName = v.backendMetadata.source_filename;
        var embedded = !!v.hasEmbeddedImages;
        return {
            index: i,
            filename: v.filename != null ? v.filename : null,
            sourceFilename: srcName,
            backendType: embedded ? 'HDF5Video' : 'MediaVideo',
            shape: v.shape != null ? v.shape : null,
            embedded: embedded,
            dataset: (v.backendMetadata && v.backendMetadata.dataset) != null ? v.backendMetadata.dataset : null,
        };
    });

    // --- sessions[] ---
    // Each entry is the verbatim on-disk `sessions_json` dict (calibration +
    // camcorder_to_video_idx_map + metadata.lucid), which handleLoadSlpFile reads
    // directly for cameras / video map / session metadata — this works for both
    // LUCID's legacy shape and the new canonical shape. Grouping, however, is
    // reconstructed from the TYPED RecordingSession (attached as `_typedSession`)
    // via reconstructInstanceGroupsFromSession, because the canonical inline
    // `instances` dict (calibration keyed `cam_N`, 4-element points) is NOT
    // readable by the dict reconstructor. The raw dict is still carried for the
    // legacy per-group `identity_idx` fallback. The worker also flattens any
    // entry that is itself an array into separate sessions; mirror that (such
    // legacy array entries fall back to the dict reconstruction — no typed ref).
    var rawSessions = labels.rawSessionsJson || [];
    var typedSessions = labels.sessions || [];
    var sessions = [];
    for (var si = 0; si < rawSessions.length; si++) {
        var rs = rawSessions[si];
        if (rs == null) continue;
        if (Array.isArray(rs)) {
            for (var ri = 0; ri < rs.length; ri++) {
                if (rs[ri] != null) sessions.push(rs[ri]);
            }
        } else {
            sessions.push(Object.assign({}, rs, {
                _typedSession: typedSessions[si] || null,
                _typedIdentities: labels.identities || [],
            }));
        }
    }

    // --- identities[] (file-level fallback; per-session lives in
    // sessions[].metadata.lucid.identities, which the importer prefers) ---
    var identities = (labels.identities || []).map(function (id) {
        return { name: id.name, color: id.color != null ? id.color : undefined };
    });

    return {
        skeleton: skeleton,
        tracks: tracks,
        frames: frames,
        videos: videos,
        sessions: sessions,
        identities: identities,
        // The file's whole provenance dict (slp-provenance.js picks each
        // session's part).
        provenance: labels.provenance || null,
    };
}

/**
 * Adapt one typed sleap-io.js `Instance`/`PredictedInstance` into the flat
 * instance dict shape the importer expects. Reads columnar `_xy`/`_visible`
 * directly (NOT `numpy()`, which zeroes invisible points to NaN and would drop
 * occluded-but-placed keypoints LUCID must keep). Occlusion = coords present but
 * visible flag false — matching the raw worker's `!visible && finite`.
 *
 * @param {Object} inst - typed Instance or PredictedInstance
 * @param {Array} typedTracks - labels.tracks (typed Track objects) for indexOf
 * @param {number} numNodes - skeleton node count (output point-array length)
 * @param {Function} PredictedInstance - the class, for the instanceof type test
 * @returns {{trackIdx:number, score:number, type:string, points:Array, occluded:boolean[],
 *   pointScores:(Float64Array|null)}} `pointScores` is the prediction's per-node
 *   score column (the typed instance's own `_score`, by reference — the importer
 *   copies it into `Instance.setPointScores`), null for a user instance.
 */
function _typedInstanceToSlpData(inst, typedTracks, numNodes, PredictedInstance) {
    var isPred = PredictedInstance && (inst instanceof PredictedInstance);
    // inst.track === null → indexOf returns -1, the worker's trackless sentinel
    // (do NOT coerce to null here; downstream treats a number <0 as trackless).
    var trackIdx = inst.track ? typedTracks.indexOf(inst.track) : -1;
    var score = isPred ? (inst.score || 0) : 0;

    var xy = inst._xy;
    var vis = inst._visible;
    var points = new Array(numNodes);
    var occluded = new Array(numNodes);
    for (var k = 0; k < numNodes; k++) {
        var x = (xy && 2 * k + 1 < xy.length) ? xy[2 * k] : NaN;
        var y = (xy && 2 * k + 1 < xy.length) ? xy[2 * k + 1] : NaN;
        if (isFinite(x) && isFinite(y)) {
            points[k] = [x, y];
            occluded[k] = !(vis && vis[k]);
        } else {
            points[k] = null;
            occluded[k] = false;
        }
    }
    return {
        trackIdx: trackIdx,
        score: score,
        type: isPred ? 'predicted' : 'user',
        points: points,
        occluded: occluded,
        pointScores: isPred && inst._score ? inst._score : null,
    };
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
export async function parsePoints3dH5(arrayBuffer) {
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
                        // Missing keypoint — use null (the app-wide convention),
                        // NOT [NaN,NaN,NaN]. A NaN-valued point array passes the
                        // `pt == null` guards in overlays / the 3D viewport and
                        // ends up as a mesh at a NaN position, which poisons
                        // Three.js bounding-sphere / fitToScene math.
                        nodePts.push(null);
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
export function instancePointsMatch(ptsA, ptsB) {
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

/**
 * `instancePointsMatch` with a LUCID `Instance` on the left-hand side, without
 * materializing its boxed points array. `Instance` stores 2D keypoints in a flat
 * `Float64Array`, so `inst.toPointsArray()` allocates one array per node on every
 * comparison — and these comparisons run once per grouped instance per frame on
 * the SLP load dedup passes. Semantics are identical to `instancePointsMatch`.
 *
 * @param {Instance} inst - LUCID Instance (left side)
 * @param {Array<number[]|null>} pts - boxed points array (right side)
 * @returns {boolean}
 */
export function instanceMatchesPoints(inst, pts) {
    if (!inst || !pts) return false;
    if (inst.numNodes !== pts.length) return false;
    var haveMatch = false;
    for (var i = 0; i < pts.length; i++) {
        var b = pts[i];
        if (b == null || !inst.hasPoint(i)) continue;
        if (Math.abs(inst.getX(i) - b[0]) > 0.5 || Math.abs(inst.getY(i) - b[1]) > 0.5) return false;
        haveMatch = true;
    }
    return haveMatch;
}

if (typeof window !== 'undefined') {
    window.instancePointsMatch = instancePointsMatch;
    window.instanceMatchesPoints = instanceMatchesPoints;
}
