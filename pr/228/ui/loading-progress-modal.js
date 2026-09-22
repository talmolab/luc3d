/**
 * loading-progress-modal.js — generic progress panel for long-running
 * load operations.
 *
 * Reusable task API designed for both:
 *   - Per-camera video decoder loads (current caller: ui/sessions-panes.js
 *     switchSession + initial-load entry points in loading/session-loader.js,
 *     import-export/save-load.js, import-export/slp-import.js).
 *   - SLP project file parsing. The handleLoadSlpFile / importSlpProjectWithProgress
 *     flow at import-export/slp-import.js uses the two-level (session group +
 *     child tasks) API below.
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
 *
 * Two-level (session-group) API: addSessionGroup() + addTaskToSession()
 * gives the SLP-project-import flow a parent-row-per-session presentation.
 * Each group cycles pending -> loading -> complete (or error). Only the
 * "current" group expands its child rows; pending/complete groups show
 * just the header row.
 */

export class LoadingProgressModal {
    constructor(options = {}) {
        this.title = options.title || 'Loading';
        this.autoDismissMs = (typeof options.autoDismissMs === 'number') ? options.autoDismissMs : 500;
        this.minVisibleMs = (typeof options.minVisibleMs === 'number') ? options.minVisibleMs : 300;
        this.tasks = new Map(); // id -> { id, label, phase, ratio, status, error, parentId }
        this._nextId = 1;
        this.root = null;
        this._listEl = null;
        this._shownAt = 0;
        this._dismissTimer = null;
        this.dismissed = true;
        // Two-level (session-group) state. additive — does not affect the
        // flat-task path used by switchSession.
        this.groups = new Map(); // id -> { id, label, status, error }
        this._currentGroupId = null;
        this._groupRowMap = new Map();   // groupId -> outer .lpm-group div
        this._childContainerMap = new Map(); // groupId -> .lpm-group-children div
        this._explicitHeader = null;     // { current, total } | null
        this._headerEl = null;           // cached header element so _updateHeader can target it
    }

    /**
     * Add a flat (non-grouped) task row, or — when opts.sessionId is set —
     * a child row under an existing session group.
     * @returns {string} unique task id
     */
    addTask({ label, sessionId } = {}) {
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
        const task = {
            id, label: label || id, phase: null, ratio: 0, status: 'pending',
            error: null, parentId: sessionId || null,
        };
        this.tasks.set(id, task);
        if (this.root && this._listEl) this._renderRow(task);
        return id;
    }

    /**
     * Add a session-group parent row. Returns the new group id.
     */
    addSessionGroup({ label } = {}) {
        if (this._dismissTimer) {
            clearTimeout(this._dismissTimer);
            this._dismissTimer = null;
        }
        const id = 'g' + this._nextId++;
        const group = { id, label: label || id, status: 'pending', error: null };
        this.groups.set(id, group);
        if (this.root && this._listEl) {
            this._renderGroup(id);
            this._updateHeader();
        }
        return id;
    }
    /** Alias for addSessionGroup. */
    addSession(opts) { return this.addSessionGroup(opts); }
    /** Alias for addSessionGroup. */
    addParentTask(opts) { return this.addSessionGroup(opts); }

    /**
     * Add a child task under the given session group.
     */
    addTaskToSession(groupId, { label } = {}) {
        return this.addTask({ label: label, sessionId: groupId });
    }
    /** Alias for addTaskToSession. */
    addChildTask(groupId, opts) { return this.addTaskToSession(groupId, opts); }

    /**
     * Mark the given session group as the currently-loading one. Updates
     * group status (-> loading), header text, and child-row visibility.
     */
    setCurrentSession(groupId) {
        if (!this.groups.has(groupId)) return;
        this._currentGroupId = groupId;
        const group = this.groups.get(groupId);
        if (group.status === 'pending') group.status = 'loading';
        if (this.root && this._listEl) {
            // Re-render groups so status icons + visibility update.
            for (const gid of this.groups.keys()) this._renderGroup(gid);
            this._refreshGroupVisibility();
            this._updateHeader();
        }
    }
    /** Alias for setCurrentSession. */
    setActiveSession(gid) { return this.setCurrentSession(gid); }

    /**
     * Mark the given session group as complete.
     */
    completeSession(groupId) {
        if (!this.groups.has(groupId)) return;
        const group = this.groups.get(groupId);
        group.status = 'complete';
        if (this.root && this._listEl) {
            this._renderGroup(groupId);
            this._refreshGroupVisibility();
        }
        this._maybeAutoDismiss();
    }
    /** Alias for completeSession. */
    finishSession(gid) { return this.completeSession(gid); }

    /**
     * Mark the given session group as failed. Modal will NOT auto-dismiss
     * (consistent with failTask).
     */
    failSession(groupId, error) {
        if (!this.groups.has(groupId)) return;
        const group = this.groups.get(groupId);
        group.status = 'error';
        group.error = error || new Error('Unknown error');
        if (this.root && this._listEl) {
            this._renderGroup(groupId);
            this._refreshGroupVisibility();
        }
        // Do NOT auto-dismiss on error.
    }

    /**
     * Explicit header progress override: `${title} - Session ${current} of ${total}`.
     */
    setProjectImportHeader({ current, total } = {}) {
        this._explicitHeader = { current: current, total: total };
        if (this.root && this._headerEl) this._updateHeader();
    }
    /** Alias for setProjectImportHeader. */
    setHeader(opts) { return this.setProjectImportHeader(opts); }
    /** Alias for setProjectImportHeader. */
    setSessionProgress(opts) { return this.setProjectImportHeader(opts); }

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
        this._headerEl = document.createElement('div');
        this._headerEl.className = 'lpm-header';
        this._headerEl.textContent = this.title;
        this.root.appendChild(this._headerEl);
        this._listEl = document.createElement('div');
        this._listEl.className = 'lpm-list';
        this.root.appendChild(this._listEl);
        // Keep root.innerHTML in sync with header text for headless DOM
        // sandboxes whose appendChild does not mirror children into
        // innerHTML/textContent. Tests inspect getRootHtml() which reads
        // outerHTML/innerHTML/textContent on root.
        this._rebuildRootSnapshot();
        document.body.appendChild(this.root);
        this._shownAt = Date.now();
        this.dismissed = false;
        // Render any groups added before show().
        for (const gid of this.groups.keys()) this._renderGroup(gid);
        // Render any tasks added before show().
        for (const task of this.tasks.values()) this._renderRow(task);
        this._refreshGroupVisibility();
        this._updateHeader();
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
        this._headerEl = null;
        // Clear cached row refs — without this, on the next show()/addTask
        // cycle _renderRow finds stale orphan rows in _rowMap (because
        // _nextId resets to 1 in reset(), so task IDs collide with the
        // previous load's IDs) and updates the dead nodes instead of
        // appending new rows to the fresh _listEl.
        if (this._rowMap) this._rowMap.clear();
        // Two-level state.
        this.groups.clear();
        this._currentGroupId = null;
        this._groupRowMap.clear();
        this._childContainerMap.clear();
        this._explicitHeader = null;
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
        // Two-level state.
        this.groups.clear();
        this._currentGroupId = null;
        this._groupRowMap.clear();
        this._childContainerMap.clear();
        this._explicitHeader = null;
        if (this.root) this._rebuildRootSnapshot();
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
        // Determine the parent container — flat task -> _listEl; child task
        // -> the group's children container.
        let parentContainer = this._listEl;
        if (task.parentId && this._childContainerMap.has(task.parentId)) {
            parentContainer = this._childContainerMap.get(task.parentId);
        }
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
            parentContainer.appendChild(row);
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
        this._rebuildRootSnapshot();
    }

    /**
     * Render or update the parent row for a session group. Idempotent —
     * subsequent calls re-use the same DOM node and update class/icon.
     */
    _renderGroup(groupId) {
        if (!this._listEl) return;
        const group = this.groups.get(groupId);
        if (!group) return;
        let groupEl = this._groupRowMap.get(groupId);
        let rowEl, iconEl, labelEl, childrenEl;
        if (!groupEl) {
            groupEl = document.createElement('div');
            groupEl.className = 'lpm-group';
            groupEl.setAttribute('data-group-id', groupId);
            rowEl = document.createElement('div');
            rowEl.className = 'lpm-group-row';
            iconEl = document.createElement('span');
            iconEl.className = 'lpm-icon';
            labelEl = document.createElement('span');
            labelEl.className = 'lpm-group-label';
            rowEl.appendChild(iconEl);
            rowEl.appendChild(labelEl);
            childrenEl = document.createElement('div');
            childrenEl.className = 'lpm-group-children';
            groupEl.appendChild(rowEl);
            groupEl.appendChild(childrenEl);
            this._listEl.appendChild(groupEl);
            this._groupRowMap.set(groupId, groupEl);
            this._childContainerMap.set(groupId, childrenEl);
            groupEl._lpmRowEl = rowEl;
            groupEl._lpmIconEl = iconEl;
            groupEl._lpmLabelEl = labelEl;
            groupEl._lpmChildrenEl = childrenEl;
        } else {
            rowEl = groupEl._lpmRowEl;
            iconEl = groupEl._lpmIconEl;
            labelEl = groupEl._lpmLabelEl;
            childrenEl = groupEl._lpmChildrenEl;
        }
        if (labelEl) labelEl.textContent = group.label;
        // Reset status classes on the outer group element.
        if (groupEl.classList && typeof groupEl.classList.remove === 'function') {
            groupEl.classList.remove('lpm-group-pending', 'lpm-group-loading', 'lpm-group-complete', 'lpm-group-error');
        } else if (typeof groupEl.className === 'string') {
            groupEl.className = 'lpm-group';
        }
        const addClass = (el, cls) => {
            if (el.classList && typeof el.classList.add === 'function') el.classList.add(cls);
            else if (typeof el.className === 'string' && el.className.indexOf(cls) < 0) el.className += ' ' + cls;
        };
        // Icon + status class.
        let iconChar = '⧗'; // ⧗ (hourglass-ish) for clock/pending
        let iconClass = 'lpm-icon lpm-icon-clock';
        let iconLabel = 'clock';
        if (group.status === 'loading') {
            iconChar = '◐'; // ◐
            iconClass = 'lpm-icon lpm-icon-spinner lpm-icon-loading';
            iconLabel = 'loading';
        } else if (group.status === 'complete') {
            iconChar = '✓'; // ✓
            iconClass = 'lpm-icon lpm-icon-check';
            iconLabel = 'check';
        } else if (group.status === 'error') {
            iconChar = '✗'; // ✗
            iconClass = 'lpm-icon lpm-icon-error';
            iconLabel = 'error';
        }
        if (iconEl) {
            iconEl.className = iconClass;
            iconEl.textContent = iconChar;
            if (typeof iconEl.setAttribute === 'function') iconEl.setAttribute('aria-label', iconLabel);
        }
        addClass(groupEl, 'lpm-group-' + group.status);
        // Error tooltip.
        if (group.status === 'error') {
            const msg = (group.error && group.error.message) || String(group.error);
            groupEl.title = msg;
        } else {
            groupEl.title = '';
        }
        this._rebuildRootSnapshot();
    }

    /**
     * Show only the current group's children. Pending and complete groups
     * collapse their child container.
     */
    _refreshGroupVisibility() {
        for (const [gid, groupEl] of this._groupRowMap) {
            const childrenEl = this._childContainerMap.get(gid);
            if (!childrenEl) continue;
            const visible = (gid === this._currentGroupId);
            if (childrenEl.style) childrenEl.style.display = visible ? '' : 'none';
        }
        this._rebuildRootSnapshot();
    }

    /**
     * Re-render the cached header element per the format:
     *   `${title} - Session ${current} of ${total}`
     * When neither _currentGroupId nor _explicitHeader is set, show just title.
     */
    _updateHeader() {
        if (!this._headerEl) return;
        let current = null;
        let total = null;
        if (this._explicitHeader && typeof this._explicitHeader.current === 'number') {
            current = this._explicitHeader.current;
            total = this._explicitHeader.total;
        } else if (this._currentGroupId != null && this.groups.size > 0) {
            const keys = Array.from(this.groups.keys());
            const idx = keys.indexOf(this._currentGroupId);
            if (idx >= 0) {
                current = idx + 1;
                total = keys.length;
            }
        }
        let text = this.title;
        if (current != null && total != null) {
            text = this.title + ' - Session ' + current + ' of ' + total;
        }
        this._headerEl.textContent = text;
        this._rebuildRootSnapshot();
    }

    /**
     * Mirror status text into root.innerHTML so headless DOM sandboxes (where
     * appendChild does not propagate child content into parent innerHTML/
     * textContent) can still expose the rendered content for inspection.
     *
     * Real browser DOMs already reflect appendChild into innerHTML, and the
     * simplified snapshot here intentionally omits progress-bar markup that
     * _renderRow appends (it's verbose and tests only care about text). So
     * we MUST skip this in browsers — running it would replace the real
     * progress-bar DOM with label-only HTML and hide every bar.
     */
    _rebuildRootSnapshot() {
        if (!this.root) return;
        // Skip in real browser environments. The Node test sandbox stubs
        // `document` without a real HTMLElement constructor, so `instanceof`
        // returns false there and the snapshot path still runs.
        if (typeof window !== 'undefined' &&
            typeof window.HTMLElement === 'function' &&
            this.root instanceof window.HTMLElement) {
            return;
        }
        const parts = [];
        const headerText = (this._headerEl && this._headerEl.textContent) || this.title;
        parts.push('<div class="lpm-header">' + this._escape(headerText) + '</div>');
        // Render groups + their children.
        for (const [gid, group] of this.groups) {
            const visible = (gid === this._currentGroupId);
            const cls = 'lpm-group lpm-group-' + group.status;
            let iconLabel = 'clock';
            let iconChar = '⧗';
            if (group.status === 'loading') { iconLabel = 'loading'; iconChar = '◐'; }
            else if (group.status === 'complete') { iconLabel = 'check'; iconChar = '✓'; }
            else if (group.status === 'error') { iconLabel = 'error'; iconChar = '✗'; }
            parts.push(
                '<div class="' + cls + '">' +
                '<div class="lpm-group-row">' +
                '<span class="lpm-icon lpm-icon-' + iconLabel + (group.status === 'loading' ? ' lpm-icon-spinner lpm-icon-loading' : '') + '" aria-label="' + iconLabel + '">' + iconChar + '</span>' +
                '<span class="lpm-group-label">' + this._escape(group.label) + '</span>' +
                '</div>'
            );
            if (visible) {
                // Inline visible child rows.
                parts.push('<div class="lpm-group-children">');
                for (const task of this.tasks.values()) {
                    if (task.parentId !== gid) continue;
                    parts.push('<div class="lpm-row" data-task-id="' + task.id + '"><div class="lpm-label">' + this._escape(task.label) + '</div></div>');
                }
                parts.push('</div>');
            } else {
                parts.push('<div class="lpm-group-children" style="display:none"></div>');
            }
            parts.push('</div>');
        }
        // Render any orphan (flat) tasks not attached to a group.
        for (const task of this.tasks.values()) {
            if (task.parentId) continue;
            parts.push('<div class="lpm-row" data-task-id="' + task.id + '"><div class="lpm-label">' + this._escape(task.label) + '</div></div>');
        }
        this.root.innerHTML = parts.join('');
        // Also mirror into textContent so tests reading root.textContent see content.
        if ('textContent' in this.root) {
            // Approximate plain-text view (strip tags from parts).
            let txt = parts.join(' ').replace(/<[^>]+>/g, ' ');
            this.root.textContent = txt;
        }
    }

    _maybeAutoDismiss() {
        // Only auto-dismiss if every task is complete (no errors, no pending).
        let allComplete = true;
        for (const task of this.tasks.values()) {
            if (task.status !== 'complete') { allComplete = false; break; }
        }
        if (!allComplete) return;
        // Two-level: also require all groups to be complete. An errored
        // group blocks auto-dismiss, matching failTask's no-auto-dismiss policy.
        if (this.groups.size > 0) {
            for (const g of this.groups.values()) {
                if (g.status !== 'complete') return;
            }
        }
        if (this.tasks.size === 0 && this.groups.size === 0) return; // nothing scheduled, no auto-dismiss
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
            '  min-width: 280px; max-width: 380px; box-shadow: 0 4px 16px rgba(0,0,0,0.4); ' +
            '  max-height: 50vh; overflow-y: auto; }' +
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
            '@keyframes lpm-pulse { 0%, 100% { opacity: 0.7; } 50% { opacity: 1; } }' +
            // Session-group styles.
            '.lpm-group { margin-bottom: 6px; }' +
            // min-width:0 + overflow:hidden so a long session name truncates
            // (via the label's text-overflow: ellipsis) instead of forcing
            // the row to expand past the modal max-width.
            '.lpm-group-row { display: flex; align-items: center; gap: 6px; ' +
            '  font-size: 12px; min-width: 0; overflow: hidden; }' +
            '.lpm-group-label { flex: 1 1 auto; min-width: 0; ' +
            '  white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }' +
            '.lpm-group-pending .lpm-group-row { color: #f56565; }' +
            '.lpm-group-loading .lpm-group-row { color: #e0e0e0; }' +
            '.lpm-group-complete .lpm-group-row { color: #48bb78; }' +
            '.lpm-group-error .lpm-group-row { color: #888; }' +
            '.lpm-group-children { margin-left: 14px; }' +
            '.lpm-group:not(.lpm-group-loading) .lpm-group-children { display: none; }' +
            '.lpm-icon { display: inline-block; font-size: 11px; min-width: 12px; ' +
            '  flex: 0 0 auto; }' +
            '.lpm-icon-spinner { animation: lpm-spin 1.4s linear infinite; }' +
            '@keyframes lpm-spin { to { transform: rotate(360deg); } }';
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
    if (!_singleton) {
        _singleton = new LoadingProgressModal(options);
    } else if (options && typeof options.title === 'string') {
        // Singleton was previously constructed (likely by another caller —
        // e.g., a prior session-swap or project import). Refresh the title
        // so each caller's header reflects its own context rather than the
        // first caller's title sticking forever.
        _singleton.title = options.title;
        if (_singleton._headerEl) _singleton._updateHeader();
    }
    return _singleton;
}
export function resetLoadingProgressModal() {
    if (_singleton) _singleton.dismiss();
    _singleton = null;
}
