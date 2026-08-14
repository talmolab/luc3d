// ESM loader hook for the EXHAUSTIVE-INDEPENDENCE PROBE (Fig 3 fresh-anchor, item 5).
//
// It is `figs/fig8-bench/hooks8.mjs` — the experimental hook that serves
// `figs/fig8-bench/xv_experimental.js` in place of `pose/cross-view-tracker.js` —
// PLUS a log of every module URL that reaches it. The log is the evidence: the claim
// under test is that `figs/fig3-bench/fig3_exhaustive.mjs` is independent of the
// tracker (and therefore of the tracker's 3D anchor), and the strongest form of that
// evidence is that the tracker module is never requested at all, measured rather than
// read off the imports.
//
// Written to $PROBE_LOADLOG, one URL per line, appended. Nothing else differs from
// hooks8.mjs; `pose/cross-view-tracker.js` would still be redirected if it were ever
// asked for, so the probe is a live experimental configuration and not a bypass.
//
// NOTE ON CHAIN ORDER. fig3_exhaustive.mjs registers `scripts/bench/hooks.mjs` itself,
// and node runs the most recently registered hook first. That hook short-circuits the
// UI stubs (ui/settings.js, ui/app-state.js, ...) before this one sees them, so the log
// is the set of REAL modules loaded, which is exactly the set the claim is about.
import fs from 'node:fs';
import { load as hook8Load } from '../fig8-bench/hooks8.mjs';

const LOG = process.env.PROBE_LOADLOG;

export async function load(url, context, nextLoad) {
    if (LOG) {
        try { fs.appendFileSync(LOG, url + '\n'); } catch (e) { /* logging must not fail the run */ }
    }
    return hook8Load(url, context, nextLoad);
}
