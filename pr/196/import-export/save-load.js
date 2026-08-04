// import-export/save-load.js — project save/load/restore/serialization + status UI
// Pass 3c-1 extraction. Holds the project lifecycle (newProject), save paths
// (quickSave, saveAs, saveProjectSlp, saveProject), load dispatcher
// (handleLoadProject + _restore* helpers), serialization (serializeSessionFrames,
// buildSlpBytes), and the loading-overlay/status-text UI helpers
// (showLoading, hideLoading, setStatus).

import {
    Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, Identity,
    InstanceGroup, Session,
    toBoxedPoints3d, asPoints3d, someValidPoint3d,
} from '../pose/pose-data.js';
import {
    getInstanceGroupsForFrame, storeReprojectedInstances, reprojectPoints,
} from '../pose/triangulation.js';
import { OnDemandVideoDecoder } from '../loading/video.js';
import { createDemoSkeleton } from '../demo-data.js';
import {
    pickFiles, parseCalibrationJSON, buildSlpLabelsAllViews,
} from './file-io.js';
import {
    state,
    videoController, interactionManager, viewport3d, timeline, paneManager,
    setVideoController, setInteractionManager,
} from '../ui/app-state.js';
import {
    autoAssignVideosToCameras, forceVideoSelection, showParentDirMatchSummary,
    forceVideoSelectionWithFolder, createViewForVideoFile, updateTotalFrames,
    rebuildVideoController, fitCanvasesToCells,
} from '../loading/session-loader.js';
import { drawAllOverlays, setReprojErrorVisible } from '../ui/rendering.js';
import { updateInfoPanel } from '../ui/info-panel.js';
// Pass 3i-3: setupInteraction / setup3DViewport / hideWelcomeOverlay moved to pose/initialization.js.
import {
    setupInteraction, setup3DViewport, hideWelcomeOverlay,
} from '../pose/initialization.js';
// Pass 3h: populateViewStrip / populateSessionStrip moved to sessions-panes.js.
import { populateViewStrip, populateSessionStrip } from '../ui/sessions-panes.js';
import { handleLoadSlpFile } from './slp-import.js';
import {
    buildSessionSlpBytesStreaming, createProjectWriterContext, buildSessionRefGraph,
    openProjectWriter, streamSessionIntoWriter, finalizeProjectWriter,
} from './slp-streaming-write.js';
import { SioLazyLoader } from '../loading/sio-lazy-loader.js';
import { getLoadingProgressModal } from '../ui/loading-progress-modal.js';
import { serializeVideoContrast, ingestVideoContrast } from '../ui/video-filters.js';

/**
 * Confirmation modal shown when the user starts loading a real session while
 * 3D points were imported into a skeleton-only project. Resolves true to
 * proceed (and discard), false to cancel. Styled like
 * showCalibrationRequiredPopup but with two buttons.
 */
export function confirmDiscardImported3D() {
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.style.cssText = 'position:fixed;top:0;left:0;width:100%;height:100%;background:rgba(0,0,0,0.85);z-index:10000;display:flex;align-items:center;justify-content:center;';
        var card = document.createElement('div');
        card.style.cssText = 'background:var(--bg-secondary,#1e1e1e);border-radius:8px;padding:24px;max-width:440px;width:90%;text-align:center;';
        var icon = document.createElement('div');
        icon.style.cssText = 'font-size:36px;margin-bottom:12px;';
        icon.textContent = '⚠';
        card.appendChild(icon);
        var title = document.createElement('div');
        title.style.cssText = 'color:#fff;font-size:16px;font-weight:600;margin-bottom:8px;';
        title.textContent = 'Discard imported 3D points?';
        card.appendChild(title);
        var msg = document.createElement('div');
        msg.style.cssText = 'color:#aaa;font-size:13px;margin-bottom:18px;line-height:1.5;';
        msg.textContent = 'Importing a session will remove all imported 3D point information, including the loaded skeleton. This cannot be undone. Continue and load the session?';
        card.appendChild(msg);
        var row = document.createElement('div');
        row.style.cssText = 'display:flex;gap:10px;justify-content:center;';
        var cancelBtn = document.createElement('button');
        cancelBtn.style.cssText = 'padding:8px 20px;font-size:14px;cursor:pointer;background:var(--bg-tertiary,#2a2a2a);color:#ddd;border:1px solid var(--border-color,#444);border-radius:6px;';
        cancelBtn.textContent = 'Cancel';
        var okBtn = document.createElement('button');
        okBtn.style.cssText = 'padding:8px 20px;font-size:14px;font-weight:600;cursor:pointer;background:var(--accent,#4a9eff);color:#fff;border:none;border-radius:6px;';
        okBtn.textContent = 'Load Session';
        row.appendChild(cancelBtn);
        row.appendChild(okBtn);
        card.appendChild(row);
        overlay.appendChild(card);
        document.body.appendChild(overlay);
        function done(result) {
            overlay.remove();
            document.removeEventListener('keydown', onKey);
            resolve(result);
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); done(false); }
            else if (e.key === 'Enter') { e.preventDefault(); done(true); }
        }
        document.addEventListener('keydown', onKey);
        cancelBtn.addEventListener('click', function () { done(false); });
        okBtn.addEventListener('click', function () { done(true); });
    });
}

/**
 * Guard for session-load entry points. If the project holds 3D points imported
 * without a session, prompt the user; on confirm, fully reset the project
 * (nothing survives, not even the skeleton) and return true so the caller can
 * proceed with the load. Returns false if the user cancels.
 */
export async function ensureNo3dImportBlockingLoad() {
    if (!state.has3dImportWithoutSession) return true;
    var ok = await confirmDiscardImported3D();
    if (!ok) return false;
    newProject(true);  // full reset, no extra confirm
    return true;
}

export function newProject(force) {
    if (!force && (state.session || state.views.length > 0)) {
        if (!confirm('Unsaved changes will be lost. Start a new project?')) return;
    }

    // Drop the "imported 3D points without a session" marker — a full reset
    // erases any such overlay (including the skeleton) by design.
    state.has3dImportWithoutSession = false;

    // Detach interaction handlers from old canvases
    if (interactionManager) {
        interactionManager.detach();
        setInteractionManager(null);
    }

    // Stop playback
    if (videoController && state.isPlaying) {
        videoController.pause();
    }
    state.isPlaying = false;
    setVideoController(null);

    // Close lazy loader if active
    if (state.session && state.session.lazyLoader) {
        state.session.lazyLoader.close();
    }

    // Clear session and annotation data
    state.session = null;
    state.currentFrame = 0;
    state.totalFrames = 0;
    state.fps = 30;
    state.keypoints3d = null;
    state.triangulationResults = new Map();
    state.lastUserPoints = new Map();
    state.viewMode = 'grid';
    state.singleViewIndex = 0;

    // Clear views and video files
    state.views = [];
    state.videoFiles = [];

    // Clear 3D viewport (remove skeletons and camera pyramids)
    if (viewport3d) {
        viewport3d.setFrame([]);
        viewport3d.cameras = [];
        viewport3d.skeleton = null;
        viewport3d.addCameraPyramids();
    }

    // Clear the dock panels and view strip, show empty state
    paneManager.clearAll();
    var stripList = document.getElementById('viewStripList');
    if (stripList) stripList.innerHTML = '';

    // Reset frame counter display
    var curFrameEl = document.getElementById('currentFrame');
    if (curFrameEl) curFrameEl.textContent = '0';
    var totalFramesEl = document.getElementById('totalFrames');
    if (totalFramesEl) totalFramesEl.textContent = '0';
    var fpsEl = document.getElementById('fpsDisplay');
    if (fpsEl) fpsEl.textContent = '30.0 fps';

    // Reset seekbar
    var seekbar = document.getElementById('seekbar');
    if (seekbar) { seekbar.value = 0; seekbar.max = 0; }

    // Reset play button
    var playBtn = document.getElementById('btnPlay');
    if (playBtn) { playBtn.textContent = '\u25B6'; playBtn.classList.remove('active'); }

    // Reset status bar selection
    var selEl = document.getElementById('statusSelection');
    if (selEl) selEl.textContent = 'Selection: none';
    var selInfo = document.getElementById('selectedInfo');
    if (selInfo) selInfo.textContent = 'None';

    // Reset triangulation badge
    var badge = document.getElementById('triangulationBadge');
    if (badge) { badge.style.display = 'none'; badge.textContent = ''; }

    // Clear linked groups and unlinked instances panels
    var groupsTbody = document.querySelector('#instanceGroupsTable tbody');
    if (groupsTbody) groupsTbody.innerHTML = '';
    var groupsTable = document.getElementById('instanceGroupsTable');
    if (groupsTable) groupsTable.style.display = 'none';
    var groupsEmpty = document.getElementById('instanceGroupsEmpty');
    if (groupsEmpty) groupsEmpty.style.display = '';
    var ulTbody = document.querySelector('#unlinkedTable tbody');
    if (ulTbody) ulTbody.innerHTML = '';
    var ulTable = document.getElementById('unlinkedTable');
    if (ulTable) ulTable.style.display = 'none';
    var ulEmpty = document.getElementById('unlinkedEmpty');
    if (ulEmpty) ulEmpty.style.display = '';

    // Clear error display
    var errorDisplay = document.getElementById('errorDisplay');
    if (errorDisplay) { errorDisplay.textContent = '-'; errorDisplay.className = 'error-display'; }
    var perCamErrors = document.getElementById('perCameraErrors');
    if (perCamErrors) perCamErrors.innerHTML = '';

    // Clear skeleton editing tables and dropdowns
    var skelBody = document.querySelector('#skeletonNodesTable tbody');
    if (skelBody) skelBody.innerHTML = '';
    var edgesBody = document.querySelector('#skeletonEdgesTable tbody');
    if (edgesBody) edgesBody.innerHTML = '';
    var srcSelect = document.getElementById('edgeSrcSelect');
    if (srcSelect) srcSelect.innerHTML = '';
    var dstSelect = document.getElementById('edgeDstSelect');
    if (dstSelect) dstSelect.innerHTML = '';
    var newNodeInput = document.getElementById('nodeNameInput');
    if (newNodeInput) newNodeInput.value = '';

    // Clear videos table
    var vidBody = document.querySelector('#videosTable tbody');
    if (vidBody) vidBody.innerHTML = '';

    // Clear cameras table
    var camBody = document.querySelector('#camerasTable tbody');
    if (camBody) camBody.innerHTML = '';

    // Clear session assignment table
    var sessBody = document.querySelector('#sessionAssignTable tbody');
    if (sessBody) sessBody.innerHTML = '';

    // Update panels
    updateInfoPanel();
    if (timeline) {
        timeline.setData(null);
    }

    // Re-create interaction manager so keyboard shortcuts work immediately
    setupInteraction();

    setStatus('New project started', 'success');
}

/**
 * Loud guard for the JSON project serializer (luc3d #195).
 *
 * `serializeSessionFrames` walks `session.frameGroups`, i.e. RESIDENT frames
 * only. On a lazily reopened project that is a handful of frames — measured 31 of
 * 180,210 — so a JSON project save would silently write ~0.02% of the labels into
 * a structurally valid file. Unlike `exportLabels` (rewritten to stream in #195)
 * this path is currently DEAD UI SURFACE: `saveProject` is imported by
 * `ui/ui-wiring.js` but wired to no menu item, and the app saves `.slp` through
 * `saveProjectSlp`/`saveAs`. Rather than restructure unreachable code, refuse
 * loudly so it can never quietly truncate a project if it is ever re-wired.
 *
 * @returns {boolean} true when serialization is safe to proceed
 */
function assertJsonSaveCoversProject(session) {
    var loader = session && session.lazyLoader;
    if (!loader) return true;                       // fully-resident project: fine
    var total = loader.nFrames || 0;
    var resident = session.frameGroups ? session.frameGroups.size : 0;
    if (total === 0 || resident >= total) return true;
    var msg = 'JSON project save covers RESIDENT frames only (' +
        resident.toLocaleString() + ' of ' + total.toLocaleString() +
        '). This project is lazily loaded, so the JSON would be almost empty. ' +
        'Use File → Save (.slp), which streams the whole project.';
    console.error('[save-load] ' + msg);
    setStatus(msg, 'error');
    return false;
}

function serializeSessionFrames(session) {
    var frames = {};
    for (var [frameIdx, fg] of session.frameGroups) {
        var frameData = { instanceGroups: [], unlinkedInstances: [] };
        var groups = session.instanceGroups.get(frameIdx) || [];
        for (var gi = 0; gi < groups.length; gi++) {
            var group = groups[gi];
            var groupData = {
                id: group.id,
                identityId: group.identityId != null ? group.identityId : -1,
                instances: {},
                points3d: toBoxedPoints3d(group.points3d),
                reprojections: group.reprojections || null,
                observedPoints: group.observedPoints || null,
                dirty: group.dirty || false,
            };
            if (group.usedCameras) {
                groupData.usedCameras = Array.from(group.usedCameras);
            }
            for (var [camName, inst] of group.instances) {
                var instData = {
                    points: inst.toPointsArray(),
                    trackIdx: inst.trackIdx,
                    type: inst.type,
                    score: inst.score,
                    modified: inst.modified,
                    occluded: inst.toOccludedArray(),
                };
                if (inst.nulledNodes && inst.nulledNodes.size > 0) {
                    instData.nulledNodes = Array.from(inst.nulledNodes);
                }
                groupData.instances[camName] = instData;
            }
            frameData.instanceGroups.push(groupData);
        }
        for (var [camName2, unlinkedList] of fg.unlinkedInstances) {
            for (var unlinked of unlinkedList) {
                var ulType = unlinked.instance.type || 'user';
                var ulData = {
                    cameraName: camName2,
                    points: unlinked.instance.toPointsArray(),
                    trackIdx: unlinked.instance.trackIdx,
                    type: ulType,
                    score: unlinked.instance.score || 1.0,
                    modified: unlinked.instance.modified || false,
                    occluded: unlinked.instance.toOccludedArray(),
                };
                if (unlinked.instance.nulledNodes && unlinked.instance.nulledNodes.size > 0) {
                    ulData.nulledNodes = Array.from(unlinked.instance.nulledNodes);
                }
                frameData.unlinkedInstances.push(ulData);
            }
        }
        // Skip empty frames
        if (frameData.instanceGroups.length === 0 && frameData.unlinkedInstances.length === 0) continue;
        frames[frameIdx] = frameData;
    }
    return frames;
}

async function ensureSleapIO() {
    if (window.SleapIO) return window.SleapIO;
    var mod = await import('./lib/sleap-io/index.browser.js');
    window.SleapIO = mod;
    return mod;
}

export function markDirty() {
    // Per-session dirty (active-session memory model): the switch-away save
    // prompt and safe lazy-eviction key off THIS flag, so it must be set even
    // when the global flag is already true from another session.
    if (state.session) state.session.isDirty = true;
    if (state.isDirty) return;
    state.isDirty = true;
    document.title = '\u2022 Lucid';
    var saveDot = document.getElementById('saveDirtyDot');
    if (saveDot) saveDot.style.display = 'inline-block';
}

export function clearDirty() {
    state.isDirty = false;
    // A full save writes every session, so all become clean. (When per-session
    // save lands, pass the saved session to clear just that one.)
    if (state.sessions && state.sessions.length) {
        state.sessions.forEach(function (s) { if (s) s.isDirty = false; });
    } else if (state.session) {
        state.session.isDirty = false;
    }
    document.title = 'Lucid';
    var saveDot = document.getElementById('saveDirtyDot');
    if (saveDot) saveDot.style.display = 'none';
}

/**
 * Yield to the event loop (a real macrotask boundary, not just a microtask)
 * between sessions in the multi-session streaming save. Dereferencing a
 * session's heavy state (lazyLoader/frameGroups/instanceGroups) makes it
 * ELIGIBLE for GC but does not force reclamation — real-data testing showed
 * V8 can leave several GB of a "evicted" session's garbage resident well into
 * the NEXT session's own allocation, stacking peaks that were each meant to
 * be sequential. This can't force a collection (no `--expose-gc` in a real
 * browser), but giving the engine an idle window between sessions measurably
 * helps it catch up rather than piling every session's compute back-to-back
 * with zero breathing room.
 */
function yieldToEventLoop(ms) {
    return new Promise(function (resolve) { setTimeout(resolve, ms || 0); });
}

/**
 * Coax V8 into actually running a collection pass. There is no `--expose-gc`
 * in a real browser, so this can't force one directly — but a large,
 * immediately-discarded allocation typically forces the allocator to prove it
 * has room (or reclaim some) before granting it, which in practice triggers
 * at least a scavenge/incremental-mark step sooner than just waiting would.
 * Real-data testing showed dereferencing a session's heavy state alone left
 * several GB resident well into the NEXT session's own allocation — a plain
 * `setTimeout` yield wasn't enough to change that; this is a further nudge,
 * best-effort only (wrapped in try/catch since the probe allocation itself
 * could throw under real memory pressure, which is fine — that pressure IS
 * what triggers collection).
 */
async function encourageGC(totalMB) {
    // A modest allocation (tried first) is trivially satisfied from free space
    // without V8 bothering to collect anything — the large old-generation
    // Maps/objects this needs to reclaim have almost certainly been promoted
    // out of the young generation, so only a MARK-COMPACT (full) GC touches
    // them, and V8 is conservative about running one of those. Allocating
    // toward the ACTUAL heap ceiling is what reliably forces that: V8 tries a
    // last-resort collection before failing an allocation, which is exactly
    // the collection this needs. Hitting the catch (OOM on the probe itself)
    // is a fine, expected outcome — it means real pressure was applied.
    var junk = [];
    try {
        var chunkMB = 150;
        var n = Math.ceil((totalMB || 2500) / chunkMB);
        for (var i = 0; i < n; i++) {
            var buf = new ArrayBuffer(chunkMB * 1024 * 1024);
            new Uint8Array(buf)[0] = 1; // touch it — keeps V8 from eliding a dead-on-arrival allocation
            junk.push(buf);
        }
    } catch (e) { /* ignore — hitting real pressure is the point */ }
    junk = null;
    await yieldToEventLoop(50);
}

/** Thrown by `buildSlpBytes` when the user declines the large-project size
 * warning below — callers should report this as a cancellation, not a
 * failure (mirrors the existing `pickErr.name === 'AbortError'` handling for
 * a declined save-file-picker). */
/** Monotonic clock, tolerant of environments without `performance`. */
function _saveNow() {
    return (typeof performance !== 'undefined' && performance.now)
        ? performance.now() : Date.now();
}

class SaveCancelledError extends Error {
    constructor(message) {
        super(message || 'Save cancelled');
        this.name = 'SaveCancelledError';
    }
}

// Per-object cost in the CAGE — V8's pointer-compressed heap, which a Chrome
// renderer hard-caps near 4 GB and which is the resource a big merged save
// actually runs out of. MEASURED in a real renderer by
// `tests/e2e/_diag-repr-sizing.mjs`, not modelled.
//
// Only in-cage bytes are counted. A typed array's backing store is allocated
// OUTSIDE the cap — verified by `tests/e2e/_diag-cage-vs-external.mjs`, which
// allocates 6,272 MB of Float64Array against a reported 4,192 MB
// `jsHeapSizeLimit` without failing — so `points3d`'s coordinates cost only
// their wrapper objects here, and `usedJSHeapSize` (which DOES count backing
// stores) is not a valid substitute for this estimate.
var CAGE_B_PER_INSTANCE = 824;      // boxed points[][] + occluded[] + object shell
var CAGE_B_PER_GROUP = 130;         // InstanceGroup shell + its instances Map entry
var CAGE_B_PER_GROUP_PTS3D = 116;   // flat Float64Array wrapper (coords are external)
var CAGE_B_PER_FIM_ENTRY = 16;      // packed-Number key -> identityId, in a Map
var CAGE_B_PER_REFGRAPH_MEMBER = 24; // PASS-1 CamRefMap parallel arrays, per (group, camera)

/**
 * Estimate the peak CAGE pressure of a merged save, by pricing the state that
 * is actually resident rather than extrapolating from the project's shape.
 *
 * WHY THIS WAS REWRITTEN (luc3d #189). The previous version returned
 * `frames x cameras x 11.4 KB`, a single-data-point extrapolation. Two things
 * were wrong with it:
 *
 *   1. It never looked at the data. On the real bug-report project it reported
 *      "~10.3 GB" (180,210 x 5 x 11.4 KB) — and would have reported the very
 *      same 10.3 GB for a project with ZERO instances in it, or after any
 *      amount of memory optimisation, because neither term is in the formula.
 *   2. The shape was wrong. O(frames x cameras) is the cost of Track All /
 *      Triangulate All, both of which have already COMPLETED by the time Save
 *      As is clicked. What the save adds is O(instance_groups x cameras) for
 *      the ref graph, on top of a baseline dominated by the live `Instance`
 *      objects that grouping pins.
 *
 * The merged save of that project has since been measured succeeding —
 * 1,404,804,682 bytes in 49.5 s — while the old estimate still claimed 10.3 GB
 * and a likely crash, so the dialog was actively steering users away from an
 * operation that works.
 *
 * Walks `session.instanceGroups` (O(groups), a few ms even at 531,799 groups).
 *
 * @param {Array} sessionsToExport
 * @returns {number} estimated peak cage bytes
 */
export function estimateSaveCagePressureBytes(sessionsToExport) {
    var total = 0;
    for (var i = 0; i < sessionsToExport.length; i++) {
        var sess = sessionsToExport[i];
        if (!sess) continue;
        var nGroups = 0, nMembers = 0, nWith3d = 0;
        if (sess.instanceGroups) {
            for (var entry of sess.instanceGroups) {
                var groups = entry[1] || [];
                for (var gi = 0; gi < groups.length; gi++) {
                    var g = groups[gi];
                    nGroups++;
                    nMembers += (g.instances && g.instances.size) || 0;
                    if (g.points3d) nWith3d++;
                }
            }
        }
        var nFim = (sess.frameIdentityMap && sess.frameIdentityMap.size) || 0;
        total += nGroups * CAGE_B_PER_GROUP
               + nMembers * CAGE_B_PER_INSTANCE
               + nWith3d * CAGE_B_PER_GROUP_PTS3D
               + nFim * CAGE_B_PER_FIM_ENTRY
               + nMembers * CAGE_B_PER_REFGRAPH_MEMBER;
    }
    return total;
}

/**
 * The tab's hard JS-heap ceiling. Chrome reports it via `performance.memory`
 * (measured 3,760-4,192 MB depending on build); anything else gets a
 * conservative 4 GB. `--max-old-space-size` does NOT raise this.
 * @returns {number} bytes
 */
export function getCageLimitBytes() {
    try {
        var m = (typeof performance !== 'undefined') && performance.memory;
        if (m && m.jsHeapSizeLimit > 0) return m.jsHeapSizeLimit;
    } catch (e) { /* not Chrome, or blocked */ }
    return 4e9;
}

// Warn once the estimated peak reaches this share of the tab's hard JS-heap
// ceiling. Video decode buffers, the UI, and whatever Track All / Triangulate
// All left resident share the same budget, so leave real margin.
//
// Reference point for the tuning: the real 180,210-frame x 5-camera project
// SUCCEEDS at a measured 2,891 MB pre-save baseline against a 3,760 MB ceiling
// (77%). So the threshold has to sit above that — warning on a save that is
// known to work is what the old heuristic did wrong.
var CAGE_WARN_FRACTION = 0.85;

async function buildSlpBytes(opts) {
    opts = opts || {};
    await ensureSleapIO();
    var SIO = window.SleapIO;

    var allLabeledFrames = [];
    var allVideos = [];
    var allSessions = [];
    var allSkeletons = [];
    var allTracks = [];
    var allIdentities = [];
    var seenSkeletonNames = new Set();
    var seenTrackNames = new Set();

    var sessionsToExport = state.sessions.length > 0 ? state.sessions : [state.session];

    // Large lazy prediction sessions: build the file INCREMENTALLY via sleap-io.js's
    // streaming writer so the whole ~108k×N-frame graph is never resident and no
    // unvisited frame is dropped (the eager path below iterates only the resident
    // `frameGroups`). Requires EVERY session to be lazy-loaded — a mixed project
    // (some hand-labeled, some lazy) falls through to the eager path below.
    // When `opts.sink` is given, the finished bytes stream straight to it (e.g. a
    // `FileSystemWritableFileStream`) instead of being materialized as one big
    // `Uint8Array` — for a multi-GB multi-session project that in-memory copy is
    // itself a meaningful chunk of peak memory on top of whatever the sessions
    // themselves haven't been reclaimed yet. Returns `null` when streamed to a sink.
    if (sessionsToExport.length > 0 && SIO && typeof SIO.openSlpWriter === 'function' &&
        sessionsToExport.every(function (s) { return !!s.lazyLoader; })) {

        if (!opts.skipSizeWarning) {
            var estBytes = estimateSaveCagePressureBytes(sessionsToExport);
            var capBytes = getCageLimitBytes();
            if (estBytes > capBytes * CAGE_WARN_FRACTION) {
                var estGB = (estBytes / 1e9).toFixed(1);
                var capGB = (capBytes / 1e9).toFixed(1);
                var proceed = window.confirm(
                    'This project is very large. Its triangulated grouping is estimated to ' +
                    'occupy ~' + estGB + ' GB of this tab\'s ~' + capGB + ' GB JavaScript memory ' +
                    'limit, leaving little headroom for a merged save, which could crash the ' +
                    'tab before finishing.\n\n' +
                    'Click OK to attempt the save anyway, or Cancel and use ' +
                    '"Export SLEAP File Per Session" / "By Cam" instead — those write one ' +
                    'smaller file per camera and are far less likely to crash.'
                );
                if (!proceed) throw new SaveCancelledError();
            }
        }

        if (sessionsToExport.length === 1) {
            var lazySess = sessionsToExport[0];
            var lazyViews = state.views.filter(function (v) {
                return lazySess.cameras.some(function (c) { return c.name === v.name; });
            });
            var lazyVideoFiles = state.videoFiles.filter(function (vf) {
                return lazySess.cameras.some(function (c) { return c.name === vf.assignedCamera; });
            });
            console.log('[save-slp] lazy session → streaming writer (', lazySess.lazyLoader.nFrames, 'frames ×',
                lazySess.cameras.length, 'cameras )');
            return await buildSessionSlpBytesStreaming(lazySess, lazyViews, lazyVideoFiles, opts.sink ? { sink: opts.sink } : undefined);
        }
        return await saveAllSessionsStreaming(sessionsToExport, opts.sink ? { sink: opts.sink } : undefined);
    }

    // MIXED PROJECT GUARD. The eager builder below iterates only the RESIDENT
    // `frameGroups`, which is correct for a fully-resident project and silently
    // catastrophic for a lazy one. The streaming path above requires EVERY
    // session to be lazy, so a project with one lazy session and one
    // hand-labeled session falls through to here — and writes a structurally
    // valid .slp containing the resident handful of the lazy session's frames
    // (31 of 180,210 in the measured case) with no error. That is silent data
    // loss on the primary save path, so refuse instead: same precedent as
    // `assertJsonSaveCoversProject` above. Sessions that are merely SMALL are
    // unaffected — a non-lazy session has every frame resident by definition,
    // and an all-lazy project never reaches this line.
    var _truncated = [];
    for (var _gi = 0; _gi < sessionsToExport.length; _gi++) {
        var _gs = sessionsToExport[_gi];
        var _gl = _gs && _gs.lazyLoader;
        if (!_gl) continue;
        var _gTotal = _gl.nFrames || 0;
        var _gResident = _gs.frameGroups ? _gs.frameGroups.size : 0;
        if (_gTotal > 0 && _gResident < _gTotal) {
            _truncated.push('"' + (_gs.name || 'session ' + _gi) + '" (' +
                _gResident.toLocaleString() + ' of ' + _gTotal.toLocaleString() + ' frames resident)');
        }
    }
    if (_truncated.length > 0) {
        var _msg = 'Cannot save: this project mixes lazily-loaded and fully-loaded ' +
            'sessions, and the combined save path can only write frames that are ' +
            'currently in memory — ' + _truncated.join('; ') + '. Saving would ' +
            'silently drop the rest. Export the lazy session(s) on their own ' +
            '(File → Save As with only those sessions), or use "Export SLEAP File ' +
            'Per Session".';
        console.error('[save-slp] ' + _msg);
        setStatus(_msg, 'error');
        throw new Error(_msg);
    }

    for (var si = 0; si < sessionsToExport.length; si++) {
        var sess = sessionsToExport[si];

        // Debug: count 3D data in this session
        var dbgGroupCount = 0, dbgWith3d = 0;
        for (var [_dbgFi, _dbgGroups] of sess.instanceGroups) {
            for (var _dbgG of _dbgGroups) {
                dbgGroupCount++;
                if (someValidPoint3d(_dbgG.points3d)) dbgWith3d++;
            }
        }
        console.log('[save-slp] Session', si, '(' + sess.name + '):', sess.frameGroups.size, 'frames,',
            dbgGroupCount, 'instance groups,', dbgWith3d, 'with 3D points,',
            sess.cameras.length, 'cameras:', sess.cameras.map(function(c){return c.name;}).join(', '));

        // Find views and videoFiles for this session
        var sessViews = state.views.filter(function (v) {
            return sess.cameras.some(function (c) { return c.name === v.name; });
        });
        var sessVideoFiles = state.videoFiles.filter(function (vf) {
            return sess.cameras.some(function (c) { return c.name === vf.assignedCamera; });
        });

        var sessLabels = buildSlpLabelsAllViews(sess, sessViews, sessVideoFiles);

        // Merge into combined Labels
        allLabeledFrames = allLabeledFrames.concat(sessLabels.labeledFrames || []);
        allVideos = allVideos.concat(sessLabels.videos || []);
        for (var sk = 0; sk < (sessLabels.skeletons || []).length; sk++) {
            var skel = sessLabels.skeletons[sk];
            if (!seenSkeletonNames.has(skel.name)) {
                allSkeletons.push(skel);
                seenSkeletonNames.add(skel.name);
            }
        }
        for (var ti = 0; ti < (sessLabels.tracks || []).length; ti++) {
            var trk = sessLabels.tracks[ti];
            if (!seenTrackNames.has(trk.name)) {
                allTracks.push(trk);
                seenTrackNames.add(trk.name);
            }
        }
        allIdentities = allIdentities.concat(sessLabels.identities || []);
        allSessions = allSessions.concat(sessLabels.sessions || []);
    }

    // Re-point every instance's track to the canonical (deduped) Track object
    // for its NAME. buildSlpLabelsAllViews creates a fresh SIO.Track array per
    // session, but the allTracks dedup above keeps only the FIRST session's
    // object per shared name. sleap-io serializes each instance's track via
    // labels.tracks.indexOf(instance.track) using OBJECT IDENTITY, so a later
    // session's instance still pointing at its own (discarded) Track object
    // would serialize as -1 (trackless) — dropping the track on any shared-name
    // track. Mapping every instance.track to the canonical object makes indexOf
    // resolve it to the correct global slot. (Tracks are then re-localized to
    // each session's own list by NAME on load — see slp-import.js.)
    var canonicalTrackByName = {};
    for (var ctI = 0; ctI < allTracks.length; ctI++) {
        canonicalTrackByName[allTracks[ctI].name] = allTracks[ctI];
    }
    for (var lfI = 0; lfI < allLabeledFrames.length; lfI++) {
        var lfInsts = allLabeledFrames[lfI].instances || [];
        for (var inI = 0; inI < lfInsts.length; inI++) {
            var sioInst = lfInsts[inI];
            if (sioInst && sioInst.track && canonicalTrackByName[sioInst.track.name]) {
                sioInst.track = canonicalTrackByName[sioInst.track.name];
            }
        }
    }

    var labels = new SIO.Labels({
        labeledFrames: allLabeledFrames,
        videos: allVideos,
        skeletons: allSkeletons,
        tracks: allTracks,
        identities: allIdentities,
        sessions: allSessions,
        provenance: { source: 'lucid', exported_at: new Date().toISOString() },
    });

    // PR 5.2: export sleap-io.js's canonical bytes directly. The typed graph
    // built by buildSlpLabelsAllViews already carries all LUCID state
    // (RecordingSession + FrameGroup + InstanceGroup with instance3d, identity,
    // and metadata.lucid), so saveSlpToBytes emits a canonical sessions_json the
    // typed importer round-trips. The old v0.6-compat post-pass (hand-rolled
    // sessions_json + flat→compound rewrite + format_id 1.4) is gone; SLEAP >=
    // 1.6 (sleap-io >= 0.7) reads the raw flat-matrix output natively.
    return await SIO.saveSlpToBytes(labels);
}

/**
 * Reopen a fresh `SioLazyLoader` for `session` from cheap, previously-retained
 * `File`/`Blob` handles (`SioLazyLoader.sourceFiles`, captured at the original
 * `open()`). A local-disk `File` is a lazy handle, not a resident copy of the
 * bytes, so this is cheap relative to the FIRST open — no Track All/
 * Triangulate All is redone, only the columnar store is reconstructed.
 */
async function reopenSessionLazyLoader(session, sourceFileEntries, wasSharedStore) {
    var loader = new SioLazyLoader();
    if (wasSharedStore) {
        // Lazily-reopened single-file project: every camera's sourceFiles entry
        // is the SAME project `.slp`. Reopen through openProjectSlp so the ONE
        // interleaved store is read once and `_sharedStore`/`videoIdByCam` are
        // restored — per-camera open() would re-read the whole project N times
        // and pass 2 would then append the shared store once per camera
        // (duplicating every frame/track).
        await loader.openProjectSlp(sourceFileEntries[0][1]);
        session.lazyLoader = loader;
        return loader;
    }
    var opens = [];
    for (var i = 0; i < sourceFileEntries.length; i++) {
        var entry = sourceFileEntries[i];
        opens.push(loader.open(entry[0], entry[1]));
    }
    await Promise.all(opens);
    session.lazyLoader = loader;
    return loader;
}

/**
 * Start a multi-session streaming save. Returns a `handle` threaded through
 * `commitSessionForMultiSessionSave`/`finalizeMultiSessionSave` (below) — kept
 * as a plain object, not module state, so it can be parked on `state` across
 * interactive steps (e.g. a future "commit this session, then load the next"
 * UI flow) without this module needing to know about that UI.
 */
export function beginMultiSessionSave() {
    return { ctx: createProjectWriterContext(), pending: [] };
}

/**
 * PASS 1, per session: `session` must currently have compute results
 * (Track All/Triangulate All already run — this function does not run them)
 * and an open `lazyLoader`. Builds its ref graph against `handle.ctx`'s
 * running counter, then EVICTS the session's heavy state (lazy loader,
 * `frameGroups`, `instanceGroups`) — safe because the small ref graph +
 * cheap `sourceFiles` handles are kept in `handle.pending`.
 *
 * This is the piece that must be interleaved with each session's OWN
 * compute step for truly memory-bounded end-to-end processing of sessions
 * whose compute alone approaches the tab's memory ceiling (e.g. a
 * ~108k-frame × 3-camera prediction session peaks ~3.7 GB — three such
 * sessions can never be simultaneously computed, only sequentially committed
 * one at a time via this function). There is currently no UI wired to drive
 * that interactively (open session → Track All → Triangulate All → commit →
 * evict → next session) — see CLAUDE.md / the multi-session save plan for
 * that follow-up; `saveAllSessionsStreaming` below covers the simpler case
 * where every session's compute already fits resident simultaneously.
 */
export async function commitSessionForMultiSessionSave(handle, session) {
    if (!session.lazyLoader) {
        throw new Error('commitSessionForMultiSessionSave: session "' + (session.name || '') +
            '" has no open lazyLoader');
    }
    var sessViews = state.views.filter(function (v) {
        return session.cameras.some(function (c) { return c.name === v.name; });
    });
    var sessVideoFiles = state.videoFiles.filter(function (vf) {
        return session.cameras.some(function (c) { return c.name === vf.assignedCamera; });
    });
    var sourceFiles = Array.from(session.lazyLoader.sourceFiles.entries());
    var wasSharedStore = !!session.lazyLoader._sharedStore;
    var refGraph = await buildSessionRefGraph(session, sessViews, sessVideoFiles, handle.ctx);
    handle.pending.push({ session: session, sourceFiles: sourceFiles, refGraph: refGraph, sharedStore: wasSharedStore });

    // Evict: this session's contribution now lives in `refGraph` (small — a
    // ref-only RecordingSession + the materialized user-edit overlay
    // instances) — the lazy loader and per-frame LUCID state can go.
    session.lazyLoader.close();
    session.lazyLoader = null;
    session.frameGroups = new Map();
    session.instanceGroups = new Map();
    console.log('[save-slp] pass 1/2: committed ref graph for session', session.name || '(unnamed)', '- evicted its lazy loader');
    // See `encourageGC` — dereferencing doesn't force reclamation; nudge the
    // engine toward a real (mark-compact) collection before the next
    // session's own heavy allocation begins.
    await encourageGC(2500);
}

/**
 * PASS 2: open the writer (every session's ref graph is now final) then
 * re-stream each session's 2D data from a freshly (cheaply) reopened lazy
 * loader — no recompute needed, `appendStore` reads straight from the
 * columnar store — evicting again after each. Returns the finished bytes
 * (or null if `opts.sink` was given).
 */
export async function finalizeMultiSessionSave(handle, opts) {
    // Per-phase timing — a merged save of a tracked+triangulated project takes
    // tens of seconds, which is indistinguishable from a hang without it. Each
    // line prints as its phase COMPLETES, so the phase still running is the one
    // after the last line printed. (Single-session path: see
    // `buildSessionSlpBytesStreaming` in slp-streaming-write.js.)
    var _t0 = _saveNow(), _tp = _t0;
    var _lap = function (label) {
        var n = _saveNow();
        console.log('[save-slp] phase: ' + label + ' — ' + Math.round(n - _tp) +
            ' ms (total ' + Math.round(n - _t0) + ' ms)');
        _tp = n;
    };
    var writer = await openProjectWriter(handle.ctx, handle.pending.map(function (p) { return p.refGraph.sioSession; }));
    _lap('openProjectWriter (writes /session_data + sessions_json)');
    try {
        for (var j = 0; j < handle.pending.length; j++) {
            var p = handle.pending[j];
            await reopenSessionLazyLoader(p.session, p.sourceFiles, p.sharedStore);
            streamSessionIntoWriter(writer, p.session, p.refGraph);
            p.session.lazyLoader.close();
            p.session.lazyLoader = null;
            console.log('[save-slp] pass 2/2: streamed session', p.session.name || j, 'into the project writer');
            _lap('stream session ' + (p.session.name || j));
            await encourageGC(1000);
        }
        var _out = await finalizeProjectWriter(writer, opts);
        _lap('finalizeProjectWriter (flush to disk)');
        return _out;
    } catch (err) {
        try { if (typeof writer.dispose === 'function') writer.dispose(); } catch (e) { /* ignore */ }
        throw err;
    }
}

/**
 * Memory-bounded save for MULTIPLE simultaneously-loaded lazy sessions (e.g.
 * several modest prediction sessions that together still fit resident at
 * once — the case where the OLD eager path would double-materialize
 * everything, or blow the `sessions_json` string-length cap, but where
 * per-session compute doesn't itself approach the memory ceiling). See
 * `slp-streaming-write.js`'s module docstring for why this needs two passes:
 * `SIO.openSlpWriter` serializes `sessions_json` synchronously at open time,
 * so every session's ref graph must be complete before the writer opens.
 *
 * Every `sessions` entry must currently have compute results and an open
 * `lazyLoader` — this convenience wrapper does NOT interleave eviction with
 * each session's OWN compute step (see `commitSessionForMultiSessionSave`
 * for that), so it does not, on its own, bound peak memory for sessions
 * whose compute alone approaches the ceiling.
 */
export async function saveAllSessionsStreaming(sessions, opts) {
    var handle = beginMultiSessionSave();
    for (var i = 0; i < sessions.length; i++) await commitSessionForMultiSessionSave(handle, sessions[i]);
    return await finalizeMultiSessionSave(handle, opts);
}

export async function quickSave() {
    if (!state.session) {
        setStatus('No session to save', 'error');
        return;
    }
    if (state.isSaving) {
        setStatus('Save already in progress...', 'warning');
        return;
    }

    try {
        // If no file handle yet, prompt for one
        if (!state.slpFileHandle) {
            if (!window.showSaveFilePicker) {
                // Fallback: use old download-based save
                saveProjectSlp();
                return;
            }
            var filename = 'project.slp';
            if (state.sessions.length === 1 && state.session.name) {
                filename = state.session.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.slp';
            }
            try {
                state.slpFileHandle = await window.showSaveFilePicker({
                    suggestedName: filename,
                    types: [{
                        description: 'SLEAP Labels',
                        accept: { 'application/x-hdf5': ['.slp'] }
                    }]
                });
            } catch (pickErr) {
                if (pickErr.name === 'AbortError') {
                    setStatus('Save cancelled', 'warning');
                    return;
                }
                throw pickErr;
            }
        }

        state.isSaving = true;
        setStatus('Saving...', 'warning');

        // Stream straight to the file handle when the streaming path is used
        // (single or multi-session lazy save) — for a multi-GB project,
        // materializing the whole finished file as one extra in-memory
        // Uint8Array on top of whatever session state hasn't been reclaimed
        // yet is itself a meaningful chunk of peak memory. `bytesWritten`
        // tracks the total since a streamed save resolves `bytes` to `null`
        // (see `buildSlpBytes`/`finalizeProjectWriter`).
        var writable = await state.slpFileHandle.createWritable();
        var bytesWritten = 0;
        var sink = {
            write: function (chunk) { bytesWritten += chunk.byteLength; return writable.write(chunk); },
            close: function () { return writable.close(); },
        };
        var bytes = await buildSlpBytes({ sink: sink });
        if (bytes) {
            // Eager (non-streaming) path returned bytes directly instead of
            // using the sink — write them out now.
            await writable.write(bytes);
            await writable.close();
            bytesWritten = bytes.byteLength;
        }

        state.isSaving = false;
        clearDirty();
        var sizeMB = (bytesWritten / 1024 / 1024).toFixed(1);
        setStatus('Saved (' + sizeMB + ' MB)', 'success');
    } catch (err) {
        state.isSaving = false;
        if (err && err.name === 'SaveCancelledError') {
            // `writable` (if it got that far) already has an open swap file —
            // abort() discards it WITHOUT touching the original file at
            // `state.slpFileHandle`, unlike close(), which would overwrite it
            // with zero bytes.
            if (typeof writable !== 'undefined' && writable && typeof writable.abort === 'function') {
                try { await writable.abort(); } catch (e) { /* best effort */ }
            }
            setStatus('Save cancelled', 'warning');
            return;
        }
        console.error('Quick save failed:', err);
        setStatus('Save failed: ' + err.message, 'error');
    }
}

export async function saveAs() {
    // Force a new file picker regardless of existing handle
    state.slpFileHandle = null;
    await quickSave();
}

export async function saveProjectSlp() {
    if (!state.session) {
        setStatus('No session to save', 'error');
        return;
    }
    try {
        setStatus('Building SLP...', 'warning');

        var bytes = await buildSlpBytes();
        var blob = new Blob([bytes], { type: 'application/x-hdf5' });

        var filename = 'project.slp';
        if (state.sessions.length === 1 && state.session.name) {
            filename = state.session.name.replace(/[^a-zA-Z0-9_-]/g, '_') + '.slp';
        }

        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = filename;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

        setStatus('Project saved as SLP (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)', 'success');
    } catch (err) {
        if (err && err.name === 'SaveCancelledError') {
            setStatus('Save cancelled', 'warning');
            return;
        }
        console.error('Save project SLP failed:', err);
        setStatus('Save failed: ' + err.message, 'error');
    }
}

export function saveProject() {
    if (!state.session) {
        setStatus('No session to save', 'error');
        return;
    }
    // luc3d #195 — refuse rather than silently write a near-empty JSON for a
    // lazily reopened project. See `assertJsonSaveCoversProject`.
    if (!assertJsonSaveCoversProject(state.session)) return;
    for (var _si = 0; _si < state.sessions.length; _si++) {
        if (!assertJsonSaveCoversProject(state.sessions[_si])) return;
    }

    try {

    if (state.sessions.length > 1) {
        // V3: multi-session format
        // First, make sure active session's triangulationResults are saved
        state.sessions[state.activeSessionIdx].triangulationResults = state.triangulationResults;

        var projectData = {
            version: 3,
            sessions: state.sessions.map(function(sess, si) {
                return {
                    name: sess.name,
                    skeleton: {
                        name: sess.skeleton.name,
                        nodes: sess.skeleton.nodes,
                        edges: sess.skeleton.edges,
                    },
                    cameras: sess.cameras.map(function(c) {
                        return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
                    }),
                    tracks: sess.tracks,
                    identities: sess.identities.map(function (id) {
                        return { id: id.id, name: id.name, color: id.color };
                    }),
                    trustTracks: sess.trustTracks || false,
                    videoContrast: serializeVideoContrast(sess) || {},
                    frameIdentityMap: sess.frameIdentityMap
                        ? sess.exportFrameIdentityEntries()
                        : [],
                    videoManifest: sess.videoFileIndices.map(function(vfIdx) {
                        var vf = state.videoFiles[vfIdx];
                        return vf ? {
                            filename: vf.name,
                            assignedCamera: vf.assignedCamera || null,
                            videoPath: vf.videoPath || null,
                        } : null;
                    }).filter(Boolean),
                    frames: serializeSessionFrames(sess),
                };
            }),
        };

        // Build blob (same chunked approach)
        var blob = new Blob([JSON.stringify(projectData)], { type: 'application/json' });
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'project.mvgui.json';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
        setStatus('Project saved (v3, ' + state.sessions.length + ' sessions)', 'success');
        return;
    }
    // else: fall through to existing v2 save code below...

    var projectData = {
        version: 2,
        skeleton: {
            name: state.session.skeleton.name,
            nodes: state.session.skeleton.nodes,
            edges: state.session.skeleton.edges,
        },
        cameras: state.session.cameras.map(function (c) {
            return { name: c.name, matrix: c.matrix, dist: c.dist, rvec: c.rvec, tvec: c.tvec, size: c.size };
        }),
        tracks: state.session.tracks,
        identities: state.session.identities.map(function (id) {
            return { id: id.id, name: id.name, color: id.color };
        }),
        trustTracks: state.session.trustTracks || false,
        videoContrast: serializeVideoContrast(state.session) || {},
        frameIdentityMap: state.session.frameIdentityMap
            ? state.session.exportFrameIdentityEntries()
            : [],
        videoManifest: (state.videoFiles || []).map(function (vf) {
            return { filename: vf.name, assignedCamera: vf.assignedCamera || null };
        }),
        frames: {},
    };

    // Serialize each frame
    for (const [frameIdx, fg] of state.session.frameGroups) {
        const frameData = {
            instanceGroups: [],
            unlinkedInstances: [],
        };

        // Serialize instance groups
        const groups = state.session.instanceGroups.get(frameIdx) || [];
        for (const group of groups) {
            const groupData = {
                id: group.id,
                identityId: group.identityId != null ? group.identityId : -1,
                instances: {},
                points3d: toBoxedPoints3d(group.points3d),
                reprojections: group.reprojections || null,
                observedPoints: group.observedPoints || null,
                dirty: group.dirty || false,
            };
            if (group.usedCameras) {
                groupData.usedCameras = Array.from(group.usedCameras);
            }
            for (const [camName, inst] of group.instances) {
                const instData = {
                    points: inst.toPointsArray(),
                    trackIdx: inst.trackIdx,
                    type: inst.type,
                    score: inst.score,
                    modified: inst.modified,
                    occluded: inst.toOccludedArray(),
                };
                if (inst.nulledNodes && inst.nulledNodes.size > 0) {
                    instData.nulledNodes = Array.from(inst.nulledNodes);
                }
                groupData.instances[camName] = instData;
            }
            frameData.instanceGroups.push(groupData);
        }

        // Serialize unlinked instances
        for (const [camName, unlinkedList] of fg.unlinkedInstances) {
            for (const unlinked of unlinkedList) {
                const ulData = {
                    cameraName: camName,
                    points: unlinked.instance.toPointsArray(),
                    trackIdx: unlinked.instance.trackIdx,
                    type: unlinked.instance.type || 'user',
                    score: unlinked.instance.score || 1.0,
                    modified: unlinked.instance.modified || false,
                    occluded: unlinked.instance.toOccludedArray(),
                };
                if (unlinked.instance.nulledNodes && unlinked.instance.nulledNodes.size > 0) {
                    ulData.nulledNodes = Array.from(unlinked.instance.nulledNodes);
                }
                frameData.unlinkedInstances.push(ulData);
            }
        }

        projectData.frames[frameIdx] = frameData;
    }

    // Build blob in chunks to avoid "invalid string length" on large sessions
    var header = Object.assign({}, projectData);
    delete header.frames;
    var headerJson = JSON.stringify(header);
    // Strip closing "}" so we can append frames
    headerJson = headerJson.slice(0, -1) + ',"frames":{';

    var blobParts = [headerJson];
    var frameKeys = Object.keys(projectData.frames);
    for (var bfi = 0; bfi < frameKeys.length; bfi++) {
        var fk = frameKeys[bfi];
        var prefix = bfi > 0 ? ',' : '';
        blobParts.push(prefix + JSON.stringify(fk) + ':' + JSON.stringify(projectData.frames[fk]));
    }
    blobParts.push('}}');

    var blob = new Blob(blobParts, { type: 'application/json' });
    var url = URL.createObjectURL(blob);
    var a = document.createElement('a');
    a.href = url;
    a.download = 'project.mvgui.json';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    setTimeout(function () { URL.revokeObjectURL(url); }, 1000);

    setStatus('Project saved (' + (blob.size / 1024 / 1024).toFixed(1) + ' MB)', 'success');

    } catch (err) {
        console.error('Save project failed:', err);
        setStatus('Save failed: ' + err.message, 'error');
    }
}

export async function handleLoadProject(prePickedFile) {
    try {
        // Warn + reset if 3D points were imported into a skeleton-only project.
        if (!(await ensureNo3dImportBlockingLoad())) {
            setStatus('Load cancelled', 'warning');
            return;
        }
        var file;
        if (prePickedFile) {
            file = prePickedFile;
        } else {
            setStatus('Picking project file...', 'warning');
            const files = await pickFiles({ accept: '.slp,.json,.h5' });
            if (files.length === 0) {
                setStatus('No file selected', 'warning');
                return;
            }
            file = files[0];
        }

        // Route SLP/H5 files to the SLP loader.
        var ext = file.name.split('.').pop().toLowerCase();
        if (ext === 'slp' || ext === 'h5') {
            // Large project .slp → reopen LAZILY. The eager path
            // (handleLoadSlpFile) materializes every frame's 2D + a grouping
            // reconstruct duplicate and OOMs the tab on real multi-camera
            // prediction sessions (e.g. a 108k-frame × 3-cam cage5 project). The
            // lazy path keeps 2D on-demand and rebuilds grouping with lightweight
            // members; videos are attached afterward via File → Load Videos.
            var LARGE_SLP_BYTES = 200 * 1024 * 1024;
            if (ext === 'slp' && file.size > LARGE_SLP_BYTES) {
                // Dynamic import avoids a session-loader ↔ save-load import cycle.
                var _sl = await import('../loading/session-loader.js');
                if (_sl && typeof _sl.handleLoadProjectSlpLazy === 'function') {
                    return _sl.handleLoadProjectSlpLazy(file);
                }
            }
            return handleLoadSlpFile(file);
        }

        var fileSize = file.size;
        if (fileSize > 50 * 1024 * 1024) {
            if (!confirm('Project file is ' + (fileSize / 1024 / 1024).toFixed(0) + 'MB — this may be slow. Continue?')) {
                setStatus('Load cancelled', 'warning');
                return;
            }
        }
        showLoading('Loading project (' + (fileSize / 1024 / 1024).toFixed(1) + ' MB)...');

        const text = await file.text();
        showLoading('Parsing project...');
        const data = JSON.parse(text);

        // 1. Restore session data (cameras, skeleton, instances, groups)
        var cameras;
        if (data.version === 3) {
            cameras = _restoreProjectV3(data);
        } else if (data.version === 2) {
            cameras = _restoreProjectV2(data);
        } else {
            cameras = _restoreLegacySession(data);
        }


        // 2. Load videos — check if already loaded, only prompt for missing ones
        hideLoading();

        // For V3 projects, collect video manifests from all sessions
        var videoManifest = data.videoManifest || [];
        if (data.version === 3 && data.sessions) {
            videoManifest = [];
            for (var vsi = 0; vsi < data.sessions.length; vsi++) {
                var sessManifest = data.sessions[vsi].videoManifest || [];
                for (var vmi = 0; vmi < sessManifest.length; vmi++) {
                    sessManifest[vmi]._sessionIdx = vsi;
                    videoManifest.push(sessManifest[vmi]);
                }
            }
        }

        // For V3, use active session's cameras; for V2, use the single session's cameras
        var activeCameras = (data.version === 3 && state.sessions[state.activeSessionIdx])
            ? state.sessions[state.activeSessionIdx].cameras
            : cameras;
        var cameraNames = activeCameras.map(function (c) { return c.name; });
        var manifestFilenames = videoManifest.map(function (m) { return m.filename; }).filter(Boolean);

        // Check which manifest videos are already loaded in state.videoFiles
        var alreadyLoaded = [];
        var missingFilenames = [];
        for (var mfi = 0; mfi < manifestFilenames.length; mfi++) {
            var mfName = manifestFilenames[mfi];
            var found = (state.videoFiles || []).find(function (vf) { return vf.name === mfName; });
            if (found) {
                alreadyLoaded.push(found);
            } else {
                missingFilenames.push(mfName);
            }
        }

        var needsVideoPrompt = missingFilenames.length > 0 || manifestFilenames.length === 0;

        // Clear stale views
        if (videoController) {
            if (state.isPlaying) videoController.pause();
            setVideoController(null);
        }
        state.views = [];
        // Reset decoder pool + cold reserve on V3 project load. Old decoders
        // point at the previous project's files and must be released to
        // avoid dangling mp4box references / leaked file handles. Mirrors
        // the equivalent reset at the top of handleLoadSlpFile.
        if (data.version === 3) {
            if (Array.isArray(state.decoderPool)) {
                for (var _dpi = 0; _dpi < state.decoderPool.length; _dpi++) {
                    var _dp = state.decoderPool[_dpi];
                    if (_dp && typeof _dp.close === 'function') {
                        try { _dp.close(); } catch (_e) {}
                    }
                }
            }
            state.decoderPool = [];
            if (Array.isArray(state._decoderPoolCold)) {
                for (var _dci = 0; _dci < state._decoderPoolCold.length; _dci++) {
                    var _dc = state._decoderPoolCold[_dci];
                    if (_dc && _dc._coldTimer) {
                        clearTimeout(_dc._coldTimer);
                        _dc._coldTimer = null;
                    }
                    if (_dc && typeof _dc.close === 'function') {
                        try { _dc.close(); } catch (_e) {}
                    }
                }
            }
            state._decoderPoolCold = [];
        }
        paneManager.clearAll();

        if (data.version === 3 && data.sessions && needsVideoPrompt) {
            // V3: prompt for session folders — with parent directory option
            var v3AllSessionNames = data.sessions.map(function (sd, idx) { return sd.name || ('Session ' + (idx + 1)); });
            var v3ParentFilesMap = null; // Map<sessionName, File[]> from parent dir pick

            var v3Modal = getLoadingProgressModal({ title: 'Loading videos' });
            v3Modal.reset();
            v3Modal.show();

            for (var psi = 0; psi < data.sessions.length; psi++) {
                var sessData = data.sessions[psi];
                var sessName = sessData.name || ('Session ' + (psi + 1));
                var sessCameras = (sessData.videoManifest || []).map(function (m) { return m.assignedCamera; }).filter(Boolean);

                var folderFiles;
                if (v3ParentFilesMap && v3ParentFilesMap.has(sessName)) {
                    // Already resolved from parent directory pick
                    folderFiles = v3ParentFilesMap.get(sessName);
                } else if (v3ParentFilesMap) {
                    // Parent dir was picked but this session wasn't matched — prompt individually
                    folderFiles = await forceVideoSelectionWithFolder(
                        'Cameras: ' + sessCameras.join(', '),
                        sessName
                    );
                    if (folderFiles && folderFiles.parentResult) folderFiles = []; // shouldn't happen here
                } else {
                    // First session — offer parent directory option
                    var promptResult = await forceVideoSelectionWithFolder(
                        'Cameras: ' + sessCameras.join(', '),
                        sessName,
                        { allSessionNames: v3AllSessionNames }
                    );

                    if (promptResult && promptResult.parentResult) {
                        // User picked parent directory
                        v3ParentFilesMap = promptResult.parentResult.matched;
                        var v3Unmatched = promptResult.parentResult.unmatched;
                        await showParentDirMatchSummary(v3ParentFilesMap, v3Unmatched);

                        // Use matched files for this session
                        folderFiles = v3ParentFilesMap.has(sessName) ? v3ParentFilesMap.get(sessName) : [];
                    } else {
                        folderFiles = promptResult;
                    }
                }

                if (folderFiles && folderFiles.length > 0) {
                    var videoExtensions = ['.mp4', '.avi', '.webm', '.mov', '.mkv'];
                    for (var ffi = 0; ffi < folderFiles.length; ffi++) {
                        var file = folderFiles[ffi];
                        var fnLower = file.name.toLowerCase();
                        var ext = fnLower.substring(fnLower.lastIndexOf('.'));
                        if (videoExtensions.indexOf(ext) < 0) continue;

                        var stem = file.name.replace(/\.[^.]+$/, '');
                        if (state.videoFiles.find(function (vf) { return vf.name === stem; })) continue;

                        showLoading('Loading ' + file.name + '...');
                        var v3TaskId = v3Modal.addTask({ label: file.name || ('camera ' + ffi) });
                        var v3OnProgress = (function (tid) {
                            return function (ev) {
                                if (ev && ev.error) v3Modal.failTask(tid, ev.error);
                                else v3Modal.updateTask(tid, ev);
                            };
                        })(v3TaskId);
                        try {
                            var decoder = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10, onProgress: v3OnProgress });
                            await decoder.init(file);
                            var vw = decoder.videoTrack.video.width;
                            var vh = decoder.videoTrack.video.height;

                            // Figure out camera from subdirectory path
                            var relPath = file.webkitRelativePath || file.name;
                            var pathParts = relPath.split('/');
                            var dirCam = pathParts.length >= 2 ? pathParts[pathParts.length - 2] : null;

                            // Match to manifest camera
                            var assignedCam = null;
                            if (dirCam) {
                                var dirCamLower = dirCam.toLowerCase();
                                for (var sci = 0; sci < sessCameras.length; sci++) {
                                    if (sessCameras[sci].toLowerCase() === dirCamLower) {
                                        assignedCam = sessCameras[sci];
                                        break;
                                    }
                                }
                            }

                            var vfIdx = state.videoFiles.length;
                            state.videoFiles.push({
                                file: file,
                                name: stem,
                                decoder: decoder,
                                videoWidth: vw,
                                videoHeight: vh,
                                frameCount: decoder.samples.length,
                                assignedCamera: assignedCam,
                                videoPath: relPath,
                                sessionIdx: psi,
                            });

                            if (state.sessions[psi] && state.sessions[psi].videoFileIndices.indexOf(vfIdx) < 0) {
                                state.sessions[psi].videoFileIndices.push(vfIdx);
                            }
                            v3Modal.completeTask(v3TaskId);
                        } catch (vidErr) {
                            console.error('Failed to load ' + file.name + ':', vidErr);
                            v3Modal.failTask(v3TaskId, vidErr);
                        }
                    }
                }
            }
            hideLoading();

        } else if (needsVideoPrompt) {
            // V2 / legacy: single prompt for video files
            var manifestInfo = missingFilenames.length > 0
                ? 'Need: ' + missingFilenames.join(', ')
                : (manifestFilenames.join(', ') || '(unknown)');
            var videoFiles = await forceVideoSelection(manifestInfo);

            if (videoFiles.length > 0) {
                for (var i = 0; i < videoFiles.length; i++) {
                    var file2 = videoFiles[i];
                    var stem2 = file2.name.replace(/\.[^.]+$/, '');
                    if (state.videoFiles.find(function (vf) { return vf.name === stem2; })) continue;

                    showLoading('Loading ' + file2.name + ' (' + (i + 1) + '/' + videoFiles.length + ')...');
                    try {
                        var decoder2 = new OnDemandVideoDecoder({ cacheSize: 60, lookahead: 10 });
                        await decoder2.init(file2);
                        state.videoFiles.push({
                            file: file2,
                            name: stem2,
                            decoder: decoder2,
                            videoWidth: decoder2.videoTrack.video.width,
                            videoHeight: decoder2.videoTrack.video.height,
                            frameCount: decoder2.samples.length,
                            assignedCamera: null,
                            videoPath: file2.webkitRelativePath || file2.name,
                        });
                    } catch (videoErr) {
                        console.error('Failed to load ' + file2.name + ':', videoErr);
                    }
                }
            }
            hideLoading();

            // Match videos to cameras using manifest (V2 path)
            for (var mi = 0; mi < videoManifest.length; mi++) {
                var entry = videoManifest[mi];
                if (!entry.filename || !entry.assignedCamera) continue;
                for (var vfi = 0; vfi < state.videoFiles.length; vfi++) {
                    var vf = state.videoFiles[vfi];
                    if (!vf.assignedCamera && vf.name === entry.filename) {
                        vf.assignedCamera = entry.assignedCamera;
                        break;
                    }
                }
            }
        }

        // Resolve stale manifest camera names (active session only for V3)
        for (var ri = 0; ri < state.videoFiles.length; ri++) {
            var rvf = state.videoFiles[ri];
            if (data.version === 3 && rvf.sessionIdx != null && rvf.sessionIdx !== state.activeSessionIdx) continue;
            if (rvf.assignedCamera && cameraNames.indexOf(rvf.assignedCamera) < 0) {
                var rvfLower = rvf.assignedCamera.toLowerCase();
                for (var rci = 0; rci < cameraNames.length; rci++) {
                    var rcamLower = cameraNames[rci].toLowerCase();
                    var rUsed = state.videoFiles.some(function (other) {
                        return other !== rvf && other.assignedCamera === cameraNames[rci];
                    });
                    if (rUsed) continue;
                    if (rvfLower === rcamLower || rvfLower.indexOf(rcamLower) >= 0 || rcamLower.indexOf(rvfLower) >= 0) {
                        console.log('[load-project] Resolved manifest camera "' + rvf.assignedCamera + '" -> "' + cameraNames[rci] + '"');
                        rvf.assignedCamera = cameraNames[rci];
                        break;
                    }
                }
            }
        }

        autoAssignVideosToCameras();

        // For any still-unassigned video, try exact camera name match (active session only for V3)
        for (var vi = 0; vi < state.videoFiles.length; vi++) {
            var vf2 = state.videoFiles[vi];
            if (data.version === 3 && vf2.sessionIdx != null && vf2.sessionIdx !== state.activeSessionIdx) continue;
            if (!vf2.assignedCamera && cameraNames.indexOf(vf2.name) >= 0) {
                vf2.assignedCamera = vf2.name;
            }
        }

        // Create views for assigned videos (active session only for V3)
        showLoading('Creating views...');
        for (var vi2 = 0; vi2 < state.videoFiles.length; vi2++) {
            var vf3 = state.videoFiles[vi2];
            // For V3 projects, only create views for the active session
            if (data.version === 3 && vf3.sessionIdx != null && vf3.sessionIdx !== state.activeSessionIdx) {
                continue;
            }
            if (vf3.assignedCamera) {
                var hasView = state.views.some(function (v) { return v.name === vf3.assignedCamera; });
                if (!hasView) {
                    createViewForVideoFile(vf3);
                }
            }
        }

        updateTotalFrames();
        if (state.views.length > 0) {
            hideWelcomeOverlay();
            populateViewStrip();
            populateSessionStrip();
            paneManager.addAllViewsAsGrid();
            rebuildVideoController();
            fitCanvasesToCells();
        }

        // Seek to first labeled frame or frame 0
        if (videoController && state.views.length > 0) {
            var firstFrame = 0;
            for (var [fIdx] of state.session.frameGroups) {
                firstFrame = fIdx;
                break;
            }
            state.currentFrame = firstFrame;
            await videoController.seekToFrame(firstFrame);
        }

        // 3. Set up 3D viewport (use active session's cameras)
        if (viewport3d) {
            viewport3d.cameras = state.session.cameras;
            viewport3d.skeleton = state.session.skeleton;
            viewport3d.addCameraPyramids();
            viewport3d.setFrame(getInstanceGroupsForFrame(state.currentFrame));
            viewport3d.fitToScene();
        } else {
            setup3DViewport();
        }

        // 4. Draw overlays and update UI
        if (state.triangulationResults.size > 0) {
            setReprojErrorVisible(true);
        }
        drawAllOverlays(state.currentFrame);
        updateInfoPanel();
        if (timeline) timeline.setData(state.session);

        hideLoading();

        var statusParts = [cameras.length + ' cameras', state.session.numFrames + ' labeled frames'];
        if (state.views.length > 0) {
            statusParts.push(state.views.length + ' views');
        }
        setStatus('Project loaded (' + statusParts.join(', ') + ')', 'success');
    } catch (err) {
        console.error('Failed to load project:', err);
        hideLoading();
        setStatus('Load error: ' + err.message, 'error');
    }
}

function _restoreProjectV3(data) {
    state.sessions = [];
    state.triangulationResults = new Map();
    var allCameras = null;

    for (var si = 0; si < data.sessions.length; si++) {
        var sd = data.sessions[si];
        // Reuse _restoreProjectV2 logic per session
        var sessionData = Object.assign({}, sd, { version: 2 });
        var cameras = _restoreProjectV2(sessionData);
        // _restoreProjectV2 sets state.session and pushes to state.sessions
        state.session.name = sd.name || ('Session ' + (si + 1));

        // Store triangulation results on session object
        state.session.triangulationResults = state.triangulationResults;
        state.triangulationResults = new Map();

        if (si === 0) allCameras = cameras;
    }

    // Activate first session
    state.activeSessionIdx = 0;
    state.session = state.sessions[0];
    state.triangulationResults = state.sessions[0].triangulationResults || new Map();

    return allCameras;
}

/**
 * Restore session data from a v2 project JSON. Sets state.session.
 * @returns {Camera[]} parsed cameras
 */
function _restoreProjectV2(data) {
    var cameras = [];
    if (data.cameras) {
        cameras = parseCalibrationJSON(JSON.stringify({ cameras: data.cameras }));
    }

    var skeleton;
    if (data.skeleton) {
        skeleton = new Skeleton(
            data.skeleton.name || 'skeleton',
            data.skeleton.nodes || [],
            data.skeleton.edges || []
        );
    } else {
        skeleton = createDemoSkeleton();
    }

    var tracks = data.tracks || ['track_0'];
    var session = new Session(cameras, skeleton, tracks);

    if (data.identities) {
        for (var idi = 0; idi < data.identities.length; idi++) {
            var idData = data.identities[idi];
            session.identities.push(new Identity(idData.id, idData.name, idData.color));
        }
    }
    if (data.trustTracks != null) session.trustTracks = data.trustTracks;
    // Per-camera video contrast (issue #149). Shared by the v2 (whole document)
    // and v3 (per-session dict) shapes — both put the key at this level.
    ingestVideoContrast(session, data.videoContrast);
    // Legacy global identity map (removed). Captured here and migrated to
    // per-frame entries after frame groups load (see end of this function).
    var legacyGlobalIdentities = data.trackIdentityMap || null;
    if (data.frameIdentityMap && data.frameIdentityMap.length > 0) {
        session.ingestFrameIdentityEntries(data.frameIdentityMap);
    }

    if (data.frames) {
        for (var frameIdxStr in data.frames) {
            var frameIdx = parseInt(frameIdxStr);
            var frameData = data.frames[frameIdxStr];
            var fg = new FrameGroup(frameIdx);

            if (frameData.instanceGroups) {
                if (!session.instanceGroups.has(frameIdx)) {
                    session.instanceGroups.set(frameIdx, []);
                }

                for (var gi = 0; gi < frameData.instanceGroups.length; gi++) {
                    var groupData = frameData.instanceGroups[gi];
                    // Backwards compat: if groupData has trackIdx but no identityId, use trackIdx as identityId
                    var loadedIdentityId = groupData.identityId != null ? groupData.identityId
                        : (groupData.trackIdx != null ? groupData.trackIdx : -1);
                    var group = new InstanceGroup(groupData.id || Date.now(), loadedIdentityId);
                    if (groupData.points3d) {
                        group.points3d = asPoints3d(groupData.points3d);
                    }
                    if (groupData.reprojections) {
                        group.reprojections = groupData.reprojections;
                    }
                    // groupData.observedPoints is ignored on restore: it is now
                    // DERIVED from the group's instances, which are rebuilt just
                    // below. Still written on save for backward compat (luc3d #189).

                    for (var camName in groupData.instances) {
                        var instData = groupData.instances[camName];
                        var inst = new Instance(
                            instData.points,
                            // null trackIdx = trackless; preserve it (don't snap to track 0).
                            instData.trackIdx != null ? instData.trackIdx : (groupData.trackIdx != null ? groupData.trackIdx : null),
                            instData.type || 'user',
                            instData.score || 1.0
                        );
                        inst.modified = instData.modified || false;
                        if (instData.occluded) inst.setOccludedFrom(instData.occluded);
                        if (instData.nulledNodes && instData.nulledNodes.length > 0) {
                            inst.nulledNodes = new Set(instData.nulledNodes);
                        }
                        group.addInstance(camName, inst);
                        fg.addInstance(camName, inst);
                    }

                    if (groupData.usedCameras) {
                        group.usedCameras = new Set(groupData.usedCameras);
                    }
                    if (groupData.dirty) {
                        group.markDirty();
                    } else if (group.points3d) {
                        group.markClean();
                    }

                    // Rebuild reprojectedInstances from saved reprojections
                    if (group.reprojections) {
                        for (var rCamName in group.reprojections) {
                            var rPts = group.reprojections[rCamName];
                            if (rPts) {
                                var rInst = new Instance(rPts, group.identityId, 'reprojected', 0);
                                group.addReprojectedInstance(rCamName, rInst);
                            }
                        }
                    }

                    session.instanceGroups.get(frameIdx).push(group);
                }
            }

            if (frameData.unlinkedInstances) {
                for (var ui = 0; ui < frameData.unlinkedInstances.length; ui++) {
                    var ulData = frameData.unlinkedInstances[ui];
                    var ulInst = new Instance(
                        ulData.points,
                        // null trackIdx = trackless; preserve it (don't snap to track 0).
                        ulData.trackIdx != null ? ulData.trackIdx : null,
                        ulData.type || 'user',
                        ulData.score || 1.0
                    );
                    ulInst.modified = ulData.modified || false;
                    if (ulData.occluded) ulInst.setOccludedFrom(ulData.occluded);
                    if (ulData.nulledNodes && ulData.nulledNodes.length > 0) {
                        ulInst.nulledNodes = new Set(ulData.nulledNodes);
                    }
                    var unlinked = new UnlinkedInstance(ulInst, ulData.cameraName);
                    fg.addUnlinkedInstance(ulData.cameraName, unlinked);
                }
            }

            session.addFrameGroup(fg);
        }
    }

    // Migrate any legacy global identities into per-frame entries now that
    // frame groups exist (preserves identities from pre-per-frame projects).
    if (legacyGlobalIdentities && legacyGlobalIdentities.length) {
        var migrated = session.migrateGlobalIdentitiesToPerFrame(legacyGlobalIdentities);
        if (migrated) console.log('[load] migrated', migrated, 'legacy global identities to per-frame');
    }

    state.session = session;
    if (state.sessions.indexOf(state.session) < 0) {
        state.sessions.push(state.session);
        state.activeSessionIdx = state.sessions.length - 1;
    }
    state.triangulationResults = new Map();

    // Camera lookup by name, for recomputing the undistorted-space error below.
    var trCamByName = {};
    for (var trci = 0; trci < cameras.length; trci++) trCamByName[cameras[trci].name] = cameras[trci];

    // Rebuild triangulationResults from saved reprojection/error data
    for (var [trFrameIdx, trGroups] of session.instanceGroups) {
        var trFrameResults = [];
            for (var trgi = 0; trgi < trGroups.length; trgi++) {
                var trGroup = trGroups[trgi];
                if (trGroup.points3d && trGroup.reprojections) {
                    // Distorted-space error from saved observed + reprojected
                    // points (saved reprojections are native/distorted pixels).
                    var trErrors = {};
                    var trTotalErr = 0, trTotalCount = 0;
                    // Undistorted-space error (mirror triangulateAndReproject
                    // Step 5): ideal pinhole reprojection vs undistorted obs, so
                    // the Undistorted headline isn't blank for loaded projects.
                    var trErrorsUndist = {};
                    var trTotalErrU = 0, trTotalCountU = 0;
                    // Derived (luc3d #189) — hoist, it allocates per access.
                    var trObserved = trGroup.observedPoints;
                    for (var trCamName in trGroup.reprojections) {
                        var trObs = trObserved[trCamName] || null;
                        var trRep = trGroup.reprojections[trCamName];
                        if (!trObs || !trRep) continue;
                        trErrors[trCamName] = [];
                        var trCam = trCamByName[trCamName];
                        var idealRep = (trCam && trCam.projectionMatrix)
                            ? reprojectPoints(trGroup.points3d, trCam.projectionMatrix) : null;
                        trErrorsUndist[trCamName] = [];
                        for (var trni = 0; trni < trRep.length; trni++) {
                            if (trObs[trni] && trRep[trni]) {
                                var dx = trRep[trni][0] - trObs[trni][0];
                                var dy = trRep[trni][1] - trObs[trni][1];
                                var err = Math.sqrt(dx * dx + dy * dy);
                                trErrors[trCamName].push(err);
                                trTotalErr += err;
                                trTotalCount++;
                            } else {
                                trErrors[trCamName].push(null);
                            }
                            // Undistorted residual for this keypoint.
                            if (idealRep && trObs[trni] && idealRep[trni] && trCam && trCam.undistortPoint) {
                                var ou = trCam.undistortPoint(trObs[trni]);
                                var dxu = idealRep[trni][0] - ou[0];
                                var dyu = idealRep[trni][1] - ou[1];
                                var erru = Math.sqrt(dxu * dxu + dyu * dyu);
                                trErrorsUndist[trCamName].push(erru);
                                trTotalErrU += erru;
                                trTotalCountU++;
                            } else {
                                trErrorsUndist[trCamName].push(null);
                            }
                        }
                    }
                    trFrameResults.push({
                        group: trGroup,
                        points3d: trGroup.points3d,
                        reprojections: trGroup.reprojections,
                        errors: trErrors,
                        errorsUndistorted: trErrorsUndist,
                        meanError: trTotalCount > 0 ? trTotalErr / trTotalCount : null,
                        meanErrorUndistorted: trTotalCountU > 0 ? trTotalErrU / trTotalCountU : null
                    });
                    // Also store reprojected instances for overlay rendering
                    storeReprojectedInstances(trGroup, { reprojections: trGroup.reprojections, points3d: trGroup.points3d }, cameras);
                }
            }
        if (trFrameResults.length > 0) {
            state.triangulationResults.set(trFrameIdx, trFrameResults);
        }
    }

    // Fix camera name mismatches: instance keys may differ from camera names
    // (e.g., instances keyed by video name "CamA" but camera named "A")
    _resolveInstanceCameraNames(session, cameras, data.videoManifest || []);

    return cameras;
}

/**
 * Resolve camera name mismatches between instance keys and calibration camera names.
 * Uses the videoManifest to build old→new name mapping, then renames all instance data.
 */
function _resolveInstanceCameraNames(session, cameras, videoManifest) {
    var cameraNames = cameras.map(function (c) { return c.name; });

    // Collect all instance keys actually used in the data
    var usedKeys = new Set();
    for (var [fIdx, groups] of session.instanceGroups) {
        for (var g of groups) {
            for (var key of g.instances.keys()) usedKeys.add(key);
        }
    }
    for (var [fIdx2, fg] of session.frameGroups) {
        for (var fgKey of fg.instances.keys()) usedKeys.add(fgKey);
        for (var ulKey of fg.unlinkedInstances.keys()) usedKeys.add(ulKey);
    }

    // Check if all used keys already match camera names
    var allMatch = true;
    for (var usedKey of usedKeys) {
        if (cameraNames.indexOf(usedKey) < 0) { allMatch = false; break; }
    }
    if (allMatch) return; // No mismatch

    console.log('[project] Instance keys', Array.from(usedKeys), 'do not match camera names', cameraNames);

    // Build mapping from old names to new names
    // Strategy 1: Use videoManifest (filename → assignedCamera → camera name)
    var renameMap = {};
    for (var mi = 0; mi < videoManifest.length; mi++) {
        var entry = videoManifest[mi];
        var oldKey = entry.assignedCamera || entry.filename;
        if (!oldKey || cameraNames.indexOf(oldKey) >= 0) continue; // Already matches
        // Try to match this old key to a camera by substring
        var oldLower = oldKey.toLowerCase();
        for (var ci = 0; ci < cameraNames.length; ci++) {
            var camLower = cameraNames[ci].toLowerCase();
            var alreadyMapped = false;
            for (var mk in renameMap) {
                if (renameMap[mk] === cameraNames[ci]) { alreadyMapped = true; break; }
            }
            if (alreadyMapped) continue;
            if (oldLower === camLower || oldLower.indexOf(camLower) >= 0 || camLower.indexOf(oldLower) >= 0) {
                renameMap[oldKey] = cameraNames[ci];
                break;
            }
        }
    }

    // Strategy 2: For any used key not in renameMap, try direct substring match
    for (var usedKey2 of usedKeys) {
        if (cameraNames.indexOf(usedKey2) >= 0) continue; // Already matches
        if (renameMap[usedKey2]) continue; // Already mapped
        var usedLower = usedKey2.toLowerCase();
        for (var ci2 = 0; ci2 < cameraNames.length; ci2++) {
            var camLower2 = cameraNames[ci2].toLowerCase();
            var alreadyMapped2 = false;
            for (var mk2 in renameMap) {
                if (renameMap[mk2] === cameraNames[ci2]) { alreadyMapped2 = true; break; }
            }
            if (alreadyMapped2) continue;
            if (usedLower === camLower2 || usedLower.indexOf(camLower2) >= 0 || camLower2.indexOf(usedLower) >= 0) {
                renameMap[usedKey2] = cameraNames[ci2];
                break;
            }
        }
    }

    // Apply renames
    for (var oldName in renameMap) {
        console.log('[project] Renaming instance key "' + oldName + '" -> "' + renameMap[oldName] + '"');
        session.renameCameraInAllData(oldName, renameMap[oldName]);
    }
}

/**
 * Restore session data from a legacy (flat) project JSON. Sets state.session.
 * @returns {Camera[]} parsed cameras
 */
function _restoreLegacySession(data) {
    var cameras = [];
    if (data.cameras) {
        cameras = parseCalibrationJSON(JSON.stringify({ cameras: data.cameras }));
    }

    var skeleton;
    if (data.skeleton) {
        skeleton = new Skeleton(
            data.skeleton.name || 'skeleton',
            data.skeleton.nodes || [],
            data.skeleton.edges || []
        );
    } else {
        skeleton = createDemoSkeleton();
    }

    var tracks = data.tracks || ['track_0'];
    var session = new Session(cameras, skeleton, tracks);

    if (data.frames) {
        for (var frameIdxStr in data.frames) {
            var frameIdx = parseInt(frameIdxStr);
            var frameData = data.frames[frameIdxStr];
            var fg = new FrameGroup(frameIdx);

            for (var camName in frameData) {
                if (camName === 'instanceGroups' || camName === 'unlinkedInstances') continue;
                var instances = frameData[camName];
                if (!Array.isArray(instances)) continue;
                for (var i = 0; i < instances.length; i++) {
                    var instData = instances[i];
                    var inst = new Instance(
                        instData.points,
                        instData.trackIdx || 0,
                        instData.type || 'user',
                        instData.score || 1.0
                    );
                    inst.modified = instData.modified || false;
                    fg.addInstance(camName, inst);
                }
            }

            session.addFrameGroup(fg);
        }
    }

    // Reconstruct InstanceGroups by grouping instances with the same trackIdx
    for (var [frameIdx2, fg2] of session.frameGroups) {
        var trackInstances = new Map();
        for (var [cn, insts] of fg2.instances) {
            for (var ii = 0; ii < insts.length; ii++) {
                var tIdx = insts[ii].trackIdx || 0;
                if (!trackInstances.has(tIdx)) trackInstances.set(tIdx, []);
                trackInstances.get(tIdx).push({ camName: cn, instance: insts[ii] });
            }
        }
        if (!session.instanceGroups.has(frameIdx2)) session.instanceGroups.set(frameIdx2, []);
        for (var [trkIdx, entries] of trackInstances) {
            var grp = new InstanceGroup(Date.now() + trkIdx, trkIdx); // identityId = trackIdx for backwards compat
            for (var ei = 0; ei < entries.length; ei++) grp.addInstance(entries[ei].camName, entries[ei].instance);
            session.instanceGroups.get(frameIdx2).push(grp);
        }
    }

    state.session = session;
    if (state.sessions.indexOf(state.session) < 0) {
        state.sessions.push(state.session);
        state.activeSessionIdx = state.sessions.length - 1;
    }
    state.triangulationResults = new Map();

    // Fix camera name mismatches
    _resolveInstanceCameraNames(session, cameras, data.videoManifest || []);

    return cameras;
}

// ============================================
// Loading / Status
// ============================================

export function showLoading(msg) {
    document.getElementById('loadingOverlay').classList.remove('hidden');
    document.getElementById('loadingStatus').textContent = msg || 'Loading...';
}

export function hideLoading() {
    document.getElementById('loadingOverlay').classList.add('hidden');
}

export function setStatus(text, type) {
    document.getElementById('statusText').textContent = text;
    const dot = document.getElementById('statusDot');
    dot.className = 'status-dot';
    if (type === 'error') dot.classList.add('error');
    else if (type === 'warning') dot.classList.add('warning');
    else if (type === 'success') dot.classList.add('success');
}
