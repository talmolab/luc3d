/**
 * test-viewport3d-skeleton-pool.js — Viewport3D.updateSkeleton's in-place path.
 *
 * During playback the 3D view now follows every frame, so `updateSkeleton`
 * no longer rebuilds the scene: it reuses pooled meshes/materials and moves
 * them, with every edge drawn by ONE shared unit cylinder scaled to length.
 * Pooling invites stale state (a leftover node from a frame with more
 * keypoints, a selected instance's 1.5x scale or emissive color sticking, a
 * detached group still attached), so these assert:
 *
 *   - after ANY sequence of frames, the scene graph equals what a FRESH viewer
 *     builds from the last frame alone (names, order, transforms, materials);
 *   - every edge cylinder spans exactly its two keypoints at the right radius
 *     (checked in world space against the input points, not the old code);
 *   - steady-state updates allocate no new geometry or materials;
 *   - changing a geometry setting (node shape) rebuilds the pool.
 *
 * Browser-only: needs real Three.js + WebGL.
 */
(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assertTrue = TF.assertTrue;
    var assertEqual = TF.assertEqual;

    var NODES = ['nose', 'head', 'neck', 'tail'];
    var EDGES = [[0, 1], [1, 2], [2, 3], [0, 3]];

    function makeViewer() {
        var container = document.createElement('div');
        container.style.width = '320px';
        container.style.height = '240px';
        container.style.position = 'fixed';
        container.style.left = '-9999px';
        document.body.appendChild(container);
        var colors = ['#ff0000', '#00ff00', '#0000ff', '#ffff00'];
        var vp = new Viewport3D(container, {
            cameras: [],
            skeleton: new Skeleton('t', NODES, EDGES),
            getTrackColor: function (i) { return colors[i % colors.length]; },
        });
        return { vp: vp, container: container };
    }

    function destroy(o) {
        try { o.vp.dispose(); } catch (e) { /* ignore */ }
        if (o.container.parentNode) o.container.remove();
    }

    // boxed [[x,y,z]|null] per node -> InstanceGroup
    function grp(id, boxed) {
        var g = new InstanceGroup(id, 0);
        g.identityId = id;
        g.points3d = fromBoxedPoints3d(boxed);
        return g;
    }

    function pts(seed, missing) {
        var out = [];
        for (var n = 0; n < NODES.length; n++) {
            if (missing && missing.indexOf(n) >= 0) { out.push(null); continue; }
            out.push([seed * 3 + n * 10, seed * 2 - n * 5, 100 + seed + n * 7]);
        }
        return out;
    }

    function r6(x) { return Math.round(x * 1e6) / 1e6; }

    // Serialize the attached skeleton scene graph.
    function snapshot(vp) {
        vp._skeletonGroup.updateMatrixWorld(true);
        var out = [];
        vp._skeletonGroup.traverse(function (o) {
            if (o === vp._skeletonGroup) return;
            var rec = {
                name: o.name, type: o.type, n: o.children.length,
                p: [r6(o.position.x), r6(o.position.y), r6(o.position.z)],
                q: [r6(o.quaternion.x), r6(o.quaternion.y), r6(o.quaternion.z), r6(o.quaternion.w)],
                s: [r6(o.scale.x), r6(o.scale.y), r6(o.scale.z)],
            };
            if (o.material) {
                rec.m = [o.material.color.getHexString(), o.material.emissive.getHexString(),
                    o.material.emissiveIntensity, o.material.shininess];
            }
            out.push(rec);
        });
        return JSON.stringify(out);
    }

    describe('Viewport3D skeleton pool (in-place updateSkeleton)', function () {

        it('any frame sequence ends in the same scene graph as a fresh build of the last frame', function () {
            var a = makeViewer(), b = makeViewer();
            try {
                var last = [grp(0, pts(1, [2])), grp(1, pts(4))];
                // Many groups, all nodes; then fewer; a selection; missing nodes; an empty frame.
                a.vp.updateSkeleton([grp(0, pts(9)), grp(1, pts(8)), grp(2, pts(7))]);
                a.vp.selectedInstanceIdx = 1;
                a.vp.updateSkeleton([grp(0, pts(5)), grp(1, pts(6))]);
                a.vp.updateSkeleton([]);
                a.vp.updateSkeleton([grp(0, pts(3, [0, 3])), grp(2, pts(2))]);
                a.vp.selectedInstanceIdx = null;
                a.vp.updateSkeleton(last);

                b.vp.updateSkeleton(last);
                assertEqual(snapshot(a.vp), snapshot(b.vp), 'reused pool == fresh build');
                // Exactly what a rebuild attaches: 2 instance groups; group 0 has
                // 3 nodes (node 2 missing) and the 2 edges not touching it.
                var kids = a.vp._skeletonGroup.children;
                assertEqual(kids.length, 2, 'one Group per instance group with 3D');
                assertEqual(kids[0].name, 'instance_0', 'group 0 named by its index');
                assertEqual(kids[0].children.map(function (c) { return c.name; }).join(','),
                    'node_nose,node_head,node_tail,edge_0_1,edge_0_3', 'nodes then edges, missing ones absent');
            } finally { destroy(a); destroy(b); }
        });

        it('selection highlight is applied and fully removed', function () {
            var a = makeViewer(), b = makeViewer();
            try {
                var frame = [grp(0, pts(1)), grp(1, pts(2))];
                a.vp.selectedInstanceIdx = 0;
                a.vp.updateSkeleton(frame);
                var sel = a.vp._skeletonGroup.children[0];
                assertEqual(sel.children[0].scale.x, 1.5, 'selected nodes scaled 1.5x');
                assertTrue(sel.children[0].material.emissiveIntensity > 0, 'selected material emissive');
                a.vp.selectedInstanceIdx = null;
                a.vp.updateSkeleton(frame);
                b.vp.updateSkeleton(frame);
                assertEqual(snapshot(a.vp), snapshot(b.vp), 'deselected == never selected');
            } finally { destroy(a); destroy(b); }
        });

        it('edge cylinders span their keypoints at the configured radius (world space)', function () {
            var a = makeViewer();
            try {
                var boxed = pts(3);
                a.vp.updateSkeleton([grp(0, boxed)]);
                a.vp._skeletonGroup.updateMatrixWorld(true);
                var r = a.vp.skeletonEdgeWeight * (a.vp._sceneScale || 1);
                var edges = a.vp._skeletonGroup.children[0].children.filter(function (c) { return c.name.indexOf('edge_') === 0; });
                assertEqual(edges.length, EDGES.length, 'one cylinder per edge');
                var worst = 0;
                edges.forEach(function (cyl) {
                    var ids = cyl.name.split('_');
                    var s = boxed[+ids[1]], d = boxed[+ids[2]];
                    var top = new THREE.Vector3(0, 0.5, 0).applyMatrix4(cyl.matrixWorld);
                    var bot = new THREE.Vector3(0, -0.5, 0).applyMatrix4(cyl.matrixWorld);
                    // A Y-cylinder rotated onto (d - s): +0.5 maps to d, -0.5 to s.
                    worst = Math.max(worst, top.distanceTo(new THREE.Vector3(d[0], d[1], d[2])));
                    worst = Math.max(worst, bot.distanceTo(new THREE.Vector3(s[0], s[1], s[2])));
                    var rim = new THREE.Vector3(1, -0.5, 0).applyMatrix4(cyl.matrixWorld);
                    worst = Math.max(worst, Math.abs(rim.distanceTo(bot) - r));
                });
                assertTrue(worst < 1e-6, 'cylinder endpoints/radius match the input (max err ' + worst + ')');
            } finally { destroy(a); }
        });

        it('steady-state frames allocate no geometry or materials', function () {
            var a = makeViewer();
            try {
                a.vp.updateSkeleton([grp(0, pts(1)), grp(1, pts(2))]);
                var geos = new Set(), mats = new Set();
                a.vp._skeletonGroup.traverse(function (o) { if (o.geometry) geos.add(o.geometry); if (o.material) mats.add(o.material); });
                for (var f = 0; f < 30; f++) a.vp.updateSkeleton([grp(0, pts(f)), grp(1, pts(f + 1))]);
                var same = true;
                a.vp._skeletonGroup.traverse(function (o) {
                    if (o.geometry && !geos.has(o.geometry)) same = false;
                    if (o.material && !mats.has(o.material)) same = false;
                });
                assertTrue(same, 'all geometries/materials reused across 30 frames');
                assertEqual(geos.size, 2, 'two shared geometries: node sphere + unit edge cylinder');
            } finally { destroy(a); }
        });

        it('changing node shape rebuilds the pool and matches a fresh build', function () {
            var a = makeViewer(), b = makeViewer();
            try {
                var frame = [grp(0, pts(1)), grp(1, pts(2))];
                a.vp.updateSkeleton(frame);
                var oldGeo = a.vp._skelPool.nodeGeo;
                a.vp.skeletonNodeShape = 'x';
                a.vp.updateSkeleton(frame);
                assertTrue(a.vp._skelPool.nodeGeo !== oldGeo, 'pool rebuilt on shape change');
                b.vp.skeletonNodeShape = 'x';
                b.vp.updateSkeleton(frame);
                assertEqual(snapshot(a.vp), snapshot(b.vp), "'x' markers after a shape change == fresh 'x' build");
            } finally { destroy(a); destroy(b); }
        });
    });
})();
