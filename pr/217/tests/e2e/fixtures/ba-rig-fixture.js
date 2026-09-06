/**
 * ba-rig-fixture.js — shared synthetic rig for the bundle-adjustment e2e tests.
 *
 * Served over the dev http server and `import()`ed from inside the page by
 * `tests/e2e/triangulate-all-ba-display.mjs` (does Triangulate All ▸ BA report
 * BA's error?) and `tests/e2e/triangulate-all-ba-export.mjs` (does a later
 * regroup/export still carry BA's 3D?). One copy so the two cannot drift.
 *
 * ## Fixture correctness — read this before editing the geometry
 *
 *   * `Camera.project()` does NOT apply distortion. A real observation is
 *     `cam.distortPoint(cam.project(X))`. Feeding ideal pinhole points in as if
 *     they were raw detections makes the undistort/reproject pipeline
 *     self-inconsistent and every measurement meaningless. Use `observe()`.
 *
 *   * `Camera.undistortPoint`'s Newton iteration degrades badly as the radius
 *     approaches the k1 fold radius `r_fold = 1/sqrt(-3*k1)`, so every synthetic
 *     observation must sit well inside it. `worstIdealR` below is measured on the
 *     **ideal** projection radius, never the distorted one — barrel distortion
 *     compresses, so filtering on the distorted radius would admit ideal radii
 *     past the fold. Callers assert `worstIdealR < 0.5 * rFoldPx`.
 *
 *   * The cameras carry REAL pure-k1 barrel distortion (k1 = -0.30, mid-range for
 *     LUCID's real rigs at -0.24..-0.37). With zero distortion BA and DLT very
 *     nearly coincide and the tests would prove nothing, so callers also assert
 *     that BA is measurably better than DLT on this data.
 *
 *   * Rig trick: for ANY `rvec`, `tvec = [0, 0, D]` puts the camera at distance D
 *     from the world origin looking straight at it (the third row of R is the
 *     forward axis, and `t = -R*C` collapses to `[0, 0, D]`). So all three
 *     cameras frame the same point cloud from genuinely different viewpoints
 *     while keeping every projection near the principal point.
 *
 * Deterministic throughout (LCG + Box-Muller), so every number a caller prints
 * is reproducible.
 */

export async function buildBaRigFixture(opts) {
    opts = opts || {};
    const pd = await import('/pose/pose-data.js');
    const TRI = await import('/pose/triangulation.js');
    const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

    const NF = opts.frames || 8;
    const NTRACK = 2, NNODE = 8, NOISE = 2.0;

    let _s = (opts.seed || 20260804) >>> 0;
    const u = () => { _s = (_s * 1103515245 + 12345) & 0x7fffffff; return _s / 0x7fffffff; };
    const gauss = () => Math.sqrt(-2 * Math.log(u() + 1e-12)) * Math.cos(2 * Math.PI * u());

    // 1280x1024, f=1000, pure-k1 barrel.
    const F = 1000, CX = 640, CY = 512;
    const K = [[F, 0, CX], [0, F, CY], [0, 0, 1]];
    const K1 = -0.30;
    const DIST = [K1, 0, 0, 0, 0];
    const rFoldPx = F / Math.sqrt(-3 * K1);
    const D = 50;
    const RVECS = [[0, 0, 0], [0, 0.45, 0], [0.40, -0.40, 0]];
    const NAMES = ['camA', 'camB', 'camC'];
    const cams = NAMES.map((n, i) => new Camera(n, K, DIST, RVECS[i], [0, 0, D], [1280, 1024]));

    // Ground truth: two animals drifting across NF frames, inside a small box
    // around the origin so every projection stays near the principal point.
    const base = [];
    for (let t = 0; t < NTRACK; t++) {
        const b = [];
        for (let k = 0; k < NNODE; k++) {
            b.push([(u() - 0.5) * 12 + (t === 0 ? -3 : 3), (u() - 0.5) * 12, (u() - 0.5) * 12]);
        }
        base.push(b);
    }
    const truth = [];
    for (let f = 0; f < NF; f++) {
        const perTrack = [];
        for (let t = 0; t < NTRACK; t++) {
            perTrack.push(base[t].map(p => [p[0] + f * 0.15, p[1] + f * 0.1, p[2]]));
        }
        truth.push(perTrack);
    }

    // Worst IDEAL projection radius over the whole fixture (the fold-radius
    // precondition callers assert on).
    let worstIdealR = 0;
    for (let f = 0; f < NF; f++) {
        for (let t = 0; t < NTRACK; t++) {
            for (const X of truth[f][t]) {
                for (const cam of cams) {
                    const q = cam.project(X);
                    worstIdealR = Math.max(worstIdealR, Math.hypot(q[0] - CX, q[1] - CY));
                }
            }
        }
    }

    /** What the real camera sees: ideal projection, distorted, plus pixel noise. */
    const observe = (cam, X) => {
        const q = cam.distortPoint(cam.project(X));
        return [q[0] + gauss() * NOISE, q[1] + gauss() * NOISE];
    };

    // Fixed observation table, so every phase compares the same numbers.
    const obs = new Map();                        // f -> camName -> [track][node][2]
    for (let f = 0; f < NF; f++) {
        const perCam = new Map();
        for (const cam of cams) {
            const perTrack = [];
            for (let t = 0; t < NTRACK; t++) perTrack.push(truth[f][t].map(X => observe(cam, X)));
            perCam.set(cam.name, perTrack);
        }
        obs.set(f, perCam);
    }

    const skel = new Skeleton('sk', Array.from({ length: NNODE }, (_, i) => 'n' + i),
        Array.from({ length: NNODE - 1 }, (_, i) => [i, i + 1]));

    const mkInstances = (f, camName) => obs.get(f).get(camName).map((pts, t) =>
        new Instance(pts.map(p => [p[0], p[1]]), t, 'predicted', 1));

    /**
     * Track-All-shaped session: identities exist and every (frame, camera, track)
     * carries a per-frame identity, but nothing is grouped — so the Triangulate
     * paths auto-group via `ensureGroupsFromIdentities`. Stamped with
     * `setFrameIdentity` rather than `assignTrackToIdentity` because the latter
     * walks `frameGroups`, which is EMPTY on a lazy session.
     */
    const mkSession = (name, opts2) => {
        opts2 = opts2 || {};
        const s = new Session(cams, skel, ['track_0', 'track_1'], name);
        const ids = [s.addIdentity('Red'), s.addIdentity('Blue')];
        if (opts2.eager) {
            for (let f = 0; f < NF; f++) {
                const fg = new FrameGroup(f);
                s.addFrameGroup(fg);
                for (const cam of cams) {
                    const insts = mkInstances(f, cam.name);
                    // `_rawInstIndex` is what `finalizeLazyFrameGroup` matches on;
                    // harmless (and consistent) on eager sessions too.
                    for (let i = 0; i < insts.length; i++) {
                        insts[i]._rawInstIndex = i;
                        fg.addInstance(cam.name, insts[i]);
                    }
                }
            }
        } else {
            s.lazyLoader = mkLazyLoader();
        }
        for (let f = 0; f < NF; f++) {
            for (const cam of cams) {
                for (let t = 0; t < NTRACK; t++) s.setFrameIdentity(f, cam.name, t, ids[t].id);
            }
        }
        return s;
    };

    /**
     * Minimal SYNC lazy loader — exactly what `sweepLazyFrameWindows` /
     * `batchLoadLazyFrames` / `buildLazyFrameGroupSync` require to take the
     * WINDOWED path (`isSync` + `releaseWindow` + `nFrames > 0`). Records its
     * releases so a caller can assert the windowed path really ran.
     */
    function mkLazyLoader() {
        const released = [];
        return {
            isSync: true,
            nFrames: NF,
            released: released,
            getFrameSync(fi) {
                if (!obs.has(fi)) return null;
                const m = new Map();
                for (const cam of cams) {
                    m.set(cam.name, obs.get(fi).get(cam.name).map((pts, t) => ({
                        points: pts.map(p => [p[0], p[1]]), trackIdx: t, type: 'predicted', score: 1,
                    })));
                }
                return m;
            },
            getFrame(fi) { return Promise.resolve(this.getFrameSync(fi) || new Map()); },
            releaseWindow(s, e) { released.push([s, e]); },
        };
    }

    /**
     * Standalone throwaway groups over the SAME observations, for computing
     * reference DLT / BA solutions independently of the app's own bookkeeping.
     * No `includedCameras` override: the app paths don't pass one either, so both
     * sides see the same live Camera Views / threshold settings.
     */
    const refGroupsFor = (f) => {
        const gs = [];
        for (let t = 0; t < NTRACK; t++) {
            const g = new InstanceGroup(9000 + t, -1);
            for (const cam of cams) {
                g.addInstance(cam.name,
                    new Instance(obs.get(f).get(cam.name)[t].map(p => [p[0], p[1]]), t, 'predicted', 1));
            }
            gs.push(g);
        }
        return gs;
    };
    const refSolve = (f, method) =>
        refGroupsFor(f).map(g => TRI.triangulateAndReproject(g, cams, { method: method }));

    /** Aggregate a results list exactly the way info-panel.updateFrameInfo does. */
    const aggregate = (results) => {
        let sum = 0, n = 0;
        for (const r of results) {
            if (r.meanError == null || !r.errors) continue;
            for (const cn in r.errors) for (const e of r.errors[cn]) if (e != null) { sum += e; n++; }
        }
        return n ? sum / n : null;
    };

    /** Worst |delta| between two flat points3d arrays; Infinity if incomparable. */
    const points3dDelta = (a, b) => {
        if (!a || !b || a.length !== b.length) return Infinity;
        let worst = 0;
        for (let i = 0; i < a.length; i++) {
            if (Number.isNaN(a[i]) && Number.isNaN(b[i])) continue;
            worst = Math.max(worst, Math.abs(a[i] - b[i]));
        }
        return worst;
    };

    /** Rough per-group cost of each method, for reporting the BA/DLT ratio. */
    const timeMethods = (trials) => {
        const gs = refGroupsFor(0);
        const run = (m) => {
            const t0 = performance.now();
            for (let i = 0; i < (trials || 40); i++) {
                for (const g of gs) TRI.triangulateAndReproject(g, cams, { method: m });
            }
            return performance.now() - t0;
        };
        run('dlt'); run('ba');                    // warm up
        const dlt = run('dlt'), ba = run('ba');
        return { dltMs: dlt, baMs: ba, ratio: ba / dlt };
    };

    return {
        NF, NTRACK, NNODE, NOISE, cams, camNames: NAMES, skel, obs, truth,
        worstIdealR, rFoldPx,
        mkSession, mkLazyLoader, mkInstances, refGroupsFor, refSolve,
        aggregate, points3dDelta, timeMethods,
    };
}
