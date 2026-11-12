/**
 * ui/panel-rail.js — the right-edge icon rail and the stack of collapsible
 * panel sections it drives (Instances, Visibility, ID Switches, Videos,
 * Cameras, Skeleton, Session). It replaced the horizontal tab bar.
 *
 * Modelled on sleap-app's sidebar (`AppShell.tsx` `Sidebar`, rules in
 * `appStore.ts` `togglePanelOpen` / `openPanel` / `closePanel` /
 * `toggleSectionCollapsed`) in its default multi-panel (accordion) mode:
 *   - several panels can be OPEN at once, stacked in rail order. Each open
 *     panel is a section with a header: a chevron + name that folds its body
 *     to a header strip, and an ✕ that closes it (takes it out of the stack).
 *   - a rail click on a panel that is not expanded opens it (if needed),
 *     expands it, and folds every other open panel to its header; a click on
 *     the expanded panel folds it. A click while the info panel is hidden
 *     shows it with that panel expanded and the others folded.
 *   - closing the last open panel hides the info panel; showing the info
 *     panel with nothing open reopens the default panel.
 *   - every open panel's icon is active (accent colour + bar).
 *   - mouse enter or focus entering the rail widens it over the panel to
 *     show each name (`.expanded`); mouse leave or focus leaving narrows it.
 * Unlike sleap-app, sections do not scroll on their own: the info panel is
 * the one scroller (CLAUDE.md: one scroller per panel), so sections have
 * their natural height and sticky headers. No section-resize splitters
 * (nothing to resize without inner scrollers) and no single-panel mode.
 *
 * Code that wants a panel on screen calls `showPanelTab(tabId)` (sleap-app's
 * `openPanel`): it opens and expands that panel, shows the info panel and
 * scrolls its header to the top, and never hides or folds anything — never
 * `.click()` a rail button for that, since clicking the expanded one folds it.
 *
 * Which panels are open / folded is display taste: remembered in
 * `localStorage` (best-effort), restored once at setup, never in the `.slp`.
 *
 * Each `.panel-tab-content` pane is wrapped at setup in a
 * `<section class="panel-section" data-tab>` holding its header; the pane
 * keeps its id and markup, and carries `.active` while its body is on screen.
 *
 * Imports only the icon strings; `toggleInfoPanel` is handed in by
 * `setupPanelRail` (it lives in `ui/ui-wiring.js`, which would close a cycle
 * for `ui/id-switch-modal.js` and `ui/plane-definition.js`).
 */
import { railIconSvg } from './panel-rail-icons.js?v=d4b8b9219192';

/** Rail and stack order = the old tab bar's order. `tab` is the `.panel-tab-content` element id. */
export const PANEL_RAIL_PANELS = [
    { tab: 'tabInstances', label: 'Instances', icon: 'users' },
    { tab: 'tabVisibility', label: 'Visibility', icon: 'eye' },
    { tab: 'tabIdSwitches', label: 'ID Switches', icon: 'arrow-left-right' },
    { tab: 'tabVideos', label: 'Videos', icon: 'film' },
    { tab: 'tabCameras', label: 'Cameras', icon: 'camera' },
    { tab: 'tabSkeleton', label: 'Skeleton', icon: 'bone' },
    { tab: 'tabSession', label: 'Session', icon: 'folder-tree' },
];

/** localStorage key of `{ open: [tabId…], folded: [tabId…] }`. */
export const PANEL_RAIL_STORAGE_KEY = 'lucidPanelRailSections';
const DEFAULT_OPEN = ['tabInstances'];
const WRAPPER_ID = 'infoPanelWrapper';

let _rail = null;
let _toggleInfoPanel = null;
/** Open panels (kept in rail order). */
let _open = DEFAULT_OPEN.slice();
/** Open panels whose body is folded to the header strip (a subset of `_open`). */
let _folded = [];
let _locked = false;

function isKnownTab(tabId) {
    return PANEL_RAIL_PANELS.some(function (p) { return p.tab === tabId; });
}

function inRailOrder(ids) {
    return PANEL_RAIL_PANELS.map(function (p) { return p.tab; })
        .filter(function (t) { return ids.indexOf(t) !== -1; });
}

function isInfoPanelCollapsed() {
    const w = document.getElementById(WRAPPER_ID);
    return !!w && w.classList.contains('collapsed');
}

function setInfoPanelShown(shown) {
    if (isInfoPanelCollapsed() === !shown) return;
    if (_toggleInfoPanel) _toggleInfoPanel();
}

function isExpanded(tabId) {
    return _open.indexOf(tabId) !== -1 && _folded.indexOf(tabId) === -1;
}

function persist() {
    try {
        localStorage.setItem(PANEL_RAIL_STORAGE_KEY, JSON.stringify({ open: _open, folded: _folded }));
    } catch (e) { /* best effort */ }
}

function sectionOf(tabId) {
    const pane = document.getElementById(tabId);
    return pane ? pane.closest('.panel-section') : null;
}

/** Apply `_open` / `_folded` to the sections, then repaint the rail and remember them. */
function applySections() {
    _open = inRailOrder(_open);
    _folded = _folded.filter(function (t) { return _open.indexOf(t) !== -1; });
    PANEL_RAIL_PANELS.forEach(function (p) {
        const section = sectionOf(p.tab);
        const pane = document.getElementById(p.tab);
        const open = _open.indexOf(p.tab) !== -1;
        const expanded = isExpanded(p.tab);
        if (section) {
            section.classList.toggle('open', open);
            section.classList.toggle('folded', open && !expanded);
            const fold = section.querySelector('.panel-section-toggle');
            if (fold) {
                fold.setAttribute('aria-expanded', expanded ? 'true' : 'false');
                fold.querySelector('.panel-section-chevron').innerHTML =
                    railIconSvg(expanded ? 'chevron-down' : 'chevron-right');
            }
        }
        if (pane) pane.classList.toggle('active', expanded);
    });
    persist();
    syncPanelRail();
}

/** Repaint the rail from the state: which icons are active, the top button's icon and name. */
export function syncPanelRail() {
    if (!_rail) return;
    const collapsed = isInfoPanelCollapsed();
    _rail.querySelectorAll('.panel-rail-btn[data-tab]').forEach(function (btn) {
        const on = !collapsed && _open.indexOf(btn.getAttribute('data-tab')) !== -1;
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

/**
 * Scroll the info panel (its one scroller) so `tabId`'s section header is at
 * the top: the panel just opened is the one being looked at. Sets only
 * `#infoPanel.scrollTop` (scrollIntoView would also scroll the page).
 */
function scrollSectionToTop(tabId) {
    const section = sectionOf(tabId);
    const panel = document.getElementById('infoPanel');
    if (!section || !panel) return;
    panel.scrollTop += section.getBoundingClientRect().top - panel.getBoundingClientRect().top;
}

/** The open panels in stack order, each with whether its body is expanded. */
export function getOpenPanelTabs() {
    return _open.map(function (t) { return { tab: t, expanded: isExpanded(t) }; });
}

/**
 * Put `tabId` on screen (sleap-app's `openPanel`): open and expand it, show
 * the info panel, and scroll its section's header to the top. Never hides or folds
 * another panel. Returns false for an unknown id.
 */
export function showPanelTab(tabId) {
    if (!isKnownTab(tabId)) return false;
    const wasHidden = isInfoPanelCollapsed();
    if (_open.indexOf(tabId) === -1) _open.push(tabId);
    _folded = _folded.filter(function (t) { return t !== tabId; });
    applySections();
    setInfoPanelShown(true);
    scrollSectionToTop(tabId);
    // A panel coming out of hiding is still widening (its text re-wraps, so
    // section heights change): place the header again once it has settled.
    if (wasHidden) setTimeout(function () { scrollSectionToTop(tabId); }, 300);
    return true;
}

/**
 * A click on a rail icon (sleap-app's accordion rule): with the info panel
 * hidden, show it with this panel expanded and the rest folded; on the
 * expanded panel, fold it; otherwise open + expand it and fold the others.
 */
export function clickPanelRailTab(tabId) {
    if (_locked || !isKnownTab(tabId)) return;
    if (isInfoPanelCollapsed()) {
        if (_open.indexOf(tabId) === -1) _open.push(tabId);
        _folded = _open.filter(function (t) { return t !== tabId; });
        applySections();
        setInfoPanelShown(true);
        return;
    }
    if (isExpanded(tabId)) {
        _folded.push(tabId);
        applySections();
        return;
    }
    if (_open.indexOf(tabId) === -1) _open.push(tabId);
    _folded = _open.filter(function (t) { return t !== tabId; });
    applySections();
    scrollSectionToTop(tabId);
}

/** A section header's chevron: fold or unfold that panel's body; the others are untouched. */
export function togglePanelSection(tabId) {
    if (_open.indexOf(tabId) === -1) return;
    if (_folded.indexOf(tabId) === -1) _folded.push(tabId);
    else _folded = _folded.filter(function (t) { return t !== tabId; });
    applySections();
}

/** A section header's ✕: take the panel out of the stack. Closing the last one hides the info panel. */
export function closePanelTab(tabId) {
    if (_open.indexOf(tabId) === -1) return;
    _open = _open.filter(function (t) { return t !== tabId; });
    applySections();
    if (_open.length === 0) setInfoPanelShown(false);
}

/**
 * Define Planes swaps the panel stack for `#planePanel`
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

/** Wrap pane `p.tab` in its `<section>` with a header (chevron + name, ✕). Idempotent. */
function buildSection(p) {
    const pane = document.getElementById(p.tab);
    if (!pane || pane.closest('.panel-section')) return;
    const section = document.createElement('section');
    section.className = 'panel-section';
    section.setAttribute('data-tab', p.tab);
    section.setAttribute('aria-label', p.label);

    const header = document.createElement('div');
    header.className = 'panel-section-header';
    const fold = document.createElement('button');
    fold.type = 'button';
    fold.className = 'panel-section-toggle';
    fold.setAttribute('aria-controls', p.tab);
    const chevron = document.createElement('span');
    chevron.className = 'panel-section-chevron';
    const title = document.createElement('span');
    title.className = 'panel-section-title';
    title.textContent = p.label;
    fold.appendChild(chevron);
    fold.appendChild(title);
    fold.addEventListener('click', function () { togglePanelSection(p.tab); });
    const close = document.createElement('button');
    close.type = 'button';
    close.className = 'panel-section-close';
    close.setAttribute('aria-label', 'Close ' + p.label);
    close.innerHTML = railIconSvg('x');
    close.addEventListener('click', function () { closePanelTab(p.tab); });
    header.appendChild(fold);
    header.appendChild(close);

    pane.parentNode.insertBefore(section, pane);
    section.appendChild(header);
    section.appendChild(pane);
}

function readStored() {
    let raw = null;
    try { raw = localStorage.getItem(PANEL_RAIL_STORAGE_KEY); } catch (e) { raw = null; }
    if (!raw) return null;
    try {
        const v = JSON.parse(raw);
        if (!v || !Array.isArray(v.open)) return null;
        return {
            open: v.open.filter(isKnownTab),
            folded: Array.isArray(v.folded) ? v.folded.filter(isKnownTab) : [],
        };
    } catch (e) { return null; }
}

/**
 * sleap-app's rail expansion (AppShell `railExpanded`): widen on mouse enter
 * and on focus entering the rail; narrow on mouse leave, and when focus
 * leaves the rail. A click neither narrows the rail nor drops focus, and
 * leaving with the mouse always narrows it, focus or not (so `I` pressed
 * after a click, then moving away, narrows it).
 */
function wireRailExpansion(inner) {
    const set = function (on) { _rail.classList.toggle('expanded', on); };
    inner.addEventListener('mouseenter', function () { set(true); });
    inner.addEventListener('mouseleave', function () { set(false); });
    inner.addEventListener('focusin', function () { set(true); });
    inner.addEventListener('focusout', function (e) {
        if (!inner.contains(e.relatedTarget)) set(false);
    });
}

/**
 * Build the rail into `#panelRail`, wrap each pane in its section, and wire
 * both. `toggleInfoPanel` is the one hide/show of `#infoPanelWrapper`
 * (ui/ui-wiring.js).
 */
export function setupPanelRail(opts) {
    _rail = document.getElementById('panelRail');
    if (!_rail) return;
    _toggleInfoPanel = (opts && opts.toggleInfoPanel) || null;
    _rail.textContent = '';

    const inner = document.createElement('div');
    inner.className = 'panel-rail-inner';
    _rail.appendChild(inner);
    wireRailExpansion(inner);

    const collapseBtn = buildButton('panel-rail-collapse', 'panel-right-close', 'Hide panel');
    collapseBtn.setAttribute('aria-controls', WRAPPER_ID);
    collapseBtn.addEventListener('click', function () {
        if (_toggleInfoPanel) _toggleInfoPanel();
        syncPanelRail();
    });
    inner.appendChild(collapseBtn);

    PANEL_RAIL_PANELS.forEach(function (p) {
        buildSection(p);
        const btn = buildButton('panel-rail-tab', p.icon, p.label);
        btn.setAttribute('data-tab', p.tab);
        btn.setAttribute('aria-controls', p.tab);
        btn.addEventListener('click', function () { clickPanelRailTab(p.tab); });
        inner.appendChild(btn);
    });

    // Restore the remembered sections (once, at setup) without touching
    // whether the info panel is shown. An empty stored stack is honoured only
    // while the info panel is hidden (showing it reopens the default panel).
    const stored = readStored();
    _open = stored ? stored.open : DEFAULT_OPEN.slice();
    _folded = stored ? stored.folded : [];
    if (_open.length === 0 && !isInfoPanelCollapsed()) { _open = DEFAULT_OPEN.slice(); _folded = []; }
    applySections();

    // Every other way of hiding/showing the info panel (Panel button, `I`,
    // View menu) flips the wrapper's class; follow it so the active icons
    // always match what is on screen, and never show an empty panel.
    const wrapper = document.getElementById(WRAPPER_ID);
    if (wrapper && typeof MutationObserver !== 'undefined') {
        new MutationObserver(function () {
            if (!isInfoPanelCollapsed() && _open.length === 0) {
                _open = DEFAULT_OPEN.slice();
                _folded = [];
                applySections();
                return;
            }
            syncPanelRail();
        }).observe(wrapper, { attributes: true, attributeFilter: ['class'] });
    }
}
