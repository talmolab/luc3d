/**
 * custom-delete-roundtrip.mjs — end-to-end round-trip test (real browser) for
 * the Custom Instance Delete feature (Edit ▸ Custom Instance Delete…, issue
 * #72).
 *
 * Proves that a custom delete is COMPLETE: the deleted instances leave no
 * residue in any data structure that reaches the exported `.slp`. Each
 * scenario builds a multi-view session in-page, runs the real
 * `collectDeletionTargets` + `executeDeletion` ops, exports through the real
 * save path (`buildSlpLabelsAllViews` + `SleapIO.saveSlpToBytes`), then
 * RE-READS the exported bytes with the real reader (`SleapIO.readSlpStreaming`)
 * and asserts, against the on-disk file:
 *   - the exact surviving 2D instances remain (deleted ones are gone);
 *   - `frame_group_dicts` (grouping) contains only the surviving groups;
 *   - `metadata.lucid.frameIdentityMap` carries NO orphaned per-frame identity
 *     override for a deleted (frame, camera, track) — the subtle "hanging
 *     part" that dead identity metadata would otherwise leave behind;
 *   - identity overrides for SURVIVING members are preserved.
 *
 * No video/calibration fixture is needed: the export bytes are re-read as an
 * in-memory `File`, so the whole build→delete→save→reload loop runs in one
 * page with no filesystem round-trip.
 *
 * How to run (see tests/e2e/README.md), from the repo root:
 *   1. cd tests/e2e && npm install
 *   2. node tests/e2e/custom-delete-roundtrip.mjs   (spawns its own server)
 *
 * Exit code 0 = all assertions pass, 1 = a regression (or driver error).
 */
import { chromium } from 'playwright';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..', '..');
const PORT = Number(process.env.PORT || 8093);

let failures = 0;
function check(cond, msg) {
    if (cond) { console.log('    ✓ ' + msg); }
    else { console.log('    ✗ ' + msg); failures++; }
}

// Runs one delete scenario end-to-end in the page and returns a plain summary
// of the RE-READ exported file. `filters` is a DeleteFilters object;
// `currentFrame` seeds the DeleteContext.
async function runScenario(page, filters, currentFrame, clip) {
    return await page.evaluate(async ({ filters, currentFrame, clip }) => {
        const pd = await import('/pose/pose-data.js');
        const fileio = await import('/import-export/file-io.js');
        const ops = await import('/ui/custom-delete-ops.js');
        const { Skeleton, Camera, Instance, UnlinkedInstance, FrameGroup, InstanceGroup, Session } = pd;

        const mtx = [[1000, 0, 255.5], [0, 1000, 255.5], [0, 0, 1]];
        const camNames = ['cam1', 'cam2', 'cam3'];
        const cams = camNames.map((n, i) => new Camera(n, mtx, [0, 0, 0, 0, 0], [0, 0.1 * i, 0], [10 * i, 0, 0], [512, 512]));
        const skel = new Skeleton('skeleton', ['a', 'b'], [[0, 1]]);
        const s = new Session(cams, skel, ['t0', 't1'], 'RT');
        const idA = s.addIdentity('A');
        const idB = s.addIdentity('B');
        const mk = (type, tr) => new Instance([[1, 2], [3, 4]], tr, type, type === 'user' ? undefined : 0.9);

        // --- Frame 0 ---
        const fg0 = new FrameGroup(0); s.addFrameGroup(fg0);
        // Group A: identity A, track 0, cam1+cam2 user.
        const a1 = mk('user', 0), a2 = mk('user', 0);
        const gA = new InstanceGroup(1, idA.id); gA.addInstance('cam1', a1); gA.addInstance('cam2', a2);
        gA.points3d = [[1, 2, 3], [4, 5, 6]];
        gA.addReprojectedInstance('cam1', mk('predicted', 0));
        gA.addReprojectedInstance('cam2', mk('predicted', 0));
        fg0.addInstance('cam1', a1); fg0.addInstance('cam2', a2);
        // Group B: identity B, track 1, cam1+cam2 predicted (fully predicted).
        const b1 = mk('predicted', 1), b2 = mk('predicted', 1);
        const gB = new InstanceGroup(2, idB.id); gB.addInstance('cam1', b1); gB.addInstance('cam2', b2);
        fg0.addInstance('cam1', b1); fg0.addInstance('cam2', b2);
        s.instanceGroups.set(0, [gA, gB]);
        // Unlinked user instance on cam3, track 0.
        fg0.addUnlinkedInstance('cam3', new UnlinkedInstance(mk('user', 0), 'cam3'));
        s.setFrameIdentity(0, 'cam1', 0, idA.id);
        s.setFrameIdentity(0, 'cam2', 0, idA.id);
        s.setFrameIdentity(0, 'cam1', 1, idB.id);
        s.setFrameIdentity(0, 'cam2', 1, idB.id);

        // --- Frame 1 ---
        const fg1 = new FrameGroup(1); s.addFrameGroup(fg1);
        const c1 = mk('user', 0), c2 = mk('user', 0), c3 = mk('user', 0);
        const gC = new InstanceGroup(3, idA.id);
        gC.addInstance('cam1', c1); gC.addInstance('cam2', c2); gC.addInstance('cam3', c3);
        fg1.addInstance('cam1', c1); fg1.addInstance('cam2', c2); fg1.addInstance('cam3', c3);
        s.instanceGroups.set(1, [gC]);
        s.setFrameIdentity(1, 'cam1', 0, idA.id);
        s.setFrameIdentity(1, 'cam2', 0, idA.id);
        s.setFrameIdentity(1, 'cam3', 0, idA.id);

        // --- Delete ---
        const ctx = { currentSession: s, currentFrame, clipRange: clip || [0, 0] };
        const res = ops.collectDeletionTargets([s], filters, ctx);
        ops.executeDeletion(res.targets);

        // --- Export + re-read the actual bytes ---
        const views = camNames.map((n) => ({ name: n, videoWidth: 512, videoHeight: 512, frameCount: 10 }));
        const vf = camNames.map((n) => ({ name: n, assignedCamera: n, videoPath: n + '.mp4' }));
        const labels = fileio.buildSlpLabelsAllViews(s, views, vf);
        const bytes = await window.SleapIO.saveSlpToBytes(labels);
        const file = new File([bytes], 'rt.slp');
        const re = await window.SleapIO.readSlpStreaming(file, {
            openVideos: false, rawSessions: true,
            h5wasmUrl: new URL('lib/h5wasm/h5wasm.iife.js', document.baseURI).href,
        });

        // Total surviving 2D instances across all labeled frames in the file.
        // LabeledFrames are PER-CAMERA, so a single multi-view frame produces
        // one LabeledFrame per camera at the same frameIdx. Count distinct
        // frame indices that still carry any instance.
        const lfs = re.labeledFrames || [];
        const totalInst = lfs.reduce((a, f) => a + (f.instances || []).length, 0);
        const frameIdxWithInst = new Set();
        for (const f of lfs) { if ((f.instances || []).length > 0) frameIdxWithInst.add(f.frameIdx); }
        const framesWithInst = frameIdxWithInst.size;

        // Raw sessions_json → grouping + identity map on disk.
        const rs = re.rawSessionsJson || [];
        const raw = rs[0] || {};
        const lucid = (raw.metadata && raw.metadata.lucid) || {};
        const fim = lucid.frameIdentityMap || [];
        const fgDicts = raw.frame_group_dicts || [];
        // Count groups on disk (each frame_group_dict lists its instance groups).
        let groupCount = 0;
        for (const fgd of fgDicts) {
            const igs = (fgd && (fgd.instance_groups || fgd.instance_group_dicts)) || [];
            groupCount += igs.length;
        }

        return {
            deleted: res.count,
            totalInst,
            framesWithInst,
            fimKeys: fim.map((e) => e[0]).sort(),
            fgDicts,
            groupCount,
        };
    }, { filters, currentFrame, clip });
}

function F(extra) {
    return Object.assign({
        type: 'all', grouping: 'any', view: null,
        trackMode: 'any', trackIdx: null, identityMode: 'any', identityId: null,
        frameScope: 'currentFrame',
    }, extra || {});
}

async function main() {
    const server = spawn('python3', ['-m', 'http.server', String(PORT)], { cwd: repoRoot, stdio: 'ignore' });
    await new Promise((r) => setTimeout(r, 1200));
    try {
        const browser = await chromium.launch({ headless: true });
        const page = await browser.newPage();
        page.on('pageerror', (e) => { console.log('    [pageerror] ' + e.message); failures++; });
        await page.goto(`http://localhost:${PORT}/index.html`, { waitUntil: 'load' });
        await page.waitForFunction(() => window.__lucid && window.__lucid.state && window.SleapIO, null, { timeout: 20000 });

        // Baseline (no matching filter): the whole session round-trips intact.
        console.log('  Scenario baseline: delete nothing (view=cam1 + track none has no match on frame 0 grouped)');
        // Reprojections only, no view → clears reprojections but keeps all observed.
        const base = await runScenario(page, F({ type: 'user', grouping: 'grouped', view: 'cam3' }), 0);
        check(base.deleted === 0, `nothing matched (deleted=${base.deleted})`);
        check(base.totalInst === 8, `all 8 observed instances survive (got ${base.totalInst})`);
        check(base.fimKeys.length === 7, `all 7 identity overrides preserved (got ${base.fimKeys.length})`);

        console.log('\n  Scenario A: delete PREDICTED across the session (removes fully-predicted group B)');
        const a = await runScenario(page, F({ type: 'predicted', frameScope: 'currentSession' }), 0);
        check(a.deleted === 2, `2 predicted instances targeted (got ${a.deleted})`);
        // Survivors: gA(2) + unlinked(1) on f0 + gC(3) on f1 = 6.
        check(a.totalInst === 6, `6 observed instances survive in file (got ${a.totalInst})`);
        check(a.groupCount === 2, `only groups A and C remain on disk (got ${a.groupCount})`);
        check(!a.fimKeys.includes('0:cam1:1') && !a.fimKeys.includes('0:cam2:1'),
            `group B's identity overrides pruned (fim=${JSON.stringify(a.fimKeys)})`);
        check(a.fimKeys.includes('0:cam1:0') && a.fimKeys.includes('1:cam3:0'),
            'surviving members keep their identity overrides');

        console.log('\n  Scenario B: delete ALL on the current frame only (frame 0)');
        const b = await runScenario(page, F({ type: 'all', frameScope: 'currentFrame' }), 0);
        check(b.deleted === 5, `5 instances on frame 0 targeted (2 gA + 2 gB + 1 unlinked, got ${b.deleted})`);
        // Only frame 1's group C (3) survives.
        check(b.totalInst === 3, `only frame 1's 3 instances survive (got ${b.totalInst})`);
        check(b.framesWithInst === 1, `only one frame retains instances (got ${b.framesWithInst})`);
        check(b.groupCount === 1, `only group C remains on disk (got ${b.groupCount})`);
        check(b.fimKeys.every((k) => k.indexOf('0:') !== 0), `NO frame-0 identity overrides leftover (fim=${JSON.stringify(b.fimKeys)})`);
        check(b.fimKeys.length === 3, `all 3 frame-1 overrides preserved (got ${b.fimKeys.length})`);

        console.log('\n  Scenario C: delete UNGROUPED only (frame 0 unlinked cam3)');
        const c = await runScenario(page, F({ grouping: 'ungrouped', frameScope: 'currentFrame' }), 0);
        check(c.deleted === 1, `1 unlinked instance targeted (got ${c.deleted})`);
        check(c.totalInst === 7, `7 observed instances survive: groups intact (got ${c.totalInst})`);
        check(c.groupCount === 3, `all three groups remain on disk (got ${c.groupCount})`);
        // The unlinked cam3 instance had track 0 → its frame-0 override (if any)
        // must not survive as a ghost, but grouped cam3 has none on frame 0 so
        // the 7 grouped overrides are unchanged.
        check(c.fimKeys.length === 7, `grouped identity overrides untouched (got ${c.fimKeys.length})`);

        console.log('\n  Scenario D: delete a SINGLE VIEW of a 3-member group (frame 1, cam1)');
        const d = await runScenario(page, F({ type: 'user', grouping: 'grouped', view: 'cam1', frameScope: 'currentSession' }), 0);
        // cam1 members of gA (f0) and gC (f1) are user → both removed; gA drops
        // to 1 (unlinked to survivor), gC drops to 2.
        check(d.deleted === 2, `2 cam1 user members targeted (gA, gC) (got ${d.deleted})`);
        check(!d.fimKeys.includes('0:cam1:0') && !d.fimKeys.includes('1:cam1:0'),
            `pruned the deleted cam1 identity overrides (fim=${JSON.stringify(d.fimKeys)})`);
        check(d.fimKeys.includes('1:cam2:0') && d.fimKeys.includes('1:cam3:0'),
            'surviving cam2/cam3 members of group C keep their overrides');

        await browser.close();
    } finally {
        server.kill('SIGTERM');
    }
}

await main();
console.log(failures === 0
    ? '\nPASS: custom delete leaves no residue in the exported .slp (instances, grouping, identity map).'
    : `\nFAIL: ${failures} assertion(s) failed.`);
process.exit(failures === 0 ? 0 : 1);
