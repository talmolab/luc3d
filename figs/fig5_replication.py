"""
Unit of replication for the Figure 4 paired comparisons (panels D and E).

THE PROBLEM THIS SOLVES (2026-09-20). The first version of panels D and E ran a paired
Wilcoxon test over the 538 displays with both animals resolved, which treats every
display as an independent observation. They are not: the displays come from 37
sessions of 9 mice in 18 pairings, and one female contributes 305 of the 539. A test
over displays reports P = 3.3e-73 from nine animals, which no experiment on nine
animals can support. The Statistics section already names the session as the unit of
analysis throughout, and panel F already tests at that level; D and E did not.

WHAT IS DONE INSTEAD. Every display-level feature is reduced to one value per animal
per session (the median over that session's displays) and the paired test runs across
sessions. The same reduction is then repeated with the pair as the unit (the same
animals recorded on several days are one observation) and with the animal as the unit
(each mouse's median over every display it took part in, males and females compared
unpaired), so a reader can see the effect at each level. The box on the panel is drawn
over the session values, so the box, the caption and the test describe the same n.

Used by figs/panels/fig5_09_upright_velocity.py and fig5_07_upright_stats.py.
"""
import numpy as np
import pandas as pd
from scipy import stats

#: Sessions need one display to contribute a median. Pairs use the same floor as the
#: pair-level leader analysis in the text (five displays, 14 pairs).
MIN_PAIR_DISPLAYS = 5
#: Panel F's floor, reported alongside for a like-for-like check.
MIN_SESSION_DISPLAYS_F = 6


def attach_identity(ev: pd.DataFrame, per_session: list) -> pd.DataFrame:
    """Add male_id, female_id and pair to the event table. Slot 0 is male and slot 1
    female in every Mouse-Dyad-10M session (fig5_upright.py's corpus-wide check)."""
    ids = {r["session"]: (r["per_track"][0]["animal"], r["per_track"][1]["animal"])
           for r in per_session}
    ev = ev.copy()
    ev["male_id"] = ev["session"].map(lambda s: ids[s][0])
    ev["female_id"] = ev["session"].map(lambda s: ids[s][1])
    ev["pair"] = ev["male_id"] + "|" + ev["female_id"]
    return ev


def by_unit(ev: pd.DataFrame, col_m: str, col_f: str, unit: str) -> pd.DataFrame:
    """One row per unit: display count and the median of each animal's values."""
    e = ev[np.isfinite(ev[col_m]) & np.isfinite(ev[col_f])]
    keys = {"session": ["session", "male_id", "female_id", "pair"],
            "pair": ["pair", "male_id", "female_id"]}[unit]
    g = e.groupby(keys, as_index=False).agg(n_displays=(col_m, "size"),
                                            male_median=(col_m, "median"),
                                            female_median=(col_f, "median"))
    return g


def per_animal(ev: pd.DataFrame, col_m: str, col_f: str):
    """Each mouse's median over every display it took part in."""
    e = ev[np.isfinite(ev[col_m]) & np.isfinite(ev[col_f])]
    males = e.groupby("male_id")[col_m].agg(["median", "size"])
    females = e.groupby("female_id")[col_f].agg(["median", "size"])
    return males, females


def tests(ev: pd.DataFrame, col_m: str, col_f: str, male_direction: str) -> dict:
    """Paired Wilcoxon across sessions and across pairs, unpaired across animals.

    male_direction is 'greater' when the claim is that the male value is higher
    (speed) and 'less' when it is lower (pursuit score, negative is approaching).
    The tests themselves are two-sided; the direction only sets the win count."""
    sign = 1 if male_direction == "greater" else -1
    out = {}
    s = by_unit(ev, col_m, col_f, "session")
    for label, tab in (("session", s),
                       (f"session_ge{MIN_SESSION_DISPLAYS_F}",
                        s[s.n_displays >= MIN_SESSION_DISPLAYS_F]),
                       ("pair", by_unit(ev, col_m, col_f, "pair")
                        .query(f"n_displays >= {MIN_PAIR_DISPLAYS}"))):
        d = tab.male_median.to_numpy() - tab.female_median.to_numpy()
        out[label] = dict(n=len(tab), male_favoured=int((sign * d > 0).sum()),
                          wilcoxon_p=float(stats.wilcoxon(d).pvalue),
                          male_median=float(tab.male_median.median()),
                          female_median=float(tab.female_median.median()))
    males, females = per_animal(ev, col_m, col_f)
    u = stats.mannwhitneyu(males["median"], females["median"], alternative="two-sided")
    out["animal"] = dict(n_male=len(males), n_female=len(females),
                         male_medians=males["median"].round(3).tolist(),
                         female_medians=females["median"].round(3).tolist(),
                         displays_per_male=males["size"].tolist(),
                         displays_per_female=females["size"].tolist(),
                         mannwhitney_p=float(u.pvalue))
    return out


def summary_rows(t: dict) -> pd.DataFrame:
    """The test results as rows that append to a per-session deposit, in the same
    style as fig5f_leader_by_session.csv's POOLED_* rows."""
    rows = []
    for k in ("session", f"session_ge{MIN_SESSION_DISPLAYS_F}", "pair"):
        r = t[k]
        rows.append({"session": f"TEST_{k.upper()}", "n_displays": r["n"],
                     "male_median": r["male_median"], "female_median": r["female_median"],
                     "male_favoured": r["male_favoured"], "wilcoxon_p": r["wilcoxon_p"]})
    a = t["animal"]
    rows.append({"session": "TEST_ANIMAL_UNPAIRED", "n_displays": a["n_male"] + a["n_female"],
                 "male_median": float(np.median(a["male_medians"])),
                 "female_median": float(np.median(a["female_medians"])),
                 "wilcoxon_p": a["mannwhitney_p"]})
    return pd.DataFrame(rows)


def overlay_points(ax, x, vals, color, *, rng=None, width=0.16, size=7, alpha=0.6):
    """One dot per session on top of its box, deterministic jitter, so the panel shows
    the n it is tested on rather than describing it."""
    rng = rng or np.random.default_rng(0)
    xs = x + rng.uniform(-width, width, size=len(vals))
    ax.scatter(xs, vals, s=size, color="white", edgecolor=color, linewidth=0.5,
               alpha=alpha, zorder=4, clip_on=False)


def stars(p):
    return "***" if p < 1e-3 else ("**" if p < 1e-2 else ("*" if p < 0.05 else "n.s."))


def report(name, t):
    print(f"  {name}:")
    for k in ("session", f"session_ge{MIN_SESSION_DISPLAYS_F}", "pair"):
        r = t[k]
        print(f"    per {k:11s} n={r['n']:2d}  male favoured {r['male_favoured']}/{r['n']}  "
              f"Wilcoxon P={r['wilcoxon_p']:.2g}  medians m={r['male_median']:.3f} "
              f"f={r['female_median']:.3f}")
    a = t["animal"]
    print(f"    per animal   males {a['male_medians']} females {a['female_medians']}  "
          f"Mann-Whitney P={a['mannwhitney_p']:.3g}  displays/animal "
          f"m={a['displays_per_male']} f={a['displays_per_female']}")
