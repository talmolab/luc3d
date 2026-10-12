/**
 * test-browser-hints.js — ui/browser-hints.js.
 *
 * Brave ships the File System Access API turned OFF (no showSaveFilePicker /
 * showDirectoryPicker) while identifying as Chrome, so saves/exports fall
 * back to in-memory downloads and multi-session loading refuses. The hint
 * must appear ONLY in Brave with the API off — never in other browsers
 * (Safari/Firefox can't enable it) nor in Brave once it's enabled.
 */
(function () {
    var TF = TestFramework;
    var describe = TF.describe, it = TF.it, assertEqual = TF.assertEqual, assertTrue = TF.assertTrue;

    // Run `fn` with navigator.brave and the pickers patched, then restore.
    function withEnv(env, fn) {
        var hadBrave = Object.prototype.hasOwnProperty.call(navigator, 'brave');
        var origBrave = navigator.brave;
        var names = ['showSaveFilePicker', 'showDirectoryPicker'];
        var own = names.map(function (n) { return Object.prototype.hasOwnProperty.call(window, n); });
        var orig = names.map(function (n) { return window[n]; });
        try {
            Object.defineProperty(navigator, 'brave', { value: env.brave ? { isBrave: function () { return Promise.resolve(true); } } : undefined,
                configurable: true, writable: true });
            names.forEach(function (n) { window[n] = env.fsa ? function () {} : undefined; });
            return fn();
        } finally {
            if (hadBrave) Object.defineProperty(navigator, 'brave', { value: origBrave, configurable: true, writable: true });
            else delete navigator.brave;
            names.forEach(function (n, i) { if (own[i]) window[n] = orig[i]; else delete window[n]; });
        }
    }

    describe('browser-hints: Brave File System Access hint', function () {
        it('Brave with the API off: explains brave://flags and the alternatives', function () {
            if (typeof fileSystemAccessHint === 'undefined') return;
            var h = withEnv({ brave: true, fsa: false }, fileSystemAccessHint);
            assertTrue(h.indexOf('brave://flags') >= 0, 'names brave://flags');
            assertTrue(h.indexOf('File System Access API') >= 0, 'names the flag');
            assertTrue(/Chrome or Edge/.test(h), 'offers alternatives');
            assertTrue(withEnv({ brave: true, fsa: false }, isBrave), 'isBrave');
        });

        it('no hint in Brave once the API is enabled', function () {
            if (typeof fileSystemAccessHint === 'undefined') return;
            assertEqual(withEnv({ brave: true, fsa: true }, fileSystemAccessHint), '', 'empty');
        });

        it('no hint in other browsers, with or without the API', function () {
            if (typeof fileSystemAccessHint === 'undefined') return;
            assertEqual(withEnv({ brave: false, fsa: false }, fileSystemAccessHint), '', 'Safari/Firefox-like: empty');
            assertEqual(withEnv({ brave: false, fsa: true }, fileSystemAccessHint), '', 'Chrome-like: empty');
            assertEqual(withEnv({ brave: false, fsa: false }, isBrave), false, 'not Brave');
        });
    });
})();
