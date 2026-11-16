/**
 * _bench-background-load.page.js — in-page helpers for measuring what the image
 * ID-switch check does to the REST of the machine (another app's video, its UI),
 * on real data. Imported into a running LUCID page by whatever drives it (a
 * Playwright script, or by hand from the console):
 *
 *   loadDataset(url)      fetch a session folder from the dev server, load it
 *   runCheck(cfg)         image checks with a given config, for `seconds`
 *   VIDEO_SAMPLER         source of a per-second sampler to paste into the video
 *                         page (dropped frames, gaps between presented frames,
 *                         event-loop lag, PressureObserver state)
 *
 * How it was run (2026-10-30, M5 MacBook Pro): a dev server on localhost with the
 * session folder linked under the tree, YouTube 1080p60 in another app, 150 s per
 * setting with 45 s idle between; each run's [modelWall, endWall] window is then
 * summarised on the video page's samples. Keep runs short: the machine is busy
 * the whole time. Not a test. Results are returned as JSON for the driver to store.
 */
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

/** Every file under a python http.server directory listing, as [relPath, url]. */
export async function listDir(url, rel = '', exclude = null, out = []) {
    const html = await (await fetch(url)).text();
    const hrefs = [...html.matchAll(/<a href="([^"]+)"/g)].map(m => decodeURIComponent(m[1]));
    for (const h of hrefs) {
        if (h.startsWith('?') || h.startsWith('/') || h.startsWith('..')) continue;
        const r = rel + h;
        if (exclude && exclude.test('/' + r)) continue;
        if (h.endsWith('/')) await listDir(url + encodeURIComponent(h.slice(0, -1)) + '/', r, exclude, out);
        else out.push([r, url + encodeURIComponent(h)]);
    }
    return out;
}

/** Fetch a session folder and hand it to the per-camera folder loader, as the picker would. */
export async function loadDataset(url, opts = {}) {
    const ex = new RegExp(opts.exclude || '(^|/)\\.|/troubleshooting/|static\\.externals|\\.proofread\\.slp$');
    const root = url.replace(/\/$/, '').split('/').pop();
    const list = await listDir(url.endsWith('/') ? url : url + '/', '', ex);
    const t0 = performance.now();
    const files = [];
    for (const [rel, u] of list) {
        const b = await (await fetch(u)).blob();
        const f = new File([b], rel.split('/').pop(), { type: b.type });
        Object.defineProperty(f, 'webkitRelativePath', { value: root + '/' + rel });
        files.push(f);
    }
    const fetchS = (performance.now() - t0) / 1000;
    const sl = await import('../../loading/session-loader.js');
    const mode = opts.mode || 'percam';
    if (mode === 'single') await sl.handleLoadSessionFolderSingleSlp(files);
    else await sl.handleLoadSessionFolderPerCamera(files, false);
    return { files: files.length, mb: Math.round(files.reduce((s, f) => s + f.size, 0) / 1e6), fetchS, loadS: (performance.now() - t0) / 1000 - fetchS };
}

/** Main-thread responsiveness of THIS page: setTimeout lateness and rAF gaps, per second. */
export function startLagProbe(store) {
    let lagMax = 0, lagSum = 0, lagN = 0, exp = performance.now() + 50, stop = false;
    (function tick() { if (stop) return; const now = performance.now(), lag = now - exp; lagMax = Math.max(lagMax, lag); lagSum += lag; lagN++; exp = now + 50; setTimeout(tick, 50); })();
    let last = performance.now(), n = 0, gap34 = 0, gapMax = 0;
    (function raf(t) { if (stop) return; const d = t - last; last = t; n++; if (d > 34) gap34++; if (d > gapMax) gapMax = d; requestAnimationFrame(raf); })(performance.now());
    let pressure = null;
    let po = null;
    try { po = new PressureObserver(rs => { pressure = rs[rs.length - 1].state; }); po.observe('cpu', { sampleInterval: 1000 }).catch(() => {}); } catch (e) { po = null; }
    const iv = setInterval(() => {
        const m = performance.memory;
        store.push({ t: Date.now(), lagMax: Math.round(lagMax), lagMean: +(lagN ? lagSum / lagN : 0).toFixed(1), raf: n, gap34, gapMax: Math.round(gapMax),
                     pressure, heapMB: m ? Math.round(m.usedJSHeapSize / 1e6) : null, vis: document.visibilityState });
        lagMax = 0; lagSum = 0; lagN = 0; n = 0; gap34 = 0; gapMax = 0;
    }, 1000);
    return () => { stop = true; clearInterval(iv); if (po) try { po.disconnect(); } catch (e) {} };
}

/**
 * Image checks on the loaded session with `cfg`, pass after pass (cache OFF, so
 * every pass does the same work), until `cfg.seconds` have passed. One embedder
 * (one model load) for all passes. Crops are counted per second (`perSec`, with
 * wall-clock seconds) so the driver can line them up with the video page.
 * cfg: { device: 'webgpu'|'cpu', cpuWorkers, cropWorkers, gpuPct, cpuPct, seconds, label, imageHz, embedderOpts }
 */
export async function runCheck(cfg) {
    const AS = await import('../../ui/app-state.js'), E = await import('../../ui/image-embedder.js');
    const SC = await import('../../pose/id-switch-check.js'), ST = await import('../../ui/settings.js');
    const session = AS.state.session;
    if (cfg.cropWorkers != null) window.LUCID_CROP_WORKERS = cfg.cropWorkers; else delete window.LUCID_CROP_WORKERS;
    const lag = [];
    const stopLag = startLagProbe(lag);
    const t0 = performance.now(), tWall = Date.now();
    const ac = new AbortController();
    let crops = 0, err = null, emb = null, passes = 0, tModel = null;
    const perSec = new Map();
    const timer = setTimeout(() => ac.abort(), (cfg.seconds || 120) * 1000);
    window.__benchAbort = ac;
    try {
        while (!ac.signal.aborted) {
            // releaseFrames (end of a pass) terminates the CPU workers, so one embedder per pass
            emb = await E.createImageEmbedder(session, Object.assign({ maxViewsPerAnimal: ST.getTrackingThreshold('imageCheckMaxViews'), cache: false,
                device: cfg.device, cpuWorkers: cfg.cpuWorkers, maxGpuPct: cfg.gpuPct, maxCpuPct: cfg.cpuPct }, cfg.embedderOpts || {}));
            if (tModel == null) tModel = performance.now();
            await SC.checkImageSwitches(session, {
                fps: AS.state.fps, imageHz: cfg.imageHz || 10, threshold: ST.getTrackingThreshold('imageChangeThreshold'),
                prepareFrames: emb.prepareFrames, croppable: emb.croppable, keyframes: emb.keyframes, inFlight: emb.inFlight, releaseFrames: emb.releaseFrames,
                signal: ac.signal,
                getEmbeddings: async (frame, items) => {
                    const out = await emb.getEmbeddings(frame, items);
                    let k = 0; out.forEach(l => { k += l.length; });
                    crops += k;
                    const s = Math.floor(Date.now() / 1000); perSec.set(s, (perSec.get(s) || 0) + k);
                    return out;
                },
            });
            passes++;
        }
    } catch (e) { if (!(e && e.name === 'AbortError')) err = String(e && e.stack || e).slice(0, 500); }
    clearTimeout(timer);
    const end = performance.now();
    let timing = null; try { timing = emb && emb.stats ? emb.stats() : null; } catch (e) {}
    stopLag();
    const embedS = (end - (tModel || t0)) / 1000;
    return { label: cfg.label, cfg, startWall: tWall, modelWall: tWall + ((tModel || t0) - t0), endWall: Date.now(),
             modelLoadS: tModel ? (tModel - t0) / 1000 : null, embedS, crops, passes, cropsPerS: embedS > 0 ? +(crops / embedS).toFixed(2) : 0,
             perSec: [...perSec.entries()], err, timingLine: timing ? E.formatEmbedTiming(timing) : null, timing, lag };
}

/** Injected into the video page (any page with a <video>): per-second samples in window.__vs. */
export const VIDEO_SAMPLER = `(() => {
  if (window.__vs) return 'already';
  const S = window.__vs = { samples: [] };
  let last = performance.now(), n = 0, g34 = 0, gmax = 0;
  (function raf(t){ const d = t - last; last = t; n++; if (d > 34) g34++; if (d > gmax) gmax = d; requestAnimationFrame(raf); })(performance.now());
  let lagMax = 0, lagSum = 0, lagN = 0, exp = performance.now() + 50;
  (function tick(){ const now = performance.now(), lag = now - exp; lagMax = Math.max(lagMax, lag); lagSum += lag; lagN++; exp = now + 50; setTimeout(tick, 50); })();
  let pressure = null; try { new PressureObserver(r => { pressure = r[r.length-1].state; }).observe('cpu', { sampleInterval: 1000 }).catch(()=>{}); } catch (e) {}
  // presented video frames: count, and the longest gap between two presentations
  let vf = 0, vlast = 0, vgap = 0, vel = null;
  const hook = () => { const el = document.querySelector('video'); if (!el || el === vel || !el.requestVideoFrameCallback) return; vel = el;
     const cb = (now) => { if (vlast) vgap = Math.max(vgap, now - vlast); vlast = now; vf++; if (vel === el) el.requestVideoFrameCallback(cb); }; el.requestVideoFrameCallback(cb); };
  setInterval(() => {
    hook();
    const el = document.querySelector('video');
    const q = el && el.getVideoPlaybackQuality ? el.getVideoPlaybackQuality() : null;
    S.samples.push({ t: Date.now(), dropped: q ? q.droppedVideoFrames : null, total: q ? q.totalVideoFrames : null,
      paused: el ? el.paused : null, ad: !!document.querySelector('.ad-showing'), vis: document.visibilityState,
      raf: n, gap34: g34, gapMax: Math.round(gmax), lagMax: Math.round(lagMax), lagMean: +(lagN ? lagSum/lagN : 0).toFixed(1),
      vframes: vf, vgapMax: Math.round(vgap), pressure, res: el ? el.videoWidth + 'x' + el.videoHeight : null });
    n = 0; g34 = 0; gmax = 0; lagMax = 0; lagSum = 0; lagN = 0; vf = 0; vgap = 0;
    if (S.samples.length > 40000) S.samples.shift();
  }, 1000);
  return 'started';
})()`;
