#!/usr/bin/env python
"""FOLLOW-UP to Fig 4E, not a manuscript panel. What does the pursuit vector do
AFTER the display ends and both animals are back on the ground?

Fig 4E measures facing-pursuit in the 1.5 s BEFORE display onset and finds the male
oriented at the female and moving (median -0.71) while the female is neither
oriented at him nor approaching (-0.06). This asks the obvious next question. When
the rear is over, does the male keep pursuing, does he disengage, or does the
female now do the approaching?

    figs/.venv/bin/python figs/followup_pursuit_after_rear.py            # measure
    figs/.venv/bin/python figs/followup_pursuit_after_rear.py --plot     # draw

THE PURSUIT QUANTITY IS FIG 4E'S, RECOMPUTED HERE, NOT RE-INVENTED. For track a,
`facing_a` is the unit body axis (Nose -> TTI) and `away_a` the unit vector from
the partner to a; their dot product is negative when a's body axis points at its
partner, and it is scaled by a's own speed so that facing without moving scores
about zero. `fig4_upright.session_upright` computes exactly this and deposits its
median over a 1.5 s pre-onset window as `pursuit_rel_t0` / `pursuit_rel_t1`.

    THE MIRROR IS VALIDATED, NOT ASSUMED. This script recomputes the series and
    then reproduces the deposited pre-onset medians for every event it shares with
    figs/out/fig5_upright.json. If that check fails it refuses to write, because a
    post-offset number is only trustworthy if the same code reproduces the
    published pre-onset one. Keep this file in step with
    `fig4_upright.session_upright` -- it mirrors that function's geometry block.

SIGN CONVENTION, throughout: NEGATIVE means oriented at the partner while moving,
i.e. pursuit. POSITIVE means oriented away while moving.

Output: figs/out/followup_pursuit_after_rear.json
        figs/data/followup/pursuit_after_rear.csv
        figs/figures/followups/pursuit_after_rear.pdf/.png
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys
from pathlib import Path

import numpy as np

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE))

import fig4_upright as UP  # noqa: E402  (loader, constants and the detector's rules)

OUT_JSON = HERE / "out" / "followup_pursuit_after_rear.json"
CSV_DIR = HERE / "data" / "followup"
FIG_DIR = HERE / "figures" / "followups"

#: seconds either side of display OFFSET for the time course
WIN_S = 3.0
#: the post-offset window whose median is the headline number, matching Fig 4E's
#: 1.5 s pre-onset window so the two are directly comparable
POST_S = 1.5
#: a second, later window. The time course shows the female's orientation turning
#: only about a second after the animals are down, which the 1.5 s window straddles
#: and therefore averages away.
LATE_FROM_S, LATE_TO_S = 1.5, 3.0


def series(t, fps):
    """(pursuit, rear, sep, base_spd, L) mirroring fig4_upright.session_upright.

    Returns None when the session is not a resolvable dyad, exactly as the source
    function does.
    """
    F, A = t.shape[0], t.shape[1]
    if A != 2:
        return None
    nose, tti = t[:, :, UP.NOSE, :], t[:, :, UP.TTI, :]
    neck = t[:, :, UP.NECK, :]
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)
    if not np.all(np.isfinite(L)) or np.any(L <= 0):
        return None
    Lm = float(np.mean(L))

    sw = max(1, int(round(UP.SPEED_WIN_S * fps)))
    spd = np.full((F, 2), np.nan)
    k = np.ones(sw) / sw
    for a in range(2):
        d = np.linalg.norm(np.diff(tti[:, a, :2], axis=0), axis=-1) / Lm * fps
        spd[1:, a] = np.convolve(d, k, mode="same")
    base_spd = np.nanmedian(spd, axis=0)

    sep_vec = tti[:, 0, :2] - tti[:, 1, :2]
    sep_norm = np.linalg.norm(sep_vec, axis=-1)
    sep_unit = sep_vec / np.where(sep_norm[:, None] > 0, sep_norm[:, None], np.nan)
    facing_vec = nose[:, :, :2] - tti[:, :, :2]
    facing_norm = np.linalg.norm(facing_vec, axis=-1)
    facing_unit = facing_vec / np.where(facing_norm[..., None] > 0,
                                        facing_norm[..., None], np.nan)
    pursuit = np.full((F, 2), np.nan)
    pursuit[:, 0] = np.einsum("ij,ij->i", facing_unit[:, 0, :], sep_unit) * spd[:, 0]
    pursuit[:, 1] = np.einsum("ij,ij->i", facing_unit[:, 1, :], -sep_unit) * spd[:, 1]

    rear = np.stack([neck[:, a, 2] / L[a] > UP.REAR_FRAC for a in range(2)], axis=1)
    sep = sep_norm / Lm
    return pursuit, rear, sep, base_spd, L


def session(sd):
    ld = UP._load(sd)
    if ld is None:
        return None
    t, fps, names, _code = ld
    s = series(t, fps)
    if s is None:
        return None
    pursuit, rear, sep, base_spd, _L = s
    if not np.all(np.isfinite(base_spd)) or np.any(base_spd <= 0):
        return None

    min_len = max(1, int(round(UP.MIN_EVENT_S * fps)))
    gap = int(round(UP.MERGE_GAP_S * fps))
    mask = rear[:, 0] & rear[:, 1] & np.isfinite(sep) & (sep <= UP.NEAR_BL)
    events = UP.runs(mask, min_len, gap)

    F = pursuit.shape[0]
    half = int(round(WIN_S * fps))
    post_n = int(round(POST_S * fps))
    late_a, late_b = int(round(LATE_FROM_S * fps)), int(round(LATE_TO_S * fps))
    pre_n = int(round(1.5 * fps))
    grid = np.arange(-half, half + 1)

    rows, curves = [], []
    for s_f, e_f in events:
        pre = slice(max(0, s_f - pre_n), s_f)
        post = slice(e_f, min(F, e_f + post_n))
        late = slice(min(F, e_f + late_a), min(F, e_f + late_b))
        if post.stop - post.start < post_n // 2:
            continue                      # not enough runway after the display
        r = {
            "session": os.path.basename(sd),
            "start_frame": int(s_f), "end_frame": int(e_f),
            "dur_s": float((e_f - s_f) / fps),
            # pre-onset, to VALIDATE against the deposit
            "pre_t0": float(np.nanmedian(pursuit[pre, 0]) / base_spd[0]),
            "pre_t1": float(np.nanmedian(pursuit[pre, 1]) / base_spd[1]),
            # post-offset, the new quantity
            "post_t0": float(np.nanmedian(pursuit[post, 0]) / base_spd[0]),
            "post_t1": float(np.nanmedian(pursuit[post, 1]) / base_spd[1]),
            "late_t0": float(np.nanmedian(pursuit[late, 0]) / base_spd[0]),
            "late_t1": float(np.nanmedian(pursuit[late, 1]) / base_spd[1]),
        }
        rows.append(r)
        # time course around OFFSET, normalised per animal exactly as above
        idx = e_f + grid
        ok = (idx >= 0) & (idx < F)
        c = np.full((len(grid), 2), np.nan)
        c[ok, 0] = pursuit[idx[ok], 0] / base_spd[0]
        c[ok, 1] = pursuit[idx[ok], 1] / base_spd[1]
        curves.append(c)

    if not rows:
        return None
    return {"session": os.path.basename(sd), "names": names, "fps": float(fps),
            "n_events": len(rows), "rows": rows,
            "curve": np.nanmedian(np.stack(curves), axis=0).tolist(),
            "grid_s": (grid / fps).tolist()}


def validate(rows):
    """Reproduce the published pre-onset medians. Refuse to proceed otherwise."""
    dep = json.loads((HERE / "out" / "fig5_upright.json").read_text())
    ref = {(e["session"], e["start_frame"]): e for e in dep["events"]}
    hits = miss = 0
    worst = 0.0
    for r in rows:
        k = (r["session"], r["start_frame"])
        if k not in ref:
            miss += 1
            continue
        for mine, theirs in (("pre_t0", "pursuit_rel_t0"), ("pre_t1", "pursuit_rel_t1")):
            a, b = r[mine], ref[k].get(theirs)
            if b is None or not np.isfinite(b):
                continue
            worst = max(worst, abs(a - b))
            hits += 1
    return hits, miss, worst


def measure():
    sds = sorted(d for d in glob.glob(os.path.join(UP.BMIMICA, "*"))
                 if os.path.isdir(d) and os.path.basename(d) != "scratch")
    out, rows = [], []
    for sd in sds:
        r = session(sd)
        if r is None:
            continue
        out.append(r)
        rows += r["rows"]
        print(f"  {r['session']}: {r['n_events']} displays", flush=True)

    hits, miss, worst = validate(rows)
    print(f"\nVALIDATION vs figs/out/fig5_upright.json: {hits} pre-onset values "
          f"compared, {miss} events not in the deposit, max |diff| {worst:.3e}")
    if hits == 0 or worst > 1e-9:
        sys.exit("REFUSING TO WRITE: this script does not reproduce the published "
                 "pre-onset pursuit medians, so its post-offset numbers cannot be "
                 "trusted. Re-sync it with fig4_upright.session_upright.")

    OUT_JSON.parent.mkdir(parents=True, exist_ok=True)
    OUT_JSON.write_text(json.dumps({
        "generated_by": "figs/followup_pursuit_after_rear.py",
        "claim": "Facing-pursuit after the mutual upright display ends, the "
                 "post-offset counterpart of Fig 4E's pre-onset window.",
        "sign": "negative = oriented at the partner while moving (pursuit)",
        "win_s": WIN_S, "post_s": POST_S,
        "validation": {"pre_onset_values_checked": hits,
                       "max_abs_diff_vs_deposit": worst},
        "sessions": out,
    }))
    print(f"wrote {OUT_JSON}")
    return out, rows


def plot():
    import pandas as pd
    import matplotlib.pyplot as plt
    sys.path.insert(0, str(HERE))
    from src.style import INK, MUTED, SALMON, TEAL, grid as sgrid, use

    d = json.loads(OUT_JSON.read_text())
    rows = [r for s in d["sessions"] for r in s["rows"]]
    df = pd.DataFrame(rows)
    CSV_DIR.mkdir(parents=True, exist_ok=True)
    df.to_csv(CSV_DIR / "pursuit_after_rear.csv", index=False)

    # per-session median curves -> across-session median and IQR
    gs = np.asarray(d["sessions"][0]["grid_s"])
    C = np.stack([np.asarray(s["curve"]) for s in d["sessions"]])   # (S, T, 2)
    med = np.nanmedian(C, axis=0)
    q1, q3 = np.nanpercentile(C, 25, axis=0), np.nanpercentile(C, 75, axis=0)

    use()
    fig, axes = sgrid(1, 3, span="full", row="std")
    MALE, FEMALE = TEAL, SALMON

    ax = axes[0]
    for a, (col, lab) in enumerate(((MALE, "male"), (FEMALE, "female"))):
        ax.fill_between(gs, q1[:, a], q3[:, a], color=col, alpha=0.18, lw=0)
        ax.plot(gs, med[:, a], color=col, lw=1.6, label=lab)
    ax.axhline(0, color=MUTED, lw=0.8, ls=(0, (1.5, 1.5)))
    ax.axvline(0, color=INK, lw=0.9, ls=(0, (3, 2)))
    ax.set_xlabel("time from display offset (s)")
    ax.set_ylabel("facing-pursuit\n(negative = toward partner)")
    ax.legend(frameon=False, fontsize=6, loc="lower right")

    ax = axes[1]
    post = [df.post_t0.to_numpy(float), df.post_t1.to_numpy(float)]
    bp = ax.boxplot(post, positions=[0, 1], widths=0.55, patch_artist=True,
                    showfliers=False, medianprops=dict(color="white", lw=1.2))
    for patch, col in zip(bp["boxes"], (MALE, FEMALE)):
        patch.set_facecolor(col); patch.set_alpha(0.75); patch.set_edgecolor(col)
    ax.axhline(0, color=MUTED, lw=0.8, ls=(0, (1.5, 1.5)))
    ax.set_xticks([0, 1]); ax.set_xticklabels(["male", "female"])
    ax.set_ylabel(f"pursuit, {POST_S:g}s after offset")

    ax = axes[2]
    for col, lab, cols in ((MALE, "male", ("pre_t0", "post_t0", "late_t0")),
                           (FEMALE, "female", ("pre_t1", "post_t1", "late_t1"))):
        y = [float(np.nanmedian(df[c].to_numpy(float))) for c in cols]
        ax.plot([0, 1, 2], y, color=col, marker="o", lw=1.6, ms=4.5,
                mec="white", mew=0.8, label=lab)
    ax.axhline(0, color=MUTED, lw=0.8, ls=(0, (1.5, 1.5)))
    ax.set_xticks([0, 1, 2])
    ax.set_xticklabels(["before\nonset", "0-1.5 s\nafter", "1.5-3 s\nafter"],
                       fontsize=6)
    ax.set_xlim(-0.35, 2.35)
    ax.set_ylabel("median facing-pursuit")
    ax.legend(frameon=False, fontsize=6, loc="best")

    FIG_DIR.mkdir(parents=True, exist_ok=True)
    for ext in ("pdf", "png"):
        fig.savefig(FIG_DIR / f"pursuit_after_rear.{ext}", dpi=300)
    plt.close(fig)
    print(f"wrote {FIG_DIR / 'pursuit_after_rear.pdf'} and .png")

    # the numbers, printed so they can be read without opening the figure
    from scipy.stats import wilcoxon
    # A handful of displays sit too close to a session boundary for a full
    # pre-onset window, so every paired test drops the pairs with a NaN on either
    # side rather than letting one propagate through the median.
    def paired(x, y):
        x, y = np.asarray(x, float), np.asarray(y, float)
        ok = np.isfinite(x) & np.isfinite(y)
        return x[ok], y[ok]

    for lab, pre, po in (("male", df.pre_t0, df.post_t0),
                         ("female", df.pre_t1, df.post_t1)):
        a, b = paired(pre, po)
        w = wilcoxon(a, b)
        print(f"  {lab:7s} pre {np.median(a):+.3f} -> post {np.median(b):+.3f}"
              f"   paired Wilcoxon P = {w.pvalue:.2e}   n = {len(a)}")
    a, b = paired(df.post_t0, df.post_t1)
    w = wilcoxon(a, b)
    print(f"  male vs female AFTER offset: {np.median(a):+.3f} against "
          f"{np.median(b):+.3f}, paired Wilcoxon P = {w.pvalue:.2e}, n = {len(a)}")
    a, b = paired(df.pre_t0, df.pre_t1)
    print(f"  (for reference, BEFORE onset: {np.median(a):+.3f} against "
          f"{np.median(b):+.3f}, n = {len(a)})")
    a, b = paired(df.late_t0, df.late_t1)
    w = wilcoxon(a, b)
    print(f"  male vs female 1.5-3 s AFTER: {np.median(a):+.3f} against "
          f"{np.median(b):+.3f}, paired Wilcoxon P = {w.pvalue:.2e}, n = {len(a)}")
    for lab, c in (("male", "late_t0"), ("female", "late_t1")):
        x = df[c].to_numpy(float); x = x[np.isfinite(x)]
        w = wilcoxon(x)
        print(f"  {lab:7s} 1.5-3 s after offset: {np.median(x):+.3f} "
              f"(vs zero, Wilcoxon P = {w.pvalue:.2e}, n = {len(x)})")


if __name__ == "__main__":
    ap = argparse.ArgumentParser()
    ap.add_argument("--plot", action="store_true", help="draw from the deposit")
    a = ap.parse_args()
    if a.plot:
        plot()
    else:
        measure()
        plot()
