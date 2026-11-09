/**
 * test-export-identity-tracks.js — the per-camera SLEAP exports write identities
 * as the file's tracks (`_exportTrackSource`, import-export/file-io.js).
 *
 * The bug: an identity switch changes `frameIdentityMap` and group identities,
 * neither of which an export wrote, and each camera's raw `track_N` is unrelated
 * to any other camera's. Unless someone had run Propagate IDs → Tracks first, the
 * file held no trace of the proofreading.
 */
(function () {
    const { describe, it, assertEqual, assertTrue, assertDeepEqual } = TestFramework;

    const h5wasmUrl = new URL('../lib/h5wasm/h5wasm.iife.js?v=22aa05e92cd0', document.baseURI).href;
    const FILTER = { user: true, predicted: true, reprojected: false };
    const CAMS = ['camA', 'camB'];
    const N = 4;

    const poseData = import('../pose/pose-data.js?v=22aa05e92cd0').then((m) => { window.__poseData = m; });

    function camera(name) {
        return new window.Camera(name, [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
    }

    // Two animals, tracked over N frames. The raw track numbers run the opposite
    // way in camB (the same animal is track 0 in camA and track 1 in camB), and an
    // instance's x says which animal it is: 100 is the first, 200 the second.
    function buildSession(identified) {
        const { Skeleton, Session, FrameGroup, Instance } = window;
        const InstanceGroup = window.__poseData.InstanceGroup;
        const session = new Session(CAMS.map(camera), new Skeleton('sk', ['nose', 'tail'], [[0, 1]]),
            ['track_0', 'track_1'], 'S');
        const ids = identified ? [session.addIdentity('id_0'), session.addIdentity('id_1')] : [];
        for (let f = 0; f < N; f++) {
            const fg = new FrameGroup(f);
            const groups = [];
            for (let animal = 0; animal < 2; animal++) {
                const group = identified ? new InstanceGroup(f * 10 + animal, ids[animal].id) : null;
                CAMS.forEach(function (cam, c) {
                    const trk = c === 0 ? animal : 1 - animal;
                    const x = (animal + 1) * 100;
                    const inst = new Instance([[x, f], [x, f + 1]], trk, 'predicted', 0.9);
                    fg.addInstance(cam, inst);
                    if (group) {
                        group.addInstance(cam, inst);
                        session.setFrameIdentity(f, cam, trk, ids[animal].id);
                    }
                });
                if (group) groups.push(group);
            }
            session.addFrameGroup(fg);
            if (identified) session.instanceGroups.set(f, groups);
        }
        return session;
    }

    // { frameIdx: { x of the instance: track name } }
    function tracksByAnimal(labels) {
        const out = {};
        for (const lf of labels.labeledFrames) {
            out[lf.frameIdx] = {};
            for (const inst of lf.instances) {
                out[lf.frameIdx][inst.points[0].xy[0]] = inst.track ? inst.track.name : null;
            }
        }
        return out;
    }

    describe('SLP export: identities are written as tracks', function () {
        it('a track is the same animal in every camera, though the raw tracks disagree', async function () {
            await poseData;
            const fio = await import('../import-export/file-io.js?v=22aa05e92cd0');
            const session = buildSession(true);
            for (const cam of CAMS) {
                const labels = fio.buildSlpLabels(session, cam, null, null, FILTER);
                assertDeepEqual(labels.tracks.map((t) => t.name), ['track_0', 'track_1'], cam + ' tracks');
                const got = tracksByAnimal(labels);
                for (let f = 0; f < N; f++) {
                    assertEqual(got[f][100], 'track_0', cam + ' frame ' + f + ' first animal');
                    assertEqual(got[f][200], 'track_1', cam + ' frame ' + f + ' second animal');
                }
            }
        });

        it('a proofreading swap reaches the file, from the frame it was made on', async function () {
            await poseData;
            const fio = await import('../import-export/file-io.js?v=22aa05e92cd0');
            const session = buildSession(true);
            const [a, b] = session.identities;
            session.swapIdentitiesForward(2, a.id, b.id);
            for (const cam of CAMS) {
                const got = tracksByAnimal(fio.buildSlpLabels(session, cam, null, null, FILTER));
                assertEqual(got[1][100], 'track_0', cam + ' before the swap');
                assertEqual(got[2][100], 'track_1', cam + ' on the swap frame');
                assertEqual(got[3][200], 'track_0', cam + ' after the swap');
            }
        });

        it('matches what Propagate IDs → Tracks then export writes', async function () {
            await poseData;
            const fio = await import('../import-export/file-io.js?v=22aa05e92cd0');
            const direct = buildSession(true);
            const [a, b] = direct.identities;
            direct.swapIdentitiesForward(2, a.id, b.id);
            const propagated = buildSession(true);
            const [c, d] = propagated.identities;
            propagated.swapIdentitiesForward(2, c.id, d.id);
            propagated.propagateIdentitiesToTracks();
            for (const cam of CAMS) {
                const x = fio.buildSlpLabels(direct, cam, null, null, FILTER);
                const y = fio.buildSlpLabels(propagated, cam, null, null, FILTER);
                assertDeepEqual(x.tracks.map((t) => t.name), y.tracks.map((t) => t.name), cam + ' track list');
                assertDeepEqual(tracksByAnimal(x), tracksByAnimal(y), cam + ' every instance');
            }
        });

        it('exporting does not change the project', async function () {
            await poseData;
            const fio = await import('../import-export/file-io.js?v=22aa05e92cd0');
            const session = buildSession(true);
            const before = JSON.stringify([session.tracks, [...session.frameIdentityEntries()].map((r) => [r.key, r.identityId])]);
            const trackIdx = session.frameGroups.get(0).instances.get('camB').map((i) => i.trackIdx);
            fio.buildSlpLabels(session, 'camB', null, null, FILTER);
            assertEqual(JSON.stringify([session.tracks, [...session.frameIdentityEntries()].map((r) => [r.key, r.identityId])]), before, 'tracks and identity map');
            assertDeepEqual(session.frameGroups.get(0).instances.get('camB').map((i) => i.trackIdx), trackIdx, 'instance tracks');
        });

        it('with no identities, instances keep their own tracks', async function () {
            await poseData;
            const fio = await import('../import-export/file-io.js?v=22aa05e92cd0');
            const session = buildSession(false);
            const got = tracksByAnimal(fio.buildSlpLabels(session, 'camB', null, null, FILTER));
            assertEqual(got[0][100], 'track_1', 'camB raw track');
            assertEqual(got[0][200], 'track_0', 'camB raw track');
        });

        it('an instance with no identity is trackless, and a group fills a key the map marks ambiguous', async function () {
            await poseData;
            const fio = await import('../import-export/file-io.js?v=22aa05e92cd0');
            const session = buildSession(true);
            const unnamed = new window.Instance([[300, 0], [300, 1]], 0, 'predicted', 0.9);
            session.frameGroups.get(0).addUnlinkedInstance('camA', new (await import('../pose/pose-data.js?v=22aa05e92cd0')).UnlinkedInstance(unnamed, 'camA'));
            session.setFrameIdentity(1, 'camA', 0, -1);   // commitTrackedFrame's collision sentinel
            const got = tracksByAnimal(fio.buildSlpLabels(session, 'camA', null, null, FILTER));
            assertEqual(got[0][300], null, 'no identity: no track, not the raw track_0 another animal holds');
            assertEqual(got[1][100], 'track_0', 'the group answers when the map cannot');
        });

        it('the By Cam builder writes them too', async function () {
            await poseData;
            const fio = await import('../import-export/file-io.js?v=22aa05e92cd0');
            const session = buildSession(true);
            const [a, b] = session.identities;
            session.swapIdentitiesForward(2, a.id, b.id);
            for (const cam of CAMS) {
                const labels = fio.buildSlpLabelsMultiSession([{ session, cameraName: cam, videoFileInfo: null }], null, FILTER);
                const got = tracksByAnimal(labels);
                assertEqual(got[1][100], 'track_0', cam + ' before the swap');
                assertEqual(got[3][100], 'track_1', cam + ' after the swap');
            }
        });

        // Lazy: the store holds raw tracks and only some frames are resident.
        async function lazySession(fn) {
            await poseData;
            const S = window.SleapIO;
            const sk = new S.Skeleton({ nodes: [new S.Node('nose'), new S.Node('tail')], edges: [], name: 'sk' });
            const tr = [new S.Track('t0'), new S.Track('t1')];
            const v = new S.Video({ filename: fn, backendMetadata: { type: 'MediaVideo', shape: [N, 64, 48, 1], filename: fn }, openBackend: false });
            v.shape = [N, 64, 48, 1];
            const lfs = [];
            for (let f = 0; f < N; f++) {
                const insts = [0, 1].map((k) => new S.PredictedInstance({
                    points: [
                        { xy: [(k + 1) * 100, f], visible: true, complete: true, score: 1 },
                        { xy: [(k + 1) * 100, f + 1], visible: true, complete: true, score: 1 },
                    ],
                    skeleton: sk, track: tr[k], score: 0.9,
                }));
                lfs.push(new S.LabeledFrame({ video: v, frameIdx: f, instances: insts }));
            }
            const bytes = await S.saveSlpToBytes(new S.Labels({ labeledFrames: lfs, videos: [v], skeletons: [sk], tracks: tr, provenance: {} }));
            const lab = await S.readSlpStreaming(new File([bytes], fn), { lazy: true, openVideos: false, h5wasmUrl });
            const loader = new window.SioLazyLoader();
            loader.labelsByCam.set('camA', lab);
            const rm = new Map();
            const fc = lab._lazyDataStore.framesData.frame_idx;
            for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
            loader.frameRowByCam.set('camA', rm);
            loader.nFrames = N;
            const session = new window.Session([camera('camA')], new window.Skeleton('sk', ['nose', 'tail'], [[0, 1]]), ['t0', 't1'], 'L');
            session.lazyLoader = loader;
            const a = session.addIdentity('id_0'), b = session.addIdentity('id_1');
            for (let f = 0; f < N; f++) {
                session.setFrameIdentity(f, 'camA', 0, a.id);
                session.setFrameIdentity(f, 'camA', 1, b.id);
            }
            return { session, a, b };
        }
        // Export as the active session, as in the app, and read back { frame: [track
        // of each store row] }. This hand-built loader does not hydrate coordinates,
        // so rows are told apart by position; tests/e2e/export-identity-tracks.mjs
        // covers a real lazy reopen, coordinates included.
        async function exportLazy(session, fn) {
            const { exportSlpClientSide } = await import('../import-export/file-io.js?v=22aa05e92cd0');
            const appState = await import('../ui/app-state.js?v=22aa05e92cd0');
            const prev = appState.state.session;
            appState.state.session = session;
            let blob;
            try {
                blob = await exportSlpClientSide(session, 'camA', null, null, fn, FILTER);
            } finally {
                appState.state.session = prev;
            }
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const rb = await window.SleapIO.readSlpStreaming(new File([bytes], fn), { lazy: false, openVideos: false, h5wasmUrl });
            const out = {};
            for (const lf of rb.labeledFrames) out[lf.frameIdx] = lf.instances.map((i) => (i.track ? i.track.name : null));
            return out;
        }

        it('a lazy project writes identities on every frame, not the raw store tracks', async function () {
            const { session, a, b } = await lazySession('lazy-a.mp4');
            session.swapIdentitiesForward(2, a.id, b.id);
            const got = await exportLazy(session, 'lazy-a.slp');
            assertEqual(Object.keys(got).length, N, 'every frame');
            assertDeepEqual(got[0], ['track_0', 'track_1'], 'before the swap');
            assertDeepEqual(got[3], ['track_1', 'track_0'], 'after the swap');
        });

        it('a swap made after Propagate IDs → Tracks is not lost to the verbatim store path', async function () {
            const { session, a, b } = await lazySession('lazy-b.mp4');
            session.propagateIdentitiesToTracks();
            session.swapIdentitiesForward(2, a.id, b.id);
            const got = await exportLazy(session, 'lazy-b.slp');
            assertDeepEqual(got[1], ['track_0', 'track_1'], 'before the swap');
            assertDeepEqual(got[3], ['track_1', 'track_0'], 'after the swap');
        });
    });
})();
