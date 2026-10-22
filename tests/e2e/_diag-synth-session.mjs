/**
 * _diag-synth-session.mjs — score LUCID against a synthetic session whose truth is
 * known exactly. The sessions are made by `sleap_synth_session.py`, which lives in
 * the sleap-io fork under `contrib/synthetic_sessions/`
 * (https://github.com/olinesn/sleap-io): SLEAP models run backward to draw each camera,
 * so the 3D, every camera's 2D and the identities are known exactly.
 *
 * For each SIDE of the generated folder it loads OUT/<side> as a per-camera session
 * folder (File ▸ Load Session Folder), runs Track All, then Triangulate All, and
 * compares what LUCID ends with to OUT/truth.json:
 *   - grouping: on every frame, each truth animal is matched to the LUCID group whose
 *     3D is nearest (exhaustive assignment); unmatched groups and animals are listed;
 *   - 3D: the per-node distance between the group's points3d and the truth (mm);
 *   - 2D: each group member's keypoints against the truth 2D in that camera (px);
 *   - identities: which identity each truth animal carries on each frame — one
 *     identity per animal, distinct across animals, is a pass; anything else is
 *     counted as a switch.
 *
 * Sides: `truth_session` holds the EXACT 2D, so its 3D error must be ~0 (it tests
 * that LUCID reads the calibration and triangulates as the generator projects);
 * `session` holds the models' predictions on the generated images
 * (`sleap_synth_session.py predict`), so its errors are what the whole pipeline
 * costs.
 *
 * Not a test (needs generated data and Chrome for its decoders). Usage:
 *   DATASET=<OUT> node tests/e2e/_diag-synth-session.mjs
 *   env: SIDES=truth_session,session  TRI=dlt|ba ('' skips Triangulate All)
 *        APP_REF=<git ref> serves that build (git archive) instead of this tree
 *        PORT=8170  HEADED=1 (takes the browser lock)  NANIMALS=<count; default truth's>
 *        THRESHOLDS='{"autoSwitchCheck":1}' tracker settings (default: no ID-switch checks)
 *        RESCORE=1  re-score the saved lucid-<side>.json snapshots (no browser; the
 *                   afterTrack score of a run with Triangulate All is kept as it was)
 * Writes OUT/lucid-<side>.json and prints a summary.
 */
import { chromium } from 'playwright';
import { spawn, execSync } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const DATASET = process.env.DATASET && path.resolve(process.env.DATASET);
if (!DATASET) { console.error('set DATASET=<sleap_synth_session.py --out folder>'); process.exit(2); }
const SIDES = (process.env.SIDES || 'truth_session,session').split(',').filter((s) => fs.existsSync(path.join(DATASET, s)));
const TRI = process.env.TRI ?? 'dlt';
const PORT = Number(process.env.PORT || 8170);
const HEADED = process.env.HEADED === '1';
const THRESHOLDS = Object.assign({ autoSwitchCheck: 0, autoImageSwitchCheck: 0 },
    process.env.THRESHOLDS ? JSON.parse(process.env.THRESHOLDS) : {});
const truth = JSON.parse(fs.readFileSync(path.join(DATASET, 'truth.json'), 'utf8'));
const NANIMALS = Number(process.env.NANIMALS || truth.animals.length);
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

let appDir = repoRoot, tmpApp = null;
if (process.env.APP_REF) {
    tmpApp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-synth-app-'));
    execSync(`git archive ${process.env.APP_REF} | tar -x -C "${tmpApp}"`, { cwd: repoRoot, shell: '/bin/sh' });
    appDir = tmpApp;
}
const appSha = process.env.APP_REF ? execSync(`git rev-parse ${process.env.APP_REF}`, { cwd: repoRoot }).toString().trim()
    : execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim() + ' (working tree)';
// RESCORE=1: re-score the snapshots a previous run saved (lucid-<side>.json) against
// the current truth.json and scoring, without running LUCID again.
const RESCORE = process.env.RESCORE === '1';
const server = RESCORE ? null : spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: appDir, stdio: 'ignore' });
if (!RESCORE) await new Promise((r) => setTimeout(r, 1200));

// Runs in the page: every group of every frame, members' 2D by node NAME.
const SNAPSHOT = async () => {
    const s = window.__lucid.state.session;
    const review = await import('./ui/id-switch-review.js').catch(() => null);
    const nodes = s.skeleton.nodes.slice();
    const idName = new Map(s.identities.map((i) => [i.id, i.name]));
    const trackName = (k) => { const t = s.tracks[k]; return t == null ? null : (typeof t === 'string' ? t : t.name); };
    const frames = {};
    for (const f of [...s.instanceGroups.keys()].sort((a, b) => a - b)) {
        frames[f] = (s.instanceGroups.get(f) || []).map((g) => {
            const members = {};
            g.instances.forEach((inst, cam) => {
                const pts = [];
                for (let k = 0; k < nodes.length; k++) pts.push(inst.getPoint(k));
                members[cam] = { track: trackName(inst.trackIdx), type: inst.type, points: pts };
            });
            return { identityId: g.identityId, identity: idName.get(g.identityId) ?? null,
                points3d: g.points3d ? Array.from(g.points3d) : null, members };
        });
    }
    return { nodes, cameras: s.cameras.map((c) => c.name), identities: s.identities.map((i) => i.name), frames,
        idSwitch: review && review.serializeIdSwitchReview ? review.serializeIdSwitchReview(s) : null };
};

const runSide = async (browser, side) => {
    const page = await browser.newPage({ viewport: { width: 1480, height: 860 } });
    page.on('pageerror', (e) => log(side + ' pageerror: ' + String(e).slice(0, 300)));
    page.on('dialog', (d) => d.accept(String(NANIMALS)));  // the old prompt() for the animal count
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async ({ thresholds, n }) => {
        const st = await import('./ui/settings.js');
        st.setTrackingThresholds(thresholds);
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
        inp.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(inp);
        // Answer whatever a run asks: the Track setup dialog's animal count, then Continue / OK.
        setInterval(() => {
            const a = document.getElementById('trackSetupAnimals');
            if (a && a.value !== String(n)) { a.value = String(n); a.dispatchEvent(new Event('input', { bubbles: true })); }
            for (const b of document.querySelectorAll('button')) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t === 'OK' || b.id === 'trackSummaryClose') && b.offsetParent !== null && !b.disabled) b.click();
            }
        }, 300);
    }, { thresholds: THRESHOLDS, n: NANIMALS });
    await page.setInputFiles('#__dir', path.join(DATASET, side));
    await page.evaluate(async () => {
        const sl = await import('./loading/session-loader.js');
        await sl.handleLoadSessionFolderPerCamera(Array.from(document.getElementById('__dir').files), false);
    });
    await page.waitForFunction(() => { const s = window.__lucid.state.session; return s && s.cameras && s.cameras.length > 1; },
        null, { timeout: 10 * 60000, polling: 500 });
    await new Promise((r) => setTimeout(r, 2000));
    const step = async (button, re, what) => {
        const prev = await page.evaluate(() => document.getElementById('statusText').textContent);
        const t0 = Date.now();
        await page.evaluate((id) => document.getElementById(id).click(), button);
        for (;;) {
            const st = await page.evaluate(() => ({ s: document.getElementById('statusText').textContent,
                hidden: document.getElementById('loadingOverlay').classList.contains('hidden') }));
            if (st.hidden && st.s !== prev && re.test(st.s)) { log(`${side} ${what}: ${((Date.now() - t0) / 1000).toFixed(1)} s — ${st.s.slice(0, 100)}`); return st.s; }
            if (Date.now() - t0 > 30 * 60000) throw new Error(what + ' timed out; status: ' + st.s);
            await new Promise((r) => setTimeout(r, 250));
        }
    };
    const out = { side };
    out.trackStatus = await step('tbTrackAll', /Assigned \d+ identities/, 'Track All');
    // The ID-switch checks Track All was told to run follow it: wait for their results.
    const want = [THRESHOLDS.autoSwitchCheck ? 'size' : null, THRESHOLDS.autoImageSwitchCheck ? 'image' : null].filter(Boolean);
    if (want.length) {
        await page.waitForFunction((w) => { const st = window.__lucid.state.session._idSwitch;
            return st && st.results && w.every((c) => st.results[c]) && document.getElementById('loadingOverlay').classList.contains('hidden'); },
        want, { timeout: 30 * 60000, polling: 500 }).catch(() => log(side + ': ID-switch checks did not finish'));
    }
    out.afterTrack = await page.evaluate(SNAPSHOT);
    if (TRI) {
        await page.evaluate(async (m) => { (await import('./ui/settings.js')).setDefaultTriangulationMethod(m); }, TRI);
        out.triStatus = await step('tbTriangulateAll', /^(Triangulated|Grouped) /, `Triangulate All (${TRI})`);
        out.afterTri = await page.evaluate(SNAPSHOT);
    }
    await page.close();
    return out;
};

// --- Scoring ---------------------------------------------------------------

const finite = (p) => p != null && Number.isFinite(p[0]) && Number.isFinite(p[1]);
const median = (a) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); const m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };
const pct = (a, q) => { if (!a.length) return null; const s = a.slice().sort((x, y) => x - y); return s[Math.min(s.length - 1, Math.floor(q * s.length))]; };
const r3 = (x) => x == null ? null : Math.round(x * 1000) / 1000;

// Best assignment of truth animals (rows) to groups (cols) by cost; exhaustive (few animals).
function assign(cost) {
    const n = cost.length, m = n ? cost[0].length : 0;
    let best = { total: Infinity, cols: [] };
    const used = new Array(m).fill(false), cols = new Array(n).fill(-1);
    const rec = (i, total) => {
        if (total >= best.total) return;
        if (i === n) { best = { total, cols: cols.slice() }; return; }
        // Leaving an animal unmatched costs a large constant, so any finite match wins.
        cols[i] = -1; rec(i + 1, total + 1e9);
        for (let j = 0; j < m; j++) {
            if (used[j] || !Number.isFinite(cost[i][j])) continue;
            used[j] = true; cols[i] = j; rec(i + 1, total + cost[i][j]); used[j] = false;
        }
        cols[i] = -1;
    };
    rec(0, 0);
    return best.cols;
}

const stats = (a) => ({ n: a.length, median: r3(median(a)), p95: r3(pct(a, 0.95)), max: r3(a.length ? Math.max(...a) : null) });

function score(snap) {
    const nodeIdx = truth.nodes.map((n) => snap.nodes.indexOf(n));
    // 2D is scored on what the image shows: a node the truth marks hidden (behind
    // another animal, `hidden`) goes to err2dHidden, and a member in a camera where
    // the animal was not drawn at all (`drawn` false) is counted, not scored.
    // 3D is scored on OBSERVABLE nodes: shown (drawn, in frame, not hidden) by at
    // least two cameras. A node fewer cameras show cannot be triangulated by any
    // method — on the crossing, a tail swept through the other mouse's body — so it
    // is listed in `unobservable` instead of setting the headline max. Observable
    // nodes are further split by whether any camera had that animal partly hidden.
    const err3d = [], err3dAll = [], err3dClear = [], err3dOccluded = [], err2d = [], err2dHidden = [],
        unobservable = [], perFrame = [], idsOf = {};
    let membersNotDrawn = 0;
    truth.animals.forEach((a) => { idsOf[a] = []; });
    let missed = 0, extra = 0;
    for (const tf of truth.frames) {
        const groups = snap.frames[tf.frame] || [];
        // 3D of each group in truth node order.
        const g3 = groups.map((g) => truth.nodes.map((_, k) => {
            const j = nodeIdx[k];
            if (!g.points3d || j < 0) return null;
            const p = [g.points3d[3 * j], g.points3d[3 * j + 1], g.points3d[3 * j + 2]];
            return p.every(Number.isFinite) ? p : null;
        }));
        // Cost: mean 3D distance, else (no 3D yet) mean 2D distance over shared cameras.
        const cost = truth.animals.map((a) => groups.map((g, gi) => {
            const T = tf.animals[a];
            let s = 0, n = 0;
            g3[gi].forEach((p, k) => { const q = T.points3d[k]; if (p && q) { s += Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]); n++; } });
            if (n) return s / n;
            for (const [cam, mem] of Object.entries(g.members)) {
                const q2 = T.points2d[cam]; if (!q2) continue;
                truth.nodes.forEach((_, k) => { const p = nodeIdx[k] >= 0 ? mem.points[nodeIdx[k]] : null; if (finite(p) && finite(q2[k])) { s += Math.hypot(p[0] - q2[k][0], p[1] - q2[k][1]); n++; } });
            }
            return n ? 1e6 + s / n : Infinity;
        }));
        const cols = assign(cost);
        const rows = [];
        truth.animals.forEach((a, i) => {
            const gi = cols[i];
            if (gi < 0) { missed++; idsOf[a].push(null); rows.push({ animal: a, group: null }); return; }
            const g = groups[gi], T = tf.animals[a];
            const e3 = [];
            g3[gi].forEach((p, k) => {
                const q = T.points3d[k];
                if (!(p && q)) return;
                const e = Math.hypot(p[0] - q[0], p[1] - q[1], p[2] - q[2]);
                err3dAll.push(e);
                const views = truth.cameras.filter((c) => (!T.drawn || T.drawn[c] !== false)
                    && T.in_frame[c] && T.in_frame[c][k] && !(T.hidden && T.hidden[c] && T.hidden[c][k])).length;
                if (views >= 2) e3.push(e);
                else unobservable.push({ frame: tf.frame, animal: a, node: truth.nodes[k], views, err_mm: r3(e) });
            });
            const e2 = {};
            for (const [cam, mem] of Object.entries(g.members)) {
                const q2 = T.points2d[cam], vis = T.in_frame[cam], hid = T.hidden ? T.hidden[cam] : null;
                if (!q2) continue;
                if (T.drawn && T.drawn[cam] === false) { membersNotDrawn++; e2[cam] = { notDrawn: true, track: mem.track }; continue; }
                const es = [], eh = [];
                truth.nodes.forEach((_, k) => {
                    const p = nodeIdx[k] >= 0 ? mem.points[nodeIdx[k]] : null;
                    if (!(vis && vis[k] && finite(p) && finite(q2[k]))) return;
                    (hid && hid[k] ? eh : es).push(Math.hypot(p[0] - q2[k][0], p[1] - q2[k][1]));
                });
                e2[cam] = { median: r3(median(es)), max: r3(es.length ? Math.max(...es) : null), track: mem.track,
                    ...(eh.length ? { hiddenNodes: eh.length, hiddenMedian: r3(median(eh)) } : {}) };
                err2d.push(...es);
                err2dHidden.push(...eh);
            }
            err3d.push(...e3);
            const occluded = T.hidden && Object.values(T.hidden).some((h) => h.some(Boolean));
            (occluded ? err3dOccluded : err3dClear).push(...e3);
            idsOf[a].push(g.identity);
            rows.push({ animal: a, identity: g.identity, cameras: Object.keys(g.members).length, occluded,
                err3d_median_mm: r3(median(e3)), err3d_max_mm: r3(e3.length ? Math.max(...e3) : null), err2d: e2 });
        });
        extra += groups.length - cols.filter((c) => c >= 0).length;
        perFrame.push({ frame: tf.frame, groups: groups.length, animals: rows });
    }
    // Identities: the identity each animal carries most often; a frame on any other is a switch.
    const identity = {}, switches = {};
    for (const a of truth.animals) {
        const counts = {};
        idsOf[a].forEach((id) => { if (id != null) counts[id] = (counts[id] || 0) + 1; });
        const top = Object.entries(counts).sort((x, y) => y[1] - x[1])[0];
        identity[a] = top ? top[0] : null;
        switches[a] = idsOf[a].filter((id) => id !== identity[a]).length;
    }
    const distinct = new Set(Object.values(identity).filter((x) => x != null)).size === truth.animals.length;
    // The ID-switch checks' change points, and whether one lands on the staged swap.
    let checks = null;
    if (snap.idSwitch && snap.idSwitch.checks) {
        checks = {};
        for (const [cue, c] of Object.entries(snap.idSwitch.checks)) {
            const pts = c.points.map(([frame, a, b, sc, kind]) => ({ frame, a, b, score: sc, kind }));
            const hit = truth.swap ? pts.filter((p) => Math.abs(p.frame - truth.swap.at) <= Math.max(2, truth.fps / 2)) : [];
            checks[cue] = { encounters: c.encounters, points: pts, swapCaught: truth.swap ? hit.length > 0 : null,
                falsePoints: truth.swap ? pts.length - hit.length : pts.length };
        }
    }
    return {
        frames: truth.frames.length, missedAnimalFrames: missed, extraGroups: extra, swap: truth.swap || null, checks,
        err3d_mm: stats(err3d), err3d_all_mm: stats(err3dAll), unobservable,
        err3d_clear_mm: stats(err3dClear), err3d_occluded_mm: stats(err3dOccluded),
        err2d_px: stats(err2d), err2d_hidden_px: stats(err2dHidden), membersNotDrawn,
        identity, identitiesDistinct: distinct, framesOffIdentity: switches, perFrame,
    };
}

let release = null, browser;
try {
    if (HEADED && !RESCORE) release = await acquireBrowserLock({ label: '_diag-synth-session' });
    if (!RESCORE) browser = await chromium.launch({ headless: !HEADED, channel: 'chrome', args: ['--window-size=1500,950'] });
    for (const side of SIDES) {
        let result;
        if (RESCORE) {
            const file = path.join(DATASET, `lucid-${side}.json`);
            if (!fs.existsSync(file)) { log(`${side}: no ${file} to re-score`); continue; }
            const old = JSON.parse(fs.readFileSync(file, 'utf8'));
            // The saved snapshot is the final one (after Triangulate All when it ran).
            result = Object.assign(old, { afterTrack: old.afterTri ? old.afterTrack : score(old.snapshot),
                afterTri: old.afterTri ? score(old.snapshot) : null, rescored: true });
        } else {
            const run = await runSide(browser, side);
            result = { dataset: DATASET, side, app: appSha, tri: TRI, thresholds: THRESHOLDS, nAnimals: NANIMALS,
                trackStatus: run.trackStatus, triStatus: run.triStatus,
                afterTrack: score(run.afterTrack), afterTri: run.afterTri ? score(run.afterTri) : null,
                lucidIdentities: run.afterTrack.identities, snapshot: run.afterTri || run.afterTrack };
        }
        fs.writeFileSync(path.join(DATASET, `lucid-${side}.json`), JSON.stringify(result, null, 1));
        const s = result.afterTri || result.afterTrack;
        log(`${side}: ${s.frames} frame(s); animals missed ${s.missedAnimalFrames}, extra groups ${s.extraGroups}; ` +
            `3D error median ${s.err3d_mm.median} mm, p95 ${s.err3d_mm.p95}, max ${s.err3d_mm.max} (${s.err3d_mm.n} nodes ` +
            `seen by 2+ cameras); 2D error median ${s.err2d_px.median} px, max ${s.err2d_px.max}`);
        if (s.unobservable.length) log(`${side}: ${s.unobservable.length} node reading(s) seen by fewer than 2 cameras, not scored ` +
            `above: ${s.unobservable.map((u) => `f${u.frame} ${u.animal} ${u.node} ${u.err_mm} mm`).slice(0, 6).join('; ')}` +
            `${s.unobservable.length > 6 ? '; …' : ''}`);
        if (s.err3d_occluded_mm.n) log(`${side}: 3D where some camera had a node hidden: median ${s.err3d_occluded_mm.median} mm, ` +
            `p95 ${s.err3d_occluded_mm.p95}, max ${s.err3d_occluded_mm.max}; elsewhere median ${s.err3d_clear_mm.median}, ` +
            `p95 ${s.err3d_clear_mm.p95}, max ${s.err3d_clear_mm.max} (seen by 2+ cameras). Hidden 2D nodes (not scored above): ` +
            `${s.err2d_hidden_px.n}, read at ${s.err2d_hidden_px.median} px median; members where not drawn: ${s.membersNotDrawn}`);
        log(`${side}: identities ${JSON.stringify(s.identity)} — ${s.identitiesDistinct ? 'distinct' : 'NOT distinct'}; ` +
            `frames off identity ${JSON.stringify(s.framesOffIdentity)}`);
        if (s.checks) log(`${side}: ID-switch checks ${JSON.stringify(Object.fromEntries(Object.entries(s.checks).map(([k, v]) =>
            [k, { points: v.points.map((p) => p.frame), swapCaught: v.swapCaught }])))}`);
        log(`wrote ${path.join(DATASET, `lucid-${side}.json`)}`);
    }
} finally {
    if (browser) await browser.close().catch(() => {});
    if (release) await release();
    if (server) server.kill();
    if (tmpApp) fs.rmSync(tmpApp, { recursive: true, force: true });
}
