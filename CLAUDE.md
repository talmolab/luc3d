# LUCID — Label Unification and Correspondence in 3D

Multi-view pose annotation GUI. Vanilla JS ES modules served as static files — no build step.

## Architecture
`index.html` loads `app.js` (`<script type="module">`), which only imports `pose/initialization.js`. Per-module purpose/exports/dependents: **`MODULES.md`** (repo root).
- `pose/` — data model, cross-view tracking, DLT triangulation, plane/mesh/origin models, ID-switch checks, lazy residency, app init (pure logic, mostly DOM-free). Workers: Track All runs on one (`tracker-pool.js`); triangulation math is `triangulation-core.js`, solved in parallel by `triangulation-pool.js`.
- `ui/` — rendering, interaction, panels, modals, timeline, 3D viewport, settings, exports.
- `loading/` — video decoding, session/SLP loading, file selection, web workers.
- `import-export/` — save/load, SLP import/merge, `metadata.lucid` serializers, mesh export.
- `demo-data.js` (synthetic data), `styles.css` (all styling).

## Local Development
```bash
python3 server.py 8080            # Windows: py server.py 8080 (or python3 -m http.server — no --offline)
# App: http://localhost:8080/   Tests: http://localhost:8080/tests/test-runner.html
python3 scripts/offline_deps.py install && python3 server.py --offline
```

## Deployment
`luc3d.sleap.ai` is the GitHub Pages custom domain (Cloudflare-proxied) for this repo; the `CNAME` at the `gh-pages` root makes it work. `.github/workflows/deploy.yml` publishes channels on `gh-pages`; `pr-preview.yml` owns `/pr/<n>/`. A deployed "build" is a copy of the repo at a ref.

Channels:
- `/` — newest **full release** only. `/stable/` — a one-file meta-refresh alias to root (deep links under it 404).
- `/latest/` — newest release incl. pre-releases. `/dev/` — every push to `main`. `/pr/<n>/` — previews, removed on PR close.
- Only a full release newer than the current one moves root, and the same run rewrites `/stable/`; channels only move forward. `workflow_dispatch` target `root` is the manual promote (writes root + alias).
- Releases are cut **by hand** (`gh release create vX.Y.Z --generate-notes`) — an Actions-created release would not fire `release: published`. Tags must match `vX.Y.Z` or `vX.Y.Z-N`.

Rules:
- **Sub-path safe:** keep every URL relative (importmap, imports, `document.baseURI` in tests). Never origin-root-relative (`/lib/...`) — it 404s on every channel but root. Alias redirect targets are relative too.
- **Pushing to `gh-pages`:** both workflows push under different concurrency groups, so any step that pushes must re-sync and retry in a loop (as `deploy.yml` / the preview cleanup do) and must **never force-push** (the preview deploy action runs with `force: false`). The cleanup triggers on `pull_request_target: closed` (plain `pull_request` doesn't run for conflicted PRs); it is safe only because it never checks out PR code.
- **Root is the only target that wipes.** Adding a channel means adding it to the keep-list (`find . -maxdepth 1 … ! -name` in `apply_targets`) or the next full release deletes it. Root is requested by an explicit `root: true` flag; keep the refusal of an empty/`.`/`/` path. `CNAME` is excluded from the wipe and recreated if missing. No `.nojekyll`.
- **Version stamp:** both workflows run `scripts/stamp-version.mjs <dir> <commit> <label>` on the staged copy (never the repo). It appends `?v=<commit>` to every same-site code reference (relative imports, `new URL('…js', …)` workers, `<script src>`, stylesheets, importmap entries, modulepreloads) so Cloudflare-cached modules can't mismatch a fresh `index.html`. It is all-or-nothing — the deploy fails if any relative module ref is left unstamped (it would load twice). Keep code references literal and relative: no computed `import(var)`, no root-absolute paths.
- The label fills the `lucid-release` / `lucid-commit` `<meta>` tags shown by `ui/version-label.js`: the tag when the ref is a release tag, else `dev`, or `PR #<n>`. The tags stay **empty in the repo**; the stamp fails if they are missing. The label never reaches the `.slp`.
- **Modulepreload:** stamping then runs `scripts/preload-modules.mjs`, inserting one `<link rel="modulepreload">` per module of the startup graph (static imports + importmap CDN entries) **right after the importmap** (Chrome ignores an importmap arriving after module loading starts). The list is derived from the stamped files, never hand-maintained; dynamic `import()` and workers are deliberately excluded. `tests/e2e/stamped-build.mjs` fails if the app requests a same-site module outside the block or any preload not exactly once — so a static import the walker can't see fails there.
- `yaml` loads as jsdelivr's single-file `yaml@2.8.0/+esm` (offline maps it to `lib/yaml/browser/index.js`). The head `<script>`s (mp4box, three, OrbitControls, h5wasm IIFE) are `defer` — they still run in order before any module script. Bundling was considered and rejected (adds a build step; deployed code would differ from tested source).
- Tests: `tests/test-stamp-version.mjs`, `tests/test-preload-modules.mjs`; `tests/e2e/stamped-build.mjs` stamps the working tree, loads the app and runs the browser suite on it — run it after changing imports, workers or `index.html`. Cold-start bench: `tests/e2e/_bench-cold-start.mjs`.

## Offline mode

Four deps load from jsdelivr by default (three.js 0.147.0, mp4box 0.5.2, dockview-core 6.6.1, yaml 2.8.0); everything else in `lib/` is committed. **`offline-deps.json` is the single source of truth** (versions, tarball URLs, integrity, file lists, CDN URL → local path). Its consumers:
- `scripts/offline_deps.py install|check|bundle|clean` — stdlib only; installs into gitignored `lib/<pkg>/` (each keeps a tracked `.gitignore` + `PROVENANCE.txt`); honors `LUCID_NPM_REGISTRY`. `check` fails if any `cdn.jsdelivr.net/npm/<pkg>@<ver>` in source disagrees with the manifest; `check --strict` also fails on any CDN URL outside `lib/` the manifest doesn't map — a deliberate exception goes in the manifest's `unmapped` block **with a reason**.
- `server.py --offline` (or `LUCID_OFFLINE=1`) rewrites mapped URLs in served `.html`/`.js`/`.mjs` (must cover `.js`: dockview is imported from `ui/sessions-panes.js` and `ui/overlay-export-modal.js`); refuses to start if a package is missing.
- `offline_deps.py bundle` stages a zip with URLs pre-rewritten plus the launchers in `scripts/offline-bundle/`.

Rules:
- Rewritten paths are **depth-relative** (`./lib/…`, `../lib/…` from `tests/`), never `/lib/…`.
- Node-only `.mjs` outside `lib/` is never rewritten (`is_rewritable`, shared by bundle and server) — `tests/test-stamp-version.mjs` holds CDN URLs as fixtures.
- `MP4BOX_CDN` (unpkg mp4box@0.5.4) in `lib/sleap-io/chunk-X76PRJK6.js` is intentionally unmapped: unreachable because `index.html`'s mp4box `<script>` always sets `globalThis.MP4Box` first. If that tag is ever removed, the unpkg fallback goes live.
- **The image ID-switch check is the one feature that does not work offline**: `TRANSFORMERS_URL` (`ui/image-embedder.js`) is `unmapped` because the model weights come from huggingface.co too. Offline it reports `MODEL_OFFLINE_REASON` and retries without reload via `importTransformers`. Test: `tests/e2e/image-check-offline.mjs`.
- Test: `tests/e2e/offline-server.mjs` (all off-origin requests aborted). Licenses in `lib/LICENSES.txt`.

## Dependencies

Loaded via `index.html` script tags / importmap (mirrored in `tests/test-runner.html`).
- **dockview-core pinned to 6.6.1 in THREE places** — `index.html` CSS, `ui/sessions-panes.js`, `ui/overlay-export-modal.js` (`check` enforces agreement). 7.x renamed `onUnhandledDragOverEvent`. `ui/overlay-export-modal.js` also uses dockview **internals** (sash resizing, feature-detected) and `styles.css` `#ovDock` its DOM; on a bump run BOTH `tests/e2e/overlay-export-sash-distribute.mjs` and `overlay-export-sash-tracking.mjs`.
- **transformers.js pinned to 4.3.0** + `onnx-community/dinov2-small`, fetched only when the opt-in image ID-switch check runs. The check is calibrated to this model's embeddings of `cutCrop`'s crops: bumping either, or changing the crop, needs recalibration (MODULES.md `pose/id-switch-check.js`). Without a GPU it runs the **fp32** model (never int8) in `ui/image-model-worker.js` (MODULES.md `ui/image-embedder.js`).
- **Video export = mediabunny via `ui/video-encode.js`, the one encoding seam.** Do NOT add a second muxer (`lib/mp4-muxer/` was removed). Re-verify the encoder contracts in `lib/mediabunny/PROVENANCE.txt` on any mediabunny bump. mediabunny **1.30.0** also drives sleap-io.js decode, so a bump must retest both decode and encode.
- **h5wasm 0.10.3, vendored** (`lib/h5wasm/`, ESM + IIFE); no CDN h5wasm on any path. Local patch `LUCID local patch (cold-read)` in BOTH `hdf5_util.js` and `h5wasm.iife.js`: WORKERFS re-reads any all-zero part of a read **plus the 4 KiB block on each side** and fills in only zero bytes (`lucidColdReadGuard`) (cloud files read mid-download return zero pages). Every h5wasm File reader goes through it (SLP worker, `frame-worker.js`, sleap-io.js's streaming worker via `importScripts` of the IIFE); reads that bypass WORKERFS (video, Load 3D Points) use `loading/cold-read-guard.js`. Test: `tests/test-workerfs-cold-read.mjs`. (These files are binary-ish: use `grep -a`.)
- **sleap-io.js 0.5.5**, vendored in `lib/sleap-io/` (`index.browser.js`, `chunk-X76PRJK6.js`, `chunk-H7G4PJNA.js`, `chunk-YS7Q6CO6.js`, `gdrive-6DDSPUUK.js`; `mediabunny-stub.js` is unused), built from source at `e8dbaef8c` via `scripts/revendor-sleap-io.sh` — re-vendor from the npm dist once 0.5.5 is published. Writes **SLP 2.8** (columnar `/session_data` for 3D + grouping, slim `sessions_json`). Its `pako`/`mediabunny` deps are vendored in `lib/`. Default video decode is its `MediaBunnyVideoBackend` (opt out: `LUCID_VIDEO_BACKEND='html5'`).
  - **Read**: `parseSlpViaSleapIO` (`import-export/file-io.js`) → `readSlpStreaming`; grouping via `reconstructInstanceGroupsFromSession` (`slp-import.js`). Raw worker `parseSlpH5` remains for analysis `.h5` and fallback (`parseSlpForImport` dispatches; that path uses `reconstructInstanceGroupsFromDicts`).
  - **Write**: `saveSlpToBytes` / streaming `openSlpWriter` over `buildSlpLabelsAllViews`'s typed graph. Interop gate: `scripts/validate_slp_sleap_compat.py`.
  - **Bump**: `npm pack @talmolab/sleap-io.js@<ver>`, copy `dist/index.browser.js` + its chunk closure (keep `gdrive` chunk + `mediabunny-stub.js`), drop orphaned chunks, check exports and importmap bare imports, re-apply patches, run the suite.

### sleap-io.js local patches
**Re-apply every one after any re-vendor (grep `LUCID local patch` with `grep -a`), and report upstream.** Byte-level guard for all write-side patches: `tests/e2e/save-golden-digest.mjs` **must not move**.
- `(#115)` `chunk-X76PRJK6.js` `MediaBunnyVideoBackend`: `sample.close()` after `toVideoFrame()` (VideoSample leak); sort `_frameTimes` by timestamp in `initialize()` because `packets()` yields DECODE order (B-frame videos returned wrong frames). Test: `tests/e2e/mediabunny-bframe-decode-order.mjs` (regenerate fixture video + PNGs together: `tests/fixtures/bframes-test/make_fixture.sh`).
- `(luc3d frame-index)` same `initialize()`: `packets(…, { metadataOnly: true })` (indexing skips payloads). Test: `tests/e2e/mediabunny-frame-index-metadata-only.mjs`.
- `(sleap-io.js#231)` writes the `instances` table as `"<d"` not `"<f8"` (h5wasm parses `"<f8"` as float32, corrupting `point_id_start/end` past 2^24). `points`/`pred_points` stay f32 on purpose. Test: dtype check in `tests/test-lazy-reopen.js`.
- `(luc3d #191)` (+ older `#185`, `#190`, `#185/#189`) `writeSessions` streams the `/session_data` tables through `LucidAppendTable` (8192-row buffer; a table that never overflows is written one-shot, keeping small files byte-identical; datasets are created on first flush, so an empty table such as `pred_points_3d` stays absent). The #185/#190 sinks are retained but unused there; `instanceGroupMemberRowsInto` must stay in sync with `instanceGroupMemberRows`. Test: `tests/e2e/save-session-3d-typed-sink.mjs` (asserts > 8192 frame groups so flush boundaries stay covered).
- `(luc3d #189)` `chunk-H7G4PJNA.js` `reconstructColumnarFrameGroups` emits a flat `Float64Array(3N)` per instance group (LUCID's `points3d` shape) instead of boxed rows — compacted, never a `subarray` view (the predicted table is stride 4 and a view pins the whole matrix); `Instance3D.nVisible` handles flat; writer accepts flat or boxed (`pushFlat`, `lucidCount3dRows`). Tests: `tests/test-slp-export-canonical.js`, `test-lazy-reopen.js`, `test-slp-streaming-write.js`.
- `(luc3d #193)` `normalizeStructData`/`normalizeStructDataset` build `Float64Array` columns (f64: ids exceed 2^24; convert `BigInt64Array` explicitly or the store silently comes back empty). Test: `tests/e2e/reopen-store-columns-typed.mjs`.
- `(luc3d eager-save)` `writeLabeledFrames` appends the 2D tables through `LucidAppendTable` (`push` takes 10 values); `from_predicted` resolved by a pre-pass; boxed `emitInstancePoints` is kept for `SlpStreamWriter`. Test: `tests/e2e/save-2d-tables-append.mjs`.
- **Not a patch, but uses bundle internals:** `makePooledSioInstances` (`import-export/file-io.js`) serves `SIO.Instance`'s private `_xy`/`_visible`/`_complete`/`_score`/`_n`/`_names`; after a re-vendor check they still exist and run `tests/test-sio-pooled-instances.js`.
- **Obsolete — do NOT re-apply** the old #134 `serializeInstanceGroup` patch (function no longer exists under SLP 2.8; `tests/e2e/save-no-inline-dup.mjs` guards the layout).

**Memory rule behind #185–#193 and eager-save:** the renderer's V8 heap is hard-capped near 4 GB; big per-row data must live in typed arrays (outside the cage) or be flushed incrementally — never one boxed JS array per keypoint/row.

## Project state in `metadata.lucid` (Visibility + Define Planes)

Per-session state, written to each session's dict by exactly two modules:
- `import-export/visibility-metadata.js` (`VISIBILITY_METADATA_KEYS`): `videoBrightness`/`videoContrast`/`videoRotation`, `hiddenCameras`/`hiddenTracks`/`hiddenIdentities`, `idSwitchReview`, `numAnimals` (a count or `"auto"`; absent until asked, so a reopened session asks again; changing it marks the project dirty).
- `import-export/plane-metadata.js` (`PLANE_METADATA_KEYS`, mapping in DOM-free `pose/plane-serialization.js`). `planeNodes`/`planes`/`meshObjects`/`planeOrigin` are project-scoped: the same in every session, read from the first one ingested. `planePlacements` is per session and must not leak.

Writers: `file-io.js`, `slp-streaming-write.js`, `save-load.js`. Readers: `handleLoadSlpFile`, `handleLoadProjectSlpLazy`, `handleLoadSessionFolderSingleSlp` and the `save-load.js` reader. A new setting changes only its module. A new loader that builds a Session by hand must call BOTH readers, or settings and planes silently reset to defaults. The per-camera and multi-session folder loaders are NOT readers: they ignore a root `.slp` and read camera-folder `.slp` files as 2D only.

Rules:
- **Never write defaults.** `tests/e2e/save-golden-digest.mjs` must not move.
- **Never touch other `metadata.lucid` keys** (keeps files SLEAP-readable).
- **Address plane points and membership by node ID, never by pool index**, and keep the file's IDs (`adoptNode`/`adoptPlane`).
- **Call `resetPlaneState()` before every load** (`readPlaneMetadata` only fills an empty model). Exception: the single-SLP folder loader with a project open adds a session without resetting, and reads plane 2D only if `planeMetadataConflict` finds every node and plane matching by id and name (node IDs restart at 1 in every project).
- **Call `markDirty()` on every plane or node mutation** (not the browser-local size sliders).
- Global appearance prefs stay in `localStorage.visibilitySettings`, never the `.slp`.

Tests: `test-visibility-metadata.js`, `test-plane-serialization.mjs`, e2e `visibility-settings-roundtrip`, `plane-persistence-roundtrip`, `reopen-folder-session-settings`.

## Lazy projects: resident frames are a window, and eviction must be lossless

On a lazy project `session.frameGroups` holds only hydrated frames. Playback evicts them via `evictLazyFrames` (`pose/triangulation.js`), with the rules in DOM-free `pose/lazy-residency.js`.
- **Evict a frame only if re-hydrating it rebuilds exactly what is resident** (`frameEvictionBlocker` compared with `SioLazyLoader.describeStoreFrame`). The blocker list is in MODULES.md `pose/lazy-residency.js`; a new kind of in-memory-only state must be added to it. A user instance always pins its frame, group member or not: the streaming save reads 2D edits from resident frames only.
- **Never evict from `batchLoadLazyFrames`.** `sweepLazyFrameWindows` holds residency for its whole run.
- **`LAZY_PLAYBACK_AHEAD` is both the loader lookahead and the protected window.** Never split them. `LAZY_KEEP_BEHIND` (512) must stay above `MAX_TRAIL_FRAMES` (500, `ui/trail-presets.js`), because trails draw resident frames only. A seek hydrates ahead, so the draw path fills the trail behind it (`ensureLazyTrailWindow`), and a non-resident frame ENDS a lazy trail (`trailWindowFrames`' `residentOnly`).
- When you drop a frame, also drop its derived reprojection caches.
- `session.instanceGroups` is never evicted. Members' 2D returns to the store when their frame leaves residency (`releaseFrameMembers2d`), but only when `member2dReleaseBlocker` allows it. Re-adopt by the member's current `_rawInstIndex`, never a cached row (store compaction renumbers released members).
- **Never write the shared `lazyPlaceholderXY` buffer.** Every in-place writer on `Instance` must call `_ownXY()` first.
- To read member 2D on a frame you do not hydrate, bracket the read with `hydrateFrameMembers2d`/`releaseFrameMembers2d` (as `frameCropGeometry` in `ui/image-embedder.js` does).

Tests: `test-lazy-residency.mjs`, e2e `lazy-playback-eviction`, `sequence-lazy-workflow`.

## Per-node prediction scores

`ui/node-tooltip.js` shows a node's name and, on a prediction, that node's score, with a stripe in its skeleton colour. Take the colour from `getGroupColor`/`unlinkedBaseColor` (`ui/overlays.js`); never compute it separately.
- **Eager instances:** scores go into shared `Float32Array` pool chunks (`Instance.setPointScores`), and the instance keeps only the integer `_ps`. Never use one array per instance.
- **Lazy instances:** the store is the only copy. `SioLazyLoader.predictedPointScore` looks the score up by `_rawInstIndex` and node NAME (a skeleton edit re-indexes resident instances, not the store). Never copy scores onto hydrated instances.
- **Ask `Session.predictedNodeScore` for a score.** It returns NaN unless the instance type is `'predicted'`.
- **Every writer writes each node's own score** (`_buildSioPoints`), and uses the instance score only for a node with none.
- SLEAP analysis `.h5` `point_scores` are dropped on purpose (see the NOTE in `loading/slp-import-worker.js` `parseAnalysisH5`).

Tests: `test-node-scores.mjs`, `test-node-score-export.js`, e2e `node-score-tooltip`.

## Triangulation must not depend on where the origin is

`triangulatePointDLT` (`pose/triangulation-core.js`) solves in a frame built from the cameras only (`dltNormalizingFrame`). Without it, the answer would depend on where the world origin is, and Track All's association (`pose/cross-view-tracker.js` `_retriangulate`) scores against these points.
- Build that frame from the cameras ONLY, never from observations or a first-pass answer.
- The tracker always uses DLT, never BA. Fix the estimator, not the setting.
- Test with noisy fixtures: noiseless rays pass on a broken build.
- New tracker cost terms must not read absolute world coordinates.
- `dltHomogeneousFlat`'s frame arguments are optional; leaving them out must be bit-identical to the raw rows (`tests/test-triangulation-kernels.mjs`).
- `smallestEigvec4Inverse` must iterate until it converges, with the Jacobi kernel as fallback. Never loosen `INVERSE_TOL` (1e-15); invariance tests fail. Before changing the solve, A/B Track All identities with `tests/e2e/_diag-trackall-ab.mjs`.
Test: `tests/e2e/triangulation-frame-invariant.mjs`.

## The defined origin moves the CALIBRATION, never the points

Set Origin (`ui/origin-definition.js`, `pose/origin-frame.js`) changes only what is drawn. Never re-bake points, cameras or plane nodes. Any node of a fitted plane can be the origin; UI text says "node", not "corner".
- **Export New Calibration** writes `REBASED_CALIBRATION_NAME` via `rebaseExtrinsics`. **`t_new` comes from `frame.origin`, NOT `frame.translation`**; using translation gives an almost-correct calibration. Set as New Calibration writes the same name with byte-identical TOML (same writer). Intrinsics and camera order stay unchanged.
- **`pickCalibrationFile`** (`loading/calibration-pick.js`; keep it import-free so Node tests can load it) prefers the rebased name, otherwise the lexicographically first. It returns the ignored names so the loader can warn. Never rely on scan order.

**Set as New Calibration** (`pose/origin-rebase.js`, `ui/origin-rebase.js`):
- 3D points, plane normals (rotation only), plane nodes (locked ones too) and cameras all move together (`p' = R·p + t`; cameras `R_cam·Rᵀ`, `R_cam·origin + t_cam`), so no pixel moves.
- Plan, then apply: `planOriginRebase` writes nothing; `applyOriginRebase` swaps in its result. A cancel or failed write leaves the project byte-identical. Never transform in place and invert.
- Call `showSaveFilePicker` synchronously inside the Continue click; user activation expires.
- Write the calibration to a NEW file, never over `calibration.toml`.
- Count every 2D instance in the project, not just `frameGroups`: `forEachInstanceRow` when lazy, members plus `unlinkedInstances` when eager.
- Multi-session: re-base a filtered sessions array, with no mode flag. The active session (`sessions.indexOf(state.session)`) cannot be deselected. Recount with `subsetRebaseTally`, never by re-walking the project.
- `autoSaveAfterRebase` calls `quickSave` only when `state.slpFileHandle` exists. Otherwise set a status asking for Save As (the picker would throw `SecurityError`). Success means `!state.isDirty`, not "no exception". Save before writing the summary status; `quickSave` overwrites it.
- The dialog's folds are never persisted (no `persistSectionState`).
- Afterwards the origin and `triangulationResults` are cleared. A saved file changes only `points_3d` and `sessions_json` (`tests/e2e/origin-rebase-slp-diff.mjs`).

The Danger Zone actions show only while `originState.frame` is set. Reset to Calibration Origin goes through `confirmClearOrigin`. `clearOrigin` itself stays unguarded.
Tests: `tests/test-origin-frame.mjs`, `tests/test-origin-rebase.mjs`, `tests/test-calibration-file-pick.mjs`, `tests/e2e/set-new-calibration.mjs`, `tests/e2e/origin-picks-any-node.mjs`.

## Multi-session calibration divergence

Per-session calibrations can silently disagree. `compareSessionCalibrations` (`pose/calibration-compare.js`, DOM-free) + `noteSessionCalibrationDivergence` (`ui/calibration-notice.js`):
- **Runs LAST**, as `promptImportSkeletonForAllSessions`'s `onDone` — never mid-load or stacked on another modal.
- **Silent unless `ok === false`.** A session with no calibration is "not compared", not a third calibration.
- **The modal lists only WHO differs**: session folder names per calibration. No prose/offset/remedies (e2e asserts absent); the measured kind/offset go to the console.
- A note: one dismiss, Esc closes, writes nothing.
Tests: `tests/test-calibration-compare.mjs`, `tests/e2e/multi-session-calibration-notice.mjs`.

## Plane-node pin states; Set Angle Between Two Planes

`PlaneNode.pin`: `'none' | 'plane-locked' | 'locked'` (`pose/plane-nodes.js`). `immutable` is an accessor for `pin === 'locked'`; keep it.
- **`plane-locked` is NOT an anchor** — never pass it to `fitPlaneConstrained`. `planeImmutableMask` (`ui/plane-definition.js`) and `planeNodeImmutability` (`pose/plane-data.js`) report `locked` only.
- `locked` is enforced by `PlaneNode.setPoint3d` refusing; `plane-locked` by `PlaneModel.constrainPoint3dForNode`. **Every 3D write of a node goes through it** (`writePoints3dForPlane`'s `constrain` hook) — incl. 3D drags and `applyPlaneFit`, which must store `plane.planeFit` BEFORE the constrained write.
- **The constraint is the intersection of ALL planes the node is in** (`planeLockForNode` rank 0–3; `planeIntersectionBasis` / `projectOntoPlaneIntersection` in `pose/plane-fit.js`; near-parallel planes dropped by `PLANE_INDEPENDENCE_TOL`). **No `pinPlaneId`** — a saved one is read and discarded.
- Project onto a USABLE fit: `usablePlaneFit` (stored fit, else derived from the plane's other solved corners, **excluding the node being constrained**; <3 other corners → inert). Setting a pin clears stored fits, so never require one. Angle dialog and 3D drag share it. Set Origin needs a STORED fit.
- Typed node `x/y/z` (`ui/plane-nodes-panel.js`) takes the 3D-drag path: **2D follows 3D** (every placed view rewritten to the reprojection); `locked` → inputs `disabled`; an untouched field keeps its full stored double, not the 4-dp display.
- Save: defaults omitted, ride `planeNodes` (`save-golden-digest.mjs` must not move); `locked` also writes `immutable: true`, `plane-locked` does not.

Set Angle (`ui/plane-angle.js`, math `pose/plane-angle.js`): angle is unsigned `acos(|n·n|)` (normal sign is arbitrary); smallest rotation about the shared edge; ROTATE the stored fit, never re-fit. Apply re-plans before committing, then sets moved nodes `plane-locked` (not downgrading `locked`); a moved node also in another plane is pulled into it too → `plane_locked_elsewhere` warning (may miss the target). Dialog is non-modal (no scrim) but freezes plane data while open via `isAngleModalOpen()` in all edit paths (`applyAngleModalLock`, 3D `editable:false`, `isPlaneDataLocked` + `handlePlaneDrop`). Offer usable planes, not just fitted.
Tests: `test-plane-constrained-fit`, `test-plane-nodes` §20b/§20c, `e2e/plane-lock-holds`, `test-plane-angle`, `e2e/plane-angle`.

## 3D Mesh Objects

Object = group of planes (`pose/mesh-object-3d.js`); shape derived, never stored (`pose/mesh-object-geometry.js`); table `ui/mesh-objects.js`. Shared nodes weld vertices.
- **Strictly additive.** `PlaneModel.deletePlane` must NOT cascade into objects; membership resolves lazily (`resolvePlaneIds`). Use `planeCount(model)`, not `planeIds.length`.
- Winding derived: `orientFacesCoherently`, then closed → `signedVolume`, open → +Z up (`areaVectorZ`); an all-vertical surface (`areaVectorZ` ≈ 0) keeps the coherent pass's result. **No flip-normals control**; old `flipNormals` read and discarded.
- Concave faces: ear-clip, non-strict point-in-triangle.
- Selection: `syncMeshObject3D` → `viewport3d.setMeshMembership` gets plane IDS only, never geometry (derived geometry is in the origin frame, the viewport in calibration world). Highlight is one fixed `MESH_MEMBER_COLOR`; payload has no colour field. Face fill depth-tested, outline/corners `depthTest:false`.
- World is Z-up. Export (`import-export/mesh-export.js`): STL verbatim; GLB converts `(x,y,z)→(x,z,-y)`, a rotation — **no winding flip**, welded, no normals. Both float32, scale 1 (calibration mm); the project file stays source of truth.
Tests: `test-mesh-object-3d`, `test-mesh-object-geometry`, `test-mesh-export`, `e2e/mesh-object-roundtrip`, `e2e/mesh-object-export`, `e2e/mesh-membership-highlight`.

## Skeleton edits re-shape every annotation

One skeleton object is shared by all sessions, and `Instance` stores 2D by node INDEX, so a node edit re-shapes the whole project. All five edits (add/remove/rename node, add/remove edge) go through `confirmSkeletonEdit` (`ui/skeleton-edit-warning.js`), counted by `pose/skeleton-edit-impact.js`.
- Count the WHOLE project: lazy → `lazyLoader.forEachInstanceRow`; eager → frame-group instances + `unlinkedInstances`. Never `frameGroups` alone.
- Settle the sessions BEFORE mutating (handed to `onConfirm`) and apply only to them (`adoptEditedSkeleton`, `ui/info-panel.js`), never `setProjectSkeleton`; sessions on a different-shaped skeleton are named, not counted or edited.
- Node edits clear `state.triangulationResults` and each session's copy (stale snapshots duplicate info-panel tables).
- 2D, `nulledNodes` and `InstanceGroup.points3d` move together (removal splices the 3D); drop cached reprojections; keep 3D pooled (`pooledPoints3d`, `NO_REPROJECTED_INSTANCES`). A new node on a USER instance is placed and nulled (so it stays clickable); predicted instances get an empty slot.
- Lazy projects with non-resident frames get a red warning: edits are resident-only and the store cannot express them.
- No annotations → no dialog (`skeletonEditNeedsConfirmation`). "Do not show again" is `localStorage.skeletonEditWarningOff`: checked before the tally, recorded only when the edit is applied, never in the `.slp`; a storage failure means warn, never skip; `#skeletonWarnOffNote` turns it back on.
- Every edit calls `markDirty()`. Keep the dialog to title + one sentence + counts.
Tests: `tests/test-skeleton-edit-impact.mjs`, `tests/test-pose-data.js`, `tests/e2e/skeleton-edit-warning.mjs`.

## UI conventions

- **One scroller per panel/modal.** No inner `max-height` + `overflow-y: auto`; make a section collapsible (`<details>`) instead.
- **Modals close on `Esc`** (remove the listener on close); mid-operation, `Esc` cancels the operation. Example: `showExport3DVideoModal` in `ui/export-modals.js`.
- **Display taste is browser-local** (`localStorage`), never the `.slp`: section open/closed (`persistSectionState`, `ui/section-state.js`, restored once at setup, not on repaint; best-effort storage; no stored value keeps the markup default, e.g. Danger Zone collapsed), slider sizes, plane visibility toggles, warning opt-outs. `save-golden-digest.mjs` must not move.
- **Plane-mode toolbar lock:** `applyPlaneModeToolbarLock` in `ui/plane-toolbar-lock.js`. Add a pose-annotation button to `PLANE_LOCKED_TOOLBAR_IDS`; a hover-menu wrapper also to `PLANE_LOCKED_DROPDOWN_IDS`. Visibility controls and the Animals field stay live. Keyboard shortcuts and menu items for these actions are still NOT gated.
- **Enter/leave Define Planes only via `togglePlaneMode`** (View menu and `definePlanes`, `Mod+Shift+P`), which does the unwinding.
- **`showHotkeysHelp` stays at module scope** in `ui/ui-wiring.js` (called from both `setupMenus` and `setupUI`).
- **Info tips:** declare with `setInfoTip(el, text)` (`ui/info-tip.js`, delegated, removes `title`); never `setStatus`. One or two sentences. Keep every ⓘ a `<button>`; its capture-phase click `stopPropagation`s so it neither folds a `<summary>` nor clicks its row. Explain a section in its ⓘ (e.g. `PLANE_SECTION_INFO`), not a paragraph. Test: `tests/e2e/info-tip.mjs`.
- **Text is selectable/copyable.** `shouldIgnoreShortcut` (`ui/keyboard-target.js`) yields copy/cut (not paste) while a selection exists. Use `user-select: none` only on drag/click surfaces (toolbars, menu bar, tab bar, modal drag handles). Test: `tests/e2e/copy-panel-text.mjs`.
- **Plane visibility** (`ui/plane-visibility.js`): four toggles, default ON; `planeVisibility(modeActive)` overrides them in Defining Plane Mode. They decide whether a plane is drawn, never how (no fill override). In 3D they hide meshes, never filter `_planes`.
- **Plane Views column** (`annotatedViewStats`, `ui/plane-list-panel.js`) counts views with at least one hand-placed (not reprojected) corner, using the same test as `triangulatePlane`'s `usableViews`.
- **Plane node selection** goes by node ID, never position (`setSelectedPlaneNode`); one capture-phase document listener (`onDocumentClickForNodeSelection`) selects and clears; don't rebuild the Nodes table on select.
- **Define Planes panel** is Nodes then Planes; the roster row is the only plane selector. `tests/e2e/define-plane-mode.mjs` §2 asserts the section's child list.
- **Progress popups** use one card style (`ui/loading-overlay.js`); pinned by `tests/e2e/fixtures/progress-card.js`.
- **Counts and frame numbers** shown to users use `n.toLocaleString('en-US')` or `formatFrameNumber` (`ui/frame-readout.js`). Not in attributes, keys or logs. Join frame ranges with `'; '`. Tests reading counts accept `[\d,]+`.
- **Track vs identity colours:** paint track colours only through `getTrackColor(trackIdx, colorByIdentity)` (`ui/overlays.js`): vivid `TRACK_COLORS` in Track mode, muted `UNIDENTIFIED_TRACK_COLORS` in Identity mode. Every track-colour painter (labels, timeline rows, Visibility swatches) passes the mode; the `onColorByChange` handler in `ui/ui-wiring.js` recolors them, so change `state.colorByIdentity` only via `setColorByIdentity` (`ui/color-by.js`). Don't change `IDENTITY_COLORS` 0-6. After adding any identity or fixed canvas colour, run `tests/test-track-identity-palette.mjs`; if it fails, change the palette, never the thresholds.

## Cloud-synced files: read a user's File through `loading/cold-read-guard.js`

In Google Drive for desktop (macOS File Provider), a Blob read of a not-yet-downloaded range can throw or return runs of zeros with no error. Never call `file.arrayBuffer()` / `slice().arrayBuffer()` on a user's file directly; use `readBlobRange` / `readBlobArrayBuffer` (retries thrown reads, re-reads all-zero 4 KiB blocks).
- The frame-accurate decoder must use `MediaBunnyVideoBackend.fromRangeSource(guardedRangeSource(file))` (`_initMediabunny`, `loading/video.js`), not `fromBlob`.
- `guardedRangeSource` reads whole 1 MiB windows.
- mp4box's index scan reads through it too (`readChunk`).
- Not covered: `<video>` blob-URL playback and small JSON/TOML `.text()` reads. `.slp` reads go through h5wasm's own `cold-read` patch. Known gap: unlike that patch, `zeroRuns` does not re-read the block on each side of a zero run.
- Tests: `tests/test-cold-read-guard.mjs`, `tests/e2e/video-cold-read.mjs`.

## Native resolution (1:1)

View ▸ Native Resolution / `Shift+0` (`setNativeResolution`, `loading/video.js`) is a zoom scale (1 video px per device px). Wheel/`+`/`-` steps snap to it (`snapZoomToNative`). Two rules keep it exact:
- **Per-axis scale** (`zoom.scale` / `zoom.scaleY`, read via `_scaleY`): anything mapping screen ↔ video must use both.
- **Pan on the device-pixel grid** (`_alignNativeOffsets` in `applyZoom`).
Enter 1:1 only via `_enterNative` (incl. the 100% preset). Anything changing the canvas box or devicePixelRatio must end in `reapplyZoom`/`reapplyAllZoom`. `state.nativeResolution` is derived (every shown view at 1:1); while on, a view coming on screen joins at 1:1 (`refreshPaneInteractions`). Exact only at integer devicePixelRatio; don't promise exactness otherwise. Only a view held at 1:1 may read "100%". Tests: `tests/e2e/native-resolution-zoom.mjs` (+`HEADED=1`), `tests/test-video-controller.js`.

## Tests

Three populations, disjoint coverage; run all three:
```bash
node tests/e2e/run-unit-tests.mjs   # tests/*.js classic scripts, headless browser
node tests/run-mjs-tests.mjs        # tests/test-*.mjs, Node (optional substring filter)
node tests/e2e/<name>.mjs           # Playwright, one file per behavior
```
- `tests/*.js` run only if `tests/test-runner.html` has a `<script>` tag for them; `tests/test-classic-tests-registered.mjs` fails on an untagged one. No Node runner for these; don't add one.
- `tests/test-*.mjs` are auto-discovered. Put ESM tests nowhere else.
- `tests/e2e/_diag-*`, `_bench-*`, `_real-*` are investigation tools, not assertions.
- Notable e2e: `sequence-lazy-workflow.mjs` (lazy-project regression harness; catches resident-only bugs, incl. edits: interactive deletes must use `deleteTargetsFromStore`, cycle 5c); `video-encode-streaming.mjs` (only coverage of streaming video export; run it if you touch `ui/video-encode.js`); `overlay-export-modal.mjs` / `export-3d-video.mjs` (the video modals); `_real-roundtrip.mjs` (real-data acceptance, needs a large `.slp`).

**One visible-browser run at a time, machine-wide** (headed = `open -a`, Playwright `headless: false`, `HEADED=1`): parallel sessions steal focus and throttle each other. Wrap any headed run not already taking the lock: `node scripts/browser-lock.mjs --label="what" -- <command>` (lock: `/tmp/luc3d-browser.lock`). Headless runs need no lock. Release re-activates the Claude app; don't add your own `osascript … activate`.

## Python scripts

`scripts/json_to_slp.py`, `scripts/json_to_h5.py` (JSON export → `.slp`/HDF5; need h5py, numpy). `scripts/validate_slp_sleap_compat.py` asserts LUCID `.slp` files load in SLEAP (`--compare`, `--metadata-roundtrip`); run with `uv run --with sleap-io --with numpy --with h5py python …`.

## Maintenance

- **When modifying any module, update its `MODULES.md` entry** (purpose, exports, dependencies).
- **Every keyboard shortcut needs an `ACTION_CATALOG` entry in `ui/settings.js`** (`{ id, label, category, binding, editable, dispatched }`). `dispatched: true` = matched by `dispatchEvent()`, needs `setHandler(id, fn)` (wired in `ui/ui-wiring.js`), rebindable if `editable`. `dispatched: false` = own handler; keep `binding` in sync with it.

