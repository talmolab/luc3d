#!/usr/bin/env bash
# Re-vendor the sleap-io.js browser bundle into lib/sleap-io/.
#
# Usage:  scripts/revendor-sleap-io.sh <git-ref> [work-dir]
#   <git-ref>   tag / branch / commit of talmolab/sleap-io.js (e.g. v0.4.1, origin/main, bdd1897)
#   [work-dir]  where to clone/build (default: ./.sleap-io-build, gitignored)
#
# Rebuilds the bundle at <git-ref>, copies index.browser.js + chunk-*.js into
# lib/sleap-io/, then prints (a) the static bare-import list you must alias in
# index.html's importmap and (b) the SHA-256 manifest for the vendoring notes
# (archived untracked at scratch/VENDORING-sleap-io.md). It does NOT edit
# index.html or the mediabunny stub — those are reviewed/applied by hand.
set -euo pipefail

REF="${1:?usage: revendor-sleap-io.sh <git-ref> [work-dir]}"
WORK="${2:-.sleap-io-build}"
REPO="https://github.com/talmolab/sleap-io.js.git"
HERE="$(cd "$(dirname "$0")/.." && pwd)"        # luc3d repo root
DEST="$HERE/lib/sleap-io"

echo ">> re-vendoring sleap-io.js @ $REF into $DEST"

if [ ! -d "$WORK/.git" ]; then
  echo ">> cloning $REPO -> $WORK"
  git clone "$REPO" "$WORK"
fi
cd "$WORK"
git fetch --all --tags --quiet
git checkout --quiet "$REF"
git --no-pager log -1 --format='>> checked out %h %s (%ci)'

echo ">> npm install"
npm install --no-audit --no-fund
echo ">> npm run build"
npm run build

test -f dist/index.browser.js || { echo "!! dist/index.browser.js missing after build"; exit 1; }

echo ">> copying bundle into $DEST"
rm -f "$DEST"/chunk-*.js
cp dist/index.browser.js dist/chunk-*.js "$DEST"/

echo ""
echo "================ ACTION REQUIRED ================"
echo "1) Static bare imports in the fresh bundle — every one needs an index.html importmap alias:"
grep -hoE 'from "[^./][^"]*"' dist/index.browser.js dist/chunk-*.js | sort -u | sed 's/^/     /'
echo ""
echo "2) mediabunny import surface (regenerate lib/sleap-io/mediabunny-stub.js only if this changed):"
grep -hA8 'from "mediabunny"' dist/chunk-*.js | sed 's/^/     /' || echo "     (no mediabunny import found)"
echo ""
echo "3) SHA-256 manifest (for the vendoring notes, scratch/VENDORING-sleap-io.md):"
( cd "$DEST" && sha256sum index.browser.js chunk-*.js | sed 's/^/     /' )
echo "================================================="
echo ">> done. Review importmap + stub, run tests/test-runner.html, then commit."
