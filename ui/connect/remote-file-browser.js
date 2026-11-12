/**
 * ui/connect/remote-file-browser.js — the Finder-style browser of a worker's filesystem: the Inference
 * panel's picker (models, Locate on worker…, output folder) and, in "browse" mode, the Connect window's
 * look-only Browse files.
 *
 * Port of sleap-app src/components/dialogs/RemoteFileBrowser.tsx @ 683a159: toolbar (Back / Forward,
 * breadcrumb + "Go to folder", Favorites star, search), sidebar (Favorites, Recents, Locations), a sortable
 * list loaded 100 at a time, filtered files greyed out, never outside the shared folders (`mountRootFor`),
 * an unopenable folder falls back to its parent. Favorites / Recents / sort / size persist
 * (`pose/connect/remote-browser-store.js`). Keys as sleap-app's (Esc: a Go-to box or search goes first).
 *
 * LUCID changes:
 *  - List view only; sort by column headers (no sort menu);
 *  - one scroller (the list); Lucide icons from the rail's set;
 *  - a scrim + card (`.rfb-*`): Esc and a scrim click close, Tab trapped (`trapModal`).
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { createRemoteBrowserStore } from '../../pose/connect/remote-browser-store.js';
import {
    KIND_LABELS, baseName, fileKind, filterLabel, formatModified, formatSize, joinPath, matchesFilter,
    matchesSearch, mountRootFor, normalizeFilter, parentPath, pathTrail, sortEntries,
} from '../../pose/connect/remote-browser.js';
import { trapModal } from './layers.js';
import { el, button, icon as baseIcon } from './dom.js';

export { mountRootFor };

const BATCH = 100;
const DEFAULT_SIZE = { width: 900, height: 600 };
const SELECTED_WORKER_KEY = '';

/** Last browsed folder per worker key, for this page session. */
const lastBrowsedPaths = new Map();

let _store = null;
/** The remembered view settings, created on first use (storage is looked up then, not at import). */
export function remoteBrowserStore() {
    if (!_store) {
        let storage;
        try { storage = window.localStorage; } catch (e) { storage = undefined; }
        _store = createRemoteBrowserStore({ storage: storage });
    }
    return _store;
}

function icon(name, cls) { return baseIcon(name, cls, 'rfb-icon'); }

/**
 * sleap-app `MiddleTruncate`: a name over 24 characters keeps its last 12 (the version and extension)
 * and truncates the head with an ellipsis; the whole name is in the title and, for a screen reader, in
 * an off-screen copy. A short name is one text node.
 */
function middleTruncate(text) {
    const wrap = el('span', 'rfb-name-text');
    wrap.title = text;
    if (text.length <= 24) {
        wrap.textContent = text;
        return wrap;
    }
    wrap.classList.add('rfb-name-split');
    const full = el('span', 'rfb-sr-only', text);
    const head = el('span', 'rfb-name-head', text.slice(0, -12));
    const tail = el('span', 'rfb-name-tail', text.slice(-12));
    head.setAttribute('aria-hidden', 'true'); tail.setAttribute('aria-hidden', 'true');
    wrap.append(full, head, tail);
    return wrap;
}

function kindIconName(entry) {
    const k = fileKind(entry);
    return k === 'folder' ? 'folder' : k === 'video' ? 'film' : 'file';
}

/**
 * Open the browser. Resolves with the picked worker path, or null when cancelled
 * (always null in "browse" mode).
 *
 * @param {{
 *   workerId?: string,
 *   mounts?: string[],
 *   mountLabels?: Record<string, string>,
 *   mode?: 'directory' | 'file' | 'browse',
 *   fileFilter?: string | string[],
 *   title?: string,
 * }} opts
 * @returns {Promise<string | null>}
 */
export function openRemoteFileBrowser(opts) {
    opts = opts || {};
    const mounts = opts.mounts || [];
    const mountLabels = opts.mountLabels;
    const mode = opts.mode || 'directory';
    const workerId = opts.workerId;
    const workerKey = workerId || SELECTED_WORKER_KEY;
    const exts = mode === 'file' ? normalizeFilter(opts.fileFilter) : null;
    const rb = remoteBrowserStore();

    return new Promise(function (resolve) {
        // State
        let currentPath = null;
        let back = [];
        let forward = [];
        const listings = {};            // path -> {entries, loading, error, hasMore}
        const loading = new Set();
        let selected = null;
        let query = '';
        let goto = null;                // null = breadcrumb, string = the "Go to folder" box
        let gotoError = null;
        let notice = null;
        let closed = false;

        function pickable(e) {
            if (mode === 'browse') return true;
            if (e.isDir) return true;
            return mode === 'file' && matchesFilter(e, exts);
        }

        // DOM skeleton
        const scrim = el('div', 'rfb-scrim');
        scrim.id = 'remoteFileBrowser';
        // Owns the keyboard while open: `shouldIgnoreShortcut` (ui/keyboard-target.js) keeps app shortcuts off the view behind it.
        scrim.setAttribute('data-shortcut-modal', '1');
        const card = el('div', 'rfb-card');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', opts.title || 'Browse Worker Files');
        const size = rb.getState().size || DEFAULT_SIZE;
        card.style.width = size.width + 'px';
        card.style.height = size.height + 'px';

        const toolbar = el('div', 'rfb-toolbar');
        const backBtn = button('rfb-tbtn', '‹', 'Back');
        backBtn.setAttribute('aria-label', 'Back');
        const fwdBtn = button('rfb-tbtn', '›', 'Forward');
        fwdBtn.setAttribute('aria-label', 'Forward');
        const pathHost = el('div', 'rfb-path');
        const starBtn = button('rfb-tbtn rfb-star');
        starBtn.appendChild(icon('star'));
        const searchWrap = el('div', 'rfb-search');
        const search = el('input', 'rfb-search-input');
        search.type = 'search';
        search.setAttribute('aria-label', 'Search this folder');
        search.placeholder = 'Search this folder';
        searchWrap.appendChild(search);
        toolbar.append(backBtn, fwdBtn, pathHost, starBtn, searchWrap);

        const bodyRow = el('div', 'rfb-body');
        const sidebar = el('nav', 'rfb-sidebar');
        sidebar.setAttribute('aria-label', 'Sidebar');
        const content = el('div', 'rfb-content');
        const noticeBox = el('div', 'rfb-notice');
        const noticeText = el('span', 'rfb-notice-text');
        const noticeX = button('rfb-tbtn rfb-notice-x', '×', 'Dismiss');
        noticeX.setAttribute('aria-label', 'Dismiss');
        noticeBox.append(noticeText, noticeX);
        const listScroll = el('div', 'rfb-list');
        listScroll.setAttribute('role', 'listbox');
        content.append(noticeBox, listScroll);
        bodyRow.append(sidebar, content);

        const footer = el('div', 'rfb-footer');
        const footInfo = el('div', 'rfb-foot-info');
        const footPath = el('p', 'rfb-foot-path');
        const footHint = el('p', 'rfb-foot-hint');
        footInfo.append(footPath, footHint);
        const cancelBtn = button('rfb-btn', 'Cancel');
        const okBtn = button('rfb-btn rfb-btn-primary', mode === 'directory' ? 'Choose Folder' : 'Open');
        if (mode === 'browse') {
            cancelBtn.hidden = true;
            okBtn.textContent = 'Close';
            okBtn.disabled = false;
        }
        footer.append(footInfo, cancelBtn, okBtn);

        card.append(toolbar, bodyRow, footer);
        scrim.appendChild(card);

        // Data
        function listingOf(p) { return listings[p]; }

        function load(path) {
            if (loading.has(path) || closed) return;
            loading.add(path);
            const prev = listings[path];
            const offset = prev ? prev.entries.length : 0;
            listings[path] = { entries: prev ? prev.entries : [], loading: true, error: null, hasMore: prev ? prev.hasMore : true };
            render();
            const store = useConnectStore.getState();
            const p = workerId ? store.browseRemoteDirOn(workerId, path, offset, BATCH) : store.browseRemoteDir(path, offset, BATCH);
            Promise.resolve(p).then(function (batch) {
                if (closed) return;
                const cur = listings[path];
                listings[path] = { entries: (cur ? cur.entries : []).concat(batch), loading: false, error: null, hasMore: batch.length >= BATCH };
            }, function (err) {
                if (closed) return;
                listings[path] = { entries: [], loading: false, error: (err && err.message) || "Couldn't open this folder", hasMore: false };
            }).then(function () {
                loading.delete(path);
                afterLoad();
                // A sort other than name, or a search, needs the whole folder: keep loading the remaining batches (sleap-app's effect).
                ensureLoaded();
                render();
            });
        }

        // A folder that cannot be opened falls back to its nearest openable parent.
        function afterLoad() {
            if (!currentPath) return;
            const l = listings[currentPath];
            if (l && l.error && mountRootFor(currentPath, mounts) !== currentPath) {
                if (!notice) notice = '“' + baseName(currentPath) + '” couldn’t be opened — showing the nearest folder that could.';
                currentPath = parentPath(currentPath);
                selected = null;
                lastBrowsedPaths.set(workerKey, currentPath);
                ensureLoaded();
            }
        }

        function needsWholeFolder() {
            const s = rb.getState().sort;
            return query.trim() !== '' || s.key !== 'name' || s.dir !== 'asc' || !s.foldersFirst;
        }

        function ensureLoaded() {
            if (!currentPath) return;
            const l = listings[currentPath];
            if (!l) { load(currentPath); return; }
            if (needsWholeFolder() && l.hasMore && !l.loading && !l.error) load(currentPath);
        }

        function navigateTo(path, o) {
            o = o || {};
            if (mounts.length > 0 && mountRootFor(path, mounts) === null) return;
            if (path === currentPath) { selected = o.select || null; render(); return; }
            if (o.history !== false && currentPath) { back.push(currentPath); forward = []; }
            currentPath = path;
            selected = o.select || null;
            query = ''; search.value = '';
            notice = null;
            if (listings[path] && listings[path].error) delete listings[path];
            lastBrowsedPaths.set(workerKey, path);
            ensureLoaded();
            render();
        }

        function goBack() {
            const prev = back[back.length - 1];
            if (!prev || !currentPath) return;
            back.pop();
            forward.unshift(currentPath);
            navigateTo(prev, { history: false });
        }
        function goForward() {
            const next = forward[0];
            if (!next || !currentPath) return;
            forward.shift();
            back.push(currentPath);
            navigateTo(next, { history: false });
        }
        function atRoot() { return !currentPath || mountRootFor(currentPath, mounts) === currentPath; }
        function goUp() { if (currentPath && !atRoot()) navigateTo(parentPath(currentPath), { select: currentPath }); }

        function entryAt(path) {
            if (!path) return undefined;
            const l = listings[parentPath(path)];
            return l ? l.entries.find(function (e) { return e.name === baseName(path); }) : undefined;
        }

        function lastOpenedMap() {
            const out = {};
            (rb.getState().recents[workerKey] || []).forEach(function (r) { out[r.path] = r.openedAt; });
            return out;
        }

        function visibleEntries() {
            const l = currentPath ? listings[currentPath] : null;
            if (!l) return [];
            return sortEntries(l.entries, rb.getState().sort, { dir: currentPath, lastOpened: lastOpenedMap() })
                .filter(function (e) { return matchesSearch(e, query); });
        }

        function pickPath() {
            if (mode === 'browse') return null;
            const se = entryAt(selected);
            if (mode === 'directory') return se && se.isDir ? selected : currentPath;
            return se && !se.isDir && pickable(se) ? selected : null;
        }

        function finish(path) {
            if (closed) return;
            closed = true;
            trap.release();
            scrim.remove();
            resolve(path || null);
        }

        function pick(path) {
            path = path === undefined ? pickPath() : path;
            if (mode === 'browse') { finish(null); return; }
            if (!path) return;
            rb.getState().addRecent(workerKey, path, mode === 'directory');
            finish(path);
        }

        function activate(dir, entry) {
            const path = joinPath(dir, entry.name);
            if (entry.isDir) navigateTo(path);
            else if (pickable(entry) && mode === 'file') pick(path);
        }

        function submitGoto(input) {
            const raw = (input.value || '').trim();
            if (!raw) { goto = null; render(); return; }
            const path = raw.length > 1 ? raw.replace(/\/+$/, '') : raw;
            if (mounts.length > 0 && mountRootFor(path, mounts) === null) {
                gotoError = "That folder isn't inside one of this worker's shared folders.";
                renderPath();
                return;
            }
            goto = null; gotoError = null;
            navigateTo(path);
        }

        // Rendering
        function renderPath() {
            pathHost.textContent = '';
            if (goto !== null) {
                const input = el('input', 'rfb-goto');
                input.type = 'text';
                input.value = goto;
                input.placeholder = '/path/on/worker';
                input.setAttribute('aria-label', 'Go to folder');
                input.addEventListener('input', function () { goto = input.value; gotoError = null; });
                input.addEventListener('keydown', function (e) {
                    if (e.key === 'Enter') { e.preventDefault(); e.stopPropagation(); submitGoto(input); }
                });
                input.addEventListener('blur', function () { if (!gotoError && goto !== null) { goto = null; renderPath(); } });
                pathHost.appendChild(input);
                if (gotoError) pathHost.appendChild(el('p', 'rfb-goto-error', gotoError));
                setTimeout(function () { input.focus(); input.select(); }, 0);
                return;
            }
            const trail = currentPath ? pathTrail(currentPath, mounts) : [];
            const crumbs = el('div', 'rfb-crumbs');
            crumbs.title = 'Click, or press ⌘⇧G, to go to a folder';
            trail.forEach(function (p, i) {
                const last = i === trail.length - 1;
                if (i > 0) crumbs.appendChild(el('span', 'rfb-sepchev', '›'));
                const b = button('rfb-crumb' + (last ? ' rfb-crumb-last' : ''), i === 0 ? ((mountLabels && mountLabels[p]) || p) : baseName(p));
                b.addEventListener('click', function () { if (!last) navigateTo(p); });
                crumbs.appendChild(b);
            });
            const fill = el('span', 'rfb-crumb-fill');
            fill.addEventListener('click', function () { goto = currentPath || ''; renderPath(); });
            crumbs.appendChild(fill);
            crumbs.addEventListener('click', function (e) { if (e.target === crumbs) { goto = currentPath || ''; renderPath(); } });
            pathHost.appendChild(crumbs);
        }

        function sidebarItem(parent, iconName, label, title, active, onClick, onRemove) {
            const row = el('div', 'rfb-side-item' + (active ? ' active' : ''));
            row.title = title;
            row.appendChild(icon(iconName));
            row.appendChild(el('span', 'rfb-side-label', label));
            if (onRemove) {
                const x = button('rfb-side-x');
                x.setAttribute('aria-label', 'Remove ' + label + ' from Favorites');
                x.appendChild(icon('x'));
                x.addEventListener('click', function (e) { e.stopPropagation(); onRemove(); });
                row.appendChild(x);
            }
            row.addEventListener('click', onClick);
            parent.appendChild(row);
        }

        function sidebarSection(title) {
            const s = el('div', 'rfb-side-section');
            s.appendChild(el('p', 'rfb-side-title', title));
            sidebar.appendChild(s);
            return s;
        }

        function renderSidebar() {
            sidebar.textContent = '';
            const st = rb.getState();
            const favs = st.favorites[workerKey] || [];
            const recents = st.recents[workerKey] || [];
            if (favs.length) {
                const s = sidebarSection('Favorites');
                favs.forEach(function (p) {
                    sidebarItem(s, 'star', baseName(p), p, currentPath === p, function () { navigateTo(p); },
                        function () { st.removeFavorite(workerKey, p); renderSidebar(); renderStar(); });
                });
            }
            if (recents.length) {
                const s = sidebarSection('Recents');
                recents.forEach(function (r) {
                    sidebarItem(s, r.isDir ? 'clock' : kindIconName({ name: r.path, isDir: false }), baseName(r.path), r.path,
                        r.isDir ? currentPath === r.path : selected === r.path, function () {
                            if (r.isDir) navigateTo(r.path); else navigateTo(parentPath(r.path), { select: r.path });
                        });
                });
            }
            const loc = sidebarSection('Locations');
            if (mounts.length === 0) loc.appendChild(el('p', 'rfb-side-none', 'No shared folders'));
            mounts.forEach(function (m) {
                sidebarItem(loc, 'hard-drive', (mountLabels && mountLabels[m]) || m, m, currentPath === m, function () { navigateTo(m); });
            });
        }

        function renderStar() {
            const fav = !!currentPath && (rb.getState().favorites[workerKey] || []).indexOf(currentPath) !== -1;
            starBtn.classList.toggle('on', fav);
            const t = fav ? 'Remove from Favorites' : 'Add to Favorites';
            starBtn.title = t;
            starBtn.setAttribute('aria-label', t);
            starBtn.setAttribute('aria-pressed', fav ? 'true' : 'false');
            starBtn.disabled = !currentPath;
        }

        function renderList() {
            const keepScroll = listScroll.scrollTop;
            listScroll.textContent = '';
            if (mounts.length === 0) {
                listScroll.appendChild(el('div', 'rfb-empty', "This worker isn't sharing any folders. On the worker, run sleap-connect add-folder <folder> to browse."));
                return;
            }
            const sort = rb.getState().sort;
            const head = el('div', 'rfb-row rfb-head');
            [['name', 'Name'], ['modified', 'Date Modified'], ['size', 'Size'], ['kind', 'Kind']].forEach(function (c) {
                const b = button('rfb-hbtn' + (sort.key === c[0] ? ' on' : ''), c[1] + (sort.key === c[0] ? (sort.dir === 'asc' ? ' ▲' : ' ▼') : ''));
                b.dataset.key = c[0];
                b.addEventListener('click', function () {
                    const s = rb.getState().sort;
                    rb.getState().setSort(s.key === c[0] ? Object.assign({}, s, { dir: s.dir === 'asc' ? 'desc' : 'asc' }) : Object.assign({}, s, { key: c[0], dir: 'asc' }));
                    ensureLoaded();
                    render();
                });
                head.appendChild(b);
            });
            listScroll.appendChild(head);
            const l = currentPath ? listings[currentPath] : null;
            if (!l || (l.loading && l.entries.length === 0)) {
                listScroll.appendChild(el('div', 'rfb-empty', 'Loading…'));
                return;
            }
            if (l.error) {
                const e = el('div', 'rfb-error', l.error);
                listScroll.appendChild(e);
                return;
            }
            const entries = visibleEntries();
            if (entries.length === 0 && !l.hasMore) {
                listScroll.appendChild(el('div', 'rfb-empty', query.trim() ? 'No items match “' + query.trim() + '”' : 'This folder is empty'));
                return;
            }
            entries.forEach(function (e) {
                const path = joinPath(currentPath, e.name);
                const enabled = pickable(e);
                const row = el('div', 'rfb-row rfb-entry' + (path === selected ? ' selected' : '') + (enabled ? '' : ' disabled'));
                row.setAttribute('role', 'option');
                row.setAttribute('aria-selected', path === selected ? 'true' : 'false');
                row.setAttribute('aria-disabled', enabled ? 'false' : 'true');
                row.dataset.name = e.name;
                row.dataset.dir = e.isDir ? '1' : '0';
                const nameCell = el('span', 'rfb-name');
                nameCell.appendChild(icon(kindIconName(e), e.isDir ? 'rfb-folder' : ''));
                nameCell.appendChild(middleTruncate(e.name));
                row.appendChild(nameCell);
                row.appendChild(el('span', 'rfb-dim', formatModified(e.modified)));
                row.appendChild(el('span', 'rfb-dim rfb-mono', e.isDir ? '—' : e.size != null ? formatSize(e.size) : ''));
                row.appendChild(el('span', 'rfb-dim', KIND_LABELS[fileKind(e)]));
                row.addEventListener('click', function () { if (enabled) { selected = path; render(); } });
                row.addEventListener('dblclick', function () { activate(currentPath, e); });
                listScroll.appendChild(row);
            });
            if (l.hasMore) {
                const more = el('div', 'rfb-more', 'Loading more… (' + l.entries.length.toLocaleString('en-US') + ' so far)');
                listScroll.appendChild(more);
                if (typeof IntersectionObserver !== 'undefined' && !l.loading) {
                    const io = new IntersectionObserver(function (items) {
                        if (items.some(function (i) { return i.isIntersecting; })) { io.disconnect(); load(currentPath); }
                    }, { root: listScroll });
                    io.observe(more);
                }
            }
            listScroll.scrollTop = keepScroll;
        }

        function render() {
            if (closed) return;
            backBtn.disabled = back.length === 0;
            fwdBtn.disabled = forward.length === 0;
            if (goto === null || !pathHost.firstChild) renderPath();
            renderStar();
            renderSidebar();
            noticeBox.hidden = !notice;
            noticeText.textContent = notice || '';
            renderList();
            const pp = pickPath();
            footPath.textContent = selected || currentPath || '';
            footPath.title = footPath.textContent;
            footHint.textContent = exts ? 'Shows ' + filterLabel(exts) : '';
            footHint.hidden = !exts;
            if (mode !== 'browse') okBtn.disabled = !pp;
        }

        // Events
        backBtn.addEventListener('click', goBack);
        fwdBtn.addEventListener('click', goForward);
        starBtn.addEventListener('click', function () {
            if (currentPath) { rb.getState().toggleFavorite(workerKey, currentPath); renderSidebar(); renderStar(); }
        });
        search.addEventListener('input', function () { query = search.value; ensureLoaded(); render(); });
        noticeX.addEventListener('click', function () { notice = null; render(); });
        cancelBtn.addEventListener('click', function () { finish(null); });
        okBtn.addEventListener('click', function () { pick(); });
        scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) finish(null); });
        // Remember the size only when the user dragged the resize corner: on a small window the card is clamped
        // to the viewport, and any click inside it must not store that clamped size as the user's choice.
        let cornerDrag = false;
        card.addEventListener('pointerdown', function (e) {
            const r = card.getBoundingClientRect();
            cornerDrag = e.clientX > r.right - 20 && e.clientY > r.bottom - 20;
        });
        card.addEventListener('pointerup', function () {
            if (!cornerDrag) return;
            cornerDrag = false;
            const r = card.getBoundingClientRect();
            const s = rb.getState().size || DEFAULT_SIZE;
            if (Math.abs(r.width - s.width) > 2 || Math.abs(r.height - s.height) > 2) {
                rb.getState().setSize({ width: Math.round(r.width), height: Math.round(r.height) });
            }
        });

        // A "Go to folder" box or a non-empty search takes the first Esc.
        function onEscape(e) {
            if (goto !== null) { goto = null; gotoError = null; renderPath(); return; }
            if (query && e.target === search) { query = ''; search.value = ''; render(); return; }
            finish(null);
        }
        function onKey(e) {
            const t = e.target;
            const typing = t && t.tagName === 'INPUT';
            const mod = e.metaKey || e.ctrlKey;
            if (mod && e.key.toLowerCase() === 'f') { e.preventDefault(); e.stopPropagation(); search.focus(); return; }
            if (mod && e.shiftKey && e.key.toLowerCase() === 'g') { e.preventDefault(); e.stopPropagation(); goto = currentPath || ''; renderPath(); return; }
            if (mod && e.key === 'ArrowUp') { e.preventDefault(); e.stopPropagation(); goUp(); return; }
            if (mod && e.key === '[') { e.preventDefault(); e.stopPropagation(); goBack(); return; }
            if (mod && e.key === ']') { e.preventDefault(); e.stopPropagation(); goForward(); return; }
            if (!typing && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
                const items = visibleEntries().filter(pickable);
                if (!items.length || !currentPath) return;
                e.preventDefault(); e.stopPropagation();
                const i = items.findIndex(function (x) { return joinPath(currentPath, x.name) === selected; });
                const next = items[Math.min(items.length - 1, Math.max(0, i < 0 ? 0 : i + (e.key === 'ArrowDown' ? 1 : -1)))];
                selected = joinPath(currentPath, next.name);
                render();
                const row = listScroll.querySelector('.rfb-entry.selected');
                if (row && row.scrollIntoView) row.scrollIntoView({ block: 'nearest' });
                return;
            }
            if (!typing && e.key === 'Enter' && currentPath && !(t && t.tagName === 'BUTTON')) {
                e.preventDefault(); e.stopPropagation();
                const se = entryAt(selected);
                if (se && se.isDir && selected) navigateTo(selected); else pick();
            }
        }
        const trap = trapModal(scrim, card, {
            onEscape: onEscape, onKey: onKey,
            focusable: function (n) { return !n.closest('[hidden]'); },
        });

        // Start where this worker was last browsed (if still inside a mount), else the first mount.
        const remembered = lastBrowsedPaths.get(workerKey);
        currentPath = remembered && (mounts.length === 0 || mountRootFor(remembered, mounts) !== null) ? remembered : (mounts[0] || null);
        document.body.appendChild(scrim);
        ensureLoaded();
        render();
        card.tabIndex = -1;
        card.focus();
    });
}
