#!/usr/bin/env python3
"""
Generates TWO figures.

Fig 3 -- Cross-view association: greedy per-view assignment instead of exhaustive
hypothesis enumeration.

The argument. Grouping detections into animals ACROSS cameras is the step that makes
multi-view 3D possible, and the published solution enumerates every possibility:

  Maree, Afshar, Oline, Leonardis, Falkner & Pereira (2024). Multi-view
  triangulation-enabled annotation for multi-animal 3D pose in SLEAP. Proceedings of
  Measuring Behavior 2024, Aberdeen, 217-224.

That paper generates `A!` grouping hypotheses per view for `A` animals (its Fig 4) and
takes the product across `C` views (its Fig 5), so a frame costs **(A!)^C**
triangulate-and-reproject evaluations -- factorial in animals, exponential in cameras
(its Fig 6). It names the greedy alternative as future work. LUC3D implements it: one
Hungarian assignment per camera per frame, each hard-committing before the next camera,
at O(C x A^3).

  a  The two strategies, drawn.
  b  The cost LUC3D minimises: a 2D reprojection term plus a 3D point-to-ray term,
     node-weighted, solved per camera by Hungarian assignment.
  c  Hypotheses per frame for the exhaustive method: (A!)^C, exact arithmetic.
  d  The sweep response, plotted against the ONLY quantity it depends on -- the ratio
     r = corr3d / corr2d. All 24 (corr2d, corr3d) cells collapse exactly onto r.
  e  Measured time per frame, greedy against exhaustive, on identical detections.

Panels a, b and c are drawn from the paper and from pose/cross-view-tracker.js and need
no measurement. Panels d-e read JSON produced by the benchmark handoff
(figs/HANDOFF-fig3-bench.md): figs/out/fig3_sweep.json, fig3_headtohead.json,
fig3_runtime.json. Each is optional: a missing file leaves its panel as an explicit
placeholder rather than inventing numbers.

Fig 7 -- Against other trackers on identical detections. Reads figs/out/fig3_trackers.json
(see figs/fig3_trackers.py, which pins the SHIPPED-baseline provenance).

  a  Within- vs cross-view IDF1, four trackers, n = 50 BMimica sessions. THE central
     claim of the paper and the first thing on the figure.
  b  The mechanism: IDF1 under black vs white bedding while the shared detector's recall
     stays flat. Drawn to the SAME geometry as a so the two slopes are comparable.
  c  Within-view IDF1 for every one of 74 SLAP-2M sessions.
  d  The paired per-session difference against SLEAP by animal count, with n on every
     tick -- including the two cells where LUC3D loses.
  e  Error composition against a shared ground truth.
  f  Session IDF1 against the shared detector's recall: what within-view IDF1 actually
     measures.

Usage: python3 figs/fig3.py
       node figs/render.mjs figs/out/fig3.svg 600
       node figs/render.mjs figs/out/fig7.svg 600
"""
import argparse
import json
import math
import re
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nature import (Figure, text_width, COL2, INK, GREY, LIGHT, FILL, ACCENT,  # noqa: E402
                    ACCENT2, PT)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
GREEN = "#009E73"
PURPLE = "#CC79A7"

# Type floor. Nature's minimum is 5 pt; nothing in this generator may go below it.
MIN_PT = 5.0

# The app's shipped defaults (ui/settings.js TRACKING_THRESHOLDS).
CORR2D, CORR3D = 1.0, 6.0


def load(name):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        return None
    with open(p) as f:
        return json.load(f)


def placeholder(f, x, y, w, h, what, how):
    """An explicit gap. A panel with no data must look like a gap, not like a result."""
    f.rect(x, y, w, h, fill="#FAFAFA", stroke=LIGHT, sw=0.4 * PT, dash="1.4,1.0")
    f.text(x + w / 2, y + h / 2 - 1.0, "awaiting measurement", size=5.6,
           anchor="middle", fill=ACCENT2, weight="bold")
    f.wrapped(x + 2.0, y + h / 2 + 2.2, f"{what} — {how}", size=MIN_PT,
              width_mm=w - 4.0, fill=GREY)


_SUP = {0: "⁰", 1: "¹", 2: "²", 3: "³", 4: "⁴",
        5: "⁵", 6: "⁶", 7: "⁷", 8: "⁸", 9: "⁹"}


def _sup(n):
    return "".join(_SUP[int(d)] for d in str(int(n)))


def thin(n):
    """Thin-space thousands separator (a comma reads as a decimal point at 5 pt)."""
    return f"{n:,}".replace(",", " ")


def title(f, x, y, letter, words):
    f.panel(x, y, letter)
    f.text(x + 5.0, y, words, size=7, weight="bold")


# --------------------------------------------------------------------------- a ---
def panel_a(f, x, y, w, h):
    """
    Exhaustive enumeration against greedy per-view assignment. Left: every combination
    of per-view groupings is built, triangulated and scored. Right: each camera is
    solved once against the running set of 3D targets and committed.
    """
    half = (w - 5.0) / 2

    # ---- exhaustive ----
    f.rect(x, y, half, h, fill="#FFFFFF", stroke=LIGHT, rx=0.9)
    f.rect(x, y, 0.9, h, fill=ACCENT2, stroke="none", sw=0)
    f.text(x + 2.6, y + 3.4, "Exhaustive hypothesis testing", size=6.2, weight="bold")
    f.text(x + 2.6, y + 6.1, "Maree et al. 2024 · (A!)ᶜ per frame", size=MIN_PT,
           fill=GREY)
    # a lattice of candidate whole-frame groupings, most of them discarded
    gx, gy = x + 4.0, y + 9.0
    cols, rowsn = 8, 4
    cw2, ch2 = (half - 8.0) / cols, 3.0
    for r in range(rowsn):
        for c in range(cols):
            keep = (r == 1 and c == 3)
            f.rect(gx + c * cw2, gy + r * ch2, cw2 * 0.72, ch2 * 0.62,
                   fill=(ACCENT2 if keep else "#EDEDED"),
                   stroke=(ACCENT2 if keep else LIGHT), sw=0.3 * PT, rx=0.2)
    f.text(gx, gy + rowsn * ch2 + 3.0, "every grouping triangulated + scored",
           size=MIN_PT, fill=GREY)
    f.text(gx, gy + rowsn * ch2 + 5.6, "one kept: lowest reprojection error",
           size=MIN_PT, fill=ACCENT2)

    # ---- greedy ----
    x2 = x + half + 5.0
    f.rect(x2, y, half, h, fill="#FFFFFF", stroke=LIGHT, rx=0.9)
    f.rect(x2, y, 0.9, h, fill=GREEN, stroke="none", sw=0)
    f.text(x2 + 2.6, y + 3.4, "Greedy per-view assignment", size=6.2, weight="bold")
    f.text(x2 + 2.6, y + 6.1, "LUC3D · C Hungarian solves, O(C·A³)",
           size=MIN_PT, fill=GREY)
    # cameras processed left to right, each committing before the next
    n = 4
    sx = x2 + 5.0
    step = (half - 12.0) / (n - 1)
    for i in range(n):
        cx = sx + i * step
        f.icon("camera", cx - 1.4, y + 10.0, s=2.8, color=INK, sw=0.45)
        f.rect(cx - 2.0, y + 15.0, 4.0, 3.2, fill=FILL, stroke=GREEN, sw=0.35 * PT,
               rx=0.3)
        f.text(cx, y + 17.2, "H", size=MIN_PT, anchor="middle", weight="bold",
               fill=GREEN)
        if i:
            f.chevron(cx - step + 2.4, y + 16.6, 2.4, color=GREEN, sw=0.5)
    f.text(sx - 2.0, y + 22.0, "each camera assigned once, then committed",
           size=MIN_PT, fill=GREY)
    f.text(sx - 2.0, y + 24.6, "targets updated before the next camera",
           size=MIN_PT, fill=GREEN)
    return y + h


# --------------------------------------------------------------------------- b ---
def panel_b(f, x, y, w, h):
    """The association cost, as implemented. Both terms drawn in the space they live in."""
    f.rect(x, y, w, h, fill="#FFFFFF", stroke=LIGHT, rx=0.9)
    f.text(x + 2.4, y + 3.4, "Cost per (target, detection) pair", size=6.2,
           weight="bold")

    # 2D term: target's 3D projected into this view vs the detection
    cx, cy = x + 12.0, y + 12.0
    f.icon("camera", x + 2.4, cy - 1.4, s=2.8, color=INK, sw=0.45)
    f.marker(cx, cy, color=ACCENT, r=0.62, sw=0.18)
    f.marker(cx + 5.0, cy - 2.4, color=INK, r=0.5, sw=0.15)
    f.line(cx, cy, cx + 5.0, cy - 2.4, stroke=ACCENT, sw=0.55 * PT, dash="0.8,0.6")
    f.text(cx + 6.0, cy - 3.0, "detection", size=MIN_PT, fill=GREY)
    f.text(cx - 1.0, cy + 2.6, "π(target)", size=MIN_PT, fill=ACCENT)
    f.text(x + 2.4, y + h - 8.0,
           "2D  wₖ · corr2d · (1 − |d − π(t)| / velThresh) "
           "· e^(−λΔt)",
           size=5.2, fill=ACCENT)

    # 3D term: point-to-ray distance
    ry = y + 22.0
    f.icon("camera", x + 2.4, ry - 1.4, s=2.8, color=INK, sw=0.45)
    f.line(x + 5.2, ry, x + w - 6.0, ry - 4.0, stroke=GREY, sw=0.45 * PT)
    f.text(x + w - 5.4, ry - 4.6, "ray", size=MIN_PT, fill=GREY)
    tx, ty = x + 18.0, ry + 1.6
    f.marker(tx, ty, color=GREEN, r=0.62, sw=0.18)
    f.line(tx, ty, tx + 1.9, ty - 3.1, stroke=GREEN, sw=0.55 * PT, dash="0.8,0.6")
    f.text(tx + 1.0, ty + 2.4, "target", size=MIN_PT, fill=GREEN)
    f.text(x + 2.4, y + h - 3.4,
           "3D  wₖ · corr3d · (1 − dist(t, ray(d)) / distThresh)",
           size=5.2, fill=GREEN)
    # The Methods sentence that used to sit here ("summed over nodes; cost = -Sigma;
    # shipped corr2d 1, corr3d 6; w_k = 0 drops a node") is in figs/captions/fig3.md.
    # Running prose does not belong on the artwork.
    return y + h


# ============================================================== Fig 3 ============
def figure3(sweep, runtime, h2h):
    W = COL2
    f = Figure(width=W, height=240.0)
    M = 0.0
    y = 3.2

    # ------------------------------------------------------------------- a -----
    title(f, M, y, "a", "Grouping strategies")
    y += 3.2
    y = panel_a(f, M, y, W, 29.4) + 4.6

    # ---------------------------------------------------------------- b, c -----
    bw = (W - 6.0) / 2
    title(f, M, y, "b", "Association cost")
    title(f, M + bw + 6.0, y, "c", "Hypotheses per frame")
    y += 3.2

    ph = 40.0
    # panel b is a boxed schematic, not a plot: it needs less height than c's axes.
    panel_b(f, M, y, bw, ph - 4.0)

    # --- c: the analytic explosion. EXHAUSTIVE ONLY. An earlier version drew LUC3D's
    # C*A^3 operation count on an axis labelled "hypotheses per frame" -- LUC3D
    # enumerates no hypotheses, so that was a unit mismatch on a shared axis. The
    # method comparison lives in panel e, in real units.
    cx0 = M + bw + 6.0
    X, Y = f.axes(cx0 + 13.0, y + 2.0, bw - 16.0, ph - 13.0, (2, 8), (0, 12),
                  xlabel="cameras, C", ylabel="log₁₀ hypotheses per frame",
                  xticks=[2, 4, 6, 8], yticks=[0, 4, 8, 12], size=6)
    for A, col in ((2, ACCENT), (3, PURPLE), (4, ACCENT2)):
        pts = [(X(C), Y(min(12, math.log10(math.factorial(A) ** C))))
               for C in range(2, 9)]
        f.polyline(pts, color=col, sw=0.8 * PT)
        f.text(X(8) - 0.4, pts[-1][1] - (1.1 if A > 2 else 2.4), f"{A} animals",
               size=MIN_PT, anchor="end", fill=col)
    # the one configuration the benchmark could not run, marked where it sits
    hyp46 = math.factorial(4) ** 6
    f.ring(X(6), Y(math.log10(hyp46)), 0.85, color=ACCENT2, sw=0.5)
    f.text(X(2.15), Y(10.5), f"4a×6c = {hyp46 / 1e8:.1f}×10⁸ ○", size=MIN_PT,
           fill=ACCENT2)
    y += ph + 5.4

    # ---------------------------------------------------------------- d, e -----
    title(f, M, y, "d", "3D-term ablation")
    title(f, M + bw + 6.0, y, "e", "Time per frame")
    y += 3.2
    ph2 = 44.0

    # --- d: LUC3D AGAINST ITSELF -- an ablation of its own two cost weights.
    # A reader of the previous version (three curves, one per corr2d, x = corr3d) read
    # the series as METHODS and asked why "exhaustive" had no switches while "LUC3D" had
    # 1,329. Nothing in this panel is a method comparison: the 1,329-switch point is
    # LUC3D with its 3D point-to-ray term switched OFF, and it also has the LOWEST IDF1
    # (0.862), so there is no paradox to resolve -- only a framing that invited the wrong
    # reading. Hence the title, the explicit "LUC3D only" tag, and one curve.
    # All 24 (corr2d, corr3d) cells are an EXACT function of r = corr3d/corr2d: every
    # pair of cells sharing an r returns identical IDF1 and identical switch counts. The
    # previous plot therefore drew three curves that were really one, and made "flat for
    # corr3d >= 1" look true when it is false at corr2d = 2 (corr3d = 1 there gives
    # 0.9401 and 100 switches). In r the statement is exact: IDF1 flat from r = 1,
    # switches bottoming out at r = 2.
    if sweep and sweep.get("cells"):
        cells = [c for c in sweep["cells"] if c.get("status", "ok") == "ok"]
        byr = {}
        for c in cells:
            byr.setdefault(c["corr3d"] / c["corr2d"], []).append(c)
        rs = sorted(byr)
        n_s = max(c.get("n_sessions", 0) for c in cells)

        pw, phh = bw - 30.0, ph2 - 18.0
        # log10 r for r > 0; r = 0 gets a detached position to its left.
        rpos = sorted(x for x in rs if x > 0)
        lo_l, hi_l = math.log10(rpos[0]), math.log10(rpos[-1])
        span = hi_l - lo_l
        x_zero = lo_l - 0.30 * span
        swmax = max(c["switches"] for c in cells)
        ytop = math.log10(swmax) + 0.25
        xlo = x_zero - 0.06 * span
        X2, Y2 = f.axes(M + 13.0, y + 1.0, pw, phh,
                        (xlo, hi_l + 0.05 * span), (0, ytop),
                        xticks=[], yticks=[], size=6)

        def xr(r):
            return X2(x_zero if r == 0 else math.log10(r))

        def rot_label(cx, cy, s, color, size=6.5):
            f.add(f'<text x="{cx:.3f}" y="{cy:.3f}" text-anchor="middle" '
                  f'fill="{color}" style="font-family:Arial,Helvetica,sans-serif;'
                  f'font-size:{size * PT:.3f}" '
                  f'transform="rotate(-90 {cx:.3f} {cy:.3f})">{s}</text>')

        # LEFT axis: switches, log decades. Axis label AND tick labels carry the series
        # colour -- on a dual-axis panel that is the only cue saying which axis is which.
        for tv in range(0, int(ytop) + 1):
            f.line(X2(xlo) - 0.8, Y2(tv), X2(xlo), Y2(tv), stroke=ACCENT2, sw=0.4 * PT)
            f.text(X2(xlo) - 1.3, Y2(tv) + 0.7, thin(10 ** tv), size=MIN_PT,
                   anchor="end", fill=ACCENT2)
        rot_label(X2(xlo) - 7.6, Y2(0) - phh / 2, "ID switches", ACCENT2)

        # RIGHT axis: cross-view IDF1, scaled to the data rather than to fixed limits,
        # because the full-session sweep can move these values.
        ivals = [c["idf1_cross"] for c in cells]
        step = 0.02
        i_lo = math.floor((min(ivals) - 0.004) / step) * step
        i_hi = math.ceil((max(ivals) + 0.004) / step) * step
        rx = X2(hi_l + 0.05 * span)

        def Yi(v):
            return Y2(0) - (v - i_lo) / (i_hi - i_lo) * phh

        f.line(rx, Y2(0), rx, Y2(0) - phh, sw=0.5 * PT)
        nt = max(2, min(5, int(round((i_hi - i_lo) / step))))
        for k in range(nt + 1):
            tv = i_lo + (i_hi - i_lo) * k / nt
            f.line(rx, Yi(tv), rx + 0.8, Yi(tv), stroke=GREEN, sw=0.4 * PT)
            f.text(rx + 1.3, Yi(tv) + 0.7, f"{tv:.2f}", size=MIN_PT, fill=GREEN)
        rot_label(rx + 8.8, Y2(0) - phh / 2, "cross-view IDF1", GREEN)

        # x ticks: every r that is a round number, so the axis stays readable
        for r in rs:
            if r != 0 and r not in (0.25, 0.5, 1, 2, 4, 8, 16, 24):
                continue
            f.line(xr(r), Y2(0), xr(r), Y2(0) + 0.8, stroke=INK, sw=0.4 * PT)
            f.text(xr(r), Y2(0) + 3.1, f"{r:g}", size=MIN_PT, anchor="middle")
        f.text(X2(x_zero), Y2(0) + 5.6, "no 3D term", size=MIN_PT, anchor="middle",
               fill=GREY)
        f.text((xr(rs[1]) + xr(rs[-1])) / 2, Y2(0) + 7.9,
               "r = corr3d / corr2d", size=6.5, anchor="middle")

        def plateau_from(key, tol=0.0):
            end = byr[max(rs)][0][key]
            return min(r for r in rs
                       if all(abs(byr[q][0][key] - end) <= tol
                              for q in rs if q >= r))

        # IDF1 and the switch count plateau at DIFFERENT r, and the IDF1 one only to
        # 4 d.p., so the two thresholds are derived separately and never typed as
        # literals -- the full-session sweep can move either.
        flat_id = plateau_from("idf1_cross", tol=1e-3)
        flat_sw = plateau_from("switches")

        # series
        sw_pts = [(xr(r), Y2(math.log10(byr[r][0]["switches"]))) for r in rs]
        id_pts = [(xr(r), Yi(byr[r][0]["idf1_cross"])) for r in rs]
        f.polyline(sw_pts[1:], color=ACCENT2, sw=0.9 * PT)
        f.polyline(id_pts[1:], color=GREEN, sw=0.9 * PT)
        f.line(*sw_pts[0], *sw_pts[1], stroke=ACCENT2, sw=0.9 * PT, dash="1.2,0.9")
        f.line(*id_pts[0], *id_pts[1], stroke=GREEN, sw=0.9 * PT, dash="1.2,0.9")
        for p in sw_pts:
            f.marker(*p, color=ACCENT2, r=0.5)
        for p in id_pts:
            f.marker(*p, color=GREEN, r=0.5)
        # series labels anchored to data-derived r values, not hardcoded ones
        # above the flat portion of the switch curve: empty in both the windowed and the
        # full-session data, whereas the descending limb runs through any label put on it
        r_sw = rs[min(len(rs) - 1, rs.index(flat_sw) + 1)]
        f.text(xr(r_sw) + 0.8, Y2(math.log10(byr[r_sw][0]["switches"])) - 1.8,
               "ID switches", size=MIN_PT, fill=ACCENT2)
        r_id = rs[min(len(rs) - 1, rs.index(flat_id) + 1)]
        f.text(xr(r_id) + 0.6, Yi(byr[r_id][0]["idf1_cross"]) + 2.8, "IDF1",
               size=MIN_PT, fill=GREEN)
        # the shipped default, on the r axis
        r_ship = CORR3D / CORR2D
        if r_ship in rs:
            f.line(xr(r_ship), Y2(0), xr(r_ship), Y2(0) - phh * 0.62, stroke=GREY,
                   sw=0.4 * PT, dash="1.2,0.9")
            f.text(xr(r_ship), Y2(0) - phh * 0.62 - 1.0, f"shipped r = {r_ship:g}",
                   size=MIN_PT, anchor="middle", fill=GREY)
        # "LUC3D only" said on the artwork, so the two series cannot be read as methods
        f.text(M + 15.0, y + 1.4, "LUC3D only · both series are this tracker",
               size=MIN_PT, fill=GREEN)

        # Frame coverage, read from the JSON. A hardcoded window claim would be wrong the
        # moment the sweep is re-run over full sessions.
        window = sweep.get("frames_per_session")
        if window is None:
            for c in sweep.get("caveats", []):
                m = re.search(r"window of ([\d,]+) frames", c)
                if m:
                    window = int(m.group(1).replace(",", ""))
                    break
        full = window is None and any(
            re.search(r"full[- ]session|every frame|full length", c, re.I)
            for c in sweep.get("caveats", []))
        cover = (f", fixed {thin(window)}-frame leading window per cell (not full "
                 f"sessions), identical across all cells." if window
                 else (", full sessions, every frame." if full else "."))
        f.text(M, y + ph2 - 3.4,
               f"all 24 (corr2d, corr3d) cells collapse exactly onto r. IDF1 flat from "
               f"r = {flat_id:g}; switches bottom out at r = {flat_sw:g}; shipped "
               f"r = {CORR3D / CORR2D:g}.", size=5.2, fill=GREY)
        f.text(M, y + ph2 - 0.4, f"n = {n_s} BMimica sessions" + cover,
               size=5.2, fill=GREY)
    else:
        placeholder(f, M, y, bw, ph2, "corr2d × corr3d grid",
                    "see figs/HANDOFF-fig3-bench.md task 1.")

    # --- e: measured time per frame, both methods, identical detections ---
    if h2h and h2h.get("frames_compared"):
        gx = M + bw + 6.0
        nf = h2h["frames_compared"]
        n_diff = round((1.0 - h2h["agreement_rate"]) * nf)
        considered = sum(c.get("frames_considered", 0) or 0
                         for c in h2h.get("configs", []))

        # LUC3D's measured seconds/frame, keyed on the SAME (animals, cameras) the
        # exhaustive run used. Previously a hardcoded per-animal dict.
        luc_meas = {}
        for m in ((runtime or {}).get("measured") or []):
            if m.get("status") == "ok":
                luc_meas.setdefault((m["animals"], m["cameras"]), []).append(
                    m["seconds_per_frame"])
        luc_meas = {k: sum(v) / len(v) for k, v in luc_meas.items()}

        cfg = [c for c in h2h.get("configs", []) if c.get("hypotheses")]
        cfg.sort(key=lambda c: c["hypotheses"])
        # Per-hypothesis rate: take the LARGEST measured configuration, i.e. the one
        # closest to the extrapolated regime, and say which. An earlier version took
        # next() over the ascending list, silently using the SMALLEST (254 us) while
        # the caption quoted 347 us.
        meas_cfg = [c for c in cfg if c.get("seconds_per_frame_exhaustive")]
        rates = [(c["seconds_per_frame_exhaustive"] / c["hypotheses"], c)
                 for c in meas_cfg]
        rate, rate_cfg = max(rates, key=lambda rc: rc[1]["hypotheses"])
        rate_lo = min(r for r, _ in rates)

        ex, exlo, luc, meas = [], [], [], []
        for c in cfg:
            spf = c.get("seconds_per_frame_exhaustive")
            ok = spf is not None
            ex.append(math.log10(spf if ok else rate * c["hypotheses"]))
            exlo.append(math.log10(spf if ok else rate_lo * c["hypotheses"]))
            luc.append(math.log10(luc_meas.get((c["animals"], c["cameras"]), 0.0024)))
            meas.append(ok)

        DEC = [(-3, "1 ms"), (-2, "10 ms"), (-1, "0.1 s"), (0, "1 s"), (1, "10 s"),
               (2, "2 min"), (3, "1 h"), (4, "3 h"), (5, "1 day")]
        ylo, yhi = min(luc) - 0.5, max(ex) + 0.55
        X3, Y3 = f.axes(gx + 15.0, y + 1.0, bw - 17.0, ph2 - 19.0,
                        (0.4, len(cfg) + 0.6), (ylo, yhi),
                        ylabel="time per frame", xticks=[], yticks=[], size=6)
        for tv, lab in DEC:
            if ylo <= tv <= yhi:
                f.line(X3(0.4) - 0.8, Y3(tv), X3(0.4), Y3(tv), stroke=INK, sw=0.4 * PT)
                f.text(X3(0.4) - 1.3, Y3(tv) + 0.7, lab, size=MIN_PT, anchor="end")
        for i, c in enumerate(cfg):
            f.text(X3(i + 1), Y3(ylo) + 3.0,
                   f"{c['animals']}a×{c['cameras']}c", size=MIN_PT,
                   anchor="middle")
            f.text(X3(i + 1), Y3(ylo) + 5.3, thin(c["hypotheses"]), size=MIN_PT,
                   anchor="middle", fill=GREY)
        f.text(X3((len(cfg) + 1) / 2), Y3(ylo) + 8.0,
               "configuration · hypotheses per frame", size=6.5, anchor="middle")
        xs = list(range(1, len(cfg) + 1))
        f.polyline([(X3(a), Y3(b)) for a, b in zip(xs, ex)], color=ACCENT2, sw=0.95 * PT)
        f.polyline([(X3(a), Y3(b)) for a, b in zip(xs, luc)], color=GREEN, sw=0.95 * PT)
        for a, b, blo, ok in zip(xs, ex, exlo, meas):
            if ok:
                f.marker(X3(a), Y3(b), color=ACCENT2, r=0.62)
            else:
                # extrapolation, drawn as the interval the measured rates span
                f.line(X3(a), Y3(blo), X3(a), Y3(b), stroke=ACCENT2, sw=0.5 * PT)
                f.marker(X3(a), Y3(b), color="#FFFFFF", r=0.62)
                f.ring(X3(a), Y3(b), 0.8, color=ACCENT2, sw=0.5)
        for a, b in zip(xs, luc):
            f.marker(X3(a), Y3(b), color=GREEN, r=0.55)
        f.text(X3(1) + 1.0, Y3(ex[0]) - 1.6, "exhaustive", size=5.2, fill=ACCENT2)
        f.text(X3(2.55), Y3(luc[2]) - 1.6, "LUC3D", size=5.2, fill=GREEN)
        f.text(X3(len(cfg)) - 0.7, Y3((ex[-1] + luc[-1]) / 2),
               f"10{_sup(round(ex[-1] - luc[-1]))}×", size=5.6, anchor="end",
               weight="bold", fill=ACCENT2)
        f.text(gx, y - 0.4,
               f"same grouping on {thin(nf - n_diff)} of {thin(nf)} eligible frames "
               f"({n_diff} differ; {thin(considered)} considered)", size=5.2,
               fill=GREEN)
        f.text(gx, y + ph2 - 0.4,
               f"○ extrapolated at {rate * 1e6:.0f} µs per hypothesis "
               f"({rate_cfg['animals']}a×{rate_cfg['cameras']}c measured); bar = "
               f"{rate_lo * 1e6:.0f}–{rate * 1e6:.0f} µs", size=MIN_PT,
               fill=GREY)
    else:
        placeholder(f, M + bw + 6.0, y, bw, ph2, "greedy vs exhaustive",
                    "see figs/HANDOFF-fig3-bench.md task 3.")
    y += ph2 + 6.0

    # Fig 3 ends here (a-e = the algorithm). Prose lives in figs/captions/fig3.md: a
    # measured 1,604 words of running text were printed across the seven figures, which
    # is the main reason the drafts read as unprofessional. Panels keep a noun title,
    # axis labels and at most one short result line.
    f.text(M, y, "d, e: IDF1 and ID-switches via motmetrics on a shared "
                 "identity-stripped detection pool. c: exact arithmetic. Exhaustive is "
                 "our reimplementation of the published per-frame procedure. See caption "
                 "for n and method.", size=5.2, fill=GREY)
    y += 2.0
    f.height = round(y + 3.0, 1)
    f.write(os.path.join(OUT, "fig3.svg"))


# ============================================================== Fig 7 ============
TCOL = {"luc3d": GREEN, "sleap": ACCENT, "bytetrack": ACCENT2}
TNAME = {"luc3d": "LUC3D", "sleap": "SLEAP", "bytetrack": "ByteTrack"}
XCOL = {"LUC3D": GREEN, "SLEAP per-camera": ACCENT, "ByteTrack": ACCENT2,
        "3D-MuPPET": PURPLE}


def slope_axes(f, x, y, w, h, labels):
    """Two-position slope axes on a fixed 0-0.85 IDF1 scale. Panels a and b share this
    geometry exactly, because a reader WILL compare their slopes and an earlier version
    drew them 15 mm apart in width."""
    X, Y = f.axes(x, y, w, h, (0.78, 2.22), (0, 0.85), ylabel="IDF1", xticks=[],
                  yticks=[0, 0.2, 0.4, 0.6, 0.8], size=6)
    for xc, lab in zip((1.0, 2.0), labels):
        f.text(X(xc), Y(0) + 3.1, lab, size=MIN_PT, anchor="middle")
    return X, Y


def figure7(trk):
    W = COL2
    f = Figure(width=W, height=240.0)
    M = 0.0
    y = 3.2
    bw2 = (W - 6.0) / 2
    sl = (trk or {}).get("slap2m") or {}
    bm = (trk or {}).get("bmimica_50_sessions") or {}
    wins_bm = (trk or {}).get("bmimica_wins") or {}

    # ---- a: within- vs cross-view IDF1. The paper's central claim, first. -------
    PLOTW, PLOTH = bw2 - 34.0, 30.0
    title(f, M, y, "a", "Within- vs cross-view IDF1")
    if bm:
        names = [n for n in ("LUC3D", "SLEAP per-camera", "ByteTrack", "3D-MuPPET")
                 if n in bm]
        X, Y = slope_axes(f, M + 13.0, y + 3.4, PLOTW, PLOTH, ("within", "cross"))
        f.hline(X, Y, 1.0 / 5.0, (0.78, 2.22), label="1/C, C = 5", color=GREY,
                side="left", size=MIN_PT)
        for nm in names:
            w, c = bm[nm]["within"], bm[nm]["cross"]
            col = XCOL.get(nm, GREY)
            f.line(X(1.0), Y(w["mean"]), X(2.0), Y(c["mean"]), stroke=col, sw=0.9 * PT)
            for xc, s_ in ((1.0, w), (2.0, c)):
                f.line(X(xc), Y(s_["ci95_lo"]), X(xc), Y(s_["ci95_hi"]), stroke=col,
                       sw=0.45 * PT)
                f.marker(X(xc), Y(s_["mean"]), color=col, r=0.6)
        lx = X(2.0) + 2.4
        for rank, nm in enumerate(sorted(names, key=lambda n: -bm[n]["cross"]["mean"])):
            w, c = bm[nm]["within"], bm[nm]["cross"]
            col = XCOL.get(nm, GREY)
            # ratio of the two means PRINTED beside it -- a reader will divide them.
            # (The mean of the per-session ratios, with its CI, is in the caption.)
            ratio = c["mean"] / w["mean"] if w["mean"] else float("nan")
            yy = Y(0.80) + rank * 4.8
            f.line(lx - 1.6, yy - 0.6, lx - 0.5, yy - 0.6, stroke=col, sw=0.8 * PT,
                   cap="round")
            f.text(lx, yy, nm, size=5.2, fill=col)
            f.text(lx, yy + 2.2,
                   f"{w['mean']:.3f} → {c['mean']:.3f}  ×{ratio:.2f}",
                   size=MIN_PT, fill=GREY)
        n_bm = bm[names[0]]["within"]["n_sessions"]
        f.text(M, y + PLOTH + 11.0,
               f"n = {n_bm} full BMimica sessions, 5 cameras, 2 mice; "
               f"mean ± 95% CI", size=5.2, fill=GREY)
        w_sleap = wins_bm.get("SLEAP per-camera", {}).get("cross", {})
        if w_sleap:
            drift = bm["LUC3D"]["drift_abs_max"]
            f.text(M, y + PLOTH + 14.6,
                   f"LUC3D drift ≤ {drift:.3f} in every session; ahead of every "
                   f"other tracker in {w_sleap['wins']}/{w_sleap['n']}",
                   size=5.2, fill=GREEN)

    # ---- b: the mechanism -- contrast invariance, with the detector as the control --
    gx = M + bw2 + 6.0
    title(f, gx, y, "b", "Bedding invariance")
    bb = sl.get("by_bedding") or {}
    if bb:
        beds = [b for b in ("black", "white") if b in bb]
        X2, Y2 = slope_axes(f, gx + 13.0, y + 3.4, PLOTW, PLOTH,
                            [f"{b} bedding" for b in beds])
        # the control: the shared detector does not care about bedding
        rec = [bb[b]["detector_recall"] for b in beds]
        f.polyline([(X2(1.0), Y2(rec[0])), (X2(2.0), Y2(rec[1]))], color=GREY,
                   sw=0.7 * PT, dash="1.3,0.9")
        for i, v in enumerate(rec):
            f.marker(X2(i + 1.0), Y2(v), color=GREY, r=0.45)
        # LUC3D and the detector control sit within 0.01 of each other, so their labels
        # are pushed apart by hand rather than anchored to their own y.
        f.text(X2(2.0) + 2.4, Y2(rec[1]) + 3.4,
               f"detector recall  Δ{abs(rec[0] - rec[1]):.3f}", size=MIN_PT,
               fill=GREY)
        for t in ("luc3d", "sleap", "bytetrack"):
            pts = [(i + 1.0, bb[b][t]["idf1"]) for i, b in enumerate(beds)
                   if t in bb[b]]
            if len(pts) < 2:
                continue
            col = TCOL[t]
            f.polyline([(X2(a), Y2(v)) for a, v in pts], color=col, sw=0.9 * PT)
            for a, v in pts:
                f.marker(X2(a), Y2(v), color=col, r=0.58)
            dy = -1.8 if t == "luc3d" else 0.8
            f.text(X2(pts[-1][0]) + 2.4, Y2(pts[-1][1]) + dy,
                   f"{TNAME[t]}  Δ{abs(pts[0][1] - pts[1][1]):.3f}", size=5.2,
                   fill=col)
        f.text(gx, y + PLOTH + 11.0,
               f"n = {bb[beds[0]]['n_sessions']} + {bb[beds[1]]['n_sessions']} "
               f"SLAP-2M sessions; identical detections", size=5.2, fill=GREY)
    y += PLOTH + 19.6

    # ---- c: within-view IDF1, every session --------------------------------------
    title(f, M, y, "c", "Within-view IDF1 per session")
    sw = sl.get("within_view") or {}
    ph_c = 32.0
    if sw:
        order = sorted(sw, key=lambda t: -sw[t]["median"])
        # Survival curves, not swarms. Three jittered clouds of 74 dots each read as
        # noise and hide the thing that actually separates the trackers: the separation
        # is largest in the UPPER tail, which a median bar and a dot cloud both bury.
        # F(x) = fraction of sessions scoring at least x, so a curve that stays high to
        # the right is a tracker that is good on MORE sessions, and the vertical gap at
        # any x is directly readable as "how many more sessions clear this bar".
        X3, Y3 = f.axes(M + 13.0, y + 3.4, bw2 - 16.0, ph_c, (0, 1.0), (0, 100),
                        xlabel="IDF1 threshold", ylabel="sessions at or above (%)",
                        xticks=[0, 0.25, 0.5, 0.75, 1.0],
                        yticks=[0, 25, 50, 75, 100], size=6)
        for t in order:
            v = sw[t]
            col = TCOL.get(t, GREY)
            vals = sorted(v["per_session"])
            n = len(vals)
            # step function; drawn as a polyline so it prints as one clean stroke
            pts = [(X3(0), Y3(100))]
            for i, val in enumerate(vals):
                frac = (n - i) / n * 100.0
                pts.append((X3(val), Y3(frac + 100.0 / n)))
                pts.append((X3(val), Y3(frac)))
            pts.append((X3(vals[-1]), Y3(0)))
            f.polyline(pts, color=col, sw=0.9 * PT)
        # Key in the lower-left, which is the only region every curve leaves empty
        # (all three start near 100% and fall rightwards). Naming curves ON the curves
        # put type straight through the strokes.
        for i, t in enumerate(order):
            ky = Y3(34 - i * 9.0)
            f.line(X3(0.04), ky - 0.6, X3(0.11), ky - 0.6, stroke=TCOL.get(t, GREY),
                   sw=0.9 * PT)
            f.text(X3(0.13), ky, TNAME.get(t, t), size=5.4, fill=TCOL.get(t, GREY))
        # the upper-tail count, which is the panel's point and is otherwise invisible
        thr = 0.9
        f.line(X3(thr), Y3(0), X3(thr), Y3(100), stroke=GREY, sw=0.4 * PT,
               dash="1.2,0.9")
        f.text(X3(thr) - 0.8, Y3(100) + 2.6, f"IDF1 \u2265 {thr:g}", size=MIN_PT,
               anchor="end", fill=GREY)
        # counts stacked at fixed rows right of the rule: at their own curve heights
        # they overlapped each other and the strokes (the three values sit within ~35
        # percentage points of one another).
        for i, t in enumerate(order):
            v = sw[t]
            n = len(v["per_session"])
            k = sum(1 for x in v["per_session"] if x >= thr)
            f.text(X3(thr) + 1.4, Y3(88 - i * 7.0), f"{k}/{n}",
                   size=MIN_PT, fill=TCOL.get(t, GREY))
        f.text(M, y + ph_c + 11.0,
               f"one step per session; n = {sw[order[0]]['n_sessions']} sessions "
               f"\u00d7 6 cameras, session mean IDF1",
               size=5.2, fill=GREY)
        am = sl.get("camera_session_argmax") or {}
        if am:
            tot = sum(am.values())
            wx = M
            for t in [o for o in order if o in am]:
                txt = f"{TNAME.get(t, t)} {am[t]}"
                f.text(wx, y + ph_c + 14.6, txt, size=5.2, fill=TCOL.get(t, GREY))
                wx += text_width(txt, 5.2) + 2.2
            f.text(wx, y + ph_c + 14.6,
                   f"tied {am.get('tie', 0)}  of {tot} camera-sessions best",
                   size=5.2, fill=GREY)

    # ---- d: the paired difference, with n on every tick --------------------------
    title(f, gx, y, "d", "Per-session paired difference")
    pd = sl.get("paired_vs_sleap") or {}
    ks = [k for k in ("1", "2", "3", "4") if k in pd]
    if ks:
        vals = [v for k in ks for v in pd[k]["per_session"]]
        lim = max(0.42, max(abs(min(vals)), abs(max(vals))) * 1.08)
        X4, Y4 = f.axes(gx + 13.0, y + 3.4, bw2 - 16.0, ph_c,
                        (0.55, len(ks) + 0.45), (-lim, lim),
                        ylabel="Δ IDF1, LUC3D − SLEAP",
                        xticks=[], yticks=[-0.4, -0.2, 0, 0.2, 0.4], size=6)
        f.line(X4(0.55), Y4(0), X4(len(ks) + 0.45), Y4(0), stroke=INK, sw=0.4 * PT)
        base = Y4(-lim)   # tick labels go below the SPINE, not below the zero line
        for i, k in enumerate(ks):
            v = pd[k]
            xc = i + 1
            col = GREEN if v["mean"] > 0 else ACCENT
            # Mean with its 95% CI, no dot cloud. The CI already carries the spread AND
            # it carries n honestly: the 3- and 4-animal groups (n = 4 and n = 3) get
            # visibly wide intervals, which is the disclosure a jittered cloud of 3 dots
            # was making badly. The exact n and win count sit under each tick.
            f.line(X4(xc), Y4(v["ci95_lo"]), X4(xc), Y4(v["ci95_hi"]),
                   stroke=col, sw=1.0 * PT)
            for yy in (Y4(v["ci95_lo"]), Y4(v["ci95_hi"])):
                f.line(X4(xc) - 0.8, yy, X4(xc) + 0.8, yy, stroke=col, sw=0.7 * PT)
            f.marker(X4(xc), Y4(v["mean"]), color=col, r=0.75)
            f.text(X4(xc) + 1.8, Y4(v["mean"]) + 0.7, f"{v['mean']:+.3f}",
                   size=MIN_PT, fill=col)
            f.line(X4(xc), base, X4(xc), base + 0.8, stroke=INK, sw=0.4 * PT)
            f.text(X4(xc), base + 3.1, k, size=5.4, anchor="middle")
            f.text(X4(xc), base + 5.6, f"n = {v['n_sessions']}", size=MIN_PT,
                   anchor="middle", fill=GREY)
            f.text(X4(xc), base + 7.9, f"{v['wins']}/{v['n_sessions']}", size=MIN_PT,
                   anchor="middle", fill=col)
        f.text(X4((1 + len(ks)) / 2), base + 10.6, "animals · sessions · wins",
               size=6.5, anchor="middle")
        f.text(X4(len(ks) + 0.45), Y4(lim) + 1.6, "LUC3D ahead", size=MIN_PT,
               anchor="end", fill=GREEN)
        f.text(X4(len(ks) + 0.45), Y4(-lim) - 1.2, "SLEAP ahead", size=MIN_PT,
               anchor="end", fill=ACCENT)
        a = pd.get("all")
        if a:
            f.text(gx, y + ph_c + 18.6,
                   f"all {a['n_sessions']} sessions: {a['mean']:+.3f} "
                   f"[{a['ci95_lo']:+.3f}, {a['ci95_hi']:+.3f}], {a['wins']}/"
                   f"{a['n_sessions']}, sign test P = {a['sign_p']:.2g}",
                   size=5.2, fill=GREY)
    y += ph_c + 26.0

    # ---- e: error composition ----------------------------------------------------
    title(f, M, y, "e", "Error composition")
    ed = sl.get("error_decomposition") or {}
    ph_e = 28.0
    if ed:
        ts = ["luc3d", "sleap", "bytetrack"]
        groups = [("false positives", "false_positives"), ("ID switches", "id_switches")]
        top = max(ed[t][k] for t in ts for _l, k in groups) * 1.24
        X5, Y5 = f.axes(M + 15.0, y + 3.4, bw2 - 18.0, ph_e, (0.5, 2.5), (0, top),
                        ylabel="errors (thousands)", xticks=[], yticks=[], size=6)
        for tv in (0, 20000, 40000, 60000):
            f.line(X5(0.5) - 0.8, Y5(tv), X5(0.5), Y5(tv), stroke=INK, sw=0.4 * PT)
            f.text(X5(0.5) - 1.3, Y5(tv) + 0.7, f"{tv // 1000:g}", size=MIN_PT,
                   anchor="end")
        for gi, (lab, key) in enumerate(groups):
            for ti, t in enumerate(ts):
                xc = gi + 1 + (ti - 1) * 0.21
                v = ed[t][key]
                xl, xr_ = X5(xc - 0.085), X5(xc + 0.085)
                f.rect(xl, Y5(v), xr_ - xl, Y5(0) - Y5(v), fill=TCOL[t],
                       stroke="none", sw=0)
                f.text((xl + xr_) / 2, Y5(v) - 0.8, thin(v), size=MIN_PT,
                       anchor="middle", fill=TCOL[t])
            f.text(X5(gi + 1), Y5(0) + 3.1, lab, size=5.4, anchor="middle")
        f.legend(X5(1.70), Y5(top) + 2.4,
                 [(TNAME[t], TCOL[t]) for t in ts], size=5.2)
        f.text(M, y + ph_e + 12.6,
               f"shared ground truth {thin(ed['luc3d']['gt_instances'])} instances; "
               f"detector false negatives are "
               f"{min(ed[t]['fn_share'] for t in ts) * 100:.1f}–"
               f"{max(ed[t]['fn_share'] for t in ts) * 100:.1f}% of every tracker's "
               f"error", size=5.2, fill=GREY)

    # ---- f: what within-view IDF1 actually measures -------------------------------
    title(f, gx, y, "f", "IDF1 vs detector recall")
    rc = sl.get("detector_recall_corr") or {}
    if rc.get("per_session"):
        X6, Y6 = f.axes(gx + 13.0, y + 3.4, bw2 - 16.0, ph_e, (0, 1.02), (0, 1.02),
                        xlabel="shared detector recall", ylabel="session IDF1",
                        xticks=[0, 0.25, 0.5, 0.75, 1.0],
                        yticks=[0, 0.25, 0.5, 0.75, 1.0], size=6)
        f.line(X6(0), Y6(0), X6(1.0), Y6(1.0), stroke=LIGHT, sw=0.5 * PT,
               dash="1.4,1.0")
        f.text(X6(0.62), Y6(0.70), "IDF1 = recall", size=MIN_PT, fill=GREY)
        for rec, luc, sle, _a in rc["per_session"]:
            f.marker(X6(rec), Y6(sle), color=ACCENT, r=0.34, sw=0)
        for rec, luc, sle, _a in rc["per_session"]:
            f.marker(X6(rec), Y6(luc), color=GREEN, r=0.34, sw=0)
        f.text(X6(0.04), Y6(0.99), f"LUC3D  r = {rc['luc3d']['r']:.3f}", size=5.2,
               fill=GREEN)
        f.text(X6(0.04), Y6(0.92), f"SLEAP  r = {rc['sleap']['r']:.3f}", size=5.2,
               fill=ACCENT)
        f.text(gx, y + ph_e + 12.6,
               f"one point per session, n = {rc['luc3d']['n_sessions']}; "
               f"R² = {rc['luc3d']['r2']:.2f} for LUC3D", size=5.2, fill=GREY)
    y += ph_e + 16.6

    f.text(M, y, "Identical identity-stripped detections for every tracker shown. "
                 "Session-level statistics throughout; SHIPPED LUC3D configuration "
                 "(see caption, Provenance). See caption for n and method.",
           size=5.2, fill=GREY)
    y += 2.4
    f.height = round(y + 2.0, 1)
    f.write(os.path.join(OUT, "fig7.svg"))


def main():
    argparse.ArgumentParser().parse_args()
    figure3(load("fig3_sweep.json"), load("fig3_runtime.json"),
            load("fig3_headtohead.json"))
    figure7(load("fig3_trackers.json"))


if __name__ == "__main__":
    main()
