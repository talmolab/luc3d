#!/usr/bin/env node
/**
 * fig3_exhaustive_probe.mjs — run `fig3_exhaustive.mjs` with the FRESH-ANCHOR
 * EXPERIMENTAL TRACKER CONFIGURATION ACTIVE, to test whether the exhaustive arm of the
 * Fig 3 head-to-head depends on it.
 *
 * WHY. Redoing Fig 3 with the fresh anchor re-runs the GREEDY arm (which is the real
 * production tracker) and re-uses the cached EXHAUSTIVE arm, because the exhaustive
 * method is a different algorithm that has no tracker state and therefore no anchor.
 * Re-using a cache on the strength of an argument is exactly the move that produces a
 * stale figure, so the argument is tested: this wrapper runs the exhaustive driver with
 *   * `figs/fig3-bench/probe_hooks.mjs` registered — i.e. hooks8's redirect of
 *     `pose/cross-view-tracker.js` to `figs/fig8-bench/xv_experimental.js`, plus a log
 *     of every module URL that is loaded, and
 *   * the method + threshold block FORCED onto `globalThis.__BENCH`,
 * and the caller digest-compares the resulting frames against the cached
 * `exhaustive.json`. Identical ⇒ the cache is valid. Different ⇒ stop and report.
 *
 * THE FORCED __BENCH IS THE POINT. fig3_exhaustive.mjs ASSIGNS
 * `globalThis.__BENCH = { nodeWeights: {}, thresholds: {} }` at the top of main(), so
 * setting it before the import would simply be overwritten — and a probe that was
 * silently disarmed would "pass" no matter what. The property below is an accessor
 * whose setter merges the method/threshold block back in, so whatever the driver
 * assigns, the experimental configuration is live for the whole run.
 *
 * `nodeWeights` is deliberately NOT injected: the exhaustive driver scores with
 * unweighted nodes (no tail exclusion) and that is a property of the exhaustive arm,
 * not of the tracker's anchor. Injecting node weights would change the reprojection
 * objective and the probe would be testing something else.
 *
 * CLI: identical to fig3_exhaustive.mjs (argv is passed straight through).
 * Env: PROBE_METHOD / PROBE_THRESHOLDS (JSON), PROBE_LOADLOG (path).
 */
import { register } from 'node:module';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const HOOKS = pathToFileURL(path.resolve(HERE, 'probe_hooks.mjs')).href;

//: Kept identical to fig8_bench.mjs's list, because xv_experimental.js reads
//: __BENCH.nodeNames when a method needs node identities.
const NODE_NAMES = [
    'Nose', 'Ear_R', 'Ear_L', 'TTI', 'TailTip', 'Head', 'Trunk',
    'Tail_0', 'Tail_1', 'Tail_2', 'Shoulder_left', 'Shoulder_right',
    'Haunch_left', 'Haunch_right', 'Neck',
];

const METHOD = JSON.parse(process.env.PROBE_METHOD || '{}');
const THRESHOLDS = JSON.parse(process.env.PROBE_THRESHOLDS || '{}');

let bench = { nodeWeights: {}, thresholds: Object.assign({}, THRESHOLDS),
              method: Object.assign({}, METHOD), nodeNames: NODE_NAMES };
Object.defineProperty(globalThis, '__BENCH', {
    configurable: true,
    get() { return bench; },
    set(v) {
        const next = Object.assign({}, v || {});
        next.thresholds = Object.assign({}, next.thresholds || {}, THRESHOLDS);
        next.method = Object.assign({}, METHOD);
        next.nodeNames = NODE_NAMES;
        bench = next;
    },
});

register(HOOKS, import.meta.url);
process.stderr.write(`[exh-probe] method=${JSON.stringify(METHOD)} `
    + `thresholds=${JSON.stringify(THRESHOLDS)} hooks=probe_hooks.mjs\n`);
await import(pathToFileURL(path.join(HERE, 'fig3_exhaustive.mjs')).href);
