#!/usr/bin/env python
"""Smoke test for lucid-exported .slp files under the pinned sleap-io version.

Run:
    python scripts/test-slp-load.py                      # scan default dir
    python scripts/test-slp-load.py path/to/file.slp     # one file

Expects sleap-io to be importable from the current Python environment. The
sibling plan at prompts/slp-export-refix.md describes which version must be
pinned (v0.6.5 via editable install of the pinned-sleap-gui-mimic branch).
"""

from __future__ import annotations

import sys
import traceback
from pathlib import Path

import sleap_io  # noqa: E402

TEST_DIR = Path(__file__).resolve().parent.parent / "tmp" / "test-exports"


def probe_file(path: Path) -> bool:
    """Load one .slp and print a structured summary. Returns True on success."""
    print(f"\n=== {path.name} ===")
    print(f"  path:        {path}")
    print(f"  size:        {path.stat().st_size} bytes")

    try:
        import h5py

        with h5py.File(path, "r") as f:
            fmt = f["metadata"].attrs.get("format_id", "<missing>")
            datasets = sorted(f.keys())
        print(f"  format_id:   {fmt}")
        print(f"  datasets:    {datasets}")
    except Exception as exc:
        print(f"  [!] could not h5-peek: {exc!r}")

    try:
        labels = sleap_io.load_slp(str(path))
    except Exception:
        print("  [FAIL] sleap_io.load_slp raised:")
        traceback.print_exc()
        return False

    n_frames = len(labels.labeled_frames)
    n_videos = len(labels.videos)
    n_skel = len(labels.skeletons)
    n_tracks = len(labels.tracks)
    n_inst = sum(len(lf.instances) for lf in labels.labeled_frames)
    print("  [OK] loaded")
    print(f"      labeled_frames: {n_frames}")
    print(f"      videos:         {n_videos}")
    print(f"      skeletons:      {n_skel}")
    print(f"      tracks:         {n_tracks}")
    print(f"      instances:      {n_inst}")

    if n_frames == 0:
        print("  [WARN] labeled_frames is empty — load succeeded but file is hollow.")
        return False
    return True


def main() -> int:
    print(f"sleap_io.__version__ = {sleap_io.__version__}")
    print(f"sleap_io.__file__    = {sleap_io.__file__}")

    args = [Path(a) for a in sys.argv[1:]]
    if args:
        targets = args
    else:
        if not TEST_DIR.exists():
            print(f"\n[!] test dir missing: {TEST_DIR}")
            print("    Create it and drop exported .slp files there, then re-run.")
            return 2
        targets = sorted(TEST_DIR.glob("*.slp"))

    if not targets:
        print(f"\nNo .slp files found in {TEST_DIR}.")
        print("Drop a lucid File -> Export 2D SLP (Per Camera / All Views)")
        print("export there and re-run.")
        print("(See prompts/slp-export-refix.md for the full iteration loop.)")
        return 0

    any_fail = False
    for t in targets:
        ok = probe_file(t)
        any_fail = any_fail or not ok
    print("\n" + ("ALL OK" if not any_fail else "ONE OR MORE FAILED"))
    return 1 if any_fail else 0


if __name__ == "__main__":
    sys.exit(main())
