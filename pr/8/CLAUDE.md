# LUCID — Label Unification and Correspondence in 3D

Multi-view pose annotation GUI. No build system — pure vanilla JS served as static files.

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
python3 -m http.server 8080
# Or simply: python3 server.py
# App: http://localhost:8080/
# Tests: http://localhost:8080/tests/test-runner.html
```

## Dependencies (CDN only)
- Three.js 0.147
- mp4box.js
- h5wasm 0.8.8 (WebAssembly HDF5)
- sleap-io.js 0.2.1 (local copy in `lib/sleap-io/`, client-side SLP export)
- All loaded via script tags / import maps in index.html

## Tests
Browser-based tests in `tests/test-runner.html`. Open in browser to run.

## Python Scripts
- `scripts/json_to_slp.py` — Convert JSON export to SLEAP .slp format
- `scripts/json_to_h5.py` — Convert JSON export to HDF5 format
- Require: h5py, numpy
