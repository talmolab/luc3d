#!/usr/bin/env python3
"""SCRATCH round 2 for Fig 5f: box-and-whisker against a null surrogate, plus the
per-animal result that turned up while checking whether the data support it.

Writes figs/out/_fig5f_options2.png. Not wired into any figure.

    python3 figs/_fig5f_options2.py
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

CI = "#8DA0CB"      # observed
CN = "#B3B3B3"      # null surrogate
MIN_DISPLAYS = 6
NREP = 2000


def build():
    d = load("fig5_upright.json")
    sizes, obs = [], []
    for s in d["per_session"]:
        n = s["n_events"]
        if n < MIN_DISPLAYS:
            continue
        sizes.append(n)
        obs.append(max(t["n_lead"] for t in s["per_track"]) / n)
    # per (animal, partner) initiation, pooled over that pairing's recordings
    tr_of = {s["session"]: {i: a["animal"] for i, a in enumerate(s["per_track"])}
             for s in d["per_session"]}
    per_animal = collections.defaultdict(lambda: [0, 0])
    for e in d["events"]:
        m = tr_of.get(e["session"])
        if not m or len(m) < 2:
            continue
        ini = m.get(e["initiator_track"])
        if ini is None:
            continue
        for k, a in m.items():
            if a == ini:
                per_animal[a][0] += 1
            else:
                per_animal[a][1] += 1
    return np.array(sizes), np.array(obs), per_animal


def surrogate(sizes, seed=0, reps=NREP):
    """One matched fair-coin dataset per rep: the same session sizes, relabelled."""
    rng = np.random.default_rng(seed)
    out = np.empty((reps, len(sizes)))
    for j, n in enumerate(sizes):
        x = rng.binomial(n, 0.5, reps)
        out[:, j] = np.maximum(x, n - x) / n
    return out


def box(ax, data, pos, color, width=0.5):
    b = ax.boxplot(data, positions=[pos], widths=width, patch_artist=True,
                   showfliers=False, medianprops=dict(color="white", lw=1.4),
                   whiskerprops=dict(color=color, lw=1.0),
                   capprops=dict(color=color, lw=1.0),
                   boxprops=dict(facecolor=color, edgecolor=color, lw=0.8))
    return b


def opt5_two_boxes(ax, sizes, obs):
    """The one asked for: observed against a size-matched null surrogate."""
    sur = surrogate(sizes)
    box(ax, obs, 0, CI)
    box(ax, sur.ravel(), 1, CN)
    p = (sur.mean(axis=1) >= obs.mean()).mean()
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["observed", "fair-coin\nsurrogate"])
    ax.set_ylabel("share started by the leader")
    ax.set_ylim(0.45, 1.02)
    ax.axhline(0.5, color=INK, lw=0.8, ls="--", alpha=0.7)
    ax.text(0.02, 0.98, f"median {np.median(obs):.2f} against {np.median(sur):.2f}\n"
                        f"{len(obs)} sessions  ·  P < {max(p, 1/NREP):.4f}",
            transform=ax.transAxes, va="top", ha="left", fontsize=6.2,
            color=INK, fontweight="bold", linespacing=1.35)
    ax.text(0.02, 0.80, "the surrogate keeps each session's own\n"
                        "display count and relabels who started",
            transform=ax.transAxes, va="top", ha="left", fontsize=5.6,
            color=MUTED, linespacing=1.3)


def opt6_paired(ax, sizes, obs):
    """Observed minus the null expected at that same session size, so 0 is chance."""
    sur = surrogate(sizes)
    exp = sur.mean(axis=0)                    # expected share at each session's n
    diff = obs - exp
    box(ax, diff, 0, CI, width=0.35)
    ax.axhline(0.0, color=INK, lw=1.0, ls="--")
    ax.set_xticks([0])
    ax.set_xticklabels(["all sessions"])
    ax.set_ylabel("observed minus fair-coin expectation")
    w = stats.wilcoxon(diff, alternative="greater")
    ax.text(0.03, 0.98, f"median +{np.median(diff):.2f} above chance\n"
                        f"{int((diff > 0).sum())} of {len(diff)} sessions above  "
                        f"(P = {w.pvalue:.1e})",
            transform=ax.transAxes, va="top", ha="left", fontsize=6.2,
            color=INK, fontweight="bold", linespacing=1.35)
    ax.text(0.03, 0.80, "each session compared with the coin at\nits OWN size, so 0 is chance",
            transform=ax.transAxes, va="top", ha="left", fontsize=5.6,
            color=MUTED, linespacing=1.3)


def opt7_per_animal(ax, per_animal):
    """Leadership is an individual trait, not only a session-level one."""
    rows = [(a, w / (w + l), w + l) for a, (w, l) in per_animal.items() if w + l >= 10]
    rows.sort(key=lambda r: r[1])
    y = np.arange(len(rows))
    ax.barh(y, [r[1] for r in rows], color=[CI if r[1] >= 0.5 else CN for r in rows],
            height=0.72, lw=0)
    ax.axvline(0.5, color=INK, lw=1.0, ls="--")
    ax.set_yticks(y)
    ax.set_yticklabels([f"{r[0]}  (n={r[2]})" for r in rows], fontsize=5.4)
    ax.set_xlabel("share of displays this animal started")
    ax.set_xlim(0, 1)
    ax.text(0.97, 0.05, "pooled over EVERY partner\nthat animal was paired with",
            transform=ax.transAxes, va="bottom", ha="right", fontsize=5.6,
            color=MUTED, linespacing=1.3)


def opt8_pairings(ax, per_animal):
    """The same thing as a distribution: one value per animal, split about 0.5."""
    vals = np.array([w / (w + l) for w, l in per_animal.values() if w + l >= 10])
    ax.hist(vals, bins=np.linspace(0, 1, 11), color=CI, lw=0)
    ax.axvline(0.5, color=INK, lw=1.0, ls="--")
    ax.set_xlabel("share started, pooled over all that animal's partners")
    ax.set_ylabel("animals")
    ax.set_xlim(0, 1)
    ax.text(0.03, 0.97, f"{len(vals)} animals, and none sits near 0.5",
            transform=ax.transAxes, va="top", ha="left", fontsize=6.2,
            color=INK, fontweight="bold")
    ax.text(0.03, 0.86, "four consistently start, four consistently\n"
                        "follow, whoever they are paired with",
            transform=ax.transAxes, va="top", ha="left", fontsize=5.6,
            color=MUTED, linespacing=1.3)


def main():
    use()
    sizes, obs, per_animal = build()
    fig, axes = plt.subplots(2, 2, figsize=(mm(180), mm(120)), layout="constrained")
    for ax, (fn, args, title) in zip(axes.ravel(), [
            (opt5_two_boxes, (sizes, obs), "Option 5  ·  observed against a null surrogate"),
            (opt6_paired, (sizes, obs), "Option 6  ·  paired difference from chance"),
            (opt7_per_animal, (per_animal,), "Option 7  ·  leadership is an individual trait"),
            (opt8_pairings, (per_animal,), "Option 8  ·  the same, as a distribution")]):
        fn(ax, *args)
        ax.set_title(title, fontsize=7.5, color=INK, fontweight="bold", loc="left")
        for s in ("top", "right"):
            ax.spines[s].set_visible(False)
    out = OUT / "_fig5f_options2.png"
    fig.savefig(out, dpi=300)
    print("wrote", out)


if __name__ == "__main__":
    main()
