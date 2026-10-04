#!/usr/bin/env python3
"""
Vendor LUCID's CDN dependencies into lib/ so the app can run without internet.

LUCID loads four packages from jsdelivr at runtime (three.js, mp4box, dockview-core
and yaml). They are declared in offline-deps.json and are NOT committed. This script
fetches them from the npm registry, verifies them, and extracts them into lib/.

Usage:
    python3 scripts/offline_deps.py install        # fetch + verify + extract
    python3 scripts/offline_deps.py check          # is offline mode ready?
    python3 scripts/offline_deps.py check --strict # also fail on unmapped CDN URLs
    python3 scripts/offline_deps.py bundle         # zip a ready-to-run offline copy
    python3 scripts/offline_deps.py clean          # remove the fetched packages

On Windows use `py` in place of `python3`.

Only the standard library is used, so there is no prerequisite beyond Python 3.8+ --
no curl, no tar, no unzip, no Node. Set LUCID_NPM_REGISTRY to fetch through an
institutional mirror or proxy instead of registry.npmjs.org.

Two modes reach the same result, and both read offline-deps.json so the URL table
exists once:

    checkout   python3 server.py --offline   rewrites CDN URLs as it serves; files
                                             on disk keep their CDN URLs
    bundle     offline_deps.py bundle        rewrites them in a staged copy, so the
                                             zip needs no special server at all

Exit code is 0 only when every requested step fully succeeded, so it is safe to gate
CI or a server startup on it.
"""

import argparse
import base64
import hashlib
import io
import json
import os
import re
import shutil
import subprocess
import sys
import tarfile
import time
import urllib.error
import urllib.request
import zipfile
from pathlib import Path

REPO_ROOT = Path(__file__).resolve().parent.parent
MANIFEST_PATH = REPO_ROOT / "offline-deps.json"

# Where the launcher templates and the end-user readme live.
BUNDLE_TEMPLATES = REPO_ROOT / "scripts" / "offline-bundle"

# npm tarballs put everything under a single "package/" directory.
TAR_PREFIX = "package/"

DOWNLOAD_RETRIES = 3
DOWNLOAD_TIMEOUT = 30

# Files that get URL-rewritten. Anything else is copied byte for byte.
REWRITABLE_SUFFIXES = (".html", ".js", ".mjs")

# Directories never worth shipping, used only when git is unavailable.
WALK_EXCLUDES = {
    ".git", ".github", ".claude", "node_modules", "scratch", "prompts",
    "tempdata", "sample_session", "verify", ".sleap-io-build", "__pycache__",
}


def log(msg):
    print(">> " + msg)


def fail(msg):
    print("!! " + msg, file=sys.stderr)


def rel(path):
    """Repo-relative display path, tolerating anything outside the repo."""
    try:
        return str(Path(path).relative_to(REPO_ROOT))
    except ValueError:
        return str(path)


# --------------------------------------------------------------------------- #
# manifest
# --------------------------------------------------------------------------- #

def load_manifest():
    with MANIFEST_PATH.open(encoding="utf-8") as fh:
        return json.load(fh)


def replacement_map(manifest):
    """{cdn url -> repo-relative local path} across every package."""
    out = {}
    for pkg in manifest["packages"].values():
        out.update(pkg.get("replaces", {}))
    return out


def rewrite_text(text, mapping, depth):
    """Swap CDN URLs for paths relative to a file sitting `depth` dirs below root.

    depth 0 -> ./lib/...   depth 1 -> ../lib/...

    Deliberately relative, not origin-root-relative: LUCID is served from
    sub-paths on gh-pages (/dev/, /stable/, /pr/<n>/), so a leading / would 404
    there. Keeping the invariant true everywhere means nobody has to reason about
    an exception for this one code path.
    """
    prefix = "./" if depth == 0 else "../" * depth
    for url, local in mapping.items():
        text = text.replace(url, prefix + local)
    return text


# --------------------------------------------------------------------------- #
# download + verify
# --------------------------------------------------------------------------- #

def registry_url(manifest, url):
    """Honor LUCID_NPM_REGISTRY so a mirror or proxy can be used."""
    override = os.environ.get("LUCID_NPM_REGISTRY")
    if not override:
        return url
    return url.replace(manifest["registry"].rstrip("/"), override.rstrip("/"), 1)


def download(url):
    last = None
    for attempt in range(1, DOWNLOAD_RETRIES + 1):
        try:
            with urllib.request.urlopen(url, timeout=DOWNLOAD_TIMEOUT) as resp:
                return resp.read()
        except (urllib.error.URLError, OSError) as exc:
            last = exc
            if attempt < DOWNLOAD_RETRIES:
                wait = 2 ** (attempt - 1)
                log("  retry %d/%d in %ds (%s)" % (attempt, DOWNLOAD_RETRIES, wait, exc))
                time.sleep(wait)
    raise RuntimeError("download failed after %d attempts: %s (%s)"
                       % (DOWNLOAD_RETRIES, url, last))


def verify_integrity(blob, integrity):
    """Check an npm `dist.integrity` value, e.g. 'sha512-<base64>'."""
    algo, _, expected_b64 = integrity.partition("-")
    if algo not in ("sha512", "sha384", "sha256"):
        raise RuntimeError("unsupported integrity algorithm: %r" % algo)
    actual = base64.b64encode(hashlib.new(algo, blob).digest()).decode("ascii")
    if actual != expected_b64:
        raise RuntimeError(
            "integrity mismatch\n     expected %s-%s\n     actual   %s-%s"
            % (algo, expected_b64, algo, actual))


# --------------------------------------------------------------------------- #
# extract
# --------------------------------------------------------------------------- #

def _safe_members(tar, wanted_prefix):
    """Yield members under wanted_prefix, rejecting anything that escapes it."""
    for member in tar.getmembers():
        if not member.isfile():
            continue
        if not member.name.startswith(wanted_prefix):
            continue
        rel = member.name[len(TAR_PREFIX):]
        if os.path.isabs(rel) or ".." in Path(rel).parts:
            raise RuntimeError("refusing unsafe tar entry: %r" % member.name)
        yield member, rel


def extract_package(blob, spec, dest):
    """Extract the manifest's declared files. Keys ending in / copy a subtree."""
    tar = tarfile.open(fileobj=io.BytesIO(blob), mode="r:gz")
    written = 0

    for src, dst in spec["files"].items():
        if src.endswith("/"):
            prefix = TAR_PREFIX + src
            found = False
            for member, rel in _safe_members(tar, prefix):
                found = True
                target = dest / dst / rel[len(src):]
                target.parent.mkdir(parents=True, exist_ok=True)
                target.write_bytes(tar.extractfile(member).read())
                written += 1
            if not found:
                raise RuntimeError("no entries under %r in the tarball" % src)
        else:
            member_name = TAR_PREFIX + src
            try:
                member = tar.getmember(member_name)
            except KeyError:
                raise RuntimeError("tarball has no %r" % member_name)
            target = dest / dst
            target.parent.mkdir(parents=True, exist_ok=True)
            target.write_bytes(tar.extractfile(member).read())
            written += 1

    return written


def run_asserts(name, spec, dest):
    """Behavioral checks: pin the API LUCID depends on, not just a hash.

    A checksum tells you the bytes are what upstream published; it cannot tell you
    upstream still exports what the app calls. These do.
    """
    for check in spec.get("assert", []):
        path = dest / check["file"]
        if not path.is_file():
            raise RuntimeError("%s: missing %s (%s)" % (name, check["file"], check["why"]))
        if path.stat().st_size == 0:
            raise RuntimeError("%s: empty %s" % (name, check["file"]))
        needle = check.get("contains")
        if needle:
            text = path.read_text(encoding="utf-8", errors="replace")
            if needle not in text:
                raise RuntimeError(
                    "%s: %s no longer contains %r -- %s"
                    % (name, check["file"], needle, check["why"]))


def write_provenance(name, spec, dest):
    """Match the hand-written lib/*/PROVENANCE.txt house format."""
    files = "\n".join(
        "          %s <- %s" % (dst, src) for src, dst in spec["files"].items())
    note = spec.get("licenseFileNote")
    lines = [
        "%s -- vendored for offline use (NOT committed)." % name,
        "",
        "Version:  %s" % spec["version"],
        "License:  %s" % spec["license"],
        "Source:   %s" % spec["tarball"],
        "Integrity: %s" % spec["integrity"],
        "Why here: %s" % spec["why"],
        "",
        "Files (from the npm tarball's package/):",
        files,
        "",
    ]
    if note:
        lines += ["License note: %s" % note, ""]
    lines += [
        "Generated by scripts/offline_deps.py from offline-deps.json -- do not edit",
        "by hand. Re-fetch with:  python3 scripts/offline_deps.py install --force",
        "",
    ]
    (dest / "PROVENANCE.txt").write_text("\n".join(lines), encoding="utf-8")


def write_dest_gitignore(dest):
    """Keep the directory and its docs visible in the repo, ignore the payload.

    Copied from sleap-app's src-tauri/binaries/.gitignore: someone browsing lib/
    then sees that three/ exists and why, instead of an invisible gap.
    """
    (dest / ".gitignore").write_text(
        "# Fetched by scripts/offline_deps.py, never committed.\n"
        "# The directory and its docs stay tracked so lib/ documents itself.\n"
        "*\n"
        "!.gitignore\n"
        "!PROVENANCE.txt\n",
        encoding="utf-8")


# --------------------------------------------------------------------------- #
# status
# --------------------------------------------------------------------------- #

def expected_files(spec, dest):
    """Concrete files the manifest promises, for presence checks."""
    out = []
    for src, dst in spec["files"].items():
        if src.endswith("/"):
            continue  # subtree: covered by the assert entries instead
        out.append(dest / dst)
    for check in spec.get("assert", []):
        out.append(dest / check["file"])
    return out


def package_status(name, spec):
    """(ok, detail) for one package."""
    dest = REPO_ROOT / spec["dest"]
    if not dest.is_dir():
        return False, "not installed"
    missing = [p for p in expected_files(spec, dest) if not p.is_file()]
    if missing:
        detail = ", ".join(rel(p) for p in missing[:3])
        return False, "incomplete (missing %s)" % detail
    try:
        run_asserts(name, spec, dest)
    except RuntimeError as exc:
        return False, str(exc)
    return True, "ok"


def check_pins(manifest):
    """Every pinned CDN version in source must match the manifest.

    CLAUDE.md requires dockview-core to be pinned in three places; the manifest is
    a fourth. Rather than trust prose, derive the truth: scan for
    cdn.jsdelivr.net/npm/<pkg>@<ver> outside lib/ and require agreement.
    """
    problems = []
    for name, spec in manifest["packages"].items():
        pattern = re.compile(
            r"cdn\.jsdelivr\.net/npm/" + re.escape(name) + r"@([0-9][^/\"'\s]*)")
        for path in source_files():
            try:
                text = path.read_text(encoding="utf-8", errors="replace")
            except OSError:
                continue
            for found in set(pattern.findall(text)):
                if found != spec["version"]:
                    problems.append(
                        "%s pins %s@%s but offline-deps.json pins %s"
                        % (rel(path), name, found, spec["version"]))
    return problems


def find_unmapped_cdn_urls(manifest):
    """CDN URLs in source that offline mode would not rewrite."""
    mapped = set(replacement_map(manifest))
    pattern = re.compile(r"https://(?:cdn\.jsdelivr\.net|unpkg\.com)/[^\"'\s)]+")
    problems = []
    for path in source_files():
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        for url in set(pattern.findall(text)):
            if url.rstrip(";,") not in mapped:
                problems.append("%s: %s" % (rel(path), url))
    return problems


def source_files():
    """Repo source worth scanning: excludes lib/ (vendored) and tooling dirs."""
    for path in tracked_files():
        if path.parts[0] == "lib":
            continue
        if path.suffix in (".html", ".js", ".mjs", ".css"):
            yield REPO_ROOT / path


# --------------------------------------------------------------------------- #
# file inventory
# --------------------------------------------------------------------------- #

def tracked_files():
    """Repo-relative Paths of the files a deploy would ship.

    Prefers `git ls-files`, which is exactly what deploy.yml's rsync of the
    actions/checkout workspace ends up with. Falls back to a filtered walk when
    git is unavailable (e.g. bundling from an extracted source zip).
    """
    try:
        out = subprocess.run(
            ["git", "-C", str(REPO_ROOT), "ls-files", "-z"],
            capture_output=True, check=True).stdout
        names = [n for n in out.decode("utf-8").split("\0") if n]
        if names:
            return [Path(n) for n in names]
    except (OSError, subprocess.CalledProcessError):
        pass

    found = []
    for root, dirs, files in os.walk(REPO_ROOT):
        dirs[:] = [d for d in dirs if d not in WALK_EXCLUDES]
        for fname in files:
            if fname == ".gitignore" or fname.endswith((".pyc", ".swp")):
                continue
            found.append(Path(root, fname).relative_to(REPO_ROOT))
    return found


# --------------------------------------------------------------------------- #
# commands
# --------------------------------------------------------------------------- #

def cmd_install(manifest, args):
    rc = 0
    for name, spec in manifest["packages"].items():
        dest = REPO_ROOT / spec["dest"]
        ok, _ = package_status(name, spec)
        if ok and not args.force:
            log("%s@%s already installed, skipping" % (name, spec["version"]))
            continue

        log("fetching %s@%s" % (name, spec["version"]))
        try:
            blob = download(registry_url(manifest, spec["tarball"]))
            verify_integrity(blob, spec["integrity"])
            if dest.exists():
                shutil.rmtree(dest)
            dest.mkdir(parents=True)
            count = extract_package(blob, spec, dest)
            run_asserts(name, spec, dest)
            write_provenance(name, spec, dest)
            write_dest_gitignore(dest)
        except RuntimeError as exc:
            fail("%s: %s" % (name, exc))
            rc = 1
            continue
        log("  %d files -> %s" % (count, spec["dest"]))

    if rc == 0:
        log("done. Start the app with:  python3 server.py --offline")
    return rc


def cmd_check(manifest, args):
    rc = 0
    for name, spec in manifest["packages"].items():
        ok, detail = package_status(name, spec)
        print("  %-14s %-9s %s" % (name, spec["version"], detail))
        if not ok:
            rc = 1

    if rc:
        fail("offline mode is not ready. Run:  python3 scripts/offline_deps.py install")

    for problem in check_pins(manifest):
        fail("version pin drift: " + problem)
        rc = 1

    if args.strict:
        for problem in find_unmapped_cdn_urls(manifest):
            fail("CDN URL not mapped by offline-deps.json: " + problem)
            rc = 1

    return rc


def cmd_clean(manifest, args):
    for name, spec in manifest["packages"].items():
        dest = REPO_ROOT / spec["dest"]
        if dest.exists():
            shutil.rmtree(dest)
            log("removed %s" % spec["dest"])
    return 0


def cmd_bundle(manifest, args):
    """Stage a pre-rewritten copy of the app and zip it.

    The point of rewriting here rather than at serve time is that the result needs
    no special server: the URLs already say ./lib/..., so whatever static server
    the user happens to have will do. That is what keeps Python off the offline
    machine's requirement list.
    """
    rc = cmd_install(manifest, args)
    if rc:
        return rc

    mapping = replacement_map(manifest)
    out_zip = Path(args.output) if args.output else REPO_ROOT / ("luc3d-offline-%s.zip" % args.label)
    staged = []

    # Everything a deploy would ship, plus the freshly fetched payloads.
    for rel in tracked_files():
        if rel.parts[0] in (".github", ".claude") or rel.name == ".gitignore":
            continue
        staged.append(rel)
    for spec in manifest["packages"].values():
        dest = REPO_ROOT / spec["dest"]
        for path in sorted(dest.rglob("*")):
            if path.is_file() and path.name != ".gitignore":
                staged.append(path.relative_to(REPO_ROOT))

    log("staging %d files" % len(staged))
    rewritten = 0

    # A zip may not carry the same name twice: unzip then stops to ask which copy
    # to keep, which is not something to hand a user on an offline machine.
    seen = set()

    with zipfile.ZipFile(out_zip, "w", zipfile.ZIP_DEFLATED) as zf:
        for rel in sorted(set(staged)):
            src = REPO_ROOT / rel
            if not src.is_file() or rel.as_posix() in seen:
                continue
            seen.add(rel.as_posix())
            if src.suffix in REWRITABLE_SUFFIXES:
                text = src.read_text(encoding="utf-8", errors="surrogateescape")
                new = rewrite_text(text, mapping, depth=len(rel.parts) - 1)
                if new != text:
                    rewritten += 1
                zf.writestr(str(rel.as_posix()), new.encode("utf-8", "surrogateescape"))
            else:
                zf.write(src, rel.as_posix())

        # Launchers and end-user docs.
        for tmpl in sorted(BUNDLE_TEMPLATES.iterdir()):
            if not tmpl.is_file() or tmpl.name in seen:
                continue
            seen.add(tmpl.name)
            data = tmpl.read_bytes()
            info = zipfile.ZipInfo(tmpl.name)
            info.compress_type = zipfile.ZIP_DEFLATED
            # zipfile drops the exec bit, and a .command without it will not run
            # on double-click. 0o755 << 16 is how the mode is carried.
            mode = 0o755 if tmpl.suffix in (".command", ".sh") else 0o644
            info.external_attr = (mode << 16) | 0o100000
            zf.writestr(info, data)

        # Licenses ship unconditionally -- the bundle is a redistribution, and
        # several of these licenses are satisfied precisely by carrying the notice
        # with the files. Included explicitly rather than via tracked_files() so a
        # not-yet-committed LICENSE can never be silently dropped.
        licenses = REPO_ROOT / "lib" / "LICENSES.txt"
        if not licenses.is_file():
            fail("lib/LICENSES.txt is missing -- the bundle needs it")
        for path in sorted((REPO_ROOT / "lib").rglob("LICENSE*")):
            name = path.relative_to(REPO_ROOT).as_posix()
            if path.is_file() and name not in seen:
                seen.add(name)
                zf.write(path, name)

    log("rewrote CDN URLs in %d files" % rewritten)
    log("wrote %s (%.1f MB)" % (out_zip, out_zip.stat().st_size / 1e6))
    log("unzip it on the offline machine, then run the start- script for that OS.")
    return 0


def main(argv=None):
    parser = argparse.ArgumentParser(
        description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)

    p_install = sub.add_parser("install", help="fetch, verify and extract into lib/")
    p_install.add_argument("--force", action="store_true",
                           help="re-fetch even if already installed")
    p_install.set_defaults(func=cmd_install)

    p_check = sub.add_parser("check", help="report whether offline mode is ready")
    p_check.add_argument("--strict", action="store_true",
                         help="also fail on CDN URLs the manifest does not map")
    p_check.set_defaults(func=cmd_check)

    p_bundle = sub.add_parser("bundle", help="zip a ready-to-run offline copy")
    p_bundle.add_argument("--output", help="zip path (default: luc3d-offline-<label>.zip)")
    p_bundle.add_argument("--label", default="dev", help="version label for the filename")
    p_bundle.add_argument("--force", action="store_true")
    p_bundle.set_defaults(func=cmd_bundle)

    p_clean = sub.add_parser("clean", help="remove the fetched packages")
    p_clean.set_defaults(func=cmd_clean)

    args = parser.parse_args(argv)
    try:
        manifest = load_manifest()
    except (OSError, json.JSONDecodeError) as exc:
        fail("cannot read %s: %s" % (MANIFEST_PATH, exc))
        return 2
    return args.func(manifest, args)


if __name__ == "__main__":
    sys.exit(main())
