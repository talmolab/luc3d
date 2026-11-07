/**
 * test-sio-pooled-instances.js — `makePooledSioInstances` (import-export/
 * file-io.js), the instances the eager project Save builds, hold EXACTLY what
 * `new SIO.Instance({ points: _buildSioPoints(...) })` held, and save to the
 * same bytes.
 *
 * The pooled instances keep their keypoints in shared column chunks instead of
 * four typed arrays each (0.93 KB of V8 heap per 2D instance before, ~50 B
 * after). Every value the writer reads — `_xy`, `_visible`, `_complete`,
 * `_score`, `score`, `track` — and every field default it may read must still
 * be what the old construction gave, or the file changes. The reference here is
 * the old construction itself, built from the same LUCID instances.
 *
 * "Same bytes" leaves out the clock: HDF5 stamps each object header with the
 * second it was written, so two saves in different seconds differ there even
 * when the content is identical (`withoutHeaderTimes`).
 */
(function () {
    const { describe, it, assertEqual, assertTrue } = TestFramework;

    function sioSkeleton(n) {
        var SIO = window.SleapIO;
        var nodes = [];
        for (var i = 0; i < n; i++) nodes.push(new SIO.Node('n' + i));
        return new SIO.Skeleton({ nodes: nodes, name: 'sk' });
    }

    // The construction buildSlpLabelsAllViews used before the pooled factory.
    function reference(SIO, skeleton, numNodes, inst, track) {
        var perPointScore = inst.type === 'user' ? undefined : (inst.score != null ? inst.score : 1.0);
        var pts = _buildSioPoints(inst, numNodes, perPointScore);
        if (inst.type === 'user') return new SIO.Instance({ points: pts, skeleton: skeleton, track: track });
        return new SIO.PredictedInstance({ points: pts, skeleton: skeleton, track: track, score: inst.score || 0 });
    }

    // Every LUCID-side case the per-node rule distinguishes.
    function lucidCases() {
        var out = [];
        var a = new Instance([[1.5, 2.25], [3, 4], [5, 6], [7, 8]], 0, 'predicted', 0.6);
        a.setPointScores([0.91, NaN, 0.07, 0.5]);
        out.push(a);                                                  // own scores, one NaN
        var b = new Instance([[1, 2], [NaN, NaN], [5, 6], [9, 10]], 1, 'predicted', null);
        out.push(b);                                                  // missing node, score null -> 1.0
        var c = new Instance([[11, 12], [13, 14], [15, 16], [17, 18]], -1, 'predicted', 0);
        c.nulledNodes = new Set([1]);
        c.toggleOccluded(2);
        out.push(c);                                                  // nulled + occluded, score 0
        var d = new Instance([[21, 22], [23, 24], [25, 26], [27, 28]], 0, 'user', 1);
        d.setPointScores([0.5, 0.5, 0.5, 0.5]);                       // left over from before an edit
        d.toggleOccluded(0);
        out.push(d);                                                  // user
        var e = new Instance([[31, 32], [33, 34]], null, 'predicted', 0.25);
        out.push(e);                                                  // fewer nodes than the skeleton
        return out;
    }

    function sameColumn(a, b) {
        if (a === null || b === null) return a === b;
        if (a.length !== b.length) return false;
        for (var i = 0; i < a.length; i++) if (!Object.is(a[i], b[i])) return false;
        return true;
    }

    // A copy of an HDF5 file with the clock taken out. Every v2 object header
    // ("OHDR", version 2) written with flag 0x20 holds four 4-byte times
    // (access, modification, change, birth: the save's Unix second), and the
    // checksum that ends the header covers them. Zero both. The header's own
    // bytes are still compared, so clearing its checksum hides nothing.
    // `cleared` counts the headers; none means the format changed under us.
    function withoutHeaderTimes(bytes) {
        var b = bytes.slice();
        var dv = new DataView(b.buffer, b.byteOffset, b.length);
        var cleared = 0;
        for (var p = 0; p + 6 <= b.length; p++) {
            if (b[p] !== 0x4f || b[p + 1] !== 0x48 || b[p + 2] !== 0x44 || b[p + 3] !== 0x52 || b[p + 4] !== 2) continue;
            var flags = b[p + 5];
            if (!(flags & 0x20)) continue;
            var q = p + 6;
            b.fill(0, q, q + 16);                                     // the four times
            q += 16 + (flags & 0x10 ? 4 : 0);                         // attribute phase-change values
            var w = 1 << (flags & 3);                                 // width of the chunk-0 size field
            var size = w === 1 ? b[q] : w === 2 ? dv.getUint16(q, true)
                : w === 4 ? dv.getUint32(q, true) : Number(dv.getBigUint64(q, true));
            q += w + size;
            b.fill(0, q, q + 4);                                      // the checksum
            cleared++;
        }
        return { bytes: b, cleared: cleared };
    }

    describe('SLP export: pooled sleap-io instances', function () {
        it('hold the same columns, score and track as the old construction', function () {
            var SIO = window.SleapIO;
            var N = 4;
            var sk = sioSkeleton(N);
            var tracks = [new SIO.Track('t0'), new SIO.Track('t1')];
            var make = makePooledSioInstances(SIO, sk, N);
            lucidCases().forEach(function (inst, i) {
                var track = inst.trackIdx >= 0 ? tracks[inst.trackIdx] || null : null;
                var got = make(inst, track);
                var want = reference(SIO, sk, N, inst, track);
                var label = 'case ' + i + ' (' + inst.type + ')';
                assertEqual(got instanceof SIO.PredictedInstance, want instanceof SIO.PredictedInstance, label + ': class');
                assertTrue(got instanceof SIO.Instance, label + ': is an Instance');
                assertTrue(sameColumn(got._xy, want._xy), label + ': _xy');
                assertTrue(sameColumn(got._visible, want._visible), label + ': _visible');
                assertTrue(sameColumn(got._complete, want._complete), label + ': _complete');
                assertTrue(sameColumn(got._score, want._score), label + ': _score');
                assertEqual(got._n, want._n, label + ': _n');
                assertEqual(got.score, want.score, label + ': score');
                assertTrue(got.track === want.track, label + ': track');
                assertTrue(got.skeleton === want.skeleton, label + ': skeleton');
                // Every other field the writer may read keeps its default.
                ['fromPredicted', 'trackingScore', 'identity', 'identityScore', 'identityEmbedding',
                    'category', 'categoryScore', 'categoryEmbedding'].forEach(function (k) {
                    assertTrue(Object.is(got[k], want[k]), label + ': ' + k);
                });
                assertEqual(JSON.stringify(got.numpy({ invisibleAsNaN: false })),
                    JSON.stringify(want.numpy({ invisibleAsNaN: false })), label + ': numpy()');
            });
        });

        it('share chunks without sharing slices, and stay writable through points', function () {
            var SIO = window.SleapIO;
            var sk = sioSkeleton(2);
            var make = makePooledSioInstances(SIO, sk, 2);
            var p = make(new Instance([[1, 2], [3, 4]], 0, 'predicted', 0.5), null);
            var q = make(new Instance([[5, 6], [7, 8]], 0, 'predicted', 0.5), null);
            assertTrue(p._c === q._c, 'one chunk');
            assertTrue(p._xy.buffer === q._xy.buffer, 'one ArrayBuffer');
            p.points[0].xy = [100, 200];
            assertEqual(p._xy[0], 100, 'a PointView writes the pooled slice');
            assertEqual(q._xy[0], 5, '... and only its own');
            p.points = [{ xy: [9, 9], visible: true, complete: true, score: 0.1 }, { xy: [8, 8], visible: false, complete: true, score: 0.2 }];
            assertEqual(p._xy[1], 9, 'the points setter gives the instance its own columns');
            assertEqual(q._xy[0], 5, '... leaving the chunk alone');
            assertTrue(p._xy.buffer !== q._xy.buffer, 'own buffer after assignment');
        });

        it('a chunk boundary does not move or overlap any instance', function () {
            var SIO = window.SleapIO;
            var N = 7;   // 65536 is not a multiple of 7: the last slot of a chunk is left over
            var sk = sioSkeleton(N);
            var make = makePooledSioInstances(SIO, sk, N);
            var made = [];
            for (var i = 0; i < 10000; i++) {
                var row = [];
                for (var k = 0; k < N; k++) row.push([i, k]);
                made.push(make(new Instance(row, 0, 'predicted', 0.5), null));
            }
            assertTrue(made[0]._c !== made[9999]._c, 'more than one chunk was used');
            var ok = true;
            for (var j = 0; j < made.length && ok; j++) {
                var xy = made[j]._xy;
                for (var m = 0; m < N; m++) if (xy[2 * m] !== j || xy[2 * m + 1] !== m) { ok = false; break; }
            }
            assertTrue(ok, 'every instance reads back its own points');
        });

        it('save to the same bytes as the old construction', async function () {
            var SIO = window.SleapIO;
            var N = 4;
            var sk = sioSkeleton(N);
            var tracks = [new SIO.Track('t0'), new SIO.Track('t1')];
            var video = new SIO.Video({ filename: 'cam.mp4', openBackend: false });
            var provenance = { source: 'lucid', exported_at: 'fixed' };
            function labelsWith(build) {
                var frames = [];
                for (var f = 0; f < 3; f++) {
                    var insts = lucidCases().map(function (inst) {
                        var track = inst.trackIdx >= 0 ? tracks[inst.trackIdx] || null : null;
                        return build(inst, track);
                    });
                    frames.push(new SIO.LabeledFrame({ video: video, frameIdx: f, instances: insts }));
                }
                return new SIO.Labels({
                    labeledFrames: frames, videos: [video], skeletons: [sk], tracks: tracks,
                    provenance: provenance,
                });
            }
            var make = makePooledSioInstances(SIO, sk, N);
            var pooled = await SIO.saveSlpToBytes(labelsWith(make));
            var old = await SIO.saveSlpToBytes(labelsWith(function (inst, track) {
                return reference(SIO, sk, N, inst, track);
            }));
            assertEqual(pooled.length, old.length, 'same length');
            var a = withoutHeaderTimes(pooled), b = withoutHeaderTimes(old);
            assertTrue(a.cleared > 0, 'found the HDF5 object headers');
            assertEqual(a.cleared, b.cleared, 'same number of object headers');
            var same = pooled.length === old.length;
            for (var i = 0; same && i < pooled.length; i++) if (a.bytes[i] !== b.bytes[i]) same = false;
            assertTrue(same, 'byte-identical files apart from the save time');
        });
    });
})();
