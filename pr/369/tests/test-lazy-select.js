/**
 * test-lazy-select.js — ui/lazy-select.js, the info panel's Track <select>.
 *
 * `updateFrameInfo` rebuilds one Track <select> per instance row on every
 * update (~10 Hz during playback). Built eagerly, each carried an <option> per
 * session track, so an 863-track prediction project produced ~35,000 options
 * per update and played at ~5 fps. `buildLazySelect` holds only head, current
 * and tail until the user presses or focuses the select, and then fills in
 * EXACTLY the list an eager build would have had.
 *
 * These pin both halves: the closed select's size does not depend on the entry
 * count, and once filled it is option-for-option what the eager build made —
 * same values, labels, order and selection. The real-panel counterpart (the
 * whole `updateFrameInfo` on 1,000 tracks) is tests/e2e/info-panel-many-tracks.mjs.
 */

(function () {
    var describe = TestFramework.describe;
    var it = TestFramework.it;
    var assertEqual = TestFramework.assertEqual;
    var assertTrue = TestFramework.assertTrue;

    function names(n) {
        var out = [];
        for (var i = 0; i < n; i++) out.push('track_' + i);
        return out;
    }

    // The pre-lazy info-panel build, verbatim in shape: head, one option per
    // track (value = index), tail, then `.value =`.
    function eagerSelect(tracks, value, noneLabel) {
        var sel = document.createElement('select');
        var none = document.createElement('option');
        none.value = '-1'; none.textContent = noneLabel; sel.appendChild(none);
        for (var i = 0; i < tracks.length; i++) {
            var o = document.createElement('option');
            o.value = i; o.textContent = tracks[i]; sel.appendChild(o);
        }
        var nw = document.createElement('option');
        nw.value = '__new__'; nw.textContent = '(+) New Track'; sel.appendChild(nw);
        sel.value = String(value);
        return sel;
    }

    // What buildTrackSelect (ui/info-panel.js) passes for a row on `trackIdx`.
    var calls;
    function lazySelect(tracks, trackIdx, noneLabel) {
        calls = 0;
        return __LazySelect.buildLazySelect({
            head: ['-1', noneLabel],
            tail: ['__new__', '(+) New Track'],
            value: trackIdx,
            label: trackIdx >= 0 && trackIdx < tracks.length ? tracks[trackIdx] : undefined,
            entries: function () {
                calls++;
                return tracks.map(function (n, i) { return [i, n]; });
            },
        });
    }

    function snapshot(sel) {
        return JSON.stringify({
            options: Array.prototype.map.call(sel.options, function (o) { return [o.value, o.textContent]; }),
            selectedIndex: sel.selectedIndex,
            value: sel.value,
        });
    }

    function shown(sel) {
        return sel.selectedIndex >= 0 ? sel.options[sel.selectedIndex].textContent : null;
    }

    describe('buildLazySelect (info-panel Track dropdown)', function () {
        it('a closed select holds head + current + tail, whatever the track count', function () {
            var few = lazySelect(names(5), 3, '(none)');
            var many = lazySelect(names(1000), 3, '(none)');
            assertEqual(few.options.length, 3, '5 tracks');
            assertEqual(many.options.length, 3, '1000 tracks');
            assertEqual(calls, 0, 'entries() is not called until the select is used');
            assertEqual(shown(many), 'track_3');
            assertEqual(many.value, '3');
            assertEqual(many.options[0].textContent, '(none)');
            assertEqual(many.options[2].textContent, '(+) New Track');
        });

        it('shows exactly what the eager build showed, closed', function () {
            var tracks = names(50);
            var cases = [[0, '(none)'], [49, '(none)'], [-1, '(none)'], [-1, '—'], [7, '—'],
                         [50, '(none)'], [999, '—']];   // out of range: nothing selected
            for (var c = 0; c < cases.length; c++) {
                var v = cases[c][0], none = cases[c][1];
                var e = eagerSelect(tracks, v, none), l = lazySelect(tracks, v, none);
                assertEqual(shown(l), shown(e), 'label for ' + v + ' / ' + none);
                assertEqual(l.value, e.value, 'value for ' + v);
                assertEqual(l.selectedIndex >= 0, e.selectedIndex >= 0, 'something selected for ' + v);
            }
            assertEqual(lazySelect(tracks, -1, '(none)').options.length, 2,
                'a trackless row needs no third option — (none) IS the current one');
            assertEqual(lazySelect(tracks, 50, '(none)').selectedIndex, -1,
                'an index past the track list selects nothing, as the eager build did');
        });

        it('focus fills it to the eager list, option for option, keeping the selection', function () {
            var tracks = names(300);
            var cases = [3, -1, 299, 300];
            for (var c = 0; c < cases.length; c++) {
                var l = lazySelect(tracks, cases[c], '(none)');
                l.dispatchEvent(new Event('focus'));
                assertEqual(snapshot(l), snapshot(eagerSelect(tracks, cases[c], '(none)')),
                    'filled select for ' + cases[c]);
            }
        });

        it('mousedown fills it too (the press that opens the list), and only once', function () {
            var l = lazySelect(names(20), 5, '—');
            l.dispatchEvent(new MouseEvent('mousedown'));
            assertEqual(l.options.length, 22, 'head + 20 tracks + tail');
            l.dispatchEvent(new Event('focus'));
            l.dispatchEvent(new MouseEvent('mousedown'));
            assertEqual(l.options.length, 22, 'a second press/focus does not duplicate the list');
            assertEqual(calls, 1, 'entries() ran once');
            assertEqual(l.value, '5');
        });

        it('a filled select can pick any track, and the tail', function () {
            var l = lazySelect(names(1000), 3, '(none)');
            l.dispatchEvent(new Event('focus'));
            l.value = '777';
            assertEqual(shown(l), 'track_777');
            l.value = '__new__';
            assertEqual(shown(l), '(+) New Track');
            l.value = '-1';
            assertEqual(shown(l), '(none)');
        });

        it('filling keeps the closed width, so the list does not open wider under the pointer', function () {
            var host = document.createElement('div');
            host.style.cssText = 'position:absolute;left:-9999px;top:0;';
            document.body.appendChild(host);
            try {
                var tracks = names(10);
                tracks.push('a_track_name_far_wider_than_any_of_the_others');
                var l = lazySelect(tracks, 1, '(none)');
                host.appendChild(l);
                var before = l.offsetWidth;
                assertTrue(before > 0, 'laid out');
                l.dispatchEvent(new Event('focus'));
                assertEqual(l.options.length, 13);
                assertEqual(l.offsetWidth, before, 'width after fill');
            } finally {
                host.remove();
            }
        });
    });
})();
