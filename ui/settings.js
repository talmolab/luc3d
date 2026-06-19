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

// Catalog of every shortcut. `binding` is a "+"-joined accelerator string for
// dispatched entries (modifier tokens: Mod = Ctrl-or-Cmd, Ctrl, Cmd/Meta, Shift,
// Alt/Option/Opt; last token is the key), or a free-form display string for
// fixed reference entries (e.g. "← / →", "1 – 9").
const ACTION_CATALOG = [
    // --- File ---
    { id: 'save', label: 'Save project', category: 'File', binding: 'Mod+S', editable: false, dispatched: false },
    { id: 'loadSession', label: 'Load single session folder', category: 'File', binding: 'Mod+O', editable: false, dispatched: false },
    { id: 'openSettings', label: 'Open Settings', category: 'File', binding: 'Mod+,', editable: false, dispatched: false },

    // --- Navigation ---
    { id: 'prevNextFrame', label: 'Previous / Next frame', category: 'Navigation', binding: '← / →', editable: false, dispatched: false },
    { id: 'labeledFrame', label: 'Prev / Next user-labeled frame', category: 'Navigation', binding: 'Opt+← / Opt+→', editable: false, dispatched: false },
    { id: 'firstLastFrame', label: 'First / Last frame', category: 'Navigation', binding: 'Home / End', editable: false, dispatched: false },
    { id: 'playPause', label: 'Play / Pause', category: 'Navigation', binding: 'Space', editable: false, dispatched: false },
    { id: 'gotoFrame', label: 'Go to frame number', category: 'Navigation', binding: 'Mod+Shift+J', editable: false, dispatched: false },

    // --- Editing ---
    { id: 'addInstanceSmart', label: 'Add instance (smart init)', category: 'Editing', binding: 'Mod+I', editable: false, dispatched: false },
    { id: 'addInstance', label: 'Add instance', category: 'Editing', binding: 'n', editable: true, dispatched: true },
    { id: 'deleteInstance', label: 'Delete selected (Shift: cascade)', category: 'Editing', binding: 'Delete', editable: false, dispatched: false },
    { id: 'ungroup', label: 'Ungroup selected', category: 'Editing', binding: 'Shift+u', editable: false, dispatched: true },
    { id: 'group', label: 'Group selected (assignment mode)', category: 'Editing', binding: 'c', editable: false, dispatched: false },
    { id: 'triangulate', label: 'Triangulate current frame', category: 'Editing', binding: 't', editable: true, dispatched: true },
    { id: 'trackFrame', label: 'Track current frame', category: 'Editing', binding: 'Shift+T', editable: false, dispatched: false },
    { id: 'trackAll', label: 'Track all frames', category: 'Editing', binding: 'Mod+Shift+T', editable: false, dispatched: false },
    { id: 'findMatch', label: 'Find match for selection', category: 'Editing', binding: 'f', editable: false, dispatched: false },

    // --- Identity & Tracks (select a group first) ---
    { id: 'assignIdentity', label: 'Assign identity 1–9 to selection', category: 'Identity & Tracks', binding: '1 – 9', editable: false, dispatched: false },
    { id: 'assignTrack', label: 'Assign track 1–9 (propagates)', category: 'Identity & Tracks', binding: 'Shift+1 – 9', editable: false, dispatched: false },

    // --- View ---
    { id: 'toggleInfoPanel', label: 'Toggle info panel', category: 'View', binding: 'i', editable: false, dispatched: false },
    { id: 'toggle3D', label: 'Toggle 3D viewport', category: 'View', binding: '\\', editable: false, dispatched: false },
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
            };
        }
    } catch (e) { /* corrupt/blocked storage — fall back to defaults */ }
    return { triangulationMethod: DEFAULTS.triangulationMethod, keybindings: {} };
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

// True if KeyboardEvent `e` triggers the action `id` under its effective
// binding. Only meaningful for dispatched actions with a well-formed binding.
export function matchesBinding(id, e) {
    const a = _byId.get(id);
    if (!a || !a.dispatched || !e) return false;
    const b = parseBinding(getBinding(id));
    if (!b) return false;

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
    // binding). For a symbol key (e.g. "?") whose character already implies
    // shift, the shift flag is ignored unless explicitly required.
    if (b.shift) {
        if (!e.shiftKey) return false;
    } else if (isAlpha) {
        if (e.shiftKey) return false;
    }

    const ek = e.key || '';
    return isAlpha ? ek.toLowerCase() === b.key.toLowerCase() : ek === b.key;
}

// Resolve a KeyboardEvent to a dispatched action and run its handler. Skips when
// typing in an input. Returns true if an action handled the event.
export function dispatchEvent(e) {
    if (!e) return false;
    const t = e.target;
    if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return false;
    for (let i = 0; i < ACTION_CATALOG.length; i++) {
        const a = ACTION_CATALOG[i];
        if (a.dispatched && _handlers.has(a.id) && matchesBinding(a.id, e)) {
            _handlers.get(a.id)();
            return true;
        }
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
        if (a && a.editable && v && v !== a.binding) next[id] = v;
    });
    _settings.keybindings = next;
    persist();
}

export function resetBindings() {
    _settings.keybindings = {};
    persist();
}

// Prettify a binding string for display (uppercases a bare single letter,
// leaves accelerators and free-form strings intact).
export function formatBinding(str) {
    if (!str) return '';
    if (/^[a-z]$/.test(str)) return str.toUpperCase();
    // Uppercase the trailing single-letter key of a simple accelerator.
    return str.replace(/\+([a-z])$/, function (_m, c) { return '+' + c.toUpperCase(); });
}
