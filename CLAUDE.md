# LUCID — Label Unification and Correspondence in 3D

Multi-view pose annotation GUI. No build system — pure vanilla JS served as static files.

## Architecture
ES modules, vanilla JS (no build step). `index.html` loads `app.js` as `<script type="module">`; `app.js` is a 2-line entry point that imports from `pose/`. The 50 modules are grouped into four directories:
- `pose/` — data model, cross-view tracking, DLT triangulation, plane annotation model (planes + the global plane-node pool), plane/origin serialization, origin transform, app initialization (10 files)
- `ui/` — UI state, canvas rendering, mouse/keyboard interaction, info panel, modals, timeline, 3D viewport, video encoding, video display settings, plane definition, origin definition, settings (25 files)
- `loading/` — video decoding, session loading, SLP/package readers, web workers (6 files)
- `import-export/` — file I/O, save/load, SLP import/merge, visibility metadata, plane metadata (9 files)
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
- dockview-core **pinned to 6.6.1** in THREE places (`index.html` CSS +
  `ui/sessions-panes.js` ESM import + `ui/overlay-export-modal.js` ESM import —
  keep all three in sync). 7.x renamed `api.onUnhandledDragOverEvent`
  → `onUnhandledDragOver`, so an unpinned `/+esm` import silently breaks pane
  docking whenever the CDN cache refreshes. Audit the dockview API usage in
  `ui/sessions-panes.js` and `ui/overlay-export-modal.js` before bumping past 6.x.
  **`ui/overlay-export-modal.js` additionally depends on dockview INTERNALS** for
  its sash resizing: `Gridview.root`, node `children`/`element` (walked to find the
  branch owning the sash **and its parent**, which is what lets a row divider move
  that boundary in every column), `BranchNode.splitview`,
  `Splitview.viewItems`/`sashes`/`layoutViews()`/`distributeEmptySpace()`/
  `saveProportions()`, and `viewItem.enabled`. These are TypeScript-private but real
  and unmangled in the 6.6.1 `/+esm` build. They are all feature-detected, so a bump
  degrades to dockview's stock neighbour-only drag rather than breaking resizing —
  but `tests/e2e/overlay-export-sash-distribute.mjs` **and**
  `tests/e2e/overlay-export-sash-tracking.mjs` will go red, which is the
  intended signal. Run BOTH: the first only drags sash 0 of a flat axis and is
  structurally blind to cursor tracking and to the nested grid; the second covers
  exactly those. `styles.css`'s `#ovDock` block also depends on dockview's group
  DOM (`.dv-groupview` > `[.dv-tabs-and-actions-container][.dv-content-container]`)
  and on `--dv-tabs-and-actions-container-height`.
- mp4box.js
- **Video export = mediabunny, via `ui/video-encode.js` — the app's one encoding
  seam.** sleap-io.js has NO browser encoder (its `renderVideo()` shells out to a
  native `ffmpeg` and is Node-entry-only; its docs say "there is no encoder in the
  JS port"), so encoding is the one part of the video pipeline LUCID owns. It is
  built on mediabunny — the same library sleap-io.js uses for DECODE, already
  vendored in full — so both directions share one dependency. This **replaced
  `lib/mp4-muxer/` (5.2.1), now deleted**, and the hand-rolled WebCodecs
  `VideoEncoder` plumbing that was duplicated in `ui/overlay-export-modal.js` and
  `ui/export-modals.js`. Do NOT reintroduce a second muxer. Encoder contracts that
  are not compile-checked (keyframe interval in SECONDS, `fastStart: 'reserve'`
  needing `maximumPacketCount`, `finalize()`/`cancel()` closing the target's
  WritableStream) are listed in `lib/mediabunny/PROVENANCE.txt` — re-verify them on
  any mediabunny bump. Large exports stream to a picked file/folder; small ones
  still just download (`shouldStreamToDisk`, 256 MB).
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
  aliased in the `index.html` importmap (and `tests/test-runner.html`). Note
  `mediabunny` is now load-bearing for **video export too** (`ui/video-encode.js`,
  see above), so a bump risks BOTH decode and encode — keep the 1.30.0 pin unless
  you mean to retest both. LUCID
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
  **LOCAL PATCH (luc3d #189):** the **read-side mirror** of #185, plus the write
  side's other half. LUCID's `InstanceGroup.points3d` is now a flat
  `Float64Array(3N)` (see MODULES.md `pose/pose-data.js`), and the bundle was
  patched to speak that representation end to end:
  - **Read** — `lib/sleap-io/chunk-H7G4PJNA.js` `reconstructColumnarFrameGroups`
    built one boxed `[x,y,z]` Array per keypoint out of `flat`, which is ALREADY
    a `Float64Array` from h5wasm. On the real project that is **7,976,985 boxed
    rows (~410 MB)** allocated in the pointer-compressed heap on *every reopen* —
    the load-side counterpart of the save OOM, and the reason reopening the
    1.4 GB project sat 8+ minutes in a GC death spiral at the ceiling. Now emits
    one compacted `Float64Array(3N)` per instance group (and a `Float64Array(N)`
    of point scores). Compacted rather than a `subarray` view because the
    predicted table is stride 4 (x,y,z,score) and a view would pin the whole
    multi-hundred-MB matrix alive for as long as any one group survived.
    `Instance3D.nVisible` was patched to handle the flat form too.
  - **Write** — `chunk-X76PRJK6.js` gained `Float64RowSink.pushFlat` (flat-to-flat
    row copy, no boxed intermediate) and `lucidCount3dRows` (keypoint count for
    boxed OR flat), used by both the #185 counting pre-pass (`_p.length` would
    otherwise over-count 3x on a flat array and mis-size the sink) and the write
    loop. Both boxed and flat inputs are still accepted.
  Six patched sites across the two chunks, all greppable as `luc3d #189` (the
  shared write loop is marked `luc3d #185/#189` since both patches touch it).
  **Re-apply after any re-vendor** (grep the
  marker) and report upstream to sleap-io.js. Guarded by the flat-shape
  assertions in `tests/test-slp-export-canonical.js`, `tests/test-lazy-reopen.js`
  and `tests/test-slp-streaming-write.js`, and at the byte level by
  `tests/e2e/save-golden-digest.mjs` (the conversion is numerically bit-exact, so
  the digest MUST NOT move).
  **LOCAL PATCH (luc3d #190):** `lib/sleap-io/chunk-X76PRJK6.js` `writeSessions`
  accumulates the `/session_data` **struct** tables (`frame_groups`,
  `instance_groups`, `instance_group_members`) into growable flat
  `Float64GrowSink`s instead of pushing one boxed `Array` per row and holding
  them all live until `createMatrixDataset` flattens them — the same fix #185
  applied to the 3D-point tables, extended to the struct tables. On the real
  project that is 531,799 + 531,799 + **2,627,453** rows. `instanceGroupMemberRows`
  gained an allocation-free twin, `instanceGroupMemberRowsInto`, that appends
  straight into the sink (the original is retained as module surface — **keep the
  two in sync**). Measured with `tests/e2e/_bench-writesessions.mjs` at 400,000
  groups / 2,000,000 members: writer peak heap **1,190 MB -> 1,008 MB** and write
  time 3,767 -> 3,285 ms; ~240 MB at the real project's scale. Time was never the
  problem — that bench shows `writeSessions` is **linear** (25.2 -> 9.4 us/group
  as fixed costs amortize) — this targets the allocation, because the writer's
  ~1 GB of temporaries landing on top of an already-large baseline pushes the
  renderer past its hard ~4 GB cap into a GC death spiral (a save that ran 30+
  minutes without finishing). Six patched sites plus `Float64GrowSink` /
  `createMatrixDatasetTyped`, all marked `// LUCID local patch (luc3d #190)`.
  Flushed bytes are unchanged — guarded by `tests/e2e/save-golden-digest.mjs`.
  **Re-apply after any re-vendor** (grep the marker) and report upstream.
  **LOCAL PATCH (luc3d #191):** `lib/sleap-io/chunk-X76PRJK6.js` `writeSessions`
  now **flushes the `/session_data` tables incrementally** instead of holding a
  whole table live until one `create_dataset` call. #185/#190 made those rows
  *typed*; they did not change the *shape* of the peak — every row still had to be
  resident at once, which at the real project's scale is `frame_groups` 4.3 MB +
  `instance_groups` 34 MB + `instance_group_members` 63 MB + `points_3d` 191 MB
  ≈ **292 MB**, plus a same-sized copy into the WASM heap at flush time, plus up
  to 2x for the doubling grow-sinks. That fits under the ~2,891 MB baseline a
  fresh Track All + Triangulate All leaves — so the **first** save succeeds — but
  NOT under the measured **4,156 MB post-reopen** baseline, where the renderer
  dies inside save phase 2/4 (`writeSessions`). These are exactly the allocations
  a large committed-but-dead V8 cage cannot absorb: typed-array backing stores and
  h5wasm's heap live *outside* the pointer-compressed cage, so they add to total
  process memory even when the cage has GBs of dead space (see
  [[luc3d-save-oom-is-v8-heap-not-wasm]] and the #189/#190 notes). New
  `LucidAppendTable` stages at most `SESSION_FLUSH_ROWS` (= `WRITE_CHUNK_ROWS`,
  8192) rows in a **fixed, reused** buffer and `write_slice`s them into a
  chunked/unlimited-`maxshape` dataset, making the writer's peak for these tables
  **constant in project size**. Three consequences: the #185 counting pre-pass is
  **gone** (nothing needs pre-sizing — also removes a full extra walk); datasets
  are created **lazily on first flush**, so a table that never gets a row stays
  absent (`pred_points_3d` on a user-only project), preserving the old
  `if (rows > 0)` guards; and a table that **never overflows** is still written
  one-shot and contiguous, so small projects stay **byte-identical** and
  `tests/e2e/save-golden-digest.mjs` **MUST NOT move**. Guarded by
  `tests/e2e/save-session-3d-typed-sink.mjs`, whose many-group scenario was raised
  to 12,000 frame groups specifically so every table crosses a flush boundary and
  the append path's running `[start, end)` bookkeeping is under test (it asserts
  `NFG > 8192` so the coverage can't silently lapse). `createMatrixDatasetTyped` /
  `Float64GrowSink` / `Float64RowSink` / `createGzipFloatMatrixTyped` are retained
  as module surface but are no longer used by `writeSessions`. All sites marked
  `// LUCID local patch (luc3d #191)`. **Re-apply after any re-vendor** (grep the
  marker) and report upstream.
  **LOCAL PATCH (luc3d #193):** `lib/sleap-io/chunk-X76PRJK6.js` builds the lazy
  store's **columns as `Float64Array`s instead of plain JS arrays**. This is the
  fix that actually made **save-after-reopen** work; #185/#189/#190/#191 were
  necessary but not sufficient. LUCID writes `frames`/`instances`/`points`/
  `pred_points` as **flat 2D matrices + a `field_names` attr**, while Python
  sleap-io writes them as **HDF5 compound dtypes** — and those two shapes take
  different column builders in the vendored reader:
  compound → `readCompoundColumnsWorker`, which has **always** produced
  `Float64Array` columns (its own comment: *"every SLEAP field — coords, scores,
  and integer id/index columns up to 2^53 — is exact in f64"*); flat+`field_names`
  → `normalizeStructData` (streaming/lazy reader) and `normalizeStructDataset`
  (non-streaming), which built `[]`/`new Array(n)`. **So reopening LUCID's own
  project was the one path that materialized every column as boxed numbers.**
  Measured on the real project with `tests/e2e/_diag-post-reload-bytes.mjs`: the
  reopened project's ONE shared store held **24 columns / 228,108,600 entries ≈
  1.8 GB inside V8's pointer-compressed cage** (5 `frames` + 10 `instances` + 4
  `points` + 5 `pred_points` fields). The save **cannot** evict it — pass 2
  (`streamSessionIntoWriter`/`appendStore`) streams 2D straight out of that store —
  so `openProjectWriter` opened with essentially no headroom and the renderer died
  in phase 2/4. Typed columns hold the same 8 B/element in a backing store
  allocated **outside** the cage, moving ~1.8 GB off the scarce resource (same
  argument as #185/#190 on the write side, #189 on the read side). **f64
  deliberately, not f32:** `point_id_start/end` reach 21.7M on this project and f32
  is exact only to 2^24 = 16.7M — the sleap-io.js#231 failure class. Both sites
  also convert explicitly when the source is a `BigInt64Array` (LUCID writes
  `frames` as `"<i8"`): assigning a BigInt into a `Float64Array` throws, and
  `readStructDatasetStreaming`'s catch-all would have **swallowed** that into a
  silently EMPTY store. Verified end to end on the real 180,210-frame × 5-camera
  project: reopen → edit → Save As previously crashed the renderer inside phase
  2/4 every time; it now completes — phases 5.9 s / 15.2 s / 15.0 s / 105.9 s,
  **1,405.1 MB in 142 s** — and the resaved file reopens. Written bytes are
  unchanged (`save-golden-digest.mjs` does not move). Guarded by
  `tests/e2e/reopen-store-columns-typed.mjs`, which was confirmed to FAIL on the
  pre-patch bundle (naming all 24 plain-array columns) while its value assertions
  pass in both states — so it pins the memory shape, not just current behavior.
  Two patched sites, marked `// LUCID local patch (luc3d #193)`. **Re-apply after
  any re-vendor** (grep the marker) and report upstream.
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

## Session-scoped Visibility settings in `metadata.lucid`

The Visibility panel's **session-scoped** state persists per session in the
`.slp`, under LUCID's own `metadata.lucid` dict: `videoBrightness`,
`videoContrast` and `videoRotation` (each `{ cameraName: int }`) plus
`hiddenCameras` / `hiddenTracks` / `hiddenIdentities` (sorted name arrays).
Everything goes through **one** module, `import-export/visibility-metadata.js`
(`writeVisibilityMetadata` / `readVisibilityMetadata`, `VISIBILITY_METADATA_KEYS`),
which the four writers and three readers all call — adding a setting means
touching that file and nothing else.

Three rules hold, and there are tests pinning each:
- **Defaults are never written.** Every key is omitted at its default, so a
  project nobody adjusted is byte-identical to one saved before these settings
  existed — `tests/e2e/save-golden-digest.mjs` must not move.
- **Nothing else in `metadata.lucid` is touched** (`sessionName`, `tracks`,
  `identities`, `skeleton`, `frameIdentityMap`, `trustTracks`, `identityId`, …).
- **Purely additive to the format.** These are optional keys in a dict sleap-io
  and sleap-io.js round-trip as opaque JSON, so files stay SLEAP-GUI readable and
  no other `.slp` import/export path changes.

The panel's **global appearance preferences** (User / Predicted / Reprojections /
Display Legend / 3D Viewer) deliberately stay in
`localStorage.visibilitySettings` — they are browser-local display taste, not
project state. Do not move them into the `.slp`.

Coverage: `tests/test-visibility-metadata.js` (unit) and
`tests/e2e/visibility-settings-roundtrip.mjs` (real app, both writers);
`tests/test-video-contrast.js` + `tests/e2e/contrast-slider-roundtrip.mjs` cover
the contrast half.

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

## Define Planes state in `metadata.lucid`

The whole Define Planes pipeline persists per session in the `.slp` (and in the
project JSON), under LUCID's own `metadata.lucid` dict, through **one** module —
`import-export/plane-metadata.js` (`writePlaneMetadata` / `readPlaneMetadata` /
`resetPlaneState`, `PLANE_METADATA_KEYS`), which the same four writers and three
readers as the Visibility settings all call. The mapping itself lives in the
DOM-free `pose/plane-serialization.js`.

The four keys split by SCOPE, and getting that split wrong is the failure mode:
- **Project-scoped** — `planeNodes` (the global pool, in pool order), `planes`
  (membership, edges, fill, the triangulation summary, the plane fit) and
  `planeOrigin` (the applied origin frame, written as its two INPUTS — the
  origin point and the chosen +Z — and rebuilt by `buildOriginFrame` on load).
  These are written **identically into every session's dict**, and read back by
  whichever session is ingested first.
- **Session-scoped** — `planePlacements`, the per-view 2D. It lives on
  `Session.planePlacements`, and must not leak between sessions.

Rules, each with a test pinning it:
- **Defaults are never written.** A project that never opened Define Planes
  carries none of the four keys, so `tests/e2e/save-golden-digest.mjs` must not
  move.
- **Nothing else in `metadata.lucid` is touched**, exactly as with the
  Visibility keys.
- **Points and plane membership are addressed BY NODE ID, never by index.** The
  pool's order is the index space every `PlaneInstance` is keyed by, so a
  count-based restore silently re-seats every column past a mid-pool edit onto
  its neighbour's node with every point still looking valid. `adoptNode` /
  `adoptPlane` keep the file's IDs rather than re-minting them.
- **Every load path must call `resetPlaneState()` first.** `readPlaneMetadata`
  only restores into an EMPTY model (that guard is what makes ingesting N
  sessions idempotent), so skipping the reset keeps the OLD project's planes and
  silently drops the new one's.
- **Every plane/node mutation calls `markDirty()`** — rename, re-colour, pin,
  place/un-place, membership, edges, fill, triangulate, fit, 2D/3D drags, origin
  apply/clear. Per mutation, not per repaint. The plane panel's node-size /
  edge-width / 3D-corner-size sliders are the deliberate exception: browser-local
  display taste, not written to the project, so they do not mark it dirty.

Coverage: `tests/test-plane-serialization.mjs` (unit, the mapping) and
`tests/e2e/plane-persistence-roundtrip.mjs` (real app, both `.slp` writers, the
dirty flag, the scope split, and both negative controls).

## UI Conventions
**Defining Plane Mode blocks the pose-annotation toolbar.** `+ Instance`,
`- Instance`, `Group`, `Edit Group`, `Triangulate`, `Triangulate All`,
`Track Frame` and `Track All` are disabled while the mode is on
(`applyPlaneModeToolbarLock` in `ui/plane-definition.js`) — they act on POSE
annotation, which in the mode is a selection the user can no longer see or
change. The **visibility** controls (User / Predicted / Reproj / Errors),
Sessions, Color and Hide Panel stay live: they change what is DRAWN, not what
is annotated. Adding a button to that lock means adding its id to
`PLANE_LOCKED_TOOLBAR_IDS`; if it opens a menu, its wrapper also needs
`PLANE_LOCKED_DROPDOWN_IDS` (a `.tri-dropdown` menu opens on hover and its
items are `div`s, so `disabled` on the button reaches neither).
NOTE the keyboard shortcuts for these actions (`n`, `t`, `Shift+T`,
`Mod+Shift+T`, `Shift+g`, `Delete`) and the Edit / Analysis menu items are
**not** gated yet — they still reach the same handlers.

**Modals must close on `Esc`** unless explicitly stated otherwise. When building
or editing any modal/overlay dialog, wire a `keydown` listener that closes it on
`Escape` (and removes the listener on close). For a modal mid-operation (e.g. an
in-progress export), `Esc` should cancel/stop that operation rather than tear the
modal down. Example: `showExport3DVideoModal` in `ui/export-modals.js`.

## Tests
There are **three** test populations, each with its own runner. Run all three —
they cover disjoint code, and a green run of one says nothing about the others.

```bash
node tests/e2e/run-unit-tests.mjs     # tests/*.js  (browser suite, headless) — 1406 assertions
node tests/run-mjs-tests.mjs          # tests/test-*.mjs  (native-ESM Node tests)
node tests/e2e/<name>.mjs             # tests/e2e/*.mjs  (Playwright, one file per behavior)
```

- `tests/*.js` — classic scripts, run in the browser via `tests/test-runner.html`
  (open directly) or headless via `tests/e2e/run-unit-tests.mjs`; also runnable in
  a `vm` sandbox by `tests/run-node.js`.
- `tests/test-*.mjs` — native ES modules, run by **`tests/run-mjs-tests.mjs`**
  (one child process per file, since several install module-loader hooks). These
  were **orphaned for a long time**: no runner referenced them, so four had been
  failing unnoticed — including a live `ReferenceError` in `pose/tracker.js` and
  three files still asserting pre-luc3d-#185 shapes (boxed `Instance.points`,
  boxed `points3d` rows, legacy string `frameIdentityMap` keys). **If you add a
  `tests/test-*.mjs`, it is picked up automatically; do not add ESM tests
  anywhere else.**
- `tests/e2e/*.mjs` — Playwright, drive the real app. `_diag-*`/`_bench-*`/
  `_real-*` are investigation tools, not assertions, and are excluded from suite
  runs. Notable:
  - `sequence-lazy-workflow.mjs` — **the lazy-project regression harness.** Builds
    a synthetic project big enough (in FRAME COUNT) to come back mostly
    non-resident, then drives real sequences — reopen → Triangulate All → save →
    reopen → modify → save → reopen → export → swap → save → reopen — asserting
    invariants after every step. This is what catches the resident-only bug class
    (#194/#195), where an operation silently processes a handful of frames,
    returns a plausible count, and only shows up a cycle later once the wrong
    state has been saved. `FRAMES=`/`CAMS=`/`NODES=`/`KEEP=1` are configurable; it
    asserts its own lazy precondition so it cannot silently stop testing that.
  - `video-encode-streaming.mjs` — the **only** coverage of the streaming video
    export path. Headless Chromium exposes `showSaveFilePicker()` but rejects it
    instantly with `AbortError`, so neither video modal can reach that path under
    automation; this drives `ui/video-encode.js` directly with a stand-in file
    handle and asserts the bytes (position-based writes, `moov` before `mdat`).
    If you touch video encoding, run this — the modal tests only exercise the
    buffered path.
  - `overlay-export-modal.mjs` / `export-3d-video.mjs` — the two video modals
    end to end, each asserting a real `.mp4` whose `avc1` sample entry carries the
    promised dimensions.
  - `_real-roundtrip.mjs` — the real-data acceptance run (needs a large `.slp`);
    `RELOAD_FILE=`, `MODIFY_RESAVE=1`, `KEEP_RESAVE=1`, `ATTRIBUTE=1`.

## Python Scripts
- `scripts/json_to_slp.py` — Convert JSON export to SLEAP .slp format
- `scripts/json_to_h5.py` — Convert JSON export to HDF5 format
- Require: h5py, numpy
- `scripts/validate_slp_sleap_compat.py` — Assert LUCID-exported `.slp` files are
  SLEAP-GUI compatible (load via `sleap_io`, non-empty tracks, optional
  `--compare` against a native SLEAP-GUI export, and `--metadata-roundtrip` to
  assert `metadata.lucid` — including the session-scoped Visibility settings —
  survives a `sleap_io` load + re-save unchanged). Headless half of `lucid-e2e`
  Stage 4; run via `uv run python` from the SLEAP repo, or standalone with
  `uv run --with sleap-io --with numpy --with h5py python …`.

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
