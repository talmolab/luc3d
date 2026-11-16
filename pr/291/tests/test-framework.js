/**
 * test-framework.js - Minimal browser-based test framework.
 * No dependencies, no build step. Runs in any browser.
 */

const TestFramework = (function () {
    const suites = [];
    let currentSuite = null;

    function describe(name, fn) {
        const suite = { name: name, tests: [], beforeEachFn: null, passed: 0, failed: 0, errors: [] };
        currentSuite = suite;
        suites.push(suite);
        fn();
        currentSuite = null;
    }

    function beforeEach(fn) {
        if (currentSuite) currentSuite.beforeEachFn = fn;
    }

    function it(name, fn) {
        if (currentSuite) {
            currentSuite.tests.push({ name: name, fn: fn });
        }
    }

    // Assertions
    function assert(condition, message) {
        if (!condition) {
            throw new Error(message || 'Assertion failed');
        }
    }

    // JSON of a value in which NaN, Infinity and -Infinity, which JSON writes
    // as null, stay distinct from null and from each other: they become
    // strings starting with \u0000 (a real string starting with \u0000 gets
    // one more, so no string can pass for one). Object keys are left alone.
    function jsonKey(value) {
        return JSON.stringify(value, function (key, v) {
            if (typeof v === 'number' && !Number.isFinite(v)) return '\u0000' + v;
            if (typeof v === 'string' && v.charCodeAt(0) === 0) return '\u0000' + v;
            return v;
        });
    }

    // jsonKey's text for a failure message: NaN and the infinities bare, real
    // strings as they were.
    function shownJson(json) {
        return json === undefined ? 'undefined'
            : json.replace(/(?<!\\)"\\u0000(NaN|Infinity|-Infinity)"(?!:)/g, '$1')
                .replace(/(?<!\\)"\\u0000\\u0000/g, '"\\u0000');
    }

    function show(value) {
        return shownJson(jsonKey(value));
    }

    // Strict equality, except that NaN equals NaN (so a test can expect NaN;
    // NaN where a number is expected still fails).
    function assertEqual(actual, expected, message) {
        if (actual !== expected && !(actual !== actual && expected !== expected)) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected ' + show(expected) + ' but got ' + show(actual)
            );
        }
    }

    // Compares the JSON of both sides, so key order matters, typed arrays
    // compare by value, and an object key holding undefined counts as absent
    // (as does undefined vs null in an array; Maps and Sets all look like {}).
    // NaN, Infinity and -Infinity, which plain JSON writes as null, are told
    // apart from null and from each other (jsonKey).
    function assertDeepEqual(actual, expected, message) {
        const a = jsonKey(actual);
        const e = jsonKey(expected);
        if (a !== e) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected ' + shownJson(e) + ' but got ' + shownJson(a)
            );
        }
    }

    // Fails on NaN and on anything that is not a number: `Math.abs(NaN - x) >
    // tol` is false, so a `> tol` check let them through. To expect NaN, pass
    // NaN as `expected`; an infinity matches only the same infinity.
    function assertApprox(actual, expected, tolerance, message) {
        tolerance = tolerance || 1e-6;
        const close = typeof actual === 'number' && typeof expected === 'number' &&
            (actual === expected || Object.is(actual, expected) || Math.abs(actual - expected) <= tolerance);
        if (!close) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected ~' + expected + ' (±' + tolerance + ') but got ' + actual
            );
        }
    }

    function assertNull(value, message) {
        if (value !== null && value !== undefined) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected null/undefined but got ' + show(value)
            );
        }
    }

    function assertNotNull(value, message) {
        if (value === null || value === undefined) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected non-null value but got ' + value
            );
        }
    }

    function assertThrows(fn, message) {
        let threw = false;
        try { fn(); } catch (e) { threw = true; }
        if (!threw) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected function to throw but it did not'
            );
        }
    }

    function assertTrue(value, message) {
        assert(value === true, (message || 'Expected true') + ' but got ' + value);
    }

    function assertFalse(value, message) {
        assert(value === false, (message || 'Expected false') + ' but got ' + value);
    }

    function assertGreaterThan(actual, expected, message) {
        if (!(actual > expected)) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected ' + actual + ' > ' + expected
            );
        }
    }

    function assertLessThan(actual, expected, message) {
        if (!(actual < expected)) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected ' + actual + ' < ' + expected
            );
        }
    }

    // Runner
    async function runAll() {
        const results = { total: 0, passed: 0, failed: 0, suites: [] };

        for (const suite of suites) {
            const suiteResult = { name: suite.name, tests: [], passed: 0, failed: 0 };

            for (const test of suite.tests) {
                results.total++;
                let status = 'passed';
                let error = null;

                try {
                    if (suite.beforeEachFn) suite.beforeEachFn();
                    const result = test.fn();
                    if (result && typeof result.then === 'function') {
                        await result;
                    }
                } catch (e) {
                    status = 'failed';
                    error = e.message || String(e);
                }

                if (status === 'passed') {
                    results.passed++;
                    suiteResult.passed++;
                } else {
                    results.failed++;
                    suiteResult.failed++;
                }

                suiteResult.tests.push({ name: test.name, status: status, error: error });
            }

            results.suites.push(suiteResult);
        }

        return results;
    }

    function renderResults(results, container) {
        container.innerHTML = '';

        const summary = document.createElement('div');
        summary.className = 'test-summary ' + (results.failed === 0 ? 'all-passed' : 'has-failures');
        summary.textContent = results.passed + '/' + results.total + ' tests passed' +
            (results.failed > 0 ? ' (' + results.failed + ' failed)' : '');
        container.appendChild(summary);

        for (const suite of results.suites) {
            const suiteEl = document.createElement('div');
            suiteEl.className = 'test-suite';

            const title = document.createElement('h3');
            title.className = 'suite-title ' + (suite.failed === 0 ? 'suite-passed' : 'suite-failed');
            title.textContent = (suite.failed === 0 ? '\u2713 ' : '\u2717 ') + suite.name +
                ' (' + suite.passed + '/' + suite.tests.length + ')';
            suiteEl.appendChild(title);

            for (const test of suite.tests) {
                const testEl = document.createElement('div');
                testEl.className = 'test-case ' + test.status;
                testEl.textContent = (test.status === 'passed' ? '  \u2713 ' : '  \u2717 ') + test.name;
                suiteEl.appendChild(testEl);

                if (test.error) {
                    const errEl = document.createElement('div');
                    errEl.className = 'test-error';
                    errEl.textContent = '    ' + test.error;
                    suiteEl.appendChild(errEl);
                }
            }

            container.appendChild(suiteEl);
        }
    }

    return {
        describe: describe,
        beforeEach: beforeEach,
        it: it,
        assert: assert,
        assertEqual: assertEqual,
        assertDeepEqual: assertDeepEqual,
        assertApprox: assertApprox,
        assertNull: assertNull,
        assertNotNull: assertNotNull,
        assertThrows: assertThrows,
        assertTrue: assertTrue,
        assertFalse: assertFalse,
        assertGreaterThan: assertGreaterThan,
        assertLessThan: assertLessThan,
        runAll: runAll,
        renderResults: renderResults,
    };
})();
