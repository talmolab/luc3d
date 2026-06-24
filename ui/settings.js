// ui/settings.js
// Central user-settings store for LUCID: the default triangulation method plus a
// comprehensive catalog of every keyboard shortcut in the app. Settings persist
// to localStorage so they survive reloads.
//
// The keyboard catalog (ACTION_CATALOG) is the single source of truth for the
// Settings ▸ Keyboard Shortcuts panel. Each entry declares its category, default
// binding, whether it is user-editable, and whether it is dispatched centrally:
//   - `dispatched: true`  → the binding is matched live by dispatchEvent() (or by
//     a module calling matchesBinding()), and a handler is attached at runtime
//     via setHandler(). Editing such a binding takes effect immediately.
//   - `dispatched: false` → the shortcut is handled by its own dedicated event
//     handler elsewhere (transport, timeline-controller, interaction, …); the
//     catalog entry exists so the panel lists it accurately as reference.
//
// MAINTENANCE: when you add or change a keyboard shortcut anywhere in the app,
// add/update its entry here so the Settings panel stays complete and truthful.
// (See CLAUDE.md.)

const STORAGE_KEY = 'lucid.settings.v1';

const DEFAULTS = {
    triangulationMethod: 'dlt', // 'dlt' | 'ba'
};

// Default weight for any skeleton node not explicitly overridden. A weight of 1
// means the node participates fully in the tracking cost (epipolar, reprojection,
// instance distance); 0 means it is ignored. Stored overrides are keyed by node
// name so they persist across reloads independently of node ordering.
const DEFAULT_NODE_WEIGHT = 1;

// Catalog of every shortcut. `binding` is a "+"-joined accelerator string for
// dispatched entries (modifier tokens: Mod = Ctrl-or-Cmd, Ctrl, Cmd/Meta, Shift,
// Alt/Option/Opt; last token is the key), or a free-form display string for
// fixed reference entries (e.g. "← / →", "1 – 9").
const ACTION_CATALOG = [
    // --- File ---
    { id: 'save', label: 'Save project', category: 'File', binding: 'Mod+S', editable: false, dispatched: false },
    { id: 'loadSession', label: 'Load single session folder', category: 'File', binding: 'Mod+O', editable: true, dispatched: true },
    { id: 'openSettings', label: 'Open Settings', category: 'File', binding: 'Mod+,', editable: true, dispatched: true },

    // --- Navigation ---
    { id: 'prevNextFrame', label: 'Previous / Next frame', category: 'Navigation', binding: '← / →', editable: false, dispatched: false },
    { id: 'labeledFrame', label: 'Prev / Next user-labeled frame', category: 'Navigation', binding: 'Opt+← / Opt+→', editable: false, dispatched: false },
    { id: 'firstLastFrame', label: 'First / Last frame', category: 'Navigation', binding: 'Home / End', editable: false, dispatched: false },
    { id: 'playPause', label: 'Play / Pause', category: 'Navigation', binding: 'Space', editable: false, dispatched: false },
    { id: 'gotoFrame', label: 'Go to frame number', category: 'Navigation', binding: 'Mod+Shift+J', editable: false, dispatched: false },

    // --- Editing ---
    { id: 'addInstanceSmart', label: 'Add instance (smart init)', category: 'Editing', binding: 'Mod+I', editable: true, dispatched: true },
    { id: 'addInstance', label: 'Add instance', category: 'Editing', binding: 'n', editable: true, dispatched: true },
    { id: 'deleteInstance', label: 'Delete selected (Shift: cascade)', category: 'Editing', binding: 'Delete', editable: false, dispatched: false },
    { id: 'ungroup', label: 'Ungroup selected', category: 'Editing', binding: 'Shift+u', editable: true, dispatched: true },
    { id: 'group', label: 'Group selected (assignment mode)', category: 'Editing', binding: 'Shift+g', editable: true, dispatched: true },
    { id: 'groupConfirmLegacy', label: 'Confirm group from assignment (legacy)', category: 'Editing', binding: 'c', editable: false, dispatched: false },
    { id: 'triangulate', label: 'Triangulate current frame', category: 'Editing', binding: 't', editable: true, dispatched: true },
    { id: 'trackFrame', label: 'Track current frame', category: 'Editing', binding: 'Shift+T', editable: true, dispatched: true },
    { id: 'trackAll', label: 'Track all frames', category: 'Editing', binding: 'Mod+Shift+T', editable: true, dispatched: true },
    { id: 'openTrackingWizard', label: 'Open Tracking Wizard', category: 'Editing', binding: 'Mod+Shift+I', editable: true, dispatched: true },
    { id: 'findMatch', label: 'Find match for selection', category: 'Editing', binding: 'f', editable: true, dispatched: true },

    // --- Identity & Tracks (select a group first) ---
    { id: 'assignIdentity', label: 'Assign identity 1–9 to selection', category: 'Identity & Tracks', binding: '1 – 9', editable: false, dispatched: false },
    { id: 'assignTrack', label: 'Assign track 1–9 (propagates)', category: 'Identity & Tracks', binding: 'Shift+1 – 9', editable: false, dispatched: false },

    // --- View ---
    { id: 'toggleInfoPanel', label: 'Toggle info panel', category: 'View', binding: 'i', editable: true, dispatched: true },
    { id: 'toggle3D', label: 'Toggle 3D viewport', category: 'View', binding: '\\', editable: true, dispatched: true },
    { id: 'toggleTimeline', label: 'Collapse / show timeline', category: 'View', binding: 'Mod+J', editable: false, dispatched: false },
    { id: 'cycleViewMode', label: 'Cycle single-view mode', category: 'View', binding: 'v', editable: true, dispatched: true },
    { id: 'gridMode', label: 'Grid view', category: 'View', binding: 'g', editable: true, dispatched: true },
    { id: 'zoomIn', label: 'Zoom in videos', category: 'View', binding: '+ / =', editable: false, dispatched: false },
    { id: 'zoomOut', label: 'Zoom out videos', category: 'View', binding: '− / _', editable: false, dispatched: false },
    { id: 'zoomReset', label: 'Reset video zoom', category: 'View', binding: '0', editable: false, dispatched: false },
    { id: 'rotateVideo', label: 'Rotate active video (hold)', category: 'View', binding: 'Shift+R + ← / →', editable: false, dispatched: false },
    { id: 'toggleUser', label: 'Toggle User keypoints', category: 'View', binding: 'u', editable: true, dispatched: true },
    { id: 'togglePredicted', label: 'Toggle Predicted keypoints', category: 'View', binding: 'p', editable: true, dispatched: true },
    { id: 'toggleReproj', label: 'Toggle Reprojections', category: 'View', binding: 'r', editable: true, dispatched: true },
    { id: 'toggleErrors', label: 'Toggle Errors', category: 'View', binding: 'e', editable: true, dispatched: true },

    // --- Help ---
    { id: 'showHotkeys', label: 'Show keyboard shortcuts help', category: 'Help', binding: '?', editable: true, dispatched: true },
];

const _byId = new Map();
ACTION_CATALOG.forEach(function (a) { _byId.set(a.id, a); });

// Runtime handlers for dispatched actions, attached by the owning UI module.
const _handlers = new Map();

let _settings = loadSettings();

function loadSettings() {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            return {
                triangulationMethod: parsed.triangulationMethod === 'ba' ? 'ba' : 'dlt',
                keybindings: (parsed.keybindings && typeof parsed.keybindings === 'object') ? parsed.keybindings : {},
                nodeWeights: (parsed.nodeWeights && typeof parsed.nodeWeights === 'object') ? parsed.nodeWeights : {},
                trackingThresholds: (parsed.trackingThresholds && typeof parsed.trackingThresholds === 'object') ? parsed.trackingThresholds : {},
            };
        }
    } catch (e) { /* corrupt/blocked storage — fall back to defaults */ }
    return { triangulationMethod: DEFAULTS.triangulationMethod, keybindings: {}, nodeWeights: {}, trackingThresholds: {} };
}

function persist() {
    try { localStorage.setItem(STORAGE_KEY, JSON.stringify(_settings)); } catch (e) { /* ignore */ }
}

// --- Default triangulation method -----------------------------------------

export function getDefaultTriangulationMethod() {
    return _settings.triangulationMethod === 'ba' ? 'ba' : 'dlt';
}

export function setDefaultTriangulationMethod(method) {
    _settings.triangulationMethod = method === 'ba' ? 'ba' : 'dlt';
    persist();
}

// --- Node weights ----------------------------------------------------------

// Clamp an arbitrary value to a valid weight in [0, 1], or null if not a number.
function clampWeight(v) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return null;
    if (n < 0) return 0;
    if (n > 1) return 1;
    return n;
}

// Effective weight for a single node name (stored override, else default 1).
export function getNodeWeight(name) {
    var w = clampWeight(_settings.nodeWeights[name]);
    return w == null ? DEFAULT_NODE_WEIGHT : w;
}

// Snapshot of all stored node-weight overrides (name → weight). Nodes without an
// override are absent (they default to DEFAULT_NODE_WEIGHT).
export function getNodeWeights() {
    var out = {};
    Object.keys(_settings.nodeWeights).forEach(function (k) {
        var w = clampWeight(_settings.nodeWeights[k]);
        if (w != null) out[k] = w;
    });
    return out;
}

// Resolve a parallel weight array for an ordered list of node names — the form
// the tracker consumes (indexed to match Instance.points). Unknown/invalid
// entries fall back to DEFAULT_NODE_WEIGHT. Returns null for a non-array input.
export function getNodeWeightArray(nodeNames) {
    if (!Array.isArray(nodeNames)) return null;
    return nodeNames.map(function (n) { return getNodeWeight(n); });
}

// Commit a name → weight override map (from the Tracking Wizard's Apply button).
// Values are clamped to [0, 1]; entries equal to the default are dropped so the
// stored set stays minimal.
export function setNodeWeights(map) {
    var next = {};
    if (map && typeof map === 'object') {
        Object.keys(map).forEach(function (name) {
            var w = clampWeight(map[name]);
            if (w != null && w !== DEFAULT_NODE_WEIGHT) next[name] = w;
        });
    }
    _settings.nodeWeights = next;
    persist();
}

// --- Tracking thresholds ---------------------------------------------------

// Catalog of user-editable cross-view-tracker thresholds (Tier A scoring knobs +
// Tier B reprojection gates). Each entry is the single source of truth for the
// Tracking Wizard's "Tracking Thresholds" section AND the default the tracker
// falls back to. `min`/`max`/`step` drive the number field; `desc` is the inline
// explanation shown under the label.
const TRACKING_THRESHOLDS = [
    {
        id: 'epipolarDecay', label: 'Epipolar error decay', default: 10,
        min: 0.1, max: 1000, step: 0.1,
        desc: 'Scale in the epipolar match score exp(−mean epipolar error / value). Larger values are more tolerant of epipolar misalignment when deciding two views show the same animal.',
    },
    {
        id: 'reprojSigma', label: 'Reprojection tolerance σ (px)', default: 20,
        min: 0.1, max: 1000, step: 0.5,
        desc: 'Keypoint reprojection spread (pixels) for the OKS consistency score; residuals beyond roughly this many pixels are penalized sharply. Raise it to accept noisier detections.',
    },
    {
        id: 'epipolarWeight', label: 'Epipolar score weight', default: 0.4,
        min: 0, max: 1, step: 0.01,
        desc: 'Weight of the epipolar score in the combined cross-view match score. Paired with the reprojection weight (the two defaults sum to 1).',
    },
    {
        id: 'reprojWeight', label: 'Reprojection score weight', default: 0.6,
        min: 0, max: 1, step: 0.01,
        desc: 'Weight of the reprojection (OKS) score in the combined cross-view match score. Paired with the epipolar weight (the two defaults sum to 1).',
    },
    {
        id: 'minMatchScore', label: 'Minimum match score', default: 0.05,
        min: 0, max: 1, step: 0.01,
        desc: 'In auto (unconstrained) mode, candidate cross-view matches scoring below this are discarded. Raise for fewer, higher-confidence matches; lower to keep marginal ones.',
    },
    {
        id: 'prevIdentityBonus', label: 'Previous-identity bonus', default: 0.3,
        min: 0, max: 5, step: 0.05,
        desc: 'Score bonus when two instances shared the same identity in the previous frame, rewarding temporal continuity. Larger values make identities stickier across frames.',
    },
    {
        id: 'reprojGate2', label: 'Reprojection gate — 2 views (px)', default: 100,
        min: 1, max: 2000, step: 1,
        desc: 'Maximum reprojection distance (px) to attach an instance to a 2-view group. Kept tight because a 2-view triangulation seed is fragile.',
    },
    {
        id: 'reprojGate3', label: 'Reprojection gate — 3 views (px)', default: 140,
        min: 1, max: 2000, step: 1,
        desc: 'Maximum reprojection distance (px) to attach an instance to a 3-view group. Looser than the 2-view gate once a third view stabilizes the 3D estimate.',
    },
    {
        id: 'reprojGate4', label: 'Reprojection gate — 4+ views (px)', default: 180,
        min: 1, max: 2000, step: 1,
        desc: 'Maximum reprojection distance (px) to attach an instance to a group of 4 or more views, where the triangulated 3D point is well constrained.',
    },
];

const _thrById = new Map();
TRACKING_THRESHOLDS.forEach(function (t) { _thrById.set(t.id, t); });

// Clamp a value to a threshold's [min, max] range, or null if not a number.
function clampThreshold(def, v) {
    var n = typeof v === 'number' ? v : parseFloat(v);
    if (!isFinite(n)) return null;
    if (n < def.min) return def.min;
    if (n > def.max) return def.max;
    return n;
}

// Catalog snapshot for the Tracking Wizard: [{ id, label, default, value, min,
// max, step, desc }] with the effective value resolved (override or default).
export function getTrackingThresholdDefs() {
    return TRACKING_THRESHOLDS.map(function (t) {
        return {
            id: t.id, label: t.label, default: t.default,
            value: getTrackingThreshold(t.id),
            min: t.min, max: t.max, step: t.step, desc: t.desc,
        };
    });
}

// Effective value for one threshold (stored override clamped to range, else the
// catalog default).
export function getTrackingThreshold(id) {
    var def = _thrById.get(id);
    if (!def) return null;
    var v = clampThreshold(def, _settings.trackingThresholds[id]);
    return v == null ? def.default : v;
}

// Effective values for every threshold, as an { id: value } map — the form the
// tracker reads once per run.
export function getTrackingThresholds() {
    var out = {};
    TRACKING_THRESHOLDS.forEach(function (t) { out[t.id] = getTrackingThreshold(t.id); });
    return out;
}

// Commit an { id: value } override map (from the Tracking Wizard's Apply button).
// Values are clamped to each threshold's range; entries equal to the default are
// dropped so the stored set stays minimal.
export function setTrackingThresholds(map) {
    var next = {};
    if (map && typeof map === 'object') {
        Object.keys(map).forEach(function (id) {
            var def = _thrById.get(id);
            if (!def) return;
            var v = clampThreshold(def, map[id]);
            if (v != null && v !== def.default) next[id] = v;
        });
    }
    _settings.trackingThresholds = next;
    persist();
}

// --- Keyboard catalog ------------------------------------------------------

// Effective binding string for an action (user override if present, else the
// catalog default).
export function getBinding(id) {
    if (Object.prototype.hasOwnProperty.call(_settings.keybindings, id)) {
        return _settings.keybindings[id];
    }
    const a = _byId.get(id);
    return a ? a.binding : null;
}

// Snapshot of the full catalog for the Settings modal, in catalog order, with
// the effective binding resolved: [{ id, label, category, binding, defaultBinding,
// editable, dispatched }].
export function getActions() {
    return ACTION_CATALOG.map(function (a) {
        return {
            id: a.id,
            label: a.label,
            category: a.category,
            binding: getBinding(a.id),
            defaultBinding: a.binding,
            editable: !!a.editable,
            dispatched: !!a.dispatched,
        };
    });
}

// Attach the runtime handler for a dispatched action (called by the owning UI
// module once at setup).
export function setHandler(id, fn) {
    _handlers.set(id, fn);
}

// Parse an accelerator string into a structured matcher, or null if it is a
// free-form display string (which is never matched live).
function parseBinding(str) {
    if (!str || typeof str !== 'string') return null;
    const parts = str.split('+').map(function (s) { return s.trim(); }).filter(Boolean);
    if (!parts.length) return null;
    const b = { mod: false, ctrl: false, meta: false, shift: false, alt: false, key: null };
    for (let i = 0; i < parts.length; i++) {
        const low = parts[i].toLowerCase();
        if (low === 'mod') b.mod = true;
        else if (low === 'ctrl' || low === 'control') b.ctrl = true;
        else if (low === 'cmd' || low === 'meta' || low === 'command') b.meta = true;
        else if (low === 'shift') b.shift = true;
        else if (low === 'alt' || low === 'option' || low === 'opt') b.alt = true;
        else b.key = parts[i];
    }
    return b.key ? b : null;
}

// Parse a binding string into a SEQUENCE of chord matchers (chords separated by
// whitespace; e.g. "g t" is press-g-then-t, "Mod+Shift+I" is one chord). Returns
// null if any chord is malformed.
function parseSequence(str) {
    if (!str || typeof str !== 'string') return null;
    const chords = str.trim().split(/\s+/).filter(Boolean);
    if (!chords.length) return null;
    const out = [];
    for (let i = 0; i < chords.length; i++) {
        const b = parseBinding(chords[i]);
        if (!b) return null;
        out.push(b);
    }
    return out;
}

// True if a single chord matcher `b` matches a keyboard-event-like `e`
// (`{ key, ctrlKey, metaKey, shiftKey, altKey }`).
function matchChord(b, e) {
    if (!b || !e) return false;
    // Ctrl / Cmd.
    if (b.mod) {
        if (!(e.ctrlKey || e.metaKey)) return false;
    } else {
        if (b.ctrl !== !!e.ctrlKey) return false;
        if (b.meta !== !!e.metaKey) return false;
    }
    // Alt / Option.
    if (b.alt !== !!e.altKey) return false;

    const isAlpha = /^[a-z]$/i.test(b.key);
    // Shift. For a bare letter, shift must NOT be held (Shift+u is a different
    // binding). For a symbol key whose character already implies shift, the shift
    // flag is ignored unless explicitly required.
    if (b.shift) {
        if (!e.shiftKey) return false;
    } else if (isAlpha) {
        if (e.shiftKey) return false;
    }

    const ek = e.key || '';
    return isAlpha ? ek.toLowerCase() === b.key.toLowerCase() : ek === b.key;
}

// True if KeyboardEvent `e` triggers the action `id` under its effective binding.
// Only meaningful for dispatched actions whose binding is a single chord (the
// form used by external owners like timeline-controller).
export function matchesBinding(id, e) {
    const a = _byId.get(id);
    if (!a || !a.dispatched || !e) return false;
    const seq = parseSequence(getBinding(id));
    if (!seq || seq.length !== 1) return false;
    return matchChord(seq[0], e);
}

// Names of keys that are modifiers on their own — ignored as sequence steps so a
// chord like "Shift+T" isn't recorded as two presses.
function isModifierKey(k) {
    return k === 'Shift' || k === 'Control' || k === 'Meta' ||
        k === 'Alt' || k === 'AltGraph' || k === 'CapsLock';
}

// Rolling buffer of recent non-modifier keystrokes, for multi-key sequence
// matching. Reset when too much time elapses between keys.
let _seqBuf = [];
const _SEQ_GAP_MS = 1200;

function _now() {
    return (typeof performance !== 'undefined' && performance.now) ? performance.now() : Date.now();
}

// Resolve a KeyboardEvent to a dispatched action and run its handler, supporting
// multi-key sequence bindings. Skips when typing in an input. Returns true if an
// action handled the event (single-chord bindings fire immediately).
export function dispatchEvent(e) {
    if (!e) return false;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
    if (isModifierKey(e.key)) return false; // wait for the real key in a chord

    const now = _now();
    if (_seqBuf.length && (now - _seqBuf[_seqBuf.length - 1].t) > _SEQ_GAP_MS) _seqBuf = [];
    _seqBuf.push({ key: e.key, ctrlKey: e.ctrlKey, metaKey: e.metaKey, shiftKey: e.shiftKey, altKey: e.altKey, t: now });
    if (_seqBuf.length > 8) _seqBuf = _seqBuf.slice(-8);

    // Pick the longest sequence whose chords match the tail of the buffer; ties
    // resolve to catalog order (first wins), matching the old single-chord rule.
    let best = null, bestLen = 0;
    for (let i = 0; i < ACTION_CATALOG.length; i++) {
        const a = ACTION_CATALOG[i];
        if (!a.dispatched || !_handlers.has(a.id)) continue;
        const seq = parseSequence(getBinding(a.id));
        if (!seq || seq.length > _seqBuf.length) continue;
        let ok = true;
        const off = _seqBuf.length - seq.length;
        for (let j = 0; j < seq.length; j++) {
            if (!matchChord(seq[j], _seqBuf[off + j])) { ok = false; break; }
        }
        if (ok && seq.length > bestLen) { best = a; bestLen = seq.length; }
    }
    if (best) {
        _seqBuf = [];
        _handlers.get(best.id)();
        return true;
    }
    return false;
}

// Commit an id->binding override map (from the Settings modal's Apply button).
// Only editable actions are accepted; bindings equal to the catalog default are
// dropped so the stored set stays minimal.
export function applyBindings(map) {
    const next = {};
    Object.keys(map).forEach(function (id) {
        const a = _byId.get(id);
        const v = map[id];
        // Only keep editable actions whose binding is a valid, non-default,
        // parseable chord/sequence string.
        if (a && a.editable && v && v !== a.binding && parseSequence(v)) next[id] = v;
    });
    _settings.keybindings = next;
    persist();
}

export function resetBindings() {
    _settings.keybindings = {};
    persist();
}

// True when running on a macOS / iOS device, so the Ctrl-or-Cmd `Mod` token is
// shown as "Cmd" rather than "Ctrl". Falls back to "Ctrl" off-browser (Node).
function isAppleDevice() {
    if (typeof navigator === 'undefined') return false;
    var plat = navigator.platform ||
        (navigator.userAgentData && navigator.userAgentData.platform) ||
        navigator.userAgent || '';
    return /Mac|iPhone|iPad|iPod/i.test(plat);
}

// Prettify a binding string for display: render the platform-appropriate
// modifier for the `Mod` token (Cmd on Apple devices, Ctrl elsewhere), uppercase
// a bare single letter, and join multi-key sequences with a space. Free-form
// reference strings (e.g. "← / →", "1 – 9") pass through unchanged because the
// per-token formatting is idempotent on them.
export function formatBinding(str) {
    if (!str) return '';
    var mod = isAppleDevice() ? 'Cmd' : 'Ctrl';
    return String(str).trim().split(/\s+/).map(function (chord) {
        var c = chord.replace(/\bmod\b/gi, mod);
        if (/^[a-z]$/.test(c)) return c.toUpperCase();
        // Uppercase the trailing single-letter key of a simple accelerator.
        return c.replace(/\+([a-z])$/, function (_m, ch) { return '+' + ch.toUpperCase(); });
    }).join(' ');
}
