# luc3d (Label Unification and Correspondence in 3D Annotation GUI)
Label Unification and Correspondence in 3D Annotation GUI in Web Browser
Multi-view pose annotation GUI. No build system — pure vanilla JS served as static files.

![LUCID](https://github.com/user-attachments/assets/ceed2a47-6515-4010-a8db-b846d9a064b6)

![lucidGUI](https://github.com/user-attachments/assets/bc89788a-bf2b-4816-89ff-b23fa4ef0b5b)

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
## Web Deployment from Main 
```bash
https://talmolab.github.io/luc3d/
```

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
