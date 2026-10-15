#!/usr/bin/env python3
"""Gate for the md56 b-figures: every Mouse-Dyad-10M deposit must exist as `_md56` AND cover
all 56 sessions. Exits non-zero, naming each failure, so the b build never starts on a
partial corpus. (2026-10-14)

    python3 figs/md56_check.py
"""
import json
import sys
from pathlib import Path

OUT = Path(__file__).resolve().parent / "out"
N = 56
T = "distanceThreshold25-stale20-sync_e508a7ab"

#: deposit -> function returning the Mouse-Dyad-10M session count it covers
def _sessions(d):
    return len(d["sessions"])


def _hh(d):    # head-to-head / quality: the BMimica config's session list
    c = next(c for c in d["configs"] if c["key"] == "A2_C5_bmimica")
    return len(c.get("sessions") or []) or c.get("n_sessions")


CHECKS = {
    "fig4_md56.json": lambda d: d["n_sessions"],
    "fig4_by_views_md56.json": lambda d: d["sessions"],
    "fig4_robust_sessions_md56.json": lambda d: len(d.get("per_session") or d.get("sessions") or []),
    "fig4_anipose_md56.json": lambda d: d["input"]["n_sessions"],
    "fig2g_retime_all_md56.json": None,           # timing only: checked for presence
    "fig3_headtohead_md56.json": _hh,
    "fig3_quality_md56.json": _hh,
    f"fig3_quality__{T}_md56.json": _hh,
    f"fig3_headtohead__{T}_md56.json": _hh,
    "fig3_sweep50_md56.json": _sessions,
    f"fig3_sweep50__{T}_md56.json": _sessions,
    "fig3_exhaustive_bmimica_md56.json": lambda d: len(d.get("per_session") or d.get("sessions") or []) or d.get("n_sessions"),
    "fig3_frame_matched_bmimica_md56.json": lambda d: d.get("n_sessions") or len(d.get("per_session") or []),
    "fig3_runtime_md56.json": None,
    "fig8_methods_50_md56.json": _sessions,
    "fig2_cams_identity_md56.json": lambda d: len({r["session"] for r in d["per_run"]}),
    "fig7_sleap_max2_md56.json": lambda d: len(d["per_session"]),
    "fig7_bytetrack_max2_md56.json": lambda d: len(d["per_session"]),
    "fig7_fair_baselines_md56.json": _sessions,
    "fig7_variant_best_md56.json": lambda d: d["bmimica_50_sessions"]["LUC3D"]["within"]["n_sessions"],
}
#: SLAP-2M deposits re-run on origin/main (checked for their own session count, 74).
SLAP = {"fig9_slap2m_lite_bvis5_notailscore_md56.json": lambda d: len(next(c for c in d["cells"] if c["config"] == "sync_stale20_dist25")["per_session"])}
N_SLAP = 74


def main():
    bad = []
    for name, f in CHECKS.items():
        p = OUT / name
        if not p.exists():
            bad.append(f"MISSING  {name}")
            continue
        if f is None:
            print(f"ok       {name} (present)")
            continue
        try:
            n = f(json.loads(p.read_text()))
        except Exception as e:  # noqa: BLE001
            bad.append(f"UNREADABLE {name}: {type(e).__name__}: {e}")
            continue
        (print if n == N else lambda m: bad.append(m))(
            f"{'ok' if n == N else 'WRONG N'}  {name}: {n} sessions")
    for name, f in SLAP.items():
        p = OUT / name
        if not p.exists():
            bad.append(f"MISSING  {name}"); continue
        n = f(json.loads(p.read_text()))
        (print if n == N_SLAP else lambda m: bad.append(m))(f"{'ok' if n == N_SLAP else 'WRONG N'}  {name}: {n} SLAP-2M sessions")
    if bad:
        print("\nmd56 GATE FAILED -- do not build:", *bad, sep="\n  ")
        return 1
    print(f"\nmd56 GATE PASSED: every Mouse-Dyad-10M deposit covers {N} sessions")
    return 0


if __name__ == "__main__":
    sys.exit(main())
