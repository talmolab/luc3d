/**
 * app-state.js — central application state and controller singleton registry.
 *
 * `state` is the canonical, mutable application state object. Its fields are
 * read and mutated by many modules; mutations are not gated by setters because
 * the codebase has hundreds of `state.X = …` sites. Treat the object as a
 * shared bag.
 *
 * The five controller bindings (`videoController`, `interactionManager`,
 * `viewport3d`, `timeline`, `paneManager`) are exported as live `let` bindings
 * so importers always read the current value. Reassignment goes through the
 * `setXxx` setter functions (importers cannot reassign a `let` import).
 *
 * `getActiveSession`/`setActiveSession` and `VIEW_NAMES` complete the public
 * surface.
 */

export const state = {
    views: [],          // { name, decoder, canvas, ctx, overlayCanvas, overlayCtx, videoWidth, videoHeight }
    videoFiles: [],     // { file, name, decoder, videoWidth, videoHeight, frameCount, assignedCamera }
    viewMode: 'grid',   // 'grid' or 'single'
    singleViewIndex: 0, // index into state.views for single-view mode
    currentFrame: 0,
    totalFrames: 0,
    fps: 30,
    isPlaying: false,
    playInterval: null,
    session: null,      // Session object from pose-data.js
    sessions: [],              // Array of Session objects
    activeSessionIdx: 0,       // Index of currently active session
    keypoints3d: null,  // Raw 3D keypoints from demo-data.js
    triangulationResults: new Map(), // frameIdx -> [{ group, points3d, reprojections, errors, meanError }]
    lastAutoAssignViews: null,  // Array of view names used for last auto-assignment
    lastAutoAssignFrame: null,  // Frame index where last auto-assignment was run
    lastUserPoints: new Map(),  // viewName -> {frameIdx, points} — cache of most recent UserInstance per view
    exportDirHandle: null,      // FileSystemDirectoryHandle from showDirectoryPicker(), retained across exports
    cameraDirMap: {},           // camName -> subdirectory name, cached from session folder load
    colorByIdentity: false,     // false = color by track, true = color by identity
    decoderPool: [],            // Persistent OnDemandVideoDecoder instances, reused across session switches
    slpFileHandle: null,        // FileSystemFileHandle for quick save
    isDirty: false,             // true when unsaved annotation changes exist
    isSaving: false,            // true while save is in progress
};

export let videoController = null;
export let interactionManager = null;
export let viewport3d = null;
export let timeline = null;
export let paneManager = null;

export function setVideoController(v) { videoController = v; }
export function setInteractionManager(v) { interactionManager = v; }
export function setViewport3D(v) { viewport3d = v; }
export function setTimeline(v) { timeline = v; }
export function setPaneManager(v) { paneManager = v; }

// View names matching sample_session video files
export const VIEW_NAMES = ['back', 'mid', 'side', 'top'];

export function getActiveSession() {
    if (state.sessions.length === 0) return state.session;
    return state.sessions[state.activeSessionIdx] || null;
}

export function setActiveSession(session) {
    if (state.sessions.length === 0) {
        state.session = session;
        return;
    }
    state.sessions[state.activeSessionIdx] = session;
    state.session = session;
}

// Debug accessor — DevTools console can inspect via `__lucid.state` etc.
// Module-scoped bindings aren't reachable from the console after the Pass 2 ESM split.
if (typeof window !== 'undefined') {
    window.__lucid = {
        get state() { return state; },
        get videoController() { return videoController; },
        get interactionManager() { return interactionManager; },
        get viewport3d() { return viewport3d; },
        get timeline() { return timeline; },
        get paneManager() { return paneManager; },
    };
}
