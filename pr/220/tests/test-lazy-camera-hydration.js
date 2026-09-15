/**
 * test-lazy-camera-hydration.js — `lazyCamerasMissingFrom`, the predicate that
 * decides whether a lazy-backed camera still needs hydrating into a FrameGroup
 * that already exists.
 *
 * `ensureLazyFrameData` used to open with a bare
 *
 *     if (session.frameGroups.has(frameIdx)) return;
 *
 * which is only sound when every camera is lazy-backed. The per-camera folder
 * loader could route a folder part eager and part lazy, and the eager cameras
 * create the FrameGroup at load time — so that guard skipped the frame and the
 * lazy cameras were never hydrated at all, on any frame. Every pane rendered
 * and only some carried annotations.
 *
 * The two ways to get this wrong are opposite and both bad, which is what these
 * tests pin:
 *
 *   - report a camera as present when it is not  -> the view stays blank, the
 *     original bug;
 *   - report a camera as missing when it is not  -> it gets hydrated a second
 *     time and the frame shows every instance twice (the #194/#195
 *     re-materialize-duplicate class).
 *
 * The subtle half is WHERE a loaded camera's instances live. The per-camera
 * folder loader moves everything it parses into the UNLINKED pool
 * (`fg.unlinkedInstances`), leaving `fg.instances` empty for that camera — so a
 * check that consults only `fg.instances` calls a fully-loaded camera empty and
 * duplicates it on the next scrub.
 *
 * `lazyCamerasMissingFrom` is bridged from `pose/triangulation.js`. Both lazy
 * loaders are duck-typed here by the Map they key per-camera state with:
 * `SioLazyLoader.labelsByCam` and `LazyFrameLoader.workers`.
 */

(function () {
    const { describe, it, assertEqual, assertDeepEqual } = TestFramework;

    // Resolved lazily inside the callbacks — the bridge that defines
    // `lazyCamerasMissingFrom` is a deferred module script and has not run
    // while this classic script's body executes. A top-level reference throws,
    // and takes every describe block in this file down with it.
    const missing = (s, fg) => lazyCamerasMissingFrom(s, fg);

    function sessionWith(camNames, opts) {
        opts = opts || {};
        const map = new Map();
        for (const cn of camNames) map.set(cn, {});   // value is never read
        const loader = {};
        loader[opts.key || 'labelsByCam'] = map;
        return { lazyLoader: loader };
    }

    function inst(x) {
        return new Instance([[x, x], [x + 1, x + 1]], 0, 'predicted', 1);
    }

    function frameGroup(spec) {
        // spec: { camName: 'linked' | 'unlinked' | 'empty' }
        const fg = new FrameGroup(0);
        for (const cn of Object.keys(spec)) {
            if (spec[cn] === 'linked') {
                fg.addInstance(cn, inst(10));
            } else if (spec[cn] === 'unlinked') {
                fg.addUnlinkedInstance(cn, new UnlinkedInstance(inst(20), cn));
            } else {
                // Present as a key but holding nothing — what an emptied camera
                // looks like, and distinct from never having been touched.
                fg.instances.set(cn, []);
                fg.unlinkedInstances.set(cn, []);
            }
        }
        return fg;
    }

    describe('lazyCamerasMissingFrom — which cameras still need hydrating', function () {

        it('reports nothing when every lazy camera is linked', function () {
            const s = sessionWith(['cam1', 'cam2']);
            const fg = frameGroup({ cam1: 'linked', cam2: 'linked' });
            assertDeepEqual(missing(s, fg), [], 'a fully-hydrated frame needs no work');
        });

        it('counts UNLINKED instances as present', function () {
            // The per-camera folder loader parks everything in the unlinked
            // pool, so this is the normal shape after a folder load — not an
            // edge case. Reading only fg.instances here would duplicate every
            // instance on the next scrub.
            const s = sessionWith(['cam1', 'cam2']);
            const fg = frameGroup({ cam1: 'unlinked', cam2: 'unlinked' });
            assertDeepEqual(missing(s, fg), [], 'unlinked is loaded, not missing');
        });

        it('counts a mix of linked and unlinked as present', function () {
            const s = sessionWith(['cam1', 'cam2']);
            const fg = frameGroup({ cam1: 'linked', cam2: 'unlinked' });
            assertDeepEqual(missing(s, fg), []);
        });

        it('names the camera an eager-built FrameGroup left out — the reported bug', function () {
            const s = sessionWith(['cam1']);              // cam1 is the lazy one
            const fg = frameGroup({ cam2: 'unlinked', cam3: 'unlinked' });  // eager cameras only
            assertDeepEqual(missing(s, fg), ['cam1'],
                'the lazy camera is absent from the group and must be hydrated');
        });

        it('names only the missing ones out of several lazy cameras', function () {
            const s = sessionWith(['cam1', 'cam2', 'cam3']);
            const fg = frameGroup({ cam1: 'unlinked', cam3: 'linked' });
            assertDeepEqual(missing(s, fg), ['cam2']);
        });

        it('treats a present-but-empty camera entry as missing', function () {
            // A camera key can exist with an empty array (the loader sets
            // `fg.instances.set(cn, [])` when it moves instances to the pool).
            // "Has a key" is not "has data".
            const s = sessionWith(['cam1']);
            const fg = frameGroup({ cam1: 'empty' });
            assertDeepEqual(missing(s, fg), ['cam1']);
        });

        it('preserves the loader\'s camera order', function () {
            const s = sessionWith(['camB', 'camA', 'camC']);
            const fg = frameGroup({});
            assertDeepEqual(missing(s, fg), ['camB', 'camA', 'camC'],
                'insertion order, not sorted — the caller hydrates in this order');
        });
    });

    describe('lazyCamerasMissingFrom — loader shapes and degenerate input', function () {

        it('works with LazyFrameLoader, which keys cameras by `workers`', function () {
            const s = sessionWith(['cam1', 'cam2'], { key: 'workers' });
            const fg = frameGroup({ cam1: 'linked' });
            assertDeepEqual(missing(s, fg), ['cam2'],
                'both loaders are handled, not just SioLazyLoader');
        });

        it('reports nothing when the session has no lazy loader at all', function () {
            const fg = frameGroup({ cam1: 'linked' });
            assertDeepEqual(missing({}, fg), [],
                'a fully eager session must never enter the hydration path');
        });

        it('reports nothing for a null FrameGroup', function () {
            assertDeepEqual(missing(sessionWith(['cam1']), null), []);
        });

        it('reports nothing when the loader exposes no camera map', function () {
            // Defensive: an unrecognised loader shape must degrade to "nothing
            // to do" rather than throwing inside a per-scrub hot path.
            assertDeepEqual(missing({ lazyLoader: {} }, frameGroup({})), []);
        });

        it('reports nothing when the loader knows no cameras', function () {
            assertDeepEqual(missing(sessionWith([]), frameGroup({ cam1: 'linked' })), []);
        });

        it('ignores cameras the FrameGroup has but the loader does not', function () {
            // Eager cameras are not the lazy loader's business.
            const s = sessionWith(['cam1']);
            const fg = frameGroup({ cam1: 'linked', cam2: 'linked', cam3: 'unlinked' });
            assertEqual(missing(s, fg).length, 0);
        });
    });
})();
