// ui/settings-modal.js
// Builds and shows the LUCID "Settings" modal.
//
// The modal has three panels (selected via a left nav): the default
// triangulation method, an editable list of keyboard shortcuts, and a
// placeholder Tracking Wizard panel. All edits are kept in a local working
// state object and the visual DOM only — nothing is committed to settings.js
// until the user clicks Apply. Cancel / close / backdrop / Escape discard.
//
// Styling lives in a separate CSS file; this module only assigns the agreed
// class names. Only one modal instance may exist at a time.

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
} from './settings.js';
import { getActiveSession, state, timeline } from './app-state.js';
import { drawAllOverlays } from './rendering.js';

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

// Show the Settings modal. `initialPanel` is one of 'triangulation' |
// 'keyboard' | 'wizard' and defaults to 'triangulation'.
export function showSettingsModal(initialPanel) {
    const startPanel = (initialPanel === 'keyboard' || initialPanel === 'wizard')
        ? initialPanel
        : 'triangulation';

    // Enforce a single instance.
    const existing = document.querySelector('.settings-overlay');
    if (existing) existing.remove();

    // --- Working state: all edits mutate this, never settings.js directly. ---
    const working = {
        method: getDefaultTriangulationMethod(),
        keyMap: {},
        nodeWeights: {},
        cameraWeights: {},
        thresholds: {},
    };
    const actions = getActions();
    // Only editable actions are user-rebindable; the working map tracks those.
    actions.forEach(function (a) { if (a.editable) working.keyMap[a.id] = a.binding; });

    // Seed the working node-weight map from the active session's skeleton, if any.
    // Keyed by node name; values are the current effective weight (default 1).
    const activeSession = getActiveSession();
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
    const closeBtn = document.createElement('div');
    closeBtn.className = 'settings-modal-close';
    closeBtn.textContent = '×';
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

    const NAV_ITEMS = [
        { panel: 'triangulation', label: 'Default Triangulation' },
        { panel: 'keyboard', label: 'Keyboard Shortcuts' },
        { panel: 'wizard', label: 'Tracking Wizard' },
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

    const TRI_METHODS = [
        {
            method: 'dlt',
            title: 'Direct Linear Transformation (DLT)',
            desc: 'Fast. Algebraic least-squares triangulation.',
        },
        {
            method: 'ba',
            title: 'Bundle Adjustment (BA)',
            desc: 'Slower. Minimizes geometric reprojection error.',
        },
    ];

    const radioRows = {};
    TRI_METHODS.forEach(function (m) {
        const row = document.createElement('div');
        row.className = 'settings-radio-row';
        row.dataset.method = m.method;

        const indicator = document.createElement('span');
        indicator.className = 'settings-radio';
        row.appendChild(indicator);

        const labelWrap = document.createElement('div');
        labelWrap.className = 'settings-radio-label';
        const rTitle = document.createElement('div');
        rTitle.className = 'settings-radio-title';
        rTitle.textContent = m.title;
        const rDesc = document.createElement('div');
        rDesc.className = 'settings-radio-desc';
        rDesc.textContent = m.desc;
        labelWrap.appendChild(rTitle);
        labelWrap.appendChild(rDesc);
        row.appendChild(labelWrap);

        row.addEventListener('click', function () {
            working.method = m.method;
            Object.keys(radioRows).forEach(function (key) {
                radioRows[key].classList.toggle('checked', key === m.method);
            });
        });

        triPanel.appendChild(row);
        radioRows[m.method] = row;
    });
    // Initialize checked row from current default.
    if (radioRows[working.method]) radioRows[working.method].classList.add('checked');

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
    // Each skeleton node gets a 0–1 weight controlling how much it counts in the
    // tracking cost (epipolar, reprojection, instance distance). 1 = full weight,
    // 0 = ignored entirely. Edits mutate working.nodeWeights; committed on Apply.
    const nwCategory = document.createElement('div');
    nwCategory.className = 'settings-kbd-category';
    nwCategory.textContent = 'Node Weights';
    wizPanel.appendChild(nwCategory);

    const nwHint = document.createElement('div');
    nwHint.className = 'settings-kbd-hint';
    nwHint.style.marginTop = '0';
    nwHint.style.marginBottom = '8px';
    nwHint.textContent = 'Weight of each skeleton node in the tracking algorithm (0–1). ' +
        '1 = fully considered (epipolar cost, reprojection, …); 0 = ignored. Changes apply when you click Apply.';
    wizPanel.appendChild(nwHint);

    if (skeletonNodes.length === 0) {
        const nwEmpty = document.createElement('div');
        nwEmpty.className = 'settings-kbd-hint';
        nwEmpty.textContent = 'Load a session with a skeleton to configure node weights.';
        wizPanel.appendChild(nwEmpty);
    } else {
        // Compact, scrollable multi-column table so long skeletons don't push the
        // Tracking Thresholds section off-screen.
        const nwList = document.createElement('div');
        nwList.className = 'settings-node-weight-list';
        wizPanel.appendChild(nwList);

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

            // Keep the working map in sync as the user types. Empty/invalid input
            // is tolerated mid-edit; clamping to [0,1] happens on blur and on Apply.
            input.addEventListener('input', function () {
                const v = parseFloat(input.value);
                if (isFinite(v)) working.nodeWeights[name] = v;
            });
            input.addEventListener('blur', function () {
                let v = parseFloat(input.value);
                if (!isFinite(v)) v = working.nodeWeights[name];
                if (v < 0) v = 0;
                if (v > 1) v = 1;
                working.nodeWeights[name] = v;
                input.value = String(v);
            });

            row.appendChild(label);
            row.appendChild(input);
            nwList.appendChild(row);
        });
    }

    // --- Camera Views section --------------------------------------------
    // Each camera view gets a binary 0/1 weight controlling whether it takes part
    // in cross-view tracking. 1 = included; 0 = excluded from the association math
    // (the view stays visible/editable in the GUI). Excluded rows are greyed out.
    // Edits mutate working.cameraWeights; committed on Apply.
    const cvCategory = document.createElement('div');
    cvCategory.className = 'settings-kbd-category';
    cvCategory.textContent = 'Camera Views';
    wizPanel.appendChild(cvCategory);

    const cvHint = document.createElement('div');
    cvHint.className = 'settings-kbd-hint';
    cvHint.style.marginTop = '0';
    cvHint.style.marginBottom = '8px';
    cvHint.textContent = 'Whether each camera view is used in tracking (1 = included, 0 = excluded). ' +
        'Excluded views are dropped from the association math but stay visible in the GUI. ' +
        'At least 2 views must stay included. Changes apply when you click Apply.';
    wizPanel.appendChild(cvHint);

    if (cameraNames.length === 0) {
        const cvEmpty = document.createElement('div');
        cvEmpty.className = 'settings-kbd-hint';
        cvEmpty.textContent = 'Load a session with cameras to choose which views are tracked.';
        wizPanel.appendChild(cvEmpty);
    } else {
        const cvList = document.createElement('div');
        cvList.className = 'settings-node-weight-list';
        wizPanel.appendChild(cvList);

        cameraNames.forEach(function (name) {
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
            input.step = '1';
            input.value = String(working.cameraWeights[name]);
            input.setAttribute('aria-label', 'Include view ' + name + ' in tracking (0 or 1)');

            // Grey the row out when the view is excluded (weight 0).
            function reflectExcluded() {
                row.classList.toggle('settings-view-excluded', working.cameraWeights[name] === 0);
            }

            // Any nonzero value is treated as included (1); only an explicit 0
            // excludes. Coerce on input so the row greys live; normalize on blur.
            input.addEventListener('input', function () {
                const v = parseFloat(input.value);
                if (isFinite(v)) working.cameraWeights[name] = v === 0 ? 0 : 1;
                reflectExcluded();
            });
            input.addEventListener('blur', function () {
                let v = parseFloat(input.value);
                if (!isFinite(v)) v = working.cameraWeights[name];
                working.cameraWeights[name] = v === 0 ? 0 : 1;
                input.value = String(working.cameraWeights[name]);
                reflectExcluded();
            });

            reflectExcluded();
            row.appendChild(label);
            row.appendChild(input);
            cvList.appendChild(row);
        });
    }

    // --- Tracking Thresholds section -------------------------------------
    // Tier A (scoring) + Tier B (reprojection gates) knobs of the cross-view
    // tracker. Each renders a labelled number field (range/step from the catalog)
    // with an inline description. Edits mutate working.thresholds; clamped to the
    // catalog range on blur and on Apply.
    const thCategory = document.createElement('div');
    thCategory.className = 'settings-kbd-category';
    thCategory.textContent = 'Tracking Thresholds';
    wizPanel.appendChild(thCategory);

    const thHint = document.createElement('div');
    thHint.className = 'settings-kbd-hint';
    thHint.style.marginTop = '0';
    thHint.style.marginBottom = '8px';
    thHint.textContent = 'Thresholds the cross-view tracker uses when matching instances across views. ' +
        'Defaults are tuned values — change them only if tracking under/over-matches. Changes apply when you click Apply.';
    wizPanel.appendChild(thHint);

    thresholdDefs.forEach(function (def) {
        const row = document.createElement('div');
        row.className = 'settings-threshold-row';

        const labelWrap = document.createElement('div');
        labelWrap.className = 'settings-threshold-label-wrap';
        const thTitle = document.createElement('div');
        thTitle.className = 'settings-threshold-title';
        thTitle.textContent = def.label;
        const thDesc = document.createElement('div');
        thDesc.className = 'settings-threshold-desc';
        thDesc.textContent = def.desc;
        labelWrap.appendChild(thTitle);
        labelWrap.appendChild(thDesc);

        const input = document.createElement('input');
        input.type = 'number';
        input.className = 'settings-num-input';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(working.thresholds[def.id]);
        input.setAttribute('aria-label', def.label);

        input.addEventListener('input', function () {
            const v = parseFloat(input.value);
            if (isFinite(v)) working.thresholds[def.id] = v;
        });
        input.addEventListener('blur', function () {
            let v = parseFloat(input.value);
            if (!isFinite(v)) v = working.thresholds[def.id];
            if (v < def.min) v = def.min;
            if (v > def.max) v = def.max;
            working.thresholds[def.id] = v;
            input.value = String(v);
        });

        row.appendChild(labelWrap);
        row.appendChild(input);
        wizPanel.appendChild(row);
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

    // Footer.
    const footer = document.createElement('div');
    footer.className = 'settings-modal-footer';
    const cancelBtn = document.createElement('button');
    cancelBtn.className = 'settings-btn settings-btn-cancel';
    cancelBtn.textContent = 'Cancel';
    const applyBtn = document.createElement('button');
    applyBtn.className = 'settings-btn settings-btn-apply';
    applyBtn.textContent = 'Apply';
    footer.appendChild(cancelBtn);
    footer.appendChild(applyBtn);
    card.appendChild(footer);

    // --- Nav behavior -----------------------------------------------------
    function selectPanel(name) {
        Object.keys(navItems).forEach(function (key) {
            navItems[key].classList.toggle('active', key === name);
        });
        Object.keys(panels).forEach(function (key) {
            panels[key].classList.toggle('active', key === name);
        });
    }
    NAV_ITEMS.forEach(function (item) {
        navItems[item.panel].addEventListener('click', function () {
            selectPanel(item.panel);
        });
    });
    selectPanel(startPanel);

    // --- Close / commit behavior ------------------------------------------
    function teardown() {
        document.removeEventListener('keydown', onDocKeyDown, true);
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
        teardown();
        // Reflect committed camera-inclusion changes immediately: excluded views
        // grey out in both the video overlays and the timeline.
        try { drawAllOverlays(state.currentFrame); } catch (e) { /* no active render yet */ }
        if (timeline && typeof timeline.redraw === 'function') timeline.redraw();
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
}
