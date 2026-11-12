/**
 * ui/connect/merge-predictions-dialog.js — Fetch & Load for one completed track job of the Jobs tab.
 *
 * Port of sleap-app src/components/connect/MergePredictionsDialog.tsx @ 683a159 (§5b.4): "Load predictions"
 * with a stage per state, the summary box (open project, skeleton check) and the choices. Its auto path is
 * kept: this project's job for a view of the open session merges at once through `fetchAndLoadJobs`
 * (mode recorded on the job, default Replace).
 *
 * LUCID changes:
 *  - "ours" = the tracked job's {sessionId, camera}; a job for ANOTHER session of the project is refused
 *    by name and offers only Download .slp;
 *  - an untagged job asks "Merge into view" (the view its paths name is preselected, else none and Merge
 *    waits), skeleton-checked first, Replace mode, then marked fetched;
 *  - no Open predictions; Download .slp goes through `downloadBytes`; Esc waits while merging.
 */
import { useConnectStore } from '../../pose/connect/store.js';
import { lucidProjectTag } from '../../pose/connect/project-tag.js';
import { state } from '../app-state.js';
import { parseSlpForImport } from '../../import-export/slp-import.js';
import { validateSkeletonCompatibility } from '../../import-export/slp-merge.js';
import { downloadBytes } from '../../import-export/file-io.js';
import { mergeViewPredictions } from '../inference-merge.js';
import { fetchAndLoadJobs, fetchJobPredictions, openProjectInfo } from './remote-inference.js';
import { notify } from './notify.js';
import { railIconSvg } from '../panel-rail-icons.js';
import { trapModal } from './layers.js';
import { el, button, errMsg } from './dom.js';

const DEFAULT_MODE = 'replace';
const NONE = 'No predictions were found for this job.';

/** The open session's view names ([] with none open). */
function sessionViews() {
    const s = state.session;
    return s && s.cameras ? s.cameras.map(function (c) { return c.name; }) : [];
}

/** sleap-app `shouldAutoMerge`, in LUCID's terms: this project's job for a view of the open session. */
function planFetchRoute(tracked, mine, session) {
    if (!tracked || tracked.camera === undefined || tracked.sessionId === undefined) return { kind: 'ask' };
    if (!session) return { kind: 'ask' };
    const tagId = lucidProjectTag(openProjectInfo()).id;
    const ours = mine || tracked.projectTag === tagId;
    if (!ours) return { kind: 'ask' };
    if (tracked.sessionId !== session.name) return { kind: 'other-session', sessionId: tracked.sessionId };
    if (sessionViews().indexOf(tracked.camera) === -1) return { kind: 'ask' };
    return { kind: 'auto' };
}

/**
 * Fetch & Load a completed track job. Resolves when the job is merged, the dialog closed, or it failed
 * (an error is toasted or shown in the dialog).
 *
 * @param {{workerId: string, jobId: string, mine: boolean}} o
 * @returns {Promise<void>}
 */
export async function loadJobPredictions(o) {
    const st = useConnectStore.getState();
    const tracked = st.trackedJobs.find(function (j) { return j.jobId === o.jobId && j.workerId === o.workerId; });
    const route = planFetchRoute(tracked, o.mine, state.session);
    if (route.kind === 'auto') {
        const lines = [];
        const r = await fetchAndLoadJobs([tracked], {
            mode: function (j) { return j.mergeMode || DEFAULT_MODE; },
            onLog: function (l) { lines.push(l); },
        });
        if (r.loaded) notify.success('Loaded. Predictions merged into ' + tracked.camera + '.');
        else if (!r.cancelled) notify.error('Fetch & Load failed', { description: (lines[lines.length - 1] || '').replace(/^✗ /, '') });
        return;
    }
    await openMergePredictionsDialog({ workerId: o.workerId, jobId: o.jobId, tracked: tracked, route: route });
}

/**
 * The dialog. Resolves when it is closed.
 * @param {{workerId: string, jobId: string, tracked?: any, route?: {kind: string, sessionId?: string}}} o
 * @returns {Promise<void>}
 */
function openMergePredictionsDialog(o) {
    return new Promise(function (resolve) {
        let closed = false;
        let stage = { kind: 'loading', text: 'Loading predictions…' };

        const scrim = el('div', 'cj-scrim');
        scrim.setAttribute('data-shortcut-modal', '1');
        const card = el('div', 'cj-card cj-merge');
        card.setAttribute('role', 'dialog');
        card.setAttribute('aria-modal', 'true');
        card.setAttribute('aria-label', 'Load predictions');
        card.tabIndex = -1;
        const head = el('div', 'cj-card-head');
        const titleRow = el('div', 'cj-card-title');
        titleRow.append(el('span', 'cj-card-title-text', 'Load predictions'));
        const x = button('cj-card-x', undefined, 'Close'); x.setAttribute('aria-label', 'Close');
        x.innerHTML = railIconSvg('x');
        titleRow.appendChild(x);
        const desc = el('p', 'cj-card-desc');
        head.append(titleRow, desc);
        const body = el('div', 'cj-merge-body');
        card.append(head, body);
        scrim.appendChild(card);

        let file = null, slpData = null, jobLabelsPath = null, skeleton = null, viewSelect = null, chosenView = null;

        function spinner(text) {
            const r = el('div', 'cj-merge-wait');
            const i = el('span', 'cj-spin'); i.innerHTML = railIconSvg('loader-circle');
            r.append(i, text);
            return r;
        }

        function render() {
            if (closed) return;
            body.textContent = '';
            desc.textContent = '';
            if (stage.kind === 'ready') {
                desc.append('From inference on ');
                desc.appendChild(el('span', 'cj-mono', jobLabelsPath || 'this job'));
            }
            if (stage.kind === 'loading' || stage.kind === 'merging') { body.appendChild(spinner(stage.text)); return; }
            if (stage.kind === 'error') { body.appendChild(el('p', 'cj-merge-error', stage.message)); return; }

            const session = state.session;
            const views = sessionViews();
            const box = el('div', 'cj-merge-box');
            const proj = openProjectInfo();
            box.appendChild(el('span', null, session ? 'Open project: ' + (proj.fileName || 'untitled.slp') : 'No project open'));
            if (o.route && o.route.kind === 'other-session') {
                box.appendChild(el('span', null, '! These results are for session ' + o.route.sessionId + '. Switch to it to merge them.'));
            } else if (session) {
                const ok = !skeleton || !skeleton.error;
                const line = el('span', 'cj-merge-line');
                line.append(el('span', ok ? 'cj-ok' : 'cj-warn', ok ? '✓' : '!'), skeleton && skeleton.error ? skeleton.error : 'Skeleton matches');
                box.appendChild(line);
            }
            if (slpData) {
                const names = predVideoNames();
                const nf = slpData.frames ? slpData.frames.length : 0;
                box.appendChild(el('span', 'cj-merge-preds', 'Predictions: ' + (names.length ? names.join(', ') : 'no video name') + ' \u00b7 ' + nf.toLocaleString('en-US') + (nf === 1 ? ' frame' : ' frames')));
            }
            body.appendChild(box);

            const canMerge = !!session && views.length > 0 && !(o.route && o.route.kind === 'other-session') && !(skeleton && skeleton.error);
            const row = el('div', 'cj-merge-actions');
            if (canMerge) {
                const lab = el('label', 'cj-merge-pick', 'Merge into view ');
                viewSelect = el('select', 'cj-select');
                viewSelect.id = 'cjMergeView';
                views.forEach(function (v) { const op = el('option', null, v); op.value = v; viewSelect.appendChild(op); });
                const pick = chosenView && views.indexOf(chosenView) !== -1 ? chosenView : guessView(views);
                // No view name matches the predictions' video: nothing is preselected, the user must pick one.
                if (!pick) {
                    const ph = el('option', null, 'Choose a view\u2026'); ph.value = ''; ph.disabled = true;
                    viewSelect.insertBefore(ph, viewSelect.firstChild);
                    body.appendChild(el('p', 'cj-merge-warn', '! No view of this session matches the predictions\u2019 video. Choose the view they belong to.'));
                }
                viewSelect.value = pick || '';
                lab.appendChild(viewSelect);
                body.appendChild(lab);
                const mergeBtn = button('connect-btn connect-btn-primary', 'Merge into view');
                mergeBtn.id = 'cjMergeGo';
                mergeBtn.disabled = !viewSelect.value;
                viewSelect.addEventListener('change', function () { mergeBtn.disabled = !viewSelect.value; });
                mergeBtn.addEventListener('click', function () { if (viewSelect.value) void doMerge(viewSelect.value); });
                row.appendChild(mergeBtn);
            } else if (!session) {
                row.appendChild(el('span', 'cj-muted', 'Open a project to merge these predictions, or download them.'));
            }
            const dl = button('connect-btn connect-btn-outline', 'Download .slp');
            dl.id = 'cjMergeDownload';
            dl.addEventListener('click', doDownload);
            row.appendChild(dl);
            body.appendChild(row);
        }

        /** The predictions' video file names (base names). */
        function predVideoNames() {
            return ((slpData && slpData.videos) || []).map(function (v) {
                const f = String(v.filename || v.path || '');
                return f.split(/[\\/]/).pop();
            }).filter(Boolean);
        }

        /** The view whose name the job's labels / output path / predictions video mention (longest wins), else null: the user must pick. */
        function guessView(views) {
            const hay = [jobLabelsPath || ''].concat(((slpData && slpData.videos) || []).map(function (v) { return String(v.filename || v.path || ''); }))
                .join(' ').toLowerCase();
            const hit = views.filter(function (v) { return hay.indexOf(v.toLowerCase()) !== -1; })
                .sort(function (a, b) { return b.length - a.length; })[0];
            return hit || null;
        }

        async function doMerge(view) {
            if (!file || stage.kind !== 'ready') return;
            chosenView = view;
            stage = { kind: 'merging', text: 'Merging…' };
            render();
            try {
                const r = await mergeViewPredictions(file, view, DEFAULT_MODE);
                useConnectStore.getState().markJobFetched(o.jobId);
                notify.success('Loaded. Merged ' + r.instances.toLocaleString('en-US') + ' predicted instances into ' + view + '.');
                close();
            } catch (err) {
                notify.error('Merge failed', { description: errMsg(err) });
                stage = { kind: 'ready' };
                render();
            }
        }

        async function doDownload() {
            if (!file) return;
            try {
                downloadBytes(new Uint8Array(await file.arrayBuffer()), o.jobId + '.predictions.slp');
            } catch (err) {
                notify.error('Download failed', { description: errMsg(err) });
            }
        }

        function close() {
            if (closed) return;
            closed = true;
            trap.release();
            scrim.remove();
            trap.restoreFocus();
            resolve();
        }
        x.addEventListener('click', close);
        scrim.addEventListener('mousedown', function (e) { if (e.target === scrim) close(); });
        // Esc waits while a merge runs.
        const trap = trapModal(scrim, card, { onEscape: function () { if (stage.kind !== 'merging') close(); } });
        document.body.appendChild(scrim);
        render();
        card.focus();

        (async function load() {
            try {
                const mb = function (b) { return Math.round(b / 1048576 * 10) / 10; };
                const got = await fetchJobPredictions(o.workerId, o.jobId, {
                    name: o.jobId,
                    onProgress: function (done, total) {
                        if (closed) throw new Error('Cancelled');
                        stage = { kind: 'loading', text: 'Loading predictions… ' + mb(done) + ' / ' + mb(total) + ' MB' };
                        render();
                    },
                });
                if (closed) return;
                file = got.file;
                jobLabelsPath = got.detail && got.detail.labelsPath ? got.detail.labelsPath : null;
                if (state.session && !(o.route && o.route.kind === 'other-session')) {
                    slpData = await parseSlpForImport(file, function () {});
                    const incoming = slpData.skeleton || { nodes: [] };
                    skeleton = validateSkeletonCompatibility(state.session.skeleton, { nodes: incoming.nodes || [] });
                    if (skeleton.error) skeleton = { error: 'Skeleton mismatch: ' + skeleton.error };
                }
                if (closed) return;
                stage = { kind: 'ready' };
                render();
            } catch (err) {
                if (closed) return;
                const m = errMsg(err);
                stage = { kind: 'error', message: /no predictions file/.test(m) ? NONE : m };
                render();
            }
        })();
    });
}
