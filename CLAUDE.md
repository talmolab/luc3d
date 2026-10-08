# LUCID — Label Unification and Correspondence in 3D

Multi-view pose annotation GUI. No build system — pure vanilla JS served as static files.

## Architecture
ES modules, vanilla JS (no build step). `index.html` loads `app.js` as `<script type="module">`; `app.js` is a 2-line entry point that imports from `pose/`. The 107 modules are grouped into four directories:
- `pose/` — data model, cross-view tracking, DLT triangulation (the pure math in `triangulation-core.js`, solved in parallel by `triangulation-pool.js` + `triangulation-worker.js`), plane annotation model (planes + the global plane-node pool), 3D mesh objects (groups of planes) and their derived geometry, plane/origin serialization, origin transform, whole-project origin re-base, cross-session calibration comparison, plane-to-plane angle, the least-squares plane fit, multi-view display alignment (`view-align.js`), the ID-switch checks by body size and images (`id-switch-check.js`), the lazy project's playback eviction (`lazy-residency.js`), SLEAP's single-camera tracker ported from sleap-nn (`sleap-tracker.js`) and single-camera Track All + its ID-switch checks (`single-camera-tracking.js`), app initialization (24 files)
- `ui/` — UI state, canvas rendering, mouse/keyboard interaction, info panel (and its lazily-filled Track dropdown), modals, timeline, 3D viewport, panel visibility, video encoding, video display settings, keyboard-target arbitration, modal geometry, view legend, plane definition, 3D mesh objects, origin definition, origin re-base, cross-session calibration notice, plane angle, frame-range tracking, collapsible section state, info tooltips, plane visibility, browser-specific hints, the loading overlay + its progress bar, the Align Views to References dialog, the seekbar hover tooltip, the status bar's whole-project frame counters, the controls bar's time / frame readout, the Tracks / Identity coloring setting, the node-trail lengths (`trail-presets.js` — presets or a custom value typed in seconds or frames, stored in seconds, drawn as `seconds × fps` frames), the Check ID Switches runner + ID Switches panel tab (and its saved review checklist), its seekbar ticks and in-view highlight, its image embedder and its crop and CPU-model workers, its coat-brightness sampler, the Track All summary box (`track-summary.js` decides what it says, `track-summary-modal.js` renders it), settings — the Define Planes panel is split across `plane-definition.js` (the hub) plus its three section modules and three helpers (62 files)
- `loading/` — video decoding, unplayable-codec diagnosis, session loading, SLP/package readers, per-camera SLP choice, calibration-file selection, video-file selection, the per-camera track-list union (`session.tracks` for a per-camera folder), web workers (11 files)
- `import-export/` — file I/O, save/load, SLP import/merge, visibility metadata, plane metadata, 3D mesh export (10 files)
- `demo-data.js` — synthetic skeleton and camera data
- `styles.css` — all styling

See `MODULES.md` at the repo root for per-module details (purpose, exports, imports/dependents).

## Local Development
```bash
python3 server.py 8080            # Windows: py server.py 8080
# Or: python3 -m http.server 8080  (no --offline support)
# App: http://localhost:8080/
# Tests: http://localhost:8080/tests/test-runner.html

python3 scripts/offline_deps.py install && python3 server.py --offline
```

## Deployment

`luc3d.sleap.ai` is a GitHub Pages **custom domain** for this repo, not a separate
host — `talmolab.github.io/luc3d/` 301-redirects to it, and the `CNAME` file at the
`gh-pages` root is what makes Pages answer for that name. Cloudflare proxies it;
the origin is Pages.

`deploy.yml` maintains five channels on `gh-pages`. There is no build step, so a
"build" is a copy of the repo at some ref, and the app is **sub-path safe**
(relative importmap, `document.baseURI` in the test harness) — which is why one
tree serves correctly from every path. Do not introduce origin-root-relative URLs
(`/lib/...`); they 404 on every channel but root.

- `/` — **the live page.** Newest **full release**; the only place it is served.
- `/stable/` — an **alias** that redirects to root. A lone `index.html`, not a
  copy, so a deep link under it (`…/stable/tests/…`) 404s.
- `/latest/` — newest release **including pre-releases**. A real copy.
- `/dev/` — every push to `main`. A real copy.
- `/pr/<n>/` — PR previews, owned by `pr-preview.yml`. `deploy.yml` never touches them.
  Removed again when the PR closes — by a step that **re-syncs and retries** its
  push, like `deploy.yml`'s. Both workflows push to `gh-pages` under different
  concurrency groups, and a merge to `main` starts the `/dev/` deploy and the
  preview cleanup in the same second; a single checkout-then-push lost that race
  so often that 23 merged/closed PRs' previews were left on the live site. Any
  new step that pushes to `gh-pages` needs the same loop.

**Only a full release moves root.** A push to `main` goes to `/dev/` alone; a
pre-release goes to `/latest/` alone; republishing an older release moves nothing
(release channels only ever move forward). The same run refreshes the `/stable/`
alias, so the two can never point at different builds — there is only one build.
`workflow_dispatch` with target `root` is the manual promote escape hatch; it
writes root *and* the `/stable/` alias in one run, exactly as a release does.

A target with a non-empty `redirect` is written as an alias (one `index.html`
whose target is **relative**, so it stays correct under the custom domain,
`talmolab.github.io/luc3d/` or a PR preview) instead of a copy of the app.
GitHub Pages cannot issue a real HTTP redirect — no `.htaccess`, no
`_redirects` — so a meta-refresh/JS stub is the only mechanism available.

**Every deployed copy is version-stamped.** Both workflows run
`scripts/stamp-version.mjs <dir> <commit>` on the staged copy (never on the
repo): every same-site code reference — relative imports, `new URL('…js', …)`
worker URLs, `<script src>`, stylesheet `<link>`s, importmap entries — gets
`?v=<commit>`. Cloudflare serves `.js`/`.css` with a 4-hour lifetime in browsers
AND per data centre, while `index.html` is revalidated within minutes; without the
stamp a visitor could run a new `index.html` with old modules for hours (seen on
PR #249's preview, even in Incognito). An ES module's identity is its URL, so the
stamp must be all-or-nothing: the script fails the deploy if any relative module
reference is left unstamped (that module would load twice). Keep code references
literal and relative — a computed `import(someVar)` or a root-absolute `/x.js`
would defeat it. Covered by `tests/test-stamp-version.mjs` and
`tests/e2e/stamped-build.mjs` (stamps the working tree, loads the app — every
module once — and runs the browser suite on it).

**Root is the only target that wipes — two rules keep that safe.** Every other
channel owns its folder and can only damage itself, but root's previous output
sits at the top of `gh-pages` beside every other channel and every PR preview:

1. **Adding a channel means adding it to the keep-list** — the
   `find . -maxdepth 1 ... ! -name` in `apply_targets`. A channel missing from
   that list is deleted by the next full release. `stable` is listed for exactly
   this reason, as are `.git` and `CNAME`.
2. **Root is requested by an explicit `root: true` flag, never an empty path.**
   The empty/`.`/`/` refusal is deliberately kept so an unset variable still
   cannot turn `rm -rf "$path"` into `rm -rf` of everything.

`CNAME` is excluded from the wipe and recreated if missing — losing it breaks the
custom domain for everyone. No `.nojekyll` is added, since that would change how
the live root is served and the app has no `_`-prefixed files.

Releases are cut **by hand** (`gh release create v0.1.0 --generate-notes`).
That is deliberate: a release created in Actions with `GITHUB_TOKEN` does not
fire `release: published`, so a helper workflow could not trigger the deploy.
Tags must be `vX.Y.Z` or `vX.Y.Z-N` (numeric pre-release), matching sleap-app.

## Offline mode

Four dependencies still load from jsdelivr (three.js, mp4box, dockview-core,
yaml); everything else under `lib/` is committed. **`offline-deps.json` is the
single source of truth** for their versions, npm tarball URLs, registry integrity
hashes, extracted file lists, and which CDN URL each local path replaces. Three
consumers read it, so the table exists exactly once:

- `scripts/offline_deps.py` (`install` / `check` / `bundle` / `clean`) — stdlib
  only, so offline setup needs no Node, curl, tar or Git Bash. Packages land in
  **gitignored** `lib/<pkg>/`, each keeping a tracked `.gitignore` +
  `PROVENANCE.txt` so `lib/` still documents what belongs there. Downloads honor
  `LUCID_NPM_REGISTRY` for institutional mirrors.
- `server.py --offline` (or `LUCID_OFFLINE=1`) — rewrites the mapped URLs in
  served `.html`/`.js`/`.mjs`, so the working tree keeps its CDN URLs and nothing
  is committed by accident. Refuses to start if a package is missing. **It must
  cover `.js`:** two of the six references are ESM imports inside
  `ui/sessions-panes.js` and `ui/overlay-export-modal.js`, not HTML tags.
- `offline_deps.py bundle` — stages a copy with the URLs **already rewritten**,
  so the zip runs under any static server. That is what keeps Python off the end
  user's machine; the bundle ships `start-windows.ps1` (PowerShell, preinstalled)
  plus `start-macos.command` / `start-linux.sh` (python3, else Ruby WEBrick).

Rewritten paths are **depth-relative** (`./lib/…` at root, `../lib/…` from
`tests/`), never origin-root-relative — the gh-pages sub-path rule applies here too.

Two guards, because this rots silently otherwise:

- **`check`** re-derives the dockview pin rather than trusting prose: any
  `cdn.jsdelivr.net/npm/<pkg>@<ver>` in source that disagrees with the manifest
  fails. The "pinned in THREE places" rule below is now enforced, not just documented.
- **`check --strict`** fails on any CDN URL outside `lib/` the manifest does not
  map, so a newly added CDN import cannot quietly break offline mode. A URL that
  is deliberately not mapped goes in the manifest's **`unmapped`** block with a
  reason — an allowlist, so the guard keeps failing on URLs nobody has considered.
- **`tests/e2e/offline-server.mjs`** boots the app with every non-localhost
  request *aborted* (not throttled — that would still hit the HTTP cache) and
  asserts THREE/OrbitControls/MP4Box/h5wasm/dockview-css/`yaml` all resolved. It
  skips cleanly when the packages are absent. Confirmed to fail without
  `--offline`, so it pins behavior rather than the current state.

`lib/sleap-io/chunk-X76PRJK6.js`'s `MP4BOX_CDN` (unpkg mp4box@0.5.4) is
deliberately **not** mapped. Its `loadMp4box()` returns `globalThis.MP4Box`
before reaching the fetch, and `index.html`'s mp4box script tag always sets that
global (from `lib/mp4box/` in offline mode) — so the unpkg fallback is
unreachable, which `tests/e2e/offline-server.mjs` confirms by asserting `MP4Box`
exists with all off-origin requests blocked. Mapping it would also silently
substitute the vendored 0.5.2 for the 0.5.4 it names. `--strict` skips `lib/`, so
it does not flag this. If the mp4box script tag is ever removed from
`index.html`, this becomes live: `await import("mp4box")` would throw (no
importmap entry) and fall through to unpkg.

**One feature does not work offline:** the image ID-switch check
(`ui/image-embedder.js`, Tracks ▸ Check ID Switches (Images)). Its
`TRANSFORMERS_URL` is in `unmapped`, because vendoring that URL would not be
enough — transformers.js then fetches the `onnx-community/dinov2-small` **weights
(44–88 MB) from huggingface.co** at runtime, so offline support means vendoring
the model as well and setting `env.localModelPath`. It is lazily imported by that
one opt-in command and nothing else touches it, so this degrades rather than
breaking the app. Offline, the dynamic `import()` currently throws a raw
"Failed to fetch dynamically imported module" instead of a reason string like
`runImage`'s other preflight gates in `ui/id-switch-modal.js`.

**Node-only `.mjs` is never rewritten** (`is_rewritable` in
`scripts/offline_deps.py`, shared by `bundle` and `server.py --offline` so the zip
and the served tree cannot drift). Every non-`lib/` `.mjs` in the repo is a test or
a tool — the browser-served ones all live under `lib/` — and
`tests/test-stamp-version.mjs` holds CDN URLs as **fixtures** asserting
`scripts/stamp-version.mjs` leaves absolute URLs alone, so rewriting it would
quietly invert what it checks. Same carve-out `stamp-version.mjs` itself makes.

Licenses for everything under `lib/` are in **`lib/LICENSES.txt`**, and each
package now carries its upstream `LICENSE` (previously none did — h5wasm's NIST
terms require the notice be kept intact and mediabunny is MPL-2.0). dockview-core
6.6.1 ships no LICENSE file upstream, so its MIT text is reproduced there.

## Dependencies (CDN by default, vendorable — see Offline mode)
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
- **transformers.js pinned to 4.3.0** (`ui/image-embedder.js`, `/+esm` from
  jsdelivr) + the `onnx-community/dinov2-small` model from the Hugging Face CDN —
  fetched only when the IMAGE ID-switch check first runs (opt-in, default off),
  then cached by the browser. Pinned for the dockview reason. The image check was
  calibrated against this model's embeddings of `cutCrop`'s crops: a bump of
  either, or any change to the crop, needs a recalibration (see MODULES.md
  `pose/id-switch-check.js`). An opt-in (`imageCheckWebNN`) also tries the
  same model on WebNN and keeps it only if a trial shows it faster AND
  consistent with WebGPU (see MODULES.md `ui/image-embedder.js`). **Without a
  hardware GPU it still runs**, on the CPU: the fp32 model (never the CPU
  runtime's default int8, which is what drifts from the calibration) in module
  workers, `ui/image-model-worker.js` — on the main thread one model run freezes
  the page for seconds, and onnxruntime's own `wasm.proxy` worker cannot start
  from the CDN bundle. ~15x slower than a GPU with 4 workers, ~600 MB each. A
  software WebGPU adapter (SwiftShader) counts as no GPU: it is 10x slower than
  one CPU worker. See MODULES.md `ui/image-embedder.js` "The CPU path".
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
  Covered by `tests/e2e/mediabunny-bframe-decode-order.mjs`. Its fixture video
  is committed through a `.gitignore` exception (`*.mp4` is otherwise ignored)
  and regenerated — together with its ground-truth PNGs, never separately — by
  `tests/fixtures/bframes-test/make_fixture.sh`.
  **LOCAL PATCH (luc3d frame-index):** `lib/sleap-io/chunk-X76PRJK6.js`
  `MediaBunnyVideoBackend.initialize()` walks `EncodedPacketSink.packets()` only
  to collect each packet's timestamp, but without options that walk **reads
  every packet's bytes — the whole file** (254–349 MB per HardFight_1kModels
  camera, ~2.3 GB for one 8-camera "Load Single Session Folder"). Patched to
  `packets(void 0, void 0, { metadataOnly: true })`: same packets, same order,
  same timestamps, payload read skipped. Per video ~120 ms -> ~28 ms alone; in
  the 8-camera load, where the decoders open in parallel and contend, all eight
  finish in ~0.46 s instead of ~1.04 s (load ~2.35 s -> ~1.8 s). Guarded by
  `tests/e2e/mediabunny-frame-index-metadata-only.mjs` (metadata-only == full
  walk, `Object.is` per timestamp and in order, plus backend index == full walk
  sorted; on a generated `-bf 3` B-frame video, and with `DATASET=` on real
  files). Marked `// LUCID local patch (luc3d frame-index)`. **Re-apply after any
  re-vendor** (grep the marker) and report upstream to sleap-io.js.
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
`hiddenCameras` / `hiddenTracks` / `hiddenIdentities` (sorted name arrays), plus
the ID Switches tab's review checklist, `idSwitchReview` (`ui/id-switch-review.js`;
absent unless a check left results on that session; it also records the switches
fixed from the tab, whose identity swaps are in the session data itself).
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

The panel's **global appearance preferences** (User / Predictions / Reprojections /
Planes / Display Legend / 3D Viewer) deliberately stay in
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

The five keys split by SCOPE, and getting that split wrong is the failure mode:
- **Project-scoped** — `planeNodes` (the global pool, in pool order), `planes`
  (membership, edges, fill, the triangulation summary, the plane fit),
  `meshObjects` (the named groups of planes — see below) and
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

## A lazy project's resident frames are a WINDOW — and eviction must be lossless

On a lazy project `session.frameGroups` holds the hydrated frames only. Playback
used to keep every frame it ever hydrated: the playback loader topped up 5,000
frames ahead and `evictLazyFrames` had no caller, so on the 8-camera
`05mice_flippers` project resident frames went 5,145 -> 31,600 over five 20 s runs
while the heap climbed toward the renderer's ~4.2 GB limit.
`pose/lazy-residency.js` now evicts during playback. Five rules:

- **Drop a frame only if re-hydrating it rebuilds EXACTLY what is resident**
  (`frameEvictionBlocker`, compared against `SioLazyLoader.describeStoreFrame`,
  which `tests/e2e/lazy-playback-eviction.mjs` pins to the real materializer).
  Anything only the resident frame knows keeps it: a user instance, a modified /
  backed-up / nulled one, a deleted or added row, a track changed only in memory,
  a #201 identity on a trackless instance, a skeleton-node change, a camera the
  loader does not back, or an object the InteractionManager holds.
- **A user instance ALWAYS pins its frame, group member or not.** A member does
  survive eviction (it lives in `instanceGroups` and comes back as the same
  object on a revisit), but the streaming save reads its 2D edit overlay from
  RESIDENT frames only (`buildSessionRefGraph`). Save while it is evicted and the
  store's original row is written instead — `sequence-lazy-workflow.mjs` cycle 7
  fails exactly that way with the `user`/`modified` blockers removed.
- **Never evict from `batchLoadLazyFrames`, and hold eviction during a sweep.**
  The sweeps hydrate a window and read it back after awaits; the protected
  windows follow the on-screen frame, not the sweep. `sweepLazyFrameWindows`
  holds residency for its whole run.
- **The playback lookahead IS the protected ahead-window** — one constant,
  `LAZY_PLAYBACK_AHEAD`, used by the loader and the eviction. Grow one without
  the other and playback evicts what it just loaded, then reloads it.
  `LAZY_KEEP_BEHIND` must stay above the longest node trail (500): trails draw
  resident frames only. A seek hydrates its target and the frames AHEAD, so
  the draw path fills the trail's window behind it (`ensureLazyTrailWindow`),
  and on a lazy project a non-resident frame ENDS the trail
  (`trailWindowFrames`' `residentOnly`). Skipping it instead joined every trail
  to frames still resident from before the jump.
- **Dropping a frame drops its derived reprojection caches too** — exactly the
  state Triangulate All leaves every frame in; the draw path re-derives them.

`session.instanceGroups` is NOT evicted, deliberately: it is the project's
grouping and 3D, bounded by project size rather than by playback, and the save
reads it whole. **Its members' 2D, though, goes back to the store** whenever
their frame stops being resident (`releaseFrameMembers2d`): after a Track All
every one of the 4,152,565 members held a private copy of its store row —
1.39 GB and ~4.2M ArrayBuffers for every full GC to sweep, which is what kept
post-Track-All playback degrading run over run. Three more rules:

- **The shared placeholder is never written.** Released members — and a
  reopened project's — all point at `lazyPlaceholderXY(numNodes)`; the three
  in-place writers on `Instance` call `_ownXY()` first. A new in-place writer
  must too, or one edit moves every lightweight member in the project.
- **Release only what re-hydration gives back exactly** (`member2dReleaseBlocker`):
  an untouched prediction on a non-resident frame, with no occlusion set and its
  store row present. Re-adoption keys on the member's CURRENT `_rawInstIndex`,
  never a cached row — store compaction renumbers released members too.
- **A reader of member 2D on a frame it does not hydrate must bracket the read**
  with `hydrateFrameMembers2d` / `releaseFrameMembers2d`. The image ID-switch
  check was the one such reader (`frameCropGeometry`, `ui/image-embedder.js`);
  reading the members directly found no keypoints on every such frame.

## Single-camera Track All is sleap-nn's tracker — keep it a faithful port

A session with ONE camera (a plain SLEAP predictions file opened with File ▸
Load SLP) has no cross-view matching and no 3D, so Track All runs SLEAP's own
tracker instead: `pose/sleap-tracker.js` is a port of `sleap_nn.tracking`
(talmolab/sleap-nn @ `3d21684419ca`), driven by `pose/single-camera-tracking.js`
in sleap-nn's known-count setup (`local_queues`, `max_tracks` = target count =
the animal count, connect single breaks). Rules:

- **It must give `sleap-nn track`'s answer, ties included.** OKS at sleap-nn's
  default stddev underflows to exactly 0 for poses ~1.5 body lengths apart, so
  ties are routine and whatever breaks them decides real tracks. That is why
  the port carries SciPy's `linear_sum_assignment` line for line, numpy's
  unstable argsort (`SMALL_QUICKSORT = 15`), CPython 3.11's set iteration order
  (`fixed_window`'s column order) and numpy's pairwise summation. Do not
  "simplify" any of them to a JS built-in: a stable sort or a different
  Hungarian is still optimal and still wrong. Measured identical on ~520,000
  real detections; `tests/test-sleap-tracker.mjs` compares every track id on a
  synthetic fixture tracked by upstream (regenerate it with
  `tests/fixtures/sleap-tracker/make_fixture.py` when moving to a newer sleap-nn).
- **It writes the TRACKS**, as sleap-nn does, plus one identity per track
  (`track_k` <-> `id_k`, identity following the track through the map) —
  unlike multi-camera Track All, which writes identities only. On one camera a
  track is the animal's identity and is what the saved `.slp` hands back to
  SLEAP; for the same reason an ID Switches tab Fix swaps tracks there.
- **The one deliberate departure is the default OKS tolerance: 0.1, not 0.025**
  (Tracking Wizard `scOksStddev`; sleap-nn's own value for its noisier Kalman
  keypoints). On 35 proofread 10-min SLAP videos it took sleap-nn's known-count
  setup from 85.8% to 93.6% correct and 156 to 102 lasting swaps. Everything
  else is sleap-nn's default.
- **The ID-switch checks read a 2D stand-in** (`singleCameraCheckSession`:
  `points3d` = (x, y, 0)). They are unit-free, so this is sound, but body size
  in 2D is not a usable cue (2 of 59 real swaps caught, AUC 0.55), so Track All
  does not run it automatically on one camera — it says so in the status line,
  and the menu still runs it. The image check needs nothing 3D.
- **Where to look comes from the tracking; whether it switched comes from both
  sides.** Track All also returns candidate moments (`candidateMoments`: the
  tracker nearly chose the exchange — read through `SleapTracker`'s read-only
  observer — or the input file's own tracklet changes animal), and the checks
  test each one by comparing the evidence BEFORE and AFTER it
  (`pose/id-switch-check.js` `testMoments`, 15 s each side, -200). Reading only
  after a moment caught 1 more real swap of 59: the classifier is fit to the
  tracker's own labels, and a swap covering most of the video is what it
  learns. Encounters score and flag exactly as without moments; a moment's row
  takes over the encounter rows of the swapped stretch it starts or ends
  (`momentChangePoints`), so one swap is one row and one Fix — two rows meant
  two fixes, the first stopping where the second began. Moments are not saved
  (their input tracklets are rewritten).
- **On one camera the automatic check is coat brightness, not body size.**
  `ui/brightness-sampler.js` reads the grey level at each animal's body
  keypoints and `checkBrightnessSwitches` runs the image check's code on it — no
  model, no GPU. Its candidate-moment rows caught 14 of 59 real swaps with no
  false rows (the image check's: 13, 12 shared); its encounter rows were noise,
  hence its strict -800 encounter threshold. Uncalibrated on multi-camera data,
  so it is not run automatically there.
- **On one camera the image check ends a swapped stretch only at a clearly
  positive encounter** (`continueBelow` = +|threshold|,
  `singleCameraImageContinueBelow`), not at any score above 0. A near-zero
  encounter in a huddle split one swap into two rows and left the stretch
  between them unfixed (topC: 93.8% -> 99.9% correct after both Fixes; SLAP:
  false rows 71 -> 51, 18 of 59 caught instead of 17). Brightness keeps 0 (its
  encounter scores are noise); size and multi-camera are unchanged.
- **Two more single-camera choices in the ID Switches tab, both measured on the
  35 SLAP videos.** A candidate moment's row is never a follow-on, and it
  outranks other pairs' encounter rows up to 3 s before it (they follow it);
  with `clearestEndLeads` the clearest of nearby encounter 'end' rows leads
  them. Following any earlier row within 60 s that shares an animal had hidden
  real swaps behind false primaries; the right pair is now the primary in 18 of
  23 swaps instead of 11 (`linkFollowOns`). And a row's window — landing
  frame, progress bar, the range where a Fix takes the current frame as its
  boundary — is ±2 s, not ±1 s (`idSwitchLeadSeconds`), because one view places
  the close spell less exactly. Multi-camera keeps 1 s.
- **On one camera an encounter scoring exactly 0 is no evidence** (`skipEmpty`,
  `singleCameraCheckOptions`). It had no samples on either side — 44.5% of the
  image check's encounters on the SLAP videos — and counting it as "reads
  right" started swapped stretches late (a Fix from 0:04.2 for a swap from
  0:00). Skipping them: false rows 51 -> 42 with the same swaps caught, wrong
  far edges 4 -> 2. Multi-camera checks still count them (not measured).
- **Eager only.** A lazy (> 150 MB) single-camera project is refused with a
  reason, never tracked from its resident window — the resident-only bug class.

## Triangulation must not depend on where the origin is

`triangulatePointDLT` (in `pose/triangulation-core.js`, re-exported from
`pose/triangulation.js`) minimizes an **algebraic** error, and `‖x‖ = 1` on a
HOMOGENEOUS 4-vector is not a geometric constraint — it weights `(X,Y,Z)`
against `W`, so moving the world origin re-weights the cost and moves the
answer. Solved in the raw calibration frame, that made triangulation depend on
where the origin happens to be, which **`Set as New Calibration` moves by
~1.2 m** while promising it changes no geometry. Measured on the real cage
session: identical 2D came out 0.26 mm apart at the median, 17 mm at p99,
metres in the tail — and because `CrossViewTracker._retriangulate` scores
cross-view association against exactly those points, **21% of frames came out
grouped differently, three times worse by reprojection (16.5 px → 51.8 px),
purely from swapping the calibration file.**

It is now solved in a frame derived from the **cameras alone** — centroid of
their centres, unit = their mean distance from it. That frame moves with the
cameras, so the normalized system differs only by an orthogonal factor, `‖x‖=1`
is untouched, and the null vector maps exactly. Four rules:
- **The normalizing frame must come from the cameras ONLY.** From the
  observations, or from a first-pass answer, and it depends on the thing being
  solved for — the invariance argument collapses.
- **The tracker does not use the `ba` / "Refined" method.** It calls
  `triangulatePoints` (DLT) unconditionally, so the Settings toggle fixes
  Triangulate / Triangulate All and never Track All. Fix the estimator, not the
  setting.
- **A noiseless fixture cannot test this.** When the rays meet exactly, `A·x=0`
  has an exact null vector and every positive re-weighting finds it. Inject
  noise, or you have written a test that passes on the broken build — which is
  exactly what the first version of this one did.
- **Everything else in the tracker's cost is already invariant** — the
  reprojection term, the point-to-ray term and the fundamental matrix (to
  1e-19). Keep it that way: a new cost term may read the rays, the pixels or
  `points3d`, never absolute world coordinates.
- **The allocation-free kernel takes the frame as four OPTIONAL arguments.**
  `dltHomogeneousFlat(xs, ys, Ps, n, out, s, cx, cy, cz)` omitted is the
  identity frame, which reproduces the raw rows exactly — multiplying by 1 and
  adding 0 are exact in IEEE 754 — so the bit-identity against `svd3x4(A)` that
  `tests/test-triangulation-kernels.mjs` pins still holds. A kernel edit that
  changes operation ORDER breaks that test, which is the intended signal.
Covered by `tests/e2e/triangulation-frame-invariant.mjs`, confirmed to fail on
the pre-fix build (7 checks red; a mis-associated point moves 6.01 mm instead
of 2.4e-13 mm).

## The defined origin moves the CALIBRATION, never the points

Set Origin (`ui/origin-definition.js`, maths in `pose/origin-frame.js`) applies
its frame to what is DRAWN — the grid, the axes and the orbit — and to nothing
else. Cameras, skeletons and plane nodes keep their calibration-world
coordinates, deliberately: re-baking the point cloud would silently change every
3D number the rest of the app reads, saves and reports, and the transform is the
deliverable, not a rewritten cloud.

**The origin is ANY node of a fitted plane, never only a corner.** A plane is a
group of nodes and its fit is a surface through all of them, so a node in the
middle of the floor is as good an origin as one at its edge — and on a real cage
it is usually the better one, since that is where a physical mark tends to be.
The picker never asked for an outline node (`_handleOriginPick` collects one
mesh per `plane.nodeIds` entry, so "is this a corner?" is not a question the
viewport can ask); only the wizard's own copy did, and a user reads copy like
that as a rule. Say **node** in every string this flow prints — the instruction,
the button tooltip, the status line and the refusal — and keep "corner" for the
outline it actually means. What IS restricted is the plane: it must be one the
user clicked Fit on, because an un-fit plane has no normal and so no +Z to
offer. Covered by `tests/e2e/origin-picks-any-node.mjs`, which pins the wording
and drives a real click onto a node strictly inside a five-node quad.

That leaves exactly one artifact still speaking the old frame, and it is the
reason the panel's **Danger Zone** exists:

- **`Export New Calibration`** writes `calibration-rebased.toml` — every
  camera's extrinsics through `rebaseExtrinsics` (`R_new = R_cam·Rᵀ`,
  `t_new = R_cam·origin + t_cam`). A downstream tool handed the user's 3D and
  the ORIGINAL calibration would reproject against the wrong world. Intrinsics,
  distortion, image size and camera ORDER are untouched, and the rotation keeps
  the notation it arrived in, so a diff against the input shows the origin
  change and nothing else. **The name is shared with `Set as New Calibration`**
  (`REBASED_CALIBRATION_NAME`, in `loading/calibration-pick.js`): for a given
  origin the two actions produce byte-identical TOML — same cameras, same
  `rebaseExtrinsics`, same writer — and what differs is whether the project
  moved to match, which is a property of the project, not of the file.

  **Two `*calib*` files in one folder is now possible, so the loaders must
  CHOOSE.** They used to do `calibFile = file` as they scanned, making the
  winner whichever the enumeration yielded LAST — an order neither the File
  System Access API nor `webkitdirectory` promises. Harmless only while a
  folder could hold one match, which stopped being true the moment this action
  wrote a second name. `pickCalibrationFile`
  (`loading/calibration-pick.js`) prefers `REBASED_CALIBRATION_NAME`
  case-insensitively, else the lexicographically first, and returns the names
  it ignored so both loaders can warn in the status bar. It lives in a module
  with NO imports on purpose: `session-loader.js` reaches Three.js through a
  CDN specifier and cannot be loaded by a Node test, and that module is also
  outside the `origin-rebase` / `origin-definition` cycle. Covered by
  `tests/test-calibration-file-pick.mjs`, including that the answer does not
  depend on scan order.
  **`t_new` is built from `frame.origin`, not `frame.translation`** — the two
  differ by a rotation (`t = −R·origin`), and substituting one yields a
  calibration that still almost works, which is the worst kind of wrong.
- **`Set as New Calibration`** COMMITS: it re-bases every 3D number in the
  project, so the world becomes the defined origin, and writes the calibration
  that matches (`pose/origin-rebase.js` + `ui/origin-rebase.js`). Several things
  about it are load-bearing:
  - **Points and cameras move together, so no pixel moves.** 3D points take
    `p' = R·p + t`, plane NORMALS take `R·n` with no translation, cameras take
    `R_cam·Rᵀ` / `R_cam·origin + t_cam`. Every reprojection lands exactly where
    it did. Move one without the others and every reprojection error in the
    project silently explodes.
  - **Plan, write, then apply.** The plan builds replacement buffers beside the
    live ones and writes nothing, so a cancel — or a failed file write — leaves
    the project byte-identical. Transforming in place and inverting on cancel is
    rejected: `Rᵀ(R·p + t − t)` is not bit-identical to `p`.
  - **The file handle is asked for inside the Continue click**, before the slow
    part, because `showSaveFilePicker` needs transient user activation and that
    expires within seconds. `Load Calibration` uses a plain `<input type=file>`
    and yields no write handle, so there is nothing to inherit.
  - **The confirmation is TWO tables: origin-dependent and not.** Which table a
    row is in IS the claim being made about it, and that split is the only
    thing about this action a user has to trust. A camera is in BOTH —
    extrinsics move, intrinsics and distortion do not — because "does this
    rewrite my lens model?" is the most common fear about the button. Every row
    is present for every project, **zeros included**: a per-camera session with
    no `project.slp` has no instance groups and no pose 3D, and that has to
    read as a stated zero rather than a missing row, or the modal's shape
    depends on the load path. A third block, `#originRebaseBySession`, appears
    only when `sessions > 1` — a multi-session project can carry a different
    `calibration.toml` per session, the user picks which of them move (below),
    and only the ACTIVE one's calibration is written. Plane nodes and plane fits
    are NOT split per session: the `PlaneModel` is project-scoped. The modal
    caps its height and sticks its action row, so Continue is never below the
    fold and there is still only one scroller. The two headline tables
    additionally **FOLD** — each is a real `<details open>` whose `<summary>`
    is its title, so the keyboard and the accessibility tree come from the
    browser rather than a click handler on a `div`, and the note folds with the
    table instead of leaving an orphaned sentence. The first one reads
    *Origin-dependent — **updated***, not *rewritten*: the numbers are
    re-expressed in a new frame, and half this dialog's job is saying what is
    NOT overwritten. **The fold is deliberately NOT persisted** — no
    `persistSectionState`, nothing in `localStorage`. That helper is for
    display taste in a long-lived panel; this split is the claim the user is
    being asked to trust, so a fold made once must never be how the next
    re-base is confirmed, and every open rebuilds both blocks expanded.
    `#originRebaseBySession` stays un-foldable on purpose: it holds the
    per-session checkboxes, and hiding the control the user came to use is
    worse than an uneven stack. Pinned by
    `tests/e2e/set-new-calibration.mjs` §1/§1b/§5/§6 and
    `tests/test-origin-rebase.mjs` §1d.
  - **On a MULTI-SESSION project the user CHOOSES which sessions move**, with a
    checkbox per `#originRebaseBySession` row. Re-basing all of them
    unconditionally was a decision the dialog was making on the user's behalf,
    and there is one calibration file per session FOLDER while this writes
    exactly one of them. The chosen sessions are passed to
    `runSetCalibration` / `planOriginRebase` as a FILTERED array — no mode
    flag, so there is no partial code path to drift, and a session that is not
    in it keeps BOTH its 3D and its cameras, which is what leaves it internally
    consistent. Three things about it:
    - **The ACTIVE session cannot be deselected.** Its cameras are what
      `calibration-rebased.toml` describes, and the project-scoped `PlaneModel`
      — the node pool and every plane fit — moves exactly once, with it; leave
      it behind and the file describes a frame the project's own plane geometry
      is not in. Its box is checked and `disabled`, and the block note names it,
      because a disabled input's own tooltip never fires. It is found by
      `sessions.indexOf(state.session)` — **not** `state.activeSessionIdx` and
      not index 0: `state.session` is what picks the cameras for the file, so
      pinning the row by anything else could let the pinned row and the written
      calibration name different sessions. Pinned with a negative control that
      makes session TWO active.
    - **Every headline count follows the selection**, through
      `subsetRebaseTally` — a re-FOLD of the tally's `perSession` records, not a
      re-count, so a click does not re-walk a lazy project's whole columnar
      store. It shares one private fold with `countRebaseTargets`, so a re-fold
      and a fresh count of the same sessions are the same tally by
      construction. One `renderSelection()` owns all four selection-dependent
      strings (both tables, the block note, the hazard warning and
      `#originRebaseMultiNote`, whose first clause becomes
      `1 of 2 loaded sessions are re-based`), and runs at build time too so no
      initial string can drift from it. `plane nodes` and `Plane fits` do NOT
      follow it: one `PlaneModel`, moving once.
    - **Deselecting is a real hazard, said in two sentences.** The sessions left
      behind keep their old 3D while the rest of the project moves, so the
      project holds 3D in TWO coordinate frames — precisely what
      `pose/calibration-compare.js` detects and `ui/calibration-notice.js`
      reports on the next load. `#originRebaseSubsetWarning` appears only while
      something is switched off, sits under the checkboxes rather than with the
      two cautions, and is deliberately short: no numbered list, no third box of
      prose. Covered by `tests/e2e/set-new-calibration.mjs` §8 (the pin, the
      counts, the warning's presence AND absence, and a commit whose deselected
      session comes out bit-identical) and `tests/test-origin-rebase.mjs`
      §11/§11b/§11c.
  - **A PLANE NODE IS A 3D POINT, and the confirmation dialog has to say so.**
    `tally.points3d` — `keypoints3d` PLUS `planeNodes` — is what the
    `3D points to update` headline quotes, and the three pose buckets and
    `plane nodes` sit under it as sub-rows that ADD UP TO IT. Quoting
    `keypoints3d` alone announced "0 3D points to update" on a project with
    planes and no pose annotation, one row above the nine plane nodes it was
    about to rewrite. Two corollaries: every sub-row counts POINTS (the group
    counts live in the labels — `from 2 User instance groups` — because a
    number of groups under a "3D points" heading is two units in one column),
    and the success status line names the total and then the split rather than
    printing "0 3D points, 9 plane nodes" for a reader to reconcile. A plane
    FIT is deliberately NOT in the sum: it is a centroid and a normal, which
    transform differently, so it keeps its own row. Covered by
    `tests/test-origin-rebase.mjs` §1/§1b and
    `tests/e2e/set-new-calibration.mjs` §1/§5.
  - **The 2D inventory counts the WHOLE population, and never `frameGroups`
    alone.** Most of an imported `.slp` is ungrouped predictions, which live in
    `FrameGroup.unlinkedInstances`, not in any `InstanceGroup` — so tallying
    group members reported `0 predicted 2D instances` on a project holding
    hundreds of thousands. Use the same enumeration
    `ui/custom-delete-ops.js`'s `collectSessionWide` uses, and for the same
    reason: `lazyLoader.forEachInstanceRow` on a lazy project, because
    `session.frameGroups` there is a small resident window (31 of 180,210
    frames on the real project) and counting it yields a plausible, tiny
    number; group members plus the unlinked pool on an eager one, which are
    disjoint by construction. 2D is inventory, not work — it does not move
    — but a wrong inventory line sends the user looking for data the dialog
    says they do not have. Pinned by `tests/test-origin-rebase.mjs` §1/§1c.
  - **THE CALIBRATION IS NOT OVERWRITTEN; THE PROJECT IS SAVED AUTOMATICALLY.**
    The calibration goes to a NEW file, `calibration-rebased.toml`
    (`REBASED_CALIBRATION_NAME`) — never over the `calibration.toml` the
    project was annotated against, which is usually shared with tools outside
    LUCID. `Export New Calibration` writes the same name, deliberately: the
    two produce byte-identical TOML for a given origin. A folder can therefore
    end up holding both names — see `pickCalibrationFile` above, which is
    what decides between them on the next load.

    The project `.slp` **is** written: `autoSaveAfterRebase` calls `quickSave`
    as the last step of the commit. Leaving that to the user — which is what
    the old completion modal's first obligation did — opened a window in which
    the calibration just written to disk disagreed with the project sitting
    beside it, for no benefit. Two things about the auto-save:
    1. **It runs only when `state.slpFileHandle` exists.** Otherwise
       `quickSave` would open `showSaveFilePicker`, which needs transient user
       activation that the Continue click no longer has after a minute of
       re-basing — so the picker throws `SecurityError`. That case sets a
       status asking for Save As instead, which is honest: there is no file to
       update.
    2. **The dirty flag is what says whether it worked**, not the absence of an
       exception: `quickSave` reports its own failures and does not re-raise,
       so success is `!state.isDirty` after the await. The save runs BEFORE the
       summary status line, because `quickSave` writes its own text into the
       status bar and would otherwise overwrite the counts.

    **There is no completion modal.** It stated two obligations; one is now
    automatic and the other was already given up front. What survives is the
    confirmation's own `#originRebaseStaleWarning`, and it makes only the claim
    that always holds — `calibration-rebased.toml` takes PRECEDENCE over
    `calibration.toml` when a folder holds both. It used to also say a folder
    `.toml` is preferred over the calibration embedded in the `.slp`: true of
    `handleLoadSessionFolderSingleSlp`, which falls back to the embedded copy
    only when the folder has no `.toml`, but NOT of reopening the
    `project.slp`, which never scans a folder. Stating it unconditionally
    overstated the hazard for the ordinary reopen. (The 77 px negative control
    in `tests/e2e/origin-rebase-slp-diff.mjs` still stands — it is about the
    two frames disagreeing, not about which file wins.)

    **On a MULTI-SESSION project the third obligation stays, in the
    confirmation.** There is one calibration file per session FOLDER and this
    writes exactly one of them, so the folders that were not written still hold
    a calibration in the old frame. `#originRebaseMultiNote` says so when
    `t.sessions > 1` — before the commit, which is also while the user can
    still decline — and ends on the one ACTION left with the user: *Ensure
    other re-based sessions have an updated calibration file in their folders.*
    It deliberately does not spell out the old-frame/new-frame consequence or
    promise a load-time note; the loader still reports the divergence if they
    do nothing (see the multi-session section above), and an instruction beats
    an explanation here. The folder count it quotes is `picked - 1`, NOT
    `total - 1` — the sessions that MOVED but whose folder was not written. A
    deselected session kept its old 3D and its old calibration, which still
    agree, so it is not a folder to go and fix; and when the current session is
    the only one moving (`picked === 1`) the trailing clauses are omitted
    rather than printing a count of zero. Deselecting a session in that same
    block puts the project into the two-frame state on purpose rather than by
    accident, which is what `#originRebaseSubsetWarning` is for.
  A pin does NOT exempt a plane node: it says "do not re-solve this point", not
  "exempt this point from the world moving". Afterwards the defined origin is
  CLEARED — the project is that frame now, so there is no offset left to report.

  **What a save after the re-base changes inside `project.slp`**, measured by
  `tests/e2e/origin-rebase-slp-diff.mjs` (it saves the same project on each side
  of the operation and diffs every HDF5 dataset):
  - **Rewritten** — `session_data/points_3d` (every 3D keypoint, by exactly
    `R·p + t`) and `sessions_json` (the EMBEDDED calibration, plus
    `metadata.lucid`'s `planeNodes` and each plane's `planeFit`;
    `planeOrigin` disappears, since the project IS that frame now).
  - **Byte-identical** — `points`, `pred_points`, `frames`, `instances`
    (all 2D), the whole `session_data` grouping (`frame_groups`,
    `instance_groups`, `instance_group_members`, `instance_group_meta`),
    `videos_json`, `tracks_json`, `suggestions_json`, and
    `metadata.lucid.planePlacements`.
  - **There is no `session_data/pred_points_3d` in a LUCID file.** Both writers
    build `SIO.Instance3D` for every group whatever its members are, and the
    vendored writer only routes to that table for a `PredictedInstance3D` with
    point scores. The user/predicted split the confirmation dialog shows is a
    provenance label on the LUCID side, not a division on disk.
- **`Reset to Calibration Origin`** goes through a warning modal
  (`confirmClearOrigin`). `clearOrigin` itself stays unguarded because the load
  path and the tests must reach it without a dialog — the confirmation is about
  an unrecoverable CLICK. The frame is derived from a node and an arrow picked
  in the 3D view and nothing records which, so there is no undo short of walking
  the wizard again.

The whole block, and the collapsible Defined Origin readout above it, appear and
disappear with `originState.frame`: without an origin all three actions are
no-ops, and offering them would be a lie about what the panel does.

Coverage: `tests/test-origin-frame.mjs` §10 (the re-based camera sees a re-based
point exactly where the old one saw the original, plus the
`frame.translation` negative control), `tests/test-origin-rebase.mjs` (the
project-wide rewrite: the pixel invariant, that planning writes nothing, that a
cancel is byte-identical, and the centroid-vs-normal split),
`tests/e2e/define-plane-mode.mjs` §14 (both panel blocks, the TOML round trip,
and the Reset warning's Esc/Cancel/Confirm) and
`tests/e2e/set-new-calibration.mjs` (the inventory dialog, both cancels, and the
commit).

## Multi-session projects: the sessions can disagree about where the world is

A multi-session load reads **one calibration per session subfolder** and nothing
makes them match. Almost always they are copies of one file, so this is a rare
edge case — but it is a silent one, and that is what earns it a check.
**Nothing looks wrong when it happens.** Each session still reprojects correctly
against its own cameras, so every error stays small and every number stays
plausible; what breaks is only the comparison BETWEEN sessions, which nothing on
screen performs and so nothing on screen contradicts. The user finds out when a
distance measured in one session does not match the same distance in another,
long after annotating both.

`compareSessionCalibrations` (`pose/calibration-compare.js`, DOM-free) runs at
the END of a multi-session load and `ui/calibration-notice.js` shows a note when
it disagrees. Five things about it are load-bearing:

- **The modal says WHO differs and nothing else.** One title — *Sessions with
  different calibrations detected* — then one section per distinct calibration:
  a letter, `N sessions · M cameras`, and the session FOLDER NAMES one per line.
  That is the whole modal, and everything else that used to be in it was
  removed: a lead paragraph, a per-kind explanation of the difference, the
  measured offset, a consequence paragraph and two numbered remedies — five
  blocks of prose over a two-row table. Nobody reads that on the way into a
  project, and the one string they need, the name of the odd folder, was buried
  in it. The folder name is the only thing here the user can act on, so it is
  the only thing the modal is made of. `tests/e2e/multi-session-calibration-notice.mjs`
  asserts the old prose is ABSENT, because copy like that creeps back one
  sentence at a time.
- **The classification is still MEASURED — it just goes to the console.** For
  one physical camera under two calibrations, `R_f = R_A^T*R_B` and
  `t_f = R_A^T*(t_B - t_A)` give the change of world frame that camera implies.
  If EVERY camera agrees on `(R_f, t_f)` the two differ only by where the origin
  is (`kind: 'origin'`, and `t_f` is the position of the second origin in the
  first's coordinates); if they disagree, no single frame change explains them
  and the sessions were calibrated apart (`'lens'`, `'cameras'`,
  `'extrinsics'`). The detector must compute this anyway — it is how it knows
  the sessions disagree at all — and it distinguishes a recoverable misplaced
  file from a genuine re-calibration, so it is worth keeping. It is logged, with
  the offset, by `noteSessionCalibrationDivergence`. Do not put it back in the
  modal: `report.frameOnly` exists for the detector's own use and for the tests,
  not to branch the copy.
- **The remedy belongs where the divergence is CREATED, not where it is
  found.** The origin case is overwhelmingly a leftover
  `calibration-rebased.toml`: `Set as New Calibration` re-bases every session in
  memory but writes ONE file (the active session's), and `pickCalibrationFile`
  then PREFERS that name on the next load — so one session comes back re-based
  while the rest come back in the original frame. The commit confirmation's
  `#originRebaseMultiNote` states that obligation BEFORE it writes the file
  (when `t.sessions > 1`), which is both the right time to act on it — the user
  can still decline — and what makes this note predictable rather than
  alarming. Measured on the real
  `small_multi_session` folder: its four `calibration.toml` files are
  BYTE-IDENTICAL (md5 `5be0c54b…`), as are the four independent `slap_GT`
  session calibrations — copies are what this lab actually ships, so the only
  divergence there is the rebased file, with all eight cameras agreeing to 3e-14
  in rotation and 5e-13 mm in translation, origin at
  `(-10.591, 11.900, 1218.743)` mm — 1218.847 mm away, rotated 162.818°.
- **It is SILENT in the ordinary case, and that matters more than any of the
  rest.** The modal opens only on `ok === false`. A note on every multi-session
  load would be worse than no note. A session with no calibration at all (a
  per-camera folder load with no `.toml`) is excluded from the comparison and
  listed as "not compared" rather than counted as a third calibration —
  otherwise a perfectly consistent project raises the modal.
- **It runs LAST, and behind the skeleton prompt.** Comparing while sessions are
  still arriving one at a time reports a divergence the next session resolves; a
  modal raised mid-load sits over the loading overlay; and two modals stacked
  means the user answers whichever is on top. So it is passed as
  `promptImportSkeletonForAllSessions`'s `onDone`.
- **It is a NOTE, not a prompt.** One dismiss button, Esc-closable, and it
  changes nothing. Fixing the divergence would mean writing to the user's
  session folders during a load, which is not what a load is for.

Coverage: `tests/test-calibration-compare.mjs` (the maths and all four `kind`s,
with the re-based fixtures built from the app's own `buildOriginFrame` +
`rebaseExtrinsics` so the detector and the re-base cannot drift apart silently)
and `tests/e2e/multi-session-calibration-notice.mjs` (the modal, the absence of
the old prose, both kinds of difference, the silent case, and the real loader
tail — driven with the REAL calibrations from
`tests/fixtures/multi-session-calib/`).

## Two pin states, and Set Angle Between Two Planes

A plane node carries `pin`, not a boolean:

    'none'          unpinned
    'plane-locked'  may move, but only within EVERY plane it is a member of
    'locked'        the 3D is frozen outright

**`locked` is the old `immutable`, and `immutable` is still there as an accessor
for `pin === 'locked'`** (getter + setter on `PlaneNode`) — which is what keeps
the ~30 readers written against the original boolean, `setPoint3d`'s refusal
included, working unchanged. Rules, each with a test:

- **`plane-locked` is NOT an anchor.** It must never reach
  `fitPlaneConstrained`, which treats what it is given as a hard positional
  constraint; this node's position is not fixed. The two chokepoints every
  fit/triangulation consumer reads — `planeImmutableMask`
  (`ui/plane-definition.js`) and `planeNodeImmutability` (`pose/plane-data.js`)
  — report `locked` ONLY. Pinned by `tests/test-plane-constrained-fit.mjs`.
- **`locked` is enforced on the node; `plane-locked` is enforced by the model.**
  `PlaneNode.setPoint3d` refuses a locked write, which is the entire locking
  mechanism. A node cannot resolve a plane's fit, so the soft state lives in
  `PlaneModel.constrainPoint3dForNode`, reached through
  `writePoints3dForPlane`'s optional `constrain` hook — the one sanctioned
  publish path, so every solve honours it without having to remember to.
  **Every path that writes a plane-locked node's 3D must go through it**, and
  two did not: the 3D corner drag took the viewport's own constraint (the plane
  under the cursor, which is only one of the planes holding the corner) as
  final, and `applyPlaneFit` wrote unhooked — so dragging or fitting a
  NEIGHBOURING plane that shares the corner pulled it off the others. Both now
  call it. A shared corner is one node with one position, so "which plane am I
  editing?" cannot be the thing that decides whether the pin holds.
  `applyPlaneFit` additionally has to store `plane.planeFit` **before** the
  constrained write, not after: a plane-locked corner of the plane being fitted
  is held by that plane too, so a hook running against the fit being REPLACED
  projects the corner onto a plane the fit then moves out from under it,
  leaving it 13 mm off the very plane it was just fitted to.
- **The constraint is MEMBERSHIP, and it is the INTERSECTION of the planes.**
  There is no `pinPlaneId` and there must not be one again. A node held by one
  plane may slide over its surface; by two, only along the line they meet in;
  by three, not at all — it has one position and is locked in all but name.
  `PlaneModel.planeLockForNode` answers with a `rank` (0 free, 1 plane, 2 line,
  3 point) and the planes doing the holding, and `planeIntersectionBasis` /
  `projectOntoPlaneIntersection` (`pose/plane-fit.js`) do the geometry by
  Gram-Schmidt over the plane equations — which is where the rank comes from.
  Nominating one plane instead was the old design and it was a second source of
  truth about something the model already knew: adding a corner to a wall now
  tightens its constraint by itself, deleting a plane loosens it with no
  cascade, and a saved `pinPlaneId` is read and DISCARDED because the plane it
  named is one of the planes the file already lists the node in.
  On the real five-plane cage this is not an edge case — the held corner is in
  Ground, the right wall AND the front wall, so it is pinned outright, and the
  first edit snaps it 1.7 mm to the point they actually meet at.
  A plane whose normal repeats a direction already accounted for is DROPPED
  rather than averaged in, on a minimum-angle threshold of about 0.06°
  (`PLANE_INDEPENDENCE_TOL`): two nearly-parallel planes do intersect, in a line
  that runs off towards infinity as they line up, and snapping a held corner
  onto it is a worse answer than admitting the second plane says nothing new.
- **The plane it projects onto is a USABLE fit, never necessarily a stored
  one.** `usablePlaneFit` (`pose/plane-data.js`) returns the stored `planeFit`,
  else derives one with `fitPlaneToPoints3d` from the plane's own solved
  corners, writing nothing. Requiring a stored fit is what made this pin state
  do **nothing at all**, and the loop is the thing to remember: setting any pin
  clears the `planeFit` of every plane holding that node — including the planes
  it is being held in — so plane-locking a node's last act was to remove the
  planes it was being locked to. On a real five-plane cage four planes had no
  stored fit, and typing `z = 2000` into the held corner left it 683 mm off its
  plane with nothing saying so.
  **The node being constrained is EXCLUDED from a derived fit.** A derived fit
  is least squares through the points it is handed, so including that node lets
  the plane chase it: the projection lands between the typed point and the real
  plane, and every repeat edit drifts further (647 mm out on that same project).
  Excluding it makes the plane the OTHER corners define, which is what the pin
  means, and makes re-projecting a committed position a no-op. A STORED fit is
  used unexcluded — it does not move when a corner is nudged, which is the same
  rule the 3D drag and the typed editor already follow. Fewer than three other
  solved corners, or collinear ones, derive nothing and the pin stays inert:
  two corners admit a pencil of planes and choosing one invents geometry.
  The same helper backs `ui/plane-angle.js`'s `usableFit` and the 3D drag
  surface, so the dialog, the viewport and the pin cannot disagree about where
  a plane is. **`fitPlaneToPoints3d` lives in `pose/plane-fit.js`** for this —
  `pose/plane-data.js` must stay off `pose/triangulation.js`, which pulls in the
  whole UI.
  **Set Origin is deliberately NOT widened by any of it.** Its node picker
  asks whether the user has DECLARED a plane's frame, which `fittedPlanes()`
  counts, so the 3D payload carries `fitted` (stored fit) beside `planeFit`
  (usable fit) and the wizard reads `fitted`. A derived surface is enough to
  slide a corner along; it is not a declaration about the project's origin.
  Covered by `tests/e2e/plane-lock-holds.mjs` and
  `tests/test-plane-nodes.mjs` §20b (the derived fit) and §20c (the
  intersection). The e2e file checks nothing against the app's own fits: the
  reference planes are rebuilt from each plane's OTHER corners, and NEAREST is
  asserted as the optimality condition — what is left of the typed position,
  measured along the only direction the corner can still move in, has to be
  zero.
- **The pin is a padlock, and the three states are named for it.**
  `PIN_LABELS` is Unlocked / Plane-locked / Locked (the model values are
  unchanged). The Nodes list shows one 15px icon per row and floats a
  three-state picker over the panel on hover or click, with the current state
  dimmed and disabled; `#planePinInfo`, beside the `Pinned` column label,
  carries the one sentence defining all three. The picker REPOSITIONS on scroll rather than
  dismissing — a `scroll` event arrives a frame late, so dismissing made it
  impossible to open on a row you had just scrolled to.
- **A node's 3D can be typed, and the pin governs that too.** Expanding a node
  reveals `x/y/z` (`Float64Array(3)` on `PlaneNode.xyz`, all-NaN =
  untriangulated) and the planes using it. Editing it takes the 3D-drag
  path — **the 2D follows the 3D**, so every placed view is rewritten to the
  reprojection of what was typed — and the pin decides what is allowed:
  `locked` renders the fields `disabled`, `plane-locked` runs the value through
  `constrainPoint3dForNode` and says in the status what it was moved to — a
  plane, the line two planes meet in, or the point three meet at, named. Every
  plane currently holding the node wears a padlock on its chip in that same
  panel, so "two marks" is how the user reads that the corner is down to a
  line; a plane it belongs to that has no usable fit yet is left plain rather
  than promising a restriction that is not in force. The display is 4 decimals,
  but a field the user did not retype keeps its full stored double, or editing
  one axis would round the other two.
- **Both states are omitted at their defaults on save** and ride the existing
  `planeNodes` key, so `PLANE_METADATA_KEYS` does not change and
  `save-golden-digest.mjs` must not move. A `locked` node redundantly also
  writes `immutable: true` so an older build still freezes it; a `plane-locked`
  node deliberately writes no `immutable`, because an older build cannot enforce
  it and treating it as free is the honest fallback.

**Set Angle Between Two Planes** (`#btnSetPlaneAngle` → `ui/plane-angle.js`,
maths in `pose/plane-angle.js`) holds one plane fixed and rotates the other
about their SHARED EDGE until they meet at a typed angle. Three things about it
are easy to get wrong:

- **The angle is unsigned, `acos(|n·n|)` ∈ [0°, 90°]** (0 = parallel,
  90 = perpendicular). A `planeFit.normal` is a PCA eigenvector whose sign is
  arbitrary and which only the constrained path stabilizes, so a SIGNED dihedral
  angle is not reproducible between two independent fits.
- **The rotation is the smallest one that reaches the target**, so a wall stays
  on the side it already leans; and the moving plane's stored fit is ROTATED
  rather than re-fitted, because a re-fit re-derives the normal's sign from
  `jacobiEigen` and can flip it.
- **Applying holds the nodes it moved PLANE-LOCKED**, so the next Triangulate
  cannot silently undo the angle. Plane-locked rather than Locked because the
  assertion is about the plane's ORIENTATION, not about where each corner sits
  on it: a held corner is still re-solved from 2D and
  `constrainPoint3dForNode` projects the answer back onto the planes it belongs
  to — the rotated one among them — so the annotation goes on improving while
  the angle survives. A node the user had already Locked is left Locked.
  It nominates no plane, because the pin no longer takes one; a corner this
  rotation moved is in the rotated plane by definition. The corollary is the
  `plane_locked_elsewhere` warning: a moved corner that is ALSO in some other
  plane is pulled back into that plane too, so the result may miss the target,
  and the warning names each node with the planes holding it elsewhere. (Separately, `Triangulate` raises a modal
  naming a plane's Locked nodes instead of mentioning them in a success line;
  `Fit` does not, because holding pinned nodes is what a constrained fit is
  for.)
- **The dialog is the one plane dialog that is NOT modal.** Its inputs are two
  planes the user has to orbit the 3D view to tell apart, so it opens beside
  that view, draws no scrim and lets the pointer through to it; the two planes
  wear matching coloured outlines in 3D (`viewport3d.setPlaneRoles`). Apply
  re-plans before committing, because the scene can change under an open
  dialog. Esc still cancels.
- **Live view, frozen data.** Not modal is not the same as editable: everything
  the dialog says is read from plane geometry, so while it is open that geometry
  is locked in all three places it can be edited from — the Define Plane panel's
  controls (`applyAngleModalLock`, at the end of `refreshPlanePanel`), 3D corner
  dragging (`editable: false` in the `syncPlanes3D` payload) and 2D corner
  dragging (`beginPlaneDrag` refuses, saying why — with `isPlaneDataLocked` and
  a guard in `handlePlaneDrop` closing the two 2D paths that do not go through
  it, the right-click null toggle and a plane row dropped onto a view). All ask
  `isAngleModalOpen()` per render rather than being toggled by hand, so no lock
  state can get out of step. Orbiting, zooming, selection and the live ghost are
  untouched; so is pose annotation, which cannot reach a plane.
- **It offers USABLE planes, not fitted ones.** A plane loses its stored
  `planeFit` whenever a node it holds is pinned — including by this action's own
  auto-lock — so gating on `fittedPlanes()` hid three of a user's five annotated
  planes. `usableFit` (`ui/plane-angle.js`) returns the stored fit or derives
  one, writing nothing, and hands it to `planAngleEdit` as its `fits` argument.
  It now delegates to the model's `usablePlaneFit`, which the `plane-locked`
  pin and the 3D drag surface also read — the same mistake had been made in both
  of those, and one definition is what keeps them from disagreeing about where a
  plane is. `planAngleEdit` keeps taking the fit as an argument as a TEST SEAM
  (hand-written fits, including all four normal signs), not because it cannot
  reach one: `fitPlaneToPoints3d` moved to the stub-free `pose/plane-fit.js`.

Coverage: `tests/test-plane-angle.mjs` (the maths, over a floor-and-wall fixture
whose angle is analytic — including that all four normal-sign combinations give
the same answer) and `tests/e2e/plane-angle.mjs` (the dialog, the ghost preview,
the auto-hold, the Triangulate modal and the edit lock).

## 3D Mesh Objects — a group of PLANES, with a DERIVED shape

The third level of the plane model, added strictly beside the first two:

    node    a point with ONE 3D position, in the global pool
    plane   simply a group of nodes
    object  a group of PLANES, whose shape comes from how they are CONNECTED

`pose/mesh-object-3d.js` owns the authoring half (`MeshObject3D` — id, name,
colour, `planeIds`; `MeshObjectSet`). `pose/mesh-object-geometry.js`
derives the shape and **never stores it**. `ui/mesh-objects.js` is the table.
The class is `MeshObject3D` because a JS identifier cannot begin with a digit —
every user-facing string says "3D Mesh Object".

**Connectivity is the shape**, and it falls straight out of the global node pool:
vertices are the pool nodes the member planes reference (two planes referencing
one node give ONE vertex, so a shared corner welds itself — no merge-by-distance
pass exists or is needed), faces are the planes, and two faces are adjacent iff
they list the same unordered vertex pair. Shells, naked edges, manifoldness and
coherent winding are all read off that one adjacency graph.

**The feature is strictly ADDITIVE, and must stay that way.** No method that
predates it changed. In particular **`PlaneModel.deletePlane` does not cascade
into objects and must not be taught to** — membership resolves LAZILY
(`resolvePlaneIds(model)` filters against the live planes on every read), so a
deleted plane simply stops contributing a face and there is no window in which a
dangling reference is dereferenced. The corollary: `planeIds.length` is NOT the
face count; call `planeCount(model)`. `tests/test-mesh-object-3d.mjs` §4 pins
this by asserting a plane model with objects on it is byte-identical to one
without, including after deleting a member plane.

**Two things the annotation does not determine**, both handled explicitly:
- **Winding.** A face's ring depends on `planeFit.normal`, a PCA eigenvector
  whose SIGN IS ARBITRARY. `orientFacesCoherently` fixes the relative half (two
  faces sharing an edge traverse it in OPPOSITE directions). The global half is
  then one bit, decided per topology: a CLOSED mesh by `signedVolume` (negative
  is inward, which is simply wrong), an OPEN one by the convention **+Z is up**
  — `areaVectorZ` orients the surface so its area-weighted normal field points
  along +Z. For a cage that means the FLOOR FACES UP, since vertical walls
  contribute nothing to that sum, and coherent winding then couples the rest, so
  the walls end up on their INWARD faces. That replaced a genuine coin flip: the
  open default used to fall out of the PCA sign of whichever ring came first, so
  the same cage exported either way depending on the order its planes were
  created in. Only an all-vertical surface has no vertical component to read and
  is left undecided — kept exactly as the coherent pass produced it, which is
  stable across rebuilds, since `areaVectorZ` is ~0 there and reading a sign off
  it would flip the object on floating-point noise.
  **There is no user override and no `Flip normals` control**, deliberately: the
  derivation answers every case a toggle could, so a persisted flip would only
  be a second source of truth fighting it. A `flipNormals` left in a file by an
  older build is read and DISCARDED, not adopted — re-applying it would invert
  exactly the objects the derivation already gets right.
- **Concave faces.** The viewport's fan (`_buildPlaneFillMesh`) is right for a
  translucent overlay and self-overlaps on a concave ring, so the geometry module
  ear-clips instead. Its point-in-triangle test is **non-strict** on purpose: a
  vertex exactly ON a candidate ear's edge must block it, or the clipped triangle
  pokes outside the polygon (a plain L-shape hits this).

**Selecting an object HIGHLIGHTS its planes; it does not draw a second body.**
An object IS the cage already on screen, so `viewport3d.setMeshMembership`
fills each member plane's FACE and redraws its corners and edges, fatter, in
**one fixed yellow** — and `syncMeshObject3D` passes it **plane IDS, never
geometry**.

Two details that look like taste and are not. The face is what makes a member
read as a member: an outline alone left the plane wearing its own colour, so on
a five-walled cage the answer to "is this wall in the object?" was a few corner
dots. And the yellow is fixed rather than the object's own colour, because a
highlight has to be legible against whatever colours the user gave their
planes — the payload deliberately carries NO colour field, so there is nothing
inviting the object's colour back in. Only one object is selected at a time, so
a shared highlight colour is never ambiguous; the object's colour remains its
identity in the table swatch and the `.glb`. The face respects depth (or a
cage's back walls paint over its front); the outline ignores depth, so an
occluded member still announces itself. That is
not a style choice. The derived geometry is built in the user's **origin frame**
(the panel quotes volumes in it, and both exporters write it), while the
viewport group that would draw it hangs off `scene` rather than `_framePivot`
and is therefore in **calibration world**. Putting the one in the other drew the
object translated and rotated away from the very planes it was built from the
moment an origin was defined. Reading positions back out of the plane payload
makes that class of bug unrepresentable. The cost is that winding is no longer
visible in 3D — and the panel does not report it either: since winding is
derived there is nothing left for a user to act on, so a read-out would be prose
nobody can use. The connectivity report keeps what IS actionable — the counts,
a closed object's volume, disjoint shells, coincident-but-unshared nodes — and
a single-shell open object, being the ordinary state of a cage with no lid, gets
no line at all.

**And there is no Shape column** on the 3D Mesh Objects table. It carried a
per-row badge (`closed`, `2 shells`, `open — 6 naked`) whose terms nothing in
the panel defined, which is a verdict the reader cannot cash. The report says
what is actionable in sentences instead; a row is swatch / name / planes /
delete.

**Coordinates: LUCID's world is Z-up right-handed and so is Blender's.** No axis
conversion belongs in this pipeline. The only transforms are the applied origin
frame and a uniform positive scale.

**Export (`import-export/mesh-export.js`) is the ONE place that rule is
suspended, and only for glTF.** The Danger-Zone-free pair of buttons in the
block — `Export .stl` and `Export .glb` — write the same derived geometry two
ways:
- **Binary STL, verbatim.** The format defines no up axis and CAD treats Z as
  up, which is already what we have. Triangles only: no colour, no units, and
  every corner repeated per triangle, so the node-level welding is invisible in
  the file by the format's design.
- **Binary glTF, converted to Y-up** — `(x, y, z)` → `(x, z, -y)` — because the
  glTF spec FIXES the up axis at +Y. Blender's importer applies the inverse, so
  the object lands back Z-up exactly as annotated; write Z-up into a .glb
  instead and Blender still rotates it, so the cage arrives on its side and
  every conformant viewer shows it tipped over. The conversion is a −90°
  rotation about X with determinant +1 — a rotation, NOT a mirror — so winding
  survives and **no winding flip accompanies it**. Adding one would silently
  invert every normal. Vertices stay WELDED and no NORMAL attribute is written,
  which is what makes glTF mandate flat shading — right for a faceted cage, and
  the only way to keep the welding a real one.
Both formats store positions as float32 because both define it that way, so a
re-imported mesh is not bit-identical to the project's float64 millimetres. The
project file stays the source of truth. Scale is 1: the calibration's own
millimetres reach the file, and nothing here invents a unit the calibration
never stated.

Coverage: `tests/test-mesh-object-3d.mjs` (the model + the additivity guarantee),
`tests/test-mesh-object-geometry.mjs` (the derivation, with negative controls),
`tests/test-mesh-export.mjs` (both formats at the BYTE level — container
layout, chunk padding, welding, sRGB→linear colour, and the Y-up conversion
with a negative control) and the three real-app files,
`tests/e2e/mesh-object-roundtrip.mjs` (the panel, the pick-and-add membership
editor, the round trip, the scope, and three negative controls),
`tests/e2e/mesh-object-export.mjs` (the buttons, the downloaded bytes, and the
same corner asserted Z-up in the .stl AND Y-up in the .glb, so a writer treating
them alike fails one of them) and `tests/e2e/mesh-membership-highlight.mjs`
(a REAL WebGL viewport: the highlight covers the members and only the members,
and every corner sits exactly on its plane node with an origin frame set —
the derived vertex being elsewhere is the control that keeps that from passing
on a build that simply ignores the frame). The axis claim was
additionally confirmed against **real Blender** (`--background`, gltf + stl
importers): both files put the tracked corner at (0, 0, 300).

## UI Conventions
**No scroll-within-scroll.** A panel or modal gets ONE scroller. Do not give an
inner widget its own `max-height` + `overflow-y: auto` inside something that
already scrolls: the wheel then does different things a few pixels apart, and
content past the inner cap is invisible with no hint that it exists. Let the
widget grow to its full height and, when that makes the page unwieldy, make the
section collapsible (a `<details>`, as the Tracking Wizard's node/camera tables
do) or the container resizable — not scrollable twice.

**Defining Plane Mode blocks the pose-annotation toolbar.** `+ Instance`,
`- Instance`, `Group`, `Edit Group`, `Triangulate`, `Triangulate All`,
`Track Frame` and `Track All` are disabled while the mode is on
(`applyPlaneModeToolbarLock` in `ui/plane-definition.js`) — they act on POSE
annotation, which in the mode is a selection the user can no longer see or
change. The **visibility** controls (User / Predictions / Reprojections / Errors),
Sessions, Tracks / Identity and the Panel toggle stay live: they change what is DRAWN, not what
is annotated. Adding a button to that lock means adding its id to
`PLANE_LOCKED_TOOLBAR_IDS`; if it opens a menu, its wrapper also needs
`PLANE_LOCKED_DROPDOWN_IDS` (a `.tri-dropdown` menu opens on hover and its
items are `div`s, so `disabled` on the button reaches neither).
NOTE the keyboard shortcuts for these actions (`n`, `t`, `Shift+T`,
`Mod+Shift+T`, `Shift+g`, `Delete`) and the Edit / Analysis menu items are
**not** gated yet — they still reach the same handlers.

The mode itself is entered from **View ▸ Define Planes** or **`Mod+Shift+P`**
(`definePlanes` in `ACTION_CATALOG`, dispatched to `togglePlaneMode`). Both go
through that one function, because leaving the mode has unwinding to do — Set
Origin Mode, the angle dialog, the toolbar lock — and a second entry point would
be a second place to forget it. `p` alone is Toggle Predictions; the two are kept
apart only by `matchChord`'s rule that a bare letter requires shift to be UP, so
that pairing is pinned by `tests/e2e/define-planes-shortcut.mjs` along with the
binding being suppressed while a plane-name field has focus.

**`showHotkeysHelp` lives at MODULE scope in `ui/ui-wiring.js`, and has to.** It
has two callers in two different closures — the Hot Keys menu item, wired in
`setupMenus`, and `setHandler('showHotkeys', ...)`, which runs in `setupUI` —
and while it was declared inside `setupMenus`, pressing `?` threw
`ReferenceError: showHotkeysHelp is not defined`. That broke the discoverability
half of the shortcut rule above for EVERY shortcut, silently, since the menu
item still worked. It also refuses to open on top of itself (`#hotkeysClose`
already present), because `dispatchEvent` does not consume the keydown for the
listeners after it. Pinned by `tests/e2e/define-planes-shortcut.mjs` §5.

**A panel's section state is browser-local, and it is remembered.** Every
collapsible `<details>` in the Define Planes panel and the Skeleton tab goes
through `persistSectionState` (`ui/section-state.js`), which restores it from
`localStorage` and writes back on `toggle`. Loading a project RELOADS the page,
so without this the markup's `open` attributes won — every section expanded
again and the user refolded the same ones after every load. Three rules:
- **It is display taste, never project state**, the same class as the plane
  panel's node-size sliders and the Visibility panel's global prefs. It must not
  reach the `.slp`: `save-golden-digest.mjs` would move, and opening a
  colleague's project would refold your panel.
- **The restore runs ONCE, at setup** — not in `refreshPlanePanel`. Restoring on
  every repaint reopens a section the instant the user collapses it.
- **An id with no stored value keeps the markup default**, which is what lets
  the origin panel's **Danger Zone** ship collapsed AND stay off the persisted
  list: it holds the three actions that rewrite the calibration every downstream
  tool reads, and reopening it because it was expanded once in another project
  is the state being collapsed is for.
Storage is best-effort everywhere (private windows and blocked site data throw
on read AND write), so a section that cannot be remembered still opens and
closes. Covered by `tests/e2e/plane-section-state.mjs`.

**Major sections in the Define Planes panel are OUTLINED; sub-sections are
not.** Both levels are the same bordered `.plane-details` box, so "Plane
Appearance" inside Planes read as top-level as "3D Mesh Objects" beside it. The
majors (`.plane-panel > .info-section > .plane-details`) have their existing 1px
border RECOLOURED to the accent, all four sides — not a bar under the title,
because a marked header says where a section starts and it is where a tall open
one ENDS that is ambiguous in a single scrolling column. Recolouring the border
already there rather than adding a second outline is what keeps it from costing
content width in a ~300px panel full of boxes-within-boxes. The header keeps its
own tint so a folded section still says what it is. Danger Zone is outlined the
same way in the error colour — it must not pick up the accent, since the whole
point of the red is that it does not look like its neighbours.

**An ⓘ explains itself BESIDE THE POINTER, never in the status bar.** Every
info icon in the app goes through `ui/info-tip.js`: `setInfoTip(el, text)` to
declare one, `installInfoTips()` once at startup. It used to call `setStatus`,
which paints the text at the bottom-left of the window — the furthest point on
screen from the icon just clicked, in a bar that also carries save results and
errors. Four things about it:
- **It is delegated**, one listener set on `document` matching `[data-infotip]`,
  not per-element wiring. The plane panel rebuilds its tables on almost every
  interaction, so a button wired at creation time would need re-wiring by every
  renderer — and the renderer that forgot would fail silently, since an icon
  with no tip looks exactly like an icon whose text is empty.
- **`setInfoTip` REMOVES `title`.** Left on, the native tooltip surfaces a
  second later saying the same sentence somewhere else. The text stays reachable
  as `aria-label`.
- **The tip lives and dies with the HOVER, clicked or not.** Leaving the icon
  dismisses it; a click only guarantees one is showing, which is what a tap
  needs on a touch device, and buys no extra time. Nothing a click pins open is
  worth the stale explanation left sitting over a panel the pointer has moved
  on from. The one exception is a tip summoned by the KEYBOARD — no pointer to
  leave, so it waits for blur or `Esc`.
- **The keyboard path is gated on `:focus-visible`.** Clicking a `<button>`
  focuses it, so without that gate a mouse click marked the tip keyboard-held
  and it then outlived the pointer — exactly the behaviour the rule above
  forbids.
- **The tip is `pointer-events: none` and flips rather than clamps.** It follows
  the cursor, so taking the hover would make it flicker itself away; and since
  nearly every icon is in the right-hand panel, a tip placed blindly to the
  right would hang off the viewport.
- **KEEP IT SHORT — one or two sentences.** A tip is a label, not
  documentation: it sits over the panel the user is working in, follows the
  pointer, and disappears the moment they move off the icon, so anything long
  enough to need reading is not read. State what the control IS; put the
  caveats on the thing they qualify (a cell's own `title`) or in MODULES.md, and
  let the behaviour be pinned by a test instead of explained in a tooltip. The
  Views column's tip is the model: *"The fraction of number of hand-annotated
  views out of all views."*
- **A click on an ⓘ must not also do the thing underneath it.** These icons sit
  inside a clickable table row, and inside the `<summary>` that folds the very
  section being asked about, so the click listener is in the CAPTURE phase and
  calls `stopPropagation`. Keep every ⓘ a `<button>`: that makes the button the
  click's activation target, which is what stops a `<summary>` ancestor folding
  without needing `preventDefault`. A plain `<span>` ⓘ would fold it.
Covered by `tests/e2e/info-tip.mjs`, including that the status bar is left
untouched and that an element created after startup is served with no wiring.

**Text in a panel, a modal or the status bar can be SELECTED and COPIED.** Two
separate things used to stop it, and fixing either alone leaves the user exactly
as stuck:
- **`Mod+C` never reached the browser.** It is bound to Copy selected instance,
  and the catalog dispatcher `preventDefault()`s every binding it matches —
  which cancels the keydown's `copy` default action too. Highlighted text could
  not be copied; the keystroke wrote "No instance selected to copy" into the
  status bar instead. `shouldIgnoreShortcut` (`ui/keyboard-target.js`) now hands
  the copy/cut chord back **whenever a selection exists**, and only then, so
  Copy selected instance is untouched in the normal annotating case. Paste is
  deliberately NOT in that set — nothing about a selection says the user wants
  to replace it.
- **`user-select: none`.** Section headings in the info panel, the plane panel
  and the Settings modal, and the whole status bar, could not be dragged over.
`user-select: none` is now kept for one thing only: a surface whose job is to be
dragged or repeatedly clicked, where a stray selection is debris — the menu bar,
the toolbars, the view strip, the video overlays, the ✓/✗ toggle cells in the
SLP chooser, the info panel's **tab bar** (a horizontal scroller the user drags;
see MODULES.md `setupPanelTabs`), and **every modal drag handle** (dragging a dialog by its title
would otherwise smear a selection across it). Covered by
`tests/e2e/copy-panel-text.mjs`, which drives the REAL clipboard — Playwright's
`keyboard.press` dispatches the key without running Chromium's edit command, so
the chord goes through CDP with `commands: ['Copy']`.

**The Define Planes panel is TWO sections: Nodes, then Planes.** Planes holds
the roster and the selected plane together, in one `<details>`: the table, then
`+ New Plane`, then that plane's `Name` and three foldables — Nodes In This
Plane, Node Connections and Actions (Triangulate / Fill / Fit, Set Origin, Set
Angle Between Planes) — with Plane Appearance last and OUTSIDE the per-plane
body, since it styles every plane in the table. Picking a plane and editing it
used to be two sections, "Edit Plane" above "Planes", which made the reader hold
a plane in their head while scrolling between the list that picks it and the
controls that act on it. Two rules hold: the **roster is the only selector** (a
row click, the one writer of `planeState.selectedPlaneId` besides
`createPlane` — there is no plane dropdown, and `+ New Plane` creates rather
than selects), and the **Nodes pool stays its own section**, because a node
outlives the planes referencing it and may be in several at once, so presenting
node creation as a sub-step of editing one plane would misstate the model.
`tests/e2e/define-plane-mode.mjs` §2 asserts the section body's whole child
list, so a part that appears, disappears or moves fails there rather than merely
looking odd.

**Outside Defining Plane Mode, the Visibility panel's `Planes` section says what
is drawn.** An annotated cage is scene geometry, so it is drawn in EVERY mode —
right when you are checking a pose against the floor, wrong when five filled
walls sit on top of the frame you are labelling. Four toggles
(`ui/plane-visibility.js`, one reader for both representations): planes in 2D,
planes in 3D, nodes in 2D, nodes in 3D. Four rules hold:
- **All four are ON by default.** Planes were always drawn before the section
  existed, so any other default silently hides existing users' work.
- **Defining Plane Mode overrides all four.** The panel's tables, the 2D
  placement drags and the 3D corner drags act on parts the user has to be able
  to see, so honouring a toggle inside the mode would hide the thing being
  edited. `planeVisibility(modeActive)` is where that override lives, once,
  rather than at each of the two call sites.
- **Planes and nodes are separate, and so are 2D and 3D.** A node outlives the
  planes referencing it and may be in several at once, so wanting the corners
  without the walls is the ordinary case — and the 3D view is often where the
  cage is the whole point while the 2D views are where it is in the way. In 3D
  the two flags are `viewport3d.showPlaneSurfaces` / `showPlaneNodes`, pushed by
  `syncPlanes3D`; they hide MESHES and never filter `_planes`, which is what a
  live drag, the selected-node marker and the mesh-object highlight resolve ids
  against.
- **They decide WHETHER a plane is drawn, never HOW.** A shown plane keeps its
  own colour, edges and `Fill`, so the two representations and the two modes
  cannot disagree about what a plane looks like. There is deliberately **no
  fill override** — a plane that gained a fill by becoming visible is the same
  confusion `mesh-membership-highlight.mjs` pins against for the mesh-object
  highlight ("no fill of its own"), and `plane.filled` is project state that
  only the `Fill` button sets. A cage that reads badly unfilled is a reason to
  click `Fill`, not a reason for the renderer to guess. The four toggles
  themselves ride `localStorage.visibilitySettings` with the panel's other
  global appearance prefs, so nothing here reaches the `.slp` and
  `save-golden-digest.mjs` must not move.
Covered by `tests/e2e/plane-visibility-toggles.mjs`, which counts pixels of two
colours on a real overlay canvas and meshes in a real WebGL scene, asserts each
toggle repaints BY ITSELF, and pins that a filled and an unfilled plane are
drawn exactly as annotated in both modes.

**The Planes table shows `Views: annotated / total`, and ANNOTATED is not
PLACED.** `annotatedViewStats` (`ui/plane-definition.js`) counts the views where
at least one of the plane's corners is hand-placed — present, not switched off,
not reprojected — over every view in the session. That distinction is the whole
point: `Triangulate` reprojects a plane into the views it was never placed on,
so afterwards it IS placed everywhere while the user may have drawn it twice,
and those corners are the solve's own output, excluded from the next solve as
evidence. Counting them would make the fraction read full after one Triangulate
and never say anything again. It uses the SAME test `triangulatePlane` applies
to choose contributing views (`usableViews`), so the number and the solver
cannot disagree. No calibration → a dash, not `0/0`.

Three unlabelled marks were removed from that row to make room, and none should
come back: the `+n` shared-node badge (`+` reads as an addition — `4 +4` on a
four-cornered plane looked like nine; the count lives in the cell's tooltip
now), the `3D` solved badge (two letters in a box in a column with no header),
and the placed-view count beside the caret (a THIRD view number on the row,
measuring something different from the Views fraction with nothing saying so).
Covered by `tests/e2e/plane-views-column.mjs`.

**A major section explains itself in an ⓘ, not a paragraph.** The Define Planes
panel's Nodes, Node Connections, Planes and 3D Mesh Objects each used to END in
a `.plane-hint` block of prose. In a ~300px column that is a wall of text
permanently wedged between one table and the next, read once and then scenery —
and it sat at the FOOT of the section, answering "what is this?" after the user
had scrolled past whatever they were unsure about. The sentence now lives in the
`<summary>`'s ⓘ (`PLANE_SECTION_INFO` in `ui/plane-definition.js`), where it
costs 16px, is where the question comes up, and survives the section being
folded. Two places deliberately have NEITHER: the **Danger Zone**, whose warning
belongs in the confirmation dialogs that actually fire, and the Planes
section's **"+ Add"**, where a working picker explains itself — only its two empty-state
lines, which are real dead ends, remain. Covered by
`tests/e2e/plane-section-info.mjs`.

**Clicking a node in the Nodes table RINGS it in 3D, and the next click
anywhere else clears it.** The table is the whole project's node pool and
nothing in a row answered "which of the dots on my cage is this?".
`planeState.selectedNodeId` is transient display state — never saved, never
remembered — and three rules hold:
- **One listener decides both halves**, a `click` on `document` in the CAPTURE
  phase, wired once in `setupPlaneDefinition`. Anything carrying
  `data-plane-node-id` selects that node; everything else — the rest of the
  panel, the 3D view, any canvas — clears it. Capture, because a row's own
  controls `stopPropagation` (the colour swatch, the padlock, the pin popover)
  and a click on one of those still means "this node". One listener, because
  wiring selection per row and clearing per surface leaves every surface nobody
  remembered to wire holding a stale marker.
- **Selecting must not rebuild the Nodes table.** The click that selects a row
  is very often the click that is about to focus its name field, and a rebuild
  throws that input away before the caret lands in it — so `setSelectedNode`
  toggles a class on rows that already exist.
- **An ID crosses into the viewport, never a position.**
  `setSelectedPlaneNode({nodeId})` resolves it against the plane payload's
  `nodeIds`, so the marker is built from the very numbers the corner was drawn
  from — the same rule `setMeshMembership` follows, and for the same reason
  (this group is in CALIBRATION world, while anything derived is in the user's
  origin frame). One marker even for a shared corner, and a node in no plane is
  marked nowhere: the 3D view draws planes, so a node no plane references is
  not in it. The marker is three rings with an EMPTY middle, because a corner
  is a dozen pixels across and anything solid over it hides the node's own
  colour. Covered by `tests/e2e/plane-node-selection.mjs`.

**Modals must close on `Esc`** unless explicitly stated otherwise. When building
or editing any modal/overlay dialog, wire a `keydown` listener that closes it on
`Escape` (and removes the listener on close). For a modal mid-operation (e.g. an
in-progress export), `Esc` should cancel/stop that operation rather than tear the
modal down. Example: `showExport3DVideoModal` in `ui/export-modals.js`.

## Tests
There are **three** test populations, each with its own runner. Run all three —
they cover disjoint code, and a green run of one says nothing about the others.

```bash
node tests/e2e/run-unit-tests.mjs     # tests/*.js  (browser suite, headless) — 1603 assertions
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
    Its sibling class is the **resident-only EDIT**: a change made to a resident
    predicted-only frame and nowhere else is undone by the next window release
    (sweeps, playback eviction) and by the streaming save, which writes the
    store rows of any camera-frame without a user instance. Cycle 5c pins this
    for the interactive deletes — which must go through `deleteTargetsFromStore`
    (`ui/custom-delete-ops.js`) — by deleting through the real Delete paths,
    asserting the frames were RELEASED before re-hydrating them, then saving and
    reopening.
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

**One VISIBLE-browser run at a time, machine-wide (`scripts/browser-lock.mjs`).**
Several Claude sessions often work on this repo at once, and headed runs —
`open -a` into the user's real Chrome/Firefox/Safari/Brave, Playwright
`headless: false`, `HEADED=1` — invalidate each other: opening a tab pushes
another session's tab to the background (its requestAnimationFrame is then
throttled, logged as "TAB HIDDEN"), bringing an app to the front covers
another run's window, and every timing shares one CPU/GPU. On 2026-10-05 three
sessions overlapped this way. The lock is a directory, `/tmp/luc3d-browser.lock`
(mkdir is atomic), whose `owner.json` names the holder; a dead or reused owner
pid is broken automatically. The headed runners above (`_probe-capabilities`,
`_bench-playback`, `_bench-step-cursor`, `_bench-image-keyframe-decode`,
`_bench-progress-overlay`, `_diag-image-keyframe-snap`, and
`_diag-real-align-views` / `run-unit-tests` under `HEADED=1`) take it
themselves; wrap any other headed run, or a sequence of them, with
`node scripts/browser-lock.mjs --label="what" -- <command>` (`status` shows the
holder; a runner inside the wrapper does not wait on it). Releasing brings the
Claude app to the front BEFORE freeing the lock, so the next holder's window
opens on top of it — do not add a separate `osascript … activate` after a
wrapped run. Headless runs do not take it. Covered by `tests/test-browser-lock.mjs`.

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
