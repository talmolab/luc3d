/**
 * session-loader.js — orchestrator for all session-loading workflows.
 *
 * Owns the workflows for empty/per-camera/single-SLP/multi-session/video-only/
 * calibration-only loading paths, plus their helpers (filesystem enumeration,
 * video selection prompts, view/grid layout, decoder rebuild). Backend lazy H5
 * loading lives in `pose/triangulation.js` (Pass 3b-1); this module wires it
 * into the session-load paths via `LazyFrameLoader`.
 *
 * IMPORTANT: this module imports a few helpers from `app.js` (status/loading
 * UI, controller setup, info-panel + strip refresh, parseSkeletonJSON,
 * switchSession). That's a deliberate circular ESM import — `app.js` imports
 * the public surface of this module, and this module imports back the
 * UI-side hooks that haven't yet been extracted into their own modules.
 * Circular ESM imports work as long as nothing is invoked at module-load
 * time, and every reference here is inside a function body. The intra-app
 * helpers will move to dedicated modules in Pass 3c–3e and these imports
 * can then be retargeted.
 */

import {
    state, videoController, interactionManager, viewport3d, timeline, paneManager,
    setVideoController, VIEW_NAMES, buildRememberedSkeleton, setProjectSkeleton,
} from '../ui/app-state.js';

import {
    Session, Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, Identity,
} from '../pose/pose-data.js';

import { OnDemandVideoDecoder, VideoController } from './video.js';

import {
    pickFiles, pickFolder, pickVideoFiles,
    parseCalibrationTOML, parseCalibrationJSON, parseSlpH5, parseSlpViaSleapIO,
    loadCalibrationFile,
} from '../import-export/file-io.js';

import { resolveImportTrackIdx, nulledNodesFromOcclusion } from '../import-export/import-track-resolve.js';
// Shared SLP grouped-reconstruction (identities + InstanceGroups + nulledNodes/
// occlusion + 3D points). Circular ESM import (slp-import imports back
// recomputeUploadedCameras); only invoked inside a function body.
import { restoreGroupingAndUnlink, reconstructInstanceGroupsFromSessionLazy } from '../import-export/slp-import.js';

import {
    LazyFrameLoader, shouldUseLazyH5, shouldUseLazySlp, getInstanceGroupsForFrame,
    ensureLazyFrameData,
} from '../pose/triangulation.js';
import { SioLazyLoader } from './sio-lazy-loader.js';

// Status UI moved to import-export/save-load.js in Pass 3c-1.
import {
    setStatus, showLoading, hideLoading, ensureNo3dImportBlockingLoad,
} from '../import-export/save-load.js';

// Circular import — these are still defined in app.js for now. See module
// header note. They are only invoked inside function bodies, never at
// module-init time, so live-binding lookup keeps them functional.
import { drawAllOverlays, setReprojErrorVisible } from '../ui/rendering.js';
import { updateInfoPanel, promptImportSkeletonForAllSessions } from '../ui/info-panel.js';
import { parseSkeletonJSON } from '../import-export/skeleton-json.js';
// Pass 3i-3: setupInteraction / setup3DViewport / setupTimeline / updateFpsDisplay /
// hideWelcomeOverlay moved to pose/initialization.js.
import {
    setupInteraction, setup3DViewport, setupTimeline,
    updateFpsDisplay,
    hideWelcomeOverlay,
} from '../pose/initialization.js';
// Pass 3h: populateViewStrip / populateSessionStrip / switchSession moved to sessions-panes.js.
import { populateViewStrip, populateSessionStrip, switchSession } from '../ui/sessions-panes.js';
// Pass 3e-1: updateSeekbar / fitTimelineToData / onPlaybackStateChange moved to ui-wiring.js.
import { updateSeekbar, fitTimelineToData, onPlaybackStateChange } from '../ui/ui-wiring.js';
import { getLoadingProgressModal } from '../ui/loading-progress-modal.js';
import { readVisibilityMetadata } from '../import-export/visibility-metadata.js';
import { readPlaneMetadata, resetPlaneState } from '../import-export/plane-metadata.js';

// Module-private debounce timer for the zoom-redraw callback in
// rebuildVideoController(). app.js's setupEmptyVideoController() has its own
// _zoomRedrawTimer — they don't run concurrently, so separate timers are fine.
var _zoomRedrawTimer = null;

/**
 * Block 1 (Prompt 4): annotate the session with the list of cameras that
 * currently have an uploaded video assigned. The Timeline reads this via
 * `session._uploadedCameras` to filter out calibration-only cameras from
 * the label gutter and tree-grouping API.
 *
 * Called from every code path that mutates `state.views` or `state.videoFiles`:
 * `handleLoadCalibration`, `handleLoadVideos`, `createViewForVideoFile`, and
 * `handleEmptySession`. Each session-switch path must also call it (the
 * timeline points at `state.session`, so the right session's annotation
 * must be in sync at refresh time).
 *
 * @param {Session} session
 * @param {Object}  appState - shape `{ views: [{name, ...}, ...], ... }`
 */
export function recomputeUploadedCameras(session, appState) {
    if (!session) return;
    var views = appState && appState.views ? appState.views : [];
    session._uploadedCameras = views.map(function (v) {
        return v.cameraName || v.name;
    });
}

export async function handleLoadCalibration() {
    try {
        setStatus('Loading calibration...', 'warning');
        const calibResult = await loadCalibrationFile();
        if (!calibResult || !calibResult.cameras || calibResult.cameras.length === 0) {
            setStatus('No calibration loaded', 'warning');
            return;
        }
        const cameras = calibResult.cameras;

        // If we have a session, replace its cameras; otherwise create a new session
        if (state.session) {
            state.session.cameras = cameras;
        } else {
            const skeleton = buildRememberedSkeleton() || new Skeleton('skeleton', [], []);
            var sessionName = calibResult.fileName
                ? calibResult.fileName.replace(/\.[^.]+$/, '')
                : ('Session ' + (state.sessions.length + 1));
            state.session = new Session(cameras, skeleton, ['track_0'], sessionName);
            if (state.sessions.indexOf(state.session) < 0) {
                state.sessions.push(state.session);
                state.activeSessionIdx = state.sessions.length - 1;
            }
        }

        // Re-assign videos to the new calibration cameras
        // First clear existing assignments so auto-assign can re-match
        var cameraNames = cameras.map(function (c) { return c.name; });
        for (var vi = 0; vi < state.videoFiles.length; vi++) {
            var vf = state.videoFiles[vi];
            // Keep assignment if camera name still exists in new calibration
            if (vf.assignedCamera && cameraNames.indexOf(vf.assignedCamera) < 0) {
                vf.assignedCamera = null;
            }
        }
        autoAssignVideosToCameras();

        // Update view names to match new camera assignments
        // Also update all instance/group data to use the new camera names
        for (var vi2 = 0; vi2 < state.videoFiles.length; vi2++) {
            var vf2 = state.videoFiles[vi2];
            if (vf2.assignedCamera) {
                // Find the view that was created for this video and rename it
                for (var vIdx = 0; vIdx < state.views.length; vIdx++) {
                    if (state.views[vIdx].name === vf2.name ||
                        state.views[vIdx].decoder === vf2.decoder) {
                        var oldName = state.views[vIdx].name;
                        if (oldName !== vf2.assignedCamera) {
                            console.log('[calibration] Renaming view "' + oldName + '" -> "' + vf2.assignedCamera + '"');
                            state.views[vIdx].name = vf2.assignedCamera;
                            // Update dock panel data attributes and tab titles
                            var cells = document.querySelectorAll('.video-cell[data-view-name="' + oldName + '"]');
                            cells.forEach(function (cell) {
                                cell.setAttribute('data-view-name', vf2.assignedCamera);
                            });
                            // Update dockview panel titles
                            if (paneManager.api) {
                                for (var panel of paneManager.api.panels) {
                                    if (panel.params?.viewName === oldName) {
                                        panel.api.updateParameters({ viewName: vf2.assignedCamera });
                                        panel.setTitle(vf2.assignedCamera);
                                    }
                                }
                            }
                            // Rename camera keys in all session data (FrameGroups, InstanceGroups, etc.)
                            if (state.session) {
                                state.session.renameCameraInAllData(oldName, vf2.assignedCamera);
                            }
                        }
                        break;
                    }
                }
            }
        }

        // Re-attach interaction handlers with updated view names
        // (closures from attach() capture view names, so stale names would break
        //  _addNewInstance, overlay lookups, etc.)
        if (interactionManager) {
            interactionManager.detach();
            interactionManager.attach(state.views);
        }

        // Rebuild the 3D viewport with new cameras
        if (viewport3d) {
            viewport3d.cameras = cameras;
            viewport3d.skeleton = state.session.skeleton;
            viewport3d.addCameraPyramids();
            viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
            viewport3d.fitToScene();
        } else {
            setup3DViewport();
        }

        // Re-draw overlays to reflect any camera name changes
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        // Block 1: refresh the per-session uploaded-camera filter so the
        // timeline reflects the latest video-to-camera assignments. If a
        // calibration load adds cameras with no matching video, those
        // cameras are excluded from the timeline gutter.
        recomputeUploadedCameras(state.session, state);
        if (timeline) timeline.refreshTracks(state.session);
        setStatus('Loaded ' + cameras.length + ' cameras', 'success');
    } catch (err) {
        console.error('Failed to load calibration:', err);
        setStatus('Calibration error: ' + err.message, 'error');
    }
}

export async function handleLoadVideos() {
    try {
        setStatus('Picking videos...', 'warning');
        const files = await pickVideoFiles();
        if (files.length === 0) {
            setStatus('No videos selected', 'warning');
            return;
        }

        showLoading('Loading videos...');

        var hlvModal = getLoadingProgressModal({ title: 'Loading videos' });
        hlvModal.reset();
        hlvModal.show();

        // Append new files to state.videoFiles (skip duplicates). Track the
        // entries created by THIS call in `newVideoFiles` so camera/view
        // creation below is scoped to the active session — `state.videoFiles`
        // is global across all sessions, so iterating it would re-create other
        // sessions' videos as views in (and skip cameras for) the current
        // session. That left a manually-populated session with a view but no
        // matching `session.cameras` entry, so the timeline (which builds rows
        // from `session.cameras`) drew nothing for instances added there.
        var failedVideos = [];
        var newVideoFiles = [];
        for (let i = 0; i < files.length; i++) {
            const file = files[i];
            const stem = file.name.replace(/\.[^.]+$/, '');

            // Skip if already loaded
            const isDup = state.videoFiles.some(function (vf) { return vf.name === stem; });
            if (isDup) {
                console.log('Skipping duplicate video: ' + stem);
                continue;
            }

            showLoading('Loading ' + file.name + '...');
            const hlvTaskId = hlvModal.addTask({ label: file.name || ('camera ' + i) });
            const hlvOnProgress = (function (tid) {
                return function (ev) {
                    if (ev && ev.error) hlvModal.failTask(tid, ev.error);
                    else hlvModal.updateTask(tid, ev);
                };
            })(hlvTaskId);
            try {
                const decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10, onProgress: hlvOnProgress });
                await decoder.init(file);

                const vw = decoder.videoTrack.video.width;
                const vh = decoder.videoTrack.video.height;
                const frameCount = decoder.samples.length;

                var newVf = {
                    file: file,
                    name: stem,
                    decoder: decoder,
                    videoWidth: vw,
                    videoHeight: vh,
                    frameCount: frameCount,
                    assignedCamera: null,
                    videoPath: file.webkitRelativePath || file.name,
                };
                state.videoFiles.push(newVf);
                newVideoFiles.push(newVf);
                hlvModal.completeTask(hlvTaskId);
            } catch (videoErr) {
                console.error('Failed to load ' + file.name + ':', videoErr);
                hlvModal.failTask(hlvTaskId, videoErr);
                var errMsg = videoErr.message || String(videoErr);
                // Detect unsupported codec errors
                if (errMsg.indexOf('NO_SUPPORTED_STREAMS') >= 0 || errMsg.indexOf('DEMUXER_ERROR') >= 0 ||
                    (errMsg.indexOf('Video error code 4') >= 0)) {
                    failedVideos.push(stem + ' (unsupported codec - try transcoding to H.264 with: ffmpeg -i input.mp4 -c:v libx264 -crf 23 output.mp4)');
                } else {
                    failedVideos.push(stem + ': ' + errMsg);
                }
            }
        }

        // If no session exists yet, create one with cameras for each video
        if (!state.session) {
            var cameras = state.videoFiles.map(function (vf) {
                return new Camera(vf.name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                    [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            });
            var skeleton = buildRememberedSkeleton() || new Skeleton('skeleton', [], []);
            state.session = new Session(cameras, skeleton, ['track_0']);
            if (state.sessions.indexOf(state.session) < 0) {
                state.sessions.push(state.session);
                state.activeSessionIdx = state.sessions.length - 1;
            }
        }

        // Tag the freshly-loaded videos with the active session so
        // switchSession's `videoFileIndices` fallback (matching on
        // `vf.sessionIdx`) can re-associate them after a session swap.
        for (var ti = 0; ti < newVideoFiles.length; ti++) {
            newVideoFiles[ti].sessionIdx = state.activeSessionIdx;
        }

        // Auto-assign videos to existing calibration cameras first
        if (state.session.cameras.length > 0) {
            autoAssignVideosToCameras();
        }

        // For any still-unassigned NEW video, create a dummy camera and assign
        // it. Scoped to `newVideoFiles`, not global `state.videoFiles`, so we
        // never skip a camera for the active session just because another
        // session already owns a same-named (already-assigned) video.
        for (var vi = 0; vi < newVideoFiles.length; vi++) {
            var vf = newVideoFiles[vi];
            if (!vf.assignedCamera) {
                // Check if a camera with this name already exists
                var cameraExists = state.session.cameras.some(function (c) { return c.name === vf.name; });
                if (!cameraExists) {
                    state.session.cameras.push(
                        new Camera(vf.name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                            [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480])
                    );
                }
                vf.assignedCamera = vf.name;
            }
        }

        // Create views for the newly-assigned videos that don't have views yet.
        // Iterating `newVideoFiles` (not global `state.videoFiles`) keeps other
        // sessions' videos from being re-created as views in this session.
        var newViewNames = [];
        for (var vi2 = 0; vi2 < newVideoFiles.length; vi2++) {
            var vf2 = newVideoFiles[vi2];
            if (vf2.assignedCamera) {
                var hasView = state.views.some(function (v) { return v.name === vf2.assignedCamera; });
                if (!hasView) {
                    createViewForVideoFile(vf2);
                    newViewNames.push(vf2.assignedCamera);
                }
            }
        }

        // Update total frames before rebuilding controller so seekToFrame works correctly
        updateTotalFrames();

        if (newViewNames.length > 0) {
            populateViewStrip();
            populateSessionStrip();
            // First load (nothing docked yet): lay out a fresh grid of all views.
            // Subsequent load: panels for previously-loaded videos already exist.
            // Re-running addAllViewsAsGrid would add a SECOND, non-interactable
            // panel for each existing view (it deliberately bypasses the
            // duplicate guard for grid init), and that new panel would steal the
            // `view.canvas` reference — leaving the original panel as a
            // non-interactable mirror. Add only the NEW views via the
            // dedup-aware addVideoPanel so existing videos aren't duplicated.
            var alreadyDocked = paneManager.dockedViews && paneManager.dockedViews.size > 0;
            if (alreadyDocked) {
                for (var nv = 0; nv < newViewNames.length; nv++) {
                    paneManager.addVideoPanel(newViewNames[nv], { direction: 'right' });
                }
            } else {
                paneManager.addAllViewsAsGrid();
            }
            rebuildVideoController();
            fitCanvasesToCells();
        }

        // Seek to frame 0 to display the first frame (await ensures it renders)
        if (videoController && state.views.length > 0) {
            await videoController.seekToFrame(0);
        }

        // Block 1: views are now settled — annotate the session with the
        // uploaded-camera list so the timeline excludes calibration-only
        // cameras from its gutter, and refresh the timeline to pick it up.
        recomputeUploadedCameras(state.session, state);
        if (timeline) timeline.refreshTracks(state.session);

        hideLoading();
        updateInfoPanel();

        if (failedVideos.length > 0 && state.views.length === 0) {
            setStatus('All videos failed to load: ' + failedVideos.join('; '), 'error');
        } else if (failedVideos.length > 0) {
            setStatus('Loaded ' + state.views.length + ' view(s), ' + failedVideos.length + ' failed: ' + failedVideos.join('; '), 'warning');
        } else {
            setStatus('Loaded ' + files.length + ' video(s), ' + state.views.length + ' views active', 'success');
        }
    } catch (err) {
        console.error('Failed to load videos:', err);
        hideLoading();
        setStatus('Video error: ' + err.message, 'error');
    }
}

/**
 * True if a picked file is a per-camera CALIBRATION video rather than a
 * session recording. Calibration clips live in a `calibration_images/`
 * subfolder of each camera folder (e.g.
 * `.../back/calibration_images/<date>-back-calibration.mp4`) and must never be
 * loaded as a session video. Their filenames embed the camera name, so the
 * substring matcher in autoAssignVideosToCameras (and the SLP-import camera
 * matcher) would otherwise bind them to a real camera and surface them as an
 * extra view. Detect by path segment (robust to whichever directory the user
 * picked as the root) OR by the `-calibration` / `_calibration` filename stem.
 */
export function isCalibrationVideoFile(file) {
    if (!file) return false;
    var relPath = (file.webkitRelativePath || file.name || '').replace(/\\/g, '/').toLowerCase();
    if (relPath.split('/').indexOf('calibration_images') >= 0) return true;
    var stem = (file.name || '').toLowerCase().replace(/\.[^.]+$/, '');
    return stem.endsWith('-calibration') || stem.endsWith('_calibration');
}

export function autoAssignVideosToCameras() {
    if (!state.session) return;
    var cameraNames = state.session.cameras.map(function (c) { return c.name; });

    for (var i = 0; i < state.videoFiles.length; i++) {
        var vf = state.videoFiles[i];
        if (vf.assignedCamera) continue; // already assigned

        // Try exact match
        if (cameraNames.indexOf(vf.name) >= 0) {
            vf.assignedCamera = vf.name;
            continue;
        }
        // Try case-insensitive match
        var lower = vf.name.toLowerCase();
        for (var j = 0; j < cameraNames.length; j++) {
            if (cameraNames[j].toLowerCase() === lower) {
                vf.assignedCamera = cameraNames[j];
                break;
            }
        }
        if (vf.assignedCamera) continue;

        // Try substring match: video name contains camera name or vice versa
        for (var j2 = 0; j2 < cameraNames.length; j2++) {
            var camLower = cameraNames[j2].toLowerCase();
            // Check if already assigned to another video
            var alreadyUsed = state.videoFiles.some(function (other) {
                return other !== vf && other.assignedCamera === cameraNames[j2];
            });
            if (alreadyUsed) continue;

            if (lower.indexOf(camLower) >= 0 || camLower.indexOf(lower) >= 0) {
                vf.assignedCamera = cameraNames[j2];
                console.log('[auto-assign] Matched video "' + vf.name + '" to camera "' + cameraNames[j2] + '" (substring)');
                break;
            }
        }
    }
}

/**
 * Show a full-screen overlay that blocks until the user selects video files.
 * Returns the selected File[] (never empty — overlay stays until files are picked).
 */
export function forceVideoSelection(refInfo) {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.id = 'videoSelectOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;';

        var title = document.createElement('div');
        title.style.cssText = 'color:#fff;font-size:20px;font-weight:600;margin-bottom:8px;';
        title.textContent = 'SLP loaded — now select the video file(s)';
        overlay.appendChild(title);

        if (refInfo) {
            var sub = document.createElement('div');
            sub.style.cssText = 'color:#aaa;font-size:14px;margin-bottom:24px;max-width:600px;text-align:center;word-break:break-all;';
            sub.textContent = 'Expected: ' + refInfo;
            overlay.appendChild(sub);
        }

        var btn = document.createElement('button');
        btn.style.cssText = 'padding:14px 40px;font-size:16px;font-weight:600;cursor:pointer;background:#4a9eff;color:#fff;border:none;border-radius:8px;';
        btn.textContent = 'Select Video Files';
        overlay.appendChild(btn);

        btn.addEventListener('click', async function () {
            var files = [];
            try { files = await pickVideoFiles(); } catch (e) { /* cancelled */ }
            if (files.length > 0) {
                overlay.remove();
                resolve(files);
            }
            // If cancelled / empty, overlay stays — user must pick files
        });

        document.body.appendChild(overlay);
    });
}

/**
 * Match a folder name to a session name using exact, case-insensitive, and contains matching.
 * Returns true if a match is found.
 */
export function matchSessionFolder(folderName, sessionName) {
    if (folderName === sessionName) return true;
    var fLower = folderName.toLowerCase();
    var sLower = sessionName.toLowerCase();
    if (fLower === sLower) return true;
    if (fLower.indexOf(sLower) >= 0 || sLower.indexOf(fLower) >= 0) return true;
    return false;
}

/**
 * Pick a parent directory and match subdirectories to session names.
 * Uses File System Access API (showDirectoryPicker) to scan subdirs,
 * then matches each subdir to a session name.
 *
 * @param {string[]} sessionNames - Names of sessions to match
 * @returns {Promise<{matched: Map<string, File[]>, unmatched: string[]}>}
 *   matched: Map of sessionName → files from that session's folder
 *   unmatched: session names with no matching folder
 */
export async function pickParentDirectoryForSessions(sessionNames) {
    if (!window.showDirectoryPicker) {
        // Fall back to pickFolder (webkitdirectory) — can't enumerate subdirs individually
        var allFiles = await pickFolder();
        if (!allFiles || allFiles.length === 0) return null;

        // Group files by top-level subdirectory
        var dirFiles = {};
        for (var i = 0; i < allFiles.length; i++) {
            var relPath = allFiles[i].webkitRelativePath || allFiles[i].name;
            var parts = relPath.split('/');
            // parts[0] = parent dir, parts[1] = session subdir, parts[2] = camera subdir, parts[3+] = files
            // Skip files at session root (only include files inside camera subdirs)
            if (parts.length < 4) continue;
            // Skip per-camera calibration clips (back/calibration_images/...).
            if (isCalibrationVideoFile(allFiles[i])) continue;
            var dirName = parts[1];
            if (!dirFiles[dirName]) dirFiles[dirName] = [];
            dirFiles[dirName].push(allFiles[i]);
        }

        var matched = new Map();
        var usedDirs = new Set();
        for (var si = 0; si < sessionNames.length; si++) {
            var sessName = sessionNames[si];
            for (var dirName in dirFiles) {
                if (usedDirs.has(dirName)) continue;
                if (matchSessionFolder(dirName, sessName)) {
                    matched.set(sessName, dirFiles[dirName]);
                    usedDirs.add(dirName);
                    break;
                }
            }
        }
        var unmatched = sessionNames.filter(function (n) { return !matched.has(n); });
        return { matched: matched, unmatched: unmatched };
    }

    // Use File System Access API for reliable enumeration
    var parentHandle;
    try {
        parentHandle = await window.showDirectoryPicker({ mode: 'read' });
    } catch (e) {
        if (e.name === 'AbortError') return null;
        throw e;
    }

    // Scan immediate subdirectories
    var subdirs = [];
    for await (var [name, handle] of parentHandle) {
        if (handle.kind === 'directory') {
            subdirs.push({ name: name, handle: handle });
        }
    }

    // Match subdirs to session names
    var matched = new Map();
    var usedDirs = new Set();
    for (var si = 0; si < sessionNames.length; si++) {
        var sessName = sessionNames[si];
        // Try exact first, then case-insensitive, then contains
        var bestMatch = null;
        for (var di = 0; di < subdirs.length; di++) {
            if (usedDirs.has(di)) continue;
            if (subdirs[di].name === sessName) { bestMatch = di; break; }
        }
        if (bestMatch === null) {
            for (var di = 0; di < subdirs.length; di++) {
                if (usedDirs.has(di)) continue;
                if (subdirs[di].name.toLowerCase() === sessName.toLowerCase()) { bestMatch = di; break; }
            }
        }
        if (bestMatch === null) {
            for (var di = 0; di < subdirs.length; di++) {
                if (usedDirs.has(di)) continue;
                var dLower = subdirs[di].name.toLowerCase();
                var sLower = sessName.toLowerCase();
                if (dLower.indexOf(sLower) >= 0 || sLower.indexOf(dLower) >= 0) { bestMatch = di; break; }
            }
        }
        if (bestMatch !== null) {
            usedDirs.add(bestMatch);
            showLoading('Scanning folder: ' + subdirs[bestMatch].name + '...');
            var allFiles = await enumerateDirectoryHandle(subdirs[bestMatch].handle, subdirs[bestMatch].name, null);
            // Only include files inside camera subdirectories (not at session root)
            // Root files have paths like "Session/file.mp4" (2 parts)
            // Camera subdir files have "Session/CamA/file.mp4" (3+ parts)
            var files = allFiles.filter(function (f) {
                var rp = f.webkitRelativePath || f.name;
                if (rp.split('/').length < 3) return false;
                // Exclude per-camera calibration clips (calibration_images/).
                return !isCalibrationVideoFile(f);
            });
            matched.set(sessName, files);
        }
    }

    var unmatched = sessionNames.filter(function (n) { return !matched.has(n); });
    return { matched: matched, unmatched: unmatched };
}

/**
 * Show a summary of matched/unmatched sessions after parent directory scan.
 * Returns a promise that resolves when the user clicks Continue.
 */
export function showParentDirMatchSummary(matched, unmatched) {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.id = 'parentDirSummaryOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;';

        var box = document.createElement('div');
        box.style.cssText = 'background:#1e1e2e;border-radius:12px;padding:32px;max-width:500px;width:90%;color:#fff;';

        var title = document.createElement('div');
        title.style.cssText = 'font-size:18px;font-weight:600;margin-bottom:16px;';
        title.textContent = 'Session Folder Matching';
        box.appendChild(title);

        // Matched list
        if (matched.size > 0) {
            var matchLabel = document.createElement('div');
            matchLabel.style.cssText = 'color:#4caf50;font-weight:600;margin-bottom:6px;';
            matchLabel.textContent = 'Matched (' + matched.size + '):';
            box.appendChild(matchLabel);
            matched.forEach(function (files, sessName) {
                var row = document.createElement('div');
                row.style.cssText = 'color:#ccc;font-size:13px;padding:2px 0 2px 12px;';
                row.textContent = '\u2713 ' + sessName;
                box.appendChild(row);
            });
        }

        // Unmatched list
        if (unmatched.length > 0) {
            var unmatchLabel = document.createElement('div');
            unmatchLabel.style.cssText = 'color:#ff9800;font-weight:600;margin-top:12px;margin-bottom:6px;';
            unmatchLabel.textContent = 'Unmatched (' + unmatched.length + '):';
            box.appendChild(unmatchLabel);
            for (var i = 0; i < unmatched.length; i++) {
                var row = document.createElement('div');
                row.style.cssText = 'color:#ccc;font-size:13px;padding:2px 0 2px 12px;';
                row.textContent = '\u2717 ' + unmatched[i] + ' — will prompt individually';
                box.appendChild(row);
            }
        }

        var btnContinue = document.createElement('button');
        btnContinue.style.cssText = 'margin-top:20px;padding:12px 36px;font-size:15px;font-weight:600;cursor:pointer;background:#4a9eff;color:#fff;border:none;border-radius:8px;';
        btnContinue.textContent = 'Continue';
        btnContinue.addEventListener('click', function () {
            overlay.remove();
            resolve();
        });
        box.appendChild(btnContinue);

        overlay.appendChild(box);
        document.body.appendChild(overlay);
    });
}

/**
 * Video selection dialog with "Select Session Folder" option.
 * Scans the folder for videos in camera subdirectories and matches them
 * to the manifest entries by camera name or filename.
 *
 * @param {string} refInfo - Camera info string
 * @param {string} sessionName - Current session name
 * @param {object} [options] - Optional settings
 * @param {string[]} [options.allSessionNames] - All session names (enables parent dir option)
 * @returns {Promise<File[]|{parentResult: {matched: Map, unmatched: string[]}}>}
 */
export function forceVideoSelectionWithFolder(refInfo, sessionName, options) {
    var allSessionNames = options && options.allSessionNames;
    var allowSkip = options && options.allowSkip;
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.id = 'videoSelectOverlay';
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;';

        // Esc skips the prompt (UI convention: modals close on Esc). Every
        // caller treats a null result as "no videos picked" and continues.
        function onKeyDown(ev) {
            if (ev.key === 'Escape') {
                ev.preventDefault();
                finish(null);
            }
        }
        function finish(result) {
            document.removeEventListener('keydown', onKeyDown);
            overlay.remove();
            resolve(result);
        }
        document.addEventListener('keydown', onKeyDown);

        var title = document.createElement('div');
        title.style.cssText = 'color:#fff;font-size:20px;font-weight:600;margin-bottom:8px;';
        title.textContent = 'Select folder for: ' + sessionName;
        overlay.appendChild(title);

        if (refInfo) {
            var sub = document.createElement('div');
            sub.style.cssText = 'color:#aaa;font-size:14px;margin-bottom:24px;max-width:600px;text-align:center;word-break:break-all;';
            sub.textContent = refInfo;
            overlay.appendChild(sub);
        }

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;gap:16px;flex-wrap:wrap;justify-content:center;';

        // Parent directory button (only when multiple sessions)
        if (allSessionNames && allSessionNames.length > 1) {
            var btnParent = document.createElement('button');
            btnParent.style.cssText = 'padding:14px 40px;font-size:16px;font-weight:600;cursor:pointer;background:#7c4dff;color:#fff;border:none;border-radius:8px;';
            btnParent.textContent = 'Select Parent Directory';
            btnRow.appendChild(btnParent);

            btnParent.addEventListener('click', async function () {
                var result;
                try { result = await pickParentDirectoryForSessions(allSessionNames); } catch (e) { console.error(e); return; }
                if (!result) return; // cancelled
                finish({ parentResult: result });
            });
        }

        var btnFolder = document.createElement('button');
        btnFolder.style.cssText = 'padding:14px 40px;font-size:16px;font-weight:600;cursor:pointer;background:#4a9eff;color:#fff;border:none;border-radius:8px;';
        btnFolder.textContent = 'Select Session Folder';
        btnRow.appendChild(btnFolder);

        var btnFiles = document.createElement('button');
        btnFiles.style.cssText = 'padding:14px 40px;font-size:16px;font-weight:600;cursor:pointer;background:var(--bg-tertiary,#333);color:#fff;border:1px solid var(--border-color,#555);border-radius:8px;';
        btnFiles.textContent = 'Select Video Files';
        btnRow.appendChild(btnFiles);

        overlay.appendChild(btnRow);

        // Folder button — scan for videos in camera subdirs
        btnFolder.addEventListener('click', async function () {
            var allFiles;
            try { allFiles = await pickFolder(); } catch (e) { return; }
            if (!allFiles || allFiles.length === 0) return;

            var videoExtensions = ['.mp4', '.avi', '.webm', '.mov', '.mkv'];
            var matchedFiles = [];

            // Build map: camera subdirs -> video files
            for (var fi = 0; fi < allFiles.length; fi++) {
                var file = allFiles[fi];
                var relPath = file.webkitRelativePath || file.name;
                var parts = relPath.split('/');
                if (parts.length < 2) continue;
                var fnLower = parts[parts.length - 1].toLowerCase();
                var ext = fnLower.substring(fnLower.lastIndexOf('.'));
                if (videoExtensions.indexOf(ext) >= 0 && !isCalibrationVideoFile(file)) {
                    matchedFiles.push(file);
                }
            }

            if (matchedFiles.length > 0) {
                finish(matchedFiles);
            }
        });

        // Files button — fallback to individual file picker
        btnFiles.addEventListener('click', async function () {
            var files = [];
            try { files = await pickVideoFiles(); } catch (e) { /* cancelled */ }
            if (files.length > 0) {
                finish(files);
            }
        });

        // Optional explicit skip (lazy project reopen: videos can be attached
        // later via File → Load Videos).
        if (allowSkip) {
            var btnSkip = document.createElement('button');
            btnSkip.style.cssText = 'padding:14px 40px;font-size:16px;font-weight:600;cursor:pointer;background:transparent;color:#aaa;border:1px solid var(--border-color,#555);border-radius:8px;';
            btnSkip.textContent = 'Skip — Load Videos Later';
            btnRow.appendChild(btnSkip);
            btnSkip.addEventListener('click', function () { finish(null); });
        }

        document.body.appendChild(overlay);
    });
}

export function createViewForVideoFile(videoFile) {
    var name = videoFile.assignedCamera || videoFile.name;
    if (!name) return null;

    // Create view data object (canvases created by VideoPaneRenderer)
    var view = {
        name: name,
        decoder: videoFile.decoder,
        canvas: null,
        ctx: null,
        overlayCanvas: null,
        overlayCtx: null,
        videoWidth: videoFile.videoWidth,
        videoHeight: videoFile.videoHeight,
        wrapper: null,
    };

    state.views.push(view);

    // Register this video's index in the active session
    if (state.session) {
        var vfIdx = state.videoFiles.indexOf(videoFile);
        if (vfIdx >= 0 && state.session.videoFileIndices.indexOf(vfIdx) < 0) {
            state.session.videoFileIndices.push(vfIdx);
        }
        // Block 1: refresh the uploaded-camera list so the timeline
        // picks up the newly-added view immediately.
        recomputeUploadedCameras(state.session, state);
    }

    return view;
}

/**
 * Update grid layout — no-op with dockview (layout managed by dock system).
 */
export function updateGridLayout() {
    // Dockview manages panel layout
}

/**
 * Create a per-cell video prompt in the grid for a camera that needs a video loaded.
 */
export function createVideoPromptCell(cameraName, referencedFilename) {
    var dockEl = document.getElementById('videoDock');

    var cell = document.createElement('div');
    cell.className = 'video-cell video-prompt-cell';
    cell.id = 'cell-' + cameraName;
    cell.style.cssText = 'display:flex;align-items:center;justify-content:center;min-height:200px;';

    var promptDiv = document.createElement('div');
    promptDiv.style.cssText = 'display:flex;flex-direction:column;align-items:center;justify-content:center;width:100%;height:100%;background:var(--bg-secondary,#1e1e1e);border:1px dashed var(--border,#444);border-radius:4px;';

    var camLabel = document.createElement('div');
    camLabel.style.cssText = 'font-size:16px;font-weight:600;color:var(--text-primary,#e0e0e0);margin-bottom:4px;';
    camLabel.textContent = cameraName;
    promptDiv.appendChild(camLabel);

    if (referencedFilename && referencedFilename !== '.') {
        var fnEl = document.createElement('div');
        fnEl.style.cssText = 'font-size:12px;color:var(--text-muted,#888);margin-bottom:12px;';
        fnEl.textContent = referencedFilename;
        promptDiv.appendChild(fnEl);
    }

    var btn = document.createElement('button');
    btn.className = 'btn btn-primary';
    btn.textContent = 'Load Video';
    btn.style.cssText = 'padding:10px 24px;font-size:14px;cursor:pointer;background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:6px;';
    btn.addEventListener('click', async function () {
        try {
            var files = await pickVideoFiles();
            if (files.length === 0) return;

            var vf = files[0];
            showLoading('Loading ' + vf.name + '...');
            var decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
            await decoder.init(vf);

            var videoFileEntry = {
                file: vf,
                name: vf.name.replace(/\.[^.]+$/, ''),
                decoder: decoder,
                videoWidth: decoder.videoTrack.video.width,
                videoHeight: decoder.videoTrack.video.height,
                frameCount: decoder.samples.length,
                assignedCamera: cameraName,
                videoPath: vf.webkitRelativePath || vf.name,
            };
            state.videoFiles.push(videoFileEntry);

            // Remove prompt cell and create real view
            cell.remove();
            createViewForVideoFile(videoFileEntry);
            updateTotalFrames();

            rebuildVideoController();
            requestAnimationFrame(function () { fitCanvasesToCells(); });

            if (videoController) {
                if (state.views.length === 1) {
                    var firstFrame = 0;
                    for (var [fIdx] of state.session.frameGroups) {
                        firstFrame = fIdx;
                        break;
                    }
                    state.currentFrame = firstFrame;
                    await videoController.seekToFrame(firstFrame);
                } else {
                    await videoController.seekToFrame(state.currentFrame);
                }
            }
            drawAllOverlays(state.currentFrame);
            updateInfoPanel();

            hideLoading();
            setStatus('Video loaded for ' + cameraName, 'success');
        } catch (e) {
            hideLoading();
            console.error('Failed to load video:', e);
            setStatus('Video load error: ' + e.message, 'error');
        }
    });

    promptDiv.appendChild(btn);
    cell.appendChild(promptDiv);

    // Hide the dock empty message and append the prompt cell directly
    hideWelcomeOverlay();
    dockEl.appendChild(cell);
}

/**
 * Fit all canvases to their cells while maintaining video aspect ratio.
 * With dockview, CSS handles basic sizing via max-width/max-height,
 * but we still need to ensure canvas display dimensions are correct.
 */
export function fitCanvasesToCells() {
    for (var i = 0; i < state.views.length; i++) {
        var view = state.views[i];
        if (!view.canvas || !view.wrapper) continue;

        var cell = view.canvas.closest('.video-cell');
        if (!cell) continue;

        var cellW = cell.clientWidth;
        var cellH = cell.clientHeight;
        if (cellW <= 0 || cellH <= 0) continue;

        var videoAR = view.videoWidth / view.videoHeight;
        var cellAR = cellW / cellH;

        var cssW, cssH;
        if (videoAR > cellAR) {
            cssW = cellW;
            cssH = cellW / videoAR;
        } else {
            cssH = cellH;
            cssW = cellH * videoAR;
        }

        cssW = Math.floor(cssW);
        cssH = Math.floor(cssH);

        view.canvas.style.width = cssW + 'px';
        view.canvas.style.height = cssH + 'px';
        if (view.overlayCanvas) {
            view.overlayCanvas.style.width = cssW + 'px';
            view.overlayCanvas.style.height = cssH + 'px';
        }
    }
    if (viewport3d) viewport3d.resize();
}

export var cellResizeObserver = new ResizeObserver(function (entries) {
    requestAnimationFrame(function () {
        fitCanvasesToCells();
        // Reapply zoom for all views (preserve scale, re-constrain offsets)
        if (videoController) {
            for (var i = 0; i < state.views.length; i++) {
                videoController.reapplyZoom(state.views[i]);
            }
        }
    });
});

window.addEventListener('resize', fitCanvasesToCells);

export function rebuildVideoController() {
    // Detach old interaction handlers
    if (interactionManager) {
        interactionManager.detach();
    }

    // Recreate video controller
    setVideoController(new VideoController(state, {
        updateSeekbar: updateSeekbar,
        drawOverlays: drawAllOverlays,
        onPlaybackStateChange: onPlaybackStateChange,
        log: window.logMessage,
        onZoomChange: function () {
            clearTimeout(_zoomRedrawTimer);
            _zoomRedrawTimer = setTimeout(function () {
                drawAllOverlays(state.currentFrame);
            }, 200);
        },
    }));

    // Set up zoom handlers for views that have been docked (have canvases)
    for (const view of state.views) {
        if (!view._zoomSetup && view.canvas) {
            view._zoomSetup = true;
            videoController.initZoom(view);
            const cell = view.canvas.closest('.video-cell');
            if (cell) videoController.setupZoomHandlers(view, cell);
        }
    }

    setupInteraction();
    if (timeline) {
        timeline.setData(state.session);
    }

    document.getElementById('totalFrames').textContent = state.totalFrames;
    document.getElementById('fpsDisplay').textContent = state.fps.toFixed(1) + ' fps';

    // Surface frame-accurate mediabunny backend failures in the status bar
    // (issue #115) — previously only a console.warn, invisible without
    // opening devtools. `_mediabunnyEnabled()` defaults ON for every decoder,
    // so a decoder with a real video but no `_mbBackend` means its init
    // silently failed and it's falling back to less-precise HTML5 seeking;
    // this makes that visible at a glance instead of requiring the user to
    // dig through the console to confirm which backend is actually active.
    var decodersMissingMediabunny = state.views.filter(function (v) {
        return v.decoder && !v.decoder._mbBackend;
    }).length;
    if (decodersMissingMediabunny > 0) {
        setStatus(decodersMissingMediabunny + ' of ' + state.views.length
            + ' camera(s) fell back to HTML5 seeking (frame-accurate mediabunny init failed) — stepping may be a frame or two off',
            'warning');
    }
}

export function updateTotalFrames() {
    var maxFrames = 0;
    var bestFps = 30;
    for (var i = 0; i < state.views.length; i++) {
        var d = state.views[i].decoder;
        if (d && d.samples && d.samples.length > maxFrames) {
            maxFrames = d.samples.length;
            bestFps = d.videoTrack && d.videoTrack.duration > 0
                ? d.samples.length / (d.videoTrack.duration / d.videoTrack.timescale)
                : 30;
        }
    }
    if (maxFrames > 0) {
        state.totalFrames = maxFrames;
        state.fps = bestFps;
        document.getElementById('totalFrames').textContent = state.totalFrames;
        document.getElementById('fpsDisplay').textContent = state.fps.toFixed(1) + ' fps';
        if (timeline) {
            timeline.setTotalFrames(maxFrames);
        }
    } else {
        // No decoders — empty session. Reset so previous session's
        // frame count cannot leak into this one.
        state.totalFrames = 0;
        state.fps = 30;
        document.getElementById('totalFrames').textContent = '0';
        document.getElementById('fpsDisplay').textContent = '30.0 fps';
        if (timeline) {
            timeline.setTotalFrames(1);
        }
    }
}

/**
 * Recursively enumerate all files under a FileSystemDirectoryHandle.
 * Returns File objects with webkitRelativePath set to rootName/relative/path.
 */
export async function enumerateDirectoryHandle(dirHandle, rootName, prefix) {
    var files = [];
    for await (var [name, handle] of dirHandle) {
        if (handle.kind === 'file') {
            var file = await handle.getFile();
            var relPath = prefix ? prefix + '/' + name : rootName + '/' + name;
            var wrappedFile = new File([file], file.name, { type: file.type, lastModified: file.lastModified });
            Object.defineProperty(wrappedFile, 'webkitRelativePath', { value: relPath });
            files.push(wrappedFile);
        } else if (handle.kind === 'directory') {
            var subPrefix = prefix ? prefix + '/' + name : rootName + '/' + name;
            var subFiles = await enumerateDirectoryHandle(handle, rootName, subPrefix);
            files = files.concat(subFiles);
        }
    }
    return files;
}

export async function handleLoadMultiSession() {
    try {
        setStatus('Pick parent folder containing session subfolders...', 'warning');

        // Use File System Access API to get directory handle
        // This lets us enumerate each session individually, avoiding
        // the browser dropping files when webkitdirectory returns too many
        var parentHandle;
        if (window.showDirectoryPicker) {
            try {
                parentHandle = await window.showDirectoryPicker({ mode: 'read' });
            } catch (e) {
                if (e.name === 'AbortError') {
                    setStatus('No folder selected', 'warning');
                    return;
                }
                throw e;
            }
        } else {
            // Fallback for browsers without File System Access API
            setStatus('This browser does not support showDirectoryPicker. Use Chrome or Edge.', 'error');
            return;
        }

        showLoading('Scanning for sessions...');

        // Find session subdirectories (directories that contain calibration or
        // camera subdirs), and a parent-level skeleton .json (e.g. skeleton.json)
        // that unifies all sessions (one skeleton per project).
        var sessionDirs = [];  // { name, handle }
        var parentSkeletonHandle = null;
        for await (var [name, handle] of parentHandle) {
            if (handle.kind === 'directory') {
                // Quick check: does this look like a session?
                var isSession = false;
                for await (var [subName, subHandle] of handle) {
                    if (subHandle.kind === 'file' && subName.toLowerCase().indexOf('calib') >= 0) {
                        isSession = true;
                        break;
                    }
                    if (subHandle.kind === 'directory') {
                        isSession = true;
                        break;
                    }
                }
                if (isSession) {
                    sessionDirs.push({ name: name, handle: handle });
                }
            } else if (handle.kind === 'file'
                && name.toLowerCase().indexOf('skeleton') >= 0
                && name.toLowerCase().endsWith('.json')) {
                parentSkeletonHandle = handle; // e.g. skeleton.json / handSkeleton.json
            }
        }

        sessionDirs.sort(function (a, b) { return a.name < b.name ? -1 : a.name > b.name ? 1 : 0; });

        if (sessionDirs.length === 0) {
            hideLoading();
            setStatus('No session subfolders found in selected folder', 'error');
            return;
        }

        showLoading('Loading ' + sessionDirs.length + ' sessions...');
        console.log('[multi-session] Found sessions:', sessionDirs.map(function (d) { return d.name; }));

        // Load each session — first gets full video init, rest defer decoders
        for (var si = 0; si < sessionDirs.length; si++) {
            var sess = sessionDirs[si];
            showLoading('Loading session ' + (si + 1) + '/' + sessionDirs.length + ': ' + sess.name + '...');
            console.log('[multi-session] Enumerating session:', sess.name);

            // Reset frame count so each session computes its own video length
            state.totalFrames = 0;
            state.fps = 0;

            var sessionFiles = await enumerateDirectoryHandle(sess.handle, sess.name, null);
            console.log('[multi-session] Session', sess.name, '— files:', sessionFiles.length);
            await handleLoadSessionFolderPerCamera(sessionFiles, si > 0);
        }

        hideLoading();
        setStatus('Loaded ' + sessionDirs.length + ' sessions', 'success');

        // Display first session's grid (it has live decoders from eager load)
        if (state.sessions.length > 1) {
            state.activeSessionIdx = state.sessions.length - 1;
            await switchSession(0);
        }

        populateSessionStrip();

        // One skeleton per project. If the parent folder contains a skeleton
        // .json, auto-load it for every session; otherwise prompt the user for a
        // unifying skeleton file. (Multi-session projects otherwise carry a
        // per-session skeleton each → duplicate-skeleton errors downstream.)
        if (state.sessions.length > 1) {
            var autoLoadedSkeleton = false;
            if (parentSkeletonHandle) {
                try {
                    var skFile = await parentSkeletonHandle.getFile();
                    var parentSk = parseSkeletonJSON(await skFile.text());
                    if (parentSk && parentSk.nodes.length > 0) {
                        setProjectSkeleton(parentSk);
                        autoLoadedSkeleton = true;
                        drawAllOverlays(state.currentFrame);
                        updateInfoPanel();
                        setStatus('Loaded skeleton from ' + parentSkeletonHandle.name +
                            ' for all ' + state.sessions.length + ' sessions', 'success');
                    }
                } catch (e) {
                    console.warn('[multi-session] parent skeleton auto-load failed:', e);
                }
            }
            if (!autoLoadedSkeleton) promptImportSkeletonForAllSessions();
        }

    } catch (err) {
        console.error('[multi-session] Error:', err);
        hideLoading();
        setStatus('Multi-session error: ' + err.message, 'error');
    }
}

// ============================================
// Session Folder Import
// ============================================

/**
 * Show a popup listing calibration cameras that have no matching directory.
 * Returns a Promise that resolves when the user dismisses the popup.
 */
/**
 * Show a popup with one or more sections of missing files, each with per-item Import buttons.
 * @param {Array<{title: string, subtitle: string, items: Array<{name: string, type: string}>}>} sections
 * @returns {Promise<Map<string, File>>} Map of item name -> imported File
 */
export function showMissingFilesPopup(sections) {
    return new Promise(function (resolve) {
        var imported = new Map();

        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;flex-direction:column;align-items:center;justify-content:center;';

        var card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-secondary,#1e1e1e);border-radius:8px;padding:24px;max-width:600px;width:90%;max-height:80vh;overflow-y:auto;';

        for (var si = 0; si < sections.length; si++) {
            var section = sections[si];
            if (section.items.length === 0) continue;

            if (si > 0) {
                var spacer = document.createElement('div');
                spacer.style.cssText = 'margin-top:16px;';
                card.appendChild(spacer);
            }

            var titleEl = document.createElement('div');
            titleEl.style.cssText = 'color:#fff;font-size:16px;font-weight:600;margin-bottom:4px;';
            titleEl.textContent = section.title;
            card.appendChild(titleEl);

            var sub = document.createElement('div');
            sub.style.cssText = 'color:#aaa;font-size:13px;margin-bottom:12px;';
            sub.textContent = section.subtitle;
            card.appendChild(sub);

            var listEl = document.createElement('div');
            listEl.style.cssText = 'margin:0 0 8px 0;';

            for (var i = 0; i < section.items.length; i++) {
                (function (item) {
                    var row = document.createElement('div');
                    row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:6px 8px;border-bottom:1px solid var(--border-color,#333);';

                    var nameSpan = document.createElement('span');
                    nameSpan.style.cssText = 'color:#e0e0e0;font-size:13px;';
                    nameSpan.textContent = item.name;
                    row.appendChild(nameSpan);

                    var importBtn = document.createElement('button');
                    importBtn.style.cssText = 'padding:4px 12px;font-size:12px;cursor:pointer;background:var(--bg-tertiary,#2a2a2a);color:var(--text-primary,#e0e0e0);border:1px solid var(--border-color,#444);border-radius:4px;';
                    importBtn.textContent = 'Import...';
                    importBtn.addEventListener('click', async function () {
                        var accept = item.type === 'video' ? '.mp4,.avi,.webm,.mov,.mkv' : '*';
                        var files = await pickFiles({ accept: accept });
                        if (files.length > 0) {
                            imported.set(item.name, files[0]);
                            nameSpan.textContent = item.name + '  \u2714 ' + files[0].name;
                            nameSpan.style.color = '#4caf50';
                            importBtn.textContent = 'Replace...';
                        }
                    });
                    row.appendChild(importBtn);

                    listEl.appendChild(row);
                })(section.items[i]);
            }
            card.appendChild(listEl);
        }

        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:16px;';

        var continueBtn = document.createElement('button');
        continueBtn.style.cssText = 'padding:10px 24px;font-size:14px;font-weight:600;cursor:pointer;background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:6px;';
        continueBtn.textContent = 'Continue';

        function dismiss() {
            overlay.remove();
            document.removeEventListener('keydown', onKeyDown);
            resolve(imported);
        }
        continueBtn.addEventListener('click', dismiss);
        function onKeyDown(e) {
            if (e.key === 'Enter') { e.preventDefault(); dismiss(); }
        }
        document.addEventListener('keydown', onKeyDown);

        btnRow.appendChild(continueBtn);
        card.appendChild(btnRow);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
    });
}

export function showSessionModeModal(showAllOptions) {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;';

        var card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-secondary,#1e1e1e);border-radius:10px;padding:28px;max-width:90vw;';

        var title = document.createElement('div');
        title.style.cssText = 'color:#fff;font-size:18px;font-weight:600;margin-bottom:20px;text-align:center;';
        title.textContent = 'Choose Session Folder Structure';
        card.appendChild(title);

        function makeOption(name, desc, iconLines, mode) {
            var opt = document.createElement('div');
            opt.dataset.mode = mode;
            opt.style.cssText = 'padding:14px 16px;border:2px solid var(--border-color,#333);border-radius:8px;cursor:pointer;transition:border-color 0.15s,background 0.15s;white-space:nowrap;';
            opt.addEventListener('mouseenter', function () {
                opt.style.borderColor = 'var(--accent,#4a9eff)';
                opt.style.background = 'rgba(74,158,255,0.08)';
            });
            opt.addEventListener('mouseleave', function () {
                opt.style.borderColor = 'var(--border-color,#333)';
                opt.style.background = 'none';
            });

            var optTitle = document.createElement('div');
            optTitle.style.cssText = 'color:#fff;font-size:12px;font-weight:600;margin-bottom:3px;';
            optTitle.textContent = name;
            opt.appendChild(optTitle);

            var optDesc = document.createElement('div');
            optDesc.style.cssText = 'color:#aaa;font-size:10px;margin-bottom:8px;';
            optDesc.textContent = desc;
            opt.appendChild(optDesc);

            var iconBlock = document.createElement('pre');
            iconBlock.style.cssText = 'margin:0;padding:6px;background:rgba(0,0,0,0.3);border-radius:6px;font-size:9px;line-height:1.5;color:#ccc;font-family:monospace;overflow-x:auto;';
            iconBlock.textContent = iconLines;
            opt.appendChild(iconBlock);

            opt.addEventListener('click', function () {
                overlay.remove();
                document.removeEventListener('keydown', onKeyNav);
                resolve(mode);
            });
            return opt;
        }

        // Two-column layout
        var columns = document.createElement('div');
        columns.style.cssText = 'display:flex;gap:14px;justify-content:center;';

        var bubbleStyle = 'padding:14px;border:1px solid var(--border-color,#333);border-radius:10px;background:rgba(255,255,255,0.02);';
        var groupTitleStyle = 'color:var(--text-muted,#888);font-size:11px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:10px;text-align:center;';

        // Left bubble: Single Session
        var leftBubble = document.createElement('div');
        leftBubble.style.cssText = bubbleStyle;

        var leftTitle = document.createElement('div');
        leftTitle.style.cssText = groupTitleStyle;
        leftTitle.textContent = 'Single Session';
        leftBubble.appendChild(leftTitle);

        var leftOptions = document.createElement('div');
        leftOptions.style.cssText = 'display:flex;gap:10px;justify-content:center;';

        if (showAllOptions) {
            leftOptions.appendChild(makeOption(
                'Empty Session',
                'Blank session, no imports.',
                '\u{1F4C1} empty session/\n\u2514\u2500\u2500 (no files)',
                'empty'
            ));
        }

        var perCameraOpt = makeOption(
            'Per-Camera SLP',
            'One SLP + one video per camera.',
            '\u{1F4C1} session/\n\u251C\u2500\u2500 \u{1F4C4} calibration.toml\n\u251C\u2500\u2500 \u{1F4C4} skeleton.json\n\u251C\u2500\u2500 \u{1F4C1} cam1/\n\u2502   \u251C\u2500\u2500 \u{1F3AC} video.mp4\n\u2502   \u2514\u2500\u2500 \u{1F4C4} cam1.slp\n\u2514\u2500\u2500 \u{1F4C1} cam2/\n    \u251C\u2500\u2500 \u{1F3AC} video.mp4\n    \u2514\u2500\u2500 \u{1F4C4} cam2.slp',
            'per-camera'
        );
        // Recommended highlight
        perCameraOpt.style.borderColor = 'rgba(255,200,50,0.6)';
        perCameraOpt.style.background = 'rgba(255,200,50,0.05)';
        var recLabel = document.createElement('div');
        recLabel.style.cssText = 'color:rgba(255,200,50,0.85);font-size:9px;font-weight:600;margin-bottom:4px;';
        recLabel.textContent = '\u2605 Recommended';
        perCameraOpt.insertBefore(recLabel, perCameraOpt.firstChild);
        // Update hover to preserve yellow theme
        perCameraOpt.addEventListener('mouseenter', function () {
            perCameraOpt.style.borderColor = 'rgba(255,200,50,0.9)';
            perCameraOpt.style.background = 'rgba(255,200,50,0.1)';
        });
        perCameraOpt.addEventListener('mouseleave', function () {
            perCameraOpt.style.borderColor = 'rgba(255,200,50,0.6)';
            perCameraOpt.style.background = 'rgba(255,200,50,0.05)';
        });
        leftOptions.appendChild(perCameraOpt);

        leftOptions.appendChild(makeOption(
            'Single SLP',
            'One SLP in root. Videos in videos/ folder.',
            '\u{1F4C1} session/\n\u251C\u2500\u2500 \u{1F4C4} calibration.toml\n\u251C\u2500\u2500 \u{1F4C4} skeleton.json\n\u251C\u2500\u2500 \u{1F4C4} labels.slp\n\u2514\u2500\u2500 \u{1F4C1} videos/\n    \u251C\u2500\u2500 \u{1F3AC} cam1_s1.mp4\n    \u251C\u2500\u2500 \u{1F3AC} cam1_s2.mp4\n    \u251C\u2500\u2500 \u{1F3AC} cam2_s1.mp4\n    \u2514\u2500\u2500 \u{1F3AC} cam2_s2.mp4',
            'single-slp'
        ));

        leftBubble.appendChild(leftOptions);
        columns.appendChild(leftBubble);

        // Right bubble: Multi-Session
        var rightBubble = document.createElement('div');
        rightBubble.style.cssText = bubbleStyle;

        var rightTitle = document.createElement('div');
        rightTitle.style.cssText = groupTitleStyle;
        rightTitle.textContent = 'Multi-Session';
        rightBubble.appendChild(rightTitle);

        var rightOptions = document.createElement('div');
        rightOptions.style.cssText = 'display:flex;gap:10px;justify-content:center;';

        var parentOpt = makeOption(
            'Parent Folder',
            'Session subfolders + optional skeleton.json (one skeleton for all sessions).',
            '\u{1F4C1} parent/\n\u251C\u2500\u2500 \u{1F4C4} skeleton.json  \u2190 one skeleton for all\n\u251C\u2500\u2500 \u{1F4C1} sess1/\n\u2502   \u251C\u2500\u2500 \u{1F4C4} calib.toml\n\u2502   \u251C\u2500\u2500 \u{1F4C1} cam1/\n\u2502   \u2514\u2500\u2500 \u{1F4C1} cam2/\n\u2514\u2500\u2500 \u{1F4C1} sess2/\n    \u251C\u2500\u2500 \u{1F4C4} calib.toml\n    \u251C\u2500\u2500 \u{1F4C1} cam1/\n    \u2514\u2500\u2500 \u{1F4C1} cam2/',
            'multi-session'
        );
        // Not selectable from wizard (use Load Multi-Session Folder instead)
        parentOpt.style.cursor = 'default';
        parentOpt.style.pointerEvents = 'none';
        parentOpt.dataset.disabled = 'true';
        rightOptions.appendChild(parentOpt);

        rightBubble.appendChild(rightOptions);
        columns.appendChild(rightBubble);

        card.appendChild(columns);

        // Mark the currently saved option
        var savedMode = localStorage.getItem('sessionFolderType') || 'per-camera';
        var allOpts = Array.from(card.querySelectorAll('[data-mode]')).filter(function (o) { return o.dataset.disabled !== 'true'; });
        allOpts.forEach(function (o) {
            if (o.dataset.mode === savedMode) {
                var badge = document.createElement('div');
                badge.style.cssText = 'color:var(--accent,#4a9eff);font-size:9px;font-weight:600;margin-bottom:4px;';
                badge.textContent = '\u2714 Current';
                o.insertBefore(badge, o.firstChild);
                o.style.borderColor = 'var(--accent,#4a9eff)';
                o.style.background = 'rgba(74,158,255,0.05)';
            }
        });

        // Keyboard navigation (skip disabled options)
        var focusIdx = allOpts.findIndex(function (o) { return o.dataset.mode === savedMode; });
        if (focusIdx < 0) focusIdx = allOpts.findIndex(function (o) { return o.dataset.mode === 'per-camera'; });
        if (focusIdx < 0) focusIdx = 0;

        function setFocus(idx) {
            allOpts.forEach(function (o) { o.style.outline = 'none'; });
            focusIdx = idx;
            var el = allOpts[focusIdx];
            el.style.outline = '2px solid var(--accent,#4a9eff)';
            el.style.outlineOffset = '2px';
            el.scrollIntoView({ block: 'nearest' });
        }
        setFocus(focusIdx);

        // Cancel button
        var btnRow = document.createElement('div');
        btnRow.style.cssText = 'display:flex;justify-content:flex-end;margin-top:16px;';
        var cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = 'padding:8px 20px;font-size:13px;font-weight:600;cursor:pointer;background:var(--bg-tertiary,#2a2a2a);color:var(--text-primary,#e0e0e0);border:1px solid var(--border-color,#444);border-radius:6px;';
        cancelBtn.textContent = 'Cancel';
        cancelBtn.addEventListener('click', function () {
            overlay.remove();
            document.removeEventListener('keydown', onKeyNav);
            resolve(null);
        });
        btnRow.appendChild(cancelBtn);
        card.appendChild(btnRow);

        function onKeyNav(e) {
            if (e.key === 'Escape') {
                e.preventDefault();
                overlay.remove();
                document.removeEventListener('keydown', onKeyNav);
                resolve(null);
            } else if (e.key === 'ArrowRight') {
                e.preventDefault();
                setFocus((focusIdx + 1) % allOpts.length);
            } else if (e.key === 'ArrowLeft') {
                e.preventDefault();
                setFocus((focusIdx - 1 + allOpts.length) % allOpts.length);
            } else if (e.key === 'Enter') {
                e.preventDefault();
                allOpts[focusIdx].click();
            }
        }
        document.addEventListener('keydown', onKeyNav);

        overlay.appendChild(card);
        document.body.appendChild(overlay);
    });
}

export function loadSingleSessionFromCache() {
    var mode = localStorage.getItem('sessionFolderType') || 'per-camera';
    if (mode === 'empty') {
        handleEmptySession();
    } else if (mode === 'single-slp') {
        handleLoadSessionFolderSingleSlp();
    } else {
        handleLoadSessionFolderPerCamera();
    }
}

export async function handleLoadSessionFolder(showAllOptions) {
    // Warn + reset if 3D points were imported into a skeleton-only project.
    if (!(await ensureNo3dImportBlockingLoad())) return;
    var mode = await showSessionModeModal(!!showAllOptions);
    if (!mode) return; // cancelled
    if (mode === 'single-slp') {
        await handleLoadSessionFolderSingleSlp();
    } else if (mode === 'per-camera') {
        await handleLoadSessionFolderPerCamera();
    } else if (mode === 'multi-session') {
        await handleLoadMultiSession();
    } else if (mode === 'empty') {
        handleEmptySession();
    }
}

export function handleEmptySession() {
    // Save current session state before switching
    if (state.sessions.length > 0) {
        var oldSession = state.sessions[state.activeSessionIdx];
        oldSession.lastFrame = state.currentFrame;
        oldSession.triangulationResults = state.triangulationResults;
        oldSession._views = state.views;
        oldSession._videoController = videoController;
        if (viewport3d && viewport3d.threeCamera && viewport3d.controls) {
            oldSession._viewport3dState = {
                cameraPosition: viewport3d.threeCamera.position.toArray(),
                cameraUp: viewport3d.threeCamera.up.toArray(),
                controlsTarget: viewport3d.controls.target.toArray(),
            };
        }
    }

    var sessionName = 'Session ' + (state.sessions.length + 1);
    // One skeleton per project: inherit the shared project skeleton so a
    // manually-created empty session stays in sync with the others (matches
    // handleLoadVideos / handleLoadCalibration). Only mint a fresh blank
    // skeleton when this is the very first session, and register it via
    // setProjectSkeleton so subsequent sessions share it.
    var skeleton = buildRememberedSkeleton();
    if (!skeleton) {
        skeleton = new Skeleton('skeleton', [], []);
        if (state.sessions.length === 0) setProjectSkeleton(skeleton);
    }
    var session = new Session([], skeleton, ['track_0'], sessionName);

    state.sessions.push(session);
    state.activeSessionIdx = state.sessions.length - 1;
    state.session = session;
    state.triangulationResults = new Map();
    state.views = [];

    if (videoController && state.isPlaying) videoController.stopPlayback();
    setVideoController(null);
    paneManager.clearAll();
    populateViewStrip();
    populateSessionStrip();

    // Show 3D message, clear viewport
    var vp3dMsg = document.getElementById('viewport3dMessage');
    if (vp3dMsg) vp3dMsg.classList.remove('hidden');
    if (viewport3d) {
        viewport3d.cameras = [];
        viewport3d.addCameraPyramids();
        viewport3d.setFrame([]);
    }

    updateInfoPanel();
    // Block 1: empty session has no uploaded cameras yet. Set the marker
    // to an empty array so the timeline filter applies (showing nothing).
    recomputeUploadedCameras(session, state);
    if (timeline) timeline.setData(session);
    setStatus('Created empty session "' + sessionName + '"', 'success');
}

export async function handleLoadSessionFolderSingleSlp() {
    try {
        setStatus('Pick session folder...', 'warning');
        var allFiles = await pickFolder();
        if (allFiles.length === 0) {
            setStatus('No folder selected', 'warning');
            return;
        }

        showLoading('Scanning folder...');

        // Find root-level SLP, calibration, skeleton, and videos/ subdirectory
        var calibFile = null, skeletonFile = null, slpFile = null;
        var videoFiles = [];
        var videoExtensions = ['.mp4', '.avi', '.webm', '.mov', '.mkv'];

        for (var fi = 0; fi < allFiles.length; fi++) {
            var file = allFiles[fi];
            var relPath = file.webkitRelativePath || file.name;
            var parts = relPath.split('/');
            var fnLower = parts[parts.length - 1].toLowerCase();

            if (parts.length === 2) {
                // Root-level files
                if ((fnLower.endsWith('.toml') || fnLower.endsWith('.json')) && fnLower.indexOf('calib') >= 0) {
                    calibFile = file;
                } else if (fnLower.endsWith('.json') && fnLower.indexOf('skeleton') >= 0) {
                    skeletonFile = file;
                } else if (fnLower.endsWith('.slp') || fnLower.endsWith('.h5')) {
                    slpFile = file;
                }
            } else if (parts.length === 3 && parts[1].toLowerCase() === 'videos') {
                var ext = fnLower.substring(fnLower.lastIndexOf('.'));
                if (videoExtensions.indexOf(ext) >= 0) {
                    videoFiles.push(file);
                }
            }
        }

        if (!slpFile) {
            hideLoading();
            setStatus('No SLP file found in root of folder', 'error');
            return;
        }

        console.log('[single-slp] Found:', {
            slp: slpFile.name,
            calibration: calibFile ? calibFile.name : null,
            skeleton: skeletonFile ? skeletonFile.name : null,
            videos: videoFiles.length
        });

        // Load the SLP. Use the typed sleap-io.js reader (same as File → Load
        // SLP) so the project's sessions_json — InstanceGroup grouping,
        // per-instance nulledNodes/occlusion, identities, 3D points — is
        // available to restoreGroupingAndUnlink below. Loading a project .slp
        // must reflect the changes saved in THAT file, not rebuild flat poses
        // from it. Fall back to the raw worker only if the typed reader throws.
        showLoading('Reading SLP: ' + slpFile.name + '...');
        var slpData;
        try {
            slpData = await parseSlpViaSleapIO(slpFile, function (msg) { showLoading(msg); });
        } catch (typedErr) {
            console.warn('[single-slp] typed SLP read failed — falling back to raw h5wasm worker:', typedErr);
            try {
                slpData = await parseSlpH5(slpFile, function (msg) { showLoading(msg); });
            } catch (parseErr) {
                hideLoading();
                setStatus('SLP parse error: ' + parseErr.message, 'error');
                return;
            }
        }

        // Load calibration
        var cameras = [];
        var hasCalibration = false;
        if (calibFile) {
            showLoading('Loading calibration...');
            var calibText = await calibFile.text();
            try {
                if (calibFile.name.toLowerCase().endsWith('.toml')) {
                    cameras = parseCalibrationTOML(calibText);
                } else {
                    cameras = parseCalibrationJSON(calibText);
                }
                hasCalibration = cameras.length > 0;
            } catch (e) {
                console.error('[single-slp] Calibration parse error:', e);
            }
        }

        // No calibration.toml? Recover the calibration EMBEDDED in the project
        // .slp's sessions_json (#134). A LUCID project .slp carries its full
        // calibration there, but this loader previously read calibration only
        // from a separate .toml — so reopening a saved project (which has no
        // .toml) dropped the cameras entirely and lost calibration + 3D. This
        // mirrors handleLoadSlpFile's embedded-calibration read.
        if (cameras.length === 0 && slpData.sessions && slpData.sessions.length > 0) {
            var _embCalib = slpData.sessions[0].calibration || {};
            var _embKeys = Object.keys(_embCalib).filter(function (k) { return k !== 'metadata'; });
            for (var _eki = 0; _eki < _embKeys.length; _eki++) {
                var _cd = _embCalib[_embKeys[_eki]];
                if (!_cd || typeof _cd !== 'object') continue;
                cameras.push(new Camera(
                    _cd.name || _embKeys[_eki],
                    _cd.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    _cd.distortions || _cd.dist || [0, 0, 0, 0, 0],
                    _cd.rotation || _cd.rvec || [0, 0, 0],
                    _cd.translation || _cd.tvec || [0, 0, 0],
                    _cd.size || [640, 480]
                ));
            }
            if (cameras.length > 0) {
                hasCalibration = true;
                console.log('[single-slp] Recovered embedded calibration for', cameras.length, 'camera(s) from project .slp');
            }
        }

        // Build session from SLP data
        var skelData = slpData.skeleton || { name: 'skeleton', nodes: [], edges: [] };
        var skeleton = new Skeleton(skelData.name, skelData.nodes, skelData.edges);

        // Override skeleton if skeleton.json is present (same folder as
        // calibration.toml). One skeleton per project — register it so it
        // propagates to every session.
        if (skeletonFile) {
            try {
                var skelText = await skeletonFile.text();
                var loadedSkel = parseSkeletonJSON(skelText);
                if (loadedSkel && loadedSkel.nodes.length > 0) {
                    skeleton = loadedSkel;
                    setProjectSkeleton(loadedSkel);
                }
            } catch (e) { /* ignore */ }
        }

        // Build video index to name mapping
        var videoIdxToCameraName = {};
        if (cameras.length === 0) {
            // No calibration — map video indices to names from SLP metadata for frame loading,
            // but do NOT create Camera objects. No camera assignments or 3D functionality.
            for (var dvi = 0; dvi < Math.max(slpData.videos.length, 1); dvi++) {
                var vMeta = slpData.videos[dvi];
                var dName = vMeta ? (vMeta.sourceFilename || vMeta.filename) : null;
                if (dName && dName !== '.') {
                    dName = dName.replace(/\.[^.]+$/, '').split('/').pop().split('\\').pop();
                } else {
                    dName = 'cam_' + dvi;
                }
                videoIdxToCameraName[dvi] = dName;
            }
        } else {
            // Map SLP video indices to calibration camera names
            if (slpData.sessions && slpData.sessions.length > 0) {
                var camMap = slpData.sessions[0].camcorder_to_video_idx_map || {};
                for (var cmk in camMap) {
                    var camIdx = parseInt(cmk.replace(/[^0-9]/g, ''));
                    if (cameras[camIdx]) videoIdxToCameraName[camMap[cmk]] = cameras[camIdx].name;
                }
            }
            // Fallback: match by video filename
            for (var vi = 0; vi < slpData.videos.length; vi++) {
                if (videoIdxToCameraName[vi]) continue;
                var vfn = slpData.videos[vi] ? (slpData.videos[vi].sourceFilename || slpData.videos[vi].filename || '') : '';
                var vStem = vfn.replace(/\.[^.]+$/, '').split('/').pop().split('\\').pop().toLowerCase();
                for (var ci = 0; ci < cameras.length; ci++) {
                    if (vStem.indexOf(cameras[ci].name.toLowerCase()) >= 0) {
                        videoIdxToCameraName[vi] = cameras[ci].name;
                        break;
                    }
                }
            }
        }

        var tracks = slpData.tracks.length > 0 ? slpData.tracks : ['track_0'];
        var folderName = allFiles[0].webkitRelativePath ? allFiles[0].webkitRelativePath.split('/')[0] : 'Session';
        var session = new Session(cameras, skeleton, tracks, folderName);

        // Populate frames
        showLoading('Building session...');
        for (var fri = 0; fri < slpData.frames.length; fri++) {
            var fd = slpData.frames[fri];
            var camName = videoIdxToCameraName[fd.videoIdx] || ('cam_' + fd.videoIdx);
            var fg = session.frameGroups.get(fd.frameIdx);
            if (!fg) { fg = new FrameGroup(fd.frameIdx); session.addFrameGroup(fg); }
            for (var ii = 0; ii < fd.instances.length; ii++) {
                var instData = fd.instances[ii];
                var resolvedTrackIdx = resolveImportTrackIdx(session, instData.trackIdx, instData.type);
                var inst = new Instance(instData.points, resolvedTrackIdx, instData.type || 'user', instData.score || 0);
                if (instData.occluded) inst.setOccludedFrom(instData.occluded);
                // Restore the occlusion flag for an unlinked user label (its
                // occluded node was saved finite-xy + not-visible; the
                // nulledNodes flag itself isn't persisted for ungrouped
                // instances). See nulledNodesFromOcclusion.
                var _nn = nulledNodesFromOcclusion(instData.points, instData.occluded, inst.type);
                if (_nn) inst.nulledNodes = _nn;
                fg.addInstance(camName, inst);
            }
        }

        // Restore the project's saved state from the SLP's sessions_json —
        // InstanceGroup grouping, per-instance nulledNodes/occlusion,
        // identities, and 3D points — then move ungrouped instances to the
        // unlinked pool. Shared with File → Load SLP (handleLoadSlpFile). When
        // the file has no sessions_json (a flat 2D SLP) the helper moves every
        // instance to unlinked, matching the previous behavior of this path.
        await restoreGroupingAndUnlink(session, slpData, 0,
            { onProgress: function (msg) { showLoading(msg); } });

        // Save current session state before switching
        if (state.sessions.length > 0 && state.session) {
            var oldSession = state.sessions[state.activeSessionIdx];
            oldSession.lastFrame = state.currentFrame;
            oldSession.triangulationResults = state.triangulationResults;
            oldSession._views = state.views;
            oldSession._videoController = videoController;
            if (viewport3d && viewport3d.threeCamera && viewport3d.controls) {
                oldSession._viewport3dState = {
                    cameraPosition: viewport3d.threeCamera.position.toArray(),
                    cameraUp: viewport3d.threeCamera.up.toArray(),
                    controlsTarget: viewport3d.controls.target.toArray(),
                };
            }
        }

        // Set as active session
        state.sessions.push(session);
        state.activeSessionIdx = state.sessions.length - 1;
        state.session = session;
        state.triangulationResults = new Map();

        // Load videos — match to cameras by filename
        showLoading('Loading videos...');
        state.views = [];
        if (videoController && state.isPlaying) videoController.stopPlayback();
        setVideoController(null);
        paneManager.clearAll();

        // Order videos by calibration camera index so the 2D viewers appear in
        // the project's camera order, not the folder's file-enumeration order
        // (pickFolder returns files in an OS-dependent order, which made the
        // 2D panes reshuffle on reload). Videos that match no camera keep their
        // relative order, placed after the matched ones.
        if (cameras.length > 0) {
            var camOrderIndex = function (vf) {
                var stem = vf.name.replace(/\.[^.]+$/, '').toLowerCase();
                for (var ci = 0; ci < cameras.length; ci++) {
                    if (stem.indexOf(cameras[ci].name.toLowerCase()) >= 0) return ci;
                }
                return cameras.length;
            };
            videoFiles = videoFiles
                .map(function (vf, i) { return { vf: vf, key: camOrderIndex(vf), i: i }; })
                .sort(function (a, b) { return (a.key - b.key) || (a.i - b.i); })
                .map(function (o) { return o.vf; });
        }

        var failedVideos = [];
        for (var vfi = 0; vfi < videoFiles.length; vfi++) {
            var vFile = videoFiles[vfi];
            var vStemName = vFile.name.replace(/\.[^.]+$/, '');
            // Match to a camera only if calibration provides cameras
            var matchedCam = null;
            for (var mci = 0; mci < cameras.length; mci++) {
                if (vStemName.toLowerCase().indexOf(cameras[mci].name.toLowerCase()) >= 0) {
                    matchedCam = cameras[mci].name;
                    break;
                }
            }
            var viewName = matchedCam || vStemName;

            try {
                var decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                await decoder.init(vFile);
                var vw = decoder.videoTrack.video.width;
                var vh = decoder.videoTrack.video.height;
                state.videoFiles.push({
                    file: vFile, name: viewName, decoder: decoder,
                    videoWidth: vw, videoHeight: vh, frameCount: decoder.samples.length,
                    assignedCamera: matchedCam,
                    videoPath: vFile.webkitRelativePath || vFile.name,
                    sessionIdx: state.activeSessionIdx,
                });
                session.videoFileIndices.push(state.videoFiles.length - 1);
                var hasView = state.views.some(function (v) { return v.name === viewName; });
                if (!hasView) {
                    state.views.push({
                        name: viewName, decoder: decoder,
                        canvas: null, ctx: null, overlayCanvas: null, overlayCtx: null,
                        videoWidth: vw, videoHeight: vh, wrapper: null,
                    });
                }
                if (state.totalFrames === 0 || decoder.samples.length > state.totalFrames) {
                    state.totalFrames = decoder.samples.length;
                }
            } catch (e) {
                console.error('[single-slp] Failed to load video:', vFile.name, e);
                var errMsg = e.message || String(e);
                if (errMsg.indexOf('NO_SUPPORTED_STREAMS') >= 0 || errMsg.indexOf('DEMUXER_ERROR') >= 0 || errMsg.indexOf('Video error code 4') >= 0) {
                    failedVideos.push(vFile.name + ' (unsupported codec — transcode to H.264: ffmpeg -i input.mp4 -c:v libx264 -crf 23 output.mp4)');
                } else {
                    failedVideos.push(vFile.name + ': ' + errMsg);
                }
            }
        }

        // Finalize
        if (state.views.length > 0) {
            paneManager._suppressActiveHighlight = true;
            populateViewStrip();
            populateSessionStrip();
            paneManager.addAllViewsAsGrid();
            paneManager._suppressActiveHighlight = false;
            rebuildVideoController();
            updateTotalFrames();
            fitCanvasesToCells();
        }

        if (state.session && hasCalibration) {
            var vp3dMsg = document.getElementById('viewport3dMessage');
            if (vp3dMsg) vp3dMsg.classList.add('hidden');
            if (viewport3d) {
                viewport3d.cameras = session.cameras;
                viewport3d.skeleton = session.skeleton;
                viewport3d.addCameraPyramids();
                viewport3d.setFrame([]);
                viewport3d.fitToScene();
            } else {
                setup3DViewport();
            }
        }

        if (!interactionManager) setupInteraction();
        if (interactionManager && state.views.length > 0) {
            interactionManager.detach();
            interactionManager.attach(state.views);
        }

        hideLoading();
        updateInfoPanel();
        if (timeline) timeline.setData(session);
        if (videoController) await videoController.seekToFrame(0);
        if (failedVideos.length > 0 && state.views.length === 0) {
            setStatus('All videos failed to load: ' + failedVideos.join('; '), 'error');
        } else if (failedVideos.length > 0) {
            setStatus('Loaded ' + state.views.length + ' video(s), ' + failedVideos.length + ' failed: ' + failedVideos[0], 'warning');
        } else {
            setStatus('Loaded session from ' + slpFile.name + ' (' + videoFiles.length + ' videos)', 'success');
        }
    } catch (err) {
        console.error('[single-slp] Error:', err);
        hideLoading();
        setStatus('Load error: ' + err.message, 'error');
    }
}

/**
 * Prompt for + attach the videos of a lazily-reopened project session — the
 * video-finalization step of `handleLoadProjectSlpLazy`, mirroring
 * `handleLoadSlpFile`'s external-video flow. A project `.slp` references its
 * videos by path only, so the user picks the session folder (or files); each
 * picked video is matched to a session camera by parent-directory name, by
 * camera-name-in-stem, or against the video filename referenced in the
 * reopened file (`loader.videos`). Matched videos get decoders + views + the
 * dock grid; unmatched ones are skipped. The prompt is skippable (Esc or the
 * Skip button) — the session then stays video-less exactly like before this
 * step existed, and File → Load Videos still works later.
 *
 * `pickedFilesOverride` (tests/automation): bypasses the prompt and uses the
 * given File list directly.
 *
 * @returns {Promise<boolean>} true if at least one video view was attached.
 */
export async function attachVideosForLazyReopen(session, loader, pickedFilesOverride) {
    var cameras = session.cameras || [];
    var camNames = cameras.map(function (c) { return c.name; });

    // Referenced video basenames from the reopened file — shown in the prompt
    // and used as a filename-matching fallback.
    var refBaseByCam = new Map();
    for (var rci = 0; rci < camNames.length; rci++) {
        var lv = loader.videos && loader.videos.get(camNames[rci]);
        if (lv && lv.filename) {
            refBaseByCam.set(camNames[rci],
                String(lv.filename).replace(/^.*[\/\\]/, '').replace(/\.[^.]+$/, '').toLowerCase());
        }
    }
    var refInfo = 'Cameras: ' + camNames.join(', ');
    if (refBaseByCam.size > 0) {
        refInfo += ' — referenced videos: ' + Array.from(refBaseByCam.values()).join(', ');
    }

    var picked = pickedFilesOverride
        || await forceVideoSelectionWithFolder(refInfo, session.name || 'Session', { allowSkip: true });
    if (!picked || picked.parentResult || picked.length === 0) return false;

    // Filter to real session videos and match each to a camera.
    var vidExts = ['.mp4', '.avi', '.mov', '.mkv', '.webm'];
    var toLoad = [];
    var unmatched = 0;
    for (var pfi = 0; pfi < picked.length; pfi++) {
        var pFile = picked[pfi];
        if (!pFile || !pFile.name) continue;
        var pExt = pFile.name.substring(pFile.name.lastIndexOf('.')).toLowerCase();
        if (vidExts.indexOf(pExt) < 0 || isCalibrationVideoFile(pFile)) continue;
        var pStem = pFile.name.replace(/\.[^.]+$/, '');
        var pStemLower = pStem.toLowerCase();
        if (state.videoFiles.some(function (vf) { return vf.name === pStem; })) continue;

        var pRel = pFile.webkitRelativePath || pFile.name;
        var pParts = pRel.split('/');
        var pParentDir = pParts.length >= 2 ? pParts[pParts.length - 2].toLowerCase() : null;

        var assignedCam = null;
        for (var mci = 0; mci < camNames.length && !assignedCam; mci++) {
            if (pParentDir && pParentDir === camNames[mci].toLowerCase()) assignedCam = camNames[mci];
        }
        for (var sci = 0; sci < camNames.length && !assignedCam; sci++) {
            if (pStemLower.indexOf(camNames[sci].toLowerCase()) >= 0) assignedCam = camNames[sci];
        }
        for (var bci = 0; bci < camNames.length && !assignedCam; bci++) {
            var refBase = refBaseByCam.get(camNames[bci]);
            if (refBase && (pStemLower === refBase || pStemLower.indexOf(refBase) >= 0 || refBase.indexOf(pStemLower) >= 0)) {
                assignedCam = camNames[bci];
            }
        }
        if (!assignedCam) { unmatched++; continue; }
        if (toLoad.some(function (e) { return e.assignedCam === assignedCam; })) continue;
        toLoad.push({ file: pFile, stem: pStem, rel: pRel, assignedCam: assignedCam });
    }
    if (toLoad.length === 0) {
        if (unmatched > 0) {
            setStatus(unmatched + ' video(s) matched no camera (' + camNames.join(', ') + ') — use File → Load Videos', 'warning');
        }
        return false;
    }

    showLoading('Loading ' + toLoad.length + ' video(s)...');
    var modal = getLoadingProgressModal({ title: 'Loading videos' });
    modal.reset();
    modal.show();

    await Promise.allSettled(toLoad.map(async function (entry) {
        var taskId = modal.addTask({ label: entry.file.name });
        try {
            var decoder = new OnDemandVideoDecoder({
                cacheSize: 60, lookahead: 10,
                onProgress: function (ev) {
                    if (ev && ev.error) modal.failTask(taskId, ev.error);
                    else modal.updateTask(taskId, ev);
                },
            });
            await decoder.init(entry.file);
            entry.decoder = decoder;
            modal.completeTask(taskId);
        } catch (decErr) {
            console.error('[load-project-lazy] Failed to load video:', entry.file.name, decErr);
            entry.error = decErr;
            modal.failTask(taskId, decErr);
        }
    }));

    var attachedNames = [];
    var failed = [];
    for (var li = 0; li < toLoad.length; li++) {
        var lEntry = toLoad[li];
        if (!lEntry.decoder) { failed.push(lEntry.file.name); continue; }
        var vfEntry = {
            file: lEntry.file, name: lEntry.stem, decoder: lEntry.decoder,
            videoWidth: lEntry.decoder.videoTrack.video.width,
            videoHeight: lEntry.decoder.videoTrack.video.height,
            frameCount: lEntry.decoder.samples.length,
            assignedCamera: lEntry.assignedCam,
            videoPath: lEntry.rel,
            sessionIdx: state.activeSessionIdx,
        };
        state.videoFiles.push(vfEntry);
        var hasView = state.views.some(function (v) { return v.name === lEntry.assignedCam; });
        if (!hasView) createViewForVideoFile(vfEntry);
        attachedNames.push(lEntry.assignedCam);
    }
    if (attachedNames.length === 0) {
        hideLoading();
        if (failed.length > 0) setStatus('All videos failed to load: ' + failed.join('; '), 'error');
        return false;
    }

    paneManager._suppressActiveHighlight = true;
    populateViewStrip();
    populateSessionStrip();
    paneManager.addAllViewsAsGrid();
    paneManager._suppressActiveHighlight = false;
    rebuildVideoController();
    updateTotalFrames();
    fitCanvasesToCells();
    hideWelcomeOverlay();

    if (!interactionManager) setupInteraction();
    if (interactionManager && state.views.length > 0) {
        interactionManager.detach();
        interactionManager.attach(state.views);
    }
    recomputeUploadedCameras(session, state);
    if (timeline) timeline.refreshTracks(session);

    // Render the images (the current frame's 2D is already hydrated).
    if (videoController) await videoController.seekToFrame(state.currentFrame);
    drawAllOverlays(state.currentFrame);
    hideLoading();
    if (failed.length > 0) {
        setStatus('Attached ' + attachedNames.length + ' video(s), ' + failed.length + ' failed: ' + failed[0], 'warning');
    }
    return true;
}

/**
 * Reopen a large project `.slp` LAZILY (the memory-bounded "Load Project" path).
 *
 * The eager path (`handleLoadSlpFile` / `parseSlpViaSleapIO`) materializes every
 * frame's 2D (21.7M points on a real cage5 project) plus a full grouping
 * reconstruct duplicate and OOMs the tab. This instead:
 *  - opens the single multi-camera file lazily (`SioLazyLoader.openProjectSlp`) so
 *    2D frames materialize on demand;
 *  - restores calibration + identities + `frameIdentityMap` from the embedded
 *    `sessions_json`;
 *  - rebuilds `session.instanceGroups` with LIGHTWEIGHT members (3D + refs, no 2D)
 *    via `reconstructInstanceGroupsFromSessionLazy` (~2.5s, ~1 GB) — 2D hydrates
 *    on scrub (`ensureLazyFrameData` → `finalizeLazyFrameGroup`).
 *
 * A project `.slp` only references videos by path, so after the data comes up
 * the user is prompted to attach them (`attachVideosForLazyReopen`, skippable —
 * File → Load Videos still works later).
 */
export async function handleLoadProjectSlpLazy(slpFile) {
    try {
        if (!(await ensureNo3dImportBlockingLoad())) { setStatus('Load cancelled', 'warning'); return; }
        showLoading('Reopening project (lazy): ' + slpFile.name + '...');

        // Free the PREVIOUS project's memory BEFORE opening the new one. A large
        // lazy session holds ~1 GB in its loader + GBs of grouping/3D; opening a
        // second project on top OOMs the tab (user-reported). Evict every resident
        // session's lazyLoader + grouping, close decoders, and start fresh.
        if (videoController) {
            if (state.isPlaying && typeof videoController.pause === 'function') videoController.pause();
            setVideoController(null);
        }
        for (var _psi = 0; _psi < (state.sessions || []).length; _psi++) {
            var _ps = state.sessions[_psi];
            if (!_ps) continue;
            if (_ps.lazyLoader && typeof _ps.lazyLoader.close === 'function') {
                try { _ps.lazyLoader.close(); } catch (e) { /* ignore */ }
            }
            _ps.lazyLoader = null;
            _ps.instanceGroups = new Map();
            _ps.frameGroups = new Map();
        }
        if (Array.isArray(state.decoderPool)) {
            for (var _dpi = 0; _dpi < state.decoderPool.length; _dpi++) {
                var _dp = state.decoderPool[_dpi];
                if (_dp && typeof _dp.close === 'function') { try { _dp.close(); } catch (e) { /* ignore */ } }
            }
        }
        state.decoderPool = [];
        if (Array.isArray(state._decoderPoolCold)) {
            for (var _dci = 0; _dci < state._decoderPoolCold.length; _dci++) {
                var _dc = state._decoderPoolCold[_dci];
                if (_dc && _dc._coldTimer) { clearTimeout(_dc._coldTimer); _dc._coldTimer = null; }
                if (_dc && typeof _dc.close === 'function') { try { _dc.close(); } catch (e) { /* ignore */ } }
            }
        }
        state._decoderPoolCold = [];
        state.sessions = [];
        state.session = null;
        state.views = [];
        state.videoFiles = [];
        state.triangulationResults = new Map();
        // Plane state is project-scoped and lives on a module singleton, so
        // it does NOT go away with `state.sessions`. `readPlaneMetadata`
        // only restores into an EMPTY model, so without this the previous
        // project's planes would survive and the new one's be dropped.
        resetPlaneState();
        paneManager.clearAll();

        var loader = new SioLazyLoader();
        var opened = await loader.openProjectSlp(slpFile, function (msg) { showLoading(msg); });
        var labels = opened.labels;
        var typedSession = opened.typedSession;

        // Cameras from the embedded calibration.
        var cameras = [];
        if (loader.calibration) {
            var calKeys = Object.keys(loader.calibration).filter(function (k) { return k !== 'metadata'; });
            for (var cki = 0; cki < calKeys.length; cki++) {
                var cd = loader.calibration[calKeys[cki]];
                if (!cd || typeof cd !== 'object') continue;
                cameras.push(new Camera(
                    cd.name || calKeys[cki],
                    cd.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    cd.distortions || cd.dist || [0, 0, 0, 0, 0],
                    cd.rotation || cd.rvec || [0, 0, 0],
                    cd.translation || cd.tvec || [0, 0, 0],
                    cd.size || [640, 480]
                ));
            }
        }
        var hasCalibration = cameras.length > 0;

        var skeleton = new Skeleton(loader.skeleton.name, loader.skeleton.nodes, loader.skeleton.edges);
        var tracks = loader.trackNames.length ? loader.trackNames.slice() : ['track_0'];

        var lucid = ((labels.rawSessionsJson || [])[0] || {}).metadata;
        lucid = (lucid && lucid.lucid) || {};
        var sessName = lucid.sessionName || slpFile.name.replace(/\.slp$/i, '');
        var session = new Session(cameras, skeleton, tracks, sessName);
        if (lucid.identities && lucid.identities.length) {
            session.identities = lucid.identities.map(function (id, i) {
                return new Identity(i, id.name || ('id_' + i), id.color || null);
            });
        }
        if (lucid.frameIdentityMap) session.ingestFrameIdentityEntries(lucid.frameIdentityMap);
        if (lucid.trustTracks != null) session.trustTracks = lucid.trustTracks;
        // Session-scoped Visibility-panel state — the lazy-reopen mirror of the
        // eager read in import-export/slp-import.js.
        readVisibilityMetadata(session, lucid);
        // Define Planes state — the lazy-reopen mirror of the eager read in
        // `import-export/slp-import.js`.
        readPlaneMetadata(session, lucid);

        session.lazyLoader = loader;
        session._lazyReopened = true;

        // Rebuild grouping + 3D (lightweight, memory-bounded).
        var nodeNames = skeleton.nodes.map(function (n) { return typeof n === 'string' ? n : (n.name || ''); });
        await reconstructInstanceGroupsFromSessionLazy(session, typedSession, loader, nodeNames,
            { onProgress: function (m) { showLoading(m); } });

        // Activate the reopened session (the previous project was already evicted
        // + state reset at the top, so this is the sole session).
        state.sessions.push(session);
        state.activeSessionIdx = state.sessions.length - 1;
        state.session = session;
        state.totalFrames = loader.nFrames;
        // No decoders yet, so updateTotalFrames() (which reads decoder sample
        // counts, and resets to 0 when there are none) can't be used here —
        // write the frame counter + timeline span from the labeled-frame count
        // directly. attachVideosForLazyReopen refines both from the real
        // decoders once videos are attached.
        var tfEl = document.getElementById('totalFrames');
        if (tfEl) tfEl.textContent = state.totalFrames;

        // 3D viewport (needs a live session).
        if (hasCalibration) {
            var vp3dMsg = document.getElementById('viewport3dMessage');
            if (vp3dMsg) vp3dMsg.classList.add('hidden');
            if (!viewport3d) setup3DViewport();
            if (viewport3d) {
                viewport3d.cameras = session.cameras;
                viewport3d.skeleton = session.skeleton;
                viewport3d.addCameraPyramids();
                viewport3d.setFrame([]);
                viewport3d.fitToScene();
            }
        }
        if (!interactionManager) setupInteraction();
        if (!timeline) setupTimeline();
        if (timeline) {
            timeline.setData(session);
            // setData does not propagate the frame span (other load paths pair
            // it with setTotalFrames) — without this the timeline clamps to 1.
            timeline.setTotalFrames(state.totalFrames);
        }

        // Land on the first grouped frame + render it (hydrates its 2D).
        var gk = Array.from(session.instanceGroups.keys());
        gk.sort(function (a, b) { return a - b; });
        var firstFrame = gk.length ? gk[0] : 0;
        state.currentFrame = firstFrame;
        await ensureLazyFrameData(firstFrame);
        // Reveal the reprojection-error section BEFORE drawing — every other
        // path that populates 3D/reprojection data (Triangulate All, group
        // edits, propagate) calls this, but the lazy-reopen path never did.
        // The underlying computation (drawAllOverlays's lazy-reproject block,
        // driven by each group's restored points3d) was already correct —
        // the section just stayed at its HTML default (display:none) forever
        // after a reopen, so the error text was there but invisible. Matches
        // the report: "reprojections show in the 2D/3D viewer [independent
        // of this section] but the Instance panel's reprojection error never
        // populates."
        if (session.instanceGroups.size > 0) setReprojErrorVisible(true);
        drawAllOverlays(firstFrame);
        if (viewport3d) viewport3d.setFrame(getInstanceGroupsForFrame(firstFrame));
        if (typeof updateSeekbar === 'function') updateSeekbar();

        hideLoading();
        updateInfoPanel();

        // Attach the project's videos (prompt; Esc/Skip keeps them deferred).
        var videosAttached = false;
        try {
            videosAttached = await attachVideosForLazyReopen(session, loader);
        } catch (vErr) {
            console.error('[load-project-lazy] Video attach failed:', vErr);
            hideLoading();
        }
        updateInfoPanel();
        if (videosAttached) {
            setStatus('Reopened ' + slpFile.name + ' — ' + session.instanceGroups.size
                + ' grouped frames, ' + state.views.length + ' videos', 'success');
        } else {
            setStatus('Reopened ' + slpFile.name + ' — ' + session.instanceGroups.size
                + ' grouped frames, ' + loader.nFrames + ' frames. File → Load Videos to show images.', 'success');
        }
    } catch (err) {
        console.error('[load-project-lazy] Error:', err);
        hideLoading();
        setStatus('Lazy reopen error: ' + (err && err.message || err), 'error');
    }
}

export async function handleLoadSessionFolderPerCamera(preloadedFiles, deferVideos) {
    try {
        var allFiles;
        if (preloadedFiles) {
            allFiles = preloadedFiles;
        } else {
            setStatus('Pick session folder...', 'warning');
            allFiles = await pickFolder();
            if (allFiles.length === 0) {
                setStatus('No folder selected', 'warning');
                return;
            }
        }

        showLoading('Scanning folder...');

        // For multi-session: save previous session's UI state before loading new one
        var previousSession = state.session;
        if (previousSession) {
            previousSession.lastFrame = state.currentFrame;
            previousSession.triangulationResults = state.triangulationResults;
            previousSession._views = state.views;
            previousSession._videoController = videoController;
        }
        // Start fresh for the new session
        state.session = null;
        state.views = [];
        state.triangulationResults = new Map();
        if (videoController && state.isPlaying) videoController.stopPlayback();
        setVideoController(null);

        // Derive folder name from first file's relative path
        var folderName = null;
        if (allFiles.length > 0) {
            var firstRelPath = allFiles[0].webkitRelativePath || '';
            var firstParts = firstRelPath.split('/');
            if (firstParts.length > 1) {
                folderName = firstParts[0];
            }
        }

        // Categorize files into per-camera directories
        var calibFile = null;
        var skeletonFile = null;
        var videoExtensions = ['.mp4', '.avi', '.webm', '.mov', '.mkv'];

        // Log all files for debugging
        console.log('[session-folder] All files in folder (' + allFiles.length + '):');
        for (var di = 0; di < allFiles.length; di++) {
            console.log('  ' + (allFiles[di].webkitRelativePath || allFiles[di].name));
        }

        // Build per-directory map
        var cameraDirs = {};  // dirName -> { videos: [File], slps: [File], envSlps: [File], dirNameLower: string }
        for (var fi = 0; fi < allFiles.length; fi++) {
            var file = allFiles[fi];
            var relPath = file.webkitRelativePath || file.name;
            var parts = relPath.split('/');

            // Root-level files (parts.length === 2)
            if (parts.length === 2) {
                var fileNameLower = parts[1].toLowerCase();
                if ((fileNameLower.endsWith('.toml') || fileNameLower.endsWith('.json'))
                    && fileNameLower.indexOf('calib') >= 0) {
                    calibFile = file;
                } else if (fileNameLower.endsWith('.json') && fileNameLower.indexOf('skeleton') >= 0) {
                    skeletonFile = file;
                }
                continue;
            }

            // Subdirectory files (parts.length === 3: root/dirName/file)
            if (parts.length === 3) {
                var dirName = parts[1];  // camera directory name (preserve original case)
                var fileName = parts[2];
                var fnLower = fileName.toLowerCase();

                if (!cameraDirs[dirName]) {
                    cameraDirs[dirName] = { videos: [], slps: [], envSlps: [], dirNameLower: dirName.toLowerCase() };
                }

                var ext = fnLower.substring(fnLower.lastIndexOf('.'));
                if (videoExtensions.indexOf(ext) >= 0) {
                    cameraDirs[dirName].videos.push(file);
                } else if (fnLower.endsWith('.slp') || fnLower.endsWith('.h5')) {
                    // Separate environment files from main annotation files
                    if (fnLower.indexOf('.externals.') >= 0) {
                        cameraDirs[dirName].envSlps.push(file);
                    } else {
                        cameraDirs[dirName].slps.push(file);
                    }
                }
            }
        }

        console.log('[session-folder] Categorization result:', {
            calibration: calibFile ? calibFile.name : null,
            skeleton: skeletonFile ? skeletonFile.name : null,
            cameraDirs: Object.keys(cameraDirs).map(function (d) {
                return d + ' (' + cameraDirs[d].videos.length + ' videos, ' + cameraDirs[d].slps.length + ' slps, ' + cameraDirs[d].envSlps.length + ' env)';
            }),
        });

        // 1. Load calibration if found
        var cameras = [];
        var hasCalibration = false;
        if (calibFile) {
            showLoading('Loading calibration...');
            var calibText = await calibFile.text();
            try {
                if (calibFile.name.toLowerCase().endsWith('.toml')) {
                    cameras = parseCalibrationTOML(calibText);
                } else {
                    cameras = parseCalibrationJSON(calibText);
                }
                console.log('[session-folder] Loaded ' + cameras.length + ' cameras from calibration');
                hasCalibration = cameras.length > 0;
            } catch (calibErr) {
                console.error('[session-folder] Calibration parse error:', calibErr);
                setStatus('Warning: calibration parse failed — load separately later', 'warning');
            }
        } else {
            console.log('[session-folder] No calibration file found — can be loaded separately');
        }

        // 2. Match camera dirs to calibration cameras
        var matchedCameraDirs = [];  // { dirName, camName, videos, slps }
        var missingCameras = [];

        console.log('[session-folder] Camera names from calibration:', cameras.map(function(c) { return c.name; }));
        console.log('[session-folder] Directory names found:', Object.keys(cameraDirs));

        if (cameras.length > 0) {
            for (var ci = 0; ci < cameras.length; ci++) {
                var cam = cameras[ci];
                var camLower = cam.name.toLowerCase();
                var found = false;
                for (var dirName in cameraDirs) {
                    var dirLower = cameraDirs[dirName].dirNameLower;
                    console.log('[session-folder] Matching cam "' + cam.name + '" (lower: "' + camLower + '") vs dir "' + dirName + '" (lower: "' + dirLower + '"): exact=' + (dirLower === camLower) + ' cam+=' + (dirLower === 'cam' + camLower) + ' strip=' + (dirLower.replace('cam', '') === camLower));
                    if (dirLower === camLower || dirLower === 'cam' + camLower || dirLower.replace('cam', '') === camLower) {
                        // Include even if no videos — will show as "None" in assignment panel
                        matchedCameraDirs.push({
                            dirName: dirName,
                            camName: cam.name,
                            videos: cameraDirs[dirName].videos,
                            slps: cameraDirs[dirName].slps,
                            envSlps: cameraDirs[dirName].envSlps
                        });
                        found = true;
                        break;
                    }
                }
                if (!found) missingCameras.push(cam.name);
            }

        } else {
            // No calibration — load videos from all directories but do NOT create cameras.
            // Videos can be viewed but camera assignments and 3D features require calibration.
            for (var dirName in cameraDirs) {
                if (cameraDirs[dirName].videos.length > 0 || cameraDirs[dirName].slps.length > 0) {
                    matchedCameraDirs.push({
                        dirName: dirName,
                        camName: dirName,
                        videos: cameraDirs[dirName].videos,
                        slps: cameraDirs[dirName].slps,
                        envSlps: cameraDirs[dirName].envSlps,
                        noCalibration: true
                    });
                }
            }
        }

        // Collect all missing items and show a single combined popup
        var missingDirItems = missingCameras.map(function (n) { return { name: n, type: 'video' }; });
        var missingVideoItems = [];
        for (var mvi = 0; mvi < matchedCameraDirs.length; mvi++) {
            var mcd = matchedCameraDirs[mvi];
            if (mcd.videos.length === 0) {
                missingVideoItems.push({ name: mcd.camName, type: 'video' });
            }
        }

        if (missingDirItems.length > 0 || missingVideoItems.length > 0) {
            hideLoading();
            var popupSections = [];
            if (missingDirItems.length > 0) {
                popupSections.push({
                    title: 'Missing Camera Directories' + (folderName ? ' — ' + folderName : ''),
                    subtitle: 'The following cameras from calibration have no matching directory.',
                    items: missingDirItems
                });
            }
            if (missingVideoItems.length > 0) {
                popupSections.push({
                    title: 'Missing Video Files' + (folderName ? ' — ' + folderName : ''),
                    subtitle: 'The following cameras have SLP annotations but no video file.',
                    items: missingVideoItems
                });
            }
            var allImported = await showMissingFilesPopup(popupSections);

            // Apply imported files
            for (var [impName, impFile] of allImported) {
                // Check if it's a missing directory camera — add new entry
                var isMissingDir = missingDirItems.some(function (d) { return d.name === impName; });
                if (isMissingDir) {
                    matchedCameraDirs.push({
                        dirName: impName,
                        camName: impName,
                        videos: [impFile],
                        slps: [],
                        envSlps: []
                    });
                } else {
                    // Missing video — add to existing entry
                    for (var mvj = 0; mvj < matchedCameraDirs.length; mvj++) {
                        if (matchedCameraDirs[mvj].camName === impName) {
                            matchedCameraDirs[mvj].videos.push(impFile);
                            break;
                        }
                    }
                }
            }
            showLoading('Loading session...');
        }

        if (matchedCameraDirs.length === 0) {
            hideLoading();
            setStatus('No camera directories with videos found in folder', 'error');
            return;
        }

        console.log('[session-folder] Matched camera dirs:', matchedCameraDirs.length);

        // Cache camera-to-subdirectory mapping for export
        state.cameraDirMap = {};
        for (var mci = 0; mci < matchedCameraDirs.length; mci++) {
            state.cameraDirMap[matchedCameraDirs[mci].camName] = matchedCameraDirs[mci].dirName;
        }

        // Cache env files on the session for later "Set Env" loading
        var envFilesByCam = {};
        for (var eci = 0; eci < matchedCameraDirs.length; eci++) {
            var ecd = matchedCameraDirs[eci];
            if (ecd.envSlps && ecd.envSlps.length > 0) {
                envFilesByCam[ecd.camName] = ecd.envSlps;
            }
        }

        // 3. Load each camera directory
        // Reset views/UI for new session but keep global videoFiles (other sessions need them)
        if (videoController && state.isPlaying) videoController.pause();
        setVideoController(null);
        state.views = [];
        paneManager.clearAll();
        var stripList = document.getElementById('viewStripList');
        if (stripList) stripList.innerHTML = '';

        var firstSession = null;
        var skeletonFromSlp = null;
        var slpVersionsLoaded = {}; // camName -> version number loaded

        // Launch all SLP/H5 parses — use lazy loading for large H5 files
        showLoading('Parsing annotations (' + matchedCameraDirs.length + ' cameras)...');
        var parseJobs = [];
        var lazyJobs = [];
        for (var cdi = 0; cdi < matchedCameraDirs.length; cdi++) {
            var camDir = matchedCameraDirs[cdi];
            if (camDir.slps.length > 0) {
                // Pick exactly ONE .slp per camera — the highest `_vN` version
                // (first-wins on a tie / when none are versioned). A camera dir
                // accumulates successive exports (e.g. `<stem>_v1.slp`,
                // `<stem>_v2.slp`, …); only the latest reflects current state.
                // Parsing every file here stacked all versions' instances into
                // the same (frame, camera) slot — the same two tracks repeated N
                // times in the Instances tab.
                var bestVersion = -1;
                var bestSlp = camDir.slps[0];
                for (var sli = 0; sli < camDir.slps.length; sli++) {
                    var slStem = camDir.slps[sli].name.replace(/\.[^.]+$/, '');
                    var slVer = slStem.match(/_(?:3D_)?v(\d+)$/);
                    var ver = slVer ? parseInt(slVer[1]) : 0;
                    if (ver > bestVersion) { bestVersion = ver; bestSlp = camDir.slps[sli]; }
                }
                slpVersionsLoaded[camDir.camName] = bestVersion;
                if (camDir.slps.length > 1) {
                    console.log('[session-folder] ' + camDir.camName + ': '
                        + camDir.slps.length + ' .slp files found — loading only "'
                        + bestSlp.name + '" (highest version), skipping '
                        + (camDir.slps.length - 1) + ' older file(s).');
                }
                if (shouldUseLazyH5(bestSlp) || shouldUseLazySlp(bestSlp)) {
                    lazyJobs.push({ camName: camDir.camName, file: bestSlp });
                } else {
                    parseJobs.push({
                        camName: camDir.camName,
                        file: bestSlp,
                        promise: parseSlpH5(bestSlp).catch(function (e) { return null; }),
                    });
                }
            }
        }

        // Open lazy files (metadata only — fast). Large `.slp` predictions use the
        // sleap-io.js streaming lazy reader (SioLazyLoader); SLEAP analysis `.h5`
        // use the worker-backed LazyFrameLoader. A session folder is normally
        // homogeneous; pick the reader by the lazy jobs' extension.
        var lazyLoader = null;
        if (lazyJobs.length > 0) {
            var lazyAreSlp = lazyJobs.every(function (job) {
                return /\.slp$/i.test(job.file.name);
            });
            lazyLoader = lazyAreSlp ? new SioLazyLoader() : new LazyFrameLoader();
            showLoading('Opening ' + lazyJobs.length + ' large '
                + (lazyAreSlp ? 'SLP' : 'H5') + ' file(s) (lazy mode)...');
            try {
                await Promise.all(lazyJobs.map(function (job) {
                    return lazyLoader.open(job.camName, job.file);
                }));
            } catch (lazyErr) {
                // Do NOT fall back to eager parseSlpH5 — a 100+ MB file would OOM
                // the tab (the very thing lazy mode avoids). Surface the error.
                console.error('[session-folder] Lazy load failed:', lazyErr);
                hideLoading();
                setStatus('Failed to load annotations (lazy): ' + (lazyErr && lazyErr.message || lazyErr), 'error');
                return;
            }
        }

        var parseResults = await Promise.all(parseJobs.map(function (j) { return j.promise; }));
        showLoading('Building session data...');

        for (var pri = 0; pri < parseJobs.length; pri++) {
            var slpData = parseResults[pri];
            if (!slpData) continue;
            var camName = parseJobs[pri].camName;

            if (slpData.skeleton && !skeletonFromSlp) {
                skeletonFromSlp = slpData.skeleton;
            }

            if (!state.session) {
                var skeleton = new Skeleton('skeleton', [], []);
                var tracks = slpData.tracks || ['track_0'];
                var sessionName = folderName || ('Session ' + (state.sessions.length + 1));
                state.session = new Session(cameras.length > 0 ? cameras : [], skeleton, tracks, sessionName);
                firstSession = state.session;
                if (state.sessions.indexOf(state.session) < 0) {
                    state.sessions.push(state.session);
                    state.activeSessionIdx = state.sessions.length - 1;
                }
            }

            var trackRemap = {};
            if (slpData.tracks) {
                for (var ti = 0; ti < slpData.tracks.length; ti++) {
                    var existingIdx = state.session.tracks.indexOf(slpData.tracks[ti]);
                    if (existingIdx >= 0) {
                        trackRemap[ti] = existingIdx;
                    } else {
                        trackRemap[ti] = state.session.tracks.length;
                        state.session.tracks.push(slpData.tracks[ti]);
                    }
                }
            }

            if (slpData.frames) {
                for (var fri = 0; fri < slpData.frames.length; fri++) {
                    var frameData = slpData.frames[fri];
                    var frameIdx = frameData.frameIdx !== undefined ? frameData.frameIdx : (frameData.frame_idx !== undefined ? frameData.frame_idx : fri);
                    if (!state.session.frameGroups.has(frameIdx)) {
                        state.session.addFrameGroup(new FrameGroup(frameIdx));
                    }
                    var fg = state.session.getFrameGroup(frameIdx);
                    if (frameData.instances) {
                        for (var ii = 0; ii < frameData.instances.length; ii++) {
                            var inst = frameData.instances[ii];
                            var rawTrackIdx = inst.trackIdx !== undefined ? inst.trackIdx : (inst.track_idx !== undefined ? inst.track_idx : 0);
                            var remappedTrackIdx = trackRemap[rawTrackIdx] !== undefined ? trackRemap[rawTrackIdx] : rawTrackIdx;
                            var instType = inst.type || (inst.from_predicted !== undefined ? 'predicted' : 'user');
                            var trackIdx = resolveImportTrackIdx(state.session, remappedTrackIdx, instType);
                            var instance = new Instance(inst.points || [], trackIdx, instType, inst.score || 1.0);
                            if (inst.occluded) instance.setOccludedFrom(inst.occluded);
                            fg.addInstance(camName, instance);
                        }
                    }
                }
            }
        }

        // Integrate lazy loader metadata into session
        if (lazyLoader) {
            if (!state.session) {
                var lazySkel = lazyLoader.skeleton || { name: 'skeleton', nodes: [], edges: [] };
                var lazySkeleton = new Skeleton(lazySkel.name || 'skeleton', lazySkel.nodes || [], lazySkel.edges || []);
                var lazyTracks = lazyLoader.trackNames.length > 0 ? lazyLoader.trackNames : ['track_0'];
                var sessionName = folderName || ('Session ' + (state.sessions.length + 1));
                state.session = new Session(cameras.length > 0 ? cameras : [], lazySkeleton, lazyTracks, sessionName);
                firstSession = state.session;
                skeletonFromSlp = lazySkel;
                if (state.sessions.indexOf(state.session) < 0) {
                    state.sessions.push(state.session);
                    state.activeSessionIdx = state.sessions.length - 1;
                }
            } else {
                if (lazyLoader.trackNames) {
                    for (var lti = 0; lti < lazyLoader.trackNames.length; lti++) {
                        if (state.session.tracks.indexOf(lazyLoader.trackNames[lti]) < 0) {
                            state.session.tracks.push(lazyLoader.trackNames[lti]);
                        }
                    }
                }
            }
            state.session.lazyLoader = lazyLoader;
            if (lazyLoader.trackOccupancy.size > 0) {
                state.session.trackOccupancy = lazyLoader.trackOccupancy;
            }
            if (lazyLoader.nFrames > state.totalFrames) {
                state.totalFrames = lazyLoader.nFrames;
            }
        }

        // Recover embedded calibration (#134 / eric/fix-save): a LUCID project
        // .slp carries its calibration inside sessions_json, but this loader
        // otherwise reads calibration ONLY from a separate calibration.toml — so
        // reopening a saved project with no .toml fell back to placeholder
        // identity cameras (calibration silently lost). When no .toml cameras
        // were parsed, build real Camera objects from the lazy loader's captured
        // embedded calibration BEFORE the video loop, so it finds them and does
        // not synthesize placeholders.
        if (cameras.length === 0 && lazyLoader && lazyLoader.calibration && state.session) {
            var _embCal = lazyLoader.calibration;
            var _embKeys = Object.keys(_embCal).filter(function (k) { return k !== 'metadata'; });
            for (var _eki = 0; _eki < _embKeys.length; _eki++) {
                var _cd = _embCal[_embKeys[_eki]];
                if (!_cd || typeof _cd !== 'object') continue;
                var _cn = _cd.name || _embKeys[_eki];
                if (state.session.cameras.some(function (c) { return c.name === _cn; })) continue;
                state.session.cameras.push(new Camera(
                    _cn,
                    _cd.matrix || [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                    _cd.distortions || _cd.dist || [0, 0, 0, 0, 0],
                    _cd.rotation || _cd.rvec || [0, 0, 0],
                    _cd.translation || _cd.tvec || [0, 0, 0],
                    _cd.size || [640, 480]
                ));
            }
            if (_embKeys.length > 0) {
                console.log('[session-folder] Recovered embedded calibration for', _embKeys.length, 'camera(s) from project .slp');
            }
        }

        // Load videos for each camera directory
        for (var vdi = 0; vdi < matchedCameraDirs.length; vdi++) {
            var camDir = matchedCameraDirs[vdi];
            var camName = camDir.camName;

            // Scan SLP files for highest version (for export naming)
            var slpFilenameForCam = null;
            var highestVersion = 0;
            for (var sfi = 0; sfi < camDir.slps.length; sfi++) {
                var slpName = camDir.slps[sfi].name;
                if (!slpFilenameForCam) slpFilenameForCam = slpName;
                var slpStem = slpName.replace(/\.[^.]+$/, '');
                var verMatch = slpStem.match(/_(?:3D_)?v(\d+)$/);
                if (verMatch) {
                    var ver = parseInt(verMatch[1]);
                    if (ver > highestVersion) {
                        highestVersion = ver;
                        slpFilenameForCam = slpName;
                    }
                }
            }

            // Load video (first in directory)
            if (camDir.videos.length > 0) {
                var videoFile = camDir.videos[0];

                if (!state.session) {
                    var sessionName = folderName || ('Session ' + (state.sessions.length + 1));
                    state.session = new Session(cameras.length > 0 ? cameras : [], buildRememberedSkeleton() || new Skeleton('skeleton', [], []), ['track_0'], sessionName);
                    if (state.sessions.indexOf(state.session) < 0) {
                        state.sessions.push(state.session);
                        state.activeSessionIdx = state.sessions.length - 1;
                    }
                }

                var sessionIdx = state.sessions.indexOf(state.session);
                var videoStem = videoFile.name.replace(/\.[^.]+$/, '');
                var assignCam = camDir.noCalibration ? null : camName;
                var viewName = camDir.noCalibration ? videoStem : camName;

                if (deferVideos) {
                    // Store file ref only — decoder created on session switch
                    state.videoFiles.push({
                        file: videoFile,
                        name: viewName,
                        decoder: null,
                        videoWidth: 0, videoHeight: 0,
                        frameCount: 0,
                        assignedCamera: assignCam,
                        slpFilename: slpFilenameForCam,
                        videoPath: videoFile.webkitRelativePath || videoFile.name,
                        sessionIdx: sessionIdx,
                    });
                    var loadedVfIdx = state.videoFiles.length - 1;
                    if (state.session.videoFileIndices.indexOf(loadedVfIdx) < 0) {
                        state.session.videoFileIndices.push(loadedVfIdx);
                    }
                } else {
                    showLoading('Loading video: ' + videoFile.name + '...');
                    try {
                        var decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                        await decoder.init(videoFile);
                        state.decoderPool.push(decoder);
                        var vw = decoder.videoTrack.video.width;
                        var vh = decoder.videoTrack.video.height;

                        state.videoFiles.push({
                            file: videoFile,
                            name: viewName,
                            decoder: decoder,
                            videoWidth: vw, videoHeight: vh,
                            frameCount: decoder.samples.length,
                            assignedCamera: assignCam,
                            slpFilename: slpFilenameForCam,
                            videoPath: videoFile.webkitRelativePath || videoFile.name,
                            sessionIdx: sessionIdx,
                        });
                        var loadedVfIdx = state.videoFiles.length - 1;
                        if (state.session.videoFileIndices.indexOf(loadedVfIdx) < 0) {
                            state.session.videoFileIndices.push(loadedVfIdx);
                        }

                        if (assignCam && !state.session.cameras.some(function (c) { return c.name === camName; })) {
                            state.session.cameras.push(
                                new Camera(camName, [[600,0,vw/2],[0,600,vh/2],[0,0,1]],
                                    [0,0,0,0,0], [0,0,0], [0,0,0], [vw, vh])
                            );
                        }

                        state.views.push({
                            name: viewName,
                            decoder: decoder,
                            canvas: null, ctx: null,
                            overlayCanvas: null, overlayCtx: null,
                            videoWidth: vw, videoHeight: vh,
                            wrapper: null,
                        });

                        if (state.totalFrames === 0 || decoder.samples.length > state.totalFrames) {
                            state.totalFrames = decoder.samples.length;
                        }
                        if (state.fps === 0 || state.fps === 30) {
                            state.fps = decoder.videoTrack.duration > 0
                                ? decoder.samples.length / (decoder.videoTrack.duration / decoder.videoTrack.timescale)
                                : 30;
                        }
                    } catch (vidErr) {
                        console.error('[session-folder] Failed to load video ' + videoFile.name + ':', vidErr);
                    }
                }
            }
        }

        // Check SLP version consistency across cameras
        var loadedVersions = Object.values(slpVersionsLoaded);
        if (loadedVersions.length > 1) {
            var allSame = loadedVersions.every(function (v) { return v === loadedVersions[0]; });
            if (!allSame) {
                var versionDetails = Object.keys(slpVersionsLoaded).map(function (cam) {
                    return cam + ': v' + slpVersionsLoaded[cam];
                }).join(', ');
                console.warn('[session-folder] Inconsistent SLP versions across cameras:', versionDetails);
                setStatus('Warning: SLP versions differ across cameras (' + versionDetails + ')', 'warning');
            }
        }

        // 4. Apply skeleton from SLP if session has empty skeleton.
        // One skeleton per project: propagate to ALL sessions (shared reference).
        if (state.session && skeletonFromSlp && state.session.skeleton.nodes.length === 0) {
            setProjectSkeleton(new Skeleton(
                skeletonFromSlp.name || 'skeleton',
                skeletonFromSlp.nodes || [],
                skeletonFromSlp.edges || []
            ));
        }

        // 5. Move all loaded instances to the unlinked pool.
        // Identity assignment is NOT run automatically — user triggers it
        // through the Assign menu. All instances start as unlinked.
        // Instance type (user/predicted) is preserved on the Instance object.
        if (state.session) {
            showLoading('Preparing instances...');
            var ulUserCount = 0, ulPredCount = 0;
            for (var [fgIdx, fgObj] of state.session.frameGroups) {
                for (var [cn, instances] of fgObj.instances) {
                    for (var instItem of instances) {
                        var ulInst = new UnlinkedInstance(instItem, cn);
                        fgObj.addUnlinkedInstance(cn, ulInst);
                        if (instItem.type === 'predicted') ulPredCount++;
                        else ulUserCount++;
                    }
                    fgObj.instances.set(cn, []);
                }
            }
            console.log('[session-folder] Prepared unlinked instances:', ulUserCount, 'user,', ulPredCount, 'predicted');
        }

        // 5b. Load skeleton JSON override if found in session folder
        if (skeletonFile && state.session) {
            try {
                showLoading('Loading skeleton file...');
                var skelText = await skeletonFile.text();
                var loadedSkeleton = parseSkeletonJSON(skelText);
                if (loadedSkeleton && loadedSkeleton.nodes.length > 0) {
                    setProjectSkeleton(loadedSkeleton); // one skeleton per project
                    console.log('[session-folder] Overrode skeleton from ' + skeletonFile.name +
                        ': ' + loadedSkeleton.nodes.length + ' nodes, ' + loadedSkeleton.edges.length + ' edges');
                    setStatus('Loaded skeleton from ' + skeletonFile.name, 'success');
                }
            } catch (skelErr) {
                console.error('[session-folder] Skeleton file parse error:', skelErr);
            }
        }

        // 6. Finalize
        if (state.views.length > 0) {
            paneManager._suppressActiveHighlight = true;
            paneManager.clearAll();
            populateViewStrip();
            populateSessionStrip();
            paneManager.addAllViewsAsGrid();
            paneManager._suppressActiveHighlight = false;
            rebuildVideoController();
            updateTotalFrames();
            fitCanvasesToCells();
        }

        // Set up or update 3D viewport only if real calibration was loaded
        if (state.session && hasCalibration) {
            var vp3dMsg = document.getElementById('viewport3dMessage');
            if (vp3dMsg) vp3dMsg.classList.add('hidden');
            if (viewport3d) {
                viewport3d.cameras = state.session.cameras;
                viewport3d.skeleton = state.session.skeleton;
                viewport3d.addCameraPyramids();
                viewport3d.setFrame([]);
                viewport3d.fitToScene();
            } else {
                setup3DViewport();
            }
            // Mark cameras without video as red in 3D viewer
            if (viewport3d) {
                var noVideoCams = [];
                var viewNames = state.views.map(function (v) { return v.name; });
                for (var nvi = 0; nvi < state.session.cameras.length; nvi++) {
                    if (viewNames.indexOf(state.session.cameras[nvi].name) < 0) {
                        noVideoCams.push(state.session.cameras[nvi].name);
                    }
                }
                viewport3d.setMissingVideoCameras(noVideoCams);
            }
        }

        // Set up interaction manager for pose editing
        if (state.session && !interactionManager) {
            setupInteraction();
        }
        if (interactionManager && state.views.length > 0) {
            interactionManager.detach();
            interactionManager.attach(state.views);
        }

        // Set up timeline
        if (state.session && !timeline) {
            setupTimeline();
        } else if (timeline) {
            timeline.setData(state.session);
            timeline.setTotalFrames(state.totalFrames);
            fitTimelineToData();
        }

        // Triangulation is NOT run automatically — user triggers it
        updateInfoPanel();
        updateFpsDisplay();

        hideLoading();

        // Save this session's UI state for switching
        if (state.session) {
            state.session.totalFrames = state.totalFrames;
            state.session.fps = state.fps;
            state.session._views = state.views;
            state.session._videoController = videoController;
            // Store env file references for "Set Env" loading
            if (Object.keys(envFilesByCam).length > 0) {
                state.session._envFiles = envFilesByCam;
                console.log('[session-folder] Env files cached for Set Env:',
                    Object.keys(envFilesByCam).map(function (c) {
                        return c + ' (' + envFilesByCam[c].length + ')';
                    }).join(', '));
            }
        }

        var statusMsg = 'Loaded ' + matchedCameraDirs.length + ' camera(s)';
        if (!calibFile) statusMsg += ' (no calibration — load separately via File > Load Calibration)';
        setStatus(statusMsg, 'success');

    } catch (err) {
        console.error('[session-folder] Error:', err);
        // Restore previous session if new one failed
        if (!state.session && previousSession) {
            state.session = previousSession;
            if (previousSession._views) {
                state.views = previousSession._views;
                setVideoController(previousSession._videoController);
            }
            state.triangulationResults = previousSession.triangulationResults || new Map();
        }
        hideLoading();
        setStatus('Session folder error: ' + err.message, 'error');
    }
}

// resolveImportTrackIdx moved to ../import-export/import-track-resolve.js (a
// dependency-free module) so it can be unit tested headlessly. Re-exported here
// (and used internally below) so the three import paths keep their import site.
export { resolveImportTrackIdx };
