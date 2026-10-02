/**
 * triangulation-frame-invariant.mjs — re-basing the world must not change the
 * geometry, in the SOLVER as well as in the maths.
 *
 * `Set as New Calibration` re-expresses the world and changes no geometry:
 * points and cameras move together, so every reprojection lands on the same
 * pixel. That contract was quietly broken by the estimator. `triangulatePointDLT`
 * minimizes an ALGEBRAIC error, and `‖x‖ = 1` on a homogeneous 4-vector weights
 * the direction part against the scale part — so moving the world origin
 * re-weighted the cost and moved the answer. On a real 6-camera session that
 * was 0.26 mm at the median but 17 mm at p99 and metres in the tail, and since
 * `CrossViewTracker._retriangulate` scores cross-view association against
 * exactly these points, 21% of frames came out grouped differently — three
 * times worse by reprojection — purely from swapping the calibration file.
 *
 * `triangulatePointDLT` now solves in a frame derived from the CAMERAS
 * (centroid + mean distance), which moves with them, so the normalized system
 * differs only by an orthogonal factor and the null vector maps exactly.
 *
 * What this pins:
 *
 *   1. A well-conditioned point is invariant to machine precision.
 *   2. So is an ILL-CONDITIONED one — two views, a narrow baseline, the case
 *      that used to move by metres. This is the assertion that fails on the
 *      pre-fix build; §1 passes either way, so it is not the guard.
 *   3. Invariance holds for a pure TRANSLATION of the origin, which is the part
 *      that actually broke (a rotation alone is orthogonal and was always safe)
 *      — and at 10 km, where the old solver lost the point entirely.
 *   4. Reprojection is preserved: the re-based answer reprojects to the SAME
 *      pixels through the re-based cameras. This is the user-visible contract.
 *   5. `CrossViewTracker` produces an identical cross-view grouping under both
 *      calibrations. NOTE this one passes pre-fix too: a synthetic fixture with
 *      three well-separated animals is not contested enough to flip an
 *      association on a sub-mm wobble, and the real failure needed four animals
 *      in a 600 mm cage. It is kept as a guard that the tracker keeps consuming
 *      the now-invariant triangulation, not as a reproduction of that failure —
 *      the checks that actually catch the bug are 1–4 and 6.
 *   6. The re-based cameras really are a different frame (negative control) —
 *      otherwise every assertion above would pass on a no-op.
 *
 * Verified to FAIL on the pre-fix build: 7 of the checks below go red, the
 * mis-associated point moving 6.01 mm instead of 2.4e-13 mm.
 *
 * The re-based cameras are built with the app's OWN `buildOriginFrame` +
 * `rebaseExtrinsics`, so the solver and the re-base cannot drift apart
 * silently, exactly as `tests/test-calibration-compare.mjs` does.
 *
 * Run: node triangulation-frame-invariant.mjs   (spawns its own http.server)
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8281);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let browser;
try {
    browser = await chromium.launch();
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push(String(e)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const out = await page.evaluate(async () => {
        const PD  = await import('/pose/pose-data.js');
        const TRI = await import('/pose/triangulation.js');
        const OF  = await import('/pose/origin-frame.js');
        const CVT = await import('/pose/cross-view-tracker.js');

        const K = [[800, 0, 640], [0, 800, 512], [0, 0, 1]];
        // A ring of cameras looking inward at a ~300 mm cage, 900 mm out — the
        // shape of a real rig, and far enough from the origin that a re-base
        // moves the world by more than the object is big.
        function rig() {
            const cams = [];
            const N = 6;
            for (let i = 0; i < N; i++) {
                const th = (2 * Math.PI * i) / N;
                const C = [900 * Math.cos(th), 900 * Math.sin(th), 700];
                // look at the origin
                const f = [-C[0], -C[1], -C[2]];
                const n = Math.hypot(f[0], f[1], f[2]);
                const z = [f[0] / n, f[1] / n, f[2] / n];
                let up = [0, 0, 1];
                let x = [up[1] * z[2] - up[2] * z[1], up[2] * z[0] - up[0] * z[2], up[0] * z[1] - up[1] * z[0]];
                const xn = Math.hypot(x[0], x[1], x[2]); x = x.map(v => v / xn);
                const y = [z[1] * x[2] - z[2] * x[1], z[2] * x[0] - z[0] * x[2], z[0] * x[1] - z[1] * x[0]];
                const R = [x, y, z];                      // world -> camera rows
                const t = [-(R[0][0]*C[0]+R[0][1]*C[1]+R[0][2]*C[2]),
                           -(R[1][0]*C[0]+R[1][1]*C[1]+R[1][2]*C[2]),
                           -(R[2][0]*C[0]+R[2][1]*C[1]+R[2][2]*C[2])];
                cams.push(new PD.Camera('c' + i, K, [0,0,0,0,0], R, t, [1280, 1024]));
            }
            return cams;
        }
        const camsA = rig();

        // Re-base through the app's own maths, at the scale a real one has:
        // the measured `Set as New Calibration` on the cage session moved the
        // origin 1229 mm and rotated 164 deg. A small offset does not exercise
        // this — the algebraic re-weighting grows with how far the origin is
        // from the points relative to their own extent.
        const frame = OF.buildOriginFrame([-16, -8, 1229], [0.28, 0.16, -0.95], null);
        const camsB = camsA.map(c => {
            const r = OF.rebaseExtrinsics(c.rotationMatrix, c.tvec, frame);
            return new PD.Camera(c.name, K, [0,0,0,0,0], r.R, r.tvec, [1280, 1024]);
        });
        const toNew = (X) => OF.applyOriginFrame(frame, X);

        const proj = (X, cam) => TRI.reprojectPoint(X, cam.projectionMatrix);
        // Deterministic pseudo-noise. Without it the rays meet EXACTLY, `A·x = 0`
        // has an exact null vector, and every positive re-weighting of the
        // algebraic cost finds that same vector — so a noiseless fixture cannot
        // show frame dependence at all, however far the origin moves. Real
        // detections never intersect exactly; that inconsistency is what makes
        // the minimizer a compromise, and a compromise is what the frame
        // re-weights.
        let _seed = 987654321;
        const noise = (amp) => {
            _seed = (_seed * 1103515245 + 12345) & 0x7fffffff;
            return (_seed / 0x7fffffff - 0.5) * 2 * amp;
        };
        const obsFor = (X, cams, idxs, amp) => {
            const o = [], P = [];
            for (const i of idxs) {
                const q = proj(X, cams[i]);
                o.push(q ? [q[0] + noise(amp || 0), q[1] + noise(amp || 0)] : null);
                P.push(cams[i].projectionMatrix);
            }
            return { o, P };
        };
        const dist = (a, b) => Math.hypot(a[0]-b[0], a[1]-b[1], a[2]-b[2]);

        function invariance(Xtrue, idxs, amp) {
            const A = obsFor(Xtrue, camsA, idxs, amp);
            const XA = TRI.triangulatePointDLT(A.o, A.P);
            // SAME pixels (the observations are what a detector produced; they
            // do not move when the world is re-expressed) through re-based cameras.
            const B = { o: A.o, P: idxs.map(i => camsB[i].projectionMatrix) };
            const XB = TRI.triangulatePointDLT(B.o, B.P);
            if (!XA || !XB) return { ok: false };
            const mapped = toNew(XA);
            return {
                ok: true, XA, XB, mapped,
                drift: mapped ? dist(mapped, XB) : null,
                errA: dist(XA, Xtrue),
                // The two answers must land on the SAME pixels — each through
                // its own cameras. Compared to each other, not to the noisy
                // input, because with noise neither one sits on the input.
                reproj: Math.max(...idxs.map((i) => {
                    const qa = proj(XA, camsA[i]);
                    const qb = proj(XB, camsB[i]);
                    return (qa && qb) ? Math.hypot(qa[0] - qb[0], qa[1] - qb[1]) : Infinity;
                })),
            };
        }

        const res = {};
        res.well = invariance([40, -25, 60], [0, 1, 2, 3, 4, 5], 0.5);
        // Ill-conditioned: two ADJACENT cameras only, so the rays are close to
        // parallel; with noise they do not meet, and the algebraic minimum is
        // both shallow and a compromise — the case the old solver resolved
        // differently in the two frames.
        res.ill = invariance([15, 200, 35], [0, 1], 3);
        res.ill2 = invariance([-260, 40, 250], [2, 3], 3);
        // The worst of it: the biggest disagreements on real data were
        // MIS-ASSOCIATED points, where the rays miss by a wide margin.
        res.bad = invariance([15, 200, 35], [0, 1, 2], 25);

        // Pure translation, including a big one.
        function translated(dz) {
            const f2 = OF.buildOriginFrame([0, 0, dz], [0, 0, 1], null);
            const cB = camsA.map(c => {
                const r = OF.rebaseExtrinsics(c.rotationMatrix, c.tvec, f2);
                return new PD.Camera(c.name, K, [0,0,0,0,0], r.R, r.tvec, [1280, 1024]);
            });
            const A = obsFor([15, 200, 35], camsA, [0, 1], 3);
            const XA = TRI.triangulatePointDLT(A.o, A.P);
            const XB = TRI.triangulatePointDLT(A.o, [0, 1].map(i => cB[i].projectionMatrix));
            if (!XA || !XB) return { ok: false };
            return { ok: true, drift: dist([XA[0], XA[1], XA[2] - dz], XB) };
        }
        res.t1 = translated(1000);
        res.t2 = translated(10000);

        // Negative control: the two camera sets really are different frames.
        res.control = Math.hypot(
            camsA[0].tvec[0] - camsB[0].tvec[0],
            camsA[0].tvec[1] - camsB[0].tvec[1],
            camsA[0].tvec[2] - camsB[0].tvec[2]);

        // ---- the tracker, over a contested multi-frame run ----
        // The PIXELS are produced ONCE, through the original cameras, and fed
        // to both runs. A detector does not know which calibration file is
        // loaded, so re-projecting through the re-based cameras would change
        // the INPUT rather than just the frame — which is a different
        // experiment, and one that proves nothing about invariance.
        const pixels = [];
        for (let f = 0; f < 25; f++) {
            // three animals on crossing paths, so association is contested
            const bodies = [
                [ -60 + 5 * f,  40 - 3 * f, 30],
                [  60 - 5 * f, -40 + 3 * f, 45],
                [   0,          10 + f,     70],
            ];
            const perCam = {};
            for (let ci = 0; ci < camsA.length; ci++) {
                const list = [];
                for (let bi = 0; bi < bodies.length; bi++) {
                    const pts = [];
                    for (let k = 0; k < 5; k++) {
                        const X = [bodies[bi][0] + 12 * k, bodies[bi][1] + 4 * k, bodies[bi][2] + 2 * k];
                        const q = proj(X, camsA[ci]);
                        // Noisy, for the reason given at `noise` above: on exact
                        // projections the solver has an exact answer and a
                        // frame change cannot perturb it.
                        pts.push(q ? [q[0] + noise(2), q[1] + noise(2)] : null);
                    }
                    list.push(pts);
                }
                perCam[camsA[ci].name] = list;
            }
            pixels.push(perCam);
        }
        function track(cams) {
            const tracker = new CVT.CrossViewTracker({});
            const sigs = [];
            for (let f = 0; f < 25; f++) {
                const m = new Map();
                for (const cam of cams) {
                    m.set(cam.name, pixels[f][cam.name].map((pts, bi) => new CVT.Detection(
                        new PD.Instance(pts, bi, 'predicted', 1), cam, f, bi)));
                }
                tracker.trackFrame(m, cams);
                sigs.push(tracker.targets.map(t => {
                    const p = [];
                    for (const [cn, d] of t.detsByCam) if (d.frameIdx === f) p.push(cn + ':' + d.slot);
                    p.sort(); return p.join(',');
                }).filter(s => s).sort().join(' | '));
            }
            return sigs;
        }
        const sA = track(camsA), sB = track(camsB);
        res.trackFrames = sA.length;
        res.trackDiff = sA.filter((s, i) => s !== sB[i]).length;
        res.trackNonEmpty = sA.filter(s => s.length > 0).length;
        return res;
    });

    const TOL = 1e-6;   // mm — machine precision for an exact map, not a fit
    check(out.control > 100,
        `NEGATIVE CONTROL: the re-based cameras are a different frame (t moved ${out.control.toFixed(1)} mm)`);

    check(out.well.ok && out.well.drift < TOL,
        `a well-conditioned 6-view point is invariant (${out.well.ok ? out.well.drift.toExponential(2) : 'n/a'} mm)`);
    check(out.well.ok && out.well.errA < 5,
        `and it is near the right point to begin with (${out.well.ok ? out.well.errA.toFixed(3) : 'n/a'} mm from truth)`);

    check(out.ill.ok && out.ill.drift < TOL,
        `an ILL-CONDITIONED 2-view point is invariant too (${out.ill.ok ? out.ill.drift.toExponential(2) : 'n/a'} mm) ` +
        '— this is one of the assertions that fails pre-fix');
    check(out.ill2.ok && out.ill2.drift < TOL,
        `and a second one, on a different camera pair (${out.ill2.ok ? out.ill2.drift.toExponential(2) : 'n/a'} mm)`);
    check(out.bad.ok && out.bad.drift < TOL,
        `a badly MIS-ASSOCIATED point — rays missing by 25 px — is invariant ` +
        `(${out.bad.ok ? out.bad.drift.toExponential(2) : 'n/a'} mm); pre-fix this was the worst case`);

    check(out.t1.ok && out.t1.drift < TOL,
        `a pure 1 m translation of the origin changes nothing (${out.t1.ok ? out.t1.drift.toExponential(2) : 'n/a'} mm)`);
    check(out.t2.ok && out.t2.drift < TOL,
        `nor does 10 km (${out.t2.ok ? out.t2.drift.toExponential(2) : 'n/a'} mm)`);

    check(out.well.ok && out.well.reproj < 1e-6,
        `both answers reproject onto the SAME pixels, each through its own cameras ` +
        `(${out.well.ok ? out.well.reproj.toExponential(2) : 'n/a'} px)`);

    check(out.trackNonEmpty === out.trackFrames,
        `the tracker actually grouped something on all ${out.trackFrames} frames (control)`);
    check(out.trackDiff === 0,
        `CrossViewTracker produces an IDENTICAL grouping under both calibrations ` +
        `(${out.trackDiff}/${out.trackFrames} frames differ)`);

    console.log('');
    check(errs.length === 0, 'no page errors / console errors' + (errs.length ? ': ' + errs.join(' | ') : ''));
} catch (err) {
    console.error('FATAL', err);
    fails++;
} finally {
    if (browser) await browser.close();
    server.kill('SIGTERM');
}

console.log(fails === 0 ? '\n✅ ALL CHECKS PASSED' : `\n❌ ${fails} CHECK(S) FAILED`);
process.exit(fails === 0 ? 0 : 1);
