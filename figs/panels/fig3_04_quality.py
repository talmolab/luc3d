#!/usr/bin/env python3
"""
Fig 3c -- greedy vs exhaustive against GROUND TRUTH, per configuration --
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
#: RENAMED 2026-08-17 (Eric's decision): the fresh-anchor operating point is now
#: the SHIPPED configuration; the arm that shipped before it is the previous
#: default. "LUC3D" is dropped from the key text to keep the tagged name inside
#: the 57.3 mm key band (the hue already says LUC3D: teal is LUC3D everywhere in
#: Fig 3, per the docstring).
FRESH_NAME = "greedy (LUC3D)"
SHIPPED_NAME = "greedy, previous default"

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
        # FRESH ANCHOR ONLY (review 2026-08-14: "for the 3c just do fresh anchor not
        # shipped"). Three series at four x positions with a raw count over each was
        # twelve markers and twelve labels in 57 mm. The shipped arm is still measured
        # and still in the deposit -- `--as-shipped` renders the two-series panel it
        # belonged to -- but the comparison this panel makes is exhaustive against the
        # configuration we would recommend, and that is two series. FRESH_NAME is the
        # `{"sync": true, "stale": 20}` + distanceThreshold 25 tracker configuration
        # (VARIANT_GLOB resolves to the one deposit tagged "stale20" -- see its
        # docstring), the fresh-anchor operating point this panel exists to show.
        methods = [("exhaustive", "exhaustive", SALMON),
                   ("greedy_fresh", FRESH_NAME, TEAL)]
    rows = []
    # PER-SESSION rates for the box-and-whisker (review: "show box and whisker
    # plots not just dots" -- a single pooled dot per config hid that most
    # sessions are perfect and a few are not). Keyed by (label, method name).
    session_rates = {}
    for c in q["configs"]:
        if c.get("status") != "ok":
            continue
        label = f"{c['animals']}×{c['cameras']}"
        for key, name, _ in methods:
            src = vc[c["key"]] if key == "greedy_fresh" else c
            field = "greedy" if key == "greedy_fresh" else key
            g = src["gt"][field]
            rows.append({
                "label": label,
                "hypotheses": None, "method": name,
                "frames": g["frames"],
                "gt_exact": g["exact_match_frames"],
                "misgrouped": g["frames"] - g["exact_match_frames"],
                # The rate the axis plots, from the SAME two numbers the box
                # summarises -- so the pooled row and the per-session box
                # cannot disagree about what went into either.
                "misgrouped_per_10k": (g["frames"] - g["exact_match_frames"])
                / g["frames"] * PER,
                "pair_accuracy_mean": g["pair_accuracy_mean"],
                "n_agree": c["n_agree"], "n_compared": c["n_compared"],
            })
            rates = []
            for ps in src["per_session"]:
                pg = ps["gt"][field]
                if pg["frames"] == 0:
                    continue
                rates.append((pg["frames"] - pg["exact_match_frames"])
                             / pg["frames"] * PER)
            session_rates[(label, name)] = np.array(rates)
    df = pd.DataFrame(rows)
    detail = [d for c in q["configs"] for d in c.get("disagreement_detail", [])]
    vdetail = ([d for c in var["configs"] for d in c.get("disagreement_detail", [])]
               if var else None)
    return df, detail, methods, vdetail, session_rates


def main(as_shipped=False):
    use()
    df, detail, methods, vdetail, session_rates = build(as_shipped)
    deposit(df, 3, "fig3c_quality_shipped.csv" if as_shipped
            else "fig3c_quality.csv")

    # A THIRD, in both renders: this panel shares its LAYOUTS[3] row with e and f
    # and the grid only closes at 180 mm if all three are "third" (see 3e's note).
    fig, ax = panel("third", "std", key=len(methods))

    # POOLED ACROSS animals x cameras (review: the 4-config x 2-method grid of
    # boxes was "ugly and hard to read" -- one box per METHOD, pooling every
    # session from every configuration, is the plain "how accurate is grouping"
    # comparison this panel exists to make). Each box is over every session's
    # per-session misgrouped rate, regardless of which of the 4 configurations
    # that session came from -- a session is still the unit of replication, the
    # animals x cameras split just no longer gets its own axis.
    pooled = {name: np.concatenate([session_rates[(lab, name)]
                                    for lab in df.label.unique()
                                    if len(session_rates[(lab, name)])])
             for _, name, _ in methods}

    # BOX-AND-WHISKER + DOTS over the pooled per-session rates, not one summary
    # dot (review: "show box and whisker plots not just dots"). UNFILLED boxes --
    # a solid alpha-fill read as a heavy bar chart when Q1 sits at/near zero
    # ("those box and whiskers are really ugly"), because a filled box from 0 to
    # Q3 has no visual box left, just a block. Thin colored outline + a colored
    # median tick; dots small, faint, and BEHIND the box so its edge stays crisp.
    x = np.arange(len(methods))
    rng = np.random.default_rng(0)
    for i, (key, name, color) in enumerate(methods):
        v = pooled[name]
        if not len(v):
            continue
        ax.scatter(np.full(len(v), i) + rng.uniform(-0.16, 0.16, len(v)),
                  v, s=4, color=color, alpha=0.35, linewidths=0, zorder=1)
        ax.boxplot([v], positions=[i], widths=0.5, patch_artist=False,
                  showfliers=False, zorder=3, manage_ticks=False,
                  medianprops=dict(color=color, linewidth=1.8),
                  boxprops=dict(color=color, linewidth=1.1),
                  whiskerprops=dict(color=color, linewidth=0.9),
                  capprops=dict(color=color, linewidth=0.9))

    text_legend(ax, [(n, c) for _, n, c in methods], "above")
    ax.set_xticks(x)
    # NO METHOD NAMES UNDER THE BOXES: the legend above already names and
    # colors each one, and the fresh-anchor name is too long to sit under a
    # single box in a 57 mm panel without wrapping onto the next box.
    ax.set_xticklabels([""] * len(methods))
    ax.tick_params(axis="x", length=0)
    ax.set_xlim(-0.6, len(methods) - 0.4)
    # SYMLOG, not log: most sessions are PERFECT (misgrouped rate exactly 0),
    # which a log axis cannot place at all. `linthresh=1` keeps the bottom
    # decade linear (so the pile of zero-rate sessions sits at the floor, not
    # off the axis) and log-scales the nonzero tail above it.
    ax.set_yscale("symlog", linthresh=1, linscale=0.6)
    top = max(400, float(max(v.max() for v in pooled.values() if len(v))) * 10 ** 0.25)
    ax.set_ylim(0, top)
    ax.set_yticks([0, 1, 10, 100] + ([1000] if top > 1000 else []))
    ax.set_yticklabels(["0", "1", "10", "100"] + (["1000"] if top > 1000 else []))
    ax.set_ylabel("frames misgrouped vs GT\nper 10,000 clean frames")

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
