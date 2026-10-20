#!/usr/bin/env python3
"""
Fig 13g/13h -- Fig 3e's 3D-term sweep SPLIT into its two metrics, one cell
panel each (2026-08-25 row-2 rebuild; Eric: "the d, e, f is way too small ...
maybe f should be split up and d, e, and split up f should be a square").

The source panel drew ID-switch rate and cross-view IDF1 as two ~15 mm
sub-axes stacked inside one third-span panel, which the old fig13 column then
scaled by 0.667 -- each metric ended up ~10 mm tall with 5.3 pt type. Here
each metric is its OWN native ~36 x 41 mm cell at 7 pt. fig13_sync stacks the
two cells into fig13's second block column (g over h, sharing their r axis
like the original sub-axes did: g hides its x tick labels, h carries the axis
label) and trues both PDFs to the exact cell height.

REUSES FIG 3e's OWN `build()` AND `_axes_setup()` (imported as a module, not
touched -- `main()` is guarded and never runs, so Fig 3's own panel, CSV
deposits and their gates are untouched). `build()` still runs its own
denominator/collapse/n_sessions gates; the frame-matched-rule reconciliation
gates from Fig 3e's `main()` are repeated here because this script draws the
same two flat rules. Every design decision on the marks -- teal/salmon, the
r = 0 broken slot, plain-number decades, the app-default rule -- is Fig 3e's;
see that script's comments. NO FOOTNOTE: `footnote()` is log-only now, and
the rate-basis/frame-matched provenance lives in FIGURE-LEGENDS.md with the
rest of the sweep's caption.

    python3 figs/panels/fig13_07_sweep_split.py
"""
import sys
from pathlib import Path

import numpy as np
from matplotlib.ticker import FixedFormatter, FixedLocator, NullLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import GREY, MUTED, SALMON, TEAL, deposit, panel, save, use  # noqa: E402
from fig3_sync import CELL_H, CELL_W, place_cell_axes  # noqa: E402
import panels.fig3_05_sweep as sw  # noqa: E402


def main():
    use(7.0)
    # 2026-10-19: the frame-matched greedy curve when this build has one (see
    # sw.build_framematched); the full-session two-arm build otherwise.
    fmd = sw.build_framematched()
    df, tcf = fmd if fmd else sw.build()

    r = np.sort(df.r.unique()).astype(float)
    first = float(r[r > 0].min())
    zero_x = first * 10 ** -sw.BREAK_DEC
    has_zero = bool(r[0] == 0.0) and bool((r[1:] > 0).all())

    exh = load("fig3_exhaustive_bmimica.json")
    df["rate"] = df.switches.clip(lower=1) / tcf * sw.PER
    exh_rate = exh["switches_per_100k_camera_frames"]
    fm = load("fig3_frame_matched_bmimica.json")
    fm_e, fm_g = fm["arms"]["exhaustive"], fm["arms"]["greedy"]
    # Fig 3e's reconciliation gates, repeated verbatim because the same two
    # flat rules are drawn here -- see that script for the reasoning.
    if abs(fm_e["switches_per_100k_camera_frames"] - exh_rate) > 1e-4:
        sys.exit(f"fig13g/h: frame-matched exhaustive switch rate "
                 f"{fm_e['switches_per_100k_camera_frames']:.5f} != the published "
                 f"deposit's {exh_rate:.5f} -- the two rescores disagree")
    if fm_e["camera_frames_scored"] != fm_g["camera_frames_scored"]:
        sys.exit("fig13g/h: the two frame-matched arms were scored over different "
                 "camera-frame counts -- the rules would not be comparable")
    if fmd and fm_e["camera_frames_scored"] != tcf:
        sys.exit(f"fig13g/h: the frame-matched sweep covers {tcf:,} camera-frames, the "
                 f"exhaustive rule {fm_e['camera_frames_scored']:,} -- not the same frames")
    if fmd:
        deposit(df, 3, "fig3g_sweep_framematched.csv")
    if fm_e["camera_frames_scored"] > tcf:
        sys.exit(f"fig13g/h: the frame-matched arms cover "
                 f"{fm_e['camera_frames_scored']:,} camera-frames, more than "
                 f"{tcf:,} -- not the same corpus")

    def sweep_line(axis, ycol):
        g = df[df.arm == sw.FRESH_NAME].sort_values("r")
        rr = g.r.to_numpy(dtype=float)
        x = np.where(rr > 0, rr, zero_x)
        pos = rr > 0
        y = g[ycol].to_numpy(dtype=float)
        axis.plot(x[pos], y[pos], color=TEAL, lw=1.8, zorder=3)
        if has_zero:
            axis.plot(x[:2], y[:2], color=TEAL, lw=1.2, ls=(0, (1.4, 1.2)), zorder=3)
        axis.plot(x, y, "o", color=TEAL, ms=4, mec="white", mew=0.8, zorder=4)

    def exh_line(axis, yval):
        axis.axhline(yval, color=SALMON, lw=1.8, zorder=2)
        axis.plot([zero_x, r[-1]], [yval] * 2, "s", color=SALMON, ms=3.4,
                  mec="white", mew=0.7, zorder=3, clip_on=False)
        # Eric 2026-10-17: no "frames without missing detections only" label on the
        # artwork (it was added 2026-10-15); the Methods/legend carry that caveat.

    def app_default(axis, in_band=True):
        axis.axvline(sw.SHIPPED_R, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
        if in_band:
            t = axis.annotate(f"app default r = {sw.SHIPPED_R:g}", (sw.SHIPPED_R, 1.0),
                              xycoords=("data", "axes fraction"), xytext=(0, 8),
                              textcoords="offset points", color=MUTED, fontsize=6,
                              ha="center", va="bottom")
            # Centred on the line unless that runs past the right spine (the low-r
            # extension pushes r = 6 right); then end the label at the spine.
            r = axis.figure.canvas.get_renderer()
            if t.get_window_extent(r).x1 > axis.get_window_extent(r).x1:
                t.xy = (1.0, 1.0)
                t.set_annotation_clip(False)
                t.xycoords = "axes fraction"
                t.set_ha("right")

    # ---- 13g: the ID-switch rate ----
    fig, ax = panel(CELL_W, CELL_H, key=1)
    sw._axes_setup(ax, min(float(df.rate.min()), exh_rate),
                   max(float(df.rate.max()), exh_rate), zero_x, first, has_zero)
    # Eric 2026-10-17: a 0.1 tick too, with the floor extended to show it.
    ax.yaxis.set_major_locator(FixedLocator([0.1, 1, 10, 100]))
    ax.yaxis.set_major_formatter(FixedFormatter(["0.1", "1", "10", "100"]))
    _b, _t = ax.get_ylim()
    ax.set_ylim(min(_b, 0.1 * 10 ** -0.08), _t)
    sweep_line(ax, "rate")
    exh_line(ax, exh_rate)
    # Eric 2026-10-18: no app-default r = 6 rule or label on g/h.
    ax.set_ylabel("ID switches /100k")
    # g carries its own r tick labels and axis title too (Eric, 2026-10-17), not just h.
    # the key band names both series once, for the g/h pair together.
    fig.text(0.22, 0.985, "exhaustive", ha="left", va="top", color=SALMON,
             fontsize=7, fontweight="bold")
    fig.text(0.62, 0.985, "greedy", ha="left", va="top", color=TEAL,
             fontsize=7, fontweight="bold")
    place_cell_axes(fig, ax, "sweep_col")   # shared cell x -- fig13_sync.CELL_AXES_X
    save(fig, 3, "g", "sweep_switches")

    # ---- 13h: cross-view IDF1 ----
    fig, ax = panel(CELL_W, CELL_H)
    sw._axes_setup(ax, 1.0, 10.0, zero_x, first, has_zero)  # x machinery
    ax.set_yscale("linear")
    sweep_line(ax, "idf1")
    exh_line(ax, fm_e["idf1_cross_mean"])
    # Eric 2026-10-17: y zoomed to the data rather than a fixed 0.35 floor. Bottom is
    # the lowest plotted value rounded down to 0.1 (with a small margin), top IDF1's
    # ceiling, ticks every 0.1.
    _ys = np.append(df[df.arm == sw.FRESH_NAME].idf1.to_numpy(dtype=float),
                    float(fm_e["idf1_cross_mean"]))
    _lo = np.floor((float(np.min(_ys)) - 0.02) * 10) / 10
    _ticks = np.round(np.arange(_lo, 1.0001, 0.1), 1)
    ax.yaxis.set_major_locator(FixedLocator(_ticks))
    ax.yaxis.set_major_formatter(FixedFormatter([f"{v:.1f}" for v in _ticks]))
    ax.yaxis.set_minor_locator(NullLocator())
    ax.set_ylim(_lo - 0.01, 1.0)
    ax.set_ylabel("cross-view IDF1")
    place_cell_axes(fig, ax, "sweep_col")   # ...and h lands on exactly g's x
    save(fig, 3, "h", "sweep_idf1")


if __name__ == "__main__":
    main()
