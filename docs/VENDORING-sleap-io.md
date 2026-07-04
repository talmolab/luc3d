# Vendoring `sleap-io.js` into `lib/sleap-io/`

LUCID ships a **prebuilt browser bundle** of [`talmolab/sleap-io.js`](https://github.com/talmolab/sleap-io.js)
under `lib/sleap-io/`. There is no build step in LUCID itself — the bundle is
committed as static ES modules and loaded directly by the browser.

This doc records the **exact pin**, how the bundle is **used**, and a **reproducible
recipe** for rebuilding it when bumping the version.

## What is pinned

Currently pinned to the released tag **`v0.4.1`** (`talmolab/sleap-io.js`, 2026-06-18).

| | |
|---|---|
| Source repo | `talmolab/sleap-io.js` |
| Source ref | **`v0.4.1`** (commit `8427072`) |
| Build toolchain | `tsup` (esbuild) — `npm run build` |
| Runtime deps aliased | `h5wasm` → local, `yaml` → CDN, `mediabunny` → local stub, **`pako` → local** |

### SHA-256 manifest (current bundle, built from `v0.4.1`)

```
e5bc304d97e43da2ee8f020689aa64063c0354643735efe8dd9e5ee3a9bb6eb7  index.browser.js
69b11e7e19670394961334c0e1049fa7369d2ce3cc314c7e3ef1f2b1d919c072  chunk-KIMQQ2HE.js
4c1015f305209bdb90e5f91f8f8fceeccf1c18d4594e4fd614552be570bfd922  chunk-VJKU6LLW.js
```

`mediabunny-stub.js` is **hand-written** (not emitted by the build). `lib/pako/` is a
locally-vendored copy of `pako` (see below). A fresh `npm install && npm run build` at
`v0.4.1` reproduces the bundle (chunk hash names are esbuild-content-derived).

### History

- **`bdd1897`** (≈ v0.2.3 + the PR #81 3D-standardization branch, before v0.3.0) was the
  original pin — a custom pre-release build carrying the 3D data model
  (`Instance3D`/`InstanceGroup`/`FrameGroup`/`RecordingSession`/`Identity`/`Camera.size`)
  ahead of its v0.3.0 squash-merge. SHA-256 of that bundle:
  `6058275…` index.browser.js / `4676003…` chunk-KE5NBER6.js / `16bd70c…` chunk-NWJVKWIL.js.
  A fresh build at `bdd1897` reproduced it byte-identical.

## How LUCID loads it

Three coordinated pieces:

1. **Importmap** (`index.html`) — aliases the bundle's *static* bare imports:
   ```html
   <script type="importmap">{ "imports": {
     "h5wasm":     "./lib/h5wasm/hdf5_hl.js",              // LUCID's local h5wasm 0.8.8
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

**Usage is write-only.** LUCID builds model objects (`Labels`, `LabeledFrame`,
`Instance`/`PredictedInstance`, `Skeleton`/`Node`/`Edge`, `Video`, `Track`, and the
3D/multi-view classes) and calls `saveSlpToBytes`, then rewrites the bytes in
`import-export/file-io.js:convertSlpToV06Compatible` (a Python-`sleap_io`-v0.6.5
compatible downgrade + `sessions_json` in `make_session` shape). SLP **import** is
hand-rolled on raw h5wasm (`loading/slp-import-worker.js`) and does **not** use
sleap-io.js.

### The `mediabunny` stub

sleap-io.js imports 6 symbols from `mediabunny` (`Input, UrlSource, BlobSource,
VideoSampleSink, EncodedPacketSink, ALL_FORMATS`) for browser video decoding, which
LUCID doesn't use. `lib/sleap-io/mediabunny-stub.js` is a hand-written no-op that
exports those 6 symbols; the importmap aliases `mediabunny` → the stub. Only
regenerate the stub if the bundle's `mediabunny` import list changes.

## Reproducible re-vendor recipe

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
