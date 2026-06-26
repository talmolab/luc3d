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

// True only when real decodable video is loaded. A non-null `videoController`
// is NOT sufficient: `setupEmptyVideoController()` installs one at app init
// before any video exists, and a skeleton + imported-3D-points project keeps
// that empty controller. Frame navigation / playback must branch on whether
// any view actually has a decoder, not on the controller's existence.
export function hasRealVideo() {
    return !!(videoController && state.views && state.views.some(function (v) { return v.decoder; }));
}
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

// --- Remembered skeleton (current app session only, no persistence) ----------
// Holds a clone of the last non-empty skeleton the user built or loaded, so a
// newly loaded video/session can inherit it instead of starting blank. Lives in
// module memory: it carries across video loads within one app session and resets
// on a full page reload (by design).
let _rememberedSkeleton = null;

// Snapshot `skeleton` as the remembered default. Ignores null/empty skeletons so
// that viewing a blank session never clobbers a previously remembered one.
export function rememberSkeleton(skeleton) {
    if (skeleton && skeleton.nodes && skeleton.nodes.length > 0) {
        _rememberedSkeleton = skeleton.clone();
    }
}

// A fresh clone of the remembered skeleton (independent arrays so each session
// owns its own), or null if nothing has been remembered yet.
export function buildRememberedSkeleton() {
    return _rememberedSkeleton ? _rememberedSkeleton.clone() : null;
}

// --- Instance clipboard (Cmd/Ctrl+C / Cmd/Ctrl+V) ----------------------------
// Holds a single copied UserInstance as a skeleton-agnostic snapshot:
//   { compatKey, pointsByName: { name -> {point:[x,y]|null, occluded} },
//     sourceView, sourceFrame }
// Lives in module memory so copy/paste works across frames, videos, and sessions
// within one app session (and resets on a full page reload). `compatKey` is the
// source skeleton's compatibilityKey() so paste can require a matching skeleton.
let _instanceClipboard = null;

export function setInstanceClipboard(data) {
    _instanceClipboard = data;
}

export function getInstanceClipboard() {
    return _instanceClipboard;
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
