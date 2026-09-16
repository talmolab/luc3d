/**
 * test-import-track-resolve.js — unit tests for resolveImportTrackIdx
 * (import-export/import-track-resolve.js), bridged to window in test-runner.html.
 *
 * Regression guard for the deleted-track bug: an instance whose track was
 * deleted becomes trackless (exported as track=-1); on reimport it must stay
 * trackless (trackIdx null) for BOTH user and predicted instances — not get
 * snapped onto the first track (e.g. global_0). Predicted instances used to be
 * coerced to track 0, which is exactly what reproduced as a phantom global_0.
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assertEqual = TestFramework.assertEqual;
    var assertNull = TestFramework.assertNull;

    // session arg is unused by the function; pass a stub.
    var S = {};

    describe('resolveImportTrackIdx — real tracks pass through', function () {
        it('track 0 stays 0 (user)', function () {
            assertEqual(resolveImportTrackIdx(S, 0, 'user'), 0);
        });
        it('track 0 stays 0 (predicted)', function () {
            assertEqual(resolveImportTrackIdx(S, 0, 'predicted'), 0);
        });
        it('track 3 stays 3 (predicted)', function () {
            assertEqual(resolveImportTrackIdx(S, 3, 'predicted'), 3);
        });
    });

    describe('resolveImportTrackIdx — trackless stays trackless', function () {
        it('user track=-1 → null', function () {
            assertNull(resolveImportTrackIdx(S, -1, 'user'));
        });
        it('predicted track=-1 → null (NOT 0 — the deleted-track bug)', function () {
            assertNull(resolveImportTrackIdx(S, -1, 'predicted'));
        });
        it('user track=null → null', function () {
            assertNull(resolveImportTrackIdx(S, null, 'user'));
        });
        it('predicted track=null → null', function () {
            assertNull(resolveImportTrackIdx(S, null, 'predicted'));
        });
        it('missing instType (undefined) trackless → null', function () {
            assertNull(resolveImportTrackIdx(S, -1, undefined));
        });
    });

    describe('remapGlobalTrackToSession — global index → per-session index by name', function () {
        // The exact multi-session bug: session 0 deletes global_0, so the saved
        // file-level (global) union reorders. Session 1 still has only
        // ["global_0"], but its instances were written at the GLOBAL index of
        // global_0 in the reordered union. Remapping by NAME must land them back
        // on session 1's own global_0 — not a phantom track.
        var GLOBAL = ['global_1', 'global_2', 'global_3', 'global_0']; // union after delete
        var SESSION2 = ['global_0'];
        var SESSION1 = ['global_1', 'global_2', 'global_3'];

        it("session 2's global_0 (global index 3) → its own index 0", function () {
            assertEqual(remapGlobalTrackToSession(3, GLOBAL, SESSION2), 0);
        });
        it('0xFFFFFFFF readback of -1 → trackless (-1)', function () {
            assertEqual(remapGlobalTrackToSession(0xFFFFFFFF, GLOBAL, SESSION2), -1);
        });
        it('trackless input stays trackless', function () {
            assertEqual(remapGlobalTrackToSession(-1, GLOBAL, SESSION2), -1);
            assertNull(remapGlobalTrackToSession(null, GLOBAL, SESSION2));
        });
        it("session 1's global_1/2/3 remap to its own 0/1/2", function () {
            assertEqual(remapGlobalTrackToSession(0, GLOBAL, SESSION1), 0); // global_1
            assertEqual(remapGlobalTrackToSession(1, GLOBAL, SESSION1), 1); // global_2
            assertEqual(remapGlobalTrackToSession(2, GLOBAL, SESSION1), 2); // global_3
        });
        it('a global track absent from this session → -1 (trackless here)', function () {
            // global_0 (global index 3) is NOT in session 1's list.
            assertEqual(remapGlobalTrackToSession(3, GLOBAL, SESSION1), -1);
        });
        it('out-of-range global index → -1', function () {
            assertEqual(remapGlobalTrackToSession(99, GLOBAL, SESSION2), -1);
        });
        it('identity when global list IS the session list (non-lucid SLP)', function () {
            var g = ['a', 'b', 'c'];
            assertEqual(remapGlobalTrackToSession(0, g, g), 0);
            assertEqual(remapGlobalTrackToSession(2, g, g), 2);
        });
    });

    describe('resolveImportTrackIdx — unsigned-int32 readback of -1', function () {
        // h5wasm may read the signed i4 track column as unsigned; 0xFFFFFFFF
        // must normalize back to -1 → trackless, not a giant "real" track.
        it('0xFFFFFFFF (predicted) → null', function () {
            assertNull(resolveImportTrackIdx(S, 0xFFFFFFFF, 'predicted'));
        });
        it('0xFFFFFFFF (user) → null', function () {
            assertNull(resolveImportTrackIdx(S, 0xFFFFFFFF, 'user'));
        });
    });
})();
