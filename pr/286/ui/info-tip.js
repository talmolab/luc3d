/**
 * ui/info-tip.js — the ⓘ explanation, shown WHERE THE USER IS LOOKING.
 *
 * An info button's text used to go to `setStatus`, which paints it in the
 * status bar at the bottom-left of the window. That is the furthest point on
 * screen from the icon the user just clicked, and on a wide window it is
 * entirely outside the region they were reading — so the answer arrived
 * somewhere they had no reason to look, and the status bar (which also carries
 * save results, triangulation counts and errors) had a help string sitting in
 * it afterwards. The explanation belongs next to the pointer that asked for it.
 *
 * ## The tip lives and dies with the hover
 *
 * It appears when the pointer reaches the icon and disappears when the pointer
 * leaves it — **including when the icon was clicked**. A click only guarantees
 * one is showing, which is what a touch device needs (a tap, no hover); it buys
 * no extra time. Anything pinned open by a click is an explanation that outlives
 * the question, sitting over a panel the user has already moved on from and
 * needing a second, deliberate click to clear. The single exception is a tip
 * summoned by the KEYBOARD, which has no pointer to leave and so waits for blur
 * or `Esc`.
 *
 * ## One popover, one delegated listener
 *
 * There is a single `#infoTip` element and a single set of listeners on
 * `document`, matching `[data-infotip]`. Delegation rather than per-element
 * wiring is what makes this work for the panels that REBUILD their rows: the
 * plane panel re-renders its tables on almost every interaction, so an info
 * button wired at creation time would have to be re-wired by every renderer,
 * and the one that forgot would fail silently — an icon that simply does
 * nothing on hover looks exactly like an icon whose text is empty.
 *
 * ## Why not `title`
 *
 * The native tooltip cannot be styled, waits about a second, and vanishes after
 * a few more — too slow to answer "what do these three states mean?" and too
 * brief to read a sentence. `setInfoTip` therefore REMOVES `title` from the
 * element it takes over, or the browser's tooltip would surface underneath this
 * one a second later, saying the same thing twice in two different places. The
 * text is kept reachable to assistive tech through `aria-label`.
 *
 * ## A LEAF module
 *
 * It imports nothing. Every panel with an explanation to give is a caller, and
 * several of those already import each other.
 */

/** Gap between the pointer and the popover's nearest corner, in px. */
const CURSOR_OFFSET = 14;

/** Kept clear of the viewport edges, so the tip never sits flush. */
const EDGE_MARGIN = 8;

let tipEl = null;
let installed = false;

// The element whose text is currently showing.
let currentTarget = null;

// True only when the tip was summoned BY THE KEYBOARD. That one case has no
// pointer to leave, so it is held until blur or Esc; every pointer-driven tip
// is tied to the hover and goes away with it, clicked or not.
let keyboardHeld = false;

/** The popover, created on first use. @private */
function ensureTip() {
    if (tipEl && tipEl.isConnected) return tipEl;
    tipEl = document.createElement('div');
    tipEl.id = 'infoTip';
    tipEl.className = 'info-tip';
    tipEl.setAttribute('role', 'tooltip');
    tipEl.hidden = true;
    document.body.appendChild(tipEl);
    return tipEl;
}

/**
 * Place the popover near (x, y), clamped so the whole of it stays on screen.
 *
 * Flipping to the other side of the pointer rather than merely clamping: an
 * icon in the right-hand panel — which is where nearly all of them are — sits
 * close enough to the edge that a clamped tip would cover the pointer and the
 * icon under it, and a tip you cannot see past is worse than one on the other
 * side. Measured AFTER the text is in and the element is visible, because a
 * hidden element has no size to read.
 * @private
 */
function placeAt(x, y) {
    const el = ensureTip();
    const r = el.getBoundingClientRect();
    const vw = window.innerWidth;
    const vh = window.innerHeight;

    let left = x + CURSOR_OFFSET;
    if (left + r.width > vw - EDGE_MARGIN) left = x - CURSOR_OFFSET - r.width;
    if (left < EDGE_MARGIN) left = EDGE_MARGIN;

    let top = y + CURSOR_OFFSET;
    if (top + r.height > vh - EDGE_MARGIN) top = y - CURSOR_OFFSET - r.height;
    if (top < EDGE_MARGIN) top = EDGE_MARGIN;

    el.style.left = Math.round(left) + 'px';
    el.style.top = Math.round(top) + 'px';
}

/**
 * Show `text` at a point.
 * @param {string} text
 * @param {number} x - Viewport coordinate.
 * @param {number} y - Viewport coordinate.
 * @private
 */
function showAt(text, x, y) {
    const el = ensureTip();
    el.textContent = text;
    el.hidden = false;
    placeAt(x, y);
}

/** Put the tip away. Safe to call when nothing is showing. */
export function hideInfoTip() {
    if (tipEl) {
        tipEl.hidden = true;
        tipEl.textContent = '';
    }
    currentTarget = null;
    keyboardHeld = false;
}

/** The element the pointer is over, or null. @private */
function targetFrom(node) {
    if (!node || typeof node.closest !== 'function') return null;
    return node.closest('[data-infotip]');
}

/**
 * Give `el` an explanation shown beside the pointer.
 *
 * Idempotent, so a renderer may call it on every repaint — which is what the
 * plane panel's tables do.
 *
 * @param {Element} el
 * @param {string} text - Plain text; it is set as `textContent`, never HTML.
 */
export function setInfoTip(el, text) {
    if (!el) return;
    el.dataset.infotip = text;
    // The native tooltip would otherwise appear a second later saying the same
    // thing somewhere else. The text stays reachable to screen readers.
    if (el.hasAttribute('title')) el.removeAttribute('title');
    if (!el.hasAttribute('aria-label')) el.setAttribute('aria-label', text);
}

/**
 * Install the delegated listeners. Call once, at app setup; further calls are
 * no-ops, so a second caller cannot double every handler.
 */
export function installInfoTips() {
    if (installed) return;
    installed = true;
    ensureTip();

    document.addEventListener('mouseover', function (e) {
        const t = targetFrom(e.target);
        if (!t) {
            // Leaving the icon dismisses the tip, FULL STOP — a click does not
            // buy it a longer life. The tip is tied to the hover, so there is
            // never a stale explanation sitting over a panel the pointer has
            // moved on from. (A keyboard-summoned one is not a hover and waits
            // for blur or Esc.)
            if (currentTarget && !keyboardHeld) hideInfoTip();
            return;
        }
        // Hovering takes over from a keyboard-held tip: the pointer is now the
        // thing in charge, so it gets the pointer's dismissal rules too.
        currentTarget = t;
        keyboardHeld = false;
        showAt(t.dataset.infotip, e.clientX, e.clientY);
    });

    // Track the pointer while it is on the icon. Without this the tip stays
    // where the pointer ENTERED, which after a diagonal approach to a 16px
    // target can be far enough away to look like it belongs to something else.
    document.addEventListener('mousemove', function (e) {
        if (!currentTarget || keyboardHeld) return;
        if (!targetFrom(e.target)) { hideInfoTip(); return; }
        placeAt(e.clientX, e.clientY);
    });

    // A click does NOT pin the tip open. It only makes sure one is showing —
    // which matters on a touch device, where the tap is the only way in and
    // there is no hover to have shown it already. Dismissal stays with the
    // pointer leaving the icon, so clicking cannot strand an explanation on
    // screen over a panel the user has moved away from.
    //
    // Capture phase + `stopPropagation` because these icons sit inside things
    // that are themselves clickable — a table row, and a <summary> that folds
    // the very section being asked about. Asking what something means must not
    // also select the row it labels or close the section it heads.
    //
    // `preventDefault` is NOT also needed, and was tried: every ⓘ in the app is
    // a <button>, so the BUTTON is the click's activation target and a
    // <summary> ancestor's fold never runs. That holds only while the icon is
    // an element with its own activation behaviour — a plain <span> ⓘ inside a
    // <summary> would fold it, since the DOM runs activation behaviour after
    // dispatch and stopping propagation does not reach it.
    // `tests/e2e/plane-section-info.mjs` §4 pins the behaviour either way.
    document.addEventListener('click', function (e) {
        const t = targetFrom(e.target);
        if (!t) { hideInfoTip(); return; }
        e.stopPropagation();
        currentTarget = t;
        keyboardHeld = false;
        showAt(t.dataset.infotip, e.clientX, e.clientY);
    }, true);

    // Keyboard: there is no pointer to sit beside, so anchor under the icon —
    // and no pointer to leave either, so this is the one tip held open, until
    // blur or Esc.
    //
    // Gated on `:focus-visible`. Clicking a <button> focuses it, so without the
    // gate a mouse click would mark the tip keyboard-held and it would then
    // survive the pointer leaving — exactly the behaviour being removed here.
    // `:focus-visible` is the "arrived by keyboard" signal, so the two paths
    // stop overlapping.
    document.addEventListener('focusin', function (e) {
        const t = targetFrom(e.target);
        if (!t) { if (!keyboardHeld) hideInfoTip(); return; }
        if (typeof t.matches === 'function' && !t.matches(':focus-visible')) return;
        const r = t.getBoundingClientRect();
        currentTarget = t;
        keyboardHeld = true;
        showAt(t.dataset.infotip, r.left + r.width / 2, r.bottom);
    });

    document.addEventListener('focusout', function (e) {
        if (targetFrom(e.target)) hideInfoTip();
    });

    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && currentTarget) hideInfoTip();
    });

    // `position: fixed` does not follow a scroll, so a scrolled tip would be
    // left pointing at whatever moved into that spot. Dismiss rather than
    // reposition: unlike the pin picker (which the user is mid-interaction
    // with), this is a thing they have finished reading.
    window.addEventListener('scroll', hideInfoTip, true);
    window.addEventListener('resize', hideInfoTip);
}
