#!/usr/bin/env python3
"""Merge the per-session fig2 JSONs into one out/fig2.json.

Same payload main() writes: only the serial loop was replaced, so this
reassembles exactly what that loop would have accumulated.
"""
import glob
import json
import os
import sys

SP = os.path.dirname(os.path.abspath(__file__))
HERE = "/root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs"
sys.path.insert(0, HERE)
import fig2_measure as fm  # noqa: E402

STRIDE = int(sys.argv[1]) if len(sys.argv) > 1 else 1
OUT = sys.argv[2] if len(sys.argv) > 2 else os.path.join(HERE, "out", "fig2.json")
REF = os.path.join(HERE, "out", "fig2.stride200.json")


def shape(o, path="", acc=None):
    """Recursive key/type signature, with dict keys that are data collapsed."""
    acc = {} if acc is None else acc
    if isinstance(o, dict):
        keys = sorted(o.keys())
        acc[path] = ("dict", tuple(keys) if len(keys) <= 30 else ("<%d keys>" % len(keys)))
        for k in keys:
            shape(o[k], f"{path}/{k}" if len(keys) <= 30 else f"{path}/*", acc)
    elif isinstance(o, list):
        acc[path] = ("list",)
        if o:
            shape(o[0], path + "[]", acc)
    else:
        acc[path] = (type(o).__name__,)
    return acc


def main():
    files = sorted(glob.glob(os.path.join(SP, f"s{STRIDE}", "*.json")))
    results = [json.load(open(f)) for f in files]
    results.sort(key=lambda r: r["session"])
    used = [r["session"] for r in results]
    payload = dict(
        dataset="BMimica (5 calibrated cameras, 2 mice, 15-node skeleton)",
        root=fm.ROOT, sessions=used, n_sessions=len(results),
        tau_px=fm.TAU_PX, tau_main=fm.TAU_MAIN,
        app_reproj_sigma_px=20.0,
        per_session=results,
    )
    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(OUT, "w") as f:
        json.dump(payload, f, indent=1)
    print(f"[json] {OUT}  {os.path.getsize(OUT)/1024:.0f} KB  {len(results)} sessions")

    # structure check against the deposited stride-200 file
    ref = json.load(open(REF))
    a, b = shape(ref), shape(payload)
    miss = sorted(set(a) - set(b))
    extra = sorted(set(b) - set(a))
    diff = [k for k in sorted(set(a) & set(b)) if a[k] != b[k]]
    print(f"[schema] missing={len(miss)} extra={len(extra)} type/keys-differ={len(diff)}")
    for k in miss[:20]:
        print("  MISSING", k, a[k])
    for k in extra[:20]:
        print("  EXTRA  ", k, b[k])
    for k in diff[:20]:
        print("  DIFF   ", k, a[k], "->", b[k])
    print("[sessions] ref", len(ref["sessions"]), "new", len(used),
          "same set:", set(ref["sessions"]) == set(used))


if __name__ == "__main__":
    main()
