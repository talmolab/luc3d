/**
 * test-lazy-export-instance-filter.js — regression test for
 * `import-export/file-io.js`'s `exportSlpClientSide`/`exportSlpMultiSession`
 * lazy fast-path gating.
 *
 * Reported bug: "Export SLEAP File Per Session" and "Export SLEAP File By
 * Cam" (the ONLY export paths tried — NOT Save/Save As, which routes through
 * the already lazy-aware `slp-streaming-write.js`) produced a file where,
 * after Track All + Propagate IDs → Tracks, only the first frame (whatever
 * was resident in `session.frameGroups` at export time) carried track
 * labels — every other frame was silently missing entirely.
 *
 * Root cause: `lazyCameraExportBytes` (file-io.js) is a lazy fast-path that
 * re-emits a camera's WHOLE columnar store verbatim (all frames, bounded
 * memory) instead of the eager `buildSlpLabels`/`buildSlpLabelsMultiSession`,
 * which iterates only `session.frameGroups` — the small resident window on a
 * lazy session. But the fast path was gated on a plain `!instanceFilter`
 * check, and EVERY export-modal call site (`ui/export-modals.js`)
 * unconditionally constructs a non-null `instanceFilter` object (`{ user:
 * true, predicted: includePred, reprojected: saveReproj }`) to carry the
 * Include-Predicted/Include-Reprojections checkbox state — even at default
 * settings. So the fast path NEVER ran for either export modal; every export
 * silently fell through to the eager, frameGroups-only builder.
 *
 * This test drives the REAL `exportSlpClientSide`/`exportSlpMultiSession`
 * with the EXACT instanceFilter shape the export modals actually pass
 * (`{ user: true, predicted: true, reprojected: false }` — default
 * checkboxes), against a real multi-frame lazy per-camera fixture with only
 * ONE frame materialized in `session.frameGroups` (simulating "just ran
 * Track All + Propagate, never scrubbed through the video"), and asserts
 * every frame — not just the resident one — survives into the export.
 */
(function () {
    const { describe, it, assertEqual, assertTrue, assertDeepEqual } = TestFramework;

    const h5wasmUrl = new URL('../lib/h5wasm/h5wasm.iife.js', document.baseURI).href;

    async function storeBytes(S, fn, n) {
        const sk = new S.Skeleton({ nodes: [new S.Node('nose'), new S.Node('tail')], edges: [new S.Edge(new S.Node('nose'), new S.Node('tail'))], name: 'sk' });
        const tr = [new S.Track('t0'), new S.Track('t1')];
        const v = new S.Video({ filename: fn, backendMetadata: { type: 'MediaVideo', shape: [n, 64, 48, 1], filename: fn }, openBackend: false });
        v.shape = [n, 64, 48, 1];
        const lfs = [];
        for (let f = 0; f < n; f++) {
            const insts = [];
            for (let k = 0; k < 2; k++) {
                insts.push(new S.PredictedInstance({
                    points: [
                        { xy: [f * 10 + k, f * 10 + k + 1], visible: true, complete: true, score: 1 },
                        { xy: [f * 10 + k + 2, f * 10 + k + 3], visible: true, complete: true, score: 1 },
                    ],
                    skeleton: sk, track: tr[k], score: 0.9,
                }));
            }
            lfs.push(new S.LabeledFrame({ video: v, frameIdx: f, instances: insts }));
        }
        return await S.saveSlpToBytes(new S.Labels({ labeledFrames: lfs, videos: [v], skeletons: [sk], tracks: tr, provenance: {} }));
    }
    async function openLazy(S, bytes, fn) {
        return await S.readSlpStreaming(new File([bytes], fn), { lazy: true, openVideos: false, h5wasmUrl });
    }

    describe('file-io.js lazy export fast-path gating (Per-Session / By-Cam export)', function () {
        it('exportSlpClientSide: default instanceFilter still uses the lazy fast-path — every frame survives, not just the resident one', async function () {
            const S = window.SleapIO;
            const { exportSlpClientSide } = await import('../import-export/file-io.js');

            const N = 6;
            const lab = await openLazy(S, await storeBytes(S, 'cam0.mp4', N), 'e1.slp');
            const loader = new window.SioLazyLoader();
            loader.labelsByCam.set('cam0', lab);
            const rm = new Map();
            const fc = lab._lazyDataStore.framesData.frame_idx;
            for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
            loader.frameRowByCam.set('cam0', rm);
            loader.nFrames = N;

            const { Camera, Skeleton, Session, FrameGroup, Instance } = window;
            const sk = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
            const c0 = new Camera('cam0', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const session = new Session([c0], sk, ['t0', 't1'], 'ExpS');
            session.lazyLoader = loader;

            // Simulate the real report exactly: propagate identities across the
            // WHOLE project via frameIdentityMap/columnar remap (as
            // propagateIdentitiesToTracks does), but only frame 0 is resident in
            // session.frameGroups (as if the user never scrubbed past it — the
            // eager builder's failure mode).
            const idA = session.addIdentity('Alice');
            const idB = session.addIdentity('Bob');
            for (let f = 0; f < N; f++) {
                session.setFrameIdentity(f, 'cam0', 0, idA.id);
                session.setFrameIdentity(f, 'cam0', 1, idB.id);
            }
            const fg0 = new FrameGroup(0);
            fg0.addInstance('cam0', new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.9));
            fg0.addInstance('cam0', new Instance([[5, 6], [7, 8]], 1, 'predicted', 0.9));
            session.addFrameGroup(fg0);
            assertEqual(session.frameGroups.size, 1, 'precondition: only frame 0 is resident, matching the real report');

            const res = session.propagateIdentitiesToTracks();
            assertEqual(res.tracks, 2, 'two tracks from the two identities');
            assertEqual(res.lazyErrorRows || 0, 0, 'no row-remap errors');

            // The EXACT instanceFilter shape ui/export-modals.js always passes,
            // at DEFAULT checkbox settings (predicted included, reprojections not).
            const instanceFilter = { user: true, predicted: true, reprojected: false };
            const blob = await exportSlpClientSide(session, 'cam0', false, null, 'out.slp', instanceFilter);
            assertTrue(blob.size > 0, 'export produced a non-empty file');

            const bytes = new Uint8Array(await blob.arrayBuffer());
            const rb = await S.readSlpStreaming(new File([bytes], 'e1-rb.slp'), { lazy: true, openVideos: false, h5wasmUrl });

            assertEqual(rb._lazyDataStore.framesData.frame_idx.length, N,
                'ALL ' + N + ' frames survived the export — not just the one resident frame (the exact regression)');
            assertDeepEqual(rb.tracks.map(function (t) { return t.name; }).sort(), ['Alice', 'Bob'],
                'propagated identity-derived track names carried through');

            const store = rb._lazyDataStore;
            const fd = store.framesData;
            const idn = store.instancesData;
            let checkedFrames = 0;
            for (let r = 0; r < fd.frame_idx.length; r++) {
                const frameIdx = Number(fd.frame_idx[r]);
                const iStart = Number(fd.instance_id_start[r]);
                const iEnd = Number(fd.instance_id_end[r]);
                assertEqual(iEnd - iStart, 2, 'frame ' + frameIdx + ' has both instances');
                const names = [];
                for (let j = iStart; j < iEnd; j++) {
                    const trk = Number(idn.track[j]);
                    assertTrue(trk >= 0 && trk < rb.tracks.length, 'frame ' + frameIdx + ' instance ' + j + ' has a valid track — not trackless/missing');
                    names.push(rb.tracks[trk].name);
                }
                assertDeepEqual(names.sort(), ['Alice', 'Bob'], 'frame ' + frameIdx + ' has both propagated identity tracks');
                checkedFrames++;
            }
            assertEqual(checkedFrames, N, 'checked every frame, not just the first');
        });

        it('exportSlpMultiSession: default instanceFilter (single-session "By Cam" case) also uses the lazy fast-path', async function () {
            const S = window.SleapIO;
            const { exportSlpMultiSession } = await import('../import-export/file-io.js');

            const N = 4;
            const lab = await openLazy(S, await storeBytes(S, 'camX.mp4', N), 'e2.slp');
            const loader = new window.SioLazyLoader();
            loader.labelsByCam.set('camX', lab);
            const rm = new Map();
            const fc = lab._lazyDataStore.framesData.frame_idx;
            for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
            loader.frameRowByCam.set('camX', rm);
            loader.nFrames = N;

            const { Camera, Skeleton, Session } = window;
            const sk = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
            const cX = new Camera('camX', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const session = new Session([cX], sk, ['t0', 't1'], 'ExpS2');
            session.lazyLoader = loader;
            // frameGroups intentionally left EMPTY — nothing resident at all.
            assertEqual(session.frameGroups.size, 0, 'precondition: nothing resident whatsoever');

            const idA = session.addIdentity('Alice');
            for (let f = 0; f < N; f++) session.setFrameIdentity(f, 'camX', 0, idA.id);
            const res = session.propagateIdentitiesToTracks();
            assertEqual(res.tracks, 1, 'one track from the one used identity');

            const instanceFilter = { user: true, predicted: true, reprojected: false };
            const selections = [{ session: session, cameraName: 'camX', videoFileInfo: null }];
            const blob = await exportSlpMultiSession(selections, false, instanceFilter);

            const bytes = new Uint8Array(await blob.arrayBuffer());
            const rb = await S.readSlpStreaming(new File([bytes], 'e2-rb.slp'), { lazy: true, openVideos: false, h5wasmUrl });
            assertEqual(rb._lazyDataStore.framesData.frame_idx.length, N,
                'ALL ' + N + ' frames survived a "By Cam"-style export with zero resident frameGroups');
        });

        it('a manual user correction on a resident frame is NEVER silently discarded — falls back to the eager (correction-aware) path', async function () {
            // The lazy fast-path re-emits the RAW columnar store verbatim — it
            // has no notion of a live-edited Instance sitting in a resident
            // FrameGroup. If it fired anyway, a manual 2D correction would be
            // silently replaced by the ORIGINAL uncorrected prediction in the
            // export — worse than the bug this fast path exists to fix. This
            // proves lazyCameraExportBytes's frameGroupHasUserInstances guard
            // actually blocks the fast path in that case, so the export goes
            // through the eager (correction-aware) builder instead.
            const S = window.SleapIO;
            const { exportSlpClientSide } = await import('../import-export/file-io.js');

            const N = 3;
            const lab = await openLazy(S, await storeBytes(S, 'camC.mp4', N), 'e3.slp');
            const loader = new window.SioLazyLoader();
            loader.labelsByCam.set('camC', lab);
            const rm = new Map();
            const fc = lab._lazyDataStore.framesData.frame_idx;
            for (let r = 0; r < fc.length; r++) rm.set(Number(fc[r]), r);
            loader.frameRowByCam.set('camC', rm);
            loader.nFrames = N;

            const { Camera, Skeleton, Session, FrameGroup, Instance } = window;
            const sk = new Skeleton('sk', ['nose', 'tail'], [[0, 1]]);
            const cC = new Camera('camC', [[600, 0, 320], [0, 600, 240], [0, 0, 1]], [0, 0, 0, 0, 0], [0, 0, 0], [0, 0, 0], [640, 480]);
            const session = new Session([cC], sk, ['t0', 't1'], 'ExpS3');
            session.lazyLoader = loader;

            // Frame 1's track-0 instance was manually corrected by the user to
            // a distinctive, easy-to-spot point far from the raw prediction
            // fixture's own values (which follow the f*10+k pattern — never
            // near [999, 999]).
            const fg1 = new FrameGroup(1);
            const corrected = new Instance([[999, 999], [999, 999]], 0, 'user', 1.0);
            corrected.modified = true;
            fg1.addInstance('camC', corrected);
            session.addFrameGroup(fg1);

            const instanceFilter = { user: true, predicted: true, reprojected: false };
            const blob = await exportSlpClientSide(session, 'camC', false, null, 'out3.slp', instanceFilter);
            const bytes = new Uint8Array(await blob.arrayBuffer());
            const rb = await S.readSlpStreaming(new File([bytes], 'e3-rb.slp'), { lazy: true, openVideos: false, h5wasmUrl });

            // The eager path is frameGroups-only, so it's expected to carry
            // only frame 1 here (not a regression under test — the whole
            // point is that it must NOT silently drop the correction by
            // taking the verbatim fast path instead).
            const store = rb._lazyDataStore;
            const fd = store.framesData;
            const pts = store.pointsData;
            let foundCorrected = false;
            for (let r = 0; r < fd.frame_idx.length; r++) {
                if (Number(fd.frame_idx[r]) !== 1) continue;
                const idn = store.instancesData;
                const iStart = Number(fd.instance_id_start[r]);
                const iEnd = Number(fd.instance_id_end[r]);
                for (let j = iStart; j < iEnd; j++) {
                    if (Number(idn.instance_type[j]) !== 0) continue; // 0 = user instance
                    const pStart = Number(idn.point_id_start[j]);
                    if (Number(pts.x[pStart]) === 999 && Number(pts.y[pStart]) === 999) foundCorrected = true;
                }
            }
            assertTrue(foundCorrected, 'the manual correction ([999,999]) survived the export — NOT silently ' +
                'replaced by the original uncorrected prediction');
        });
    });
})();
