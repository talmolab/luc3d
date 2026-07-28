/**
 * Guards the LUCID local patch (luc3d #185) that made the vendored writer
 * accumulate `/session_data/points_3d` (and `pred_points_3d`) into a pre-sized
 * Float64Array instead of ~1 boxed `Array(3)` per 3D keypoint.
 *
 * That patch moved an estimated ~400 MB off V8's pointer-compressed heap on the
 * real 180,210-frame x 5-camera project (531,799 instance groups x 15 nodes =
 * 7,976,985 3D rows; the table becomes one ~191 MB Float64Array whose backing
 * store lives outside that heap). A renderer hard-caps that heap near 4 GB
 * (measured jsHeapSizeLimit 3.76 GB), and a controlled A/B on that project went
 * from a crash 13 s into Save As to writing 1,404,804,682 bytes in 49.5 s.
 * This test does NOT measure memory — it pins
 * the thing the optimization could plausibly break: the exact VALUES written,
 * including
 *   - a fully-null 3D keypoint row  -> [NaN, NaN, NaN]
 *   - an individually-null coordinate -> NaN in that column only
 *   - predicted 3D instances -> the trailing score column, incl. a missing score
 *   - row ordering / the per-group [pts3dStart, pts3dEnd) slice bounds
 *
 * A silent regression here is realistic: writes past the end of a typed array are
 * discarded without error, so an undercount in the patch's sizing pre-pass would
 * corrupt 3D points invisibly. (The sink also throws on overflow for that reason.)
 *
 * Run: node save-session-3d-typed-sink.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 8112);
const LOG = (...a) => console.log(...a);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

let failures = 0;
const check = (name, cond, extra) => {
    if (cond) LOG(`  ok   ${name}`);
    else { failures++; LOG(`  FAIL ${name}${extra !== undefined ? ' -> ' + JSON.stringify(extra) : ''}`); }
};

let browser;
try {
    browser = await chromium.launch({ headless: true });
    const page = await browser.newPage();
    page.on('pageerror', e => LOG('[pageerror]', String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') LOG('[console.error]', m.text().slice(0, 300)); });

    await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'domcontentloaded', timeout: 120000 });
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, { timeout: 120000 });

    // Build a Labels graph directly against the vendored sleap-io.js typed API —
    // the same objects `writeSessions` consumes on the real save path — with 3D
    // point payloads chosen to exercise every coercion branch, then round-trip
    // it through the real writer and read the raw datasets back.
    const result = await page.evaluate(async () => {
        const SIO = window.SleapIO;
        const skeleton = new SIO.Skeleton({ name: 'sk', nodes: ['a', 'b', 'c'] });
        const video = new SIO.Video({ filename: 'v0.mp4', shape: [10, 8, 8, 1] });

        const cam = new SIO.Camera({ name: 'cam0', size: [8, 8] });
        const cam2 = new SIO.Camera({ name: 'cam1', size: [8, 8] });
        const cameraGroup = new SIO.CameraGroup({ cameras: [cam, cam2] });
        const session = new SIO.RecordingSession({ cameraGroup });
        session.videoByCamera.set(cam, video);
        session.videoByCamera.set(cam2, video);

        // Group 0: a USER 3D instance. Row 1 is entirely null; row 2 has a null Y.
        const g0pts = [[1.5, 2.5, 3.5], null, [7, null, 9]];
        // Group 1: a PREDICTED 3D instance with point scores, one of them missing
        // (scores shorter than points -> undefined -> must land as NaN).
        const g1pts = [[10, 11, 12], [13, 14, 15]];
        const g1scores = [0.25];

        const lf = new SIO.LabeledFrame({ video, frameIdx: 0, instances: [] });
        const ig0 = new SIO.InstanceGroup({ instance3d: new SIO.Instance3D({ points: g0pts, skeleton }) });
        const ig1 = new SIO.InstanceGroup({
            instance3d: new SIO.PredictedInstance3D({ points: g1pts, skeleton, pointScores: g1scores }),
        });
        const fg = new SIO.FrameGroup({ frameIdx: 0, instanceGroups: [ig0, ig1] });
        session.frameGroups.set(0, fg);

        const labels = new SIO.Labels({
            skeletons: [skeleton], videos: [video], labeledFrames: [lf], sessions: [session],
        });

        const bytes = await SIO.saveSlpToBytes(labels);

        // Read the raw columnar datasets back out of the produced file.
        const h5 = window.h5wasm;
        await h5.ready;
        const p = '/rt-3d-typed.slp';
        h5.FS.writeFile(p, bytes);
        const f = new h5.File(p, 'r');
        const read = n => {
            const d = f.get(n);
            if (!d) return null;
            return { shape: d.shape, value: Array.from(d.value) };
        };
        const out = {
            byteLength: bytes.byteLength,
            hasSessionData: !!f.get('session_data'),
            points_3d: read('session_data/points_3d'),
            pred_points_3d: read('session_data/pred_points_3d'),
            instance_groups: read('session_data/instance_groups'),
        };
        f.close();
        return out;
    });

    LOG('save-session-3d-typed-sink:');
    check('produced a file', result.byteLength > 0, result.byteLength);
    check('wrote the SLP 2.8 columnar /session_data group', result.hasSessionData);

    // ---- user 3D points: 3 rows x 3 cols, exact values incl. NaN placement ----
    const p3 = result.points_3d;
    check('points_3d shape is [3,3]', p3 && p3.shape[0] === 3 && p3.shape[1] === 3, p3 && p3.shape);
    if (p3) {
        const v = p3.value;
        const isNaNAt = i => Number.isNaN(v[i]);
        check('row0 = [1.5, 2.5, 3.5] exactly', v[0] === 1.5 && v[1] === 2.5 && v[2] === 3.5, v.slice(0, 3));
        check('row1 (null row) = all NaN', isNaNAt(3) && isNaNAt(4) && isNaNAt(5), v.slice(3, 6));
        check('row2 = [7, NaN, 9] (null coord -> NaN in that column only)',
            v[6] === 7 && isNaNAt(7) && v[8] === 9, v.slice(6, 9));
    }

    // ---- predicted 3D points: trailing score column, missing score -> NaN ----
    const pp = result.pred_points_3d;
    check('pred_points_3d shape is [2,4]', pp && pp.shape[0] === 2 && pp.shape[1] === 4, pp && pp.shape);
    if (pp) {
        const v = pp.value;
        check('pred row0 = [10, 11, 12, 0.25]',
            v[0] === 10 && v[1] === 11 && v[2] === 12 && v[3] === 0.25, v.slice(0, 4));
        check('pred row1 = [13, 14, 15, NaN] (missing score -> NaN)',
            v[4] === 13 && v[5] === 14 && v[6] === 15 && Number.isNaN(v[7]), v.slice(4, 8));
    }

    // ---- the per-group slice bounds must still address those rows ----
    const ig = result.instance_groups;
    check('instance_groups has 2 rows', ig && ig.shape[0] === 2, ig && ig.shape);
    if (ig && ig.shape[0] === 2) {
        const w = ig.shape[1];
        // SESSION_INSTANCE_GROUP_FIELDS = [identity, score, i3d_score,
        //   pts3d_start, pts3d_end, pts3d_predicted, member_start, member_end]
        const row = r => ig.value.slice(r * w, (r + 1) * w);
        const a = row(0), b = row(1);
        check('group0 slice is [0,3) and not flagged predicted',
            a[3] === 0 && a[4] === 3 && a[5] === 0, [a[3], a[4], a[5]]);
        check('group1 slice is [0,2) into the PREDICTED table and is flagged predicted',
            b[3] === 0 && b[4] === 2 && b[5] === 1, [b[3], b[4], b[5]]);
    }

    // ---- many-group scenario ----------------------------------------------
    // The single-group case above can't catch a sizing pre-pass that drifts from
    // the write loop only once user and predicted groups interleave across many
    // frames. This builds 4,000 frame groups alternating user/predicted 3D
    // instances (plus a null row in every user group) and checks that BOTH
    // tables end up with exactly the expected row counts and that a sampled
    // group's slice still addresses its own points.
    const bulk = await page.evaluate(async () => {
        const SIO = window.SleapIO;
        const NFG = 4000, NODES = 15;
        const skeleton = new SIO.Skeleton({
            name: 'sk', nodes: Array.from({ length: NODES }, (_, i) => 'n' + i),
        });
        const video = new SIO.Video({ filename: 'v0.mp4', shape: [NFG, 8, 8, 1] });
        const cam = new SIO.Camera({ name: 'cam0', size: [8, 8] });
        const cameraGroup = new SIO.CameraGroup({ cameras: [cam] });
        const session = new SIO.RecordingSession({ cameraGroup });
        session.videoByCamera.set(cam, video);

        let expUser = 0, expPred = 0;
        for (let f = 0; f < NFG; f++) {
            const groups = [];
            // user group: node 3 is null, everything else is a real triple keyed to f
            const upts = Array.from({ length: NODES }, (_, k) => (k === 3 ? null : [f, k, f + k]));
            groups.push(new SIO.InstanceGroup({ instance3d: new SIO.Instance3D({ points: upts, skeleton }) }));
            expUser += NODES;
            if (f % 2 === 0) {
                const ppts = Array.from({ length: NODES }, (_, k) => [f + 0.5, k, 1]);
                groups.push(new SIO.InstanceGroup({
                    instance3d: new SIO.PredictedInstance3D({
                        points: ppts, skeleton,
                        pointScores: Array.from({ length: NODES }, () => 0.5),
                    }),
                }));
                expPred += NODES;
            }
            session.frameGroups.set(f, new SIO.FrameGroup({ frameIdx: f, instanceGroups: groups }));
        }
        const labels = new SIO.Labels({
            skeletons: [skeleton], videos: [video], labeledFrames: [], sessions: [session],
        });
        const bytes = await SIO.saveSlpToBytes(labels);

        const h5 = window.h5wasm;
        await h5.ready;
        const p = '/rt-3d-bulk.slp';
        h5.FS.writeFile(p, bytes);
        const f2 = new h5.File(p, 'r');
        const pts = f2.get('session_data/points_3d');
        const pred = f2.get('session_data/pred_points_3d');
        const igs = f2.get('session_data/instance_groups');
        // Spot-check the LAST user group: its slice must hold f=NFG-1's triples.
        const igShape = igs.shape;
        const igVals = Array.from(igs.value);
        const w = igShape[1];
        // find the final user row (pts3d_predicted === 0)
        let lastUserRow = -1;
        for (let r = igShape[0] - 1; r >= 0; r--) {
            if (igVals[r * w + 5] === 0) { lastUserRow = r; break; }
        }
        const start = igVals[lastUserRow * w + 3], end = igVals[lastUserRow * w + 4];
        // h5wasm's slice() hands back the data directly (not a {value} wrapper);
        // tolerate either so this doesn't hinge on that detail.
        const asArr = x => Array.from(x && x.value !== undefined ? x.value : x);
        const slice = asArr(pts.slice([[start, start + 1], [0, 3]]));
        const nullRow = asArr(pts.slice([[start + 3, start + 4], [0, 3]]));
        const out = {
            NFG, NODES, expUser, expPred,
            ptsShape: pts.shape, predShape: pred.shape, igRows: igShape[0],
            lastUserSliceLen: end - start,
            firstNodeOfLastUser: slice,
            nullNodeOfLastUser: nullRow,
        };
        f2.close();
        return out;
    });

    LOG('  -- many-group scenario --');
    check(`points_3d has exactly ${bulk.expUser} rows`,
        bulk.ptsShape[0] === bulk.expUser, bulk.ptsShape);
    check(`pred_points_3d has exactly ${bulk.expPred} rows`,
        bulk.predShape[0] === bulk.expPred, bulk.predShape);
    check('instance_groups row count = user + predicted groups',
        bulk.igRows === bulk.NFG + bulk.NFG / 2, bulk.igRows);
    check('last user group slice spans exactly NODES rows',
        bulk.lastUserSliceLen === bulk.NODES, bulk.lastUserSliceLen);
    check('last user group node0 = [NFG-1, 0, NFG-1]',
        bulk.firstNodeOfLastUser[0] === bulk.NFG - 1 &&
        bulk.firstNodeOfLastUser[1] === 0 &&
        bulk.firstNodeOfLastUser[2] === bulk.NFG - 1, bulk.firstNodeOfLastUser);
    check('last user group node3 (null) = all NaN',
        bulk.nullNodeOfLastUser.every(Number.isNaN), bulk.nullNodeOfLastUser);

    LOG(failures === 0 ? '\nPASS' : `\nFAIL (${failures} assertion(s))`);
} catch (err) {
    failures++;
    LOG('*** ERROR ***', (err && err.stack) || String(err));
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
}
process.exit(failures === 0 ? 0 : 1);
