# LUCID — Label Unification and Correspondence in 3D

Multi-view pose annotation GUI. No build system — pure vanilla JS served as static files.

## Architecture
ES modules, vanilla JS (no build step). `index.html` loads `app.js` as `<script type="module">`; `app.js` is a 2-line entry point that imports from `pose/`. The 28 modules are grouped into four directories:
- `pose/` — data model, cross-view tracking, DLT triangulation, app initialization (5 files)
- `ui/` — UI state, canvas rendering, mouse/keyboard interaction, info panel, modals, timeline, 3D viewport, settings (14 files)
- `loading/` — video decoding, session loading, SLP/package readers, web workers (5 files)
- `import-export/` — file I/O, save/load, SLP import/merge (4 files)
- `demo-data.js` — synthetic skeleton and camera data
- `styles.css` — all styling

See `MODULES.md` at the repo root for per-module details (purpose, exports, imports/dependents).

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

## UI Conventions
**Modals must close on `Esc`** unless explicitly stated otherwise. When building
or editing any modal/overlay dialog, wire a `keydown` listener that closes it on
`Escape` (and removes the listener on close). For a modal mid-operation (e.g. an
in-progress export), `Esc` should cancel/stop that operation rather than tear the
modal down. Example: `showExport3DVideoModal` in `ui/export-modals.js`.

## Tests
Browser-based tests in `tests/test-runner.html`. Open in browser to run.

## Python Scripts
- `scripts/json_to_slp.py` — Convert JSON export to SLEAP .slp format
- `scripts/json_to_h5.py` — Convert JSON export to HDF5 format
- Require: h5py, numpy
- `scripts/validate_slp_sleap_compat.py` — Assert LUCID-exported `.slp` files are
  SLEAP-GUI compatible (load via `sleap_io`, non-empty tracks, optional
  `--compare` against a native SLEAP-GUI export). Headless half of `lucid-e2e`
  Stage 4; run via `uv run python` from the SLEAP repo.

## Maintenance
**When modifying any module, always update the corresponding entry in `MODULES.md` to reflect the change — including exports, dependencies, and purpose.**

**Keyboard shortcuts.** Every keyboard shortcut in the app must have an entry in
`ACTION_CATALOG` in `ui/settings.js` so it is listed (and stays accurate) in
**Settings ▸ Keyboard Shortcuts**. When you add, change, or remove a shortcut:
- Add/update its catalog entry: `{ id, label, category, binding, editable, dispatched }`.
- `dispatched: true` means the binding is matched live by `dispatchEvent()` and
  needs a handler attached via `setHandler(id, fn)` (see `ui/ui-wiring.js`); such
  shortcuts are rebindable when `editable: true`.
- `dispatched: false` means the shortcut keeps its own dedicated handler
  (transport, `timeline-controller.js`, `interaction.js`, …) and the catalog
  entry is reference-only — keep its `binding` string in sync with that handler.
