/**
 * ui/panel-rail.js — the right-edge icon rail that shows and hides the info
 * panel's panels (Instances, Visibility, ID Switches, Videos, Cameras,
 * Skeleton, Session). It replaced the horizontal tab bar.
 *
 * Modelled on sleap-app's sidebar (`AppShell.tsx` `Sidebar`) in its
 * one-panel-at-a-time mode:
 *   - a click on an icon shows that panel (expanding the info panel if it is
 *     hidden); a click on the icon of the panel already showing hides the info
 *     panel. The info panel's own hide/show (`toggleInfoPanel`: the Panel
 *     button, `I`, View ▸ Toggle Info Panel, the rail's top button) is the one
 *     collapse, so every way of hiding it agrees with the rail.
 *   - an icon is active (accent colour + bar on the panel-facing edge) only
 *     while its panel is on screen; a hidden info panel shows no active icon.
 *   - hovering or focusing the rail widens it over the panel to show each
 *     icon's name (pure CSS, `.panel-rail:hover`).
 * sleap-app's default multi-panel stack is NOT ported: stacked sections each
 * need their own scroller (CLAUDE.md: one scroller per panel), and the info
 * panel's code assumes one active tab.
 *
 * Code that wants a panel on screen calls `showPanelTab(tabId)`, which never
 * hides anything — never `.click()` a rail button for that, since clicking the
 * active one hides the panel.
 *
 * The chosen panel is display taste: remembered in `localStorage`
 * (best-effort), restored once at setup, never in the `.slp`.
 *
 * Imports only the icon strings; `toggleInfoPanel` is handed in by
 * `setupPanelRail` (it lives in `ui/ui-wiring.js`, which would close a cycle
 * for `ui/id-switch-modal.js` and `ui/plane-definition.js`).
 */
import { railIconSvg } from './panel-rail-icons.js';

/** Rail order = the old tab bar's order. `tab` is the `.panel-tab-content` element id. */
export const PANEL_RAIL_PANELS = [
    { tab: 'tabInstances', label: 'Instances', icon: 'users' },
    { tab: 'tabVisibility', label: 'Visibility', icon: 'eye' },
    { tab: 'tabIdSwitches', label: 'ID Switches', icon: 'arrow-left-right' },
    { tab: 'tabVideos', label: 'Videos', icon: 'film' },
    { tab: 'tabCameras', label: 'Cameras', icon: 'camera' },
    { tab: 'tabSkeleton', label: 'Skeleton', icon: 'bone' },
    { tab: 'tabSession', label: 'Session', icon: 'folder-tree' },
];

export const PANEL_RAIL_STORAGE_KEY = 'lucidPanelRailTab';
const DEFAULT_TAB = 'tabInstances';
const WRAPPER_ID = 'infoPanelWrapper';

let _rail = null;
let _toggleInfoPanel = null;
let _activeTab = DEFAULT_TAB;
let _locked = false;

function isKnownTab(tabId) {
    return PANEL_RAIL_PANELS.some(function (p) { return p.tab === tabId; });
}

function isInfoPanelCollapsed() {
    const w = document.getElementById(WRAPPER_ID);
    return !!w && w.classList.contains('collapsed');
}

function setInfoPanelShown(shown) {
    if (isInfoPanelCollapsed() === !shown) return;
    if (_toggleInfoPanel) _toggleInfoPanel();
}

/** Show `tabId`'s content (the info panel's `.active` pane) and remember it. */
function applyActiveTab(tabId) {
    _activeTab = tabId;
    document.querySelectorAll('.panel-tab-content').forEach(function (c) {
        c.classList.toggle('active', c.id === tabId);
    });
    try { localStorage.setItem(PANEL_RAIL_STORAGE_KEY, tabId); } catch (e) { /* best effort */ }
}

/** Repaint the rail from the DOM: which icon is active, the top button's icon and name. */
export function syncPanelRail() {
    if (!_rail) return;
    const collapsed = isInfoPanelCollapsed();
    _rail.querySelectorAll('.panel-rail-btn[data-tab]').forEach(function (btn) {
        const on = !collapsed && btn.getAttribute('data-tab') === _activeTab;
        btn.classList.toggle('active', on);
        btn.setAttribute('aria-pressed', on ? 'true' : 'false');
        btn.disabled = _locked;
    });
    const t = _rail.querySelector('.panel-rail-collapse');
    if (t) {
        const name = collapsed ? 'Show panel' : 'Hide panel';
        t.querySelector('.panel-rail-icon').innerHTML = railIconSvg(collapsed ? 'panel-right-open' : 'panel-right-close');
        t.querySelector('.panel-rail-label').textContent = name;
        t.setAttribute('aria-label', name);
        t.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    }
}

/** The panel currently chosen (shown whenever the info panel is). */
export function getActivePanelTab() {
    return _activeTab;
}

/**
 * Put `tabId` on screen: select it and show the info panel if it is hidden.
 * Never hides anything. Returns false for an unknown id.
 */
export function showPanelTab(tabId) {
    if (!isKnownTab(tabId)) return false;
    applyActiveTab(tabId);
    setInfoPanelShown(true);
    syncPanelRail();
    return true;
}

/**
 * A click on a rail icon (sleap-app's one-at-a-time rule): the icon of the
 * panel already on screen hides the info panel; any other shows its panel.
 */
export function clickPanelRailTab(tabId) {
    if (_locked || !isKnownTab(tabId)) return;
    if (!isInfoPanelCollapsed() && tabId === _activeTab) {
        setInfoPanelShown(false);
        syncPanelRail();
        return;
    }
    showPanelTab(tabId);
}

/**
 * Define Planes swaps the tabbed content for `#planePanel`
 * (`setPanelPlaneMode`, ui/plane-definition.js); while it does, the panel
 * icons are disabled. The top hide/show button stays live.
 */
export function setPanelRailLocked(on) {
    _locked = !!on;
    if (_rail) _rail.classList.toggle('locked', _locked);
    syncPanelRail();
}

function buildButton(cls, iconName, label) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'panel-rail-btn ' + cls;
    btn.setAttribute('aria-label', label);
    const icon = document.createElement('span');
    icon.className = 'panel-rail-icon';
    icon.innerHTML = railIconSvg(iconName);
    const name = document.createElement('span');
    name.className = 'panel-rail-label';
    name.textContent = label;
    btn.appendChild(icon);
    btn.appendChild(name);
    return btn;
}

/**
 * Build the rail into `#panelRail` and wire it. `toggleInfoPanel` is the one
 * hide/show of `#infoPanelWrapper` (ui/ui-wiring.js).
 */
export function setupPanelRail(opts) {
    _rail = document.getElementById('panelRail');
    if (!_rail) return;
    _toggleInfoPanel = (opts && opts.toggleInfoPanel) || null;
    _rail.textContent = '';

    const inner = document.createElement('div');
    inner.className = 'panel-rail-inner';
    _rail.appendChild(inner);

    const collapseBtn = buildButton('panel-rail-collapse', 'panel-right-close', 'Hide panel');
    collapseBtn.setAttribute('aria-controls', WRAPPER_ID);
    collapseBtn.addEventListener('click', function () {
        if (_toggleInfoPanel) _toggleInfoPanel();
        syncPanelRail();
    });
    inner.appendChild(collapseBtn);

    PANEL_RAIL_PANELS.forEach(function (p) {
        const btn = buildButton('panel-rail-tab', p.icon, p.label);
        btn.setAttribute('data-tab', p.tab);
        btn.setAttribute('aria-controls', p.tab);
        btn.addEventListener('click', function () { clickPanelRailTab(p.tab); });
        inner.appendChild(btn);
    });

    // Restore the remembered panel (once, at setup) without touching
    // whether the info panel is shown.
    let stored = null;
    try { stored = localStorage.getItem(PANEL_RAIL_STORAGE_KEY); } catch (e) { stored = null; }
    const markupActive = document.querySelector('.panel-tab-content.active');
    _activeTab = isKnownTab(stored) ? stored
        : (markupActive && isKnownTab(markupActive.id) ? markupActive.id : DEFAULT_TAB);
    document.querySelectorAll('.panel-tab-content').forEach(function (c) {
        c.classList.toggle('active', c.id === _activeTab);
    });

    // Every other way of hiding/showing the info panel (Panel button, `I`,
    // View menu, `openIdSwitchPanel` callers) flips the wrapper's class;
    // follow it so the active icon always matches what is on screen.
    const wrapper = document.getElementById(WRAPPER_ID);
    if (wrapper && typeof MutationObserver !== 'undefined') {
        new MutationObserver(syncPanelRail).observe(wrapper, { attributes: true, attributeFilter: ['class'] });
    }
    syncPanelRail();
}
