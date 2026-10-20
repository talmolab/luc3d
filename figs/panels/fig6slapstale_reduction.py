"""SLAP-2M staleness sweep, redrawn as % switch reduction against stale 0 (2026-10-19).

Eric: "can we express that [fig6slapstale] in terms of percentage reduction of
switches? ... i dont like the identity and recall plot anymore". So the PR plane is
gone, the cross-view IDF1 survival stays, and the switch sub-panel shows each stale
window's switch total as a percentage reduction from stale 0 (no eviction) instead of
the % of camera-frames carrying a switch.

Reads figs/out/stale_sweep_slap2m.json (written by figs/stale_sweep_slap2m.py).

    FIG_TAG=slapstale .venv/bin/python panels/fig6slapstale_reduction.py
    FIG_TAG=c .venv/bin/python panels/fig6slapstale_reduction.py   # Fig 6 panel f

As Fig 6f it also writes figures/fig6<FIG_TAG>/fig6f_axes.json, which panel g
(panels/fig6_09_sdannce_survival.py) copies so the two survival axes line up --
the job the old fig6_07_pr_switches panel did. Re-run g after this.
"""
import json
import os
import sys
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import GREY, grid, save, use  # noqa: E402
from fig6_07_pr_switches import STALE_COLOURS  # noqa: E402

FIGS = Path(__file__).resolve().parent.parent
SERIES = [
    ("stale0_dist25", "stale 0", STALE_COLOURS[0]),
    ("sync_stale1_dist25", "stale 1", STALE_COLOURS[1]),
    ("sync_stale10_dist25", "stale 10", STALE_COLOURS[2]),
    ("sync_stale20_dist25", "stale 20", STALE_COLOURS[3]),
    ("sync_stale30_dist25", "stale 30", STALE_COLOURS[4]),
]
REF = "stale0_dist25"


def main(letter="f"):
    use()
    d = json.loads((FIGS / "out" / "stale_sweep_slap2m.json").read_text())
    cells = {c["config"]: c for c in d["cells"]}
    ref = cells[REF]["switches"]
    rows = []
    for cfg, lab, col in SERIES:
        c = cells[cfg]
        rows.append({"label": lab, "colour": col, "switches": c["switches"],
                     "reduction": 100.0 * (ref - c["switches"]) / ref,
                     "idf1": [q["cross_idf1"] for q in c["per_session"]]})
        print(f"  {lab:9s} switches {c['switches']:,}  reduction "
              f"{rows[-1]['reduction']:.1f}%  mean IDF1 {np.mean(rows[-1]['idf1']):.4f}")

    fig, (axF, axS) = grid(1, 2, span="two-thirds", row=55.0)
    fig.get_layout_engine().set(rect=(0, 0.075, 1, 0.895))

    # ---- cross-view IDF1 survival, as fig6_07 draws it ----------------------------
    for r in rows:
        v = np.sort(np.asarray(r["idf1"], float))
        n = len(v)
        ys = np.empty(2 * n)
        ys[0::2] = 100.0 * (n - np.arange(n)) / n
        ys[1::2] = 100.0 * (n - np.arange(n) - 1) / n
        ref_row = r["label"] == "stale 0"
        axF.plot(np.repeat(v, 2), ys, color=r["colour"], lw=1.9 if ref_row else 1.2,
                 zorder=4 if ref_row else 3)
    axF.axhline(50, color=GREY, lw=0.7, ls=(0, (1.5, 1.5)), zorder=1)
    axF.set_xlabel("cross-view IDF1", fontsize=7)
    axF.set_ylabel("% of the sessions at or above", fontsize=7)
    axF.set_xlim(0.3, 1.0)
    axF.set_ylim(0, 101.5)
    axF.set_yticks([0, 25, 50, 75, 100])
    axF.tick_params(labelsize=6.5)

    # ---- switch reduction from stale 0 --------------------------------------------
    ypos = np.arange(len(rows))[::-1]
    for y, r in zip(ypos, rows):
        axS.barh(y, r["reduction"], height=0.6, color=r["colour"], zorder=3)
        txt = "reference" if r["label"] == "stale 0" else f"{r['reduction']:.0f}%"
        axS.annotate(txt, (max(r["reduction"], 0), y), textcoords="offset points",
                     xytext=(3, 0), ha="left", va="center", fontsize=6.5,
                     color=r["colour"])
    axS.axvline(0, color="#333333", lw=0.8, zorder=4)
    axS.set_yticks(ypos)
    axS.set_yticklabels([r["label"] for r in rows], fontsize=6.5)
    axS.set_ylim(-0.6, len(rows) - 0.4)
    axS.set_xlim(0, 16)
    axS.set_xticks([0, 5, 10, 15])
    axS.xaxis.set_major_formatter(lambda v, _p: f"{v:g}%")
    axS.set_xlabel("fewer ID switches\nthan stale 0", fontsize=7)
    axS.tick_params(labelsize=6.5)

    # key strip, centred under both sub-plots
    fig.canvas.draw()
    renderer = fig.canvas.get_renderer()
    kx, fw, keys = 0.0, fig.bbox.width, []
    for r in rows:
        t = fig.text(kx, 0.022, r["label"], color=r["colour"], fontsize=7,
                     fontweight="bold", ha="left", va="bottom")
        keys.append(t)
        kx += t.get_window_extent(renderer).width / fw + 0.022
    mid = (axF.get_position().x0 + axS.get_position().x1) / 2
    for t in keys:
        x0, y0 = t.get_position()
        t.set_position((x0 + mid - (kx - 0.022) / 2, y0))

    fig.canvas.draw()
    W, H = fig.get_size_inches() * 25.4
    boxes = [a.get_position() for a in (axF, axS)]
    # per FIG_TAG, so a fig6c build cannot rewrite the main figure's geometry (X5)
    (FIGS / "figures" / f"fig6{os.environ.get('FIG_TAG', '')}" / "fig6f_axes.json").write_text(json.dumps({
        "fig_mm": [W, H],
        "axes_mm": [[b.x0 * W, b.y0 * H, b.width * W, b.height * H] for b in boxes]},
        indent=1))
    save(fig, 6, letter, "switch_reduction")


if __name__ == "__main__":
    main(sys.argv[sys.argv.index("--letter") + 1] if "--letter" in sys.argv else "f")
