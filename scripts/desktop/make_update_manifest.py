#!/usr/bin/env python3
"""
Write the in-app updater's latest.json (Tauri's static update format) for one
release of the luc3d desktop app.

    python3 scripts/desktop/make_update_manifest.py \\
        --version 1.2.0 --notes-file notes.md --pub-date 2026-11-04T12:00:00Z \\
        --base-url https://github.com/<owner>/<repo>/releases/download/v1.2.0 \\
        --assets-dir artifacts [--output latest.json]

Used by .github/workflows/desktop.yml for both channels (a `vX.Y.Z[-N]` release
and the rolling `desktop-dev` prerelease). Standard library only.

Each updater payload in --assets-dir (non-recursive) must sit next to its
`.sig` (the Tauri signer's output, base64 text), and maps to these platform
keys -- tauri-plugin-updater looks up "{os}-{arch}-{installer}" first, then
"{os}-{arch}":

    *.app.tar.gz   darwin-aarch64, darwin-x86_64, darwin-aarch64-app,
                   darwin-x86_64-app   (one universal tarball serves both
                   arches: each slice reports its own arch at runtime)
    *-setup.exe    windows-x86_64, windows-x86_64-nsis
    *.AppImage     linux-x86_64, linux-x86_64-appimage

Refuses (exit 1, nothing written) when a payload has no .sig, a .sig has no
payload, two payloads claim the same platform, or no platform was found at
all: an empty or half-signed latest.json would break every installed app's
update check rather than merely offering nothing.
"""

import argparse
import json
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import quote

RULES = [
    (".app.tar.gz", ["darwin-aarch64", "darwin-x86_64", "darwin-aarch64-app", "darwin-x86_64-app"]),
    ("-setup.exe", ["windows-x86_64", "windows-x86_64-nsis"]),
    (".AppImage", ["linux-x86_64", "linux-x86_64-appimage"]),
]

# Tauri compares versions as semver (a leading "v" is tolerated, not needed).
SEMVER = re.compile(r"^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$")


class ManifestError(Exception):
    pass


def rfc3339(text):
    """Validate (and return) an RFC 3339 timestamp; default: now, UTC."""
    if not text:
        return datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    try:
        datetime.fromisoformat(text.replace("Z", "+00:00"))
    except ValueError:
        raise ManifestError("--pub-date %r is not an RFC 3339 timestamp" % text)
    if not re.search(r"(Z|[+-]\d\d:\d\d)$", text):
        raise ManifestError("--pub-date %r has no time zone (use ...Z)" % text)
    return text


def build_manifest(version, notes, pub_date, base_url, assets_dir):
    if not SEMVER.match(version):
        raise ManifestError("--version %r is not semver (X.Y.Z[-pre][+build])" % version)
    if not re.match(r"^https://", base_url):
        raise ManifestError("--base-url must be an https:// URL, got %r" % base_url)
    assets = Path(assets_dir)
    if not assets.is_dir():
        raise ManifestError("--assets-dir %s is not a directory" % assets_dir)
    names = sorted(p.name for p in assets.iterdir() if p.is_file())

    platforms, problems = {}, []
    for suffix, keys in RULES:
        payloads = [n for n in names if n.endswith(suffix)]
        orphans = [n for n in names if n.endswith(suffix + ".sig") and n[:-4] not in names]
        for n in orphans:
            problems.append("%s has no payload %s next to it" % (n, n[:-4]))
        if len(payloads) > 1:
            problems.append("%s: more than one payload (%s)" % (keys[0], ", ".join(payloads)))
            continue
        if not payloads:
            continue
        payload = payloads[0]
        if payload + ".sig" not in names:
            problems.append("%s has no %s.sig: the updater would reject it" % (payload, payload))
            continue
        signature = (assets / (payload + ".sig")).read_text(encoding="utf-8").strip()
        if not signature:
            problems.append("%s.sig is empty" % payload)
            continue
        entry = {"signature": signature, "url": base_url.rstrip("/") + "/" + quote(payload)}
        for key in keys:
            platforms[key] = dict(entry)

    if problems:
        raise ManifestError("refusing to write latest.json:\n  " + "\n  ".join(problems))
    if not platforms:
        raise ManifestError("refusing to write latest.json: no updater payload in %s "
                            "(expected *.app.tar.gz, *-setup.exe or *.AppImage with a .sig)"
                            % assets_dir)
    return {"version": version, "notes": notes, "pub_date": pub_date, "platforms": platforms}


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--version", required=True, help="X.Y.Z[-pre], no leading v")
    ap.add_argument("--notes-file", help="release notes (UTF-8 text); default: empty")
    ap.add_argument("--pub-date", help="RFC 3339 timestamp; default: now (UTC)")
    ap.add_argument("--base-url", required=True,
                    help="the release's download URL, e.g. .../releases/download/<tag>")
    ap.add_argument("--assets-dir", required=True, help="directory holding payloads and .sig files")
    ap.add_argument("--output", default="latest.json", help="where to write (default: latest.json)")
    args = ap.parse_args(argv)
    try:
        notes = Path(args.notes_file).read_text(encoding="utf-8").strip() if args.notes_file else ""
        manifest = build_manifest(args.version, notes, rfc3339(args.pub_date),
                                  args.base_url, args.assets_dir)
    except (ManifestError, OSError) as exc:
        print("::error::%s" % exc, file=sys.stderr)
        return 1
    Path(args.output).write_text(json.dumps(manifest, indent=2) + "\n", encoding="utf-8")
    print("wrote %s: version %s, platforms %s"
          % (args.output, manifest["version"], ", ".join(sorted(manifest["platforms"]))))
    return 0


if __name__ == "__main__":
    sys.exit(main())
