// ui/triangulation-methods-figure.js
// The DLT-vs-Refined diagram under the Settings ▸ Default Triangulation choices.
//
// Two top-down sketches of the SAME three cameras and detections, one per
// method: each camera's 2D detection (orange) on its image plane, the line of
// sight through it, the 3D answer (blue), where that answer lands back in each
// camera (blue ring) and the pixel error between the two (red). The right-hand
// camera's detection is a stray, so DLT's single solve is pulled toward it and
// leaves every camera a little off, while Refined (bundle adjustment, cameras
// held fixed) fits the two that agree and leaves the stray one off.
//
// The coordinates are a hand-tuned illustration, not output of the real
// solvers (`pose/triangulation-core.js`): an equal-weight least-squares point
// for DLT and a robust pixel-error minimum for Refined, computed once for this
// layout. Colours come from the theme variables in `styles.css` (`.tri-methods`).
//
// Depends on: nothing.

// Shared by both sketches: the three cameras, their image planes, the
// detections on them and the lines of sight through those detections.
var CAMERA_BODY = '<rect x="-13" y="-7" width="14" height="14" rx="2" class="tm-cam"/>'
    + '<path d="M1 -4 L7 -7 L7 7 L1 4 Z" class="tm-cam"/>';
var RAYS = '<line x1="91.2" y1="97.9" x2="242.9" y2="53.8" class="tm-ray"/>'
    + '<line x1="148.8" y1="108" x2="146.3" y2="-50" class="tm-ray"/>'
    + '<line x1="218.4" y1="67.5" x2="102.5" y2="-30.7" class="tm-ray tm-ray-stray"/>';
var CAMERAS = '<line x1="101.5" y1="130.9" x2="80" y2="62.2" class="tm-plane"/>'
    + '<g transform="translate(22 118) rotate(-17.4)">' + CAMERA_BODY + '</g>'
    + '<line x1="186" y1="108" x2="114" y2="108" class="tm-plane"/>'
    + '<g transform="translate(150 180) rotate(-90)">' + CAMERA_BODY + '</g>'
    + '<line x1="220" y1="62.2" x2="198.5" y2="130.9" class="tm-plane"/>'
    + '<g transform="translate(278 118) rotate(-162.6)">' + CAMERA_BODY + '</g>';
var DETECTIONS = [[91.2, 97.9], [148.8, 108], [218.4, 67.5]];
var CAMERA_CENTRES = [[22, 118], [150, 180], [278, 118]];

/**
 * One sketch: shared scene, the 3D answer `point`, the lines back to each
 * camera, and per camera the landing spot `landings[i]` with its pixel error.
 */
function sketch(point, landings, extra) {
    var s = RAYS;
    CAMERA_CENTRES.forEach(function (c) {
        s += '<line x1="' + c[0] + '" y1="' + c[1] + '" x2="' + point[0] + '" y2="' + point[1] + '" class="tm-back"/>';
    });
    s += CAMERAS;
    DETECTIONS.forEach(function (d, i) {
        var q = landings[i];
        s += '<line x1="' + d[0] + '" y1="' + d[1] + '" x2="' + q[0] + '" y2="' + q[1] + '" class="tm-gap"/>'
            + '<circle cx="' + d[0] + '" cy="' + d[1] + '" r="3" class="tm-det"/>'
            + '<circle cx="' + q[0] + '" cy="' + q[1] + '" r="3.6" class="tm-proj"/>';
    });
    s += extra
        + '<circle cx="' + point[0] + '" cy="' + point[1] + '" r="5" class="tm-point"/>'
        + '<text x="226" y="77" class="tm-note tm-note-stray">stray</text>';
    return '<svg viewBox="5 25 290 172" role="img" aria-hidden="true">'
        + '<defs><marker id="tm-arrow" viewBox="0 0 8 8" refX="7" refY="4" markerWidth="7" markerHeight="7" orient="auto">'
        + '<path d="M0 0 L8 4 L0 8 Z" class="tm-arrowhead"/></marker></defs>'
        + s + '</svg>';
}

var DLT_SKETCH = sketch([168.5, 56.2], [[88.6, 89.9], [160.7, 108], [213.9, 81.8]],
    '<line x1="132" y1="44" x2="162" y2="54" class="tm-leader"/>'
    + '<text x="128" y="38" text-anchor="end" class="tm-note">pulled toward</text>'
    + '<text x="128" y="49" text-anchor="end" class="tm-note">the stray line</text>');

var REFINED_SKETCH = sketch([148.4, 81.3], [[91.2, 97.9], [148.8, 108], [208.7, 98.3]],
    '<circle cx="168.5" cy="56.2" r="4" class="tm-start"/>'
    + '<line x1="165.4" y1="60.1" x2="153.4" y2="75.1" class="tm-move" marker-end="url(#tm-arrow)"/>'
    + '<line x1="132" y1="44" x2="163" y2="54" class="tm-leader"/>'
    + '<text x="128" y="47" text-anchor="end" class="tm-note">DLT start</text>');

/**
 * Build the figure. Static markup; text is HTML so it wraps with the panel.
 * @returns {HTMLElement}
 */
export function buildTriangulationMethodsFigure() {
    var fig = document.createElement('figure');
    fig.className = 'tri-methods';
    fig.innerHTML =
        '<p class="tri-methods-lead">Both methods start the same way: each camera\'s 2D point is a line of sight, '
        + 'and the 3D point is where those lines meet. Real detections never meet exactly. Here the right-hand '
        + 'camera\'s 2D prediction is placed wrong: an outlier, marked stray.</p>'
        + '<div class="tri-methods-cols">'
        + '<div class="tri-methods-col">'
        + '<div class="tri-methods-head">DLT <span>one direct solve</span></div>'
        + DLT_SKETCH
        + '<p>Solves one set of equations for the point that fits every line at once, treating every camera '
        + 'alike. Fast, but an outlier pulls the answer, so every camera ends up a little off.</p>'
        + '</div>'
        + '<div class="tri-methods-col">'
        + '<div class="tri-methods-head">Refined <span>= bundle adjustment</span></div>'
        + REFINED_SKETCH
        + '<p>Starts at the DLT point, projects it back into every camera and moves it to shrink the pixel '
        + 'errors. A camera that disagrees a lot counts less, so the outlier stays off and the rest fit. '
        + 'Use it when one view\'s 2D prediction may be placed wrong. '
        + 'The cameras stay fixed; only the point moves. Slower, and never a larger error than DLT.</p>'
        + '</div>'
        + '</div>'
        + '<div class="tri-methods-legend">'
        + '<span><i class="tm-key-det"></i>2D detection in that camera</span>'
        + '<span><i class="tm-key-point"></i>3D answer</span>'
        + '<span><i class="tm-key-proj"></i>where the 3D answer lands in that camera</span>'
        + '<span><i class="tm-key-gap"></i>pixel error</span>'
        + '</div>';
    return fig;
}
