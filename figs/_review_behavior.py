import json, sys
import numpy as np, matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
sys.path.insert(0, "figs")
from src.style import use, SET2, MUTED, INK

d = json.load(open("figs/out/fig5_behavior.json"))
use()
C = {"nose-to-nose": SET2[0], "nose-to-TTI": SET2[3]}
fig, axes = plt.subplots(2, 2, figsize=(9.2, 6.2), constrained_layout=True)
for col, corpus in enumerate(["BMimica", "SLAP-2M"]):
    s = d["corpora"][corpus]
    t = np.asarray(s["t"])
    for row, (key, shuf, lab) in enumerate(
            [("z", "z_shuf", "nose height − own median (mm)"),
             ("rear", "rear_shuf", "body axis TTI→Neck (° above horizontal)")]):
        ax = axes[row, col]
        for kind in ["nose-to-nose", "nose-to-TTI"]:
            g = s[kind][key]
            if not g: continue
            p50 = np.asarray(g["p50"])
            ax.fill_between(t, g["p25"], g["p75"], color=C[kind], alpha=0.15, lw=0)
            ax.plot(t, p50, color=C[kind], lw=2,
                    label=f"{kind}  (n={s['n_bouts_total'][kind]:,})")
            k = int(np.argmax(p50))
            ax.plot(t[k], p50[k], "o", color=C[kind], ms=5, mec="white", mew=1)
            ax.annotate(f"{t[k]:+.2f}s", (t[k], p50[k]), textcoords="offset points",
                        xytext=(0, 7), ha="center", color=C[kind], fontsize=7,
                        fontweight="bold")
            sh = s[kind][shuf]
            if sh:
                ax.plot(t, sh["p50"], color=MUTED, lw=0.9, ls=":", zorder=1)
        ax.axvline(0, color=INK, lw=0.8, ls="--", alpha=0.6)
        ax.set_xlabel("time from bout onset (s)")
        ax.set_ylabel(lab)
        if row == 0:
            ax.set_title(f"{corpus} — {s['n_sessions']} sessions @ "
                         f"{s['fps']:.0f} fps", fontweight="bold")
            ax.legend(frameon=False, fontsize=7, loc="upper left")
axes[1,0].text(0.02, 0.03, "dotted = shuffled onsets (null)", transform=axes[1,0].transAxes,
               color=MUTED, fontsize=7)
fig.savefig("figs/out/fig5_behavior_review.png", dpi=150)
print("ok")
