# Vendoring `sleap-io.js` into `lib/sleap-io/`

LUCID ships a **prebuilt browser bundle** of [`talmolab/sleap-io.js`](https://github.com/talmolab/sleap-io.js)
under `lib/sleap-io/`. There is no build step in LUCID itself — the bundle is
committed as static ES modules and loaded directly by the browser.

This doc records the **exact pin**, how the bundle is **used**, and a **reproducible
recipe** for rebuilding it when bumping the version.

## What is pinned

Pinned to the **released npm package [`@talmolab/sleap-io.js@0.5.0`](https://www.npmjs.com/package/@talmolab/sleap-io.js)**
(gitHead `1918f9e`), which contains **PR #196** ("perf: SLP read path") **and PR #198**
("faithful lazy-native recording-session model"). This is a **tagged release** — it
retires the earlier experimental moving-`main` pin (`07b0830`). Revert to a prior version
with `npm pack @talmolab/sleap-io.js@<version>` (see recipe below).

| | |
|---|---|
| Source package | `@talmolab/sleap-io.js` (npm) |
| Version | **`0.5.0`** (gitHead `1918f9e`) — released, from npm |
| Build toolchain | `tsup` (esbuild) — prebuilt in the npm tarball's `dist/` |
| Runtime deps aliased | `h5wasm` → local, `yaml` → CDN, `mediabunny` → local stub, **`pako` → local** |

### Vendored browser closure (5 files)

The npm `dist/` ships node + browser + lite builds; LUCID vendors only the **browser
entry and its transitive closure**: `index.browser.js` imports `chunk-NIFGJKOL.js`,
`chunk-PPF2ABAO.js`, `chunk-YS7Q6CO6.js`; two of those reference `gdrive-6DDSPUUK.js`
(a dynamic Google-Drive chunk LUCID never triggers, kept so the dynamic import resolves).
The node-only chunks (`index.js`, `lite.js`, and 0.4.x's `chunk-KIMQQ2HE/VJKU6LLW/XMK3JNEP`)
are **not** vendored.

### SHA-256 manifest (0.5.0, from the npm tarball)

```
09dba915b34880fbe17309e9034692f3db8f5483d96ee96043a34167b2c0bc64  index.browser.js
9461cf151dd672cf2020f092c934800b0a0d801cb51732775562896bba930368  chunk-NIFGJKOL.js
bcd2b4b951004579d88f6486041d8413fc58be2adfa4bf14e77a4a0945045e05  chunk-PPF2ABAO.js
e3b10f994ee279f993a043b3a57f9fa7596f6f472eec2a33b6f642aad0dbd65b  chunk-YS7Q6CO6.js
d2525cde72767bc6f4d55435d88efde54c93fe73be3e3ffd669f5c9d2fe48d46  gdrive-6DDSPUUK.js
```

`mediabunny-stub.js` is **hand-written** (not emitted by the build). `lib/pako/` is a
locally-vendored copy of `pako` (see below). The static bare-import set is unchanged
(`mediabunny`, `pako`, `yaml`), so the importmap needs no new entries. (`chunk-NIFGJKOL.js`
and `chunk-YS7Q6CO6.js` keep the same hash-names — and the same bytes — as the 0.4.x/`main`
builds; only the big container chunk changed, `P3K3Y4YO` → `PPF2ABAO`.) sleap-io's
*internal* reader h5wasm (`0.10.2`) is a dynamic import inside its own worker; LUCID keeps
its own h5wasm 0.8.8/local ESM.

### History

- **`07b0830`** (unreleased `main`, PR #196 + #198) — the experimental pin superseded by
  0.5.0. SHA-256: `79b40e1…` index.browser.js / `895cf7d…` chunk-P3K3Y4YO.js.
- **`v0.4.1`** (tag `8427072`) — the last *released* pin before 0.5.0.
  SHA-256: `e5bc304…` index.browser.js / `69b11e7…` chunk-KIMQQ2HE.js.
- **`bdd1897`** (≈ v0.2.3 + the PR #81 3D-standardization branch, before v0.3.0) — the
  original pin, a custom pre-release build carrying the 3D data model
  (`Instance3D`/`InstanceGroup`/`FrameGroup`/`RecordingSession`/`Identity`/`Camera.size`)
  ahead of its v0.3.0 squash-merge. SHA-256: `6058275…` index.browser.js /
  `4676003…` chunk-KE5NBER6.js / `16bd70c…` chunk-NWJVKWIL.js. Reproduced byte-identical.

## How LUCID loads it

Three coordinated pieces:

1. **Importmap** (`index.html`) — aliases the bundle's *static* bare imports:
   ```html
   <script type="importmap">{ "imports": {
     "h5wasm":     "./lib/h5wasm/hdf5_hl.js",              // LUCID's local h5wasm (unlabeled; newer than the 0.8.8 CDN copy — exposes create_compound_dataset + get_dataset_data)
     "yaml":       "https://cdn.jsdelivr.net/npm/yaml@2.8.0/browser/index.js",
     "mediabunny": "./lib/sleap-io/mediabunny-stub.js"      // no-op stub (see below)
   }}</script>
   ```
   At `bdd1897` the only static bare imports are `yaml` and `mediabunny`; `h5wasm`
   and `mp4box` are imported *dynamically* inside sleap-io's own reader/video
   backends — code paths LUCID never triggers — so they need no alias.
2. **Bridge** (`index.html`) — imports 18 names from `./lib/sleap-io/index.browser.js`
   onto `window.SleapIO` and dispatches `sleapio-ready`.
3. **Lazy fallback** — `import-export/save-load.js` `ensureSleapIO()` dynamic-imports
   the same module.

**Write path (PR 5.2).** LUCID builds model objects (`Labels`, `LabeledFrame`,
`Instance`/`PredictedInstance`, `Skeleton`/`Node`/`Edge`, `Video`, `Track`, and the
3D/multi-view classes — `buildSlpLabelsAllViews` assembles the full typed
RecordingSession graph with `metadata.lucid`) and calls **`saveSlpToBytes`
directly**. The old `convertSlpToV06Compatible` v0.6-compat post-pass is **deleted**:
SLEAP >= 1.6 (sleap-io >= 0.7) reads sleap-io.js's raw flat-matrix `field_names`
output natively (#378), and #198 serializes a canonical `sessions_json` from the typed
graph. (Interop gate: `scripts/validate_slp_sleap_compat.py`, needs a SLEAP Python env.)

**Read path (PR 5.1/5.2).** `.slp` **import** goes through sleap-io.js:
`parseSlpViaSleapIO` (`import-export/file-io.js`) drives `readSlpStreaming(file,
{rawSessions:true})` (PR #196) and adapts the typed `Labels` into LUCID's `slpData`
shape — pose via a columnar `_xy`/`_visible` transform, grouping rebuilt from the typed
`RecordingSession` by `reconstructInstanceGroupsFromSession` (reads both LUCID's legacy
and the new canonical `sessions_json`). The raw-h5wasm worker
(`loading/slp-import-worker.js`, via `parseSlpH5`) is kept for SLEAP analysis `.h5` and
as a fallback (`parseSlpForImport` dispatches). Verified in-browser: pose parity vs the
raw worker + full canonical export→import round-trip.

### The `mediabunny` stub

sleap-io.js imports 6 symbols from `mediabunny` (`Input, UrlSource, BlobSource,
VideoSampleSink, EncodedPacketSink, ALL_FORMATS`) for browser video decoding, which
LUCID doesn't use. `lib/sleap-io/mediabunny-stub.js` is a hand-written no-op that
exports those 6 symbols; the importmap aliases `mediabunny` → the stub. Only
regenerate the stub if the bundle's `mediabunny` import list changes.

## Re-vendor from a released npm version (preferred)

For a tagged release, pull the prebuilt bundle straight from npm — no clone/build:

```bash
# 1) Download + extract the published tarball (no install)
npm pack @talmolab/sleap-io.js@0.5.0
tar -xzf talmolab-sleap-io.js-0.5.0.tgz          # -> package/dist/

# 2) Identify the browser closure: index.browser.js + the chunks it (transitively)
#    references. List them:
grep -rhoE '"\./[A-Za-z0-9_-]+\.js"' package/dist/index.browser.js \
     package/dist/chunk-*.js | sort -u
#    -> index.browser.js imports 3 chunks; 2 of those reference gdrive-*.js.

# 3) Replace the vendored bundle with exactly that closure (NOT the node chunks)
rm -f <luc3d>/lib/sleap-io/chunk-*.js <luc3d>/lib/sleap-io/gdrive-*.js
cp package/dist/index.browser.js \
   package/dist/chunk-NIFGJKOL.js package/dist/chunk-PPF2ABAO.js \
   package/dist/chunk-YS7Q6CO6.js package/dist/gdrive-6DDSPUUK.js \
   <luc3d>/lib/sleap-io/

# 4) Re-derive the importmap (static bare imports) + verify the mediabunny stub:
grep -hoE 'from "[^./][^"]*"' package/dist/index.browser.js package/dist/chunk-*.js | sort -u
#    (0.5.0: mediabunny, pako, yaml — unchanged, no importmap edits needed)

# 5) Refresh the SHA-256 manifest in this doc + the CLAUDE.md version pin, then
#    re-run tests/test-runner.html (esp. the SLP export post-pass guard) and an
#    import parity check.
```

`npm view @talmolab/sleap-io.js@<version> version gitHead` records the provenance.

## Reproducible re-vendor recipe (build from source — for unreleased refs)

```bash
# 0) Clone (once)
git clone https://github.com/talmolab/sleap-io.js.git && cd sleap-io.js

# 1) Check out the target ref
git checkout v0.4.1                      # a released tag
#   or the current pin:  git checkout bdd1897
#   or unreleased main:  git fetch origin && git checkout origin/main

# 2) Install + build (npm works for every ref, incl. main; main also builds under bun 1.3.14)
npm install --no-audit --no-fund
npm run build                            # emits dist/index.browser.js + dist/chunk-*.js

# 3) Copy the browser bundle into LUCID (index.browser.js + ALL chunk-*.js it references)
rm -f  <luc3d>/lib/sleap-io/chunk-*.js
cp dist/index.browser.js dist/chunk-*.js  <luc3d>/lib/sleap-io/

# 4) Re-derive the importmap: list every STATIC bare import in the fresh bundle
grep -hoE 'from "[^./][^"]*"' dist/index.browser.js dist/chunk-*.js | sort -u
#   Add an <luc3d>/index.html importmap alias for EVERY entry, or the module fails
#   to load at startup. (h5wasm stays -> ./lib/h5wasm/hdf5_hl.js.)

# 5) Verify the mediabunny stub still covers the imported symbol set
grep -A8 'from "mediabunny"' dist/chunk-*.js
#   Regenerate lib/sleap-io/mediabunny-stub.js only if the symbol list changed.

# 6) Refresh the SHA-256 manifest in this doc
sha256sum <luc3d>/lib/sleap-io/index.browser.js <luc3d>/lib/sleap-io/chunk-*.js
```

`scripts/revendor-sleap-io.sh <ref>` wraps steps 0–6.

### Importmap deltas (observed at v0.4.1)

The bundle's **static** bare imports at `v0.4.1` are `mediabunny`, `pako`, `yaml`
(tsup externalizes all `dependencies`; `h5wasm`, `mp4box`, `jsfive`, `tiff` are
imported *dynamically* inside sleap-io's own reader/video backends, which LUCID never
triggers, so they need no importmap entry). The delta from the old `bdd1897` pin is
**`pako`** — imported as `{ deflate }` / `{ inflate }` for label-image/mask zlib in the
SLP writer. LUCID writes no masks/label-images, so pako is never *executed*, but the
static import must still *resolve* at load. It is vendored locally at
`lib/pako/pako.esm.mjs` (see `lib/pako/PROVENANCE.txt`) and aliased
`"pako" → ./lib/pako/pako.esm.mjs`, matching how `h5wasm` is kept local for offline/CSP.

When bumping to **`main`** (or a future release), re-run step 4: `main` bumps sleap-io's
internal `h5wasm` to `0.10.2` and adds `--external tiff`, and may surface additional
static imports — **always re-derive the list from the freshly-built bundle; do not
assume.** The same importmap must be mirrored in `tests/test-runner.html` (paths
relative to `tests/`) so the SLP export post-pass test can load `window.SleapIO`.

Chunk hash filenames are cosmetic (referenced only through `index.browser.js`, which
is copied alongside), so a differing local esbuild is functionally fine even if the
hashes don't match upstream's published tarball.
