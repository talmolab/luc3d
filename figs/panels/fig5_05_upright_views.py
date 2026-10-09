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
  * REAL -- the 3D pose (P-frame, z is height above the cage floor); each camera's
    DIRECTION from the scene; the projected 2D on each plane, which is
    `cv2.projectPoints` of the aligned pose through that camera's real intrinsics,
    distortion and extrinsics.
  * ARRANGED -- the five projections are each drawn to fit their own little frame, so
    their SCALES are not comparable to each other; the elevation above each says where
    it was taken from. The 3D render's proportions are metric (the pose is placed in
    the volume at true scale) but it carries no axes, so the volume's dimensions are
    stated on the panel instead.

THE 3D PANEL IS A BLENDER RENDER (Eric 2026-08-16: prettier skeleton renders): the
matplotlib stick-figure axes were replaced by a Cycles render in the established
house aesthetic (blender-images/cage_scene.py -- matte PBR ball-and-stick skeleton,
translucent body membranes, soft area lights, orthographic camera), the pose inside
a plain translucent box because this dataset has no cage geometry. Regenerate with:

    cd figs/blender-images && ./bpyenv/bin/python fig5a_scene.py \
        --azim 255 --elev 22 --ortho 0.335 --box 230 230 140 \
        --samples 200 --res 1900 1900 --out renders/fig5a_upright.png

(square, not landscape: the render sits in a portrait grid cell, and a 4:3 image
letterboxed into it left a dead zone below).

The five 2D projections were restyled to match (the old stick+arrow lines read as a
different species next to the render): each animal is now the same surface-filled
skeleton in 2D -- body membranes as low-alpha fills, bones as round-capped lines,
joints as small dots -- in the same Set2 teal/pink.

Source: figs/out/fig5_views.json (figs/fig5_views.py, which needs the bench env),
plus blender-images/renders/fig5a_upright.png (command above).

    python3 figs/panels/fig5_05_upright_views.py
"""
import sys
from pathlib import Path

import matplotlib.image as mpimg
import matplotlib.pyplot as plt
import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import FIGS, MUTED, ROW_H, SPAN, deposit, mm, save, use  # noqa: E402

CA, CB = "#4393C3", "#D6604D"        # male, female -- matches every other fig5 panel
RENDER = FIGS / "blender-images" / "renders" / "fig5a_upright.png"
BOX_MM = (230, 230, 140)             # the render's volume; keep in sync with the
                                     # fig5a_scene.py command in the docstring

# The surface-filled mouse, mirrored from blender-images/cage_scene.py
# (MOUSE_SURFACES / MOUSE_EDGES, themselves verbatim from viz_08 cell 16) so the
# five 2D projections draw the same animal the Blender render does. By NAME, not
# index: fig5_views.json's node order differs from the SLAP skeleton toml order.
MOUSE_SURFACES = [
    ["Nose", "Head", "Ear_R"], ["Nose", "Head", "Ear_L"],
    ["Head", "Neck", "Shoulder_left"], ["Head", "Neck", "Shoulder_right"],
    ["Neck", "Trunk", "Haunch_left", "Shoulder_left"],
    ["Neck", "Trunk", "Haunch_right", "Shoulder_right"],
    ["Trunk", "TTI", "Haunch_left"], ["Trunk", "TTI", "Haunch_right"],
    ["Head", "Shoulder_left", "Shoulder_right"],
    ["Haunch_left", "Haunch_right", "Shoulder_right", "Shoulder_left"],
    ["Haunch_left", "Haunch_right", "TTI"],
]
MOUSE_EDGES = [
    ["TailTip", "Tail_2"], ["Tail_2", "Tail_1"], ["Tail_1", "Tail_0"], ["Tail_0", "TTI"],
    ["TTI", "Trunk"], ["Trunk", "Neck"], ["Neck", "Head"], ["Head", "Nose"],
    ["TTI", "Haunch_left"], ["TTI", "Haunch_right"],
    ["Trunk", "Haunch_right"], ["Trunk", "Haunch_left"],
    ["Neck", "Shoulder_left"], ["Neck", "Shoulder_right"],
    ["Ear_L", "Head"], ["Ear_R", "Head"], ["Ear_L", "Nose"], ["Ear_R", "Nose"],
    ["Shoulder_left", "Head"], ["Shoulder_right", "Head"],
    ["Shoulder_left", "Haunch_left"], ["Shoulder_right", "Haunch_right"],
    ["Shoulder_left", "Shoulder_right"], ["Haunch_left", "Haunch_right"],
]


def draw_mouse2d(ax, pts, idx, col):
    """One animal as the render draws it, flattened: membrane fills under
    round-capped bone lines under small joint dots, nose emphasised."""
    for snodes in MOUSE_SURFACES:
        poly = pts[[idx[n] for n in snodes]]
        ax.fill(poly[:, 0], poly[:, 1], color=col, alpha=0.28, lw=0, zorder=2)
    for a, b in MOUSE_EDGES:
        ax.plot(pts[[idx[a], idx[b]], 0], pts[[idx[a], idx[b]], 1],
                color=col, lw=0.8, solid_capstyle="round", zorder=3)
    ax.plot(pts[:, 0], pts[:, 1], "o", color=col, ms=1.0, mew=0, zorder=4)
    ax.plot(pts[idx["Nose"], 0], pts[idx["Nose"], 1], "o", color=col, ms=2.4,
            mec="white", mew=0.4, zorder=5)


def main():
    use()
    d = load("fig5_views.json")
    P = np.asarray(d["pose_mm"], float)              # (2, 15, 3) mm, z = height
    idx = {n: i for i, n in enumerate(d["nodes"])}
    ctr = np.r_[P[:, idx["TTI"], :2].mean(axis=0), P[:, :, 2].mean()]

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
    # 1.62, up from 1.15 (Eric, 2026-08-19: "make the 2d pose visualizations a little
    # smaller and make the 3d bigger"). With the header and the volume note cut, the
    # render is the only thing in the left column, and because its content is wider
    # than tall in a column that is taller than wide it is WIDTH-limited: the column
    # ratio is the only lever that makes it bigger. The five projections shrink to
    # suit, which is the other half of the instruction.
    gs = fig.add_gridspec(1, 2, width_ratios=[1.62, 1.0], wspace=0.01)
    # 3 ROWS x 2 COLS, not 2 x 3: the right column is tall and narrow, so three tall
    # rows fill it and give each projection a usable frame. At 2 x 3 the five views
    # were postage stamps with a hole in the middle of the panel.
    gsr = gs[0, 1].subgridspec(3, 2, hspace=0.30, wspace=0.08)

    # ---- the reconstruction (Blender render; regeneration command in docstring) --
    # Placed by hand, OUTSIDE constrained layout: the five aspect-locked projection
    # axes on the right make the solver reapportion the outer gridspec's columns,
    # and the render (itself aspect-locked) then shrank to ~34 mm inside a cell it
    # no longer filled. A fixed axes with in_layout=False cannot be squeezed; the
    # panel's size is declared on the grid, so the fractions are deterministic.
    # NO IN-PANEL EXPOSITION (Eric, 2026-08-19). The "3D reconstruction" header, the
    # "volume 230 x 230 x 140 mm / only the 3D panel is metric" note, and the
    # "5 camera views, same instant / all 58-76 above, 93-106 px apart / None has the
    # vertical" block in the sixth cell were all cut. The panel's own title, which the
    # assembler draws from TITLES, now says what it is, and the volume and the camera
    # elevations are caption material rather than artwork. `BOX_MM` is kept because
    # the caption quotes it and it must stay in step with the render.
    #
    # The render takes the height the header used to occupy, which is why the axes
    # runs to 0.95 rather than 0.79 + 0.045.
    ax = fig.add_axes([0.002, 0.030, 0.618, 0.94], in_layout=False)
    img = mpimg.imread(str(RENDER))
    H, W = img.shape[:2]
    # TRIMMED TO THE INK, MEASURED, not to a guessed margin. On the shipping render
    # the box edges and the two mice span x 0.073 to 0.926 and y 0.101 to 0.816; the
    # rest is the grey world and the floor shadow. The old crop kept 0.02 to 0.96 in
    # y, so about a quarter of the panel's left column was empty world, which is what
    # pushed the box inward from the panel edge and away from c below it.
    img = img[int(0.085 * H):int(0.845 * H), int(0.055 * W):int(0.945 * W)]
    ax.imshow(img)
    # CENTRED, not anchored north. It hugged the header that has now been cut, which
    # left the whole lower half of the column empty. The render is landscape and the
    # column is tall, so some slack is unavoidable; splitting it above and below
    # reads as margin rather than as a hole.
    ax.axis("off")

    # ---- the five real camera projections --------------------------------------
    cams = sorted(d["cameras"], key=lambda c: -_elev(c, ctr))
    for i, cam in enumerate(cams):
        a2 = fig.add_subplot(gsr[i // 2, i % 2])
        proj = np.asarray(cam["proj_px"], float)
        for a_i, col in ((0, CA), (1, CB)):
            draw_mouse2d(a2, proj[a_i], idx, col)
        # IMAGE CONVENTION: y DOWN. Without inverting, every projection is drawn
        # upside down and the reared animals appear to hang from the ceiling.
        a2.invert_yaxis()
        a2.set_aspect("equal")
        a2.margins(0.08)
        a2.set_xticks([]); a2.set_yticks([])
        for s in a2.spines.values():
            s.set_color("#D8D8D8")
            s.set_linewidth(0.5)
        a2.set_title(f"{_elev(cam, ctr):.0f}°", fontsize=5.6, color=MUTED, pad=1.0)
    # The sixth cell is left empty. It used to carry the note that has now been cut;
    # the numbers it quoted are still printed here so they stay available to the
    # caption, which is where they now live.
    gaps = [c["tti_gap_px"] for c in d["cameras"]]
    print(f"  cameras {min(_elev(c, ctr) for c in cams):.0f}-"
          f"{max(_elev(c, ctr) for c in cams):.0f} deg above the animals; "
          f"tail-base gap {min(gaps):.0f}-{max(gaps):.0f} px in every view")
    save(fig, 5, "a", "upright_views")


def _elev(cam, ctr):
    """Elevation of a camera above the scene, degrees."""
    v = np.asarray(cam["centre_mm"], float) - ctr
    return float(np.degrees(np.arcsin(v[2] / max(np.linalg.norm(v), 1e-9))))


if __name__ == "__main__":
    main()
