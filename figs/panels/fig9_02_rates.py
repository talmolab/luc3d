#!/usr/bin/env python3
"""
Fig 9b -- the two failure RATES on SLAP-2M, per 100,000 camera-frames: within-view ID
switches and misgrouped DETECTIONS, shipped against the Fig 8 winner, over the 42
multi-animal sessions.

    THIS FIGURE IS EXPLORATORY AND UNPLACED. It is not part of the manuscript, is
    absent from FIGURE-LEGENDS.md / METHODS.md / RESULTS.md / CAPTIONS.md, and no
    panel of Figures 1-7 depends on it. Do not cite it as a result.

TWO QUANTITIES, NOT ONE, and the distinction is the reason both are drawn:

  ID SWITCHES        motmetrics `num_switches`, summed over the six cameras. A switch is
                     an EVENT: the frame at which a track changes identity.
  MISGROUPED         DETECTIONS -- one animal, one camera, one frame -- that were
  DETECTIONS         LABELLED, overlap a ground-truth box at IoU >= 0.5, and carry an id
                     that disagrees with that box under the OPTIMAL tracker-id -> GT-index
                     permutation for that camera. This is the DURATION of the damage --
                     the "mislabelled mass" of figs/fig8_diag_loss.py. Fig 8c showed a
                     single session losing 0.311 IDF1 to only ten switches, so a switch
                     count alone cannot say how much of a session is wrong.

BOTH NUMBERS ARE PRINTED ON EVERY MARK: the rate per 100,000 AND the raw total. That is
not redundancy. Fig 8d's own note records the misreading that made this rule: a mark sat
at 0.92 on a rate axis and was labelled "413", so two different quantities shared one
mark; and a bare "0.00092%" invites being read as "92 per 100,000". A rate with no
numerator cannot be checked, and a total with no denominator cannot be compared, so both
appear, each labelled as what it is.

ONE MEASURED DENOMINATOR, SHARED. Per camera, min(gt_frames, det_frames), clipped to that
session's real length -- exactly the frames the scorer scores, and exactly what
fig9_slap2m.py's `camera_frames()` measures from HDF5 shapes. It is printed beside each
cohort's label, because the two cohorts have DIFFERENT denominators and a rate whose
denominator is off-panel is not auditable. This panel re-derives each cohort's
denominator from `camera_frames_by_session` and refuses to draw if it disagrees with the
aggregate the measurement deposited.

THE MULTI-ANIMAL ROW IS THE ONLY ROW. 32 of the 74 sessions hold ONE animal, where there
is nothing to associate across views and every tracker scores near-perfectly; they
contribute exactly 0 switches and 0 misgrouped detections and were dropped from Figure 9
on 2026-08-13, because pooling them changed only the denominator (a 43% dilution).

WHAT IT SHOWS, on the CORRECTED metric (2026-08-13, and every pre-correction misgrouped
number this panel drew is retracted -- it reported 4,025,419 -> 3,981,680 and "-1.1%").
The experimental arm removes 30% of the ID SWITCHES -- 2,826 -> 1,991, 69.87 -> 49.23 per
100,000 camera-frames -- and none of the MISLABELLED MASS: misgrouped detections go
849,849 -> 861,224, 21,011.6 -> 21,292.8 per 100,000, 11.52% -> 11.68% of the 7,374,061
labelled detections, which is 1.3% WORSE, not better. Cross-view IDF1 is flat and very
slightly down with it (mean 0.8396 -> 0.8388, median 0.9237 -> 0.9197). A switch is an
EVENT and mass is a DURATION, and this arm cuts the event count without cutting the
damage -- consistent with it making fewer but longer-lived identity errors. That is the
whole reason both quantities are on this panel: a 30% cut in switches, reported alone,
would have read as a 30% improvement.

AND THE ANSWER IS POOL-DEPENDENT, which is the reason the pool is named on every axis of
this figure. The SAME two configurations over the SAME 42 sessions on the OTHER SLAP-2M
detection pool -- `predictions_h5s`, the one Fig 7's b-g panels are scored on, deposited at
figs/out/fig9_slap2m_predictions.json -- show the opposite: misgrouped detections
303,987 -> 125,142 (-59%; 5.95% -> 2.45% of that pool's 5,110,008 labelled detections),
switches 3,094 -> 1,312 (-58%), cross-view IDF1 0.7040 -> 0.7212 and identity precision
0.9194 -> 0.9555. So "the fresh anchor does not reduce mislabelled mass" is a statement
about THIS pool (`keeptrack_h5s`, within-view IDF1 0.839) and not about SLAP-2M. The two
pools' absolute levels are not comparable and must never be mixed in one number; what
transfers between them is only the direction, and here even that does not.

THREE DENOMINATORS, NAMED APART, because calling all of them "frames" is what broke this
panel's headline number once already. On this cohort: 674,111 VIDEO FRAMES x 6 cameras =
4,044,666 CAMERA-FRAMES, carrying 7,374,061 LABELLED DETECTIONS -- about 1.8 per
camera-frame.
The rate axis divides by camera-frames, so a misgrouped rate above 100,000 per 100,000 is
arithmetic and not an error; the share of LABELLED DETECTIONS is printed beside it because
that is the fraction a reader actually wants. Every one of the three is derived here from
the deposit, never typed.

`misgrouped` IS COUNTED THROUGH THE OPTIMAL id PERMUTATION, and the panel says so on its
face. THE FIRST VERSION OF THIS METRIC WAS BROKEN and every number it produced is
retracted: it compared the tracker's identity id against the GT track index DIRECTLY, and
those are unrelated numbering systems (the tracker allocates ids as it discovers animals,
GT numbers tracks 0..n-1 per session), so it measured how often two arbitrary labellings
coincide -- ~50% for two animals, by construction, which is what it reported. The scorer
now builds the tracker-id x GT-index co-occurrence table per (session, camera), solves the
assignment that maximises agreement (`scipy.optimize.linear_sum_assignment`) and counts
only matched detections that disagree UNDER that mapping. That is what IDF1 does
internally, so the LEVEL is now meaningful and can be read against IDF1, not only the
difference between two configurations.

Source: figs/out/fig9_slap2m.json `cells[*].all_sessions` / `.multi_animal_only`, written
by `/root/vast/eric/luc3d-bench/liezl_env/bin/python figs/fig9_slap2m.py`.

    figs/.venv/bin/python figs/panels/fig9_02_rates.py
"""
import sys
from pathlib import Path

import pandas as pd
from matplotlib.ticker import FuncFormatter, MaxNLocator

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from fig9_common import (BMIMICA_REF, CORR12, IMPROVED, OTHER_POOL,  # noqa: E402
                        SERIES, SHIPPED, camera_frames_of, corpus_shape, load9,
                        misgrouped_lines, other_pool)
from src.style import (GREY, MUTED, deposit, footnote, grid, save,  # noqa: E402
                       text_legend, use)

#: (cohort key, label, y centre of its pair). Multi-animal on top: it is the reading.
#: MULTI-ANIMAL ONLY (2026-08-13, on instruction). The 32 single-animal sessions are
#: excluded from Figure 9 because they contribute EXACTLY 0 switches and 0 misgrouped
#: detections under both configurations -- measured, in this deposit's own by_animals["1"]
#: -- so they changed nothing but the denominator, inflating it by 66% (11,726,640
#: camera-frames over 74 against 4,044,666 over 42) and flattering every pooled rate.
COHORTS = [("multi_animal_only", "42 multi-animal", 1.0)]
#: Vertical offset of the two configurations within a cohort's pair.
DY = 0.22

#: (metric key in the aggregate, raw key, axis label, extra label line).
METRICS = [("switches_per_100k", "switches",
            "within-view ID switches per 100,000 camera-frames",
            "rate, then the RAW total in parentheses"),
           ("misgrouped_per_100k", "misgrouped",
            "misgrouped detections per 100,000 camera-frames",
            "DETECTIONS, not frames — ~1.8 per camera-frame")]

#: Multiple of the largest mark that the x axis extends to, so each mark's two-part label
#: has room to its right. Measured, not guessed: at 2.35 the misgrouped panel's
#: "35,574.0 per 100k  (6,818,088)  -24% vs shipped" ran off the artwork, because
#: constrained_layout sizes the axes without seeing offset-placed annotations. The label
#: was shortened AND this widened. Then back to 2.6 from 3.1: at 3.1 the misgrouped axis
#: ran to 300,000 per 100,000 with every mark inside its left third, which is a lot of
#: empty axis to buy room that 2.6 already gives (the longest label is ~39 mm and its mark
#: sits ~28 mm along a ~72 mm axes).
X_HEADROOM = 2.8
ROW_H = 64.0
#: Key layout: TWO COLUMNS plus one full-width line under them. This panel's key has to
#: carry eight sentences (two configurations, the shared denominator, what the numbers
#: beside each mark are, why the multi-animal cohort is the reading, the misgrouped
#: definition, why it is only a relative rate, and the Mouse-Dyad-10M reference). As one column
#: at 155 characters that is nine lines = half the panel's height. In two columns of ~80
#: characters it is five, and the plot keeps 38 of 64 mm.
KEY_X = (0.022, 0.505)
#: 0.043, down from 0.050, because the key grew from 8 lines to 13 when the other pool's
#: numbers went onto the artwork: at 0.050 that band is 0.67 of the panel and leaves 21 mm
#: for an axes that needs 12 of them for its two-line x label and ticks. 0.043 x 64 mm =
#: 2.75 mm of leading for 6 pt type (~2.1 mm high), which is tight but does not touch.
KEY_DY = 0.043
KEY_TOP = 0.985


def build(d, cells):
    rows = []
    cf_by_session = camera_frames_of(d)
    for cohort, cohort_label, ypos in COHORTS:
        for cfg, _label, colour in SERIES:
            a = cells[cfg][cohort]
            ps = [q for q in cells[cfg]["per_session"]
                  if q["animals"] > 1]   # Fig 9 is multi-animal only
            # The denominator, re-derived from the per-session table rather than taken on
            # trust. It is printed on the artwork and both rates divide by it, so a
            # disagreement with the deposited aggregate must stop the render.
            check = sum(cf_by_session[q["session"]] for q in ps)
            if check != a["camera_frames"]:
                sys.exit(f"fig9b: {cfg}/{cohort} camera_frames {a['camera_frames']:,} "
                         f"but camera_frames_by_session sums to {check:,} over its "
                         f"{len(ps)} sessions -- the denominator on the artwork would be "
                         f"wrong; do not draw it")
            rows.append({
                "cohort": cohort, "cohort_label": cohort_label, "config": cfg,
                "n_sessions": a["n_sessions"], "camera_frames": a["camera_frames"],
                "switches": a["switches"],
                "switches_per_100k": a["switches_per_100k"],
                # The same measurement in Fig 8d's unit, for reading the two figures
                # against each other. 1 per 100,000 == 0.001% of camera-frames.
                "switches_pct": a["switches"] * 100.0 / a["camera_frames"],
                "misgrouped": a["misgrouped"],
                "misgrouped_per_100k": a["misgrouped_per_100k"],
                "misgrouped_pct_of_labelled":
                    100.0 * a["misgrouped"] / a["det_labelled"] if a["det_labelled"]
                    else float("nan"),
                "det_labelled": a["det_labelled"],
                "det_with_bbox": a["det_with_bbox"],
                "idf1_cross": a["idf1_cross"], "idf1_within": a["idf1_within"],
                "_y": ypos + (DY if cfg == SHIPPED else -DY), "_colour": colour})
    return pd.DataFrame(rows)


def main():
    use()
    d, cells = load9("fig9b")
    df = build(d, cells)
    deposit(df[[c for c in df.columns if not c.startswith("_")]], 9, "fig9b_rates.csv")

    fig, axes = grid(1, 2, span="full", row=ROW_H)

    def get(cohort, cfg, key):
        return df[(df.cohort == cohort) & (df.config == cfg)][key].iloc[0]

    for i_ax, (ax, (rkey, rawkey, xlabel, extra)) in enumerate(zip(axes, METRICS)):
        hi = df[rkey].max()
        for _i, r in df.iterrows():
            # HORIZONTAL lollipops, so every label has the full width to its right --
            # Fig 8d records two failed attempts at labelling these vertically.
            ax.plot([0, r[rkey]], [r._y, r._y], color=r._colour, lw=1.0, alpha=0.5,
                    zorder=2)
            ax.plot(r[rkey], r._y, "o", color=r._colour, ms=5.5, mec="white", mew=0.9,
                    zorder=4)
            # BOTH quantities on the mark: the rate the axis shows and the raw count that
            # is its numerator. The key says which is which -- appending "vs shipped" to
            # the change ran the label off the page.
            txt = f"{r[rkey]:,.1f} per 100k   ({int(r[rawkey]):,})"
            if r.config == IMPROVED:
                base = get(r.cohort, SHIPPED, rkey)
                if base:
                    # ONE DECIMAL under 10%, because the whole reading of the misgrouped
                    # panel is that its change is small: "+1%" hid +1.3% and, worse, hid
                    # its SIGN behind a rounding that could as easily have printed "+0%".
                    chg = 100.0 * (r[rkey] / base - 1)
                    txt += f"   {chg:+.1f}%" if abs(chg) < 10 else f"   {chg:+.0f}%"
            ax.annotate(txt, (r[rkey], r._y), textcoords="offset points", xytext=(5, 0),
                        ha="left", va="center", fontsize=5.8, color=r._colour)
        ax.set_yticks([y for _c, _l, y in COHORTS])
        # THE DENOMINATOR IS ON THE TICK of the left panel only: both panels divide by the
        # same two numbers, and repeating them cost the misgrouped panel ~20 mm of the
        # width its longer labels need. "the reading" is on the tick rather than as an
        # in-axes arrow -- an arrow at the right-hand end of the row pointed at nothing.
        ax.set_yticklabels(
            [f"{lab}{' — the reading' if c == 'multi_animal_only' else ''}"
             + (f"\n{int(get(c, SHIPPED, 'camera_frames')):,} camera-frames"
                if i_ax == 0 else "")
             for c, lab, _y in COHORTS], fontsize=6.2)
        # Tight around the ONE cohort's pair. The old limits (-0.62, 1.62) were sized for
        # two cohorts stacked at y = 0 and y = 1; with the pooled cohort dropped they left
        # the bottom 60% of both axes empty, which reads as data that failed to draw.
        ax.set_ylim(min(df._y) - 0.35, max(df._y) + 0.35)
        ax.set_xlim(0, hi * X_HEADROOM)
        ax.set_xlabel(f"{xlabel}\n({extra})", fontsize=7)
        ax.tick_params(axis="x", labelsize=6.5)
        # Thousands as "50k". The misgrouped axis runs past 250,000 per 100,000 -- these
        # are DETECTIONS over camera-frames and there are ~1.8 labelled detections per
        # camera-frame in this cohort, so a rate above 100,000 is arithmetic, not an
        # error -- and six-digit tick labels at 6.5 pt collide on a 72 mm axes.
        if hi > 10_000:
            ax.xaxis.set_major_formatter(
                FuncFormatter(lambda v, _p: f"{v / 1000:g}k" if v else "0"))
            ax.xaxis.set_major_locator(MaxNLocator(5))
        ax.tick_params(axis="y", length=0)

    # THE THREE DENOMINATORS, all derived from the deposit. Printing camera-frames alone was
    # survivable while the other two were only in prose; it is not, now that the misgrouped
    # rate is above 100,000 per 100,000 and the reader needs to see why that is arithmetic.
    vf, cf_multi, det_lab = corpus_shape(d, cells[SHIPPED])
    # Two columns of ~70 characters, then the Mouse-Dyad-10M reference across the full width.
    # Line length is measured, not guessed: at 6 pt a character is ~1.0 mm, so a column
    # starting at 0.505 of a 180 mm panel holds ~85 before it runs off the artwork (an
    # earlier single-column key had four lines cut mid-word).
    mis_share_ship = get("multi_animal_only", SHIPPED, "misgrouped_pct_of_labelled")
    mis_share_imp = get("multi_animal_only", IMPROVED, "misgrouped_pct_of_labelled")
    # CHECKED, then printed. The single-animal sessions turn out to contribute exactly
    # zero of both quantities under both configurations -- which is a much stronger
    # statement than "they dilute the effect", because it means pooling them changes only
    # the DENOMINATOR. Strong enough that it must not be asserted from a prior render:
    # if a future pass finds any switch there, the key says the weaker thing instead.
    single_clean = all(
        sum(q[k] for q in cells[c]["per_session"] if q["animals"] == 1) == 0
        for c in (SHIPPED, IMPROVED) for k in ("within_switches", "misgrouped"))
    cohort_line = ("animal and contribute 0 switches and 0 misgrouped detections, so"
                   if single_clean else
                   "animal, where nothing has to be associated across views, so")
    left = [
        (SERIES[0][1], SERIES[0][2]),
        ("M1 + stale 20 + distThresh 25 — EXPERIMENTAL:", SERIES[1][2]),
        ("figs/fig8-bench/xv_experimental.js, not in the shipped app", SERIES[1][2]),
        ("beside each mark: the rate, the RAW total in parentheses, then the", MUTED),
        ("change vs shipped. THREE DENOMINATORS, named apart, because two of", MUTED),
        (f"them have been called “frames”: {vf:,} VIDEO FRAMES × 6 cameras =", MUTED),
        (f"{cf_multi:,} CAMERA-FRAMES — min(gt, det) per camera, clipped to", MUTED),
        (f"session length — holding {det_lab:,} LABELLED DETECTIONS", MUTED),
    ]
    right = [
        ("READ THE MULTI-ANIMAL COHORT: 32 of the 74 sessions hold ONE", MUTED),
        (cohort_line, MUTED),
        ("they are EXCLUDED — pooling changed only the denominator (43%).", MUTED),
        # 70 characters and this exact tail wording wrap to five FULL lines. "a LEVEL that
        # can be read against IDF1" left "against IDF1" alone on a sixth, which reads as a
        # line the renderer dropped -- the failure this figure can least afford.
    ] + misgrouped_lines(70, MUTED,
                         f"{mis_share_ship:.1f}% -> {mis_share_imp:.1f}% of the labelled "
                         f"detections here, a LEVEL readable against IDF1")
    text_legend(axes[0], left, "above", size=6.0, dy=KEY_DY, xy=(KEY_X[0], KEY_TOP),
                transform=fig.transFigure)
    text_legend(axes[0], right, "above", size=6.0, dy=KEY_DY, xy=(KEY_X[1], KEY_TOP),
                transform=fig.transFigure)
    # BELOW BOTH COLUMNS, whichever is taller -- the columns no longer have the same number
    # of lines (the misgrouped definition is wrapped, so it grows or shrinks with the text)
    # and a fixed offset here put this full-width line straight through the right column.
    # THE OTHER POOL, ON THE ARTWORK, because the corrected metric's answer DEPENDS on it and
    # a reader who takes "the fresh anchor does not reduce mislabelled mass" off this panel
    # as a fact about SLAP-2M would be wrong. Derived from the other deposit at render time,
    # never typed; if it is absent the line says that instead of quietly disappearing.
    op = other_pool()
    if SHIPPED in op and IMPROVED in op:
        s, i = op[SHIPPED], op[IMPROVED]
        # LINE LENGTH IS THE CONSTRAINT: at 6 pt from x = 0.022 a line of ~148 characters
        # reaches the right edge of a 180 mm panel, and the renderer DROPS the overhang
        # silently -- the first version of the line below lost the last digits of an IDF1.
        wide = [
            (f"OTHER SLAP-2M POOL (predictions_h5s, what Fig 7 b-g use), same 42 sessions: "
             f"misgrouped {s['misgrouped']:,} -> {i['misgrouped']:,} "
             f"({100 * (i['misgrouped'] / s['misgrouped'] - 1):+.0f}%), switches "
             f"{s['switches']:,} -> {i['switches']:,},", GREY),
            (f"cross-view IDF1 {s['idf1_cross']:.3f} -> {i['idf1_cross']:.3f}. So the "
             f"mislabelled-mass result is POOL-DEPENDENT: this arm cuts switches on both "
             f"pools, mass only there — never mix the pools' levels", GREY),
            ("and the pre-correction claim that this arm made mass WORSE was an artefact of "
             "the broken metric, not a finding", GREY),
        ]
        if CORR12 in op:
            c12 = op[CORR12]
            wide.append(
                (f"corr3dWeight 12, Mouse-Dyad-10M's winner (371 vs 413 switches there), is NEUTRAL "
                 f"there: {c12['switches']:,} vs {i['switches']:,} switches, IDF1 "
                 f"{c12['idf1_cross']:.4f} vs {i['idf1_cross']:.4f} — corpus-specific", GREY))
    else:
        wide = [(f"the other SLAP-2M pool's numbers are NOT available (figs/out/"
                 f"{OTHER_POOL} absent or mid-write), so this panel cannot say whether the "
                 f"mislabelled-mass result holds there", GREY)]
    wide.append((BMIMICA_REF, GREY))

    nkey = max(len(left), len(right)) + len(wide)
    for k, entry in enumerate(wide):
        text_legend(axes[0], [entry], "above", size=6.0, dy=KEY_DY,
                    xy=(KEY_X[0], KEY_TOP - (max(len(left), len(right)) + k) * KEY_DY),
                    transform=fig.transFigure)
    # The band the axes must stay out of, sized from the key that was actually built rather
    # than from a hardcoded line count that silently went stale every time a line was
    # added. constrained_layout resolves at draw time, so setting the rect here is
    # equivalent to setting it before plotting.
    fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (KEY_DY * nkey + 0.02)))

    note = ""
    for cohort, lab, _y in COHORTS:
        s_sw, i_sw = (get(cohort, c, "switches_per_100k") for c in (SHIPPED, IMPROVED))
        s_mg, i_mg = (get(cohort, c, "misgrouped_per_100k") for c in (SHIPPED, IMPROVED))
        note += (f"{lab}: switches {s_sw:.2f} -> {i_sw:.2f} per 100k "
                 f"({int(get(cohort, SHIPPED, 'switches')):,} -> "
                 f"{int(get(cohort, IMPROVED, 'switches')):,} raw, "
                 f"{100 * (i_sw / s_sw - 1):+.0f}%); misgrouped {s_mg:,.1f} -> "
                 f"{i_mg:,.1f} per 100k "
                 f"({int(get(cohort, SHIPPED, 'misgrouped')):,} -> "
                 f"{int(get(cohort, IMPROVED, 'misgrouped')):,} raw, "
                 f"{100 * (i_mg / s_mg - 1):+.0f}%)\n")
    # THE READING, computed rather than asserted. It is the sentence a reader takes away, so
    # it must be derived from this render's numbers -- the claim it replaces ("switches -30%,
    # mislabelled mass -1.1%") came from the broken pre-permutation metric and outlived it.
    d_sw = 100 * (get("multi_animal_only", IMPROVED, "switches")
                  / get("multi_animal_only", SHIPPED, "switches") - 1)
    d_mg = 100 * (get("multi_animal_only", IMPROVED, "misgrouped")
                  / get("multi_animal_only", SHIPPED, "misgrouped") - 1)
    note += (f"READING: ID switches {d_sw:+.0f}%, misgrouped detections {d_mg:+.1f}% "
             f"({'worse' if d_mg > 0 else 'better'}), cross-view IDF1 "
             f"{get('multi_animal_only', SHIPPED, 'idf1_cross'):.4f} -> "
             f"{get('multi_animal_only', IMPROVED, 'idf1_cross'):.4f} — the switch cut does "
             f"NOT reduce mislabelled mass\n")
    note += (f"switches in Fig 8d's unit: shipped "
             f"{get('multi_animal_only', SHIPPED, 'switches_pct'):.5f}% of all camera-frames, "
             f"improved {get('multi_animal_only', IMPROVED, 'switches_pct'):.5f}% — "
             f"{BMIMICA_REF}\n"
             f"misgrouped as a share of LABELLED detections (42 multi-animal): "
             f"{get('multi_animal_only', SHIPPED, 'misgrouped_pct_of_labelled'):.2f}% -> "
             f"{get('multi_animal_only', IMPROVED, 'misgrouped_pct_of_labelled'):.2f}% of "
             f"{int(get('multi_animal_only', SHIPPED, 'det_labelled')):,}\n"
             f"the same fractions over det_with_bbox "
             f"({int(get('multi_animal_only', SHIPPED, 'det_with_bbox')):,}, which INCLUDES "
             f"unlabelled detections) are "
             f"{100 * get('multi_animal_only', SHIPPED, 'misgrouped') / get('multi_animal_only', SHIPPED, 'det_with_bbox'):.2f}% -> "
             f"{100 * get('multi_animal_only', IMPROVED, 'misgrouped') / get('multi_animal_only', IMPROVED, 'det_with_bbox'):.2f}%; "
             f"det_labelled is the denominator the artwork quotes, since an unlabelled "
             f"detection cannot be misgrouped\n"
             + (f"OTHER POOL (predictions_h5s, Fig 7 b-g), same 42 sessions: misgrouped "
                f"{op[SHIPPED]['misgrouped']:,} -> {op[IMPROVED]['misgrouped']:,} "
                f"({100 * (op[IMPROVED]['misgrouped'] / op[SHIPPED]['misgrouped'] - 1):+.0f}%), "
                f"switches {op[SHIPPED]['switches']:,} -> {op[IMPROVED]['switches']:,}, "
                f"cross-view IDF1 {op[SHIPPED]['idf1_cross']:.4f} -> "
                f"{op[IMPROVED]['idf1_cross']:.4f} — the mass result REVERSES between pools, "
                f"and the pre-correction claim that this arm made mass worse was an artefact "
                f"of the broken metric\n"
                if SHIPPED in op and IMPROVED in op else
                f"OTHER POOL: figs/out/{OTHER_POOL} unavailable, so the pool-dependence of "
                f"the mass result could not be stated\n")
             + (f"corr3dWeight 12 (Mouse-Dyad-10M's winner, 371 vs 413 switches there) is NEUTRAL on "
                f"the other SLAP-2M pool: {op[CORR12]['switches']:,} vs "
                f"{op[IMPROVED]['switches']:,} switches, cross-view IDF1 "
                f"{op[CORR12]['idf1_cross']:.4f} vs {op[IMPROVED]['idf1_cross']:.4f}, "
                f"misgrouped {op[CORR12]['misgrouped']:,} vs {op[IMPROVED]['misgrouped']:,} "
                f"— corpus-specific, not a general improvement\n"
                if CORR12 in op and IMPROVED in op else "")
             + f"SLAP-2M, 6 cameras, full length; ONE detection pool per deposit "
               f"(keeptrack_h5s here), sessions PAIRED across the two configurations")
    footnote(axes[0], note)
    save(fig, 9, "b", "rates")


if __name__ == "__main__":
    main()
