# Overnight report — figures, 2026-08-15 morning

You asked for majorly improved figures, more stratified plots, no prose on artwork,
docs in sync, and self-sustained iteration. Three adversarial review rounds ran
overnight (each a fresh agent told to break the figures, each finding verified
against the scripts before anything moved); everything below is committed on
`eric/figs`, lint is at its 2 pre-existing issues, and every number that moved is in
`FIGURE-LEGENDS.md` / `METHODS.md`, which a dedicated agent kept honest all night.

## Look at these first

1. `figures/fig7/fig7.png` — 7a now plots the FAIR baselines (SLEAP 0.642 with the
   2-track cap actually enforced; ByteTrack 0.676 never-retire + our 2-identity
   stitch), the experimental arm is AMBER (it was wearing the shipped tracker's teal
   — caught by review), 3D-MuPPET's line says "1.3% coverage" instead of a
   misleading ×1.00, the ~30% dead band is reclaimed, and the corpus pointer is
   back. All caveats live in the legend.
2. `figures/fig2/fig2.png` — 2c is your box-plot-by-cameras (medians 4.32/3.66/3.34
   px at k=2/3/4; the axis explains why k stops at 4: one camera must judge). 2b
   plots labels-free-by-reprojection with C×N as the labelled denominator. 2a draws
   six grey cameras where its caption says six, and names its anchor cams.
3. **New measurement, finished and gated:** `figures/fig2/fig2s1_cams_identity.png`
   — cross-view identity vs cameras used. 450 tracking runs over deterministic
   camera subsets; the k=5 cell reproduces the published 50-session numbers to
   0.000e+00. Result: **0.67 → 0.74 → 0.75 → 0.75** — the 2→3 jump is the whole
   story, the diminishing return you predicted.

## The stratified plots you asked for (supplementary letters, awaiting your placement)

| panel | what | proposed home |
|---|---|---|
| `fig7s3_idf1_by_difficulty` | three trackers' within-view IDF1 by SLAP-2M difficulty, median + IQR, n under ticks | Fig 7, beside 7c |
| `fig6s4_quality_by_animals` | miss rate vs difficulty per animal-count stratum | replaces 6d, or stays supplementary (same cells as 6d — don't place both) |
| `fig6s5_percam_quality` | per-camera miss %, pooled bars + 74 session dots (top 30.1% → back 40.3%) | Fig 6, row c/d |
| `fig2s1_cams_identity` | identity vs cameras used (above) | Fig 2, beside 2c |

## Fig 3, per your instructions

3a unboxed (coloured headings, screenshot-matching identity colours); 3b cut (the
cost function now lives in METHODS.md, stated in the code's own form — which carries
a `(1+Δt)` factor the old schematic omitted); 3c is fresh-anchor vs exhaustive only,
no count labels; 3d sweeps the fresh anchor against exhaustive reference rules
(within 0.400 IDF1 / 81 switches per 100k on its own clean-frames denominator,
labelled); 3e has no prose. Panels re-lettered c→b, d→c, e→d, f→e.

## Measured overnight (all gated)

- **Camera subsets** (above): `figs/out/fig2_cams_identity.json`.
- **ID accuracy**: IDA = 92.46% pooled for the fresh anchor, median 100%, worst
  56.6%; false positives are 0.104% of matches, so IDA ≈ IDP. In METHODS.md.
- **Uncapped exhaustive 3×5 and 4×3**: running all eligible frames (10,419 and
  19,135 instead of the 7,001/3,000 samples you flagged). 6 of 7 sessions done at
  last check (`figs/out/tmp/hh_uncap.log`); panels 3c/3e re-render when it lands.

## Fixed after being caught by review (worth knowing)

- My fig2c "fix" (dots plotting 3D-mm against px boxes) **died in a failed shell
  call and I committed a message claiming it anyway.** The round-2 reviewer caught
  it by arithmetic (50 dots below their own box's p25). Actually applied and
  verified in round 2; the commit message of the false claim is `5f0cc69`, the real
  fix `4b51d21`.
- fig7s3's mean±s.d. whiskers asserted IDF1 up to 1.14 on a [0,1] metric → now
  median with IQR whiskers.
- fig6e's Hours column showed 18.7 + 10.9 = 29.5.

## Needs you (nothing else can move these)

1. **Place or decline the four supplementary panels** (table above).
2. **2a's 3D viewport re-render from sideL** — needs the app opened on the demo
   session; everything scripted around it is done.
3. **F7.3 recovery tolerance** (10 px / 20 px?) and denominator — blocks the
   false-negative-recovery panel.
4. **X.2 px→cm scale plane** (arena floor vs mean animal height).
5. **F3.3 "the square"** — Jaccard metric, heat-map, or R²?
6. 7b/7e per your late-night message: if you meant the SLAP-2M fair-baseline
   substitution on those panels too, that needs the baselines re-run on SLAP-2M
   (different pool; SLEAP's detections there are indexed by its own tracks) — a
   real experiment, not a redraw. Say the word and I'll spec it.

Commits tonight: `5f0cc69`, `6d280f3`, `4b51d21`, `c85a796`, `3c4ece7`, plus the
docs sync and whatever lands from the final legend pass. `git log --oneline` reads
as the narrative.
