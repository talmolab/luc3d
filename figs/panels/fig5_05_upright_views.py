#!/usr/bin/env python3
"""
Fig 5a -- one mutual upright display, reconstructed, with what each camera saw.

THE CLAIM IS ABSENCE, NOT AMBIGUITY, and the distinction is load-bearing because the
obvious version is false here. `fig5_ambiguity.py` tested "a single view cannot
separate the two animals" over 535 displays: in the WORST of the five views the tail
bases are still 83.5 px apart and never once fell below 20 px. Bounding-box overlap is
actually LOWER during displays (35.9% of views) than in a proximity-matched control
(58.6%) -- two reared animals are tall narrow boxes side by side. This rig's cameras
are well placed and no view is confused.

What no single view has is the VERTICAL. Each of the five projections here is a
different foreshortening of the same posture, and the apparent height in each depends
on where that camera sits, not on the animals. "Both reached ~1.1 body lengths above
the floor and their noses closed to 11 mm" is a property of the five together. The
panel is therefore the reconstruction beside the five real projections: the views are
the evidence, the skeleton is the answer.

WHAT IS REAL AND WHAT IS ARRANGED, stated because a 3D figure invites the assumption
that everything in it is metric:
  * REAL -- the 3D pose (P-frame, z is height above the cage floor in mm); each
    camera's DIRECTION from the scene; the projected 2D on each plane, which is
    `cv2.projectPoints` of the aligned pose through that camera's real intrinsics,
    distortion and extrinsics.
  * ARRANGED -- the five projections are each drawn to fit their own little frame, so
    their SCALES are not comparable to each other; the elevation above each says where
    it was taken from. Only the 3D panel is metric.

Source: figs/out/fig5_views.json (figs/fig5_views.py, which needs the bench env).

    python3 figs/panels/fig5_05_upright_views.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import MUTED, ROW_H, SPAN, deposit, mm, save, use  # noqa: E402

NOSE, TTI = 0, 3
CA, CB = "#66C2A5", "#E78AC3"        # the two animals, as in every other 5c-e panel


def main():
    use()
    d = load("fig5_views.json")
    P = np.asarray(d["pose_mm"], float)              # (2, 15, 3) mm, z = height
    edges = d["edges"]
    A = P.shape[0]
    ctr = np.r_[P[:, TTI, :2].mean(axis=0), P[:, :, 2].mean()]

    deposit(pd.DataFrame([
        {"camera": c["name"], "tti_gap_px": c["tti_gap_px"],
         "nose_gap_px": c["nose_gap_px"]} for c in d["cameras"]
    ]), 5, "fig5a_camera_gaps.csv")

    # FIVE PLANES FLOATING AT THEIR TRUE CAMERA DIRECTIONS WAS TRIED AND FAILED, for a
    # reason worth recording: this rig is top-heavy. Every camera sits 58-76 degrees
    # ABOVE the scene (azimuths +80 to +154 and -174), so seen from the animals all
    # five lie in nearly the same direction and the five planes drew on top of one
    # another in a single clump. Arranging them on a fake ring would have implied a
    # camera layout the rig does not have.
    #
    # So: the reconstruction on the left, the five real projections as their own small
    # image panels on the right, each labelled with the elevation it was taken from.
    # Same content, and the elevations now carry the fact the clump was hiding.
    w, h = SPAN["half"], ROW_H["tall"]
    fig = plt.figure(figsize=(mm(w), mm(h)), layout="constrained")
    gs = fig.add_gridspec(1, 2, width_ratios=[1.15, 1.0], wspace=0.01)
    ax = fig.add_subplot(gs[0, 0], projection="3d")
    # 3 ROWS x 2 COLS, not 2 x 3: the right column is tall and narrow, so three tall
    # rows fill it and give each projection a usable frame. At 2 x 3 the five views
    # were postage stamps with a hole in the middle of the panel.
    gsr = gs[0, 1].subgridspec(3, 2, hspace=0.30, wspace=0.08)

    # ---- the reconstruction ----------------------------------------------------
    for a_i, col in ((0, CA), (1, CB)):
        for u, vtx in edges:
            ax.plot(*[[P[a_i, u, kk], P[a_i, vtx, kk]] for kk in range(3)],
                    color=col, lw=1.5, solid_capstyle="round", zorder=6)
        ax.scatter(P[a_i, :, 0], P[a_i, :, 1], P[a_i, :, 2], color=col, s=4,
                   depthshade=False, zorder=7)
        ax.scatter([P[a_i, NOSE, 0]], [P[a_i, NOSE, 1]], [P[a_i, NOSE, 2]],
                   color=col, s=26, edgecolor="white", linewidth=0.7,
                   depthshade=False, zorder=8)
    xy = P[:, :, :2].reshape(-1, 2)
    r = float(np.nanmax(np.abs(xy - ctr[:2]))) * 1.15
    zmax = float(np.nanmax(P[:, :, 2])) * 1.15
    ax.set_xlim(ctr[0] - r, ctr[0] + r)
    ax.set_ylim(ctr[1] - r, ctr[1] + r)
    ax.set_zlim(0, zmax)
    ax.set_box_aspect((1, 1, 1.0))
    ax.view_init(elev=14, azim=-62)
    for axis in (ax.xaxis, ax.yaxis, ax.zaxis):
        axis.pane.set_facecolor("white")
        axis.pane.set_edgecolor("#DDDDDD")
        axis.pane.set_alpha(1.0)
        axis._axinfo["grid"].update(color="#EEEEEE", linewidth=0.4)
    ax.set_xticks([]); ax.set_yticks([])
    ax.set_zticks([z for z in (0, 50, 100, 150) if z <= zmax])
    ax.tick_params(axis="z", labelsize=5.5, pad=0)
    L = d["body_length_mm"]
    ax.plot([ctr[0] - r + 0.05 * L, ctr[0] - r + 0.05 * L + L],
            [ctr[1] - 0.92 * r, ctr[1] - 0.92 * r], [0, 0], color=MUTED, lw=1.3)
    ax.text2D(0.02, 0.99, "3D reconstruction", transform=ax.transAxes, fontsize=6.5,
              color="#4C4D4C", va="top", ha="left", fontweight="bold")
    ax.text2D(0.02, 0.93, f"height in mm · bar = {L:.0f} mm",
              transform=ax.transAxes, fontsize=5.6, color=MUTED, va="top", ha="left")

    # ---- the five real camera projections --------------------------------------
    cams = sorted(d["cameras"], key=lambda c: -_elev(c, ctr))
    for i, cam in enumerate(cams):
        a2 = fig.add_subplot(gsr[i // 2, i % 2])
        proj = np.asarray(cam["proj_px"], float)
        for a_i, col in ((0, CA), (1, CB)):
            for u, vtx in edges:
                a2.plot(proj[a_i, [u, vtx], 0], proj[a_i, [u, vtx], 1],
                        color=col, lw=0.7)
            a2.plot(proj[a_i, NOSE, 0], proj[a_i, NOSE, 1], "o", color=col, ms=1.8)
        # IMAGE CONVENTION: y DOWN. Without inverting, every projection is drawn
        # upside down and the reared animals appear to hang from the ceiling.
        a2.invert_yaxis()
        a2.set_aspect("equal")
        a2.set_xticks([]); a2.set_yticks([])
        for s in a2.spines.values():
            s.set_color("#D8D8D8")
            s.set_linewidth(0.5)
        a2.set_title(f"{_elev(cam, ctr):.0f}°", fontsize=5.6, color=MUTED, pad=1.0)
    # the sixth cell carries the note rather than an empty frame. Lines kept SHORT:
    # the first version ran past the panel edge and lint could not see it, because the
    # text belongs to an axes that is itself at the figure boundary.
    a3 = fig.add_subplot(gsr[2, 1])
    a3.axis("off")
    gaps = [c["tti_gap_px"] for c in d["cameras"]]
    a3.text(0.0, 1.0, "5 camera views,\nsame instant", fontsize=5.8,
            color=MUTED, va="top", ha="left", fontweight="bold", linespacing=1.25)
    a3.text(0.0, 0.50, f"all {min(_elev(c, ctr) for c in cams):.0f}–"
                       f"{max(_elev(c, ctr) for c in cams):.0f}° above,\n"
                       f"{min(gaps):.0f}–{max(gaps):.0f} px apart\n"
                       f"in every view.\nNone has the\nvertical.",
            fontsize=5.0, color=MUTED, va="top", ha="left", linespacing=1.28)
    save(fig, 5, "a", "upright_views")


def _elev(cam, ctr):
    """Elevation of a camera above the scene, degrees."""
    v = np.asarray(cam["centre_mm"], float) - ctr
    return float(np.degrees(np.arcsin(v[2] / max(np.linalg.norm(v), 1e-9))))


if __name__ == "__main__":
    main()
