#!/usr/bin/env python3
"""
Shared loading, guards and constants for Figure 9's three panels.

    FIGURE 9 IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is absent
    from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no panel of
    Figures 1-7 depends on it. Do not cite it as a result.

NOT A PANEL -- this file draws nothing. It exists because 9a, 9b and 9c all print the
SAME load-bearing numbers on their artwork (the 0.7704 identity-fix ceiling, the 32/74
single-animal split, the two configurations' names) and three copies of those constants
is three chances for one panel to disagree with the others about what the corpus is.
One home, checked once against the deposit's own `caveats`.

`figs/panels/fig9_0*.py` are the panels; `figs/fig9_slap2m.py` is the measurement.
"""
from __future__ import annotations

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import have, load  # noqa: E402
from src.style import INK, PERIWINKLE  # noqa: E402

DEPOSIT = "fig9_slap2m.json"

#: The measurement command, printed verbatim by every clean failure. It needs the BENCH
#: interpreter (motmetrics + the detection pool), not figs/.venv, and it writes the JSON
#: once at the very end of the pass -- so "missing" usually means "still running".
RUN = ("/root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig9_slap2m.py "
       "--configs shipped,sync_stale20_dist25")
PROGRESS = "tail figs/out/tmp/fig9_slap2m.log"

#: (config key, label drawn on the panel, colour).
#:
#: Colours match Fig 8d exactly -- shipped is INK and this arm is PERIWINKLE there --
#: because the two figures are read against each other (BMimica there, SLAP-2M here) and
#: a hue that swapped meaning between them would be worse than no colour at all.
#:
#: The long label is deliberate. "stale 20" names nothing on its own, and the arm is
#: EXPERIMENTAL: it lives in `figs/fig8-bench/xv_experimental.js` and is NOT in the
#: shipped app, which has to be legible on the artwork and not only in a caption.
SHIPPED = "shipped"
IMPROVED = "sync_stale20_dist25"
SERIES = [
    (SHIPPED, "shipped — pose/cross-view-tracker.js as it ships", INK),
    (IMPROVED, "M1 + stale 20 + distThresh 25 — EXPERIMENTAL: "
               "figs/fig8-bench/xv_experimental.js, not in the shipped app", PERIWINKLE),
]
COLOUR = {c: k for c, _l, k in SERIES}
LABEL = {c: l for c, l, _k in SERIES}
#: Short forms, for axis tick labels where the full label will not fit.
SHORT = {SHIPPED: "shipped", IMPROVED: "M1 + stale 20 + dt 25"}

#: What `misgrouped` IS, in one sentence, wrapped by each panel to its own column width so
#: 9b and 9c cannot drift apart on the definition.
#:
#: THE UNIT IS A DETECTION, NOT A FRAME. It was called "misgrouped frames" until
#: 2026-08-13; on this cohort there are ~1.8 labelled detections per camera-frame and six
#: camera-frames per video frame, so "frames" was wrong by more than an order of magnitude
#: and made a rate above 100,000 per 100,000 camera-frames read as an impossibility rather
#: than as arithmetic.
#:
#: THE PERMUTATION IS THE FIX. The first version compared the tracker's identity id against
#: the GT track index DIRECTLY -- the tracker allocates ids as it discovers animals, GT
#: numbers tracks 0..n-1 per session -- so it measured how often two arbitrary labellings
#: coincide, which for two animals is ~50% by construction. `fig9_slap2m.py:score_one` now
#: maximises agreement over the tracker-id x GT-index co-occurrence table per (session,
#: camera) before counting disagreements, which is what IDF1 does internally.
MISGROUPED_DEF = (
    "misgrouped = a LABELLED DETECTION — one animal, one camera, one frame — over a GT box "
    "(IoU ≥ 0.5) whose id disagrees with that box under the OPTIMAL tracker-id -> GT-index "
    "permutation for that camera, solved with linear_sum_assignment exactly as IDF1 does "
    "internally")


def misgrouped_lines(width, colour, tail=None):
    """`MISGROUPED_DEF` wrapped to `width` characters, as `text_legend` entries.

    Wrapped rather than hand-split per panel: 9b's key column holds ~70 characters and 9c's
    full width ~104, and two hand-wrapped copies of one definition is how the two panels
    would come to disagree about what the metric is -- which is the failure this whole
    correction is about. `tail` is appended to the last line's paragraph before wrapping so
    each panel can add its own numbers without a dangling short line.
    """
    import textwrap
    text = MISGROUPED_DEF + (f" — {tail}" if tail else "")
    return [(ln, colour) for ln in textwrap.wrap(text, width)]

#: The identity-fix ceiling on SLAP-2M: the cross-view IDF1 a tracker that got EVERY
#: identity right would still be stuck at, because 35.4% of ground truth has no
#: detection to carry a label at all. BMimica's detector misses 8.7% and its ceiling is
#: 0.9527, which is why a smaller gain here than there is EXPECTED rather than a
#: failure. Both are asserted against the deposit's own `caveats` by `verify()`.
CEILING = 0.7704
BMIMICA_CEILING = 0.9527
MISS_RATE = "35.4%"

#: The reference result on the other corpus, quoted on 9b so the SLAP-2M numbers are
#: read against something. From figs/out/fig8_methods_50.json via Fig 8d.
BMIMICA_REF = ("BMimica reference (50 sessions, 5 cameras): shipped 2,071 switches "
               "(0.00460% of camera-frames) -> stale 20's 413 (0.00092%); "
               "cross-view IDF1 0.749 -> 0.861")

#: (cohort key in the deposit, label, linestyle, linewidth). MULTI-ANIMAL FIRST, and
#: solid: it is the reading. 32 of the 74 sessions hold ONE animal, where there is
#: nothing to associate across views and every tracker scores near-perfectly (Fig 7d),
#: so pooling them dilutes any effect by 43%. `all_sessions` is drawn BESIDE it, never
#: instead of it.
#: MULTI-ANIMAL ONLY. The 32 single-animal sessions were dropped from Figure 9 entirely
#: (2026-08-13, on instruction) and the reason is measured, not stylistic: they contribute
#: EXACTLY 0 ID switches and 0 misgrouped detections under both configurations, so
#: including them changed nothing but the denominator -- inflating it by 66% (11,726,640
#: camera-frames over 74 against 4,044,666 over 42) and making every pooled rate look
#: better than it is. With nothing to associate across views there is no cross-view
#: tracking problem in a one-animal session at all.
COHORTS = [("multi_animal_only", "42 multi-animal", "-", 1.9)]


def verify(d, panel):
    """Fail if the deposit no longer supports the claims the panels print.

    The ceiling, the 32/74 split and the detector's miss rate are drawn as statements of
    fact on the artwork, and they are the measurement script's claims, not the panels'.
    A panel that kept printing them after the deposit stopped saying them would be the
    worst failure mode available here: stale prose over fresh numbers.
    """
    blob = " ".join(d.get("caveats", []))
    # "RELATIVE" was in this list until 2026-08-13 and is deliberately gone. It pinned the
    # panels to the deposit's claim that `misgrouped` could only be compared BETWEEN
    # configurations, because the pre-fix metric compared tracker ids against GT track
    # indices directly -- two unrelated numbering systems. `fig9_slap2m.py:score_one` now
    # solves the optimal id permutation per (session, camera) with `linear_sum_assignment`
    # before counting disagreements, which is what IDF1 does internally, so the level is
    # meaningful and the panels say so. NOTE the deposit's own `misgrouped` caveat still
    # carries the pre-fix "RELATIVE rate" sentence; the panels describe the code, and that
    # caveat string needs the same correction in fig9_slap2m.py.
    for token in (str(CEILING), str(BMIMICA_CEILING), MISS_RATE, "32 of 74", "43%"):
        if token not in blob:
            sys.exit(f"{panel}: figs/out/{DEPOSIT} `caveats` no longer states {token!r}, "
                     f"which this panel draws on the artwork. Reconcile the panel with "
                     f"the deposit before rendering.\n  deposit written by: {RUN}")


def load9(panel, *, need_pr=False):
    """`(deposit, {config: cell})`, or a clean exit naming what to run.

    A half-empty axis is worse than no axis at all: it reads as a measurement that found
    nothing rather than one that was never made. Every failure here names the command.
    """
    if not have(DEPOSIT):
        sys.exit(f"{panel}: missing figs/out/{DEPOSIT}. The SLAP-2M measurement pass has "
                 f"not finished — it writes the file once, at the end of the pass.\n"
                 f"  run:      {RUN}\n  progress: {PROGRESS}")
    d = load(DEPOSIT)
    cells = {c["config"]: c for c in d.get("cells", [])
             if c.get("all_sessions") and c.get("per_session")}
    absent = [c for c in (SHIPPED, IMPROVED) if c not in cells]
    if absent:
        sys.exit(f"{panel}: figs/out/{DEPOSIT} has no usable cell for {absent} "
                 f"(present: {sorted(cells) or 'none'}).\n  run: {RUN}")
    for c in (SHIPPED, IMPROVED):
        if not cells[c].get("multi_animal_only"):
            sys.exit(f"{panel}: cell {c!r} has no `multi_animal_only` aggregate, which is "
                     f"the primary reading of every Fig 9 panel.\n  run: {RUN}")
        if need_pr and cells[c]["per_session"][0].get("cross_idp") is None:
            sys.exit(f"{panel}: cell {c!r} was scored before identity precision/recall "
                     f"were added and must be RE-SCORED.\n  run: {RUN}")
    verify(d, panel)
    CF.clear()
    CF.update(camera_frames_of(d))
    return d, cells


def camera_frames_of(d):
    """`session -> camera-frames`, summed over that session's six cameras.

    The measured denominator both rates share: per camera, min(gt_frames, det_frames)
    clipped to the session's real length. Used to build denominators for strata the
    deposit does not pre-aggregate (e.g. multi-animal only, per difficulty).
    """
    return {s: sum(per.values()) for s, per in d["camera_frames_by_session"].items()}


def strata(cells, key):
    """Per-stratum aggregates over MULTI-ANIMAL sessions only, recomputed from scratch.

    The deposit's own `by_difficulty` / `by_animals` aggregate EVERY session in a stratum,
    single-animal ones included, so they cannot be reused once Figure 9 excludes those --
    a difficulty stratum that is half one-animal sessions would carry their camera-frames
    in its denominator and none of their (zero) switches, halving its apparent rate. So
    this rebuilds each stratum from `per_session`, filtered to `animals > 1`, and derives
    the denominator by summing that stratum's own sessions out of
    `camera_frames_by_session`.

    `key` is "difficulty" or "animals". Returns {config: {stratum: aggregate}} with
    stratum keys as ints, plus the session count so an empty or thin stratum is visible
    rather than drawn as a confident zero.
    """
    import numpy as np
    out = {}
    for cfg, cell in cells.items():
        rows = [r for r in cell["per_session"] if r["animals"] > 1]
        per = {}
        for r in rows:
            per.setdefault(int(r[key]), []).append(r)
        agg = {}
        for k, sub in sorted(per.items()):
            cf = sum(CF[r["session"]] for r in sub)
            sw = sum(r["within_switches"] for r in sub)
            mis = sum(r["misgrouped"] for r in sub)
            agg[k] = {
                "n_sessions": len(sub), "camera_frames": cf,
                "idf1_cross": float(np.mean([r["cross_idf1"] for r in sub])),
                "idp_cross": float(np.mean([r["cross_idp"] for r in sub])),
                "idr_cross": float(np.mean([r["cross_idr"] for r in sub])),
                "switches": sw, "switches_per_100k": sw * 1e5 / cf if cf else float("nan"),
                "misgrouped": mis,
                "misgrouped_per_100k": mis * 1e5 / cf if cf else float("nan"),
            }
        out[cfg] = agg
    return out


#: filled by `load9`, so `strata` can reach the per-session denominators
CF = {}


#: The OTHER SLAP-2M detection pool, measured by the same script with `--pool predictions`.
#: It is what Fig 7's b-g panels are scored on, and the corrected `misgrouped` metric does
#: not merely change its magnitude -- it REVERSES the direction reported for this arm. Read
#: only for the two or three cells' multi-animal aggregates, never merged with this pool's
#: numbers: the two pools have different detectors, so their LEVELS are not comparable.
OTHER_POOL = "fig9_slap2m_predictions.json"
#: The BMimica winner that does NOT transfer, checked for in the deposits rather than assumed.
CORR12 = "sync_stale20_dist25_corr12"


def other_pool():
    """`{config: multi_animal_only aggregate}` for `OTHER_POOL`, or `{}`.

    Optional by design, and silent on failure for a specific reason: the measurement script
    rewrites these deposits in place, so a panel that hard-failed on a half-written file
    would break every render that happened to coincide with a re-score. A panel that quotes
    this must say so when it comes back empty rather than dropping the sentence.
    """
    import json
    from src.data_loader import OUT
    try:
        d = json.loads((OUT / OTHER_POOL).read_text())
        return {c["config"]: c["multi_animal_only"] for c in d["cells"]
                if c.get("multi_animal_only")}
    except Exception:  # noqa: BLE001 -- absent, mid-write, or malformed: all "not available"
        return {}


def corpus_shape(d, cell):
    """`(video_frames, camera_frames, labelled_detections)` for the multi-animal cohort.

    THREE DIFFERENT DENOMINATORS, all of which have been called "frames" on this figure at
    some point, which is exactly how `misgrouped` came to be reported as a count of frames
    and then read as impossible. Named apart, and DERIVED rather than typed: video frames
    is camera-frames over the six cameras the deposit names, and labelled detections is the
    measurement's own `det_labelled`.
    """
    a = cell["multi_animal_only"]
    cf = int(a["camera_frames"])
    ncam = len(d.get("cameras") or []) or 1
    return cf // ncam, cf, int(a["det_labelled"])
