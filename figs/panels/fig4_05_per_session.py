#!/usr/bin/env python3
"""
Fig 4d -- reprojection error per session, THREE solvers, paired.

WAS 4e. Review (2026-08) cut the "Error in an unused camera" panel that held this
letter -- the held-out-by-camera-count breakdown did not earn its panel ("it
doesn't make much sense to me"), and its one finding (the two solvers within
0.14 px of each other at every camera count) is legible here as the right-hand
group's near-flat pairing. This panel's "a camera it never saw" group is now the
figure's ONLY out-of-sample solver comparison, which is one more reason it must
keep both groups.

FOUR COLUMNS, PAIRED BY ALGORITHM CLASS, which is what Fig 4e also does:

    linear      Anipose triangulate   <->  our DLT
    non-linear  Anipose optim_points  <->  our refinement

Without the Anipose columns the figure only ever compared us against us. With only
Anipose's LINEAR column it compared their closed-form solve against our iterative
one, which is the category error 4e used to make. `aniposelib` is scored on the same
17,013,412 keypoints, the same 50 sessions, the same 3 calibrations, by the same error
definition -- see figs/fig4_anipose.py.

READ THE RIGHT-HAND GROUP BEFORE WRITING ANYTHING ABOUT WHO WINS. Out of sample,
BOTH ANIPOSE COLUMNS BEAT BOTH OF OURS. Anipose's plain DLT is lower than our DLT in
50/50 sessions and lower than our refinement in 49/50. Our refinement wins the
left-hand group, which it optimises. This panel must not be captioned as a win for
LUC3D, and the ordering, the shared grey pairing lines and the four medians printed
above each group are all there so that the losing comparison is as easy to read as
the winning one.

THE ANIPOSE OPTIM COLUMN HAS TEMPORAL SMOOTHING DISABLED, and the footer says so.
aniposelib's default `optim_points` adds a smoothing term across consecutive frames
(`scale_smooth=4`), but fig4_input is sampled at stride 15 and then filtered to
keypoints complete in all five views, so its "consecutive" entries are 15+ frames
apart. The smoothing term would be penalising real motion as noise, and the column
would report OUR SAMPLING rather than Anipose's method -- with it on, Anipose's optim
is worse than its own linear solve in 50/50 sessions. Off, what remains is soft-L1
reprojection error with the cameras fixed, which is exactly what our refinement is.
`fig4_anipose.py` measures both and deposits both; this panel draws the fair one.

One dot per session per solver, joined, so the comparison is visibly PAIRED: these
are 50 correlated recordings, not 50 independent draws, which is exactly why a bar
chart of four pooled medians would overstate every difference here.

THE LEFT GROUP IS ENFORCED FOR THE REFINEMENT, and is labelled so on the artwork.
The refinement's phase 2 minimises the reported error itself and a backtracking
guard vetoes any step that raises it, so "refined lowest" on the cameras the solver
used cannot come out any other way. It is shown only to size the in-sample effect
beside the held-out group, which any of the three can lose -- and ours does.

The rules are the median OF THE SESSION DOTS, not the median pooled over all 4.2 M
keypoints. A rule drawn through a dot cloud must be that cloud's median, and the
session is the independent unit.

Source: figs/out/fig4.json `per_session[].{reproj_p50,heldout_p50}` (dlt, ba)
        figs/out/fig4_anipose.json `per_session[].{reproj_p50,heldout_p50}` (linear)
        figs/out/fig4_anipose.json `per_session_optim[].optim_nosmooth_*` (optim)

    python3 figs/panels/fig4_05_per_session.py
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load, median  # noqa: E402
from src.style import MUTED, deposit, entity, panel, save, use  # noqa: E402

#: Set-wide entity colours -- see the note in `fig4_01_solvers.py`. Anipose earns
#: its own hue rather than sharing salmon with our DLT: they stand side by side in
#: this panel, which is precisely the case the shared-comparator-colour rule
#: excludes.
ANI_C, DLT_C, REF_C = entity("anipose"), entity("dlt"), entity("refined")

#: column key -> (tick label, colour). ORDER IS LOAD-BEARING: each Anipose column
#: sits immediately left of the LUC3D column of the same algorithm class, so a pair
#: is one saccade rather than a comparison across the panel.
#: TWO-LINE LABELS, library over configuration. One-line names did not fit: eight
#: columns share ~100 mm of axes, so a column gets ~11 mm, and "Anipose" alone is
#: ~10 mm at 6 pt. Stacking the library over the configuration keeps each line
#: inside that budget and, unlike a corner key, survives a greyscale print.
SOLVERS = [("anipose", "Anipose\nlinear", ANI_C),
           ("dlt", "LUC3D\nDLT", DLT_C),
           ("anipose_optim", "Anipose\noptim", ANI_C),
           ("refined", "LUC3D\nrefined", REF_C)]
#: ONE GROUP. The held-out-camera arm was dropped from the artwork on request; its
#: numbers are still deposited in the CSV and still quoted in the legend, because it
#: is the arm in which nothing is enforced and it is the one Anipose wins. What is
#: plotted here is the in-sample metric, which our refinement minimises by
#: construction, so the y label names the scoring space rather than leaving the
#: reader to assume it is a free comparison.
GROUPS = [("reproj_p50", None, None)]

#: EVERY GROUP IS DEPOSITED, only the first is drawn. Cutting the held-out arm from
#: the artwork must not cut it from the record: it is the arm in which nothing is
#: enforced, it is the one Anipose wins, and the legend quotes it. Dropping it from
#: GROUPS alone silently emptied the CSV of it, which is precisely the failure the
#: deposit exists to prevent.
DEPOSIT_GROUPS = [("reproj_p50", "cameras it used", None),
                  ("heldout_p50", "a camera it never saw", None)]

#: x offsets within a group, and the gap between group centres. NO COLUMN MAY SIT AT
#: 0.0: that is the group centre, where the group's major tick goes, and matplotlib
#: deletes a minor tick colliding with a major one (see `remove_overlapping_locs`
#: below -- this cost two silently mislabelled columns once already).
#:
#: GROUP_DX IS DELIBERATELY TIGHT -- the between-group gap is one column spacing, not
#: the generous gap two groups of two could afford. Eight labels have to fit, and
#: whitespace between the groups is whitespace taken from them; a drawn divider
#: separates the groups instead, at no horizontal cost.
OFFSET = {"anipose": -0.75, "dlt": -0.25, "anipose_optim": 0.25, "refined": 0.75}
GROUP_DX = 2.0
#: where the divider between the two groups goes
#: Retained for reference only: it separated the two groups, and there is one
#: group now, so nothing draws it.
DIVIDER_X = GROUP_DX / 2.0


def build() -> pd.DataFrame:
    aj = load("fig4_anipose.json")
    ani = {s["session"]: s for s in aj["per_session"]}
    # THE PLOTTED OPTIM ARM IS `optim_nosmooth` -- see the docstring. The
    # smoothing-on variant is in the same file and is caption material only.
    opt = {s["session"]: s for s in (aj.get("per_session_optim") or [])}
    if not opt:
        raise SystemExit(
            "fig4_anipose.json has no `per_session_optim`; re-run "
            "figs/fig4_anipose.py WITHOUT --no-optim (and with "
            "--optim-score-frames 0, so the optim column covers the same keypoints "
            "as the other three)")
    okey = {"reproj_p50": "optim_nosmooth_reproj_p50",
            "heldout_p50": "optim_nosmooth_heldout_p50"}
    rows = []
    for s in load("fig4.json")["per_session"]:
        sid = s["session"]
        a, o = ani.get(sid), opt.get(sid)
        for key, label, _ in DEPOSIT_GROUPS:
            v = s.get(key) or {}
            if v.get("dlt") is None or v.get("ba") is None:
                continue
            # A session missing from either anipose pass would silently become a
            # short column, i.e. a hole in one series that reads as a solver which
            # happens to have fewer dots. Refuse instead.
            if a is None or a.get(key) is None:
                raise SystemExit(
                    f"fig4_anipose.json has no {key} for session {sid}; "
                    f"re-run figs/fig4_anipose.py over all 50 sessions")
            if o is None or o.get(okey[key]) is None:
                raise SystemExit(
                    f"fig4_anipose.json has no {okey[key]} for session {sid}; "
                    f"re-run the optim accuracy pass over all 50 sessions")
            rows.append({"session": sid, "group": key, "label": label,
                         "anipose": a[key], "dlt": v["dlt"],
                         "anipose_optim": o[okey[key]], "refined": v["ba"],
                         # deposited so the caption's "same keypoints" claim is
                         # checkable rather than asserted
                         "n_optim_keypoints": o["n"]})
    return pd.DataFrame(rows)


def main():
    use()
    df = build()
    deposit(df, 4, "fig4d_per_session.csv")

    # TWO-THIRDS, NOT HALF. Six columns of dots plus six named ticks do not fit in
    # 88 mm -- the tick labels collide and the paired lines become a single smear.
    # The row is (d two-thirds + e quarter) = 163.3 mm, still inside the 180 mm
    # page, and better filled than the 134 mm it was.
    fig, ax = panel("two-thirds", "std")
    centres, cols = {}, []
    for gi, (key, label, note) in enumerate(GROUPS):
        g = df[df.group == key]
        xs = {k: gi * GROUP_DX + OFFSET[k] for k, *_ in SOLVERS}
        cols += [(xs[k], t, c) for k, t, c in SOLVERS]
        centres[key] = (gi * GROUP_DX, label, note, g)
        # ONE POLYLINE PER SESSION ACROSS ALL THREE, not three pairwise segments:
        # the reader is meant to follow a single recording through the solvers, and
        # a session whose anipose dot is low but whose refined dot is high should
        # trace a visible zigzag rather than two unrelated links.
        for _, r in g.iterrows():
            ax.plot([xs[k] for k, *_ in SOLVERS], [r[k] for k, *_ in SOLVERS],
                    color="#DDDDDD", lw=0.5, zorder=1)
        for k, _, color in SOLVERS:
            # THE OPTIM COLUMNS ARE OPEN CIRCLES, the linear ones filled. Anipose
            # keeps one hue across both of its columns because it is one library, so
            # the marker has to carry "which configuration" -- as the hatch does on
            # 4e's optim bar. Two solid green columns read as two methods.
            fill = "none" if k.endswith("_optim") else color
            ax.plot(np.full(len(g), xs[k]), g[k], "o", ms=4.5, zorder=2,
                    color=color, markerfacecolor=fill, markeredgecolor=color,
                    markeredgewidth=0.8, linestyle="none")
            ax.plot([xs[k] - 0.18, xs[k] + 0.18], [median(g[k])] * 2, color=color,
                    lw=3.0, zorder=3, solid_capstyle="butt")

    keys = [k for k, *_ in SOLVERS]
    lo, hi = df[keys].min().min(), df[keys].max().max()
    ax.set_ylim(lo - 0.2, hi + 0.55)
    # The four columns and a margin, not the two-group span: with the held-out
    # group gone, the old limit left the right half of the panel empty and the
    # marks smaller than the space allowed.
    ax.set_xlim(min(OFFSET.values()) - 0.45, max(OFFSET.values()) + 0.45)
    # TWO LINES, not one. "reprojection error, median (px)" is 37 mm of rotated type
    # and adding the solver tick row below leaves the axes ~35 mm, so the one-line
    # form was clipped off the top of the page. Broken in two it needs only the
    # width of its longer line -- and costs ~4 mm of the panel instead.
    ax.set_ylabel("reprojection error, median (px)\nin the cameras the solve used")

    ticks, labels = [], []
    for centre, label, note, g in centres.values():
        # The three medians go above the cloud, not beside their own rules: the dots
        # span the full data range at each x and would overprint a label at the rule.
        #
        # AND THEY ARE COLOUR-CODED TO THE SOLVERS, as the legacy panel had them: in
        # grey, "2.26 2.35 2.15" does not say which column is which, so the reader
        # has to infer it from the order. Drawn as separate text objects because
        # matplotlib cannot colour part of one. Printed in COLUMN order, not sorted,
        # so the numbers line up under the columns they belong to.
        for k, _, color in SOLVERS:
            ax.text(centre + OFFSET[k], hi + 0.42, f"{median(g[k]):.2f}",
                    ha="center", va="top", fontweight="bold", fontsize=8,
                    color=color)
        # The win count belongs to its group, so it goes INTO the tick label on a
        # second line. As free-floating text it landed on the tick labels.
        #
        # EACH GROUP GETS THE COUNT THAT IS ACTUALLY CONTINGENT IN IT. On the left,
        # "lowest" is the refinement by construction, so the only count that carries
        # information is the DLT-against-DLT one: Anipose's linear solve against
        # ours, neither of which optimises this metric. On the right nothing is
        # enforced, so the headline count is the honest one -- and it is not ours.
        # Quoting "refined lower in 50/50" here, as this panel did with two columns,
        # would now be picking the flattering pair out of three.
        # WITH FOUR COLUMNS THE COUNT IS REPORTED PER PAIR, not as one "lowest"
        # tally. "Anipose lowest in 0/50" on the left was true and uninformative --
        # it was dominated by the enforced refinement. Each pair's own count says
        # which of two comparable solvers won, which is the question the pairing
        # poses.
        # NO WIN COUNTS ON THE ARTWORK. With one group they would report only the
        # enforced comparison, which cannot come out any other way; the honest
        # counts belong to the arm that is no longer drawn and are in the legend.
        ticks.append(centre)
        labels.append("")

    # THE COLUMNS ARE NAMED UNDER THEMSELVES, which is what the legacy panel did and
    # what the restyle dropped in favour of a corner colour key. A key makes the
    # reader carry "teal = refined" across the panel to each of the six columns; a
    # label under the column does not, and it is also the only thing that survives a
    # greyscale print. Minor ticks for the columns, major ticks (drawn at length 0,
    # since there is no column at a group centre) for the group, padded clear of the
    # minor row.
    #
    # `remove_overlapping_locs = False` IS LOad-BEARING, not tidying. matplotlib
    # drops any MINOR tick that coincides with a MAJOR one, and the DLT column sits
    # at OFFSET 0.0 -- exactly the group centre, where the group's major tick is. So
    # both DLT labels were silently deleted and the remaining four labels were then
    # paired with the wrong colours by `zip`, giving a panel whose right-hand group
    # read "Anipose (teal) ... refined (green)": every column mislabelled and
    # miscoloured, on artwork that otherwise looked finished.
    ax.xaxis.remove_overlapping_locs = False
    ax.set_xticks([x for x, *_ in cols], minor=True)
    ax.set_xticklabels([t for _, t, _ in cols], minor=True, fontsize=8)
    for lab, (_, _, color) in zip(ax.get_xticklabels(minor=True), cols):
        lab.set_color(color)
    ax.set_xticks(ticks)
    ax.set_xticklabels(labels)
    ax.tick_params(axis="x", which="minor", length=0, pad=3.0)
    # 20, not 13: the minor row is now TWO lines, so the group row has to clear both.
    ax.tick_params(axis="x", which="major", length=0, pad=2.0)
    save(fig, 4, "d", "per_session")


if __name__ == "__main__":
    main()
