#!/usr/bin/env python3
"""
Rearing: the vertical behaviour, measured in 3D, on two rigs.

Rearing is the cleanest possible demonstration that the 3D matters, because it is
defined ENTIRELY in the axis a single camera cannot recover. A top-down view sees a
rearing mouse as a small blob; a side view sees height in its own image plane, which
is the cage's vertical only if the camera is level and the animal is in its plane.
Neither gives "how high, for how long, how often" in millimetres.

WHY NOT THE TTI->Neck ANGLE, which is the obvious first choice and was tried first.
It is not a rearing detector, and the two corpora disagree about what it selects:

    corr(TTI->Neck elevation, nose height)   BMimica +0.31 .. +0.72   SLAP-2M +0.59 .. +0.79
    nose height on frames with angle > 40    BMimica 26.5 mm          SLAP-2M 75-133 mm

26 mm is a mouse with its nose barely off the floor: in BMimica the angle criterion
selects a tilted body axis with the animal still down, not a rear. `TTI->Trunk` is
worse still -- SLAP-2M sits at a median 41 degrees at REST, an anatomical offset
rather than a posture. The angle is kept in the deposit as a descriptor of the bouts
this script finds, but it does not define them.

WHAT DEFINES A REAR HERE. Neck height above the cage floor, expressed in the animal's
OWN BODY LENGTHS, sustained for at least MIN_REAR_S:

    L      = median |Nose - TTI| for that animal over the session (its body length)
    rear   = neck_z > REAR_FRAC * L, held for >= MIN_REAR_S

Two normalisations, both load-bearing:
  * BY BODY LENGTH, because the corpora are not the same animals -- BMimica's median
    body length is 77-93 mm against SLAP-2M's 120-124 mm. A millimetre threshold that
    is "half a body" in one corpus is "a third of a body" in the other, and the rate
    difference that produced would be about mouse size, not behaviour.
  * NECK, not nose. The nose is the most distal node and the noisiest, and a mouse can
    point its nose up while standing on all fours. The neck rising IS the rear.
Nose height is still REPORTED (peak height reached is the interpretable number); it
just does not do the detecting.

THE THRESHOLD IS ARBITRARY AND THE DEPOSIT SAYS SO. `sensitivity` re-runs the whole
detection at a range of REAR_FRAC so a reader can see how much the rate depends on
the choice, instead of taking one number on trust.

THE SHUFFLE CONTROL, as in fig5_behavior.py: the same number of pseudo-onsets placed
uniformly at random, through the identical peri-event pipeline. A rear-triggered
average must stand clear of it.

UNIT OF ANALYSIS IS THE SESSION. Bouts within a session share animals, cage and day.
Each session contributes one value (or one median curve) and the summary is the
across-session median with p25-p75.

    figs/.venv/bin/python figs/fig5_rearing.py
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import h5py
import numpy as np
import pandas as pd

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
BMIMICA = "/root/vast/eric/BMimica"
SLAP = "/root/talmolab-smb/eric/slap_2m"

NODES = ["Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk", "Tail_0",
         "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right", "Haunch_left",
         "Haunch_right", "Neck"]
NOSE, TTI, NECK = NODES.index("Nose"), NODES.index("TTI"), NODES.index("Neck")

REAR_FRAC = 0.75          # neck height, in body lengths
MIN_REAR_S = 0.25         # seconds a rear must hold
MERGE_GAP_S = 0.15
WIN_S = 1.5               # peri-onset window
SENS_FRACS = [0.5, 0.625, 0.75, 0.875, 1.0]
#: vertical-occupancy histogram, in body lengths -- threshold-free, so it is the one
#: statement in this file that survives any disagreement about what a rear is.
OCC_EDGES = np.linspace(0.0, 2.0, 41)


def runs(mask, min_len, merge_gap):
    m = np.asarray(mask, bool)
    if not m.any():
        return []
    d = np.diff(np.concatenate(([0], m.view(np.int8), [0])))
    starts, ends = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    merged = []
    for s, e in zip(starts, ends):
        if merged and s - merged[-1][1] <= merge_gap:
            merged[-1][1] = e
        else:
            merged.append([s, e])
    return [(s, e) for s, e in merged if e - s >= max(1, min_len)]


def session_rearing(tracks_mm, fps, seed=0):
    F, A = tracks_mm.shape[0], tracks_mm.shape[1]
    nose = tracks_mm[:, :, NOSE, :]
    tti = tracks_mm[:, :, TTI, :]
    neck = tracks_mm[:, :, NECK, :]
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)      # (A,)
    if not np.all(np.isfinite(L)) or np.any(L <= 0):
        return None
    v = neck - tti
    ang = np.degrees(np.arctan2(v[:, :, 2], np.linalg.norm(v[:, :, :2], axis=-1)))

    minutes = F / fps / 60.0
    w = int(round(WIN_S * fps))
    min_len = int(round(MIN_REAR_S * fps))
    gap = int(round(MERGE_GAP_S * fps))
    rng = np.random.default_rng(seed)

    neck_bl = neck[:, :, 2] / L[None, :]        # neck height in body lengths
    nose_bl = nose[:, :, 2] / L[None, :]

    # threshold-free vertical occupancy, per animal then averaged
    occ = []
    for a in range(A):
        x = nose_bl[:, a]
        x = x[np.isfinite(x)]
        if x.size:
            occ.append(np.histogram(x, bins=OCC_EDGES, density=True)[0])
    occ = np.nanmean(np.asarray(occ), axis=0).tolist() if occ else None

    sens = {}
    for f in SENS_FRACS:
        n = sum(len(runs(neck_bl[:, a] > f, min_len, gap)) for a in range(A))
        sens[str(f)] = n / minutes / A

    durs, peaks, angs, curves, shuf_curves = [], [], [], [], []
    n_rears = 0
    for a in range(A):
        rr = runs(neck_bl[:, a] > REAR_FRAC, min_len, gap)
        n_rears += len(rr)
        for s, e in rr:
            durs.append((e - s) / fps)
            peaks.append(float(np.nanmax(nose[s:e, a, 2])))
            angs.append(float(np.nanmax(ang[s:e, a])))
            if w <= s < F - w:
                seg = nose_bl[s - w:s + w + 1, a]
                if np.isfinite(seg).all():
                    curves.append(seg)
        for s in rng.integers(w, max(w + 1, F - w), size=len(rr)):
            seg = nose_bl[s - w:s + w + 1, a]
            if np.isfinite(seg).all():
                shuf_curves.append(seg)

    return {
        "n_frames": int(F), "n_animals": int(A), "fps": float(fps),
        "minutes": minutes, "half_window_frames": int(w),
        "body_length_mm": float(np.nanmedian(L)),
        "n_rears": int(n_rears),
        "rate_per_min_per_animal": n_rears / minutes / A,
        "duration_s_median": float(np.median(durs)) if durs else None,
        "peak_nose_mm_median": float(np.median(peaks)) if peaks else None,
        "peak_angle_deg_median": float(np.median(angs)) if angs else None,
        "occupancy": occ,
        "sensitivity": sens,
        "peri": np.nanmedian(np.asarray(curves), axis=0).tolist() if curves else None,
        "peri_shuf": (np.nanmedian(np.asarray(shuf_curves), axis=0).tolist()
                      if shuf_curves else None),
        "n_peri": len(curves),
    }


def _bmimica(sd):
    f = glob.glob(os.path.join(sd, "*points3d*.h5"))
    if not f:
        return None
    with h5py.File(f[0]) as h:
        names = [x.decode() if isinstance(x, bytes) else x for x in h["node_names"][:]]
        if list(names) != NODES:
            raise SystemExit(f"{sd}: unexpected skeleton")
        t = h["tracks"][:] * 1000.0
        fps = float(h["recording_frame_rate"][()])
    r = session_rearing(t, fps)
    return None if r is None else {"session": os.path.basename(sd), **r}


def _slap(arg):
    rel, fps = arg
    f = f"{SLAP}/{rel}/aligned_points3d.h5"
    if not os.path.exists(f):
        return None
    with h5py.File(f) as h:
        t = h["tracks"][:]
    r = session_rearing(t, fps)
    return None if r is None else {"session": rel, **r}


def slap_fps(m):
    """See fig5_behavior.slap_fps -- `duration` is MINUTES and the corpus is not all
    30 fps. Kept as its own copy so this script stands alone."""
    fps, known = {}, {}
    for r in m.itertuples():
        d = float(r.duration) if pd.notna(r.duration) else np.nan
        if np.isfinite(d) and d > 0:
            v = float(r.frames) / (d * 60.0)
            fps[r.session_path] = v
            known.setdefault(r.session_path.split("/")[0], set()).add(round(v, 1))
    for r in m.itertuples():
        if r.session_path in fps:
            continue
        cand = known.get(r.session_path.split("/")[0], set())
        if len(cand) != 1:
            raise SystemExit(f"{r.session_path}: cannot infer fps from {sorted(cand)}")
        fps[r.session_path] = next(iter(cand))
    return fps


def summarise(rows, corpus):
    if not rows:
        return None
    fps = min(r["fps"] for r in rows)
    w = int(round(WIN_S * fps))
    t = np.arange(-w, w + 1) / fps
    out = {"corpus": corpus, "n_sessions": len(rows), "fps_min": fps,
           "fps_present": sorted({round(r["fps"], 1) for r in rows}),
           "t": t.tolist(),
           "n_rears_total": int(sum(r["n_rears"] for r in rows)),
           "body_length_mm": float(np.median([r["body_length_mm"] for r in rows]))}
    for key in ("rate_per_min_per_animal", "duration_s_median", "peak_nose_mm_median",
                "peak_angle_deg_median"):
        v = [r[key] for r in rows if r[key] is not None]
        out[key] = {"p25": float(np.percentile(v, 25)), "p50": float(np.median(v)),
                    "p75": float(np.percentile(v, 75)), "n": len(v)} if v else None
    occ = [r["occupancy"] for r in rows if r["occupancy"]]
    if occ:
        a = np.asarray(occ)
        out["occupancy"] = {"edges": OCC_EDGES.tolist(),
                            "p25": np.percentile(a, 25, axis=0).tolist(),
                            "p50": np.median(a, axis=0).tolist(),
                            "p75": np.percentile(a, 75, axis=0).tolist()}
    out["sensitivity"] = {
        str(f): float(np.median([r["sensitivity"][str(f)] for r in rows]))
        for f in SENS_FRACS}
    for key, name in (("peri", "peri"), ("peri_shuf", "peri_shuf")):
        cur = []
        for r in rows:
            c = r[key]
            if c is None:
                continue
            wr = r["half_window_frames"]
            if len(c) != 2 * wr + 1:
                continue
            # common time grid in seconds -- the corpora and even sessions within
            # SLAP-2M differ in frame rate (30 vs 60).
            cur.append(np.interp(t, np.arange(-wr, wr + 1) / r["fps"],
                                 np.asarray(c, float)))
        if cur:
            a = np.asarray(cur)
            out[name] = {"n_sessions": int(a.shape[0]),
                         "p25": np.percentile(a, 25, axis=0).tolist(),
                         "p50": np.median(a, axis=0).tolist(),
                         "p75": np.percentile(a, 75, axis=0).tolist()}
        else:
            out[name] = None
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=12)
    ap.add_argument("--out", type=Path, default=OUT / "fig5_rearing.json")
    args = ap.parse_args()

    bm = [d for d in sorted(glob.glob(f"{BMIMICA}/*")) if os.path.isdir(d)]
    m = pd.read_excel(f"{SLAP}/master_sheet.xlsx")
    fps_of = slap_fps(m)
    # ALL sessions, not just multi-animal: rearing is a solo behaviour and a
    # one-animal session is a perfectly good sample of it. (fig5_behavior.py needs
    # two animals because its events are social; this does not.)
    sl = [(r.session_path, fps_of[r.session_path]) for r in m.itertuples()]
    if args.limit:
        bm, sl = bm[:args.limit], sl[:args.limit]
    print(f"BMimica {len(bm)} dirs, SLAP-2M {len(sl)} sessions")

    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        bm_rows = [r for r in ex.map(_bmimica, bm) if r]
        sl_rows = [r for r in ex.map(_slap, sl) if r]

    res = {"rear_frac_body_lengths": REAR_FRAC, "min_rear_s": MIN_REAR_S,
           "merge_gap_s": MERGE_GAP_S, "window_s": WIN_S,
           "detector": ("neck height > REAR_FRAC x the animal's own body length "
                        "(median |Nose-TTI|), held for min_rear_s. NOT the TTI->Neck "
                        "angle: see the module docstring for why that fails."),
           "corpora": {}, "per_session": {}}
    for name, rows in (("BMimica", bm_rows), ("SLAP-2M", sl_rows)):
        res["corpora"][name] = summarise(rows, name)
        res["per_session"][name] = [
            {k: r[k] for k in ("session", "n_animals", "fps", "minutes",
                               "body_length_mm", "n_rears",
                               "rate_per_min_per_animal", "duration_s_median",
                               "peak_nose_mm_median", "peak_angle_deg_median")}
            for r in rows]
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(res, indent=1))

    for name in ("BMimica", "SLAP-2M"):
        s = res["corpora"][name]
        if not s:
            continue
        print(f"\n=== {name}: {s['n_sessions']} sessions, body length "
              f"{s['body_length_mm']:.0f} mm, {s['n_rears_total']:,} rears ===")
        for k, unit in (("rate_per_min_per_animal", "/min/animal"),
                        ("duration_s_median", "s"),
                        ("peak_nose_mm_median", "mm"),
                        ("peak_angle_deg_median", "deg")):
            v = s[k]
            if v:
                print(f"  {k:26} {v['p50']:7.2f} {unit:12} "
                      f"(p25-p75 {v['p25']:.2f}-{v['p75']:.2f}, n={v['n']})")
        print("  rate vs threshold (body lengths): " + "  ".join(
            f"{f}:{s['sensitivity'][str(f)]:.2f}" for f in SENS_FRACS))
        if s["peri"]:
            t = np.asarray(s["t"])
            mu = np.asarray(s["peri"]["p50"])
            sh = np.asarray(s["peri_shuf"]["p50"]) if s["peri_shuf"] else None
            k = int(np.argmax(mu))
            print(f"  peri-onset nose height peaks {mu[k]:.2f} body lengths at "
                  f"{t[k]:+.2f} s" + (f" (shuffle max {np.max(sh):.2f})"
                                      if sh is not None else ""))
    print(f"\n[json] {args.out}")


if __name__ == "__main__":
    main()
