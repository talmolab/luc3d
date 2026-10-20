#!/usr/bin/env python
"""Mouse-Dyad-10M b-series (2026-10-15, EXPLORATORY): does a lighter pool or the tail help LUC3D?

LUC3D only (v1.0.5 2dc001fe real tracker, fig3_bench.mjs + LUCID_ROOT defaults = the paper's
sync / stale 20 / distanceThreshold 25 / corr3d 6), all 56 sessions, scored TAIL-FREE exactly as
the paper (fig3_score.score_session, SCORE_NOTAIL=1, IoU 0.5) against the same GT.

  b0  paper pool det_h5/,          tail excluded  -> GATE: must reproduce the paper
  b1  lighter pool det_h5_bvis5/,  tail excluded  (SLAP-2M's rule: >= 5 body kps, no score filters)
  b2  paper pool det_h5/,          tail INCLUDED in tracking (weight 1, --no-exclude-tail)
  b3  lighter pool det_h5_bvis5/,  tail INCLUDED

Nothing existing is written: tracker outputs go to out/tmp/mdb_2dc001fe/<cfg>/, scores to
out/tmp/mdb_2dc001fe/<cfg>/<sid>.score.json, the summary to out/mdb_experiment_v105.json
(refuses to overwrite). The b0 gate compares every tracker output digest with the paper's
v1.0.5 outputs (out/tmp/md_main2dc001fe/) and the scored per-session cross IDF1 with
out/fig8_methods_50_md56.json cell sync_stale20_dist25.

    LUCID_ROOT=/root/vast/eric/lucid-main-md56 SCORE_NOTAIL=1 PATH=/root/vast/eric/node26_env/bin:$PATH \
      <scoring python> figs/mdb_experiment.py --stage track --configs b0,b1,b2,b3 --workers N
    ... --stage score --configs b0,b1,b2,b3 --workers N
    ... --stage summary
"""
import argparse, json, os, subprocess, sys
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

FIGS = Path(__file__).resolve().parent
OUT = FIGS / "out"
sys.path.insert(0, str(FIGS))
DRIVER = FIGS / "fig3-bench" / "fig3_bench.mjs"
BM = Path("/root/vast/eric/luc3d-bench/outputs/bmimica")
CAMS = ["21241563", "21369048", "21372315", "21372316", "22085397"]
TMP = OUT / "tmp" / "mdb_2dc001fe"
REF_OUT = OUT / "tmp" / "md_main2dc001fe"
DEPOSIT = OUT / "mdb_experiment_v105.json"
CONFIGS = {
    "b0": {"pool": BM / "det_h5", "tail": False, "what": "paper pool, tail excluded (gate)"},
    "b1": {"pool": BM / "det_h5_bvis5", "tail": False, "what": "lighter pool (>=5 body kps, no sleap-nn filters), tail excluded"},
    "b2": {"pool": BM / "det_h5", "tail": True, "what": "paper pool, tail included in tracking"},
    "b3": {"pool": BM / "det_h5_bvis5", "tail": True, "what": "lighter pool, tail included in tracking"},
}


def sessions():
    return sorted(p.stem for p in REF_OUT.glob("2025*.json"))


def track_one(cfg, s):
    c = CONFIGS[cfg]
    o = TMP / cfg / f"{s}.json"
    if o.exists() and o.stat().st_size > 100:
        return cfg, s, "skip"
    o.parent.mkdir(parents=True, exist_ok=True)
    cal = next((Path("/root/vast/eric/BMimica") / s / "calibration").glob("*_calibration.toml"))
    cmd = ["node", str(DRIVER), "--session-idx", "0", "--num-animals", "2", "--calibration", str(cal),
           "--pred-h5-dir", str(c["pool"] / s), "--cameras", ",".join(CAMS), "--out", str(o)]
    if c["tail"]:
        cmd.append("--no-exclude-tail")
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=10800)
    return cfg, s, ("ok" if r.returncode == 0 else "FAILED " + r.stderr[-300:])


def score_one(cfg, s):
    import fig3_score as fs
    c = CONFIGS[cfg]
    o = TMP / cfg / f"{s}.json"
    sc = TMP / cfg / f"{s}.score.json"
    if sc.exists():
        return cfg, s, json.loads(sc.read_text())
    r = fs.score_session(str(o), str(c["pool"] / s), str(BM / "gt" / s), CAMS, 2)
    rec = {k: r[k] for k in ("within_idf1", "cross_idf1", "within_idp", "within_idr", "cross_idp",
                             "cross_idr", "within_switches", "cross_switches")}
    sc.write_text(json.dumps(rec))
    return cfg, s, rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--stage", choices=["track", "score", "summary"], required=True)
    ap.add_argument("--configs", default="b0,b1,b2,b3")
    ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()
    cfgs = a.configs.split(",")
    if os.environ.get("SCORE_NOTAIL") != "1":
        sys.exit("set SCORE_NOTAIL=1 (scoring is tail-free in every config, as in the paper)")
    root = os.environ.get("LUCID_ROOT") or sys.exit("set LUCID_ROOT to the v1.0.5 checkout")
    commit = subprocess.run(["git", "-C", root, "rev-parse", "HEAD"], capture_output=True, text=True, check=True).stdout.strip()
    if not commit.startswith("2dc001fe"):
        sys.exit(f"LUCID_ROOT at {commit[:8]}, not v1.0.5")
    S = sessions()
    assert len(S) == 56, len(S)
    if a.stage in ("track", "score"):
        fn = track_one if a.stage == "track" else score_one
        bad = 0
        with ProcessPoolExecutor(a.workers) as ex:
            futs = [ex.submit(fn, c, s) for c in cfgs for s in S]
            for i, f in enumerate(as_completed(futs), 1):
                c, s, r = f.result()
                if isinstance(r, str) and r.startswith("FAILED"):
                    bad += 1; print(f"  {c}/{s} {r}", flush=True)
                if i % 28 == 0:
                    print(f"[{a.stage}] {i}/{len(futs)}", flush=True)
        print(f"[{a.stage}] done, {bad} failed"); sys.exit(1 if bad else 0)

    # summary
    if DEPOSIT.exists():
        sys.exit(f"refusing to overwrite {DEPOSIT}")
    sys.path.insert(0, str(FIGS))
    import fig3_hh_freshanchor as fa
    ref = {c["config"]: c for c in json.load(open(OUT / "fig8_methods_50_md56.json"))["cells"]}["sync_stale20_dist25"]
    ref_ps = {p["session"]: p for p in ref["per_session"]}
    out = {"generated_by": "figs/mdb_experiment.py", "status": "EXPLORATORY (b-series); not in the paper",
           "lucid_commit": commit, "scoring": "tail-free (SCORE_NOTAIL=1), IoU 0.5, same GT as the paper",
           "paper_reference": {"cross_idf1_mean": ref["idf1_cross"], "within_switches": ref["switches"]},
           "configs": {}}
    for c in cfgs:
        recs = [json.loads((TMP / c / f"{s}.score.json").read_text()) for s in S]
        m = lambda k: sum(r[k] for r in recs) / len(recs)
        out["configs"][c] = {"what": CONFIGS[c]["what"], "pool": str(CONFIGS[c]["pool"]), "tail_in_tracking": CONFIGS[c]["tail"],
                             "cross_idf1_mean": m("cross_idf1"), "within_idf1_mean": m("within_idf1"),
                             "cross_idp_mean": m("cross_idp"), "cross_idr_mean": m("cross_idr"),
                             "within_switches": sum(r["within_switches"] for r in recs),
                             "cross_switches": sum(r["cross_switches"] for r in recs),
                             "per_session": dict(zip(S, recs))}
    if "b0" in cfgs:
        dig = sum(fa.payload_digest(TMP / "b0" / f"{s}.json") == fa.payload_digest(REF_OUT / f"{s}.json") for s in S)
        idf = sum(abs(out["configs"]["b0"]["per_session"][s]["cross_idf1"] - ref_ps[s]["cross_idf1"]) < 1e-12 for s in S)
        out["gate_b0"] = {"tracker_outputs_identical": dig, "cross_idf1_identical": idf, "of": len(S),
                          "pass": dig == len(S) and idf == len(S)}
        print("GATE b0:", out["gate_b0"])
    DEPOSIT.write_text(json.dumps(out, indent=1))
    print(f"{'cfg':4} {'crossIDF1':>9} {'IDP':>6} {'IDR':>6} {'switches':>8}  what")
    print(f"{'ppr':4} {ref['idf1_cross']:9.4f} {'':>6} {'':>6} {ref['switches']:8d}  paper (fig8 sync_stale20_dist25)")
    for c, v in out["configs"].items():
        print(f"{c:4} {v['cross_idf1_mean']:9.4f} {v['cross_idp_mean']:6.3f} {v['cross_idr_mean']:6.3f} {v['within_switches']:8d}  {v['what']}")
    sys.exit(0 if out.get("gate_b0", {}).get("pass", True) else 1)


if __name__ == "__main__":
    main()
