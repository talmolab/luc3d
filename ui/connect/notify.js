/**
 * ui/connect/notify.js — the toast stack Connect reports through (`configureConnect({ notify })`).
 *
 * Stands in for sleap-app's `toast` (src/lib/notify.tsx + AppShell's sonner `<Toaster>` @ 683a159), with
 * sonner's defaults: 4 s, hover / hidden tab pauses all, same `id` replaces, 3 visible (older collapse,
 * never dropped), per-kind icon, action button OR copy button, close x top-left, "Clear all (n)" at 2+.
 *
 * LUCID changes:
 *  - vanilla DOM; not a modal (no scrim, no focus, ignores Esc), text selectable;
 *  - no notification history (LUCID has no Notifications panel).
 */
import { button, icon } from './dom.js';

const TOAST_MS = 4000;
const MAX_VISIBLE = 3;
const CONTAINER_ID = 'connectToasts';
const CLEAR_ID = 'connectToastsClear';
const KIND_ICON = { success: 'circle-check', error: 'circle-x', info: 'info' };

/** @type {Map<string, {el: HTMLElement, timer: any, remaining: number, started: number}>} insertion order = age */
const live = new Map();
let seq = 0;
let hovering = false;
let tabHidden = false;
let clearBtn = null;

function container() {
    let c = document.getElementById(CONTAINER_ID);
    if (!c) {
        c = document.createElement('div');
        c.id = CONTAINER_ID;
        c.className = 'connect-toasts';
        c.setAttribute('role', 'region');
        c.setAttribute('aria-label', 'Notifications');
        c.addEventListener('mouseenter', function () { hovering = true; sync(); });
        c.addEventListener('mouseleave', function () { hovering = false; sync(); });
        document.body.appendChild(c);
        if (typeof document.addEventListener === 'function') {
            document.addEventListener('visibilitychange', function () { tabHidden = document.hidden; sync(); });
        }
    }
    return c;
}

function stopClock(t) {
    if (t.timer === null) return;
    clearTimeout(t.timer);
    t.timer = null;
    t.remaining = Math.max(500, t.remaining - (Date.now() - t.started));
}

/** Show the newest MAX_VISIBLE toasts; run the clock of those only, and only while nothing pauses it. */
function sync() {
    const ids = Array.from(live.keys());
    if (ids.length === 0) hovering = false;   // the pointer's own toast vanished: no mouseleave will come
    const firstShown = Math.max(0, ids.length - MAX_VISIBLE);
    ids.forEach(function (id, i) {
        const t = live.get(id);
        const shown = i >= firstShown;
        t.el.hidden = !shown;
        if (shown && !hovering && !tabHidden) {
            if (t.timer === null) {
                t.started = Date.now();
                t.timer = setTimeout(function () { dismiss(id); }, t.remaining);
            }
        } else {
            stopClock(t);
        }
    });
    syncClearAll(ids.length);
}

function syncClearAll(count) {
    if (count < 2) {
        if (clearBtn) clearBtn.hidden = true;
        return;
    }
    if (!clearBtn) {
        clearBtn = button('connect-toasts-clear');
        clearBtn.id = CLEAR_ID;
        clearBtn.addEventListener('click', function () { dismissAll(); });
        document.body.appendChild(clearBtn);
    }
    clearBtn.hidden = false;
    clearBtn.textContent = '';
    clearBtn.append(icon('x'), 'Clear all (' + count.toLocaleString('en-US') + ')');
}

function dismiss(id) {
    const t = live.get(id);
    if (!t) return;
    clearTimeout(t.timer);
    live.delete(id);
    t.el.remove();
    sync();
}

function dismissAll() {
    Array.from(live.keys()).forEach(dismiss);
    hovering = false;
}

/**
 * @param {'success'|'error'|'info'} kind
 * @param {string} message
 * @param {{description?: string, id?: string, action?: {label: string, onClick: () => void}}} [opts]
 * @returns {string} the toast id
 */
function show(kind, message, opts) {
    if (typeof document === 'undefined') return '';
    opts = opts || {};
    const id = opts.id || ('t' + (++seq));
    if (live.has(id)) dismiss(id);

    const el = document.createElement('div');
    el.className = 'connect-toast connect-toast-' + kind;
    el.setAttribute('role', kind === 'error' ? 'alert' : 'status');
    el.dataset.toastId = id;

    const kindIcon = icon(KIND_ICON[kind] || 'info', 'connect-toast-kind');
    el.appendChild(kindIcon);

    const body = document.createElement('div');
    body.className = 'connect-toast-body';
    const title = document.createElement('div');
    title.className = 'connect-toast-title';
    title.textContent = message;
    body.appendChild(title);
    if (opts.description) {
        const d = document.createElement('div');
        d.className = 'connect-toast-desc';
        d.textContent = opts.description;
        body.appendChild(d);
    }
    el.appendChild(body);

    if (opts.action && opts.action.label) {
        const a = button('connect-toast-action', opts.action.label);
        a.addEventListener('click', function () {
            try { opts.action.onClick(); } catch (e) { console.error('[connect] toast action threw', e); }
            dismiss(id);
        });
        el.appendChild(a);
    } else {
        // sleap-app: `action: data.action ?? <CopyAction/>` — only a toast without an action gets Copy.
        const text = opts.description ? message + '\n' + opts.description : message;
        const copy = button('connect-toast-copy');
        copy.setAttribute('aria-label', 'Copy');
        copy.appendChild(icon('copy'));
        copy.addEventListener('click', function (e) {
            e.stopPropagation();
            try {
                const p = navigator.clipboard && navigator.clipboard.writeText(text);
                if (p && p.catch) p.catch(function () {});
            } catch (err) { /* clipboard unavailable */ }
            copy.textContent = '';
            copy.appendChild(icon('check', 'connect-ok'));
            setTimeout(function () { copy.textContent = ''; copy.appendChild(icon('copy')); }, 1500);
        });
        el.appendChild(copy);
    }

    const close = button('connect-toast-close');
    close.setAttribute('aria-label', 'Close');
    close.appendChild(icon('x'));
    close.addEventListener('click', function () { dismiss(id); });
    el.appendChild(close);

    container().appendChild(el);
    live.set(id, { el: el, timer: null, remaining: TOAST_MS, started: Date.now() });
    sync();
    return id;
}

/** The notifier handed to `configureConnect({ notify })`. */
export const notify = {
    success: function (m, o) { return show('success', m, o); },
    error: function (m, o) { return show('error', m, o); },
    info: function (m, o) { return show('info', m, o); },
    dismiss: dismiss,
    dismissAll: dismissAll,
};
