#!/usr/bin/env python
"""Fig 8b (EXPLORATORY) — ALGORITHMIC methods for the cross-view tracker, measured on
exactly Fig 8's measurement.

Fig 8 swept the ten CrossViewTracker THRESHOLDS and found that five cannot move the
shipped tracker at all and that the best available knob (`distanceThreshold` 50 -> 25)
buys 4.50 -> 3.64 switches per 100,000 camera-frames and cross-view IDF1 0.735 ->
0.795. This script asks the next question: what does a change to the ALGORITHM buy,
rather than a change to its constants?

Same 8 BMimica sessions, same shared detection pool, same full sessions with no frame
cap, same `figs/fig3_score.py` scorer, same 7,205,370 camera-frame denominator — so
every number here is directly comparable to Fig 8's and Fig 3e's. The only difference
from `fig8_param_sweeps.py` is the driver: `figs/fig8-bench/fig8_bench.mjs`, which
serves `figs/fig8-bench/xv_experimental.js` in place of pose/cross-view-tracker.js via
an ESM loader hook. No app source is modified.

WHY THESE METHODS — see `figs/fig8_diag_loss.py`, which decomposes the loss first:
99.4% of detections already get an identity (coverage is not the problem), the
perfect-identity ceiling at that coverage is 0.9367 against an as-is 0.7347, and IDF1 is
0.935 over the leading 20,000 frames of each session but 0.735 over the whole thing. So
the failure is a handful of PERMANENT identity swaps, not a large number of switches —
324 switches across 7.2M camera-frames, and 20250904_131913 loses 0.311 IDF1 to TEN of
them. Each costs every frame that follows it, because after a swap both targets are
perfectly consistent with their swapped detections and no geometric term can even detect
it. Prevention and recovery are therefore not interchangeable.

WHAT IT FOUND, so a reader of this file knows where it ended up: the winning axis is
ANCHOR FRESHNESS, which was not one of the three methods this started with.
`Target.detsByCam` keeps one detection per camera and never expires it, and
`_retriangulate()` fuses all of them, so the 3D state every association is scored against
blends the current pose with wherever each other camera last saw the animal — mean
detection age 3.0-49.8 frames by session, maxima up to 8,652
(`figs/fig8_diag_anchor_age.py`). Evicting stale detections plus scoring the whole frame
against one frozen state plus `distanceThreshold` 25 reaches 108 switches / 0.8745 IDF1
(`stale: 1`) or 64 switches / 0.8581 (`stale: 10`), against the shipped 324 / 0.7347 and
the best pure-threshold configuration's 252 / 0.8185. Three of the initial premises were
refuted by measurement — see the "WHAT THE MEASUREMENTS DID TO THE HYPOTHESES" block in
xv_experimental.js, which is the part worth reading before adding another method.

    $PY figs/fig8_methods.py --verify              # prove the fork == shipped tracker
    $PY figs/fig8_methods.py                       # run every config
    $PY figs/fig8_methods.py --configs bundle,bundle_reid4
    $PY figs/fig8_methods.py --recheck             # do cached cells still reproduce?
    $PY figs/fig8_methods.py --reaggregate         # redo vs_shipped, no re-scoring
    $PY figs/fig8_methods.py --per-session         # merge per-session detail

Run with the bench interpreter (scoring needs motmetrics):
/root/vast/eric/luc3d-bench/liezl_env/bin/python

Output: figs/out/fig8_methods.json; per-cell tracker results cached under
figs/out/tmp/fig8m/, so the run is restartable. That cache is the one hazard here — it
outlives tracker edits, so `--recheck` exists to prove it has not silently mixed code
versions across rounds.
"""
import argparse
import hashlib
import json
import os
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "figs" / "out"

sys.path.insert(0, str(REPO / "figs"))
import fig3_sweep as f3  # noqa: E402
import fig8_param_sweeps as f8  # noqa: E402  (payload_digest, vslug)

TMP_DIR = OUT_DIR / "tmp" / "fig8m"
DEPOSIT = OUT_DIR / "fig8_methods.json"
DRIVER = REPO / "figs" / "fig8-bench" / "fig8_bench.mjs"

#: Fig 8's default cell — the shipped tracker on these same 8 full sessions. Symlinked
#: in as the control so the comparison is against a measurement, not a remembered
#: number.
SHIPPED_SRC = OUT_DIR / "tmp" / "fig8" / "default"

WORKERS = int(os.environ.get("FIG8M_WORKERS", "32"))

#: Common re-id settings. `reidScale` is calibrated, not guessed: the descProbe run
#: (`method.descProbe`) measures a target's prototype at 3.2 mm from its own animal's
#: bundle and 7.7 mm from the other animal's on a clean session, so a 5 mm scale puts
#: the two roughly a full unit apart in the cost. `reidMaxDesc` discards the term
#: entirely when the descriptor distance is absurd (some sessions triangulate badly and
#: produce hundreds of mm), so a broken 3D frame cannot drive an identity decision.
REID = {"reidScale": 5, "reidWarm": 500, "reidEma": 0.01, "reidMaxDesc": 20}

#: (name, method overrides, one-line rationale). `shipped` is the control.
CONFIGS = [
    ("shipped", {},
     "control: pose/cross-view-tracker.js as it ships (Fig 8's default cell)"),
    ("sync", {"sync": True},
     "M1: score every view against the frame-start 3D and re-triangulate once at "
     "frame end, so one ambiguous view cannot drag the other four with it"),
    ("bundle", {"bundle": True},
     "M2: epipolar-cluster detections across views into 3D bundles, then ONE "
     "Hungarian target->bundle; cross-view consistency by construction"),
    ("bundle_stale1", {"bundle": True, "stale": 1},
     "M2 + evict per-view detections older than 1 frame, so re-triangulation never "
     "fuses a current view with a stale one"),
    ("sync_motion", {"sync": True, "motion": 0.5},
     "M1 + damped constant-velocity 3D prediction (SORT's motion model, absent from "
     "the reference tracker)"),
    ("bundle_reid4", dict({"bundle": True, "reid": 4}, **REID),
     "M3: M2 + skeletal re-id prototype in the assignment cost (recovery half)"),
    ("bundle_reid8", dict({"bundle": True, "reid": 8}, **REID),
     "M3 at twice the weight"),
    ("bundle_reid4_hyst", dict({"bundle": True, "reid": 4, "reidSwapFrames": 30}, **REID),
     "M3 + hysteresis: adopt a re-id-driven disagreement only after 30 consecutive "
     "frames, so descriptor noise cannot flip identities"),

    # --- round 2: prototype memory. The plain EMA above has a ~100-frame time
    # constant at reidEma 0.01, so after a swap the prototype MIGRATES ONTO THE OTHER
    # ANIMAL and the recovery signal decays -- the recovery window is only as long as
    # that time constant. These vary the memory instead of the weight.
    ("bundle_reid4_slow", dict({"bundle": True, "reid": 4}, **dict(REID, reidEma=0.0005)),
     "M3 with a 2,000-frame prototype time constant instead of 100"),
    ("bundle_reid4_freeze", dict({"bundle": True, "reid": 4},
                                 **dict(REID, reidFreeze=2000)),
     "M3 learning the prototype over 2,000 frames and then FREEZING it, so it stays "
     "attached to the animal it was learned from"),
    ("bundle_reid8_freeze", dict({"bundle": True, "reid": 8},
                                 **dict(REID, reidFreeze=2000)),
     "frozen prototype at twice the weight"),
    ("bundle_reid8_freeze_hyst", dict({"bundle": True, "reid": 8, "reidSwapFrames": 30},
                                      **dict(REID, reidFreeze=2000)),
     "frozen prototype, twice the weight, plus 30-frame hysteresis"),
]


#: Round 3. Two things changed the question after rounds 1-2, both measured:
#:
#:  * `xvRefine` accepted 0 and 5 exchanges out of ~170,000 tests on two sessions, so
#:    the shipped per-view association is ALREADY cross-view consistent by the
#:    triangulation-residual test. The swap is not a jointly-inconsistent labelling;
#:    all five views swap together and the triangulation stays tight. That is why
#:    `bundle`'s premise was wrong and why `sync`'s gain is small.
#:  * The skeletal re-id descriptor is at chance on full sessions once the prototype is
#:    frozen (P(self closer) 0.40-0.57 over 8 sessions), and block-averaging separates
#:    the animals in only 2 of 8 sessions. There is no animal-attached feature here to
#:    recover a swap with.
#:
#: What is left is to stop an ambiguous frame from being WRITTEN INTO THE ANCHOR, which
#: is the mechanism that makes a swap permanent. The per-view decision gap is measured:
#: fewer than 0.01% of view-decisions fall below a gap of 20 and under 0.7% below 100,
#: so these margins act on the tail rather than on the bulk. And every method has to
#: beat `dist25` — Fig 8's own winner at cross-view IDF1 0.795 — not merely `shipped`.
ROUND3 = [
    ("dist25", {"thresholds": {"distanceThreshold": 25}},
     "Fig 8's threshold winner, re-measured here as the real bar to clear"),
    ("sync_ambig20", {"method": {"sync": True, "ambigMargin": 20}},
     "M4: freeze the 3D anchor on view-decisions whose permutation gap is under 20 "
     "(<0.01% of decisions), so a coin-flip frame cannot become permanent"),
    ("sync_ambig100", {"method": {"sync": True, "ambigMargin": 100}},
     "M4 at gap < 100 (~0.3-0.7% of decisions)"),
    ("sync_ambig400", {"method": {"sync": True, "ambigMargin": 400}},
     "M4 well into the bulk, to find where anchor-freezing starts to cost"),
    ("sync_xvrefine", {"method": {"xvRefine": 2}},
     "M2': cross-view consistency by triangulation residual. Expected null — recorded "
     "on all 8 full sessions so the null is measured, not inferred from two"),
    ("sync_smooth", {"method": {"sync": True, "anchorSmooth": 0.1}},
     "M5: score against a smoothed 3D anchor, the always-on form of M4"),
    ("sync_stale1", {"method": {"sync": True, "stale": 1}},
     "M1 + current-frame-only re-triangulation"),
    ("sync_dist25", {"method": {"sync": True}, "thresholds": {"distanceThreshold": 25}},
     "does M1 add anything on top of Fig 8's threshold winner?"),
]

#: Round 4 — the combination that rounds 1-3 point at, plus its ablations.
ROUND4 = [
    ("dist25_ambig100", {"method": {"ambigMargin": 100},
                         "thresholds": {"distanceThreshold": 25}},
     "M4 on top of the threshold winner, without M1"),
    ("sync_dist25_ambig100", {"method": {"sync": True, "ambigMargin": 100},
                              "thresholds": {"distanceThreshold": 25}},
     "M1 + M4 + the threshold winner"),
    ("sync_dist25_ambig400", {"method": {"sync": True, "ambigMargin": 400},
                              "thresholds": {"distanceThreshold": 25}},
     "M1 + M4 at the wider margin + the threshold winner"),
    ("sync_dist10", {"method": {"sync": True}, "thresholds": {"distanceThreshold": 10}},
     "M1 at the tighter distance threshold Fig 8 also found below the default"),

    # M6. Why a robust aggregation is the remaining idea worth trying inside the cost
    # function: the Hungarian only sees DIFFERENCES, and for the shipped per-node linear
    # ramp the difference between two candidates is (d2 - d1)/distThresh summed over
    # nodes -- so lowering distanceThreshold does not sharpen the ramp in any absolute
    # sense, it just doubles the 3D term's differences RELATIVE to the 2D term's. That
    # is why Fig 8 found distanceThreshold 25 and corr3dWeight 12/36 to be worth about
    # the same, and why its interaction check found they do not stack: they are one knob.
    # Within a linear per-node ramp the only free parameter is that 2D/3D balance, and
    # Fig 3e's grid already swept it. Changing the AGGREGATION is a different axis.
    ("sync_robust25", {"method": {"sync": True, "robustTrim": 0.25}},
     "M6: 25%-trimmed mean per node instead of the shipped sum, so a few badly "
     "triangulated nodes cannot tip a near-degenerate frame"),
    ("dist25_robust25", {"method": {"robustTrim": 0.25},
                         "thresholds": {"distanceThreshold": 25}},
     "M6 on top of the threshold winner"),
    ("sync_dist25_robust25", {"method": {"sync": True, "robustTrim": 0.25},
                              "thresholds": {"distanceThreshold": 25}},
     "M1 + M6 + the threshold winner"),
]

#: Round 5 — against the ACTUAL bar. `dist25` is Fig 8's best 1-D cell, but Fig 8's
#: `interaction_check` found a better one still: `distanceThreshold` 25 WITH
#: `corr3dWeight` 36, at 252 switches (3.497 per 100,000) and cross-view IDF1 0.8185.
#: That is the configuration any algorithmic change actually has to beat, and it is a
#: pure threshold change — no new code. Rounds 1-4 measured methods against `shipped`
#: and against `dist25`; this round re-runs the survivors on top of the real bar, since
#: a method that helps a weak baseline and not a strong one is not worth shipping.
ROUND5 = [
    ("dist25_corr36", {"thresholds": {"distanceThreshold": 25, "corr3dWeight": 36}},
     "THE BAR: Fig 8's interaction_check winner, re-measured through this driver"),
    ("sync_dist25_corr36", {"method": {"sync": True},
                            "thresholds": {"distanceThreshold": 25, "corr3dWeight": 36}},
     "M1 on top of the bar"),
    ("dist25_corr36_ambig100", {"method": {"ambigMargin": 100},
                                "thresholds": {"distanceThreshold": 25,
                                               "corr3dWeight": 36}},
     "M4 on top of the bar"),
    ("dist25_corr36_robust25", {"method": {"robustTrim": 0.25},
                                "thresholds": {"distanceThreshold": 25,
                                               "corr3dWeight": 36}},
     "M6 on top of the bar"),
    ("sync_dist25_corr36_ambig100", {"method": {"sync": True, "ambigMargin": 100},
                                     "thresholds": {"distanceThreshold": 25,
                                                    "corr3dWeight": 36}},
     "M1 + M4 on top of the bar"),

    # OC-SORT's actual point, which the round-1 `sync_motion` test missed: a 1-frame
    # velocity baseline on a DLT triangulation is mostly triangulation noise, so the
    # "prediction" injects noise into the state being matched against. That is why
    # sync_motion (0.746) came in BELOW sync (0.762). A longer observation-centric
    # baseline is the fix, and is a different experiment rather than a re-tune.
    ("sync_motion_base15", {"method": {"sync": True, "motion": 0.5, "motionBase": 15}},
     "M1 + constant-velocity prediction estimated over 15 frames, not 1"),
    ("dist25_corr36_motion15", {"method": {"motion": 0.5, "motionBase": 15},
                                "thresholds": {"distanceThreshold": 25,
                                               "corr3dWeight": 36}},
     "the 15-frame velocity baseline on top of the bar"),
]

#: Round 6 — ANCHOR FRESHNESS, which is what round 3 actually found.
#:
#: `sync` + `stale: 1` came in at 118 switches and cross-view IDF1 0.8341, against the
#: shipped 324 / 0.7347 and against the best pure-threshold configuration's 252 / 0.8185.
#: The mechanism is not subtle once the rest of round 3 is read alongside it. A target's
#: `detsByCam` keeps ONE detection per camera and never expires it, so
#: `_retriangulate()` fuses this frame's views with whatever each other camera last
#: contributed — possibly thousands of frames ago. The 3D anchor every association is
#: scored against is therefore a blend of where the animal is and where it used to be.
#: `stale: 1` drops anything older than the current frame, so the anchor is exactly the
#: current pose.
#:
#: The two methods that deliberately made the anchor STALER are the control for that
#: reading, and they fail hard and monotonically: `ambigMargin` 20/100/400 gives 336 /
#: 1,700 / 27,042 switches, and `anchorSmooth` 0.1 gives 2,800. Fresher is better,
#: staler is worse, over four orders of magnitude of switch count. That is a much
#: stronger statement than one config winning.
#:
#: This round asks the two questions that follow: how far back does the staleness
#: horizon want to reach, and does the fix compose with the threshold winners or replace
#: them? `stale1` without `sync` isolates which half of the round-3 winner did the work.
ROUND6 = [
    ("stale1", {"method": {"stale": 1}},
     "staleness eviction ALONE, to see whether `sync` contributed anything"),
    ("sync_stale2", {"method": {"sync": True, "stale": 2}},
     "how sharp is the horizon? 2 frames"),
    ("sync_stale5", {"method": {"sync": True, "stale": 5}},
     "5 frames"),
    ("sync_stale30", {"method": {"sync": True, "stale": 30}},
     "30 frames — a full second at 30 fps, i.e. mostly the shipped behaviour"),
    ("sync_stale1_dist25", {"method": {"sync": True, "stale": 1},
                            "thresholds": {"distanceThreshold": 25}},
     "the round-3 winner plus Fig 8's threshold winner"),
    ("sync_stale1_dist25_corr36", {"method": {"sync": True, "stale": 1},
                                   "thresholds": {"distanceThreshold": 25,
                                                  "corr3dWeight": 36}},
     "the round-3 winner plus the best pure-threshold configuration"),
    ("stale1_dist25_corr36", {"method": {"stale": 1},
                              "thresholds": {"distanceThreshold": 25,
                                             "corr3dWeight": 36}},
     "same without `sync`"),
]

#: Round 7 — do no harm. `sync` + `stale: 1` + `distanceThreshold` 25 reaches 108
#: switches / 0.8745, but it is WORSE on 20250827_141755 (0.9664 -> 0.8990, +18
#: switches) — a session that was already sitting exactly on its own oracle ceiling.
#: That is this repo's known failure pattern for identity fixes, so it is the number
#: that decides whether any of this is shippable.
#:
#: The anchor-age measurement says what to try. 20250827_141755's mean detection age is
#: 4.5 frames with 0.99% over 100; the sessions that gain have means of 22-50 frames and
#: 4-6% over 100. So `stale: 1` is rewriting the behaviour of a session that never had a
#: staleness problem in order to fix ones that did. A HORIZON — long enough to leave
#: ordinary 2-5 frame staleness alone, short enough to cut the multi-thousand-frame tail
#: — should get the gains without the regression. `sync_stale30` alone (0.8326, 114
#: switches) versus `sync_stale1` (0.8341, 118) already suggests the horizon is not
#: sensitive, i.e. the damage is done by the long tail and not by the bulk.
ROUND7 = [
    ("sync_stale10_dist25", {"method": {"sync": True, "stale": 10},
                             "thresholds": {"distanceThreshold": 25}},
     "10-frame horizon: cut the tail, leave ordinary staleness"),
    ("sync_stale20_dist25", {"method": {"sync": True, "stale": 20},
                             "thresholds": {"distanceThreshold": 25}},
     "20-frame horizon — fills the gap between 10 and 30 for the horizon curve"),
    ("sync_stale30_dist25", {"method": {"sync": True, "stale": 30},
                             "thresholds": {"distanceThreshold": 25}},
     "30-frame horizon — one second at 30 fps"),
    ("sync_stale100_dist25", {"method": {"sync": True, "stale": 100},
                              "thresholds": {"distanceThreshold": 25}},
     "100-frame horizon: only the extreme tail"),

    # Fig 3g's finding, folded back in. Re-running the corr2d x corr3d sweep on 50 sessions
    # WITH the fresh anchor showed corr3dWeight = 12 reaching 371 switches against the
    # shipped r = 6's 413 -- so the corr3d plateau Fig 3e and Fig 8 both reported was a
    # property of the STALE anchor, not of the cost function. Once the anchor is fresh the
    # 3D term rewards more weight. This measures that combination through the same harness
    # as every other cell, with idp/idr, so it is directly comparable.
    ("sync_stale20_dist25_corr12", {"method": {"sync": True, "stale": 20},
                                    "thresholds": {"distanceThreshold": 25,
                                                   "corr3dWeight": 12}},
     "the fresh anchor at the corr3dWeight Fig 3g found, not the shipped 6"),
]

#: Round 8 — close the inventory. Two methods were implemented and documented in
#: xv_experimental.js but appeared in no scored configuration, which would leave them
#: asserted rather than measured. Both are expected to fail for reasons already
#: established, and both are run anyway, because "expected to fail for established
#: reasons" is how an unfounded claim gets made.
#:
#: `reidSwap` is M3', the better-posed form of re-id: instead of dragging a target onto a
#: distant body (a geometric penalty of tens of units against a re-id term whose whole
#: range is about one unit times its weight), it EXCHANGES the two targets'
#: (trackId, prototype) pairs and leaves the geometry alone. The formulation is sound; its
#: input is not. A smoke test on 20250905_165151 put the mean cost of keeping the labels
#: at 9.646 mm against 9.294 mm for exchanging them — no separation — and note the test is
#: BIASED toward exchanging, since the exchange cost is a Hungarian minimum and is
#: therefore always <= the diagonal. At margin 1.0 it fired 109 times in 60,000 frames,
#: which is oscillation, not repair; at margin 3.0 it fired 0 times.
#:
#: `gateAdj` refuses a match whose adjacency is below a floor instead of letting the
#: forced Hungarian take it, and lets the target coast. With `maxTargets` = 2 and two
#: targets already alive, `_initializeTargets` returns immediately, so a refused detection
#: is simply dropped — the risk is that this buys identity purity with coverage, and 8c
#: says there is only 0.003 of coverage headroom to spend.
ROUND8 = [
    ("reidswap_dist25", {"method": dict({"reidSwap": True, "reidSwapFrames": 300,
                                         "reidSwapMargin": 3.0},
                                        **dict(REID, reidWarm=1000, reidFreeze=2000)),
                         "thresholds": {"distanceThreshold": 25}},
     "M3': prototype-driven identity EXCHANGE rather than re-assignment"),
    ("sync_gate0_dist25", {"method": {"sync": True, "gateAdj": 0},
                           "thresholds": {"distanceThreshold": 25}},
     "refuse matches with negative adjacency and let the target coast"),
]


def _as_params(ov):
    """Normalise a config's overrides into the driver's --params shape.

    Rounds 1-2 wrote a bare method dict; rounds 3+ need `thresholds` too, because a
    method has to be judged against Fig 8's best THRESHOLD setting and not only against
    the shipped default. Both spellings are accepted so the earlier cached cells stay
    valid and are not silently re-run under a different meaning.
    """
    if any(k in ov for k in ("method", "thresholds", "nodeWeights")):
        return {"method": ov.get("method", {}),
                "thresholds": ov.get("thresholds", {})}
    return {"method": ov, "thresholds": {}}


def config_map():
    return {name: (ov, why) for (name, ov, why) in CONFIGS + ROUND3 + ROUND4 + ROUND5 + ROUND6 + ROUND7 + ROUND8}



def _compare(cells_by_name):
    """Attach each cell's per-session comparison against the `shipped` control.

    This is the unit a change to the shipped tracker has to be argued in: a pooled mean
    can be carried by one session, and this repo has been burned by exactly that (see
    figs/README.md and fig8_param_sweeps.per_session). `worst_cross_idf1_delta` is the
    one to read first -- two of the eight sessions are already at their oracle ceiling,
    so a method that gains on the mean by damaging those is not a candidate.

    Takes the MERGED cell map rather than one run's rows, so a partial run
    (`--configs sync_ambig100`) is still compared against the control from the existing
    deposit instead of silently emitting no comparison at all.
    """
    ctrl = cells_by_name.get("shipped")
    if not ctrl or not ctrl.get("per_session"):
        print("[fig8m] no `shipped` control in the deposit -- vs_shipped not computed",
              flush=True)
        return
    base = {p["session"]: p for p in ctrl["per_session"]}
    for name, r in cells_by_name.items():
        if name == "shipped" or not r.get("per_session"):
            continue
        ps = [p for p in r["per_session"] if p["session"] in base]
        if not ps:
            continue
        r["vs_shipped"] = {
            "sessions_fewer_switches": sum(
                1 for p in ps if p["within_switches"] < base[p["session"]]["within_switches"]),
            "sessions_more_switches": sum(
                1 for p in ps if p["within_switches"] > base[p["session"]]["within_switches"]),
            "sessions_higher_cross_idf1": sum(
                1 for p in ps if p["cross_idf1"] > base[p["session"]]["cross_idf1"] + 1e-9),
            "sessions_lower_cross_idf1": sum(
                1 for p in ps if p["cross_idf1"] < base[p["session"]]["cross_idf1"] - 1e-9),
            "worst_cross_idf1_delta": min(
                (p["cross_idf1"] - base[p["session"]]["cross_idf1"] for p in ps),
                default=None),
            "worst_switch_delta": max(
                (p["within_switches"] - base[p["session"]]["within_switches"]
                 for p in ps), default=None),
        }



def _link_shipped():
    """Symlink Fig 8's default cell in as the `shipped` control (8 x ~34 MB)."""
    d = TMP_DIR / "shipped"
    d.mkdir(parents=True, exist_ok=True)
    n = 0
    for s in f3.SESSIONS:
        src, dst = SHIPPED_SRC / f"{s}.json", d / f"{s}.json"
        if dst.exists() or dst.is_symlink():
            continue
        if not src.exists():
            print(f"[fig8m] shipped control: {src} missing -- will be tracked fresh")
            continue
        dst.symlink_to(src)
        n += 1
    print(f"[fig8m] shipped control: linked {n} session results from {SHIPPED_SRC}")


def run_one(cell, overrides, session):
    """Track one (config, session) with the experimental driver. Restartable."""
    cell_dir = TMP_DIR / cell
    cell_dir.mkdir(parents=True, exist_ok=True)
    out_path = cell_dir / f"{session}.json"
    if out_path.exists() and out_path.stat().st_size > 100:
        return (session, "ok", str(out_path))

    calib = f3.calib_for(session)
    if not calib:
        return (session, "failed", f"no calibration.toml for {session}")
    det_dir = f3.DET / session
    if not det_dir.exists():
        return (session, "failed", f"no det_h5 dir {det_dir}")

    params_path = cell_dir / "params.json"
    params_path.write_text(json.dumps(_as_params(overrides)))

    cmd = [
        "node", str(DRIVER),
        "--session-idx", "0", "--num-animals", str(f3.NUM_ANIMALS),
        "--calibration", calib,
        "--pred-h5-dir", str(det_dir),
        "--out", str(out_path),
        "--cameras", ",".join(f3.CAMERAS),
        "--params", str(params_path),
    ]
    try:
        r = subprocess.run(cmd, capture_output=True, text=True, timeout=7200)
        if r.returncode != 0 or not out_path.exists():
            return (session, "failed",
                    f"driver exit {r.returncode}: " + r.stderr[-500:].replace("\n", " "))
        return (session, "ok", str(out_path))
    except subprocess.TimeoutExpired:
        return (session, "failed", "driver timed out")
    except Exception as e:  # noqa: BLE001
        return (session, "failed", str(e))


def score_one(cell, session):
    """Score one (config, session) and digest its identities+frames payload."""
    result_path = TMP_DIR / cell / f"{session}.json"
    if not result_path.exists():
        return (session, "failed", "no result JSON (driver run failed)", None)
    import fig3_score as fs  # noqa: E402
    try:
        s = fs.score_session(str(result_path), str(f3.DET / session),
                             str(f3.GT / session), f3.CAMERAS, f3.NUM_ANIMALS,
                             max_frames=None)
        return (session, "ok", s, f8.payload_digest(result_path))
    except Exception as e:  # noqa: BLE001
        return (session, "failed", str(e), None)


def method_stats(cell):
    """Sum the tracker's own methodStats over sessions (bundles, re-id flips, ...)."""
    agg = {}
    for s in f3.SESSIONS:
        p = TMP_DIR / cell / f"{s}.json"
        if not p.exists():
            continue
        try:
            d = json.loads(p.read_text()).get("methodStats") or {}
        except Exception:  # noqa: BLE001
            continue
        for k, v in d.items():
            if isinstance(v, (int, float)):
                agg[k] = agg.get(k, 0) + v
    return agg


def verify():
    """Prove the experimental fork reproduces the shipped tracker bit for bit.

    Tracks all 8 FULL sessions through fig8_bench.mjs + xv_experimental.js with an
    EMPTY method block, and compares the SHA-256 of the tracker's identities+frames
    payload against Fig 8's default cell (the real pose/cross-view-tracker.js, driven
    by fig3_bench.mjs). This is the claim that makes every number below meaningful: a
    difference in any row is a difference the METHOD made, not a difference the fork
    made. It is the same payload_digest() Fig 8 used to prove five thresholds inert.
    """
    print(f"[fig8m] verify: tracking {len(f3.SESSIONS)} full sessions with an empty "
          f"method block", flush=True)
    t0 = time.time()
    with ProcessPoolExecutor(max_workers=min(WORKERS, len(f3.SESSIONS))) as ex:
        futs = {ex.submit(run_one, "verify_shipped", {"method": {}}, s): s
                for s in f3.SESSIONS}
        for fut in as_completed(futs):
            session, status, info = fut.result()
            if status != "ok":
                print(f"[fig8m] verify FAILED {session}: {info}", flush=True)

    ok, rows = True, []
    for s in f3.SESSIONS:
        mine = TMP_DIR / "verify_shipped" / f"{s}.json"
        theirs = SHIPPED_SRC / f"{s}.json"
        a = f8.payload_digest(mine) if mine.exists() else None
        b = f8.payload_digest(theirs) if theirs.exists() else None
        same = a is not None and a == b
        ok = ok and same
        rows.append({"session": s, "experimental_digest": a, "shipped_digest": b,
                     "identical": bool(same)})
        print(f"[fig8m] {s}: {'IDENTICAL' if same else 'DIFFERS'}  "
              f"exp={str(a)[:16]} shipped={str(b)[:16]}", flush=True)

    dest = OUT_DIR / "fig8_methods_verify.json"
    dest.write_text(json.dumps({
        "generated_by": "figs/fig8_methods.py --verify",
        "claim": "figs/fig8-bench/xv_experimental.js with an EMPTY method block "
                 "reproduces pose/cross-view-tracker.js exactly -- the SHA-256 of the "
                 "tracker's identities+frames payload matches Fig 8's default cell on "
                 "all 8 full sessions. Without this, no method row below can be "
                 "attributed to the method rather than to the fork.",
        "all_identical": bool(ok), "sessions": rows,
        "seconds": round(time.time() - t0, 1),
    }, indent=2))
    print(f"[fig8m] verify: all_identical={ok} ({time.time()-t0:.0f}s) -> {dest}",
          flush=True)
    return 0 if ok else 1


def use_all_bmimica_sessions():
    """Re-point this module at EVERY proofread BMimica session, not Fig 3e's eight.

    The eight-session subset is what makes Fig 8a-8d comparable to Fig 3e, and it is also
    the whole weakness of Fig 8d: this repo's own history records that Fig 4 over all 50
    sessions REVERSED a conclusion drawn from a subset. A method that moves the shipped
    tracker has to survive the full corpus.

    A session qualifies when it has detections, proofread ground truth AND a calibration
    for all five cameras -- checked rather than assumed, so a partially-prepared session
    cannot silently shrink a camera and change the denominator.

    Writes to its OWN cache and deposit (`tmp/fig8m50/`, `fig8_methods_50.json`). Keeping
    it separate is not tidiness: `switches` is a raw sum and its camera-frame denominator
    is different here, so mixing 50-session and 8-session cells in one file would produce
    rates that silently are not comparable.
    """
    global TMP_DIR, DEPOSIT, SHIPPED_SRC
    from glob import glob as _glob
    det, gt = f3.DET, f3.GT
    sessions = []
    for s in sorted(os.listdir(det)):
        if not (det / s).is_dir() or not (gt / s).is_dir():
            continue
        if not _glob(str(BMROOT_CAL(s))):
            continue
        if all((det / s / f"{c}_predictions.h5").exists()
               and (gt / s / c / "proofread.analysis.h5").exists() for c in f3.CAMERAS):
            sessions.append(s)
    f3.SESSIONS = sessions
    TMP_DIR = OUT_DIR / "tmp" / "fig8m50"
    DEPOSIT = OUT_DIR / "fig8_methods_50.json"
    # The 8-session `shipped` cell cannot be symlinked in for 50 sessions; track it.
    SHIPPED_SRC = OUT_DIR / "tmp" / "_nonexistent_so_shipped_is_tracked"
    print(f"[fig8m] ALL-SESSIONS mode: {len(sessions)} BMimica sessions, cache "
          f"{TMP_DIR.name}, deposit {DEPOSIT.name}", flush=True)
    return sessions


def BMROOT_CAL(session):
    return Path("/root/vast/eric/BMimica") / session / "calibration" / "*_calibration.toml"


def _recheck_one(name, overrides, sess):
    """Re-track one (cell, session) into a scratch cell and digest-compare. See recheck().

    Module level, not nested inside `recheck`, because ProcessPoolExecutor pickles the
    callable by qualified name and a closure is unpicklable ("Can't get local object").
    """
    scratch = f"_recheck__{name}"
    p = TMP_DIR / scratch / f"{sess}.json"
    if p.exists():
        p.unlink()
    _s, status, info = run_one(scratch, overrides, sess)
    if status != "ok":
        return name, None, info
    return name, (f8.payload_digest(p)
                  == f8.payload_digest(TMP_DIR / name / f"{sess}.json")), None


def recheck(names, session=None, workers=None):
    """Do the CACHED cells still reproduce under the current tracker code?

    `run_one` early-returns on an existing result JSON, which is what makes the sweep
    restartable and is also its one real hazard: cells tracked hours and many edits ago
    are compared against cells tracked just now, and nothing in the deposit would notice
    if an edit had quietly changed an older cell's meaning. Rounds of this sweep added
    `motionBase`, `_ambigCams`/`_retriangulate(exclude)`, `robustTrim`, `anchorSmooth` and
    `probeAge` AFTER some cells were already cached — each supposedly inert with its flag
    off, which is exactly the sort of "supposedly" that should be measured.

    So: re-track ONE session per cell with today's code into a scratch cell, and compare
    the SHA-256 of the identities+frames payload against what is cached. Same digest as
    `--verify` uses. One session per cell rather than all eight because this is a
    tripwire, not a re-run; a real difference shows up on any session that exercises the
    method at all.

    DIFFERS on any cell means the deposit mixes code versions and the affected cells must
    be deleted from figs/out/tmp/fig8m/ and re-tracked before the numbers are used.
    """
    cmap = config_map()
    bad = []
    sess = session or f3.SESSIONS[4]      # 20250904_131913: oldest anchor, most sensitive
    jobs = [n for n in names
            if n in cmap and (TMP_DIR / n / f"{sess}.json").exists()]
    skipped = [n for n in names if n not in jobs]
    if skipped:
        print(f"[fig8m] recheck: {len(skipped)} cell(s) not cached for {sess}, skipped: "
              f"{', '.join(skipped)}", flush=True)
    print(f"[fig8m] recheck: {len(jobs)} cached cells on {sess}", flush=True)

    with ProcessPoolExecutor(max_workers=workers or min(WORKERS, len(jobs) or 1)) as ex:
        futs = [ex.submit(_recheck_one, n, cmap[n][0], sess) for n in jobs]
        for fut in as_completed(futs):
            name, same, err = fut.result()
            if err:
                print(f"[fig8m] recheck {name}: FAILED {err}", flush=True)
                bad.append(name)
            elif not same:
                print(f"[fig8m] recheck {name}: DIFFERS -- cached under older code",
                      flush=True)
                bad.append(name)
            else:
                print(f"[fig8m] recheck {name}: ok", flush=True)

    dest = OUT_DIR / "fig8_methods_recheck.json"
    dest.write_text(json.dumps({
        "generated_by": "figs/fig8_methods.py --recheck",
        "claim": "Every cached cell listed here re-tracks to a byte-identical "
                 "identities+frames payload under the tracker code as it stands now, so "
                 "the deposit does not mix code versions across rounds.",
        "session": sess, "checked": jobs, "not_cached": skipped,
        "mismatched": bad, "all_reproduce": not bad,
    }, indent=2))
    print(f"[fig8m] recheck: all_reproduce={not bad} -> {dest}", flush=True)
    return 1 if bad else 0


def reaggregate():
    """Recompute the per-session comparison over the existing deposit. No re-scoring.

    A partial run (`--configs a,b`) has no `shipped` row of its own, so its cells land
    in the deposit without `vs_shipped`. Scoring a cell is minutes of motmetrics over
    5 cameras x ~180k frames; the comparison is arithmetic over numbers already in the
    file. Also refreshes `method_stats` and the switch rate, and re-orders the cells.
    """
    path = DEPOSIT
    if not path.exists():
        raise SystemExit(f"{path} does not exist -- nothing to re-aggregate")
    out = json.loads(path.read_text())
    keep = {c["config"]: c for c in out.get("cells", [])}
    total_cf = out.get("total_camera_frames")
    for name, c in keep.items():
        c["method_stats"] = method_stats(name)
        if c.get("switches") is not None and total_cf:
            c["switches_per_100k_camera_frames"] = c["switches"] * 100_000 / total_cf
    _compare(keep)
    allcfg = CONFIGS + ROUND3 + ROUND4 + ROUND5 + ROUND6 + ROUND7 + ROUND8
    ordered = [keep[n] for (n, _o, _w) in allcfg if n in keep]
    ordered += [v for k, v in keep.items() if k not in {c[0] for c in allcfg}]
    out["cells"] = ordered
    path.write_text(json.dumps(out, indent=2))
    print(f"[fig8m] re-aggregated {len(ordered)} cells in {path}")
    return 0


def main(names):
    t0 = time.time()
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    _link_shipped()

    cmap = config_map()
    unknown = [n for n in names if n not in cmap]
    if unknown:
        raise SystemExit(f"unknown config(s): {unknown}; have {list(cmap)}")

    jobs = [(n, cmap[n][0], s) for n in names for s in f3.SESSIONS]
    print(f"[fig8m] {len(names)} configs x {len(f3.SESSIONS)} sessions = {len(jobs)} "
          f"driver runs, {WORKERS} workers", flush=True)

    run_status = {}
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(run_one, c, m, s): (c, s) for (c, m, s) in jobs}
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            session, status, info = fut.result()
            run_status[key] = (status, info)
            done += 1
            if done % 5 == 0 or done == len(jobs):
                print(f"[fig8m] driver runs {done}/{len(jobs)} "
                      f"({time.time()-t0:.0f}s)", flush=True)
            if status != "ok":
                print(f"[fig8m] FAILED cell={key[0]} session={session}: {info}",
                      flush=True)

    score_status, digests = {}, {}
    with ProcessPoolExecutor(max_workers=WORKERS) as ex:
        futs = {ex.submit(score_one, c, s): (c, s)
                for (c, _m, s) in jobs if run_status[(c, s)][0] == "ok"}
        done = 0
        for fut in as_completed(futs):
            key = futs[fut]
            session, status, info, dig = fut.result()
            score_status[key] = (status, info)
            digests[key] = dig
            done += 1
            if done % 5 == 0 or done == len(futs):
                print(f"[fig8m] scored {done}/{len(futs)} ({time.time()-t0:.0f}s)",
                      flush=True)
            if status != "ok":
                print(f"[fig8m] SCORE-FAILED cell={key[0]} session={session}: {info}",
                      flush=True)

    import fig3_score as fs  # noqa: E402

    total_cf, cf_by_session = f3.camera_frames()
    rows = []
    for n in names:
        ov, why = cmap[n]
        per, whyfail = [], []
        for s in f3.SESSIONS:
            if run_status[(n, s)][0] != "ok":
                whyfail.append(f"{s}: driver failed: {run_status[(n, s)][1]}")
                continue
            st, info = score_status.get((n, s), ("failed", "not scored"))
            if st != "ok":
                whyfail.append(f"{s}: scoring failed: {info}")
                continue
            per.append(info)
        agg = fs.score_cell(per) if per else None
        row = {
            "config": n, "overrides": ov, "params": _as_params(ov), "why": why,
            "status": "ok" if agg else "failed", "failures": "; ".join(whyfail),
            "per_session": [
                {"session": s,
                 "within_switches": i["within_switches"],
                 "cross_switches": i["cross_switches"],
                 "within_idf1": i["within_idf1"],
                 "cross_idf1": i["cross_idf1"],
                 # identity precision/recall -- the pair whose harmonic mean is IDF1
                 "within_idp": i.get("within_idp"), "within_idr": i.get("within_idr"),
                 "cross_idp": i.get("cross_idp"), "cross_idr": i.get("cross_idr")}
                for s, i in zip(
                    [s for s in f3.SESSIONS if score_status.get((n, s), ("", ))[0] == "ok"],
                    per)
            ],
            "method_stats": method_stats(n),
        }
        row.update(agg or {"idf1_within": None, "idf1_cross": None,
                           "switches": None, "n_sessions": 0})
        if row["switches"] is not None:
            row["switches_per_100k_camera_frames"] = \
                row["switches"] * 100_000 / total_cf
        rows.append(row)
        print(f"[fig8m] {n}: switches={row['switches']} "
              f"cross={row['idf1_cross']} within={row['idf1_within']}", flush=True)

    path = DEPOSIT
    prev = json.loads(path.read_text()) if path.exists() else {}
    keep = {r["config"]: r for r in prev.get("cells", []) if r["config"] not in names}
    for r in rows:
        keep[r["config"]] = r
    _compare(keep)
    allcfg = CONFIGS + ROUND3 + ROUND4 + ROUND5 + ROUND6 + ROUND7 + ROUND8
    ordered = [keep[n] for (n, _o, _w) in allcfg if n in keep]
    ordered += [v for k, v in keep.items() if k not in {c[0] for c in allcfg}]

    out = {
        "generated_by": "figs/fig8_methods.py",
        "status": "EXPLORATORY -- algorithmic methods for the cross-view tracker, "
                  "measured on Fig 8's measurement. Not placed in any manuscript "
                  "figure.",
        "dataset": "BMimica",
        "detection_pool": str(f3.DET),
        "sessions": f3.SESSIONS,
        "cameras": f3.CAMERAS,
        "num_animals": f3.NUM_ANIMALS,
        "metric": "IDF1 (motmetrics) + ID-switches",
        "total_camera_frames": total_cf,
        "camera_frames_by_session": cf_by_session,
        "driver": str(DRIVER),
        "experimental_tracker": str(REPO / "figs" / "fig8-bench" / "xv_experimental.js"),
        "caveats": [
            "Every cell/session is tracked and scored on the FULL session -- every "
            "frame, no window -- exactly as fig3_sweep.py and fig8_param_sweeps.py "
            "were, so these rates are directly comparable to Fig 3e's and Fig 8's.",
            f3.CF_CAVEAT,
            "The `shipped` control is Fig 8's default cell, reused by symlink: the "
            "real pose/cross-view-tracker.js on these same 8 full sessions. It is a "
            "measurement in this pass, not a number copied from another file.",
            "figs/out/fig8_methods_verify.json proves the experimental fork with an "
            "EMPTY method block is byte-identical to the shipped tracker on all 8 "
            "full sessions (SHA-256 of the identities+frames payload). Any difference "
            "in a row below is therefore the method's, not the fork's.",
            "No app source is modified. figs/fig8-bench/hooks8.mjs serves "
            "figs/fig8-bench/xv_experimental.js in place of pose/cross-view-tracker.js "
            "through an ESM loader hook; pose/triangulation.js and pose/pose-data.js "
            "load real and unmodified.",
            "IDF1's cell-to-cell noise on Fig 3e's grid is about 0.05, so an IDF1 "
            "difference below that should not be read as a ranking on its own. "
            "vs_shipped counts per-session wins/losses, which is the unit that "
            "licenses a change; worst_cross_idf1_delta / worst_switch_delta are the "
            "worst harm on any single session.",
            "The re-id descriptor is the vector of pairwise 3D inter-keypoint "
            "distances over matching-weighted nodes. It is a property of the animal's "
            "body, so it is only meaningful where the 3D is sane; `reidMaxDesc` "
            "discards it where it is not.",
        ],
        "cells": ordered,
    }
    path.write_text(json.dumps(out, indent=2))
    print(f"[fig8m] wrote {path} ({time.time()-t0:.0f}s total)", flush=True)


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--verify", action="store_true")
    ap.add_argument("--all-sessions", action="store_true",
                    help="run over EVERY proofread BMimica session (50) instead of Fig "
                         "3e's 8, into tmp/fig8m50/ + fig8_methods_50.json")
    ap.add_argument("--recheck", action="store_true",
                    help="re-track one session per CACHED cell with today's code and "
                         "compare digests -- a tripwire against the restartable cache "
                         "silently mixing tracker code versions across rounds")
    ap.add_argument("--reaggregate", action="store_true",
                    help="recompute vs_shipped over the existing deposit and re-order "
                         "the cells, without re-tracking or re-scoring anything "
                         "(scoring a cell costs minutes; the comparison costs none)")
    ap.add_argument("--configs", default=None,
                    help="comma-separated subset of CONFIGS names")
    a = ap.parse_args()
    if a.all_sessions:
        use_all_bmimica_sessions()
    if a.verify:
        raise SystemExit(verify())
    if a.reaggregate:
        raise SystemExit(reaggregate())
    if a.recheck:
        names = (a.configs.split(",") if a.configs
                 else [c["config"] for c in json.loads(
                     (OUT_DIR / "fig8_methods.json").read_text()).get("cells", [])])
        raise SystemExit(recheck([n for n in names if n != "shipped"]))
    names = (a.configs.split(",") if a.configs
             else [c[0] for c in CONFIGS + ROUND3 + ROUND4 + ROUND5 + ROUND6 + ROUND7 + ROUND8])
    main(names)
