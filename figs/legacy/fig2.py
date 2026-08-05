#!/usr/bin/env python3
"""
Fig 2 — Reprojection-aided labelling, laid out to Nature-family specs.

  a  The protocol, staged in the real app: label two anchor views -> triangulate
     from ONLY those two -> the 3D point is drawn back into every other view as a
     dotted reprojection -> accept it or nudge it. The geometry that makes this work
     is drawn abstractly alongside the real tiles it produces.
  b  Annotation scaling: manual keypoint placements per frame against the number of
     cameras. Traditional labelling is linear in cameras (C x N); reprojection-aided
     labelling is essentially constant (2N + a measured correction term).
  c  What accepting a reprojection costs. Left: where the reprojection lands in the
     views that were NOT labelled. Right: two-view 3D error against the angle the
     anchor pair subtends AT THE ANIMAL, with the depth-uncertainty law k/sin(theta)
     overlaid -- so the reader sees which pairs the law explains and which it does not.

WHAT IS REAL HERE, AND WHAT IS MODELLED
---------------------------------------
* Panel a is the app, driven by figs/fig2_protocol.mjs, on the 8-camera session.
  The two-view solve is a genuine two-view solve: the other six cameras are set to
  weight 0 in the app's own Camera Views panel, so they cannot contribute. The px
  numbers quoted in the panel are that run's own reprojection errors.
* Panels b and c are MEASURED on real proofread multi-camera data -- 50 BMimica
  sessions, 5 calibrated cameras, 2 mice, 15 nodes, 1,277,424 keypoints
  (figs/fig2_measure.py -> fig2.json). EVERY session enters EVERY panel; no panel
  uses a subset. In b, p is measured on real camera subsets of a 5-camera rig, so
  only C <= 5 is measured -- the shaded band says so and markers stop at C = 5.
  Beyond that the two curves are the model, and the ratio printed on the artwork is
  the one at the MEASURED rig size (C = 5). The C = 8 number lives in the caption,
  flagged as model.
* The one modelled quantity is the placement COUNT itself. Wall-clock labelling time
  was not measured -- there is no such data for this app -- so b reports placements,
  which is what the protocol actually changes, and says so on the axis.
* Bone-length variance was tried as the 3D-consistency metric first (it is the
  obvious choice) and it barely discriminates: mean coefficient of variation over
  700 session x edge pairs is 0.156 for independently-estimated per-view 2D versus
  0.150 for the proofread 3D (a 3.7% relative reduction, lower on 613/700 edges),
  because at this scale bone length is dominated by real animal deformation, not by
  labelling error. Panel c therefore reports per-keypoint reprojection error and 3D
  error, which do separate the conditions. This is recorded here so the choice is
  not mistaken for cherry-picking.

WHY c-RIGHT IS A 1/sin CURVE AND NOT A STRAIGHT LINE
----------------------------------------------------
An earlier draft drew a least-squares STRAIGHT line through the ten pairs and its
caption implied a clean monotone relationship. Both are wrong. The depth uncertainty
of a two-ray intersection goes as 1/sin(theta), so a line is the wrong model, and the
relationship is not monotone: two pairs sit far above the law. `k` is estimated
ROBUSTLY as median(err * sin(theta)) = 1.52 mm, under which 8 of 10 pairs fall inside
+-25% (the shaded band); the plain least-squares k = 1.87 mm puts only 5 of 10 inside,
which is why the robust estimator is used and named. The two exceptions are exactly
the two pairs that contain camera 2 -- the farthest camera, 1.32 m from the animals
against ~1.0 m for the other four (recoverable from `cameras_xyz` + `baseline_deg` in
fig2.json) -- so a narrow angle and a coarse mm-per-pixel compound there. They are
drawn as OPEN markers and named, rather than being smoothed over by a trend line.
Nothing here is rig-DESIGN evidence: no camera was ever moved, all ten points come
from one fixed geometry with shared cameras and one calibration, and the range is only
13-31 deg. That argument belongs in the Discussion and is kept off the artwork.

Usage: python3 figs/fig2.py [--embed]
       node figs/render.mjs figs/out/fig2.svg 600
"""
import argparse
import html
import json
import math
import os
import re
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nature import (Figure, png_size, text_width, esc, COL2, FONT, INK, GREY,  # noqa: E402
                    LIGHT, FILL, ACCENT, ACCENT2, PT)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

NODES = 15                     # skeleton size in the measured dataset
# The tolerance at which a labeller accepts a reprojection untouched.
#
# This was 20.0 px, justified as "the app's own reprojSigma default" -- which was wrong
# twice. `ui/settings.js:246` reprojSigma is not an accept threshold at all: it is the
# Gaussian width in the TRACKER's OKS cross-view matching score (pose/tracker.js:143,
# exp(-d^2 / 2*sigma^2)), so a residual sitting AT 20 px scores exp(-0.5) = 0.61 rather
# than being accepted. Borrowing that constant as tau imported a number that means
# something else.
#
# 10 px is justified on its own terms: the fully-informed reference 3D's own reprojection
# error is 1.88 px (median, fig4.json reference_reproj_px.p50), so 10 px is ~5x the error
# the reference itself carries, and 94.6% of reprojections land inside it. It also costs
# almost nothing: the saving has a hard ceiling of C/2 = 2.5x however generous tau gets,
# because two views are always placed by hand, and tau = 10 already reaches 92% of that
# ceiling (2.31x against 2.49x at tau = 20). tau = 5 px is drawn alongside so the
# sensitivity is visible: 1.56x, still a saving, on a threshold nobody can call generous.
TAU_MAIN = 10.0
TAU_STRICT = 5.0
CMAX = 8                       # extend the scaling model out to an 8-camera rig
GREEN = "#009E73"              # Okabe-Ito bluish green, for the "aided" condition


def load(name):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        sys.exit(f"missing figs/out/{name} -- see the header of this file")
    with open(p) as f:
        return json.load(f)


def med(vals):
    return st.median(vals) if vals else float("nan")


def pull(ps, path, key):
    """Collect one statistic across sessions, skipping any session missing it."""
    out = []
    for s in ps:
        o = s
        try:
            for p in path:
                o = o[p]
            out.append(o[key])
        except (KeyError, TypeError):
            pass
    return out


_TXT = re.compile(
    r'<text x="(-?[\d.]+)" y="(-?[\d.]+)" text-anchor="(\w+)"[^>]*'
    r'font-size:([\d.]+);font-weight:(\w+)[^>]*>(.*?)</text>')


def check_width(f, limit=COL2, pad=0.15):
    """
    Every un-rotated text run measured against the trim edge, with the real Arial
    metrics. A 5.4 pt annotation in c ran to 180.3 mm and was CLIPPED in the render
    without anything failing -- the figure just silently lost the end of a sentence.
    Fails loudly instead.
    """
    bad = []
    for p in f.parts:
        m = _TXT.match(p)
        if not m or "rotate(" in p:
            continue
        x, _, anchor, fs, weight, body = m.groups()
        x, size = float(x), float(fs) / PT
        w = text_width(html.unescape(body), size, weight)
        x0 = x if anchor == "start" else (x - w / 2 if anchor == "middle" else x - w)
        if x0 < -pad or x0 + w > limit + pad:
            bad.append((round(x0, 1), round(x0 + w, 1), html.unescape(body)))
    if bad:
        for a, b, s in bad:
            print(f"  [overflow] {a}..{b} mm: {s!r}")
        raise SystemExit(f"fig2: {len(bad)} text run(s) outside 0..{limit:.0f} mm")


def ylabel_rot(f, x, cy, lines, size=6.5, fill=INK):
    """
    Multi-line rotated y-axis label. nature.py's axes() draws one line, and
    "manual placements per animal per frame" as a single 44 mm run reaches up past
    the axes and collides with the panel letter above it.
    """
    # rotate(-90) maps "up" to "left", so the FIRST line has to be the leftmost
    # column or the label reads bottom-up in the wrong order.
    for i, ln in enumerate(lines):
        xx = x - (len(lines) - 1 - i) * size * PT * 1.20
        f.add(f'<text x="{xx:.3f}" y="{cy:.3f}" text-anchor="middle" fill="{fill}" '
              f'style="font-family:{FONT};font-size:{size * PT:.3f}" '
              f'transform="rotate(-90 {xx:.3f} {cy:.3f})">{esc(ln)}</text>')


def hkey(f, x, y, items, size=5.2, swatch=2.6, gap=3.4):
    """Horizontal colour key on one line: [(label, colour, dash), ...]."""
    for lab, col, dash in items:
        f.line(x, y - 0.55, x + swatch, y - 0.55, stroke=col, sw=0.9 * PT,
               cap="round", dash=dash)
        f.text(x + swatch + 0.8, y, lab, size=size)
        x += swatch + 0.8 + text_width(lab, size) + gap
    return x


def geometry(f, x, y, w, h):
    """
    The abstract reason the protocol works, drawn rather than asserted: two labelled
    views define one 3D point by intersection; that point then has a determined
    image in every other calibrated view, so those views do not need to be labelled
    -- they need to be CHECKED.
    """
    # 3D point sits right-of-centre so the outgoing dashed rays have room.
    px, py = x + w * 0.50, y + h * 0.46
    cam_w = 3.0
    anchors = [(x + 0.4, y + h * 0.10), (x + 0.4, y + h * 0.74)]
    others = [(x + w - cam_w - 0.4, y + h * 0.02),
              (x + w - cam_w - 0.4, y + h * 0.40),
              (x + w - cam_w - 0.4, y + h * 0.78)]
    for (cx, cy) in anchors:
        f.icon("camera", cx, cy, s=cam_w, color=INK, sw=0.5)
        f.line(cx + cam_w, cy + cam_w / 2, px, py, stroke=INK, sw=0.55 * PT)
    for (cx, cy) in others:
        f.icon("camera", cx, cy, s=cam_w, color=GREY, sw=0.45)
        f.line(px, py, cx, cy + cam_w / 2, stroke=GREEN, sw=0.5 * PT, dash="0.9,0.7")
    f.marker(px, py, color=ACCENT2, r=0.75, sw=0.25)
    f.text(px, py - 1.5, "3D", size=5.3, anchor="middle", fill=ACCENT2, weight="bold")
    f.text(x + 0.4, y + h + 1.6, "2 views labelled", size=5.3, fill=INK)
    f.text(x + w, y + h + 1.6, "rest reprojected", size=5.3, anchor="end", fill=GREEN)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--embed", action="store_true")
    args = ap.parse_args()
    E = args.embed
    prot = load("fig2-protocol.json")
    meas = load("fig2.json")
    ps = meas["per_session"]

    # ---- aggregate the measurement (median across sessions; n is quoted) -----
    nkp = sum(s["keypoints_used"] for s in ps)
    nses = meas["n_sessions"]
    ncam = ps[0]["cameras"]
    QK = ("p5", "p25", "p50", "p75", "p90", "p95", "p99",
          "acc2", "acc5", "acc10", "acc20", "acc40")
    held = {k: med(pull(ps, ["held_out"], k)) for k in QK}
    # The DATA-ANCHORED variant: distance to the held-out view's OWN detection rather
    # than to the reprojected reference 3D. The reference is itself a multi-view solve,
    # so comparing against it flatters a 2-anchor solve; this one does not. It was
    # measured all along and an earlier draft plotted only the flattering curve.
    heldobs = {k: med(pull(ps, ["held_out_vs_observation"], k)) for k in QK}
    n_held = sum(s["held_out_vs_observation"]["n"] for s in ps)
    err3d = {k: {q: med(pull(ps, ["err3d_mm_by_anchor_count", k], q))
                 for q in ("p5", "p25", "p50", "p75", "p90", "p95")}
             for k in ("2", "3", "4", "5")}
    # Per-anchor-PAIR 3D error against its baseline angle -- the angle the two
    # cameras subtend at the animals. This is what conditions a two-view solve: the
    # pooled k=2 number averages good and badly-conditioned pairs together, but a
    # labeller CHOOSES a pair, so the per-pair breakdown is the actionable form.
    # Both coordinates are medians ACROSS ALL 50 SESSIONS: the baseline angle moves a
    # little between sessions because the vertex is that session's own mean 3D point,
    # so taking the first session's angle (as an earlier draft did) reported one
    # session's geometry for a fifty-session median error.
    pair_rows = {}
    for sr in ps:
        for k, v in (sr.get("err3d_mm_by_pair") or {}).items():
            r = pair_rows.setdefault(k, {"baseline": [], "p50": [], "n": 0})
            r["baseline"].append(v["baseline_deg"])
            r["p50"].append(v["p50"])
            r["n"] += v.get("n", 0)
    pairs = sorted((med(r["baseline"]), med(r["p50"]), k)
                   for k, r in pair_rows.items())
    n_pair_kp = sum(r["n"] for r in pair_rows.values())
    # Depth uncertainty of a two-ray intersection goes as 1/sin(theta), so that -- not
    # a straight line -- is the model to draw. k is estimated ROBUSTLY, as the median
    # of err*sin(theta): least squares gives k = 1.87 mm with only 5/10 pairs inside
    # +-25%, the robust k puts 8/10 inside, and the two it misses are the informative
    # ones (both contain the farthest camera). Reported as the estimator it is.
    ksin = med([e * math.sin(math.radians(b)) for b, e, _ in pairs])

    def law(theta):
        return ksin / math.sin(math.radians(theta))

    BAND = 0.25
    off_law = [(b, e, k) for b, e, k in pairs
               if abs(e - law(b)) / law(b) > BAND]

    # correction rate = the fraction of reprojected keypoints a labeller would have
    # to touch, at each tolerance. Measured, not assumed.
    # correction rate from the DATA-ANCHORED curve -- the conservative choice
    pcorr = {2.0: 1 - heldobs["acc2"], 5.0: 1 - heldobs["acc5"],
             10.0: 1 - heldobs["acc10"], 20.0: 1 - heldobs["acc20"]}

    # Bone-length CV, computed from the deposited JSON. An earlier draft hardcoded
    # "0.149 vs 0.142" as a string literal from a smaller run, and asserted the two
    # conditions were indistinguishable. Recomputed here: the reduction is small but
    # CONSISTENT in sign across edges, which is a different (and defensible) claim.
    ind_cv, pf_cv, n_edges, n_lower = [], [], 0, 0
    for sr in ps:
        for b in (sr.get("bones") or {}).values():
            if b.get("ind_cv") is not None and b.get("pf_cv") is not None:
                ind_cv.append(b["ind_cv"])
                pf_cv.append(b["pf_cv"])
                n_edges += 1
                if b["pf_cv"] < b["ind_cv"]:
                    n_lower += 1
    cv_ind = sum(ind_cv) / len(ind_cv) if ind_cv else float("nan")
    cv_pf = sum(pf_cv) / len(pf_cv) if pf_cv else float("nan")

    W = COL2
    f = Figure(width=W, height=150.0)
    M = 0.0
    y = 3.2

    # ================================================================= a =====
    f.panel(M, y, "a")
    f.text(M + 5.0, y, "Protocol", size=7, weight="bold")
    y += 3.0

    colw = (W - 3 * 3.6) / 4
    tile_h = colw * 0.80
    head_h = 6.6
    cols = [M + i * (colw + 3.6) for i in range(4)]

    def head(i, n, title):
        f.badge(cols[i] + 1.5, y + 1.5, n, r=1.5)
        f.text(cols[i] + 3.9, y + 2.35, title, size=6, weight="bold")

    # --- 1. the two anchor views -------------------------------------------
    head(0, 1, "Label 2 anchor views")
    ay = y + head_h
    for k, v in enumerate(prot["views"]["anchor"]):
        b = v["bbox"]
        f.image(cols[0], ay + k * (tile_h + 1.4), colw, tile_h,
                os.path.join(OUT, os.path.basename(v["file"])),
                crop=(b["x0"], b["y0"], b["x1"], b["y1"]),
                src_size=(v["width"], v["height"]), embed=E,
                label=v["name"].replace("Camera", "cam ").replace("_", " "),
                label_size=5.2)
        f.text(cols[0] + colw - 0.8, ay + k * (tile_h + 1.4) + tile_h - 1.2,
               "anchor", size=5.0, anchor="end", fill="#FFFFFF", weight="bold",
               halo="#000000", halo_w=0.3)
    a_bot = ay + 2 * tile_h + 1.4

    # --- 2. triangulate from those two only --------------------------------
    head(1, 2, "Triangulate")
    geometry(f, cols[1], y + head_h + 0.6, colw, tile_h * 0.82)
    # The animal-framed 3D shot, not the rig overview: in a 42 mm column the rig's
    # animals are ~2 mm across, and step 2's claim is that you now have a 3D POSE.
    near = os.path.join(OUT, prot["threeD"]["animals"])
    nw, nh = png_size(near)
    ry = ay + tile_h + 1.4
    f.image(cols[1], ry, colw, tile_h, near, src_size=(nw, nh), embed=E,
            label="3D from the 2 anchors", label_size=5.2)
    f.text(cols[1] + 0.8, y + head_h + tile_h * 0.82 + 4.6,
           f"other {len(prot['cameras']) - len(prot['anchors'])} views: weight 0",
           size=5.0, fill=GREY)

    # --- 3. reprojections in the views nobody labelled ---------------------
    head(2, 3, "Reprojections appear")
    shown = prot["views"]["reproj"][:2]
    for k, v in enumerate(shown):
        b = v["bbox"]
        f.image(cols[2], ay + k * (tile_h + 1.4), colw, tile_h,
                os.path.join(OUT, os.path.basename(v["file"])),
                crop=(b["x0"], b["y0"], b["x1"], b["y1"]),
                src_size=(v["width"], v["height"]), embed=E,
                label=v["name"].replace("Camera", "cam ").replace("_", " "),
                label_size=5.2)
        f.text(cols[2] + colw - 0.8, ay + k * (tile_h + 1.4) + tile_h - 1.2,
               "not labelled", size=5.0, anchor="end", fill=GREEN, weight="bold",
               halo="#000000", halo_w=0.3)

    # --- 4. accept or nudge, magnified ------------------------------------
    head(3, 4, "Accept or nudge")
    chk = prot["views"]["check"][0]
    b = chk["bbox"]
    # Magnify ONE animal so the reader can see the reprojection sitting on the
    # detection. At tile scale the two coincide and the panel would show nothing.
    d0 = max(chk["details"], key=lambda d: (d.get("box") or [0, 0, 0, 0])[2]
             if d.get("box") else 0)
    cxp, cyp = d0["centroid"]
    half = max(90, 0.16 * (b["x1"] - b["x0"]))
    cyp += 0.28 * half          # the app draws the id label ABOVE the centroid
    f.image(cols[3], ay, colw, tile_h,
            os.path.join(OUT, os.path.basename(chk["file"])),
            crop=(cxp - half, cyp - half, cxp + half, cyp + half),
            src_size=(chk["width"], chk["height"]), embed=E,
            label="magnified", label_size=5.2)
    # the app's own errors for this run
    e2 = prot["reprojErrorsTwoAnchors"] or []
    anch = prot["anchors"]
    a_err, h_err = [], []
    for rec in e2:
        for nm, val in (rec.get("perView") or {}).items():
            (a_err if nm in anch else h_err).append(val)
    ty = ay + tile_h + 3.0
    f.text(cols[3], ty, "2-anchor solve, this frame", size=5.4, weight="bold")
    ty += 2.5
    if a_err:
        f.text(cols[3], ty, f"anchor views  {min(a_err):.1f}–{max(a_err):.1f} px",
               size=5.2, fill=INK)
        ty += 2.3
    if h_err:
        f.text(cols[3], ty, f"the other {len(prot['cameras']) - len(anch)}  "
                            f"{min(h_err):.1f}–{max(h_err):.1f} px",
               size=5.2, fill=GREEN)
        ty += 2.3
    f.text(cols[3], ty, "dotted = reprojected, solid = detected",
           size=5.0, fill=GREY)

    for i in range(3):
        f.chevron(cols[i] + colw + 0.6, y + head_h + tile_h * 0.55, 3.0)

    y = a_bot + 4.6

    # ================================================================= b =====
    bw = 78.0                  # b gets less width than c: c carries two sub-axes
    f.panel(M, y, "b")
    f.text(M + 5.0, y, "Placements vs rig size", size=7, weight="bold")
    yb = y + 3.0

    px_w, px_h = bw - 12.0, 34.0
    xlim, ylim = (2, CMAX), (0, CMAX * NODES * 1.06)
    X, Y = f.axes(M + 12.0, yb, px_w, px_h, xlim, ylim,
                  xlabel="cameras in the rig, C",
                  xticks=[2, 4, 6, 8], yticks=[0, 30, 60, 90, 120], size=6)
    # N = 15 is a PER-ANIMAL skeleton, so the ordinate is per animal per frame -- the
    # old label said only "per frame" while the caption said per animal per frame.
    ylabel_rot(f, M + 8.2, yb + px_h / 2,
               ["manual placements", "per animal per frame"], size=6.5)
    cs = list(range(2, CMAX + 1))
    # traditional: every node placed by hand in every view
    f.polyline([(X(c), Y(c * NODES)) for c in cs], color=ACCENT2, sw=0.8 * PT)
    # reprojection-aided: two anchor views, plus the measured corrections
    for tau, dash in ((5.0, "1.1,0.9"), (20.0, None)):
        p = pcorr[tau]
        f.polyline([(X(c), Y(2 * NODES + (c - 2) * NODES * p)) for c in cs],
                   color=GREEN, sw=0.8 * PT, dash=dash)
    # the measured region: camera subsets we actually have data for
    f.rect(X(2), Y(ylim[1]), X(ncam) - X(2), Y(0) - Y(ylim[1]),
           fill=ACCENT, stroke="none", sw=0)
    f.parts[-1] = f.parts[-1].replace('fill="#0072B2"', 'fill="#0072B2" fill-opacity="0.06"')
    f.text(X((2 + ncam) / 2), Y(ylim[1]) - 0.8,
           f"p measured, C ≤ {ncam}", size=5.2, anchor="middle", fill=ACCENT)
    f.text(X((ncam + CMAX) / 2), Y(ylim[1]) - 0.8, "model", size=5.2,
           anchor="middle", fill=GREY)
    # Markers ONLY where p was measured. Drawing them out to C = 8 read as eight
    # measured rig sizes when only C <= 5 exists in the data.
    for c in range(2, ncam + 1):
        f.marker(X(c), Y(c * NODES), color=ACCENT2, r=0.6)
        f.marker(X(c), Y(2 * NODES + (c - 2) * NODES * pcorr[TAU_MAIN]), color=GREEN, r=0.6)
    f.text(X(CMAX) - 0.6, Y(CMAX * NODES) - 2.0, "traditional", size=5.6,
           anchor="end", fill=ACCENT2)
    f.text(X(CMAX) - 0.6, Y(2 * NODES) + 5.0, "reprojection-aided", size=5.6,
           anchor="end", fill=GREEN)
    # Two tolerances, so the reader can see the curve is flat either way.
    f.text(X(CMAX) - 0.6, Y(2 * NODES + (CMAX - 2) * NODES * pcorr[TAU_STRICT]) - 1.5,
           f"τ = {TAU_STRICT:.0f} px", size=5.0, anchor="end", fill=GREEN)
    f.text(X(CMAX) - 0.6, Y(2 * NODES) + 1.9, f"τ = {TAU_MAIN:.0f} px", size=5.0,
           anchor="end", fill=GREEN)
    # The ratio, quoted at the MEASURED rig size and nowhere else. The old caption
    # gave "2.3-4x", which mixed two different tolerances AND two rig sizes; the 4x
    # end needs C = 8, outside the measured band.
    aided5 = 2 * NODES + (ncam - 2) * NODES * pcorr[TAU_MAIN]
    bx = X(ncam) - 1.6
    f.line(bx, Y(ncam * NODES), bx, Y(aided5), stroke=INK, sw=0.4 * PT)
    for yy in (Y(ncam * NODES), Y(aided5)):
        f.line(bx - 0.7, yy, bx + 0.7, yy, stroke=INK, sw=0.4 * PT)
    f.text(bx - 1.2, (Y(ncam * NODES) + Y(aided5)) / 2 + 0.7,
           f"{ncam * NODES / aided5:.1f}×", size=5.6, anchor="end", weight="bold")

    # ================================================================= c =====
    cx0 = M + bw + 10.0
    f.panel(cx0, y, "c")
    f.text(cx0 + 5.0, y, "Cost of two anchors", size=7, weight="bold")

    # --- c-left: where the reprojection lands in the UNLABELLED views ------
    # 88 mm for c: ylabel + 30 mm axes, twice, with a gap that keeps the right
    # plot's rotated ylabel clear of the left plot's x-axis numbers.
    sub_w = 30.0
    # The key sits ABOVE the axes rather than inside them: at every in-plot position
    # tried it either sat on the CDF or crossed the τ rule.
    hkey(f, cx0 + 12.0, y + 2.7,
         [("vs the view's own detection", GREEN, None),
          ("vs the reference 3D", GREEN, "1.1,0.8")], size=5.2)
    yb = yb + 2.4                      # room for that key
    X2, Y2 = f.axes(cx0 + 12.0, yb, sub_w, px_h, (0, 25), (0, 100),
                    xlabel="error in an unlabelled view (px)",
                    ylabel="cumulative % of keypoints",
                    xticks=[0, 10, 20], yticks=[0, 25, 50, 75, 100], size=6)
    def cdf_of(stat):
        pts = [(0.0, 0.0)]
        for q, v in (("p5", 5), ("p25", 25), ("p50", 50), ("p75", 75),
                     ("p90", 90), ("p95", 95), ("p99", 99)):
            if stat.get(q) is not None:
                pts.append((stat[q], v))
        for tau in (2.0, 5.0, 10.0, 20.0):
            a = stat.get(f"acc{int(tau)}")
            if a is not None:
                pts.append((tau, a * 100))
        return sorted(set(pts))

    # solid = the honest, data-anchored curve; dashed = against the reference 3D
    f.polyline([(X2(min(a, 25)), Y2(b_)) for a, b_ in cdf_of(heldobs)],
               color=GREEN, sw=0.95 * PT)
    f.polyline([(X2(min(a, 25)), Y2(b_)) for a, b_ in cdf_of(held)],
               color=GREEN, sw=0.6 * PT, dash="1.3,0.9")
    f.line(X2(TAU_MAIN), Y2(0), X2(TAU_MAIN), Y2(100), stroke=ACCENT2,
           sw=0.45 * PT, dash="1.2,0.9")
    f.text(X2(TAU_MAIN) - 0.9, Y2(30), f"\u03c4 = {TAU_MAIN:.0f} px", size=5.0,
           anchor="middle", fill=ACCENT2, rotate=-90)
    f.text(X2(6.4), Y2(26), f"{heldobs['acc5'] * 100:.0f}% \u2264 5 px", size=5.2,
           fill=INK)
    f.text(X2(6.4), Y2(14), f"{heldobs['acc10'] * 100:.1f}% \u2264 {TAU_MAIN:.0f} px",
           size=5.2, fill=INK)
    f.text(X2(6.4), Y2(38), f"median {heldobs['p50']:.1f} px", size=5.2, fill=GREEN)

    # --- c-right: WHY a two-view solve costs anything, and what to do about it --
    rx = cx0 + 12.0 + sub_w + 16.0
    bl = [p[0] for p in pairs]
    ev = [p[1] for p in pairs]
    floor5 = err3d["5"]["p50"]
    XL = (10, 34)
    X3, Y3 = f.axes(rx, yb, sub_w, px_h, XL, (0, 14),
                    xlabel="anchor-pair baseline angle (°)",
                    ylabel="3D error vs proofread (mm)",
                    xticks=[10, 20, 30], yticks=[0, 4, 8, 12], size=6)
    # ±25% band around the depth-uncertainty law, drawn BEFORE the markers so the
    # reader can count for themselves which pairs the law explains -- no prose needed.
    th = [XL[0] + i * (XL[1] - XL[0]) / 60.0 for i in range(61)]
    f.ribbon(X3, Y3, th, [law(t) * (1 - BAND) for t in th],
             [min(law(t) * (1 + BAND), 14) for t in th], color=GREEN, opacity=0.14)
    f.polyline([(X3(t), Y3(law(t))) for t in th], color=GREEN, sw=0.5 * PT,
               dash="1.4,1.0")
    # the floor: what labelling EVERY view achieves
    f.hline(X3, Y3, floor5, XL, label=f"all {ncam} views {floor5:.1f} \u2014 comparison floor",
            color=ACCENT, side="left", size=5.0)
    # Every pair gets the SAME marker. The two off-law pairs were drawn hollow, but the
    # +/-25% band already shows which points fall outside it and both are named on the
    # plot, so the third encoding of one fact was redundant ink.
    for x_, v_, key in pairs:
        f.marker(X3(x_), Y3(v_), color=GREEN, r=0.65)
    f.text(X3(33.6), Y3(5.4), "k / sin θ", size=5.2, anchor="end",
           fill=GREEN, italic=True)
    # Data labels on the two extremes only -- these are the actionable pair choices.
    # Max sits left of its marker (it is hugging the left spine) and min below its own,
    # so neither lands on the pair-id labels or on the neighbouring 3-4 marker.
    imax = max(range(len(ev)), key=lambda i: ev[i])
    imin = min(range(len(ev)), key=lambda i: ev[i])
    f.text(X3(bl[imax]), Y3(ev[imax]) - 1.3, f"{ev[imax]:.1f}", size=5.2,
           anchor="middle", fill=GREEN)
    f.text(X3(bl[imin]), Y3(ev[imin]) + 2.8, f"{ev[imin]:.1f}", size=5.2,
           anchor="middle", fill=GREEN)
    # Name the two exceptions, so "which pairs" is on the artwork rather than only
    # in the caption. Camera indices are the JSON's own pair keys.
    for x_, v_, key in off_law:
        f.text(X3(x_) + 1.2, Y3(v_) + 0.7, "cam " + key.replace("-", "+"),
               size=5.2, fill=GREY)

    y = yb + px_h + 10.0

    # -------------------------------------------------- provenance footer ----
    # Prose lives in figs/CAPTIONS.md.
    f.text(M, y,
           f"a: the app on an 8-camera recording (different rig). "
           f"b, c: all {nses} proofread BMimica sessions, {ncam} cameras, "
           f"{ps[0]['animals']} mice, {NODES} nodes, {nkp:,} keypoints.",
           size=5.4, fill=GREY)
    y += 2.5
    f.text(M, y,
           f"Every session enters every panel: {n_held:,} held-out view measurements "
           f"in c left, {n_pair_kp:,} two-anchor solves in c right. See caption.",
           size=5.4, fill=GREY)
    y += 2.4

    check_width(f)
    f.height = round(y + 3.0, 1)
    f.write(os.path.join(OUT, "fig2.svg"))


if __name__ == "__main__":
    main()
