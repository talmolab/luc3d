#!/usr/bin/env python3
"""
Fig 2d -- WHY a two-anchor solve costs anything, and which two views to pick.

THE SCHEMATIC STRIP (2026-09-07). A reviewer said the panel was "hard to make sense
of ... without a schematic" of what the camera angle IS, so a strip above the plot
draws the two EXTREME pairs of the scatter -- the narrowest (cam 1+2, 13 deg, the
worst point) and the widest (cam 0+1, 31 deg, the best) -- as two cameras sighting
down onto one animal at their REAL angle, in the rig's own formation (see the
ELEV/formation notes at the constants below), each glyph centred over its own marker
and each marker named on a stem. Two cameras 13 deg apart see nearly the same
picture, so the second view adds little depth information and the solve is poorly
conditioned; at 31 deg the views disagree enough to fix depth. That is the whole
content of the x-axis, and it was previously only in the caption. Designed in
figures/drafts/temp as a full Fig 2 composite for review, then promoted here the same
day; the drafts are gone.

The strip is drawn to the REAL angles from data/fig2/fig2d_baseline_angle.csv (the
same rows the markers are), not to a stylised "narrow vs wide", and in the rig's own
formation -- which camera is the more overhead one, and how much farther one is --
read from figs/out/fig5_views.json at build time. The two cameras of the 13 deg pair
very nearly touch at this scale; that is not a layout accident, it is the geometry.

The pooled two-anchor error (4.75 mm) averages over all ten camera pairs, but a
labeller CHOOSES a pair. Per pair the error tracks the baseline angle the two
cameras subtend AT THE ANIMAL: the widest pair reaches 2.69 mm, the narrowest
12.59 mm -- a 4.7x difference that is free at annotation time.

THE RANK STATEMENT IS THE STRONG ONE and is what the caption leads with: the widest
pair is the most accurate in 50/50 sessions and the narrowest the least accurate in
50/50 (Spearman -0.88; Pearson r = -0.657).

The dashed curve is the depth-uncertainty law err = k/sin(theta), with k estimated
ROBUSTLY as median(err*sin(theta)) = 1.52 mm. Do not quote k = 1.87 mm with the
8-of-10 count: 1.87 is the plain least-squares fit and it puts only 5 of 10 pairs
inside +/-25%, because least squares is dragged upward by the two outliers it is
supposed to be diagnosing. The robust fit misses exactly the two genuine exceptions
(both pair camera 2), which is the point of the panel.

THE 8-OF-10 IS DESCRIPTIVE AND THE ARTWORK NOW SAYS SO. `k` is median(err*sin theta)
over these same ten pairs, so the +/-25% band is fitted AND scored on one set of
points: roughly half of them sit near the curve by construction, and +/-25% is a wide
target against a 2.7-12.6 mm range. Set in TEAL under a `k =` line it read as a test
the law had passed. There is no test available here -- there are ten pairs and all ten
went into `k`, so this design has no held-out pair to score against, and inventing one
by refitting on eight would be worse than saying nothing. So the count is now led by
"in-sample band:" and set in MUTED, one step back from `k` itself. The two MISSES
(cam 1+2 and cam 0+2, both pairing the farthest camera) were for a while named on the
data; since 2026-09-07 the on-plot names tie the markers to the schematic instead
(cam 1+2 and cam 0+1), and the miss story is carried by the legend.

The two EXTREMES carry their value (12.6, 2.7) because the panel's second finding is
a RANGE -- 4.7x, free at annotation time -- and a range cannot be read off a scatter
to one decimal. The curve carries its own name, `k / sin theta`, so the dashed line
and its band are attributable without the caption.

THIS IS NOT AN ARGUMENT FOR A WIDER RIG. No camera was ever moved; all ten points
come from one fixed 5-camera geometry, the pairs share cameras and one calibration,
and the observed range is only 13-31 deg. The extrapolation belongs in the
Discussion, not on the artwork.

TEN POINTS ARE NOT TEN OBSERVATIONS -- every pair carries the same n = 1,277,424
keypoints, the same five cameras and one calibration, solved ten ways, so the
effective n is well under ten. That disclosure lives in the FIGURE FOOTER
(`assemble.py FOOTERS[2]`: "12,774,240 two-anchor solves in d", against the same
footer's "1,277,424 keypoints" -- the 10x reuse is the quotient), which is exactly
where the legacy figure carried it. It is deliberately NOT repeated here: a caveat
printed twice on one page reads as two different caveats.

Source: figs/out/fig2.json `per_session[].err3d_mm_by_pair`.

    python3 figs/panels/fig2_04_baseline_angle.py
"""
import math
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from matplotlib.patches import Arc

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.diagram import camera, mouse_pose, ray  # noqa: E402
from src.style import INK, MUTED, GREY, TEAL, deposit, panel, save, use  # noqa: E402

BAND = 0.25

#: Fraction of the panel's HEIGHT given to the schematic strip, which sits ABOVE the
#: scatter (Eric, 2026-09-07: "maybe it should go above the graph ... a bit bigger
#: ... less vertical ... text under it to the left"). 52 mm x 0.32 = 16.6 mm; the
#: scatter keeps ~35 mm (~26 mm of plot).
#:
#: THE PAIR LOOKS DOWN. A first pass drew each pair level with the animal -- cameras
#: at the left, rays running horizontally to the mouse -- and it read as a SIDE view.
#: Every Mouse-Dyad-10M camera sits 58-76 deg above the animals (Fig 4a's caption),
#: so the glyph now tilts: the cameras sit upper-left and sight down onto the animal
#: at ELEV_DEG, with a ground line under the mouse (Eric: "i dont want to give the
#: impression that they are side views since they are mostly top down views").
#:
#: THE FORMATION IS THE RIG'S (Eric, 2026-09-07: "lets make sure that the angles
#: match and the general relative formations match in terms of verticality etc, the
#: true elevation doesnt need to match necessarily"). Three things are taken from
#: the rig, read at build time from figs/out/fig5_views.json (the cameras in the
#: P-frame, z up -- the numbers behind Fig 4a's "58 to 76 degrees above the
#: animals"): which camera of the pair is the MORE OVERHEAD one (cam 0 is 75.7 deg
#: above the animals, cam 1 58.1, cam 2 73.2), the pair's mean elevation (~66 for both
#: pairs drawn), and the cameras' RELATIVE distances (cam 2 is the farthest camera on
#: the rig, 1.36 m against 1.04-1.17 m -- and it is the camera both of the law's
#: misses share, which the glyph now shows rather than the docstring alone). What is
#: EXACT is the angle between the rays: it is the x variable, from the same rows as
#: the markers, and the pair is opened about its mean elevation with the more
#: overhead camera on the steep side. The per-camera elevations therefore come out
#: close but not equal to the true ones (cam 0 and cam 1 are 72 deg apart in azimuth,
#: so their 30 deg 3D angle is wider than their 18 deg elevation difference), which is
#: the trade the quote above accepts. Ray lengths scale with true distance, longest
#: = RAY_MM. A first draft tilted every pair at 42 deg with equal rays.
STRIP = 0.32
#: Glyph geometry, in the strip's own units (1 unit = 1 mm of panel).
RAY_MM = 10.5          # animal -> the FARTHER camera of the pair
CAM_S = 0.90           # `diagram.camera` scale; ~1.9 mm long at this size
ARC_R = 2.8            # radius of the theta arc at the animal
CAPTION_PT = 6.5


def rig_geometry():
    """Per-camera elevation above the animals and distance to them, from the rig.

    Read from fig5_views.json: camera centres in the P-frame (z up) and the animals'
    3D pose in that frame for one Mouse-Dyad-10M frame; the vertex is the pose
    centroid. Only ORDER and RATIOS are used here (which camera is more overhead,
    how much farther one is), so the choice of frame is immaterial at this scale.
    Returns {camera index: (elevation_deg, distance_mm)}.
    """
    d = load("fig5_views.json")
    ctr = np.nanmean(np.asarray(d["pose_mm"], float).reshape(-1, 3), axis=0)
    out = {}
    for c in d["cameras"]:
        v = np.asarray(c["centre_mm"], float) - ctr
        n = float(np.linalg.norm(v))
        out[int(c["index"])] = (float(np.degrees(np.arcsin(v[2] / n))), n)
    return out


def build():
    ps = load("fig2.json")["per_session"]
    rows = {}
    for s in ps:
        for k, v in (s.get("err3d_mm_by_pair") or {}).items():
            r = rows.setdefault(k, {"baseline": [], "p50": [], "n": 0})
            r["baseline"].append(v["baseline_deg"])
            r["p50"].append(v["p50"])
            r["n"] += v.get("n", 0)
    # Both coordinates are medians ACROSS SESSIONS: the baseline angle moves a little
    # between sessions because the vertex is that session's own mean 3D point, so
    # taking one session's angle would report one session's geometry against a
    # fifty-session median error.
    df = pd.DataFrame([
        {"pair": k, "baseline_deg": median(r["baseline"]),
         "err3d_mm": median(r["p50"]), "n": r["n"]}
        for k, r in rows.items()
    ]).sort_values("baseline_deg").reset_index(drop=True)

    floor = median([s["err3d_mm_by_anchor_count"]["5"]["p50"] for s in ps])
    k = median([e * math.sin(math.radians(b))
                for b, e in zip(df.baseline_deg, df.err3d_mm)])
    df["law_mm"] = k / np.sin(np.radians(df.baseline_deg))
    df["within_band"] = (df.err3d_mm - df.law_mm).abs() / df.law_mm <= BAND
    return df, floor, k


def pair_glyph(sax, ax_, ground_y, theta_deg, pair, rig, draw=True):
    """Two cameras sighting DOWN onto one animal at `theta_deg`, in the rig's formation.

    The animal sits on a ground line at `ground_y`, mid-body at x = `ax_`. The pair is
    opened by exactly `theta_deg` about its mean true elevation, the more overhead
    camera on the steep side; each camera sits at RAY_MM x (its distance / the
    farther one's) and is rotated to face the animal, so the convergence is drawn
    rather than implied. The arc at the animal carries theta to the degree; the pair
    name is centred under the glyph. Returns the glyph's horizontal extent (mm);
    with `draw=False` it only computes that, which is how the caller centres a
    glyph under its marker and then pulls it inside the panel before drawing.
    """
    a, b = (int(k) for k in pair.split("-"))
    (ea, da), (eb, db) = rig[a], rig[b]
    mean_e = (ea + eb) / 2
    dmax = max(da, db)
    xs = [ax_ - 1.5, ax_ + 1.7]                       # the mouse's extent
    ay_ = ground_y + 0.7                                # the animal, mid-body
    for e_true, dist in ((ea, da), (eb, db)):
        e = mean_e + (theta_deg / 2 if e_true >= max(ea, eb) else -theta_deg / 2)
        phi = math.radians(180 - e)                     # up-left, e above ground
        L = RAY_MM * dist / dmax
        cxi, cyi = ax_ + L * math.cos(phi), ay_ + L * math.sin(phi)
        dx, dy = ax_ - cxi, ay_ - cyi
        # Ray stops short of the lens so it reads as a sight line INTO it, and short
        # of the animal so the mouse is not struck through.
        f0, f1 = 1.4 / L, 1 - 2.0 / L
        xs += [cxi - 1.1 * CAM_S, cxi + 1.1 * CAM_S]
        if not draw:
            continue
        ray(sax, cxi + dx * f0, cyi + dy * f0, cxi + dx * f1, cyi + dy * f1,
            color=GREY)
        camera(sax, cxi, cyi, s=CAM_S, color=INK,
               angle=math.degrees(math.atan2(dy, dx)))
    xs.append(ax_ - 6.8)                                # the theta label's reach
    x0, x1 = min(xs), max(xs)
    if not draw:
        return x0, x1
    # Ground line and the animal on it: the set's mini mouse, nose to the right.
    sax.plot([ax_ - 2.8, ax_ + 3.2], [ground_y, ground_y], color=GREY, lw=0.7,
             zorder=1)
    mouse_pose(sax, ax_ - 1.5, ground_y + 0.05, 3.0, 1.4, color=INK, lw=0.8)
    # Theta: an arc between the two rays, opening toward the cameras. Its value sits
    # OUTSIDE the wedge, left of the animal just above the ground line -- on the
    # bisector it lay across both rays and, at 13 deg, its white pad swallowed the
    # arc. zorder 2: under the arc (3) so the pad can never eat it.
    sax.add_patch(Arc((ax_, ay_), 2 * ARC_R, 2 * ARC_R, angle=0.0,
                      theta1=180 - mean_e - theta_deg / 2,
                      theta2=180 - mean_e + theta_deg / 2,
                      color=TEAL, lw=0.9, zorder=3))
    sax.text(ax_ - 3.6, ay_ + 0.4, f"{theta_deg:.0f}°", color=TEAL,
             fontsize=CAPTION_PT, ha="right", va="center", fontweight="bold",
             bbox=dict(facecolor="white", edgecolor="none", pad=0.5), zorder=2)
    sax.text((x0 + x1) / 2, ground_y - 0.9, f"cam {a}+{b}", color=MUTED,
             fontsize=CAPTION_PT, ha="center", va="top")
    return x0, x1


def main():
    use()
    df, floor, k = build()
    deposit(df, 2, "fig2d_baseline_angle.csv")

    fig, ax = panel("third", "std")
    # Reserve the top STRIP of the panel for the schematic: constrained_layout
    # fits the scatter, its ticks and its labels into the rect BELOW the strip and
    # nothing it manages is drawn above it. Same mechanism as `panel(key=...)`, which
    # reserves a band above for a text legend.
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - STRIP))

    th = np.linspace(df.baseline_deg.min() - 2, df.baseline_deg.max() + 2, 200)
    law = k / np.sin(np.radians(th))
    ax.fill_between(th, law * (1 - BAND), law * (1 + BAND), color=TEAL, alpha=0.16,
                    lw=0)
    ax.plot(th, law, color=TEAL, lw=1.2, ls=(0, (2.5, 1.5)))

    ax.axhline(floor, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)))
    # DECLUTTERED 2026-08-13 (review: "get rid of a lot of the writing on there").
    # The panel's finding is that a WIDER anchor pair gives a lower error, and it was
    # being read through five separate blocks of prose. What stays is what a mark
    # cannot say for itself: the floor's value, the law's name, the two pairs the law
    # misses, and the two extremes. What went: the "comparison floor" gloss (it is the
    # dotted line at the bottom and the legend defines it), and the in-sample-band
    # count, which was three lines explaining that a band fitted on ten points
    # contains eight of them -- a statement about the fit, not about the geometry, and
    # it belongs in the legend where it now lives.
    # LEFT END, not right. Shortening this label (see above) narrowed its box, which
    # moved it into the stretch where the k/sin-theta band has come down to meet the
    # floor -- lint: ON DATA, 9% inked, and 32% when nudged upward. At the LEFT end
    # the law is at its steepest (k/sin 10 deg ~ 8.8 mm), so the strip just above the
    # floor is empty for the whole first third of the axis.
    # GREY, not periwinkle: this rule is a BOUND, and periwinkle is SLEAP's reserved
    # hue set-wide -- a Fig 7 reader returning here read a SLEAP series into a panel
    # SLEAP is not in (review 2026-08-14).
    ax.text(th[0], floor + 0.25, f"all 5 views {floor:.1f}",
            color=MUTED, fontsize=7, ha="left", va="bottom")

    # The curve is named ON the curve, in its own colour, just above the band's upper
    # edge in the one stretch (theta ~ 25-33 deg) where neither a point nor the corner
    # block is. Without it the dashed line and its band are unattributed on the
    # artwork and a reader has to reach the caption to find out what is being fitted.
    ax.text(25.4, k / math.sin(math.radians(25.4)) * (1 + BAND) + 0.35, "k / sin θ",
            color=TEAL, fontsize=7, ha="left", va="bottom")

    ax.plot(df.baseline_deg, df.err3d_mm, "o", color=TEAL, ms=6, mec="white",
            mew=1.0, zorder=4)
    # NAME THE TWO PAIRS THE SCHEMATIC DRAWS, on stems (Eric, 2026-09-07: "label
    # cam 0+1 on the scatter plot, get rid of the cam 0+2 label, also maybe make
    # little stems that go to the scatter point"). The names used to mark the two
    # pairs the robust law MISSES (cam 1+2 and cam 0+2); now they tie the two glyphs
    # above to their markers, so they are the two EXTREMES -- cam 1+2 is both. The
    # miss story stays in the docstring and the legend. `cam 1+2`, not the raw key
    # `1-2`: these are camera PAIRS, and a hyphen between two numbers reads as a range
    # or a minus sign. The CSV keeps the raw key.
    # cam 0+1 sits ABOVE its marker with the stem coming down, because right of the
    # marker is the `2.7` value and the band, and below it is the floor line.
    # (30.5, 8.0) is clear of `k / sin theta` (x 25.4-29, y to ~5.5) and the stem
    # passes left of `2.7` and right of the 30.3 deg marker.
    stem = dict(arrowstyle="-", color=GREY, lw=0.6, shrinkA=0, shrinkB=3.5)
    worst, best = df.iloc[0], df.iloc[-1]
    ax.annotate(f"cam {worst.pair.replace('-', '+')}",
                (worst.baseline_deg, worst.err3d_mm), fontsize=7, color=MUTED,
                ha="left", va="bottom", textcoords="offset points", xytext=(11, 7),
                arrowprops=stem)
    ax.annotate(f"cam {best.pair.replace('-', '+')}",
                (best.baseline_deg, best.err3d_mm), fontsize=7, color=MUTED,
                ha="center", va="bottom", textcoords="data", xytext=(30.5, 8.0),
                arrowprops=stem)

    # The two EXTREMES carry their value, because the panel's second finding is a
    # RANGE -- 12.6 mm down to 2.7 mm, 4.7x, free at annotation time -- and a range
    # cannot be read off a scatter to one decimal. Legacy printed exactly these two
    # numbers and they were lost in the restyle. Placed on the sides of each marker
    # that are empty: below the worst pair, which already carries its name above, and
    # up and to the RIGHT of the best. Neither centred-above nor right-of works for
    # the best pair: centred above, the 30.3 deg pair is close enough that the label
    # read as belonging to THAT marker, and level with it the label ran into the
    # comparison-floor line's own label. Up-and-right clears both, and the 6 pt rise
    # is the smallest that also clears the band FILL -- at 3 pt `lint_text.py`'s
    # on-data check reports the label 25% inked.
    for r, xy, ha, va in ((worst, (0, -7), "center", "top"),
                          (best, (5, 6), "left", "bottom")):
        ax.annotate(f"{r.err3d_mm:.1f}", (r.baseline_deg, r.err3d_mm), fontsize=7,
                    color=MUTED, ha=ha, va=va, textcoords="offset points",
                    xytext=xy)

    # `k` IS NO LONGER PRINTED (Eric, 2026-08-18: "for 2d get rid of 'k = 1.52mm'").
    # The curve is still named `k / sin theta` on itself, and its value is in the
    # caption -- so the law is attributable on the artwork and reproducible from the
    # legend, which is where a fitted constant belongs.

    ax.set_xlabel("anchor-pair angle at the animal (°)")
    # Pinned to what the shipped panel auto-chose: the two-line y-label makes the
    # axes a little narrower and the locator then dropped to 20 / 30 only.
    ax.set_xticks([15, 20, 25, 30])
    # Two lines, as panel c already sets it: the strip takes 14 mm off the axes'
    # height and the one-line label no longer fits beside it -- "(mm)" was clipped
    # at the top of the panel.
    ax.set_ylabel("3D error vs proofread\n(mm)")
    ax.set_ylim(0, df.err3d_mm.max() * 1.15)

    # ---- the schematic strip -------------------------------------------------
    # A second axes over the top STRIP of the panel, in units of PANEL MILLIMETRES
    # (equal aspect by construction), so the glyph constants above are in mm and
    # print at exactly that size. Both glyphs stand on ONE ground line and their
    # captions on one baseline, so the row reads as a row. Each glyph is centred
    # under its own marker's x (the correspondence the strip exists to draw), pulled
    # inward only as far as keeps it inside the panel -- the 31 deg marker sits 4 mm
    # from the right edge.
    fig.canvas.draw()
    w_mm, h_mm = fig.get_size_inches() * 25.4
    sax = fig.add_axes([0, 1 - STRIP, 1, STRIP])
    sax.set_xlim(0, w_mm)
    sax.set_ylim(0, h_mm * STRIP)
    sax.set_axis_off()
    rig = rig_geometry()
    pos = ax.get_position()
    x0d, x1d = ax.get_xlim()
    # The steepest camera drawn sets the ground height: mean elevation + theta/2 of
    # the wide pair, at the full RAY_MM.
    e_top = max((rig[int(a)][0] + rig[int(b)][0]) / 2 + r.baseline_deg / 2
                for r in (worst, best) for a, b in [r.pair.split("-")])
    ground_y = (h_mm * STRIP - 0.4 - 1.0 * CAM_S
                - RAY_MM * math.sin(math.radians(e_top)) - 0.7)
    for r in (worst, best):
        cx = (pos.x0 + pos.width * (r.baseline_deg - x0d) / (x1d - x0d)) * w_mm
        lo, hi = pair_glyph(sax, cx, ground_y, r.baseline_deg, r.pair, rig,
                            draw=False)
        cx += max(0.0, 0.5 - lo) - max(0.0, hi - (w_mm - 0.5))
        pair_glyph(sax, cx, ground_y, r.baseline_deg, r.pair, rig)

    save(fig, 2, "d", "baseline_angle")


if __name__ == "__main__":
    main()
