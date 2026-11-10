/**
 * ui/connect/index.js — startup of SLEAP Connect (remote GPU workers).
 *
 * `setupConnect()` (idempotent) is what `pose/initialization.js` calls after
 * the panel rail exists, through ONE literal dynamic `import()` (so cold start
 * is unchanged and `scripts/stamp-version.mjs` stamps it), in the web app and
 * the desktop app alike. It:
 *   1. `configureConnect({ notify, openConnectWindow, platform, appVersion })`
 *      — the toast stack (`ui/connect/notify.js`), the Connect window opener
 *      (`setConnectWindowOpener(openConnectWindowLazy)`: the window,
 *      `ui/connect/connect-window.js`, is imported on first open; the Connect
 *      panel comes to the front if that fails), 'desktop' when `window.lucidDesktop`
 *      exists else 'web', and the version from `<meta name="lucid-release">`
 *      ('dev' when empty). The desktop shim exposes no computer name
 *      (`system_info` has none), so `computerName` is omitted and the device
 *      falls back to "<Browser> on <OS>".
 *   2. `installConnectStorageSync(window)` (another window's pairing shows up
 *      here), `resumeTrackedJobs()` once, `releaseIdleConnections()` on
 *      `pagehide`.
 *   3. registers the rail panel (`tabConnect`, label "Connect", Lucide `globe`).
 *
 * After a reload sleap-app does NOT reconnect (matched here): the window's
 * selected worker comes back from sessionStorage (the store's hydrate), but
 * `connectionStatus` stays idle until the user presses Connect; the only
 * startup network work is `resumeTrackedJobs()` (AppShell.tsx's mount effect,
 * which dials workers that have an active job).
 *
 * iroh (desktop only): when `window.lucidDesktop.iroh` exists (the shim over the
 * `iroh_*` commands, `src-tauri/src/iroh_client.rs`) the iroh socket factory and
 * blob fetcher are registered BEFORE `resumeTrackedJobs()` — they must exist
 * before the first connect, since a relay-only code pairs over iroh and a
 * dropped WebSocket falls back to it. The web build never has one, so it stays
 * ws-only.
 *
 * Nothing here touches the `.slp`: pairing and keys live in localStorage /
 * IndexedDB (`lucid-connect`).
 */
import {
    useConnectStore, configureConnect, installConnectStorageSync,
} from '../../pose/connect/store.js';
import { registerPanelRailPanel, showPanelTab } from '../panel-rail.js';
import { notify } from './notify.js';
import { createConnectPanel } from './connect-panel.js';
import { registerIrohSocketFactory, registerIrohBlobFetcher } from '../../pose/connect/transport.js';
import { createIrohSocketFactory } from '../../pose/connect/iroh-socket.js';
import { fetchBlobOverIroh } from '../../pose/connect/iroh-blob.js';

export const CONNECT_TAB_ID = 'tabConnect';

/**
 * Registers the iroh transport (socket factory + blob fetcher) over the desktop
 * shim's `iroh` object; a no-op without one (the web build). Exported for tests.
 * @param {{iroh?: object} | null | undefined} desktop `window.lucidDesktop`
 * @returns {boolean} whether iroh is now available
 */
export function registerDesktopIroh(desktop) {
    const iroh = desktop && desktop.iroh;
    if (!iroh || typeof iroh.connect !== 'function') return false;
    registerIrohSocketFactory(createIrohSocketFactory(function () { return iroh; }));
    registerIrohBlobFetcher(function (connId, ref, options) {
        return fetchBlobOverIroh(function () { return iroh; }, connId, ref.sha256, ref.size, options);
    });
    return true;
}

let _setUp = false;
let _panel = null;
let _opener = null;

/** Default opener: bring the Connect panel to the front. */
function focusConnectPanel() {
    showPanelTab(CONNECT_TAB_ID);
}

/** Replaces what "Open Connect window" does. `null` restores the default (bring the Connect panel to the front). */
export function setConnectWindowOpener(fn) {
    _opener = typeof fn === 'function' ? fn : null;
}

/**
 * The Connect window (`ui/connect/connect-window.js`), loaded on first use through ONE literal dynamic
 * `import()` so cold start is unchanged. Falls back to the panel if the module cannot load.
 * @param {{workerId?: string}} [opts]
 */
function openConnectWindowLazy(opts) {
    return import('./connect-window.js').then(
        function (m) { m.openConnectWindow(opts); },
        function (err) { console.warn('[connect] could not open the Connect window:', err); focusConnectPanel(); });
}

/** What the panel's button, the toasts' "Open" action and View > Connect Window call. */
export function openConnectWindow(opts) {
    return (_opener || focusConnectPanel)(opts);
}

function releaseVersion() {
    const m = document.querySelector('meta[name="lucid-release"]');
    const v = m ? (m.getAttribute('content') || '').trim() : '';
    return v || 'dev';
}

/** @returns {boolean} whether this call did the setup (false = already set up). */
export function setupConnect() {
    if (_setUp) return false;
    _setUp = true;

    setConnectWindowOpener(openConnectWindowLazy);
    configureConnect({
        notify: notify,
        openConnectWindow: openConnectWindow,
        platform: window.lucidDesktop ? 'desktop' : 'web',
        appVersion: releaseVersion(),
    });
    installConnectStorageSync(window);

    // Before anything can plan or dial a pairing (the panel's form asks whether iroh exists).
    registerDesktopIroh(window.lucidDesktop);

    _panel = createConnectPanel({ openConnectWindow: openConnectWindow });
    const pane = document.createElement('div');
    pane.className = 'connect-pane';
    pane.appendChild(_panel.el);
    registerPanelRailPanel({ tab: CONNECT_TAB_ID, label: 'Connect', icon: 'globe' }, pane);


    const store = useConnectStore.getState();
    Promise.resolve(store.resumeTrackedJobs()).catch(function (e) {
        console.warn('[connect] resumeTrackedJobs failed:', e);
    });
    window.addEventListener('pagehide', function () {
        try { useConnectStore.getState().releaseIdleConnections(); } catch (e) { /* closing anyway */ }
    });
    return true;
}
