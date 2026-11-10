/**
 * ui/connect/worker-devices.js — "Devices with access" for one worker.
 *
 * Port of sleap-app src/components/connect/WorkerDevices.tsx @ 683a159: every device paired with a worker
 * (who can use it), with when it paired and was last seen, from the worker's `clients.list`. Read-only
 * except renaming THIS device (pencil -> box, Enter saves, Esc cancels, optimistic, then reloaded).
 * Removing devices is done on the worker (`sleap-connect clients`). Shown as a header button, "N devices
 * with access" ("Devices…" while loading, "Devices with access" when the list could not load), that opens a
 * popover. The list (`sortDevices`: this device first, then most recently seen), the error text
 * (`describeError`: "too old to list devices" for an unknown method) and the name limit (`DEVICE_NAME_MAX`)
 * are `pose/connect/worker-ui-helpers.js`; `devicesFor` / `setDeviceName` are the store's.
 *
 * LUCID changes: vanilla DOM; the popover (Radix in sleap-app) is a fixed panel under the button, right
 * aligned, closed by Esc (the rename box's Esc closes just the box), a click outside, or the window closing.
 * The worker records a device's version but not which app it is, so each row's second line is
 * "Browser" / "Desktop app" and the version; only THIS device's row names the client (`clientAgentLabel`,
 * "LUC3D <version>"), sleap-app wrote "sleap-app <version>" for every row.
 *
 * Contract (p5): `createWorkerDevicesButton(container, {workerId, workerLabel, refreshToken}) ->
 * {update(props), destroy()}`. Exports: createWorkerDevicesButton.
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { sortDevices, describeError, DEVICE_NAME_MAX, clientAgentLabel } from '../../pose/connect/worker-ui-helpers.js';
import { timeAgo } from '../../pose/connect/timestamp.js';
import { railIconSvg } from '../panel-rail-icons.js';
import { layerAbove } from './layers.js';

function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
}

function icon(name, cls) {
    const s = el('span', 'connect-icon' + (cls ? ' ' + cls : ''));
    s.innerHTML = railIconSvg(name);
    return s;
}

function releaseVersion() {
    const m = document.querySelector('meta[name="lucid-release"]');
    return (m && (m.getAttribute('content') || '').trim()) || 'dev';
}

/**
 * @param {HTMLElement} container
 * @param {{workerId: string, workerLabel: string, refreshToken?: number}} props
 */
export function createWorkerDevicesButton(container, props) {
    let p = props;
    let devices = null;
    let error = null;
    let open = false;
    let editing = false;
    let draft = '';
    let seq = 0;
    let popover = null;

    const btn = el('button', 'connect-btn connect-btn-outline cw-btn-sm cw-devices-btn');
    btn.type = 'button';
    btn.id = 'cwDevicesBtn';
    btn.setAttribute('aria-haspopup', 'dialog');
    btn.setAttribute('aria-expanded', 'false');
    container.appendChild(btn);

    function buttonLabel() {
        return devices === null
            ? (error ? 'Devices with access' : 'Devices…')
            : devices.length.toLocaleString('en-US') + ' device' + (devices.length === 1 ? '' : 's') + ' with access';
    }

    async function load() {
        const mine = ++seq;
        const workerId = p.workerId;
        try {
            const list = await useConnectStore.getState().devicesFor(workerId);
            if (mine !== seq) return;
            devices = list;
            error = null;
        } catch (err) {
            if (mine !== seq) return;
            error = describeError(err);
        }
        render();
    }

    function renderButton() {
        btn.replaceChildren(icon('users'), document.createTextNode(buttonLabel()));
    }

    async function rename(name) {
        // Optimistic: the list shows the new name right away.
        if (devices) devices = devices.map(function (d) { return d.you ? Object.assign({}, d, { name: name }) : d; });
        render();
        try { await useConnectStore.getState().setDeviceName(name); } catch (e) { /* load() shows the truth */ }
        void load();
    }

    function deviceRow(d) {
        const li = el('li', 'cw-dev');
        li.dataset.nodeId = d.nodeId;
        li.appendChild(icon(d.platform === 'web' ? 'globe' : 'laptop', 'cw-dev-icon'));
        const mid = el('div', 'cw-dev-mid');
        const top = el('div', 'cw-dev-top');
        if (editing && d.you) {
            const input = el('input', 'connect-input cw-dev-input');
            input.type = 'text';
            input.value = draft;
            input.maxLength = DEVICE_NAME_MAX;
            input.setAttribute('aria-label', 'Device name');
            input.addEventListener('input', function () { draft = input.value; });
            const save = function () {
                const name = draft.trim();
                editing = false;
                if (name && name !== d.name) void rename(name); else render();
            };
            input.addEventListener('keydown', function (e) {
                if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); save(); }
            });
            input.addEventListener('focus', function () { input.select(); });
            const ok = el('button', 'connect-icon-btn cw-dev-btn'); ok.type = 'button'; ok.setAttribute('aria-label', 'Save name'); ok.appendChild(icon('check'));
            ok.addEventListener('click', save);
            const no = el('button', 'connect-icon-btn cw-dev-btn'); no.type = 'button'; no.setAttribute('aria-label', 'Cancel rename'); no.appendChild(icon('x'));
            no.addEventListener('click', function () { editing = false; render(); });
            top.append(input, ok, no);
            setTimeout(function () { if (input.isConnected) input.focus(); }, 0);
        } else {
            top.appendChild(el('span', 'cw-dev-name' + (d.name ? '' : ' unnamed'), d.name == null ? 'Unnamed device' : d.name));
            if (d.you) {
                top.appendChild(el('span', 'cw-dev-you', 'This device'));
                const pen = el('button', 'connect-icon-btn cw-dev-btn');
                pen.type = 'button';
                pen.setAttribute('aria-label', 'Rename this device');
                pen.appendChild(icon('pencil'));
                pen.addEventListener('click', function () { draft = d.name || ''; editing = true; render(); });
                top.appendChild(pen);
            }
        }
        mid.appendChild(top);
        const kind = d.platform ? (d.platform === 'web' ? 'Browser' : 'Desktop app') : null;
        let line;
        if (!kind) line = 'Paired before devices were named';
        else if (d.you) line = kind + ' · ' + clientAgentLabel({ name: 'lucid', version: d.appVersion || releaseVersion() });
        else line = kind + (d.appVersion ? ' · ' + d.appVersion : '');
        mid.appendChild(el('div', 'cw-dev-sub', line));
        li.appendChild(mid);
        const times = el('div', 'cw-dev-times');
        times.appendChild(el('div', '', d.lastSeenAt ? 'seen ' + timeAgo(d.lastSeenAt) : 'never seen'));
        times.appendChild(el('div', '', d.pairedAt ? 'paired ' + timeAgo(d.pairedAt) : ''));
        li.appendChild(times);
        return li;
    }

    function renderPopover() {
        if (!popover) return;
        popover.replaceChildren();
        popover.appendChild(el('p', 'connect-caps cw-pop-title', 'Devices with access to ' + p.workerLabel));
        if (error && !devices) {
            popover.appendChild(el('p', 'cw-pop-text', error));
        } else if (devices) {
            const ul = el('ul', 'cw-dev-list');
            sortDevices(devices).forEach(function (d) { ul.appendChild(deviceRow(d)); });
            popover.appendChild(ul);
            const foot = el('p', 'cw-pop-foot', 'Every device paired with this worker can use it. To see them on the worker, run ');
            foot.appendChild(el('code', 'cw-mono', 'sleap-connect clients'));
            foot.appendChild(document.createTextNode('.'));
            popover.appendChild(foot);
        } else {
            popover.appendChild(el('p', 'cw-pop-text', 'Loading…'));
        }
    }

    function render() {
        renderButton();
        renderPopover();
    }

    function onKey(e) {
        if (e.key !== 'Escape' || layerAbove(popover)) return;
        e.preventDefault();
        e.stopPropagation();
        if (editing) { editing = false; render(); return; }
        setOpen(false, true);
    }
    function onDown(e) {
        if (popover && !popover.contains(e.target) && !btn.contains(e.target)) setOpen(false, false);
    }

    function place() {
        if (!popover) return;
        const r = btn.getBoundingClientRect();
        const w = Math.min(420, window.innerWidth - 16);
        popover.style.width = w + 'px';
        popover.style.left = Math.max(8, Math.min(r.right - w, window.innerWidth - w - 8)) + 'px';
        popover.style.top = (r.bottom + 6) + 'px';
    }

    function setOpen(next, restoreFocus) {
        if (next === open) return;
        open = next;
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        if (open) {
            popover = el('div', 'cw-popover');
            popover.setAttribute('role', 'dialog');
            popover.setAttribute('aria-label', 'Devices with access');
            popover.tabIndex = -1;
            document.body.appendChild(popover);
            renderPopover();
            place();
            popover.focus();   // Radix moves focus into its content on open
            document.addEventListener('keydown', onKey, true);
            document.addEventListener('pointerdown', onDown, true);
            window.addEventListener('resize', place);
            void load();
        } else {
            editing = false;
            document.removeEventListener('keydown', onKey, true);
            document.removeEventListener('pointerdown', onDown, true);
            window.removeEventListener('resize', place);
            if (popover) popover.remove();
            popover = null;
            if (restoreFocus) btn.focus();
        }
    }

    btn.addEventListener('click', function () { setOpen(!open, false); });

    function reset() {
        devices = null;
        error = null;
        editing = false;
        render();
        void load();
    }

    reset();

    return {
        update: function (next) {
            const changed = next.workerId !== p.workerId || next.refreshToken !== p.refreshToken;
            const workerChanged = next.workerId !== p.workerId;
            p = next;
            if (workerChanged) reset();
            else if (changed) reset();   // sleap-app: each refreshToken goes back to "Devices…" (list and error cleared) and reloads
            else render();
        },
        destroy: function () {
            seq++;
            setOpen(false, false);
            btn.remove();
        },
    };
}
