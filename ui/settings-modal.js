// ui/settings-modal.js
// Builds and shows the LUCID "Settings" modal.
//
// The modal has four panels (selected via a left nav): the default
// triangulation method, an editable list of keyboard shortcuts, the Tracking
// Wizard, and Temporal Smoothing (the post-triangulation 3D filter's
// hyperparameters, luc3d #134). All edits are kept in a local working
// state object and the visual DOM only — nothing is committed to settings.js
// until the user clicks Apply. Apply keeps the modal open and its button reads
// "Applied ✓" until the next edit. Cancel / × / backdrop / Escape discard what
// has not been applied; with nothing pending, Cancel reads "Close".
//
// Styling lives in a separate CSS file; this module only assigns the agreed
// class names. Only one modal instance may exist at a time.
//
// The card is resizable (CSS `resize: both`) and draggable by its header, and
// remembers where it was left — see `ui/modal-geometry.js`. That matters most
// for the Tracking Wizard, whose node/camera tables are as long as the skeleton
// is; widening the modal reflows them into more columns instead of making the
// user scroll.
//
// ## No scroll-within-scroll
//
// `.settings-panel-container` is the ONE scroller in the card. The node and
// camera tables used to be height-capped boxes with their own `overflow-y`,
// which put a scrollbar inside a scrollbar: the wheel did different things a
// few pixels apart, and rows below the cap were invisible with no hint that the
// modal could simply be made taller. They now grow to their full height inside
// a collapsible section, so the panel scrolls and nothing else does.

import {
    getDefaultTriangulationMethod,
    setDefaultTriangulationMethod,
    getActions,
    applyBindings,
    formatBinding,
    getNodeWeight,
    setNodeWeights,
    getCameraWeight,
    setCameraWeights,
    getTrackingThresholdDefs,
    setTrackingThresholds,
    getSmoothingParamDefs,
    setSmoothingParams,
} from './settings.js';
import { getActiveSession, state, timeline } from './app-state.js';
import { drawAllOverlays } from './rendering.js';
import { buildTriangulationMethodsFigure } from './triangulation-methods-figure.js';
import { buildSmoothingWindowsFigure } from './smoothing-windows-figure.js';
import { buildThresholdExamples } from './threshold-examples-panel.js';
import { installModalGeometry } from './modal-geometry.js';
import { refreshIdSwitchHighlight } from './id-switch-highlight.js';
import { buildDetectionFilterPreview } from './detection-filter-preview.js';
import { NODE_WEIGHT_TIP } from './track-setup-modal.js';

// True when the running device is macOS/iOS, so the primary Ctrl-or-Cmd modifier
// is recorded as the cross-platform `Mod` token (matching the catalog defaults).
function _isAppleDevice() {
    if (typeof navigator === 'undefined') return false;
    var plat = navigator.platform ||
        (navigator.userAgentData && navigator.userAgentData.platform) ||
        navigator.userAgent || '';
    return /Mac|iPhone|iPad|iPod/i.test(plat);
}

// Keys that are modifiers on their own — ignored as a sequence step.
function isModifierKeyName(k) {
    return k === 'Shift' || k === 'Control' || k === 'Meta' ||
        k === 'Alt' || k === 'AltGraph' || k === 'CapsLock';
}

// Build a canonical chord string (e.g. "Mod+Shift+I") from a KeyboardEvent. The
// platform-primary modifier becomes `Mod` so captured bindings match catalog
// defaults and conflict-detect cleanly.
function chordFromEvent(e) {
    const apple = _isAppleDevice();
    const parts = [];
    if (apple) {
        if (e.metaKey) parts.push('Mod'); else if (e.ctrlKey) parts.push('Ctrl');
    } else {
        if (e.ctrlKey) parts.push('Mod'); else if (e.metaKey) parts.push('Cmd');
    }
    if (e.altKey) parts.push('Alt');
    if (e.shiftKey) parts.push('Shift');
    parts.push(e.key);
    return parts.join('+');
}

/**
 * An on/off switch (the app's standard .toggle-switch) for a 0/1 setting.
 *
 * @param {boolean} checked
 * @param {string} ariaLabel
 * @param {function(boolean): void} onChange
 * @returns {HTMLElement}
 */
function makeToggle(checked, ariaLabel, onChange) {
    const sw = document.createElement('label');
    sw.className = 'toggle-switch settings-toggle';
    const box = document.createElement('input');
    box.type = 'checkbox';
    box.checked = !!checked;
    box.setAttribute('role', 'switch');
    box.setAttribute('aria-label', ariaLabel);
    box.addEventListener('change', function () { onChange(box.checked); });
    const slider = document.createElement('span');
    slider.className = 'slider';
    sw.appendChild(box);
    sw.appendChild(slider);
    return sw;
}

/**
 * A labelled row for one catalog parameter, bound to a working map.
 *
 * Shared by the Tracking Wizard's thresholds and the Temporal Smoothing panel —
 * both render the same `{ id, label, desc, min, max, step }` catalog shape. A
 * `kind: 'toggle'` def gets an on/off switch storing 1 / 0; everything else gets
 * a number field that clamps on blur, so a typed out-of-range value is corrected
 * in place rather than silently at Apply.
 *
 * @param {{id:string,label:string,desc:string,kind?:string,min:number,max:number,step:number}} def
 * @param {Object.<string, number>} bag working map mutated on edit
 * @param {?function(): void} [onEdit] called after each edit of a number field
 * @returns {HTMLElement}
 */
function buildParamRow(def, bag, onEdit) {
    const row = document.createElement('div');
    row.className = 'settings-threshold-row';

    const labelWrap = document.createElement('div');
    labelWrap.className = 'settings-threshold-label-wrap';
    const rowTitle = document.createElement('div');
    rowTitle.className = 'settings-threshold-title';
    rowTitle.textContent = def.label;
    const rowDesc = document.createElement('div');
    rowDesc.className = 'settings-threshold-desc';
    rowDesc.textContent = def.desc;
    labelWrap.appendChild(rowTitle);
    labelWrap.appendChild(rowDesc);

    if (def.kind === 'toggle') {             // on/off settings: a switch, stored as 1 / 0
        row.appendChild(labelWrap);
        row.appendChild(makeToggle(bag[def.id] > 0, def.label, function (on) { bag[def.id] = on ? 1 : 0; }));
        return row;
    }

    const input = document.createElement('input');
    input.type = 'number';
    input.className = 'settings-num-input';
    input.min = String(def.min);
    input.max = String(def.max);
    input.step = String(def.step);
    input.value = String(bag[def.id]);
    input.setAttribute('aria-label', def.label);

    input.addEventListener('input', function () {
        const v = parseFloat(input.value);
        if (isFinite(v)) bag[def.id] = v;
        if (onEdit) onEdit();
    });
    input.addEventListener('blur', function () {
        let v = parseFloat(input.value);
        if (!isFinite(v)) v = bag[def.id];
        if (v < def.min) v = def.min;
        if (v > def.max) v = def.max;
        bag[def.id] = v;
        input.value = String(v);
        if (onEdit) onEdit();
    });

    row.appendChild(labelWrap);
    row.appendChild(input);
    return row;
}

/**
 * A wizard section as a native `<details>`: heading that folds, body inside.
 *
 * `<details>`/`<summary>` rather than a hand-rolled div + click handler so the
 * disclosure is keyboard-operable and screen-reader-labelled for free — and so
 * `ui/keyboard-target.js` already knows a `SUMMARY` owns Space/Enter.
 *
 * @param {string} title
 * @param {number|null} count  shown beside the title when there is a list
 * @returns {{root: HTMLElement, body: HTMLElement}}
 */
function buildSection(title, count) {
    const root = document.createElement('details');
    root.className = 'settings-section';
    root.open = true;

    const summary = document.createElement('summary');
    summary.className = 'settings-section-summary';

    const label = document.createElement('span');
    label.className = 'settings-kbd-category settings-section-title';
    label.textContent = title;
    summary.appendChild(label);

    if (count !== null && count !== undefined) {
        const badge = document.createElement('span');
        badge.className = 'settings-section-count';
        badge.textContent = String(count);
        summary.appendChild(badge);
    }
    root.appendChild(summary);

    const body = document.createElement('div');
    body.className = 'settings-section-body';
    root.appendChild(body);

    return { root: root, body: body };
}

// The panel Settings was last left on, so Help ▸ Settings reopens there.
// Browser-local display taste (`localStorage`), never the `.slp`; storage that
// throws just means the first panel.
const LAST_PANEL_KEY = 'settingsLastPanel';
const SETTINGS_PANELS = ['wizard', 'triangulation', 'smoothing', 'keyboard'];

function readLastPanel() {
    try {
        const v = localStorage.getItem(LAST_PANEL_KEY);
        return SETTINGS_PANELS.indexOf(v) >= 0 ? v : null;
    } catch (e) { return null; }
}

function writeLastPanel(name) {
    try { localStorage.setItem(LAST_PANEL_KEY, name); } catch (e) { /* best effort */ }
}

// Show the Settings modal. `initialPanel` is one of 'wizard' | 'triangulation'
// | 'smoothing' | 'keyboard'; without one (Help ▸ Settings, its shortcut) it
// opens on the panel last shown, else the first, Tracking Wizard.
export function showSettingsModal(initialPanel) {
    const startPanel = SETTINGS_PANELS.indexOf(initialPanel) >= 0
        ? initialPanel
        : (readLastPanel() || SETTINGS_PANELS[0]);

    // Enforce a single instance.
    const existing = document.querySelector('.settings-overlay');
    if (existing) existing.remove();

    // Set once the footer exists: every write to `working` repaints its buttons.
    let onWorkingEdit = function () {};
    const watched = function (obj) {
        return new Proxy(obj, {
            set: function (target, key, value) { target[key] = value; onWorkingEdit(); return true; },
        });
    };

    // --- Working state: all edits mutate this, never settings.js directly. ---
    const working = watched({
        method: getDefaultTriangulationMethod(),
        keyMap: watched({}),
        nodeWeights: watched({}),
        cameraWeights: watched({}),
        thresholds: watched({}),
        smoothing: watched({}),
    });
    const actions = getActions();
    // Only editable actions are user-rebindable; the working map tracks those.
    actions.forEach(function (a) { if (a.editable) working.keyMap[a.id] = a.binding; });

    const activeSession = getActiveSession();

    // Seed the working node-weight map from the active session's skeleton, if any.
    // Keyed by node name; values are the current effective weight (default 1).
    const skeletonNodes = (activeSession && activeSession.skeleton && Array.isArray(activeSession.skeleton.nodes))
        ? activeSession.skeleton.nodes.slice()
        : [];
    skeletonNodes.forEach(function (name) { working.nodeWeights[name] = getNodeWeight(name); });

    // Seed the working camera-inclusion map from the active session's cameras, if
    // any. Keyed by camera name; values are 0 (excluded from tracking) or 1
    // (included, the default).
    const cameraNames = (activeSession && Array.isArray(activeSession.cameras))
        ? activeSession.cameras.map(function (c) { return c.name; })
        : [];
    cameraNames.forEach(function (name) { working.cameraWeights[name] = getCameraWeight(name); });

    // Seed the working tracking-threshold map from the catalog's effective values.
    const thresholdDefs = getTrackingThresholdDefs();
    thresholdDefs.forEach(function (def) { working.thresholds[def.id] = def.value; });

    // Seed the working temporal-smoothing map the same way (luc3d #134).
    const smoothingDefs = getSmoothingParamDefs();
    smoothingDefs.forEach(function (def) { working.smoothing[def.id] = def.value; });

    // What the detection filters would remove at the values being typed, per
    // camera (ui/detection-filter-preview.js). Counts the session in the
    // background after the modal is up; each edit only re-counts.
    const filterPreview = buildDetectionFilterPreview({
        session: activeSession,
        getValues: function () {
            return {
                minVisibleNodes: working.thresholds.filterMinVisibleNodes,
                minInstanceScore: working.thresholds.filterMinInstanceScore,
                minMeanNodeScore: working.thresholds.filterMinMeanNodeScore,
            };
        },
        isCameraIncluded: function (name) { return working.cameraWeights[name] !== 0; },
    });

    // --- Build DOM --------------------------------------------------------
    const overlay = document.createElement('div');
    overlay.className = 'settings-overlay';

    const card = document.createElement('div');
    card.className = 'settings-modal';
    overlay.appendChild(card);

    // Header.
    const header = document.createElement('div');
    header.className = 'settings-modal-header';
    const title = document.createElement('div');
    title.className = 'settings-modal-title';
    title.textContent = 'Settings';
    const closeBtn = document.createElement('button');
    closeBtn.type = 'button';
    closeBtn.className = 'settings-modal-close';
    closeBtn.textContent = '×';
    closeBtn.setAttribute('aria-label', 'Close Settings');
    closeBtn.title = 'Close Settings';
    header.appendChild(title);
    header.appendChild(closeBtn);
    card.appendChild(header);

    // Body: nav + panel container.
    const body = document.createElement('div');
    body.className = 'settings-modal-body';
    card.appendChild(body);

    const nav = document.createElement('div');
    nav.className = 'settings-nav';
    body.appendChild(nav);

    const panelContainer = document.createElement('div');
    panelContainer.className = 'settings-panel-container';
    body.appendChild(panelContainer);

    // In the order they are used, as on the toolbar (Track, Triangulate,
    // Smooth); Keyboard Shortcuts is not a step, so it goes last.
    const NAV_ITEMS = [
        { panel: 'wizard', label: 'Tracking Wizard' },
        { panel: 'triangulation', label: 'Default Triangulation' },
        { panel: 'smoothing', label: 'Temporal Smoothing' },
        { panel: 'keyboard', label: 'Keyboard Shortcuts' },
    ];

    const navItems = {};
    NAV_ITEMS.forEach(function (item) {
        const el = document.createElement('div');
        el.className = 'settings-nav-item';
        el.dataset.panel = item.panel;
        el.textContent = item.label;
        nav.appendChild(el);
        navItems[item.panel] = el;
    });

    // --- Panels -----------------------------------------------------------
    const panels = {};

    // 1) Triangulation panel.
    const triPanel = document.createElement('div');
    triPanel.className = 'settings-panel';
    triPanel.dataset.panel = 'triangulation';
    const triTitle = document.createElement('div');
    triTitle.className = 'settings-panel-title';
    triTitle.textContent = 'Default Triangulation';
    triPanel.appendChild(triTitle);

    // The two methods are chosen by clicking their diagram cards
    // (`ui/triangulation-methods-figure.js`), not separate rows. Its third card
    // shows the Tracking Wizard's reprojection error threshold. Its slider only
    // redraws the sketch; its Use and Turn off buttons set the same working value
    // and the wizard's field.
    const reprojThresholdDef = thresholdDefs.find(function (d) { return d.id === 'reprojErrorThreshold'; });
    const thrExamples = buildThresholdExamples({
        session: activeSession,
        isCameraIncluded: function (name) { return working.cameraWeights[name] !== 0; },
    });
    const triFigure = buildTriangulationMethodsFigure({
        examples: thrExamples,
        onThreshold: function (value) {
            working.thresholds.reprojErrorThreshold = value;
            const field = reprojThresholdDef && panelContainer.querySelector(
                '.settings-panel[data-panel="wizard"] input[aria-label="' + reprojThresholdDef.label + '"]');
            if (field) field.value = String(value);
        },
    });
    const methodCards = Array.from(triFigure.el.querySelectorAll('.tri-method-choice'));
    function pickMethod(method) {
        working.method = method;
        methodCards.forEach(function (c) {
            const on = c.dataset.method === method;
            c.classList.toggle('checked', on);
            c.setAttribute('aria-checked', on ? 'true' : 'false');
        });
        triFigure.update({ method: method });
    }
    // Enter/Space on a focused card is handled in `onDocKeyDown`: it stops
    // every keydown in the capture phase, so a listener on the card never runs.
    methodCards.forEach(function (c) {
        c.addEventListener('click', function () { pickMethod(c.dataset.method); });
    });
    triFigure.update({ threshold: working.thresholds.reprojErrorThreshold, saved: working.thresholds.reprojErrorThreshold });
    pickMethod(working.method);
    triPanel.appendChild(triFigure.el);

    // Docs link for additional information on triangulation methods.
    const triDocsNote = document.createElement('div');
    triDocsNote.className = 'settings-kbd-hint settings-docs-note';
    const triDocsLink = document.createElement('a');
    triDocsLink.href = 'https://talmolab.github.io/luc3d-docs/how-it-works/triangulation/';
    triDocsLink.target = '_blank';
    triDocsLink.rel = 'noopener';
    triDocsLink.textContent = 'Triangulation Docs';
    triDocsNote.appendChild(triDocsLink);
    triPanel.appendChild(triDocsNote);

    panelContainer.appendChild(triPanel);
    panels.triangulation = triPanel;

    // 2) Keyboard panel.
    const kbdPanel = document.createElement('div');
    kbdPanel.className = 'settings-panel';
    kbdPanel.dataset.panel = 'keyboard';
    const kbdTitle = document.createElement('div');
    kbdTitle.className = 'settings-panel-title';
    kbdTitle.textContent = 'Keyboard Shortcuts';
    kbdPanel.appendChild(kbdTitle);

    // Tracks an in-progress capture so Escape-to-close knows to defer.
    let capturingState = null;

    // The currently-shown key for any action: the working override for editable
    // actions, else the catalog binding. Used for conflict detection.
    function currentBindingOf(action) {
        return action.editable ? working.keyMap[action.id] : action.binding;
    }

    // Render rows grouped by category, with a subheader per category.
    let lastCategory = null;
    actions.forEach(function (action) {
        if (action.category !== lastCategory) {
            lastCategory = action.category;
            const cat = document.createElement('div');
            cat.className = 'settings-kbd-category';
            cat.textContent = action.category;
            kbdPanel.appendChild(cat);
        }

        const row = document.createElement('div');
        row.className = 'settings-kbd-row';

        const label = document.createElement('div');
        label.className = 'settings-kbd-label';
        label.textContent = action.label;

        const keyChip = document.createElement('div');
        keyChip.className = 'settings-kbd-key';
        keyChip.dataset.actionId = action.id;
        keyChip.textContent = formatBinding(currentBindingOf(action));

        if (!action.editable) {
            // Fixed reference entry: shown but not rebindable here.
            keyChip.classList.add('fixed');
            keyChip.title = 'This shortcut is fixed';
        } else {
            keyChip.title = 'Click, then press keys (a chord or a multi-key sequence). Click anywhere to set; Esc cancels.';
            keyChip.addEventListener('click', function () {
                // Ignore re-entry if already capturing this (or another) chip.
                if (capturingState) return;

                const previousText = keyChip.textContent;
                const previousBinding = working.keyMap[action.id];
                let seq = [];
                keyChip.classList.add('capturing');
                keyChip.textContent = 'Press keys…';

                function render() {
                    keyChip.textContent = seq.length ? formatBinding(seq.join(' ')) : 'Press keys…';
                }

                function cleanup() {
                    document.removeEventListener('keydown', onKeyDown, true);
                    document.removeEventListener('mousedown', onStop, true);
                    capturingState = null;
                    keyChip.classList.remove('capturing');
                }

                function cancel() {
                    cleanup();
                    keyChip.textContent = previousText;
                }

                function finalize() {
                    cleanup();
                    if (!seq.length) { keyChip.textContent = previousText; return; }
                    const binding = seq.join(' ');
                    // Conflict: reject a binding already used by another action.
                    let conflict = false;
                    actions.forEach(function (other) {
                        if (other.id === action.id) return;
                        const ob = currentBindingOf(other);
                        if (ob && ob.toLowerCase() === binding.toLowerCase()) conflict = true;
                    });
                    if (conflict) {
                        working.keyMap[action.id] = previousBinding;
                        keyChip.textContent = 'In use';
                        setTimeout(function () { keyChip.textContent = previousText; }, 800);
                        return;
                    }
                    working.keyMap[action.id] = binding;
                    keyChip.textContent = formatBinding(binding);
                }

                function onKeyDown(e) {
                    e.preventDefault();
                    e.stopImmediatePropagation();
                    if (e.key === 'Escape') { cancel(); return; }
                    if (isModifierKeyName(e.key)) return;  // wait for the real key
                    if (e.key === ' ') return;             // space can't be a sequence token
                    seq.push(chordFromEvent(e));
                    render();
                }

                // A click anywhere ends key input and commits the sequence.
                function onStop() { finalize(); }

                capturingState = { chip: keyChip };
                document.addEventListener('keydown', onKeyDown, true);
                // Defer the click-to-stop listener so the click that STARTED
                // capture doesn't immediately finalize it.
                setTimeout(function () {
                    if (capturingState && capturingState.chip === keyChip) {
                        document.addEventListener('mousedown', onStop, true);
                    }
                }, 0);
            });
        }

        row.appendChild(label);
        row.appendChild(keyChip);
        kbdPanel.appendChild(row);
    });

    const kbdHint = document.createElement('div');
    kbdHint.className = 'settings-kbd-hint';
    kbdHint.textContent = 'Click a key, then press a chord or a multi-key sequence (keep typing for a sequence); click anywhere to set, Esc to cancel. Greyed keys are fixed. Changes apply when you click Apply.';
    kbdPanel.appendChild(kbdHint);

    panelContainer.appendChild(kbdPanel);
    panels.keyboard = kbdPanel;

    // 3) Wizard panel.
    const wizPanel = document.createElement('div');
    wizPanel.className = 'settings-panel';
    wizPanel.dataset.panel = 'wizard';
    const wizTitle = document.createElement('div');
    wizTitle.className = 'settings-panel-title';
    wizTitle.textContent = 'Tracking Wizard';
    wizPanel.appendChild(wizTitle);

    // --- Node Weights section --------------------------------------------
    // Each skeleton node gets a 0–1 weight scaling how much it counts in the
    // CrossViewTracker's association cost (2D reprojection + 3D point-to-ray).
    // 1 = full weight, 0 = the node is dropped from matching. Edits mutate
    // working.nodeWeights; committed on Apply.
    const nwSection = buildSection('Node Weights', skeletonNodes.length || null);
    wizPanel.appendChild(nwSection.root);

    const nwHint = document.createElement('div');
    nwHint.className = 'settings-kbd-hint';
    nwHint.style.marginTop = '0';
    nwHint.style.marginBottom = '8px';
    nwHint.textContent = 'Weight of each skeleton node in the cross-view matching cost (0–1). ' +
        '1 = fully considered (2D reprojection + 3D point-to-ray); 0 = ignored during tracking. ' +
        'Changes apply when you click Apply.';
    nwSection.body.appendChild(nwHint);
    if (skeletonNodes.length) {
        const nwTip = document.createElement('div');
        nwTip.className = 'settings-kbd-hint settings-node-weight-tip';
        nwTip.style.marginTop = '0';
        nwTip.style.marginBottom = '8px';
        nwTip.textContent = NODE_WEIGHT_TIP;
        nwSection.body.appendChild(nwTip);
    }

    if (skeletonNodes.length === 0) {
        const nwEmpty = document.createElement('div');
        nwEmpty.className = 'settings-kbd-hint';
        nwEmpty.textContent = 'Load a session with a skeleton to configure node weights.';
        nwSection.body.appendChild(nwEmpty);
    } else {
        // A multi-column table that grows to its full height — no inner
        // scrollbar. Widening the modal reflows it into more columns, which is
        // what makes a long skeleton fit; folding the section away is what
        // keeps the rest of the wizard reachable.
        const nwList = document.createElement('div');
        nwList.className = 'settings-node-weight-list';
        nwSection.body.appendChild(nwList);

        skeletonNodes.forEach(function (name) {
            const row = document.createElement('div');
            row.className = 'settings-node-weight-row';

            const label = document.createElement('div');
            label.className = 'settings-kbd-label';
            label.textContent = name;

            const input = document.createElement('input');
            input.type = 'number';
            input.className = 'settings-num-input';
            input.min = '0';
            input.max = '1';
            input.step = '0.01';
            input.value = String(working.nodeWeights[name]);
            input.setAttribute('aria-label', 'Weight for node ' + name);

            // Grey the row out when the node is dropped (weight 0).
            function reflectDropped() {
                row.classList.toggle('settings-view-excluded', working.nodeWeights[name] === 0);
            }

            // Keep the working map in sync as the user types. Empty/invalid input
            // is tolerated mid-edit; clamping to [0,1] happens on blur and on Apply.
            input.addEventListener('input', function () {
                const v = parseFloat(input.value);
                if (isFinite(v)) working.nodeWeights[name] = v;
                reflectDropped();
            });
            input.addEventListener('blur', function () {
                let v = parseFloat(input.value);
                if (!isFinite(v)) v = working.nodeWeights[name];
                if (v < 0) v = 0;
                if (v > 1) v = 1;
                working.nodeWeights[name] = v;
                input.value = String(v);
                reflectDropped();
            });

            reflectDropped();
            row.appendChild(label);
            row.appendChild(input);
            nwList.appendChild(row);
        });
    }

    // --- Camera Views section --------------------------------------------
    // Each camera view gets an on/off switch (stored as a 0/1 weight) controlling
    // whether it takes part in cross-view tracking: on = included; off = excluded
    // from the association math (the view stays visible/editable in the GUI).
    // Excluded rows are greyed out.
    // Edits mutate working.cameraWeights; committed on Apply.
    const cvSection = buildSection('Camera Views', cameraNames.length || null);
    wizPanel.appendChild(cvSection.root);

    const cvHint = document.createElement('div');
    cvHint.className = 'settings-kbd-hint';
    cvHint.style.marginTop = '0';
    cvHint.style.marginBottom = '8px';
    cvHint.textContent = 'Whether each camera view is used in tracking (on = included, off = excluded). ' +
        'Excluded views are dropped from the association math but stay visible in the GUI. ' +
        'At least 2 views must stay included. Changes apply when you click Apply.';
    cvSection.body.appendChild(cvHint);

    if (cameraNames.length === 0) {
        const cvEmpty = document.createElement('div');
        cvEmpty.className = 'settings-kbd-hint';
        cvEmpty.textContent = 'Load a session with cameras to choose which views are tracked.';
        cvSection.body.appendChild(cvEmpty);
    } else {
        const cvList = document.createElement('div');
        cvList.className = 'settings-node-weight-list';
        cvSection.body.appendChild(cvList);

        cameraNames.forEach(function (name) {
            const row = document.createElement('div');
            row.className = 'settings-node-weight-row';

            const label = document.createElement('div');
            label.className = 'settings-kbd-label';
            label.textContent = name;

            // Grey the row out when the view is excluded (weight 0).
            function reflectExcluded() {
                row.classList.toggle('settings-view-excluded', working.cameraWeights[name] === 0);
            }
            // An on/off switch: on = the view takes part in tracking (1), off = excluded (0).
            const sw = makeToggle(working.cameraWeights[name] !== 0, 'Include view ' + name + ' in tracking', function (on) {
                working.cameraWeights[name] = on ? 1 : 0;
                thrExamples.invalidate();
                reflectExcluded();
                filterPreview.update();
            });

            reflectExcluded();
            row.appendChild(label);
            row.appendChild(sw);
            cvList.appendChild(row);
        });
    }

    // --- Tracking Thresholds section -------------------------------------
    // Tier A (scoring) + Tier B (reprojection gates) knobs of the cross-view
    // tracker. Each renders a labelled number field (range/step from the catalog),
    // or an on/off switch for a `kind: 'toggle'` setting, with an inline
    // description. Edits mutate working.thresholds; numbers are clamped to the
    // catalog range on blur and on Apply.
    const thSection = buildSection('Tracking Thresholds', thresholdDefs.length || null);
    wizPanel.appendChild(thSection.root);

    const thHint = document.createElement('div');
    thHint.className = 'settings-kbd-hint';
    thHint.style.marginTop = '0';
    thHint.style.marginBottom = '8px';
    thHint.textContent = 'Thresholds the cross-view tracker uses when matching instances across views. ' +
        'Defaults are tuned values — change them only if tracking under/over-matches. Changes apply when you click Apply.';
    thSection.body.appendChild(thHint);

    thresholdDefs.forEach(function (def) {
        const isFilter = def.id === 'filterMinVisibleNodes' || def.id === 'filterMinInstanceScore' ||
            def.id === 'filterMinMeanNodeScore';
        const onEdit = isFilter ? function () { filterPreview.update(); }
            : def.id === 'reprojErrorThreshold'
                ? function () { triFigure.update({ threshold: working.thresholds.reprojErrorThreshold }); }
                : null;
        thSection.body.appendChild(buildParamRow(def, working.thresholds, onEdit));
        // The readout goes right under the last of the three filter fields.
        if (def.id === 'filterMinMeanNodeScore') thSection.body.appendChild(filterPreview.root);
    });

    // Docs link at the bottom of the thresholds.
    const docsNote = document.createElement('div');
    docsNote.className = 'settings-kbd-hint settings-docs-note';
    const docsLink = document.createElement('a');
    docsLink.href = 'https://talmolab.github.io/luc3d-docs/how-it-works/tracking-triangulation/';
    docsLink.target = '_blank';
    docsLink.rel = 'noopener';
    docsLink.textContent = 'Tracker Docs';
    docsNote.appendChild(docsLink);
    wizPanel.appendChild(docsNote);

    panelContainer.appendChild(wizPanel);
    panels.wizard = wizPanel;

    // 4) Temporal Smoothing panel (luc3d #134).
    //
    // The post-triangulation filter's hyperparameters. Kept as its own panel
    // rather than a fourth section of the Tracking Wizard because it is NOT a
    // tracking parameter: it runs after triangulation, over 3D that the tracker
    // has already finished with. Run it from the toolbar's Smooth (Temporal Smoothing)
    // button (all frames; its menu also has "This frame").
    const smPanel = document.createElement('div');
    smPanel.className = 'settings-panel';
    smPanel.dataset.panel = 'smoothing';
    const smTitle = document.createElement('div');
    smTitle.className = 'settings-panel-title';
    smTitle.textContent = 'Temporal Smoothing';
    smPanel.appendChild(smTitle);

    const smHint = document.createElement('div');
    smHint.className = 'settings-kbd-hint';
    smHint.style.marginTop = '0';
    smHint.style.marginBottom = '8px';
    smHint.textContent = 'Smooths each node\'s 3D over time, after triangulation: a median first, then a Gaussian. ' +
        '2D labels and predictions never change; the reprojections follow the smoothed 3D. Both stages are off (0) ' +
        'by default. Run it from the toolbar\'s Smooth ▾ (a click runs all frames; its menu also has This frame and ' +
        'Remove smoothing). Changes here apply when you click Apply.';
    smPanel.appendChild(smHint);

    // What the two windows do, redrawn as they are typed
    // (`ui/smoothing-windows-figure.js`). Its sliders only redraw the sketch;
    // its Use and Turn off buttons set the same working values and the
    // matching field.
    const smFigure = buildSmoothingWindowsFigure({
        saved: Object.assign({}, working.smoothing),
        onParam: function (id, value) {
            working.smoothing[id] = value;
            const def = smoothingDefs.find(function (d) { return d.id === id; });
            const field = def && smSection.body.querySelector('input[aria-label="' + def.label + '"]');
            if (field) field.value = String(value);
        },
    });
    smFigure.update(working.smoothing);
    smPanel.appendChild(smFigure.el);

    const smSection = buildSection('Filter Parameters', smoothingDefs.length || null);
    smPanel.appendChild(smSection.root);
    smoothingDefs.forEach(function (def) {
        smSection.body.appendChild(buildParamRow(def, working.smoothing, function () {
            smFigure.update(working.smoothing);
        }));
    });

    // The two dials of luc3d #134 pull against each other and the interaction is
    // the opposite of what tuning two sliders suggests, so say so here.
    const smNote = document.createElement('div');
    smNote.className = 'settings-kbd-hint';
    smNote.textContent = 'Tip: raising the Tracking Wizard\'s "Reprojection error threshold" drops unreliable ' +
        'views, which removes a cause of jitter — but it also nulls nodes that fall below two reliable views, ' +
        'creating more gaps. Gap edges are where a filter is least accurate, so turning both dials up hard is ' +
        'worse than either alone. Try the threshold first, then smooth what is left.';
    smPanel.appendChild(smNote);

    panelContainer.appendChild(smPanel);
    panels.smoothing = smPanel;

    // Footer.
    const footer = document.createElement('div');
    footer.className = 'settings-modal-footer';
    // Window size: display taste, kept with the card's geometry, so Apply has nothing to do with it.
    const sizeBtns = document.createElement('div');
    sizeBtns.className = 'settings-size-btns';
    sizeBtns.setAttribute('role', 'group');
    sizeBtns.setAttribute('aria-label', 'Window size');
    const sizeLabel = document.createElement('span');
    sizeLabel.textContent = 'Window';
    sizeBtns.appendChild(sizeLabel);
    const SIZE_PRESETS = [
        {
            name: 'default', label: 'Default', tip: 'Fill the browser\'s height, up to 1700 px wide, centred',
            // A window centred in the browser, with room either side.
            icon: '<rect x="1" y="2.5" width="14" height="11" rx="1.5" fill="none" stroke="currentColor" opacity="0.55"/>'
                + '<rect x="4.5" y="4" width="7" height="8" rx="0.75" fill="currentColor"/>',
        },
        {
            name: 'full', label: 'Full', tip: 'Fill the whole browser window',
            // Four corners pushed out to the edges: the usual full-screen mark.
            icon: '<path d="M1.5 5.5V2.5a1 1 0 0 1 1-1h3M10.5 1.5h3a1 1 0 0 1 1 1v3M14.5 10.5v3a1 1 0 0 1-1 1h-3M5.5 14.5h-3a1 1 0 0 1-1-1v-3" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"/>'
                + '<rect x="4.5" y="4.5" width="7" height="7" rx="0.75" fill="currentColor"/>',
        },
    ];
    const sizeButtons = SIZE_PRESETS.map(function (preset) {
        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'settings-size-btn';
        btn.dataset.size = preset.name;
        btn.innerHTML = '<svg viewBox="0 0 16 16" width="14" height="14" aria-hidden="true">' + preset.icon + '</svg>';
        btn.appendChild(document.createTextNode(preset.label));
        btn.title = preset.tip;
        btn.addEventListener('click', function () {
            if (disposeGeometry && disposeGeometry.setSizePreset) disposeGeometry.setSizePreset(preset.name);
        });
        sizeBtns.appendChild(btn);
        return btn;
    });
    function paintSizeButtons(current) {
        sizeButtons.forEach(function (btn) {
            btn.setAttribute('aria-pressed', btn.dataset.size === current ? 'true' : 'false');
        });
    }
    footer.appendChild(sizeBtns);
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'settings-btn settings-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'settings-btn settings-btn-apply';
    applyBtn.textContent = 'Apply';
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);
    card.appendChild(footer);

    // The buttons follow `working` against what is stored: an edit undone by hand
    // has nothing to apply. "Applied" is only said once Apply has been clicked.
    let storedSnapshot = JSON.stringify(working);
    let appliedOnce = false;
    function paintFooter() {
        const pending = JSON.stringify(working) !== storedSnapshot;
        applyBtn.disabled = !pending;
        applyBtn.classList.toggle('is-applied', !pending && appliedOnce);
        applyBtn.textContent = !pending && appliedOnce ? 'Applied ✓' : 'Apply';
        cancelBtn.textContent = pending ? 'Cancel' : 'Close';
    }
    onWorkingEdit = paintFooter;
    paintFooter();

    // --- Nav behavior -----------------------------------------------------
    function selectPanel(name) {
        Object.keys(navItems).forEach(function (key) {
            navItems[key].classList.toggle('active', key === name);
        });
        Object.keys(panels).forEach(function (key) {
            panels[key].classList.toggle('active', key === name);
        });
        if (name === 'wizard') filterPreview.start();
        if (name === 'triangulation') thrExamples.start();
        thrExamples.setActive(name === 'triangulation');
        writeLastPanel(name);
    }
    NAV_ITEMS.forEach(function (item) {
        navItems[item.panel].addEventListener('click', function () {
            selectPanel(item.panel);
        });
    });
    selectPanel(startPanel);

    // --- Close / commit behavior ------------------------------------------
    // Set once the card is in the DOM (geometry has to be measured), so
    // teardown has to tolerate a null.
    let disposeGeometry = null;

    function teardown() {
        document.removeEventListener('keydown', onDocKeyDown, true);
        filterPreview.dispose();
        thrExamples.dispose();
        if (disposeGeometry) { disposeGeometry(); disposeGeometry = null; }
        overlay.remove();
    }

    function close() {
        // Discard pending edits — just remove the overlay.
        teardown();
    }

    function commit() {
        setDefaultTriangulationMethod(working.method);
        applyBindings(working.keyMap);
        setNodeWeights(working.nodeWeights);
        setCameraWeights(working.cameraWeights);
        setTrackingThresholds(working.thresholds);
        setSmoothingParams(working.smoothing);
        storedSnapshot = JSON.stringify(working);
        appliedOnce = true;
        paintFooter();
        // The figures' "not saved until you click Apply" notes measure from here now.
        triFigure.update({ saved: working.thresholds.reprojErrorThreshold });
        smFigure.update(working.smoothing, Object.assign({}, working.smoothing));
        // Reflect committed camera-inclusion changes immediately: excluded views
        // grey out in both the video overlays and the timeline.
        try { drawAllOverlays(state.currentFrame); } catch (e) { /* no active render yet */ }
        if (timeline && typeof timeline.redraw === 'function') timeline.redraw();
        // The ID-switch box encloses only nonzero-weight nodes: re-fit it to the new weights.
        refreshIdSwitchHighlight();
    }

    function onDocKeyDown(e) {
        // This runs in the capture phase (before the app's bubble-phase keydown
        // handlers), so stopping propagation here makes the modal fully capture
        // the keyboard: background shortcuts (t/v/g/…) won't fire while Settings
        // is open, and a key being rebound won't also trigger its current action.
        // It does NOT stop the per-chip capture listener, which is registered on
        // the same target+phase and only stopped by stopImmediatePropagation.
        e.stopPropagation();
        // Don't intercept Escape while a key capture is in progress; the
        // capture's own listener handles it first.
        if (capturingState) return;
        const choice = e.target && e.target.closest ? e.target.closest('.tri-method-choice') : null;
        if (choice && (e.key === 'Enter' || e.key === ' ')) {
            e.preventDefault();
            pickMethod(choice.dataset.method);
            return;
        }
        if ((e.key === 'ArrowLeft' || e.key === 'ArrowRight') && e.target && e.target.closest && e.target.closest('.thr-ex')) {
            e.preventDefault();
            thrExamples.step(e.key === 'ArrowLeft' ? -1 : 1);
            return;
        }
        if (e.key === 'Escape') {
            e.preventDefault();
            close();
        }
    }
    document.addEventListener('keydown', onDocKeyDown, true);

    closeBtn.addEventListener('click', close);
    cancelBtn.addEventListener('click', close);
    applyBtn.addEventListener('click', commit);
    overlay.addEventListener('click', function (e) {
        // Only the backdrop itself closes — not clicks inside the card.
        if (e.target === overlay) close();
    });

    document.body.appendChild(overlay);

    // Restore the remembered size/position, and keep it remembered. Must come
    // after the append: with no stored geometry the card is centred at whatever
    // size the stylesheet gave it, which can only be measured once it is laid
    // out. The header is the drag handle, minus the close button — dragging
    // from an × that is about to be clicked would be a trap.
    disposeGeometry = installModalGeometry(card, {
        id: 'settings',
        handle: header,
        noDragSelector: '.settings-modal-close',
        minW: 520,
        minH: 320,
        margin: 24,
        fillHeight: true,
        fillWidth: 1700,
        onSizePreset: paintSizeButtons,
        // The opening size before it widened (to 1040x620, now 1320x800);
        // records holding it were saved without a resize, so they open at the
        // current default. Later records carry `sized`, so they follow it too.
        legacyDefaultSize: { w: 880, h: 620 },
    });
    if (disposeGeometry.sizePreset) paintSizeButtons(disposeGeometry.sizePreset());
}
