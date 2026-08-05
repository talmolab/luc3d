#!/usr/bin/env python3
"""
Fig 1 — System overview, laid out to Nature-family specs (see figs/nature.py).

  a  Pipeline schematic: load videos + calibration -> annotate/predict 2D ->
     cross-view re-ID -> triangulate 3D -> proofread -> export .slp. Drawn with
     icons and a marked contribution span, not a row of captioned boxes.
  b  Cross-view identity on one real frame: per-camera SLEAP tracks (left pair)
     vs LUC3D identities (right pair), for TWO of the eight cameras.
  c  3D reconstruction of that frame: the camera's video, the 3D viewport at that
     same camera's pose and field of view, and the rig.
  d  Comparison with existing tools.

Inputs:
  node figs/fig1_tracking.mjs   -> figs/out/fig1.json + the 2D/3D panels
  node figs/fig1_rig.mjs        -> figs/out/fig1-rig.json + rig-*.png framings

Panel d's cells are FACT CLAIMS ABOUT OTHER SOFTWARE and are marked for checking
against each tool's current docs before submission -- see NEEDS_CHECK below.

Usage: python3 figs/fig1.py [--embed] [--rig NAME]
       node figs/render.mjs figs/out/fig1.svg 600
       python3 figs/lint.py figs/out/fig1.svg      # MUST be 0 failures

HEIGHT IS A HARD CONSTRAINT. Nature Methods allows 180 x 247 mm for artwork PLUS
caption, and this caption runs ~70 mm, so the artwork has to stay near 180 mm.
nature.MAX_H (240 mm) is far too loose to catch that -- figs/lint.py enforces the
real 200 mm ceiling and is the check to trust. The 4x2 before/after grid this panel
b used to draw cost ~45 mm on its own and took the figure to 237 mm.


WHAT IS ALLOWED ON THE ARTWORK
------------------------------
Every number printed on this figure is read from figs/out/fig1.json and is
asserted against the manifest at build time (see `ledger()`). Three annotations
were REMOVED rather than reworded, because they could not meet that bar:

* "5 overhead + 3 side cameras" was derived by substring-matching `top`/`mid`
  against `side` in the camera NAMES. Camera names are not geometry: that rule
  calls `Camera0_mid` overhead, and it is the view shown in b and c. Working the
  real classification out of the calibration is possible -- camera centres are
  `-R^T t` and the optical axis is `R^T [0,0,1]`, which on this rig gives four
  cameras with axes 58-89 deg off horizontal and four at -6 to 21 deg, i.e. 4+4,
  not 5+3 -- but figs/session/ is gitignored and this script must build from
  figs/out/ alone. So the figure now says "8 cameras", which is in the manifest,
  and classifies nothing.
* "15 nodes each" and "3 animals in 3D" were true (`stats.nNodes`,
  `stats.with3dThisFrame`) but unexplained on the panel and absent from the
  caption. They moved to figs/captions/fig1.md.
* "the same animal carries a different track label in every view" is refuted by
  the figure's own data taken over all eight views: three track NAMES are reused
  by unrelated tracks in different cameras (`ledger.collidingNames`), and
  `track_127` even denotes a different animal in cam 1 than in cam 4. The claim
  holds for the two cameras shown and nowhere near strongly enough to print as a
  general statement, so it is a caption sentence with the collisions disclosed.

COUNT: 26, NOT 22. `ledger.detections` = 26 = one per (camera, track) pair = the
number of per-camera track labels a reader would have to reconcile by hand.
`ledger.distinctNames` = 22 is the same set collapsed by name, which is smaller
only by the three coincidental collisions above -- quoting it would understate
the problem by exactly the amount that makes the problem worse. Of the 26, 24
are assigned an identity; the other two are duplicate detections of an animal
that is already matched in that view, and the panel marks them "?", which is the
app's own badge for an unlinked instance.
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nature import (Figure, png_size, text_width, COL2, INK, GREY, FILL,  # noqa: E402
                    ACCENT, ACCENT2, PT)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# Panel b shows TWO of the eight cameras, before and after re-ID. The selection
# rule is stated on the artwork ("2 of 8 views") and in the caption, and it is
# not a best case:
#   * Camera0_mid is the view panel c reconstructs, so b and c are the same frame
#     AND the same camera -- the reader can carry the identities across panels.
#   * Camera7_sideR is one of only TWO views where per-camera tracking returned a
#     FOURTH detection for three animals. That extra detection is the one the
#     re-ID leaves unassigned, so the harder of the two cases is on the page.
# The previous four-camera selection was, unintentionally, four of the six views
# with no unassigned detection. Eight-view grids go to Extended Data; the height
# budget (see the note above) does not fit 4x2 tiles here.
PANEL_CAMS = ["Camera0_mid", "Camera7_sideR"]

# Which rig framing from fig1_rig.mjs to use. Chosen by eye from the sweep: the
# orbit azimuth of a real top camera, 22 degrees above horizontal.
RIG_SHOT = "rig-c4_topR-el22-pad104.png"

# The app's own colour for an unlinked instance (its "?" badge, ui/overlays.js).
UNASSIGNED = "#FBBF24"

# Radius of the "same animal" ring in panel b. Deliberately smaller than the
# animal: these mice are in contact, so a ring sized to the detection box would
# enclose its neighbour too and stop meaning anything.
RING_R = 3.6

# --- panel d ---------------------------------------------------------------
# EVERY non-LUC3D cell here is a claim about someone else's software, written
# from that tool's published paper/docs. Re-checked 2026-08-04; the notes below
# record what each cell rests on, and the caption carries the same qualifications
# in prose. Cells are deliberately CONSERVATIVE: an unsupported "yes" and an
# unsupported "no" are both over-claims.
#
#   SLEAP        multi-camera 3D is real but lives OUTSIDE the GUI, in sleap-io's
#                RecordingSession/FrameGroup/InstanceGroup (the SLP 2.8
#                /session_data LUC3D itself writes) plus sleap-anipose. Cross-view
#                association at annotation time is Maree, Afshar, Oline,
#                Leonardis, Falkner & Pereira (2024), Measuring Behavior 217-224,
#                by exhaustive hypothesis testing -- the method Fig 3 compares
#                against. There is no 3D viewport, so proofreading is 2D.
#   Label3D      README: "GUI for the manual labeling of 3D keypoints in multiple
#                cameras", "supports multiview triangulation of 3D keypoints".
#                Its API takes ONE skeleton struct, and multi-animal labelling is
#                not a documented feature -- so "1 animal", not a checkmark. This
#                is the direct predecessor for reprojection-aided multi-camera 3D
#                labelling and must be cited.
#   JARVIS       AnnotationTool "leverages the multi camera recordings by
#                projecting your manual annotations on a subset of those cameras
#                to the remaining ones" and shows a reprojection error bar -- i.e.
#                exactly the Fig 2a protocol, which is therefore NOT novel here;
#                the browser implementation and the quantification are. No 3D
#                viewport is documented, and simultaneous multi-subject capture is
#                not documented either.
#   DeepLabCut   the 3D module triangulates ONE animal from camera PAIRS; 2D
#                multi-animal (maDLC) is separate from it.
#   Anipose      single-animal pipeline, CLI-driven.
#   DANNCE       multi-animal is SDANNCE. Both infer 3D directly from image
#                volumes, so there is no per-view 2D track set to associate --
#                the "-" in Cross-view ID means "does not arise", and the caption
#                says so rather than letting it read as a deficiency.
NEEDS_CHECK = True
CHECK_DATE = "2026-08-04"
TOOLS = [
    # name, install, runs in, multi-animal, multi-cam 3D, cross-view ID, 3D proofreading
    ("LUC3D (this work)",  "none",       "browser",      True,       True,  True,  True),
    ("SLEAP",              "conda/pip",  "desktop",      True,       "sleap-anipose",
     "Maree et al. 2024", "2D only"),
    ("Label3D",            "MATLAB",     "desktop",      "1 animal", True,  False, True),
    ("JARVIS (HybridNet)", "conda/pip",  "desktop",      "1 animal", True,  False,
     "reproj. error"),
    ("DeepLabCut",         "conda/pip",  "desktop",      True,       "1 animal, pairwise",
     False, False),
    ("Anipose",            "conda/pip",  "CLI",          False,      True,  False, False),
    ("DANNCE / SDANNCE",   "conda/pip",  "CLI + MATLAB", "SDANNCE",  True,  False, False),
]
COLS = ["", "Install", "Runs in", "Multi-animal", "Multi-camera 3D",
        "Cross-view ID", "3D proofreading"]

# title, subtitle, icon, is-a-contribution-of-this-paper
PIPELINE = [
    ("Videos +\ncalibration", "N cameras, .toml",       "cameras",     False),
    ("2D pose",               "predict or\nlabel in app", "skeleton",  False),
    ("Cross-view\nre-ID",     "one identity\nper animal", "ids",       True),
    ("Triangulate",           "DLT, N ≥ 2 views",       "triangulate", True),
    ("Proofread 3D",          "3D + reprojections",     "check",       True),
    ("Export",                ".slp 2.8 / H5",          "file",        False),
]


def load(name):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        sys.exit(f"missing figs/out/{name} -- see the header of this file")
    with open(p) as f:
        return json.load(f)


def view(man, state, cam):
    for v in man[state]:
        if v["name"] == cam:
            return v
    sys.exit(f"camera {cam} not in manifest state {state}")


def ledger(man):
    """
    The association ledger, recomputed here from the per-view detail lists rather
    than trusted from the manifest's summary fields. fig1_tracking.mjs writes both;
    if a future run of the driver ever disagrees with its own detail lists, this
    is where it fails, instead of the figure quietly printing a stale number.
    """
    det = {(v["name"], d["track"]) for v in man["before"] for d in v["details"] if d["track"]}
    names = {d["track"] for v in man["before"] for d in v["details"] if d["track"]}
    ids = sorted({d["identity"] for v in man["after"] for d in v["details"] if d["identity"]})
    assigned = sum(1 for v in man["after"] for d in v["details"] if d["identity"])
    unassigned = [(v["name"], d["track"]) for v in man["after"] for d in v["details"]
                  if not d["identity"]]
    colliding = sorted(n for n in names
                       if sum(1 for v in man["before"]
                              if any(d["track"] == n for d in v["details"])) > 1)
    missing = [v["name"] for v in man["after"]
               if any(not any(d["identity"] == i for d in v["details"]) for i in ids)]
    lg = dict(detections=len(det), distinctNames=len(names), identities=len(ids),
              assigned=assigned, unassigned=unassigned, colliding=colliding,
              viewsMissingAnIdentity=missing)

    # Everything the figure prints, checked before it is printed.
    m = man.get("ledger")
    if m:
        for k in ("detections", "distinctNames", "assigned"):
            if m[k] != lg[k]:
                sys.exit(f"fig1.json ledger.{k}={m[k]} disagrees with the detail "
                         f"lists ({lg[k]}) -- re-run figs/fig1_tracking.mjs")
    if lg["identities"] != man["tracked"]["identities"]:
        sys.exit(f"{lg['identities']} identities in the detail lists but "
                 f"tracked.identities={man['tracked']['identities']}")
    if lg["assigned"] + len(lg["unassigned"]) != lg["detections"]:
        sys.exit("assigned + unassigned != detections; the ledger does not close")
    # "3 identities in all N views" is printed on the artwork, so it is verified,
    # not assumed: every view must carry every identity.
    if lg["viewsMissingAnIdentity"]:
        sys.exit("cannot print 'in all N views': these views are missing an "
                 "identity: " + ", ".join(lg["viewsMissingAnIdentity"]))
    if lg["detections"] <= lg["distinctNames"]:
        print("[note] no track-name collisions in this frame; the caption's "
              "collision sentence must be dropped", file=sys.stderr)
    return lg


def short_id(name):
    """id_0 -> 1. A tile is 43 mm wide; "id_0" printed on a 9 mm mouse is not."""
    tail = str(name).rsplit("_", 1)[-1]
    return str(int(tail) + 1) if tail.isdigit() else str(name)


def dodge(items, min_dy):
    """
    Push apart labels that would overprint. `items` are dicts with x (centre),
    y (baseline) and w (text width); the lower one of a colliding pair moves DOWN.
    Two mice in contact is the normal case in this data, not the exception, so
    their labels land on top of each other unless something separates them.
    """
    placed = []
    for it in sorted(items, key=lambda d: d["y"]):
        for _ in range(12):
            hit = next((p for p in placed
                        if abs(it["x"] - p["x"]) < (it["w"] + p["w"]) / 2 + 0.3
                        and abs(it["y"] - p["y"]) < min_dy), None)
            if hit is None:
                break
            it["y"] = hit["y"] + min_dy
        placed.append(it)
    return items


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", action="store_true",
                    help="inline PNGs as data URIs (self-contained, large file)")
    ap.add_argument("--rig", default=RIG_SHOT)
    args = ap.parse_args()
    man = load("fig1.json")
    rigman = load("fig1-rig.json")
    lg = ledger(man)
    ncam = man["stats"]["nCameras"]
    E = args.embed

    W = COL2
    f = Figure(width=W, height=210.0)
    M = 0.0                    # figure margin: journals crop to the artwork
    y = 3.2

    # ================================================================= a =====
    f.panel(M, y, "a")
    f.text(M + 5.0, y, "Pipeline", size=7, weight="bold")
    y += 2.4

    n = len(PIPELINE)
    gap = 4.4
    bw = (W - (n - 1) * gap) / n
    bh = 17.6
    xs = []
    for i, (title, sub, ic, mine) in enumerate(PIPELINE):
        bx = M + i * (bw + gap)
        xs.append((bx, bx + bw))
        f.stage(bx, y, bw, bh, title, sub=sub, icon_kind=ic,
                fill="#FFFFFF" if mine else FILL,
                accent=ACCENT if mine else None)
        if i:
            f.chevron(xs[i - 1][1] + (gap - 2.2) / 2, y + bh / 2, 3.0)

    # The three stages this paper contributes, bracketed underneath. The bracket
    # used to carry a full sentence naming them; the bracket already names them by
    # spanning them, and the sentence is in the caption.
    yb = y + bh + 1.4
    f.bracket(xs[2][0], xs[4][1], yb, "this work", size=6, color=ACCENT, depth=1.1)
    y = yb + 5.0

    # ================================================================= b =====
    f.panel(M, y, "b")
    f.text(M + 5.0, y, "Cross-view re-identification", size=7, weight="bold")
    f.text(M + W, y, f"{len(PANEL_CAMS)} of {ncam} views", size=6, anchor="end",
           fill=GREY)
    y += 2.2

    # One row, two groups of two: the same two cameras before and after. A 4x2
    # grid of the same tiles was 48 mm taller and said nothing extra -- the
    # before/after contrast is between the GROUPS, so it reads across, not down.
    nc = len(PANEL_CAMS)
    g_in, g_mid = 1.6, 8.0
    tw = (W - 2 * (nc - 1) * g_in - g_mid) / (2 * nc)
    th = tw * 0.80

    groups = [("before", "per-camera tracks"), ("after", "LUC3D identities")]

    # Follow ONE animal across the views. Which detection that is in the tracks
    # tiles is not guessable from the track label -- it is looked up through the
    # identity the tracker later assigned to that same track, so the ring marks
    # the same physical mouse in both views by construction.
    follow_id = sorted({d["identity"] for v in man["after"] for d in v["details"]
                        if d["identity"]})[0]
    follow_track = {}
    for cam in PANEL_CAMS:
        for d in view(man, "after", cam)["details"]:
            if d["identity"] == follow_id:
                follow_track[cam] = d["track"]

    hdr_y = y + 6 * PT
    ty = hdr_y + 1.6
    for gi, (state, glabel) in enumerate(groups):
        gx = M + gi * (nc * tw + (nc - 1) * g_in + g_mid)
        gw = nc * tw + (nc - 1) * g_in
        f.text(gx + gw / 2, hdr_y, glabel, size=6.5, weight="bold", anchor="middle")
        for ci, cam in enumerate(PANEL_CAMS):
            v = view(man, state, cam)
            x = gx + ci * (tw + g_in)
            # BOTH tiles of a camera are framed by the BEFORE bbox. The exporter
            # computes each state's bbox from that state's own detections, so a run
            # where re-ID drops a detection near the edge would frame the two tiles
            # differently and the reader could no longer compare them pixel for
            # pixel -- which is the whole basis of the before/after claim.
            b = view(man, "before", cam)["bbox"]
            f.image(x, ty, tw, th, os.path.join(OUT, os.path.basename(v["file"])),
                    crop=(b["x0"], b["y0"], b["x1"], b["y1"]),
                    src_size=(v["width"], v["height"]), embed=E,
                    label=cam.replace("Camera", "cam ").replace("_", " "),
                    label_size=5.5)
            crop = f.last_crop            # actual crop after aspect fit + clamp
            scale = tw / (crop[2] - crop[0])

            def to_mm(px, py):
                return x + (px - crop[0]) * scale, ty + (py - crop[1]) * scale

            # The label each animal carries IN THIS VIEW: a per-camera track label
            # on the left, the global identity on the right. An unassigned
            # detection gets "?" -- the app's own badge for an unlinked instance.
            # Mark the followed animal in the tracks tiles. A ring, not a leader:
            # the two views disagree about the label, which is the point, and a
            # leader from outside the tile would have to cross the other animals.
            ringed = follow_track.get(cam) if state == "before" else None
            labs = []
            for d in v["details"]:
                if state == "before":
                    nm, fill = d["track"].replace("track_", "t"), d["color"] or "#FFFFFF"
                elif d["identity"]:
                    nm, fill = short_id(d["identity"]), d["color"] or "#FFFFFF"
                else:
                    nm, fill = "?", UNASSIGNED
                cx, cy = to_mm(*d["centroid"])
                if not (x - 1 <= cx <= x + tw + 1 and ty - 1 <= cy <= ty + th + 1):
                    continue
                if d["track"] == ringed:
                    f.ring(cx, cy, RING_R, color=ACCENT2, sw=0.5, dash="0.9,0.7")
                    cy -= RING_R + 0.4      # clear of the ring, not inside it
                labs.append(dict(x=cx, y=cy - 0.9, w=text_width(nm, 5.8, "bold"),
                                 s=nm, fill=fill))
            for it in dodge(labs, 5.8 * PT * 1.25):
                f.text(it["x"], min(max(it["y"], ty + 2.2), ty + th - 0.8), it["s"],
                       size=5.8, anchor="middle", fill=it["fill"], weight="bold",
                       halo="#000000")

    # The transition is between the two GROUPS, so it is marked in the gap between
    # them. A full-width rule was tried and it reads as a boundary between panels
    # b and c, not as a step inside b.
    gmx = M + nc * tw + (nc - 1) * g_in
    f.chevron(gmx + g_mid / 2 - 1.4, ty + th / 2, 4.6, w=2.8, color=ACCENT, sw=0.9)
    f.runs(M + W / 2, ty + th + 4.4, [
        ("cross-view re-ID (Track All)", 6.5, "bold", INK),
        (f"{lg['detections']} per-camera track labels in {ncam} views → "
         f"{lg['identities']} identities, one per animal in every view "
         f"({lg['assigned']} of {lg['detections']} assigned)", 6, "normal", GREY),
    ], anchor="middle", gap=2.2)
    y = ty + th + 8.0

    # ================================================================= c =====
    f.panel(M, y, "c")
    f.text(M + 5.0, y, "Triangulated 3D", size=7, weight="bold")
    y += 2.2

    vcam = man["viewCam"]
    v2d = view(man, "after", vcam)
    b = v2d["bbox"]

    # --- the rig tile's crop, computed BEFORE the row is laid out ----------
    # Cropped to the CONTENT (every camera plus the animals) rather than shown
    # whole: the 3D scene is mostly empty space, which is what made the first pass
    # of this panel an almost-black box. rigFit() reports where each camera and the
    # animals landed in the render, so the crop is computed from the same
    # projection instead of being placed by hand. The content already spans ~78% of
    # the render in each direction -- the remaining black is BETWEEN the frustums
    # and no crop can remove it, which is why this is the smallest tile in the row
    # and carries no printed annotation.
    #
    # The tile's WIDTH is then derived from that crop's aspect. nature.image()
    # expands a crop to the tile's aspect and CLAMPS at the image edge; when the
    # expansion does not fit (this crop needs 2,962 of 2,560 available rows for a
    # portrait tile) the clamp silently returns a differently-shaped crop and the
    # tile is left part empty -- a 6.6 mm white band under the rig, which is what
    # the first pass of this row rendered. Sizing the tile to the content instead
    # means there is nothing to expand.
    shot = next((s for s in rigman["shots"] if s["name"] == args.rig), None)
    if shot is None:
        sys.exit(f"rig shot {args.rig} not in fig1-rig.json; have: "
                 + ", ".join(s["name"] for s in rigman["shots"]))
    if shot["nCams"] != ncam:
        sys.exit(f"rig shot has {shot['nCams']} cameras, manifest has {ncam}")
    rigpath = os.path.join(OUT, shot["name"])
    rw, rh = png_size(rigpath)
    px = rw / shot["pane"][0]          # render is at deviceScaleFactor 2
    pts = [(c["x"] * px, c["y"] * px) for c in shot["camScreen"]]
    pts.append((shot["animalsScreen"]["x"] * px, shot["animalsScreen"]["y"] * px))
    padpx = 0.030 * rw
    rx = [min(p[0] for p in pts) - padpx, max(p[0] for p in pts) + padpx]
    ry = [min(p[1] for p in pts) - padpx, max(p[1] for p in pts) + padpx * 1.6]
    rx = [max(0.0, rx[0]), min(float(rw), rx[1])]
    ry = [max(0.0, ry[0]), min(float(rh), ry[1])]
    rig_ar = (rx[1] - rx[0]) / (ry[1] - ry[0])

    gap_c = 2.0
    ch = 46.0
    rig_w = round(min(max(ch * rig_ar, 34.0), 62.0), 2)
    cw = (W - 2 * gap_c - rig_w) / 2
    if abs(rig_w / ch - rig_ar) > 0.02:
        print(f"[warn] rig tile aspect {rig_w / ch:.3f} != content {rig_ar:.3f}; "
              f"nature.image will letterbox or crop content", file=sys.stderr)
    f.image(M, y, cw, ch, os.path.join(OUT, os.path.basename(v2d["file"])),
            crop=(b["x0"], b["y0"], b["x1"], b["y1"]),
            src_size=(v2d["width"], v2d["height"]), embed=E,
            label=vcam.replace("Camera", "cam ").replace("_", " ") + ": video",
            label_size=5.5)
    crop = f.last_crop
    cscale = cw / (crop[2] - crop[0])
    labs = []
    for d in v2d["details"]:
        nm = short_id(d["identity"]) if d["identity"] else "?"
        fill = (d["color"] or "#FFFFFF") if d["identity"] else UNASSIGNED
        cx = M + (d["centroid"][0] - crop[0]) * cscale
        cy = y + (d["centroid"][1] - crop[1]) * cscale
        if M - 1 <= cx <= M + cw + 1 and y - 1 <= cy <= y + ch + 1:
            labs.append(dict(x=cx, y=cy - 0.9, w=text_width(nm, 5.8, "bold"),
                             s=nm, fill=fill))
    for it in dodge(labs, 5.8 * PT * 1.25):
        f.text(it["x"], min(max(it["y"], y + 2.2), y + ch - 0.8), it["s"], size=5.8,
               anchor="middle", fill=it["fill"], weight="bold", halo="#000000")

    # The 3D pane was set to this camera's perspective AND its aspect ratio, so the
    # projection matches the 2D tile -- which means the SAME NORMALISED CROP frames
    # the animals identically in both. Uncropped, the 3D tile shows the whole sensor
    # while the 2D tile is zoomed, and the reader cannot compare them.
    ncrop = f.last_norm_crop
    cam3d = os.path.join(OUT, "tri3d-camview.png")
    w3, h3 = png_size(cam3d)
    f.image(M + cw + gap_c, y, cw, ch, cam3d, embed=E,
            crop=(ncrop[0] * w3, ncrop[1] * h3, ncrop[2] * w3, ncrop[3] * h3),
            src_size=(w3, h3),
            label=vcam.replace("Camera", "cam ").replace("_", " ") + ": 3D",
            label_size=5.5)

    # --- the rig tile (crop computed above, with the row's geometry) --------
    rx0 = M + 2 * (cw + gap_c)
    f.image(rx0, y, rig_w, ch, rigpath, crop=(rx[0], ry[0], rx[1], ry[1]),
            src_size=(rw, rh),
            embed=E, label="rig", label_size=5.5)
    # NO printed camera count and NO ring, both of which this tile used to carry.
    # The count: two of the eight frustums project within 1.6 mm of each other at
    # every elevation in the sweep, so a reader counts seven and the tile appears to
    # contradict itself; the eight is in the caption, where the coincidence can be
    # stated. The ring: rigFit() reports only the animals' CENTROID, and the three
    # of them span ~17 mm in this tile, so a ring drawn at that point either
    # encircles one animal and excludes the other two or is so large it means
    # nothing. Their identity colours already separate them from the frustums.
    y += ch + 4.2

    # ================================================================= d =====
    f.panel(M, y, "d")
    f.text(M + 5.0, y, "Capability comparison", size=7, weight="bold")
    y += 3.0

    rows_t = [list(t) for t in TOOLS]
    end = f.table(M, y, W, COLS, rows_t,
                  col_w=[38.0] + [(W - 38.0) / 6] * 6,
                  header_size=6, cell_size=5.6, row_h=4.8)
    if NEEDS_CHECK:
        print(f"[warn] fig1d third-party rows verified {CHECK_DATE}; re-check before "
              f"submission", file=sys.stderr)
    end = f.text(M, end + 2.8,
                 f"Third-party capabilities from published documentation, "
                 f"checked {CHECK_DATE}; qualifications in the caption.",
                 size=5.4, fill=GREY) + 1.0

    f.height = round(end + 3.0, 1)
    f.write(os.path.join(OUT, "fig1.svg"))
    print(f"[fig1] ledger: {lg['detections']} detections / per-camera track labels, "
          f"{lg['distinctNames']} distinct names (collisions: "
          f"{', '.join(lg['colliding']) or 'none'}), {lg['identities']} identities, "
          f"{lg['assigned']} assigned, unassigned: "
          f"{', '.join(a + '/' + b for a, b in lg['unassigned']) or 'none'}")


if __name__ == "__main__":
    main()
