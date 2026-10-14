/**
 * ui/track-setup-modal.js — what Track All and Track Frame ask the first time
 * they run on a session: the number of animals, and a review of the node
 * weights.
 *
 * The animal count used to be a native `prompt()`. Node weights reached the
 * tracker's association cost (`pose/cross-view-tracker.js`) without ever being
 * shown on the way to a run: they live in Tracks ▸ Tracking Wizard, are saved
 * per BROWSER rather than per project, and a weight left at 0 from another
 * project silently drops that node from this one's matching. The one moment
 * every user passes through before tracking a session is this question, so the
 * weights are laid out under it, editable, with the values the run will use.
 *
 * A LEAF on purpose: it imports nothing, takes the current values in and hands
 * the answer back, and commits nothing itself. `pose/tracker.js` writes the
 * count (`setTrackerNumAnimals`) and the weights (`setNodeWeights`) — the same
 * two writers as the toolbar's Animals field and the Tracking Wizard — so there
 * is no second path to either setting, and no import cycle with the tracker.
 *
 * Track All's copy also carries the image ID-switch check that can follow the
 * run (`autoImageSwitchCheck` and its four options, the Tracking Wizard's own
 * settings): it is off by default and slow when on, so the moment a run is
 * about to start is when to decide. Track Frame's copy leaves it out — a
 * single frame is never checked. Track Frame Range shows the same section
 * (`buildImageCheckFields`), since a range is checked too.
 *
 * When it opens is the tracker's business, unchanged from the prompt: only
 * while the session has never been asked (`numAnimalsAnswered`). Track Frame
 * Range collects the count in its own dialog and never reaches this one.
 */

/**
 * Show the dialog. Resolves with the answer on Continue / Enter, or `null` on
 * Cancel / Esc / a backdrop click, which must leave everything as it was.
 *
 * Only one at a time: a second call while one is open resolves `null` at once,
 * so a Track Frame clicked under an open Track All dialog does nothing.
 *
 * @param {{title?: string, animals?: ?number,
 *          nodes?: Array<{name: string, weight: number}>,
 *          imageCheck?: Array<Object>}} opts
 *   `title` names the run ("Track All" / "Track Frame"); `animals` pre-fills
 *   the count (null/undefined = blank, auto-detect); `nodes` are the session's
 *   skeleton nodes in order, each with its CURRENT effective weight;
 *   `imageCheck`, when given, is the image check's settings as
 *   `getTrackingThresholdDefs()` describes them (`IMAGE_CHECK_IDS`).
 * @returns {Promise<?{animals: ?number, nodeWeights: Object<string, number>,
 *                     thresholds: Object<string, number>}>}
 *   `animals` null = auto-detect; `nodeWeights` maps EVERY node shown to its
 *   weight in [0, 1], edited or not; `thresholds` maps every image-check
 *   setting shown to its value ({} when none were).
 */
export function showTrackSetupModal(opts) {
    opts = opts || {};
    if (document.querySelector('.track-setup-modal')) return Promise.resolve(null);
    var nodes = Array.isArray(opts.nodes) ? opts.nodes : [];
    var animals = (typeof opts.animals === 'number' && opts.animals >= 1) ? opts.animals : null;

    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay';
        var modal = document.createElement('div');
        modal.className = 'multi-frame-modal track-setup-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');

        var h = document.createElement('h3');
        h.textContent = opts.title || 'Track';
        modal.appendChild(h);

        // --- Animals ---------------------------------------------------------
        var animalsRow = document.createElement('label');
        animalsRow.className = 'track-setup-animals';
        var animalsLabel = document.createElement('span');
        animalsLabel.textContent = 'Number of animals';
        var animalsInput = document.createElement('input');
        animalsInput.type = 'number';
        animalsInput.id = 'trackSetupAnimals';
        animalsInput.step = '1';
        animalsInput.min = '1';
        animalsInput.placeholder = 'auto';
        animalsInput.value = animals != null ? String(animals) : '';
        var animalsHint = document.createElement('span');
        animalsHint.className = 'track-setup-hint';
        animalsHint.textContent = 'Leave blank to auto-detect.';
        animalsRow.appendChild(animalsLabel);
        animalsRow.appendChild(animalsInput);
        animalsRow.appendChild(animalsHint);
        modal.appendChild(animalsRow);

        // --- Node weights ------------------------------------------------------
        var weights = buildNodeWeightFields(nodes);
        if (weights.element) modal.appendChild(weights.element);

        // --- Image ID-switch check (Track All only) ---------------------------
        var imageCheck = buildImageCheckFields(opts.imageCheck);
        if (imageCheck.element) modal.appendChild(imageCheck.element);

        var note = document.createElement('p');
        note.className = 'track-setup-note track-setup-later';
        note.textContent = 'To change these later: the Animals field beside Track Frame, and ' +
            'Tracks ▸ Tracking Wizard. Node weights' + (imageCheck.element ? ' and the image check' : '') +
            ' are saved in this browser, for every project.';
        modal.appendChild(note);

        var errorEl = document.createElement('div');
        errorEl.className = 'modal-error';
        errorEl.id = 'trackSetupError';
        modal.appendChild(errorEl);

        var actions = document.createElement('div');
        actions.className = 'modal-actions';
        var cancelBtn = document.createElement('button');
        cancelBtn.id = 'trackSetupCancel';
        cancelBtn.textContent = 'Cancel';
        var continueBtn = document.createElement('button');
        continueBtn.id = 'trackSetupContinue';
        continueBtn.className = 'primary';
        continueBtn.textContent = 'Continue';
        actions.appendChild(cancelBtn);
        actions.appendChild(continueBtn);
        modal.appendChild(actions);
        overlay.appendChild(modal);

        // Parsed, validated form. `error` non-null ⇒ Continue is disabled and the
        // message shown; the dialog never closes on bad input, and never clamps
        // one silently (a typed 5 is a typo, not a request for 1).
        function readForm() {
            var raw = animalsInput.value.trim();
            var n = raw === '' ? null : Number(raw);
            // `badInput` is text that is not a number at all (a stray "e"), which
            // `value` reports as '' — a typo, not a request for auto-detect.
            if (animalsInput.validity.badInput || (n !== null && (!Number.isInteger(n) || n < 1))) {
                return { error: 'Number of animals must be a whole number, 1 or more, or blank to auto-detect.' };
            }
            var w = weights.read();
            if (w.error) return { error: w.error };
            var t = imageCheck.read();
            if (t.error) return { error: t.error };
            return { animals: n, nodeWeights: w.nodeWeights, thresholds: t.thresholds, error: null };
        }

        function refresh() {
            var f = readForm();
            errorEl.textContent = f.error || '';
            continueBtn.disabled = !!f.error;
            weights.refresh();
            imageCheck.refresh();
        }

        var done = false;
        function finish(answer) {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(answer);
        }

        function proceed() {
            var f = readForm();
            if (f.error) { refresh(); return; }
            finish({ animals: f.animals, nodeWeights: f.nodeWeights, thresholds: f.thresholds });
        }

        // Capture phase, and the keys are consumed: Esc and Enter belong to the
        // dialog while it is up, not to whatever app shortcut shares them.
        function onKey(e) {
            if (e.key === 'Escape') {
                e.preventDefault(); e.stopPropagation(); finish(null);
            } else if (e.key === 'Enter' && e.target !== cancelBtn) {
                e.preventDefault(); e.stopPropagation(); proceed();
            }
        }
        document.addEventListener('keydown', onKey, true);

        modal.addEventListener('input', refresh);
        modal.addEventListener('change', refresh);   // the switch
        cancelBtn.addEventListener('click', function () { finish(null); });
        continueBtn.addEventListener('click', proceed);
        overlay.addEventListener('click', function (e) {
            if (e.target === overlay) finish(null);
        });

        document.body.appendChild(overlay);
        refresh();
        animalsInput.focus();
        animalsInput.select();
    });
}

/**
 * The node-weight editor both tracking dialogs show: a title, one sentence,
 * and one row per node in the Tracking Wizard's own markup and classes, so the
 * editors of one setting look the same (the grid is narrower here, styles.css).
 * Used by this dialog and by Track Frame Range (`ui/track-range-modal.js`).
 * Commits nothing.
 *
 * @param {Array<{name: string, weight: number}>} nodes  in skeleton order
 * @returns {{element: ?HTMLElement,
 *            read: () => ({nodeWeights: Object<string, number>} | {error: string}),
 *            refresh: () => void}}
 *   `element` is null for no nodes. `read` refuses a weight outside [0, 1] —
 *   never clamps it — with an error naming the node. `refresh` greys the rows
 *   weighted 0; call it on every input.
 */
export function buildNodeWeightFields(nodes) {
    nodes = Array.isArray(nodes) ? nodes : [];
    var fields = [];
    var element = null;
    if (nodes.length) {
        element = document.createElement('div');
        element.className = 'track-weights-block';
        var title = document.createElement('div');
        title.className = 'track-setup-section-title';
        title.textContent = 'Node weights';
        element.appendChild(title);
        var hint = document.createElement('p');
        hint.className = 'track-setup-note';
        hint.textContent = 'How much each node counts when matching animals: ' +
            '1 = full weight, 0 = ignored.';
        element.appendChild(hint);

        var list = document.createElement('div');
        list.className = 'settings-node-weight-list track-setup-weights';
        nodes.forEach(function (node) {
            var row = document.createElement('div');
            row.className = 'settings-node-weight-row';
            var label = document.createElement('div');
            label.className = 'settings-kbd-label';
            label.textContent = node.name;
            label.title = node.name;
            var input = document.createElement('input');
            input.type = 'number';
            input.className = 'settings-num-input';
            input.min = '0';
            input.max = '1';
            input.step = '0.01';
            input.value = String(node.weight);
            input.dataset.node = node.name;
            input.setAttribute('aria-label', 'Weight for node ' + node.name);
            row.appendChild(label);
            row.appendChild(input);
            list.appendChild(row);
            fields.push({ name: node.name, input: input, row: row });
        });
        element.appendChild(list);
    }

    function read() {
        var out = {};
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            var v = f.input.value.trim() === '' ? NaN : Number(f.input.value);
            if (f.input.validity.badInput || !isFinite(v) || v < 0 || v > 1) {
                return { error: 'The weight for ' + f.name + ' must be between 0 and 1.' };
            }
            out[f.name] = v;
        }
        return { nodeWeights: out };
    }

    // Grey a dropped node out, as the Tracking Wizard does.
    function refresh() {
        fields.forEach(function (f) {
            f.row.classList.toggle('settings-view-excluded',
                f.input.value.trim() !== '' && Number(f.input.value) === 0);
        });
    }

    refresh();
    return { element: element, read: read, refresh: refresh };
}

/**
 * The Tracking Wizard settings of the image ID-switch check that runs after
 * Track All, in the order the dialog shows them: the on/off switch first.
 */
export const IMAGE_CHECK_IDS = [
    'autoImageSwitchCheck', 'imageChangeThreshold', 'imageCheckHz', 'imageCheckMaxViews', 'imageCheckWebNN',
];

/**
 * The image ID-switch check's settings as the Track All and Track Frame Range
 * dialogs show them: a
 * switch for the check itself and, while it is on, its options in a compact
 * grid. Labels are the Wizard's, less its "Image check: " prefix (the section
 * says it); the Wizard's long description of each sits in its label's `title`
 * rather than in the dialog. Commits nothing.
 *
 * @param {Array<Object>} [defs]  `getTrackingThresholdDefs()` entries
 *   (`{id, label, value, min, max, step, desc, kind}`); only `IMAGE_CHECK_IDS`
 *   are used, in that order.
 * @param {string} [after]  what the check follows, for the switch's label
 *   ("Track All", "tracking the range"); default "Track All".
 * @returns {{element: ?HTMLElement,
 *            read: () => ({thresholds: Object<string, number>} | {error: string}),
 *            refresh: () => void}}
 *   `element` is null when there is nothing to show. `read` refuses a value
 *   outside its setting's range — never clamps it — naming the setting.
 *   `refresh` shows the options only while the check is on.
 */
export function buildImageCheckFields(defs, after) {
    var byId = {};
    (Array.isArray(defs) ? defs : []).forEach(function (d) { byId[d.id] = d; });
    var main = byId[IMAGE_CHECK_IDS[0]];
    if (!main) return { element: null, read: function () { return { thresholds: {} }; }, refresh: function () {} };

    var fields = [];   // {def, input, label}
    function shortLabel(def) {
        var t = def.label.replace(/^Image check:\s*/, '');
        return t.charAt(0).toUpperCase() + t.slice(1);
    }
    function toggle(def, text) {
        var wrap = document.createElement('label');
        wrap.className = 'track-setup-switch-row';
        wrap.title = def.desc || '';
        var sw = document.createElement('span');
        sw.className = 'toggle-switch toggle-switch-sm';
        var box = document.createElement('input');
        box.type = 'checkbox';
        box.checked = def.value > 0;
        box.dataset.setting = def.id;
        box.setAttribute('role', 'switch');
        var slider = document.createElement('span');
        slider.className = 'slider';
        sw.appendChild(box);
        sw.appendChild(slider);
        var span = document.createElement('span');
        span.textContent = text;
        wrap.appendChild(sw);
        wrap.appendChild(span);
        fields.push({ def: def, input: box });
        return wrap;
    }

    var element = document.createElement('div');
    element.className = 'track-image-check-block';
    var title = document.createElement('div');
    title.className = 'track-setup-section-title';
    title.textContent = 'ID switch check (images)';
    element.appendChild(title);
    element.appendChild(toggle(main, 'Check for ID switches by image after ' + (after || 'Track All')));
    var hint = document.createElement('p');
    hint.className = 'track-setup-note';
    hint.textContent = 'Slow: minutes for a long recording, and it needs the videos loaded.';
    element.appendChild(hint);

    var options = document.createElement('div');
    options.className = 'settings-node-weight-list track-setup-options';
    IMAGE_CHECK_IDS.slice(1).forEach(function (id) {
        var def = byId[id];
        if (!def) return;
        if (def.kind === 'toggle') {
            var row = document.createElement('div');
            row.className = 'settings-node-weight-row';
            row.appendChild(toggle(def, shortLabel(def)));
            options.appendChild(row);
            return;
        }
        var r = document.createElement('div');
        r.className = 'settings-node-weight-row';
        var label = document.createElement('div');
        label.className = 'settings-kbd-label';
        label.textContent = shortLabel(def);
        label.title = def.desc || '';
        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'settings-num-input';
        input.min = String(def.min);
        input.max = String(def.max);
        input.step = String(def.step);
        input.value = String(def.value);
        input.dataset.setting = def.id;
        input.setAttribute('aria-label', def.label);
        r.appendChild(label);
        r.appendChild(input);
        options.appendChild(r);
        fields.push({ def: def, input: input });
    });
    element.appendChild(options);

    function read() {
        var out = {};
        for (var i = 0; i < fields.length; i++) {
            var f = fields[i];
            if (f.input.type === 'checkbox') { out[f.def.id] = f.input.checked ? 1 : 0; continue; }
            var v = f.input.value.trim() === '' ? NaN : Number(f.input.value);
            if (f.input.validity.badInput || !isFinite(v) || v < f.def.min || v > f.def.max) {
                return { error: shortLabel(f.def) + ' must be between ' + f.def.min + ' and ' + f.def.max + '.' };
            }
            out[f.def.id] = v;
        }
        return { thresholds: out };
    }

    function refresh() {
        options.hidden = !fields[0].input.checked;
    }

    refresh();
    return { element: element, read: read, refresh: refresh };
}
