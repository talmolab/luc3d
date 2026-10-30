// ui/modal-geometry.js — remembered size and position for resizable modals.
//
// Dependency-free on purpose: it imports NO project modules, so it bridges into
// the browser test runner (`tests/test-runner.html`), and `clampGeometry`
// unit-tests as the pure function it is.
//
// ## What it does
//
// A modal that opens at a fixed 880x620 in the middle of the screen is fine
// until its content is a table of every node in the skeleton. Then the user
// wants it BIGGER, and wants it to stay that way — reopening at the default
// every time is the same work over and over. This module gives a modal card a
// drag handle, a resize grip (CSS `resize`, so the grip itself is the
// browser's) and a localStorage record of where it ended up.
//
// ## Geometry is browser-local display taste
//
// It lives in `localStorage`, NOT in the `.slp` — the same call CLAUDE.md makes
// for the Visibility panel's global appearance preferences. Where someone likes
// their Settings window on THIS screen says nothing about the project.
//
// ## Only a size the user chose is remembered
//
// Position is always remembered, but size only once the user has actually
// resized the card (`sized: true` in the record). Otherwise the card opens at
// the stylesheet's size, so a later change of the default reaches everyone who
// never resized it. Records written before the flag existed saved the opening
// size on every close; a caller can name its old default (`legacyDefaultSize`)
// so such a record counts as unsized.
//
// With `fillHeight`, a card whose HEIGHT the user has not chosen takes the viewport's
// whole height (less the margin) and follows it as the window changes, so a large
// screen means less scrolling. Dragging the grip's height takes over from there
// (`heightChosen` in the record). A width dragged on its own leaves the height filling,
// and so does a record older than the flag: its height was only ever chosen because
// the card could not fill the window then.
//
// ## Clamping is the load-bearing part
//
// Restoring a remembered rect blindly is how a modal ends up off-screen: the
// window that sized it may have been larger, or on a second monitor that is no
// longer attached. `clampGeometry` keeps the whole card inside the viewport,
// which also keeps the header — the drag handle and the close button — always
// reachable. It runs on open AND on every window resize, so a window that
// shrinks drags the card back into view rather than stranding it.

export const DEFAULT_MIN_W = 480;
export const DEFAULT_MIN_H = 300;

// Gutter kept between the card and the viewport edges. This module is the ONE
// owner of the card's rect: a CSS `max-width: 94vw` alongside it would cap a
// width this function thought it had granted, and the card would land flush
// against an edge with a gap on the opposite side.
export const DEFAULT_MARGIN = 0;

const STORAGE_KEY = 'lucid.modalGeometry.v1';

function isNum(v) {
    return typeof v === 'number' && isFinite(v);
}

/**
 * Fit a remembered rect inside the current viewport.
 *
 * Size is clamped to `[min, available]` — available wins, so a card remembered
 * from a bigger window shrinks rather than overflowing, and a viewport narrower
 * than the minimum simply gets the whole viewport. Position is then clamped so
 * the entire card is on screen.
 *
 * @param {{x:number,y:number,w:number,h:number}} geom
 * @param {{width:number,height:number}} viewport
 * @param {{minW?:number,minH?:number,margin?:number}} [min]
 * @returns {{x:number,y:number,w:number,h:number}|null} null if `geom` is unusable
 */
export function clampGeometry(geom, viewport, min) {
    if (!geom || !viewport) return null;
    if (!isNum(geom.x) || !isNum(geom.y) || !isNum(geom.w) || !isNum(geom.h)) return null;
    if (geom.w <= 0 || geom.h <= 0) return null;

    const vw = isNum(viewport.width) && viewport.width > 0 ? viewport.width : 0;
    const vh = isNum(viewport.height) && viewport.height > 0 ? viewport.height : 0;
    if (!vw || !vh) return null;

    const minW = (min && isNum(min.minW)) ? min.minW : DEFAULT_MIN_W;
    const minH = (min && isNum(min.minH)) ? min.minH : DEFAULT_MIN_H;
    let m = (min && isNum(min.margin)) ? Math.max(0, min.margin) : DEFAULT_MARGIN;
    // A margin wider than the viewport would invert the available box.
    if (2 * m >= vw || 2 * m >= vh) m = 0;

    const availW = vw - 2 * m;
    const availH = vh - 2 * m;
    const w = Math.min(Math.max(geom.w, minW), availW);
    const h = Math.min(Math.max(geom.h, minH), availH);
    const x = Math.min(Math.max(geom.x, m), Math.max(m, vw - m - w));
    const y = Math.min(Math.max(geom.y, m), Math.max(m, vh - m - h));
    return { x: x, y: y, w: w, h: h };
}

/** Centre a `w x h` card in the viewport (clamped like everything else). */
export function centerGeometry(w, h, viewport, min) {
    const vw = (viewport && viewport.width) || 0;
    const vh = (viewport && viewport.height) || 0;
    return clampGeometry({ x: (vw - w) / 2, y: (vh - h) / 2, w: w, h: h }, viewport, min);
}

function store(storage) {
    if (storage) return storage;
    try {
        return (typeof localStorage !== 'undefined') ? localStorage : null;
    } catch (e) {
        // Private mode / blocked site data.
        return null;
    }
}

function readAll(storage) {
    const s = store(storage);
    if (!s) return {};
    try {
        const raw = s.getItem(STORAGE_KEY);
        if (!raw) return {};
        const parsed = JSON.parse(raw);
        return (parsed && typeof parsed === 'object') ? parsed : {};
    } catch (e) {
        return {};
    }
}

/**
 * The remembered rect for `id`, or null when there is none (or it is corrupt).
 * Never clamped here — the caller clamps against the CURRENT viewport.
 */
export function readGeometry(id, storage) {
    const all = readAll(storage);
    const g = all[id];
    if (!g || !isNum(g.x) || !isNum(g.y) || !isNum(g.w) || !isNum(g.h)) return null;
    const out = { x: g.x, y: g.y, w: g.w, h: g.h };
    // `sized` is absent on records written before it existed.
    if (typeof g.sized === 'boolean') out.sized = g.sized;
    if (g.heightChosen === true) out.heightChosen = true;
    return out;
}

/**
 * Whether a remembered rect's SIZE was chosen by the user. A record with no
 * `sized` flag predates it: it counts as chosen unless its size is exactly the
 * caller's old default (`legacyDefaultSize`), which every close used to save.
 */
export function rememberedSizeIsChosen(geom, legacyDefaultSize) {
    if (!geom) return false;
    if (typeof geom.sized === 'boolean') return geom.sized;
    const old = legacyDefaultSize;
    return !(old && Math.round(geom.w) === old.w && Math.round(geom.h) === old.h);
}

/** Remember `geom` for `id`. Rounds to whole pixels — sub-pixel noise is churn. */
export function writeGeometry(id, geom, storage) {
    const s = store(storage);
    if (!s || !geom) return false;
    if (!isNum(geom.x) || !isNum(geom.y) || !isNum(geom.w) || !isNum(geom.h)) return false;
    const all = readAll(storage);
    all[id] = {
        x: Math.round(geom.x), y: Math.round(geom.y),
        w: Math.round(geom.w), h: Math.round(geom.h),
        sized: geom.sized === true,
    };
    if (geom.heightChosen === true) all[id].heightChosen = true;
    try {
        s.setItem(STORAGE_KEY, JSON.stringify(all));
        return true;
    } catch (e) {
        // Quota or blocked storage — the modal still works, it just forgets.
        return false;
    }
}

/** Forget `id` (used by tests and by any future "reset layout" action). */
export function clearGeometry(id, storage) {
    const s = store(storage);
    if (!s) return false;
    const all = readAll(storage);
    delete all[id];
    try {
        s.setItem(STORAGE_KEY, JSON.stringify(all));
        return true;
    } catch (e) {
        return false;
    }
}

/**
 * Make `card` draggable by `handle`, restore its remembered geometry, and keep
 * that record up to date. The card is positioned absolutely within its
 * (already positioned) overlay, so it must be in the DOM before this is called
 * — the first-open geometry is measured from its CSS-given size.
 *
 * Resizing itself is CSS (`resize: both` on the card); this only observes the
 * result. That keeps the grip native and the JS to bookkeeping.
 *
 * @param {HTMLElement} card
 * @param {{id:string, handle?:HTMLElement, minW?:number, minH?:number,
 *          margin?:number, storage?:Storage, noDragSelector?:string,
 *          legacyDefaultSize?:{w:number,h:number}, fillHeight?:boolean}} opts
 * @returns {function(): void} dispose — removes every listener it added
 */
export function installModalGeometry(card, opts) {
    const o = opts || {};
    const id = o.id;
    if (!card || !id || typeof window === 'undefined') return function () {};

    const handle = o.handle || card;
    const min = {
        minW: o.minW || DEFAULT_MIN_W,
        minH: o.minH || DEFAULT_MIN_H,
        margin: isNum(o.margin) ? o.margin : DEFAULT_MARGIN,
    };
    const noDrag = o.noDragSelector || null;
    const viewport = function () {
        return { width: window.innerWidth, height: window.innerHeight };
    };

    // The size this module last set; a card size that differs from it was
    // changed by the user's resize grip.
    let appliedW = 0;
    let appliedH = 0;
    let sized = false;
    let heightChosen = false;

    function apply(geom) {
        if (!geom) return;
        appliedW = geom.w;
        appliedH = geom.h;
        card.style.position = 'absolute';
        card.style.margin = '0';
        // The rect below is already viewport-clamped; a stylesheet `max-width`
        // on top of it would silently shrink it and leave the card flush
        // against one edge.
        card.style.maxWidth = 'none';
        card.style.maxHeight = 'none';
        card.style.left = geom.x + 'px';
        card.style.top = geom.y + 'px';
        card.style.width = geom.w + 'px';
        card.style.height = geom.h + 'px';
    }

    function current() {
        const r = card.getBoundingClientRect();
        return { x: r.left, y: r.top, w: r.width, h: r.height, sized: sized, heightChosen: heightChosen };
    }

    // `geom`, at the viewport's full height if the user has not chosen a height.
    function filled(geom) {
        if (!o.fillHeight || heightChosen) return geom;
        return { x: geom.x, y: min.margin, w: geom.w, h: viewport().height - 2 * min.margin };
    }

    // --- Restore, or centre at the size the stylesheet asked for ------------
    // A remembered position comes back as is; a remembered size only if the
    // user chose it. Otherwise the stylesheet's size, keeping the old centre.
    const base = card.getBoundingClientRect();
    const stored = readGeometry(id, o.storage);
    if (stored && rememberedSizeIsChosen(stored, o.legacyDefaultSize)) {
        sized = true;
        heightChosen = stored.heightChosen === true;
        apply(clampGeometry(filled(stored), viewport(), min));
    } else if (stored) {
        apply(clampGeometry(filled({
            x: stored.x + (stored.w - base.width) / 2,
            y: stored.y + (stored.h - base.height) / 2,
            w: base.width, h: base.height,
        }), viewport(), min));
    } else {
        const centred = centerGeometry(base.width, base.height, viewport(), min);
        apply(centred && clampGeometry(filled(centred), viewport(), min));
    }

    let persistTimer = 0;
    function persistSoon() {
        if (persistTimer) clearTimeout(persistTimer);
        persistTimer = setTimeout(function () {
            persistTimer = 0;
            writeGeometry(id, current(), o.storage);
        }, 200);
    }

    // --- Drag by the handle -------------------------------------------------
    let drag = null;
    function onPointerDown(e) {
        if (e.button !== undefined && e.button !== 0) return;
        if (noDrag && e.target && e.target.closest && e.target.closest(noDrag)) return;
        const r = card.getBoundingClientRect();
        drag = { dx: e.clientX - r.left, dy: e.clientY - r.top, id: e.pointerId };
        card.classList.add('modal-dragging');
        if (handle.setPointerCapture && e.pointerId !== undefined) {
            try { handle.setPointerCapture(e.pointerId); } catch (err) { /* not captured */ }
        }
        e.preventDefault();
    }
    function onPointerMove(e) {
        if (!drag) return;
        const r = card.getBoundingClientRect();
        const next = clampGeometry(
            { x: e.clientX - drag.dx, y: e.clientY - drag.dy, w: r.width, h: r.height },
            viewport(), min);
        apply(next);
    }
    function onPointerUp() {
        if (!drag) return;
        drag = null;
        card.classList.remove('modal-dragging');
        writeGeometry(id, current(), o.storage);
    }

    handle.addEventListener('pointerdown', onPointerDown);
    handle.addEventListener('pointermove', onPointerMove);
    handle.addEventListener('pointerup', onPointerUp);
    handle.addEventListener('pointercancel', onPointerUp);

    // --- Persist the result of a CSS resize ---------------------------------
    let ro = null;
    if (typeof ResizeObserver !== 'undefined') {
        ro = new ResizeObserver(function () {
            if (drag) return;
            const r = card.getBoundingClientRect();
            const heightMoved = Math.abs(r.height - appliedH) > 1;
            if (Math.abs(r.width - appliedW) > 1 || heightMoved) {
                sized = true;
                if (heightMoved && o.fillHeight) heightChosen = true;
                appliedW = r.width;
                appliedH = r.height;
            }
            persistSoon();
        });
        ro.observe(card);
    }

    // --- Keep the card reachable when the window changes size ---------------
    function onWindowResize() {
        apply(clampGeometry(filled(current()), viewport(), min));
        persistSoon();
    }
    window.addEventListener('resize', onWindowResize);

    return function dispose() {
        if (persistTimer) { clearTimeout(persistTimer); persistTimer = 0; }
        // Capture the final rect — a resize that ended inside the debounce
        // window would otherwise be lost when the modal closes.
        writeGeometry(id, current(), o.storage);
        handle.removeEventListener('pointerdown', onPointerDown);
        handle.removeEventListener('pointermove', onPointerMove);
        handle.removeEventListener('pointerup', onPointerUp);
        handle.removeEventListener('pointercancel', onPointerUp);
        window.removeEventListener('resize', onWindowResize);
        if (ro) ro.disconnect();
    };
}
