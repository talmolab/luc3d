/**
 * ui/models-3d-pane.js — the collapsible 3D pane of the two "models for views" modals (Inference ▸ Models ▸
 * Assign models…, `ui/inference-models-modal.js`; Training ▸ Models to train…, `ui/training-models-modal.js`).
 *
 * A second `Viewport3D` built with the app viewer's own display settings (`viewport3DDisplayOptions`) and the
 * same scene (the current frame's skeletons, the planes). The caller colours each camera and lights a FOCUS set
 * (`tint`, `Viewport3D.tintCameras`: the focused pyramids light up, the rest dim). Hovering a camera in the 3D
 * view reports it (`onCameraHover`), and a click on one can too (`onCameraClick`), so the caller can light the
 * same camera and its model as when a row is hovered. Camera clicks never fly the view into a camera here.
 *
 * `ids` keeps each modal's element ids (`stage`, `toggle`, `foot`) for its tests.
 */
import { state, viewport3d } from './app-state.js?v=e37e05d05839';
import { Viewport3D } from './viewport3d.js?v=e37e05d05839';
import { viewport3DDisplayOptions } from './viewport3d-options.js?v=e37e05d05839';
import { getTrackColor, getGroupColor } from './overlays.js?v=e37e05d05839';
import { getInstanceGroupsForFrame } from '../pose/triangulation.js?v=e37e05d05839';

function el(tag, cls, text) {
    const n = document.createElement(tag);
    if (cls) n.className = cls;
    if (text != null) n.textContent = text;
    return n;
}

/** True when the session's cameras carry a calibration the 3D view can place. */
export function hasCalibration(session) {
    return !!(session && Array.isArray(session.cameras) && session.cameras.length &&
        session.cameras.every(function (c) { return c && c.rotationMatrix && c.tvec; }));
}

/**
 * @param {{ids?: {stage?: string, toggle?: string, foot?: string}, title?: string,
 *          onCameraHover?: (name: string|null) => void, onCameraClick?: (name: string) => void,
 *          noCalibrationText?: string}} [o]
 * @returns {{el: HTMLElement, mount: (hasViews: boolean) => void, tint: (spec: object) => void, setFoot: (text: string) => void,
 *            setCollapsed: (c: boolean) => void, isCollapsed: () => boolean, resize: () => void, dispose: () => void}}
 */
export function createModels3DPane(o) {
    const oo = o || {};
    const ids = oo.ids || {};
    let vp = null;
    let collapsed = false;
    let lastTint = null;

    const pane = el('div', 'inf-mm-3d');
    const head = el('div', 'inf-mm-3dhead');
    head.appendChild(el('span', 'inf-mm-3dtitle', oo.title || '3D view'));
    const collapseBtn = el('button', 'inf-mm-icon', '⟩');
    collapseBtn.type = 'button';
    collapseBtn.title = 'Hide the 3D view';
    collapseBtn.setAttribute('aria-label', collapseBtn.title);
    if (ids.toggle) collapseBtn.id = ids.toggle;
    head.appendChild(collapseBtn);
    const stage = el('div', 'inf-mm-stage');
    if (ids.stage) stage.id = ids.stage;
    const stageMsg = el('div', 'inf-mm-stagemsg');
    stage.appendChild(stageMsg);
    const foot = el('div', 'inf-mm-3dfoot');
    if (ids.foot) foot.id = ids.foot;
    pane.appendChild(head);
    pane.appendChild(stage);
    pane.appendChild(foot);

    function tint(spec) {
        lastTint = spec;
        if (vp) { try { vp.tintCameras(spec); } catch (e) { /* ignore */ } }
    }

    function mount(hasViews) {
        const session = state.session;
        if (!session || !hasViews) { stageMsg.textContent = 'Import data with a calibration to see the cameras here.'; return; }
        if (!hasCalibration(session)) {
            stageMsg.textContent = oo.noCalibrationText || 'No calibration loaded, so the cameras can’t be placed.';
            return;
        }
        if (typeof THREE === 'undefined') { stageMsg.textContent = '3D view unavailable.'; return; }
        try {
            vp = new Viewport3D(stage, Object.assign({
                cameras: session.cameras,
                skeleton: session.skeleton,
                getTrackColor: getTrackColor,
                getGroupColor: function (group) {
                    return getGroupColor(group, session, state.colorByIdentity || false, state.currentFrame);
                },
                pickCameras: false,
                onCameraHover: oo.onCameraHover || null,
                onCameraClick: oo.onCameraClick || null,
            }, viewport3DDisplayOptions()));
            stageMsg.hidden = true;
            vp.setFrame(getInstanceGroupsForFrame(state.currentFrame));
            if (viewport3d && typeof viewport3d.getPlanes === 'function') {
                vp.showPlaneSurfaces = viewport3d.showPlaneSurfaces;
                vp.showPlaneNodes = viewport3d.showPlaneNodes;
                vp.planeNodeSize = viewport3d.planeNodeSize;
                vp.setPlanes(viewport3d.getPlanes());
            }
            setTimeout(function () {
                if (!vp) return;
                try { vp.resize(); vp.fitToScene(); } catch (e) { /* ignore */ }
                if (lastTint) tint(lastTint);
            }, 120);
        } catch (err) {
            console.error('[models 3D] 3D view unavailable:', err);
            vp = null;
            stageMsg.hidden = false;
            stageMsg.textContent = '3D view unavailable (WebGL required).';
        }
    }

    function setCollapsed(c) {
        collapsed = c;
        pane.classList.toggle('collapsed', c);
        collapseBtn.textContent = c ? '⟨' : '⟩';
        const label = c ? 'Show the 3D view' : 'Hide the 3D view';
        collapseBtn.title = label;
        collapseBtn.setAttribute('aria-label', label);
        if (vp) {
            try { vp.setVisible(!c); if (!c) { vp.resize(); if (lastTint) tint(lastTint); } } catch (e) { /* ignore */ }
        }
    }
    collapseBtn.addEventListener('click', function () { setCollapsed(!collapsed); });

    return {
        el: pane,
        mount: mount,
        tint: tint,
        setFoot: function (text) { foot.textContent = text || ''; },
        setCollapsed: setCollapsed,
        isCollapsed: function () { return collapsed; },
        resize: function () { if (vp) { try { vp.resize(); } catch (e) { /* ignore */ } } },
        dispose: function () { if (vp) { try { vp.dispose(); } catch (e) { /* ignore */ } vp = null; } },
    };
}
