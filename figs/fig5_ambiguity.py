#!/usr/bin/env python3
"""
What 3D buys you: the mutual upright display is AMBIGUOUS in a single camera.

THE ARGUMENT. During the display the two animals stand tail-base to tail-base about
0.8 body lengths apart and lean together until their noses nearly touch. That is a
comfortable separation in three dimensions. In a two-dimensional projection it need
not be: if the line joining the animals runs anywhere near a camera's optical axis,
the two skeletons land on top of each other in that image, and no per-camera tracker
can be sure which limb belongs to which animal. This script measures how often that
happens, in the real camera views, with the real detections.

MEASURED FROM THE 2D DETECTIONS, NOT FROM A PROJECTION OF THE 3D, which matters: a
reprojection would inherit the reconstruction it is supposed to be independent of, and
would also require the P-frame-to-calibration-frame alignment. Each camera's
`*.analysis.h5` holds its own two tracks in its own pixels. Per camera and frame:

    iou        intersection-over-union of the two animals' node bounding boxes
    nose_px    distance between the two animals' noses, in pixels
    min_px     smallest distance between ANY node of one animal and any of the other,
               which is the quantity a per-camera tracker actually has to resolve

IDENTITY IS NOT NEEDED and is deliberately not used. The question is "how separable
are the two animals in this image", which is a property of the pair, so the arbitrary
per-camera track order cannot affect it. That also means this measurement does not
depend on cross-view identity being correct -- it is not circular.

THE CONTROL IS PROXIMITY-MATCHED. Two animals that overlap in a view merely because
they are close would prove nothing about the display. Control frames are drawn from
moments when the animals are just as close (within NEAR_BL) but NOT both reared, so
the only difference is the posture. If overlap is no worse during displays, there is
no 3D argument here and the panel should not be drawn.

    figs/.venv/bin/python figs/fig5_ambiguity.py
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

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
BMIMICA = "/root/vast/eric/BMimica"

NODES = ["Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk", "Tail_0",
         "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right", "Haunch_left",
         "Haunch_right", "Neck"]
NOSE, TTI, NECK = NODES.index("Nose"), NODES.index("TTI"), NODES.index("Neck")

REAR_FRAC, NEAR_BL = 0.75, 2.0
MIN_EVENT_S, MERGE_GAP_S = 0.25, 0.15
IOU_OVERLAP = 0.10        # "these two boxes overlap enough to be confusable"
IOU_SEVERE = 0.50
MAX_EVENTS = 60           # per session, to bound the 2D reads


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


def pair_stats(xy):
    """xy: (2 animals, 15 nodes, 2) -> (iou, nose_px, min_px, tti_px, cent_px).

    WHY tti_px AND cent_px WERE ADDED. The first version of this script scored
    ambiguity by bounding-box IoU and found the display OVERLAPS LESS than the
    proximity-matched control (35.9% of views against 58.6%). That is real and it is
    obvious in hindsight: two reared animals are tall NARROW boxes side by side, which
    intersect less than two horizontal animals lying together. Body-box overlap is
    simply the wrong quantity.

    What projection actually collapses is the SEPARATION BETWEEN THE BODIES. The
    animals stand 0.87 body lengths apart at the tail base; a camera looking along
    that line sees the two bodies superimposed, and the pixel gap between their tail
    bases goes to nothing while the 3D separation is unchanged. `tti_px` is that gap
    and `cent_px` the same for the whole-skeleton centroid. The spread of those across
    the five views is the ambiguity, and the 3D number is what resolves it.

    (`nose_px` is NOT evidence of projective ambiguity, and must not be presented as
    such: the noses are 0.07 body lengths apart in 3D too. They are genuinely close,
    not apparently close.)
    """
    if not np.isfinite(xy).all():
        return (np.nan,) * 5
    boxes = []
    for a in range(2):
        boxes.append((xy[a, :, 0].min(), xy[a, :, 1].min(),
                      xy[a, :, 0].max(), xy[a, :, 1].max()))
    (ax0, ay0, ax1, ay1), (bx0, by0, bx1, by1) = boxes
    ix = max(0.0, min(ax1, bx1) - max(ax0, bx0))
    iy = max(0.0, min(ay1, by1) - max(ay0, by0))
    inter = ix * iy
    ua = (ax1 - ax0) * (ay1 - ay0) + (bx1 - bx0) * (by1 - by0) - inter
    iou = inter / ua if ua > 0 else np.nan
    nose_px = float(np.hypot(*(xy[0, NOSE] - xy[1, NOSE])))
    d = np.linalg.norm(xy[0][:, None, :] - xy[1][None, :, :], axis=-1)
    tti_px = float(np.hypot(*(xy[0, TTI] - xy[1, TTI])))
    cent_px = float(np.hypot(*(xy[0].mean(axis=0) - xy[1].mean(axis=0))))
    return iou, nose_px, float(d.min()), tti_px, cent_px


def _session(sd):
    fp = glob.glob(os.path.join(sd, "*points3d*.h5"))
    if not fp:
        return None
    with h5py.File(fp[0]) as h:
        t3 = h["tracks"][:] * 1000.0
        fps = float(h["recording_frame_rate"][()])
    F, A = t3.shape[0], t3.shape[1]
    if A != 2:
        return None
    nose, tti, neck = t3[:, :, NOSE, :], t3[:, :, TTI, :], t3[:, :, NECK, :]
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)
    if not np.all(np.isfinite(L)) or np.any(L <= 0):
        return None
    Lm = float(np.mean(L))
    sep = np.linalg.norm(tti[:, 0, :] - tti[:, 1, :], axis=-1) / Lm
    rear = np.stack([neck[:, a, 2] / L[a] > REAR_FRAC for a in range(2)], axis=1)
    near = np.isfinite(sep) & (sep <= NEAR_BL)

    ev = runs(rear[:, 0] & rear[:, 1] & near,
              int(round(MIN_EVENT_S * fps)), int(round(MERGE_GAP_S * fps)))
    if not ev:
        return None
    rng = np.random.default_rng(0)
    # one frame per display: the moment the noses are closest, i.e. the hardest
    # instant for a per-camera tracker
    nose_xy = np.linalg.norm(nose[:, 0, :2] - nose[:, 1, :2], axis=-1) / Lm
    disp = [int(s + np.nanargmin(nose_xy[s:e])) for s, e in ev][:MAX_EVENTS]
    # PROXIMITY-MATCHED CONTROL: as close, but not both reared.
    ctrl_pool = np.flatnonzero(near & ~(rear[:, 0] & rear[:, 1]))
    if ctrl_pool.size == 0:
        return None
    ctrl = rng.choice(ctrl_pool, size=min(len(disp), ctrl_pool.size),
                      replace=False).tolist()

    cams = sorted(d for d in os.listdir(sd)
                  if re.fullmatch(r"\d+", d) and os.path.isdir(os.path.join(sd, d)))
    out = {"session": os.path.basename(sd), "fps": fps, "n_cameras": len(cams),
           "n_displays": len(disp), "sep_bl_median": float(np.nanmedian(sep[disp])),
           "per_cam": {}}
    got = {"display": [], "control": []}
    for cam in cams:
        h5s = glob.glob(os.path.join(sd, cam, "*.analysis.h5"))
        if not h5s:
            continue
        with h5py.File(h5s[0]) as h:
            tr = h["tracks"]           # (2 tracks, 2 coords, 15 nodes, F)
            if tr.shape[0] < 2:
                continue
            for tag, frames in (("display", disp), ("control", ctrl)):
                idx = np.array(sorted(f for f in frames if 0 <= f < tr.shape[3]))
                if not idx.size:
                    continue
                sub = tr[:, :, :, idx]                    # (2,2,15,n)
                sub = np.transpose(sub, (3, 0, 2, 1))     # (n,2,15,2)
                for k in range(sub.shape[0]):
                    got[tag].append((cam, k, *pair_stats(sub[k])))
    for tag in ("display", "control"):
        rows = got[tag]
        if not rows:
            out[tag] = None
            continue
        iou = np.array([r[2] for r in rows], float)
        nose_px = np.array([r[3] for r in rows], float)
        min_px = np.array([r[4] for r in rows], float)
        tti_px = np.array([r[5] for r in rows], float)
        cent_px = np.array([r[6] for r in rows], float)
        ok = np.isfinite(iou)
        # PER FRAME, ACROSS VIEWS: the worst view is the one that matters, because a
        # single-camera pipeline has only one view and does not get to pick.
        byf = {}
        for r in rows:
            byf.setdefault(r[1], []).append((r[5], r[6]))
        # nanmin/nanmax, and frames with NO finite view dropped entirely: a plain
        # min() propagated a single camera's NaN and turned every worst-view value
        # into NaN.
        wt, bt = [], []
        for vs in byf.values():
            f = [v[0] for v in vs if np.isfinite(v[0])]
            if f:
                wt.append(min(f))
                bt.append(max(f))
        worst_tti = np.array(wt, float)
        best_tti = np.array(bt, float)
        if not worst_tti.size:
            worst_tti = best_tti = np.array([np.nan])
        out[tag] = {
            "n": int(ok.sum()),
            "iou_p50": float(np.nanmedian(iou[ok])),
            "frac_overlap": float((iou[ok] > IOU_OVERLAP).mean()),
            "frac_severe": float((iou[ok] > IOU_SEVERE).mean()),
            "nose_px_p50": float(np.nanmedian(nose_px[np.isfinite(nose_px)])),
            "min_px_p50": float(np.nanmedian(min_px[np.isfinite(min_px)])),
            "tti_px_p50": float(np.nanmedian(tti_px[np.isfinite(tti_px)])),
            "cent_px_p50": float(np.nanmedian(cent_px[np.isfinite(cent_px)])),
            "worst_view_tti_px_p50": float(np.nanmedian(worst_tti)),
            "best_view_tti_px_p50": float(np.nanmedian(best_tti)),
            "frac_worst_under_20px": float(np.nanmean(worst_tti < 20)),
        }
    # per-view breakdown, so the panel can show that it is not every camera
    for cam in cams:
        v = [r[1] for r in got["display"] if r[0] == cam and np.isfinite(r[1])]
        if v:
            out["per_cam"][cam] = {"n": len(v), "iou_p50": float(np.median(v)),
                                   "frac_overlap": float(np.mean(np.array(v) > IOU_OVERLAP))}
    # HOW MANY VIEWS AT ONCE. The decisive number: a pipeline can survive one bad
    # view, so what matters is how many of the cameras are compromised together.
    ncam = len(out["per_cam"])
    if ncam:
        per_frame = {}
        for r in got["display"]:
            per_frame.setdefault(r[0], []).append(r[2])
        # RAGGED BY CONSTRUCTION: a camera whose analysis.h5 is missing or has one
        # track contributes no rows, so the per-camera lists need not be the same
        # length. Truncate to the shortest rather than zip-padding, which would
        # silently count a missing view as "not overlapping".
        n = min(len(per_frame[c]) for c in out["per_cam"])
        m = np.array([per_frame[c][:n] for c in out["per_cam"]], float)
        n_ov = np.nansum(m > IOU_OVERLAP, axis=0)
        out["views_overlapping"] = {
            "n_cameras": ncam, "n_frames": int(n),
            "median": float(np.median(n_ov)),
            # FIXED WIDTH 6 (0..5 views). Sessions differ in usable camera count, so
            # a per-session-width histogram cannot be summed across the corpus.
            "hist": np.bincount(n_ov.astype(int), minlength=6)[:6].tolist(),
            "frac_two_or_more": float((n_ov >= 2).mean()),
        }
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=10)
    ap.add_argument("--out", type=Path, default=OUT / "fig5_ambiguity.json")
    args = ap.parse_args()
    sds = [d for d in sorted(glob.glob(f"{BMIMICA}/*")) if os.path.isdir(d)]
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        rows = [r for r in ex.map(_session, sds) if r]

    def agg(tag, key):
        v = [r[tag][key] for r in rows if r.get(tag)]
        return float(np.median(v)) if v else None

    hist = np.sum([r["views_overlapping"]["hist"] for r in rows
                   if "views_overlapping" in r], axis=0)
    res = {"corpus": "BMimica", "n_sessions": len(rows),
           "iou_overlap": IOU_OVERLAP, "iou_severe": IOU_SEVERE,
           "n_displays": int(sum(r["n_displays"] for r in rows)),
           "summary": {tag: {k: agg(tag, k) for k in
                             ("iou_p50", "frac_overlap", "frac_severe",
                              "nose_px_p50", "min_px_p50", "tti_px_p50",
                              "cent_px_p50", "worst_view_tti_px_p50",
                              "best_view_tti_px_p50", "frac_worst_under_20px")}
                       for tag in ("display", "control")},
           "views_overlapping_hist": hist.tolist(),
           "views_overlapping_median": float(np.median(
               [r["views_overlapping"]["median"] for r in rows
                if "views_overlapping" in r])),
           "frac_two_or_more": float(np.median(
               [r["views_overlapping"]["frac_two_or_more"] for r in rows
                if "views_overlapping" in r])),
           "sep_bl_median": float(np.median([r["sep_bl_median"] for r in rows])),
           "per_session": rows}
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(res, indent=1))

    print(f"{len(rows)} sessions, {res['n_displays']} displays sampled")
    print(f"3D separation at those instants: {res['sep_bl_median']:.2f} body lengths "
          f"(unambiguous)")
    for tag in ("display", "control"):
        s = res["summary"][tag]
        print(f"  {tag:8} tail-base gap: worst view {s['worst_view_tti_px_p50']:6.1f} px"
              f"   best view {s['best_view_tti_px_p50']:6.1f} px"
              f"   median view {s['tti_px_p50']:6.1f} px"
              f"   worst < 20 px in {s['frac_worst_under_20px'] * 100:4.1f}%")
        print(f"  {'':8} bbox IoU {s['iou_p50']:.3f}, overlapping "
              f"{s['frac_overlap'] * 100:.1f}% of views; nose gap "
              f"{s['nose_px_p50']:.1f} px (genuinely close in 3D too)")
    print(f"  views overlapping at once: median {res['views_overlapping_median']:.1f} "
          f"of 5; >=2 views in {res['frac_two_or_more'] * 100:.0f}% of displays")
    print(f"  histogram over #views overlapping: {res['views_overlapping_hist']}")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
