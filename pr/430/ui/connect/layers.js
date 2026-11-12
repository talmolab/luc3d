/**
 * ui/connect/layers.js — which modal layer is on top (so Esc / Tab / Enter reach only that one), and the
 * Esc + Tab trap every Connect dialog shares.
 *
 * LUCID addition (no sleap-app counterpart: Radix stacks its dialogs itself). Capture-phase listeners on
 * `document` run in registration order, so the layer opened EARLIER saw a key first; each one now ignores
 * the key while `layerAbove(its scrim)` (computed z-index, then DOM order).
 */

/** Every full-window layer a Connect dialog can sit under (the window itself included, for popovers over it). */
const MODAL_LAYER_SELECTOR = '.cw-scrim, .njw-scrim, .rfb-scrim, .cj-scrim, .ask-modal-overlay, .plane-confirm-overlay';

const FOCUSABLE = 'button, input, select, textarea, [tabindex]';

function zOf(node) {
    const z = parseInt(getComputedStyle(node).zIndex, 10);
    return Number.isNaN(z) ? 0 : z;
}

/**
 * True when some other modal layer is stacked above `self` (an element inside a layer, or the layer itself).
 * @param {Element | null} self
 * @returns {boolean}
 */
export function layerAbove(self) {
    if (!self) return false;
    const mine = self.closest ? (self.closest(MODAL_LAYER_SELECTOR) || self) : self;
    const zMine = zOf(mine);
    const all = document.querySelectorAll(MODAL_LAYER_SELECTOR);
    for (const other of all) {
        if (other === mine || mine.contains(other)) continue;
        const z = zOf(other);
        if (z > zMine) return true;
        if (z === zMine && (mine.compareDocumentPosition(other) & Node.DOCUMENT_POSITION_FOLLOWING)) return true;
    }
    return false;
}

/**
 * Esc + Tab for a modal `card` on `scrim`: Esc calls `onEscape(e)`, Tab cycles through the card's focusables.
 * By default the listener is capture-phase, ignores keys while another layer is above, and stops Esc / Tab
 * from reaching anything else. `bubble: true` (the Connect window) listens in the bubble phase instead, leaves
 * an Esc already handled (`defaultPrevented`) and a Tab whose focus sits in a layer above alone, and stops nothing.
 *
 * @param {HTMLElement} scrim
 * @param {HTMLElement} card
 * @param {{
 *   onEscape?: (e: KeyboardEvent) => void,
 *   onKey?: (e: KeyboardEvent) => void,          // any other key
 *   blocked?: () => boolean,                     // ignore every key while true
 *   focusable?: (n: HTMLElement) => boolean,     // extra filter (default: enabled and tabIndex >= 0)
 *   selector?: string,
 *   bubble?: boolean,
 * }} [o]
 * @returns {{ release: () => void, restoreFocus: () => void }}
 */
export function trapModal(scrim, card, o) {
    o = o || {};
    const bubble = !!o.bubble;
    const prevFocus = document.activeElement;
    let active = true;

    function focusables() {
        return Array.from(card.querySelectorAll(o.selector || FOCUSABLE)).filter(function (n) {
            return !n.disabled && (bubble || n.tabIndex >= 0) && (!o.focusable || o.focusable(n));
        });
    }

    function onKey(e) {
        if (!active || (!bubble && layerAbove(scrim)) || (o.blocked && o.blocked())) return;
        if (e.key === 'Escape') {
            if (bubble && e.defaultPrevented) return;
            e.preventDefault();
            if (!bubble) e.stopPropagation();
            if (o.onEscape) o.onEscape(e);
            return;
        }
        if (e.key === 'Tab') {
            const a = document.activeElement;
            if (bubble && a && a !== document.body && !card.contains(a)) return; // a popover / dialog above owns Tab
            if (!bubble) e.stopPropagation();
            const f = focusables();
            if (!f.length) { e.preventDefault(); card.focus(); return; }
            const first = f[0], last = f[f.length - 1];
            if (!card.contains(a) || a === card) { e.preventDefault(); (e.shiftKey ? last : first).focus(); }
            else if (e.shiftKey && a === first) { e.preventDefault(); last.focus(); }
            else if (!e.shiftKey && a === last) { e.preventDefault(); first.focus(); }
            return;
        }
        if (o.onKey) o.onKey(e);
    }
    document.addEventListener('keydown', onKey, !bubble);

    return {
        release: function () {
            if (!active) return;
            active = false;
            document.removeEventListener('keydown', onKey, !bubble);
        },
        /** Focus what had it when the trap was set (if it is still in the page). */
        restoreFocus: function () {
            if (prevFocus && prevFocus.isConnected && typeof prevFocus.focus === 'function') {
                try { prevFocus.focus(); } catch (e) { /* gone */ }
            }
        },
    };
}
