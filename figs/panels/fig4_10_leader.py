#!/usr/bin/env python3
"""
Fig 5f -- female initiates displays.

THE CLAIM, REVISED 2026-08-21. This panel used to report that "one animal starts
most displays" without saying which one, because track slot looked like an arbitrary
per-session label. Eric then pointed out it is not: Mouse-Dyad-10M's track slot 0 is
always male and slot 1 always female, verified against every session's track_names
(6 animal IDs seen only at slot 0, 9 only at slot 1, zero in both, across all 56
sessions). Once the female's own share of each session's displays is read out
directly (not `max(share_0, share_1)`, which cannot say who), the result sharpens
from "there is a leader" to "the leader is female": female starts 432 of 539 displays
pooled (80.1%) and leads outright in 36 of the 37 sessions with at least one display.
The one exception is an exact tie (2-2, n=4, below MIN_DISPLAYS). Zero sessions have
the male as the outright leader.

NOT A BODY-SIZE ARTEFACT. Male is the structurally LONGER animal here (median body
length 90.1 vs 84.2 mm, male longer in 29/37 sessions, paired Wilcoxon P<0.0001) --
so the smaller-bodied sex is the one leading, which rules out "the bigger animal
wins" as the explanation.

TWO BOXES ARE HER SHARE AND HIS SHARE, NOT A NULL (revised again, same day). This
used to compare the female's share against a size-matched fair-coin surrogate
(Binomial(n, 0.5)/n at each session's own display count) -- a legitimate null, but
one more box to explain, and the two REAL numbers (her share, his share) already say
the same thing more directly: they are complementary (male_share = 1 - female_share
within a session), so putting both on the panel shows the asymmetry as two real
distributions rather than one real distribution against a simulation.

STATS: paired Wilcoxon signed-rank, female share vs male share, on the 23 sessions
with >= MIN_DISPLAYS displays (mathematically the same test as female share vs 0.5,
since the two shares sum to 1 within a session). Restricting to >= 6 displays is the
same choice the surrogate-comparison version made and for the same reason: under a
fair coin the 95th percentile of the larger share is 1.0 for every n up to and
including 5 (a clean 5/5 sweep still has probability 2/32 = 0.0625), so a
five-display session cannot register at all, and exactly one session in the corpus
has five displays.

STAR CONVENTION. `STARS` is drawn as given -- currently mapped from the Wilcoxon P
by the usual convention (Nature journals among them): * P<0.05, ** P<0.01,
*** P<0.001.

Source: figs/out/fig5_upright.json `per_session[].{n_events,per_track[].n_lead,
per_track[].L_mm}` (figs/fig4_upright.py). per_track[0] is male, per_track[1] female
(see the corpus-wide track-slot check above).

    python3 figs/panels/fig5_10_leader.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import INK, deposit, panel, save, use  # noqa: E402

CFEM = "#D6604D"     # female -- matches every other fig5 panel
CM = "#4393C3"       # male
MIN_DISPLAYS = 6


def main():
    use()
    d = load("fig5_upright.json")
    rows = []
    for r in d["per_session"]:
        male, female = r["per_track"]
        n = r["n_events"]
        rows.append({"session": r["session"], "displays": n,
                     "male_id": male["animal"], "female_id": female["animal"],
                     "male_lead": male["n_lead"], "female_lead": female["n_lead"],
                     "female_share": female["n_lead"] / n, "male_share": male["n_lead"] / n,
                     "L_male_mm": male["L_mm"], "L_female_mm": female["L_mm"]})
    df = pd.DataFrame(rows).sort_values("displays")

    n_female_leader = int((df.female_lead > df.male_lead).sum())
    n_male_leader = int((df.male_lead > df.female_lead).sum())
    n_tie = int((df.male_lead == df.female_lead).sum())

    big = df[df["displays"] >= MIN_DISPLAYS]
    obs_f = big["female_share"].to_numpy()
    obs_m = big["male_share"].to_numpy()
    w = stats.wilcoxon(obs_f - obs_m)
    pooled = df["female_lead"].sum() / df["displays"].sum()

    # NOT A SIZE ARTEFACT: male is structurally longer, not female.
    L_male, L_female = df["L_male_mm"].to_numpy(), df["L_female_mm"].to_numpy()
    wsize = stats.wilcoxon(L_male, L_female)

    deposit(pd.concat([df, pd.DataFrame([
        {"session": "POOLED_ALL_SESSIONS", "displays": int(df.displays.sum()),
         "female_lead": int(df.female_lead.sum()), "female_share": pooled},
        {"session": "N_SESSIONS_FEMALE_LEADER", "displays": len(df),
         "female_share": n_female_leader / len(df)},
        {"session": f"OBSERVED_MEDIAN_ge{MIN_DISPLAYS}", "displays": len(obs_f),
         "female_share": float(np.median(obs_f)), "male_share": float(np.median(obs_m))},
        {"session": "BODY_LENGTH_MM_MEDIAN", "displays": len(df),
         "female_share": float(np.median(L_female)),
         "male_lead": float(np.median(L_male))},
    ])], ignore_index=True), 4, "fig4f_leader_by_session.csv")
    print(f"  female leads {n_female_leader}/{len(df)} sessions outright "
          f"(male {n_male_leader}, tie {n_tie})")
    print(f"  pooled female share {pooled:.4f} ({int(df.female_lead.sum())}/"
          f"{int(df.displays.sum())}); median female {np.median(obs_f):.3f} vs "
          f"male {np.median(obs_m):.3f}; paired Wilcoxon n={len(obs_f)} "
          f"P={w.pvalue:.3g}")
    print(f"  body length (mm): male {np.median(L_male):.1f}  female "
          f"{np.median(L_female):.1f}  (male longer in "
          f"{int((L_male > L_female).sum())}/{len(L_male)}, Wilcoxon "
          f"P={wsize.pvalue:.2g})")

    # THIRD, not half. Two boxes in an 88 mm slot sat in the middle of a wide empty
    # axes; the content here is nearly square, so it belongs in the narrow slot and
    # the coupling panel beside it takes the width back (fig5_12_coupling is now
    # two-thirds, and 57.3 + 117.3 + the 4 mm gutter is the page). Swapping this
    # panel with c was the alternative and was rejected: it would put "the same
    # animal leads all session" before "one animal is up first", which is backwards.
    fig, ax = panel("third", "short")
    for x, data, col in ((0, obs_f, CFEM), (1, obs_m, CM)):
        ax.boxplot(data, positions=[x], widths=0.52, patch_artist=True,
                   showfliers=False,
                   medianprops=dict(color="white", lw=1.4),
                   whiskerprops=dict(color=col, lw=1.0),
                   capprops=dict(color=col, lw=1.0),
                   boxprops=dict(facecolor=col, edgecolor=col, lw=0.8))
    # the two shares are complementary within a session, so 0.5 is where neither
    # sex leads -- not a null, just the midpoint the two real distributions split.
    ax.axhline(0.5, color=INK, lw=0.7, ls="--", alpha=0.55, zorder=1)

    # THE SIGNIFICANCE BRACKET IS THE ONLY MARK-UP ON THE PANEL. Everything the old
    # version wrote inside the axes (medians, n, the null's definition) is caption
    # text and now lives there; in-axes notes were colliding with the boxes.
    top = max(obs_f.max(), obs_m.max())
    y = top + 0.055
    ax.plot([0, 0, 1, 1], [y - 0.018, y, y, y - 0.018], color=INK, lw=0.9,
            solid_joinstyle="miter", clip_on=False)
    stars = "***" if w.pvalue < 1e-3 else ("**" if w.pvalue < 1e-2 else "*")
    ax.text(0.5, y + 0.008, stars, ha="center", va="bottom", color=INK,
            fontsize=8.5, fontweight="bold", clip_on=False)

    ax.set_xticks([0, 1])
    ax.set_xticklabels(["female share", "male share"])
    ax.set_xlim(-0.62, 1.62)
    ax.set_ylim(0.0, y + 0.075)
    ax.set_yticks([0.0, 0.25, 0.5, 0.75, 1.0])
    ax.set_ylabel("share of displays started")
    save(fig, 4, "f", "leader")


if __name__ == "__main__":
    main()
