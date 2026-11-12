/**
 * ui/connect/worker-queue.js — the queue cards of the Connect window's sidebar.
 *
 * Port of sleap-app src/components/connect/WorkerQueue.tsx @ 683a159: failed run(s) first, then running,
 * then queued, a row per model with the Jobs tab's badges (+ "After training"). A click opens the run in
 * the Jobs tab; a right-click offers Open in Jobs / Stop Early / Cancel run. Pure parts: `job-groups.js`
 * (re-exported under WorkerQueue.tsx's names).
 *
 * LUCID changes:
 *  - the context menu is a small menu at the pointer (Esc closes just it, arrows move, menu key opens it);
 *  - Tailwind chip classes become `cw-chip-*` (styled exactly as the Jobs tab's `cj-chip-*`).
 */
import { isActiveGroup, unfinishedJobs, cancelRunConfirm, queueRows, queueRunEntries } from '../../pose/connect/job-groups.js';
import { layerAbove } from './layers.js';
import { el, button } from './dom.js';

export { isActiveGroup, unfinishedJobs, cancelRunConfirm, queueRows, queueRunEntries };

/** sleap-app's Tailwind badge class string (job-groups.js `CHIP_STYLES`, "After training") as a `cw-chip-*` class. */
function chipClassFor(tailwindClass) {
    const c = tailwindClass || '';
    const kind = c.includes('orange') ? 'running' : c.includes('green') ? 'completed' : c.includes('red') ? 'failed'
        : c.includes('text-zinc-400') ? 'muted' : 'queued';
    return 'cw-chip-badge cw-chip-' + kind;
}

// ------------------------------------------------------------------ context menu

let openMenu = null;

function closeMenu() {
    if (!openMenu) return;
    const m = openMenu;
    openMenu = null;
    document.removeEventListener('keydown', m.onKey, true);
    document.removeEventListener('pointerdown', m.onDown, true);
    window.removeEventListener('blur', m.close);
    m.el.remove();
    if (m.returnFocus && m.returnFocus.isConnected) m.returnFocus.focus();
}

/**
 * A context menu at (x, y). `items`: `{label, onSelect, destructive?, disabled?}`.
 * Esc closes it alone (the Connect window stays open).
 */
function openContextMenu(x, y, items, returnFocus) {
    closeMenu();
    const menu = el('div', 'cw-menu');
    menu.setAttribute('role', 'menu');
    const buttons = items.map(function (it) {
        const b = button('cw-menu-item' + (it.destructive ? ' destructive' : ''), it.label);
        b.setAttribute('role', 'menuitem');
        b.disabled = !!it.disabled;
        b.addEventListener('click', function () { closeMenu(); if (!it.disabled) it.onSelect(); });
        menu.appendChild(b);
        return b;
    });
    document.body.appendChild(menu);
    const r = menu.getBoundingClientRect();
    menu.style.left = Math.max(4, Math.min(x, window.innerWidth - r.width - 4)) + 'px';
    menu.style.top = Math.max(4, Math.min(y, window.innerHeight - r.height - 4)) + 'px';

    function onKey(e) {
        if (layerAbove(menu)) return;
        const enabled = buttons.filter(function (b) { return !b.disabled; });
        if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); closeMenu(); return; }
        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
            e.preventDefault(); e.stopPropagation();
            const i = enabled.indexOf(document.activeElement);
            const n = enabled.length;
            if (n) enabled[(i + (e.key === 'ArrowDown' ? 1 : -1) + n) % n].focus();
            return;
        }
        if (e.key === 'Tab') { e.preventDefault(); e.stopPropagation(); return; }
    }
    function onDown(e) { if (!menu.contains(e.target)) closeMenu(); }
    document.addEventListener('keydown', onKey, true);
    document.addEventListener('pointerdown', onDown, true);
    window.addEventListener('blur', closeMenu);
    openMenu = { el: menu, onKey: onKey, onDown: onDown, close: closeMenu, returnFocus: returnFocus };
    const first = buttons.find(function (b) { return !b.disabled; });
    if (first) first.focus();
    return closeMenu;
}

// ------------------------------------------------------------------ the list

/**
 * @param {HTMLElement} container
 * @param {{
 *   entries: Array<import('../../pose/connect/job-groups.js').QueueRunEntry>,
 *   canManage: (group: any) => boolean,
 *   onOpen: (entry: any) => void,
 *   onStopEarly: (job: any) => void,
 *   onCancelRun: (group: any) => void,
 * }} props
 */
export function createQueueRunList(container, props) {
    let p = props;
    const root = el('div', 'cw-queue-list');
    root.setAttribute('data-cw', 'queue-list');
    container.appendChild(root);

    function menuFor(entry, x, y, returnFocus) {
        const { group, status } = entry;
        const manage = p.canManage(group);
        const runningTrain = group.jobs.find(function (j) { return j.state === 'running' && j.kind !== 'track'; });
        const items = [{
            label: status === 'failed' ? 'Open in Jobs and clear' : 'Open in Jobs',
            onSelect: function () { p.onOpen(entry); },
        }];
        if (manage && runningTrain) {
            items.push({
                label: 'Stop Early (' + (runningTrain.modelTypes[0] || 'model') + ')',
                onSelect: function () { p.onStopEarly(runningTrain); },
            });
        }
        if (manage && status !== 'failed') {
            items.push({ label: 'Cancel run', destructive: true, onSelect: function () { p.onCancelRun(group); } });
        }
        if (!manage && status !== 'failed') {
            items.push({ label: "View only (another project's run)", disabled: true, onSelect: function () {} });
        }
        openContextMenu(x, y, items, returnFocus);
    }

    function render() {
        const active = document.activeElement;
        const focusKey = active && root.contains(active) ? active.getAttribute('data-fk') : null;
        root.replaceChildren();
        if (p.entries.length === 0) {
            root.appendChild(el('p', 'cw-queue-empty', 'Nothing running or queued.'));
            return;
        }
        const ol = el('ol', 'cw-queue-runs');
        p.entries.forEach(function (entry) {
            const { group, status, place, rows } = entry;
            const failure = (group.jobs.find(function (j) { return j.state === 'failed'; }) || {}).error;
            const failureLine = failure ? String(failure).split('\n')[0] : undefined;
            const li = el('li', 'cw-qcard cw-qcard-' + status);
            li.setAttribute('role', 'button');
            li.tabIndex = 0;
            li.dataset.runKey = group.key;
            li.dataset.status = status;
            li.setAttribute('data-fk', 'q:' + group.key);
            li.setAttribute('aria-label', group.title + ': open in Jobs');
            li.title = status === 'failed' ? 'Open in Jobs (and clear from the queue)' : 'Open in Jobs';
            li.addEventListener('click', function () { p.onOpen(entry); });
            li.addEventListener('keydown', function (e) {
                if (e.target !== li) return;
                if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); p.onOpen(entry); }
            });
            li.addEventListener('contextmenu', function (e) {
                e.preventDefault();
                // The keyboard menu key reports (0, 0): open it at the card.
                const r = li.getBoundingClientRect();
                const atCard = e.clientX === 0 && e.clientY === 0;
                menuFor(entry, atCard ? r.left + 24 : e.clientX, atCard ? r.top + 24 : e.clientY, li);
            });

            const head = el('div', 'cw-qcard-head');
            head.appendChild(el('span', 'cw-qmark', status === 'running' ? '▶' : status === 'failed' ? '✕' : '#' + place));
            if (group.mine) head.appendChild(el('span', 'cw-qstar', '★'));
            const title = el('span', 'cw-qtitle', group.title);
            title.title = group.title;
            head.appendChild(title);
            li.appendChild(head);

            li.appendChild(el('div', 'cw-qsub',
                (group.labelsName || '—') + (group.mine ? '' : ' · ' + (group.project && group.project.name ? 'from ' + group.project.name : 'other project'))));

            const ul = el('ul', 'cw-qrows');
            rows.forEach(function (row) {
                const r = el('li', 'cw-qrow' + (row.active ? ' active' : ''));
                r.appendChild(el('span', 'cw-qrow-title', row.title));
                r.appendChild(el('span', chipClassFor(row.chip.className), row.chip.text));
                ul.appendChild(r);
            });
            li.appendChild(ul);

            if (status === 'failed') {
                const f = el('p', 'cw-qfail', failureLine || 'Failed');
                f.title = failureLine || '';
                li.appendChild(f);
            }
            ol.appendChild(li);
        });
        root.appendChild(ol);
        if (focusKey) {
            const t = Array.prototype.find.call(root.querySelectorAll('[data-fk]'), function (n) { return n.getAttribute('data-fk') === focusKey; });
            if (t) t.focus();
        }
    }

    render();
    return {
        update: function (next) { p = next; render(); },
        destroy: function () { closeMenu(); root.remove(); },
    };
}
