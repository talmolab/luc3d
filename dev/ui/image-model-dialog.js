/**
 * ui/image-model-dialog.js — which model the image ID-switch check uses for a
 * session: the built-in one, or a model PACKAGE (pose/image-model-manifest.js),
 * typically one fine-tuned on this rig's own recordings.
 *
 * The choice is per session (`Session.imageModel`, saved in the project as
 * `metadata.lucid.imageModel` only when it is not the built-in model). A
 * package's files are not saved in the project: a package from a URL reloads by
 * itself; one from a local folder has to be picked again after a reload, and the
 * check says so rather than falling back to another model.
 *
 * The ID Switches tab shows the model in use with a "Change…" button
 * (`imageModelLineHtml` / `wireImageModelLine`), which opens the dialog
 * (`showImageModelDialog`). Esc, Cancel and a backdrop click leave everything
 * as it was; "Use this model" sets the session's choice and marks the project
 * dirty.
 *
 * Depends on: ui/image-model-package.js, pose/image-model-manifest.js,
 * ui/image-embedder.js (BUILTIN_IMAGE_MODEL), import-export/save-load.js (markDirty).
 */

import { BUILTIN_IMAGE_MODEL } from './image-embedder.js?v=5d43d4fc53a2';
import {
    loadModelPackageFromFiles, loadModelPackageFromUrl, registeredModelPackage, registeredModelPackages,
} from './image-model-package.js?v=5d43d4fc53a2';
import { modelChoiceOf } from '../pose/image-model-manifest.js?v=5d43d4fc53a2';
import { markDirty } from '../import-export/save-load.js?v=5d43d4fc53a2';

function escapeHtml(s) {
    return String(s).replace(/[&<>"']/g, function (c) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
}
const minus = function (v) { return String(v).replace('-', '−'); };

/**
 * The package `session` uses, loaded: null for the built-in model. A saved URL
 * choice not loaded on this page is fetched again (its key must still match);
 * a saved folder choice not loaded throws an Error whose message is the reason
 * the check gives.
 * @returns {Promise<?Object>}
 */
export async function resolveSessionImageModel(session) {
    const choice = session && session.imageModel;
    if (!choice) return null;
    const have = registeredModelPackage(choice.key);
    if (have) return have;
    if (choice.url) {
        let pkg;
        try { pkg = await loadModelPackageFromUrl(choice.url); }
        catch (e) { throw new Error('could not load this session\'s image model "' + choice.name + '" from ' + choice.url + ': ' + ((e && e.message) || e)); }
        if (pkg.key !== choice.key) {
            throw new Error('the image model at ' + choice.url + ' has changed since this session chose it ("' + choice.name +
                '"): choose it again in the ID Switches tab (Image model ▸ Change…)');
        }
        return pkg;
    }
    throw new Error('this session uses the image model "' + choice.name + '"' + (choice.folder ? ' (folder ' + choice.folder + ')' : '') +
        ', which is not loaded: in the ID Switches tab, Image model ▸ Change… ▸ Load package folder…, or go back to the built-in model');
}

/** One line for the ID Switches tab: the session's image model and a Change… button. */
export function imageModelLineHtml(session) {
    const choice = session && session.imageModel;
    const name = choice ? choice.name : BUILTIN_IMAGE_MODEL.name;
    const missing = choice && !registeredModelPackage(choice.key) && !choice.url;
    return '<div class="image-model-line">Image model: <b>' + escapeHtml(name) + '</b>' +
        (choice ? ' · flags below ' + escapeHtml(minus(choice.threshold)) : '') +
        (missing ? ' <span class="image-model-missing">(not loaded)</span>' : '') +
        ' <button class="panel-btn image-model-change" type="button">Change…</button></div>';
}

/** Wire the line's button; `onChanged()` runs after the choice changed. */
export function wireImageModelLine(host, session, onChanged) {
    const b = host && host.querySelector('.image-model-change');
    if (b) b.addEventListener('click', function () {
        showImageModelDialog(session).then(function (changed) { if (changed && onChanged) onChanged(); });
    });
}

function describe(pkg) {
    if (pkg.builtin) {
        return [['Model', 'DINOv3 ViT-S/16, frozen (not trained on your recordings)'], ['License', pkg.license],
            ['Input', pkg.input + ' px'], ['Flag threshold', 'the Tracking Wizard\'s (Image check: flag threshold)']];
    }
    const rows = [['Trained from', pkg.base || '—'], ['License', pkg.license || '—'], ['Input', pkg.input + ' px'],
        ['Flag threshold', minus(pkg.threshold) + ' (the package\'s; the Wizard\'s applies to the built-in model)'],
        ['Precision', pkg.fp16 ? 'fp16 on GPUs that support it, else fp32' : 'fp32'],
        ['Source', pkg.source.kind === 'url' ? pkg.source.url : 'folder ' + (pkg.source.folder || '') + ' (pick it again after a reload)'],
        ['Key', pkg.key.slice(0, 16) + '…']];
    const flat = function (o) {
        return o ? Object.keys(o).map(function (k) { const v = o[k]; return k + ': ' + (v && typeof v === 'object' ? JSON.stringify(v) : String(v)); }).join('; ') : '';
    };
    if (pkg.manifest && pkg.manifest.training) rows.push(['Training', flat(pkg.manifest.training)]);
    if (pkg.manifest && pkg.manifest.validation) rows.push(['Validation', flat(pkg.manifest.validation)]);
    return rows;
}

/**
 * The dialog. Resolves true when the session's model changed, false otherwise.
 * `opts.pickFiles` (tests) stands in for the folder picker: returns a Promise of a File list.
 */
export function showImageModelDialog(session, opts) {
    opts = opts || {};
    if (!session || document.querySelector('.image-model-modal')) return Promise.resolve(false);
    return new Promise(function (resolve) {
        const choice = session.imageModel;
        let selected = choice ? (registeredModelPackage(choice.key) || null) : BUILTIN_IMAGE_MODEL;
        const overlay = document.createElement('div');
        overlay.className = 'multi-frame-modal-overlay';
        const modal = document.createElement('div');
        modal.className = 'multi-frame-modal image-model-modal';
        modal.setAttribute('role', 'dialog');
        modal.setAttribute('aria-modal', 'true');
        modal.setAttribute('aria-labelledby', 'imageModelTitle');
        modal.innerHTML = '<h3 id="imageModelTitle">Image model for the ID switch check</h3>' +
            '<p class="image-model-text">A model fine-tuned on this rig\'s own recordings tells its animals apart better than the built-in one; ' +
            'it does not help on other rigs. Load its package (a folder with lucid-model.json), from disk or a URL.</p>' +
            '<div class="image-model-list" role="radiogroup" aria-label="Image model"></div>' +
            '<div class="image-model-load"><button type="button" class="panel-btn" id="imageModelFolder">Load package folder…</button>' +
            '<input type="file" id="imageModelFolderInput" webkitdirectory hidden>' +
            '<input type="text" id="imageModelUrl" placeholder="owner/repo or https://…/package/" aria-label="Package URL or Hugging Face repo">' +
            '<button type="button" class="panel-btn" id="imageModelUrlLoad">Load from URL</button></div>' +
            '<dl class="image-model-details"></dl>' +
            '<div class="modal-error" id="imageModelError"></div>' +
            '<div class="modal-actions"><button id="imageModelCancel">Cancel</button><button id="imageModelUse" class="primary">Use this model</button></div>';
        overlay.appendChild(modal);
        const list = modal.querySelector('.image-model-list'), details = modal.querySelector('.image-model-details');
        const errorEl = modal.querySelector('#imageModelError'), useBtn = modal.querySelector('#imageModelUse');
        const folderInput = modal.querySelector('#imageModelFolderInput'), urlInput = modal.querySelector('#imageModelUrl');

        function render() {
            const pkgs = [BUILTIN_IMAGE_MODEL].concat(registeredModelPackages());
            let h = pkgs.map(function (p) {
                return '<label class="image-model-option"><input type="radio" name="imageModelPick" value="' + escapeHtml(p.key) + '"' +
                    (selected && selected.key === p.key ? ' checked' : '') + '> <b>' + escapeHtml(p.name) + '</b>' +
                    (p.builtin ? '' : ' <span class="image-model-sub">' + escapeHtml((p.base || '') + ' · ' + p.input + ' px · flags below ' + minus(p.threshold)) + '</span>') + '</label>';
            }).join('');
            if (choice && !registeredModelPackage(choice.key)) {
                h += '<div class="image-model-option image-model-missing">This session\'s model, <b>' + escapeHtml(choice.name) + '</b>' +
                    (choice.folder ? ' (folder ' + escapeHtml(choice.folder) + ')' : '') + ', is not loaded: load its package to use it.</div>';
            }
            list.innerHTML = h;
            list.querySelectorAll('input[type=radio]').forEach(function (r) {
                r.addEventListener('change', function () {
                    selected = r.value === BUILTIN_IMAGE_MODEL.key ? BUILTIN_IMAGE_MODEL : registeredModelPackage(r.value);
                    render();
                });
            });
            details.innerHTML = selected ? describe(selected).map(function (r) { return '<dt>' + escapeHtml(r[0]) + '</dt><dd>' + escapeHtml(r[1]) + '</dd>'; }).join('') : '';
            useBtn.disabled = !selected;
        }

        async function load(promise) {
            errorEl.textContent = '';
            modal.classList.add('is-busy');
            try { selected = await promise; render(); }
            catch (e) { errorEl.textContent = 'Could not load the model: ' + ((e && e.message) || e); }
            finally { modal.classList.remove('is-busy'); }
        }

        let done = false;
        function finish(changed) {
            if (done) return;
            done = true;
            document.removeEventListener('keydown', onKey, true);
            overlay.remove();
            resolve(changed);
        }
        function onKey(e) { if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); finish(false); } }
        document.addEventListener('keydown', onKey, true);
        modal.querySelector('#imageModelCancel').addEventListener('click', function () { finish(false); });
        overlay.addEventListener('click', function (e) { if (e.target === overlay) finish(false); });
        modal.querySelector('#imageModelFolder').addEventListener('click', function () {
            if (opts.pickFiles) { load(opts.pickFiles().then(function (files) { return loadModelPackageFromFiles(files, function (t) { errorEl.textContent = t; }); })); return; }
            folderInput.value = '';
            folderInput.click();
        });
        folderInput.addEventListener('change', function () {
            if (folderInput.files && folderInput.files.length) load(loadModelPackageFromFiles(folderInput.files, function (t) { errorEl.textContent = t; }));
        });
        const fromUrl = function () { if (urlInput.value.trim()) load(loadModelPackageFromUrl(urlInput.value)); };
        modal.querySelector('#imageModelUrlLoad').addEventListener('click', fromUrl);
        urlInput.addEventListener('keydown', function (e) { if (e.key === 'Enter') { e.preventDefault(); fromUrl(); } });
        useBtn.addEventListener('click', function () {
            if (!selected) return;
            const next = selected.builtin ? null : modelChoiceOf(selected);
            const before = session.imageModel ? session.imageModel.key : null, after = next ? next.key : null;
            session.imageModel = next;
            if (before !== after) markDirty();
            finish(before !== after);
        });

        render();
        document.body.appendChild(overlay);
        modal.querySelector('#imageModelCancel').focus();
    });
}
