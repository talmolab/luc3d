/**
 * ui/connect/index.js — startup of SLEAP Connect (remote GPU workers).
 *
 * LUCID addition (sleap-app's AppShell wiring). `setupConnect()` (idempotent), loaded by ONE literal
 * `import()` in `pose/initialization.js`, configures the store (toasts, the lazily imported Connect window,
 * platform, version from `<meta name="lucid-release">`), installs storage sync, registers the desktop iroh
 * transport BEFORE anything can pair or dial, adds the rail panel, then `resumeTrackedJobs()` (like
 * sleap-app, nothing reconnects after a reload). Nothing touches the `.slp`.
 */
import {
    useConnectStore, configureConnect, installConnectStorageSync,
} from '../../pose/connect/store.js?v=82449baaa3c2';
import { registerPanelRailPanel, showPanelTab } from '../panel-rail.js?v=82449baaa3c2';
import { notify } from './notify.js?v=82449baaa3c2';
import { createConnectPanel } from './connect-panel.js?v=82449baaa3c2';
import { registerIrohSocketFactory, registerIrohBlobFetcher } from '../../pose/connect/transport.js?v=82449baaa3c2';
import { createIrohSocketFactory } from '../../pose/connect/iroh-socket.js?v=82449baaa3c2';
import { fetchBlobOverIroh } from '../../pose/connect/iroh-blob.js?v=82449baaa3c2';
import { releaseVersion } from './dom.js?v=82449baaa3c2';

const CONNECT_TAB_ID = 'tabConnect';

/**
 * Registers the iroh transport (socket factory + blob fetcher) over the desktop
 * shim's `iroh` object; a no-op without one (the web build). Exported for tests.
 * @param {{iroh?: object} | null | undefined} desktop `window.lucidDesktop`
 * @returns {boolean} whether iroh is now available
 */
function registerDesktopIroh(desktop) {
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
    return import('./connect-window.js?v=82449baaa3c2').then(
        function (m) { m.openConnectWindow(opts); },
        function (err) { console.warn('[connect] could not open the Connect window:', err); focusConnectPanel(); });
}

/** What the panel's button, the toasts' "Open" action and View > Connect Window call. */
export function openConnectWindow(opts) {
    return (_opener || focusConnectPanel)(opts);
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
