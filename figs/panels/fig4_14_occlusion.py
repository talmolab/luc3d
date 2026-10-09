#!/usr/bin/env python3
"""
Fig 4b (the 2026-10-07 Fig 4b variant) -- occlusion: keypoints that no rig can
triangulate, because they are seen by 0 cameras or by exactly 1.

REPLACES the difficulty x cameras heat-map (`fig4_12_recovery_surface.py`) in the
variant composite. Eric, 2026-10-07: "fraction of keypoints present in one or fewer
cameras (cannot be triangulated) ... there are a lot of occlusions, there is one case
where we cant triangulate at all". A first draft paired this with a per-rig-size
missing-keypoint plot and drew this half as stacked bars; Eric asked for this half
alone, as a line plot, with s.e.m. error bars (between sessions, n = 4 to 13 per
stratum). The per-rig-size residuals (`missing_k2..6_pct`) are still deposited, and
k = 2 is checked against the per-view miss rate on every build.

WHAT "SEEN" MEANS follows FIG_VARIANT. Under `proofread` (the variant this panel was
built for) it is the proofreaders' per-camera 2D labels, so the panel measures
occlusion as a human judged it, not detector quality. Under no variant it is the raw
keeptrack pool. `*_notail` drops TailTip and Tail_0-2. The proofread 3D itself is
complete (finite in every frame of all 74 sessions), so "missing" here is always a
missing 2D view, never a missing 3D point.

Source: figs/out/fig4_recovery_proofread2d.json (per-node (g, m) histograms; the
pool-specific file is picked from FIG_VARIANT below).

    FIG_TAG=b FIG_VARIANT=proofread figs/.venv/bin/python figs/panels/fig4_14_occlusion.py
"""
import os
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import AMBER, INK, VIOLET, deposit, panel, save, use  # noqa: E402
from fig4_recovery import surface_from_hist  # noqa: E402

KS = (2, 3, 4, 5, 6)
#: TailTip, Tail_0, Tail_1, Tail_2 (fig4_detections / build_predslp_pool's TAIL)
TAIL = [4, 7, 8, 9]
#: the per-node (g, m) deposit for each pool. These do not follow data_loader's
#: `<stem>_<variant>` naming, so the map is explicit.
PERNODE = {"": "fig4_recovery_pernode.json",
           "proofread": "fig4_recovery_proofread2d.json",
           "predslp": "fig4_recovery_predslp_pernode.json"}


def build():
    # default = proofread labels, tail excluded (the former Fig 4c, base since 2026-10-09)
    v = os.environ.get("FIG_VARIANT") or "proofread_notail"
    base = v.replace("_notail", "")
    if base not in PERNODE:
        sys.exit(f"fig4c occlusion: no per-node deposit for FIG_VARIANT={v!r} "
                 f"(have {sorted(PERNODE)})")
    j = load(PERNODE[base], variant=False)
    print(f"  pool: {PERNODE[base]}{' (tail nodes dropped)' if 'notail' in v else ''}")
    rows = []
    for sid, h in j["histograms"].items():
        d = j["difficulty"].get(sid)
        if d is None:
            continue
        a = np.array(h["hist"], dtype=np.int64)              # (N, g, m)
        if "notail" in v:
            a = np.delete(a, TAIL, axis=0)
        a = a.sum(axis=0)
        n = a.sum()
        surf = surface_from_hist(a, ks=KS)
        rows.append({"session": sid, "difficulty": int(d), "n_keypoints": int(n),
                     "seen_0_pct": 100.0 * a[:, 0].sum() / n,
                     "seen_1_pct": 100.0 * a[:, 1].sum() / n,
                     **{f"missing_k{k}_pct": surf[k]["residual_missing_pct"]
                        for k in KS}})
    df = pd.DataFrame(rows)
    df["seen_le1_pct"] = df.seen_0_pct + df.seen_1_pct
    return df


def main():
    use()
    per = build()
    agg = per.drop(columns="session").groupby("difficulty").agg(["mean", "std", "count"])
    agg.columns = [f"{a}_{b}" for a, b in agg.columns]
    agg = agg.reset_index()
    deposit(per.sort_values(["difficulty", "session"]), 4, "fig4b_occlusion_sessions.csv")
    deposit(agg, 4, "fig4b_occlusion.csv")

    # k = 2 must equal 4e's per-view miss rate (same histograms, same sessions).
    _v = os.environ.get("FIG_VARIANT") or "proofread_notail"
    bd = load(f"fig6_detections_{_v}.json", variant=False)["by_difficulty"]
    for _, r in agg.iterrows():
        e = bd[str(int(r.difficulty))]["miss_rate"] * 100
        if abs(e - r.missing_k2_pct_mean) > 0.05:
            print(f"  WARNING d{int(r.difficulty)}: k=2 {r.missing_k2_pct_mean:.2f}% "
                  f"!= 4e miss rate {e:.2f}% -- deposits out of step")

    # ONE line plot (Eric, 2026-10-07: "i dont like the two panes for C ... make it a
    # line plot ... maybe SEM not ST DEV ... get rid of C left"). The rig-size lines
    # are gone from the artwork but stay in the deposit (missing_k*_pct).
    fig, ax = panel("third", "std")
    x = agg.difficulty.to_numpy()
    # Two HUES, not two greys (Eric, 2026-10-07: "they need to be different colors").
    # Camera count is a quantity, not an entity, so any non-entity hue is allowed
    # (see the rule above ENTITY in src/style.py). VIOLET vs AMBER also differ in
    # lightness, and the markers differ, so the pair survives greyscale print.
    for col, lab, c, mk in (("seen_0_pct", "0 cameras", VIOLET, "o"),
                            ("seen_1_pct", "1 camera", AMBER, "D")):
        y = agg[f"{col}_mean"].to_numpy()
        sem = (agg[f"{col}_std"] / np.sqrt(agg[f"{col}_count"])).fillna(0).to_numpy()
        ax.errorbar(x, y, yerr=sem, fmt="none", ecolor=c, elinewidth=0.7,
                    capsize=1.4, capthick=0.7, zorder=2)
        ax.plot(x, y, color=c, lw=1.6, zorder=3)
        ax.plot(x, y, mk, color=c, ms=3.6 if mk == "o" else 3.2, mec="white",
                mew=0.7, zorder=4)
    # direct labels in the empty upper-left, in each line's own colour
    ax.text(0.04, 0.97, "0 cameras", transform=ax.transAxes, va="top",
            color=VIOLET, fontsize=6.5, fontweight="bold")
    ax.text(0.04, 0.87, "1 camera", transform=ax.transAxes, va="top",
            color=AMBER, fontsize=6.5, fontweight="bold")
    ax.text(0.04, 0.77, "mean ± s.e.m.", transform=ax.transAxes, va="top",
            color=INK, fontsize=6.0)
    ax.set_xticks(x)
    ax.set_xlabel("difficulty rating")
    ax.set_ylabel("keypoints seen by\n0 or 1 camera (%)")
    ax.set_ylim(0, None)

    print("  [note, not drawn] ±1 s.e.m. between sessions · n = "
          + ", ".join(str(int(n)) for n in agg.n_keypoints_count)
          + " sessions at difficulty 1–7")
    for _, r in agg.iterrows():
        print(f"  d{int(r.difficulty)}: k2 {r.missing_k2_pct_mean:.1f}  k6 "
              f"{r.missing_k6_pct_mean:.1f}  seen0 {r.seen_0_pct_mean:.1f}  "
              f"seen1 {r.seen_1_pct_mean:.1f}")
    save(fig, 4, "b", "occlusion")


if __name__ == "__main__":
    main()
