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
- dockview-core **pinned to 6.6.1** (`index.html` CSS + `ui/sessions-panes.js` ESM
  import — keep the two pins in sync). 7.x renamed `api.onUnhandledDragOverEvent`
  → `onUnhandledDragOver`, so an unpinned `/+esm` import silently breaks pane
  docking whenever the CDN cache refreshes. Audit the dockview API usage in
  `ui/sessions-panes.js` before bumping past 6.x.
- mp4box.js
- h5wasm 0.10.3 (WebAssembly HDF5) — **vendored locally** at `lib/h5wasm/`
  (ESM `hdf5_hl.js` + IIFE `h5wasm.iife.js`; no CDN fetch). See its `PROVENANCE.txt`.
- sleap-io.js — vendored browser bundle in `lib/sleap-io/`, pinned to **0.5.5**,
  **built from source** at `talmolab/sleap-io.js@e8dbaef8c` (the `0.5.5` release-bump
  commit) via `scripts/revendor-sleap-io.sh e8dbaef8ccc8` — 0.5.5 was **not yet on
  npm** at vendor time, so this is a source build (not npm-dist byte-parity); **re-
  vendor from the npm dist once `0.5.5` publishes** for parity. 0.5.5 lands the
  **SLP 2.8 columnar `/session_data`** storage (PR #224, porting Python sleap-io #546):
  3D points + frame-group/instance-group grouping move OUT of the single per-session
  `sessions_json` JSON string into chunked HDF5 datasets — fixing the large-project
  read bug (luc3d #161: a ~524 MB `sessions_json` exceeded h5wasm's ~0.45 GB vlen-
  string read ceiling and silently returned 0 sessions, dropping calibration/3D/IDs).
  It also adds **fail-loud** reads (a present-but-unreadable `sessions_json` now
  THROWS instead of silently yielding `[]`), the **per-2D-detection identity** stack
  (`/identity` + `/identity/links` + `/embeddings`, SLP 2.5, PR #225) and the
  **category** subsystem (SLP 2.7, PR #226), plus two write-side fixes folded in from
  #161 (`NaN`-not-`null` for missing 3D keypoints; the 2D point-span off-by-one).
  Retains the streaming SLP **writer** (`openSlpWriter`
  /`appendStore`/`appendFrames`/`close`/`writeToSink`, `saveSlpMergedFromStores` /
  `saveSlpMergedToSink`) + lazy frame-release API (`labels.frameCacheLimit` /
  `releaseFrame` / `releaseFrameWindow`). **Chunks:** `index.browser.js` +
  `chunk-X76PRJK6.js` (the big one: session I/O + `MediaBunnyVideoBackend`),
  `chunk-H7G4PJNA.js`, `chunk-YS7Q6CO6.js`, `gdrive-6DDSPUUK.js` (byte-stable).
  Importmap bare-imports (h5wasm/mediabunny/pako/yaml) are unchanged from 0.5.3. The
  lazy streaming reader backs `SioLazyLoader` (`loading/sio-lazy-loader.js`) for large
  prediction `.slp` session loads; both the eager `saveSlpToBytes` and streaming
  `openSlpWriter` now emit SLP 2.8 automatically when a session has frame groups.
  Its `pako`
  dep is vendored at `lib/pako/`; `mediabunny` is vendored at
  `lib/mediabunny/mediabunny.min.mjs` (npm `mediabunny@1.30.0` browser ESM,
  matching sleap-io.js's `^1.30.0`) — it was previously stubbed
  (`lib/sleap-io/mediabunny-stub.js`, now unused) and is now the REAL library
  so sleap-io.js's `MediaBunnyVideoBackend` can do frame-accurate video decode
  (issue #115), wired into `loading/video.js` as the default (opt-out via
  `LUCID_VIDEO_BACKEND='html5'`) backend. Both `pako` and `mediabunny` are
  aliased in the `index.html` importmap (and `tests/test-runner.html`). LUCID
  uses sleap-io.js on **both** the read and write paths (PR 5.1/5.2).
  **LOCAL PATCH (issue #115):** `lib/sleap-io/chunk-X76PRJK6.js`
  `MediaBunnyVideoBackend.decodeSingleFrame`/`decodeRange` were patched to call
  `sample.close()` after `sample.toVideoFrame()` — upstream leaks the VideoSample
  ("A VideoSample was garbage collected without first being closed"), which can
  exhaust the WebCodecs frame pool over a long session. Both patch lines are
  marked `// LUCID local patch (#115)`. **Re-apply after any re-vendor** (grep the
  marker) and report upstream to sleap-io. (The chunk moved `M65RB7KH`→`X76PRJK6`
  in the 0.5.5 re-vendor.)
  **LOCAL PATCH (issue #115, decode-order):** `lib/sleap-io/chunk-X76PRJK6.js`
  `MediaBunnyVideoBackend.initialize()` builds its frame-index → timestamp map
  (`_frameTimes`) by pushing `EncodedPacketSink.packets()`'s timestamps in
  *iteration* order — but mediabunny's own docs state `packets()` yields
  packets in **decode** order, not presentation order (each packet's
  `.timestamp` is its real PTS; only the *iteration* order is unsorted). For
  any B-frame-encoded video (routine for real camera recordings — this is
  exactly what the original #115 report suspected, "keyframes versus
  B-frames"), decode order != presentation order, so `_frameTimes[i]` was NOT
  the i-th frame in playback order: `decodeSingleFrame(i)` looked up the
  WRONG timestamp for any `i` displaced by B-frame reordering, **deterministically
  returning the wrong frame's pixel content for a correctly-requested index —
  not a race, reproducible on a single, non-concurrent step.** Verified with a
  real ffmpeg-generated B-frame video (`tests/fixtures/bframes-test/`,
  `-bf 3 -g 10`): 18 of 30 frames (60%) decoded wrong before this patch, 0
  after. Fixed by sorting `_frameTimes` ascending by timestamp at the end of
  `initialize()`, marked `// LUCID local patch (#115)`. **Re-apply after any
  re-vendor** (grep the marker) and report upstream to sleap-io/mediabunny.
  Covered by `tests/e2e/mediabunny-bframe-decode-order.mjs`.
  **LOCAL PATCH (sleap-io.js#231):** `lib/sleap-io/chunk-X76PRJK6.js` writes the
  SLP `instances` table with dtype `"<d"` (h5wasm float64) instead of upstream's
  `"<f8"` — h5wasm does NOT speak numpy dtype strings and parses `"<f8"` as
  FLOAT32, which quantizes `point_id_start/end` to even integers beyond 2^24
  point rows and silently corrupts every instance's node assignment on files
  with >16.7M points (~1M instances at 17 nodes; the real cage5 project has
  21.7M). Three patched sites (eager `createMatrixDataset`, streaming
  `createAppendableMatrixDataset`, merged `writeLazyMatrixDataset` — all marked
  `// LUCID local patch (sleap-io.js#231)`); `points`/`pred_points` stay f32
  deliberately (coordinates only — f64 would add ~50% file size). Guarded by a
  dtype regression test in `tests/test-lazy-reopen.js`. **Re-apply after any
  re-vendor until upstream fixes #231** (grep the marker).
  **LOCAL PATCH (luc3d #185):** `lib/sleap-io/chunk-X76PRJK6.js` `writeSessions`
  accumulates the `/session_data` 3D-point tables (`points_3d`,
  `pred_points_3d`) into a **pre-sized `Float64Array`** (`Float64RowSink` +
  `createGzipFloatMatrixTyped`, sized by an exact counting pre-pass) instead of
  pushing one boxed `Array(3|4)` per 3D keypoint (`coerce3dRow`) into a plain JS
  array and holding them all live until `createGzipFloatMatrix` flattened them.
  On the real 180,210-frame × 5-camera project that is 531,799 instance groups ×
  15 nodes = **7,976,985** rows — an estimated **~400 MB** of boxed arrays (~48 B
  per 3-double JSArray plus outer element pointers) sitting in V8's
  **pointer-compressed heap, which a Chrome renderer hard-caps near 4 GB**
  (measured `jsHeapSizeLimit` 3.76 GB headless; `--max-old-space-size` does NOT
  raise it). A typed array's backing store is allocated OUTSIDE that cap, so
  this moves the cost off the scarce resource — the table becomes one
  7,976,985 × 3 × 8 B ≈ **191 MB** buffer. Measured end-to-end via a controlled
  A/B (same harness, pre-save baselines within 3 MB — 2,891 MB unpatched vs
  2,894 MB patched): merged "Save As" went from a **renderer OOM crash 13 s in**
  to **succeeding — 1,404,804,682 bytes in 49.5 s**. The crash's last progress
  checkpoint was `after refGraph, before openProjectWriter`, placing it inside
  `writeSessions` rather than `buildSessionRefGraph`.
  NOTE the WASM heap was never the constraint here: it is capped at
  2 GiB (`getHeapMax` in `lib/h5wasm/h5wasm.iife.js`) and only ever holds
  ~300 MB on this path — the "hard ~4 GB WASM32 ceiling" diagnosis in PR #185 is
  wrong. Four patched sites, all marked `// LUCID local patch (luc3d #185)`;
  `createGzipFloatMatrix` is retained because the `embeddings/*` writer still
  uses it. The sink **throws on overflow** rather than letting an undercount
  silently truncate 3D points (out-of-range typed-array writes are discarded
  with no error). Guarded by `tests/e2e/save-session-3d-typed-sink.mjs` (exact
  values incl. null rows / null coords / missing point scores, plus a
  4,000-frame-group interleaved user+predicted scenario); those assertions were
  validated against the pre-patch writer first, so they pin equivalence rather
  than just current behavior. **Re-apply after any re-vendor** (grep the marker)
  and report upstream to sleap-io.js.
  **OBSOLETE PATCH (issue #134):** the old inline-points-fallback patch to
  `serializeInstanceGroup` is **gone and must NOT be re-applied.** SLP 2.8 (0.5.5)
  replaced the inline `frame_group_dicts` serializer with the columnar
  `/session_data` writer, so `serializeInstanceGroup` no longer exists in the bundle
  and no 2D/3D is duplicated into `sessions_json` (the whole #134 failure class is
  structurally gone). `tests/e2e/save-no-inline-dup.mjs` now guards the 2.8 columnar
  layout instead. The read/write split:
  - **Read** (`parseSlpViaSleapIO`, `import-export/file-io.js`): drives
    `readSlpStreaming` (#196) and adapts the typed `Labels` into LUCID's `slpData`
    shape. Grouping is rebuilt from the **typed `RecordingSession`** by
    `reconstructInstanceGroupsFromSession` (`slp-import.js`) — reads LUCID's legacy
    inline `frame_group_dicts`, the canonical `sessions_json`, AND the SLP 2.8
    columnar `/session_data` (the reader dispatches on which is present). The raw worker (`parseSlpH5`) stays
    for SLEAP analysis `.h5` and as a fallback (`parseSlpForImport` dispatches; that
    path still uses `reconstructInstanceGroupsFromDicts`).
  - **Write** (PR 5.2): export is **raw `saveSlpToBytes(labels)`** — the old
    `convertSlpToV06Compatible` v0.6-compat post-pass is **deleted**. The typed graph
    `buildSlpLabelsAllViews` builds carries all LUCID state (RecordingSession /
    FrameGroup / InstanceGroup with `instance3d`, `identity`, and `metadata.lucid`
    incl. per-session `identityId`), so `saveSlpToBytes` (and the streaming
    `openSlpWriter`) emit the **SLP 2.8 columnar `/session_data`** (3D points +
    grouping) plus a **slim `sessions_json`** (calibration + video map + session
    metadata + fg range) that the typed reader round-trips. Reads back natively in
    SLEAP >= 1.6 (sleap-io >= 0.7, flat-matrix `field_names` interop; the 2.8
    `/session_data` needs sleap-io >= the #546 release). *Interop gate:
    `scripts/validate_slp_sleap_compat.py` (needs a SLEAP Python env).*

  All h5wasm is now LUCID's local vendored 0.10.3 (PR 5.2b): the importmap `h5wasm`
  → local ESM, the `index.html` `<script>` global + `readSlpStreaming`'s `h5wasmUrl`
  → local IIFE, and the module workers import the local ESM — no CDN h5wasm fetch on
  any path. To bump the sleap-io.js bundle to a **released** version, vendor from the
  npm dist: `npm pack @talmolab/sleap-io.js@<ver>`, then copy `dist/index.browser.js`
  + its chunk closure (trace `index.browser.js` imports; keep the `gdrive` chunk +
  local `mediabunny-stub.js`) into `lib/sleap-io/`, dropping any orphaned old chunk.
  Verify the `index.browser.js` export set + importmap bare-imports (h5wasm/mediabunny/
  pako/yaml) are unchanged, then run the suite. `scripts/revendor-sleap-io.sh <ref>`
  builds from source instead (for unreleased pins); the detailed recipe + SHA-256
  manifest live in the untracked `scratch/VENDORING-sleap-io.md`.
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
