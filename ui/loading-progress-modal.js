/**
 * loading-progress-modal.js — generic progress panel for long-running
 * load operations.
 *
 * Reusable task API designed for both:
 *   - Per-camera video decoder loads (current caller: ui/sessions-panes.js
 *     switchSession + initial-load entry points in loading/session-loader.js,
 *     import-export/save-load.js, import-export/slp-import.js).
 *   - SLP project file parsing (PLANNED, NOT WIRED). The breadcrumb at
 *     import-export/slp-import.js:50 (handleLoadSlpFile) and similar
 *     points where SLP-parse phases would each be a task.
 *
 * Lifecycle: each top-level caller calls modal.reset() before its first
 * addTask() so a new load operation starts with a clean panel. Concurrent
 * loads from a single user click serialize naturally because session UI
 * defers via setTimeout.
 *
 * Bar model: weighted-monotonic per task. Mp4box ratio:1 lands at 90%,
 * leaving 10% reserved for the "first frame decoded + painted to canvas"
 * step that callers signal via completeTask(). The bar never resets at
 * a phase boundary; only the thumb color flips (red -> blue -> green).
 *   canplay  (Phase 2): 0–5%
 *   mp4box   (Phase 3): 5–90%
 *   complete (frame painted): 100%
 */

export class LoadingProgressModal {
    constructor(options = {}) {
        this.title = options.title || 'Loading';
        this.autoDismissMs = (typeof options.autoDismissMs === 'number') ? options.autoDismissMs : 500;
        this.minVisibleMs = (typeof options.minVisibleMs === 'number') ? options.minVisibleMs : 300;
        this.tasks = new Map(); // id -> { id, label, phase, ratio, status, error }
        this._nextId = 1;
        this.root = null;
        this._listEl = null;
        this._shownAt = 0;
        this._dismissTimer = null;
        this.dismissed = true;
    }

    addTask({ label } = {}) {
        // Cancel any pending auto-dismiss — adding a task means we're not done.
        // Without this, sequential loaders (handleLoadSlpFile, handleLoadVideos,
        // V3 project load) that completeTask between videos would schedule a
        // dismiss timer that fires mid-loop, removing the modal before later
        // rows can appear.
        if (this._dismissTimer) {
            clearTimeout(this._dismissTimer);
            this._dismissTimer = null;
        }
        const id = 't' + this._nextId++;
        const task = { id, label: label || id, phase: null, ratio: 0, status: 'pending', error: null };
        this.tasks.set(id, task);
        if (this.root && this._listEl) this._renderRow(task);
        return id;
    }

    updateTask(id, info) {
        const task = this.tasks.get(id);
        if (!task) return;
        if (info && typeof info.phase === 'string') task.phase = info.phase;
        if (info && typeof info.ratio === 'number') {
            task.ratio = Math.max(0, Math.min(1, info.ratio));
        }
        this._renderRow(task); // idempotent
    }

    completeTask(id) {
        const task = this.tasks.get(id);
        if (!task) return;
        task.status = 'complete';
        task.ratio = 1;
        this._renderRow(task);
        this._maybeAutoDismiss();
    }

    failTask(id, error) {
        const task = this.tasks.get(id);
        if (!task) return;
        task.status = 'error';
        task.error = error || new Error('Unknown error');
        this._renderRow(task);
        // Do NOT auto-dismiss on error.
    }

    show() {
        if (this.root) return; // idempotent
        if (typeof document === 'undefined' || !document.body) return; // graceful no-op when no DOM
        this._injectStyleOnce();
        this.root = document.createElement('div');
        this.root.className = 'lucid-loading-progress-modal';
        this.root.innerHTML = '<div class="lpm-header">' + this._escape(this.title) + '</div>';
        this._listEl = document.createElement('div');
        this._listEl.className = 'lpm-list';
        this.root.appendChild(this._listEl);
        document.body.appendChild(this.root);
        this._shownAt = Date.now();
        this.dismissed = false;
        // Render any tasks added before show().
        for (const task of this.tasks.values()) this._renderRow(task);
    }

    dismiss() {
        if (this._dismissTimer) {
            clearTimeout(this._dismissTimer);
            this._dismissTimer = null;
        }
        if (this.root && this.root.parentNode) {
            this.root.parentNode.removeChild(this.root);
        }
        this.root = null;
        this._listEl = null;
        // Clear cached row refs — without this, on the next show()/addTask
        // cycle _renderRow finds stale orphan rows in _rowMap (because
        // _nextId resets to 1 in reset(), so task IDs collide with the
        // previous load's IDs) and updates the dead nodes instead of
        // appending new rows to the fresh _listEl.
        if (this._rowMap) this._rowMap.clear();
        this.dismissed = true;
    }

    isOpen() {
        return !this.dismissed;
    }

    reset() {
        if (this._dismissTimer) {
            clearTimeout(this._dismissTimer);
            this._dismissTimer = null;
        }
        this.tasks.clear();
        this._nextId = 1;
        if (this._listEl) this._listEl.innerHTML = '';
        // Clear cached row refs (see comment in dismiss()).
        if (this._rowMap) this._rowMap.clear();
    }

    getTaskState(id) {
        const task = this.tasks.get(id);
        if (!task) return null;
        return { label: task.label, phase: task.phase, ratio: task.ratio, status: task.status, error: task.error };
    }

    // --- internals ---

    _renderRow(task) {
        if (!this._listEl) return;
        // Cache rows on a private map so we don't depend on host querySelector
        // capabilities (the Node test sandbox only supports tag-name selectors).
        if (!this._rowMap) this._rowMap = new Map();
        let row = this._rowMap.get(task.id) || null;
        if (!row && typeof this._listEl.querySelector === 'function') {
            row = this._listEl.querySelector('[data-task-id="' + task.id + '"]');
        }
        let labelEl, barWrap, bar;
        if (!row) {
            row = document.createElement('div');
            row.className = 'lpm-row';
            row.setAttribute('data-task-id', task.id);
            // Build children explicitly so we can keep direct refs without
            // depending on querySelector resolving class selectors.
            labelEl = document.createElement('div');
            labelEl.className = 'lpm-label';
            barWrap = document.createElement('div');
            barWrap.className = 'lpm-bar-wrap';
            barWrap.setAttribute('role', 'progressbar');
            barWrap.setAttribute('aria-valuemin', '0');
            barWrap.setAttribute('aria-valuemax', '100');
            bar = document.createElement('div');
            bar.className = 'lpm-bar';
            barWrap.appendChild(bar);
            row.appendChild(labelEl);
            row.appendChild(barWrap);
            row._lpmLabelEl = labelEl;
            row._lpmBarWrap = barWrap;
            row._lpmBar = bar;
            this._listEl.appendChild(row);
            this._rowMap.set(task.id, row);
        } else {
            labelEl = row._lpmLabelEl || (typeof row.querySelector === 'function' ? row.querySelector('.lpm-label') : null);
            barWrap = row._lpmBarWrap || (typeof row.querySelector === 'function' ? row.querySelector('.lpm-bar-wrap') : null);
            bar = row._lpmBar || (typeof row.querySelector === 'function' ? row.querySelector('.lpm-bar') : null);
        }
        if (labelEl) labelEl.textContent = task.label;
        // Weighted-monotonic display ratio. Phases reach 90% at mp4box
        // ratio:1; the final 10% is reserved for the caller's
        // completeTask() once the first frame has actually painted.
        let display = 0;
        if (task.status === 'complete') display = 1;
        else if (task.phase === 'canplay') display = 0.05 * (task.ratio || 0);
        else if (task.phase === 'mp4box') display = 0.05 + 0.85 * (task.ratio || 0);
        else display = 0;
        if (bar && bar.style) bar.style.width = (display * 100).toFixed(1) + '%';
        if (barWrap && typeof barWrap.setAttribute === 'function') {
            barWrap.setAttribute('aria-valuenow', String(Math.round(display * 100)));
        }
        // Phase color class.
        if (row.classList && typeof row.classList.remove === 'function') {
            row.classList.remove('lpm-phase-canplay', 'lpm-phase-mp4box', 'lpm-complete', 'lpm-error');
        }
        const addClass = (cls) => {
            if (row.classList && typeof row.classList.add === 'function') row.classList.add(cls);
            else if (typeof row.className === 'string' && row.className.indexOf(cls) < 0) row.className += ' ' + cls;
        };
        if (task.status === 'error') {
            addClass('lpm-error');
            const msg = (task.error && task.error.message) || String(task.error);
            row.title = msg;
            if (typeof row.setAttribute === 'function') row.setAttribute('aria-label', task.label + ' — error: ' + msg);
        } else if (task.status === 'complete') {
            addClass('lpm-complete');
            row.title = '';
        } else if (task.phase === 'mp4box') {
            addClass('lpm-phase-mp4box');
        } else if (task.phase === 'canplay') {
            addClass('lpm-phase-canplay');
        }
    }

    _maybeAutoDismiss() {
        // Only auto-dismiss if every task is complete (no errors, no pending).
        let allComplete = true;
        for (const task of this.tasks.values()) {
            if (task.status !== 'complete') { allComplete = false; break; }
        }
        if (!allComplete) return;
        if (this.tasks.size === 0) return; // no tasks, no auto-dismiss
        const elapsed = Date.now() - this._shownAt;
        const delay = Math.max(this.autoDismissMs, this.minVisibleMs - elapsed);
        if (this._dismissTimer) clearTimeout(this._dismissTimer);
        this._dismissTimer = setTimeout(() => this.dismiss(), Math.max(0, delay));
    }

    _injectStyleOnce() {
        if (typeof document === 'undefined') return;
        if (document.getElementById && document.getElementById('lucid-loading-progress-modal-style')) return;
        const target = document.head || document.body;
        if (!target || typeof target.appendChild !== 'function') return;
        const style = document.createElement('style');
        style.id = 'lucid-loading-progress-modal-style';
        style.textContent =
            '.lucid-loading-progress-modal { position: fixed; right: 16px; bottom: 16px; ' +
            '  z-index: 10000; background: rgba(22, 33, 62, 0.97); color: #e0e0e0; ' +
            '  border: 1px solid #2a2d5e; border-radius: 6px; padding: 12px 14px; ' +
            '  font-family: "SF Mono", "Fira Code", "Consolas", monospace; font-size: 12px; ' +
            '  min-width: 280px; max-width: 380px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); }' +
            '.lpm-header { font-weight: 600; color: #667eea; margin-bottom: 8px; }' +
            '.lpm-row { margin-bottom: 6px; }' +
            '.lpm-label { font-size: 11px; color: #c0c0c0; margin-bottom: 2px; ' +
            '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
            '.lpm-bar-wrap { height: 6px; background: rgba(255,255,255,0.08); border-radius: 3px; overflow: hidden; }' +
            '.lpm-bar { height: 100%; width: 0%; background: #667eea; transition: width 120ms linear; }' +
            '.lpm-phase-canplay .lpm-bar { background: #f56565; animation: lpm-pulse 1s ease-in-out infinite; }' +
            '.lpm-phase-mp4box .lpm-bar { background: #667eea; }' +
            '.lpm-complete .lpm-bar { background: #48bb78; }' +
            '.lpm-error .lpm-bar { background: #4a4a4a; }' +
            '@keyframes lpm-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }';
        target.appendChild(style);
    }

    _escape(s) {
        return String(s).replace(/[&<>"']/g, function (c) {
            return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
        });
    }
}

let _singleton = null;
export function getLoadingProgressModal(options) {
    if (!_singleton) _singleton = new LoadingProgressModal(options);
    return _singleton;
}
export function resetLoadingProgressModal() {
    if (_singleton) _singleton.dismiss();
    _singleton = null;
}
