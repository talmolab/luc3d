/**
 * browser-lock.mjs — one headed / real-browser test run at a time, across every
 * Claude session and worktree on this machine.
 *
 * Why: several sessions measuring playback at once invalidate each other. A run
 * that opens a tab in the user's real browser (`open -a`) pushes another
 * session's tab to the background, and a hidden tab's requestAnimationFrame is
 * throttled; bringing an app to the front covers another run's window; and
 * timings share one CPU/GPU. Seen on 2026-10-05: two sessions' runs logged
 * "TAB HIDDEN" on the other's activity, and a third run never reached its server.
 *
 * The lock is a DIRECTORY (mkdir is atomic) at a fixed path, default
 * /tmp/luc3d-browser.lock (env LUCID_BROWSER_LOCK), holding owner.json — pid,
 * label, cwd, start time — so a waiter can say who it is waiting for. A lock
 * whose pid is dead (or reused by a younger process) is stale and broken.
 *
 * CLI — wrap any command (the runner, or a whole sequence of runs):
 *   node scripts/browser-lock.mjs [--label=TEXT] -- node verify/pause-xb.mjs
 *   node scripts/browser-lock.mjs status
 * The child gets LUCID_BROWSER_LOCK_HELD, so a runner inside it that takes the
 * lock itself does not wait on its own parent.
 *
 * In a runner:
 *   import { acquireBrowserLock } from '../../scripts/browser-lock.mjs';
 *   const release = await acquireBrowserLock({ label: 'pause harness' });
 *   try { ...open browsers, measure... } finally { await release(); }
 *
 * On release (macOS) the Claude app is brought to the front BEFORE the lock is
 * freed, so the next holder's browser window opens on top of it rather than
 * being covered by it. LUCID_BROWSER_LOCK_REFOCUS=0 turns that off.
 *
 * Waits up to LUCID_BROWSER_LOCK_WAIT_MIN minutes (default 60), then fails with
 * exit code 75. Stdlib only.
 */
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const LOCK_DIR = process.env.LUCID_BROWSER_LOCK || '/tmp/luc3d-browser.lock';
const OWNER = 'owner.json';
const HELD_ENV = 'LUCID_BROWSER_LOCK_HELD';

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

function readOwner(dir = LOCK_DIR) {
    try { return JSON.parse(fs.readFileSync(path.join(dir, OWNER), 'utf8')); } catch (e) { return null; }
}

/** Start time (ms) of process `pid` per `ps`, or null if unknown. */
function processStartMs(pid) {
    try {
        const r = spawnSync('ps', ['-o', 'lstart=', '-p', String(pid)], { encoding: 'utf8' });
        const t = Date.parse((r.stdout || '').trim());
        return Number.isFinite(t) ? t : null;
    } catch (e) { return null; }
}

/** Is the lock's owner still the process that took it? */
function ownerAlive(o) {
    if (!o || !Number.isInteger(o.pid)) return false;
    try { process.kill(o.pid, 0); } catch (e) { if (e.code !== 'EPERM') return false; }
    // pid reuse: a process that started after the lock was taken is not its owner
    const st = processStartMs(o.pid);
    return !(st != null && o.processStartMs != null && st > o.processStartMs + 2000);
}

export function describeOwner(o) {
    if (!o) return 'an unknown holder';
    const mins = ((Date.now() - Date.parse(o.started)) / 60000).toFixed(1);
    return `"${o.label}" (pid ${o.pid}, ${o.cwd}, held ${mins} min)`;
}

/** Move a stale lock aside, but only if it still belongs to `stale` (another waiter may have replaced it). */
function breakStale(stale) {
    const grave = `${LOCK_DIR}.stale.${process.pid}.${Date.now()}`;
    try { fs.renameSync(LOCK_DIR, grave); } catch (e) { return; }
    const moved = readOwner(grave);
    if (moved && (!stale || moved.pid !== stale.pid || moved.started !== stale.started)) {
        try { fs.renameSync(grave, LOCK_DIR); return; } catch (e) { /* re-taken meanwhile: fall through */ }
    }
    fs.rmSync(grave, { recursive: true, force: true });
}

/** Activate the Claude app (macOS), so the user sees the run has finished. */
function refocusClaude() {
    if (process.platform !== 'darwin' || process.env.LUCID_BROWSER_LOCK_REFOCUS === '0') return;
    try { spawnSync('osascript', ['-e', 'tell application "Claude" to activate'], { stdio: 'ignore', timeout: 5000 }); } catch (e) { /* not fatal */ }
}

/**
 * Wait for and take the lock. Resolves to an async `release()` (idempotent;
 * also run on exit and on SIGINT/SIGTERM/SIGHUP). If an ancestor process holds
 * it (LUCID_BROWSER_LOCK_HELD), resolves at once to a no-op.
 */
export async function acquireBrowserLock({ label, log = (m) => console.error(m), waitMin } = {}) {
    const held = process.env[HELD_ENV];
    if (held) {
        const o = readOwner();
        if (o && String(o.pid) === held && ownerAlive(o)) return async () => {};
    }
    label = label || path.basename(process.argv[1] || 'run');
    const maxWait = (waitMin != null ? waitMin : Number(process.env.LUCID_BROWSER_LOCK_WAIT_MIN || 60)) * 60000;
    const t0 = Date.now();
    let told = 0;
    for (;;) {
        try {
            fs.mkdirSync(LOCK_DIR);
            const owner = { pid: process.pid, label, cwd: process.cwd(), host: os.hostname(),
                started: new Date().toISOString(), processStartMs: Math.round(Date.now() - process.uptime() * 1000) };
            fs.writeFileSync(path.join(LOCK_DIR, OWNER), JSON.stringify(owner, null, 2));
            if (told) log(`[browser-lock] acquired after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
            return makeRelease(owner);
        } catch (e) {
            if (e.code !== 'EEXIST') throw e;
        }
        const o = readOwner();
        if (!o) {
            // created but owner.json not written yet — or its creator died in between
            let age = 0;
            try { age = Date.now() - fs.statSync(LOCK_DIR).mtimeMs; } catch (e) { continue; }
            if (age > 10000) { log('[browser-lock] breaking a lock with no owner record'); breakStale(null); continue; }
        } else if (!ownerAlive(o)) {
            log(`[browser-lock] breaking a stale lock: ${describeOwner(o)} is no longer running`);
            breakStale(o);
            continue;
        }
        const waited = Date.now() - t0;
        if (!told || waited - told >= 60000) {
            log(`[browser-lock] waiting for ${describeOwner(o)} — another headed browser run is in progress`);
            told = waited || 1;
        }
        if (waited > maxWait) {
            const err = new Error(`[browser-lock] gave up after ${(maxWait / 60000).toFixed(0)} min; still held by ${describeOwner(o)}`);
            err.code = 'BROWSER_LOCK_TIMEOUT';
            throw err;
        }
        await sleep(2000);
    }
}

function makeRelease(owner) {
    let done = false;
    const free = () => {
        if (done) return;
        done = true;
        const o = readOwner();
        if (o && o.pid === owner.pid && o.started === owner.started) fs.rmSync(LOCK_DIR, { recursive: true, force: true });
    };
    const onSignal = (sig) => { free(); process.exit(sig === 'SIGINT' ? 130 : 143); };
    process.once('exit', free);
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.once(s, onSignal);
    /** `release({ refocus: false })` leaves the browser in front (e.g. a window kept open to inspect). */
    return async function release(opts) {
        if (done) return;
        if (!(opts && opts.refocus === false)) refocusClaude();   // before freeing, so the next holder's window opens on top
        free();
    };
}

// ------------------------------------------------------------------ CLI
const isMain = process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url);
if (isMain) {
    const args = process.argv.slice(2);
    if (args[0] === 'status') {
        const o = readOwner();
        console.log(fs.existsSync(LOCK_DIR)
            ? `${LOCK_DIR}: held by ${describeOwner(o)}${o && !ownerAlive(o) ? ' — STALE (owner not running)' : ''}`
            : `${LOCK_DIR}: free`);
        process.exit(0);
    }
    const dd = args.indexOf('--');
    const opts = dd >= 0 ? args.slice(0, dd) : [];
    const cmd = dd >= 0 ? args.slice(dd + 1) : args;
    if (!cmd.length) {
        console.error('usage: node scripts/browser-lock.mjs [--label=TEXT] -- <command> [args…]\n       node scripts/browser-lock.mjs status');
        process.exit(64);
    }
    const labelOpt = opts.find((a) => a.startsWith('--label='));
    let release;
    try {
        release = await acquireBrowserLock({ label: labelOpt ? labelOpt.slice(8) : cmd.join(' ').slice(0, 120) });
    } catch (e) {
        console.error(e.message);
        process.exit(e.code === 'BROWSER_LOCK_TIMEOUT' ? 75 : 1);
    }
    const child = spawn(cmd[0], cmd.slice(1), { stdio: 'inherit', env: { ...process.env, [HELD_ENV]: String(process.pid) } });
    // forward termination to the child; the lock is freed when this process exits
    for (const s of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.removeAllListeners(s).on(s, () => { try { child.kill(s); } catch (e) {} });
    child.on('exit', async (code, sig) => {
        await release();
        process.exit(code != null ? code : (sig ? 128 + (os.constants.signals[sig] || 1) : 1));
    });
    child.on('error', async (e) => { console.error(e.message); await release(); process.exit(127); });
}
