/**
 * test-browser-hints.js — ui/browser-hints.js.
 *
 * Brave ships the File System Access API turned OFF (no showSaveFilePicker /
 * showDirectoryPicker) while identifying as Chrome, so saves/exports fall
 * back to in-memory downloads and multi-session loading refuses. The hint
 * must appear ONLY in Brave with the API off — never in other browsers
 * (Safari/Firefox can't enable it) nor in Brave once it's enabled.
 *
 * Brave's fingerprinting protection (a random core count, noisy canvas reads)
 * gets a step-by-step note under the progress popups' CPU line — ONLY in Brave
 * with canvas reads perturbed; real Brave is driven by
 * tests/e2e/brave-fingerprinting-hint.mjs.
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

    describe('browser-hints: Brave fingerprinting protection (random core count)', function () {
        it('this browser reads a canvas back exactly (the real probe; Chromium does not farble)', function () {
            if (typeof canvasReadsPerturbed === 'undefined') return;
            __setCanvasProbe(null);
            assertEqual(canvasReadsPerturbed(), false, 'exact read-back');
        });

        it('Brave with noisy canvas reads: the reported count, and the steps in Brave\'s words', function () {
            if (typeof braveFingerprintingHint === 'undefined') return;
            __setCanvasProbe(function () { return true; });
            try {
                var h = withEnv({ brave: true, fsa: true }, function () { return braveFingerprintingHint(5); });
                assertTrue(!!h && /random number of CPU cores to this site \(this session: 5\)/.test(h.lead), 'names the reported count: ' + (h && h.lead));
                assertEqual(h.steps.length, 3, 'three steps');
                assertTrue(/save your project/.test(h.steps[0]) && /reloads the page/.test(h.steps[0]), 'save first: Shields reloads the page');
                assertTrue(/Shields icon \(the lion\)/.test(h.steps[1]), 'where to click');
                assertTrue(/Advanced controls/.test(h.steps[2]) && /Allow fingerprinting/.test(h.steps[2]) && /Block fingerprinting/.test(h.steps[2]),
                    'Brave 1.97\'s labels, and the older switch');
                assertTrue(/goes away/.test(h.after), 'says how to tell it worked');
                assertTrue(withEnv({ brave: true, fsa: true }, braveFingerprintingActive), 'active');
            } finally { __setCanvasProbe(null); }
        });

        it('no note in Brave with the site allowed, nor in other browsers', function () {
            if (typeof braveFingerprintingHint === 'undefined') return;
            __setCanvasProbe(function () { return false; });
            try { assertEqual(withEnv({ brave: true, fsa: true }, function () { return braveFingerprintingHint(12); }), null, 'Brave, allowed'); }
            finally { __setCanvasProbe(null); }
            __setCanvasProbe(function () { return true; });
            try { assertEqual(withEnv({ brave: false, fsa: true }, function () { return braveFingerprintingHint(4); }), null, 'not Brave, even with noise'); }
            finally { __setCanvasProbe(null); }
        });

        it('renders as a lead, three numbered steps and an after-note, or hides', function () {
            if (typeof renderBraveFingerprintingHint === 'undefined') return;
            var el = document.createElement('div');
            __setCanvasProbe(function () { return true; });
            try {
                assertTrue(withEnv({ brave: true, fsa: true }, function () { return renderBraveFingerprintingHint(el, 7); }), 'shown');
                assertEqual(el.hidden, false, 'visible');
                assertEqual(el.querySelectorAll('ol > li').length, 3, 'numbered steps');
                assertTrue(/this session: 7/.test(el.querySelector('strong').textContent), 'the lead in bold');
            } finally { __setCanvasProbe(null); }
            assertEqual(withEnv({ brave: false, fsa: true }, function () { return renderBraveFingerprintingHint(el, 7); }), false, 'not shown elsewhere');
            assertTrue(el.hidden && el.textContent === '', 'hidden and emptied');
        });
    });

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
