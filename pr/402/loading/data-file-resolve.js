// data-file-resolve.js — settle, for every camera of every session being
// loaded, which data file it loads (#413 / #414 / #214).
//
// Used by the per-camera folder loaders BEFORE anything is loaded, so Cancel
// leaves the app exactly as it was: `handleLoadSessionFolderPerCamera` for one
// session, and `handleLoadMultiSession` for all of its sessions at once (one
// dialog, one tab per session).
//
// Per camera, in order:
//   1. A choice saved in this browser for this session folder + camera
//      directory (`loading/data-file-choices.js`) is used as long as that file
//      is still there — files added since are ignored on purpose. A saved file
//      that has gone missing puts the camera in the dialog, marked red.
//   2. Otherwise `planCameraDataFile` (`loading/percam-slp-choice.js`) decides
//      if there is nothing to decide: one file, or only `.slp` files with the
//      newest LUC3D export newest overall. For that it needs each `.slp`'s
//      LUC3D export time, read from the files' provenance in one worker
//      (`readSlpProvenances`, the `metadata` attribute only) for folders that
//      hold more than one file.
//   3. Anything else goes to the dialog (`ui/data-file-chooser.js`) with a
//      default selected. "Save Options" saves the rows the user had to decide
//      or changed; rows the rule settled stay automatic.

import { readSlpProvenances } from '../import-export/file-io.js?v=9aab3ba0af2d';
import { lucidExportedAt } from '../import-export/slp-provenance.js?v=9aab3ba0af2d';
import { planCameraDataFile } from './percam-slp-choice.js?v=9aab3ba0af2d';
import { savedDataFileChoices, saveDataFileChoices, applySavedChoice } from './data-file-choices.js?v=9aab3ba0af2d';
import { showDataFileChooser, dataFileKindLabel } from '../ui/data-file-chooser.js?v=9aab3ba0af2d';

/**
 * @param {Array<{key: string, title: string, folderName: string|null,
 *     cameras: Array<{camName: string, dirName: string, videoName: string|null,
 *                     files: File[]}>}>} plans
 *   One per session; `files` are a camera folder's `.slp`/`.h5` files (no
 *   `.externals.`). Cameras with no files may be listed; they load nothing.
 * @param {{onAsk?: Function, onAnswered?: Function, ask?: Function}} [opts]
 *   `onAsk` runs just before the dialog opens (e.g. hide the loading card),
 *   `onAnswered` just after it closes with an answer. `ask` replaces the dialog
 *   (tests).
 * @returns {Promise<Object|null>} null when the user cancelled; otherwise
 *   `{ [key]: { files: {camName: File|null}, how: {camName: 'auto'|'saved'|'chosen'},
 *               chosen: {camName: 'dir/file'|null}, asked: boolean } }` where
 *   `chosen` holds the cameras whose file the user decided (now or before) —
 *   what a saved project carries as `metadata.lucid.dataFileChoices`.
 */
export async function resolveDataFiles(plans, opts) {
    opts = opts || {};

    // 1. LUC3D export times, only where a folder has a choice to make.
    var stampCandidates = [];
    plans.forEach(function (p) {
        p.cameras.forEach(function (c) {
            if ((c.files || []).length < 2) return;
            c.files.forEach(function (f) { if (/\.slp$/i.test(f.name)) stampCandidates.push(f); });
        });
    });
    var stampByFile = new Map();
    if (stampCandidates.length > 0) {
        var provs = await readSlpProvenances(stampCandidates);
        for (var i = 0; i < stampCandidates.length; i++) stampByFile.set(stampCandidates[i], lucidExportedAt(provs[i]));
    }
    var exportedAt = function (f) { var t = stampByFile.get(f); return t === undefined ? NaN : t; };

    // 2. Decide what can be decided.
    var result = {};
    var dialogSessions = [];
    var anyAttention = false;
    plans.forEach(function (p) {
        var saved = savedDataFileChoices(p.folderName);
        var res = { files: {}, how: {}, chosen: {}, asked: false };
        result[p.key] = res;
        var rows = [];
        p.cameras.forEach(function (c) {
            var files = c.files || [];
            if (files.length === 0) { res.files[c.camName] = null; return; }
            var plan = planCameraDataFile(files, { exportedAt: exportedAt });
            var sv = applySavedChoice(saved, c.dirName, files);
            var row = {
                camName: c.camName, dirName: c.dirName, videoName: c.videoName || null,
                plan: plan, attention: false, missingName: null, how: 'auto', initial: null,
            };
            if (sv.state === 'use') {
                row.how = 'saved'; row.initial = sv.file;
            } else if (sv.state === 'missing') {
                row.missingName = sv.name; row.initial = plan.defaultFile; anyAttention = true;
            } else if (plan.needsChoice) {
                row.attention = true; row.initial = plan.defaultFile; anyAttention = true;
            } else {
                row.initial = plan.auto;
            }
            rows.push(row);
        });
        dialogSessions.push({ plan: p, res: res, rows: rows });
    });

    // 3. Ask, if anything needs it.
    var answers = null;
    if (anyAttention) {
        // The dialog lists every camera, so label the files of one-file
        // cameras too (their stamp was not needed to decide): a LUC3D export
        // reads as one, not as "SLEAP file".
        var lateStamp = [];
        dialogSessions.forEach(function (d) {
            d.rows.forEach(function (r) {
                r.plan.options.forEach(function (o) {
                    if (/\.slp$/i.test(o.file.name) && !stampByFile.has(o.file)) lateStamp.push(o.file);
                });
            });
        });
        if (lateStamp.length > 0) {
            var lateProvs = await readSlpProvenances(lateStamp);
            for (var li = 0; li < lateStamp.length; li++) stampByFile.set(lateStamp[li], lucidExportedAt(lateProvs[li]));
            dialogSessions.forEach(function (d) {
                d.rows.forEach(function (r) {
                    if (r.plan.reason !== 'single') return;   // only these were planned without stamps
                    var replan = planCameraDataFile(r.plan.options.map(function (o) { return o.file; }), { exportedAt: exportedAt });
                    r.plan = replan;
                });
            });
        }
        var shown = dialogSessions.filter(function (d) { return d.rows.length > 0; });
        var payload = shown.map(function (d) {
            return {
                key: d.plan.key,
                title: d.plan.title,
                rows: d.rows.map(function (r) {
                    var options = r.plan.options.map(function (o, oi) {
                        // Kind first: the names share the video's long stem,
                        // so a clipped drop-down still shows what each file is.
                        return { value: String(oi), label: dataFileKindLabel(o) + ' — ' + o.file.name };
                    });
                    var initialIdx = r.initial ? r.plan.options.findIndex(function (o) { return o.file === r.initial; }) : -1;
                    return {
                        camName: r.camName, videoName: r.videoName, options: options,
                        value: initialIdx >= 0 ? String(initialIdx) : '',
                        attention: r.attention, missingName: r.missingName,
                    };
                }),
            };
        });
        if (opts.onAsk) opts.onAsk();
        answers = await (opts.ask || showDataFileChooser)(payload);
        if (!answers) return null;
        if (opts.onAnswered) opts.onAnswered();
    }

    // 4. Settle every row, and remember what the user decided.
    dialogSessions.forEach(function (d) {
        var toSave = {};
        var nSave = 0;
        d.rows.forEach(function (r) {
            var file = r.initial;
            var how = r.how;
            var ans = answers && answers[d.plan.key] ? answers[d.plan.key][r.camName] : undefined;
            if (ans !== undefined) {
                var picked = ans === '' ? null : (r.plan.options[Number(ans)] || {}).file || null;
                var decided = r.attention || r.missingName || picked !== r.initial;
                if (decided) {
                    file = picked;
                    how = 'chosen';
                    toSave[r.dirName] = picked ? picked.name : null;
                    nSave++;
                }
                d.res.asked = true;
            }
            d.res.files[r.camName] = file;
            d.res.how[r.camName] = how;
            if (how === 'saved' || how === 'chosen') {
                d.res.chosen[r.camName] = file ? r.dirName + '/' + file.name : null;
            }
            console.log('[data-files] ' + (d.plan.title || d.plan.key) + ' / ' + r.camName + ': '
                + (file ? '"' + file.name + '"' : 'no data file') + ' (' + how
                + (how === 'auto' ? ', ' + r.plan.reason : '') + ')');
        });
        if (nSave > 0) saveDataFileChoices(d.plan.folderName, toSave);
    });
    return result;
}
