/**
 * ui/connect/index.js — startup of SLEAP Connect (remote GPU workers).
 *
 * `setupConnect()` (idempotent) is what `pose/initialization.js` calls after
 * the panel rail exists, through ONE literal dynamic `import()` (so cold start
 * is unchanged and `scripts/stamp-version.mjs` stamps it), in the web app and
 * the desktop app alike. It:
 *   1. `configureConnect({ notify, openConnectWindow, platform, appVersion })`
 *      — the toast stack (`ui/connect/notify.js`), the Connect window opener
 *      (`setConnectWindowOpener`; until that window exists it only brings the
 *      Connect panel to the front), 'desktop' when `window.lucidDesktop`
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
 * HOOK (P8): register the iroh socket factory
 * (`registerIrohSocketFactory`, `pose/connect/transport.js`) at the marked
 * line BEFORE `resumeTrackedJobs()` — it must exist before the first connect.
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

export const CONNECT_TAB_ID = 'tabConnect';

let _setUp = false;
let _panel = null;
let _opener = null;

/** Default opener: bring the Connect panel to the front. */
function focusConnectPanel() {
    showPanelTab(CONNECT_TAB_ID);
}

/** The Connect window (a later phase) replaces what "Open Connect window" does. `null` restores the default. */
export function setConnectWindowOpener(fn) {
    _opener = typeof fn === 'function' ? fn : null;
}

function openConnectWindow() {
    (_opener || focusConnectPanel)();
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

    configureConnect({
        notify: notify,
        openConnectWindow: openConnectWindow,
        platform: window.lucidDesktop ? 'desktop' : 'web',
        appVersion: releaseVersion(),
    });
    installConnectStorageSync(window);

    _panel = createConnectPanel({ openConnectWindow: openConnectWindow });
    const pane = document.createElement('div');
    pane.className = 'connect-pane';
    pane.appendChild(_panel.el);
    registerPanelRailPanel({ tab: CONNECT_TAB_ID, label: 'Connect', icon: 'globe' }, pane);

    // P8 HOOK: registerIrohSocketFactory(...) goes here, before the first connect below.

    const store = useConnectStore.getState();
    Promise.resolve(store.resumeTrackedJobs()).catch(function (e) {
        console.warn('[connect] resumeTrackedJobs failed:', e);
    });
    window.addEventListener('pagehide', function () {
        try { useConnectStore.getState().releaseIdleConnections(); } catch (e) { /* closing anyway */ }
    });
    return true;
}
