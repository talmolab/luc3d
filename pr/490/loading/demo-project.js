// loading/demo-project.js — File ▸ Open Demo: a 15 s, 8-camera SLAP-2M clip
// fetched from Hugging Face and loaded as a session folder.
//
// The clip lives in the `demo/` folder of the talmolab/slap-2m dataset (its
// README there says where it was cut from). It is fetched from ONE commit
// (`DEMO_REVISION`), so a later upload to the dataset changes nothing until the
// pin here moves. Every file is fetched whole (24 MB in all), wrapped as a File
// with a `webkitRelativePath`, and handed to the per-camera session-folder
// loader exactly as a picked folder would be: the demo exercises the same path
// as a user's own data, and nothing about it is special once loaded.
//
// Hugging Face answers cross-origin requests (`Access-Control-Allow-Origin`),
// so this works from every deployed channel. It does NOT work offline (the
// files are not in the offline bundle); it then fails with a status message.

import { state } from '../ui/app-state.js?v=0b5f1d0b4e7d';
import { handleLoadSessionFolderPerCamera } from './session-loader.js?v=0b5f1d0b4e7d';
import { newProject, setStatus, showLoading, hideLoading } from '../import-export/save-load.js?v=0b5f1d0b4e7d';
import { showLoadingProgress } from '../ui/loading-overlay.js?v=0b5f1d0b4e7d';
import { setPageProject } from '../ui/page-title.js?v=0b5f1d0b4e7d';

/** The Hugging Face commit of talmolab/slap-2m the demo is read from. */
export const DEMO_REVISION = '683b01330e775cb9a7e4bf5080f2284e9e189509';

/** Where the demo's files are, with a trailing slash. */
export const DEMO_BASE_URL =
    'https://huggingface.co/datasets/talmolab/slap-2m/resolve/' + DEMO_REVISION + '/demo/';

/** The folder name the loader sees, and the project's name in the tab title. */
export const DEMO_PROJECT_NAME = 'SLAP-2M demo';

/**
 * The demo folder's files, relative to `DEMO_BASE_URL`, with their sizes in
 * bytes (the progress bar's total before any response arrives).
 */
export const DEMO_FILES = [
    ['calibration.toml', 2950],
    ['back/back.mp4', 2468493], ['back/back.slp', 443588],
    ['backL/backL.mp4', 2852763], ['backL/backL.slp', 443588],
    ['mid/mid.mp4', 2583791], ['mid/mid.slp', 443588],
    ['midL/midL.mp4', 3109598], ['midL/midL.slp', 443588],
    ['side/side.mp4', 2655266],
    ['sideL/sideL.mp4', 2627474],
    ['top/top.mp4', 2879340], ['top/top.slp', 443588],
    ['topL/topL.mp4', 2896852], ['topL/topL.slp', 443588],
];

/** Files fetched at once. */
const FETCH_CONCURRENCY = 4;

/**
 * Fetch every file of the demo, counting bytes as they arrive.
 *
 * @param {string} baseUrl  with a trailing slash
 * @param {function(number, number)} onBytes  (done, total) after each chunk
 * @param {typeof fetch} [fetchFn]
 * @returns {Promise<File[]>} each with `webkitRelativePath` = `<DEMO_PROJECT_NAME>/<path>`
 */
export async function fetchDemoFiles(baseUrl, onBytes, fetchFn) {
    var doFetch = fetchFn || fetch;
    var total = DEMO_FILES.reduce(function (s, f) { return s + f[1]; }, 0);
    var got = new Array(DEMO_FILES.length).fill(0);
    var files = new Array(DEMO_FILES.length);
    function report() {
        var done = got.reduce(function (s, n) { return s + n; }, 0);
        if (onBytes) onBytes(Math.min(done, total), total);
    }

    async function one(i) {
        var rel = DEMO_FILES[i][0];
        var resp = await doFetch(baseUrl + rel);
        if (!resp.ok) throw new Error('could not download ' + rel + ' (HTTP ' + resp.status + ')');
        var parts = [];
        if (resp.body && resp.body.getReader) {
            var reader = resp.body.getReader();
            for (;;) {
                var r = await reader.read();
                if (r.done) break;
                parts.push(r.value);
                got[i] += r.value.byteLength;
                report();
            }
        } else {
            var buf = await resp.arrayBuffer();
            parts.push(buf);
            got[i] = buf.byteLength;
            report();
        }
        var name = rel.slice(rel.lastIndexOf('/') + 1);
        var type = name.endsWith('.mp4') ? 'video/mp4' : '';
        var file = new File(parts, name, { type: type });
        Object.defineProperty(file, 'webkitRelativePath', { value: DEMO_PROJECT_NAME + '/' + rel });
        files[i] = file;
    }

    var next = 0;
    async function worker() {
        while (next < DEMO_FILES.length) await one(next++);
    }
    var workers = [];
    for (var w = 0; w < Math.min(FETCH_CONCURRENCY, DEMO_FILES.length); w++) workers.push(worker());
    await Promise.all(workers);
    return files;
}

/**
 * File ▸ Open Demo. Replaces an open project (after asking), downloads the
 * clip, and loads it as a session folder.
 *
 * @param {Object} [opts]
 * @param {string} [opts.baseUrl]  another copy of the demo folder (tests)
 * @returns {Promise<boolean>} true once the demo is loaded
 */
export async function loadDemoProject(opts) {
    opts = opts || {};
    if (state.session || state.views.length > 0) {
        if (!confirm('Close the open project and open the demo?' +
            (state.isDirty ? ' Unsaved changes will be lost.' : ''))) return false;
    }
    newProject(true);

    var files;
    try {
        showLoading('Downloading the demo…');
        files = await fetchDemoFiles(opts.baseUrl || DEMO_BASE_URL, function (done, total) {
            showLoadingProgress('Downloading', Math.round(done / 1e5) / 10, Math.round(total / 1e5) / 10, {
                unit: 'MB', title: 'Opening the demo',
                detail: '15 s of SLAP-2M, 8 cameras, from Hugging Face',
            });
        });
    } catch (err) {
        console.error('[demo] download failed:', err);
        hideLoading();
        setStatus('Could not download the demo (' + err.message + '). It needs an internet connection.', 'error');
        return false;
    }
    await handleLoadSessionFolderPerCamera(files);
    if (!state.session) return false;
    setPageProject(DEMO_PROJECT_NAME);
    return true;
}
