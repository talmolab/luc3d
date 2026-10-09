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

import { trailFrames, trailRate } from './trail-presets.js?v=acbc61b54ece';

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
    trailSeconds: 0,            // node-trail length in SECONDS (0 = off; presets ¼/½/1/2 s or Custom…, ui/trail-presets.js). Set via Tracks menu / Trails button.
    // The trail in FRAMES, derived — never stored — so it follows `fps` when a
    // video loads or the FPS pill is edited. Setting it (tests and benches pin a
    // frame count) stores the same span in seconds at the current rate.
    get trailLength() { return trailFrames(this.trailSeconds, this.fps); },
    set trailLength(frames) { this.trailSeconds = frames > 0 ? frames / trailRate(this.fps) : 0; },
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
// True when `view` has a video pane in the dock, i.e. its canvas is on screen
// (a pane in an inactive tab still counts). Every view keeps a decoder whether
// or not it is docked, so frame stepping, playback and overlay drawing ask this
// to skip the views nobody can see: with one camera solo'd out of 17, the other
// 16 used to decode every step and play during playback all the same. A view
// that is docked again gets a NEW canvas, and the pane's renderer then
// re-seeks the current frame (`refreshPaneInteractions`), so skipping it
// meanwhile never leaves a stale picture on screen. With no dock at all
// (before the dock exists) every view counts as shown, as before.
export function isViewDocked(view) {
    if (!paneManager || !paneManager.dockedViews || !view) return true;
    return paneManager.dockedViews.get(view.name) > 0;
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
// The single PROJECT skeleton, shared BY REFERENCE across every session in the
// project (state.sessions[*].skeleton === this object). "One skeleton per
// project": loading/editing a skeleton on one session applies to all, and the
// exported .slp always carries exactly one skeleton (no duplicates for sleap-io/
// sleap-nn to trip on). Calibration stays per-session; this is skeleton-only.
// Lives in module memory: carries across loads within one app session, resets on
// a full page reload (by design).
let _rememberedSkeleton = null;

// The current project skeleton (the object all sessions share), or null.
export function getProjectSkeleton() {
    if (_rememberedSkeleton) return _rememberedSkeleton;
    if (state.session && state.session.skeleton) return state.session.skeleton;
    return null;
}

// Make `skeleton` the single project skeleton: point every session's `.skeleton`
// at this same object and store it as the default new sessions inherit. Because
// the skeleton editor mutates the object in place, all sessions then stay in sync
// automatically. Node add/remove still needs per-session instance propagation
// (see propagateSkeletonNodeChange in info-panel.js).
export function setProjectSkeleton(skeleton) {
    if (!skeleton) return;
    _rememberedSkeleton = skeleton;
    if (state.sessions && state.sessions.length) {
        for (var i = 0; i < state.sessions.length; i++) {
            if (state.sessions[i]) state.sessions[i].skeleton = skeleton;
        }
    }
    if (state.session) state.session.skeleton = skeleton;
}

// Back-compat shim: snapshot `skeleton` as the project default. Now stores the
// reference (not a clone) so new sessions SHARE it rather than diverging.
export function rememberSkeleton(skeleton) {
    if (skeleton && skeleton.nodes && skeleton.nodes.length > 0) {
        _rememberedSkeleton = skeleton;
    }
}

// The project skeleton for seeding a newly created session. Returns the SHARED
// reference (one skeleton per project), or null if none has been set yet — in
// which case the caller's fresh `new Skeleton()` should be registered via
// setProjectSkeleton so subsequent sessions share it.
export function buildRememberedSkeleton() {
    return _rememberedSkeleton;
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
