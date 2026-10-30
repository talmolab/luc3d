/**
 * Guards the LUCID local patch (luc3d eager-save) that makes the vendored
 * writer's `writeLabeledFrames` append the four 2D tables — `frames`,
 * `instances`, `points`, `pred_points` — through fixed-size LucidAppendTables
 * (luc3d #191) instead of building one boxed JS row per keypoint.
 *
 * Those boxed rows are what ran the eager project Save out of memory on a
 * 17-camera, 34-node, 36,000-frame recording (47M keypoint rows; a prediction's
 * row grew to ~210 B of V8 heap). This test does NOT measure memory
 * (`tests/e2e/_diag-eager-save-heap.mjs` does, on real data). It pins what the
 * patch could plausibly break, by comparing every written value against rows
 * built by the ORIGINAL algorithm (`referenceRows`, a copy of the pre-patch
 * `writeLabeledFrames`/`emitInstancePoints` row logic):
 *   - every table crosses a flush boundary (> 8,192 rows), so the running
 *     `[start, end)` bookkeeping across flushes is under test — asserted, so
 *     the coverage cannot lapse if the fixture shrinks;
 *   - user AND predicted instances, NaN coordinates, a NaN score, invisible /
 *     incomplete points, trackless instances, two videos;
 *   - an instance with FEWER points than its skeleton has nodes (the padding
 *     row) and one with MORE (truncated);
 *   - `from_predicted`: a link to an instance in the file, one to an instance
 *     that is not, and one to an instance in a LATER frame (already flushed
 *     rows cannot be patched afterwards, which is why the patch resolves the
 *     links first);
 *   - the layout: an overflowing table is chunked and appendable, while a small
 *     file's tables stay contiguous (save-golden-digest.mjs pins the bytes).
 *
 * Run: node tests/e2e/save-2d-tables-append.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const PORT = Number(process.env.PORT || 8113);
const LOG = (...a) => console.log(...a);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: REPO, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));
if (server.exitCode !== null) {
    console.error(`port ${PORT} is in use; pass PORT= a free port`);
    process.exit(2);
}

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
    await page.waitForFunction(() => window.SleapIO && window.h5wasm, null, { timeout: 120000 });

    const r = await page.evaluate(async () => {
        const SIO = window.SleapIO;
        const NODES = ['a', 'b', 'c', 'd'];
        const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES });
        const videos = [
            new SIO.Video({ filename: 'cam0.mp4', shape: [5000, 16, 16, 1] }),
            new SIO.Video({ filename: 'cam1.mp4', shape: [5000, 16, 16, 1] }),
        ];
        const tracks = [new SIO.Track({ name: 't0' }), new SIO.Track({ name: 't1' })];
        // Deterministic, irregular coordinates (not representable exactly in
        // float32, so the f32 cast of `points`/`pred_points` is under test too).
        const val = (k) => Math.sin(k * 12.9898) * 437.5453;
        const pointsFor = (seed, n, predicted) => {
            const pts = [];
            for (let i = 0; i < n; i++) {
                const k = seed * 7 + i;
                const p = {
                    xy: (k % 23 === 0) ? [NaN, NaN] : [val(k), val(k + 0.5)],
                    visible: k % 5 !== 0,
                    complete: k % 3 === 0,
                    name: NODES[i],
                };
                if (predicted) p.score = (k % 29 === 0) ? NaN : Math.abs(val(k + 0.25)) / 500;
                pts.push(p);
            }
            return pts;
        };
        // An instance that is NOT in the file, as a from_predicted target.
        const orphan = new SIO.PredictedInstance({ points: pointsFor(-1, 4, true), skeleton, score: 0.5 });

        const NF = 4500;
        const labeledFrames = [];
        let seed = 0;
        const pending = [];          // user instances linked to a LATER frame's prediction
        for (let f = 0; f < NF; f++) {
            for (let v = 0; v < 2; v++) {
                // Every 97th instance is short (3 points), every 101st long (5).
                const nPred = (seed % 97 === 0) ? 3 : 4;
                const pred = new SIO.PredictedInstance({
                    points: pointsFor(seed++, nPred, true), skeleton,
                    track: (f % 11 === 0) ? null : tracks[f % 2],
                    score: (f % 13 === 0) ? NaN : 0.25 + (f % 7) / 10,
                    trackingScore: (f % 17 === 0) ? undefined : (f % 5) / 4,
                });
                const nUser = (seed % 101 === 0) ? 5 : 4;
                const user = new SIO.Instance({
                    points: pointsFor(seed++, nUser, false), skeleton,
                    track: tracks[(f + 1) % 2],
                    fromPredicted: (f % 3 === 0) ? pred : (f % 3 === 1) ? orphan : null,
                });
                const insts = [pred, user];
                if (f % 50 === 0) pending.push(user);
                labeledFrames.push(new SIO.LabeledFrame({ video: videos[v], frameIdx: f, instances: insts }));
            }
        }
        // Link early user instances to a prediction in the LAST frame.
        const lastPred = labeledFrames[labeledFrames.length - 1].instances[0];
        for (const u of pending) u.fromPredicted = lastPred;

        const labels = new SIO.Labels({ skeletons: [skeleton], videos, tracks, labeledFrames });

        // The ORIGINAL row logic (pre-patch writeLabeledFrames +
        // emitInstancePoints), kept here as the reference.
        function referenceRows(labels) {
            const frames = [], instances = [], points = [], predPoints = [];
            const instanceIndex = new Map(), predictedLinks = [];
            const emit = (target, instance, predicted) => {
                const nNodes = instance.skeleton.nodeNames.length;
                const pts = instance.points;
                for (let i = 0; i < nNodes; i++) {
                    const p = pts[i];
                    if (p) {
                        const row = [p.xy[0], p.xy[1], p.visible ? 1 : 0, p.complete ? 1 : 0];
                        if (predicted) row.push(p.score ?? 0);
                        target.push(row);
                    } else {
                        target.push(predicted ? [NaN, NaN, 0, 0, 0] : [NaN, NaN, 0, 0]);
                    }
                }
            };
            for (const lf of labels.labeledFrames) {
                const frameId = frames.length, instanceStart = instances.length;
                const videoIndex = Math.max(0, labels.videos.indexOf(lf.video));
                for (const instance of lf.instances) {
                    const instanceId = instances.length;
                    instanceIndex.set(instance, instanceId);
                    const skeletonId = Math.max(0, labels.skeletons.indexOf(instance.skeleton));
                    const trackId = instance.track ? labels.tracks.indexOf(instance.track) : -1;
                    const trackingScore = instance.trackingScore ?? 0;
                    let score = 0, pointStart = 0, pointEnd = 0;
                    if (instance instanceof SIO.PredictedInstance) {
                        score = instance.score ?? 0;
                        pointStart = predPoints.length; emit(predPoints, instance, true); pointEnd = predPoints.length;
                    } else {
                        pointStart = points.length; emit(points, instance, false); pointEnd = points.length;
                        if (instance.fromPredicted) predictedLinks.push([instanceId, instance.fromPredicted]);
                    }
                    instances.push([instanceId, instance instanceof SIO.PredictedInstance ? 1 : 0, frameId,
                        skeletonId, trackId, -1, score, pointStart, pointEnd, trackingScore]);
                }
                frames.push([frameId, videoIndex, lf.frameIdx, instanceStart, instances.length]);
            }
            for (const [id, from] of predictedLinks) {
                const fi = instanceIndex.get(from);
                instances[id][5] = fi != null ? fi : -1;
            }
            return { frames, instances, points, pred_points: predPoints };
        }
        const ref = referenceRows(labels);

        const h5 = window.h5wasm;
        await h5.ready;
        const readBack = async (lab, p) => {
            const bytes = await SIO.saveSlpToBytes(lab);
            h5.FS.writeFile(p, bytes);
            const f = new h5.File(p, 'r');
            const out = {};
            for (const n of ['frames', 'instances', 'points', 'pred_points']) {
                const d = f.get(n);
                out[n] = { shape: d.shape, maxshape: d.metadata.maxshape, dtype: d.dtype, value: d.value,
                    fields: JSON.parse(d.attrs.field_names.value) };
            }
            f.close();
            h5.FS.unlink(p);
            return out;
        };
        const got = await readBack(labels, '/rt-2d-append.slp');

        // Compare, cast as the file stores each table (points are float32,
        // frames int32, instances float64), bit for bit (NaN == NaN).
        const cast = { frames: (x) => x | 0, instances: (x) => x, points: Math.fround, pred_points: Math.fround };
        const cmp = {};
        for (const n of Object.keys(ref)) {
            const rows = ref[n], g = got[n];
            const w = g.shape[1];
            let mismatches = 0, first = null;
            for (let i = 0; i < rows.length; i++) {
                for (let j = 0; j < w; j++) {
                    const e = cast[n](rows[i][j]);
                    const a = Number(g.value[i * w + j]);
                    if (!(Object.is(e, a) || (Number.isNaN(e) && Number.isNaN(a)) || (e === 0 && a === 0))) {
                        mismatches++;
                        if (!first) first = { row: i, col: j, expected: e, got: a };
                    }
                }
            }
            cmp[n] = { refRows: rows.length, gotRows: g.shape[0], cols: w, mismatches, first,
                maxshape: g.maxshape, dtype: g.dtype, fields: g.fields };
        }

        // A small file (one flush's worth or less) keeps contiguous tables.
        const small = new SIO.Labels({ skeletons: [skeleton], videos, tracks, labeledFrames: labeledFrames.slice(0, 10) });
        const gotSmall = await readBack(small, '/rt-2d-small.slp');
        const smallLayout = {};
        for (const n of Object.keys(gotSmall)) smallLayout[n] = { shape: gotSmall[n].shape, maxshape: gotSmall[n].maxshape };

        const links = {
            inFile: ref.instances.filter((row, i) => row[1] === 0 && row[5] >= 0 && row[5] < i).length,
            orphan: ref.instances.filter(row => row[1] === 0 && row[5] === -1).length,
            later: ref.instances.filter((row, i) => row[1] === 0 && row[5] > i).length,
        };
        return { cmp, smallLayout, links };
    });

    const FLUSH = 8192;
    for (const [n, c] of Object.entries(r.cmp)) {
        check(`${n}: more rows than one flush (${c.refRows.toLocaleString('en-US')} > ${FLUSH})`, c.refRows > FLUSH, c.refRows);
        check(`${n}: row count matches the reference`, c.gotRows === c.refRows, [c.gotRows, c.refRows]);
        check(`${n}: every value matches the reference`, c.mismatches === 0, c);
        // h5wasm reports H5S_UNLIMITED as 2^64 - 1.
        check(`${n}: appended (chunked, unlimited rows)`, Array.isArray(c.maxshape) && (c.maxshape[0] == null || c.maxshape[0] > 2 ** 60), c.maxshape);
    }
    check('frames field_names', JSON.stringify(r.cmp.frames.fields) === JSON.stringify(['frame_id', 'video', 'frame_idx', 'instance_id_start', 'instance_id_end']), r.cmp.frames.fields);
    check('instances stay float64 (sleap-io.js#231)', /f8|<d|float64/i.test(String(r.cmp.instances.dtype)), r.cmp.instances.dtype);
    check('from_predicted: links to earlier instances', r.links.inFile > 0, r.links);
    check('from_predicted: links to instances not in the file are -1', r.links.orphan > 0, r.links);
    check('from_predicted: links to LATER instances (resolved before their rows flush)', r.links.later > 0, r.links);
    for (const [n, l] of Object.entries(r.smallLayout)) {
        check(`small file: ${n} stays contiguous`, JSON.stringify(l.maxshape) === JSON.stringify(l.shape), l);
    }
} catch (e) {
    failures++;
    LOG('ERROR', e && e.stack || e);
} finally {
    if (browser) await browser.close();
    server.kill();
}
LOG(failures ? `\nFAIL (${failures})` : '\nPASS');
process.exit(failures ? 1 : 0);
