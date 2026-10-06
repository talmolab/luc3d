/**
 * percam-track-union.mjs — a per-camera session folder whose cameras carry
 * DIFFERENT track lists must give one, deterministic `session.tracks`, and
 * every instance's trackIdx must be in range and name that instance's own
 * track — whichever camera's file finishes opening first.
 *
 * Reported 2026-10-06: five loads of one real 8-camera folder through
 * `handleLoadSessionFolderPerCamera` gave `session.tracks.length` = 262, 863,
 * 863, 863, 388. Each camera's `.slp` has its own list (249..863 tracks), files
 * over 150 MB take the lazy path, and `SioLazyLoader.open()` — called for every
 * camera in parallel — took `trackNames` from whichever open resolved FIRST,
 * while each camera's instances kept indices into their OWN list. So a camera
 * with more tracks than the winner had indices past the end of
 * `session.tracks`, and every other camera's track names and colours were read
 * off another camera's list.
 *
 * This drives the REAL folder loader on a synthetic folder of three cameras
 * whose lists differ in length AND are not prefixes of one another, and forces
 * the lazy opens to resolve in each of the six possible orders (a shim around
 * `window.SleapIO.readSlpStreaming` holds each camera's read until the previous
 * camera's open has finished). It asserts, for every order:
 *   - `session.tracks` is the same list — the union, cameras in name order;
 *   - every hydrated instance's trackIdx is in range and
 *     `session.tracks[trackIdx]` is the name its own file gave it (the fixture
 *     encodes each instance's own track index in its x coordinate);
 *   - the columnar store agrees for EVERY row (`forEachInstanceRow`), the
 *     Tracks Timeline occupancy is keyed by session index, and each camera's
 *     `labels.tracks` is that same list (what the streaming writer reads);
 * then that the EAGER path (same files, under the threshold) gives the same
 * list, and that a streaming save writes the tracks once rather than once per
 * camera. A precondition check confirms the six orders really did put three
 * different cameras first, so the test cannot quietly stop testing the race.
 *
 * Confirmed to fail on the pre-fix build. Run: node tests/e2e/percam-track-union.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8273);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch({ args: ['--disable-dev-shm-usage'] });
    const page = await browser.newPage();
    const errs = [];
    page.on('pageerror', e => errs.push('pageerror: ' + String(e).slice(0, 300)));
    page.on('console', m => { if (m.type() === 'error') errs.push('console.error: ' + m.text().slice(0, 200)); });

    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, { timeout: 30000 });

    const r = await page.evaluate(async () => {
        const loader = await import('/loading/session-loader.js');
        const tri = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const ssw = await import('/import-export/slp-streaming-write.js');
        const SIO = window.SleapIO;

        // Own track lists. camB is the longest; camC's names are out of order
        // and include one nobody else has, so the union depends on the ORDER
        // the cameras are taken in — which must be camera name, not I/O timing.
        const OWN = {
            camA: ['track_0', 'track_1', 'track_2'],
            camB: ['track_0', 'track_1', 'track_2', 'track_3', 'track_4', 'track_5', 'track_6'],
            camC: ['track_9', 'track_0', 'mouse_x', 'track_4'],
        };
        const EXPECTED = ['track_0', 'track_1', 'track_2', 'track_3', 'track_4', 'track_5', 'track_6', 'track_9', 'mouse_x'];
        // NOT name order, and camC first: the eager loader used to merge in
        // calibration order, which would put camC's track_9 at index 0.
        const CALIB_ORDER = ['camC', 'camB', 'camA'];
        const CAMS = Object.keys(OWN);
        const NF = 8, ROOT = 'sess', TRACKLESS_X = 999.5;
        const NODES = ['nose', 'tail'];

        // ---- per-camera .slp fixtures --------------------------------------
        // Frame f holds two predictions on own tracks f%n and (f+1)%n (so every
        // own track occurs), node 0 at x = 10*ownTrack + 1.5. camA frame 0 also
        // holds one TRACKLESS prediction at x = TRACKLESS_X.
        async function slpBytes(cam) {
            const skeleton = new SIO.Skeleton({ name: 'sk', nodes: NODES });
            const video = new SIO.Video({ filename: cam + '.mp4', shape: [NF, 64, 64, 1] });
            const tracks = OWN[cam].map(n => new SIO.Track(n));
            const n = tracks.length;
            const lfs = [];
            for (let f = 0; f < NF; f++) {
                const insts = [];
                for (const t of [f % n, (f + 1) % n]) {
                    const x = 10 * t + 1.5;
                    insts.push(new SIO.PredictedInstance({
                        points: [[x, f + 1], [x + 2, f + 2]], skeleton, track: tracks[t], score: 0.9,
                    }));
                }
                if (cam === 'camA' && f === 0) {
                    insts.push(new SIO.PredictedInstance({
                        points: [[TRACKLESS_X, 1], [TRACKLESS_X + 2, 2]], skeleton, track: null, score: 0.9,
                    }));
                }
                lfs.push(new SIO.LabeledFrame({ video, frameIdx: f, instances: insts }));
            }
            return SIO.saveSlpToBytes(new SIO.Labels({ skeletons: [skeleton], videos: [video], tracks, labeledFrames: lfs }));
        }
        const bytes = {};
        for (const cam of CAMS) bytes[cam] = await slpBytes(cam);

        function mkFile(bits, relPath, type) {
            const f = new File(bits, relPath.split('/').pop(), { type: type || 'application/octet-stream' });
            Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
            return f;
        }
        let toml = '';
        CALIB_ORDER.forEach((cn, i) => {
            toml += '[cam_' + i + ']\nname = "' + cn + '"\nsize = [64, 64]\n'
                + 'matrix = [[600.0, 0.0, 32.0], [0.0, 600.0, 32.0], [0.0, 0.0, 1.0]]\n'
                + 'distortions = [0.0, 0.0, 0.0, 0.0, 0.0]\n'
                + 'rotation = [0.0, ' + (0.2 * i) + ', 0.0]\ntranslation = [' + (15 * i) + ', 0.0, 0.0]\n\n';
        });
        // `shouldUseLazySlp` reads only `file.size`, and HDF5 ignores trailing
        // bytes, so zero padding sends a real file down the lazy path. One
        // shared pad; the File objects are reused across loads.
        const pad = new Uint8Array(tri.LAZY_SLP_THRESHOLD + (1 << 20));
        const slpFiles = { lazy: {}, eager: {} };
        for (const cam of CAMS) {
            const rel = ROOT + '/' + cam + '/' + cam + '_v1.slp';
            slpFiles.lazy[cam] = mkFile([bytes[cam], pad], rel, 'application/x-hdf5');
            slpFiles.eager[cam] = mkFile([bytes[cam]], rel, 'application/x-hdf5');
        }
        // Videos are deferred (never decoded); a camera directory only has to
        // HAVE one, or the loader stops to ask for it.
        const videos = CAMS.map(cam => mkFile([new Uint8Array(16)], ROOT + '/' + cam + '/' + cam + '.mp4', 'video/mp4'));
        const calib = mkFile([toml], ROOT + '/calibration.toml', 'text/plain');

        // Hold each camera's read until the previous camera in `order` has
        // finished opening. `open()` runs synchronously from the moment its
        // read resolves to its end, so releasing the next one on a timeout
        // (after this one's continuation drains) fixes the resolution order.
        function installOpenOrder(order) {
            const real = window.SleapIO;
            const shim = Object.assign({}, real);
            const turns = new Map();
            let prev = Promise.resolve();
            for (const cam of order) {
                let release;
                const mine = new Promise(res => { release = res; });
                turns.set(cam, { after: prev, release });
                prev = mine;
            }
            shim.readSlpStreaming = async function (file, opts) {
                const labels = await real.readSlpStreaming(file, opts);
                const turn = turns.get(file.name.replace(/_v1\.slp$/, ''));
                await turn.after;
                setTimeout(turn.release, 0);
                return labels;
            };
            window.SleapIO = shim;
            return () => { window.SleapIO = real; };
        }

        function resetApp() {
            AS.state.sessions = []; AS.state.activeSessionIdx = 0;
            AS.state.videoFiles = []; AS.state.session = null; AS.state.views = [];
        }

        function inspect(s, lazy) {
            const out = { tracks: s.tracks.slice(), instances: 0, trackless: 0, bad: [], rows: 0, rowsOut: 0 };
            for (const [f, fg] of s.frameGroups) {
                for (const cam of CAMS) {
                    const list = (fg.instances.get(cam) || []).slice();
                    for (const u of (fg.getUnlinkedInstances(cam) || [])) if (u && u.instance) list.push(u.instance);
                    for (const inst of list) {
                        out.instances++;
                        const x = inst.getX(0);
                        if (x > 900) {
                            out.trackless++;
                            // Eager hydration says `null`, lazy hydration passes the
                            // store's `-1` through — both mean no track.
                            if (inst.trackIdx != null && inst.trackIdx >= 0) {
                                out.bad.push(cam + '@' + f + ': trackless got ' + inst.trackIdx);
                            }
                            continue;
                        }
                        const want = OWN[cam][Math.round((x - 1.5) / 10)];
                        const t = inst.trackIdx;
                        const ok = t != null && t >= 0 && t < s.tracks.length && s.tracks[t] === want;
                        if (!ok) out.bad.push(cam + '@' + f + ': want ' + want + ', trackIdx ' + t + ' -> ' + s.tracks[t]);
                    }
                }
            }
            if (lazy) {
                const L = s.lazyLoader;
                out.opened = Array.from(L.labelsByCam.keys());   // insertion = resolution order
                L.forEachInstanceRow((cam, f, trk) => {
                    out.rows++;
                    if (trk >= s.tracks.length) out.rowsOut++;
                });
                // Occupancy keys -> names must be exactly the camera's own names.
                out.occOk = CAMS.every(cam => {
                    const occ = s.trackOccupancy && s.trackOccupancy.get(cam);
                    if (!occ || !occ.segments) return false;
                    const names = Array.from(occ.segments.keys()).map(k => s.tracks[k]).sort();
                    return JSON.stringify(names) === JSON.stringify(OWN[cam].slice().sort());
                });
                // Each camera's store list is the session list (what the writer reads).
                out.storeListsOk = CAMS.every(cam => JSON.stringify(
                    L.labelsByCam.get(cam).tracks.map(t => t.name)) === JSON.stringify(s.tracks));
            }
            return out;
        }

        async function load(kind, order) {
            resetApp();
            const restore = order ? installOpenOrder(order) : () => {};
            try {
                await loader.handleLoadSessionFolderPerCamera(
                    [calib, ...videos, ...CAMS.map(c => slpFiles[kind][c])], true);
            } finally {
                restore();
            }
            const s = AS.state.session;
            if (kind === 'lazy') for (let f = 0; f < NF; f++) await tri.ensureLazyFrameData(f);
            return inspect(s, kind === 'lazy');
        }

        const ORDERS = [
            ['camA', 'camB', 'camC'], ['camA', 'camC', 'camB'], ['camB', 'camA', 'camC'],
            ['camB', 'camC', 'camA'], ['camC', 'camA', 'camB'], ['camC', 'camB', 'camA'],
        ];
        const lazy = [];
        for (const order of ORDERS) lazy.push(Object.assign({ order }, await load('lazy', order)));

        // Streaming save of the last lazy session: one track list in the header.
        const s = AS.state.session;
        const ctx = ssw.createProjectWriterContext();
        const graph = await ssw.buildSessionRefGraph(s, AS.state.views, AS.state.videoFiles, ctx);
        const save = {
            headerTracks: ctx.allTracks.map(t => t.name),
            trackBases: graph.cam.map(c => c.trackBase),
        };

        const eager = await load('eager', null);
        eager.wasLazy = !!AS.state.session.lazyLoader;

        return { EXPECTED, OWN, lazy, save, eager };
    });

    const { EXPECTED, OWN, lazy, save, eager } = r;
    const exp = JSON.stringify(EXPECTED);
    console.log('  expected session.tracks:', EXPECTED.join(', '));

    // Precondition: the orders really did resolve as requested, and the first
    // camera differed — the old "first to open wins" would have given lists of
    // 3, 7 and 4 tracks across these runs.
    check(lazy.every(x => JSON.stringify(x.opened) === JSON.stringify(x.order)),
        'each lazy load opened its cameras in the requested order (' +
        lazy.map(x => x.opened.join('>')).join(', ') + ')');
    check(new Set(lazy.map(x => OWN[x.order[0]].length)).size === 3,
        'three different cameras were first to open, with 3, 7 and 4 tracks of their own');

    for (const x of lazy) {
        const label = 'lazy, opened ' + x.order.join('>');
        check(JSON.stringify(x.tracks) === exp,
            `${label}: session.tracks is the union in camera-name order (got ${x.tracks.length}: ${x.tracks.join(',')})`);
        check(x.bad.length === 0 && x.instances === 3 * 8 * 2 + 1,
            `${label}: all ${x.instances} instances in range and named as in their own file` +
            (x.bad.length ? ` — ${x.bad.length} wrong, e.g. ${x.bad.slice(0, 3).join('; ')}` : ''));
        check(x.trackless === 1, `${label}: the trackless prediction stayed trackless`);
        check(x.rows === 3 * 8 * 2 + 1 && x.rowsOut === 0,
            `${label}: every store row (${x.rows}) holds a session index (out of range: ${x.rowsOut})`);
        check(x.occOk, `${label}: each camera's timeline occupancy names exactly its own tracks`);
        check(x.storeListsOk, `${label}: every camera's labels.tracks is the session list`);
    }

    check(JSON.stringify(save.headerTracks) === exp && save.trackBases.every(b => b === 0),
        `streaming save writes the session's ${EXPECTED.length} tracks ONCE, every camera at base 0 ` +
        `(got ${save.headerTracks.length} tracks, bases ${JSON.stringify(save.trackBases)})`);

    check(!eager.wasLazy, 'the unpadded folder took the eager path');
    check(JSON.stringify(eager.tracks) === exp,
        `eager: the same session.tracks as every lazy load (got ${eager.tracks.join(',')})`);
    check(eager.bad.length === 0 && eager.instances === 3 * 8 * 2 + 1 && eager.trackless === 1,
        `eager: all ${eager.instances} instances in range and named as in their own file` +
        (eager.bad.length ? ` — e.g. ${eager.bad.slice(0, 3).join('; ')}` : ''));

    check(errs.length === 0, `no page/console errors (got ${JSON.stringify(errs.slice(0, 3))})`);

    await browser.close();
} finally {
    server.kill('SIGTERM');
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
