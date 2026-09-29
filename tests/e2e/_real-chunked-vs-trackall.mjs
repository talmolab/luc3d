/**
 * _real-chunked-vs-trackall.mjs — does Track Frame Range (#212) over N
 * non-overlapping chunks reproduce a single Track All over the whole
 * recording?
 *
 * This is the standing equivalence check for the feature. `track-frame-range.mjs`
 * proves the range machinery is correctly SCOPED (it touches only its own
 * frames, recycles identities, clamps its endpoints); this proves the tracking
 * it produces is the SAME TRACKING — that chopping a recording into windows
 * does not quietly change who is who. An `_real-` tool rather than a suite
 * assertion, because it needs a real multi-camera session folder on disk.
 *
 * ## What it does
 *
 * Two independent runs, in two independent pages (page A is closed before page
 * B opens, so they never share a renderer heap — see `_real-roundtrip.mjs` for
 * why that matters on a large project):
 *
 *   A. one `trackAll()` over every frame
 *   B. a fresh load of the same folder, then `trackFrameRange()` over each of
 *      N contiguous, non-overlapping chunks covering exactly the same frames
 *
 * Each run returns one compact line per frame — `camIdx:trackIdx=identityId`
 * for every detection that got an identity — and the comparison happens here
 * in Node.
 *
 * ## Two metrics, because identity LABELS are arbitrary but the GROUPING is not
 *
 * A range run restarts the tracker at its first frame, so chunk k may call an
 * animal `id_2` where Track All called it `id_0`. Comparing raw label equality
 * would report that as total disagreement, which is meaningless.
 *
 *   - **Partition agreement** (label-invariant): does each frame split its
 *     detections into the same groups? This is the real "are the tracks the
 *     same" question.
 *   - **Label agreement after per-chunk best-match relabeling**: having found
 *     each chunk's best identity mapping, how many detections agree? This
 *     catches a chunk that groups each frame correctly but links identities
 *     across frames differently — which partition agreement alone would miss.
 *
 * Disagreements are expected only at chunk STARTS, where the range run has no
 * history yet and Track All does, so the report says how far into its chunk
 * each mismatch sits.
 *
 * ## Result on the reference project (10072022145420)
 *
 * 8 cameras (6 with predictions), 18,255 frames, 15 nodes, 4 tracks, 6 chunks:
 * partition identical on 18,254/18,255 frames (99.995%), labels identical on
 * 410,481/410,482 detections (100.000%), 4 identities in both runs. The single
 * difference is one 2-view bundle on frame 3066, 23 frames into chunk 2 —
 * Track All arrived carrying a target for that animal from earlier frames so a
 * weak two-camera association cleared the gate; the chunk had not established
 * it yet. That is the minimum possible disagreement.
 *
 * Videos are deliberately never fetched (hundreds of MB each, and irrelevant
 * to association) — `deferVideos` is set on the loader.
 *
 * Run:
 *   PROJ=/abs/path/to/session-folder node tests/e2e/_real-chunked-vs-trackall.mjs
 *   PROJ=... NCHUNKS=6 ANIMALS=4 node tests/e2e/_real-chunked-vs-trackall.mjs
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8171);
const PROJ = process.env.PROJ;
const NCHUNKS = Number(process.env.NCHUNKS || 6);
const ANIMALS = process.env.ANIMALS ? Number(process.env.ANIMALS) : null;
// Partition/label agreement below this is a failure. Boundary effects cost a
// handful of frames out of tens of thousands, so anything under 98% is a real
// divergence, not a missing prior.
const MIN_AGREE = Number(process.env.MIN_AGREE || 0.98);

const VIDEO_EXT = new Set(['.mp4', '.avi', '.webm', '.mov', '.mkv']);
const PRED_EXT = new Set(['.h5', '.slp']);

const t0 = Date.now();
const el = () => ((Date.now() - t0) / 1000).toFixed(1) + 's';
const log = (...a) => console.log(`[${el()}]`, ...a);
let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

if (!PROJ || !fs.existsSync(PROJ) || !fs.statSync(PROJ).isDirectory()) {
    console.error('Set PROJ=/abs/path/to/session-folder (calibration.toml + per-camera subdirs).');
    process.exit(2);
}

/*
 * Discover the session folder's contents the way the app's folder picker would
 * see them, minus the videos. Per-camera prediction files are whatever `.h5` /
 * `.slp` sits directly in a camera subdir — `calibration_images/` is skipped
 * (it holds per-camera calibration clips, not annotations) and so is anything
 * `.externals.` (environment geometry, loaded by a different path). A camera
 * subdir with no prediction file is simply omitted: it still becomes a Camera
 * from the calibration, just with no detections, which is what the app does.
 */
const projName = path.basename(PROJ.replace(/\/+$/, ''));
let calibRel = null, skeletonRel = null;
const camPreds = [];
for (const entry of fs.readdirSync(PROJ, { withFileTypes: true })) {
    if (entry.isFile()) {
        const lower = entry.name.toLowerCase();
        if ((lower.endsWith('.toml') || lower.endsWith('.json')) && lower.includes('calib')) {
            calibRel = entry.name;
        } else if (lower.endsWith('.json') && lower.includes('skeleton')) {
            skeletonRel = entry.name;
        }
        continue;
    }
    if (!entry.isDirectory() || entry.name === 'calibration_images') continue;
    for (const f of fs.readdirSync(path.join(PROJ, entry.name))) {
        const lower = f.toLowerCase();
        const ext = lower.slice(lower.lastIndexOf('.'));
        if (VIDEO_EXT.has(ext) || !PRED_EXT.has(ext) || lower.includes('.externals.')) continue;
        camPreds.push([entry.name, f]);
        break;                               // one prediction file per camera
    }
}
if (!calibRel) { console.error('No calibration .toml/.json at the root of ' + PROJ); process.exit(2); }
if (camPreds.length < 2) { console.error('Need >= 2 camera subdirs with a prediction file; found ' + camPreds.length); process.exit(2); }
log(`discovered: calibration=${calibRel}, skeleton=${skeletonRel || '(none)'}, ` +
    `cameras with predictions=${camPreds.map(c => c[0]).join('/')}`);

// Serve the project from the repo origin. python http.server follows symlinks,
// and same-origin means the page can just fetch() these paths.
const linkName = '_realproj_' + process.pid;
const linkPath = path.join(repoRoot, linkName);
fs.symlinkSync(PROJ, linkPath);

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

// Runs in the page: fetch the session-folder files and drive the REAL loader.
async function loadProject({ link, projName, calibRel, skeletonRel, cams }) {
    const mk = async (relPath, url) => {
        const resp = await fetch(url);
        if (!resp.ok) throw new Error('fetch ' + url + ' -> ' + resp.status);
        const f = new File([await resp.blob()], relPath.split('/').pop());
        // webkitRelativePath is read-only, and the loader keys everything off
        // it — folder name, camera subdir, root-vs-subdir classification.
        Object.defineProperty(f, 'webkitRelativePath', { value: relPath });
        return f;
    };
    const files = [await mk(projName + '/' + calibRel, '/' + link + '/' + calibRel)];
    if (skeletonRel) files.push(await mk(projName + '/' + skeletonRel, '/' + link + '/' + skeletonRel));
    for (const [cam, pred] of cams) {
        files.push(await mk(projName + '/' + cam + '/' + pred, '/' + link + '/' + cam + '/' + pred));
    }
    const sl = await import('/loading/session-loader.js');
    window.__loadErr = null;
    // deferVideos = true: never touch the per-camera videos.
    sl.handleLoadSessionFolderPerCamera(files, true)
        .catch(e => { window.__loadErr = String((e && e.stack) || e).slice(0, 500); });
    return files.length;
}

// Installed in the page: one compact line per frame that HAS identities.
function snapshotSource() {
    window.__snapshotIdentities = function () {
        const s = window.__lucid.state.session;
        const camIdx = new Map();
        s.cameras.forEach((c, i) => camIdx.set(c.name, i));
        const perFrame = new Map();
        for (const rec of s.frameIdentityEntries()) {
            // Skip the EXPLICIT_NONE (-1) sentinel: it records "this detection
            // deliberately got no identity", which is bookkeeping, not a group.
            if (rec.identityId == null || rec.identityId < 0) continue;
            let arr = perFrame.get(rec.frameIdx);
            if (!arr) { arr = []; perFrame.set(rec.frameIdx, arr); }
            arr.push((camIdx.get(rec.camName) ?? -1) + ':' + rec.trackIdx + '=' + rec.identityId);
        }
        const out = [];
        for (const [f, arr] of perFrame) { arr.sort(); out.push(f + ' ' + arr.join(',')); }
        out.sort((a, b) => parseInt(a, 10) - parseInt(b, 10));
        return out;
    };
}

async function runPage(browser, label, body) {
    const page = await browser.newPage();
    page.on('pageerror', e => log(`[${label} pageerror]`, String(e).slice(0, 200)));
    page.on('crash', () => { log(`*** ${label} RENDERER CRASHED ***`); fails++; });
    // Track All asks for the animal count with a native prompt(). An UNHANDLED
    // dialog is auto-dismissed by Playwright, so prompt() returns null,
    // promptNumAnimals() returns false, and trackAll() returns silently having
    // done nothing at all. Accept it. (Track Frame Range needs no handler —
    // its modal collects the count, which is why runTrackingPass skips the
    // prompt on that path.)
    page.on('dialog', async d => { await d.accept(ANIMALS != null ? String(ANIMALS) : ''); });
    await page.goto(`http://localhost:${PORT}/index.html`);
    await page.waitForFunction(() => window.__lucid && window.SleapIO, { timeout: 30000 });
    // The folder loader ends in interactive modals that never resolve
    // headlessly; dismiss them on a timer and poll the state instead.
    await page.evaluate(() => {
        setInterval(() => {
            for (const b of Array.from(document.querySelectorAll('button'))) {
                const t = b.textContent.trim();
                if ((t === 'Continue' || t.startsWith('Skip') || t === 'Cancel' || t === 'Close')
                    && b.offsetParent !== null) b.click();
            }
        }, 250);
    });
    await page.evaluate(snapshotSource);

    log(`${label}: loading project …`);
    const n = await page.evaluate(loadProject, {
        link: linkName, projName, calibRel, skeletonRel, cams: camPreds,
    });
    log(`${label}: handed ${n} files to handleLoadSessionFolderPerCamera`);
    await page.waitForFunction(() => {
        const s = window.__lucid.state.session;
        return !!(s && s.cameras && s.cameras.length >= 2 && s.frameGroups && s.frameGroups.size > 100)
            || window.__loadErr;
    }, { timeout: 600000 });
    const info = await page.evaluate(() => {
        const s = window.__lucid.state.session;
        return {
            err: window.__loadErr,
            cameras: s.cameras.map(c => c.name),
            frames: s.frameGroups.size,
            minF: Math.min(...s.frameGroups.keys()),
            maxF: Math.max(...s.frameGroups.keys()),
            nodes: s.skeleton.nodes.length,
            tracks: s.tracks.length,
        };
    });
    if (info.err) throw new Error(`${label} load failed: ${info.err}`);
    log(`${label}: loaded ${JSON.stringify({ ...info, cameras: info.cameras.join('/') })}`);

    const result = await body(page, info);
    await page.close();
    return { info, result };
}

let A, B;
try {
    const browser = await chromium.launch();

    // ---------------------------------------------------------------- run A
    A = await runPage(browser, 'A(trackAll)', async (page) => {
        log('A: Track All over every frame …');
        const r = await page.evaluate(async (animals) => {
            const tracker = await import('/pose/tracker.js');
            tracker.setTrackerNumAnimals(animals);
            const t = performance.now();
            await tracker.trackAll();
            const s = window.__lucid.state.session;
            return {
                ms: Math.round(performance.now() - t),
                status: document.getElementById('statusText').textContent,
                identities: s.identities.length,
                fim: s.frameIdentityMap.size,
                lines: window.__snapshotIdentities(),
            };
        }, ANIMALS);
        log(`A: ${r.status}  (${(r.ms / 1000).toFixed(1)}s, ${r.identities} identities, ${r.fim.toLocaleString()} entries)`);
        return r;
    });

    // ---------------------------------------------------------------- run B
    const { minF, maxF } = A.info;
    const size = Math.ceil((maxF - minF + 1) / NCHUNKS);
    const chunks = [];
    for (let i = 0; i < NCHUNKS; i++) {
        const lo = minF + i * size;
        if (lo > maxF) break;
        chunks.push([lo, Math.min(maxF, lo + size - 1)]);
    }
    log(`B: ${chunks.length} non-overlapping chunks: ${chunks.map(c => c[0] + '-' + c[1]).join(', ')}`);

    B = await runPage(browser, 'B(NxRange)', async (page) => {
        const r = await page.evaluate(async ({ animals, chunks }) => {
            const tracker = await import('/pose/tracker.js');
            tracker.setTrackerNumAnimals(animals);
            const per = [];
            const t = performance.now();
            for (const [lo, hi] of chunks) {
                const t1 = performance.now();
                await tracker.trackFrameRange(lo, hi);
                per.push({
                    lo, hi,
                    ms: Math.round(performance.now() - t1),
                    status: document.getElementById('statusText').textContent,
                    identitiesAfter: window.__lucid.state.session.identities.length,
                });
            }
            const s = window.__lucid.state.session;
            return {
                ms: Math.round(performance.now() - t), per,
                identities: s.identities.length,
                fim: s.frameIdentityMap.size,
                lines: window.__snapshotIdentities(),
            };
        }, { animals: ANIMALS, chunks });
        for (const p of r.per) log(`   chunk ${p.lo}-${p.hi}: ${(p.ms / 1000).toFixed(1)}s, identities now ${p.identitiesAfter}`);
        log(`B: total ${(r.ms / 1000).toFixed(1)}s, ${r.identities} identities, ${r.fim.toLocaleString()} entries`);
        return { ...r, chunks };
    });

    await browser.close();
} catch (e) {
    console.log('[harness error]', String((e && e.stack) || e).slice(0, 900));
    fails++;
} finally {
    server.kill('SIGTERM');
    try { fs.unlinkSync(linkPath); } catch { /* already gone */ }
}

if (!A || !B) { console.log('\nFAIL — a run did not complete'); process.exit(1); }

// ------------------------------------------------------------------ compare
const parse = (lines) => {
    const m = new Map();
    for (const line of lines) {
        const sp = line.indexOf(' ');
        const dets = new Map();
        for (const tok of line.slice(sp + 1).split(',')) {
            const eq = tok.lastIndexOf('=');
            dets.set(tok.slice(0, eq), parseInt(tok.slice(eq + 1), 10));
        }
        m.set(parseInt(line.slice(0, sp), 10), dets);
    }
    return m;
};
const a = parse(A.result.lines);
const b = parse(B.result.lines);
const common = [...a.keys()].filter(f => b.has(f)).sort((x, y) => x - y);

// Metric A — label-invariant partition agreement.
const partition = (dets) => {
    const byId = new Map();
    for (const [det, id] of dets) {
        let g = byId.get(id); if (!g) { g = []; byId.set(id, g); } g.push(det);
    }
    return [...byId.values()].map(g => g.sort().join('+')).sort().join('|');
};
let partSame = 0;
const partDiffFrames = [];
for (const f of common) {
    if (partition(a.get(f)) === partition(b.get(f))) partSame++;
    else partDiffFrames.push(f);
}

// Metric B — per-chunk best-match relabeling, then per-detection agreement.
const chunks = B.result.chunks;
let detTotal = 0, detAgree = 0;
const perChunk = [];
for (const [lo, hi] of chunks) {
    const frames = common.filter(f => f >= lo && f <= hi);
    const counts = new Map();                            // "bId>aId" -> overlap
    for (const f of frames) {
        const da = a.get(f), db = b.get(f);
        for (const [det, bId] of db) {
            const aId = da.get(det); if (aId == null) continue;
            const k = bId + '>' + aId;
            counts.set(k, (counts.get(k) || 0) + 1);
        }
    }
    // Greedy highest-overlap-first pairing. Exact assignment would need
    // Hungarian, but with a handful of identities per chunk greedy is optimal
    // in every realistic case and far easier to read.
    const map = new Map(); const usedA = new Set();
    for (const [k] of [...counts.entries()].sort((x, y) => y[1] - x[1])) {
        const [bId, aId] = k.split('>').map(Number);
        if (map.has(bId) || usedA.has(aId)) continue;
        map.set(bId, aId); usedA.add(aId);
    }
    let tot = 0, agr = 0, firstBad = null;
    for (const f of frames) {
        const da = a.get(f), db = b.get(f);
        for (const [det, bId] of db) {
            const aId = da.get(det); if (aId == null) continue;
            tot++;
            if (map.get(bId) === aId) agr++;
            else if (firstBad == null) firstBad = f;
        }
    }
    detTotal += tot; detAgree += agr;
    perChunk.push({ lo, hi, tot, agr, pct: tot ? agr / tot * 100 : 100, firstBad });
}

const chunkStarts = chunks.map(c => c[0]);
const distToStart = (f) => Math.min(...chunkStarts.map(s => (f >= s ? f - s : Infinity)));
const nearStart = partDiffFrames.filter(f => distToStart(f) < 30).length;

console.log('\n============ chunked Track Frame Range  vs  single Track All ============');
console.log(`project            ${projName}  (${A.info.cameras.length} cams, ${A.info.nodes} nodes, ${A.info.tracks} tracks)`);
console.log(`frames             ${A.info.minF}–${A.info.maxF}  (${A.info.frames.toLocaleString()} with data)`);
console.log(`chunks             ${chunks.length} x ~${chunks[0][1] - chunks[0][0] + 1} frames, non-overlapping, whole range`);
console.log(`identities         Track All ${A.result.identities}   |   ${chunks.length}x Range ${B.result.identities}`);
console.log(`identity entries   Track All ${A.result.fim.toLocaleString()}   |   ${chunks.length}x Range ${B.result.fim.toLocaleString()}   (incl. -1 sentinels, which the comparison skips)`);
console.log(`frames compared    ${common.length.toLocaleString()}`);
console.log(`\nMETRIC A — per-frame grouping partition (label-invariant)`);
console.log(`  identical on     ${partSame.toLocaleString()} / ${common.length.toLocaleString()} frames  = ${(partSame / common.length * 100).toFixed(3)}%`);
console.log(`  differing        ${partDiffFrames.length.toLocaleString()} frames; ${nearStart} within 30 frames of a chunk start`);
if (partDiffFrames.length) {
    console.log(`  first few        ${partDiffFrames.slice(0, 12).join(', ')}`);
    console.log('  --- detail (up to 5) ---');
    const fmt = (m) => [...m.entries()].sort().map(([d, i]) => d + '=' + i).join(' ');
    for (const f of partDiffFrames.slice(0, 5)) {
        console.log(`  frame ${f}  (+${distToStart(f)} into its chunk)`);
        console.log(`    TrackAll  ${fmt(a.get(f))}`);
        console.log(`    NxRange   ${fmt(b.get(f))}`);
    }
}
console.log(`\nMETRIC B — identity labels, after per-chunk best-match relabeling`);
for (const c of perChunk) {
    console.log(`  ${String(c.lo).padStart(6)}–${String(c.hi).padEnd(6)}  ${c.agr.toLocaleString().padStart(9)}/${c.tot.toLocaleString().padEnd(9)} = ${c.pct.toFixed(3).padStart(7)}%   first mismatch: ${c.firstBad == null ? '—' : c.firstBad + ' (+' + (c.firstBad - c.lo) + ' into chunk)'}`);
}
console.log(`  ${'overall'.padStart(13)}  ${detAgree.toLocaleString().padStart(9)}/${detTotal.toLocaleString().padEnd(9)} = ${(detAgree / detTotal * 100).toFixed(3)}%`);
console.log('=========================================================================\n');

check(A.result.identities > 0, `Track All produced identities (${A.result.identities})`);
check(B.result.identities > 0, `the chunked run produced identities (${B.result.identities})`);
check(B.result.identities === A.result.identities,
    `both runs settled on the same identity count (${A.result.identities} vs ${B.result.identities})`);
check(common.length > A.info.frames * 0.9,
    `both runs covered essentially the same frames (${common.length.toLocaleString()} in common of ${A.info.frames.toLocaleString()})`);
check(partSame / common.length > MIN_AGREE,
    `grouping partition matches on >${(MIN_AGREE * 100).toFixed(0)}% of frames (${(partSame / common.length * 100).toFixed(3)}%)`);
check(detAgree / detTotal > MIN_AGREE,
    `identity labels match on >${(MIN_AGREE * 100).toFixed(0)}% of detections after per-chunk relabeling (${(detAgree / detTotal * 100).toFixed(3)}%)`);

console.log(fails ? `FAIL — ${fails} check(s) failed` : 'PASS');
process.exit(fails ? 1 : 0);
