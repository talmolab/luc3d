// ui/threshold-examples-3d.js — the 3D view in the threshold card's "In this
// session" panel (ui/threshold-examples-panel.js): the app's own `Viewport3D`,
// styled from Visibility ▸ 3D Viewer as the overlay export's 3D tile is (cameras aside),
// showing every animal in the example's frame from the solve being tried. On top of it go
// the example node's 3D point and each camera's line of sight through it.
//
// The framing is set per example and left alone as values are tried, so what moves
// is the point, not the view. A drag turns it (orbit controls), and the angle holds
// from one example to the next. The wheel is left to the Settings panel's scroller.
//
// Depends on: ui/viewport3d.js (Viewport3D), ui/overlays.js (getTrackColor).

import { getTrackColor } from './overlays.js?v=abe845f9f66e';
import { Viewport3D } from './viewport3d.js?v=abe845f9f66e';

const RAY = 0xc8c8c8, RAY_DROPPED = 0xf39c12, POINT = 0xffffff, FIRST_SOLVE = 0xb5b5b5;

function readNum(id, dflt) {
    const e = document.getElementById(id);
    const v = e ? parseFloat(e.value) : NaN;
    return isFinite(v) ? v : dflt;
}

function readBool(id, dflt) {
    const e = document.getElementById(id);
    return e ? e.checked : dflt;
}

function readAttr(id, dflt) {
    const e = document.getElementById(id);
    return (e && e.getAttribute('data-value')) || dflt;
}

/**
 * @param {HTMLElement} host  an empty element with a size
 * @param {Object} opts
 * @param {Object} opts.session
 * @param {function(Object): string} opts.getGroupColor  a shown group's colour
 * @returns {{setScene: function(Object): void, setFraming: function(Object): void,
 *   setVisible: function(boolean): void, dispose: function(): void}}
 * @throws if WebGL or three.js is unavailable
 */
export function build3dView(host, opts) {
    const session = opts.session;
    const brightness = document.getElementById('vis3dBrightness');
    const vp = new Viewport3D(host, {
        cameras: session.cameras,
        skeleton: session.skeleton,
        getTrackColor: getTrackColor,
        getGroupColor: opts.getGroupColor,
        cameraLabelSize: readNum('vis3dLabelSize', 28),
        cameraSphereSize: readNum('vis3dSphereSize', 3),
        pyramidLength: readNum('vis3dPyramidLength', 40),
        skeletonNodeSize: readNum('vis3dNodeSize', 2),
        skeletonEdgeWeight: readNum('vis3dEdgeWeight', 0.8),
        skeletonBrightness: brightness && isFinite(parseFloat(brightness.value)) ? parseFloat(brightness.value) / 100 : 1,
        // The animal is the subject, framed close: cameras would only crowd it.
        showCameraLabels: false,
        showCameraSpheres: false,
        showCameraPyramids: false,
        showSkeletonNodes: readBool('vis3dNodeShow', true),
        showSkeletonEdges: readBool('vis3dEdgeShow', true),
        skeletonNodeShape: readAttr('vis3dNodeStyle', 'circle'),
        preserveDrawingBuffer: true,
    });
    vp.controls.enableZoom = false;
    vp.controls.minDistance = 1;

    const marks = new THREE.Group();
    marks.name = 'threshold_example_marks';
    vp.scene.add(marks);

    function clearMarks() {
        while (marks.children.length) {
            const child = marks.children[0];
            marks.remove(child);
            if (child.geometry) child.geometry.dispose();
            if (child.material) child.material.dispose();
        }
    }

    function addLine(a, b, material) {
        const geo = new THREE.BufferGeometry().setFromPoints([new THREE.Vector3(a[0], a[1], a[2]), new THREE.Vector3(b[0], b[1], b[2])]);
        const seg = new THREE.Line(geo, material);
        seg.computeLineDistances();
        marks.add(seg);
    }

    function addBall(at, radius, color) {
        const ball = new THREE.Mesh(new THREE.SphereGeometry(radius, 20, 20), new THREE.MeshPhongMaterial({ color: color, shininess: 60 }));
        ball.position.set(at[0], at[1], at[2]);
        marks.add(ball);
    }

    let radius = 1;
    const baseNodeSize = vp.skeletonNodeSize, baseEdgeWeight = vp.skeletonEdgeWeight;

    return {
        /**
         * What the solve being tried gives.
         * @param {Object} scene
         * @param {Array<{points3d: Float64Array}>} scene.groups  the frame's animals
         * @param {?number[]} scene.point  the example node's 3D point, if it has one
         * @param {?number[]} scene.first  the node's point in the first solve, if a camera was dropped
         * @param {Array<{origin: number[], dir: number[], dropped: boolean}>} scene.rays
         */
        setScene: function (scene) {
            vp.setFrame(scene.groups);
            clearMarks();
            const ballSize = Math.max(vp.skeletonNodeSize * (vp._sceneScale || 1) * 1.7, radius * 0.03);
            const anchor = scene.point || scene.first;
            if (anchor) {
                scene.rays.forEach(function (ray) {
                    const t0 = (anchor[0] - ray.origin[0]) * ray.dir[0] + (anchor[1] - ray.origin[1]) * ray.dir[1] + (anchor[2] - ray.origin[2]) * ray.dir[2];
                    const along = function (t) {
                        return [ray.origin[0] + ray.dir[0] * t, ray.origin[1] + ray.dir[1] * t, ray.origin[2] + ray.dir[2] * t];
                    };
                    addLine(along(t0 - 4 * radius), along(t0 + 4 * radius), new THREE.LineDashedMaterial({
                        color: ray.dropped ? RAY_DROPPED : RAY,
                        dashSize: radius * 0.06, gapSize: radius * 0.05,
                        transparent: true, opacity: ray.dropped ? 1 : 0.55,
                    }));
                });
            }
            if (scene.first && scene.point) {
                addLine(scene.first, scene.point, new THREE.LineBasicMaterial({ color: FIRST_SOLVE }));
                addBall(scene.first, ballSize * 0.7, FIRST_SOLVE);
            }
            if (scene.point) addBall(scene.point, ballSize, POINT);
        },
        /**
         * Look at an example's animal, keeping the angle the view has.
         * @param {{centre: number[], radius: number}} frame
         */
        setFraming: function (frame) {
            radius = frame.radius;
            // The viewer's sizes suit a whole rig; a close view of one animal grows
            // them with it, or the skeleton reads as a thread.
            const grow = Math.max(1, radius * 0.03 / (baseNodeSize * (vp._sceneScale || 1)));
            vp.skeletonNodeSize = baseNodeSize * grow;
            vp.skeletonEdgeWeight = baseEdgeWeight * grow;
            const cam = vp.threeCamera, target = vp.controls.target;
            const dir = new THREE.Vector3().subVectors(cam.position, target);
            if (!(dir.length() > 0)) dir.set(1, -1, 0.8);
            dir.normalize();
            const away = 1.05 * radius / Math.tan(cam.fov * Math.PI / 360);
            target.set(frame.centre[0], frame.centre[1], frame.centre[2]);
            cam.position.set(target.x + dir.x * away, target.y + dir.y * away, target.z + dir.z * away);
            cam.near = Math.max(0.01, away * 0.01);
            cam.far = Math.max(100000, away * 10);
            cam.updateProjectionMatrix();
            vp.controls.update();
        },
        setVisible: function (visible) { vp.setVisible(visible); },
        dispose: function () {
            clearMarks();
            vp.dispose();
        },
    };
}
