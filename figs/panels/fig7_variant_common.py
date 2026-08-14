#!/usr/bin/env python3
"""Shared machinery for the tracker arms of Fig 7's SLAP-2M panels (b-f since the
2026-08-14 re-lettering; the docstrings below say "b-g"/"c-g" where they narrate the
HISTORY of the substitution, which happened under the old letters -- the letters in
prose about past events are the letters things had at the time).

    ############################################################################
    THE SUBSTITUTION IS NOW LIVE ON c, d, e, f AND g (Eric, 2026-08-13). Their
    DEFAULT render -- the one `assemble.py` composites into the manuscript
    figure -- reads the SHIPPED tracker (`slap2m` in
    `figs/out/fig7_variant_best.json`, i.e. `pose/cross-view-tracker.js`) instead
    of `fig3_trackers.json`'s pre-#131 block. Same panel design, same three
    series, same pool, same 74 sessions; the LUC3D data is the tracker LUCID
    actually ships. `fig3_trackers.json` is still NOT rewritten -- it is a
    manuscript deposit and it stays git-clean -- the panels changed which block
    they read.

    `--as-shipped` reproduces the OLD pre-#131 render for provenance, under a
    `_pre131` slug so it can never overwrite the manuscript PDF. `--variant` is
    unchanged and still draws all three arms.

    THE BEDDING PANEL WAS CUT FROM THE FIGURE 2026-08-14 (review): it now renders
    as supplementary `fig7s2_bedding` and still plots the pre-#131 arm for its own
    historical reasons. With it gone, NO placed panel plots the retired tracker and
    the two-generations-under-one-name inconsistency is closed. Panels re-lettered
    c-g -> b-f.
    ############################################################################

    ############################################################################
    WHAT THE SUBSTITUTION CORRECTS, and it is a correction pointed at US.

    Fig 7 b-g's LUC3D arm came from `figs/out/fig3_trackers.json`'s `slap2m`
    block, which was produced by `matchFrameInstances` -- the pre-#131,
    pre-module-refactor PER-FRAME matcher -- driven by
    `luc3d-bench/scripts/luc3d_track_all.mjs` against a FLAT LUCID snapshot on
    2026-05-15. `pose/cross-view-tracker.js` (`runCrossViewTracker`) was merged
    2026-07-06, seven weeks later. So every b-g number describes a tracker that
    has not been the shipped tracker since. Measured, not inferred: item 3
    reproduced the reference's stored outputs assignment-for-assignment and
    re-scored them to `_eval_baseline.csv`'s 0.7360353065988466 with zero
    per-session deviation. `figs/out/ITEM3-SLAP2M-GATE.md`.

    Fig 7a's BMimica arm, by contrast, IS `runCrossViewTracker`. So the figure
    as shipped labels two different trackers "LUC3D".

    THERE ARE TWO MOVEMENTS AND THEY ARE KEPT APART. c-g now PLOT the first and
    the `--variant` render draws both:
      1. pre-#131 -> SHIPPED. The correction. MIXED by animal count: the whole
         +0.0160 corpus gain is the 35 two-animal sessions, and on >= 3 animals
         the OLD tracker is better and the shipped one's switch count blows up
         (3 animals n = 4: 205 -> 744; 4 animals n = 3: 299 -> 606).
      2. SHIPPED -> FRESH ANCHOR. The experimental arm ({sync, stale 20} +
         distanceThreshold 25, `figs/fig8-bench/xv_experimental.js`, NOT in the
         app). This is where the switch fix lives: 3,094 -> 1,312 overall, and
         744 -> 54 / 606 -> 145 on the >= 3-animal strata it rescues -- without
         fully recovering their IDF1.

    The variant still writes its own slug, so it cannot overwrite a manuscript
    panel; what changed on 2026-08-13 is which block the MANUSCRIPT slug is built
    from for c-g.
    ############################################################################

WHY A SHARED MODULE. Six panels take the same three arms out of the same deposit and
have to agree on what each arm is CALLED and how it is DRAWN, or a reader comparing
two panels of one figure sees the same tracker under two names. `fig9_common.py` is
the precedent.

THE COLOUR RULE, WHICH IS NOT NEGOTIABLE HERE. LUC3D's series colour stays
`entity("luc3d")` teal for BOTH the shipped and the fresh-anchor arm. Amber/brown for
LUC3D was explicitly rejected. Experimental status is carried by WORDS ("EXPERIMENTAL",
"not in the app") and by LINE STYLE (dashed line, hollow marker, hatched bar), never by
recolouring the method. The superseded pre-#131 arm is the one thing drawn in MUTED
grey, because it is a historical reference level rather than a method on offer.

NOTE 7a DOES IT DIFFERENTLY, ON INSTRUCTION, and that asymmetry has to be stated
rather than smoothed: on 7a's variant the `LUC3D` slot IS the fresh anchor, drawn in
amber and labelled, because that panel replaces the arm. On b-g the LUC3D series is
the SHIPPED tracker and the fresh anchor sits beside it. Neither choice may be
inferred from the other.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import load  # noqa: E402
from src.style import MUTED, entity  # noqa: E402

#: The variant deposit, built by
#: `figs/fig7_variant_tracker.py --config sync_stale20_dist25
#:  --label 'LUC3D (fresh anchor)' --replace --fix-sleap --muppet-coverage --slap2m`.
VARIANT_SRC = "fig7_variant_best.json"

#: The three SLAP-2M arms' keys in that deposit. `slap2m` is the SHIPPED tracker (the
#: correction); the other two are named blocks beside it. Its `slap2m` block is
#: STRUCTURALLY IDENTICAL to `fig3_trackers.json`'s -- verified key for key, nested,
#: with zero keys on either side only -- which is what makes it a drop-in for the
#: default render of c-g and why no panel needed a new code path to consume it.
SHIPPED_KEY = "slap2m"
REF_KEY = "slap2m_pre131_reference"
FRESH_KEY = "slap2m_fresh_anchor"
ARMS_KEY = "slap2m_arm_comparison"

#: Names on the artwork. Short enough for a key line (~50 characters at bold 8 pt in
#: an 88 mm panel; `lint_text.truncated()` is the backstop) and each says what the arm
#: IS rather than which flag produced it.
SHIPPED_LABEL = "LUC3D (shipped)"
FRESH_LABEL = "LUC3D + fresh anchor"
REF_LABEL = "LUC3D pre-#131 (Fig 7 as shipped)"

#: One line each, drawn under the arm it qualifies, in that arm's own colour.
FRESH_NOTE = "· EXPERIMENTAL: not in the shipped app"
REF_NOTE = "· superseded: a tracker retired 2026-07-06"


def arm_colors():
    """(shipped, fresh, reference) colours. See the colour rule in the docstring."""
    return entity("luc3d"), entity("luc3d"), MUTED


#: Line/marker idiom per arm, so six panels draw the same distinction the same way.
FRESH_LS = (0, (2.2, 1.4))
REF_LS = (0, (1.0, 1.6))


def _require_substituted(t):
    """REFUSE a variant deposit built without `--slap2m`: that file still holds the
    pre-#131 block under `slap2m`, and drawing it while calling the panel corrected
    would assert a substitution that did not happen. The presence of
    `slap2m_pre131_reference` is the proof that `slap2m` was substituted -- the
    builder writes the two together or neither."""
    for k in (REF_KEY, FRESH_KEY, ARMS_KEY):
        if k not in t:
            sys.exit(f"fig7: {VARIANT_SRC} has no `{k}` -- it was built without "
                     f"--slap2m, so its `slap2m` block is still the PRE-#131 tracker. "
                     f"Rebuild it with:\n  $PY figs/fig7_variant_tracker.py --config "
                     f"sync_stale20_dist25 --label 'LUC3D (fresh anchor)' --replace "
                     f"--fix-sleap --muppet-coverage --slap2m")


def arms(variant, corrected=True):
    """(shipped, fresh, ref, arm_table) SLAP-2M blocks.

    THREE MODES, and the middle one is the manuscript's since 2026-08-13:

      `arms(False)`                  -> the SHIPPED tracker alone (c, d, e, f, g).
                                        The corrected manuscript render.
      `arms(False, corrected=False)` -> the pre-#131 block out of
                                        `fig3_trackers.json`. What c-g used to
                                        draw; still what 7b draws, and what
                                        `--as-shipped` renders under a `_pre131`
                                        slug for provenance.
      `arms(True)`                   -> all three arms, for the `--variant` render.

    Outside `--variant` the other three returns are None, so a call site cannot
    silently draw a missing arm as zero -- it has to branch.
    """
    if variant:
        t = load(VARIANT_SRC)
        _require_substituted(t)
        return t[SHIPPED_KEY], t[FRESH_KEY], t[REF_KEY], t[ARMS_KEY]
    if not corrected:
        return load("fig3_trackers.json")["slap2m"], None, None, None
    t = load(VARIANT_SRC)
    _require_substituted(t)
    return t[SHIPPED_KEY], None, None, None


def slug(base, variant, corrected=True):
    """`<base>_variant` under `--variant` and `<base>_pre131` under `--as-shipped`,
    so neither render can overwrite the manuscript panel's PDF, PNG or deposited CSV.
    The bare slug belongs to the corrected default."""
    if variant:
        return f"{base}_variant"
    return base if corrected else f"{base}_pre131"


def flags(argv):
    """`(variant, corrected)` from a panel's `sys.argv`, so all five corrected panels
    spell the two flags the same way and `--as-shipped` cannot mean one thing on 7c
    and another on 7g."""
    return "--variant" in argv, "--as-shipped" not in argv


def pool_note():
    """The pool caveat every b-g panel carries, because every claim here is
    pool-dependent and the two SLAP-2M pools are not interchangeable.

    `predictions_h5s` (this figure, via PAF_3d_kalman/_eval_baseline.csv) scores
    within-view IDF1 0.736-0.752 on these 74 sessions; `keeptrack_h5s` scores 0.899 on
    the SAME sessions. On this pool the fresh anchor cuts mislabelled detections 59%
    over the 42 multi-animal sessions; on keeptrack the same arm is
    flat-to-marginally-worse (+1.3% relative) while switches still fall 30%.
    """
    return ("pool: predictions_h5s. On keeptrack_h5s the same 74 sessions score 0.899 "
            "within view and the fresh anchor's mislabelled-mass gain does NOT "
            "reproduce (flat to +1.3% worse; switches still -30%)")
