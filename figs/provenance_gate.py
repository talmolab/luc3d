#!/usr/bin/env python3
"""Provenance gate for the final figure build (LUC3D-JS-CONSISTENCY-PLAN-2026-10-20, G1/G2).

The paper tests LUC3D v1.0.5's JavaScript. This gate fails the build unless every input
the figures read is accounted for and every LUC3D number came from that JavaScript.

  provenance_gate.py --links out/md56_logs/X7_links.tsv --loads out/md56_logs/X7_loads.tsv

G1  every deposit the build resolved (links) is in provenance_manifest.json and is not
    'unclassified'; every luc3d_js / app_capture deposit carries lucid_commit = v1.0.5;
    fig2.json (fig2_measure.py's NumPy DLT) is read by nothing; the manifest's
    unlogged inputs (read outside data_loader) pass the same stamp check.
G2  every panel script that ran and every deposit generator it names is scanned for
    Python geometry (triangulate_batch, def triangulate, np.linalg.svd,
    cv2.triangulatePoints, cv2.projectPoints, cv2.undistortPoints); each hit must be in
    the manifest's python_geometry_allowlist.
Writes out/provenance_gate.json and exits 1 on any failure.
"""
import argparse
import glob
import json
import os
import re
import sys

FIGS = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(FIGS, "out")
STAMPED = ("luc3d_js", "app_capture")
GEOM = re.compile(r"triangulate_batch|def triangulate|np\.linalg\.svd|cv2\.triangulatePoints|"
                  r"cv2\.projectPoints|cv2\.undistortPoints")


def stamp_ok(path, v105):
    try:
        d = json.load(open(path))
    except (OSError, ValueError) as e:
        return False, f"unreadable ({e.__class__.__name__})"
    c = d.get("lucid_commit") if isinstance(d, dict) else None
    return c == v105, f"lucid_commit={c}"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--links", required=True)
    ap.add_argument("--loads", required=True)
    a = ap.parse_args()
    man = json.load(open(os.path.join(FIGS, "provenance_manifest.json")))
    v105, deps = man["v105"], man["deposits"]
    fails, rows = [], []

    # ---- G1: every resolved deposit ------------------------------------------------
    for line in open(a.links):
        name, real, src = line.rstrip("\n").split("\t")
        ent = deps.get(real)
        if ent is None:
            fails.append(f"G1 {name} -> {real}: not in provenance_manifest.json"); continue
        r = dict(name=name, file=real, kind=ent["kind"], fig=ent.get("fig"))
        if ent["kind"] == "unclassified":
            fails.append(f"G1 {real}: unclassified ({ent.get('reason')})")
        if ent["kind"] in STAMPED:
            ok, why = stamp_ok(os.path.join(OUT, real), v105)
            r["stamp"] = why
            if not ok:
                fails.append(f"G1 {real} ({ent['kind']}, Fig {ent.get('fig')}): {why}, need {v105[:8]}")
        rows.append(r)
    for line in open(a.loads):
        _s, name, got = line.rstrip("\n").split("\t")
        if os.path.basename(os.path.realpath(os.path.join(OUT, got))) == "fig2.json":
            fails.append(f"G1 {_s} read fig2.json (NumPy DLT)")
    for path, ent in man.get("unlogged_inputs", {}).items():
        full = os.path.normpath(os.path.join(OUT, path))
        if ent["kind"] == "luc3d_js":
            ok, why = stamp_ok(full, v105)
        elif ent["kind"] == "luc3d_js_dir":
            js = glob.glob(os.path.join(full, "**", "*.json"), recursive=True)
            hits = [p for p in js if stamp_ok(p, v105)[0]]
            ok, why = bool(hits), f"{len(hits)} of {len(js)} json files stamped v1.0.5"
        else:
            ok, why = True, "not LUC3D"
        rows.append(dict(name=path, file=path, kind=ent["kind"], fig=ent.get("fig"), stamp=why))
        if not ok:
            fails.append(f"G1 unlogged {path} (Fig {ent.get('fig')}): {why}")

    # ---- G2: Python geometry on the build path ------------------------------------
    scripts = {os.path.join("panels", l.split("\t")[0]) for l in open(a.loads)}
    for r in rows:
        p = os.path.join(OUT, r["file"])
        try:
            g = json.load(open(p)).get("generated_by") if p.endswith(".json") else None
        except (OSError, ValueError, AttributeError):
            g = None
        if isinstance(g, str):
            scripts.add(g.split()[0].replace("figs/", "", 1))
    allow = man.get("python_geometry_allowlist", {})
    scanned = []
    for s in sorted(scripts):
        fp = os.path.join(FIGS, s)
        if not os.path.isfile(fp) or not fp.endswith(".py"):
            continue
        hits = [f"{i}: {ln.strip()[:90]}" for i, ln in enumerate(open(fp), 1)
                if GEOM.search(ln) and not ln.lstrip().startswith("#")]
        scanned.append(dict(script=s, hits=len(hits)))
        if hits and s not in allow:
            fails.append(f"G2 {s}: Python geometry not allowlisted -> {hits[:3]}")

    out = dict(generated_by="figs/provenance_gate.py", v105=v105, passed=not fails,
               failures=fails, inputs=rows, scanned=scanned)
    json.dump(out, open(os.path.join(OUT, "provenance_gate.json"), "w"), indent=1)
    for f in fails:
        print("FAIL", f)
    print(f"PROVENANCE GATE {'PASSED' if not fails else 'FAILED'}: {len(rows)} inputs, "
          f"{len(scanned)} scripts scanned, {len(fails)} failures")
    sys.exit(0 if not fails else 1)


if __name__ == "__main__":
    main()
