/**
 * custom-delete-roundtrip.mjs — THE durability proof for Custom Instance Delete.
 *
 * A bulk delete that only mutates `session.frameGroups`/`instanceGroups` looks
 * perfect in the UI and is not a delete at all on a lazy project. It fails twice:
 *
 *   - WITHOUT SAVING. `finalizeLazyFrameGroup` re-derives `fg.instances` from the
 *     columnar store rows on every hydration and puts any row with no matching
 *     `_rawInstIndex` member into the UNGROUPED pool. Scrub away and back and the
 *     instance is simply there again.
 *   - ON SAVE. The streaming writer ends in `appendStore`, which copies the store
 *     columns verbatim with no per-instance filter.
 *
 * So this test asserts the gates from scratch/PLAN-custom-instance-delete.md §1
 * against a REAL project that is saved, lazily reopened, mutated, saved again and
 * reopened again:
 *
 *   gate 2  does not come back when a frame is evicted and re-hydrated (NO save)
 *   gate 3  does not come back after save + reopen
 *   gate 4  the reopened store's instance-row count dropped by exactly N
 *   gate 5  no orphaned frameIdentityMap residue in the reopened project
 *   gate 6  does not come back after a subsequent Triangulate All (which rebuilds
 *           groups from frameIdentityMap via ensureGroupsFromIdentities)
 *
 * Scenario B (delete EVERY instance on one camera-frame) is the one that fails
 * against a naive implementation: the user-correction overlay bails on
 * `lucidInsts.length === 0`, so an emptied camera-frame streams back verbatim
 * unless the store itself was mutated.
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8101);
const FIXTURE = '_custom-delete-roundtrip.slp';
const FIXTURE_PATH = path.join(repoRoot, FIXTURE);

let fails = 0;
const check = (c, m) => { console.log((c ? '  ✓ ' : '  ✗ ') + m); if (!c) fails++; };

try { fs.unlinkSync(FIXTURE_PATH); } catch (e) { /* ignore */ }

const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
await new Promise(r => setTimeout(r, 1200));

const NF = 12;           // frames
const CAMS = ['camA', 'camB', 'camC'];
const PER_CAM = 2;       // instances per camera per frame -> 12*3*2 = 72 rows

let browser;
try {
    browser = await chromium.launch();

    // =======================================================================
    // Page 1 — build a real multi-camera project and save it through the real
    // save path, so page 2 can lazily REOPEN it (the path that matters).
    // =======================================================================
    const ctx1 = await browser.newContext();
    const page1 = await ctx1.newPage();
    page1.on('pageerror', e => { console.log('  [p1 pageerror]', String(e).slice(0, 300)); fails++; });
    page1.on('dialog', async d => { await d.accept(''); });

    let bytesWritten = 0;
    const fd = fs.openSync(FIXTURE_PATH, 'w');
    await page1.exposeFunction('__appendChunkBase64', (b64) => {
        const buf = Buffer.from(b64, 'base64');
        fs.writeSync(fd, buf);
        bytesWritten += buf.length;
    });

    await page1.goto(`http://localhost:${PORT}/index.html`);
    await page1.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    const built = await page1.evaluate(async ({ NF, CAMS, PER_CAM }) => {
        const pd = await import('/pose/pose-data.js');
        const saveLoad = await import('/import-export/save-load.js');
        const AS = await import('/ui/app-state.js');
        const { Skeleton, Camera, Instance, InstanceGroup, FrameGroup, Session } = pd;

        const K = [[600, 0, 320], [0, 600, 240], [0, 0, 1]];
        const cams = CAMS.map((n, i) =>
            new Camera(n, K, [0, 0, 0, 0, 0], [0, 0.25 * i, 0], [18 * i, 0, 0], [640, 480]));
        const skel = new Skeleton('sk', ['a', 'b'], [[0, 1]]);
        const session = new Session(cams, skel, ['t0', 't1'], 'CustomDeleteRT');

        // Two animals per camera per frame: track 0 is USER, track 1 is PREDICTED.
        // The mix matters: a frame with a surviving user instance takes the overlay
        // path on save, a frame without one does not.
        for (let f = 0; f < NF; f++) {
            const fg = new FrameGroup(f);
            session.addFrameGroup(fg);
            for (let t = 0; t < PER_CAM; t++) {
                const base = [10 - 6 * t + f * 0.1, 4 + t, 48 + t];
                const p2 = [base[0] + 1, base[1] + 1, base[2] + 1];
                for (const cam of cams) {
                    fg.addInstance(cam.name, new Instance(
                        [cam.project(base), cam.project(p2)], t, t === 0 ? 'user' : 'predicted', 1));
                }
            }
            // Group each track across all cameras, and stamp a per-frame identity
            // so gate 5 (residue) and gate 6 (resurrection) are exercised.
            const groups = [];
            for (let t = 0; t < PER_CAM; t++) {
                const g = new InstanceGroup(f * 10 + t, -1);
                for (const cam of cams) g.addInstance(cam.name, fg.instances.get(cam.name)[t]);
                groups.push(g);
            }
            session.instanceGroups.set(f, groups);
        }
        const idA = session.addIdentity('A');
        const idB = session.addIdentity('B');
        for (let f = 0; f < NF; f++) {
            for (const cam of cams) {
                session.setFrameIdentity(f, cam.name, 0, idA.id);
                session.setFrameIdentity(f, cam.name, 1, idB.id);
            }
            session.instanceGroups.get(f)[0].identityId = idA.id;
            session.instanceGroups.get(f)[1].identityId = idB.id;
        }

        AS.state.sessions = [session];
        AS.state.activeSessionIdx = 0;
        AS.state.session = session;
        AS.state.totalFrames = NF;
        AS.state.currentFrame = 0;
        AS.state.triangulationResults = new Map();
        AS.state.views = [];

        const toBase64 = (bytes) => {
            let binary = '';
            const CHUNK = 0x8000;
            for (let off = 0; off < bytes.length; off += CHUNK) {
                binary += String.fromCharCode.apply(null, bytes.subarray(off, off + CHUNK));
            }
            return btoa(binary);
        };
        window.showSaveFilePicker = async () => ({
            createWritable: async () => ({
                write: async (chunk) => {
                    await window.__appendChunkBase64(chunk instanceof Uint8Array ? toBase64(chunk) : toBase64(new Uint8Array(chunk)));
                },
                close: async () => {}, abort: async () => {},
            }),
        });
        await saveLoad.saveAs();
        return {
            frames: session.frameGroups.size,
            groups: session.instanceGroups.size,
            fimSize: session.frameIdentityMap.size,
            status: document.getElementById('statusText').textContent,
        };
    }, { NF, CAMS, PER_CAM });
    fs.closeSync(fd);

    console.log('  page1 built+saved:', JSON.stringify(built), `bytes=${bytesWritten}`);
    check(built.frames === NF, `built ${NF} frames (got ${built.frames})`);
    check(bytesWritten > 1000, `saved a non-trivial project (${bytesWritten} bytes)`);
    await ctx1.close();

    // =======================================================================
    // Page 2 — lazily reopen, delete, and prove the gates.
    // =======================================================================
    const ctx2 = await browser.newContext();
    const page2 = await ctx2.newPage();
    page2.on('pageerror', e => { console.log('  [p2 pageerror]', String(e).slice(0, 300)); fails++; });
    page2.on('dialog', async d => { await d.accept(''); });
    await page2.goto(`http://localhost:${PORT}/index.html`);
    await page2.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });

    // Real lazy-reopen entry point, then wait for the session to appear.
    await page2.evaluate(async (fixture) => {
        const sessionLoader = await import('/loading/session-loader.js');
        const resp = await fetch('/' + fixture);
        if (!resp.ok) throw new Error('fixture fetch failed: ' + resp.status);
        sessionLoader.handleLoadProjectSlpLazy(new File([await resp.blob()], 'rt.slp'));
    }, FIXTURE);

    await page2.waitForFunction(
        () => { const s = window.__lucid && window.__lucid.state; return !!(s && s.session && s.session.lazyLoader); },
        { timeout: 30000 });

    const storeRows = () => page2.evaluate(() => {
        let n = 0;
        window.__lucid.state.session.lazyLoader.forEachInstanceRow(() => { n++; });
        return n;
    });

    const rowsBefore = await storeRows();
    console.log('  reopened lazily; store instance rows =', rowsBefore);
    check(rowsBefore === NF * CAMS.length * PER_CAM,
        `precondition: store holds all ${NF * CAMS.length * PER_CAM} instance rows (got ${rowsBefore})`);

    // ---- Scenario A: delete PREDICTED instances on frame 0, all views --------
    const scenA = await page2.evaluate(async () => {
        const OPS = await import('/ui/custom-delete-ops.js');
        const TRI = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const session = AS.state.session;

        // Hydrate frame 0 the way scrubbing does, so the resident model is real.
        await TRI.ensureLazyFrameData(0);
        AS.state.currentFrame = 0;

        const filters = {
            type: 'predicted', grouping: 'any', view: null,
            trackMode: 'any', trackIdx: null, identityMode: 'any', identityId: null,
            frameScope: 'currentFrame',
        };
        const found = OPS.collectDeletionTargets(session, filters, { currentFrame: 0 });
        const res = OPS.executeDeletion(session, found.targets);
        return {
            matched: found.count,
            deleted: res.deleted,
            durable: res.durable,
            errorRows: res.errorRows,
            groupsDissolved: res.groupsDissolved,
        };
    });
    console.log('  scenario A (predicted on frame 0):', JSON.stringify(scenA));
    check(scenA.matched === CAMS.length, `matched the ${CAMS.length} predicted instances on frame 0 (got ${scenA.matched})`);
    check(scenA.errorRows === 0, 'no store row errors');
    check(scenA.durable === CAMS.length,
        `reported a DURABLE count of ${CAMS.length} (store rows), not just a resident one (got ${scenA.durable})`);

    const rowsAfterA = await storeRows();
    check(rowsAfterA === rowsBefore - CAMS.length,
        `gate 4: store rows dropped by exactly ${CAMS.length} (${rowsBefore} -> ${rowsAfterA})`);

    // ---- gate 2: evict and re-hydrate frame 0 WITHOUT saving ----------------
    const gate2 = await page2.evaluate(async () => {
        const TRI = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const session = AS.state.session;
        // Force frame 0 out of residency, then bring it back — the exact path
        // (`finalizeLazyFrameGroup`) that used to resurrect deleted rows into the
        // ungrouped pool.
        session.frameGroups.delete(0);
        await TRI.ensureLazyFrameData(0);
        const fg = session.getFrameGroup(0);
        let predResident = 0, ungroupedResident = 0;
        if (fg) {
            for (const [, arr] of fg.instances) for (const i of arr) if (i.type === 'predicted') predResident++;
            for (const [, ul] of fg.unlinkedInstances) ungroupedResident += ul.length;
        }
        return { predResident, ungroupedResident };
    });
    console.log('  gate 2 (evict + re-hydrate frame 0, no save):', JSON.stringify(gate2));
    check(gate2.predResident === 0,
        `gate 2: no predicted instance resurrected on re-hydration (got ${gate2.predResident})`);
    check(gate2.ungroupedResident === 0,
        `gate 2: nothing resurrected into the UNGROUPED pool either (got ${gate2.ungroupedResident})`);

    // ---- Scenario B: delete EVERYTHING on frame 1 (the empty-frame case) ----
    const scenB = await page2.evaluate(async () => {
        const OPS = await import('/ui/custom-delete-ops.js');
        const TRI = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const session = AS.state.session;
        await TRI.ensureLazyFrameData(1);
        AS.state.currentFrame = 1;
        const filters = {
            type: 'all', grouping: 'any', view: null,
            trackMode: 'any', trackIdx: null, identityMode: 'any', identityId: null,
            frameScope: 'currentFrame',
        };
        const found = OPS.collectDeletionTargets(session, filters, { currentFrame: 1 });
        const res = OPS.executeDeletion(session, found.targets);
        return { matched: found.count, deleted: res.deleted, durable: res.durable, errorRows: res.errorRows };
    });
    console.log('  scenario B (EVERYTHING on frame 1 — the empty-frame case):', JSON.stringify(scenB));
    check(scenB.matched === CAMS.length * PER_CAM,
        `matched all ${CAMS.length * PER_CAM} instances on frame 1 (got ${scenB.matched})`);
    check(scenB.errorRows === 0, 'no store row errors on the empty-frame case');

    const rowsAfterB = await storeRows();
    const expectedRows = rowsBefore - CAMS.length - CAMS.length * PER_CAM;
    check(rowsAfterB === expectedRows,
        `store rows now ${expectedRows} (${rowsBefore} - ${CAMS.length} - ${CAMS.length * PER_CAM}), got ${rowsAfterB}`);

    // ---- gate 6: Triangulate All must not resurrect anything ---------------
    const gate6 = await page2.evaluate(async () => {
        const EM = await import('/ui/export-modals.js');
        const AS = await import('/ui/app-state.js');
        await EM.groupByIdentityAndTriangulateAll();
        const session = AS.state.session;
        return {
            f0groups: (session.instanceGroups.get(0) || []).length,
            f1groups: (session.instanceGroups.get(1) || []).length,
        };
    });
    const rowsAfterTriangulate = await storeRows();
    console.log('  gate 6 (after real Triangulate All):', JSON.stringify(gate6), 'rows =', rowsAfterTriangulate);
    check(rowsAfterTriangulate === expectedRows,
        `gate 6: Triangulate All did not resurrect any store row (still ${expectedRows}, got ${rowsAfterTriangulate})`);
    check(gate6.f1groups === 0,
        `gate 6: the emptied frame 1 did NOT get its groups rebuilt from frameIdentityMap (got ${gate6.f1groups})`);

    // ---- gates 3 + 5: save, reopen, and re-measure --------------------------
    const RESAVE = '_custom-delete-roundtrip-2.slp';
    const RESAVE_PATH = path.join(repoRoot, RESAVE);
    try { fs.unlinkSync(RESAVE_PATH); } catch (e) { /* ignore */ }
    let bytes2 = 0;
    const fd2 = fs.openSync(RESAVE_PATH, 'w');
    await page2.exposeFunction('__appendChunk2', (b64) => {
        const buf = Buffer.from(b64, 'base64');
        fs.writeSync(fd2, buf);
        bytes2 += buf.length;
    });
    await page2.evaluate(async () => {
        const saveLoad = await import('/import-export/save-load.js');
        const toBase64 = (bytes) => {
            let binary = '';
            const CHUNK = 0x8000;
            for (let off = 0; off < bytes.length; off += CHUNK) {
                binary += String.fromCharCode.apply(null, bytes.subarray(off, off + CHUNK));
            }
            return btoa(binary);
        };
        window.showSaveFilePicker = async () => ({
            createWritable: async () => ({
                write: async (chunk) => {
                    await window.__appendChunk2(chunk instanceof Uint8Array ? toBase64(chunk) : toBase64(new Uint8Array(chunk)));
                },
                close: async () => {}, abort: async () => {},
            }),
        });
        await saveLoad.saveAs();
    });
    fs.closeSync(fd2);
    console.log('  re-saved after delete:', bytes2, 'bytes');
    check(bytes2 > 1000, `re-save produced a real file (${bytes2} bytes)`);
    await ctx2.close();

    // Fresh page: reopen the re-saved file and confirm the deletions stuck.
    const ctx3 = await browser.newContext();
    const page3 = await ctx3.newPage();
    page3.on('pageerror', e => { console.log('  [p3 pageerror]', String(e).slice(0, 300)); fails++; });
    page3.on('dialog', async d => { await d.accept(''); });
    await page3.goto(`http://localhost:${PORT}/index.html`);
    await page3.waitForFunction(() => window.__lucid && window.__lucid.state, { timeout: 20000 });
    await page3.evaluate(async (fixture) => {
        const sessionLoader = await import('/loading/session-loader.js');
        const resp = await fetch('/' + fixture);
        if (!resp.ok) throw new Error('re-saved fixture fetch failed: ' + resp.status);
        sessionLoader.handleLoadProjectSlpLazy(new File([await resp.blob()], 'rt2.slp'));
    }, RESAVE);
    await page3.waitForFunction(
        () => { const s = window.__lucid && window.__lucid.state; return !!(s && s.session && s.session.lazyLoader); },
        { timeout: 30000 });

    const reopened = await page3.evaluate(async () => {
        const TRI = await import('/pose/triangulation.js');
        const AS = await import('/ui/app-state.js');
        const session = AS.state.session;
        let rows = 0;
        const perFrame = {};
        session.lazyLoader.forEachInstanceRow((cam, frameIdx) => {
            rows++;
            perFrame[frameIdx] = (perFrame[frameIdx] || 0) + 1;
        });
        await TRI.ensureLazyFrameData(0);
        await TRI.ensureLazyFrameData(1);
        const countResident = (f) => {
            const fg = session.getFrameGroup(f);
            let grouped = 0, ungrouped = 0, predicted = 0;
            if (fg) {
                for (const [, arr] of fg.instances) { grouped += arr.length; for (const i of arr) if (i.type === 'predicted') predicted++; }
                for (const [, ul] of fg.unlinkedInstances) ungrouped += ul.length;
            }
            return { grouped, ungrouped, predicted };
        };
        return {
            rows,
            f0rows: perFrame[0] || 0,
            f1rows: perFrame[1] || 0,
            f2rows: perFrame[2] || 0,
            f0: countResident(0),
            f1: countResident(1),
            fimSize: session.frameIdentityMap.size,
        };
    });
    console.log('  reopened after delete:', JSON.stringify(reopened));

    check(reopened.rows === expectedRows,
        `gate 3: reopened store has ${expectedRows} rows — deletions persisted (got ${reopened.rows})`);
    check(reopened.f0rows === (CAMS.length * PER_CAM) - CAMS.length,
        `gate 3: frame 0 kept only its ${(CAMS.length * PER_CAM) - CAMS.length} user rows (got ${reopened.f0rows})`);
    check(reopened.f1rows === 0,
        `gate 3: frame 1 came back EMPTY — the empty-frame case survived the round trip (got ${reopened.f1rows})`);
    check(reopened.f2rows === CAMS.length * PER_CAM,
        `untouched frame 2 is intact (${CAMS.length * PER_CAM} rows, got ${reopened.f2rows})`);
    check(reopened.f0.predicted === 0,
        `gate 3: no predicted instance on frame 0 after reopen (got ${reopened.f0.predicted})`);
    check(reopened.f1.grouped === 0 && reopened.f1.ungrouped === 0,
        `gate 3: frame 1 has no grouped OR ungrouped instances after reopen ` +
        `(got ${reopened.f1.grouped}/${reopened.f1.ungrouped})`);

    // gate 5: the emptied frame must carry no identity residue. Every (cam, track)
    // override for frame 1 was pruned, so 3 cameras x 2 tracks = 6 entries are gone,
    // plus frame 0's 3 predicted-track (t1) overrides.
    const fimExpected = built.fimSize - (CAMS.length * PER_CAM) - CAMS.length;
    check(reopened.fimSize === fimExpected,
        `gate 5: frameIdentityMap has no orphan residue — ${built.fimSize} -> ${fimExpected} ` +
        `(got ${reopened.fimSize})`);

    await ctx3.close();
    try { fs.unlinkSync(RESAVE_PATH); } catch (e) { /* ignore */ }
} finally {
    if (browser) await browser.close().catch(() => {});
    server.kill('SIGTERM');
    try { fs.unlinkSync(FIXTURE_PATH); } catch (e) { /* ignore */ }
}
process.exit(fails ? 1 : 0);
