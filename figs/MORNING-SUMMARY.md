# Overnight report — 2026-08-16 morning

You went to sleep with three visual-quality workstreams launched and two
benchmark reruns in flight. Everything landed; every panel below was verified
by eye (the rendered PNGs, not just exit codes) before being called done.
(The previous morning's report is preserved at `MORNING-SUMMARY-2026-08-15.md`.)

## Look at these first

1. `figures/fig5/fig5.png` — **5a is now a Blender render**: the mutual upright
   display's two mice as matte ball-and-stick skeletons with filled membranes,
   inside a plain translucent cutaway cube (no cage — different dataset), in
   fig5's Set2 teal/pink. The five 2D projection views are restyled to the same
   surface-filled skeleton look. Regenerate the render with the command in
   `panels/fig5_05_upright_views.py`'s docstring (`blender-images/fig5a_scene.py`).
   TWO REAL BUGS found en route, both documented in the scene file:
   (a) `cage_scene.hex2rgba` feeds raw sRGB values into Blender's LINEAR color
   sockets — the systemic pastel wash in these renders; fig5a pre-linearizes its
   hexes instead (cage_scene untouched, its approved renders unchanged);
   (b) the box's camera-facing translucent walls were desaturating everything
   behind them — the box is now a cutaway (film only on the far walls, full ink
   wireframe). If you ever re-render `cage_two_mice`, consider the same fixes.
2. `figures/fig10/fig10.png` — three changes you asked for, finished:
   **10a** tiles now draw full skeletons (the deposit's own `joints_idx` edges +
   translucent convex-hull body panels + joint dots) instead of bare dots;
   **10f** is the camera-count ablation under 25% instance dropout at σ=0|σ=3
   (your spec): pooled switch rate falls ~130–190 → 4–10 per 100k frames from
   2 → 6 cameras (~20–40×), four spread cameras recover most of it, and adding
   3 px noise barely moves the curve — missingness, not noise, is what cameras
   buy protection against; **10g**'s dropout arm is now at σ=0 (0 → ~1 → ~7
   per 100k at 0/25/50%). All lines figure-wide are now POOLED statistics
   (your "why does it say 0 switches" review) — medians live in caption text.
3. `figures/fig6/fig6s2_mean_pose.png` — the mean-pose supplementary panel
   restyled with the new shared helper `src/skeleton_style.py` (2D + 3D
   surface-filled skeletons for any future panel; includes a workaround for a
   real matplotlib-3.11 `add_collection3d` bug, documented in the module).

## Benchmark state (fig10)

- 1,562 cell results in `fig10-bench/results/` (main matrix 656 + C6 hand-labels
  + C7 camera ablations at σ3/σ10/σ0/σ0+drop25/σ3+drop25 + C8 drop50@σ0),
  zero missing per `fig10_aggregate.py`, zero failed cells.
- Verification controls deposited (`fig10_controls.py` → `results/agg/controls.json`):
  randomized-GT re-score collapses to chance; a GT splice is detected exactly;
  wrong calibration collapses the score. The scorer cannot self-confirm.
- `LEGEND-fig10.md` numbers re-verified against `summary.csv` after every
  condition change; PANEL-SOURCES rows updated (e/f/g conditions, 10a pipeline).

## Open decisions (yours)

- **Fig 10 is 236 mm** against the 200 mm soft ceiling (7 panels). Candidate
  trims: shrink the 10a image row, or move 10b to supplementary (its number is
  also in the caption). Same situation as fig6's overrun — your call.
- The fig5a render's mice sit slightly lighter than the 2D views' Set2 (soft
  lighting lift after the linearization fix; compensation factor 0.8 noted in
  `fig5a_scene.py`). Judged close enough to read as the same animals — push
  further only if it bothers you.
- sRGB-vs-linear bug in `cage_scene.hex2rgba`: left in place deliberately
  (fixing it would change the approved cage_two_mice renders). Flag if you want
  it fixed and those re-rendered.
