/**
 * ui/identity-marks-modal.js — what each identity's tail shows: one row per identity
 * with its number of dark bands (0 = plain), for Track All's identity engine
 * (pose/identity-cues.js, the tail-band cue in pose/tail-mark.js).
 *
 * A LEAF: it imports nothing and commits nothing. The caller writes the answer
 * (`setIdentityMarks`, pose/tracker.js), as the Animals field and the first-use dialog do.
 * Other cues (fur marks, dye) would add a column here.
 */

/**
 * The per-identity rows, for this dialog and for Track All's first-use dialog.
 * @param {string[]} names  identity names, in order
 * @param {?Object<string, number>} counts  current bands per name
 * @returns {{element: HTMLElement, read: () => ({counts: Object<string, number>} | {error: string})}}
 */
export function buildBandCountFields(names, counts) {
    var element = document.createElement('div');
    element.className = 'settings-node-weight-list identity-marks-list';
    var inputs = names.map(function (name, i) {
        var row = document.createElement('label');
        row.className = 'settings-node-weight-row';
        var label = document.createElement('span');
        label.className = 'settings-kbd-label';
        label.textContent = name;
        var input = document.createElement('input');
        input.type = 'number';
        input.className = 'settings-num-input';
        input.min = '0';
        input.max = '9';
        input.step = '1';
        input.dataset.identity = name;
        input.value = String(counts && counts[name] != null ? counts[name] : i);
        input.setAttribute('aria-label', 'Tail bands on ' + name);
        row.appendChild(label);
        row.appendChild(input);
        element.appendChild(row);
        return input;
    });
    function read() {
        var out = {};
        for (var i = 0; i < inputs.length; i++) {
            var v = inputs[i].value.trim() === '' ? NaN : Number(inputs[i].value);
            if (!Number.isInteger(v) || v < 0 || v > 9) return { error: 'Bands on ' + names[i] + ' must be a whole number from 0 to 9.' };
            out[names[i]] = v;
        }
        var distinct = new Set(Object.keys(out).map(function (k) { return out[k]; }));
        if (distinct.size < 2) return { error: 'At least two identities need different numbers of bands.' };
        return { counts: out };
    }
    return { element: element, read: read };
}

/**
 * Ask for each identity's number of tail bands. Resolves `{counts}` on Save, or null
 * on Cancel / Esc / a backdrop click.
 * @param {string[]} names
 * @param {?Object<string, number>} counts
 * @returns {Promise<?{counts: Object<string, number>}>}
 */
export function showIdentityMarksModal(names, counts) {
    if (document.querySelector('.identity-marks-modal')) return Promise.resolve(null);
    return new Promise(function (resolve) {
        var overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay';
        var modal = document.createElement('div');
        modal.className = 'multi-frame-modal track-setup-modal identity-marks-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        var h = document.createElement('h3');
        h.textContent = 'Tail bands per identity';
        modal.appendChild(h);
        var p = document.createElement('p');
        p.className = 'track-setup-note';
        p.textContent = 'How many dark bands each animal has at the base of its tail (0 = plain). After Track All, ' +
            'the tails are read in every camera and each identity keeps the animal with its bands.';
        modal.appendChild(p);
        var fields = buildBandCountFields(names, counts);
        modal.appendChild(fields.element);
        var errorEl = document.createElement('div');
        errorEl.className = 'modal-error';
        modal.appendChild(errorEl);
        var actions = document.createElement('div');
        actions.className = 'modal-actions';
        var cancel = document.createElement('button');
        cancel.textContent = 'Cancel';
        var save = document.createElement('button');
        save.className = 'primary';
        save.id = 'identityMarksSave';
        save.textContent = 'Save';
        actions.appendChild(cancel);
        actions.appendChild(save);
        modal.appendChild(actions);
        overlay.appendChild(modal);

        var done = false;
        function finish(answer) {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(answer);
        }
        function submit() {
            var r = fields.read();
            if (r.error) { errorEl.textContent = r.error; return; }
            finish({ counts: r.counts });
        }
        function onKey(e) {
            if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(null); }
            else if (e.key === 'Enter' && e.target !== cancel) { e.preventDefault(); e.stopPropagation(); submit(); }
        }
        document.addEventListener('keydown', onKey, true);
        modal.addEventListener('input', function () { var r = fields.read(); errorEl.textContent = r.error || ''; save.disabled = !!r.error; });
        cancel.addEventListener('click', function () { finish(null); });
        save.addEventListener('click', submit);
        overlay.addEventListener('click', function (e) { if (e.target === overlay) finish(null); });
        document.body.appendChild(overlay);
        var first = modal.querySelector('input');
        if (first) { first.focus(); first.select(); }
    });
}
