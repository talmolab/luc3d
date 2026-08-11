#!/usr/bin/env python3
"""
Downstream 3D behaviour: what the body does, in the vertical axis, around the onset
of a social investigation bout. Two corpora, measured identically.

WHY THIS IS A 3D RESULT AND NOT A TRACKING RESULT. Both quantities here are
unavailable from any single camera:
  * nose HEIGHT above the cage floor -- a top-down view gives the horizontal
    approach and none of this; a side view gives height in ITS image plane, which is
    not the cage's vertical unless the camera happens to be level and the animal
    happens to be in its plane.
  * body-axis ELEVATION (TTI -> Neck) -- a 3D angle between two 3D points.
And the bouts themselves need cross-view identity: "animal i's nose near animal j's
tail base" is only defined once i and j are the same animals in every view. So this
measures the thing the pipeline exists to produce, rather than arguing about it.

TWO EVENT TYPES, following docs/scraps/pilot_social_eda_02.ipynb: for investigator i
and target j, nose_i within THRESH_MM of nose_j (nose-to-nose) or of TTI_j
(nose-to-TTI, i.e. anogenital/tail-base investigation). Note TTI is the TAIL-TORSO
INTERFACE, which sits at trunk height, not on the floor -- which is why the naive
prediction "anogenital investigation happens lower" is wrong, and why a bout-median
height does not separate the two types at all. It flips sign across sessions.

WHAT DOES SEPARATE THEM IS TIMING, so this time-locks to bout ONSET and keeps the
trajectory. A bout median integrates exactly the structure that carries the result.

TWO METRICS PER WINDOW:
  nose_z_mm      investigator's nose height, MINUS that animal's own session-median
                 nose height. Baseline-subtracted because cages, bedding depth and
                 alignment differ between sessions and corpora, and the question is
                 what the animal does relative to its own normal posture.
  rear_deg       elevation of the investigator's TTI -> Neck vector above horizontal,
                 in degrees. 0 = body axis level, +90 = fully upright. NOT
                 baseline-subtracted: degrees above horizontal is already absolute
                 and comparable across rigs.

THE SHUFFLE CONTROL IS NOT OPTIONAL. A peri-event average will show a bump whenever
events are non-uniformly distributed in time, whatever the behaviour. Each session
also gets the same number of pseudo-bouts at uniformly random onsets, run through
the identical pipeline. If the real curve does not stand clear of the shuffled one,
there is no result -- and the panel must show both.

THE UNIT OF ANALYSIS IS THE SESSION, not the bout. Bouts within a session are
correlated (same animals, same cage, same day), so pooling them would be
pseudo-replication with a meaningless error bar. Each session contributes one median
curve; the plotted line is the across-session median and the band is the
across-session p25-p75 of those curves.

CORPORA, and they are not equally powered -- say so rather than averaging over it:
  BMimica  50 sessions x 2 mice, 150 fps, ~100-400 bouts per session.
  SLAP-2M  42 multi-animal sessions of 74, 30 fps, ~15-60 bouts per session.
BMimica is the primary because a half-second latency difference is 75 frames there
and 15 here. The SLAP-2M panel is a replication attempt on a different rig, a
different cage and a fifth of the temporal resolution.

    figs/.venv/bin/python figs/fig5_behavior.py
    figs/.venv/bin/python figs/fig5_behavior.py --limit 4   # quick pass
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

#: Node indices. Identical in both corpora -- asserted in `load_*`, not assumed.
NODES = ["Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk", "Tail_0",
         "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right", "Haunch_left",
         "Haunch_right", "Neck"]
NOSE, TTI, NECK = NODES.index("Nose"), NODES.index("TTI"), NODES.index("Neck")

THRESH_MM = 30.0      # the notebook's threshold, in mm
MIN_BOUT_S = 0.10     # seconds -- in TIME, not frames, so 150 fps and 30 fps agree
MERGE_GAP_S = 0.10    # bouts separated by less than this are one bout
WIN_S = 1.0           # peri-event window, seconds either side of onset
KINDS = ["nose-to-nose", "nose-to-TTI"]


def bouts(mask, min_len, merge_gap):
    """[(start, end_exclusive)] of True runs, gaps <= merge_gap closed first."""
    m = np.asarray(mask, bool).copy()
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


def peri_curves(tracks_mm, fps, seed=0):
    """Per-session peri-onset curves. tracks_mm: (F, A, 15, 3) mm, z = height."""
    F, A = tracks_mm.shape[0], tracks_mm.shape[1]
    if A < 2 or F < 10:
        return None
    w = int(round(WIN_S * fps))
    if w < 2 or 2 * w + 1 > F:
        return None
    min_len = int(round(MIN_BOUT_S * fps))
    gap = int(round(MERGE_GAP_S * fps))

    nose = tracks_mm[:, :, NOSE, :]
    tti = tracks_mm[:, :, TTI, :]
    neck = tracks_mm[:, :, NECK, :]

    # body-axis elevation, per animal per frame: angle of TTI->Neck above horizontal
    v = neck - tti                                        # (F, A, 3)
    horiz = np.linalg.norm(v[:, :, :2], axis=-1)
    with np.errstate(invalid="ignore", divide="ignore"):
        rear = np.degrees(np.arctan2(v[:, :, 2], horiz))  # (F, A)

    base_z = np.nanmedian(nose[:, :, 2], axis=0)          # (A,) own normal height

    d_nn = np.linalg.norm(nose[:, :, None, :] - nose[:, None, :, :], axis=-1)
    d_nt = np.linalg.norm(nose[:, :, None, :] - tti[:, None, :, :], axis=-1)

    rng = np.random.default_rng(seed)
    acc = {k: {"z": [], "rear": [], "z_shuf": [], "rear_shuf": []} for k in KINDS}
    counts = {k: 0 for k in KINDS}

    for i in range(A):
        for j in range(A):
            if i == j:
                continue
            for kind, D in (("nose-to-nose", d_nn), ("nose-to-TTI", d_nt)):
                dij = D[:, i, j]
                close = np.isfinite(dij) & (dij < THRESH_MM)
                bs = bouts(close, min_len, gap)
                onsets = [s for s, _ in bs if w <= s < F - w]
                counts[kind] += len(bs)
                if not onsets:
                    continue
                # SHUFFLE CONTROL: same count, uniformly random onsets, same pipeline.
                shuf = rng.integers(w, F - w, size=len(onsets))
                for src, zk, rk in ((onsets, "z", "rear"), (shuf, "z_shuf", "rear_shuf")):
                    for s in src:
                        zs = nose[s - w:s + w + 1, i, 2] - base_z[i]
                        rs = rear[s - w:s + w + 1, i]
                        if np.isfinite(zs).all():
                            acc[kind][zk].append(zs)
                        if np.isfinite(rs).all():
                            acc[kind][rk].append(rs)

    out = {"n_frames": int(F), "n_animals": int(A), "fps": float(fps),
           "half_window_frames": int(w)}
    for kind in KINDS:
        out[kind] = {"n_bouts": int(counts[kind])}
        for key in ("z", "rear", "z_shuf", "rear_shuf"):
            a = acc[kind][key]
            out[kind][key] = (np.nanmedian(np.asarray(a), axis=0).tolist()
                              if a else None)
            out[kind][f"n_{key}"] = len(a)
    return out


def _bmimica(sd):
    f = glob.glob(os.path.join(sd, "*points3d*.h5"))
    if not f:
        return None
    with h5py.File(f[0]) as h:
        names = [x.decode() if isinstance(x, bytes) else x for x in h["node_names"][:]]
        if list(names) != NODES:
            raise SystemExit(f"{sd}: unexpected skeleton {names}")
        # metres -> mm. The file name says `_metric`; the check is that a mouse's
        # nose lives a few centimetres off the floor, not a few hundred metres.
        t = h["tracks"][:] * 1000.0
        fps = float(h["recording_frame_rate"][()])
    span = np.nanpercentile(t[:, :, NOSE, 2], 99) - np.nanpercentile(t[:, :, NOSE, 2], 1)
    if not (1.0 < span < 500.0):
        raise SystemExit(f"{sd}: nose-height span {span:.3g} mm is not millimetres")
    r = peri_curves(t, fps)
    return None if r is None else {"session": os.path.basename(sd), **r}


def slap_fps(m):
    """session_path -> frames per second, with the gaps filled defensibly.

    TWO TRAPS HERE, both of which silently produce a noise curve rather than an error.

    (1) `duration` in the master sheet is MINUTES, not seconds: frames/duration gives
        1800 for a 30 fps recording. Getting this wrong turns a +/-1 s window into
        +/-60 s, which is exactly what the first pilot produced.
    (2) SLAP-2M IS NOT UNIFORMLY 30 fps -- the whole 2022-10-19 group is 60 -- so a
        hardcoded 30 would halve the time axis for seven of the 42 multi-animal
        sessions. The rate has to come per session.

    Six sessions have no `duration` at all. All six are 2022-10-07, whose other 16
    sessions are unanimously 30 fps, so the date group supplies the answer. That is an
    inference, so it is made explicitly, logged, and REFUSED if the group is not
    unanimous -- rather than defaulting to 30 and hoping.
    """
    fps = {}
    known = {}
    for r in m.itertuples():
        d = float(r.duration) if pd.notna(r.duration) else np.nan
        if np.isfinite(d) and d > 0:
            v = float(r.frames) / (d * 60.0)
            fps[r.session_path] = v
            known.setdefault(r.session_path.split("/")[0], set()).add(round(v, 1))
    missing = [r.session_path for r in m.itertuples()
               if r.session_path not in fps]
    for rel in missing:
        date = rel.split("/")[0]
        cand = known.get(date, set())
        if len(cand) != 1:
            raise SystemExit(
                f"{rel}: no duration, and its date group {date} has frame rates "
                f"{sorted(cand) or 'none'} -- cannot infer. Supply the rate.")
        # `next(iter(...))`, NOT `.pop()`: `cand` IS the cached set for this date, so
        # popping emptied it and the SECOND session missing a duration in the same
        # group was told its group had no known rate at all.
        fps[rel] = next(iter(cand))
        n_src = sum(1 for r in m.itertuples()
                    if r.session_path.split("/")[0] == date and pd.notna(r.duration))
        print(f"  [fps] {rel}: no duration; inferred {fps[rel]:.0f} fps, unanimous "
              f"across the {n_src} {date} sessions that have one")
    return fps


def _slap(arg):
    rel, fps = arg
    f = f"{SLAP}/{rel}/aligned_points3d.h5"
    if not os.path.exists(f):
        return None
    with h5py.File(f) as h:
        t = h["tracks"][:]
    if not (5.0 < fps < 300.0):
        raise SystemExit(f"{rel}: implausible fps {fps:.1f}")
    r = peri_curves(t, fps)
    return None if r is None else {"session": rel, **r}


def summarise(rows, corpus):
    """Across-session median and p25-p75 of the per-session curves.

    ON A COMMON TIME GRID IN SECONDS, because a corpus need not have one frame rate:
    SLAP-2M's 2022-10-19 sessions run at 60 fps and the rest at 30, so their windows
    hold 121 and 61 samples for the same +/-1 s. Averaging those element-wise would
    silently compare t = +0.5 s in one session against t = +1.0 s in another. Each
    session is interpolated onto the grid of the COARSEST rate present -- downsampling
    the fast sessions rather than inventing resolution for the slow ones.
    """
    if not rows:
        return None
    fps_all = sorted({r["fps"] for r in rows})
    fps = min(fps_all)
    w = int(round(WIN_S * fps))
    t = np.arange(-w, w + 1) / fps
    out = {"corpus": corpus, "n_sessions": len(rows), "fps": fps,
           "fps_present": fps_all, "t": t.tolist(),
           "n_bouts_total": {k: int(sum(r[k]["n_bouts"] for r in rows)) for k in KINDS}}
    for kind in KINDS:
        out[kind] = {}
        for key in ("z", "rear", "z_shuf", "rear_shuf"):
            curves = []
            for r in rows:
                c = r[kind][key]
                if c is None:
                    continue
                wr = r["half_window_frames"]
                if len(c) != 2 * wr + 1:
                    continue
                tr = np.arange(-wr, wr + 1) / r["fps"]
                curves.append(np.interp(t, tr, np.asarray(c, float)))
            if not curves:
                out[kind][key] = None
                continue
            a = np.asarray(curves, float)
            out[kind][key] = {
                "n_sessions": int(a.shape[0]),
                "p25": np.nanpercentile(a, 25, axis=0).tolist(),
                "p50": np.nanmedian(a, axis=0).tolist(),
                "p75": np.nanpercentile(a, 75, axis=0).tolist(),
            }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0, help="sessions per corpus (0=all)")
    ap.add_argument("--jobs", type=int, default=12)
    ap.add_argument("--out", type=Path, default=OUT / "fig5_behavior.json")
    args = ap.parse_args()

    bm = sorted(glob.glob(f"{BMIMICA}/*"))
    bm = [d for d in bm if os.path.isdir(d)]
    if args.limit:
        bm = bm[:args.limit]

    m = pd.read_excel(f"{SLAP}/master_sheet.xlsx")
    fps_of = slap_fps(m)
    sl = [(r.session_path, fps_of[r.session_path])
          for r in m[m["animals"] > 1].itertuples()]
    if args.limit:
        sl = sl[:args.limit]

    print(f"BMimica {len(bm)} candidate dirs, SLAP-2M {len(sl)} multi-animal sessions "
          f"(frame rates {sorted({f for _, f in sl})})")
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        bm_rows = [r for r in ex.map(_bmimica, bm) if r]
        sl_rows = [r for r in ex.map(_slap, sl) if r]

    res = {"threshold_mm": THRESH_MM, "min_bout_s": MIN_BOUT_S,
           "merge_gap_s": MERGE_GAP_S, "window_s": WIN_S,
           "note": ("Peri-onset curves for social investigation bouts. Unit of "
                    "analysis is the SESSION: each contributes one median curve and "
                    "the summary is the across-session median with p25-p75. `*_shuf` "
                    "is the same pipeline on the same number of uniformly random "
                    "onsets -- the null. nose z is baseline-subtracted per animal; "
                    "rear_deg is TTI->Neck elevation above horizontal, absolute."),
           "corpora": {}, "per_session": {}}
    for name, rows in (("BMimica", bm_rows), ("SLAP-2M", sl_rows)):
        res["corpora"][name] = summarise(rows, name)
        res["per_session"][name] = [
            {"session": r["session"], "n_animals": r["n_animals"], "fps": r["fps"],
             **{k: r[k]["n_bouts"] for k in KINDS}} for r in rows]

    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(res, indent=1))

    for name in ("BMimica", "SLAP-2M"):
        s = res["corpora"][name]
        if not s:
            continue
        print(f"\n=== {name}: {s['n_sessions']} sessions @ {s['fps']:.0f} fps ===")
        for kind in KINDS:
            b = s["n_bouts_total"][kind]
            z, zs = s[kind]["z"], s[kind]["z_shuf"]
            if not z:
                print(f"  {kind:14} {b} bouts -- no curve")
                continue
            t = np.asarray(s["t"])
            mu, sh = np.asarray(z["p50"]), np.asarray(zs["p50"]) if zs else None
            pk = int(np.argmax(mu))
            print(f"  {kind:14} {b:6d} bouts, {z['n_sessions']} sessions   "
                  f"nose z peak {mu[pk]:+5.1f} mm at {t[pk]:+.2f} s"
                  + (f"   (shuffle peak {np.max(sh):+.1f})" if sh is not None else ""))
            r = s[kind]["rear"]
            if r:
                rm = np.asarray(r["p50"])
                rp = int(np.argmax(rm))
                print(f"  {'':14} {'':6}  {'':>21}rear {rm[rp]:+5.1f} deg at {t[rp]:+.2f} s"
                      f"  (at onset {rm[len(rm) // 2]:+.1f})")
    print(f"\n[json] {args.out}")


if __name__ == "__main__":
    main()
