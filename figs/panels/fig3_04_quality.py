#!/usr/bin/env python3
"""
Fig 3d -- greedy vs exhaustive against GROUND TRUTH, per configuration --
now with the greedy arm at BOTH of its operating points.

UPDATED 2026-08 (on instruction): the manuscript panel carries THREE series --
exhaustive, LUC3D greedy as SHIPPED, and LUC3D greedy with the FRESH ANCHOR
(`sync` + `stale 20` + `distanceThreshold 25`, corr3dWeight at the shipped 6). The
greedy arm of this comparison IS the production tracker
(`figs/fig3-bench/fig3_bench.mjs` drives the real `pose/cross-view-tracker.js`), so
the fresh-anchor configuration changes it, and the question the third series answers
is whether a tracker that stops fusing stale per-view detections into its 3D anchor
groups CLEAN frames more like the ground truth. Both movements stay visible: a
re-render that silently replaced the greedy series would hide which part of any
change is the configuration.

THREE SERIES, NOT A SUBSTITUTION -- AND THE TWO LUC3D ARMS SHARE ONE HUE. Salmon is
the published exhaustive method and teal is LUC3D (`entity("luc3d")`), everywhere in
Fig 3. The fresh-anchor arm is the SAME tracker at a different operating point, not a
different method, so it is teal too and distinguished by a HOLLOW marker -- a second
colour would read as a second method.

THE EXHAUSTIVE SERIES IS THE SAME NUMBERS, AND THAT IS ASSERTED. The exhaustive method
has no tracker state, so `fig3_hh_freshanchor.py` re-uses its cached per-frame outputs
(independence verified by `--probe`: figs/out/fig3_hh_exhaustive_probe.json) and only
the greedy arm is re-run. This panel CHECKS that the two deposits agree on every
exhaustive number and on every frame count, and refuses to draw if they do not -- if
that ever fails, the cached arm was not what it was assumed to be. The fresh-anchor
harness itself is gated: with an empty method block it reproduced the shipped greedy
payload byte-for-byte on all 92 sessions and both manuscript deposits diffed clean
(figs/out/fig3_hh_gate.json), so a difference between the two greedy series is
attributable to the configuration, not the harness.

WHAT IS PLOTTED: the RATE at which a configuration's grouping differs from the GT
partition -- misgrouped frames per 10,000 clean frames -- with the raw count still
printed beside each marker. Bars would be invisible at these values; dodged markers
with the count printed beside each are not.

THE AXIS IS A RATE BECAUSE THE FOUR CONFIGURATIONS HAVE WILDLY DIFFERENT n (review
2026-08). They are scored on 122,830 / 14,275 / 200 / 366 clean frames, so on a
count axis exhaustive's 3 misgroupings in the 366-frame 4x3 configuration sat
adjacent to its 1 misgrouping in the 122,830-frame 2x5 one -- while as rates those
are 82 and 0.0 per 10,000, three orders of magnitude apart. A total is
uninterpretable without its denominator, and a count axis invited exactly the
cross-configuration comparison the denominators forbid.

PER 10,000 RATHER THAN PERCENT, chosen on how the numbers read: every value here is
under 0.9%, and the two headline totals are 0.00073% and 0.0029% -- four leading
zeros, which no reader can hold or compare. Per 10,000 clean frames puts the axis on
integer ticks (0 / 20 / 40 / 60 / 80) and the headline totals at 0.07 and 0.29.
(Fig 7e's rates ARE plain percent; there the values are 0.03-11%, where percent is
the unit nobody has to convert. The unit follows the magnitude, not a house rule.)

THE COUNTS ARE STILL ON THE ARTWORK, beside each marker, because "1 frame" is a fact
worth stating and a rate alone hides how few events these percentages rest on.

READ THE CEILING HONESTLY. These are the CLEAN frames -- every camera holds
exactly A detections, occlusion-heavy frames excluded by construction (the
composition note on 3f). Near-perfect grouping on clean frames is a statement
about clean frames; neither method is being called perfect overall. The GT
matching transfers proofread identities over an IoU-0.5 match that is
near-saturated on this pool (49 of 1,402,015 detection keys unmatched, all in the
2x6 configuration) -- honest counts in the deposit's `gt_matching` blocks.

Source: figs/out/fig3_quality.json (fig3_quality.py + fig3_rescore_frames.mjs) for
the exhaustive and shipped-greedy series, figs/out/fig3_quality__<tag>.json
(fig3_hh_freshanchor.py --run) for the fresh-anchor greedy series.

    python3 figs/panels/fig3_04_quality.py               # the manuscript panel
    python3 figs/panels/fig3_04_quality.py --as-shipped  # the retired 2-series panel


--as-shipped: THE RETIRED SHIPPED-ONLY PANEL
--------------------------------------------
Renders the pre-update manuscript panel -- exhaustive vs the shipped greedy arm only,
no fresh anchor -- pixel-identical to the committed artwork, under the
`quality_shipped` slug so it can never overwrite the manuscript PDF. Facts that
belong to that render: on the 5 frames (4-config subset) where the two methods chose
different groupings, the ground truth sided with greedy on 4 -- the
minimum-reprojection-error grouping is not always the right grouping, so optimising
the reprojection objective harder than greedy does buys nothing; exhaustive picks it
by construction, greedy happens not to. (An even earlier version printed "each
method misgroups exactly one of the 137,266 clean frames"; the corpus-scale deposit
says otherwise, and both counts are read from the data at draw time.)
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (SALMON, TEAL, deposit, panel,  # noqa: E402
                       save, text_legend, use)

#: The fresh-anchor deposit, and the tag that identifies it. Globbed rather than
#: named so the tag (a digest of the method+threshold block) does not have to be
#: duplicated here, and `__shipped` -- the reproduction gate's rebuild of the SHIPPED
#: numbers -- is excluded, because plotting it as "fresh anchor" would be a silent
#: mislabel of the one file that is deliberately identical to the manuscript's.
VARIANT_GLOB = "fig3_quality__*.json"

#: Series names. Short enough that a three-line key fits the 57.3 mm third-column
#: slot this panel keeps in LAYOUTS[3] -- the earlier exploratory render spelt the
#: fresh arm as a sentence and needed two-thirds width for it.
FRESH_NAME = "LUC3D greedy, fresh anchor"
SHIPPED_NAME = "LUC3D greedy, shipped"

#: Method -> (deposit key, display name, colour), for the --as-shipped render.
#: SALMON/TEAL match 3a and 3f: salmon is the published exhaustive method, teal is
#: LUC3D, everywhere in Fig 3.
METHODS = [("exhaustive", "exhaustive", SALMON), ("greedy", "LUC3D (greedy)", TEAL)]

#: Rate basis. 10,000 clean frames -- see the docstring for why not percent.
PER = 10_000


def variant_deposit_name():
    """The newest fresh-anchor quality deposit, or a message saying what to run."""
    hits = sorted(p.name for p in (Path(__file__).resolve().parent.parent / "out")
                  .glob(VARIANT_GLOB) if "__shipped" not in p.name)
    if not hits:
        sys.exit("fig3d: no fresh-anchor quality deposit. Run:\n"
                 "  PY=/root/vast/eric/luc3d-bench/liezl_env/bin/python\n"
                 "  $PY figs/fig3_hh_freshanchor.py --probe\n"
                 "  $PY figs/fig3_hh_freshanchor.py --run")
    return hits[-1]


def _check_exhaustive_unchanged(shipped, var):
    """The exhaustive arm must be identical between the two deposits.

    It is the same `exhaustive.json` bytes in both (only the greedy arm was re-run), so
    any difference means the assumption the re-use rests on is wrong. Checked here, at
    draw time, because this panel is where the two arms are put on one axis.
    """
    sc = {c["key"]: c for c in shipped["configs"] if c.get("status") == "ok"}
    vc = {c["key"]: c for c in var["configs"] if c.get("status") == "ok"}
    if set(sc) != set(vc):
        sys.exit(f"fig3d: configs differ: {sorted(sc)} vs {sorted(vc)}")
    for k in sc:
        a, b = sc[k]["gt"]["exhaustive"], vc[k]["gt"]["exhaustive"]
        for f in ("frames", "exact_match_frames", "frames_with_pairs"):
            if a[f] != b[f]:
                sys.exit(f"fig3d: exhaustive {f} moved in {k}: "
                         f"{a[f]} vs {b[f]} -- the re-used exhaustive arm is NOT the "
                         f"cached one. Do not draw this panel; re-run --probe.")
        if sc[k]["n_compared"] != vc[k]["n_compared"]:
            sys.exit(f"fig3d: n_compared moved in {k}: "
                     f"{sc[k]['n_compared']} vs {vc[k]['n_compared']}")


def build(as_shipped=False):
    q = load("fig3_quality.json")
    var, vc = None, None
    if as_shipped:
        methods = list(METHODS)
    else:
        var = load(variant_deposit_name())
        _check_exhaustive_unchanged(q, var)
        vc = {c["key"]: c for c in var["configs"] if c.get("status") == "ok"}
        methods = [("exhaustive", "exhaustive", SALMON),
                   ("greedy", SHIPPED_NAME, TEAL),
                   ("greedy_fresh", FRESH_NAME, TEAL)]
    rows = []
    for c in q["configs"]:
        if c.get("status") != "ok":
            continue
        for key, name, _ in methods:
            g = (vc[c["key"]]["gt"]["greedy"] if key == "greedy_fresh"
                 else c["gt"][key])
            rows.append({
                "label": f"{c['animals']}×{c['cameras']}",
                "hypotheses": None, "method": name,
                "frames": g["frames"],
                "gt_exact": g["exact_match_frames"],
                "misgrouped": g["frames"] - g["exact_match_frames"],
                # The rate the axis plots, and the count it prints, from the SAME
                # two numbers -- so the marker height and the label beside it
                # cannot disagree.
                "misgrouped_per_10k": (g["frames"] - g["exact_match_frames"])
                / g["frames"] * PER,
                "pair_accuracy_mean": g["pair_accuracy_mean"],
                "n_agree": c["n_agree"], "n_compared": c["n_compared"],
            })
    df = pd.DataFrame(rows)
    detail = [d for c in q["configs"] for d in c.get("disagreement_detail", [])]
    vdetail = ([d for c in var["configs"] for d in c.get("disagreement_detail", [])]
               if var else None)
    return df, detail, methods, vdetail


def main(as_shipped=False):
    use()
    df, detail, methods, vdetail = build(as_shipped)
    deposit(df, 3, "fig3d_quality_shipped.csv" if as_shipped
            else "fig3d_quality.csv")

    # A THIRD, in both renders: this panel shares its LAYOUTS[3] row with e and f
    # and the grid only closes at 180 mm if all three are "third" (see 3e's note).
    # The three-series key fits because the series names are kept short.
    fig, ax = panel("third", "std", key=len(methods))
    labels = list(dict.fromkeys(df.label))
    x = np.arange(len(labels))

    # A LOG RATE AXIS, because the rates now span 1.3 to 90 per 10,000. On a linear
    # axis the 4x3 point pins the top and the three two-animal configurations pile up
    # against the floor, which is what the corpus-scale re-run turned this panel into:
    # with 92 sessions instead of 4 the counts went from 0/1/3 to three and four
    # digits, and the old layout collided in five places (lint: 4 OVERLAP, 1 dropped
    # run). Log separates them and makes the animal-count trend legible, which is the
    # panel's actual content now that there is a trend to see.
    # THE TWO LUC3D ARMS SHARE ONE HUE (see the docstring): the fresh-anchor arm is
    # teal with a HOLLOW marker, not a second colour.
    hollow = {FRESH_NAME}
    n_m = len(methods)
    for mi, (key, name, color) in enumerate(methods):
        g = df[df.method == name].set_index("label").loc[labels]
        xs = x + (mi - (n_m - 1) / 2) * (0.52 if n_m == 2 else 0.36)
        if name in hollow:
            ax.plot(xs, g.misgrouped_per_10k, "o", mfc="white", mec=color, mew=1.5,
                    ms=5.5, zorder=3)
        else:
            ax.plot(xs, g.misgrouped_per_10k, "o", color=color, ms=5.5, mec="white",
                    mew=1.0, zorder=3)
        # RAW COUNT ABOVE EACH MARKER. One misgrouped frame is a fact a rate hides,
        # so the count stays. Putting one series BELOW its marker was tried and is
        # wrong at the bottom of a log axis: LUC3D's 2x5 point sits at 1.7 per
        # 10,000, so its label fell through the axis floor and printed on the spine.
        # The horizontal dodge separates the series instead; in the three-series
        # render the hollow arm's label goes a step higher so two arms landing at a
        # similar rate cannot stack their labels.
        for xi, v, n in zip(xs, g.misgrouped_per_10k, g.misgrouped):
            ax.annotate(f"{int(n):,}", (xi, v), textcoords="offset points",
                        xytext=(0, 13 if name in hollow else 6),
                        ha="center", va="bottom",
                        color=color, fontsize=6, fontweight="bold")

    text_legend(ax, [(n, c) for _, n, c in methods], "above")
    ax.set_xticks(x)
    # n GOES UNDER ITS OWN TICK, not into a list. "n = 4,324,330 - 237,841 - 7,001 -
    # 3,000 frames" was too long for a 57 mm panel and PyMuPDF dropped the whole run
    # from the PDF, so the denominators silently vanished from the artwork.
    def _n(v):
        return f"{v / 1e6:.1f}M" if v >= 1e6 else (f"{v / 1e3:.0f}k" if v >= 1e4
                                                  else f"{v:,}")
    ns = [int(df[df.label == lab].frames.iloc[0]) for lab in labels]
    ax.set_xticklabels([f"{lab}\n{_n(n)}" for lab, n in zip(labels, ns)])
    ax.set_xlim(-0.55, len(labels) - 0.45)
    ax.set_yscale("log")
    # Floor just below the smallest rate, ceiling one short step above the largest so
    # the count labels clear the frame. No band is reserved at the top any more:
    # the pooled totals that used to sit there are legend text now. The ceiling is
    # widened only if a series exceeds the shipped render's 400 (the fresh arm's
    # rates were not known when 400 was chosen).
    top = (400 if as_shipped
           else max(400, float(df.misgrouped_per_10k.max()) * 10 ** 0.65))
    ax.set_ylim(0.75, top)
    ax.set_yticks([1, 10, 100] + ([1000] if top > 1000 else []))
    ax.set_yticklabels(["1", "10", "100"] + (["1000"] if top > 1000 else []))
    ax.set_ylabel("frames misgrouped vs GT\nper 10,000 clean frames")
    ax.set_xlabel("animals × cameras")

    # NO POOLED-TOTAL BLOCK ON THE ARTWORK. The corpus-scale re-run put four-digit
    # counts and a 4.57M denominator into a 57 mm panel, and every arrangement of
    # them collided with the data or was dropped by the renderer (lint: OVERLAP,
    # CLIPPED, TRUNCATED). They are legend sentences, they are in
    # FIGURE-LEGENDS.md, and they are printed to the build log here so a value that
    # goes wrong is still visible to whoever runs the build.
    first_greedy = methods[1][1]
    total = int(df[df.method == first_greedy].frames.sum())
    wrong = {n: int(df[df.method == n].misgrouped.sum()) for _, n, _ in methods}
    rate = {n: wrong[n] / total * PER for _, n, _ in methods}
    gt_g = sum(1 for d in detail if d.get("gt_matches") == "greedy")
    gt_e = sum(1 for d in detail if d.get("gt_matches") == "exhaustive")
    print(f"  pooled over {total:,} clean frames: "
          + ", ".join(f"{n} {wrong[n]:,} ({rate[n]:.2f} per {PER:,})"
                      for _, n, _ in methods))
    print(f"  methods disagree on {len(detail):,}: GT sides with greedy {gt_g:,}, "
          f"exhaustive {gt_e:,}")
    if vdetail is not None:
        vg = sum(1 for d in vdetail if d.get("gt_matches") == "greedy")
        ve = sum(1 for d in vdetail if d.get("gt_matches") == "exhaustive")
        print(f"  fresh anchor vs exhaustive disagree on {len(vdetail):,}: GT sides "
              f"with greedy {vg:,}, exhaustive {ve:,}")

    save(fig, 3, "d", "quality_shipped" if as_shipped else "quality")


if __name__ == "__main__":
    main(as_shipped="--as-shipped" in sys.argv)
