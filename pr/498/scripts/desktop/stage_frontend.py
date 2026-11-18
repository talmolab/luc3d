#!/usr/bin/env python3
"""
Stage the frontend the LUCID desktop app (src-tauri/) embeds.

    python3 scripts/desktop/stage_frontend.py --out dist-desktop [--label TEXT] [--commit SHA]
    python3 scripts/desktop/stage_frontend.py --verify-only <dir>

tauri.conf.json runs the first form as its beforeBuildCommand and embeds
`frontendDist: "../dist-desktop"`. Works from any cwd: the repo root comes from
this file's path, and a relative --out is taken relative to the REPO ROOT.

LUCID has no build step, so the desktop frontend is a copy of the app -- the same
copy `scripts/offline_deps.py bundle` zips, through the same code
(offline_deps.app_file_list + stage_files), with two differences:

  * Only what the app loads at runtime is staged (STAGE_FILES / STAGE_DIRS):
    no tests/, scripts/, docs/, sample_session/ (only e2e tests read it --
    pose/initialization.js's loadDemoSession is not wired to any menu),
    src-tauri/, .github/, *.md, launchers, server.py, test-worker.html (a
    debug page whose own script tags 404), lucid.jpg (nothing references it).
  * Files git does not ignore but has not tracked yet are staged too
    (`git ls-files --others --exclude-standard`): a local `tauri build` should
    ship the working tree the developer is running, like deploy.yml's rsync.

Steps:
  1. offline_deps install (fetch three, mp4box, dockview-core, yaml into lib/;
     a no-op once installed). Exit 3 if they cannot be fetched.
  2. Wipe --out (see check_out_dir for what it refuses) and copy the app into
     it with every mapped CDN URL rewritten to a depth-relative ./lib/ path.
  3. scripts/stamp-version.mjs <out> <commit> <label> (if `node` is on PATH):
     `?v=<commit>` on every same-site code URL -- the webview's HTTP cache is
     keyed by the stable http://localhost:<port> origin, so it would otherwise
     mix modules across app updates exactly like Cloudflare does on the web --
     plus the modulepreload block (its CLI runs scripts/preload-modules.mjs,
     the same single command deploy.yml runs) and the lucid-release /
     lucid-commit <meta> tags ui/version-label.js shows.
  4. verify_tree: every relative module / worker / script / stylesheet / CSS
     url() reference in the staged tree names a staged file; no bare import
     specifier is missing from the importmap; no CDN URL survives except the
     manifest's documented `unmapped` ones (and two unreachable defaults inside
     vendored lib/ code, LIB_UNREACHABLE_CDN). Any problem fails the stage.

Label: --label, else $LUCID_DESKTOP_LABEL, else "desktop <tauri.conf.json
version>", else "desktop dev". Commit: --commit, else $LUCID_DESKTOP_COMMIT, else
`git rev-parse --short=12 HEAD` (deploy.yml stamps 12 characters too).
"""

import argparse
import json
import os
import re
import shutil
import subprocess
import sys
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent.parent
sys.path.insert(0, str(REPO_ROOT / "scripts"))

import offline_deps  # noqa: E402  (needs the sys.path entry above)

TAURI_CONF = REPO_ROOT / "src-tauri" / "tauri.conf.json"

# What the app needs at runtime. Everything else in the repo stays out.
STAGE_FILES = ("index.html", "app.js", "styles.css", "demo-data.js")
STAGE_DIRS = ("icons", "pose", "ui", "loading", "import-export", "lib")

# Never shipped even inside a STAGE_DIR.
SKIP_SUFFIXES = (".md", ".swp", ".swo", ".pyc")
SKIP_NAMES = (".gitignore", ".DS_Store", "Thumbs.db")

# Directories --out may never be (or be inside of, for the source ones): wiping
# them would destroy the checkout.
PROTECTED_TOP = {
    ".git", ".github", ".claude", "docs", "scripts", "tests", "sample_session",
    "src-tauri",
} | set(STAGE_DIRS)

# CDN URLs inside vendored lib/ code that the app never reaches. `check --strict`
# does not scan lib/ at all; the desktop app must work offline, so here a NEW
# CDN URL in a re-vendored file fails the stage until someone decides about it.
LIB_UNREACHABLE_CDN = {
    "https://unpkg.com/mp4box@0.5.4/dist/mp4box.all.min.js":
        "sleap-io.js MP4BOX_CDN fallback: index.html's mp4box <script> always sets "
        "globalThis.MP4Box first (CLAUDE.md, Offline mode).",
    "https://cdn.jsdelivr.net/npm/h5wasm@0.10.2/dist/iife/h5wasm.js":
        "sleap-io.js default h5wasm IIFE URL for its streaming worker: LUCID always "
        "passes h5wasmUrl = lib/h5wasm/h5wasm.iife.js (import-export/file-io.js, "
        "loading/sio-lazy-loader.js).",
}

EXIT_FETCH = 3  # the offline packages could not be installed (no network?)


def log(msg):
    print(">> " + msg, flush=True)


class StageError(RuntimeError):
    pass


# --------------------------------------------------------------------------- #
# selection
# --------------------------------------------------------------------------- #

def is_staged(rel):
    """Should repo-relative Path `rel` ship in the desktop frontend?"""
    if rel.name in SKIP_NAMES or rel.name.endswith(SKIP_SUFFIXES):
        return False
    if "__pycache__" in rel.parts:
        return False
    if len(rel.parts) == 1:
        return rel.name in STAGE_FILES
    return rel.parts[0] in STAGE_DIRS


def select_files(manifest):
    files = [r for r in offline_deps.app_file_list(manifest, include_untracked=True)
             if is_staged(r)]
    files += offline_deps.license_files()
    return sorted(set(files))


# --------------------------------------------------------------------------- #
# output directory
# --------------------------------------------------------------------------- #

def resolve_out(out):
    if not out or not str(out).strip():
        raise StageError("--out is empty")
    p = Path(out).expanduser()
    if not p.is_absolute():
        p = REPO_ROOT / p
    return Path(os.path.abspath(p))


def _git_tracks_anything_under(path):
    try:
        res = subprocess.run(["git", "-C", str(REPO_ROOT), "ls-files", "-z", "--", str(path)],
                             capture_output=True, check=True)
        return bool(res.stdout.strip(b"\0"))
    except (OSError, subprocess.CalledProcessError):
        return False


def check_out_dir(out):
    """Refuse an --out whose wipe could destroy anything but a previous stage."""
    real = Path(os.path.realpath(out))
    repo = Path(os.path.realpath(REPO_ROOT))
    home = Path(os.path.realpath(Path.home()))
    if real == Path(real.anchor) or real == home or real == repo or real in repo.parents:
        raise StageError("refusing to use %s as --out: it is the repo root, an ancestor "
                         "of it, the home directory or a filesystem root" % out)
    if real.exists() and not real.is_dir():
        raise StageError("--out %s exists and is not a directory" % out)
    if repo in real.parents:
        top = real.relative_to(repo).parts[0]
        if top in PROTECTED_TOP or _git_tracks_anything_under(real):
            raise StageError("refusing to use %s as --out: it holds repo source" % out)
        return  # a scratch directory inside the checkout (normally dist-desktop/)
    # Outside the repo, wipe only an empty directory or what looks like a previous
    # stage: nothing at top level but what this script writes.
    if real.is_dir():
        entries = {e.name for e in real.iterdir()}
        allowed = set(STAGE_FILES) | set(STAGE_DIRS)
        if entries and not (entries <= allowed and "index.html" in entries):
            raise StageError("refusing to wipe %s: it is outside the repo and does not look "
                             "like a previous stage (has %s)"
                             % (out, ", ".join(sorted(entries - allowed)[:5]) or "no index.html"))


def wipe(out):
    check_out_dir(out)
    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)


# --------------------------------------------------------------------------- #
# version label
# --------------------------------------------------------------------------- #

def tauri_version():
    try:
        return json.loads(TAURI_CONF.read_text(encoding="utf-8")).get("version") or None
    except (OSError, ValueError):
        return None


def default_label():
    env = os.environ.get("LUCID_DESKTOP_LABEL")
    if env:
        return env
    v = tauri_version()
    return "desktop %s" % v if v else "desktop dev"


def default_commit():
    env = os.environ.get("LUCID_DESKTOP_COMMIT")
    if env:
        return env
    try:
        return subprocess.run(["git", "-C", str(REPO_ROOT), "rev-parse", "--short=12", "HEAD"],
                              capture_output=True, check=True, text=True).stdout.strip()
    except (OSError, subprocess.CalledProcessError):
        return "unknown"


# Same rules scripts/stamp-version.mjs enforces; checked here for a clear error.
COMMIT_RE = re.compile(r"^[A-Za-z0-9._-]{4,64}$")
LABEL_RE = re.compile(r"^[A-Za-z0-9 #._+-]{0,40}$")


def stamp(out, commit, label):
    node = shutil.which("node")
    if not node:
        log("WARNING: node is not on PATH -- not stamping ?v=%s or the version label "
            "(the app still runs; the menu bar shows no version)" % commit)
        return False
    if not COMMIT_RE.match(commit):
        raise StageError("commit must be 4-64 chars of [A-Za-z0-9._-], got %r" % commit)
    if not LABEL_RE.match(label):
        raise StageError("label must be at most 40 chars of [A-Za-z0-9 #._+-], got %r" % label)
    res = subprocess.run([node, str(REPO_ROOT / "scripts" / "stamp-version.mjs"),
                          str(out), commit, label], cwd=str(REPO_ROOT))
    if res.returncode:
        raise StageError("scripts/stamp-version.mjs failed (exit %d)" % res.returncode)
    return True


# --------------------------------------------------------------------------- #
# verification
# --------------------------------------------------------------------------- #

IMPORT_RE = re.compile(r"""\b(?:from|import)\s*\(?\s*(['"])([^'"`\s]+)\1""")
# Static import/export statements with a BARE specifier (what the importmap must
# resolve). Anchored at a statement start so prose like 'nothing to export', '…'
# cannot match; `import(` cannot match either (dynamic imports may be guarded).
STATIC_BARE_IMPORT_RE = re.compile(
    r"""(?:^|[;}])[ \t]*(?:import|export)\s*(?:[\w$*{}\s,]*?\bfrom\s*)?(['"])"""
    r"""([@A-Za-z_][\w@./+-]*)\1""", re.M)
NEW_URL_RE = re.compile(
    r"""\bnew\s+URL\(\s*(['"])([^'"`\s]+)\1\s*(?:\+[^,]*)?,\s*"""
    r"""(import\.meta\.url|document\.baseURI|self\.location(?:\.href)?|location\.href)\b""")
IMPORT_SCRIPTS_RE = re.compile(r"""\bimportScripts\(\s*(['"])([^'"`\s]+)\1""")
CSS_URL_RE = re.compile(r"""url\(\s*(['"]?)([^'")\s]+)\1\s*\)""")
HTML_REF_RE = re.compile(r"""<(?:script|link|img|source)\b[^>]*?\b(?:src|href)\s*=\s*(["'])([^"']+)\1""",
                         re.I)
MODULE_SCRIPT_RE = re.compile(
    r"""<script\b[^>]*\btype\s*=\s*["']module["'][^>]*>([\s\S]*?)</script>""", re.I)
IMPORTMAP_RE = re.compile(
    r"""<script\b[^>]*\btype\s*=\s*["']importmap["'][^>]*>([\s\S]*?)</script>""", re.I)
ABSOLUTE_RE = re.compile(r"^(?:[a-z][\w+.-]*:|//|#)", re.I)


def _strip_comments(src):
    return re.sub(r"(^|[^:'\"`\\])//[^\n]*", r"\1", re.sub(r"/\*[\s\S]*?\*/", " ", src))


def _strip_query(spec):
    return re.sub(r"[?#].*$", "", spec)


def verify_tree(out, manifest):
    """Problems with a staged tree (empty list = good). See the module docstring."""
    out = Path(out)
    problems = []
    stats = {"refs": 0, "workers": 0, "files": 0}

    def check_ref(origin, spec, base_dir, kind):
        if ABSOLUTE_RE.match(spec) or spec.startswith("data:") or spec.startswith("blob:"):
            return
        if spec.startswith("/"):
            problems.append("%s: root-absolute %s %r (not sub-path safe)" % (origin, kind, spec))
            return
        target = (base_dir / _strip_query(spec)).resolve()
        stats["refs"] += 1
        if out.resolve() not in target.parents:
            problems.append("%s: %s %r points outside the staged tree" % (origin, kind, spec))
        elif not target.is_file():
            problems.append("%s: %s %r -> %s, which is not staged"
                            % (origin, kind, spec, target.relative_to(out.resolve()).as_posix()))

    index = out / "index.html"
    importmap = {}
    if not index.is_file():
        problems.append("index.html is missing")
    else:
        html = index.read_text(encoding="utf-8", errors="replace")
        html_nc = re.sub(r"<!--[\s\S]*?-->", "", html)
        m = IMPORTMAP_RE.search(html_nc)
        if m:
            try:
                importmap = json.loads(m.group(1)).get("imports", {})
            except ValueError as exc:
                problems.append("index.html: importmap is not JSON (%s)" % exc)
        for key, spec in importmap.items():
            check_ref("index.html importmap[%s]" % key, spec, out, "importmap entry")
        for m in HTML_REF_RE.finditer(html_nc):
            check_ref("index.html", m.group(2), out, "tag reference")
        for body in MODULE_SCRIPT_RE.findall(html_nc):
            for m in IMPORT_RE.finditer(body):
                if m.group(2).startswith((".", "/")):
                    check_ref("index.html <script type=module>", m.group(2), out, "import")
        for m in NEW_URL_RE.finditer(html_nc):
            check_ref("index.html", m.group(2), out, "new URL()")

    bare_seen = {}
    for path in sorted(out.rglob("*")):
        if not path.is_file():
            continue
        rel = path.relative_to(out).as_posix()
        if path.suffix in (".js", ".mjs"):
            stats["files"] += 1
            text = path.read_text(encoding="utf-8", errors="replace")
            for m in IMPORT_RE.finditer(text):
                if m.group(2).startswith((".", "/")):
                    check_ref(rel, m.group(2), path.parent, "import")
            for m in NEW_URL_RE.finditer(text):
                stats["workers"] += 1
                base = path.parent if m.group(3) in ("import.meta.url", "self.location",
                                                     "self.location.href") else out
                check_ref(rel, m.group(2), base, "new URL()")
            for m in IMPORT_SCRIPTS_RE.finditer(text):
                check_ref(rel, m.group(2), path.parent, "importScripts()")
            for m in STATIC_BARE_IMPORT_RE.finditer(_strip_comments(text)):
                if not ABSOLUTE_RE.match(m.group(2)):
                    bare_seen.setdefault(m.group(2), rel)
        elif path.suffix == ".css":
            text = path.read_text(encoding="utf-8", errors="replace")
            for m in CSS_URL_RE.finditer(text):
                check_ref(rel, m.group(2), path.parent, "CSS url()")

    for spec, rel in sorted(bare_seen.items()):
        if spec not in importmap:
            problems.append("%s: bare import %r is not in index.html's importmap" % (rel, spec))

    # `check --strict` on the staged tree: outside lib/ only the manifest's
    # documented `unmapped` URLs may remain; inside lib/ only LIB_UNREACHABLE_CDN;
    # a URL the manifest MAPS must be gone everywhere (the rewrite missed it).
    mapped = set(offline_deps.replacement_map(manifest))
    unmapped = set(manifest.get("unmapped", {}))
    for path in sorted(out.rglob("*")):
        if not path.is_file() or path.suffix not in (".html", ".js", ".mjs", ".css"):
            continue
        rel = path.relative_to(out).as_posix()
        text = path.read_text(encoding="utf-8", errors="replace")
        for url in sorted(offline_deps.cdn_urls(text)):
            url = url.rstrip(";,")
            if url in mapped:
                problems.append("%s: CDN URL %s was not rewritten to ./lib/" % (rel, url))
            elif rel.startswith("lib/"):
                if url not in LIB_UNREACHABLE_CDN:
                    problems.append("%s: CDN URL %s in vendored code (add it to "
                                    "LIB_UNREACHABLE_CDN with a reason, or vendor it)" % (rel, url))
            elif url not in unmapped:
                problems.append("%s: CDN URL not mapped by offline-deps.json: %s" % (rel, url))

    if stats["refs"] < 300 or stats["workers"] < 5:
        problems.append("verifier saw only %d references / %d new URL()s -- is the tree "
                        "complete, or did a pattern stop matching?" % (stats["refs"], stats["workers"]))
    return problems, stats


# --------------------------------------------------------------------------- #
# main
# --------------------------------------------------------------------------- #

def stage(out, label, commit, manifest):
    check_out_dir(out)  # before any fetch, so a refused --out costs nothing
    rc = offline_deps.cmd_install(manifest, argparse.Namespace(force=False))
    if rc:
        print("!! the offline packages (offline-deps.json) could not be installed -- no "
              "network? Fetch them once with: python3 scripts/offline_deps.py install",
              file=sys.stderr)
        return EXIT_FETCH

    wipe(out)
    files = select_files(manifest)
    rewritten = offline_deps.stage_files(files, offline_deps.replacement_map(manifest),
                                         offline_deps.DirSink(out), set())
    log("staged %d files into %s (CDN URLs rewritten in %d)" % (len(files), out, rewritten))

    stamped = stamp(out, commit, label)
    problems, stats = verify_tree(out, manifest)
    if stamped:
        html = (out / "index.html").read_text(encoding="utf-8")
        if '<meta name="lucid-release" content="%s">' % label not in html:
            problems.append("index.html: lucid-release meta tag was not filled with %r" % label)
    if problems:
        print("!! the staged desktop frontend is broken:", file=sys.stderr)
        for p in problems:
            print("   " + p, file=sys.stderr)
        print("   (a file the app imports but git ignores is not staged)", file=sys.stderr)
        return 1
    log("verified %d references (%d new URL()s) in %d modules; label %r, commit %s"
        % (stats["refs"], stats["workers"], stats["files"],
           label if stamped else "(unstamped)", commit))
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--out", help="output directory (relative = to the repo root)")
    parser.add_argument("--label", help="release label for the menu bar's version tag")
    parser.add_argument("--commit", help="commit stamped as ?v=<commit> (default: HEAD, 12 chars)")
    parser.add_argument("--verify-only", metavar="DIR",
                        help="only run the checks on an already staged directory")
    args = parser.parse_args(argv)
    manifest = offline_deps.load_manifest()
    try:
        if args.verify_only:
            problems, stats = verify_tree(Path(args.verify_only), manifest)
            for p in problems:
                print("   " + p, file=sys.stderr)
            log("%d problem(s); %d references checked" % (len(problems), stats["refs"]))
            return 1 if problems else 0
        if args.out is None:
            parser.error("--out is required")
        return stage(resolve_out(args.out), args.label if args.label is not None else default_label(),
                     args.commit or default_commit(), manifest)
    except StageError as exc:
        print("!! " + str(exc), file=sys.stderr)
        return 2


if __name__ == "__main__":
    sys.exit(main())
