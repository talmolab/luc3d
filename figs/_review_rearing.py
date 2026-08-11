import json, sys
import numpy as np, matplotlib
matplotlib.use("Agg"); import matplotlib.pyplot as plt
sys.path.insert(0, "figs")
from src.style import use, SET2, MUTED, INK

d = json.load(open("figs/out/fig5_rearing.json"))
use()
CO = {"BMimica": SET2[0], "SLAP-2M": SET2[2]}
fig, ax = plt.subplots(1, 3, figsize=(11.5, 3.5), constrained_layout=True)

# 1-2: rear-triggered average, one per corpus
for i, c in enumerate(["BMimica", "SLAP-2M"]):
    s = d["corpora"][c]; t = np.asarray(s["t"]); a = ax[i]
    p = s["peri"]; sh = s["peri_shuf"]
    a.fill_between(t, p["p25"], p["p75"], color=CO[c], alpha=0.20, lw=0)
    a.plot(t, p["p50"], color=CO[c], lw=2.2, label="rears")
    a.fill_between(t, sh["p25"], sh["p75"], color=MUTED, alpha=0.15, lw=0)
    a.plot(t, sh["p50"], color=MUTED, lw=1.2, ls=":", label="shuffled onsets")
    k = int(np.argmax(p["p50"]))
    a.plot(t[k], p["p50"][k], "o", color=CO[c], ms=6, mec="white", mew=1.2, zorder=5)
    a.annotate(f"{p['p50'][k]:.2f} BL\n{t[k]:+.2f} s", (t[k], p["p50"][k]),
               textcoords="offset points", xytext=(6, -2), color=CO[c],
               fontsize=7.5, fontweight="bold", va="top")
    a.axvline(0, color=INK, lw=0.8, ls="--", alpha=0.6)
    a.axhline(d["rear_frac_body_lengths"], color=INK, lw=0.6, ls="-.", alpha=0.4)
    a.set_xlabel("time from rear onset (s)")
    a.set_ylabel("nose height (body lengths)")
    a.set_title(f"{c} — {s['n_sessions']} sessions, {s['n_rears_total']:,} rears",
                fontweight="bold")
    a.legend(frameon=False, fontsize=7, loc="upper left")
    a.set_ylim(0, 1.55)

# 3: vertical occupancy, threshold-free
a = ax[2]
for c in ["BMimica", "SLAP-2M"]:
    s = d["corpora"][c]; o = s["occupancy"]
    e = np.asarray(o["edges"]); ctr = 0.5 * (e[1:] + e[:-1])
    a.fill_between(ctr, o["p25"], o["p75"], color=CO[c], alpha=0.18, lw=0)
    a.plot(ctr, o["p50"], color=CO[c], lw=2, label=c)
a.axvline(d["rear_frac_body_lengths"], color=INK, lw=0.8, ls="-.", alpha=0.6)
a.annotate("rear threshold\n0.75 BL", (d["rear_frac_body_lengths"], a.get_ylim()[1]*0.75),
           xytext=(8, 0), textcoords="offset points", fontsize=7, color=MUTED)
a.set_xlabel("nose height (body lengths)"); a.set_ylabel("density")
a.set_title("Vertical occupancy (no threshold)", fontweight="bold")
a.legend(frameon=False, fontsize=7); a.set_yscale("log")
fig.savefig("figs/out/fig5_rearing_review.png", dpi=150)
print("ok")
