/**
 * ui/connect/layers.js — which modal layer is on top, so Esc / Tab / Enter reach only that one.
 *
 * LUCID addition (no sleap-app counterpart: Radix stacks its dialogs itself). The Connect window, New job
 * wizard, job viewer, merge dialog, worker file browser and the in-app ask dialog each listen for Esc on
 * `document` in the capture phase; listeners on one node all run in registration order, so a layer opened
 * EARLIER saw the key first and closed together with the dialog above it. Each handler now asks
 * `layerAbove(its scrim)` and ignores the key when another layer sits over it (computed z-index, then DOM order).
 *
 * Exports: layerAbove, MODAL_LAYER_SELECTOR.
 */

/** Every full-window layer a Connect dialog can sit under (the window itself included, for popovers over it). */
export const MODAL_LAYER_SELECTOR = '.cw-scrim, .njw-scrim, .rfb-scrim, .cj-scrim, .ask-modal-overlay, .plane-confirm-overlay';

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
