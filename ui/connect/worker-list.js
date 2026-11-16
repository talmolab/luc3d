/**
 * ui/connect/worker-list.js — the Connect window's left column: the paired workers.
 *
 * Port of sleap-app src/components/connect/WorkerList.tsx @ 683a159 (§4b.3): status dot, GPU specs line,
 * route, filter chips with counts, "+ Pair worker", the empty state, Re-pair / Forget. Selecting a card
 * changes only the window's pick (`onSelect`). Helpers: `pose/connect/worker-ui-helpers.js`.
 *
 * LUCID changes:
 *  - vanilla DOM from a store selector; Tailwind dot classes become `cw-dot-*`;
 *  - a repaint keeps focus on its card / chip; pairing forms survive repaints and `reset()` when hidden.
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { shallowEqual } from '../../pose/connect/mini-store.js';
import { classifyWorkerStatus, workerSpecsLine, WORKER_FILTERS } from '../../pose/connect/worker-ui-helpers.js';
import { transportLabel } from '../../pose/connect/transport.js';
import { createPairWorkerForm } from './pair-worker-form.js';
import { forgetWorkerWithConfirm } from './connect-panel.js';
import { el, button } from './dom.js';

/** sleap-app's Tailwind dot class (`bg-green-500`, …) as the Connect window's own class. */
function dotClassFor(tailwindClass) {
    const m = /bg-([a-z]+)-\d+/.exec(tailwindClass || '');
    return 'cw-dot cw-dot-' + (m ? m[1] : 'zinc');
}

/**
 * @param {HTMLElement} container
 * @param {{selectedId: string | null, onSelect: (id: string) => void}} props
 */
export function createWorkerList(container, props) {
    let p = props;
    let filter = 'all';
    let showPairForm = false;
    // The worker whose "Re-pair" form is showing: at most one at a time.
    let repairingId = null;
    const repairForms = new Map();

    const root = el('div', 'cw-wl');
    root.setAttribute('data-cw', 'worker-list');
    container.appendChild(root);

    const topForm = createPairWorkerForm({
        showCancel: true,
        onPaired: function () { setShowPairForm(false); },
        onCancel: function () { setShowPairForm(false); },
    });

    function setShowPairForm(v) {
        showPairForm = v;
        if (!v) topForm.reset();
        render();
    }

    function setRepairing(id) {
        if (repairingId && repairingId !== id) dropRepairForm(repairingId);
        repairingId = id;
        render();
    }

    function dropRepairForm(id) {
        const f = repairForms.get(id);
        if (f) { f.reset(); repairForms.delete(id); }
    }

    function repairForm(w, status) {
        let f = repairForms.get(w.nodeId);
        if (!f) {
            f = createPairWorkerForm({
                showCancel: true,
                onPaired: function () {
                    // A new identity is a new worker entry: the old (dead) one would otherwise linger
                    // alongside it. An unpaired worker re-pairs into its OWN entry: keep that.
                    if (status.identityMismatch) void useConnectStore.getState().forgetWorker(w.nodeId);
                    dropRepairForm(w.nodeId);
                    repairingId = null;
                    render();
                },
                onCancel: function () { dropRepairForm(w.nodeId); repairingId = null; render(); },
            });
            repairForms.set(w.nodeId, f);
        }
        return f;
    }

    function snapshot() {
        const s = useConnectStore.getState();
        return { pairedWorkers: s.pairedWorkers, connections: s.connections, workerErrors: s.workerErrors, workerInfo: s.workerInfo };
    }

    function render() {
        const active = document.activeElement;
        const focusKey = active && root.contains(active) ? active.getAttribute('data-fk') : null;
        const s = snapshot();
        const statuses = new Map();
        const counts = { idle: 0, busy: 0, offline: 0 };
        s.pairedWorkers.forEach(function (w) {
            const st = classifyWorkerStatus(s.connections[w.nodeId], s.workerErrors[w.nodeId], s.workerInfo[w.nodeId] && s.workerInfo[w.nodeId].busy, !!w.unpairedAt);
            statuses.set(w.nodeId, st);
            counts[st.bucket]++;
        });
        // A repair form whose worker is gone (forgotten) goes with it.
        if (repairingId && !s.pairedWorkers.some(function (w) { return w.nodeId === repairingId; })) { dropRepairForm(repairingId); repairingId = null; }

        // Detach the live forms first so replaceChildren does not destroy what they hold.
        root.replaceChildren();
        const head = el('div', 'cw-wl-head');
        head.appendChild(el('span', 'connect-caps', 'Paired workers (' + s.pairedWorkers.length + ')'));
        const pairBtn = button('connect-btn connect-btn-outline cw-btn-xs', '+ Pair worker');
        pairBtn.id = 'cwPairWorker';
        pairBtn.setAttribute('data-fk', 'pair');
        pairBtn.addEventListener('click', function () { setShowPairForm(!showPairForm); });
        head.appendChild(pairBtn);
        root.appendChild(head);

        if (showPairForm) root.appendChild(topForm.el);

        if (s.pairedWorkers.length === 0) {
            const empty = el('div', 'cw-wl-empty');
            empty.id = 'cwNoWorkers';
            empty.appendChild(el('p', '', 'No workers paired yet. On the machine you want to train/infer on, in your data folder:'));
            empty.appendChild(el('code', 'connect-code cw-block', 'sleap-connect serve'));
            const p2 = el('p', '', 'Then paste the pairing code it prints below (for a new one: ');
            p2.appendChild(el('code', 'cw-mono', 'sleap-connect pair'));
            p2.appendChild(document.createTextNode(').'));
            empty.appendChild(p2);
            root.appendChild(empty);
        } else {
            const chips = el('div', 'cw-chips');
            WORKER_FILTERS.forEach(function (f) {
                const b = button('cw-chip' + (filter === f.key ? ' on' : ''),
                    f.label + ' (' + (f.key === 'all' ? s.pairedWorkers.length : counts[f.key]) + ')');
                b.setAttribute('data-filter', f.key);
                b.setAttribute('data-fk', 'f:' + f.key);
                b.setAttribute('aria-pressed', filter === f.key ? 'true' : 'false');
                b.addEventListener('click', function () { filter = f.key; render(); });
                chips.appendChild(b);
            });
            root.appendChild(chips);

            const list = el('div', 'cw-wl-cards');
            s.pairedWorkers.filter(function (w) {
                return filter === 'all' || statuses.get(w.nodeId).bucket === filter;
            }).forEach(function (w) { list.appendChild(card(w, statuses.get(w.nodeId), s)); });
            root.appendChild(list);
        }

        if (focusKey) {
            const target = root.querySelector('[data-fk="' + (window.CSS && CSS.escape ? CSS.escape(focusKey) : focusKey) + '"]');
            if (target) target.focus();
        } else if (active && active.isConnected && root.contains(active) && document.activeElement !== active) {
            // A pairing form's own box (kept alive across repaints): moving it dropped the focus.
            const a = /** @type {HTMLInputElement} */ (active);
            const start = a.selectionStart, end = a.selectionEnd;
            a.focus();
            try { if (start != null) a.setSelectionRange(start, end); } catch (e) { /* not a text box */ }
        }
    }

    function card(w, status, s) {
        const wrap = el('div', 'cw-wl-item');
        const specs = workerSpecsLine(s.workerInfo[w.nodeId]);
        const route = s.connections[w.nodeId] && s.connections[w.nodeId].route;
        const isSelected = p.selectedId === w.nodeId;

        const btn = button('cw-wcard' + (isSelected ? ' selected' : ''));
        btn.dataset.nodeId = w.nodeId;
        btn.setAttribute('data-fk', 'w:' + w.nodeId);
        btn.setAttribute('aria-pressed', isSelected ? 'true' : 'false');
        btn.addEventListener('click', function () { p.onSelect(w.nodeId); });
        const row = el('div', 'cw-wcard-row');
        row.appendChild(el('span', dotClassFor(status.dotClass)));
        row.appendChild(el('span', 'cw-wcard-name', w.label));
        row.appendChild(el('span', 'cw-wcard-status', status.label));
        btn.appendChild(row);
        if (specs) btn.appendChild(el('div', 'cw-wcard-specs', specs));
        if (route && status.bucket !== 'offline') btn.appendChild(el('div', 'cw-wcard-via', 'via ' + transportLabel(route)));
        wrap.appendChild(btn);

        if (status.identityMismatch && repairingId !== w.nodeId) {
            const note = el('div', 'cw-wl-note cw-wl-note-row');
            note.appendChild(el('span', '', w.label + ' has a new identity.'));
            const b = button('connect-btn connect-btn-outline cw-btn-xs cw-btn-xxs', 'Re-pair');
            b.setAttribute('data-fk', 'r:' + w.nodeId);
            b.addEventListener('click', function () { setRepairing(w.nodeId); });
            note.appendChild(b);
            wrap.appendChild(note);
        }
        if (status.unpaired && repairingId !== w.nodeId) {
            const note = el('div', 'cw-wl-note');
            const msg = el('p', '', 'This device was unpaired by ' + w.label + '. Ask for a new code (');
            msg.appendChild(el('code', 'cw-mono', 'sleap-connect pair'));
            msg.appendChild(document.createTextNode(') to use it again.'));
            note.appendChild(msg);
            const acts = el('div', 'cw-wl-note-row');
            const re = button('connect-btn connect-btn-outline cw-btn-xs cw-btn-xxs', 'Re-pair');
            re.setAttribute('data-fk', 'r:' + w.nodeId);
            re.addEventListener('click', function () { setRepairing(w.nodeId); });
            const fg = button('connect-btn connect-btn-ghost cw-btn-xs cw-btn-xxs cw-muted', 'Forget');
            fg.setAttribute('data-fk', 'g:' + w.nodeId);
            fg.addEventListener('click', function () { void forgetWorkerWithConfirm(w.nodeId); });
            acts.append(re, fg);
            note.appendChild(acts);
            wrap.appendChild(note);
        }
        if (repairingId === w.nodeId) wrap.appendChild(repairForm(w, status).el);
        return wrap;
    }

    const unsub = useConnectStore.subscribeSelector(snapshot, render, shallowEqual);
    render();

    return {
        update: function (next) { p = next; render(); },
        destroy: function () {
            unsub();
            topForm.reset();
            repairForms.forEach(function (f) { f.reset(); });
            repairForms.clear();
            root.remove();
        },
    };
}
