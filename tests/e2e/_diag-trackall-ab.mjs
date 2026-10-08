/**
 * _diag-trackall-ab.mjs — does a change to the tracker or the triangulation
 * change what Track All finds? Runs Track All, then Triangulate All, on the SAME
 * recording with two builds of the app — OLD (any git ref, extracted with
 * `git archive`) and NEW (this working tree) — and compares, frame by frame:
 *   - the identity groups: each InstanceGroup's identity and exactly which 2D
 *     detection it holds in each camera (a per-frame hash of the canonical list);
 *   - the 3D: every node of every group, on every SAMPLE-th frame, after Track All
 *     (the tracker's own DLT points) and after Triangulate All;
 *   - the time each step took (the two builds run one after the other, OLD first,
 *     then NEW, then OLD and NEW again with REPEAT=2 — so a busy machine shows up
 *     as a disagreement between repeats, not as a speed-up).
 * Writes verify/trackall-ab/<label>-<timestamp>.json and prints a summary.
 *
 * Not a test (needs a real dataset, a display, and real Chrome for its video
 * decoders). Takes the browser lock (scripts/browser-lock.mjs). Usage:
 *   DATASET=<per-camera folder> OLD=<git ref> NANIMALS=5 node tests/e2e/_diag-trackall-ab.mjs
 *   env: TRI=dlt (Triangulate All method; '' skips it)  SAMPLE=50  REPEAT=1  LABEL=<name>
 *        EXCLUDE=<regex of files to leave out>  PORT=8150 (OLD; NEW is PORT+1)
 *        NEW_THRESHOLDS='{"matchGate":1}' — tracker settings applied to the NEW side
 *          only: the negative control (the comparison must then report differing frames)
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
const DATASET = process.env.DATASET;
const OLD = process.env.OLD || 'origin/main';
const NANIMALS = process.env.NANIMALS ?? '';
const TRI = process.env.TRI ?? 'dlt';
const SAMPLE = Number(process.env.SAMPLE || 50);
const REPEAT = Number(process.env.REPEAT || 1);
const PORT = Number(process.env.PORT || 8150);
const EXCLUDE = process.env.EXCLUDE || '(^|/)\\.|/troubleshooting/';
const NEW_THRESHOLDS = process.env.NEW_THRESHOLDS ? JSON.parse(process.env.NEW_THRESHOLDS) : null;
const LABEL = process.env.LABEL || path.basename(DATASET || 'dataset');
if (!DATASET) { console.error('set DATASET'); process.exit(2); }
const log = (m) => process.stdout.write(`[${new Date().toISOString().slice(11, 19)}] ${m}\n`);

// OLD: a clean copy of the ref (no git worktree registered), served beside this tree.
const oldSha = execSync(`git rev-parse ${OLD}`, { cwd: repoRoot }).toString().trim();
const oldDir = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-ab-old-'));
execSync(`git archive ${oldSha} | tar -x -C "${oldDir}"`, { cwd: repoRoot, shell: '/bin/sh' });
const newSha = execSync('git rev-parse HEAD', { cwd: repoRoot }).toString().trim();
const dirty = execSync('git status --porcelain -- pose ui loading import-export app.js index.html', { cwd: repoRoot }).toString().trim() !== '';
const servers = [spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: oldDir, stdio: 'ignore' }),
    spawn('python3', ['-m', 'http.server', String(PORT + 1)], { cwd: repoRoot, stdio: 'ignore' })];
await new Promise(r => setTimeout(r, 1500));

// Runs in the page after each step: per-frame hashes of the identity groups, plus sampled 3D.
const SNAPSHOT = (sample) => {
    const s = window.__lucid.state.session;
    const fnv = (str) => { let h = 0x811c9dc5; for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); } return (h >>> 0).toString(16); };
    const keyOf = (cam, inst) => {
        let pt = '';
        const n = inst.numNodes || (inst.points ? inst.points.length / 2 : 0) || 0;
        for (let i = 0; i < n; i++) { const p = inst.getPoint && inst.getPoint(i); if (p && isFinite(p[0]) && isFinite(p[1])) { pt = p[0].toFixed(3) + ',' + p[1].toFixed(3); break; } }
        return cam + '#' + (inst._rawInstIndex != null ? inst._rawInstIndex : '') + '#' + inst.trackIdx + '#' + pt;
    };
    const frames = [...s.instanceGroups.keys()].sort((a, b) => a - b);
    const hashes = new Array(frames.length), canon = {}, pts = {};
    let groups = 0;
    for (let fi = 0; fi < frames.length; fi++) {
        const f = frames[fi], gs = s.instanceGroups.get(f) || [];
        const lines = gs.map((g) => {
            const mem = []; g.instances.forEach((inst, cam) => mem.push(keyOf(cam, inst)));
            return String(g.identityId) + '|' + mem.sort().join(';');
        }).sort();
        groups += gs.length;
        hashes[fi] = f + ':' + fnv(lines.join('\n'));
        if (f % sample === 0) {
            canon[f] = lines;
            pts[f] = gs.map((g) => [String(g.identityId), g.points3d ? Array.from(g.points3d) : null]);
        }
    }
    return { identities: s.identities.length, frames: frames.length, groups, hashes, canon, pts };
};

const runSide = async (side, port) => {
    const page = await browser.newPage({ viewport: { width: 1480, height: 860 } });
    page.on('pageerror', (e) => log(side + ' pageerror: ' + String(e).slice(0, 300)));
    page.on('dialog', (d) => d.accept(String(NANIMALS)));
    await page.goto(`http://localhost:${port}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, null, { timeout: 30000 });
    await page.evaluate(async (extra) => {
        const st = await import('./ui/settings.js');
        st.setTrackingThresholds(Object.assign({ autoSwitchCheck: 0, autoImageSwitchCheck: 0 }, extra));   // tracking only: no ID-switch checks
        const inp = document.createElement('input');
        inp.type = 'file'; inp.multiple = true; inp.webkitdirectory = true; inp.id = '__dir';
        inp.style.cssText = 'position:fixed;left:-9999px'; document.body.appendChild(inp);
        setInterval(() => { for (const b of document.querySelectorAll('button')) { const t = b.textContent.trim(); if ((t === 'Continue' || t === 'OK') && b.offsetParent !== null) b.click(); } }, 300);
    }, side === 'NEW' && NEW_THRESHOLDS ? NEW_THRESHOLDS : {});
    await page.setInputFiles('#__dir', DATASET);
    await page.evaluate(async (ex) => {
        const sl = await import('./loading/session-loader.js');
        const re = new RegExp(ex);
        await sl.handleLoadSessionFolderPerCamera(Array.from(document.getElementById('__dir').files).filter((f) => !re.test(f.webkitRelativePath || f.name)), false);
    }, EXCLUDE);
    await page.waitForFunction(() => window.__lucid.state.session && window.__lucid.state.session.cameras && window.__lucid.state.session.cameras.length > 1, null, { timeout: 30 * 60000, polling: 1000 });
    await new Promise((r) => setTimeout(r, 3000));
    const step = async (button, re, what) => {
        const prev = await page.evaluate(() => document.getElementById('statusText').textContent);
        const t0 = Date.now();
        await page.evaluate((id) => document.getElementById(id).click(), button);
        for (;;) {
            const st = await page.evaluate(() => ({ s: document.getElementById('statusText').textContent, hidden: document.getElementById('loadingOverlay').classList.contains('hidden') }));
            if (st.hidden && st.s !== prev && re.test(st.s)) { const ms = Date.now() - t0; log(`${side} ${what}: ${(ms / 1000).toFixed(1)} s — ${st.s.slice(0, 90)}`); return ms; }
            if (Date.now() - t0 > 60 * 60000) throw new Error(what + ' timed out');
            await new Promise((r) => setTimeout(r, 250));
        }
    };
    const out = { side };
    out.trackMs = await step('tbTrackAll', /Assigned \d+ identities/, 'Track All');
    out.afterTrack = await page.evaluate(SNAPSHOT, SAMPLE);
    if (TRI) {
        await page.evaluate(async (m) => { (await import('./ui/settings.js')).setDefaultTriangulationMethod(m); }, TRI);
        out.triMs = await step('tbTriangulateAll', /^(Triangulated|Grouped) /, 'Triangulate All (' + TRI + ')');
        out.afterTri = await page.evaluate(SNAPSHOT, SAMPLE);
    }
    await page.close();
    return out;
};

// Compare two snapshots: frames whose groups differ, and the largest 3D difference on sampled frames.
const compare = (a, b) => {
    const ha = new Map(a.hashes.map((h) => h.split(':'))), hb = new Map(b.hashes.map((h) => h.split(':')));
    const differ = [];
    for (const [f, h] of ha) if (hb.get(f) !== h) differ.push(+f);
    for (const f of hb.keys()) if (!ha.has(f)) differ.push(+f);
    let max3d = 0, n3d = 0;
    for (const f of Object.keys(a.pts)) {
        const pa = new Map(a.pts[f].map(([id, p]) => [id, p])), pb = new Map((b.pts[f] || []).map(([id, p]) => [id, p]));
        for (const [id, p] of pa) {
            const q = pb.get(id);
            if (!p || !q || p.length !== q.length) continue;
            for (let k = 0; k < p.length; k += 3) {
                if (!isFinite(p[k]) || !isFinite(q[k])) continue;
                max3d = Math.max(max3d, Math.hypot(p[k] - q[k], p[k + 1] - q[k + 1], p[k + 2] - q[k + 2])); n3d++;
            }
        }
    }
    return { identities: [a.identities, b.identities], groups: [a.groups, b.groups], framesCompared: ha.size, framesDiffer: differ.length,
        firstDiffer: differ.sort((x, y) => x - y).slice(0, 20), max3dMm: max3d, points3dCompared: n3d,
        sampleExample: differ.length ? (() => { const f = differ.find((x) => a.canon[x]); return f != null ? { frame: f, old: a.canon[f], new: b.canon[f] } : null; })() : null };
};

const releaseLock = await acquireBrowserLock({ label: '_diag-trackall-ab' });
let browser;
const result = { dataset: DATASET, old: oldSha, new: newSha, newDirty: dirty, newThresholds: NEW_THRESHOLDS, nAnimals: NANIMALS, tri: TRI, sample: SAMPLE, runs: [] };
try {
    browser = await chromium.launch({ headless: false, channel: 'chrome', args: ['--window-size=1500,950'] });
    for (let r = 0; r < REPEAT; r++) {
        const o = await runSide('OLD', PORT), n = await runSide('NEW', PORT + 1);
        const cmp = { repeat: r, trackMs: [o.trackMs, n.trackMs], triMs: [o.triMs, n.triMs], afterTrack: compare(o.afterTrack, n.afterTrack) };
        if (TRI) cmp.afterTri = compare(o.afterTri, n.afterTri);
        result.runs.push(cmp);
        log(`run ${r + 1}: Track All ${(o.trackMs / 1000).toFixed(1)} -> ${(n.trackMs / 1000).toFixed(1)} s; identities ${cmp.afterTrack.identities.join(' / ')}; ` +
            `groups ${cmp.afterTrack.groups.join(' / ')}; frames whose groups differ: ${cmp.afterTrack.framesDiffer} of ${cmp.afterTrack.framesCompared}; ` +
            `tracker 3D max diff ${cmp.afterTrack.max3dMm.toExponential(2)} mm over ${cmp.afterTrack.points3dCompared} points`);
        if (TRI) log(`       Triangulate All ${(o.triMs / 1000).toFixed(1)} -> ${(n.triMs / 1000).toFixed(1)} s; frames differ ${cmp.afterTri.framesDiffer}; ` +
            `3D max diff ${cmp.afterTri.max3dMm.toExponential(2)} mm over ${cmp.afterTri.points3dCompared} points`);
    }
} finally {
    if (browser) await browser.close().catch(() => {});
    await releaseLock();
    servers.forEach((s) => s.kill());
    fs.rmSync(oldDir, { recursive: true, force: true });
    const dir = path.join(repoRoot, 'verify', 'trackall-ab');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${LABEL}-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.json`);
    fs.writeFileSync(file, JSON.stringify(result, null, 1));
    log('wrote ' + path.relative(repoRoot, file));
}
