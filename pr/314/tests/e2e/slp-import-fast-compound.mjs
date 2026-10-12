/**
 * slp-import-fast-compound.mjs — the SLP import worker's fast compound reader
 * (`readCompoundColumnsFast`, loading/slp-import-worker.js) must produce exactly
 * what h5wasm's `Dataset.value` path produced.
 *
 * The fast reader decodes the `frames` / `instances` / `points` / `pred_points`
 * compound tables straight from their record buffer instead of through
 * `Dataset.value` (which builds a JS array of TypedArrays per row — ~52–58 s of a
 * 72 s 8-camera session load). It feeds every frame/instance/point LUCID loads
 * from a SLEAP-written `.slp`, so it is pinned to the old path value for value:
 * the worker is run twice on the same file — once normally, once with
 * `slowCompound: true` (the old path) — and the two `result` payloads must be
 * deep-equal (`Object.is` on every number, so NaN and -0 count).
 *
 * Also asserted: the fast path actually ran (else this would compare the slow
 * path with itself), and it is faster.
 *
 * Second contract, same files: the worker's opt-in COLUMNAR result
 * (`{ columnar: true }` — flat transferred typed arrays, what "Load Single
 * Session Folder" now asks for) expands back to exactly the default nested
 * `frames`: same frames kept, same instances kept, same track/score/type, every
 * coordinate (NaN = missing -> null) and every occlusion flag. And the
 * session-side consumer, `addColumnarFramesToSession`, builds Instances identical
 * (coords bit for bit, occlusion bits, track, type, score) to the nested-`frames`
 * loop it replaced in `handleLoadSessionFolderPerCamera`.
 *
 * Inputs: `tests/fixtures/slp-compound/sleap-compound-small.slp` (a genuine
 * Python-sleap-io file — LUCID's own writer emits 2-D matrices, which never take
 * the compound path). `DATASET=<session folder>` additionally checks every
 * `.slp` under it (e.g. the 8 HardFight_1kModels cameras).
 *
 * Run: node tests/e2e/slp-import-fast-compound.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8141);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

const files = [path.join(repoRoot, 'tests/fixtures/slp-compound/sleap-compound-small.slp')];
if (process.env.DATASET) {
    const walk = (d) => fs.readdirSync(d, { withFileTypes: true }).flatMap(e =>
        e.isDirectory() ? walk(path.join(d, e.name))
            : (/\.slp$/i.test(e.name) && !e.name.startsWith('.') ? [path.join(d, e.name)] : []));
    files.push(...walk(process.env.DATASET).sort());
}

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

try {
    const browser = await chromium.launch();
    const page = await browser.newPage();
    page.on('pageerror', e => { console.log('  [pageerror]', String(e).slice(0, 300)); fails++; });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page.evaluate(() => {
        const inp = document.createElement('input');
        inp.type = 'file'; inp.id = '__slp';
        document.body.appendChild(inp);
        window.__parse = (file, slowCompound, columnar) => new Promise((resolve, reject) => {
            const w = new Worker(new URL('loading/slp-import-worker.js', document.baseURI), { type: 'module' });
            const msgs = [];
            const t0 = performance.now();
            w.onmessage = (e) => {
                const m = e.data;
                if (m.type === 'progress') msgs.push(m.message);
                else if (m.type === 'result') { w.terminate(); resolve({ data: m.data, msgs, ms: performance.now() - t0 }); }
                else if (m.type === 'error') { w.terminate(); reject(new Error(m.message)); }
            };
            w.postMessage({ type: 'parse', file, slowCompound, columnar: !!columnar });
        });
        // The columnar result in the nested `frames` shape the worker builds by default.
        window.__expand = (c) => {
            const out = [];
            for (let f = 0; f < c.nFrames; f++) {
                const instances = [];
                for (let i = c.instOffsets[f]; i < c.instOffsets[f + 1]; i++) {
                    const points = [], occluded = [];
                    for (let k = 0; k < c.numNodes; k++) {
                        const o = (i * c.numNodes + k) * 2;
                        const x = c.xy[o], y = c.xy[o + 1];
                        points.push(Number.isNaN(x) ? null : [x, y]);
                        occluded.push(c.occluded[i * c.numNodes + k] === 1);
                    }
                    instances.push({ trackIdx: c.trackIdx[i], score: c.score[i],
                        type: c.type[i] === 1 ? 'predicted' : 'user', points, occluded });
                }
                out.push({ frameIdx: c.frameIdx[f], videoIdx: c.videoIdx[f], instances });
            }
            return out;
        };
        // First difference between two structured-clone payloads, or null.
        window.__diff = (a, b, p = '') => {
            if (typeof a === 'number' && typeof b === 'number') return Object.is(a, b) ? null : `${p}: ${a} !== ${b}`;
            if (typeof a !== typeof b) return `${p}: type ${typeof a} !== ${typeof b}`;
            if (a === null || b === null || typeof a !== 'object') return a === b ? null : `${p}: ${a} !== ${b}`;
            if (Array.isArray(a) !== Array.isArray(b)) return `${p}: array/object mismatch`;
            const ka = Object.keys(a), kb = Object.keys(b);
            if (ka.length !== kb.length) return `${p}: ${ka.length} keys !== ${kb.length}`;
            for (const k of ka) {
                const d = window.__diff(a[k], b[k], p + '.' + k);
                if (d) return d;
            }
            return null;
        };
    });

    for (const f of files) {
        console.log(`\n• ${path.relative(process.env.DATASET || repoRoot, f)}`);
        await page.setInputFiles('#__slp', f);
        const r = await page.evaluate(async () => {
            const file = document.getElementById('__slp').files[0];
            const slow = await window.__parse(file, true);
            const fast = await window.__parse(file, false);
            const col = await window.__parse(file, false, true);
            const c = col.data.columnar;
            // Instances both ways: the nested loop the loader used to run, and the
            // columnar builder it runs now.
            const pd = await import('./pose/pose-data.js');
            const sl = await import('./loading/session-loader.js');
            const tracks = fast.data.tracks || ['track_0'];
            const mk = () => new pd.Session([], new pd.Skeleton('s', [], []), tracks.slice(), 'x');
            const sOld = mk(), sNew = mk();
            const remap = {};
            for (let ti = 0; ti < tracks.length; ti++) remap[ti] = ti;
            for (const fr of fast.data.frames) {
                if (!sOld.frameGroups.has(fr.frameIdx)) sOld.addFrameGroup(new pd.FrameGroup(fr.frameIdx));
                const fg = sOld.getFrameGroup(fr.frameIdx);
                for (const inst of fr.instances) {
                    const rem = remap[inst.trackIdx] !== undefined ? remap[inst.trackIdx] : inst.trackIdx;
                    const ti = sl.resolveImportTrackIdx(sOld, rem, inst.type);
                    const I = new pd.Instance(inst.points || [], ti, inst.type, inst.score || 1.0);
                    if (inst.occluded) I.setOccludedFrom(inst.occluded);
                    fg.addInstance('cam', I);
                }
            }
            sl.addColumnarFramesToSession(sNew, 'cam', c, remap);
            const dump = (S) => {
                const out = [];
                for (const fi of Array.from(S.frameGroups.keys()).sort((a, b) => a - b)) {
                    for (const I of S.getFrameGroup(fi).instances.get('cam') || []) {
                        const occ = [];
                        for (let k = 0; k < I.numNodes; k++) occ.push(I.isOccluded(k));
                        out.push({ fi, xy: Array.from(I._xy), occ, t: I.trackIdx, type: I.type, score: I.score });
                    }
                }
                return out;
            };
            const instDiff = window.__diff(dump(sOld), dump(sNew), 'instances');
            const nInst = fast.data.frames.reduce((s, fr) => s + fr.instances.length, 0);
            const nUser = fast.data.frames.reduce((s, fr) => s + fr.instances.filter(i => i.type === 'user').length, 0);
            let nNull = 0, nOcc = 0;
            for (const fr of fast.data.frames) for (const i of fr.instances) {
                for (const p of i.points) if (p === null) nNull++;
                for (const o of i.occluded) if (o) nOcc++;
            }
            return {
                diff: window.__diff(slow.data, fast.data),
                colDiff: c ? window.__diff(fast.data.frames, window.__expand(c), 'frames') : 'no columnar result',
                colFramesEmpty: col.data.frames.length === 0,
                colTransferred: !!c && c.xy instanceof Float64Array && c.xy.length === c.nInstances * c.numNodes * 2,
                colMs: Math.round(col.ms),
                instDiff,
                fastUsed: fast.msgs.filter(m => /fast compound read/.test(m)).length,
                slowUsed: slow.msgs.filter(m => /fast compound read/.test(m)).length,
                frames: fast.data.frames.length, nInst, nUser, nNull, nOcc,
                slowMs: Math.round(slow.ms), fastMs: Math.round(fast.ms),
            };
        });
        console.log(`  ${r.frames} frames, ${r.nInst} instances (${r.nUser} user), ${r.nNull} missing nodes; ` +
            `Dataset.value ${r.slowMs} ms vs fast ${r.fastMs} ms vs fast+columnar ${r.colMs} ms`);
        check(r.frames > 0 && r.nInst > 0, 'parsed real data');
        check(r.fastUsed >= 2, `the fast reader ran (frames + instances report it: ${r.fastUsed})`);
        check(r.slowUsed === 0, 'slowCompound: true really took the old Dataset.value path');
        check(r.diff === null, 'fast and Dataset.value results are identical' + (r.diff ? ` — first difference ${r.diff}` : ''));
        check(r.colDiff === null, 'columnar result expands to exactly the nested frames' + (r.colDiff ? ` — first difference ${r.colDiff}` : ''));
        check(r.instDiff === null, 'addColumnarFramesToSession builds the same Instances as the nested loop' +
            (r.instDiff ? ` — first difference ${r.instDiff}` : ''));
        check(r.colFramesEmpty && r.colTransferred, 'columnar replaces (not duplicates) the nested frames, as flat Float64 xy');
        if (f.includes('sleap-compound-small')) {
            check(r.nUser > 0, 'fixture covers user instances (the `points` table)');
            check(r.nNull > 0, 'fixture covers missing (NaN) nodes');
            check(r.nOcc > 0, `fixture covers occluded nodes (coords kept, visible=False): ${r.nOcc}`);
        } else {
            check(r.fastMs < r.slowMs, `fast reader is faster on a real file (${r.fastMs} < ${r.slowMs} ms)`);
        }
    }
    await browser.close();
} finally {
    server.kill();
}
console.log(fails ? `\nFAIL (${fails})` : '\nPASS');
process.exit(fails ? 1 : 0);
