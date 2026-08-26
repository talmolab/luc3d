#!/usr/bin/env python
"""Fig 7a's baselines at their BEST honest configuration, in one deposit.

    ############################################################################
    WHY THIS DEPOSIT EXISTS. Fig 7a compares LUC3D against two per-camera
    trackers that were run in configurations WE chose and that guarantee the
    fragmentation the panel then charges them for, while LUC3D's arm is
    constrained to 2 global identities by construction:

    * SLEAP was tracked with `--tracking_target_instance_count 2`, which caps
      instances PER FRAME, not tracks -- median 47.5 tracks per camera-session.
      Re-run with the real cap (`--max_tracks 2 --candidates_method
      local_queues`), verified at exactly 2 tracks on all 250 camera-sessions.
    * ByteTrack was tracked with `lost_track_buffer = 60` FRAMES on 180,200-frame
      sessions, so any occlusion over two seconds retired the track -- median 437
      ids per session. Re-run never-retiring, and again with a 2-identity
      constraint (its own knob has no track cap).

    Both re-runs are the reviewer-proof form of the comparison, and both move
    AGAINST us within view. They do not touch the panel's actual claim, which is
    the within->cross RETENTION -- and that gets slightly WORSE for both
    baselines, because a higher within-view score has further to fall when the
    cameras are pooled.

    Eric, 2026-08-13: "that's fine if it moves against us because we still win
    the cross-view."
    ############################################################################

WHAT IT DOES NOT DO. It does not rewrite `figs/out/fig3_trackers.json`, the
manuscript deposit -- same rule as the Fig 7 b-g substitution. It writes its own
file and the panel reads it.

CAMERA-SCOPED, NOT UNSCOPED, and with two enforced tracks that matters more than
it used to: `track_0` now exists in all five cameras, so unscoped pooling would
hand a per-camera tracker large free cross-view identity through shared slot
numbering alone (ITEM6 section 6's 0.469 artefact). Both cross-view columns here
are the camera-scoped convention Fig 7a already uses; SLEAP's unscoped column is
carried alongside, unplotted, so the size of that artefact stays visible.

    $PY figs/fig6_fair_baselines.py

Output: figs/out/fig7_fair_baselines.json
"""
import json
from pathlib import Path

import numpy as np

OUT = Path(__file__).resolve().parent / "out"
SLEAP = OUT / "fig7_sleap_max2.json"
BYTE = OUT / "fig7_bytetrack_max2.json"
#: The ByteTrack arm to plot. B1s = never-retire + the 2-identity stitch: the closest
#: honest analogue of SLEAP's `--max_tracks 2`, since supervision's ByteTrack has no
#: track cap of its own. B1 (its own knob alone) is carried too, because B1 is
#: unmodified ByteTrack and B1s is ByteTrack plus post-processing OF OURS -- a
#: distinction the artwork has to keep.
BYTE_ARM = "B1s"


def main():
    sl = json.loads(SLEAP.read_text())
    by = json.loads(BYTE.read_text())

    s_rows = {r["session"]: r for r in sl["per_session"]}
    b_rows = {r["session"]: r for r in by["per_session"]}
    common = sorted(set(s_rows) & set(b_rows))
    if len(common) != 50:
        print(f"[fair] WARNING: {len(common)} sessions in both runs, not 50 -- the "
              f"arms must be compared on the SAME sessions, so the deposit records "
              f"this list and any panel must use it")

    def ci95(v, n_boot=10000):
        """Percentile bootstrap of the mean over sessions, seeded so the deposit is
        reproducible. This is THIS script's bootstrap, not the reference generator's --
        same kind of interval, resampled here because the fair arms were scored by a
        different pass. Fig 7a draws it as the arms' error bars, so it must exist for
        every arm the panel plots or the panel raises rather than drawing a bar it
        cannot justify."""
        rng = np.random.default_rng(20260814)
        idx = rng.integers(0, v.size, size=(n_boot, v.size))
        means = v[idx].mean(axis=1)
        return float(np.percentile(means, 2.5)), float(np.percentile(means, 97.5))

    def arm(vals_within, vals_cross, **extra):
        w, c = np.asarray(vals_within, float), np.asarray(vals_cross, float)
        w_lo, w_hi = ci95(w)
        c_lo, c_hi = ci95(c)
        return {"within": {"mean": float(w.mean()), "median": float(np.median(w)),
                           "ci95_lo": w_lo, "ci95_hi": w_hi,
                           "min": float(w.min()), "max": float(w.max()),
                           "n_sessions": int(w.size)},
                "cross": {"mean": float(c.mean()), "median": float(np.median(c)),
                          "ci95_lo": c_lo, "ci95_hi": c_hi,
                          "min": float(c.min()), "max": float(c.max()),
                          "n_sessions": int(c.size)},
                "retention_cross_over_within": float(c.mean() / w.mean()),
                "per_session_within": [float(v) for v in w],
                "per_session_cross": [float(v) for v in c],
                **extra}

    out = {
        "generated_by": "figs/fig6_fair_baselines.py",
        "claim": "The two per-camera baselines of Fig 7a, re-run with the same "
                 "2-identity constraint LUC3D's arm has by construction, on the same "
                 "50 BMimica sessions and the same shared detections.",
        "pooling_convention": "camera-scoped (ci-keyed hypothesis ids), as Fig 7a",
        "sessions": common,
        "sources": {"sleap": str(SLEAP.name), "bytetrack": str(BYTE.name),
                    "bytetrack_arm": BYTE_ARM},
        "arms": {
            "SLEAP per-camera (2 tracks enforced)": arm(
                [s_rows[s]["within_idf1"] for s in common],
                [s_rows[s]["cross_idf1_scoped"] for s in common],
                switches_2d_total=sum(s_rows[s]["within_switches"] for s in common),
                config="sleap-nn 0.3.0, --max_tracks 2 --candidates_method "
                       "local_queues --tracking_clean_instance_count 2; all other "
                       "flags identical to the shipped baseline run",
                cap_verified="exactly 2 tracks on all 250 camera-sessions",
                cross_unscoped_mean=float(np.mean(
                    [s_rows[s]["cross_idf1_unscoped"] for s in common])),
                unscoped_note="unscoped pooling would report this instead; it is an "
                              "artefact of two enforced tracks sharing slot numbers "
                              "across cameras, not cross-view identity the tracker "
                              "earned. NOT plotted."),
            f"ByteTrack (2 identities, {BYTE_ARM})": arm(
                [b_rows[s][f"arm_{BYTE_ARM}"]["within_idf1"] for s in common],
                [b_rows[s][f"arm_{BYTE_ARM}"]["cross_idf1_scoped"] for s in common],
                switches_2d_total=sum(b_rows[s][f"arm_{BYTE_ARM}"]["within_sw"]
                                      for s in common),
                config="supervision 0.30.0, lost_track_buffer = n_frames "
                       "(never retire) plus a tracklet-whole 2-identity stitch that "
                       "uses NO ground truth; all other parameters identical to the "
                       "shipped run",
                labelling_rule="the stitch is OURS. Arm B1 (0.2718 within) is "
                               "unmodified ByteTrack at its own best setting; this "
                               "arm is ByteTrack PLUS our post-processing, and the "
                               "artwork must say which."),
            "ByteTrack (own knob only, B1)": arm(
                [b_rows[s]["arm_B1"]["within_idf1"] for s in common],
                [b_rows[s]["arm_B1"]["cross_idf1_scoped"] for s in common],
                switches_2d_total=sum(b_rows[s]["arm_B1"]["within_sw"]
                                      for s in common),
                config="supervision 0.30.0, lost_track_buffer = n_frames only"),
        },
        "gates": {
            "sleap_cap": "figs/fig6_sleap_max2_retrack.py --verify: 250/250 "
                         "camera-sessions at <= 2 tracks",
            "bytetrack_scorer": "re-scoring the SHIPPED ByteTrack arm through this "
                                "scorer reproduces bmimica_crossview_all_eval.csv to "
                                "max |diff| 0.000e+00 on both within and cross, 50 "
                                "sessions",
            "bytetrack_library_drift": "re-running one camera-session at the SHIPPED "
                                       "parameters under supervision 0.30.0 "
                                       "reproduces the stored May array cell for "
                                       "cell (max abs diff 0.0 over 4,321,296 cells)",
        },
        "what_this_costs_us": "Within view the LUC3D lead falls from ~5x to ~1.1x. "
                              "The within->cross retention -- the panel's actual "
                              "claim -- is unaffected and moves slightly in our "
                              "favour: both baselines retain ~0.23 of their "
                              "within-view score across cameras, against LUC3D's "
                              "1.00.",
    }
    (OUT / "fig7_fair_baselines.json").write_text(json.dumps(out, indent=1))

    print(f"[fair] {len(common)} sessions")
    for name, a in out["arms"].items():
        print(f"  {name:42s} within {a['within']['mean']:.4f}  cross "
              f"{a['cross']['mean']:.4f}  retention "
              f"{a['retention_cross_over_within']:.3f}  switches "
              f"{a['switches_2d_total']:,}")
    print(f"[fair] wrote {OUT / 'fig7_fair_baselines.json'}")


if __name__ == "__main__":
    main()
