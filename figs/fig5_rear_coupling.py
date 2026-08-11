#!/usr/bin/env python3
"""
Is one animal's rearing related to the other's?

THE MEASUREMENT. Detect rears exactly as `fig5_rearing.py` does (neck height above
REAR_FRAC of that animal's own body length, held for MIN_REAR_S). Then, for every
ordered pair of animals (i, j), take animal i's rear ONSETS and read out the
probability that animal j is rearing at each lag around them:

    P(j rearing | i starts a rear at t=0)   for lag in [-LAG_S, +LAG_S]

Divide by j's own base rate P(j rearing) and the curve becomes an ENRICHMENT: 1.0 is
"no relationship", 2.0 is "twice as likely as chance".

THE NULL IS A CIRCULAR SHIFT, NOT A RESHUFFLE, and the difference decides the result.
Rears are long (about a second) and clustered, so an animal's rear series has strong
autocorrelation. Scattering onsets uniformly at random destroys that structure and
produces a null that is far too flat -- against it, almost anything looks
significant. Rotating animal j's series by a random offset preserves its rate, its
bout durations and its autocorrelation exactly, and destroys ONLY the temporal
relationship to animal i. That is the hypothesis under test, so that is the only
thing the null may destroy.

THE PROXIMITY SPLIT IS WHAT MAKES IT A SOCIAL CLAIM RATHER THAN A CORRELATION.
A circular shift cannot distinguish genuine interaction from a shared slow drive --
if both animals rear more in the first five minutes, or whenever the room is
disturbed, the real curve rises above the rotated null and nothing social has
happened. So every onset is additionally labelled by how far apart the animals were
at that moment (TTI to TTI, in body lengths), split at NEAR_BL. If the enrichment is
social it should be bigger when they are close. If it is the same near and far, it is
a shared drive and the panel must not call it social.

Unit of analysis is the SESSION, as everywhere else in this figure: each session
contributes one curve per condition and the summary is the across-session median with
p25-p75.

    figs/.venv/bin/python figs/fig5_rear_coupling.py
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

REAR_FRAC, MIN_REAR_S, MERGE_GAP_S = 0.75, 0.25, 0.15
LAG_S = 5.0            # cross-correlogram half-width
N_SHIFTS = 24          # circular shifts per pair
NEAR_BL = 2.0          # "near" = TTI-TTI within 2 body lengths

#: Minimum onsets a session must contribute to a CONDITION before its curve counts.
#:
#: The enrichment is a mean over binary samples, so a session that supplies six "near"
#: onsets returns a curve made of 0s and 1s divided by a base rate -- noise with the
#: right units. Aggregated without this rule the near condition's p25 was 0.00 at lag
#: 0 while its median was 2.21: a quarter of sessions were contributing curves that
#: were mostly zeros because their two animals are hardly ever within two body
#: lengths, not because those animals fail to co-rear. The median is unaffected (it is
#: the same 2.2x either way); what the rule fixes is a band that said the effect might
#: be nothing when the sessions that could actually measure it all agree it is not.
MIN_ONSETS = 20


def runs(mask, min_len, merge_gap):
    m = np.asarray(mask, bool)
    if not m.any():
        return []
    d = np.diff(np.concatenate(([0], m.view(np.int8), [0])))
    s, e = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    merged = []
    for a, b in zip(s, e):
        if merged and a - merged[-1][1] <= merge_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged if b - a >= max(1, min_len)]


def session_coupling(tracks_mm, fps, seed=0):
    F, A = tracks_mm.shape[0], tracks_mm.shape[1]
    if A < 2:
        return None
    nose, tti, neck = (tracks_mm[:, :, NOSE, :], tracks_mm[:, :, TTI, :],
                       tracks_mm[:, :, NECK, :])
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)
    if not np.all(np.isfinite(L)) or np.any(L <= 0):
        return None
    lag = int(round(LAG_S * fps))
    if 2 * lag + 1 >= F:
        return None
    min_len = int(round(MIN_REAR_S * fps))
    gap = int(round(MERGE_GAP_S * fps))

    rear = np.zeros((F, A), bool)
    onsets = {}
    for a in range(A):
        rr = runs(neck[:, a, 2] / L[a] > REAR_FRAC, min_len, gap)
        onsets[a] = [s for s, _ in rr if lag <= s < F - lag]
        for s, e in rr:
            rear[s:e, a] = True

    rng = np.random.default_rng(seed)
    acc = {"all": [], "near": [], "far": [], "near_q": [], "far_q": [], "null": []}
    n_on = {"all": 0, "near": 0, "far": 0, "near_q": 0, "far_q": 0}
    base_rates = []
    sep_bl = []          # separation at every onset, for the deposit
    for i in range(A):
        for j in range(A):
            if i == j:
                continue
            base = rear[:, j].mean()
            if base <= 0 or not onsets[i]:
                continue
            base_rates.append(base)
            # inter-animal separation at each onset, in i's body lengths
            sep = np.linalg.norm(tti[:, i, :] - tti[:, j, :], axis=-1) / L[i]
            idx = np.asarray(onsets[i])
            win = idx[:, None] + np.arange(-lag, lag + 1)[None, :]
            obs = rear[win, j].astype(float)                 # (n_onsets, 2*lag+1)
            near = np.isfinite(sep[idx]) & (sep[idx] <= NEAR_BL)
            acc["all"].append(obs.mean(axis=0) / base)
            n_on["all"] += len(idx)
            sep_bl.extend(float(x) for x in sep[idx] if np.isfinite(x))
            if near.any():
                acc["near"].append(obs[near].mean(axis=0) / base)
                n_on["near"] += int(near.sum())
            if (~near).any():
                acc["far"].append(obs[~near].mean(axis=0) / base)
                n_on["far"] += int((~near).sum())
            # SELF-NORMALISING SPLIT: this session's own separation tertiles.
            # The fixed NEAR_BL cut is not comparable across the corpora -- BMimica's
            # arena is 6.9 body lengths across and SLAP-2M's is 3.2, so "within 2 body
            # lengths" is 17% of the time in one and 48% in the other, and SLAP-2M has
            # almost no genuine "far" condition to contrast against. Tertiles of the
            # observed separation make "near" mean "closer than this pair usually is"
            # in both, which is the comparison the question actually asks.
            s_on = sep[idx]
            fin = np.isfinite(s_on)
            if fin.sum() >= 6:
                lo, hi = np.percentile(s_on[fin], [33.3, 66.7])
                q_near, q_far = fin & (s_on <= lo), fin & (s_on >= hi)
                if q_near.any():
                    acc["near_q"].append(obs[q_near].mean(axis=0) / base)
                    n_on["near_q"] += int(q_near.sum())
                if q_far.any():
                    acc["far_q"].append(obs[q_far].mean(axis=0) / base)
                    n_on["far_q"] += int(q_far.sum())
            # CIRCULAR SHIFT of j only: keeps j's rate/durations/autocorrelation,
            # destroys only its alignment to i.
            for _ in range(N_SHIFTS):
                r = rng.integers(lag, F - lag)
                acc["null"].append(np.roll(rear[:, j], r)[win].mean(axis=0) / base)
    if not acc["all"]:
        return None
    out = {"fps": float(fps), "n_animals": int(A), "lag_frames": int(lag),
           "n_onsets": n_on, "base_rate": float(np.mean(base_rates)),
           "sep_bl_p33": float(np.percentile(sep_bl, 33.3)) if sep_bl else None,
           "sep_bl_p50": float(np.median(sep_bl)) if sep_bl else None,
           "sep_bl_p67": float(np.percentile(sep_bl, 66.7)) if sep_bl else None}
    for k, v in acc.items():
        out[k] = np.nanmean(np.asarray(v), axis=0).tolist() if v else None
    return out


def _bmimica(sd):
    f = glob.glob(os.path.join(sd, "*points3d*.h5"))
    if not f:
        return None
    with h5py.File(f[0]) as h:
        if [x.decode() if isinstance(x, bytes) else x
                for x in h["node_names"][:]] != NODES:
            raise SystemExit(f"{sd}: unexpected skeleton")
        t = h["tracks"][:] * 1000.0
        fps = float(h["recording_frame_rate"][()])
    r = session_coupling(t, fps)
    return None if r is None else {"session": os.path.basename(sd), **r}


def _slap(arg):
    rel, fps = arg
    f = f"{SLAP}/{rel}/aligned_points3d.h5"
    if not os.path.exists(f):
        return None
    with h5py.File(f) as h:
        t = h["tracks"][:]
    r = session_coupling(t, fps)
    return None if r is None else {"session": rel, **r}


def slap_fps(m):
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
            raise SystemExit(f"{r.session_path}: cannot infer fps")
        fps[r.session_path] = next(iter(cand))
    return fps


def summarise(rows, corpus):
    if not rows:
        return None
    fps = min(r["fps"] for r in rows)
    lag = int(round(LAG_S * fps))
    t = np.arange(-lag, lag + 1) / fps
    out = {"corpus": corpus, "n_sessions": len(rows), "t": t.tolist(),
           "fps_min": fps,
           "n_onsets": {k: int(sum(r["n_onsets"][k] for r in rows))
                        for k in ("all", "near", "far", "near_q", "far_q")},
           "sep_bl": {q: float(np.median([r[f"sep_bl_p{q}"] for r in rows
                                          if r.get(f"sep_bl_p{q}") is not None]))
                      for q in ("33", "50", "67")}}
    for key in ("all", "near", "far", "near_q", "far_q", "null"):
        cur, dropped = [], 0
        for r in rows:
            c = r[key]
            if c is None:
                continue
            # The null has no onset count of its own -- it is built from the same
            # onsets as `all`, so it is admitted on that count.
            n = r["n_onsets"].get("all" if key == "null" else key, 0)
            if n < MIN_ONSETS:
                dropped += 1
                continue
            lr = r["lag_frames"]
            cur.append(np.interp(t, np.arange(-lr, lr + 1) / r["fps"],
                                 np.asarray(c, float)))
        if not cur:
            out[key] = None
            continue
        a = np.asarray(cur)
        out[key] = {"n_sessions": int(a.shape[0]),
                    "n_sessions_dropped": dropped, "min_onsets": MIN_ONSETS,
                    "p25": np.nanpercentile(a, 25, axis=0).tolist(),
                    "p50": np.nanmedian(a, axis=0).tolist(),
                    "p75": np.nanpercentile(a, 75, axis=0).tolist()}
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--limit", type=int, default=0)
    ap.add_argument("--jobs", type=int, default=12)
    # PAIRWISE COUPLING IS DILUTED BY A THIRD ANIMAL, so the corpora are only
    # like-for-like at two. With four animals there are 12 ordered pairs instead of 2,
    # "the other animal" is one of three, and the chance of SOME other animal rearing
    # near lag 0 rises with the count -- the base-rate division corrects the level but
    # not the fact that a pair's own interaction is a smaller share of what is
    # measured. BMimica is always two animals; `--slap-animals 2` matches it.
    ap.add_argument("--slap-animals", type=int, default=0,
                    help="restrict SLAP-2M to sessions with exactly this many "
                         "animals (0 = every multi-animal session)")
    ap.add_argument("--out", type=Path, default=OUT / "fig5_rear_coupling.json")
    args = ap.parse_args()

    bm = [d for d in sorted(glob.glob(f"{BMIMICA}/*")) if os.path.isdir(d)]
    m = pd.read_excel(f"{SLAP}/master_sheet.xlsx")
    fps_of = slap_fps(m)
    sel = (m["animals"] == args.slap_animals) if args.slap_animals else (m["animals"] > 1)
    sl = [(r.session_path, fps_of[r.session_path]) for r in m[sel].itertuples()]
    if args.limit:
        bm, sl = bm[:args.limit], sl[:args.limit]
    print(f"BMimica {len(bm)} dirs, SLAP-2M {len(sl)} sessions"
          + (f" with exactly {args.slap_animals} animals" if args.slap_animals
             else " (all multi-animal)"))

    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        bm_rows = [r for r in ex.map(_bmimica, bm) if r]
        sl_rows = [r for r in ex.map(_slap, sl) if r]

    res = {"rear_frac_body_lengths": REAR_FRAC, "min_rear_s": MIN_REAR_S,
           "lag_s": LAG_S, "n_shifts": N_SHIFTS, "near_bl": NEAR_BL,
           "note": ("P(other animal rearing | this animal starts a rear), divided by "
                    "the other animal's base rate, so 1.0 = chance. Null is a CIRCULAR "
                    "SHIFT of the other animal's rear series, which preserves its rate, "
                    "durations and autocorrelation and destroys only the alignment. "
                    "near/far split at NEAR_BL body lengths of TTI-TTI separation at "
                    "onset: a social effect should be larger when near, a shared drive "
                    "should not."),
           "corpora": {}}
    for name, rows in (("BMimica", bm_rows), ("SLAP-2M", sl_rows)):
        res["corpora"][name] = summarise(rows, name)
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(res, indent=1))

    for name in ("BMimica", "SLAP-2M"):
        s = res["corpora"][name]
        if not s:
            continue
        t = np.asarray(s["t"])
        z = int(np.argmin(np.abs(t)))
        print(f"\n=== {name}: {s['n_sessions']} sessions, onsets "
              f"{s['n_onsets']['all']:,} (near {s['n_onsets']['near']:,}, "
              f"far {s['n_onsets']['far']:,}) ===")
        print(f"  separation at onset (body lengths): p33 {s['sep_bl']['33']:.2f}  "
              f"p50 {s['sep_bl']['50']:.2f}  p67 {s['sep_bl']['67']:.2f}")
        for key in ("all", "near", "far", "near_q", "far_q", "null"):
            g = s[key]
            if not g:
                continue
            mu = np.asarray(g["p50"])
            k = int(np.argmax(mu))
            print(f"  {key:5}  at lag 0 {mu[z]:5.2f}x chance   peak {mu[k]:5.2f}x "
                  f"at {t[k]:+.2f} s")
    print(f"\n[json] {args.out}")


if __name__ == "__main__":
    main()
