#!/usr/bin/env python3
"""
Fig 7b -- within-view IDF1 per session, across the SLAP-2M corpus.

    ############################################################################
    FIXED 2026-08-13, ON ERIC'S INSTRUCTION: THIS PANEL NOW PLOTS THE SHIPPED
    TRACKER. Until then its LUC3D curve came from `matchFrameInstances`, the
    pre-#131 PER-FRAME matcher (run 2026-05-15) -- `pose/cross-view-tracker.js`
    was merged 2026-07-06, so the panel described a tracker LUCID had not shipped
    for seven weeks. Same 74 sessions, same pool, same three series, same design;
    the LUC3D data is now `figs/out/fig7_variant_best.json`'s `slap2m` block.

        within-view IDF1   mean 0.7360 -> 0.7520,  median 0.8997 -> 0.9202
        sessions >= 0.9      36/74 -> 39/74
        camera-sessions won 229/444 -> 269/444, and TIES 38 -> 92, so SLEAP's
                            outright wins fall 173 -> 79

    So the panel's claim -- LUC3D separates from the other two in the upper tail
    -- is strengthened, and every number in the count block moved. THE TIE COUNT
    QUADRUPLING IS THE ONE TO STATE OUT LOUD rather than bury: most of SLEAP's
    fall in outright wins is camera-sessions the two now score IDENTICALLY
    (single-animal sessions where both are perfect), NOT camera-sessions SLEAP
    lost. Read as "we beat SLEAP on 40 more camera-sessions" it would overclaim.

    `--as-shipped` re-renders the retired arm under a `_pre131` slug for
    provenance. `figs/out/fig3_trackers.json` is NOT rewritten; this panel reads a
    different deposit. Account: `figs/out/ITEM3-SLAP2M-GATE.md`.
    ############################################################################

THIS PANEL REPLACED A DOT SWARM, and the change is substantive, not cosmetic. As
444 jittered dots the finding was invisible; as a survival curve -- the percentage
of sessions scoring at or above each IDF1 threshold -- it is a vertical distance at
any threshold the reader cares to pick.

The trackers separate most in the UPPER TAIL, which both a median bar and a jittered
cloud bury: at IDF1 >= 0.9 the counts are LUC3D 39/74, SLEAP 22/74, ByteTrack 10/74.
(SLEAP and ByteTrack are untouched by the tracker substitution above -- same files,
same scores -- so all of that movement is ours.)

The curve is drawn from every session's own IDF1, so it is a true ECDF over the 74
sessions rather than an interpolation through the five deposited thresholds; the 0.9
threshold is marked so the numbers in the caption can be read straight off.

WHAT THIS PANEL MEASURES IS NOT WHAT 7a MEASURES, and the figure previously gave a
reader no way to tell. 7a's "within view" is 0.749 -- Mouse-Dyad-10M, 50 sessions, 5
cameras. This is SLAP-2M, 74 sessions, 6 cameras, where LUC3D's within-view mean is
0.752. Two different quantities, both called within-view IDF1; the corpus and n are
now on the panel, and BOTH DIRECTIONS OF THE POINTER ARE DRAWN -- `SLAP-2M corpus ·
a is Mouse-Dyad-10M` heads the count block here, and 7a's footer carries `b-f: SLAP-2M`.
One-sided labelling was the state that made 7.6 a finding: naming the corpus on the
panel a reader happens to be looking at does nothing if the panel they are comparing
it with is unlabelled, and the two numbers (0.749 vs 0.752) are close enough to read
as one measurement rounded twice. THE SUBSTITUTION MADE THAT WORSE, NOT BETTER: they
used to differ by 0.013 and now differ by 0.003, so the labelling is doing more work
than it was.

BOTH MEAN AND MEDIAN ARE PRINTED, which the deposit asks for: `caveats` --
"Corpus means are dragged by a heavy tail: LUC3D within-view IDF1 mean 0.736 vs
median 0.900. Report both." (That caveat was written against the pre-#131 arm; on the
shipped tracker it is 0.752 vs 0.920 and the point is unchanged -- the gap between the
two is what the caveat is about, and it barely moved: 0.164 -> 0.168.) The survival
curve shows exactly that shape (half the sessions above 0.9, a long tail of hard ones
below 0.3), so those two numbers are the right summary to set beside it.

The in-axes block also carries `camera_session_argmax` -- how many of the 444
camera-sessions each tracker wins outright -- which was on the legacy panel and had
been dropped: LUC3D 269, SLEAP 79, ByteTrack 4, 92 tied.

Source: figs/out/fig7_variant_best.json `slap2m.within_view[*].per_session`,
        `slap2m.camera_session_argmax` (`slap2m` = the SHIPPED tracker); with
        `--variant`, also `slap2m_fresh_anchor` and `slap2m_pre131_reference`;
        with `--as-shipped`, figs/out/fig3_trackers.json `slap2m` (pre-#131).

    python3 figs/panels/fig7_01_survival.py               # the manuscript panel
    python3 figs/panels/fig7_01_survival.py --variant     # + fresh anchor + pre-#131
    python3 figs/panels/fig7_01_survival.py --as-shipped  # the retired arm, _pre131 slug
"""
import sys
from pathlib import Path

import numpy as np
import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import (MUTED, entity, footnote, GREY, deposit, panel,  # noqa: E402
                       save, use)
from fig7_variant_common import (FRESH_LS, REF_LS, arms, flags,  # noqa: E402
                                 pool_note, slug)

#: Hues from `entity()`, not picked here: these three trackers recur across five of
#: this figure's seven panels and across Figs 3-5, so one hue must mean one tracker
#: set-wide (review finding C3). The colours are unchanged; the mapping now has one
#: home instead of seven.
TRACKERS = [("luc3d", "LUC3D", entity("luc3d")),
            ("sleap", "SLEAP", entity("sleap")),
            ("bytetrack", "ByteTrack", entity("bytetrack"))]
MARK = 0.9
N_CAMERAS = 6
#: The corpus, stated as a header over the in-axes count block. See the comment at
#: its `ax.text` for why it is there and not on a fourth footer line.
CORPUS = "SLAP-2M corpus · a is Mouse-Dyad-10M"
#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render this panel's ink spanned 49.4 of 52.1 mm, and the assembled page came to
#: 196.3 mm with 19.3% of its scanlines carrying no ink at all (review findings 6.12 /
#: C9). At 47 mm nothing is resized and no type is touched -- the axes just stops being
#: taller than its content. It has to be the WHOLE figure: a row is as tall as its
#: tallest panel, so shrinking one panel of a pair buys nothing. 48 rather than 47
#: because its row-mate 7d bottoms out there (see that file), and a row is as tall
#: as its tallest panel -- 47 here would only add 1 mm of white under this panel.
#: 50.0, not 47/48. Fig 7 was already UNDER the 200 mm ceiling, and these
#: panels' ink spans ~50 of 52 mm -- so trimming below 50 buys page height by
#: SHORTENING THE AXES, not by removing blank. Most composite "blank" is the
#: inter-row structure that carries the panel letters and titles (see the
#: whitespace note in figs/README.md), so shrinking data plots to chase that
#: metric is a bad trade. 50 mm is the strictly bbox-preserving floor.
ROW_H = 50.0



def main(variant=False, corrected=True):
    use()
    sl, fresh, ref, _tab = arms(variant, corrected)
    wv = sl["within_view"]
    am = sl["camera_session_argmax"]
    n_cs = sl["n_camera_sessions"]

    rows = []
    # "half", not "third": at a third of the page this panel could not carry its own
    # corpus label, and the row it shares with 7d used 149 of 180 mm, so the width
    # was free. Both panels in the row are now 88 mm and their axes line up.
    fig, ax = panel("half", ROW_H)
    # THE THREE LUC3D ARMS FIRST, so the two movements are one vertical distance each
    # at any threshold: the retired pre-#131 curve (MUTED, finely dotted -- a reference
    # level, not a method), the SHIPPED curve (teal, solid, the one the panel is about),
    # and the EXPERIMENTAL fresh anchor (teal, dashed). LUC3D keeps its hue on both of
    # its arms; the arm is distinguished by dash pattern and by the key.
    extra = []
    if variant:
        # Relabelled 2026-08-17: the fresh anchor is the SHIPPED configuration
        # now, and the arm the manuscript panel draws is the previous default.
        extra = [("LUC3D pre-#131 (retired)",
                  ref["within_view"]["luc3d"]["per_session"], MUTED, REF_LS, 1.1),
                 ("LUC3D + fresh anchor (shipped)",
                  fresh["within_view"]["luc3d"]["per_session"], entity("luc3d"),
                  FRESH_LS, 1.5)]
    for label, vals, color, ls, lw in extra:
        v = np.sort(np.asarray(vals))
        n = len(v)
        surv = 100.0 * (n - np.arange(n)) / n
        ax.step(v, surv, where="post", color=color, lw=lw, ls=ls, zorder=2)
        rows += [{"tracker": label, "idf1": float(xx), "survival_pct": float(ss)}
                 for xx, ss in zip(v, surv)]
    for key, label, color in TRACKERS:
        v = np.sort(np.asarray(wv[key]["per_session"]))
        n = len(v)
        # Survival: % of sessions at or above each threshold. Step-post, because
        # the value is constant until the next session's score is passed.
        surv = 100.0 * (n - np.arange(n)) / n
        ax.step(v, surv, where="post", color=color, lw=2.0, zorder=3)
        atmark = 100.0 * (v >= MARK).sum() / n
        rows += [{"tracker": label, "idf1": float(x), "survival_pct": float(s)}
                 for x, s in zip(v, surv)]
        ax.plot([MARK], [atmark], "o", color=color, ms=5, mec="white", mew=1.0,
                zorder=4)

    deposit(pd.DataFrame(rows), 7,
            f"{slug('fig7b_survival', variant, corrected)}.csv")

    ax.axvline(MARK, color=GREY, lw=0.8, ls=(0, (1.5, 1.5)), zorder=1)
    # Lower LEFT: every curve starts near 100% and falls rightwards, so this corner
    # is the only reliably empty one -- against the 0.9 rule the three counts landed
    # on the strokes they describe. The names live here too rather than in a key band
    # above, which keeps the plot its full height for the four-line footer.
    # THE VARIANT'S BLOCK IS FIVE LINES, NOT THREE, and it grows UPWARD from the same
    # bottom line: the corner is empty up to ~50% of the axes height at x = 0.03
    # (every curve starts near 100% and falls rightwards), so the two extra LUC3D arms
    # fit above the three published series without touching a stroke. Each arm's
    # camera-session argmax is that arm's OWN three-way count against the same,
    # unchanged SLEAP and ByteTrack columns.
    block = [(label, np.asarray(wv[key]["per_session"]), color, am[key], n_cs)
             for key, label, color in TRACKERS]
    if variant:
        block = [("LUC3D (previous default)", np.asarray(wv["luc3d"]["per_session"]),
                  entity("luc3d"), am["luc3d"], n_cs),
                 ("LUC3D + fresh (shipped)",
                  np.asarray(fresh["within_view"]["luc3d"]["per_session"]),
                  entity("luc3d"),
                  fresh["camera_session_argmax"]["luc3d"],
                  fresh["n_camera_sessions"]),
                 ("LUC3D pre-#131",
                  np.asarray(ref["within_view"]["luc3d"]["per_session"]), MUTED,
                  ref["camera_session_argmax"]["luc3d"],
                  ref["n_camera_sessions"])] + block[1:]
    y0 = 0.22 + 0.09 * (len(block) - 3)
    for i, (label, v, color, won, ncs) in enumerate(block):
        ax.text(0.03, y0 - i * 0.09,
                f"{label}  {int((v >= MARK).sum())}/{len(v)} · {won}/{ncs}",
                transform=ax.transAxes, ha="left", color=color, fontsize=7,
                fontweight="bold")
    # THE CORPUS, AS A HEADER OVER THAT BLOCK, and it is load-bearing rather than
    # provenance boilerplate. 7a's "within view" is 0.749 and this curve is centred
    # near 0.90; both are called within-view IDF1 and they are DIFFERENT quantities
    # (a: Mouse-Dyad-10M, 50 sessions, C = 5; here: SLAP-2M, 74 sessions, C = 6). The footer
    # already names SLAP-2M, but a reader reads a number where it is printed, and the
    # counts in this block are the numbers a reader compares against a. So the
    # contrast is stated at the block, in MUTED so it reads as a label for the three
    # coloured lines under it rather than a fourth series.
    #
    # HERE AND NOT ON A FOURTH FOOTER LINE: `footnote` folds into the x label, so a
    # fourth line costs ~3.2 mm out of this panel's plot. This corner is free -- every
    # curve starts near 100% and falls rightwards, and at 6.5 pt the string measures
    # 33.9 mm against the ~46 mm of clear width before the ByteTrack step reaches
    # this height, so it lands on nothing. Measured, not assumed; `lint_text.py`'s
    # on-data check is the backstop.
    ax.text(0.03, y0 + 0.09, CORPUS, transform=ax.transAxes, ha="left",
            va="baseline", color=MUTED, fontsize=6.5)
    # HORIZONTAL, NOT ROTATED, and this is a height consequence rather than a taste
    # change. Set along the rule the label is ~11 mm of type; against the 25 mm axis
    # this panel had at 52 mm that reached down to about the 52% line and cleared
    # every curve, but against a ~20 mm axis it reaches to ~41% and crosses LUC3D's
    # step at x = 0.9 (`lint_text.py`: ON DATA, 8% of its box inked). Laid flat it
    # spends the panel's WIDTH, of which there is far more to spare: it occupies
    # x = 0.70-0.88 at y = 98, where the highest curve is still 35 points below.
    ax.text(MARK - 0.02, 98, f"IDF1 ≥ {MARK}", color=MUTED, fontsize=7,
            ha="right", va="top")

    ax.set_xlim(0, 1)
    ax.set_ylim(0, 100)
    ax.set_yticks([0, 25, 50, 75, 100])
    # "session mean over 6 cameras" belongs in the axis label, not the footer: the
    # unit of replication is the session, and each session's IDF1 is the mean of its
    # six per-camera scores. The legacy footer said so and it had been dropped; on the
    # label it is next to the quantity it qualifies, and the footer lines stay narrow
    # enough not to hang off an 88 mm panel.
    ax.set_xlabel(f"IDF1 threshold, session mean over {N_CAMERAS} cameras")
    # TWO LINES: rotated, this label is ~40 mm of type against a ~20 mm axis at this
    # row height. A rotated label cannot be shrunk to fit -- constrained_layout
    # centres it and lets it overhang -- so at anything under 52 mm the page cut its
    # ends off (`lint_text.py` CLIPPED). Wrapping spends width, not height.
    ax.set_ylabel("% of sessions\nat or above")
    luc = wv["luc3d"]
    footnote(ax, f"one step per session; n = {luc['n_sessions']} SLAP-2M sessions\n"
             f"counts: sessions ≥ {MARK} · camera-sessions won "
             f"({am['tie']} of {n_cs} tied)\n"
             f"LUC3D within-view IDF1: mean {luc['mean']:.3f}, "
             f"median {luc['median']:.3f}"
             + ("" if not variant else
                f"\nLUC3D here is the PREVIOUS DEFAULT tracker (shipped until the "
                f"2026-08-17 fresh-anchor promotion): mean {luc['mean']:.4f} / median "
                f"{luc['median']:.4f} / {int((np.asarray(luc['per_session']) >= MARK).sum())}"
                f" sessions >= {MARK}, against the pre-#131 tracker this panel printed "
                f"until 2026-08-13 "
                f"({ref['within_view']['luc3d']['mean']:.4f} / "
                f"{ref['within_view']['luc3d']['median']:.4f} / "
                f"{int((np.asarray(ref['within_view']['luc3d']['per_session']) >= MARK).sum())}), "
                f"retired 2026-07-06"
                f"\nthe fresh anchor (shipped since 2026-08-17) is "
                f"{fresh['within_view']['luc3d']['mean']:.4f} / "
                f"{fresh['within_view']['luc3d']['median']:.4f} / "
                f"{int((np.asarray(fresh['within_view']['luc3d']['per_session']) >= MARK).sum())}"
                f"\nTIES QUADRUPLE, {ref['camera_session_argmax']['tie']} -> "
                f"{am['tie']} of {n_cs} camera-sessions, so most of SLEAP's fall in "
                f"outright wins ({ref['camera_session_argmax']['sleap']} -> "
                f"{am['sleap']}) is camera-sessions the two now score IDENTICALLY, not "
                f"camera-sessions SLEAP lost"
                f"\n{pool_note()}"))
    save(fig, 7, "b", slug("survival", variant, corrected))


if __name__ == "__main__":
    main(*flags(sys.argv))
