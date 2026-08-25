#!/usr/bin/env python3
"""
Does the social-rearing leader/follower effect REPLICATE outside Mouse-Dyad-10M?

Figure 5 established, on Mouse-Dyad-10M (novel pairs), that one animal's rear onset
predicts the other's at 4.05x chance when the two are within two body lengths, that
the effect is absent when they are far apart, and that each session has a consistent
initiator. This script re-runs that measurement on two further corpora and reports
whether the same numbers come back:

  * SLAP-2M, restricted to its 35 two-animal sessions -- FAMILIAR cagemates, which is
    the comparison of interest. If proximity-gated rear coupling is about social
    novelty, it should be weaker or absent here.
  * s-DANNCE SCN2A dyads (SOC1 + SOC3, 29 sessions of rats) -- a different species,
    rig and lab, as an out-of-family check on whether the effect is a property of
    mouse dyads or of this measurement.

THE DETECTORS ARE IMPORTED, NOT REIMPLEMENTED. `session_coupling` comes from
`fig5_rear_coupling.py` and `session_upright` from `fig5_upright.py`, so every corpus
goes through byte-identical event detection, the same circular-shift null and the same
per-session aggregation as the shipped Fig 5. A corpus adapts to the detector by
placing its own three relevant nodes into the canonical 15-slot skeleton's Nose / TTI
/ Neck positions (`_canonical`); the detectors read no other node, which is asserted
at import time rather than assumed.

WHAT IS AND IS NOT CONTROLLED. The corpora differ in more than familiarity -- arena
size (SLAP-2M is 3.2 body lengths across, Mouse-Dyad-10M 6.9), frame rate (30 vs 150
vs 50 Hz), session length (10 vs 20 vs 30 min), strain, and rig. A negative result
here therefore says the effect does not reproduce under SLAP-2M's conditions; it does
NOT isolate familiarity as the cause. Two of those confounds are addressed directly:

  * ARENA SIZE, by the self-normalising `near_q`/`far_q` tertile split that
    `fig5_rear_coupling.py` already computes -- "closer than this pair usually is"
    rather than a fixed body-length cut.
  * FRAME RATE, by `summarise`, which resamples every session's curve onto a common
    lag axis at the corpus's own minimum fps before taking the median.

Session length and strain are not controlled and are reported, not adjusted.

    figs/.venv/bin/python figs/fig12_social.py --corpus slap-2m --corpus mouse-dyad-10m
    figs/.venv/bin/python figs/fig12_social.py --corpus scn2a
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import re
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import h5py
import numpy as np
import pandas as pd
import scipy.io as sio

import fig5_rear_coupling as RC
import fig5_upright as UP

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"

BMIMICA = "/root/vast/eric/BMimica"
SLAP = "/root/talmolab-smb/eric/slap_2m"
SDANNCE = "/root/vast/eric/s-DANNCE-data"
LONGEVANS = f"{SDANNCE}/s-DANNCE-LONG-EVANS"

# The canonical 15-node skeleton both fig5 detectors index into.
NODES = RC.NODES
N_CANON = len(NODES)
# Guard the whole adapter strategy: if either detector ever starts reading a fourth
# node, the NaN-padded corpora would silently produce garbage instead of failing.
assert (RC.NOSE, RC.TTI, RC.NECK) == (UP.NOSE, UP.TTI, UP.NECK), \
    "the two fig5 detectors disagree on node indices"
NOSE, TTI, NECK = RC.NOSE, RC.TTI, RC.NECK

#: s-DANNCE 23-node rat skeleton -> the three nodes the detectors read. Array order is
#: verified against the deposit's own Label3D files in `fig10-bench/fig10_tiles.py`:
#: 0 Snout, 3 SpineF, 6 TailBase. SpineF is the neck analogue (the most anterior spine
#: joint, as Neck is in the mouse skeleton) and Snout-TailBase is the body-length
#: segment, matching Nose-TTI.
RAT23 = {"nose": 0, "neck": 3, "tti": 6}

#: An ANIMAL must appear in this many resolvable displays, pooled over its partners,
#: before `_per_animal` reports a lead rate for it. Without it a mouse seen in a single
#: display scores 0.000 or 1.000 and reads as the most extreme leader in the corpus
#: (animal 177397, n = 1, 2026-08-20).
MIN_DISPLAYS_PER_ANIMAL = 10

#: A session must yield this many mutual-upright displays before its initiator bias is
#: summarised. `initiator_bias` is max(count)/total over a session's displays, which is
#: bounded BELOW by 0.5 and rises as the count falls -- a session with two displays
#: scores >= 0.5 and often 1.0 by arithmetic, not by having a leader. Without this gate
#: a corpus with few events per session reports a spuriously high mean bias. The same
#: reasoning as MIN_ONSETS in fig5_rear_coupling.py.
MIN_EVENTS_FOR_BIAS = 8


def _canonical(xyz, mapping):
    """(F, A, n, 3) in a foreign skeleton -> (F, A, 15, 3) the detectors can read.

    Unmapped slots are NaN rather than zero: zero is a legal coordinate and would put
    a phantom keypoint on the floor, while NaN propagates into the nanmedian body
    length and would surface as a dropped session.
    """
    F, A = xyz.shape[0], xyz.shape[1]
    out = np.full((F, A, N_CANON, 3), np.nan, dtype=float)
    out[:, :, NOSE, :] = xyz[:, :, mapping["nose"], :]
    out[:, :, TTI, :] = xyz[:, :, mapping["tti"], :]
    out[:, :, NECK, :] = xyz[:, :, mapping["neck"], :]
    return out


# --------------------------------------------------------------------------- loaders
# Each returns (tracks_mm, fps, track_names, experimental_code) or None, in the
# canonical layout, millimetres, floor at z = 0.

def _load_bmimica(sd):
    return UP._load(sd)


def _load_slap(arg):
    rel, fps = arg
    f = f"{SLAP}/{rel}/aligned_points3d.h5"
    if not os.path.exists(f):
        return None
    with h5py.File(f) as h:
        t = h["tracks"][:]          # (F, A, 15, 3), already mm and floor-aligned
    if t.ndim != 4 or t.shape[2] != N_CANON:
        return None
    # SLAP-2M deposits no per-animal identity (the master sheet counts coats, it does
    # not name individuals), so the two tracks are anonymous WITHIN a session. The
    # within-session initiator bias is still well defined; the cross-session question
    # -- whether a given animal keeps the leader role against a new partner -- is not
    # answerable for this corpus and must not be reported for it.
    return t, fps, ["anon0", "anon1"], ""


def _scn2a_ids(sd):
    """Session dir `2022_09_22_M3_M4` -> ("M3", "M4"), matching rat1/rat2 file order.

    VALIDATED, not assumed. Body length is a stable individual trait, so if this mapping
    is right each animal's measured Snout-TailBase should be consistent across its ~10
    sessions. Under dirname order the between-animal / within-animal sd ratio is 1.697;
    over 4,000 random per-session slot swaps that statistic never exceeded 1.368
    (median 0.448, p < 0.00025). No arbitrary assignment recovers stable individuals, so
    the order is real. This is what makes the per-animal analysis possible at all --
    SOC1 and SOC3 are a REPLICATED ROUND-ROBIN over six animals (all 15 pairs, 14 of them
    twice, ~2 weeks apart), so leadership can be asked of the ANIMAL rather than only of
    the session.
    """
    ids = re.findall(r"M(\d)", os.path.basename(sd))
    return (f"M{ids[0]}", f"M{ids[1]}") if len(ids) == 2 else ("rat1", "rat2")


def _load_scn2a(sd):
    per_rat = sorted(glob.glob(os.path.join(sd, "SDANNCE", "*rat*", "save_data_AVG.mat")))
    if len(per_rat) != 2:
        return None
    preds = []
    for p in per_rat:
        pr = sio.loadmat(p)["pred"]            # (F, 3, 23), mm, z up, floor ~ 0
        if pr.ndim != 3 or pr.shape[1] != 3:
            return None
        preds.append(pr)
    F = min(p.shape[0] for p in preds)
    xyz = np.stack([p[:F] for p in preds], axis=1).transpose(0, 1, 3, 2)  # (F,A,23,3)
    # 50 Hz: the deposit's metadata.csv gives recTimeInSec 1800 for 90,000 nominal
    # frames. Recorded as a constant because no per-session frame-rate field exists.
    return (_canonical(xyz, RAT23), 50.0, list(_scn2a_ids(sd)),
            os.path.basename(sd))


def _longevans_social():
    """The Long-Evans amphetamine cohort -> [(arm, key, file, dosed_first)].

    THE DEPOSIT STORES EACH RECORDING FOUR TIMES and a naive glob quadruple-counts it.
    Per (date, unordered pair) there are: one file per DIRECTION (focal = A, focal = B,
    each carrying both animals in `m1`/`m2`), and a `-1` twin of each. The twins are
    EXACT duplicates -- `m1` and `m2` bit-identical, same metadata -- so they are dropped,
    and only one direction per recording is read. 180 social files are 45 recordings.

    `isamph` CODING, established two independent ways because the deposit README
    documents `ratgen` but not `isamph`:
      * The paper (Klibaite et al. 2025, STAR Methods "Pharmacology recordings"): rats
        were "injected with 1.25mg/kg amphetamine" and "never dosed with amphetamine or
        paired with an amphetamine partner in consecutive" sessions -- i.e. a dosed
        animal is paired with an UNDOSED partner, and the control condition is "neither
        animal had received amphetamine".
      * Locomotion: code 1 runs 1.51x faster than control animals (Mann-Whitney
        p = 7e-13) while code 2 is indistinguishable from control (0.96x, p = 0.32).
        Hyperlocomotion in exactly one member of each pair is amphetamine's signature.
    So 1 = dosed, 2 = the undosed partner of a dosed animal, 0 = neither dosed.

    For the amphetamine arm the direction whose FOCAL animal is the dosed one is chosen,
    so slot 0 is always the dosed rat and "does the drug make you initiate?" is a
    question about a fixed slot rather than a per-session lookup.
    """
    groups = {}
    for f in sorted(glob.glob(f"{LONGEVANS}/*.mat")):
        b = os.path.basename(f)
        if b.endswith("-1.mat"):          # exact duplicate of its twin
            continue
        try:
            sd = sio.loadmat(f, squeeze_me=True, struct_as_record=False)["sdannce"]
        except Exception:
            continue
        if int(getattr(sd, "issoc", 0)) != 1:
            continue
        m2 = getattr(sd, "m2", None)
        if m2 is None or np.ndim(m2) != 3:
            continue
        ia, ip = int(sd.isamph), int(sd.isamphP)
        a, bb = str(sd.ratid), str(sd.ratp_id)
        gk = (str(sd.ratdate), tuple(sorted((a, bb))))
        arm = "le-amph" if (ia, ip) in ((1, 2), (2, 1)) else (
            "le-control" if (ia, ip) == (0, 0) else None)
        if arm is None:
            continue
        # Amph arm: keep the direction where the FOCAL animal is the dosed one (ia == 1).
        # Control arm: either direction will do, so keep the first seen.
        keep = (ia == 1) if arm == "le-amph" else (gk not in groups)
        if keep or gk not in groups:
            groups[gk] = (arm, f"{gk[0]}_{gk[1][0]}_{gk[1][1]}", f, a, bb, ia)
    return list(groups.values())


def _load_longevans(arg):
    f, a, b, ia = arg
    sd = sio.loadmat(f, squeeze_me=True, struct_as_record=False)["sdannce"]
    m1, m2 = np.asarray(sd.m1, float), np.asarray(sd.m2, float)
    F = min(m1.shape[0], m2.shape[0])
    xyz = np.stack([m1[:F], m2[:F]], axis=1).transpose(0, 1, 3, 2)   # (F, 2, 23, 3)
    # Names carry BOTH the animal and its condition (no underscore, so
    # `session_upright`'s `split("_")[0]` keeps the whole label): the per-animal
    # aggregation can then ask whether the DOSED slot initiates more often.
    names = ([f"{a}|amph", f"{b}|partner"] if ia == 1
             else [f"{a}|ctrl", f"{b}|ctrl"])
    return _canonical(xyz, RAT23), 50.0, names, os.path.basename(f)


def _one(job):
    """Run BOTH fig5 detectors on one session. Returns (coupling_row, upright_row)."""
    corpus, key, arg = job
    ld = {"mouse-dyad-10m": _load_bmimica, "slap-2m": _load_slap,
          "scn2a": _load_scn2a, "scn2a-r1": _load_scn2a,
          "scn2a-r3": _load_scn2a, "le-control": _load_longevans,
          "le-amph": _load_longevans}[corpus](arg)
    if ld is None:
        return None
    t, fps, names, code = ld
    if t.shape[1] != 2:
        return None
    cp = RC.session_coupling(t, fps)
    up = UP.session_upright(t, fps, names, code, key)
    return ({"session": key, **cp} if cp else None,
            up if up else None)


# ------------------------------------------------------------------------ enumeration

def _sessions(corpus, limit=0):
    if corpus == "mouse-dyad-10m":
        # `BMimica/scratch/` is an independent third-party DLT re-triangulation, not a
        # session (DATA-LOCATIONS.md). It carries no `*points3d*.h5`, so it loads as
        # None and cannot affect a measurement -- but it WOULD count as one more
        # zero-event session in the rate denominator below, so it is excluded here.
        js = [(corpus, os.path.basename(d), d)
              for d in sorted(glob.glob(f"{BMIMICA}/*"))
              if os.path.isdir(d) and os.path.basename(d) != "scratch"]
    elif corpus == "slap-2m":
        m = pd.read_excel(f"{SLAP}/master_sheet.xlsx")
        fps_of = RC.slap_fps(m)
        # EXACTLY TWO ANIMALS, to match Mouse-Dyad-10M. fig5_rear_coupling.py's own
        # note applies: with more animals a pair's interaction is a smaller share of
        # what the pairwise measurement sees, so the corpora are only like-for-like
        # at two.
        js = [(corpus, r.session_path, (r.session_path, fps_of[r.session_path]))
              for r in m[m["animals"] == 2].itertuples()]
    elif corpus in ("scn2a", "scn2a-r1", "scn2a-r3"):
        # SOC1 and SOC3 are ROUNDS 1 and 3 of one round-robin over the same six rats
        # (README: "6 rats, round-robin meeting round N"), ~2 weeks apart, so splitting
        # them is a WITHIN-CORPUS familiarity contrast: same animals, same pairings, same
        # rig, same 50 Hz. Every confound that muddies the SLAP-2M comparison (arena,
        # frame rate, strain, lab) is held fixed here. Round 2 is unavailable -- the SOC2
        # dataset publishes zero files upstream -- so this is meeting 1 vs meeting 3.
        want = {"scn2a-r1": "SOC1", "scn2a-r3": "SOC3"}.get(corpus)
        js = []
        for soc in sorted(glob.glob(f"{SDANNCE}/s-DANNCE-SCN2A_SOC*")):
            if want and not soc.endswith(want):
                continue
            for d in sorted(glob.glob(f"{soc}/*")):
                if os.path.isdir(d) and glob.glob(f"{d}/SDANNCE/*rat*/save_data_AVG.mat"):
                    js.append((corpus, f"{os.path.basename(soc)}/{os.path.basename(d)}", d))
    elif corpus in ("le-control", "le-amph"):
        js = [(corpus, key, (f, a, b, ia))
              for arm, key, f, a, b, ia in _longevans_social() if arm == corpus]
    else:
        raise SystemExit(f"unknown corpus {corpus}")
    return js[:limit] if limit else js


# ------------------------------------------------------------------------- leader agg

def leader_summary(rows, corpus, n_enumerated):
    """Per-corpus mutual-upright and initiator statistics.

    `session_upright` returns None for a session with no mutual-upright display, so
    `rows` covers only the sessions that HAVE the behaviour. `n_enumerated` is how many
    were attempted, and the rate statistics below are reported over that full
    denominator with the empty sessions entered as zeros. Reporting them over `rows`
    alone conditions the rate on the behaviour having occurred, which flatters whichever
    corpus is emptiest -- 34% of Mouse-Dyad-10M sessions contain no display at all
    against 3% of SLAP-2M's, so that conditioning is not a rounding detail.
    """
    if not rows:
        return None
    minutes = float(sum(r["minutes"] for r in rows))
    rates_all = [r["rate_per_min"] for r in rows] + [0.0] * (n_enumerated - len(rows))
    ev = [e for r in rows for e in r["events"]]
    lags = [e["lag_s"] for e in ev if e["lag_s"] is not None]
    # Only sessions with enough displays to estimate a bias (see MIN_EVENTS_FOR_BIAS).
    gated = [r for r in rows if r["n_initiator_known"] >= MIN_EVENTS_FOR_BIAS
             and r["initiator_bias"] is not None]
    bias = [r["initiator_bias"] for r in gated]

    def q(v, p):
        return float(np.percentile(v, p)) if len(v) else float("nan")

    return {
        "corpus": corpus,
        "n_sessions_enumerated": n_enumerated,
        "n_sessions": len(rows),
        "n_sessions_with_events": sum(1 for r in rows if r["n_events"] > 0),
        "n_sessions_no_events": n_enumerated - len(rows),
        "observation_minutes": minutes,
        "n_events": len(ev),
        "events_per_session_p50": q([r["n_events"] for r in rows], 50),
        # THE RATE, not the raw count: the corpora differ ~3x in total observation
        # time, so counts are not comparable and rates are. Over ALL enumerated
        # sessions (empty ones = 0); the `_nonzero` twin is the conditional version.
        "rate_per_min_p50": q(rates_all, 50),
        "rate_per_min_p25": q(rates_all, 25),
        "rate_per_min_p75": q(rates_all, 75),
        "rate_per_min_mean": float(np.mean(rates_all)),
        "rate_per_min_p50_nonzero": q([r["rate_per_min"] for r in rows], 50),
        "body_length_mm_p50": q([r["body_length_mm"] for r in rows], 50),
        "dur_s_p50": q([e["dur_s"] for e in ev], 50) if ev else float("nan"),
        "min_nose_gap_p50": q([e["min_nose_gap"] for e in ev], 50) if ev else float("nan"),
        "initiator_lag_s_p50": q(lags, 50),
        "initiator_lag_s_p25": q(lags, 25),
        "initiator_lag_s_p75": q(lags, 75),
        "n_lag_known": len(lags),
        "min_events_for_bias": MIN_EVENTS_FOR_BIAS,
        "n_sessions_bias_gated": len(gated),
        "n_sessions_bias_dropped": len(rows) - len(gated),
        "initiator_bias_p50": q(bias, 50),
        "initiator_bias_p25": q(bias, 25),
        "initiator_bias_p75": q(bias, 75),
        "per_session": [{k: r[k] for k in ("session", "n_events", "rate_per_min",
                                           "minutes", "body_length_mm",
                                           "initiator_bias", "n_initiator_known")}
                        for r in rows],
        "per_animal": _per_animal(rows),
    }


def _per_animal(rows):
    """Leadership as a property of the ANIMAL, pooled over its partners.

    Only meaningful where individuals are identifiable AND re-paired: that is the
    s-DANNCE SCN2A round-robin alone. Mouse-Dyad-10M names its animals but the pairings
    are not a round-robin, and SLAP-2M's tracks are anonymous within a session
    (`_load_slap`), which is why this returns None rather than a table of "anon0".

    The denominator is every display in that animal's sessions whose initiator was
    resolvable, so `lead_rate` is the share of displays THIS animal started across all
    its partners. 0.5 is the null, and unlike `initiator_bias` this statistic has no
    floor -- it can fall below 0.5, so a consistent FOLLOWER is visible too.
    """
    agg = {}
    for r in rows:
        n = r["n_initiator_known"]
        if not n:
            continue
        for pt in r["per_track"]:
            a = pt["animal"]
            if a.startswith("anon"):
                return None
            d = agg.setdefault(a, {"animal": a, "n_lead": 0, "n_displays": 0,
                                   "n_sessions": 0, "partners": [], "L_mm": []})
            d["n_lead"] += int(pt["n_lead"])
            d["n_displays"] += int(n)
            d["n_sessions"] += 1
            d["L_mm"].append(pt["L_mm"])
            d["partners"] += [q["animal"] for q in r["per_track"]
                              if q["animal"] != a]
    if len(agg) < 3:
        return None
    out = []
    for d in agg.values():
        if d["n_displays"] < MIN_DISPLAYS_PER_ANIMAL:
            continue
        out.append({"animal": d["animal"], "n_sessions": d["n_sessions"],
                    "n_partners": len(set(d["partners"])),
                    "n_lead": d["n_lead"], "n_displays": d["n_displays"],
                    "lead_rate": d["n_lead"] / d["n_displays"] if d["n_displays"] else None,
                    "body_length_mm": float(np.mean(d["L_mm"]))})
    return sorted(out, key=lambda x: x["animal"])


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--corpus", action="append", default=None,
                    choices=["mouse-dyad-10m", "slap-2m", "scn2a",
                             "scn2a-r1", "scn2a-r3", "le-control", "le-amph"],
                    help="repeatable; default is SLAP-2M plus its reference arm")
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=12)
    ap.add_argument("--out", type=Path, default=OUT / "fig12_social.json")
    args = ap.parse_args()
    corpora = args.corpus or ["slap-2m", "mouse-dyad-10m"]

    res = {"rear_frac_body_lengths": RC.REAR_FRAC, "min_rear_s": RC.MIN_REAR_S,
           "lag_s": RC.LAG_S, "n_shifts": RC.N_SHIFTS, "near_bl": RC.NEAR_BL,
           "min_onsets": RC.MIN_ONSETS, "min_events_for_bias": MIN_EVENTS_FOR_BIAS,
           "min_displays_per_animal": MIN_DISPLAYS_PER_ANIMAL,
           "nodes": NODES, "coupling": {}, "leader": {}}

    for corpus in corpora:
        jobs = _sessions(corpus, args.limit)
        print(f"{corpus}: {len(jobs)} sessions", flush=True)
        with ProcessPoolExecutor(max_workers=args.jobs) as ex:
            got = [r for r in ex.map(_one, jobs) if r]
        cp = [c for c, _ in got if c]
        up = [u for _, u in got if u]
        print(f"  {len(cp)} coupling rows, {len(up)} upright rows", flush=True)
        res["coupling"][corpus] = RC.summarise(cp, corpus)
        # Denominator = sessions the detectors could actually see (`cp`), not
        # directories globbed (`jobs`): a directory that fails to load is not a session
        # with zero displays, and entering it as a zero would depress the rate.
        res["leader"][corpus] = leader_summary(up, corpus, len(cp))

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(res))
    print(f"wrote {args.out}")


if __name__ == "__main__":
    main()
