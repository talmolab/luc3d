/**
 * _diag-export-bycam-timing.js — where File ▸ Export SLEAP File By Cam spends
 * its time, measured in a REAL page on real data (investigation tool, not an
 * assertion). Load it into a running LUC3D page (deployed or local):
 *
 *     await import('./tests/e2e/_diag-export-bycam-timing.js')   // local server; sets window.__exportBench
 *
 * The deployed site never serves it (gh-pages has no .nojekyll, so Jekyll drops
 * `_` files): load it from jsDelivr at a commit instead,
 *     await import('https://cdn.jsdelivr.net/gh/talmolab/luc3d@<full sha>/tests/e2e/_diag-export-bycam-timing.js')
 *
 * Imports nothing relative (tests/e2e/ is not version-stamped); it reaches the
 * app's own module instances through the page's modulepreload URLs, so it never
 * loads a second copy of a module.
 *
 *   __exportBench.env()            the machine and the open project
 *   __exportBench.recordClicks()   then click Download All as a user would; records
 *                                  the progress card (#429) or the button text (/dev/)
 *   __exportBench.clickReport()    per camera: find folder / build / save, seconds
 *   __exportBench.buildAll(opts)   builds every camera's file in memory, NO disk
 *                                  write, in the background: poll __exportBench.status()
 *                                  opts: {predicted=true, reproj=true, reprojAs='user', cams}
 *   __exportBench.writeTest(opts)  times writing the last built file (or `mb` MB of
 *                                  random bytes) into the folder Download All was
 *                                  given (state.exportDirHandle), in the folder itself
 *                                  and in its first camera folder; removes its own files.
 *                                  opts: {mb, repeats=2}
 */
(function () {
    var now = function () { return performance.now(); };
    var S = function () { return window.__lucid.state; };
    var round = function (ms) { return Math.round(ms) / 1000; };

    /** The app's own instance of a module (its stamped URL when deployed). */
    function modUrl(rel) {
        var links = document.querySelectorAll('link[rel=modulepreload]');
        for (var i = 0; i < links.length; i++) if (links[i].href.indexOf('/' + rel) >= 0) return links[i].href;
        return new URL(rel, document.baseURI).href;   // local, unstamped
    }
    function fileIO() { return import(modUrl('import-export/file-io.js')); }

    function env() {
        var st = S(), s = st.session;
        var loader = s && s.lazyLoader;
        return {
            url: location.href,
            build: (document.querySelector('meta[name=lucid-commit]') || {}).content || '(local)',
            ua: navigator.userAgent, cores: navigator.hardwareConcurrency, deviceMemoryGB: navigator.deviceMemory,
            jsHeapLimitMB: performance.memory ? Math.round(performance.memory.jsHeapSizeLimit / 1048576) : null,
            sessions: (st.sessions || []).length,
            cameras: s ? s.cameras.map(function (c) { return c.name; }) : [],
            lazy: !!loader,
            frames: loader ? loader.nFrames : (s ? s.frameGroups.size : 0),
            residentFrames: s ? s.frameGroups.size : 0,
            videoFiles: (st.videoFiles || []).map(function (v) {
                return { cam: v.assignedCamera, path: v.videoPath || (v.file && v.file.name), slp: v.slpFilename || null };
            }),
            hasProjectFile: !!st.slpFileHandle,
        };
    }

    // ---- what a real click does, as the user sees it --------------------------
    var log = null, obs = null;
    function recordClicks() {
        log = [];
        if (obs) obs.disconnect();
        var last = '';
        var snap = function () {
            var ov = document.getElementById('loadingOverlay');
            var shown = ov && !ov.classList.contains('hidden');
            var st = shown ? (document.getElementById('loadingStatus') || {}).textContent : '';
            var sub = shown ? (document.getElementById('loadingSubstatus') || {}).textContent : '';
            var btn = document.getElementById('slpByCamDownloadAll');
            var bt = btn ? btn.textContent : '';
            var key = shown + '|' + st + '|' + sub + '|' + bt;
            if (key === last) return;
            last = key;
            log.push({ t: now(), shown: shown, status: st, sub: sub, button: bt });
        };
        obs = new MutationObserver(snap);
        obs.observe(document.body, { subtree: true, childList: true, characterData: true, attributes: true, attributeFilter: ['class'] });
        return 'recording — click Download All now; then __exportBench.clickReport()';
    }
    /** Phase of one log entry: find / build / save / other, and its camera step. */
    function phaseOf(e) {
        var m = /Step (\d+) of (\d+)/.exec(e.sub || '');
        var step = m ? +m[1] : null;
        if (/^Reading \d+ cameras?/.test(e.status)) return { step: step, phase: 'sweep (all cameras)' };
        if (/^Finding /.test(e.status)) return { step: step, phase: 'find' };
        if (/^Saving /.test(e.status)) return { step: step, phase: 'save' };
        if (/^Writing /.test(e.status) || /: [\d,]+\/[\d,]+ frames/.test(e.status)) return { step: step, phase: 'build' };
        var b = /Downloading\.\.\. \((\d+)\/(\d+)\)/.exec(e.button || '');
        if (b && !e.shown) return { step: +b[1], phase: 'camera (dev: build+save)' };
        return { step: null, phase: null };
    }
    function clickReport() {
        if (!log || log.length < 2) return 'nothing recorded';
        var rows = {}, order = [];
        var first = null, lastT = log[log.length - 1].t;
        for (var i = 0; i < log.length; i++) {
            var p = phaseOf(log[i]);
            if (!p.phase) continue;
            if (first === null) first = log[i].t;
            var end = i + 1 < log.length ? log[i + 1].t : lastT;
            var k = p.step + '';
            if (!rows[k]) { rows[k] = { step: p.step }; order.push(k); }
            rows[k][p.phase] = round((rows[k][p.phase] || 0) * 1000 + (end - log[i].t));
        }
        return { totalSeconds: first === null ? null : round(lastT - first), perCamera: order.map(function (k) { return rows[k]; }), entries: log.length };
    }

    // ---- the in-memory build, per camera, with no disk write -------------------
    var run = null;
    function columns() {
        var st = S(), sessions = st.sessions || [], cols = {}, order = [];
        (st.videoFiles || []).forEach(function (vf) {
            var si = typeof vf.sessionIdx === 'number' ? vf.sessionIdx : 0, cam = vf.assignedCamera || vf.name;
            if (!cam || !sessions[si]) return;
            if (!cols[cam]) { cols[cam] = []; order.push(cam); }
            if (!cols[cam].some(function (x) { return x.session === sessions[si]; }))
                cols[cam].push({ session: sessions[si], cameraName: cam, videoFileInfo: vf });
        });
        if (!order.length && st.session) st.session.cameras.forEach(function (c) {
            order.push(c.name);
            cols[c.name] = [{ session: st.session, cameraName: c.name, videoFileInfo: { name: c.name } }];
        });
        return order.map(function (c) { return { cam: c, selections: cols[c] }; });
    }
    function buildAll(opts) {
        opts = opts || {};
        var predicted = opts.predicted !== false, reproj = opts.reproj !== false;
        var reprojAsUser = reproj ? (opts.reprojAs || 'user') === 'user' : null;
        var filter = { user: true, predicted: predicted, reprojected: reproj };
        var cols = columns();
        if (opts.cams) cols = cols.filter(function (c) { return opts.cams.indexOf(c.cam) >= 0; });
        run = { opts: { predicted: predicted, reproj: reproj, reprojAsUser: reprojAsUser }, done: false, err: null, cams: [], startedAt: now() };
        (async function () {
            try {
                var fio = await fileIO();
                for (var i = 0; i < cols.length; i++) {
                    var c = cols[i], row = { cam: c.cam, sessions: c.selections.length, frames: 0 };
                    run.current = c.cam;
                    var t0 = now();
                    var blob = await fio.exportSlpMultiSession(c.selections, reprojAsUser, filter, {
                        onProgress: function (done, total) { row.frames = done; row.total = total; },
                    });
                    row.seconds = round(now() - t0);
                    row.MB = +(blob.size / 1e6).toFixed(1);
                    row.path = row.total ? 'streaming sweep (frames counted)' : 'one step (store fast path or eager build)';
                    run.cams.push(row);
                    run.lastBlob = blob;
                    if (performance.memory) row.heapMB = Math.round(performance.memory.usedJSHeapSize / 1048576);
                }
            } catch (e) { run.err = String(e && e.stack || e).slice(0, 600); }
            run.done = true;
            run.totalSeconds = round(now() - run.startedAt);
        })();
        return 'started ' + cols.length + ' cameras — poll __exportBench.status()';
    }
    function status() {
        if (!run) return 'not started';
        return { done: run.done, err: run.err, current: run.done ? null : run.current, totalSeconds: run.totalSeconds || round(now() - run.startedAt), opts: run.opts, cams: run.cams };
    }

    // ---- the disk write alone --------------------------------------------------
    async function timeWrite(dir, name, blob) {
        var t0 = now();
        var fh = await dir.getFileHandle(name, { create: true });
        var t1 = now();
        var w = await fh.createWritable();
        var t2 = now();
        await w.write(blob);
        var t3 = now();
        await w.close();
        var t4 = now();
        await dir.removeEntry(name);
        return { getHandle: round(t1 - t0), createWritable: round(t2 - t1), write: round(t3 - t2), close: round(t4 - t3), total: round(t4 - t0) };
    }
    async function writeTest(opts) {
        opts = opts || {};
        var root = S().exportDirHandle;
        if (!root) return 'no folder yet: run Download All once (any result) so the page holds its folder';
        var blob = (!opts.mb && run && run.lastBlob) || null;
        if (!blob) {
            var mb = opts.mb || 100, buf = new Uint8Array(mb * 1048576);
            for (var o = 0; o < buf.length; o += 65536) crypto.getRandomValues(buf.subarray(o, Math.min(o + 65536, buf.length)));
            blob = new Blob([buf]);
        }
        var out = { folder: root.name, MB: +(blob.size / 1e6).toFixed(1), root: [], cameraFolder: null };
        var reps = opts.repeats || 2;
        for (var r = 0; r < reps; r++) out.root.push(await timeWrite(root, '_lucid_write_bench_' + r + '.slp', blob));
        for await (var h of root.values()) {
            if (h.kind !== 'directory') continue;
            out.cameraFolder = { name: h.name, runs: [] };
            for (var r2 = 0; r2 < reps; r2++) out.cameraFolder.runs.push(await timeWrite(h, '_lucid_write_bench_' + r2 + '.slp', blob));
            break;
        }
        out.MBperSecond = +(out.MB / out.root[out.root.length - 1].total).toFixed(1);
        return out;
    }

    window.__exportBench = { env: env, recordClicks: recordClicks, clickReport: clickReport, buildAll: buildAll, status: status, writeTest: writeTest };
})();
