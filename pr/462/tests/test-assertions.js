/**
 * test-assertions.js — the test framework's own assertions (tests/test-framework.js).
 *
 * NaN must fail a check. JSON writes NaN, Infinity and -Infinity as null, so
 * a JSON-based assertDeepEqual once passed [NaN] against [null] and printed
 * the NaN as null; assertApprox once passed NaN against any number. These pin
 * that each non-finite number matches only itself, and that the failure
 * message shows it.
 */

(function () {
    const { describe, it, assert, assertEqual, assertDeepEqual, assertApprox,
        assertNull, assertTrue } = TestFramework;

    // The error message the assertion throws, or null if it passed.
    function failure(fn) {
        try { fn(); } catch (e) { return e.message; }
        return null;
    }

    describe('Test framework: assertDeepEqual and non-finite numbers', function () {
        it('tells NaN and the infinities apart from null and from each other', function () {
            const values = [NaN, Infinity, -Infinity, null];
            for (const a of values) {
                for (const b of values) {
                    const msg = failure(() => assertDeepEqual([a], [b]));
                    const same = Object.is(a, b);
                    assertTrue(same ? msg === null : msg !== null,
                        `[${a}] vs [${b}] should ${same ? 'pass' : 'fail'}`);
                }
            }
        });

        it('finds them nested in objects and typed arrays', function () {
            assert(failure(() => assertDeepEqual({ p: { x: NaN } }, { p: { x: null } })) !== null,
                'nested NaN vs null passed');
            assert(failure(() => assertDeepEqual(new Float64Array([1, NaN]), new Float64Array([1, 0]))) !== null,
                'typed-array NaN vs 0 passed');
            assertEqual(failure(() => assertDeepEqual(new Float32Array([1, NaN]), new Float64Array([1, NaN]))), null,
                'typed arrays with NaN in the same place');
        });

        it('shows NaN and the infinities bare in the message', function () {
            assertEqual(failure(() => assertDeepEqual([NaN, -Infinity], [null, 1], 'pts')),
                'pts: Expected [null,1] but got [NaN,-Infinity]');
        });

        it('cannot be fooled by a string that looks like the internal tag', function () {
            assert(failure(() => assertDeepEqual(['\u0000NaN'], [NaN])) !== null, 'tag-like string passed as NaN');
            assert(failure(() => assertDeepEqual(['NaN'], [NaN])) !== null, '"NaN" passed as NaN');
            assertEqual(failure(() => assertDeepEqual(['\u0000x'], ['\u0000x'])), null, 'equal \\u0000 strings');
        });

        it('keeps its JSON behaviour for everything else', function () {
            // Key order matters (tests pin serialized layouts with it).
            assert(failure(() => assertDeepEqual({ a: 1, b: 2 }, { b: 2, a: 1 })) !== null, 'key order ignored');
            // An undefined key is absent; -0 equals 0.
            assertEqual(failure(() => assertDeepEqual({ a: 1, u: undefined }, { a: 1 })), null, 'undefined key');
            assertEqual(failure(() => assertDeepEqual([-0], [0])), null, '-0 vs 0');
            assertEqual(failure(() => assertDeepEqual(new Float32Array([1, 2]), new Float64Array([1, 2]))), null,
                'typed arrays compare by value');
        });
    });

    describe('Test framework: other assertions and NaN', function () {
        it('assertEqual: NaN equals only NaN, and the message shows it', function () {
            assertEqual(failure(() => assertEqual(NaN, NaN)), null, 'NaN vs NaN');
            assertEqual(failure(() => assertEqual(NaN, 3)), 'Expected 3 but got NaN');
            assertEqual(failure(() => assertEqual(Infinity, null)), 'Expected null but got Infinity');
        });

        it('assertApprox: NaN fails unless NaN is expected', function () {
            assert(failure(() => assertApprox(NaN, 1, 1e9)) !== null, 'NaN within any tolerance');
            assertEqual(failure(() => assertApprox(NaN, NaN)), null, 'NaN vs NaN');
            assert(failure(() => assertApprox(Infinity, -Infinity, 1e9)) !== null, 'opposite infinities');
        });

        it('assertNull: a NaN is not null, and the message says NaN', function () {
            assertEqual(failure(() => assertNull(NaN)), 'Expected null/undefined but got NaN');
        });
    });
})();
