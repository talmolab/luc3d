/**
 * ui/connect/worker-data-access.js — the Connect window's Data access tab.
 *
 * Port of sleap-app src/components/connect/WorkerDataAccess.tsx @ 683a159
 * (§4b.5): the worker's configured mounts (read-only, from `fs.mounts`, with a
 * Browse files button that opens the look-only worker file browser) and this
 * worker's remembered local<->worker path rules (the Locate-on-worker
 * overrides), each with Clear. There is no mapping editor: rules are only
 * created by browsing elsewhere ("Locate on worker…", the store's
 * `addPathRule`). Every string is sleap-app's.
 *
 * LUCID changes: vanilla DOM factory (`createWorkerDataAccess(container,
 * {workerId, refreshToken})` -> `{update(props), destroy()}`) instead of a React
 * component; `update` with a changed `workerId` or a bumped `refreshToken`
 * re-fetches the mounts, anything else repaints from the store; the rule list
 * follows the store (`subscribeSelector` on the worker's `pathRules`), so Clear
 * re-renders at once.
 *
 * Used by `ui/connect/connect-window.js`.
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { isWorkerPath } from '../../pose/connect/path-mappings.js';
import { openRemoteFileBrowser } from './remote-file-browser.js';
import { railIconSvg } from '../panel-rail-icons.js';

const NO_PATH_RULES = [];

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

/**
 * @param {HTMLElement} container
 * @param {{workerId: string, refreshToken?: number}} props
 * @returns {{update: (props: {workerId: string, refreshToken?: number}) => void, destroy: () => void}}
 */
export function createWorkerDataAccess(container, props) {
    let workerId = props.workerId;
    let refreshToken = props.refreshToken || 0;
    let mounts = [];
    let loading = true;
    let error = null;
    let fetchSeq = 0;
    let destroyed = false;

    const root = el('div', 'cda');
    root.id = 'connectDataAccess';
    container.appendChild(root);

    // ---- mounts section (built once, repainted by `paint`) ----
    const mountsBox = el('div', 'cda-section');
    const mountsHead = el('div', 'cda-head');
    mountsHead.appendChild(el('p', 'cda-caps', 'Folders this worker shares (where it was started, plus sleap-connect add-folder)'));
    const browse = el('button', 'btn btn-sm cda-btn cda-browse');
    browse.type = 'button'; browse.id = 'cdaBrowse';
    const bIcon = el('span', 'cda-icon'); bIcon.innerHTML = railIconSvg('folder-open');
    browse.append(bIcon, ' Browse files');
    browse.addEventListener('click', function () {
        void openRemoteFileBrowser({
            workerId: workerId, mounts: mounts.map(function (m) { return m.path; }), mountLabels: mountLabels(), mode: 'browse',
        });
    });
    mountsHead.appendChild(browse);
    const mountsErr = el('p', 'cda-error'); mountsErr.id = 'cdaError';
    const mountsList = el('div', 'cda-list'); mountsList.id = 'cdaMounts';
    mountsBox.append(mountsHead, mountsErr, mountsList);

    // ---- remembered locations ----
    const rulesBox = el('div', 'cda-section');
    rulesBox.appendChild(el('p', 'cda-caps', 'Remembered locations — learned when you use "Locate on worker…"'));
    const rulesList = el('div', 'cda-list'); rulesList.id = 'cdaRules';
    rulesBox.appendChild(rulesList);
    root.append(mountsBox, rulesBox);

    function mountLabels() {
        const o = {};
        mounts.forEach(function (m) { if (m.label) o[m.path] = m.label; });
        return o;
    }

    function rules() {
        const w = useConnectStore.getState().pairedWorkers.find(function (x) { return x.nodeId === workerId; });
        return (w && w.pathRules) || NO_PATH_RULES;
    }

    function paintMounts() {
        browse.disabled = loading || mounts.length === 0;
        mountsErr.textContent = error || ''; mountsErr.hidden = !error;
        mountsList.textContent = '';
        if (loading) { mountsList.appendChild(el('p', 'cda-muted', 'Loading…')); return; }
        if (mounts.length === 0) { mountsList.appendChild(el('p', 'cda-muted', 'No mounts configured.')); return; }
        mounts.forEach(function (m) {
            const row = el('div', 'cda-mount');
            row.appendChild(el('span', 'cda-mount-path', m.path));
            if (m.label) row.appendChild(el('span', 'cda-muted cda-mount-label', m.label));
            mountsList.appendChild(row);
        });
    }

    function paintRules() {
        const list = rules();
        rulesList.textContent = '';
        if (list.length === 0) { rulesList.appendChild(el('p', 'cda-muted', 'None yet.')); return; }
        list.forEach(function (rule) {
            const row = el('div', 'cda-rule');
            const body = el('div', 'cda-rule-body');
            // Both sides on their own wrapping line: a single truncated "local -> worker" line hid the worker side.
            const l1 = el('div', 'cda-rule-line');
            l1.append(el('span', 'cda-rule-key', 'This computer'), el('span', 'cda-rule-val', rule.local));
            const l2 = el('div', 'cda-rule-line');
            l2.append(el('span', 'cda-rule-key', 'Worker'), el('span', 'cda-rule-val', rule.worker));
            body.append(l1, l2);
            if (!loading && !error && !isWorkerPath(rule.worker, mounts.map(function (m) { return m.path; }))) {
                const warn = el('p', 'cda-warn', 'Not in a shared folder: fine for videos; labels, configs or models there are refused.');
                warn.title = 'Videos there still work. Labels, configs or models there will be refused by the worker.';
                body.appendChild(warn);
            }
            const clear = el('button', 'btn btn-sm cda-btn cda-clear', 'Clear');
            clear.type = 'button';
            clear.addEventListener('click', function () { useConnectStore.getState().clearPathRule(workerId, rule.local); });
            row.append(body, clear);
            rulesList.appendChild(row);
        });
    }

    function paint() { paintMounts(); paintRules(); }

    async function fetchMounts() {
        const seq = ++fetchSeq;
        loading = true; mounts = []; error = null;
        paint();
        try {
            const client = await useConnectStore.getState().clientFor(workerId);
            const result = await client.fsMounts();
            if (seq === fetchSeq && !destroyed) mounts = result;
        } catch (err) {
            if (seq === fetchSeq && !destroyed) error = err instanceof Error ? err.message : String(err);
        } finally {
            if (seq === fetchSeq && !destroyed) { loading = false; paint(); }
        }
    }

    // A reactive selector on this worker's rules: Clear (or a Locate elsewhere) repaints the list at once.
    const unsubscribe = useConnectStore.subscribeSelector(function (s) {
        const w = s.pairedWorkers.find(function (x) { return x.nodeId === workerId; });
        return (w && w.pathRules) || NO_PATH_RULES;
    }, function () { if (!destroyed) paintRules(); });

    paint();
    void fetchMounts();

    return {
        update: function (next) {
            const idChanged = next.workerId !== workerId;
            const tokenChanged = (next.refreshToken || 0) !== refreshToken;
            workerId = next.workerId;
            refreshToken = next.refreshToken || 0;
            if (idChanged || tokenChanged) void fetchMounts(); else paint();
        },
        destroy: function () {
            destroyed = true;
            fetchSeq++;
            unsubscribe();
            root.remove();
        },
    };
}
