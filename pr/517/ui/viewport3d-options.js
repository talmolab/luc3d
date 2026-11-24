/**
 * ui/viewport3d-options.js — the 3D viewer's display settings as the user set
 * them in Visibility ▸ 3D Viewer, read from those controls, for every
 * `Viewport3D` that should look like the app's own (the main 3D viewer,
 * `pose/initialization.js` `setup3DViewport`, and the Inference panel's
 * Models modal). A missing control falls back to the viewer's default.
 *
 * DOM reads only; no imports.
 */

function num(id, dflt) {
    var e = document.getElementById(id);
    var v = e ? parseFloat(e.value) : NaN;
    return isFinite(v) && v !== 0 ? v : dflt;
}

function bool(id, dflt) {
    var e = document.getElementById(id);
    return e ? e.checked : dflt;
}

/** The Visibility ▸ 3D Viewer settings as `Viewport3D` options. */
export function viewport3DDisplayOptions() {
    var bright = document.getElementById('vis3dBrightness');
    var b = bright ? parseFloat(bright.value) : NaN;
    var shape = document.getElementById('vis3dNodeStyle');
    var label = document.getElementById('vis3dLabelSize');
    return {
        cameraLabelSize: label ? parseInt(label.value) || 28 : 28,
        cameraSphereSize: num('vis3dSphereSize', 3),
        pyramidLength: num('vis3dPyramidLength', 40),
        showCameraLabels: bool('vis3dLabelShow', true),
        showCameraSpheres: bool('vis3dSphereShow', true),
        showCameraPyramids: bool('vis3dPyramidShow', true),
        skeletonNodeSize: num('vis3dNodeSize', 2),
        skeletonEdgeWeight: num('vis3dEdgeWeight', 0.8),
        skeletonBrightness: isNaN(b) ? 0.5 : Math.min(100, Math.max(0, b)) / 100,
        skeletonNodeShape: shape ? (shape.getAttribute('data-value') || 'circle') : 'circle',
        showSkeletonNodes: bool('vis3dNodeShow', true),
        showSkeletonEdges: bool('vis3dEdgeShow', true),
    };
}
