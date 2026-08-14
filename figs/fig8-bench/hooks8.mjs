// ESM loader hooks for the Fig 8 METHODS bench — scripts/bench/hooks.mjs plus one
// extra interception.
//
// `scripts/bench/hooks.mjs` stubs the UI modules so pose/tracker.js can load
// headlessly, and routes thresholds through globalThis.__BENCH. This adds a single
// redirect on top: the specifier `pose/cross-view-tracker.js` is served from
// `figs/fig8-bench/xv_experimental.js` instead of the real file.
//
// WHY A REDIRECT AND NOT AN EDIT. pose/cross-view-tracker.js is shipped code that
// works on the real project, and CLAUDE.md's figs rule ("no app-source edits") plus
// the standing instruction not to refactor working LUCID paths both say the same
// thing: an exploratory method sweep must not be able to change what the app does.
// So the app file is read, never written, and the experiment lives entirely in
// figs/.
//
// The redirect serves SOURCE for the pose/cross-view-tracker.js URL rather than
// resolving to a different path, so the experimental module's relative imports
// (`./triangulation.js`, `./pose-data.js`) still resolve inside pose/ and load the
// REAL, unmodified geometry. Everything below the tracker is production code.
//
// With no `__BENCH.method` flags set, xv_experimental.js must reproduce the shipped
// tracker exactly; `figs/fig8_methods.py --verify` asserts that at the level of a
// SHA-256 of the tracker's whole identities+frames payload on full sessions.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { load as baseLoad } from '../../scripts/bench/hooks.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const EXPERIMENTAL = path.join(HERE, 'xv_experimental.js');

export async function load(url, context, nextLoad) {
    if (url.endsWith('/pose/cross-view-tracker.js')) {
        return {
            format: 'module',
            source: fs.readFileSync(EXPERIMENTAL, 'utf8'),
            shortCircuit: true,
        };
    }
    return baseLoad(url, context, nextLoad);
}
