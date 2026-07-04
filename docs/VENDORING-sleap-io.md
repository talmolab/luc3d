# Vendoring `sleap-io.js` into `lib/sleap-io/`

LUCID ships a **prebuilt browser bundle** of [`talmolab/sleap-io.js`](https://github.com/talmolab/sleap-io.js)
under `lib/sleap-io/`. There is no build step in LUCID itself — the bundle is
committed as static ES modules and loaded directly by the browser.

This doc records the **exact pin**, how the bundle is **used**, and a **reproducible
recipe** for rebuilding it when bumping the version.

## What is pinned

The committed bundle is **not a published npm release.** It is a custom build off
the PR #81 (“3d standardization”) feature branch:

| | |
|---|---|
| Source repo | `talmolab/sleap-io.js` |
| Source commit | **`bdd1897`** (`package.json` says `0.2.3`; ≈ v0.2.3 + PR #78/#79 + the first 11 PR-#81 commits) |
| Build toolchain | `tsup` (esbuild) — `npm run build` |
| Why not a tag | The 3D data model (`Instance3D`, `InstanceGroup`, `FrameGroup`, `RecordingSession`, `Identity`, `Camera.size`) shipped on the PR #81 branch **before** it was squash-merged for v0.3.0. The vendored build predates the v0.3.0 annotation-architecture overhaul. |

### SHA-256 manifest (current bundle, built from `bdd1897`)

```
605827528d4acedc17ab47444789b33c33edc1344674e460b8d905e5d09423d2  index.browser.js
4676003618ed18c888fd2f4f3d5a4382063d298cebeab8711d1bdec7ffa720b4  chunk-KE5NBER6.js
16bd70c24a61dc1e70f8c2a74248fe94abcada3899a6f10a8beb22eccdedc597  chunk-NWJVKWIL.js
```

`mediabunny-stub.js` is **hand-written** (not emitted by the build) — see below.
A fresh `npm install && npm run build` at `bdd1897` reproduces the three files above
**byte-identical** (same esbuild content-hash chunk names).

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

### Importmap deltas expected when bumping to ≥ v0.3.0 / main

The bundle grows and adds **static** bare imports (tsup externalizes all
`dependencies`). Expect at least **`pako`** (label-image zlib) and likely
**`jsfive`** in addition to `yaml`/`mediabunny`. LUCID keeps runtime deps local
(offline/CSP), so vendor local copies (e.g. `lib/pako/…`, `lib/jsfive/…`) and alias
them in the importmap rather than pointing at a CDN. `main` also bumps sleap-io's
internal `h5wasm` to `0.10.2` and adds `--external tiff`, but those only affect
sleap-io's own reader (dynamic imports LUCID doesn't reach) — **always re-derive the
static-import list with step 4; do not assume.**

Chunk hash filenames are cosmetic (referenced only through `index.browser.js`, which
is copied alongside), so a differing local esbuild is functionally fine even if the
hashes don't match upstream's published tarball.
