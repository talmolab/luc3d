// ui/keyboard-target.js — who owns a keystroke: the focused control, or the app?
//
// Dependency-free on purpose: it imports NO project modules, so it can be
// bridged into the browser test runner (`tests/test-runner.html`) and the `vm`
// sandbox runner without dragging `app.js` in. Every global keydown handler in
// the app routes its "am I allowed to act on this key?" question through here,
// so the answer is defined once instead of ten times.
//
// ## The bug this exists for (issue #163)
//
// Ten separate keydown handlers each carried their own copy of
//
//     if (e.target.tagName === 'INPUT' || e.target.tagName === 'TEXTAREA' ||
//         e.target.isContentEditable) return;
//
// meaning "don't steal keys from someone who is typing". But `tagName` is
// `INPUT` for a CHECKBOX too, and for a radio, a range slider and a file
// picker. So the moment the user clicked the User / Predicted / Reproj / Errors
// checkbox, that one test went true for every keystroke and EVERY shortcut in
// the app went dead — spacebar toggled the checkbox instead of playing the
// video, and the only cure was to click back onto a video pane.
//
// ## The two halves of the fix
//
// **1. Ask what the control actually consumes, not what tag it is.** A text
// field consumes the whole alphabet, so it blocks everything. A checkbox
// consumes exactly one key — Space — and has no claim on `f`, `n`, the arrows
// or anything else. `shouldIgnoreShortcut` draws that line, which is also what
// keeps the app usable for someone driving it from the keyboard: they can Tab
// to a checkbox and still step frames.
//
// **2. Give focus back after a POINTER click.** Fixing the guard alone still
// leaves Space ambiguous — a focused checkbox legitimately owns it, so play /
// pause would stay broken for exactly the interaction the issue describes.
// `installFocusRelease` blurs a control whose entire keyboard contract is
// "activate me" once a pointer has just done that, since the click already
// delivered everything that focus was good for. Keyboard focus is detected via
// `:focus-visible` and deliberately left alone: someone who tabbed to the
// checkbox and pressed Space still gets a toggle, not a play.
//
// Text fields, selects and sliders are NEVER blurred — focus there is the start
// of an interaction, not the end of one.

// Input types that take free text. `el.type` reports 'text' for a missing or
// unknown type, which lands in this set — the safe default, since this is the
// bucket that blocks every shortcut.
const TEXT_INPUT_TYPES = new Set([
    'text', 'search', 'url', 'tel', 'email', 'password', 'number',
    'date', 'datetime-local', 'month', 'week', 'time',
]);

// Input types whose whole keyboard contract is "activate me".
const ACTIVATABLE_INPUT_TYPES = new Set([
    'button', 'submit', 'reset', 'file', 'image', 'color',
]);

const CHECKABLE_INPUT_TYPES = new Set(['checkbox', 'radio']);

// Keys a focused <input type="range"> consumes natively. Every one of them is
// also an app shortcut (frame stepping, Home/End), which is why a slider has to
// be asked rather than assumed.
const RANGE_KEYS = new Set([
    'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown',
    'Home', 'End', 'PageUp', 'PageDown',
]);

function tagOf(t) {
    return (t && t.tagName) ? String(t.tagName).toUpperCase() : '';
}

function inputTypeOf(t) {
    // The DOM normalizes and lowercases `input.type` for us.
    return (t && typeof t.type === 'string') ? t.type.toLowerCase() : '';
}

function roleOf(t) {
    return (t && t.getAttribute) ? String(t.getAttribute('role') || '').toLowerCase() : '';
}

function isSpaceKey(key) {
    return key === ' ' || key === 'Spacebar';
}

/**
 * True when `t` is somewhere the user types free text, so no shortcut may fire
 * at all.
 *
 * `<select>` counts: it consumes the arrows, Home/End, Enter and letter
 * typeahead — very nearly the whole shortcut alphabet — so treating it like a
 * text field is both simpler and safer than enumerating what it keeps.
 *
 * @param {EventTarget} t
 * @returns {boolean}
 */
export function isTextEntryTarget(t) {
    if (!t) return false;
    if (t.isContentEditable) return true;
    const tag = tagOf(t);
    if (tag === 'TEXTAREA' || tag === 'SELECT') return true;
    if (tag === 'INPUT') return TEXT_INPUT_TYPES.has(inputTypeOf(t) || 'text');
    const role = roleOf(t);
    return role === 'textbox' || role === 'searchbox' || role === 'combobox';
}

/**
 * True when the focused control natively consumes THIS key, so the app must not
 * also act on it. Everything else is fair game — a focused checkbox has no
 * claim on `f` or the arrow keys.
 *
 * A modifier chord is never the control's own: `Mod+S` must still save while a
 * checkbox has focus.
 *
 * @param {EventTarget} t
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function targetOwnsKey(t, e) {
    if (!t || !e) return false;
    if (e.ctrlKey || e.metaKey || e.altKey) return false;

    const key = e.key;
    const tag = tagOf(t);
    const type = tag === 'INPUT' ? inputTypeOf(t) : '';
    const role = roleOf(t);

    if ((tag === 'INPUT' && type === 'range') || role === 'slider') {
        return RANGE_KEYS.has(key);
    }
    // Space toggles a checkbox or radio; Enter does not.
    if ((tag === 'INPUT' && CHECKABLE_INPUT_TYPES.has(type)) ||
        role === 'checkbox' || role === 'switch' || role === 'radio') {
        return isSpaceKey(key);
    }
    if (tag === 'BUTTON' || tag === 'SUMMARY' ||
        (tag === 'INPUT' && ACTIVATABLE_INPUT_TYPES.has(type)) ||
        role === 'button') {
        return isSpaceKey(key) || key === 'Enter';
    }
    // A link activates on Enter only — Space scrolls the page.
    if (role === 'link' || (tag === 'A' && t.hasAttribute && t.hasAttribute('href'))) {
        return key === 'Enter';
    }
    return false;
}

/**
 * The one guard every global keydown handler uses: true when this keystroke
 * belongs to whatever has focus rather than to the app.
 *
 * @param {KeyboardEvent} e
 * @returns {boolean}
 */
export function shouldIgnoreShortcut(e) {
    if (!e) return false;
    const t = e.target;
    return isTextEntryTarget(t) || targetOwnsKey(t, e);
}

/**
 * True for a control whose entire keyboard contract is "activate me" — so once
 * a pointer HAS activated it, holding focus buys the user nothing and costs
 * them the shortcut that shares the key.
 *
 * Deliberately excludes text fields, selects and sliders: focus there is the
 * beginning of an interaction, not the end of one.
 *
 * @param {EventTarget} t
 * @returns {boolean}
 */
export function isTransientFocusControl(t) {
    if (!t) return false;
    const tag = tagOf(t);
    if (tag === 'BUTTON' || tag === 'SUMMARY') return true;
    if (tag === 'INPUT') {
        const type = inputTypeOf(t);
        return CHECKABLE_INPUT_TYPES.has(type) || ACTIVATABLE_INPUT_TYPES.has(type);
    }
    const role = roleOf(t);
    return role === 'button' || role === 'checkbox' || role === 'switch' || role === 'radio';
}

// `:focus-visible` is the browser's own answer to "did this focus come from the
// keyboard?", which is exactly the question here, and it is far more reliable
// than reading `event.detail` — a click on a <label> forwards a SYNTHETIC click
// to its control with `detail: 0`, indistinguishable from a keyboard one.
function isKeyboardFocused(el) {
    try {
        return !!(el && el.matches && el.matches(':focus-visible'));
    } catch (err) {
        // Unsupported selector: assume pointer focus, which is the case this
        // whole module exists for.
        return false;
    }
}

/**
 * Blur `el` if it is a pointer-focused activate-me control. No-op for anything
 * else, including a keyboard-focused one.
 *
 * @param {Element} el
 * @param {Document} [doc]
 * @returns {boolean} whether focus was released
 */
export function releaseTransientFocus(el, doc) {
    const d = doc || (el && el.ownerDocument);
    if (!el || !d) return false;
    if (!isTransientFocusControl(el)) return false;
    if (d.activeElement !== el) return false;
    if (isKeyboardFocused(el)) return false;
    if (typeof el.blur !== 'function') return false;
    el.blur();
    return true;
}

let _focusReleaseDoc = null;

/**
 * Install the one delegated click listener that hands focus back to the
 * document after a pointer activates a checkbox, radio or button. Idempotent
 * per document.
 *
 * @param {Document} [doc]
 * @returns {boolean} whether a listener was installed by this call
 */
export function installFocusRelease(doc) {
    const d = doc || (typeof document !== 'undefined' ? document : null);
    if (!d || !d.addEventListener) return false;
    if (_focusReleaseDoc === d) return false;
    _focusReleaseDoc = d;
    d.addEventListener('click', function (e) {
        const t = e.target;
        if (!isTransientFocusControl(t)) return;
        // Deferred a turn of the event loop for two reasons: a <label> click
        // forwards to its control and focus lands AFTER this listener runs, and
        // `input`/`change` fire as part of the activation behavior — blurring
        // mid-dispatch would be reaching into someone else's event.
        setTimeout(function () { releaseTransientFocus(t, d); }, 0);
    });
    return true;
}

// Test seam: forget the installed-on document so a fresh one can be wired.
export function _resetFocusReleaseForTests() {
    _focusReleaseDoc = null;
}
