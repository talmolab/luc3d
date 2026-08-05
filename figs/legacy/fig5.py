#!/usr/bin/env python3
"""
Fig 5 — Proofreading is targeted, not exhaustive.

The argument. Once a frame is triangulated, every keypoint carries a number that says
how much the cameras disagree about it, and that number needs no ground truth. If the
disagreement predicts where a human actually had to intervene, then review effort spent
worst-first buys far more than review effort spent in frame order. The figure shows the
signal the app reports (a), the loop it supports today (b), and how well the signal
predicts the real corrections (c, d) — measured on 74 real sessions.

  a  What the app reports for the frame you are on: the reprojection against the
     detection, and the per-view reprojection error for every animal in the frame.
     Staged from an ALL-VIEWS solve on purpose. An earlier draft borrowed Fig 2a's
     tiles and numbers, which come from a deliberately crippled TWO-ANCHOR solve --
     every non-anchor residual there is inflated by construction (up to 24.6 px),
     which is Fig 2's point and the opposite of this one. Fig 5 is about proofreading
     a fully-informed 3D, so panel a now has its own staging run.
  b  The loop LUC3D supports today. Deliberately drawn WITHOUT any ranking step,
     because there is none (see the note on WORKFLOW below).
  c  Does the signal predict where a human actually intervened? Ranking keypoints by
     reprojection error and then reporting captured reprojection error would be
     circular. So the payload is the REAL correction distance (how far the raw
     detection sits from the proofread answer, which needs the answer), while the
     ranking uses only the cross-view residual (which does not). Compared against
     ranking by detector confidence — the obvious alternative — against an oracle that
     ranks by the answer itself, and against random order (the diagonal).
  d  The same comparison per session, so the pooled curve in c cannot hide a corpus in
     which the residual only wins on average.

Panel a and panels c/d are different corpora — an 8-camera HardFight recording for the
app staging (it is the only session built as an app session with a calibration) and 74
SLAP-2M sessions for the measurement. The footer says so on the artwork.

Inputs:
  node figs/fig5_panel_a.mjs    -> figs/out/fig5a-*.png + fig5a.json             (a)
  figs/fig6_detections.py       -> figs/out/fig6_detections.json                 (c, d)

Usage: python3 figs/fig5.py
       node figs/render.mjs figs/out/fig5.svg 600
"""
import argparse
import json
import math
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nature import (Figure, COL2, GREY, LIGHT, FILL, ACCENT, ACCENT2, PT,
                    text_width)  # noqa: E402

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")

# Okabe-Ito, plus a three-step grey ramp for the per-animal bars in a. The bars are
# deliberately GREY: orange/blue carry a fixed meaning in c and d (which ranking), and
# a colour that means "animal 2" in one panel and "detector confidence" in another is
# the kind of thing a reader silently mis-reads. Bar LENGTH already encodes magnitude,
# so nothing is lost. (The identity colours inside the image tiles are the app's own
# pure #00ff00/#00ffff/#ff00ff, baked into the exported PNGs; they cannot be recoloured
# here without re-running the app.)
ANIMAL_GREYS = ["#D9D9D9", "#8C8C8C", "#404040"]
MIDGREY = "#8C8C8C"

# CORRECTED against the source, and re-verified for this revision. An earlier draft
# claimed "Rank by error / worst disagreement first" and "Re-triangulate / only what
# changed". Neither exists:
#   * There is no global ranking, sort-by-error, worst-frame navigation, error-coloured
#     timeline or needs-review flag anywhere in ui/, pose/ or import-export/. Every
#     .sort() in ui/ orders by name, label, track index or frame index; the per-instance
#     error breakdown is sorted ALPHABETICALLY on purpose (ui/info-panel.js:1465-1474,
#     "stable reading order across frames"). ui/timeline.js contains zero occurrences of
#     "error". ACTION_CATALOG has no error-navigation binding. The one project-wide
#     aggregator, getFrameStats (ui/overlays.js:2299), is referenced only by tests.
#     grep for sortBy / worklist / needsReview / worstFrame / jumpToError: no hits.
#   * A dirty flag exists (pose/pose-data.js:956) but nothing reads it to select what to
#     re-solve; `t` re-solves every group on the current frame
#     (pose/triangulation.js:2293).
#   * The one place the app acts on the residual by itself is the robust-triangulation
#     setting `reprojErrorThreshold` (ui/settings.js:327), which DROPS a high-error view
#     inside the solve. That is not a review order, and it is not depicted here.
# What the app really gives you is the per-node, per-view error for the frame you are on
# (ui/info-panel.js:1280-1503), which is what a and b show.
WORKFLOW = [
    ("Triangulate\nall", "every frame, every group", "triangulate"),
    ("Read the\nerror", "per node, per view, this frame", "ids"),
    ("Fix", "accept, nudge, or drop a view", "check"),
    ("Re-triangulate", "the frame you fixed", "cube"),
    ("Export", ".slp 2.8 / H5", "file"),
]

FRACS = [0.01, 0.05, 0.10, 0.20]
# (json key, colour, on-panel label) -- all three series, checked present below.
SERIES = [
    ("capture_by_oracle", GREY, "oracle"),
    ("capture_by_reproj", ACCENT2, "cross-view residual"),
    ("capture_by_lowconf", ACCENT, "detector confidence"),
]


def load(name, required=True):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        if required:
            sys.exit(f"missing figs/out/{name} -- see the header of this file")
        return None
    with open(p) as f:
        return json.load(f)


def curve(sessions, field):
    """Mean over sessions of the capture fraction at each review budget.

    Session-mean, not keypoint-weighted: each session is one measurement of the
    ranking's usefulness. It coincides to 5 decimal places with the difficulty-stratum
    weighted mean the audit reproduced (0.26953 at a 10% budget), so the panel numbers
    and the caption numbers cannot drift apart.
    """
    pts = [(0.0, 0.0)]
    for fr in FRACS:
        vals = [s[field][str(fr)] for s in sessions
                if s.get(field) and s[field].get(str(fr)) is not None]
        if vals:
            pts.append((fr, sum(vals) / len(vals)))
    return pts


def at(pts, x):
    """Linear interpolation into a capture curve -- used only to place labels."""
    for (x0, y0), (x1, y1) in zip(pts, pts[1:]):
        if x0 <= x <= x1:
            t = (x - x0) / (x1 - x0) if x1 > x0 else 0.0
            return y0 + t * (y1 - y0)
    return pts[-1][1]


def main():
    argparse.ArgumentParser().parse_args()
    # fig5a.json ONLY -- never fig2-protocol.json. Fig 2a's run solves the 3D from two
    # anchor views, so its per-view residuals are inflated by construction and are not
    # what a proofreader sees. Panel a has its own all-views staging run.
    prot = load("fig5a.json", required=False)
    det = load("fig6_detections.json", required=False)

    W = COL2
    f = Figure(width=W, height=170.0)
    M = 0.0
    y = 3.2

    # ================================================================= a =====
    f.panel(M, y, "a")
    f.text(M + 5.0, y, "Per-view reprojection error", size=7, weight="bold")
    y += 3.4

    aw = 86.0
    ah = 42.0
    if prot and prot.get("views", {}).get("check"):
        views = prot["views"]["check"]
        tw = (aw - 1.6) / 2
        # LEFT tile: the frame as the app shows it, all animals, all overlays.
        v = views[0]
        b = v["bbox"]
        f.image(M, y, tw, ah, os.path.join(OUT, os.path.basename(v["file"])),
                crop=(b["x0"], b["y0"], b["x1"], b["y1"]),
                src_size=(v["width"], v["height"]),
                label=v["name"].replace("Camera", "cam ").replace("_", " "),
                label_size=5.2)
        # RIGHT tile: the single (view, animal) with the largest residual among the
        # exported views, cropped to that animal. At an all-views solve most keypoints
        # agree to ~3 px, which is invisible at print size -- so a whole-frame tile
        # alone would illustrate nothing. This is the one place the disagreement is
        # actually SEEABLE, and the bar chart says it is 16.8 px, not "large".
        pick = None
        for vv in views:
            for det_i in (vv.get("details") or []):
                for r in ((prot or {}).get("reprojErrorsAllViews") or []):
                    if det_i.get("identity") != f"id_{r.get('identity')}":
                        continue
                    e = (r.get("perView") or {}).get(vv["name"])
                    if e is not None and (pick is None or e > pick[0]):
                        pick = (e, vv, det_i)
        if pick:
            err, vv, det_i = pick
            bx0, by0, bx1, by1 = det_i["box"]
            pad = 0.40 * max(bx1 - bx0, by1 - by0)
            f.image(M + tw + 1.6, y, tw, ah,
                    os.path.join(OUT, os.path.basename(vv["file"])),
                    crop=(bx0 - pad, by0 - pad, bx1 + pad, by1 + pad),
                    src_size=(vv["width"], vv["height"]),
                    label=(vv["name"].replace("Camera", "cam ").replace("_", " ")
                           + " · " + det_i["identity"].replace("id_", "animal ")),
                    label_size=5.2, corner=f"{err:.1f} px")
        f.text(M, y + ah + 2.6,
               "solid = detected · dotted = reprojected from the 3D · red = the error",
               size=5.4, fill=GREY)
    else:
        f.rect(M, y, aw, ah, fill="#FAFAFA", stroke=LIGHT, sw=0.4 * PT, dash="1.4,1.0")
        f.text(M + aw / 2, y + ah / 2, "run node figs/fig5_panel_a.mjs", size=5.4,
               anchor="middle", fill=ACCENT2)

    # ---- the per-view readout, from the app's own numbers -------------------
    # Was a 24-row table of labelled bars (3 animals x 8 views) that ran ~60 mm tall,
    # overshot the tiles, pushed prose into panel b and printed every value at 4.6 pt --
    # below the 5 pt print floor, on the numbers a reader is meant to read. Same numbers,
    # one small grouped bar chart with an axis in pixels: a third of the height, nothing
    # under 5 pt, and views can be compared ACROSS animals by eye.
    bx = M + aw + 8.0
    recs = (prot or {}).get("reprojErrorsAllViews") or []
    cams = (prot or {}).get("cameras") or []
    if recs and cams:
        px0 = bx + 9.5
        pw = W - px0 - 1.0
        ph = 29.0
        py = y + 5.2
        worst = max(max((r.get("perView") or {}).values()) for r in recs)
        ymax = 5.0 * math.ceil(worst / 5.0)
        nc = len(cams)

        def X(v):
            return px0 + (v + 0.5) / nc * pw

        f.axes(px0, py, pw, ph, (-0.5, nc - 0.5), (0, ymax),
               ylabel="reprojection error (px)",
               yticks=[t for t in range(0, int(ymax) + 1, 5)], size=5.5,
               xticks=[])

        def Y(v):
            return py + ph - v / ymax * ph

        bwid = 0.92 / max(1, len(recs))
        for ai, rec in enumerate(recs):
            per = rec.get("perView") or {}
            col = ANIMAL_GREYS[ai % len(ANIMAL_GREYS)]
            for ci, cam in enumerate(cams):
                v = per.get(cam)
                if v is None:
                    continue
                x0 = X(ci - 0.46 + ai * bwid)
                f.rect(x0, Y(v), X(0) - X(-bwid), Y(0) - Y(v), fill=col,
                       stroke=MIDGREY if ai == 0 else "none",
                       sw=0.3 * PT if ai == 0 else 0)
        for ci, cam in enumerate(cams):
            f.text(X(ci), py + ph + 0.8 + 5.0 * PT + 0.3,
                   cam.replace("Camera", "").replace("_", " "), size=5.0,
                   anchor="middle")
        # legend: one line, above the plot
        lx = px0
        for ai, rec in enumerate(recs):
            f.rect(lx, py - 3.4, 2.2, 1.4, fill=ANIMAL_GREYS[ai % 3],
                   stroke=MIDGREY if ai == 0 else "none",
                   sw=0.3 * PT if ai == 0 else 0)
            lab = f"animal {rec.get('identity')}"
            f.text(lx + 2.9, py - 2.3, lab, size=5.2)
            lx += 2.9 + text_width(lab, 5.2) + 4.0

    y += ah + 5.6

    # ================================================================= b =====
    f.panel(M, y, "b")
    f.text(M + 5.0, y, "Proofreading loop", size=7, weight="bold")
    y += 3.0

    n = len(WORKFLOW)
    gap = 4.0
    sw_ = (W - (n - 1) * gap) / n
    sh_ = 17.0
    for i, (title, sub, ic) in enumerate(WORKFLOW):
        sx = M + i * (sw_ + gap)
        f.stage(sx, y, sw_, sh_, title, sub=sub, icon_kind=ic,
                fill="#FFFFFF" if i in (1, 2) else FILL,
                accent=ACCENT if i in (1, 2) else None)
        if i:
            f.chevron(sx - gap + (gap - 2.2) / 2, y + sh_ / 2, 3.0)
    yb = y + sh_ + 1.4
    # Four words, and they are the honesty guard: the app has no ranked worklist, so the
    # read-and-fix stages happen on whichever frame you are on. c and d measure what a
    # ranking WOULD buy; nothing here should let a reader infer the GUI ranks anything.
    f.bracket(M + (sw_ + gap), M + 3 * sw_ + 2 * gap, yb,
              "one frame at a time", size=5.6, color=ACCENT, depth=1.0)
    y = yb + 6.6

    # =============================================================== c, d =====
    # 5c was the panel that failed: three curves, a right-hand column of four
    # statistics, a sentence of explanation and a label per series. It is now ONE
    # question -- how much of the work do you find for how much looking -- with the
    # series named on the curves and exactly three numbers, at the 10% budget.
    if det and det.get("sessions"):
        S = det["sessions"]
        n_s = len(S)
        n_k = sum(s.get("n_keypoints", 0) for s in S)
        rows = [(lab, col, curve(S, field)) for field, col, lab in SERIES]
        missing = [lab for lab, _, pts in rows if len(pts) < 2]
        if missing:  # a silently absent series is how the oracle vanished once before
            sys.exit(f"fig5c: no data for {missing} in fig6_detections.json")

        f.panel(M, y, "c")
        f.text(M + 5.0, y, "Correction found per review budget", size=7, weight="bold")

        cx0, cw, ch = 11.0, 99.0, 38.0
        cy = y + 3.6
        XLIM, YLIM = 20.0, 50.0
        X, Y = f.axes(cx0, cy, cw, ch, (0, XLIM), (0, YLIM),
                      xlabel="keypoints reviewed, worst first (%)",
                      ylabel="correction found (%)",
                      xticks=[0, 5, 10, 15, 20],
                      yticks=[0, 10, 20, 30, 40, 50], size=6)
        # reviewing in random order finds exactly what you look at
        f.line(X(0), Y(0), X(XLIM), Y(XLIM), stroke=LIGHT, sw=0.5 * PT, dash="1.2,0.9")
        ang = -math.degrees(math.atan2(XLIM / YLIM * ch, cw))
        f.text(X(6.4), Y(6.4) + 2.3, "random", size=5.0, fill=MIDGREY, rotate=ang)
        f.line(X(10), Y(0), X(10), Y(46.5), stroke=GREY, sw=0.4 * PT, dash="0.8,0.6")
        f.text(X(10) + 0.9, Y(48.6), "10% budget", size=5.2, fill=GREY)

        for lab, col, pts in rows:
            f.polyline([(X(a * 100), Y(b * 100)) for a, b in pts], color=col,
                       sw=0.95 * PT)
            for a, b in pts[1:]:
                f.marker(X(a * 100), Y(b * 100), color=col, r=0.55)
        # series named on their own curves: no legend to cross-reference, and the
        # labels sit in the empty side of each curve so nothing crosses a line
        f.text(X(13.6), Y(at(rows[0][2], 0.136) * 100) - 1.4, "oracle", size=5.4,
               fill=GREY)
        f.text(X(13.6), Y(at(rows[1][2], 0.136) * 100) + 2.6, "cross-view residual",
               size=5.4, fill=ACCENT2, weight="bold")
        f.text(X(12.6), Y(at(rows[2][2], 0.126) * 100) - 1.4, "detector confidence",
               size=5.4, fill=ACCENT)
        # the three numbers a reader should leave with: 27 vs 12, against 32 at best
        v_or = at(rows[0][2], 0.10) * 100
        v_rj = at(rows[1][2], 0.10) * 100
        v_lc = at(rows[2][2], 0.10) * 100
        f.text(X(10) - 1.1, Y(v_or) - 1.1, f"{v_or:.0f}", size=5.8, anchor="end",
               fill=GREY)
        f.text(X(10) + 1.1, Y(v_rj) - 1.1, f"{v_rj:.0f}", size=6.6, weight="bold",
               fill=ACCENT2)
        f.text(X(10) + 1.1, Y(v_lc) - 1.1, f"{v_lc:.0f}", size=5.8, fill=ACCENT)
        # ... and the fourth, which is the one that keeps the comparison honest:
        # random order finds 10%, so confidence at 12% is barely distinguishable from
        # looking in no order at all. Quoting "2.3x confidence" without it flatters us.
        f.text(X(10) + 1.1, Y(10.0) + 2.0, "10", size=5.4, fill=MIDGREY)

        # -------------------------------------------------------------- d ----
        # Guards the pooled curve: a corpus where the residual won on average and lost
        # in a third of the sessions would look identical in c.
        dx0 = 132.0
        f.panel(dx0 - 8.0, y, "d")
        f.text(dx0 - 3.0, y, "Per session, 10% budget", size=7, weight="bold")
        dw = dh = 38.0
        # Unequal ranges (x to 20, y to 50) on purpose: on equal 0-50 axes the whole
        # corpus collapses into a 15%-of-area blob and the spread is unreadable. The
        # claim here is binary -- above the line or below it -- and the line is labelled
        # on itself, so the honest reading survives the axis scaling.
        DLX, DLY = 20.0, 50.0
        Xd, Yd = f.axes(dx0, cy, dw, dh, (0, DLX), (0, DLY),
                        xlabel="found by confidence (%)",
                        ylabel="found by residual (%)",
                        xticks=[0, 10, 20], yticks=[0, 25, 50], size=6)
        f.line(Xd(0), Yd(0), Xd(DLX), Yd(DLX), stroke=LIGHT, sw=0.5 * PT, dash="1.2,0.9")
        f.text(Xd(14.0), Yd(14.0) + 2.4, "equal", size=5.0, fill=MIDGREY,
               rotate=-math.degrees(math.atan2(DLX / DLY * dh, dw)))
        pair = [(s["capture_by_lowconf"]["0.1"] * 100, s["capture_by_reproj"]["0.1"] * 100)
                for s in S
                if s.get("capture_by_lowconf") and s.get("capture_by_reproj")]
        for a, b in pair:
            f.marker(Xd(a), Yd(b), color=ACCENT2, r=0.42, sw=0.15 * PT)
        f.text(Xd(0.6), Yd(47.0), f"n = {len(pair)}", size=5.2, fill=GREY)

        y = cy + ch + 0.8 + 6.0 * PT * 2.6 + 3.4

        # ---------------------------------------------- provenance footer ----
        # Prose lives in figs/captions/fig5.md. This line exists so no number on the
        # artwork is unattributed, and so the figure itself never implies a feature.
        ncam = len((prot or {}).get("cameras") or [])
        f.text(M, y,
               f"Different corpora: a is one frame of an {ncam}-camera recording in "
               f"LUC3D, 3D solved from all {ncam} views (the app's normal state, not a "
               f"held-out or anchored solve); c and d are {n_s} SLAP-2M sessions, "
               f"{n_k:,} keypoints.",
               size=5.2, fill=GREY)
        y += 2.4
        f.text(M, y,
               "The ranking in c and d is a property of the residual, measured offline: "
               "LUC3D reports the residual for the frame you are on and has no ranked "
               "worklist, sort or filter.",
               size=5.2, fill=GREY)
        y += 2.0
    else:
        f.panel(M, y, "c")
        f.text(M + 5.0, y + 6.0, "run figs/fig6_detections.py", size=5.4, fill=ACCENT2)
        y += 12.0

    f.height = round(y + 3.0, 1)
    f.write(os.path.join(OUT, "fig5.svg"))


if __name__ == "__main__":
    main()
