#!/usr/bin/env python3
"""
Fig 1c -- the triangulated 3D, in LUC3D's own viewport, next to the image it came from.

THREE TILES, AND THE ORDER IS THE ARGUMENT: the camera's video, the same camera's
view of the 3D reconstruction, and the whole rig. Reading left to right you can
check the reconstruction against the pixels it was computed from, then see where the
cameras that produced it actually sit.

WHY THE VIEWPORT IS SET TO A REAL CAMERA'S PERSPECTIVE. An arbitrary orbit angle
cannot be checked against anything. Using the app's own "Show Camera View" button
puts the 3D skeletons exactly where that camera's 2D pane shows the animals, so
tiles 1 and 2 are the SAME scene from the SAME viewpoint and the reader can compare
rather than take it on faith.

WHICH WAY IS UP. This rig's calibration frame has +Z pointing DOWN: the overhead
cameras have a SMALLER z than the animals on the floor. Assuming Z-up (the
viewport's default) renders the rig upside down with the animals floating above the
cameras, which is how the first pass of this panel came out. `rigFit()` takes "up"
from the data instead -- whichever Z direction points from the animals toward the
cameras.

FRAMING. The app's own "Show Initial View" fits the scene BOUNDS, which leaves the
animals a few pixels across. `rigFit()` projects the real content, takes its
bounding box in the render, and scales the viewing distance AND pans so that box
fills the frame. Fitting a bounding sphere was tried first and is both loose and
off-centre -- the rig is a flat-ish shell whose centroid is not where the content
lands on screen.

KNOWN DEFECT -- THE PALETTE DOES NOT MATCH PANEL b. The 3D exports were staged
BEFORE `setIdentityPalette()` existed, so they still carry the app's shipped
`IDENTITY_COLORS` (#00ff00 green, #ff00ff magenta, #00ffff cyan) while panel b
carries the colourblind-safe Okabe-Ito palette. Same three animals, two colour
schemes inside one figure -- and the shipped green/magenta pair is exactly the one
that converges under deuteranopia. `setIdentityPalette()` is wired into
`fig2_protocol.mjs` and `fig5_panel_a.mjs` but NOT into `fig1_tracking.mjs`. THE FIX
IS TO RE-STAGE: add `setIdentityPalette(page)` to `fig1_tracking.mjs` AFTER
`trackAll()` (it rewrites `.color` on identities that already exist, so calling it
earlier is a no-op) and re-run the driver. Do not recolour the PNGs.

    python3 figs/panels/fig1_03_reconstruction.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT, load  # noqa: E402
from src.style import INK, SPAN, mm, save, tile, use  # noqa: E402

VIEW_CAM = "Camera0_mid"

#: file, badge, crop bbox in SOURCE pixels (None = use the manifest's own bbox).
#: The 3D tiles are 800x1696 of mostly empty viewport, so they carry explicit crops.
TILES = [
    ("after-f150-Camera0_mid.png", "cam 0 mid: video", None),
    ("fig1b-e-3d-camview-clean.png", "cam 0 mid: 3D", (110, 620, 500, 1010)),
    ("fig1b-d2-3d-rig.png", "rig", (0, 250, 800, 1300)),
]


def main():
    use()
    j = load("fig1.json")
    bbox = None
    for v in j["after"]:
        if v["name"] == VIEW_CAM:
            b = v["bbox"]
            bbox = (b["x0"], b["y0"], b["x1"], b["y1"])

    print("  WARNING: the 3D exports predate setIdentityPalette() — their identity "
          "colours do NOT match panel b. See the docstring.")

    fig, axes = plt.subplots(1, 3, figsize=(mm(SPAN["full"]), mm(38.0)),
                             layout="constrained")
    fig.get_layout_engine().set(rect=(0, 0.11, 1, 0.985))
    for ax, (name, badge, crop) in zip(axes, TILES):
        p = OUT / name
        if not p.exists():
            sys.exit(f"missing figs/out/{name} — run `node figs/fig1_tracking.mjs`")
        tile(ax, p, crop if crop is not None else bbox, badge=badge, pad=0.06,
             corner="lower left")

    fig.text(0.5, 0.05,
             f"{j['stats']['groupsThisFrame']} animals triangulated from "
             f"{j['stats']['nCameras']} cameras · "
             f"{j['stats']['nodes3dFilled']}/{j['stats']['nodes3d']} 3D nodes filled",
             ha="center", va="center", color=INK, fontsize=7)
    save(fig, 1, "c", "reconstruction")


if __name__ == "__main__":
    main()
