#!/usr/bin/env bash
# TEMPORARY cold-start experiment (to be removed before merge): publish two extra
# variants of this PR's tree beside the preview, so all three load through the
# same Cloudflare path at the same time:
#   _exp/base/    the base branch's index.html, stamped only (= /dev/ today)
#   _exp/bundle/  this tree bundled with esbuild (code splitting), stamped + preloaded
set -euo pipefail
V="$1"
git fetch -q --depth 1 origin "$BASE_SHA"
rm -rf _exp && mkdir -p _exp
rsync -a --exclude .git --exclude _exp --exclude tests --exclude scripts --exclude sample_session --exclude docs ./ _exp/base/
git show "$BASE_SHA:index.html" > _exp/base/index.html
node --input-type=module -e "
  const m = await import('./scripts/stamp-version.mjs');
  const r = m.stampSite('_exp/base', '$V');
  console.log('base stamped', r.refs, 'problems', r.problems.length);
  if (r.problems.length) process.exit(1);"

rsync -a --exclude .git --exclude _exp --exclude tests --exclude scripts --exclude sample_session --exclude docs ./ _exp/bundle/
cd _exp/bundle
python3 - <<'PY'
import re
s = open('index.html').read()
m = re.search(r'<script type="module">\n(.*?)</script>', s, re.S)
open('bridge.js', 'w').write(m.group(1))
s = s.replace(m.group(0), '<script type="module" src="_b/bridge.js"></script>')
s = s.replace('<script type="module" src="app.js"></script>', '<script type="module" src="_b/app.js"></script>')
open('index.html', 'w').write(s)
for f, a, b in [('ui/image-embedder.js', "new URL('./image-model-worker.js', import.meta.url)", "new URL('ui/image-model-worker.js', document.baseURI)"),
                ('ui/image-embedder.js', "new URL('./image-crop-worker.js', import.meta.url)", "new URL('ui/image-crop-worker.js', document.baseURI)"),
                ('import-export/slp-import.js', "new URL('../loading/frame-worker.js', import.meta.url)", "new URL('loading/frame-worker.js', document.baseURI)"),
                ('import-export/save-load.js', "import('./lib/sleap-io/index.browser.js')", "import('../lib/sleap-io/index.browser.js')")]:
    t = open(f).read(); assert a in t, (f, a); open(f, 'w').write(t.replace(a, b))
PY
npx --yes esbuild@0.25.10 app.js bridge.js --bundle --splitting --format=esm --outdir=_b \
  --external:'https://*' --external:yaml \
  --alias:mediabunny=./lib/mediabunny/mediabunny.min.mjs --alias:pako=./lib/pako/pako.esm.mjs --alias:h5wasm=./lib/h5wasm/hdf5_hl.js \
  --chunk-names='chunk-[hash]' --log-level=warning
cd ../..
node scripts/stamp-version.mjs _exp/bundle "$V"
