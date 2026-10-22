/**
 * test-browser-lock.mjs — scripts/browser-lock.mjs, the machine-wide lock that
 * keeps headed / real-browser test runs from overlapping across Claude
 * sessions (overlapping runs hid each other's tabs and stole each other's
 * window focus, so their playback measurements were invalid).
 *
 * Everything here runs against a private lock path (LUCID_BROWSER_LOCK) with
 * the Claude-refocus off, so it never touches the real lock or the screen.
 * ESM, so `tests/run-mjs-tests.mjs` picks it up.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const LOCK_JS = path.resolve(__dirname, '..', 'scripts', 'browser-lock.mjs');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'lucid-browser-lock-test-'));
const LOCK = path.join(tmp, 'browser.lock');
process.env.LUCID_BROWSER_LOCK = LOCK;
process.env.LUCID_BROWSER_LOCK_REFOCUS = '0';
const env = { ...process.env };
const { acquireBrowserLock } = await import(LOCK_JS);

let passed = 0, failed = 0;
const check = (cond, msg) => {
    if (cond) { passed++; console.log('  ok   ' + msg); }
    else { failed++; console.log('  FAIL ' + msg); }
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Run the CLI; resolves { code, stderr, stdout }. */
function cli(args, extraEnv = {}) {
    return new Promise((resolve) => {
        const p = spawn(process.execPath, [LOCK_JS, ...args], { env: { ...env, ...extraEnv } });
        let out = '', err = '';
        p.stdout.on('data', (d) => { out += d; });
        p.stderr.on('data', (d) => { err += d; });
        p.on('exit', (code) => resolve({ code, stdout: out, stderr: err, pid: p.pid }));
        resolve.proc = p;
    });
}
/** A node one-liner as a child command. */
const nodeCmd = (code) => [process.execPath, '-e', code];
const deadPid = () => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' }); return Number(r.stdout); };

// 1. status on a free lock
{
    const r = await cli(['status']);
    check(r.code === 0 && /: free$/m.test(r.stdout), `status reports free (${r.stdout.trim()})`);
}

// 2. two wrapped runs never overlap, and the second says whom it waits for
{
    const log = path.join(tmp, 'order.log');
    const job = (name) => nodeCmd(`const fs=require('fs');fs.appendFileSync(${JSON.stringify(log)},'${name}+'+Date.now()+'\\n');setTimeout(()=>fs.appendFileSync(${JSON.stringify(log)},'${name}-'+Date.now()+'\\n'),1500)`);
    const a = cli(['--label=run A', '--', ...job('A')]);
    await sleep(400);
    const b = cli(['--label=run B', '--', ...job('B')]);
    const [ra, rb] = await Promise.all([a, b]);
    const ev = Object.fromEntries(fs.readFileSync(log, 'utf8').trim().split('\n').map((l) => [l.slice(0, 2), Number(l.slice(2))]));
    check(ra.code === 0 && rb.code === 0, 'both wrapped runs exit 0');
    check(ev['B+'] >= ev['A-'], `B started only after A finished (A ended ${ev['A-']}, B started ${ev['B+']})`);
    check(/waiting for "run A"/.test(rb.stderr), `the waiter names the holder (${rb.stderr.split('\n')[0]})`);
    check(!fs.existsSync(LOCK), 'lock freed after both runs');
}

// 3. the child's exit code passes through
{
    const r = await cli(['--', ...nodeCmd('process.exit(7)')]);
    check(r.code === 7, `child exit code 7 passes through (got ${r.code})`);
    check(!fs.existsSync(LOCK), 'lock freed after a failing run');
}

// 4. a lock whose owner is dead is broken
{
    fs.mkdirSync(LOCK);
    fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: deadPid(), label: 'crashed run', cwd: '/x', started: new Date().toISOString(), processStartMs: Date.now() }));
    const logs = [];
    const release = await acquireBrowserLock({ label: 'after crash', log: (m) => logs.push(m) });
    check(logs.some((m) => /breaking a stale lock: "crashed run"/.test(m)), 'a dead owner\'s lock is broken, and said so');
    check(JSON.parse(fs.readFileSync(path.join(LOCK, 'owner.json'), 'utf8')).label === 'after crash', 'and taken');
    await release();
}

// 5. a reused pid (a live process that started after the lock was taken) is stale too
{
    fs.mkdirSync(LOCK);
    fs.writeFileSync(path.join(LOCK, 'owner.json'), JSON.stringify({ pid: process.pid, label: 'old run', cwd: '/x', started: '2000-01-01T00:00:00Z', processStartMs: Date.parse('2000-01-01T00:00:00Z') }));
    const logs = [];
    const release = await acquireBrowserLock({ label: 'pid reuse', log: (m) => logs.push(m) });
    check(logs.some((m) => /breaking a stale lock: "old run"/.test(m)), 'a pid now belonging to a younger process does not hold the lock');
    await release();
}

// 6. a lock dir with no owner record is broken once it is old, not while it is fresh
{
    fs.mkdirSync(LOCK);
    const p = acquireBrowserLock({ label: 'no owner', log: () => {}, waitMin: 0.05 });
    await sleep(500);
    check(fs.existsSync(LOCK) && !fs.existsSync(path.join(LOCK, 'owner.json')), 'a FRESH ownerless lock is waited on (its creator may be writing owner.json)');
    const old = (Date.now() - 60000) / 1000;
    fs.utimesSync(LOCK, old, old);
    const release = await p;
    check(JSON.parse(fs.readFileSync(path.join(LOCK, 'owner.json'), 'utf8')).label === 'no owner', 'an OLD ownerless lock is broken and taken');
    await release();
}

// 7. a runner inside the wrapper does not wait on its own parent
{
    const inner = `import(${JSON.stringify(LOCK_JS)}).then(async m => { const t = Date.now(); const rel = await m.acquireBrowserLock({ label: 'inner', waitMin: 0.05 }); await rel(); console.log('inner-ok ' + (Date.now() - t)); })`;
    const r = await cli(['--label=outer', '--', process.execPath, '--input-type=module', '-e', inner]);
    check(r.code === 0 && /inner-ok \d+/.test(r.stdout), `nested acquire inside the wrapper returns at once (${(r.stdout.match(/inner-ok \d+/) || ['none'])[0]} ms)`);
}

// 8. a live holder makes a bounded waiter give up with exit 75
{
    const holder = cli(['--label=long run', '--', ...nodeCmd('setTimeout(()=>{},2500)')]);
    await sleep(400);
    const r = await cli(['--', ...nodeCmd('0')], { LUCID_BROWSER_LOCK_WAIT_MIN: '0.02' });
    check(r.code === 75 && /gave up .* "long run"/.test(r.stderr), `bounded wait fails with 75, naming the holder (code ${r.code})`);
    await holder;
}

// 9. SIGTERM to the wrapper stops the child and frees the lock
{
    const p = spawn(process.execPath, [LOCK_JS, '--label=killed', '--', ...nodeCmd('setTimeout(()=>{},30000)')], { env });
    for (let i = 0; i < 50 && !fs.existsSync(path.join(LOCK, 'owner.json')); i++) await sleep(100);
    const held = fs.existsSync(LOCK);
    p.kill('SIGTERM');
    const code = await new Promise((r) => p.on('exit', (c, s) => r(c != null ? c : s)));
    check(held && !fs.existsSync(LOCK), `SIGTERM frees the lock (exit ${code})`);
}

fs.rmSync(tmp, { recursive: true, force: true });
console.log(`\n${passed} passed, ${failed} failed`);
console.log(failed === 0 ? 'PASS' : 'FAIL');
process.exit(failed === 0 ? 0 : 1);
