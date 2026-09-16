# luc3d (Label Unification and Correspondence in 3D Annotation GUI)
Label Unification and Correspondence in 3D Annotation GUI in Web Browser
Multi-view pose annotation GUI. No build system — pure vanilla JS served as static files.

<img width="3450" height="1804" alt="luc3d image" src="https://github.com/user-attachments/assets/f013dc6b-c10c-4f1d-a70a-1a18a105dbd0" />

Full documentation, tutorials, and user guides: (https://talmolab.github.io/luc3d-docs)

## Architecture
- `index.html` — Main SPA with all app logic in inline script
- `pose-data.js` — Data model (Skeleton, Camera, Instance, FrameGroup, InstanceGroup, Session)
- `interaction.js` — Mouse/keyboard interaction, hit testing, drag handling
- `overlays.js` — Canvas rendering for pose skeletons and overlays
- `triangulation.js` — DLT triangulation + reprojection math
- `video.js` — WebCodecs video decoding (OnDemandVideoDecoder)
- `viewport3d.js` — Three.js 3D visualization
- `timeline.js` — SLEAP-like timeline widget
- `file-io.js` — File loading, calibration parsing, export (TOML/JSON/SLP)
- `demo-data.js` — Demo skeleton and camera data
- `styles.css` — All styling

## Local Development
```bash
python3 -m http.server 8080 --bind 0.0.0.0
# App: http://localhost:8080/
# Tests: http://localhost:8080/tests/test-runner.html
```
## Web Deployment

<a href="https://luc3d.sleap.ai/" target="_blank" rel="noopener noreferrer">Access Here</a>

The app is served from GitHub Pages at **https://luc3d.sleap.ai/**. That is the
canonical URL — the old `https://talmolab.github.io/luc3d/` now 301-redirects to
it.

`.github/workflows/deploy.yml` keeps four independent channels on the `gh-pages`
branch. There is no build step, so each one is just the repo tree at some ref,
and the app is sub-path safe (relative importmap), so the same tree works at
every path:

| URL | Serves | Moves when |
| --- | --- | --- |
| <https://luc3d.sleap.ai/> | Newest **full release** — stable | a non-pre-release is published |
| <https://luc3d.sleap.ai/latest/> | Newest release, **pre-releases included** | any release is published |
| <https://luc3d.sleap.ai/dev/> | Tip of `main` — bleeding edge | every push to `main` (or `dev`, see below) |
| `https://luc3d.sleap.ai/pr/<n>/` | Per-PR preview | a PR opens or updates (`pr-preview.yml`) |

The `dev` branch also deploys to `/dev/`. It exists so the deploy pipeline can
be exercised for real before `main` adopts it — GitHub runs a push workflow from
the *pushed* branch's copy of the file. Both branches write the same path, so
whichever pushed last wins; that's fine for a short-lived staging branch, but if
`dev` becomes a permanent integration branch, give it its own channel instead.

Both release channels only ever move **forward**: a republished older version
leaves the site alone, since GitHub does not guarantee releases are published in
increasing version order.

### Cutting a release

Releases are published by hand, from the GitHub Releases UI or a laptop:

```bash
gh release create v0.1.0 --generate-notes           # -> / and /latest/
gh release create v0.2.0-1 --generate-notes --prerelease   # -> /latest/ only
```

Publishing is what triggers the deploy. Doing it from a workflow would not
work: a release created with the Actions `GITHUB_TOKEN` does not fire
`release: published`, so the deploy would never run.

Tags must be `vX.Y.Z`, or `vX.Y.Z-N` with a **numeric** pre-release part
(`v0.2.0-1`, `v0.2.0-2`) — same convention as
[sleap-app](https://github.com/talmolab/sleap-app). Anything else fails the
deploy loudly rather than skipping it silently. To re-deploy a channel by hand,
run **Deploy to GitHub Pages** from the Actions tab and pick the tag in *Use
workflow from*.

## Dependencies (CDN only)
- Three.js 0.147
- mp4box.js
- All loaded via script tags in index.html

## Tests
Browser-based tests in `tests/test-runner.html`. Open in browser to run.

## Python Scripts
- `scripts/json_to_slp.py` — Convert JSON export to SLEAP .slp format
- `scripts/json_to_h5.py` — Convert JSON export to HDF5 format
- Require: h5py, numpy
