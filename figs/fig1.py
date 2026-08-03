#!/usr/bin/env python3
"""
Fig 1 — System overview, laid out to Nature-family specs (see figs/nature.py).

  a  Pipeline: load videos + calibration -> annotate/predict 2D -> cross-view
     re-ID -> triangulate 3D -> proofread -> export .slp. Browser-only, no install.
  b  Cross-view identity on one real frame: per-camera SLEAP tracks (top row) vs
     LUC3D identities (bottom row), same four cameras, same frame. The numbers in
     the annotation come from figs/out/fig1.json, i.e. from the run itself.
  c  3D reconstruction of that frame: the camera's 2D view, the 3D viewport at
     that same camera's perspective, and the rig with all 8 frustums.
  d  Comparison with existing tools.

Inputs come from `node figs/fig1_tracking.mjs` (writes figs/out/fig1.json + PNGs).
Panel d's cells are FACT CLAIMS ABOUT OTHER SOFTWARE and are marked for checking
against each tool's current docs before submission -- see NEEDS_CHECK below.

Usage: python3 figs/fig1.py [--embed]
       node figs/render.mjs figs/out/fig1.svg 600
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nature import (Figure, png_size, COL2, INK, GREY, LIGHT, FILL, ACCENT,
                    ACCENT2, PT)  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# Panel b/c use four cameras: two overhead, two side, so the reader sees that the
# same identity holds across very different viewpoints.
PANEL_CAMS = ["Camera0_mid", "Camera1_topB", "Camera4_topR", "Camera6_sideL"]

# --- panel d ---------------------------------------------------------------
# EVERY non-LUC3D cell here is a claim about someone else's software. They are
# written from the tools' published papers/docs, but versions move: verify before
# submission and date the check in the caption.
NEEDS_CHECK = True
TOOLS = [
    # name,                    install,          runs in,         multi-animal, multi-cam 3D, built-in cross-view ID, proofread 3D
    ("LUC3D (this work)",      "none",           "browser",       True,  True,  True,  True),
    ("SLEAP",                  "conda/pip",      "desktop",       True,  False, False, False),
    ("DeepLabCut",             "conda/pip",      "desktop",       True,  "via 3D module", False, False),
    ("Anipose",                "conda/pip",      "CLI",           False, True,  False, False),
    ("DANNCE",                 "conda/pip",      "CLI + MATLAB",  True,  True,  False, False),
    ("JARVIS (HybridNet)",     "conda/pip",      "desktop",       True,  True,  False, False),
]
COLS = ["", "Install", "Runs in", "Multi-animal", "Multi-camera 3D",
        "Cross-view ID", "3D proofreading"]

PIPELINE = [
    ("Videos +\ncalibration", "N cameras, .toml"),
    ("2D pose", "SLEAP / sleap-nn\nor label in app"),
    ("Cross-view\nre-ID", "one identity\nper animal"),
    ("Triangulate", "DLT, N≥2 views"),
    ("Proofread", "3D + reprojections"),
    ("Export", ".slp 2.8 / H5"),
]


def load():
    p = os.path.join(OUT, "fig1.json")
    if not os.path.exists(p):
        sys.exit("missing figs/out/fig1.json -- run: node figs/fig1_tracking.mjs")
    with open(p) as f:
        return json.load(f)


def view(man, state, cam):
    for v in man[state]:
        if v["name"] == cam:
            return v
    sys.exit(f"camera {cam} not in manifest state {state}")


def rel(path):
    """URL for the renderer: SVG lives in figs/out/, so tiles are siblings."""
    return os.path.basename(path)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", action="store_true",
                    help="inline PNGs as data URIs (self-contained, large file)")
    args = ap.parse_args()
    man = load()
    E = args.embed

    W = COL2
    f = Figure(width=W, height=196.0)
    M = 0.0                    # figure margin: journals crop to the artwork
    y = 0.0

    # ================================================================= a =====
    y = 3.2
    f.panel(M, y, "a")
    f.text(M + 5.0, y, "Browser-based multi-view 3D annotation: no installation",
           size=7, weight="bold")
    y += 2.2

    bw, bh, gap = 25.0, 11.5, 5.6
    bx = M
    boxes = []
    for i, (title, sub) in enumerate(PIPELINE):
        lines = title.split("\n")
        f.rect(bx, y, bw, bh, fill=FILL, stroke=INK, rx=0.8)
        ty = y + bh / 2 - (len(lines) - 1) * 1.1 - 0.6
        for ln in lines:
            f.text(bx + bw / 2, ty, ln, size=6.5, anchor="middle", weight="bold")
            ty += 2.2
        sy = ty + 0.1
        for ln in sub.split("\n"):
            f.text(bx + bw / 2, sy, ln, size=5.5, anchor="middle", fill=GREY)
            sy += 1.9
        boxes.append((bx, bx + bw))
        if i:
            f.arrow(boxes[i - 1][1] + 0.9, y + bh / 2, bx - 0.9, y + bh / 2,
                    color=INK, sw=0.5 * PT, head=1.9)
        bx += bw + gap

    # The two stages this paper contributes, bracketed underneath.
    x0 = boxes[2][0]
    x1 = boxes[4][1]
    yb = y + bh + 1.4
    f.line(x0, yb, x1, yb, sw=0.5 * PT)
    f.line(x0, yb, x0, yb - 1.0, sw=0.5 * PT)
    f.line(x1, yb, x1, yb - 1.0, sw=0.5 * PT)
    f.text((x0 + x1) / 2, yb + 2.4, "this work: cross-view re-ID + 3D proofreading in the browser",
           size=6, anchor="middle", fill=ACCENT)
    y = yb + 4.0

    # ================================================================= b =====
    f.panel(M, y + 1.0, "b")
    f.text(M + 5.0, y + 1.0,
           "Per-camera tracks carry no identity across views; LUC3D's cross-view re-ID does",
           size=7, weight="bold")
    y += 3.0

    n = len(PANEL_CAMS)
    tw = (W - (n - 1) * 2.0) / n
    th = tw * 0.80
    lab_w = 15.0

    rows = [
        ("before", "per-camera tracks", ACCENT2),
        ("after", "LUC3D identities", ACCENT),
    ]
    # Follow ONE animal across the four views. Which detection that is in the
    # BEFORE tiles is not guessable from the track label -- it is looked up through
    # the identity the tracker later assigned to that same track, so the arrows
    # point at the same physical mouse by construction.
    follow_id = "id_0"
    follow_track = {}
    for cam in PANEL_CAMS:
        for d in view(man, "after", cam)["details"]:
            if d["identity"] == follow_id:
                follow_track[cam] = d["track"]

    row_y = []
    for ri, (state, rowlabel, col) in enumerate(rows):
        ry = y + ri * (th + 5.0)
        row_y.append(ry)
        for ci, cam in enumerate(PANEL_CAMS):
            v = view(man, state, cam)
            x = M + ci * (tw + 2.0)
            b = v["bbox"]
            f.image(x, ry, tw, th, os.path.join(OUT, os.path.basename(v["file"])),
                    crop=(b["x0"], b["y0"], b["x1"], b["y1"]),
                    src_size=(v["width"], v["height"]), embed=E,
                    label=cam.replace("Camera", "cam ").replace("_", " "),
                    label_size=5.5)
            crop = f.last_crop            # actual crop after aspect fit + clamp
            scale = tw / (crop[2] - crop[0])

            def to_mm(px, py):
                return x + (px - crop[0]) * scale, ry + (py - crop[1]) * scale

            # The label each animal carries IN THIS VIEW, drawn on the animal.
            # In the top row these are per-camera track labels and every view uses
            # a different one; in the bottom row they are the global identities and
            # every view uses the same three.
            for d in v["details"]:
                nm = d["track"] if state == "before" else d["identity"]
                if not nm:
                    continue
                cx, cy = to_mm(*d["centroid"])
                if not (x - 1 <= cx <= x + tw + 1 and ry - 1 <= cy <= ry + th + 1):
                    continue
                f.text(cx, cy - 0.8, nm.replace("track_", "t"), size=5.5,
                       anchor="middle", fill=d["color"] or "#FFFFFF", weight="bold",
                       halo="#000000")

            # The follow-one-animal callout, on the top row only.
            if state == "before" and cam in follow_track:
                for d in v["details"]:
                    if d["track"] != follow_track[cam]:
                        continue
                    cx, cy = to_mm(*d["centroid"])
                    f.arrow(cx, ry + th + 3.4, cx, min(cy + 2.2, ry + th - 0.5),
                            color=ACCENT2, sw=0.45 * PT, head=1.8)
                    f.text(cx, ry + th + 4.6, d["track"].replace("track_", "t"),
                           size=5.5, anchor="middle", fill=ACCENT2, weight="bold")
        # row label, rotated on the left edge of the block
        f.text(M - 1.2, ry + th / 2, rowlabel, size=6, anchor="middle",
               fill=col, rotate=-90)

    # Caption for the callout row, then the transition arrow, in the gap.
    gap_y = row_y[0] + th + 4.6
    f.text(M + W, gap_y, "← one animal, a different track label in every view",
           size=6, anchor="end", fill=ACCENT2)
    mid_y = gap_y + 2.6
    f.arrow(M + 22.0, mid_y, M + 34.0, mid_y, color=INK, sw=0.6 * PT, head=2.2)
    f.text(M + 35.5, mid_y + 0.7, "cross-view re-ID (Track All):", size=6.5, weight="bold")
    f.text(M + 79.0, mid_y + 0.7,
           f"{man['distinctTrackNames']} per-camera track labels → "
           f"{man['tracked']['identities']} identities, consistent across all "
           f"{man['stats']['nCameras']} views", size=6, fill=GREY)

    y = row_y[1] + th + 4.0

    # ================================================================= c =====
    f.panel(M, y + 1.0, "c")
    f.text(M + 5.0, y + 1.0,
           "Triangulated 3D, checked against the view it came from", size=7, weight="bold")
    y += 3.0

    vcam = man["viewCam"]
    v2d = view(man, "after", vcam)
    b = v2d["bbox"]
    cw = (W - 2 * 2.0) / 3
    ch = cw * 0.80
    f.image(M, y, cw, ch, os.path.join(OUT, os.path.basename(v2d["file"])),
            crop=(b["x0"], b["y0"], b["x1"], b["y1"]),
            src_size=(v2d["width"], v2d["height"]), embed=E,
            label=vcam.replace("Camera", "cam ").replace("_", " ") + "  (2D)", label_size=5.5)

    # The 3D pane was set to this camera's perspective AND its aspect ratio, so the
    # projection matches the 2D tile -- which means the SAME NORMALISED CROP frames
    # the animals identically in both. Uncropped, the 3D tile shows the whole sensor
    # while the 2D tile is zoomed, and the reader cannot compare them.
    nc = f.last_norm_crop
    cam3d = os.path.join(OUT, "tri3d-camview.png")
    w3, h3 = png_size(cam3d)
    f.image(M + cw + 2.0, y, cw, ch, cam3d, embed=E,
            crop=(nc[0] * w3, nc[1] * h3, nc[2] * w3, nc[3] * h3), src_size=(w3, h3),
            label="3D, same camera perspective + crop", label_size=5.5)

    rig = os.path.join(OUT, "tri3d-rig.png")
    wr, hr = png_size(rig)
    f.image(M + 2 * (cw + 2.0), y, cw, ch, rig, embed=E, src_size=(wr, hr),
            label="rig: 8 calibrated views", label_size=5.5)
    y += ch + 2.4
    f.text(M, y,
           f"{man['stats']['with3dThisFrame']} animals triangulated from "
           f"{man['stats']['nCameras']} views ({man['stats']['nNodes']} nodes each); "
           f"the 3D viewport is set to {vcam.replace('Camera', 'cam ')}'s own perspective, "
           f"so 3D and 2D are directly comparable.", size=6, fill=GREY)
    y += 4.0

    # ================================================================= d =====
    f.panel(M, y + 1.0, "d")
    f.text(M + 5.0, y + 1.0, "Comparison with existing tools", size=7, weight="bold")
    y += 3.4

    rows_t = []
    for name, inst, runs, ma, mc, xv, pr in TOOLS:
        rows_t.append([name, inst, runs, ma, mc, xv, pr])
    end = f.table(M, y, W, COLS, rows_t,
                  col_w=[38.0] + [(W - 38.0) / 6] * 6,
                  header_size=6, cell_size=6, row_h=3.6)
    if NEEDS_CHECK:
        f.text(M, end + 3.0,
               "Rows other than LUC3D describe third-party software and MUST be "
               "re-verified against current docs before submission.",
               size=5.5, fill=ACCENT2, italic=True)
        end += 3.0

    f.height = round(end + 4.0, 1)
    f.write(os.path.join(OUT, "fig1.svg"))


if __name__ == "__main__":
    main()
