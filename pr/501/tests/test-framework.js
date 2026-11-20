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

    function assertEqual(actual, expected, message) {
        if (actual !== expected) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected ' + JSON.stringify(expected) + ' but got ' + JSON.stringify(actual)
            );
        }
    }

    function assertDeepEqual(actual, expected, message) {
        const a = JSON.stringify(actual);
        const e = JSON.stringify(expected);
        if (a !== e) {
            throw new Error(
                (message ? message + ': ' : '') +
                'Expected ' + e + ' but got ' + a
            );
        }
    }

    function assertApprox(actual, expected, tolerance, message) {
        tolerance = tolerance || 1e-6;
        if (Math.abs(actual - expected) > tolerance) {
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
                'Expected null/undefined but got ' + JSON.stringify(value)
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
