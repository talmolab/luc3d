#!/usr/bin/env python3
"""SCRATCH: four candidate replacements for Fig 5f, drawn side by side to choose from.

Not a panel and not wired into any figure. Writes figs/out/_fig5f_options.png.
Underscore-prefixed like the other investigation tools in this tree.

The claim all four make is the same one 5f makes now: within a session, one animal
starts most of the mutual upright displays. What differs is how each handles the
fact that the CURRENT panel's y quantity, max(k, n-k)/n, cannot fall below 0.5 by
construction, which is why it needs a simulated null band rather than a line at
chance.

    python3 figs/_fig5f_options.py
"""
import collections
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.data_loader import OUT, load  # noqa: E402
from src.style import INK, MUTED, mm, use  # noqa: E402

CI = "#8DA0CB"      # the leader
CF = "#D9DCE6"      # the follower
CN = "#B3B3B3"      # the null
MIN_DISPLAYS = 6    # smallest session a two-sided binomial can call at all


def build():
    d = load("fig5_upright.json")
    ses = d["per_session"]
    ev = d["events"]

    # per session: n displays and the larger of the two initiation counts
    share = {s["session"]: (s["n_events"],
                            max(t["n_lead"] for t in s["per_track"]))
             for s in ses}

    # split half: label the animal by who leads the FIRST half, score the SECOND
    by = collections.defaultdict(list)
    for e in ev:
        by[e["session"]].append((e["start_frame"], e["initiator_track"]))
    half = []
    for s, lst in by.items():
        lst.sort()
        n = len(lst)
        if n < 4:
            continue
        h = n // 2
        first, second = [t for _, t in lst[:h]], [t for _, t in lst[h:]]
        lead1 = collections.Counter(first).most_common(1)[0][0]
        half.append(second.count(lead1) / len(second))

    # pairs: the leading animal in each session, grouped by the pair recorded
    pair_of, lead_animal = {}, {}
    for s in ses:
        pair_of[s["session"]] = tuple(sorted(a["animal"] for a in s["per_track"]))
        tr = s["per_track"]
        if max(a["n_lead"] for a in tr):
            lead_animal[s["session"]] = max(tr, key=lambda a: a["n_lead"])["animal"]
    byp = collections.defaultdict(list)
    for sess, p in pair_of.items():
        if sess in lead_animal:
            byp[p].append((sess, lead_animal[sess]))
    return share, np.array(half), byp


def null_draw(ns, seed=0, n=40000):
    """Pooled fair-coin distribution of max(k, n-k)/n at these session sizes."""
    rng = np.random.default_rng(seed)
    out = []
    for m in ns:
        x = rng.binomial(m, 0.5, n)
        out.append(np.maximum(x, m - x) / m)
    return np.concatenate(out)


def opt1_splithalf(ax, half):
    """Split-half consistency. Chance is a genuine 0.5, so no null band."""
    ok = int((half > 0.5).sum())
    p = stats.binomtest(ok, len(half), 0.5, alternative="greater").pvalue
    ax.hist(half, bins=np.linspace(0, 1, 11), color=CI, lw=0)
    ax.axvline(0.5, color=INK, lw=1.0, ls="--")
    ax.set_xlabel("second half started by the first half's leader")
    ax.set_ylabel("sessions")
    ax.set_xlim(0, 1)
    ax.text(0.02, 0.97, f"{ok} of {len(half)} sessions keep the same leader\n"
                        f"across the two halves  (P = {p:.0e})",
            transform=ax.transAxes, va="top", ha="left", fontsize=6.0,
            color=INK, fontweight="bold", linespacing=1.35)
    ax.text(0.02, 0.74, "chance is a true 0.5 here, so no\nsimulated null is needed",
            transform=ax.transAxes, va="top", ha="left", fontsize=5.6, color=MUTED,
            linespacing=1.3)


def opt2_bars(ax, share):
    """One stacked bar per session, sorted. Every session, no dots."""
    rows = sorted((n, k) for n, k in share.values())
    frac = [k / n for n, k in rows]
    y = np.arange(len(frac))
    ax.barh(y, frac, color=CI, lw=0, height=0.9)
    ax.barh(y, [1 - f for f in frac], left=frac, color=CF, lw=0, height=0.9)
    ax.axvline(0.5, color=INK, lw=1.0, ls="--")
    ax.set_xlim(0, 1)
    ax.set_ylim(-0.6, len(frac) - 0.4)
    ax.set_yticks([])
    ax.set_xlabel("share of displays started, by session")
    ax.set_ylabel(f"{len(frac)} sessions, smallest first")
    ax.text(0.02, 0.97, "every session, leader against follower",
            transform=ax.transAxes, va="top", ha="left", fontsize=6.0,
            color=INK, fontweight="bold")
    ax.text(0.02, 0.90, "all bars clear 0.5 BY CONSTRUCTION,\nso the null still needs saying",
            transform=ax.transAxes, va="top", ha="left", fontsize=5.6, color=MUTED,
            linespacing=1.3)


def opt3_pairs(ax, byp):
    """The pair as the unit of replication, across separate recordings."""
    multi = {p: v for p, v in byp.items() if len(v) >= 2}
    consistent = [len(set(a for _, a in v)) == 1 for v in multi.values()]
    ok = sum(consistent)
    p = stats.binomtest(ok, len(multi), 0.5, alternative="greater").pvalue
    order = np.argsort([len(v) for v in multi.values()])[::-1]
    vals = [len(list(multi.values())[i]) for i in order]
    cons = [consistent[i] for i in order]
    y = np.arange(len(vals))
    ax.barh(y, vals, color=[CI if c else CN for c in cons], lw=0, height=0.75)
    ax.set_yticks([])
    ax.set_xlabel("recordings of that pair")
    ax.set_ylabel(f"{len(vals)} pairs recorded more than once")
    ax.set_xticks(range(0, max(vals) + 1))
    ax.text(0.03, 0.97, f"{ok} of {len(multi)} pairs keep the same leader\n"
                        f"in every recording  (P = {p:.2f})",
            transform=ax.transAxes, va="top", ha="left", fontsize=6.0,
            color=INK, fontweight="bold", linespacing=1.35)
    ax.text(0.03, 0.74, "blue, same leader throughout\ngrey, the leader changed",
            transform=ax.transAxes, va="top", ha="left", fontsize=5.6, color=MUTED,
            linespacing=1.3)


def opt4_dist(ax, share):
    """Observed leader share against the pooled fair-coin distribution."""
    big = [(n, k) for n, k in share.values() if n >= MIN_DISPLAYS]
    obs = np.array([k / n for n, k in big])
    nul = null_draw([n for n, _ in big])
    bins = np.linspace(0.5, 1.0, 12)
    ax.hist(nul, bins=bins, weights=np.full(len(nul), len(obs) / len(nul)),
            color=CN, alpha=0.55, lw=0, label="fair coin")
    ax.hist(obs, bins=bins, histtype="step", color=CI, lw=1.6, label="observed")
    ax.set_xlabel("share of displays started by the leader")
    ax.set_ylabel("sessions")
    ax.set_xlim(0.5, 1.0)
    ax.text(0.03, 0.97, f"median {np.median(obs):.2f} against a fair coin's "
                        f"{np.median(nul):.2f}",
            transform=ax.transAxes, va="top", ha="left", fontsize=6.0,
            color=INK, fontweight="bold")
    ax.text(0.03, 0.90, f"{len(obs)} sessions with {MIN_DISPLAYS} or more displays;\n"
                        "grey, what a coin gives at those same sizes",
            transform=ax.transAxes, va="top", ha="left", fontsize=5.6, color=MUTED,
            linespacing=1.3)


def main():
    use()
    share, half, byp = build()
    fig, axes = plt.subplots(2, 2, figsize=(mm(180), mm(120)), layout="constrained")
    for ax, (fn, arg, title) in zip(axes.ravel(), [
            (opt1_splithalf, half, "Option 1  ·  split-half consistency"),
            (opt2_bars, share, "Option 2  ·  one stacked bar per session"),
            (opt3_pairs, byp, "Option 3  ·  the pair as the unit"),
            (opt4_dist, share, "Option 4  ·  distribution against the null")]):
        fn(ax, arg)
        ax.set_title(title, fontsize=7.5, color=INK, fontweight="bold", loc="left")
        for s in ("top", "right"):
            ax.spines[s].set_visible(False)
    out = OUT / "_fig5f_options.png"
    fig.savefig(out, dpi=300)
    print("wrote", out)


if __name__ == "__main__":
    main()
