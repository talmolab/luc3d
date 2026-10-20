#!/usr/bin/env python
"""Rebuild the Mouse-Dyad-10M block of `fig7_variant_best_<tag>.json` from tagged deposits.

Supp Fig 6A reads `fig7_variant_best*.json` `bmimica_50_sessions` (the key name is
historical; it holds every session the deposits cover) and `bmimica_wins`. For the
tail-free run (bvis5nt, 2026-10-12) that block was assembled by hand. This script does the
same assembly from files, so it can be re-run and checked:

  * `LUC3D`           <- fig8_methods_50_<tag>.json, cell `sync_stale20_dist25` (the tracker
                         the app ships since #210)
  * `LUC3D (shipped)` <- the same deposit, cell `shipped` (the pre-#210 "previous default")
  * `SLEAP per-camera`, `ByteTrack` <- fig7_fair_baselines_<tag>.json's two-identity arms.
                         The panel overlays these same arms at render time; they are written
                         here too so every number in the block covers the same sessions.
  * `bmimica_wins`    <- LUC3D vs each fair arm, and LUC3D vs `LUC3D (shipped)`, per session.
  * `3D-MuPPET` and the invalid 2-track SLEAP truncation are DROPPED: neither is in the
    manuscript (the variant panel does not draw 3D-MuPPET) and neither was measured beyond
    the original 50 sessions.

Everything outside the Mouse-Dyad block (the SLAP-2M sections) is copied from --base.

    $PY figs/fig6_variant_best_rebuild.py --tag bvis5nt --check   # must reproduce the hand build
    $PY figs/fig6_variant_best_rebuild.py --tag md56 --base bvis5nt
"""
import argparse
import json
import os
import math
import sys
from pathlib import Path

FIGS = Path(__file__).resolve().parent
OUT = FIGS / "out"
sys.path.insert(0, str(FIGS))
from fig6_variant_tracker import sign_p, stats  # noqa: E402  (the original builder's own)

FRESH = "sync_stale20_dist25"
FAIR = {"SLEAP per-camera": "SLEAP per-camera (2 tracks enforced)",
        "ByteTrack": "ByteTrack (2 identities, B1s)"}


def luc_entry(cell):
    per = cell["per_session"]
    w = [q["within_idf1"] for q in per]
    c = [q["cross_idf1"] for q in per]
    drift = sorted(abs(q["cross_idf1"] - q["within_idf1"]) for q in per)
    return {
        "within": stats(w), "cross": stats(c),
        "switches_2d_total": cell["switches"],
        "switches_xview_total": sum(q["cross_switches"] for q in per),
        "per_session_within": w, "per_session_cross": c,
        "drift_abs_max": drift[-1], "drift_abs_median": float(drift[len(drift) // 2]),
        "drift_wilcoxon_p": None, "drift_sign_p": None,
        "cross_over_within": {"mean": sum(c) / max(1e-12, sum(w)),
                              "ci95_lo": None, "ci95_hi": None},
    }


def fair_entry(arm):
    w, c = arm["per_session_within"], arm["per_session_cross"]
    return {"within": stats(w), "cross": stats(c),
            "switches_2d_total": arm.get("switches_2d_total"),
            "per_session_within": w, "per_session_cross": c,
            "cross_over_within": {"mean": sum(c) / max(1e-12, sum(w)),
                                  "ci95_lo": None, "ci95_hi": None},
            "config": arm.get("config")}


def build(tag, base_tag):
    base = json.loads((OUT / f"fig7_variant_best_{base_tag}.json").read_text())
    f8 = json.loads((OUT / f"fig8_methods_50_{tag}.json").read_text())
    fair = json.loads((OUT / f"fig7_fair_baselines_{tag}.json").read_text())
    cells = {c["config"]: c for c in f8["cells"]}
    # VB_SHIPPED_CELL (2026-10-15, b3): the "previous default" cell. b3 has no pre-#210 `shipped`
    # cell (that is the fork on det_h5), so it uses stale0_dist25 (v1.0.5, eviction off), the
    # same stand-in Supp 6F uses via FIG6F_NOEVICT. Unset = `shipped`, unchanged.
    fresh, ship = cells[FRESH], cells[os.environ.get("VB_SHIPPED_CELL", "shipped")]
    for c in (fresh, ship):
        if c.get("status") != "ok":
            raise SystemExit(f"cell {c['config']} status {c.get('status')}")
    sess = [q["session"] for q in fresh["per_session"]]
    if [q["session"] for q in ship["per_session"]] != sess:
        raise SystemExit("fresh and shipped cells cover different sessions")
    if sorted(fair["sessions"]) != sorted(sess):
        raise SystemExit(f"fair baselines cover {len(fair['sessions'])} sessions, "
                         f"LUC3D {len(sess)} -- not the same corpus")
    luc = {q["session"]: (q["within_idf1"], q["cross_idf1"]) for q in fresh["per_session"]}

    bm = {"LUC3D": luc_entry(fresh), "LUC3D (shipped)": luc_entry(ship)}
    wins = {}
    for key, fkey in FAIR.items():
        arm = fair["arms"][fkey]
        bm[key] = fair_entry(arm)
        w = {}
        for i, lbl in enumerate(("within", "cross")):
            vals = arm[f"per_session_{lbl}"]
            k = sum(1 for s, v in zip(fair["sessions"], vals) if luc[s][i] > v)
            w[lbl] = {"wins": k, "n": len(vals), "sign_p": sign_p(k, len(vals))}
        wins[key] = w
    sw = {q["session"]: q for q in ship["per_session"]}
    wins["LUC3D"] = {
        lbl: {"wins": sum(1 for q in fresh["per_session"]
                          if q[f"{lbl}_idf1"] > sw[q["session"]][f"{lbl}_idf1"]),
              "n": len(sess)} for lbl in ("within", "cross")}

    out = dict(base)
    out["bmimica_50_sessions"] = bm
    out["bmimica_wins"] = wins
    out["generated_by"] = (f"figs/fig6_variant_best_rebuild.py --tag {tag} --base {base_tag}: "
                           f"Mouse-Dyad-10M block from fig8_methods_50_{tag}.json and "
                           f"fig7_fair_baselines_{tag}.json over {len(sess)} sessions; "
                           f"SLAP-2M sections copied from fig7_variant_best_{base_tag}.json")
    out["bmimica_sessions"] = sess
    # 2026-10-20 (LUC3D-JS plan J11): provenance comes from the source deposit. The base
    # file's `luc3d_is_experimental` named the fig8-bench xv_experimental.js fork, which
    # is not where these cells come from.
    out.update(provenance_fields(f8, tag, fresh["config"], ship["config"]))
    out.pop("luc3d_is_experimental", None)
    return out


#: The base file's SLAP-2M sections and their notes, copied unchanged. Placed Supp Fig 6
#: B-D read only `slap2m_fair` (panels/fig6_variant_common.py FAIR_KEY).
LEGACY_NOTE = ("`slap2m`, `slap2m_fresh_anchor`, `slap2m_pre131_reference`, "
               "`slap2m_arm_comparison`, `provenance` and `slap2m_luc3d_is_substituted` are "
               "copied unchanged from the base file. They describe LEGACY SLAP-2M arms "
               "(luc3d-bench runs and the fig8-bench xv_experimental.js fork) that no placed "
               "panel reads. Placed Supp Fig 6 B-D read `slap2m_fair` only; its `source` "
               "names its inputs.")


def provenance_fields(f8, tag, fresh_cell, ship_cell):
    if f8.get("experimental_tracker"):
        raise SystemExit(f"fig8_methods_50_{tag}.json names an experimental tracker "
                         f"({f8['experimental_tracker']}) -- not LUC3D")
    return {
        "lucid_root": f8.get("lucid_root"), "lucid_commit": f8.get("lucid_commit"),
        "driver": f8.get("driver"),
        "luc3d_source": (f"bmimica_50_sessions `LUC3D` = fig8_methods_50_{tag}.json cell "
                         f"{fresh_cell}; `LUC3D (shipped)` = cell {ship_cell}. LUC3D "
                         f"{f8.get('lucid_commit')} at {f8.get('lucid_root')}, driven by "
                         f"{f8.get('driver')}."),
        "legacy_blocks_note": LEGACY_NOTE,
    }


def check(tag):
    """Reproduction gate: the rebuilt block must equal the hand-built one where it overlaps."""
    mine = build(tag, tag)
    theirs = json.loads((OUT / f"fig7_variant_best_{tag}.json").read_text())
    bad = []

    def close(a, b):
        if isinstance(a, float) and isinstance(b, float):
            return math.isclose(a, b, rel_tol=1e-12, abs_tol=1e-15)
        return a == b
    for key in ("LUC3D", "LUC3D (shipped)"):
        for f, v in mine["bmimica_50_sessions"][key].items():
            t = theirs["bmimica_50_sessions"][key].get(f)
            if isinstance(v, dict):
                bad += [f"{key}.{f}.{k}" for k in v if not close(v[k], (t or {}).get(k))]
            elif isinstance(v, list):
                # The hand build listed `LUC3D (shipped)` in a different session order;
                # this one is session-aligned with `LUC3D`. Compare that arm as a multiset.
                if key == "LUC3D (shipped)":
                    v, t = sorted(v), sorted(t)
                if len(v) != len(t) or not all(close(x, y) for x, y in zip(v, t)):
                    bad.append(f"{key}.{f}")
            elif not close(v, t):
                bad.append(f"{key}.{f}: {v} vs {t}")
    for key in ("SLEAP per-camera", "ByteTrack", "LUC3D"):
        if mine["bmimica_wins"][key] != theirs["bmimica_wins"][key]:
            bad.append(f"wins {key}: {mine['bmimica_wins'][key]} vs {theirs['bmimica_wins'][key]}")
    print("[rebuild] CHECK", "PASSED" if not bad else "FAILED", *bad[:20], sep="\n  ")
    return 0 if not bad else 1


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--tag", required=True)
    ap.add_argument("--base", default=None, help="variant file the SLAP-2M sections come from")
    ap.add_argument("--check", action="store_true")
    a = ap.parse_args()
    if a.check:
        sys.exit(check(a.tag))
    out = build(a.tag, a.base or a.tag)
    dest = OUT / f"fig7_variant_best_{a.tag}.json"
    dest.write_text(json.dumps(out, indent=1))
    n = out["bmimica_50_sessions"]["LUC3D"]["within"]["n_sessions"]
    print(f"[rebuild] wrote {dest.name} ({n} sessions)")


if __name__ == "__main__":
    main()
