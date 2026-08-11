#!/usr/bin/env python3
"""
What happens AFTER the mutual upright display, and whether it is specific to it.

THE QUESTION. The display ends when one animal comes down. Does the follower back off
or flee? Do they stay together? Is there anything stereotyped at all? The measurement
has to answer "compared with what", so every quantity below is computed twice: once
after a display, and once after a CLOSE ENCOUNTER that met the same proximity and
duration criteria but in which the two animals were NOT both reared. That control is
the whole design -- "they separate afterwards" is not a finding if two mice separate
after any close encounter.

WHAT IS MEASURED, in the window after the event's last frame:
  * pair distance (tail base to tail base, body lengths) over time;
  * each animal's speed, split by ROLE (initiator / follower), so "who leaves" is
    answerable rather than assumed;
  * RETREAT, the component of each animal's displacement along the axis pointing away
    from where the partner was at the end of the event -- positive means it moved away.
    Splitting the separation into the two animals' contributions is the only way to
    say whether one animal withdrew or both did;
  * FACING, the angle between an animal's own body axis (tail base -> nose, in the
    horizontal plane) and the direction to its partner. 0 deg = pointed at the
    partner, 180 deg = pointed directly away. "Turns away" is a claim about this
    quantity and nothing else;
  * whether the pair is still within 2 body lengths after 1, 2 and 3 s, and whether a
    new display starts within 10 s.

    figs/.venv/bin/python figs/fig5_aftermath.py
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

from fig5_upright import (BMIMICA, MERGE_GAP_S, MIN_EVENT_S, NEAR_BL, NOSE, NECK,
                          REAR_FRAC, TTI, runs)

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"

POST_S = 3.0          # window after the event's last frame
SPEED_WIN_S = 0.20


def _session(sd):
    fp = glob.glob(os.path.join(sd, "*points3d*.h5"))
    if not fp:
        return None
    with h5py.File(fp[0]) as h:
        t = h["tracks"][:] * 1000.0
        fps = float(h["recording_frame_rate"][()])
    F, A = t.shape[0], t.shape[1]
    if A != 2:
        return None
    nose, tti, neck = t[:, :, NOSE, :], t[:, :, TTI, :], t[:, :, NECK, :]
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)
    if not np.all(np.isfinite(L)) or np.any(L <= 0):
        return None
    Lm = float(np.mean(L))

    min_len = int(round(MIN_EVENT_S * fps))
    gap = int(round(MERGE_GAP_S * fps))
    sw = max(1, int(round(SPEED_WIN_S * fps)))
    w = int(round(POST_S * fps))

    rear = np.stack([neck[:, a, 2] / L[a] > REAR_FRAC for a in range(2)], axis=1)
    sep = np.linalg.norm(tti[:, 0, :] - tti[:, 1, :], axis=-1) / Lm
    near = np.isfinite(sep) & (sep <= NEAR_BL)

    spd = np.full((F, 2), np.nan)
    for a in range(2):
        dd = np.linalg.norm(np.diff(tti[:, a, :2], axis=0), axis=-1) / Lm * fps
        spd[1:, a] = np.convolve(dd, np.ones(sw) / sw, mode="same")

    # heading in the horizontal plane, and the direction to the partner
    head = nose[:, :, :2] - tti[:, :, :2]
    head /= np.maximum(np.linalg.norm(head, axis=-1, keepdims=True), 1e-9)
    to_p = np.stack([tti[:, 1, :2] - tti[:, 0, :2],
                     tti[:, 0, :2] - tti[:, 1, :2]], axis=1)
    to_p /= np.maximum(np.linalg.norm(to_p, axis=-1, keepdims=True), 1e-9)
    facing = np.degrees(np.arccos(np.clip((head * to_p).sum(-1), -1, 1)))  # F x 2

    disp = [r for r in runs(rear[:, 0] & rear[:, 1] & near, min_len, gap)]

    # THE CONTROL IS MATCHED ON SEPARATION, not on being a "close encounter". The
    # first version of this took proximity epochs that were not displays and used
    # their END -- but such an epoch ENDS BECAUSE the animals moved apart (that is
    # what terminates the run), so it started its window at 2.0 BL where a display
    # ends at 0.86, and "they separate afterwards" was true of the control by
    # construction. Here each display is matched to a moment in the same session at
    # the SAME separation (+-0.15 BL) with the animals not both reared and no display
    # within 3 s, so the two windows begin in the same geometry and only the history
    # differs.
    rng = np.random.default_rng(abs(hash(os.path.basename(sd))) % (2 ** 31))
    both = rear[:, 0] & rear[:, 1]
    busy = np.zeros(F, bool)
    for s, e in disp:
        busy[max(0, s - 3 * int(fps)):min(F, e + 3 * int(fps))] = True
    ok = near & ~both & ~busy
    ok[F - w - 1:] = False
    ctrl = []
    for s, e in disp:
        cand = np.flatnonzero(ok & (np.abs(sep - sep[e]) < 0.15))
        if cand.size:
            c = int(rng.choice(cand))
            ctrl.append((max(0, c - (e - s)), c))

    own = [runs(rear[:, a], min_len, gap) for a in range(2)]
    starts = sorted(s for s, _ in disp)

    def collect(evs, kind):
        out = []
        for s, e in evs:
            if e + w >= F or e <= 0:
                continue
            if kind == "display":
                ons = []
                for a in range(2):
                    c = [bs for bs in own[a] if bs[0] <= s < bs[1]]
                    ons.append(c[-1][0] if c else None)
                if None in ons:
                    continue
                init = 0 if ons[0] < ons[1] else 1
            else:
                # No initiator for a control epoch: the role is assigned by which
                # animal was moving LESS on approach -- the closest analogue to
                # "was already there". Falls back to track 0 when the pre-window is
                # empty or all-NaN rather than raising, since a control epoch that
                # starts at frame 0 is not worth losing the session over.
                pre = [np.nanmean(spd[max(0, s - sw):s, a]) if s > 0 else np.nan
                       for a in range(2)]
                init = 0 if not np.isfinite(pre).all() else int(np.argmin(pre))
            fol = 1 - init
            k = slice(e, e + w + 1)
            p0 = tti[e, :, :2]
            away = p0[[1, 0]] - p0                       # partner -> self, at offset
            away /= np.maximum(np.linalg.norm(away, axis=-1, keepdims=True), 1e-9)
            away = -away                                  # self -> away from partner
            retreat = np.stack(
                [((tti[k, a, :2] - p0[a]) * away[a]).sum(-1) / Lm for a in range(2)],
                axis=1)
            nxt = [x for x in starts if x > e]
            out.append({
                "kind": kind, "session": os.path.basename(sd),
                "start_frame": int(s), "end_frame": int(e),
                "dur_s": (e - s) / fps,
                "sep": (sep[k] / 1.0).tolist(),
                "spd_init": spd[k, init].tolist(),
                "spd_follow": spd[k, fol].tolist(),
                "retreat_init": retreat[:, init].tolist(),
                "retreat_follow": retreat[:, fol].tolist(),
                "facing_init": facing[k, init].tolist(),
                "facing_follow": facing[k, fol].tolist(),
                "sep_at_end": float(sep[e]),
                "near_1s": bool(sep[e + int(fps)] <= NEAR_BL),
                "near_2s": bool(sep[e + int(2 * fps)] <= NEAR_BL),
                "near_3s": bool(sep[e + w] <= NEAR_BL),
                "requeue_10s": bool(nxt and (nxt[0] - e) / fps <= 10.0),
            })
        return out

    ev = collect(disp, "display") + collect(ctrl, "control")
    if not ev:
        return None
    # BASE RATES for the two claims that are about occurrence rather than shape:
    # how much of the session the pair spends within 2 BL at all, and how often a
    # display would follow a random near-moment within 10 s. Without these, "they are
    # still together 3 s later" and "another display within 10 s" are unreadable.
    near_frames = np.flatnonzero(near & ~busy)
    ten = int(round(10 * fps))
    starts_arr = np.array([s for s, _ in disp])
    if near_frames.size and starts_arr.size:
        samp = rng.choice(near_frames, size=min(2000, near_frames.size),
                          replace=False)
        nxt = np.searchsorted(starts_arr, samp, side="right")
        base_requeue = float(np.mean([
            (nxt[i] < starts_arr.size) and (starts_arr[nxt[i]] - samp[i]) <= ten
            for i in range(samp.size)]))
    else:
        base_requeue = float("nan")
    return {"session": os.path.basename(sd), "fps": fps, "n_display": len(disp),
            "n_control": len(ctrl), "events": ev,
            "frac_near": float(np.mean(near[np.isfinite(sep)])),
            "base_requeue_10s": base_requeue}


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=14)
    ap.add_argument("--out", type=Path, default=OUT / "fig5_aftermath.json")
    args = ap.parse_args()
    sds = [d for d in sorted(glob.glob(f"{BMIMICA}/*")) if os.path.isdir(d)]
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        rows = [r for r in ex.map(_session, sds) if r]

    fps = min(r["fps"] for r in rows)
    w = int(round(POST_S * fps))
    t = np.arange(0, w + 1) / fps
    allev = []
    for r in rows:
        wr = int(round(POST_S * r["fps"]))
        tr = np.arange(0, wr + 1) / r["fps"]
        for e in r["events"]:
            for k in ("sep", "spd_init", "spd_follow", "retreat_init",
                      "retreat_follow", "facing_init", "facing_follow"):
                e[k] = np.interp(t, tr, np.asarray(e[k], float)).tolist()
            allev.append(e)

    res = {"corpus": "BMimica", "n_sessions": len(rows), "t": t.tolist(),
           "post_s": POST_S, "near_bl": NEAR_BL, "events": allev,
           "per_session": [{k: r[k] for k in ("session", "n_display", "n_control",
                                              "frac_near", "base_requeue_10s")}
                           for r in rows]}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(res))

    d = [e for e in allev if e["kind"] == "display"]
    c = [e for e in allev if e["kind"] == "control"]
    print(f"{len(rows)} sessions: {len(d)} displays, {len(c)} close-encounter controls")
    for tag, S in (("display", d), ("control", c)):
        if not S:
            continue
        ri = np.array([e["retreat_init"][-1] for e in S])
        rf = np.array([e["retreat_follow"][-1] for e in S])
        print(f"  {tag:8} sep at end {np.median([e['sep_at_end'] for e in S]):.2f} BL"
              f" -> {np.median([e['sep'][-1] for e in S]):.2f} BL at {POST_S:.0f} s;"
              f" still near 1/2/3 s: "
              f"{np.mean([e['near_1s'] for e in S]):.0%}/"
              f"{np.mean([e['near_2s'] for e in S]):.0%}/"
              f"{np.mean([e['near_3s'] for e in S]):.0%}")
        print(f"           retreat init {np.median(ri):+.2f} BL, follower "
              f"{np.median(rf):+.2f} BL; follower larger in "
              f"{np.mean(rf > ri):.0%} of events")
        print(f"           facing away at 1 s: init "
              f"{np.median([e['facing_init'][int(fps)] for e in S]):.0f} deg, follower "
              f"{np.median([e['facing_follow'][int(fps)] for e in S]):.0f} deg")
        print(f"           new display within 10 s: "
              f"{np.mean([e['requeue_10s'] for e in S]):.0%}")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
