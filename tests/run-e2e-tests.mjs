/**
 * run-e2e-tests.mjs — run the Playwright files in `tests/e2e/` in parallel.
 *
 * Each file is still a standalone script (`node tests/e2e/<name>.mjs` works as
 * before); this runs many of them at once and reports them together:
 *
 *   - several at a time, slowest first (from the last runs' times), so one long
 *     file does not start last and hold up the end of the run;
 *   - a time limit per file, after which its whole process group is killed;
 *   - every failure run again ALONE, so a file that only fails under load is
 *     told apart from one that fails every time ("passed alone");
 *   - a file that prints a line starting with `SKIP` is reported as skipped,
 *     not passed;
 *   - `tests/e2e/known-failures.json` names files that fail on main for a known
 *     reason: they are run and reported but do not fail the run, and the
 *     summary says when one starts passing so it can come off the list;
 *   - one summary at the end, each file's output in a log file.
 *
 * Usage (from anywhere):
 *   node tests/run-e2e-tests.mjs                 # all
 *   node tests/run-e2e-tests.mjs plane save-     # files whose name contains a filter
 *   node tests/run-e2e-tests.mjs --failed        # only what failed last time here
 * Options:
 *   -j, --jobs N     files at a time (default: half the cores left idle by the
 *                    current load, 1 to 8; HEADED=1 forces 1)
 *   --timeout S      per-file limit in seconds (default 600)
 *   --no-rerun       do not rerun failures alone
 *   --logs DIR       where to keep each file's output (default: a new folder
 *                    under the system temp folder; printed at the end)
 *   --list           print the files in run order and stop
 *   --shard I/N      run only part I of N (CI runs N machines). Every machine
 *                    computes the same split, from `tests/e2e/timings.json`
 *                    only (committed), never from this machine's own times
 *   --write-timings  after the run, record its times in `tests/e2e/timings.json`
 *                    (commit it when the slow files change, so shards stay even)
 *
 * Files that use `tests/e2e/lib/harness.mjs` get a free port of their own; any
 * other file is handed a free `PORT=`. Times and last results are kept in the
 * harness's cache folder (`LUC3D_E2E_CACHE`). Under GitHub Actions each
 * failure is also an error annotation, and the summary goes to the job's page.
 */
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { cacheDir } from './e2e/lib/harness.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const e2eDir = path.join(repoRoot, 'tests', 'e2e');
// Not test files: the classic-suite launcher (run on its own) and helpers.
const NOT_TESTS = new Set(['run-unit-tests.mjs']);

// ---- arguments ----------------------------------------------------------------
const argv = process.argv.slice(2);
const opts = { jobs: null, timeout: 600, rerun: true, logs: null, list: false, failed: false, shard: null, writeTimings: false, filters: [] };
for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (a === '-j' || a === '--jobs') opts.jobs = Number(argv[++i]);
    else if (a.startsWith('--jobs=')) opts.jobs = Number(a.slice(7));
    else if (a === '--timeout') opts.timeout = Number(argv[++i]);
    else if (a === '--no-rerun') opts.rerun = false;
    else if (a === '--logs') opts.logs = argv[++i];
    else if (a === '--list') opts.list = true;
    else if (a === '--failed') opts.failed = true;
    else if (a === '--write-timings') opts.writeTimings = true;
    else if (a === '--shard' || a.startsWith('--shard=')) {
        const v = a === '--shard' ? argv[++i] : a.slice(8);
        const m = /^(\d+)\/(\d+)$/.exec(v || '');
        if (!m || !(Number(m[1]) >= 1 && Number(m[1]) <= Number(m[2]))) { console.error('--shard needs I/N with 1 <= I <= N, e.g. 2/4'); process.exit(2); }
        opts.shard = { index: Number(m[1]), count: Number(m[2]) };
    }
    else if (a === '-h' || a === '--help') {
        console.log(fs.readFileSync(fileURLToPath(import.meta.url), 'utf8').split('*/')[0].replace(/^\/\*\*\n/, '').replace(/^ \* ?/gm, ''));
        process.exit(0);
    }
    else if (a.startsWith('-')) { console.error('unknown option ' + a); process.exit(2); }
    else opts.filters.push(a);
}
if (opts.jobs !== null && !(opts.jobs >= 1)) { console.error('--jobs needs a number of at least 1'); process.exit(2); }
if (!(opts.timeout > 0)) { console.error('--timeout needs a number of seconds'); process.exit(2); }

// ---- state kept between runs ----------------------------------------------------
const store = cacheDir();
const timingsFile = path.join(store, 'e2e-timings.json');             // shared by every worktree
const lastRunFile = path.join(store, 'e2e-last-run-' +
    crypto.createHash('sha256').update(repoRoot).digest('hex').slice(0, 12) + '.json'); // this checkout's
const readJson = (f, fallback) => { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return fallback; } };
const timings = readJson(timingsFile, {});
const lastRun = readJson(lastRunFile, {});
const known = readJson(path.join(e2eDir, 'known-failures.json'), { files: {} }).files || {};
const committedTimingsFile = path.join(e2eDir, 'timings.json');
const committed = readJson(committedTimingsFile, { seconds: {} }).seconds || {};

// ---- which files, in what order ---------------------------------------------------
let files = fs.readdirSync(e2eDir)
    .filter(f => f.endsWith('.mjs') && !f.startsWith('_') && !NOT_TESTS.has(f))
    .filter(f => opts.filters.length === 0 || opts.filters.some(s => f.includes(s)));
if (opts.failed) files = files.filter(f => lastRun[f] && lastRun[f] !== 'ok' && lastRun[f] !== 'skip');
if (files.length === 0) { console.error(opts.failed ? 'nothing failed last time' : 'no matching tests/e2e/*.mjs'); process.exit(opts.failed ? 0 : 1); }
// A file never timed counts as 1 s per 10 kB of source.
const bySize = f => fs.statSync(path.join(e2eDir, f)).size / 10000;
if (opts.shard) {
    // Longest first, each to the emptiest shard: the same on every machine,
    // because it reads only committed times and file sizes.
    const weight = f => committed[f] ?? bySize(f);
    const loads = Array(opts.shard.count).fill(0), mine = new Set();
    for (const f of [...files].sort((a, b) => weight(b) - weight(a) || a.localeCompare(b))) {
        const s = loads.indexOf(Math.min(...loads));
        loads[s] += weight(f);
        if (s === opts.shard.index - 1) mine.add(f);
    }
    files = files.filter(f => mine.has(f));
    if (files.length === 0) { console.log(`shard ${opts.shard.index}/${opts.shard.count} has no files`); process.exit(0); }
}
// Slowest first, from this machine's last times when it has them.
const expected = f => timings[f] ?? committed[f] ?? bySize(f);
files.sort((a, b) => expected(b) - expected(a) || a.localeCompare(b));

const cpus = os.cpus().length;
const load = os.loadavg()[0];
let jobs = opts.jobs ?? Math.max(1, Math.min(8, Math.floor((cpus - load) / 2)));
if (process.env.HEADED === '1') jobs = 1;
jobs = Math.min(jobs, files.length);

if (opts.list) { files.forEach(f => console.log(`${expected(f).toFixed(1).padStart(7)} s  ${f}`)); process.exit(0); }

const logDir = opts.logs || fs.mkdtempSync(path.join(os.tmpdir(), 'luc3d-e2e-logs-'));
fs.mkdirSync(logDir, { recursive: true });

// ---- running one file ----------------------------------------------------------------
const freePort = () => new Promise((resolve, reject) => {
    const s = net.createServer();
    s.once('error', reject);
    s.listen(0, () => { const { port } = s.address(); s.close(() => resolve(port)); });
});

const usesHarness = f => fs.readFileSync(path.join(e2eDir, f), 'utf8').includes('lib/harness.mjs');

function killGroup(child, signal) {
    try { process.kill(-child.pid, signal); } catch { try { child.kill(signal); } catch { /* gone */ } }
}

// Ctrl-C stops the files that are running, browsers and servers included.
const running = new Set();
for (const sig of ['SIGINT', 'SIGTERM']) {
    process.on(sig, () => {
        for (const c of running) killGroup(c, 'SIGKILL');
        process.exit(130);
    });
}

async function runFile(f, logName) {
    const env = { ...process.env };
    delete env.BASE;
    if (usesHarness(f)) delete env.PORT; else env.PORT = String(await freePort());
    const logPath = path.join(logDir, logName);
    const out = fs.openSync(logPath, 'w');
    const t0 = performance.now();
    const { code, timedOut } = await new Promise((resolve) => {
        // Its own process group, so a time-out also takes the browser and any server it started.
        const child = spawn(process.execPath, [path.join('tests', 'e2e', f)], {
            cwd: repoRoot, env, stdio: ['ignore', out, out], detached: true,
        });
        running.add(child);
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            killGroup(child, 'SIGTERM');
            setTimeout(() => killGroup(child, 'SIGKILL'), 5000).unref();
        }, opts.timeout * 1000);
        const finish = (result) => {
            clearTimeout(timer);
            running.delete(child);
            // Whatever the file left behind in its group (a Python server, a browser).
            try { process.kill(-child.pid, 'SIGKILL'); } catch { /* nothing left */ }
            resolve(result);
        };
        child.on('close', (code, signal) => finish({ code: signal ? 128 : code, timedOut }));
        child.on('error', () => finish({ code: 127, timedOut }));
    });
    fs.closeSync(out);
    const secs = (performance.now() - t0) / 1000;
    const text = fs.readFileSync(logPath, 'utf8');
    const status = timedOut ? 'timeout' : code !== 0 ? 'fail' : /^SKIP\b/m.test(text) ? 'skip' : 'ok';
    return { file: f, status, secs, code, logPath, text };
}

// Lines worth showing for a failure.
function failureLines(text) {
    const lines = text.split('\n');
    const picked = lines.filter(l => /✗|Error|error:|FAIL|Timeout|timed out|expected/.test(l));
    return (picked.length ? picked : lines.filter(Boolean).slice(-8)).slice(0, 12).map(l => l.trim().slice(0, 200));
}

// ---- the run ----------------------------------------------------------------------------
const label = s => ({ ok: 'ok   ', fail: 'FAIL ', timeout: 'TIME ', skip: 'skip ' }[s]);
console.log(`running ${files.length} e2e file(s)${opts.shard ? ` (shard ${opts.shard.index}/${opts.shard.count})` : ''}, ${jobs} at a time (${cpus} cores, load ${load.toFixed(1)}), ` +
    `limit ${opts.timeout} s each; logs in ${logDir}\n`);
const t0 = Date.now();
const results = new Map();
const queue = [...files];
let done = 0;
await Promise.all(Array.from({ length: jobs }, async () => {
    while (queue.length) {
        const f = queue.shift();
        const r = await runFile(f, f.replace(/\.mjs$/, '.log'));
        results.set(f, r);
        done++;
        const note = known[f] && r.status !== 'ok' && r.status !== 'skip' ? '  (known failure)' : '';
        console.log(`  ${label(r.status)} ${r.secs.toFixed(1).padStart(6)} s  [${String(done).padStart(String(files.length).length)}/${files.length}]  ${f}${note}`);
    }
}));

// Failures again, one at a time, to tell load from a real failure.
const failedFirst = files.filter(f => ['fail', 'timeout'].includes(results.get(f).status));
const reruns = new Map();
if (opts.rerun && failedFirst.length && jobs > 1) {
    console.log(`\nrunning ${failedFirst.length} failure(s) again, alone`);
    for (const f of failedFirst) {
        const r = await runFile(f, f.replace(/\.mjs$/, '.rerun.log'));
        reruns.set(f, r);
        console.log(`  ${label(r.status)} ${r.secs.toFixed(1).padStart(6)} s  ${f}`);
    }
}
const wall = (Date.now() - t0) / 1000;

// ---- remember times and results ------------------------------------------------------------
const finalStatus = new Map();
for (const f of files) {
    const r = results.get(f), rr = reruns.get(f);
    finalStatus.set(f, rr ? (rr.status === 'ok' ? 'flaky' : rr.status) : r.status);
    if (r.status === 'ok' || r.status === 'fail') timings[f] = Math.round(r.secs * 10) / 10;
    lastRun[f] = finalStatus.get(f);
}
try {
    fs.mkdirSync(store, { recursive: true });
    fs.writeFileSync(timingsFile, JSON.stringify(timings, null, 1));
    fs.writeFileSync(lastRunFile, JSON.stringify(lastRun, null, 1));
} catch { /* a cache, nothing more */ }
if (opts.writeTimings) {
    const out = { ...committed };
    for (const f of files) if (['ok', 'fail'].includes(results.get(f).status)) out[f] = Math.round(results.get(f).secs * 10) / 10;
    for (const f of Object.keys(out)) if (!fs.existsSync(path.join(e2eDir, f))) delete out[f];
    const sorted = Object.fromEntries(Object.keys(out).sort().map(f => [f, out[f]]));
    fs.writeFileSync(committedTimingsFile, JSON.stringify({
        about: 'Seconds per tests/e2e file, from `node tests/run-e2e-tests.mjs --write-timings`. Used only to split the files evenly across CI machines (--shard) and to start slow files first; a wrong or missing entry costs balance, never coverage.',
        seconds: sorted,
    }, null, 1) + '\n');
    console.log(`\nwrote ${Object.keys(sorted).length} times to tests/e2e/timings.json`);
}

// ---- summary ------------------------------------------------------------------------------------
const by = s => files.filter(f => finalStatus.get(f) === s);
const failing = [...by('fail'), ...by('timeout')];
const realFailures = failing.filter(f => !known[f]);
const knownFailing = failing.filter(f => known[f]);
const knownPassing = Object.keys(known).filter(f => files.includes(f) && ['ok', 'flaky'].includes(finalStatus.get(f)));

console.log('\n' + '-'.repeat(72));
for (const f of realFailures) {
    const r = reruns.get(f) || results.get(f);
    console.log(`\n${finalStatus.get(f) === 'timeout' ? 'TIMED OUT' : 'FAILED'}: ${f}${reruns.has(f) ? ' (again when run alone)' : ''}  — log: ${r.logPath}`);
    for (const l of failureLines(r.text)) console.log('    ' + l);
}
if (by('flaky').length) {
    console.log('\nFailed in parallel but passed alone (load or timing, not counted as a failure):');
    for (const f of by('flaky')) console.log(`    ${f}  — first log: ${results.get(f).logPath}`);
}
if (knownFailing.length) {
    console.log('\nKnown failures (tests/e2e/known-failures.json), not counted:');
    for (const f of knownFailing) console.log(`    ${f}: ${known[f]}`);
}
if (knownPassing.length) {
    console.log('\nListed as known failures but PASSED — take them off tests/e2e/known-failures.json:');
    for (const f of knownPassing) console.log(`    ${f}`);
}
if (by('skip').length) console.log('\nSkipped (printed SKIP): ' + by('skip').join(', '));
const slow = files.map(f => results.get(f)).sort((a, b) => b.secs - a.secs).slice(0, 5);
console.log('\nSlowest: ' + slow.map(r => `${r.file.replace(/\.mjs$/, '')} ${r.secs.toFixed(0)} s`).join(', '));
const sum = files.reduce((s, f) => s + results.get(f).secs, 0);
console.log(`\n${realFailures.length === 0 ? 'PASS' : 'FAIL'} — ${by('ok').length} passed, ${by('flaky').length} passed alone, ` +
    `${realFailures.length} failed, ${knownFailing.length} known failure(s), ${by('skip').length} skipped, of ${files.length}; ` +
    `${(wall / 60).toFixed(1)} min (${(sum / 60).toFixed(1)} min of test time, ${jobs} at a time); logs in ${logDir}`);

// ---- GitHub Actions: annotations and the job summary ------------------------------------------------
if (process.env.GITHUB_ACTIONS === 'true') {
    const esc = s => String(s).replace(/%/g, '%25').replace(/\r/g, '%0D').replace(/\n/g, '%0A');
    for (const f of realFailures) {
        const r = reruns.get(f) || results.get(f);
        console.log(`::error file=tests/e2e/${f},title=${finalStatus.get(f) === 'timeout' ? 'timed out' : 'failed'}${reruns.has(f) ? ' (also alone)' : ''}::${esc(failureLines(r.text).slice(0, 6).join('\n'))}`);
    }
    for (const f of by('flaky')) console.log(`::warning file=tests/e2e/${f},title=passed only when run alone::failed while running in parallel; see the log artifact`);
    if (process.env.GITHUB_STEP_SUMMARY) {
        const lines = [`### e2e${opts.shard ? ` shard ${opts.shard.index}/${opts.shard.count}` : ''}: ${realFailures.length === 0 ? 'passed' : `${realFailures.length} failed`}`, '',
            `${by('ok').length} passed, ${by('flaky').length} passed alone, ${realFailures.length} failed, ${knownFailing.length} known failure(s), ${by('skip').length} skipped, of ${files.length}; ${(wall / 60).toFixed(1)} min, ${jobs} at a time.`, ''];
        for (const f of realFailures) lines.push(`- ❌ \`${f}\`: ${failureLines((reruns.get(f) || results.get(f)).text).slice(0, 3).map(l => l.replace(/\|/g, '\\|')).join(' / ')}`);
        for (const f of by('flaky')) lines.push(`- ⚠️ \`${f}\` failed in parallel, passed alone`);
        for (const f of knownFailing) lines.push(`- known failure \`${f}\`: ${known[f]}`);
        for (const f of knownPassing) lines.push(`- ✅ \`${f}\` is listed as a known failure but passed: take it off \`tests/e2e/known-failures.json\``);
        if (by('skip').length) lines.push(`- skipped: ${by('skip').map(f => '`' + f + '`').join(', ')}`);
        lines.push('', 'Slowest: ' + slow.map(r => `${r.file.replace(/\.mjs$/, '')} ${r.secs.toFixed(0)} s`).join(', '), '');
        try { fs.appendFileSync(process.env.GITHUB_STEP_SUMMARY, lines.join('\n') + '\n'); } catch { /* not fatal */ }
    }
}
process.exit(realFailures.length === 0 ? 0 : 1);
