#!/usr/bin/env python3
"""
Fig 5f -- one animal starts most of the displays, against a size-matched null.

THE CLAIM. Within a session one animal starts most of the mutual upright displays.
Pooled over all 539 displays in 37 sessions, the session's leader starts 432 of
them, 80.1%. That number is stable against every reasonable inclusion rule --
79.8% over sessions with at least 3 displays, 79.6% at 5, 79.8% at 8, 79.0% at 10 --
so it is not an artefact of which sessions are counted.

TWO BOXES, NOT A FUNNEL OF DOTS (Eric, 2026-08-19: "option 5 is good, but get rid of
all the colliding text ... just put two stars above them"). The panel used to plot
each session's leader share against its display count, with a simulated null band
behind it. That form had to be read rather than seen, for a reason inherent to the
quantity: "the leader's share" is max(share_0, share_1), which CANNOT fall below 0.5
however the two animals behave, so it could not be plotted against a line at chance
and needed a per-size curve instead. Comparing the observed distribution with a
size-matched surrogate says the same thing in a shape a reader already knows.

THE SURROGATE IS SIZE-MATCHED, which is the whole point. Each replicate keeps every
session's OWN display count and only relabels who started each one, drawing from
Binomial(n, 0.5) and taking max(k, n-k)/n exactly as the observed statistic does. So
the grey box is not a generic coin at 0.5: it is what THIS corpus would look like if
initiation were random, floor and small-session inflation included, which is why its
median sits at 0.57 rather than at 0.50.

THE P VALUE IS A PERMUTATION BOUND, not a parametric test. `NREP` surrogate corpora
are drawn and none reaches the observed median, so the statement is P < 1/NREP. With
NREP = 2000 that is P < 0.0005. Raising NREP tightens the bound and nothing else.

STAR CONVENTION. `STARS` is drawn as given and is currently two. Note the usual
convention (Nature journals among them) is * P<0.05, ** P<0.01, *** P<0.001, under
which a bound of P < 0.0005 would take THREE. Two is what was asked for; change the
constant if the convention should win.

n = 23 sessions with at least MIN_DISPLAYS displays. Six, not five: under a fair coin
the 95th percentile of the larger share is 1.0 for every n up to and including 5,
because a clean 5/5 sweep still has probability 2/32 = 0.0625, and the two-sided
binomial test agrees, its best attainable P at n = 5 being 0.0625. A five-display
session therefore cannot register at all, and exactly one session in the corpus has
five displays.

Source: figs/out/fig5_upright.json `per_session[].{n_events,per_track[].n_lead}`
        (figs/fig5_upright.py).

    python3 figs/panels/fig5_10_leader.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, deposit, panel, save, use  # noqa: E402

CI = "#8DA0CB"      # observed
CN = "#B3B3B3"      # the size-matched fair-coin surrogate
MIN_DISPLAYS = 6
NREP = 2000         # surrogate corpora; the P bound is 1/NREP
STARS = "**"        # see STAR CONVENTION in the docstring


def surrogate(sizes, seed=0, reps=NREP):
    """(reps, n_sessions) leader shares under a fair coin at the SAME session sizes."""
    rng = np.random.default_rng(seed)
    out = np.empty((reps, len(sizes)))
    for j, n in enumerate(sizes):
        x = rng.binomial(n, 0.5, reps)
        out[:, j] = np.maximum(x, n - x) / n
    return out


def main():
    use()
    d = load("fig5_upright.json")
    rows = []
    for r in d["per_session"]:
        n = r["n_events"]
        led = max(t["n_lead"] for t in r["per_track"])
        rows.append({"session": r["session"], "displays": n,
                     "started_by_leader": led, "leader_share": led / n})
    df = pd.DataFrame(rows).sort_values("displays")

    big = df[df["displays"] >= MIN_DISPLAYS]
    obs = big["leader_share"].to_numpy()
    sizes = big["displays"].to_numpy()
    sur = surrogate(sizes)
    # one-sided permutation bound: how often a surrogate corpus reaches the observed
    # median. None does, so the printed statement is a bound rather than an estimate.
    hits = int((np.median(sur, axis=1) >= np.median(obs)).sum())
    pooled = df["started_by_leader"].sum() / df["displays"].sum()

    deposit(pd.concat([df, pd.DataFrame([
        {"session": "POOLED_ALL_SESSIONS", "n": len(df),
         "displays": int(df.displays.sum()),
         "started_by_leader": int(df.started_by_leader.sum()),
         "leader_share": pooled},
        {"session": f"OBSERVED_MEDIAN_ge{MIN_DISPLAYS}", "n": len(obs),
         "leader_share": float(np.median(obs))},
        {"session": f"SURROGATE_MEDIAN_ge{MIN_DISPLAYS}", "n": NREP,
         "leader_share": float(np.median(sur))},
    ])], ignore_index=True), 5, "fig5f_leader_by_session.csv")
    print(f"  pooled {pooled:.4f} ({int(df.started_by_leader.sum())}/{int(df.displays.sum())}); "
          f"median {np.median(obs):.3f} vs surrogate {np.median(sur):.3f}; "
          f"{hits}/{NREP} surrogates reach it -> P < {1/NREP:g}")

    # THIRD, not half. Two boxes in an 88 mm slot sat in the middle of a wide empty
    # axes; the content here is nearly square, so it belongs in the narrow slot and
    # the coupling panel beside it takes the width back (fig5_12_coupling is now
    # two-thirds, and 57.3 + 117.3 + the 4 mm gutter is the page). Swapping this
    # panel with c was the alternative and was rejected: it would put "the same
    # animal leads all session" before "one animal is up first", which is backwards.
    fig, ax = panel("third", "short")
    for x, data, col in ((0, obs, CI), (1, sur.ravel(), CN)):
        ax.boxplot(data, positions=[x], widths=0.52, patch_artist=True,
                   showfliers=False,
                   medianprops=dict(color="white", lw=1.4),
                   whiskerprops=dict(color=col, lw=1.0),
                   capprops=dict(color=col, lw=1.0),
                   boxprops=dict(facecolor=col, edgecolor=col, lw=0.8))
    # chance for a SINGLE animal, drawn as the floor the statistic cannot cross. It is
    # not the null for this statistic -- that is the grey box -- so it is thin and grey.
    ax.axhline(0.5, color=INK, lw=0.7, ls="--", alpha=0.55, zorder=1)

    # THE SIGNIFICANCE BRACKET IS THE ONLY MARK-UP ON THE PANEL. Everything the old
    # version wrote inside the axes (medians, n, the null's definition) is caption
    # text and now lives there; in-axes notes were colliding with the boxes.
    top = max(obs.max(), np.percentile(sur, 99.5))
    y = top + 0.055
    ax.plot([0, 0, 1, 1], [y - 0.018, y, y, y - 0.018], color=INK, lw=0.9,
            solid_joinstyle="miter", clip_on=False)
    ax.text(0.5, y + 0.008, STARS, ha="center", va="bottom", color=INK,
            fontsize=8.5, fontweight="bold", clip_on=False)

    ax.set_xticks([0, 1])
    ax.set_xticklabels(["observed", "fair-coin\nsurrogate"])
    ax.set_xlim(-0.62, 1.62)
    ax.set_ylim(0.46, y + 0.075)
    ax.set_yticks([0.5, 0.75, 1.0])
    # Two lines: the single-line form was ~30 mm of type against a 57 mm panel and
    # the figure clipped its last character.
    ax.set_ylabel("share of displays\nstarted by the leader")
    save(fig, 5, "f", "leader")


if __name__ == "__main__":
    main()
