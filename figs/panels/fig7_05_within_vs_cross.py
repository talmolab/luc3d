#!/usr/bin/env python3
"""
Fig 7a -- within-view vs cross-view IDF1: which trackers hold identity ACROSS cameras.

    ############################################################################
    THE MANUSCRIPT PANEL `fig7a_within_vs_cross.pdf` STILL CONTAINS THREE DEFECTS.
    They are corrected ONLY in the `--variant` render, which no manuscript figure
    uses. Fixing 7a itself requires REGENERATING `figs/out/fig3_trackers.json`,
    which is a manuscript deposit and Eric's decision, not this panel's:

      1. SLEAP per-camera 0.115 / 0.062 is a TWO-TRACK FRAGMENT of SLEAP's output
         (`bmimica_build_sleap_ref.py` keeps `ti < N_ANIMALS = 2` of a median 47
         tracks per camera-session). Corrected: within-view 0.1154 -> 0.2062
         (x1.79). Its CROSS-view number is right by accident: like for like,
         camera-scoped, 0.0616 -> 0.0617 (x1.00).
      2. 3D-MuPPET 0.011 / 0.011 is a COVERAGE number, not an identity score: its
         assignments cover a median 1.31% of a session and every unlabelled frame
         is scored as a miss. On the frames it labels it scores 0.21-0.67.
      3. The 1/C = 0.20 rule drawn on the panel is NOT a ceiling. It is a property
         of the camera-scoped pooling convention and is not strict even then;
         measured per-session values exceed it.

    So the panel as it stands understates TWO competitors by two unrelated
    mechanisms and states a bound the data does not respect. This is recorded
    here, in FIX-PLAN-8-13.md, and in the variant deposit's `caveats`. Do not
    treat it as handled because a corrected variant exists.
    ############################################################################

THE HEADLINE RESULT OF THE WHOLE FIGURE, and the one my first pass omitted entirely.
A per-camera tracker can score well within a view and still have no idea that
camera 0's animal 1 is camera 3's animal 1. This panel measures exactly that: the
same sessions scored within view, then across views.

LUC3D 0.749 -> 0.749 (x1.00): no drift at all, because cross-view identity is what
it solves. SLEAP 0.206 -> 0.062 (x0.30) and ByteTrack 0.157 -> 0.046 (x0.29) lose
half to three-quarters of their score, because nothing in a per-camera tracker links
views. 3D-MuPPET is flat but at 0.011 -- and on the variant that flatness is withdrawn as
evidence of anything, because at a median coverage of 1.31% there is almost nothing for it
to be flat over (see "3D-MuPPET" below). Height and flatness have to be read together, and
both have to be read against how much of the corpus the series covers.

THOSE SLEAP NUMBERS ARE THE CORRECTED ONES AND THEY ARE ONLY ON THE VARIANT. `--variant`
reads a deposit in which SLEAP is the ALL-TRACKS baseline (0.206 -> 0.062); the default panel
still reads `fig3_trackers.json`, where the same series is 0.115 -> 0.062 and INVALID. See
"THE SLEAP SERIES" below -- that difference is a correction, not a variant, and it is the
only number on this panel that changes meaning depending on the flag.

THE RULE AT 0.20 HAS NOW BEEN WRONG TWICE, IN OPPOSITE DIRECTIONS, and the current
finding is that it is neither of the things it has been called. The history is kept
because it is the same mistake twice -- asserting a level without asking what scoring
convention produced it -- and the third section below ("THE 1/C RULE DOES NOT SURVIVE")
is the version that is measured rather than argued.

  reading 1 (deleted)     "THE CHANCE LINE ... every per-camera tracker's cross-view
                          score sits BELOW chance". Contradicted the deposit's own
                          caveat, and chance is set by the ANIMAL count, not the
                          camera count.
  reading 2 (below)       a CEILING a per-camera tracker cannot exceed. True only
                          under camera-scoped pooling, and not strict even then.
  current                 a scoring CONVENTION's typical level, drawn as a reference.
                          The variant's artwork says that; 7a still says "ceiling".

Reading 2's argument, kept because it is what the deposit's caveat says and it is right
about the mechanism even though "ceiling" overstates it. `caveats`:

    "Cross-view IDF1 is bounded near 1/C for any tracker with no cross-view
     association mechanism (0.20 at C=5, 0.167 at C=6). At C=5 the per-camera
     trackers land far BELOW that bound ... so the bound is a ceiling on what they
     could achieve, not a level they reach."

WHAT THE RULE ACTUALLY IS. Cross-view IDF1 pools all C cameras into one accumulator
with one global identity per animal. A tracker that labels each camera independently
can have its labelling matched to the truth in at most ONE camera; the other C - 1
cameras carry labels that cannot simultaneously be right. So 1/C = 0.20 is the BEST
such a tracker could score -- an upper bound it fails to reach, not a coin-flip
baseline. CHANCE, by contrast, is set by the number of ANIMALS: with 2 mice, guessing
the cross-view assignment is right about half the time, so a chance level would sit
near 0.5, far ABOVE where SLEAP and ByteTrack land. Both facts are printed at the
rule, because a reader who takes 0.20 for chance draws a WEAKER conclusion than the
data supports: the per-camera trackers' MEANS are below it either way.

THE 1/C RULE DOES NOT SURVIVE THE CORRECTION AS A CEILING, and saying so is a change to
this panel's argument, not a refinement of it. Two independent reasons, both measured:

* IT IS A PROPERTY OF THE SCORING CONVENTION, measured both ways on the same 50 sessions
  and the same files. 1/C follows only if a per-camera tracker's ids are CAMERA-SCOPED when
  the cameras are pooled, so each GT animal can claim a hypothesis id in one camera and no
  more. `bmimica_eval_crossview_all.py` scopes them (`ci*10 + slot`);
  `figs/fig7_sleap_retracked.py` did not, pooling the track NAME so the same name in five
  cameras is one identity. `figs/fig7_sleap_scoped.py` scored both: SLEAP's corrected
  cross-view mean is 0.0617 camera-scoped and 0.0836 unscoped, a 36% difference produced by
  nothing but the id convention. Under the unscoped convention 1/C bounds nothing at all --
  the audit measured shared numbering reaching 0.6227 on a single session, 3.1x the "ceiling"
  (`figs/out/ITEM6-BASELINE-AUDIT.md` section 4).
* IT IS NOT STRICT EVEN WHEN SCOPED. IDF1 = 2*IDTP/(N_gt + N_pred) is not a coverage
  fraction: a tracker whose predictions are sparse or unevenly spread shrinks N_pred while
  IDTP concentrates, so the pooled score can exceed 1/C. Camera-scoped per-session values of
  0.2022 and 0.2151 are measured in the audit (on the truncated two-track reference, first
  20,000 frames). NOT on the corrected all-tracks series: its camera-scoped per-session
  maximum is 0.1643, so nothing in the plotted data crosses the rule. The non-strictness is
  real but belongs to the other source, and the panel says only what its own series shows.

So the rule may be drawn as a REFERENCE LEVEL, labelled convention-dependent, or not drawn
at all -- but not as a bound. The invalid top-2-track series sat so far below it that the
distinction never came up.

THIS PANEL'S "WITHIN VIEW" IS NOT PANEL c'S. Both are called within-view IDF1 and
they are different quantities: 0.749 here is BMimica, 50 sessions, C = 5, while c is
SLAP-2M, 74 sessions, C = 6, where LUC3D's within-view mean is 0.736 and its median
0.900. Nothing about the two numbers announces the difference -- 0.749 and 0.736 look
like the same measurement rounded twice -- so the corpus is named in this panel's
footer AND the pointer `b-f: SLAP-2M` rides on its last line, with the mirror note on
c. See the footnote comment for why it goes there rather than on a fourth line.

Every mean now carries its deposited 95% CI (`ci95_lo`/`ci95_hi`, bootstrap over
sessions) at both ends of its slope; the panel previously plotted bare means, so a
reader could not see that LUC3D's two intervals coincide (the no-drift result).

FOUR TRACKERS HERE, THREE IN b-g, AND THE KEY SAYS WHY. 3D-MuPPET is measured on
BMimica only; the SLAP-2M deposit has no 3D-MuPPET column anywhere. The tracker sets
genuinely differ between the two corpora, but a reader who is not told that reads the
missing fourth series as a dropped comparison -- so its key entry carries
"· BMimica only", right where the question comes up.

THE SLEAP SERIES: `--variant` CARRIES A CORRECTION, NOT A VARIANT, AND IT IS THE ONE
DIFFERENCE HERE THAT IS ABOUT THE COMPETITOR RATHER THAN ABOUT US.

Fig 7a's BMimica SLEAP numbers -- 0.115 within, 0.062 cross, out of
`bmimica_crossview_all_eval.csv`'s `sleap_idf1` -- ARE scored from SLEAP's own tracker, and
the earlier claim in this docstring that they came from a detections-only pool's unstable
slot index was WRONG. They are scored from `outputs/bmimica/sleap_h5/`, which
`scripts/bartul/bmimica_build_sleap_ref.py` builds from the retracked `.slp` files by
sleap-nn's own track id -- and truncates to the first TWO tracks:

    sleap = np.full((F, N_ANIMALS, N_NODES, 2), np.nan)   # N_ANIMALS = 2
    ...
        if ti is not None and ti < N_ANIMALS:              # track >= 2 SILENTLY DROPPED

The retracked files hold a median of 47 tracks per camera-session. Counted on two of them:
17-188 tracks per file, and the share of tracked instances surviving `ti < 2` is 84.5 /
11.7 / 0.0 / 24.9 / 11.1% across one session's five cameras and 1.1 / 2.8 / 6.1 / 1.1 /
7.1% across another's. So the plotted series is a top-two-track FRAGMENT of SLEAP's output
scored as though it were all of it. The 856 `switches_2d_total` in the deposit is invalid
for the same reason.

`figs/fig7_sleap_retracked.py` scores the 250 `.slp` files DIRECTLY -- every track, no
fixed-width intermediate to overflow -- with the same IoU >= 0.5 matching and the same
motmetrics construction, and `figs/fig7_variant_tracker.py --fix-sleap` installs the result
here. Over all 50 sessions:

    within-view IDF1   0.1154 -> 0.2062  (median 0.0976 -> 0.1882)   x1.79
    cross-view IDF1    0.0616 -> 0.0617  (median 0.0452 -> 0.0519)   x1.00  camera-scoped
    within-view ID switches  856 -> 31,606      fragmentations 1,111,431

HALF THE CORRECTION IS REAL AND THE OTHER HALF WAS A SCORING CONVENTION. The first pass
(`fig7_sleap_retracked.py`) reported cross-view 0.0836, a 1.4x "correction", by pooling the
five cameras with the track NAME as the hypothesis id -- UNSCOPED, so `track_3` in two
cameras counts as one identity. `scripts/bartul/bmimica_eval_crossview_all.py`, which
produced every other number on this panel, CAMERA-SCOPES its per-camera baselines
(`ci*10 + slot` for SLEAP, `ci*100000 + tid` for ByteTrack) and uses global ids only for
LUC3D and 3D-MuPPET, which actually have cross-view identity. Unscoped pooling can only ADD
cross-view matches that scoped pooling refuses, never remove one, so it is an upper bound
rather than an alternative.

`figs/fig7_sleap_scoped.py` measured both conventions in one pass over the same files, gated
on reproducing the first pass's numbers EXACTLY (max |diff| 0.000e+00 on all 50 sessions for
within-view IDF1, unscoped cross-view IDF1 and switch counts, so the two passes differ in the
pooling id and in nothing else). Camera-scoped, like for like against Fig 7a:

    cross-view IDF1    0.0616 -> 0.0617      x1.00      (unscoped: 0.0836, x1.36)

SO THE HONEST FINDING IS SPLIT. The within-view correction is real and large: 1.79x, and it
stands under any convention because within-view scoring does not pool. The cross-view figure
Fig 7a prints was approximately RIGHT, and right for the wrong reason -- it was computed on a
two-track fragment, but a per-camera tracker pooled camera-scoped scores about the same
whether it has 2 tracks or 47, because scoping is what limits it either way. Had the
unscoped 0.0836 been shipped, the panel would have claimed a 1.4x cross-view correction of
which every part was the convention -- a correction that flattered us against a competitor,
which is worse than the defect it was fixing.

THE COHERENCE GATE IS NOT THE DIAGNOSIS. The tracks are coherent (mean per-track p95
frame-to-frame centroid jump 4.8 px) and always were; the 498 px / 8.78% incoherence that
the first diagnosis rested on was measured on the DETECTION pool, which is not what this
series was scored from. `--fix-sleap` still applies that gate -- a series measured from
incoherent tracks would be refused -- but it is not why the old number was wrong.

AND THE HONEST HALF OF THE RESULT. The correction was expected to lift BMimica's SLEAP into
the regime of SLAP-2M's tracked SLEAP (0.661). It does not, and it cannot: SLAP-2M's pool is
indexed BY SLEAP's own tracks, so SLEAP's fragmentation costs it nothing there, whereas on
BMimica an all-tracks SLEAP is spread over a median 47 tracks -- 1,111,431 fragmentations --
whose top-2-id arithmetic ceiling is a session mean of 0.2702. The measured 0.2062 sits just
under that ceiling, which is the consistent answer rather than a disappointing one. SLEAP is
genuinely weak on BMimica: the manuscript's qualitative claim survives and only the
magnitude was overstated. LUC3D is still ahead in 50/50 sessions on both metrics against the
corrected series, recomputed per session.

The erroneous numbers are NOT deleted: `fig7_variant_best.json` keeps them under
`SLEAP per-camera (2-track truncation, invalid)`, with their win counts, so the number the
manuscript currently prints stays traceable. `fig3_trackers.json` is untouched, which is
why the default render of this panel still shows 0.115 -> 0.062: fixing the MANUSCRIPT
figure means regenerating that deposit, which is a separate decision from rendering a
corrected variant.

3D-MuPPET: THE SECOND INVALID SERIES, AND IT FAILS FOR AN UNRELATED REASON. 0.0112 /
0.0112 is a COVERAGE number. `scripts/bartul/muppet_run.py` builds `global_by_track` once,
at the init frame, mapping SORT track id -> global id per camera, while SORT runs with
`max_age = 10`; the first time a tracklet dies its successor id is in no map, that camera
emits nothing further, and within a few thousand frames every camera has gone silent.
Frames absent from the result JSON are scored as MISSES, not skipped, so the denominator is
the whole session.

Measured over all 50 result JSONs (independently re-counted here, not taken from the
audit): assignments cover 0.17% to 7.22% of a session, median **1.31%**, and the emitted
frame indices are a CONTIGUOUS PREFIX from frame 0 in **all 50** sessions -- the tracker
dies, it does not sample sparsely. So ~98.7% of 0.011 is denominator. Scored only on the
frames it does label, it gets within-view 0.21-0.67 and cross-view 0.25-0.70 (4 sessions,
first 20,000 frames; `figs/out/ITEM6-BASELINE-AUDIT.md` section 3), and its identities are
coherent where present (p95 3.4 px). "3D-MuPPET IDF1 0.011" therefore compares a coverage
collapse against three trackers that predict on every frame.

WHAT THE VARIANT DOES ABOUT IT, and why not the other two options. The series is DRAWN,
dotted with hollow markers, with its coverage stated in the key from the deposit's measured
value. It is not SWAPPED for the conditional score, because that has a different
denominator and would sit on the same axis as four full-session series -- the same category
error being corrected -- and because it exists for 4 sessions, not 50. It is not DROPPED,
because removing a competitor silently is worse than labelling one, and an absence cannot
be audited. The coverage-conditional numbers are quoted in this docstring and in the
deposit's `invalid_reason`, with their n and their source.

`--variant` REPLACES THE LUC3D SERIES with a tracker that is not in the app, and it is a
different panel. `figs/fig8-bench/xv_experimental.js` with method `{sync: true, stale: 20}`
and `distanceThreshold = 25` -- the fresh-anchor configuration Fig 8d found -- scores within
0.861 / cross 0.861 on these same 50 sessions against the shipped tracker's 0.749 / 0.749,
with 413 within-view ID switches against 2,071, and it is ahead of the shipped tracker in
38/50 sessions within view and 38/50 cross view. It REPLACES rather than joins LUC3D
(2026-08-13, on instruction): two LUC3D lines on one panel force the reader to work out
which one is the app, which is worse than one clearly-labelled line. The shipped
measurement is preserved in the deposit under `LUC3D (shipped)` and is what the "against
the shipped tracker's ..." annotation reads. That is a large result and it is
NOT a manuscript result: the code is not in `pose/cross-view-tracker.js`, so Figure 7a
must not show it. Hence the flag, and hence three separate defences:

* the variant writes a DIFFERENT SLUG, `fig7a_within_vs_cross_variant.pdf`, so it cannot
  overwrite the manuscript panel `fig7a_within_vs_cross.pdf` whatever letter it carries.
  It is lettered "a" (not "h", as an earlier version was; those `fig7h_*` artefacts have
  been deleted and the deposited CSV was renamed to match this panel's letter) because
  `assemble.py`'s `LAYOUTS[7]` now PLACES this panel in position a: the assembled
  `figures/fig7/fig7.pdf` shows the variant, titled "... (+ experimental arm)", and a
  panel lettered h sitting in the first slot would read as a mistake. Swapping the slug
  back in `LAYOUTS[7]` restores the manuscript panel;
* it reads `fig7_variant_best.json`, a separate deposit whose own `generated_by`
  says "NOT the manuscript deposit" and whose `caveats` carry the provenance of the
  extra arm. The default path still reads `fig3_trackers.json` and is unchanged, which
  is checked by re-rendering without the flag;
* the extra series is labelled EXPERIMENTAL on the artwork -- on its own key line, in
  the data area next to its switch count, and in the footnote -- because a panel that
  reads as Fig 7a with one more tracker on it WILL be screenshotted out of context.

Only BMimica carries the arm. It has never been run on SLAP-2M, so b-g cannot be
redrawn from that file, and SLAP-2M is a different regime anyway (the detector misses
35.4% of GT there; the identity-fix ceiling is 0.7704 against BMimica's 0.9367). No
extrapolation from this panel to the rest of the figure is licensed.

Source: figs/out/fig3_trackers.json `bmimica_50_sessions`, `bmimica_wins`, `caveats`;
with `--variant`, figs/out/fig7_variant_best.json (same schema; the experimental arm in
the LUC3D slot, the corrected SLEAP series, 3D-MuPPET's measured coverage, and both
originals preserved beside them). That deposit is built by
`figs/fig7_variant_tracker.py --replace --fix-sleap --muppet-coverage`, which reads the
SLEAP measurement from `figs/out/fig7_sleap_scoped.json`
(`figs/fig7_sleap_scoped.py`: both pooling conventions, gated on reproducing
`fig7_sleap_retracked.json` exactly).

    python3 figs/panels/fig7_05_within_vs_cross.py            # 7a, the manuscript panel
    python3 figs/panels/fig7_05_within_vs_cross.py --variant  # the experimental arm and
                                                             # the corrected SLEAP series
"""
import sys
from pathlib import Path

import pandas as pd

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import (AMBER, MUTED, entity, footnote, deposit, panel,  # noqa: E402
                       save, text_legend, use)

#: (deposit key, name on the artwork, colour). The deposit calls SLEAP's entry
#: "SLEAP per-camera"; the artwork says "SLEAP" so the name matches panels b-f --
#: the figure used to call the same tracker two different things -- and the
#: per-camera-ness is carried at the 0.20 rule instead, which is the one place it is
#: load-bearing: the rule is the ceiling *because* SLEAP and ByteTrack label each
#: camera on its own, and both names are printed there.
#:
#: COLOURS COME FROM `entity()`, not from a hue picked here. All four series are
#: recurring ENTITIES -- LUC3D, SLEAP and ByteTrack appear in five of this figure's
#: seven panels and in Figs 3-5 as well -- so their hues are reserved set-wide and
#: `entity()` is the only place that mapping lives. Hard-coding TEAL/PERIWINKLE here
#: is how periwinkle came to mean DLT in Fig 4 and SLEAP in Fig 7 (review finding C3).
#: The hues are unchanged by the switch; what changes is that they can no longer
#: drift apart panel by panel.
ORDER = [("LUC3D", "LUC3D", entity("luc3d")),
         ("SLEAP per-camera", "SLEAP", entity("sleap")),
         ("ByteTrack", "ByteTrack", entity("bytetrack")),
         ("3D-MuPPET", "3D-MuPPET", entity("3d-muppet"))]

#: WHY THIS PANEL HAS FOUR SERIES AND b-g HAVE THREE, said next to the series that is
#: only here. 3D-MuPPET is measured on BMimica alone: `fig3_trackers.json` lists it
#: under `bmimica_50_sessions` and nowhere under `slap2m`, whose `within_view`,
#: `error_decomposition` and paired tables carry luc3d/sleap/bytetrack only. Read with
#: the figure footer ("a: 50 BMimica sessions ... b-g: 74 SLAP-2M sessions") that is a
#: complete answer to "where did the fourth tracker go", and it rides in the key band
#: `panel(key=...)` has already reserved, so it costs no axes height -- see the
#: footnote comment below for what a fourth footnote line would have cost instead.
#: Entry measures 65.6 mm from the key's x = 12.3 mm, i.e. 77.9 of 88 mm.
CORPUS_NOTE = {"3D-MuPPET": "· BMimica only"}
NCAM = 5

#: `--variant` ONLY. The deposit, and the tracker key inside it that names the arm on
#: the artwork. The key is the deposit's own spelling, so a rename upstream fails on the
#: `bm[VARIANT_KEY]` lookup rather than silently dropping the series (the `if key not in
#: bm: continue` guard in the loop would swallow it).
VARIANT_SRC = "fig7_variant_best.json"
#: THE BASELINES AT THEIR BEST HONEST CONFIGURATION (2026-08-14, on instruction).
#: Built by `figs/fig7_fair_baselines.py` from the two re-runs:
#:   SLEAP     sleap-nn with `--max_tracks 2 --candidates_method local_queues`
#:             -- the shipped baseline passed `--tracking_target_instance_count 2`,
#:             which caps instances PER FRAME and left a median 47.5 tracks per
#:             camera-session. Cap verified at exactly 2 on all 250.
#:   ByteTrack `lost_track_buffer = n_frames` (never retire) + a tracklet-whole
#:             2-identity stitch that uses NO ground truth -- the shipped run
#:             retired a lost track after 60 frames on 180,200-frame sessions.
#: Both moved sharply UP within view (0.206 -> 0.642 and 0.157 -> 0.676) and their
#: within->cross RETENTION got slightly WORSE (0.23 each, against LUC3D's 1.00),
#: which is the quantity this panel claims. Drawn by default on the variant render;
#: `--handicapped` restores the arms as previously configured.
FAIR_SRC = "fig7_fair_baselines.json"
FAIR_MAP = {"SLEAP per-camera": "SLEAP per-camera (2 tracks enforced)",
            "ByteTrack": "ByteTrack (2 identities, B1s)"}
VARIANT_KEY = "LUC3D + fresh anchor"

#: The deposit's SLEAP keys. `SLEAP_INVALID_KEY` is written ONLY by
#: `fig7_variant_tracker.py --fix-sleap`, which moves the old slot-index series there and
#: puts the tracked baseline in `SLEAP_KEY`. So its presence is the panel's test for
#: "this deposit's SLEAP series is the corrected one" -- the correction note is drawn only
#: then, because a `--variant` deposit built WITHOUT `--fix-sleap` still holds the invalid
#: numbers and must not be annotated as though it did not.
SLEAP_KEY = "SLEAP per-camera"
SLEAP_INVALID_KEY = "SLEAP per-camera (2-track truncation, invalid)"

#: AMBER, AND NOT THROUGH `entity()`. Every hue `entity()` hands out is already spoken
#: for on this panel or set-wide: TEAL is this work (LUC3D), PERIWINKLE SLEAP, SALMON
#: ByteTrack, PINK 3D-MuPPET, GREY the 1/C ceiling, GREEN Anipose. `#DF9C20` is one of
#: the two `fig2b` accents the palette reserves for nothing, it is the farthest hue from
#: all four series here, and it is the DARKEST of them (2.4:1 on white against teal's
#: 2.1:1), which matters because this label carries the word a reader must not miss.
#: SKY (`#93C9DE`) was the other candidate and is rejected: pale blue against
#: PERIWINKLE's blue-violet is exactly the pair that stops being separable at print
#: size, and it is the lightest ink in the module.
#:
#: DELIBERATELY NOT ADDED TO `ENTITY`. That table reserves hues for entities that RECUR
#: across the set, and the whole point of this series is that it recurs nowhere -- it is
#: in one opt-in panel and in no shipped figure. Minting a set-wide reservation for it
#: would be a promise the set does not keep, and editing `style.py` would put every
#: other panel's colours in the blast radius of a variant render. The rule the ENTITY
#: comment actually forbids is one hue meaning two different things on facing pages;
#: amber means nothing anywhere else, so there is nothing to collide with.
VARIANT_COLOR = AMBER

#: Its own key line, NOT a suffix on the series entry, because the entry has no room:
#: at bold 8 pt the four existing entries reach 77.9 of 88 mm (see CORPUS_NOTE), and
#: `LUC3D + fresh anchor  0.850 → 0.850 ×1.00` is already 61 mm of the 75.7 mm the
#: key has from its x = 12.3 mm anchor. Appending the warning would push it ~34 mm off
#: the page, and the renderer drops the overhang WITHOUT COMPLAINT (it is `lint_text.py`
#: `truncated()`, not matplotlib, that would have told me). A short line of its own in
#: the same amber reads as part of the same entry and measures 57 mm.
VARIANT_NOTE = "· experimental: NOT in the shipped app"

#: `--variant` ONLY, and the on-artwork half of the SLEAP correction. The variant plots
#: SLEAP at 0.206 -> 0.084 where Fig 7a plots the SAME SERIES at 0.115 -> 0.062, and a
#: reader who meets the two panels without being told will take one of them for a typo.
#: So the panel says which is which, in SLEAP's own periwinkle, directly under its entry.
#: TWO LINES because one cannot carry both facts inside the key's width: at bold 8 pt the
#: key has 75.7 mm from its x = 12.3 mm anchor and measures ~1.49 mm/char (see
#: VARIANT_NOTE), so ~50 characters is the ceiling and these are 42 and 44. The numbers
#: are NOT repeated here -- the entry above already prints them, and `lint_text.py`
#: `truncated()` is what catches an overhang if this is ever extended.
#: REWRITTEN 2026-08-14 with the fair-baseline substitution. It used to say "ALL
#: sleap-nn tracks, median 47/camera", which described the arm plotted BEFORE the
#: re-run -- the uncapped one. The plotted series is now the 2-track-enforced run, so
#: the old note made a false statement about the line beside it, which is the exact
#: defect this panel exists to correct. `--handicapped` restores the old arms and,
#: with them, would need the old note; the flag is documented but the note is not
#: switched, because that render is for provenance rather than for print.
SLEAP_FIX_NOTE = ("· SLEAP: re-run with 2 tracks enforced (--max_tracks 2)",
                  "  Fig 7a's 0.115 capped the SLOTS, not the tracks")
#: The ByteTrack arm is ByteTrack PLUS post-processing of ours, and the artwork has to
#: say so: its own knob alone (never-retire) reaches 0.272, and the 0.676 drawn here
#: needs a 2-identity constraint we wrote. Claiming 0.676 as plain ByteTrack would
#: overstate the baseline; hiding the stitch would understate it.
BYTE_FAIR_NOTE = ("· ByteTrack: never-retire + a 2-identity constraint",
                  "  its own knob alone reaches 0.272")

#: `--variant` ONLY. 3D-MuPPET's series is the SECOND invalid one on this panel and it fails
#: in an unrelated way: 0.011 is a COVERAGE number. `muppet_run.py` maps SORT ids to global
#: ids once at the init frame with `max_age = 10`, so each camera falls silent for good the
#: first time a tracklet dies; assignments cover a median 1.31% of a session (measured on all
#: 50 result JSONs, a contiguous prefix from frame 0 in every one), and every unlabelled
#: frame is scored as a miss. So ~98.7% of that number is denominator.
#:
#: THE SERIES IS DRAWN, NOT DROPPED, AND NOT SWAPPED. Three options existed and the reasons
#: pick this one:
#:   * substituting the coverage-CONDITIONAL score (within 0.21-0.67) would put a different
#:     denominator on the same axis as four full-session series, which is the very error
#:     being corrected -- and that number exists for 4 sessions, not 50;
#:   * dropping the series would silently remove a competitor from a panel that compares
#:     competitors, and a reader cannot audit an absence;
#:   * so it stays, drawn DOTTED with hollow markers (the set's idiom for "not comparable"),
#:     with the coverage stated in the key. A reader sees a mark, sees it is not a solid
#:     series, and reads why on the next line.
#: The coverage figure comes from the DEPOSIT (`--muppet-coverage` measures and deposits it),
#: not from this comment, so the artwork cannot drift from the measurement. The conditional
#: range is quoted from `figs/out/ITEM6-BASELINE-AUDIT.md` section 3 with its n, because
#: re-measuring it is a separate pass and an unattributed number would be worse than a
#: cited one.
#: TWO lines, not three: the key band costs 2.70 mm per line out of the same panel the
#: slopes are drawn in, and at nine lines the plot is already down to ~20 mm.
MUPPET_KEY = "3D-MuPPET"
MUPPET_NOTE = ("· 3D-MuPPET: 0.011 is COVERAGE — {cov:.1%} of frames",
               "  on the frames it labels: 0.21–0.67 (4 sessions)")

#: Panel height in mm, DECLARED rather than taken from `ROW_H["std"]` (52 mm). Every
#: panel in this figure was 52 mm and none of them needed it: measured on the 300 dpi
#: render, this panel's ink spanned 50.0 of 52.1 mm and the page came to 196.3 mm --
#: 19.3% of its scanlines carrying no ink at all (review findings 6.12 / C9). At 47 mm
#: the ink is the same ink: nothing is resized, no type is touched, the axes simply
#: stops being taller than its content. A row is as tall as its TALLEST panel, so this
#: only pays if its row-mate (7b) comes down with it, which it does.
#: 50.0, not 47/48. Fig 7 was already UNDER the 200 mm ceiling, and these
#: panels' ink spans ~50 of 52 mm -- so trimming below 50 buys page height by
#: SHORTENING THE AXES, not by removing blank. Most composite "blank" is the
#: inter-row structure that carries the panel letters and titles (see the
#: whitespace note in figs/README.md), so shrinking data plots to chase that
#: metric is a bad trade. 50 mm is the strictly bbox-preserving floor.
ROW_H = 50.0

#: `--variant` ONLY, and it is allowed to be taller because it has more key to carry: the
#: variant's key is NINE lines rather than four -- four series, the EXPERIMENTAL note, the
#: two-line SLEAP-correction note and the two-line 3D-MuPPET coverage note -- and
#: `panel(key=n)` charges 0.052 of the figure height per line. At 50 mm that band would take
#: 47% of the panel and leave the slopes ~8 mm of plot, at which point the two-line 1/C
#: annotation and the data are fighting over the same millimetres. 70 mm buys the five extra
#: key lines back (62 mm did it for five lines, 66 for seven) and nothing else changes: no
#: type is resized and no mark moves.
#:
#: IT DOES COST PAGE HEIGHT, and the earlier note here ("7h SHARES A ROW WITH NOTHING --
#: it is assembled nowhere") is no longer true: `assemble.py`'s `LAYOUTS[7]` places this
#: panel in position a, beside 7b, and a row is as tall as its tallest panel. This panel
#: IS that tallest panel, so the assembled `fig7.pdf` grows millimetre for millimetre with
#: this constant -- 187.0 mm at 62 mm and 195.0 mm at 70 mm, against the 200 mm page
#: ceiling. Both measured on the assembled PDF after the change, not assumed; re-check it
#: with `assemble.py 7` after touching this number. Anything past ~74 mm breaches it.
ROW_H_VARIANT = 70.0


def key_dy(h):
    """Key line spacing in FIGURE units that is 2.70 mm at ANY panel height.

    `text_legend`'s "above" branch hard-codes `dy = 0.052` in FIGURE coordinates, i.e.
    2.70 mm at the 52 mm height it was tuned for and 2.44 mm at 47 mm -- and 8 pt type
    sets a ~3.24 mm span box, so at the shorter height the four key lines would overlap
    by 25% of a box and `lint_text.py` would (correctly) fail. Passing `dy` and an
    explicit `transform` keeps the ABSOLUTE line spacing at 2.70 mm, so the key reads
    exactly as it did at 52 mm. This is the documented way to override that branch: it
    is skipped when `transform` is not None, and `xy` then supplies the anchor the
    branch would have set.

    A FUNCTION rather than the module constant `KEY_DY` it used to be, because the
    variant is a different height and the same 2.70 mm has to come out of both. The
    expression is the constant's, unchanged, so `key_dy(ROW_H)` is the number the
    manuscript panel has always passed -- verified: 7a re-renders byte-identical.
    """
    return 0.052 * 52.0 / h


def main(variant=False, fair=True):
    use()
    t = load(VARIANT_SRC if variant else "fig3_trackers.json")
    bm = t["bmimica_50_sessions"]
    # THE BASELINE SUBSTITUTION. `bm` is a dict of arms keyed by name, so the fair
    # arms drop straight in under the SAME keys the rest of this panel reads -- the
    # series, the key lines, the value labels and the win counts all follow without a
    # second code path. The replaced arms are kept under their own names so a footnote
    # can quote what they used to read, which is the whole point of showing this.
    fair_note = None
    if variant and fair:
        fb = load(FAIR_SRC)["arms"]
        for key, fair_key in FAIR_MAP.items():
            if key in bm and fair_key in fb:
                bm[key + " (as previously configured)"] = bm[key]
                bm[key] = {**bm[key], **{k: v for k, v in fb[fair_key].items()
                                         if k in ("within", "cross",
                                                  "per_session_within",
                                                  "per_session_cross",
                                                  "switches_2d_total")}}
        fair_note = fb
    wins = t["bmimica_wins"]
    # The extra arm goes LAST so the shipped tracker keeps the top line of the key and
    # the reading order of the manuscript panel is preserved: what a reader compares the
    # experimental series against is the series directly above it.
    # REPLACEMENT, not addition (2026-08-13, on instruction): the variant deposit puts the
    # improved tracker INTO the `LUC3D` slot, so every series here picks it up and there is
    # exactly one LUC3D line -- two would force the reader to work out which one is the app.
    # The name on the artwork becomes "LUC3D (fresh anchor)" and the colour becomes AMBER,
    # because a bare "LUC3D" in teal would present an EXPERIMENTAL tracker as the shipped
    # one, which is the single thing this panel must never do. If the deposit still carries
    # a separate `LUC3D + fresh anchor` key (the older additive layout) that is drawn
    # instead, so both deposit shapes render.
    vkey = VARIANT_KEY if VARIANT_KEY in t["bmimica_50_sessions"] else "LUC3D"
    skey = "LUC3D (shipped)" if "LUC3D (shipped)" in t["bmimica_50_sessions"] else "LUC3D"
    if not variant:
        order = ORDER
    elif VARIANT_KEY in t["bmimica_50_sessions"]:
        order = ORDER + [(VARIANT_KEY, VARIANT_KEY, VARIANT_COLOR)]
    else:
        order = [(("LUC3D", "LUC3D (fresh anchor)", col) if k == "LUC3D"
                  else (k, nm, col)) for k, nm, col in ORDER]
    height = ROW_H_VARIANT if variant else ROW_H
    # Whether this deposit's SLEAP series is the CORRECTED one. See SLEAP_INVALID_KEY:
    # the note below is a claim about provenance, so it is drawn from evidence in the
    # deposit rather than from the flag that selected the deposit.
    sleap_fixed = variant and SLEAP_INVALID_KEY in bm
    # Same rule for 3D-MuPPET: the coverage note is drawn only when the deposit carries a
    # MEASURED coverage figure (`--muppet-coverage`), never from a number typed here.
    muppet_cov = (bm.get(MUPPET_KEY, {}).get("coverage") or {}).get("median") \
        if variant else None
    rows, entries = [], []
    # THE VALUE LABELS LIVE IN THE KEY BAND, not beside their own lines. They were
    # annotated at x = 1.05 with `annotation_clip=False`, which constrained_layout
    # DOES account for -- so the four labels squeezed the axes into the left half of
    # the panel (measured: axes 44.5 of 88 mm) and pulled the centred x-axis footer
    # left with it until its leading characters fell off the page. In the band the
    # plot keeps its full width and the footer is centred on a full-width axis.
    # Key lines: one per series, plus the EXPERIMENTAL note, plus the two-line SLEAP
    # correction note when the deposit carries the corrected series. `panel(key=n)`
    # reserves the band, so an undercount here would let the top key line sit on the plot.
    fig, ax = panel("half", height,
                    key=len(order) + (1 if variant else 0) + (2 if sleap_fixed else 0)
                    + (len(MUPPET_NOTE) if muppet_cov else 0))
    for rank, (key, name, color) in enumerate(order):
        if key not in bm:
            continue
        wv, cv = bm[key]["within"], bm[key]["cross"]
        w, c = wv["mean"], cv["mean"]
        rows.append({"tracker": name, "within": w,
                     "within_ci95_lo": wv["ci95_lo"], "within_ci95_hi": wv["ci95_hi"],
                     "cross": c,
                     "cross_ci95_lo": cv["ci95_lo"], "cross_ci95_hi": cv["ci95_hi"],
                     "ratio": c / w if w else float("nan"),
                     "n_sessions": wv["n_sessions"]})
        # DOTTED AND HOLLOW = "measured, but not on the same footing". Only 3D-MuPPET, only
        # in the variant, and only when the deposit carries the coverage that justifies it:
        # its 0.011 is ~98.7% denominator (see MUPPET_NOTE), so drawing it as a solid series
        # beside four full-session scores would assert a comparison the data does not support.
        # The mark stays, because a reader cannot audit a series that was quietly removed.
        limited = bool(muppet_cov) and key == MUPPET_KEY
        ax.plot([0, 1], [w, c], color=color, lw=2.0 if not limited else 1.4,
                ls="-" if not limited else (0, (1.4, 1.4)), zorder=3)
        # errorbar, and ms=3.2 rather than 5: LUC3D's interval is +-0.04, which a
        # 5 pt marker covers completely -- the whiskers were drawn and invisible.
        # Caps make a +-0.04 interval readable at a plot height of ~25 mm.
        for x, s in ((0, wv), (1, cv)):
            ax.errorbar([x], [s["mean"]],
                        yerr=[[s["mean"] - s["ci95_lo"]], [s["ci95_hi"] - s["mean"]]],
                        fmt="o", color=color, ms=3.2,
                        # Hollow marker on the coverage-limited series: white fill, its own
                        # hue as the edge, so it reads as the same series drawn differently
                        # rather than as a fifth colour.
                        mfc="white" if limited else color,
                        mec=color if limited else "white", mew=0.6,
                        elinewidth=1.0, capsize=1.8, capthick=1.0, zorder=5)
        entry = f"{name}  {w:.3f} → {c:.3f} ×{c / w:.2f}"
        if name in CORPUS_NOTE:
            entry += f"  {CORPUS_NOTE[name]}"
        entries.append((entry, color))
        # EACH NOTE DIRECTLY UNDER THE SERIES IT QUALIFIES, in that series' own hue, so it
        # reads as that entry's second line. They used to be appended after the loop, which
        # was right when the experimental arm was the LAST series and wrong once it took
        # over the FIRST line: a warning at the bottom of the key does not obviously belong
        # to the entry at the top. See VARIANT_NOTE / SLEAP_FIX_NOTE for why neither can
        # ride on the entry text itself (the key runs out of width at ~50 characters).
        if variant and key == vkey:
            entries.append((VARIANT_NOTE,
                            VARIANT_COLOR if vkey != "LUC3D" else entity("luc3d")))
        # THE PER-SERIES NOTES ARE GONE FROM THE KEY for the same reason as the
        # in-plot prose: nine lines of 6.5 pt caveat above a four-line plot is a
        # caption typeset on the artwork. Every one of them is now in the legend --
        # SLEAP's cap, ByteTrack's stitch, 3D-MuPPET's coverage denominator -- and
        # they are all claims a reader must still be given, so the legend entry is
        # not optional and FIGURE-LEGENDS.md carries them verbatim.
        if not variant:
            if sleap_fixed and key == SLEAP_KEY:
                entries.extend((line, color) for line in SLEAP_FIX_NOTE)
            if limited:
                entries.extend((line.format(cov=muppet_cov), color)
                               for line in MUPPET_NOTE)

    df = pd.DataFrame(rows)
    # THE TABLE CARRIES THE SAME PANEL LETTER AS THE ARTWORK. This deposited `fig7h_*`
    # while `save()` below writes `fig7a_within_vs_cross_variant.*`, left over from when the
    # variant was lettered h -- a figure whose artwork and data table disagree about which
    # panel they are is a trap for whoever reads the deposit later. The slug still says
    # `variant`, which is what keeps this from overwriting the manuscript panel's table.
    deposit(df, 7, "fig7a_within_vs_cross_variant.csv" if variant
            else "fig7a_within_vs_cross.csv")

    # The rule, and what it is. See the docstring: 1/C is the CEILING for a tracker
    # that labels each camera independently, and chance is set by the animal count.
    # Both are printed, because the two readings support different conclusions and
    # the deposit's own caveat picks the ceiling one.
    # entity("ceiling") -- the same GREY every bound in the set is drawn in (Fig 5's
    # oracle, Fig 4's random baseline). A bound is not a method and must not borrow a
    # method's hue.
    ax.axhline(1 / NCAM, color=entity("ceiling"), lw=0.8, ls=(0, (2.5, 1.5)),
               zorder=1)
    # Anchored at the axes' left edge (x = -0.13), not at x = 0, so the two lines fit
    # inside the plot without running under the tracker values.
    #
    # THE VARIANT SAYS SOMETHING DIFFERENT HERE, and it is a retraction rather than a
    # rewording. "Ceiling" does not survive: 1/C follows only if a per-camera tracker's ids
    # are CAMERA-SCOPED when the cameras are pooled, and it is not strict even then, because
    # IDF1 shrinks its own denominator when a tracker predicts sparsely -- measured
    # per-session cross-view values of 0.2022, 0.2151 and 0.2237 all sit above it. So on the
    # variant the rule is labelled as the scoring convention it is. The manuscript panel
    # keeps the old wording ONLY because its deposit cannot be rewritten here: see the
    # three-defect notice at the top of this docstring. That is a defect awaiting a
    # regenerate decision, not a disagreement about what the rule means.
    if variant:
        rule = (f"1/C = {1 / NCAM:.2f}: where CAMERA-SCOPED pooling puts a per-camera\n"
                "tracker's cross-view score — a scoring CONVENTION, not a ceiling\n"
                # 59 characters. The first draft of this line was 74 and ran off the page,
                # where the renderer dropped it silently -- `lint_text.py` CLIPPED +
                # TRUNCATED caught it. Line 2 above is 64 and fits, so ~65 is the budget.
                # 0.600, not 0.084: with TWO ENFORCED TRACKS the unscoped convention
                # links `track_0` across all five cameras, so the artefact it would
                # produce is now four times larger than it was on the uncapped arm.
                # That is the whole reason this panel pools camera-scoped, and the
                # number has to move with the arm it describes.
                "(unscoped ids would give 0.600); chance ≈ 0.5 with 2 animals")
    else:
        rule = (f"1/C = {1 / NCAM:.2f}: ceiling for a per-camera tracker "
                "(SLEAP, ByteTrack)\n"
                "not a chance level — chance with 2 animals ≈ 0.5")
    # THE EMPTY BAND MOVED WHEN THE BASELINES DID (2026-08-14). This block sat just
    # above the 1/C rule because the per-camera trackers ran along the bottom of the
    # plot; fairly configured they start at ~0.65 and descend, so that region is now
    # THROUGH them (lint: three lines ON DATA, 8-9% inked). The space they vacated is
    # the bottom strip, under the descending lines and above 3D-MuPPET's flat 0.011 --
    # so the block now hangs BELOW the rule it describes rather than above it, which
    # is also the right side of the rule for a note about what sits under it.
    # THE PROSE IS OFF THE ARTWORK (review 2026-08-14: "I don't like all that text!
    # too much text on 7a it looks awful. we will describe that in the methods").
    # What a mark cannot say for itself stays -- the dashed rule is still drawn, the
    # series still carry their values in the key -- but the three-line explanation of
    # what 1/C is, and the switch counts, are caption and Methods material. They are
    # in FIGURE-LEGENDS.md. `--handicapped` keeps the old render for provenance.
    if not variant:
        ax.text(-0.13, 1 / NCAM + 0.015, rule,
                color=MUTED, fontsize=6.5, va="bottom", linespacing=1.4)

    # THE SWITCH COUNTS, IN THE DATA AREA, IN THE VARIANT ONLY. IDF1 alone understates
    # what the fresher anchor does -- 0.749 -> 0.850 is one number, 2,071 -> 511 ID
    # switches is the mechanism -- and this panel's whole subject is identity, so the
    # count belongs on it. It goes at y = 0.50, the one band of the plot no series
    # crosses (the per-camera trackers all sit under 0.16, LUC3D is flat at 0.749 and
    # the arm at 0.850), and in the arm's own amber so it is unambiguous which series it
    # describes -- `annotate_series`'s idiom. `lint_text.py`'s on-data check confirms
    # the band is empty: this text reports 0% of its box inked.
    # THE SWITCH COUNTS ARE CAPTION MATERIAL TOO (review 2026-08-14). They were the
    # last block of prose inside the axes and there is no longer an empty band for
    # them: fairly configured, the two baselines sweep from ~0.65 down through ~0.15
    # and cross every horizontal strip this note used to sit in. 413 against 2,071 is
    # a strong number and it belongs in the legend, not typeset over the data.

    text_legend(ax, entries, "above", dy=key_dy(height), xy=(0.14, 0.985),
                transform=fig.transFigure)
    ax.set_xlim(-0.15, 1.05)
    ax.set_xticks([0, 1])
    ax.set_xticklabels(["within view", "cross view"])
    ax.set_ylabel("IDF1")
    ax.set_ylim(0, 0.95)
    # Explicit: the shorter plot made matplotlib fall back to 0.0 / 0.5 alone, and
    # a reader cannot place the 0.20 rule against two ticks.
    ax.set_yticks([0, 0.2, 0.4, 0.6, 0.8])
    # "full" distinguishes these from Fig 3d's 6,000-frame leading windows over the
    # same corpus. `drift_abs_max` and the cross-view win counts are deposited and
    # were on the legacy panel; both had been dropped.
    drift = bm["LUC3D"]["drift_abs_max"]
    # THE EXPERIMENTAL ARM IS EXCLUDED FROM THIS MIN, and excluding it is the honest
    # choice rather than the flattering one. `bmimica_wins[k]` is LUC3D's win count
    # against tracker k, so the min over all k is "ahead of EVERY tracker in n/50". The
    # variant deposit adds a key under which LUC3D wins only 36 -- so left alone, the
    # same sentence would silently change meaning from "ahead of every published
    # tracker" (50/50) to "ahead of everything including our own unshipped fork"
    # (36/50), with nothing on the panel saying which was measured. Both facts are
    # stated instead: this line keeps its 50/50 over the published trackers, and the
    # variant's own footnote line below reports the arm beating shipped 37/50 and 36/50.
    # A no-op without `--variant`: `fig3_trackers.json` has no such key.
    # ALSO EXCLUDED: the preserved-but-invalid SLEAP entry. `--fix-sleap` keeps the old
    # truncated series in the deposit under `... (2-track truncation, invalid)` so the Fig
    # 7a prints stays auditable, and it keeps its win counts with it. Those counts must not
    # enter this min: it would let a measurement the deposit itself labels invalid decide
    # the sentence "ahead of every published tracker in n/50".
    shipped_wins = {k: v for k, v in wins.items()
                    if k not in (VARIANT_KEY, 'LUC3D') and "invalid" not in k}
    xwins = min(w["cross"]["wins"] for w in shipped_wins.values())
    xn = min(w["cross"]["n"] for w in shipped_wins.values())
    # THREE SHORT LINES, not two long ones. At 7.5 pt (what `footnote` sets) the
    # single-line version measured 77 mm and the per-camera line 80 mm on an 88 mm
    # panel; the x label is centred on the axes, so anything wider than the axis
    # extent hangs off the left of the page and the renderer drops the overhang
    # without complaint. Every line here is under 68 mm, measured.
    #
    # A FOURTH LINE IS NOT FREE, which is why the "BMimica only" note rides in the
    # key instead (see CORPUS_NOTE). `footnote` folds into the x label, so each line
    # is 3.2 mm taken out of THIS panel's axes: measured, a fourth line shrinks the
    # plot from 22.0 to 18.8 mm, and the two-line ceiling annotation then fills a
    # third of the data area. The key band is already reserved by `panel(key=4)`.
    #
    # `b–f: SLAP-2M` RIDES ON LINE 3 FOR THAT REASON, and it is not decoration.
    # TWO DIFFERENT QUANTITIES IN THIS FIGURE ARE BOTH CALLED "within-view IDF1":
    # this panel's 0.749 is BMimica, 50 sessions, C = 5; panel c's survival curve is
    # SLAP-2M, 74 sessions, C = 6, where the same tracker's within-view mean is 0.736
    # and its median 0.900. A reader who meets 0.749 here and a curve centred near
    # 0.90 there has no way to know they are different corpora unless BOTH panels say
    # so, so each names its own corpus AND points at the other (c carries the mirror
    # note "a is BMimica"). Naming only this one would still leave c unlabelled.
    #
    # THE VARIANT ADDS TWO MORE LINES and can afford them: `footnote` no longer draws
    # anything (it prints to the build log and returns -- the journal sets the legend),
    # so the "a fourth line is not free" arithmetic above is about the strip as it was
    # and as it may be again. If the strip ever comes back, these two lines are the
    # first thing to re-measure on 7h; the EXPERIMENTAL warning is already on the
    # artwork twice over (key line + data-area annotation) and does not depend on them.
    # "every tracker" is precise on 7a, where every tracker in the file IS a published
    # comparison; on 7h it would be false, because the panel shows one that beats LUC3D.
    every = "every published tracker" if variant else "every tracker"
    note = (f"n = {int(df.n_sessions.iloc[0])} full BMimica sessions, "
            f"{NCAM} cameras, 2 mice\n"
            f"mean ± 95% CI; LUC3D drift ≤ {drift:.3f} in every session\n"
            f"ahead of {every} in {xwins}/{xn} sessions · b–f: SLAP-2M")
    if variant:
        vw = wins[vkey]
        note += (
            f"\nLUC3D here is the EXPERIMENTAL fresh-anchor tracker, NOT the shipped app: "
            "figs/fig8-bench/xv_experimental.js, "
            "method {sync, stale 20} + distanceThreshold 25 — NOT in "
            "pose/cross-view-tracker.js and NOT what the app does\n"
            f"it is ahead of the shipped tracker in {vw['within']['wins']}/"
            f"{vw['within']['n']} sessions within view and {vw['cross']['wins']}/"
            f"{vw['cross']['n']} cross view. This panel is BMimica; the SLAP-2M panels "
            "b-g rest on a different detection pool (predictions_h5s via "
            "PAF_3d_kalman) and need their own run of this arm")
        # THE TWO COMPETITOR CORRECTIONS, in the note as well as on the artwork, so they
        # reach the build log of every render. `footnote` is not drawn (see its docstring),
        # which is exactly why the corrections do NOT depend on it: SLEAP's is on two key
        # lines and MuPPET's on two more. This is the audit trail, not the disclosure.
        sl = bm.get(SLEAP_INVALID_KEY)
        mc = (bm.get(MUPPET_KEY, {}).get("coverage") or {})
        if sl:
            note += (f"\nSLEAP here is the 2-TRACK-ENFORCED re-run (median 47 per "
                     f"camera-session); Fig 7a's {sl['within']['mean']:.3f} → "
                     f"{sl['cross']['mean']:.3f} kept only the first 2, and is preserved in "
                     f"the deposit as '{SLEAP_INVALID_KEY}'. Cross-view is CAMERA-SCOPED, "
                     f"the convention every other series here uses")
        if mc:
            note += (f"\n3D-MuPPET's {bm[MUPPET_KEY]['within']['mean']:.3f} is a COVERAGE "
                     f"number: its assignments cover a median {mc['median']:.2%} of a "
                     f"session ({mc['contiguous_prefix_sessions']}/{mc['n_sessions']} "
                     f"sessions a contiguous prefix from frame 0), and unlabelled frames "
                     f"score as misses. Drawn dotted/hollow for that reason")
    footnote(ax, note)
    if variant:
        # Lettered "a" because it OCCUPIES position a in the assembled figure, and a
        # panel lettered "h" sitting in the first slot reads as a mistake. Safety comes
        # from the SLUG, not the letter: `within_vs_cross_variant` is a different
        # filename, so the manuscript panel fig7a_within_vs_cross.pdf can never be
        # overwritten by this branch.
        save(fig, 7, "a", "within_vs_cross_variant")
    else:
        save(fig, 7, "a", "within_vs_cross")


if __name__ == "__main__":
    main(variant="--variant" in sys.argv,
         fair="--handicapped" not in sys.argv)
