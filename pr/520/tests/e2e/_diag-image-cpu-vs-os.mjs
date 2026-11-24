/**
 * _diag-image-cpu-vs-os.mjs — DIAGNOSTIC (not an assertion): does the image
 * ID-switch check's CPU line ("CPU: 12 cores · load 7%") follow the CPU the
 * operating system sees the browser use?
 *
 * Runs the real check (real model, from the CDN) on a synthetic 3-animal,
 * 3-camera session (as tests/e2e/image-check-cpu.mjs) for up to DIAG_SECONDS,
 * and every 2 s reads the card's CPU load and the OS's CPU time of every process
 * of the browser (`ps -o time=` over the browser's process tree: the browser,
 * GPU, renderer and utility processes). Prints both in cores, and their means.
 * The card counts the check's own compute only, so it should sit at or a little
 * under the OS figure (which also has the GPU process, the renderer's other
 * work, the compositor…), within about a core.
 *
 * Run (macOS or Linux; WebGPU on a hardware GPU — headless Chrome has one on macOS):
 *   LUC3D_E2E_CHANNEL=chrome node tests/e2e/_diag-image-cpu-vs-os.mjs
 * Env: DIAG_SECONDS (default 45), DIAG_ROOT (serve another checkout, e.g. the
 * base commit, to compare), HEADED=1, DIAG_DEVICE=cpu (the CPU model instead).
 */
import { startServer, launchBrowser } from './lib/harness.mjs';
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = process.env.DIAG_ROOT ? path.resolve(process.env.DIAG_ROOT) : path.resolve(__dirname, '..', '..');
const SECONDS = Number(process.env.DIAG_SECONDS) || 45;
const server = await startServer(repoRoot);

// every process: pid, ppid, cumulative CPU seconds, command
const cpuSeconds = (t) => {   // [[dd-]hh:]mm:ss[.ss]
    const [d, rest] = t.includes('-') ? t.split('-') : ['0', t];
    return Number(d) * 86400 + rest.split(':').reduce((a, v) => a * 60 + Number(v), 0);
};
const procs = () => execFileSync('ps', ['-A', '-o', 'pid=,ppid=,time=,command='], { encoding: 'utf8', maxBuffer: 64 << 20 })
    .split('\n').filter(Boolean).map((l) => {
        const m = l.trim().match(/^(\d+)\s+(\d+)\s+(\S+)\s+(.*)$/);
        return m && { pid: +m[1], ppid: +m[2], cpu: cpuSeconds(m[3]), cmd: m[4] };
    }).filter(Boolean);
const before = new Set(procs().map((p) => p.pid));

let browser;
try {
    browser = await launchBrowser({ headless: process.env.HEADED !== '1', args: ['--enable-unsafe-webgpu'] });
    // the browser's root: a new process with a --user-data-dir whose parent is not new
    const all0 = procs(), fresh = all0.filter((p) => !before.has(p.pid));
    const freshPids = new Set(fresh.map((p) => p.pid));
    const root = fresh.find((p) => /--user-data-dir=/.test(p.cmd) && !freshPids.has(p.ppid) && !/--type=/.test(p.cmd));
    if (!root) throw new Error('could not find the browser process');
    const tree = () => {
        const all = procs(), kids = new Map();
        all.forEach((p) => { if (!kids.has(p.ppid)) kids.set(p.ppid, []); kids.get(p.ppid).push(p); });
        const out = [], stack = [all.find((p) => p.pid === root.pid)].filter(Boolean);
        while (stack.length) { const p = stack.pop(); out.push(p); (kids.get(p.pid) || []).forEach((k) => stack.push(k)); }
        return out;
    };
    const kind = (cmd) => (cmd.match(/--type=(\S+)/) || [, 'browser'])[1] + (/--utility-sub-type=(\S+)/.test(cmd) ? ':' + cmd.match(/--utility-sub-type=(\S+)/)[1].split('.').pop() : '');

    const page = await browser.newPage({ viewport: { width: 1400, height: 900 } });
    await page.goto(`http://localhost:${server.port}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async () => {   // the fixture of tests/e2e/image-check-cpu.mjs
        const pd = await import('/pose/pose-data.js'), AS = await import('/ui/app-state.js');
        const NODES = ['Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk', 'Tail_0', 'Tail_1', 'Tail_2',
            'Shoulder_left', 'Shoulder_right', 'Haunch_left', 'Haunch_right', 'Neck'];
        const TEMPLATE = { Nose: [45, 0, 0], Ear_R: [25, -11, 4], Ear_L: [25, 11, 4], Head: [30, 0, 3], Neck: [20, 0, 2],
            Trunk: [-5, 0, 4], TTI: [-40, 0, 0], Shoulder_left: [10, 12, 0], Shoulder_right: [10, -12, 0],
            Haunch_left: [-25, 15, 0], Haunch_right: [-25, -15, 0], Tail_0: [-65, 0, 0], Tail_1: [-88, 0, 0],
            Tail_2: [-110, 0, 0], TailTip: [-132, 0, 0] };
        const CAMS = ['camA', 'camB', 'camC'], STEP = 4;
        const pose = (cx, cy, h) => { const out = new Float64Array(45), c = Math.cos(h), s = Math.sin(h);
            NODES.forEach((n, i) => { const [x, y, z] = TEMPLATE[n]; out[i * 3] = cx + c * x - s * y; out[i * 3 + 1] = cy + s * x + c * y; out[i * 3 + 2] = z; }); return out; };
        const inst = (P, ci) => ({ getPoint: (i) => [130 + 12 * ci + 0.8 * P[i * 3], 130 + 8 * ci + 0.8 * P[i * 3 + 1]] });
        const home = [[0, 0], [400, 0], [200, 350]], PAIRS = [[0, 1], [1, 2], [0, 2]];
        const events = []; for (let e = 0; e < 24; e++) events.push({ pair: PAIRS[e % 3], t0: 300 + e * 260 });
        const T = 300 + 24 * 260 + 300;
        const session = new pd.Session([], new pd.Skeleton('m', NODES, []), [], 'CpuDiag');
        for (let i = 0; i < 3; i++) session.addIdentity('id_' + i);
        let gid = 1;
        for (let t = 0; t < T; t++) {
            const pos = home.map(h => [h[0] + 15 * Math.sin(t / 37 + h[0]), h[1] + 15 * Math.cos(t / 41 + h[1])]);
            for (const ev of events) { const d = t - ev.t0; if (d < 0 || d > 100) continue;
                const [a, b] = ev.pair, mid = [(home[a][0] + home[b][0]) / 2, (home[a][1] + home[b][1]) / 2];
                const f = d < 40 ? d / 40 : d <= 60 ? 1 : 1 - (d - 60) / 40;
                for (const [k, side] of [[a, -1], [b, 1]]) pos[k] = [home[k][0] + f * (mid[0] + side * 10 - home[k][0]), home[k][1] + f * (mid[1] - home[k][1])]; }
            session.instanceGroups.set(t * STEP, [0, 1, 2].map(k => { const g = new pd.InstanceGroup(gid++, session.identities[k].id);
                g.points3d = pose(pos[k][0], pos[k][1], (t / 50 + k) % (2 * Math.PI)); CAMS.forEach((c, ci) => g.instances.set(c, inst(g.points3d, ci))); return g; }));
        }
        // a 1280 x 1024 frame per camera: a fresh VideoFrame each time, as a decoder hands them out
        const cv = new OffscreenCanvas(1280, 1024), cx = cv.getContext('2d');
        for (let i = 0; i < 2000; i++) { cx.fillStyle = `hsl(${(i * 37) % 360},45%,${15 + (i * 13) % 70}%)`; cx.beginPath(); cx.arc((i * 97) % 1280, (i * 53) % 1024, 4 + (i % 25), 0, 7); cx.fill(); }
        const bmp = await createImageBitmap(cv);
        AS.state.sessions = [session]; AS.state.activeSessionIdx = 0; AS.state.session = session;
        AS.state.totalFrames = T * STEP; AS.state.currentFrame = 0; AS.state.fps = 60;
        AS.state.views = CAMS.map(c => ({ cameraName: c, decoder: { getFrame: async () => bmp } }));
    });
    const cores = await page.evaluate(() => navigator.hardwareConcurrency);
    await page.evaluate(async (dev) => {
        const M = await import('/ui/id-switch-modal.js');
        if (dev) { const E = await import('/ui/image-embedder.js'), real = E.createImageEmbedder;
            window.__inject = { createEmbedder: (s, o) => real(s, Object.assign({}, o, { device: dev })) }; }
        window.__done = M.runIdSwitchChecks({ image: true, auto: true, statusPrefix: 'diag', inject: window.__inject });
    }, process.env.DIAG_DEVICE || null);
    await page.waitForFunction(() => /frame \d/.test(document.querySelector('.id-switch-progress-text')?.textContent || ''), null, { timeout: 180000 });
    const rows = [];
    let prev = { t: Date.now(), byPid: new Map(tree().map((p) => [p.pid, p])) };
    const t0 = Date.now();
    while (Date.now() - t0 < SECONDS * 1000) {
        await new Promise((r) => setTimeout(r, 2000));
        const card = await page.evaluate(() => {
            const q = (c) => document.querySelector('.id-switch-progress ' + c);
            return q('.id-switch-progress-cpu') ? { cpu: q('.id-switch-progress-cpu').textContent, gpu: q('.id-switch-progress-gpu').textContent,
                                                    text: q('.id-switch-progress-text').textContent } : null;
        });
        const now = { t: Date.now(), byPid: new Map(tree().map((p) => [p.pid, p])) };
        if (!card) break;
        const dt = (now.t - prev.t) / 1000, per = {};
        let os = 0;
        now.byPid.forEach((p, pid) => { const q = prev.byPid.get(pid); const d = Math.max(0, p.cpu - (q ? q.cpu : p.cpu)) / dt; os += d; const k = kind(p.cmd); per[k] = (per[k] || 0) + d; });
        const load = +((card.cpu.match(/load (\d+)%/) || [])[1]);
        rows.push({ s: (now.t - t0) / 1000, cardCores: isFinite(load) ? load / 100 * cores : NaN, osCores: os, per, card });
        console.log(`${((now.t - t0) / 1000).toFixed(0).padStart(3)} s  card ${isFinite(load) ? (load / 100 * cores).toFixed(2) : '  -  '} cores ("${card.cpu}")  OS ${os.toFixed(2)} cores  [` +
                    Object.entries(per).filter(([, v]) => v >= 0.05).sort((a, b) => b[1] - a[1]).map(([k, v]) => k + ' ' + v.toFixed(2)).join(', ') + ']');
        prev = now;
    }
    const gpuLine = rows.length ? rows[rows.length - 1].card.gpu : '';
    const steady = rows.filter((r) => r.s >= 6 && isFinite(r.cardCores));   // the card's 5 s window has filled
    const mean = (k) => steady.reduce((a, r) => a + r[k], 0) / Math.max(1, steady.length);
    console.log(`\n${repoRoot}\n${cores} logical cores; device line: "${gpuLine}"`);
    console.log(`mean over ${steady.length} samples (from 6 s): card ${mean('cardCores').toFixed(2)} cores, OS ${mean('osCores').toFixed(2)} cores, ` +
                `difference ${(mean('osCores') - mean('cardCores')).toFixed(2)} cores`);
    await page.keyboard.press('Escape');
    await page.evaluate(() => window.__done).catch(() => {});
} finally {
    if (browser) await browser.close();
    server.kill();
}
