#!/usr/bin/env python3
"""
Fig 4 — What sets the accuracy of a triangulated 3D point.

THE CLAIM THE FIGURE MAKES. 3D accuracy on this rig is set by how many views
contribute and by whether an outlying view is rejected, not by the choice of
triangulation solver: view count moves 3D error 4.75 -> 1.22 mm (3.9x) and rejecting
one badly-fitting view moves a point a median 7.2 mm, while the solver changes the
residual by ~8% in sample and ~3% out of sample -- and out of sample the sign REVERSES
when only two views contribute.

READ THIS BEFORE TOUCHING THE HELD-OUT NUMBERS. On ONE session the refinement was
worse out of sample (held-out median DLT 2.27 vs refined 2.35 px); on all 50 it is
slightly BETTER (3.05 vs 2.97 px, lower in 34/50 sessions, better on 53.1% of
21,268,180 held-out views). The single-session result was pseudo-replication -- 5.3 M
correlated keypoints from one recording -- and it did not survive the corpus. That
session (`sorted(sessions)[0]`, which is what `fig4_export.py --sessions 1` picks) is
the corpus EXTREME on both of this figure's headline metrics: the lowest fraction of
held-out views the refinement wins (0.4525 vs a 0.453-0.610 range across sessions) and
the highest pre-#113 regression rate (0.391 vs 0.129-0.393). Do not restore the
"refinement does not generalise" headline from a one-session run; the qualified version
is that it generalises weakly, and only above two views.

  a  The three solvers, and what separates them: which error each minimises, in
     which coordinate space, and whether the cameras are free to move. The app's
     menu calls the middle one "Bundle Adjustment"; it holds the cameras FIXED, so
     it is non-linear TRIANGULATION. The panel uses the correct names. This is a
     nomenclature correction, not a result -- hence it leads as a schematic.
  b  3D error against a fully-informed reconstruction as views are added.
  c  How far the 3D estimate moves when the single worst-fitting view is rejected.
  d  Held-out reprojection error against the number of views the solve was given,
     with a difference strip because the two solvers' levels are indistinguishable at
     this scale and the SIGN of their difference is the finding. Needs NO reference
     3D: it is scored against the raw detection in a view no solve ever saw.
  e  Reprojection error on the views the solver was given and on a held-out view,
     paired per session (n = 50), so the pooled medians carry a spread.
  f  The signed change in the DISPLAYED reprojection error, shipped option set vs
     the pre-#113 one.
  g  Solve time per keypoint, measured in this run.

WHAT IS NOT A RESULT, AND MUST NOT BE DRAWN AS ONE
--------------------------------------------------
1. "Refined is never worse than DLT" on the views it optimised is enforced, not
   observed: phase 2's loss IS the reported metric (`reportedError`, triangulation.js)
   and a backtracking guard returns the DLT seed unless the candidate's reported error
   is <= the seed's. So panel e's left group cannot come out any other way, and it is
   marked "(enforced)" on the artwork so 50/50 is not read as evidence. It is shown
   only because it is the size of the in-sample effect, side by side with the held-out
   group, which either solver can lose. The contingent quantities are panels d/e's
   held-out columns and panel f's pre-#113 spread.
2. No 3D-accuracy comparison BETWEEN SOLVERS, anywhere, including by the back door.
   Measured: the proofread reference's own native-space reprojection error exceeds
   both solvers', so it is not the minimiser of reprojection error on these
   detections; distance to a reference that sits further from the data than both
   candidates rewards whichever candidate moved less (DLT, by construction) and
   cannot arbitrate between methods that differ precisely in which error they
   minimise. fig4.json's `by_worst_view` holds exactly that comparison and is
   labelled a diagnostic; it is deliberately NOT loaded here.
   Panel b varies only the VIEW COUNT with the solver held constant, so any
   reference bias is common-mode across its four points -- but its 5-view floor is
   bounded below by the RANSAC-Procrustes alignment residual, which the caption
   states. Panel d is the reference-free version of the same effect.
3. A regression RATE without its magnitude is not a finding either: the pre-#113
   option set raised the displayed error on 24.6% of keypoints but by a median of
   0.026 px (p99 0.30). Panel f draws the whole signed distribution and prints the
   rate, so the #113 fix is not oversold: it removed a frequent sub-0.1-px
   inconsistency in a number the UI shows, not an accuracy defect.

Inputs (all from the SAME 50 BMimica sessions):
  /root/.../lp3d_env/bin/python figs/fig4_export.py    -> figs/out/fig4_input.json
  node figs/fig4_measure.mjs                           -> figs/out/fig4.json
  figs/fig2_measure.py                                 -> figs/out/fig2.json  (panel b)

Usage: python3 figs/fig4.py
       node figs/render.mjs figs/out/fig4.svg 600
"""
import argparse
import json
import os
import re
import statistics as st
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nature import (Figure, COL2, INK, GREY, LIGHT, ACCENT, ACCENT2, PT)  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
# FIG4_OUT redirects both the inputs and the .svg, so a layout pass can be iterated
# against a truncated measurement (LIMIT= on fig4_measure.mjs) without touching the
# real figs/out/.
OUT = os.environ.get("FIG4_OUT") or os.path.join(HERE, "out")

# ---------------------------------------------------------------- palette ----
# One meaning per colour, within this figure:
#   blue       the linear baseline (DLT)
#   green      the app's non-linear refinement
#   pink       effects that are not about the solver at all -- view count, view
#              rejection -- so a reader cannot mistake them for a solver comparison
#   vermillion the failure axis: the pre-#113 option set
DLT_C = ACCENT          # #0072B2
REF_C = "#009E73"       # Okabe-Ito green
GEOM_C = "#CC79A7"      # Okabe-Ito reddish purple
MIN_PT = 5.0            # Nature's type floor


def ticks_upto(limit, candidates):
    """Only the ticks that fall inside the axis. f.axes() happily draws a tick beyond
    its own limit, which places it ABOVE the plot -- in a stacked figure that lands in
    the panel above and reads as a stray glyph."""
    return [t for t in candidates if t <= limit]


def load(name):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        sys.exit(f"missing figs/out/{name} -- see the header of this file")
    with open(p) as f:
        return json.load(f)


def check_type_floor(f):
    """No run below 5 pt. nature.py does not enforce this yet (and is shared, so it
    is not edited from here), and a 4.6 pt label is below Nature's legibility floor
    -- at 4.6 pt Arial the cap height is 1.15 mm."""
    bad = sorted({round(float(m) / PT, 2) for m in
                  re.findall(r'font-size:([0-9.]+)', f.svg())
                  if float(m) / PT < MIN_PT - 1e-6})
    if bad:
        sys.exit(f"fig4: type below the {MIN_PT} pt floor: {bad} pt")


def solver_panel(f, x, y, w, h, title, sub, tag, *, cameras_fixed, curved, iterative,
                 accent):
    """
    One solver, drawn. Two cameras, their rays, the point, and the residual each
    method actually minimises: a straight algebraic offset for DLT, a curved
    (distorted) image-space residual for the native-space solvers. Cameras carry a
    lock when they are held fixed and arrows when they are free to move -- which is
    the single distinction the UI's naming gets wrong, so `tag` names each box's
    status in the shipped app.
    """
    f.rect(x, y, w, h, fill="#FFFFFF", stroke=LIGHT, rx=0.9)
    f.rect(x, y, 0.9, h, fill=accent, stroke="none", sw=0)
    f.text(x + 2.6, y + 3.4, title, size=6.2, weight="bold")
    f.text(x + 2.6, y + 6.2, sub, size=5.2, fill=GREY)
    f.text(x + 2.6, y + 9.0, tag, size=5.0, fill=accent)

    gy = y + 11.0
    gh = h - 13.0
    ax, ay = x + 4.0, gy + 1.2
    bx, by = x + 4.0, gy + gh - 1.2
    px, py = x + w * 0.62, gy + gh / 2

    for (cx, cy) in ((ax, ay), (bx, by)):
        f.icon("camera", cx, cy - 1.4, s=2.8, color=INK, sw=0.45)
        f.line(cx + 2.8, cy, px, py, stroke=GREY, sw=0.45 * PT)
        if cameras_fixed:
            # a small padlock, tucked under the camera so it cannot reach the tag
            f.rect(cx - 0.4, cy + 1.5, 1.5, 1.1, stroke=GREY, sw=0.3 * PT, rx=0.2)
            f.add(f'<path d="M{cx:.3f},{cy + 1.5:.3f} v-0.45 '
                  f'a0.4,0.4 0 0 1 0.8,0 v0.45" fill="none" stroke="{GREY}" '
                  f'stroke-width="{0.3 * PT:.4f}"/>')
        else:
            f.arrow(cx - 0.2, cy + 2.4, cx + 2.0, cy + 1.4, color=accent,
                    sw=0.4 * PT, head=1.2)
    f.marker(px, py, color=INK, r=0.7, sw=0.2)

    # the residual being minimised, drawn in the space it lives in
    ox, oy = px + w * 0.15, py - gh * 0.22
    if curved:
        f.add(f'<path d="M{px:.3f},{py:.3f} Q{px + 2.2:.3f},{py - 3.0:.3f} '
              f'{ox:.3f},{oy:.3f}" fill="none" stroke="{accent}" '
              f'stroke-width="{0.6 * PT:.4f}" stroke-dasharray="0.8,0.6"/>')
    else:
        f.line(px, py, ox, oy, stroke=accent, sw=0.6 * PT, dash="0.8,0.6")
    f.marker(ox, oy, color=accent, r=0.45, sw=0.15)
    if iterative:
        f.add(f'<path d="M{ox + 1.4:.3f},{oy + 0.9:.3f} '
              f'Q{px + 4.0:.3f},{py + 2.8:.3f} {px + 0.9:.3f},{py + 2.0:.3f}" '
              f'fill="none" stroke="{accent}" stroke-width="{0.4 * PT:.4f}" '
              f'marker-end="url(#{f._arrowhead(accent, 1.4)})"/>')
        f.text(x + w - 1.8, gy + gh + 0.6, "repeat", size=5.0, anchor="end",
               fill=accent)


def paired_dots(f, X, Y, xd, xb, sessions, key, cd, cb, r=0.34):
    """
    One dot per session for each of two methods, joined so the comparison is visibly
    PAIRED, with the pooled median drawn as a rule. A bar chart of two pooled medians
    hides that these are 50 correlated recordings, which is the whole reason the
    pooled difference needs an error bar.
    """
    pairs = [(s[key]["dlt"], s[key]["ba"]) for s in sessions
             if s.get(key) and s[key].get("dlt") is not None
             and s[key].get("ba") is not None]
    for vd, vb in pairs:
        f.line(X(xd), Y(vd), X(xb), Y(vb), stroke=LIGHT, sw=0.28 * PT)
    for vd, vb in pairs:
        f.marker(X(xd), Y(vd), color=cd, r=r, sw=0.1)
        f.marker(X(xb), Y(vb), color=cb, r=r, sw=0.1)
    return pairs


def main():
    argparse.ArgumentParser().parse_args()
    m = load("fig4.json")
    f2 = load("fig2.json")
    if "per_session" not in m or "heldout_by_views" not in m:
        sys.exit("figs/out/fig4.json predates the 50-session measurement -- re-run "
                 "`node figs/fig4_measure.mjs` (see the header of this file)")

    W = COL2
    f = Figure(width=W, height=200.0)
    M = 0.0
    y = 3.2

    dlt = m["methods"]["dlt"]
    ba = m["methods"]["ba"]
    nk = m["keypoints"]
    ps = m["per_session"]
    ho = m["heldout_reproj_px"]

    # ================================================================= a =====
    f.panel(M, y, "a")
    f.text(M + 5.0, y, "Triangulation solvers", size=7, weight="bold")
    y += 3.2

    gap = 4.0
    sw_ = (W - 2 * gap) / 3
    sh_ = 28.0
    solver_panel(f, M, y, sw_, sh_, "Linear DLT",
                 "algebraic error · closed form", "app default",
                 cameras_fixed=True, curved=False, iterative=False, accent=DLT_C)
    solver_panel(f, M + sw_ + gap, y, sw_, sh_, "Non-linear triangulation",
                 "geometric error · native pixels",
                 "app menu: “Bundle Adjustment”",
                 cameras_fixed=True, curved=True, iterative=False, accent=REF_C)
    solver_panel(f, M + 2 * (sw_ + gap), y, sw_, sh_, "Joint bundle adjustment",
                 "cameras + structure · iterative", "not wired to the UI",
                 cameras_fixed=False, curved=True, iterative=True, accent=GREY)
    y += sh_ + 7.0

    # ---- row 2: three panels across -----------------------------------------
    gapx = 10.0
    pw = (W - 2 * gapx) / 3
    plot_l = 11.5                      # room for the rotated y label + ticks
    ph = 30.0
    xs = [M, M + pw + gapx, M + 2 * (pw + gapx)]
    yr = y + 4.0                       # plot top for row 2

    # ================================================================= b =====
    f.panel(xs[0], y, "b")
    f.text(xs[0] + 5.0, y, "Accuracy vs cameras used", size=7, weight="bold")

    per2 = f2["per_session"]
    ks = ["2", "3", "4", "5"]
    e3 = {k: st.median([s["err3d_mm_by_anchor_count"][k]["p50"] for s in per2
                        if k in s.get("err3d_mm_by_anchor_count", {})]) for k in ks}
    iqr = {k: (st.median([s["err3d_mm_by_anchor_count"][k]["p25"] for s in per2
                          if k in s.get("err3d_mm_by_anchor_count", {})]),
               st.median([s["err3d_mm_by_anchor_count"][k]["p75"] for s in per2
                          if k in s.get("err3d_mm_by_anchor_count", {})])) for k in ks}
    topb = max(iqr[k][1] for k in ks) * 1.18
    Xb, Yb = f.axes(xs[0] + plot_l, yr, pw - plot_l, ph, (1.7, 5.3), (0, topb),
                    xlabel="cameras that saw the keypoint", ylabel="3D error (mm)",
                    xticks=[2, 3, 4, 5], yticks=ticks_upto(topb, [0, 2, 4, 6, 8, 10]),
                    size=6)
    f.ribbon(Xb, Yb, [int(k) for k in ks], [iqr[k][0] for k in ks],
             [iqr[k][1] for k in ks], color=GEOM_C, opacity=0.16)
    f.polyline([(Xb(int(k)), Yb(e3[k])) for k in ks], color=GEOM_C, sw=0.9 * PT)
    for k in ks:
        f.marker(Xb(int(k)), Yb(e3[k]), color=GEOM_C, r=0.62)
    f.text(Xb(2) + 0.8, Yb(e3["2"]) - 1.2, f"{e3['2']:.1f}", size=5.4, fill=GEOM_C)
    f.text(Xb(5), Yb(e3["5"]) - 1.6, f"{e3['5']:.1f}", size=5.4, anchor="middle",
           fill=GEOM_C)
    f.text(Xb(3.6), Yb(topb * 0.86), f"{e3['2'] / e3['5']:.1f}×", size=6.4,
           anchor="middle", weight="bold", fill=GEOM_C)

    # ================================================================= c =====
    f.panel(xs[1], y, "c")
    f.text(xs[1] + 5.0, y, "Dropping the worst camera", size=7, weight="bold")

    rb = m["robust"]
    order = [k for k in ("clean", "mid", "outlier") if k in rb]
    labels = {"clean": "< 3", "mid": "3–10", "outlier": "≥ 10"}
    topc = max(rb[k]["moved_mm"]["p95"] for k in order) * 1.16
    Xc, Yc = f.axes(xs[1] + plot_l, yr, pw - plot_l, ph, (0.4, len(order) + 0.6),
                    (0, topc), xlabel="how far that camera disagreed (px)",
                    ylabel="the 3D point moves (mm)", xticks=[],
                    yticks=ticks_upto(topc, [0, 10, 20, 30, 40, 50]), size=6)
    for i, k in enumerate(order):
        b = rb[k]
        xc = 1 + i
        f.box_whisker(Xc, Yc, xc, b["moved_mm"], width=0.44, color=GEOM_C)
        f.text(Xc(xc), Yc(0) + 3.0, labels[k], size=5.4, anchor="middle")
        # n above the whisker, not under the tick: the x label lives under the tick,
        # and the outlier stratum is ~1% of the data so it must not read as equal
        f.text(Xc(xc), Yc(b["moved_mm"]["p95"]) - 1.0, f"n={b['n']:,}", size=5.0,
               anchor="middle", fill=GREY)
        f.text(Xc(xc + 0.26) + 0.5, Yc(b["moved_mm"]["p50"]) + 0.7,
               f"{b['moved_mm']['p50']:.1f}", size=5.4, fill=GEOM_C)

    # ================================================================= d =====
    f.panel(xs[2], y, "d")
    f.text(xs[2] + 5.0, y, "Error in an unused camera", size=7, weight="bold")

    hv = m["heldout_by_views"]["by_k"]
    kk = sorted(int(k) for k in hv)
    xlim_d = (kk[0] - 0.35, kk[-1] + 0.35)
    # Split into a level plot and a difference strip. On a 0-based axis the two
    # solvers' medians differ by <0.15 px out of ~3-4 and are indistinguishable, so the
    # levels alone cannot show the finding that the sign of the solver difference FLIPS
    # when only two views feed the solve. Shared x, so only the strip carries ticks.
    ph_main, ph_str, gap_d = 17.0, 10.0, 3.0
    topd = max(hv[str(k)][s]["p50"] for k in kk for s in ("dlt", "ba")) * 1.22
    Xd, Yd = f.axes(xs[2] + plot_l, yr, pw - plot_l, ph_main, xlim_d, (0, topd),
                    ylabel="error (px)",
                    xticks=[], yticks=ticks_upto(topd, [0, 2, 4]), size=6)
    for nm, col in (("dlt", DLT_C), ("ba", REF_C)):
        f.polyline([(Xd(k), Yd(hv[str(k)][nm]["p50"])) for k in kk], color=col,
                   sw=0.9 * PT)
        for k in kk:
            f.marker(Xd(k), Yd(hv[str(k)][nm]["p50"]), color=col, r=0.55)
    f.legend(Xd(kk[1]) - 1.0, yr + 1.6, [("DLT", DLT_C), ("refined", REF_C)], size=5.4)

    dif = {k: hv[str(k)]["ba"]["p50"] - hv[str(k)]["dlt"]["p50"] for k in kk}
    md = max(abs(v) for v in dif.values()) * 1.9
    ys = yr + ph_main + gap_d
    Xd2, Yd2 = f.axes(xs[2] + plot_l, ys, pw - plot_l, ph_str, xlim_d, (-md, md),
                      xlabel="cameras the solver was given", ylabel="Δ (px)",
                      xticks=kk, yticks=[-0.1, 0.1], size=6)
    f.hline(Xd2, Yd2, 0.0, xlim_d, color=GREY, dash="1.2,0.9", sw=0.4)
    for k in kk:
        v = dif[k]
        col = REF_C if v < 0 else DLT_C          # the bar takes the winner's colour
        xl, xr = Xd2(k - 0.16), Xd2(k + 0.16)
        f.rect(xl, min(Yd2(v), Yd2(0)), xr - xl, abs(Yd2(v) - Yd2(0)), fill=col,
               stroke="none", sw=0)
    # No "DLT better"/"refined better" text: each bar already carries the winner's
    # colour and the panel's own legend maps colour to solver.

    y = yr + ph + 13.0

    # ---- row 3: three panels across, same grid as row 2 ---------------------
    yr3 = y + 4.0
    xe, xf = xs[0], xs[1]   # third slot retired with panel f

    # ================================================================= e =====
    f.panel(xe, y, "e")
    f.text(xe + 5.0, y, "Per session, both solvers", size=7, weight="bold")

    obs_pairs = [(s["reproj_p50"]["dlt"], s["reproj_p50"]["ba"]) for s in ps
                 if s["reproj_p50"]["dlt"] is not None]
    ho_pairs = [(s["heldout_p50"]["dlt"], s["heldout_p50"]["ba"]) for s in ps
                if s["heldout_p50"]["dlt"] is not None]
    allv = [v for pr in obs_pairs + ho_pairs for v in pr]
    lo_e = max(0.0, min(allv) - 0.25)
    hi_e = max(allv) + 0.55
    Xe, Ye = f.axes(xe + plot_l, yr3, pw - plot_l, ph, (0.45, 2.55), (lo_e, hi_e),
                    ylabel="reprojection error, median (px)", xticks=[],
                    yticks=[t for t in (0, 0.5, 1, 1.5, 2, 2.5, 3, 3.5, 4)
                            if lo_e <= t <= hi_e], size=6)
    # The rule is the median OF THE DOTS (across sessions), not the median pooled over
    # all 4 M keypoints: a rule drawn through a dot cloud must be that cloud's median,
    # and the session is the independent unit. Both are printed by caption_numbers().
    groups = [(1.0, "cameras it used", "reproj_p50",
               st.median([a for a, _ in obs_pairs]),
               st.median([b for _, b in obs_pairs]), "(enforced)"),
              (2.0, "a camera it never saw", "heldout_p50",
               st.median([a for a, _ in ho_pairs]),
               st.median([b for _, b in ho_pairs]), None)]
    for xc, lab, key, pool_d, pool_b, note in groups:
        xd, xb = xc - 0.30, xc + 0.30
        pairs = paired_dots(f, Xe, Ye, xd, xb, ps, key, DLT_C, REF_C)
        # medians as rules. The values go ABOVE the whole dot cloud, not beside their
        # own rule: the dots occupy the full data range at each x, so any label placed
        # at the rule is overprinted by its own column of session dots.
        for xx, v, col in ((xd, pool_d, DLT_C), (xb, pool_b, REF_C)):
            f.line(Xe(xx) - 2.2, Ye(v), Xe(xx) + 2.2, Ye(v), stroke=col, sw=1.0 * PT)
        f.runs(Xe(xc), yr3 - 0.9,
               [(f"{pool_d:.2f}", 5.6, "bold", DLT_C), (" → ", 5.6, "normal", GREY),
                (f"{pool_b:.2f}", 5.6, "bold", REF_C)], anchor="middle")
        # the two columns are named under their own ticks, which is why this panel
        # needs no legend box competing with 100 session dots for the same corner
        f.text(Xe(xd), Ye(lo_e) + 3.0, "DLT", size=5.0, anchor="middle", fill=DLT_C)
        f.text(Xe(xb), Ye(lo_e) + 3.0, "refined", size=5.0, anchor="middle", fill=REF_C)
        f.text(Xe(xc), Ye(lo_e) + 5.8, lab, size=5.4, anchor="middle")
        bwin = sum(1 for a, b in pairs if b < a)
        f.text(Xe(xc), Ye(lo_e) + 8.2, f"refined lower in {bwin}/{len(pairs)}",
               size=5.0, anchor="middle", fill=GREY)
        # The left group's sweep is guaranteed: phase 2 minimises this exact metric and
        # a backtracking guard vetoes any step that raises it. Marked so 50/50 cannot be
        # read as evidence; the right group is the comparison either solver can lose.
        if note:
            f.text(Xe(xc), Ye(lo_e) + 10.5, note, size=5.0, anchor="middle", fill=GREY)

    # ================================================================= g =====
    f.panel(xf, y, "f")
    f.text(xf + 5.0, y, "Time per keypoint", size=7, weight="bold")

    cost = [("DLT", dlt["us_per_keypoint"], DLT_C),
            ("refined", ba["us_per_keypoint"], REF_C)]
    topg = max(v for _, v, _ in cost) * 1.30
    Xg, Yg = f.axes(xf + plot_l, yr3, pw - plot_l, ph, (0.45, 2.55), (0, topg),
                    ylabel="µs per keypoint", xticks=[],
                    yticks=ticks_upto(topg, [0, 20, 40, 60, 80]), size=6)
    for i, (lab, v, col) in enumerate(cost):
        xc = 1.0 + i
        xl, xr = Xg(xc - 0.28), Xg(xc + 0.28)
        f.rect(xl, Yg(v), xr - xl, Yg(0) - Yg(v), fill=col, stroke="none", sw=0)
        f.text((xl + xr) / 2, Yg(v) - 1.0, f"{v:.0f}", size=5.6, anchor="middle",
               weight="bold", fill=col)
        f.text((xl + xr) / 2, Yg(0) + 3.0, lab, size=5.4, anchor="middle")
    f.text(Xg(1.5), Yg(topg * 0.90),
           f"{cost[1][1] / cost[0][1]:.1f}×", size=6.4, anchor="middle",
           weight="bold", fill=GREY)

    y = yr3 + ph + 15.2

    # -------------------------------------------------- provenance footer ----
    # Findings live in figs/captions/fig4.md, not on the artwork.
    dist = m.get("distortion_px") or {}
    kp2 = sum(s.get("keypoints_used", 0) for s in per2)
    f.text(M, y,
           f"All panels: the same {m['n_sessions']} BMimica sessions, "
           f"{m['cameras']} cameras, {m['n_calibrations']} calibrations. "
           f"c–f {nk:,} keypoints at stride {m.get('stride')}; "
           f"b {kp2:,} at stride {per2[0].get('stride')}. "
           f"Median lens-distortion displacement "
           f"{dist.get('p50', float('nan')):.1f} px "
           f"(p95 {dist.get('p95', float('nan')):.1f}).",
           size=5.4, fill=GREY)
    y += 2.4

    f.height = round(y + 3.0, 1)
    check_type_floor(f)
    f.write(os.path.join(OUT, "fig4.svg"))
    caption_numbers(m, f2, e3, per2)


def boot_ci(vals, iters=4000, seed=12345, lo=2.5, hi=97.5):
    """Percentile bootstrap over SESSIONS -- the independent unit here. Pooling the
    4 M keypoints would give an interval of meaningless width, because keypoints
    within a session are correlated."""
    import random
    rnd = random.Random(seed)
    n = len(vals)
    meds = []
    for _ in range(iters):
        meds.append(st.median([vals[rnd.randrange(n)] for _ in range(n)]))
    meds.sort()
    return (meds[int(len(meds) * lo / 100)], meds[int(len(meds) * hi / 100)])


def caption_numbers(m, f2, e3, per2):
    """
    Every number quoted in figs/captions/fig4.md, printed from the deposited data so
    the caption can be checked against this output rather than retyped. The audit that
    prompted this figure's rebuild found four caption values that no data file
    contained; this is the cheap structural fix.
    """
    ps = m["per_session"]
    dlt, ba = m["methods"]["dlt"], m["methods"]["ba"]
    ho, hp = m["heldout_reproj_px"], m["heldout_paired"]
    obs_d = [s["reproj_p50"]["ba"] - s["reproj_p50"]["dlt"] for s in ps
             if s["reproj_p50"]["dlt"] is not None]
    ho_d = [s["heldout_p50"]["ba"] - s["heldout_p50"]["dlt"] for s in ps
            if s["heldout_p50"]["dlt"] is not None]
    hv = m["heldout_by_views"]["by_k"]
    kk = sorted(int(k) for k in hv)
    out = [
        f"n: {m['n_sessions']} sessions, {m['n_calibrations']} calibrations, "
        f"{m['cameras']} cameras, {m['keypoints']:,} keypoints at stride {m['stride']}",
        f"panel b: {sum(s.get('keypoints_used', 0) for s in per2):,} keypoints at "
        f"stride {per2[0].get('stride')} over {len(per2)} sessions; "
        + " / ".join(f"{k}v {e3[k]:.2f} mm" for k in ("2", "3", "4", "5"))
        + f"; ratio {e3['2'] / e3['5']:.2f}x; alignment residual median "
        f"{st.median([s['align']['resid_med'] for s in f2['per_session']]):.2f} mm",
        "panel c: " + " / ".join(
            f"{k} n={m['robust'][k]['n']:,} p50 {m['robust'][k]['moved_mm']['p50']:.2f} "
            f"p95 {m['robust'][k]['moved_mm']['p95']:.1f} mm"
            for k in ("clean", "mid", "outlier") if k in m["robust"]),
        "panel d: " + " / ".join(
            f"{k}v DLT {hv[str(k)]['dlt']['p50']:.3f} refined {hv[str(k)]['ba']['p50']:.3f}"
            for k in kk) + f" px (n {hv[str(kk[0])]['dlt']['n']:,} keypoints)",
        f"panel e observed (drawn: median across sessions) DLT "
        f"{st.median([s['reproj_p50']['dlt'] for s in ps]):.3f} -> refined "
        f"{st.median([s['reproj_p50']['ba'] for s in ps]):.3f} px; "
        f"pooled over keypoints DLT {dlt['reproj_px']['p50']:.3f} -> refined "
        f"{ba['reproj_px']['p50']:.3f} px "
        f"({(ba['reproj_px']['p50'] / dlt['reproj_px']['p50'] - 1) * 100:+.1f}%), "
        f"per-session median delta {st.median(obs_d):+.3f} px "
        f"[{boot_ci(obs_d)[0]:+.3f}, {boot_ci(obs_d)[1]:+.3f}], "
        f"DLT lower in {sum(1 for d in obs_d if d > 0)}/{len(obs_d)}",
        f"panel e held-out (drawn: median across sessions) DLT "
        f"{st.median([s['heldout_p50']['dlt'] for s in ps]):.3f} -> refined "
        f"{st.median([s['heldout_p50']['ba'] for s in ps]):.3f} px; "
        f"pooled DLT {ho['dlt']['p50']:.3f} -> refined {ho['ba']['p50']:.3f} px "
        f"({(ho['ba']['p50'] / ho['dlt']['p50'] - 1) * 100:+.1f}%), "
        f"per-session median delta {st.median(ho_d):+.3f} px "
        f"[{boot_ci(ho_d)[0]:+.3f}, {boot_ci(ho_d)[1]:+.3f}], "
        f"DLT lower in {sum(1 for d in ho_d if d > 0)}/{len(ho_d)}; "
        f"refined better on {hp['ba_better_frac'] * 100:.1f}% of {hp['n']:,} held-out views",
        f"NOT PLOTTED (caption Methods only): {m['worse_than_dlt']['ba'] / m['worse_than_dlt']['of'] * 100:.2f}% "
        f"above 0, pre-#113 "
        f"{m['worse_than_dlt']['ba_legacy'] / m['worse_than_dlt']['of'] * 100:.1f}% "
        f"({m['worse_than_dlt']['ba_legacy']:,}/{m['worse_than_dlt']['of']:,}); "
        f"regression magnitude p50 {m['legacy_regression_px']['p50']:.3f} "
        f"p99 {m['legacy_regression_px']['p99']:.3f} px; shipped delta p50 "
        f"{m['diff_vs_dlt_px']['ba']['p50']:.3f} px",
        f"panel g: DLT {dlt['us_per_keypoint']:.1f} vs refined "
        f"{ba['us_per_keypoint']:.1f} us/keypoint "
        f"({ba['us_per_keypoint'] / dlt['us_per_keypoint']:.1f}x)",
        f"not plotted: reference's own reprojection error p50 "
        f"{m['reference_reproj_px']['p50']:.3f} px vs DLT {dlt['reproj_px']['p50']:.3f} "
        f"and refined {ba['reproj_px']['p50']:.3f} -- why no 3D comparison is made; "
        f"guard returned the DLT seed on {m['guard']['returned_seed']:,}/"
        f"{m['guard']['of']:,}",
        f"distortion: median {m['distortion_px']['p50']:.2f} px, "
        f"p95 {m['distortion_px']['p95']:.2f}, n {m['distortion_px']['n']:,}",
    ]
    print("\n".join("[caption] " + s for s in out))


if __name__ == "__main__":
    main()
