"""Review renders for the mutual-upright display: real poses + characterisation."""
import json, sys
import numpy as np, matplotlib
matplotlib.use("Agg"); import matplotlib.pyplot as plt
sys.path.insert(0, "figs")
from src.style import use, SET2, MUTED, INK

d = json.load(open("figs/out/fig5_upright.json")); use()
E = d["edges"]; NOSE, TTI, NECK = 0, 3, 14
CA, CB = SET2[0], SET2[3]

# ---------------------------------------------------------------- poses ----
ex = d["examples"]
# pick 6 spread across sessions, preferring long well-converged ones
seen, pick = set(), []
for e in sorted(ex, key=lambda x: -x["dur_s"]):
    if e["session"] in seen: continue
    seen.add(e["session"]); pick.append(e)
    if len(pick) == 6: break
fig = plt.figure(figsize=(11.5, 7.2))
for i, e in enumerate(pick):
    P = np.asarray(e["pose"])                       # (2, 15, 3) mm
    ax = fig.add_subplot(2, 3, i + 1, projection="3d")
    ctr = np.nanmean(P[:, TTI, :2], axis=0)
    for a, c in ((0, CA), (1, CB)):
        for u, v in E:
            ax.plot(*[[P[a, u, k] - (ctr[k] if k < 2 else 0),
                       P[a, v, k] - (ctr[k] if k < 2 else 0)] for k in range(3)],
                    color=c, lw=1.6, solid_capstyle="round")
        ax.scatter(*[P[a, :, k] - (ctr[k] if k < 2 else 0) for k in range(3)],
                   color=c, s=7, depthshade=False)
        ax.scatter(*[[P[a, NOSE, k] - (ctr[k] if k < 2 else 0)] for k in range(3)],
                   color=c, s=42, edgecolor="white", linewidth=0.8, depthshade=False)
    L = e["L_mm"]
    ax.set_xlim(-1.3 * L, 1.3 * L); ax.set_ylim(-1.3 * L, 1.3 * L)
    ax.set_zlim(0, 2.0 * L)
    ax.set_box_aspect((1, 1, 0.85))
    ax.set_title(f"{e['session'][:13]}  ·  {e['dur_s']:.2f} s", fontsize=8,
                 fontweight="bold")
    ax.tick_params(labelsize=5, pad=0)
    ax.set_zlabel("height (mm)", fontsize=6, labelpad=-4)
    ax.view_init(elev=12, azim=-60)
fig.suptitle("Mutual upright display — real reconstructed poses at closest approach "
             "(large dot = nose)", fontweight="bold", fontsize=11)
fig.tight_layout(rect=[0, 0, 1, 0.96])
fig.savefig("figs/out/fig5_upright_poses.png", dpi=150)

# ------------------------------------------------------ characterisation ----
ev = d["events"]; t = np.asarray(d["t"])
g = lambda k: np.asarray([e[k] for e in ev], float)
fig, ax = plt.subplots(2, 3, figsize=(11.5, 6.4), constrained_layout=True)

a = ax[0, 0]
for key, c, lab in (("hi", CA, "taller animal"), ("lo", CB, "shorter animal")):
    p = d["peri"][key]
    a.fill_between(t, p["p25"], p["p75"], color=c, alpha=0.18, lw=0)
    a.plot(t, p["p50"], color=c, lw=2, label=lab)
a.axvline(0, color=INK, lw=0.8, ls="--", alpha=.6)
a.set_xlabel("time from display onset (s)"); a.set_ylabel("nose height (body lengths)")
a.set_title("Both animals rise together", fontweight="bold"); a.legend(frameon=False, fontsize=7)

a = ax[0, 1]
p = d["peri"]["gap"]
a.fill_between(t, p["p25"], p["p75"], color=SET2[1], alpha=0.2, lw=0)
a.plot(t, p["p50"], color=SET2[1], lw=2)
a.axvline(0, color=INK, lw=0.8, ls="--", alpha=.6)
a.set_xlabel("time from display onset (s)")
a.set_ylabel("horizontal nose gap (body lengths)")
a.set_title("…and their noses converge", fontweight="bold")

a = ax[0, 2]
a.scatter(g("peak_hi"), g("peak_lo"), s=9, color=SET2[2], alpha=0.5, lw=0)
lim = [0.7, 2.0]; a.plot(lim, lim, color=MUTED, lw=1, ls="--")
a.set_xlim(*lim); a.set_ylim(*lim)
a.set_xlabel("taller animal peak (BL)"); a.set_ylabel("shorter animal peak (BL)")
a.set_title(f"Heights are matched (median {np.median(g('height_match')):.2f})",
            fontweight="bold")

a = ax[1, 0]
a.hist(g("dur_s"), bins=np.linspace(0, 3, 31), color=SET2[0], alpha=0.85)
a.axvline(np.median(g("dur_s")), color=INK, lw=1.2, ls="--")
a.set_xlabel("display duration (s)"); a.set_ylabel("events")
a.set_title(f"Duration (median {np.median(g('dur_s')):.2f} s)", fontweight="bold")

a = ax[1, 1]
v = g("speed_rel"); v = v[np.isfinite(v)]
a.hist(v, bins=np.linspace(0, 2.5, 31), color=SET2[3], alpha=0.85)
a.axvline(1.0, color=INK, lw=1.2, ls="--")
a.annotate("baseline speed", (1.0, a.get_ylim()[1] * 0.9), xytext=(6, 0),
           textcoords="offset points", fontsize=7, color=MUTED)
a.set_xlabel("speed during display / own baseline"); a.set_ylabel("events")
a.set_title(f"They go STILL, not fast (median {np.median(v):.2f}×)", fontweight="bold")

a = ax[1, 2]
a.scatter(g("x"), g("y"), s=10, color=SET2[5], alpha=0.6, lw=0)
a.set_aspect("equal"); a.set_xlabel("arena x (mm)"); a.set_ylabel("arena y (mm)")
a.set_title("Where they happen", fontweight="bold")

fig.suptitle(f"Mutual upright display — {d['n_events']} events, "
             f"{d['n_sessions']} BMimica sessions", fontweight="bold", fontsize=11)
fig.savefig("figs/out/fig5_upright_characterisation.png", dpi=150)
print("ok")
