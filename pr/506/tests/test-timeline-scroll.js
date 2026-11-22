/**
 * test-timeline-scroll.js — Block 1, subfeature 1.2 (Prompt 4)
 *
 * Scrollable timeline track area.
 *
 * Per Block 1 of Prompt 4, the timeline must:
 *   - Add a scrollable track-area container (CSS overflow-y) so when total
 *     content height exceeds the timeline container height, the *track
 *     rows* scroll while the header / mode-toggle / playhead row stays
 *     fixed.
 *   - When content fits inside the container, the scrollbar is NOT shown.
 *   - Tracks "hide from the bottom" — i.e., the bottom-most tracks are
 *     scrolled out of view rather than removed. The current behaviour
 *     (timeline.js `_computeLayout` returning `showTracks: false` when
 *     `availableForTracks < naturalTrackH`) is what Block 1 replaces.
 *
 * Requirements covered:
 *
 *   (T7) Scroll on overflow — when timeline container height < natural
 *        track-area height, a track-area scroll container is in the DOM,
 *        has `overflow-y: auto` (or `scroll`), and has `scrollHeight >
 *        clientHeight`.
 *
 *   (T8) No scroll when content fits — when container is tall enough,
 *        `scrollHeight <= clientHeight` (no scrollbar).
 *
 *   (T9) Header does NOT scroll — the `timeline-mode-toggle` element
 *        (and any header / playhead row) is OUTSIDE the scrollable
 *        track-area container in the DOM tree, so it remains visible
 *        while the track area scrolls.
 *
 * Pre-implementation expectation: every assertion below FAILS because:
 *   - There is no dedicated scrollable track-area container yet — the
 *     Timeline mounts a single `<canvas>` inside the container, plus the
 *     scrollbar that's already in `index.html` is *horizontal* (for frame
 *     scrubbing), not vertical (for tracks).
 *   - When `_computeLayout` decides tracks don't fit, it sets
 *     `showTracks: false` (hides them) rather than scrolling them.
 */

(function () {
    var TF = TestFramework;
    var describe = TF.describe;
    var it = TF.it;
    var assert = TF.assert;
    var assertEqual = TF.assertEqual;
    var assertTrue = TF.assertTrue;
    var assertFalse = TF.assertFalse;
    var assertNotNull = TF.assertNotNull;
    var assertGreaterThan = TF.assertGreaterThan;
    var assertLessThan = TF.assertLessThan;

    function createContainer(width, height) {
        var div = document.createElement('div');
        div.style.width = (width || 800) + 'px';
        div.style.height = (height || 60) + 'px';
        div.style.position = 'fixed';
        div.style.top = '-9999px';
        div.style.left = '0';
        // Mirror production index.html: `.timeline-container` uses
        // `display: flex; flex-direction: column;` so `_trackScrollEl`'s
        // inline `flex: 1 1 auto; min-height: 0` actually constrains the
        // scroll-element height. Without this, the browser test-runner
        // (which doesn't load styles.css) lets _trackScrollEl auto-grow
        // around its canvas, producing scrollHeight == clientHeight even
        // when there are far more rows than the container can hold.
        div.style.display = 'flex';
        div.style.flexDirection = 'column';
        // Keep the visual chrome around the timeline (mode toggle + header)
        // to mirror index.html. Block 1 must mount its track-area scroll
        // container INSIDE this same wrapper so the mode toggle never
        // scrolls.
        document.body.appendChild(div);
        return div;
    }

    function cleanup(tl, container) {
        if (tl) tl.destroy();
        if (container && container.parentNode) container.remove();
    }

    function buildBigSession(numTracks, cameraNames) {
        var skel = new Skeleton('s', ['a', 'b'], [[0, 1]]);
        var cams = [];
        for (var i = 0; i < cameraNames.length; i++) {
            cams.push(new Camera(cameraNames[i],
                [[600, 0, 320], [0, 600, 240], [0, 0, 1]],
                [0, 0, 0, 0, 0],
                [[1, 0, 0], [0, 1, 0], [0, 0, 1]],
                [0, 0, 0],
                [640, 480]));
        }
        var trackNames = [];
        for (var t = 0; t < numTracks; t++) trackNames.push('track_' + t);
        var session = new Session(cams, skel, trackNames);
        session._uploadedCameras = cameraNames.slice();
        var slot = 0;
        for (var c = 0; c < cameraNames.length; c++) {
            for (var t2 = 0; t2 < numTracks; t2++) {
                var inst = new Instance([[10, 10], [20, 20]], slot, 'user', 1);
                inst.trackIdx = t2;
                var fg = session.getFrameGroup(slot) || new FrameGroup(slot);
                fg.addInstance(cameraNames[c], inst);
                if (!session.getFrameGroup(slot)) session.addFrameGroup(fg);
                slot++;
            }
        }
        return session;
    }

    /**
     * Block 1 must add a dedicated track-area scroll container inside the
     * timeline. We accept either:
     *   - a `timeline._trackScrollEl` reference (or `trackScrollContainer`)
     *   - a queryable element with class `timeline-track-area` /
     *     `timeline-tracks-scroll` / a data-attribute `data-timeline-tracks`.
     * Returns the element, or null if none exist.
     */
    function getTrackScrollEl(tl, container) {
        if (tl._trackScrollEl) return tl._trackScrollEl;
        if (tl._trackScrollContainer) return tl._trackScrollContainer;
        if (tl._trackArea) return tl._trackArea;
        if (typeof tl.getTrackAreaElement === 'function') {
            return tl.getTrackAreaElement();
        }
        var candidates = [
            container.querySelector('.timeline-track-area'),
            container.querySelector('.timeline-tracks-scroll'),
            container.querySelector('.timeline-tracks'),
            container.querySelector('[data-timeline-tracks]'),
        ];
        for (var i = 0; i < candidates.length; i++) {
            if (candidates[i]) return candidates[i];
        }
        return null;
    }

    /**
     * Header / mode-toggle / playhead — the *fixed* chrome row that must
     * NOT scroll. We accept `.timeline-mode-toggle`, `.timeline-header`,
     * or any element marked with `data-timeline-header`.
     */
    function getHeaderEl(container) {
        return container.querySelector('.timeline-mode-toggle')
            || container.querySelector('.timeline-header')
            || container.querySelector('[data-timeline-header]')
            || null;
    }

    function isAncestor(ancestor, node) {
        if (!ancestor || !node) return false;
        while (node) {
            if (node === ancestor) return true;
            node = node.parentNode;
        }
        return false;
    }

    describe('Timeline scroll (Prompt 4 / Block 1) — overflow → scrollbar', function () {

        it('(T7) when content height > container height, the track area scrolls', function () {
            // Tall content (50 tracks × 2 cameras = 100 rows) in a small
            // container — should overflow.
            var container = createContainer(900, 120);
            // We also want the mode-toggle present so the header check has a
            // target. Mirror the structure index.html builds.
            var header = document.createElement('div');
            header.className = 'timeline-mode-toggle';
            header.textContent = 'Tracks | IDs | Both';
            container.appendChild(header);

            var tl = new Timeline(container, { totalFrames: 200 });
            tl.setData(buildBigSession(50, ['camA', 'camB']));

            var scrollEl = getTrackScrollEl(tl, container);
            assertNotNull(scrollEl,
                'Block 1 must add a dedicated track-area scroll container ' +
                '(searched for ._trackScrollEl / .timeline-track-area / etc.). ' +
                'Container HTML: ' + container.innerHTML.slice(0, 200));

            // Computed style must allow vertical scrolling.
            var cs = (typeof window !== 'undefined' && window.getComputedStyle)
                ? window.getComputedStyle(scrollEl)
                : { overflowY: scrollEl.style.overflowY };
            var ovY = (cs.overflowY || '').toLowerCase();
            assertTrue(ovY === 'auto' || ovY === 'scroll',
                'track-area must have overflow-y: auto|scroll for tracks ' +
                'to scroll; got "' + ovY + '"');

            // Scrollable: scrollHeight > clientHeight.
            assertGreaterThan(scrollEl.scrollHeight, scrollEl.clientHeight,
                'with 100 rows in a 120 px container, scrollHeight must ' +
                'exceed clientHeight; scrollHeight=' + scrollEl.scrollHeight +
                ' clientHeight=' + scrollEl.clientHeight);

            cleanup(tl, container);
        });
    });

    describe('Timeline scroll (Prompt 4 / Block 1) — content fits → no scrollbar', function () {

        it('(T8) when timeline height ≥ content, scrollHeight ≤ clientHeight', function () {
            // Few tracks in a tall container — should fit without scrolling.
            var container = createContainer(900, 600);
            var header = document.createElement('div');
            header.className = 'timeline-mode-toggle';
            header.textContent = 'Tracks | IDs | Both';
            container.appendChild(header);

            var tl = new Timeline(container, { totalFrames: 50 });
            tl.setData(buildBigSession(2, ['camA']));

            var scrollEl = getTrackScrollEl(tl, container);
            assertNotNull(scrollEl,
                'Block 1 must add a track-area scroll container even ' +
                'when no scrolling is needed; got null');

            assertTrue(scrollEl.scrollHeight <= scrollEl.clientHeight + 1,
                'with 2 tracks in a 600 px container, content should fit; ' +
                'scrollHeight=' + scrollEl.scrollHeight +
                ' clientHeight=' + scrollEl.clientHeight);

            cleanup(tl, container);
        });
    });

    describe('Timeline scroll (Prompt 4 / Block 1) — header stays fixed', function () {

        it('(T9) timeline-mode-toggle / header is OUTSIDE the scrollable track area', function () {
            // Force the overflow case so the test is meaningful.
            var container = createContainer(900, 120);
            var header = document.createElement('div');
            header.className = 'timeline-mode-toggle';
            header.textContent = 'Tracks | IDs | Both';
            container.appendChild(header);

            var tl = new Timeline(container, { totalFrames: 50 });
            tl.setData(buildBigSession(40, ['camA', 'camB']));

            var scrollEl = getTrackScrollEl(tl, container);
            assertNotNull(scrollEl,
                'expected a track scroll container; got null');

            var hdr = getHeaderEl(container);
            assertNotNull(hdr,
                'expected a timeline-mode-toggle / header element in the ' +
                'container chrome');

            assertFalse(isAncestor(scrollEl, hdr),
                'header / mode-toggle must NOT be a descendant of the ' +
                'track-area scroll container — otherwise it would scroll ' +
                'together with the tracks.');

            // Equivalently: header must remain a direct child of the
            // outer timeline wrapper.
            assertTrue(isAncestor(container, hdr),
                'header must still live inside the timeline wrapper');

            cleanup(tl, container);
        });
    });
})();
