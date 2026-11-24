#!/usr/bin/env python3
"""
Check that every updater signature a build produced was made by the key the
app trusts.

    python3 scripts/desktop/check_update_signatures.py \\
        --conf src-tauri/tauri.conf.json [--require=SUFFIX ...] DIR [DIR ...]

(Write `--require=-setup.exe` with the `=`: argparse reads a bare `-setup.exe`
as an option.)

A TAURI_SIGNING_PRIVATE_KEY that does not match tauri.conf.json's
plugins.updater.pubkey is only a WARNING from the bundler: the build goes
green, the release looks perfect, and every installed app then rejects every
update with an opaque signature error. minisign embeds the signing key's 8-byte
id in both the public key and each signature, so compare those (the method
sleap-app's build.yml uses). Standard library only.

Every `*.sig` under the DIRs (recursively) must carry the configured key id.
Each --require SUFFIX additionally demands a payload ending in SUFFIX with a
`.sig` beside it (the platform's updater artifact was actually produced).
Exit 0 when all hold; 1 on a mismatch or a missing signature; 2 on bad input.
"""

import argparse
import base64
import binascii
import json
import sys
from pathlib import Path


class SigError(Exception):
    pass


def _minisign_line(blob_b64, what):
    """The base64 payload line of a Tauri-wrapped minisign key/signature.

    Tauri base64-encodes the whole minisign text ("untrusted comment: ..."
    newline, then the base64 key/signature line, then for a signature a
    trusted comment and the global signature).
    """
    try:
        text = base64.b64decode(blob_b64.strip(), validate=True).decode("utf-8")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        raise SigError("%s is not base64 of minisign text" % what)
    lines = [l for l in text.splitlines() if l.strip()]
    if len(lines) < 2 or not lines[0].startswith("untrusted comment:"):
        raise SigError("%s is not minisign text (no 'untrusted comment:' header)" % what)
    try:
        return base64.b64decode(lines[1], validate=True)
    except (binascii.Error, ValueError):
        raise SigError("%s: its key/signature line is not base64" % what)


def key_id_of_pubkey(pubkey_b64):
    raw = _minisign_line(pubkey_b64, "the public key")
    if len(raw) != 42 or raw[:2] != b"Ed":
        raise SigError("the public key is not an Ed25519 minisign key")
    return raw[2:10][::-1].hex().upper()


def key_id_of_signature(sig_b64, what):
    raw = _minisign_line(sig_b64, what)
    # "Ed" = plain Ed25519, "ED" = prehashed (BLAKE2b-512), which Tauri uses.
    if len(raw) != 74 or raw[:2] not in (b"Ed", b"ED"):
        raise SigError("%s is not an Ed25519 minisign signature" % what)
    return raw[2:10][::-1].hex().upper()


def configured_pubkey(conf_path):
    try:
        conf = json.loads(Path(conf_path).read_text(encoding="utf-8"))
        return conf["plugins"]["updater"]["pubkey"]
    except (OSError, ValueError, KeyError, TypeError) as exc:
        raise SigError("no plugins.updater.pubkey in %s (%s)" % (conf_path, exc))


def check(pubkey_b64, dirs, require=()):
    """Returns (ok_lines, problems)."""
    want = key_id_of_pubkey(pubkey_b64)
    ok, problems = ["configured updater key id: %s" % want], []
    sigs = sorted(p for d in dirs for p in Path(d).rglob("*.sig") if p.is_file())
    for sig in sigs:
        try:
            got = key_id_of_signature(sig.read_text(encoding="utf-8"), sig.name)
        except (SigError, OSError, UnicodeDecodeError) as exc:
            problems.append("%s: %s" % (sig, exc))
            continue
        if got != want:
            problems.append("%s was signed with key id %s, but plugins.updater.pubkey is %s: "
                            "every installed app would reject this update"
                            % (sig, got, want))
        else:
            ok.append("  %s: %s" % (sig.name, got))
    for suffix in require:
        payloads = [p for d in dirs for p in Path(d).rglob("*" + suffix) if p.is_file()]
        if not payloads:
            problems.append("no *%s updater payload was produced" % suffix)
        for p in payloads:
            if not Path(str(p) + ".sig").is_file():
                problems.append("%s has no .sig beside it" % p)
    if not sigs and not require:
        problems.append("no .sig files found under %s" % ", ".join(map(str, dirs)))
    return ok, problems


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__,
                                 formatter_class=argparse.RawDescriptionHelpFormatter)
    src = ap.add_mutually_exclusive_group(required=True)
    src.add_argument("--conf", help="tauri.conf.json holding plugins.updater.pubkey")
    src.add_argument("--pubkey", help="the base64 public key itself")
    ap.add_argument("--require", action="append", default=[], metavar="SUFFIX",
                    help="a payload with this suffix must exist and be signed (repeatable; use --require=SUFFIX for one starting with -)")
    ap.add_argument("dirs", nargs="+", help="directories to scan for *.sig")
    args = ap.parse_args(argv)
    try:
        pubkey = args.pubkey if args.pubkey else configured_pubkey(args.conf)
        ok, problems = check(pubkey, args.dirs, args.require)
    except SigError as exc:
        print("::error::%s" % exc, file=sys.stderr)
        return 2
    for line in ok:
        print(line)
    for p in problems:
        print("::error::%s" % p, file=sys.stderr)
    return 1 if problems else 0


if __name__ == "__main__":
    sys.exit(main())
