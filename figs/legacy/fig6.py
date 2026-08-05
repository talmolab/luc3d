#!/usr/bin/env python3
"""
Fig 6 — The proofread corpora, and where they are hard.

The argument: these corpora are large and fully proofread in 3D, they span a real
difficulty range, and the way difficulty manifests is the case for multi-view. Across
the corpus's own difficulty rating the per-view MISS rate rises 10.9x while the error of
the detections that do fire rises 1.29x. A keypoint missing in one view is recoverable
from the others; a keypoint that is uniformly noisy in every view is not.

  a  The rig as LUC3D renders it, upright -- cameras above, animals below -- with the
     frame's own 3D inset on the animals.
  b  One frame across the six proofread cameras, instances coloured by identity.
  c  THE ARGUMENT. Raw detection quality against the corpus's own difficulty rating:
     miss rate, the error of what is NOT missed, and the tail beyond tolerance.
  d  The animal-count control for c -- difficulty is confounded with animal count, so
     the trend is re-run WITHIN each animal count.
  e  What the two corpora contain, and which of them c and d measure.
  f  The measured strata.

SCOPE, deliberately: c, d and f are SLAP-2M only (74 sessions, 1,561,915 keypoints).
BMimica carries 84% of the corpus frame count and contributes NOTHING to the finding,
so e is the only place the 130-session / 12.0 M-frame corpus figure appears, and it
appears as a composition statement with an explicit "measured here" column.

Inputs:
  figs/fig6_measure.py     -> figs/out/fig6.json              (corpus totals, rigs)
  figs/fig6_detections.py  -> figs/out/fig6_detections.json   (c, d, f -- PREFERRED:
                              TRUE raw detections from the benchmark's shared pool,
                              $BENCH/outputs/keeptrack_h5s/{cam}_predictions.h5, whose
                              attrs read source="filter-only detections (no tracking)")
  figs/fig6_difficulty.py  -> figs/out/fig6_difficulty.json   (fallback only; that file
                              compares proofread labels against the reprojected
                              proofread 3D, so it measures the reconstruction's own
                              2D-to-3D residual and per-camera label coverage, NOT
                              detector performance -- a circular comparison. If the
                              figure ever falls back to it, it says so on the artwork.)
  figs/fig6_session.py + figs/fig6_app.mjs -> figs/out/fig6-app.json + PNGs (a, b)

Panels a and b are skipped with a printed warning if the app manifest is absent, so the
figure still builds from the measurements alone.

Usage: python3 figs/fig6.py
       node figs/render.mjs figs/out/fig6.svg 600
"""
import argparse
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from nature import (Figure, png_size, COL2, INK, GREY, LIGHT, FILL, ACCENT,  # noqa: E402
                    ACCENT2, PT)

HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out")
# Okabe-Ito, same set the app now draws the overlays in (figs/fig6_app.mjs PALETTE).
GREEN = "#009E73"
ORANGE = "#E69F00"
PURPLE = "#CC79A7"
MIN_PT = 5.0            # the journal's type floor; nothing on this figure goes below it
SCALE_MM = 50.0         # scale-bar length for the camera tiles


def load(name, required=True):
    p = os.path.join(OUT, name)
    if not os.path.exists(p):
        if required:
            sys.exit(f"missing figs/out/{name} -- see the header of this file")
        return None
    with open(p) as f:
        return json.load(f)


def ticks_upto(limit, candidates):
    return [t for t in candidates if t <= limit]


def mean(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    return sum(xs) / len(xs) if xs else None


def sd(xs):
    xs = [x for x in xs if isinstance(x, (int, float))]
    if len(xs) < 2:
        return 0.0
    m = sum(xs) / len(xs)
    return (sum((x - m) ** 2 for x in xs) / len(xs)) ** 0.5


def open_marker(f, cx, cy, color, r=0.62):
    """Unfilled marker: this stratum has a single session, so there is no spread."""
    f.add(f'<circle cx="{cx:.3f}" cy="{cy:.3f}" r="{r:.3f}" fill="#FFFFFF" '
          f'stroke="{color}" stroke-width="{0.5 * PT:.4f}"/>')


def fold(f, x, y, text, color):
    """A fold-change annotation, placed at the axes' top-left inside the frame."""
    f.text(x, y, text, size=5.4, fill=color, weight="bold")


def scale_bar(f, x, y, w, h, px_per_mm, src_px_per_mm, mm=SCALE_MM):
    """
    A scale bar drawn with a haloed caption, bottom-right of a tile.

    nature.py's own `scalebar=` draws plain white text, which disappears where a tile's
    corner is a bright bedding rail (it does, in two of these six views). `f.tag()`
    halos the type, so this stays legible on any background.

    `px_per_mm`     source pixels per millimetre AT THE ANIMALS' DEPTH (from the
                    calibration; see figs/fig6_app.mjs measureScale)
    `src_px_per_mm` source pixels per print millimetre for this tile (`f.px_per_mm`
                    after the image call)
    """
    bar = mm * px_per_mm / src_px_per_mm          # print mm
    x2, y2 = x + w - 1.4, y + h - 1.6
    f.line(x2 - bar, y2, x2, y2, stroke="#FFFFFF", sw=1.0 * PT)
    f.tag(x2, y2 - 1.0, f"{mm:.0f} mm", size=5.0, anchor="end")


def main():
    argparse.ArgumentParser().parse_args()
    corp = load("fig6.json")
    det = load("fig6_detections.json", required=False)
    diff = load("fig6_difficulty.json", required=not det)
    # Prefer the true raw-detection measurement. `diff` measures a different quantity
    # (see the module docstring) and is only a fallback.
    src = det or diff
    USING_DETECTIONS = det is not None
    app = load("fig6-app.json", required=False)
    if app is None:
        print("[warn] no figs/out/fig6-app.json -- panels a/b will be omitted. "
              "Run figs/fig6_session.py then figs/fig6_app.mjs.")

    W = COL2
    f = Figure(width=W, height=210.0)
    M = 0.0
    y = 3.2

    # ================================================================ a and b =
    if app:
        # Both 3D renders are PORTRAIT (the rig is cameras above / animals below), and
        # nature.py expands a crop to its box's aspect -- so a landscape box for either
        # of them pads the difference with the viewport's empty black field, which is
        # exactly the "40% empty" complaint. Size each box from its OWN content aspect
        # instead, and solve for the left-column width that makes the stacked column
        # come out the same height as the tile grid.
        def content(name, key):
            p = os.path.join(OUT, name)
            wpx, hpx = png_size(p)
            bb = app["threeD"].get(key)
            if not bb:
                return p, (wpx, hpx), None, wpx / hpx
            pad = 0.012 * wpx
            crop = (bb["x0"] - pad, bb["y0"] - pad, bb["x1"] + pad, bb["y1"] + pad)
            return p, (wpx, hpx), crop, (crop[2] - crop[0]) / (crop[3] - crop[1])

        rig_p, rig_sz, rig_crop, ar_rig = content(app["threeD"]["rig"], "rigBBox")
        an_name = app["threeD"].get("animals")
        has_an = bool(an_name) and os.path.exists(os.path.join(OUT, an_name))
        an_p, an_sz, an_crop, ar_an = (content(an_name, "animalsBBox") if has_an
                                       else (None, None, None, 1.0))
        GAP, TG = 5.0, 1.4                # column gap, tile gap
        cols, rows = 3, 2
        # rig height (a function of LEFT_W) == tile grid height (W - LEFT_W - GAP),
        # solved for LEFT_W so neither panel is padded with empty viewport.
        ca = 1.0 / ar_rig
        ga = 2.0 / (1.245 * cols)
        gb = TG - ga * (GAP + (cols - 1) * TG)
        LEFT_W = (ga * W + gb) / (ca + ga)
        LEFT_W = max(24.0, min(64.0, LEFT_W))
        TILE_X = M + LEFT_W + GAP
        TILE_W = W - TILE_X
        tw = (TILE_W - (cols - 1) * TG) / cols
        th = tw / 1.245                   # native 1280x1024, so tiles stay near-native
        ROW_H = rows * th + TG

        f.panel(M, y, "a")
        f.text(M + 5.0, y, "Rig and 3D", size=7, weight="bold")
        f.panel(TILE_X, y, "b")
        f.text(TILE_X + 5.0, y, "One frame, six cameras", size=7, weight="bold")
        y += 3.2

        # --- a: the rig, cropped to its own content -----------------------------
        fr = app["threeD"]["framing"]
        rig_h = LEFT_W / ar_rig
        nprf = len(app.get("cameras") or [])
        f.image(M, y, LEFT_W, rig_h, rig_p, crop=rig_crop, src_size=rig_sz,
                label=f"{fr['nCams']} cameras", label_size=5.2,
                corner=f"{nprf} proofread")
        rcrop, rscale = f.last_crop, LEFT_W / (f.last_crop[2] - f.last_crop[0])
        pxs = rig_sz[0] / fr["pane"][0]
        amx = M + (fr["animalsScreen"]["x"] * pxs - rcrop[0]) * rscale
        amy = y + (fr["animalsScreen"]["y"] * pxs - rcrop[1]) * rscale
        ring_ok = M <= amx <= M + LEFT_W and y <= amy <= y + rig_h
        if ring_ok:
            f.ring(amx, amy, 2.4, color="#FFFFFF", sw=0.4, dash="0.8,0.6")

        # The frame's 3D, as an INSET rather than its own panel: it is a zoom of the
        # ringed cluster in the same render, so a second lettered panel would spend
        # ~30 x 37 mm restating panel a at a different distance -- and at the width two
        # side-by-side portrait panels leave, neither is legible.
        if has_an:
            # Centre-right, NOT the bottom-right corner: two of the eight frustums sit
            # in that corner (they are the rightmost content in the box), and an inset
            # over them makes the panel's own "8 cameras" label wrong. The centre-right
            # is the one genuinely empty region of this framing.
            iw = LEFT_W * 0.50
            ih = iw / ar_an
            ix, iy = M + LEFT_W * 0.47, y + rig_h * 0.32
            if ring_ok:
                f.zoom_lines((amx - 2.4, amy - 2.4, 4.8, 4.8), (ix, iy, iw, ih),
                             color="#8C8C8C", sw=0.35, dash="0.8,0.6")
            f.rect(ix - 0.35, iy - 0.35, iw + 0.7, ih + 0.7, fill="#000000",
                   stroke="none")
            f.image(ix, iy, iw, ih, an_p, crop=an_crop, src_size=an_sz,
                    label=f"{app['nAnimals']} in 3D", label_size=5.0)

        # --- b: the six camera tiles, with a scale bar --------------------------
        views = app.get("views") or []
        scale = (app.get("scale") or {}).get("perView") or {}
        if views:
            for i, v in enumerate(views[:cols * rows]):
                cx = TILE_X + (i % cols) * (tw + TG)
                cy = y + (i // cols) * (th + TG)
                b = v["bbox"]
                f.image(cx, cy, tw, th,
                        os.path.join(OUT, os.path.basename(v["file"])),
                        crop=(b["x0"], b["y0"], b["x1"], b["y1"]),
                        src_size=(v["width"], v["height"]),
                        label=v["name"], label_size=5.2)
                # A perspective image has no single scale; this bar is the scale in the
                # fronto-parallel plane through the animals, which is where the content
                # is. Derived from the calibration by the app's own projection --
                # see figs/fig6_app.mjs measureScale().
                ppm = (scale.get(v["name"]) or {}).get("pxPerUnit")
                if ppm:
                    scale_bar(f, cx, cy, tw, th, ppm, f.px_per_mm)
        else:
            f.text(TILE_X, y + 6.0,
                   "(per-camera tiles need the video-bearing session; "
                   "run fig6_session.py without --no-video)", size=5.4, fill=ACCENT2)

        y += ROW_H + 4.6

    # ============================================================== c and d ====
    SLOT = W / 4.0
    ph = 30.0
    ax_dx, ax_w = 12.5, SLOT - 15.0

    f.panel(M, y, "c")
    f.text(M + 5.0, y, "Detection quality", size=7, weight="bold")
    f.panel(M + 3 * SLOT, y, "d")
    f.text(M + 3 * SLOT + 5.0, y, "Animal-count control", size=7, weight="bold")
    y += 3.6

    bd = src["by_difficulty"]
    ks = sorted(bd, key=lambda k: float(k))
    tau = src["tau_px"]
    kmin, kmax = float(ks[0]), float(ks[-1])
    xlim_d = (kmin - 0.4, kmax + 0.4)
    xt = [int(float(k)) for k in ks]

    # --- c1: miss rate (the effect that moves) ------------------------------
    miss = [bd[k]["miss_rate"] * 100 for k in ks]
    msd = [bd[k].get("miss_rate_sd") or 0.0 for k in ks]
    topm = max(m + s * 100 for m, s in zip(miss, msd)) * 1.12
    X, Y = f.axes(M + ax_dx, y, ax_w, ph, xlim_d, (0, topm),
                  xlabel="difficulty rating", ylabel="keypoints missing (%)",
                  xticks=xt, yticks=ticks_upto(topm, [0, 20, 40, 60, 80]), size=6)
    for k, v, s in zip(ks, miss, msd):
        if s:
            f.line(X(float(k)), Y(max(0, v - s * 100)), X(float(k)), Y(v + s * 100),
                   stroke=ACCENT2, sw=0.4 * PT)
    f.polyline([(X(float(k)), Y(v)) for k, v in zip(ks, miss)], color=ACCENT2,
               sw=0.9 * PT)
    for k, v in zip(ks, miss):
        f.marker(X(float(k)), Y(v), color=ACCENT2, r=0.6)
    fold(f, M + ax_dx + 1.0, y + 2.2, f"{miss[-1] / miss[0]:.1f}×", ACCENT2)

    # --- c2: error of what IS detected (the effect that barely moves) -------
    # MEAN is the headline statistic, not the median: it is the one the outlier tail
    # moves. The 95th percentile is drawn with it so the tail is visible rather than
    # implied -- it rises 1.40x against the mean's 1.29x, and the p99 in g rises 1.88x.
    emu = [bd[k]["err_mean"] for k in ks]
    e95 = [bd[k]["err_p95"] for k in ks]
    esd = [bd[k].get("err_mean_sd") or 0.0 for k in ks]
    tope = max(e95) * 1.22
    x2 = M + SLOT
    X2, Y2 = f.axes(x2 + ax_dx, y, ax_w, ph, xlim_d, (0, tope),
                    xlabel="difficulty rating", ylabel="error when present (px)",
                    xticks=xt, yticks=ticks_upto(tope, [0, 4, 8, 12, 16]), size=6)
    f.polyline([(X2(float(k)), Y2(v)) for k, v in zip(ks, e95)], color=ACCENT,
               sw=0.7 * PT, dash="1.2,0.9")
    for k, v, e in zip(ks, emu, esd):
        if e:
            f.line(X2(float(k)), Y2(max(0, v - e)), X2(float(k)), Y2(v + e),
                   stroke=ACCENT, sw=0.4 * PT)
    f.polyline([(X2(float(k)), Y2(v)) for k, v in zip(ks, emu)], color=ACCENT,
               sw=0.9 * PT)
    for k, v in zip(ks, emu):
        f.marker(X2(float(k)), Y2(v), color=ACCENT, r=0.58)
    mid = len(ks) // 2
    f.text(X2(float(ks[mid])), Y2(emu[mid]) + 3.0, "mean ± s.d.", size=5.0,
           anchor="middle", fill=ACCENT)
    f.text(X2(float(ks[mid + 1])), Y2(e95[mid + 1]) - 1.8, "95th percentile", size=5.0,
           anchor="middle", fill=ACCENT)
    fold(f, x2 + ax_dx + 1.0, y + 2.2, f"{emu[-1] / emu[0]:.2f}×", ACCENT)

    # --- c3: the tail beyond the app's own tolerance ------------------------
    over = [bd[k]["frac_over_tau"] * 100 for k in ks]
    topo = max(over) * 1.32
    x3 = M + 2 * SLOT
    X3, Y3 = f.axes(x3 + ax_dx, y, ax_w, ph, xlim_d, (0, topo),
                    xlabel="difficulty rating",
                    ylabel=f"beyond {tau:.0f} px tolerance (%)",
                    xticks=xt, yticks=ticks_upto(topo, [0, 1, 2, 3, 4]), size=6)
    f.bars(X3, Y3, [(float(k), v, GREEN, "") for k, v in zip(ks, over)],
           width=0.62, labels=False)
    for k, v in zip(ks, over):
        f.text(X3(float(k)), Y3(v) - 0.8, f"{v:.1f}", size=MIN_PT, anchor="middle",
               fill=GREEN)
    fold(f, x3 + ax_dx + 1.0, y + 2.2, f"{over[-1] / over[0]:.1f}×", GREEN)

    # --- d: the same trend WITHIN each animal count -------------------------
    # Animal count is confounded with the rating (stratum 1 is twelve single-animal
    # sessions, stratum 7 is twelve two-animal ones), so the rating's effect is re-run
    # inside the two counts that have enough sessions to support it.
    sess = src["sessions"]
    x4 = M + 3 * SLOT
    series = [(1, ORANGE, "o", "1 animal"), (2, PURPLE, "s", "2 animals")]
    pts = {}
    for a, _c, _sh, _lab in series:
        row = []
        for k in ks:
            v = [q for q in sess
                 if q.get("animals") == a and str(q.get("difficulty")) == str(k)
                 and q.get("miss_rate") is not None]
            if v:
                row.append((float(k), mean([q["miss_rate"] for q in v]) * 100,
                            sd([q["miss_rate"] for q in v]) * 100, len(v)))
        pts[a] = row
    top4 = max(v + s for row in pts.values() for _k, v, s, _n in row) * 1.18
    X4, Y4 = f.axes(x4 + ax_dx, y, ax_w, ph, xlim_d, (0, top4),
                    xlabel="difficulty rating", ylabel="keypoints missing (%)",
                    xticks=xt, yticks=ticks_upto(top4, [0, 20, 40, 60, 80]), size=6)
    for a, col, shape, _lab in series:
        row = pts[a]
        f.polyline([(X4(k), Y4(v)) for k, v, _s, _n in row], color=col, sw=0.9 * PT)
        for k, v, s, n in row:
            if n > 1:
                f.line(X4(k), Y4(max(0, v - s)), X4(k), Y4(v + s), stroke=col,
                       sw=0.4 * PT)
                f.marker(X4(k), Y4(v), color=col, r=0.6, shape=shape)
            else:
                open_marker(f, X4(k), Y4(v), col)
    ley = f.legend(x4 + ax_dx + 1.6, y + 2.6,
                   [(lab, col) for _a, col, _sh, lab in series],
                   size=MIN_PT, swatch_len=2.2)
    # A grey swatch here would read as a third series; the note is type only.
    f.text(x4 + ax_dx + 1.6, ley, "open marker: n = 1 session", size=MIN_PT, fill=GREY)

    y += ph + 9.6

    # ================================================================= e =====
    f.panel(M, y, "e")
    f.text(M + 5.0, y, "Corpora", size=7, weight="bold")
    y += 3.4

    bm = next(c for c in corp["corpora"] if c["name"] == "BMimica")
    sl = next(c for c in corp["corpora"] if c["name"] == "SLAP-2M")

    def animals_range(key):
        vals = sorted({s["animals"] for s in corp[key] if s.get("animals")})
        return (f"{vals[0]}–{vals[-1]}" if len(vals) > 1
                else (str(vals[0]) if vals else "–"))

    def proofread_cams(key, total):
        vals = sorted({s.get("proofread_camera_files") for s in corp[key]
                       if s.get("proofread_camera_files")})
        return f"{total} ({vals[-1]} proofread)" if vals and vals[-1] != total else str(total)

    ftot_s = bm["sessions_with_3d"] + sl["sessions_with_3d"]
    ftot_a = bm["sessions_total"] + sl["sessions_total"]
    ftot_f = bm["frames_total"] + sl["frames_total"]
    ftot_h = bm["hours"] + sl["hours"]
    fcols = ["Corpus", "Cameras", "Animals", "Sessions with 3D", "Frames", "Hours",
             "Nodes", "Measured in c, d, f"]
    frows = [
        ["BMimica", proofread_cams("bmimica", bm["cameras"] if "cameras" in bm else 5),
         animals_range("bmimica"),
         f"{bm['sessions_with_3d']} of {bm['sessions_total']}",
         f"{bm['frames_total']:,}", f"{bm['hours']:.1f}", "15", False],
        ["SLAP-2M", proofread_cams("slap2m", 8), animals_range("slap2m"),
         f"{sl['sessions_with_3d']} of {sl['sessions_total']}",
         f"{sl['frames_total']:,}", f"{sl['hours']:.1f}", "15", True],
        ["Total", "–", "1–4", f"{ftot_s} of {ftot_a}", f"{ftot_f:,}",
         f"{ftot_h:.1f}", "15", "–"],
    ]
    end = f.table(M, y, W, fcols, frows,
                  col_w=[22.0] + [(W - 22.0) / 7] * 7,
                  header_size=6, cell_size=6, row_h=3.5)
    y = end + 5.0

    # ================================================================= f =====
    f.panel(M, y, "f")
    f.text(M + 5.0, y, "Difficulty strata", size=7, weight="bold")
    y += 3.4

    gcols = ["Difficulty", "Sessions", "Keypoints", "Animals", "Bedding (b/w)",
             "Missing (%)", "Error mean (px)", "Error p95 (px)", "Error p99 (px)",
             f"> {tau:.0f} px (%)"]
    grows = []
    for k in ks:
        v = bd[k]
        ss = [q for q in sess if str(q.get("difficulty")) == str(k)]
        # The SET of animal counts, comma-joined: an en-dash here reads as a range the
        # stratum does not contain ("1-2-4" for {1, 2, 4}).
        an = sorted({q["animals"] for q in ss if q.get("animals")})
        nb = sum(1 for q in ss if q.get("bedding") == "black")
        nw = sum(1 for q in ss if q.get("bedding") == "white")
        grows.append([k, str(v["n_sessions"]), f"{v.get('n_keypoints', 0):,}",
                      ", ".join(str(a) for a in an) if an else "–",
                      f"{nb}/{nw}",
                      f"{v['miss_rate'] * 100:.1f}", f"{v['err_mean']:.2f}",
                      f"{v['err_p95']:.2f}", f"{v['err_p99']:.2f}",
                      f"{v['frac_over_tau'] * 100:.1f}"])
    end = f.table(M, y, W, gcols, grows,
                  col_w=[20.0] + [(W - 20.0) / 9] * 9,
                  header_size=6, cell_size=6, row_h=3.5)

    # Provenance. The rest of the prose lives in figs/captions/fig6.md.
    src_note = ("raw detections from the benchmark's shared identity-stripped pool"
                if USING_DETECTIONS else
                "PROOFREAD labels vs the reprojected proofread 3D -- NOT raw detections")
    f.text(M, end + 3.2,
           f"c, d, f: {src['n_sessions']} SLAP-2M sessions, "
           f"{sum(bd[k].get('n_keypoints', 0) for k in ks):,} keypoints, {src_note},",
           size=5.2, fill=GREY)
    f.text(M, end + 5.4,
           "matched per frame against the proofread 3D reprojected into each camera. "
           "a, b: one SLAP-2M session (difficulty 4, 4 animals, black bedding).",
           size=5.2, fill=GREY)
    y = end + 7.8

    f.height = round(y + 3.0, 1)
    f.write(os.path.join(OUT, "fig6.svg"))


if __name__ == "__main__":
    main()
