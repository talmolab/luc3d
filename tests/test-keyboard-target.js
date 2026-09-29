/**
 * test-keyboard-target.js — who owns a keystroke (issue #163).
 *
 * Pins `ui/keyboard-target.js`, the single guard every global keydown handler
 * now calls. The bug it replaced was one line, copied ten times:
 *
 *     if (e.target.tagName === 'INPUT' || ... ) return;
 *
 * `tagName` is `INPUT` for a CHECKBOX, so clicking User / Predicted / Reproj /
 * Errors made the app deaf to EVERY key, not just the one the checkbox wanted.
 * The assertions below are therefore about the distinction that line could not
 * draw: a text field consumes the whole alphabet, a checkbox consumes exactly
 * Space, and a slider consumes exactly the arrows.
 *
 * Every predicate reads only `tagName` / `type` / `role` / `isContentEditable`
 * off its argument, so these run against plain object stubs — no DOM, and the
 * same file serves the browser runner and the `vm` sandbox.
 *
 * The behavior at the app level (click the checkbox, press Space, get playback)
 * is covered end to end by `tests/e2e/checkbox-focus-hotkeys.mjs`.
 */

(function () {
    const { describe, it, assertEqual, assertTrue, assertFalse } = TestFramework;

    // Bridged onto `window` by the browser runner, left on the sandbox global
    // by `tests/run-node.js`. Resolve through both.
    function pick(name) {
        if (typeof window !== 'undefined' && window[name] !== undefined) return window[name];
        if (typeof globalThis !== 'undefined' && globalThis[name] !== undefined) return globalThis[name];
        return undefined;
    }
    function KT() {
        return {
            isTextEntryTarget: pick('isTextEntryTarget'),
            targetOwnsKey: pick('targetOwnsKey'),
            shouldIgnoreShortcut: pick('shouldIgnoreShortcut'),
            isTransientFocusControl: pick('isTransientFocusControl'),
            releaseTransientFocus: pick('releaseTransientFocus'),
        };
    }

    /** A stand-in for an <input>. `type` is what the DOM would report. */
    function input(type, extra) {
        const el = { tagName: 'INPUT', type: type, isContentEditable: false };
        el.getAttribute = function (n) { return (extra && extra[n]) || null; };
        el.hasAttribute = function (n) { return !!(extra && extra[n]); };
        return el;
    }
    function el(tagName, attrs) {
        const e = { tagName: tagName, isContentEditable: false };
        e.getAttribute = function (n) { return (attrs && attrs[n]) || null; };
        e.hasAttribute = function (n) { return !!(attrs && attrs[n]); };
        return e;
    }
    /** A stand-in for a KeyboardEvent. */
    function key(k, mods) {
        return {
            key: k,
            target: (mods && mods.target) || null,
            ctrlKey: !!(mods && mods.ctrl),
            metaKey: !!(mods && mods.meta),
            altKey: !!(mods && mods.alt),
            shiftKey: !!(mods && mods.shift),
        };
    }

    describe('Keyboard target - text entry blocks every shortcut', function () {
        it('a text input, a textarea and a contenteditable all block', function () {
            const kt = KT();
            assertTrue(kt.isTextEntryTarget(input('text')), 'input[type=text]');
            assertTrue(kt.isTextEntryTarget(input('number')), 'input[type=number]');
            assertTrue(kt.isTextEntryTarget(input('search')), 'input[type=search]');
            assertTrue(kt.isTextEntryTarget(el('TEXTAREA')), 'textarea');
            const ce = el('DIV');
            ce.isContentEditable = true;
            assertTrue(kt.isTextEntryTarget(ce), 'contenteditable div');
        });

        it('an input with a missing or unknown type is treated as text', function () {
            const kt = KT();
            // The DOM reports 'text' for both, and 'text' is the safe default:
            // it is the one bucket that blocks everything.
            assertTrue(kt.isTextEntryTarget(input('text')), 'unknown type reports text');
            assertTrue(kt.isTextEntryTarget(input(undefined)), 'no type at all');
        });

        it('a <select> blocks too — it uses the arrows, Enter and typeahead', function () {
            assertTrue(KT().isTextEntryTarget(el('SELECT')), 'select');
        });

        it('but a checkbox, radio, range and button are NOT text entry', function () {
            const kt = KT();
            assertFalse(kt.isTextEntryTarget(input('checkbox')), 'checkbox');
            assertFalse(kt.isTextEntryTarget(input('radio')), 'radio');
            assertFalse(kt.isTextEntryTarget(input('range')), 'range');
            assertFalse(kt.isTextEntryTarget(el('BUTTON')), 'button');
            assertFalse(kt.isTextEntryTarget(null), 'nothing focused');
        });
    });

    describe('Keyboard target - a control owns only the keys it uses', function () {
        it('a checkbox owns Space and nothing else — this IS issue #163', function () {
            const kt = KT();
            const cb = input('checkbox');
            assertTrue(kt.targetOwnsKey(cb, key(' ', { target: cb })), 'Space toggles it');
            assertFalse(kt.targetOwnsKey(cb, key('ArrowRight', { target: cb })), 'ArrowRight does not');
            assertFalse(kt.targetOwnsKey(cb, key('f', { target: cb })), 'f does not');
            assertFalse(kt.targetOwnsKey(cb, key('Enter', { target: cb })), 'Enter does not toggle a checkbox');
        });

        it('a range slider owns the arrows and Home/End, but not Space', function () {
            const kt = KT();
            const sl = input('range');
            assertTrue(kt.targetOwnsKey(sl, key('ArrowRight', { target: sl })), 'ArrowRight');
            assertTrue(kt.targetOwnsKey(sl, key('Home', { target: sl })), 'Home');
            assertTrue(kt.targetOwnsKey(sl, key('PageUp', { target: sl })), 'PageUp');
            assertFalse(kt.targetOwnsKey(sl, key(' ', { target: sl })), 'Space is free for play/pause');
            assertFalse(kt.targetOwnsKey(sl, key('f', { target: sl })), 'f is free');
        });

        it('a button owns Space and Enter; a link owns Enter only', function () {
            const kt = KT();
            const btn = el('BUTTON');
            assertTrue(kt.targetOwnsKey(btn, key(' ', { target: btn })), 'button + Space');
            assertTrue(kt.targetOwnsKey(btn, key('Enter', { target: btn })), 'button + Enter');
            assertFalse(kt.targetOwnsKey(btn, key('ArrowLeft', { target: btn })), 'button + ArrowLeft');
            const a = el('A', { href: '#x' });
            assertTrue(kt.targetOwnsKey(a, key('Enter', { target: a })), 'link + Enter');
            assertFalse(kt.targetOwnsKey(a, key(' ', { target: a })), 'Space scrolls, it does not click a link');
        });

        it('ARIA roles are honoured for non-native widgets', function () {
            const kt = KT();
            const sw = el('DIV', { role: 'switch' });
            assertTrue(kt.targetOwnsKey(sw, key(' ', { target: sw })), 'role=switch + Space');
            assertFalse(kt.targetOwnsKey(sw, key('n', { target: sw })), 'role=switch + n');
            const slider = el('DIV', { role: 'slider' });
            assertTrue(kt.targetOwnsKey(slider, key('ArrowUp', { target: slider })), 'role=slider + ArrowUp');
        });

        it('a modifier chord is never the control\'s own key', function () {
            const kt = KT();
            // Mod+S must still save while a checkbox has focus.
            const cb = input('checkbox');
            assertFalse(kt.targetOwnsKey(cb, key(' ', { target: cb, ctrl: true })), 'Ctrl+Space');
            const btn = el('BUTTON');
            assertFalse(kt.targetOwnsKey(btn, key('s', { target: btn, meta: true })), 'Cmd+S on a button');
        });
    });

    describe('Keyboard target - the guard every keydown handler calls', function () {
        it('the reported case: a focused checkbox stops Space but nothing else', function () {
            const kt = KT();
            const cb = input('checkbox');
            assertTrue(kt.shouldIgnoreShortcut(key(' ', { target: cb })),
                'Space belongs to the checkbox');
            assertFalse(kt.shouldIgnoreShortcut(key('ArrowRight', { target: cb })),
                'frame stepping still works');
            assertFalse(kt.shouldIgnoreShortcut(key('f', { target: cb })),
                'Find Match still works');
            assertFalse(kt.shouldIgnoreShortcut(key('n', { target: cb })),
                'New instance still works');
        });

        it('a focused text field still stops everything', function () {
            const kt = KT();
            const tx = input('text');
            ['a', ' ', 'ArrowRight', 'Enter', 'f', 'Home'].forEach(function (k) {
                assertTrue(kt.shouldIgnoreShortcut(key(k, { target: tx })), 'text field swallows ' + k);
            });
        });

        it('nothing focused means every shortcut is live', function () {
            const kt = KT();
            const body = el('BODY');
            assertFalse(kt.shouldIgnoreShortcut(key(' ', { target: body })), 'Space on body');
            assertFalse(kt.shouldIgnoreShortcut(null), 'no event at all');
        });
    });

    describe('Keyboard target - focus is released after a POINTER click', function () {
        it('checkboxes, radios and buttons are activate-me controls', function () {
            const kt = KT();
            assertTrue(kt.isTransientFocusControl(input('checkbox')), 'checkbox');
            assertTrue(kt.isTransientFocusControl(input('radio')), 'radio');
            assertTrue(kt.isTransientFocusControl(el('BUTTON')), 'button');
            assertTrue(kt.isTransientFocusControl(input('submit')), 'input[type=submit]');
        });

        it('text fields, selects and sliders are NOT — focus there is a beginning', function () {
            const kt = KT();
            assertFalse(kt.isTransientFocusControl(input('text')), 'text');
            assertFalse(kt.isTransientFocusControl(input('range')), 'range');
            assertFalse(kt.isTransientFocusControl(el('SELECT')), 'select');
            assertFalse(kt.isTransientFocusControl(el('TEXTAREA')), 'textarea');
        });

        /** A checkbox stub that records blur(), with a fake owning document. */
        function focusedCheckbox(focusVisible) {
            const cb = input('checkbox');
            cb.blurred = 0;
            cb.blur = function () { cb.blurred++; doc.activeElement = null; };
            cb.matches = function (sel) { return sel === ':focus-visible' && focusVisible; };
            const doc = { activeElement: cb };
            cb.ownerDocument = doc;
            return cb;
        }

        it('a pointer-focused checkbox is blurred', function () {
            const cb = focusedCheckbox(false);
            assertTrue(KT().releaseTransientFocus(cb), 'released');
            assertEqual(cb.blurred, 1, 'blur() called once');
        });

        it('a KEYBOARD-focused checkbox keeps focus, so Space still toggles it', function () {
            const cb = focusedCheckbox(true);
            assertFalse(KT().releaseTransientFocus(cb), 'not released');
            assertEqual(cb.blurred, 0, 'blur() never called');
        });

        it('a control that no longer holds focus is left alone', function () {
            const cb = focusedCheckbox(false);
            cb.ownerDocument.activeElement = { tagName: 'BODY' };
            assertFalse(KT().releaseTransientFocus(cb), 'not released');
            assertEqual(cb.blurred, 0, 'blur() never called');
        });

        it('a text field is never blurred, even pointer-focused', function () {
            const kt = KT();
            const tx = input('text');
            tx.blurred = 0;
            tx.blur = function () { tx.blurred++; };
            tx.matches = function () { return false; };
            tx.ownerDocument = { activeElement: tx };
            assertFalse(kt.releaseTransientFocus(tx), 'not released');
            assertEqual(tx.blurred, 0, 'blur() never called');
        });
    });
})();
