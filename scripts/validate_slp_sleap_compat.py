#!/usr/bin/env python3
"""Validate that LUCID-exported .slp files are SLEAP-GUI compatible.

Reads each .slp through the canonical `sleap_io` reader (the same library the
SLEAP GUI uses) and asserts the file round-trips with a sane, non-empty
structure. Optionally compares a LUCID export against a native SLEAP-GUI export
of the same data to prove they are *semantically identical*, not merely both
loadable.

This is the headless half of `lucid-e2e` Stage 4. The browser produces the
`.slp` files (LUCID's sleap-io.js serializer only runs in the browser); this
script is what confirms the bytes are GUI-compatible afterwards.

`sleap_io` is usually NOT on the default python path. Two ways to provision it:

Standalone (no SLEAP repo — pins the same sleap-io SLEAP 1.6.3 ships, 0.7.x):

    uv run --with 'sleap-io>=0.7.0,<0.8.0' --with numpy python \
        <luc3d>/scripts/validate_slp_sleap_compat.py \
        /path/export_camA.slp /path/export_camB.slp

Or from the SLEAP repo, which provisions its pinned sleap-io:

    cd <sleap-repo>          # e.g. /root/vast/joshua/sleap
    uv run python <luc3d>/scripts/validate_slp_sleap_compat.py \
        /path/export_camA.slp /path/export_camB.slp

    # Prove LUCID == SLEAP GUI for the same view:
    uv run python <luc3d>/scripts/validate_slp_sleap_compat.py \
        --compare /path/cam_C_lucid_export.slp /path/cam_C_SLEAPGUI_export.slp

    # Prove LUCID's own metadata.lucid survives a SLEAP-side round trip:
    uv run python <luc3d>/scripts/validate_slp_sleap_compat.py \
        --metadata-roundtrip /path/project.slp

Exit code is 0 only when every check passes; non-zero on any load failure,
empty track list, comparison mismatch, or metadata loss — so it is safe to gate
CI / e2e on.
"""
from __future__ import annotations

import argparse
import json
import sys
import tempfile
from pathlib import Path


def _load():
    try:
        import sleap_io as sio  # noqa: WPS433 (import inside fn: optional dep)
    except ImportError:
        sys.stderr.write(
            "ERROR: sleap_io not importable. Run via `uv run python ...` from the "
            "SLEAP repo (it provisions the pinned sleap-io).\n"
        )
        raise SystemExit(2)
    return sio


def _summary(sio, path):
    """Return (labels, rows) where rows are sorted, comparable instance tuples."""
    import numpy as np

    labels = sio.load_slp(path)
    nodes = [n.name for n in labels.skeletons[0].nodes] if labels.skeletons else []
    rows = []
    for frame in labels.labeled_frames:
        for inst in frame.instances:
            pts = np.round(np.nan_to_num(inst.numpy()), 2).tobytes()
            track = inst.track.name if inst.track else None
            rows.append((frame.frame_idx, track, type(inst).__name__, pts))
    rows.sort(key=lambda r: (r[0], str(r[1]), r[2]))
    return labels, nodes, rows


def validate(path, *, require_tracks=True):
    """Assert one .slp loads and (by default) has a non-empty track list."""
    sio = _load()
    try:
        labels, nodes, rows = _summary(sio, path)
    except Exception as exc:  # noqa: BLE001 — surface any reader error as a FAIL
        print(f"FAIL  {path}\n      load error: {type(exc).__name__}: {exc}")
        return False

    track_names = [t.name for t in labels.tracks]
    n_inst = len(rows)
    print(f"OK    {path}")
    print(f"      {labels!r}")
    print(f"      skeleton nodes={len(nodes)} {nodes}")
    print(f"      tracks={track_names}")
    print(f"      labeled_frames={len(labels.labeled_frames)} instances={n_inst}")

    if require_tracks and not track_names:
        print(
            "FAIL  track list is EMPTY — tracks must survive export (a flat 2D "
            "project must not export trackless). See lucid-e2e Stage 4."
        )
        return False
    return True


def compare(lucid_path, gui_path):
    """Assert a LUCID export is structurally identical to a SLEAP-GUI export."""
    sio = _load()
    try:
        la, na, ra = _summary(sio, lucid_path)
        lb, nb, rb = _summary(sio, gui_path)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  compare load error: {type(exc).__name__}: {exc}")
        return False

    ok = True
    if na != nb:
        print(f"FAIL  skeleton nodes differ:\n      LUCID {na}\n      GUI   {nb}")
        ok = False
    if len(ra) != len(rb):
        print(f"FAIL  instance count differs: LUCID {len(ra)} vs GUI {len(rb)}")
        ok = False

    matched = 0
    for (fa, ta, tya, pa), (fb, tb, tyb, pb) in zip(ra, rb):
        same = (fa, ta, tya, pa) == (fb, tb, tyb, pb)
        matched += same
        flag = "" if same else "   <-- MISMATCH"
        print(f"  f{fa} track={ta} type={tya} | f{fb} track={tb} type={tyb}{flag}")
    if matched != len(ra):
        ok = False

    print(
        f"\n{'OK   ' if ok else 'FAIL '} LUCID vs SLEAP-GUI: "
        f"{matched}/{len(ra)} instance rows identical (nodes, tracks, types, points)"
    )
    return ok


def _read_lucid_metadata(path):
    """Pull `sessions_json[*].metadata.lucid` straight out of the HDF5.

    Deliberately NOT via `sio.load_slp` — Python sleap_io carries the session
    `metadata` dict through faithfully but does not expose it as an attribute on
    its RecordingSession object, so reading it back requires going to the file.
    That is true of LUCID's long-standing keys (`sessionName`, `tracks`,
    `identities`, ...) as much as the newer Visibility ones.

    Returns a list of per-session lucid dicts (empty list when absent).
    """
    import h5py
    import numpy as np

    with h5py.File(path, "r") as handle:
        if "sessions_json" not in handle:
            return []
        raw = handle["sessions_json"][()]
    if isinstance(raw, np.ndarray):
        raw = raw[0]
    if isinstance(raw, bytes):
        raw = raw.decode()
    parsed = json.loads(raw)
    sessions = parsed if isinstance(parsed, list) else [parsed]
    return [(s.get("metadata") or {}).get("lucid", {}) for s in sessions]


# Session-scoped Visibility-panel settings (see
# import-export/visibility-metadata.js). Optional by design — a project nobody
# adjusted carries none of them, which is what keeps its bytes unchanged.
VISIBILITY_KEYS = (
    "videoBrightness", "videoContrast", "videoRotation",
    "hiddenCameras", "hiddenTracks", "hiddenIdentities",
)


def metadata_roundtrip(path):
    """Assert LUCID's `metadata.lucid` survives a SLEAP-side load + re-save.

    This is what makes the Visibility settings (and every other lucid key) safe
    to store there: sleap_io treats the dict as opaque JSON, so a user who opens
    a LUCID project in the SLEAP GUI and saves it must not silently strip them.
    """
    sio = _load()
    try:
        before = _read_lucid_metadata(path)
        labels = sio.load_slp(path)
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL  {path}\n      load error: {type(exc).__name__}: {exc}")
        return False

    if not before:
        print(f"OK    {path}\n      no sessions_json/metadata.lucid — nothing to round-trip")
        return True

    with tempfile.TemporaryDirectory() as tmp:
        out = str(Path(tmp) / "resaved.slp")
        try:
            sio.save_slp(labels, out)
            after = _read_lucid_metadata(out)
        except Exception as exc:  # noqa: BLE001
            print(f"FAIL  {path}\n      re-save error: {type(exc).__name__}: {exc}")
            return False

    print(f"OK    {path}")
    if len(before) != len(after):
        print(f"FAIL  session count changed on re-save: {len(before)} -> {len(after)}")
        return False

    ok = True
    for idx, (b, a) in enumerate(zip(before, after)):
        vis = sorted(k for k in b if k in VISIBILITY_KEYS)
        print(f"      session {idx}: metadata.lucid keys={sorted(b)}")
        print(f"      session {idx}: visibility keys={vis or '(none — all default)'}")
        missing = sorted(set(b) - set(a))
        changed = sorted(k for k in b if k in a and a[k] != b[k])
        if missing:
            print(f"FAIL  session {idx}: keys DROPPED by the re-save: {missing}")
            ok = False
        if changed:
            print(f"FAIL  session {idx}: keys ALTERED by the re-save: {changed}")
            ok = False
    if ok:
        print("      every metadata.lucid key survived the SLEAP round trip unchanged")
    return ok


def main(argv=None):
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("slp", nargs="*", help="One or more .slp files to validate")
    parser.add_argument(
        "--compare",
        nargs=2,
        metavar=("LUCID_SLP", "GUI_SLP"),
        help="Assert a LUCID export is identical to a SLEAP-GUI export",
    )
    parser.add_argument(
        "--allow-trackless",
        action="store_true",
        help="Do not fail on an empty track list (off by default)",
    )
    parser.add_argument(
        "--metadata-roundtrip",
        nargs="+",
        metavar="SLP",
        help="Assert each file's metadata.lucid (incl. the session-scoped "
             "Visibility settings) survives a sleap_io load + re-save unchanged",
    )
    args = parser.parse_args(argv)

    if not args.slp and not args.compare and not args.metadata_roundtrip:
        parser.error(
            "provide at least one .slp to validate, --compare A B, "
            "or --metadata-roundtrip SLP..."
        )

    ok = True
    for path in args.slp:
        ok = validate(path, require_tracks=not args.allow_trackless) and ok
        print()
    if args.compare:
        ok = compare(args.compare[0], args.compare[1]) and ok
    for path in args.metadata_roundtrip or []:
        ok = metadata_roundtrip(path) and ok
        print()

    print("\n=== RESULT:", "PASS ===" if ok else "FAIL ===")
    return 0 if ok else 1


if __name__ == "__main__":
    raise SystemExit(main())
