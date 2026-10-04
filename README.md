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
python3 server.py 8080          # Windows: py server.py 8080
# App: http://localhost:8080/
# Tests: http://localhost:8080/tests/test-runner.html
```
`python3 -m http.server 8080 --bind 0.0.0.0` also works, but does not support
`--offline` (below).

### Offline
Four dependencies (three.js, mp4box, dockview-core, yaml) normally load from a
CDN. Fetch them once, while connected, and the app runs with no network:
```bash
python3 scripts/offline_deps.py install     # Windows: py scripts\offline_deps.py install
python3 server.py --offline
```
`--offline` rewrites those URLs to `lib/` as it serves, so nothing on disk
changes and nothing gets committed by accident. It refuses to start if a package
is missing rather than serving a half-offline page. `scripts/offline_deps.py
check` reports what is installed; `--strict` also fails on a CDN URL the manifest
does not map, which is what stops a new one from silently breaking offline mode.

One feature still needs internet: **Tracks ▸ Check ID Switches (Images)** downloads
an image model (~44 MB) on first use. Everything else works with the network off.

To give someone a copy that runs offline without any of this, build a zip whose
URLs are already rewritten — it works under any static server, and includes
start scripts for Windows, macOS and Linux:
```bash
python3 scripts/offline_deps.py bundle
```
Versions and checksums live in `offline-deps.json`; licenses in `lib/LICENSES.txt`.
## Web Deployment

<a href="https://luc3d.sleap.ai/" target="_blank" rel="noopener noreferrer">Access the live site here</a>

Or copy into the browser:
```
https://luc3d.sleap.ai/
```

Newest full release.
```
https://luc3d.sleap.ai/stable/
```


Newest release, pre-releases included.

```
https://luc3d.sleap.ai/latest/
```

Contains most recent pushes to `main` branch

```
https://luc3d.sleap.ai/dev/
```


## Requirements

Chrome or Edge — the app uses the File System Access and WebCodecs APIs, which
Firefox and Safari do not support.

Nothing to install; all libraries load automatically (~11 MB on first visit,
cached afterwards). Most of them are served from this site, but four still come
from a CDN, so a cold load needs internet — see [Offline](#offline) to remove
that dependency.

## Tests
Browser-based tests in `tests/test-runner.html`. Open in browser to run.

## Python Scripts
- `scripts/offline_deps.py` — Vendor the CDN dependencies into `lib/` for offline
  use (`install` / `check` / `bundle` / `clean`). Standard library only.
- `scripts/json_to_slp.py` — Convert JSON export to SLEAP .slp format
- `scripts/json_to_h5.py` — Convert JSON export to HDF5 format
- `json_to_*.py` require: h5py, numpy
