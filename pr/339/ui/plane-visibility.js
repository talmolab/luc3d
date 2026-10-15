// ui/plane-visibility.js — which PARTS of the annotated planes are drawn, in
// which representation.
//
// The Visibility panel's `Planes` section is four independent toggles: planes
// and nodes, in 2D and in 3D. They exist because an annotated cage is scene
// geometry that outlives the annotating — it is drawn in every mode, which is
// right when you are checking a pose against the floor and wrong when five
// filled walls are sitting on top of the frame you are labelling.
//
// One module, read by both representations, for the same reason
// `import-export/visibility-metadata.js` is one module: the 2D overlay
// (`ui/plane-overlays.js`) and the 3D payload (`syncPlanes3D`) have to agree
// about what "planes are off" means, and adding a fifth part later should mean
// touching this file and nothing else.
//
// NO IMPORTS, deliberately. It is read from inside the plane panel's import
// cycle (`plane-definition` <-> `plane-overlays`) and from `ui/ui-wiring.js`,
// and a module with no edges of its own cannot be the one that closes a loop.
// It also makes the four ids readable without a viewport.

/**
 * The four checkboxes, keyed by the field each one produces.
 *
 * Exported so the persistence list in `ui/ui-wiring.js` (`visCheckIds`) and the
 * tests name them from here rather than re-typing them: a toggle missing from
 * that list still works and silently forgets, which is invisible until the next
 * reload.
 */
export const PLANE_VIS_IDS = {
    planes2d: 'visPlanes2D',
    planes3d: 'visPlanes3D',
    nodes2d: 'visPlaneNodes2D',
    nodes3d: 'visPlaneNodes3D',
};

/**
 * What to draw right now.
 *
 * **Defining Plane Mode overrides all four.** In the mode every part is on
 * whatever the checkboxes say: the panel's tables, the 2D placement drags and
 * the 3D corner drags all act on parts the user has to be able to see, so
 * honouring a toggle there would hide the thing being edited. These toggles are
 * about the DEFAULT mode, where a plane is scenery.
 *
 * **They decide WHETHER a plane is drawn, never HOW.** A shown plane is drawn
 * exactly as annotated — its own colour, its own edges and its own `Fill` — so
 * the two representations and the two modes cannot disagree about what a plane
 * looks like. In particular there is no fill override here, and there must not
 * be one: `plane.filled` is project state written to the `.slp`, the `Fill`
 * button is the one thing that sets it, and a plane gaining a fill because it
 * became visible is exactly the confusion
 * `tests/e2e/mesh-membership-highlight.mjs` pins against for the mesh-object
 * highlight ("no fill of its own"). A cage that reads badly unfilled is a
 * reason to click `Fill`, not a reason for the renderer to guess.
 *
 * A missing checkbox reads as ON — the headless runners build a partial DOM,
 * and the failure mode of the other default (a harness that silently renders
 * nothing and passes) is far harder to see than a stray plane.
 *
 * @param {boolean} modeActive `planeState.active` — Defining Plane Mode.
 * @returns {{planes2d:boolean, planes3d:boolean, nodes2d:boolean,
 *            nodes3d:boolean}}
 */
export function planeVisibility(modeActive) {
    if (modeActive) {
        return { planes2d: true, planes3d: true, nodes2d: true, nodes3d: true };
    }
    var out = {};
    var keys = Object.keys(PLANE_VIS_IDS);
    for (var i = 0; i < keys.length; i++) {
        var el = (typeof document !== 'undefined')
            ? document.getElementById(PLANE_VIS_IDS[keys[i]]) : null;
        out[keys[i]] = el ? !!el.checked : true;
    }
    return out;
}
