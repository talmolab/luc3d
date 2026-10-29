/**
 * ui/node-tooltip.js — the node under the pointer, named, with a prediction's
 * per-node score: SLEAP 1.6.5's node tooltip, in LUCID's video views.
 *
 * SLEAP gives every node a Qt tooltip (`QtNode`, sleap/gui/widgets/video.py):
 * the node's name, and for a predicted point a second line
 * `(score: 0.94)` — the model's confidence in THAT node, not the instance.
 * This module shows the same text. The interaction manager decides which node
 * the pointer is on and what it says (`setNodeTooltipTarget`, on every
 * mousemove over a view); the score comes from `Session.predictedNodeScore`.
 *
 * ## The color says WHICH skeleton
 *
 * The text names a node, but where skeletons overlap the pointer can sit on
 * two of them at once, and "trunk (score: 0.42)" does not say whose trunk.
 * The tip's left edge is a stripe in the color that instance is drawn from —
 * its track's, or its identity's in Identity mode, as the renderer chose it
 * (`target.color`, from `ui/overlays.js` via the interaction manager). It is
 * the base color, not a selection's white or a prediction's desaturated tint:
 * it identifies the animal, not the instance's state.
 *
 * ## Timing is Qt's
 *
 * A node is a few pixels across and the pointer crosses dozens of them while
 * annotating, so a tip that appeared instantly would flicker over the very
 * points being placed. Qt waits `NODE_TIP_DELAY_MS` before the first tip, then
 * stays "awake" — moving onto another node shows its tip at once, including
 * after a brief pass over empty space (`NODE_TIP_AWAKE_MS`). A press, a key or
 * the wheel puts it back to sleep, as in Qt. Once shown, a tip stays where it
 * appeared rather than following the pointer, also as Qt's does.
 *
 * ## It never outlives what it describes
 *
 * The text is about one node on one frame. A new frame (playback, a step, a
 * seek) moves the node out from under a pointer that has not moved, so the
 * render path calls `syncNodeTooltipFrame` and a tip for another frame goes
 * away. Pressing, typing, scrolling, zooming and leaving the view do too.
 *
 * The tip holds strings and numbers only — never an Instance — so it cannot
 * keep a lazy project's frame alive.
 *
 * It shares the ⓘ tip's look and its placement rule (`placeTipNear`), and is
 * `pointer-events: none` for the same reason: a tip that took the hover would
 * make the view see a `mouseleave` and hide it again.
 */

import { placeTipNear } from './info-tip.js?v=0682ad96f11c';

/** Before the first tip: Qt's `SH_ToolTip_WakeUpDelay`, so it feels like SLEAP. */
export const NODE_TIP_DELAY_MS = 700;

/** After a tip hides, another one shows at once for this long (Qt's fall-asleep). */
export const NODE_TIP_AWAKE_MS = 2000;

/**
 * The tooltip text, exactly as SLEAP 1.6.5 formats it: the node name, and when
 * the node has a score, `(score: 0.94)` on a second line.
 * @param {string} nodeName
 * @param {number} score - NaN when the node has no score
 * @returns {string}
 */
export function nodeTooltipText(nodeName, score) {
    const name = String(nodeName);
    return Number.isFinite(score) ? name + '\n(score: ' + score.toFixed(2) + ')' : name;
}

let nodeTipEl = null;
let nodeTipInstalled = false;
/** The node the pointer is on: `{ key, text, frameIdx }`, showing or pending. */
let nodeTipTarget = null;
let nodeTipShown = false;
let nodeTipTimer = 0;
/** Until this time (ms) a new tip shows without the delay. */
let nodeTipAwakeUntil = 0;
let nodeTipX = 0;
let nodeTipY = 0;

/** The popover, created on first use. @private */
function ensureNodeTip() {
    if (nodeTipEl && nodeTipEl.isConnected) return nodeTipEl;
    nodeTipEl = document.createElement('div');
    nodeTipEl.id = 'nodeTip';
    nodeTipEl.className = 'info-tip node-tip';
    nodeTipEl.setAttribute('role', 'tooltip');
    nodeTipEl.hidden = true;
    document.body.appendChild(nodeTipEl);
    return nodeTipEl;
}

/** Show the current target's text where the pointer is. @private */
function showNodeTip() {
    nodeTipTimer = 0;
    if (!nodeTipTarget) return;
    const el = ensureNodeTip();
    el.textContent = nodeTipTarget.text;
    if (nodeTipTarget.color) el.style.setProperty('--node-tip-color', nodeTipTarget.color);
    else el.style.removeProperty('--node-tip-color');
    el.hidden = false;
    placeTipNear(el, nodeTipX, nodeTipY);
    nodeTipShown = true;
}

/** Hide the tip and forget its node. @param {boolean} stayAwake @private */
function dropNodeTip(stayAwake) {
    if (nodeTipTimer) { clearTimeout(nodeTipTimer); nodeTipTimer = 0; }
    nodeTipAwakeUntil = (stayAwake && nodeTipShown) ? Date.now() + NODE_TIP_AWAKE_MS : 0;
    nodeTipTarget = null;
    nodeTipShown = false;
    if (nodeTipEl) {
        nodeTipEl.hidden = true;
        nodeTipEl.textContent = '';
    }
}

/**
 * Put the tip away and back to sleep — the next one waits the full delay.
 * Safe to call when nothing is showing.
 */
export function hideNodeTooltip() {
    dropNodeTip(false);
}

/**
 * The node the pointer is on, or null when it is on none. Called on every
 * mousemove over a view.
 *
 * @param {{key: string, text: string, frameIdx: number, color: (string|null)}|null} target
 *   `key` names the node (view, frame, instance, node); the same key again
 *   leaves a showing tip where it is. `color` is the instance's drawn color,
 *   shown as the tip's left stripe (null: the plain border).
 * @param {number} clientX
 * @param {number} clientY
 */
export function setNodeTooltipTarget(target, clientX, clientY) {
    nodeTipX = clientX;
    nodeTipY = clientY;
    if (!target) {
        if (nodeTipTarget) dropNodeTip(true);
        return;
    }
    if (nodeTipTarget && nodeTipTarget.key === target.key) return;
    const awake = nodeTipShown || Date.now() < nodeTipAwakeUntil;
    if (nodeTipTimer) { clearTimeout(nodeTipTimer); nodeTipTimer = 0; }
    nodeTipTarget = target;
    if (awake) showNodeTip();
    else nodeTipTimer = setTimeout(showNodeTip, NODE_TIP_DELAY_MS);
}

/**
 * The views are now drawing `frameIdx`: a tip about another frame describes a
 * node that is no longer under the pointer, so it goes. A redraw that names no
 * frame is not a frame change.
 * @param {number} frameIdx
 */
export function syncNodeTooltipFrame(frameIdx) {
    if (nodeTipTarget && Number.isFinite(frameIdx) && nodeTipTarget.frameIdx !== frameIdx) {
        hideNodeTooltip();
    }
}

/**
 * Install the listeners that put the tip away. Call once, at app setup;
 * further calls are no-ops.
 */
export function installNodeTooltip() {
    if (nodeTipInstalled) return;
    nodeTipInstalled = true;
    // Capture phase: the views stop some of these from bubbling (Alt+wheel
    // rotation, a drag), and the tip must go regardless.
    document.addEventListener('mousedown', hideNodeTooltip, true);
    document.addEventListener('keydown', hideNodeTooltip, true);
    document.addEventListener('wheel', hideNodeTooltip, { capture: true, passive: true });
    window.addEventListener('scroll', hideNodeTooltip, true);
    window.addEventListener('resize', hideNodeTooltip);
    window.addEventListener('blur', hideNodeTooltip);
}
