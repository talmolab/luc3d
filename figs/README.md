# `figs/` — paper figures

Figures for the LUC3D paper, generated from the **real app driven over real data** —
no mock-ups, no hand-placed skeletons. Every panel that shows pose comes out of
LUC3D's own canvases after the actual pipeline (load → Track All → Triangulate All)
runs, and every number in an annotation is read back from that run.

Laid out to Nature-family specs (the SLEAP paper, Pereira et al. *Nat Methods*
2022, is the reference): 180 mm double-column width, Arial, 7 pt body / 6 pt
annotation / 8 pt bold lowercase panel letters, 0.4–0.75 pt strokes, no chrome.

## Pipeline

```bash
# 1. Build the figure session (once). Trims a short window out of the 8-camera
#    HardFight recording and remaps the .slp onto it: ~22 MB instead of ~2.4 GB.
python3 figs/build_fig_session.py                 # -> figs/session/  (gitignored)

# 2. Export the source panels at native resolution + a JSON manifest.
node figs/fig1_tracking.mjs                       # -> figs/out/*.png, fig1.json

# 3. Lay out the figure, then rasterize.
python3 figs/fig1.py                              # -> figs/out/fig1.svg
node figs/render.mjs figs/out/fig1.svg 600        # -> fig1.png (600 dpi) + fig1.pdf
```

`figs/session/` and `figs/out/` are **gitignored** — the scripts are the artifact,
the 22 MB of video and the rendered PNGs are not.

## Files

| File | What it is |
|---|---|
| `build_fig_session.py` | Cuts an 8-camera window (default frames 24551–24850, the longest run where all 8 views see all 3 mice) out of `_bugdata/20260605_133431-HardFight{,_reencoded}` and rewrites each `.slp` onto it. Frame-accurate: decodes from frame 0 rather than input-seeking, because a keyframe-snapped seek would silently shift every label. |
| `_drive.mjs` | Playwright driver: load the session, navigate frames, Track All, Triangulate All, colour mode, timeline mode, "Show Camera View", pane layout, and `exportViews()` — which composites each view's video + overlay canvas at **native 1280×1024** and records each animal's centroid, box, track, per-frame identity, and the exact colour the app drew it in. |
| `fig1_tracking.mjs` | Runs the pipeline and writes Fig 1's source panels + `fig1.json`. |
| `fig1.py` | Fig 1 layout (a pipeline schematic, b tracks→identities, c 3D, d tool comparison). |
| `nature.py` | Tiny SVG layout library in millimetres with the journal's conventions baked in (panel letters, type scale, stroke weights, crop-by-clip images, Nature-style tables, bare-spine axes). |
| `render.mjs` | Rasterizes a figure SVG through headless Chromium → PNG at any DPI + PDF. |
| `probe.mjs`, `fig1_gui.mjs` | Earlier full-GUI screenshot passes. Kept because the whole-window shot is still useful for docs/slides, but it is **not** the figure — at print size the 8-pane GUI is illegible, which is why Fig 1b uses native-resolution crops instead. |

## Things worth knowing

**Why native-resolution crops, not GUI screenshots.** A view pane is a CSS-scaled
1280×1024 canvas laid out 4-across, so a pane crop is ~300 px wide and a mouse is a
few dozen pixels — unreadable in print. `exportViews()` reads the canvases
themselves and the manifest says where the animals are, so tiles can be cropped
tight and still carry real detail.

**Why "Show Camera View" for the 3D panel.** An arbitrary orbit angle cannot be
checked against anything. Setting the 3D viewport to a real camera's perspective
(the app's own button) puts the 3D skeletons exactly where that camera's 2D pane
shows the animals; the panel then also reuses the *same normalised crop*, so the
reader can compare 3D against the image rather than taking it on faith.

**Brightness.** The app applies per-view brightness as a CSS filter on the pane,
which is *not* in the canvas pixels — `exportViews({brightness})` re-applies it when
compositing, to the video only, never the overlay. These are dark IR frames; the
default 1.9 is a display gain, applied identically to every tile in a figure.

**Overlay geometry.** The app's marker sizes are tuned for panes at ~1:3 CSS scale;
at native resolution they are chunky X's that swamp a 40 mm tile. `setOverlayStyle`
sets the real Visibility sliders (so the app's own `getVisibilitySettings()` is what
changes) rather than drawing anything different.

**Panel d is third-party claims.** Every non-LUC3D cell describes someone else's
software from its published docs. `NEEDS_CHECK` in `fig1.py` prints a warning onto
the figure; re-verify against current docs and date the check in the caption before
submission.

## Open

* **Fig 2b (annotation-time scaling)** needs *real timing data* — there is none in
  this repo. Either instrument the app to log per-frame labelling time, or run a
  small timed labelling study. A measurable surrogate that needs no study: count
  the manual keypoint placements required per frame (traditional = *N*<sub>cams</sub> ×
  *N*<sub>nodes</sub>; reprojection-aided = 2 × *N*<sub>nodes</sub> + corrections),
  where the correction count is measurable from proofread data.
* **Fig 2c (3D consistency)** needs the two conditions pinned down: what counts as
  "independent" labelling versus "reprojection-guided" in the data we actually have.
