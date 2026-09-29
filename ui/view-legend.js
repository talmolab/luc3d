/**
 * view-legend.js — the Visibility panel's "Display Legend" key, as pane chrome.
 *
 * The legend used to be painted onto the overlay CANVAS by `drawLegend`
 * (ui/overlays.js), anchored to the canvas's top-right corner. That put it
 * inside the `.canvas-wrapper`, which is the element `applyZoom` rotates — so a
 * rotated view tipped the legend over with the video, and at 180 degrees it hung
 * upside down in what was now the bottom-left. It also meant "top-right" was the
 * top-right of the VIDEO, so on a letterboxed pane the legend sat inside the
 * picture with empty bars beside it, and its on-screen size drifted with the
 * video's resolution (a fixed 310 canvas px is a different number of screen px
 * per camera).
 *
 * As DOM in the pane — a sibling of the wrapper, not a child — all three go
 * away for free: it is outside the transform so it cannot rotate, it is
 * anchored to the pane so it may overhang the video, and it is sized in CSS px
 * so every view's legend matches. It is also crisper, with no 2x offscreen
 * canvas needed to get readable text.
 *
 * `drawLegend` is KEPT and unchanged: the overlay-video export has to burn the
 * legend into the encoded frames, where there is no DOM to lean on. That path
 * already hoisted it out of the view transform for the same upright-ness reason
 * (`drawTileContent`, ui/overlay-export-modal.js), so the two agree on what a
 * legend is and only differ in where it can live.
 *
 * Colors come from the same constants the overlays draw with, so the key cannot
 * drift from the thing it is keying.
 */

import { state } from './app-state.js';
import { TRACK_COLORS, REPROJECTION_COLOR } from './overlays.js';

const LEGEND_CLASS = 'view-legend';

// The error-vector swatch is a short three-segment line running green -> amber
// -> red, matching `errorColor`'s low/medium/high bands in ui/overlays.js.
const ERROR_BANDS = ['#4ade80', '#fbbf24', '#ef4444'];

/**
 * The legend rows for a given visibility state, in draw order.
 *
 * Mirrors `drawLegend`'s item list exactly — same rows, same order, same
 * conditions — so the live legend and the exported one never disagree.
 *
 * @param {{showDetected?: boolean, showReprojected?: boolean, showErrors?: boolean}} opts
 * @returns {Array<{type: string, label: string}>}
 */
export function legendItems(opts) {
    opts = opts || {};
    const items = [];
    if (opts.showDetected !== false) items.push({ type: 'detected', label: 'Detected' });
    if (opts.showReprojected !== false) items.push({ type: 'reprojected', label: 'Reprojected' });
    if (opts.showErrors !== false) items.push({ type: 'error', label: 'Error vector' });
    return items;
}

/** One row's swatch, as inline SVG sized to the row's text. */
function buildIcon(type) {
    const NS = 'http://www.w3.org/2000/svg';
    const svg = document.createElementNS(NS, 'svg');
    svg.setAttribute('class', 'view-legend-icon');
    svg.setAttribute('viewBox', '0 0 18 12');
    svg.setAttribute('aria-hidden', 'true');

    if (type === 'detected') {
        const dot = document.createElementNS(NS, 'circle');
        dot.setAttribute('cx', '9');
        dot.setAttribute('cy', '6');
        dot.setAttribute('r', '4');
        dot.setAttribute('fill', TRACK_COLORS[0]);
        svg.appendChild(dot);
    } else if (type === 'reprojected') {
        const x = document.createElementNS(NS, 'path');
        x.setAttribute('d', 'M5 2 L13 10 M13 2 L5 10');
        x.setAttribute('stroke', REPROJECTION_COLOR);
        x.setAttribute('stroke-width', '2');
        x.setAttribute('stroke-linecap', 'round');
        x.setAttribute('fill', 'none');
        svg.appendChild(x);
    } else if (type === 'error') {
        for (let i = 0; i < ERROR_BANDS.length; i++) {
            const seg = document.createElementNS(NS, 'line');
            seg.setAttribute('x1', String(1 + i * 16 / 3));
            seg.setAttribute('y1', '6');
            seg.setAttribute('x2', String(1 + (i + 1) * 16 / 3));
            seg.setAttribute('y2', '6');
            seg.setAttribute('stroke', ERROR_BANDS[i]);
            seg.setAttribute('stroke-width', '2.5');
            seg.setAttribute('stroke-linecap', 'round');
            svg.appendChild(seg);
        }
    }
    return svg;
}

/**
 * Create or update one pane's legend element, or remove it when there is
 * nothing to show.
 *
 * Rebuilds only when the row set actually changed — this runs from
 * `drawAllOverlays`, i.e. on every frame of playback, and replacing the DOM
 * 30 times a second for an unchanging three-row key would be pure churn.
 * `dataset.legendKey` is the cheap comparison that avoids it.
 *
 * @param {HTMLElement} cell - the `.video-cell` pane element
 * @param {Array<{type: string, label: string}>} items - from `legendItems`
 */
function syncCell(cell, items) {
    let el = cell.querySelector(':scope > .' + LEGEND_CLASS);

    if (items.length === 0) {
        if (el) el.remove();
        return;
    }

    const key = items.map(i => i.type).join(',');
    if (el && el.dataset.legendKey === key) return;

    if (!el) {
        el = document.createElement('div');
        el.className = LEGEND_CLASS;
        cell.appendChild(el);
    }
    el.dataset.legendKey = key;
    el.textContent = '';

    for (const item of items) {
        const row = document.createElement('div');
        row.className = 'view-legend-row';
        row.appendChild(buildIcon(item.type));
        const text = document.createElement('span');
        text.textContent = item.label;
        row.appendChild(text);
        el.appendChild(row);
    }
}

/**
 * Put every visible view's legend in sync with the current visibility state.
 *
 * Called from `drawAllOverlays` so it follows the same triggers the canvas
 * overlays do — including the Visibility panel's own checkbox handlers, which
 * already end in a redraw, so "Display Legend" needs no extra wiring.
 *
 * @param {boolean} showLegend - the Visibility panel's Display Legend toggle
 * @param {{showDetected?: boolean, showReprojected?: boolean, showErrors?: boolean}} [opts]
 */
export function syncViewLegends(showLegend, opts) {
    const views = state && state.views;
    if (!views) return;
    const items = showLegend ? legendItems(opts) : [];
    for (const view of views) {
        const anchor = view.overlayCanvas || view.canvas;
        if (!anchor || !anchor.closest) continue;
        const cell = anchor.closest('.video-cell');
        if (cell) syncCell(cell, items);
    }
}
