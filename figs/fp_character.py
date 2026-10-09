#!/usr/bin/env python
"""What are LUC3D's false positives on the UNFILTERED SLAP-2M pool? (2026-10-08, Eric:
"lets take a look at the character of those false positives and then strategically
filter without dropping so many points and sacrificing IDF1").

Same box rule as the scorer (luc3d-bench evaluate.bbox_from_kpts: min/max of >= 3 finite
keypoints, 5 px pad; IoU >= 0.5 to match), over every LABELLED detection (tracker id >= 0)
in all multi-animal sessions and all six cameras. A detection is a HIT if its best IoU
against any GT box in that frame is >= 0.5, else a FALSE POSITIVE. This is the greedy
stand-in for motmetrics' Hungarian. It can only call fewer FPs, never more, so the shares
below are a lower bound on the scorer's.

Each FP is classified by what it overlaps:
  no_overlap      best IoU 0 against every GT box (spurious / background / reflection)
  gt_partial      overlaps a GT animal whose PROOFREAD box is small, i.e. the label itself is
                  partial (occlusion), while the detection's keypoints sit on that animal
                  (median keypoint distance on shared nodes <= 15 px). A correct detection
                  scored as an FP because the GT box shrank
  det_partial     overlaps a GT animal but the DETECTION has few keypoints (< 8)
  dup_of_hit      overlaps a GT animal that ALREADY has a hit in this frame and camera
  offset          overlaps a GT animal, keypoints NOT on it (median distance > 15 px)
Features recorded for hits and FPs alike: visible keypoints, instance score, box area.

Output: out/fp_character_<pool>.json (+ printed summary).
    PYTHONPATH=<cv2h> $LIEZL figs/fp_character.py --pool predslp --workers 24
"""
import argparse
import json
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import h5py
import numpy as np

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))
import fig4_slap2m as f9  # noqa: E402  (sessions(), POOLS, CAMERAS; evaluate on path)
import evaluate as ev  # noqa: E402

OUT = FIGS / "out"
f9_SLAP_ROOT = "/root/talmolab-smb/eric/slap_2m"
PAD, MINV, NEAR_PX = 5.0, 3, 15.0


def boxes(k):
    """(..., N, 2) keypoints -> (..., 4) boxes and (...) valid flag, scorer's rule."""
    fin = np.isfinite(k[..., 0]) & np.isfinite(k[..., 1])
    n = fin.sum(-1)
    x = np.where(fin, k[..., 0], np.nan)
    y = np.where(fin, k[..., 1], np.nan)
    with np.errstate(all="ignore"):
        b = np.stack([np.nanmin(x, -1) - PAD, np.nanmin(y, -1) - PAD,
                      np.nanmax(x, -1) + PAD, np.nanmax(y, -1) + PAD], -1)
    return b, n >= MINV, n


def iou(a, b):
    """a (F, D, 4), b (F, T, 4) -> (F, D, T)."""
    a, b = a[:, :, None], b[:, None]
    iw = np.clip(np.minimum(a[..., 2], b[..., 2]) - np.maximum(a[..., 0], b[..., 0]), 0, None)
    ih = np.clip(np.minimum(a[..., 3], b[..., 3]) - np.maximum(a[..., 1], b[..., 1]), 0, None)
    inter = iw * ih
    ua = (a[..., 2] - a[..., 0]) * (a[..., 3] - a[..., 1])
    ub = (b[..., 2] - b[..., 0]) * (b[..., 3] - b[..., 1])
    with np.errstate(all="ignore"):
        return np.nan_to_num(inter / (ua + ub - inter))


def one(args):
    s, pool, luc_dir = args
    luc = json.loads((luc_dir / f"{s['session']}.json").read_text())
    rec = {"hit": {"vis": [], "score": [], "area": [], "frag": []},
           "fp": {"vis": [], "score": [], "area": [], "kind": [], "gt_vis": [],
                  "frag": [], "on_reproj": [], "reproj_unlabelled": []}}
    for cam in f9.CAMERAS:
        with h5py.File(f9.POOLS[pool] / f"{cam}_predictions.h5", "r") as f:
            det = f["tracks"][s["det_session_idx"]]
            sc = f["det_scores"][s["det_session_idx"]]
        gt, occ = ev.load_gt(Path(s["gt_paths"][cam]))
        nf = min(gt.shape[0], det.shape[0], s["max_frames"])
        det, sc, gt, occ = det[:nf], sc[:nf], gt[:nf], occ[:nf]
        ids = ev.luc3d_assignments_for_cam(luc, cam, nf, det.shape[1])
        # proofread 3D reprojected into this camera: complete even where 2D labels are not
        rp = s["reproj"][cam]
        rp = rp if rp.startswith("/") else str(Path(f9_SLAP_ROOT) / rp)
        with h5py.File(rp, "r") as f:
            R = np.transpose(f["tracks"][:], (3, 0, 2, 1))[:nf]       # (F, T, N, 2)
        db, dok, dn = boxes(det)
        gb, gok, gn = boxes(gt)
        gok &= occ
        I = iou(db, gb)
        I[~np.broadcast_to(gok[:, None, :], I.shape)] = 0
        best = I.max(-1)
        arg = I.argmax(-1)
        lab = dok & (ids >= 0)
        hit = lab & (best >= 0.5)
        fp = lab & (best < 0.5)
        area = (db[..., 2] - db[..., 0]) * (db[..., 3] - db[..., 1])
        rb, rok, _ = boxes(R)
        IR = iou(db, rb[:nf])
        IR[~np.broadcast_to(rok[:nf, None, :], IR.shape)] = 0
        rbest, rarg = IR.max(-1), IR.argmax(-1)
        # FRAGMENT (no GT used): most of this box lies inside another detection's box,
        # and that other detection has more visible keypoints
        a_, b_ = db[:, :, None], db[:, None]
        iw = np.clip(np.minimum(a_[..., 2], b_[..., 2]) - np.maximum(a_[..., 0], b_[..., 0]), 0, None)
        ih = np.clip(np.minimum(a_[..., 3], b_[..., 3]) - np.maximum(a_[..., 1], b_[..., 1]), 0, None)
        with np.errstate(all="ignore"):
            cont = np.nan_to_num(iw * ih / area[:, :, None])
        more = dn[:, None, :] > dn[:, :, None]
        okpair = dok[:, :, None] & dok[:, None, :] & more
        D = det.shape[1]
        cont[:, np.arange(D), np.arange(D)] = 0
        frag = ((cont >= 0.6) & okpair).any(-1)
        rec["hit"]["frag"] += frag[hit].tolist()
        rec["fp"]["frag"] += frag[fp].tolist()
        rec["fp"]["on_reproj"] += (rbest[fp] >= 0.5).tolist()
        fr2, dj2 = np.nonzero(fp)
        t2 = rarg[fr2, dj2]
        rec["fp"]["reproj_unlabelled"] += ((rbest[fr2, dj2] >= 0.5) & ~gok[fr2, t2]).tolist()
        for k in ("vis", "score", "area"):
            v = {"vis": dn, "score": sc, "area": area}[k]
            rec["hit"][k] += v[hit].tolist()
            rec["fp"][k] += v[fp].tolist()
        # which GT animals already have a hit, per frame
        hit_gt = np.zeros(gok.shape, bool)
        fr, dj = np.nonzero(hit)
        hit_gt[fr, arg[fr, dj]] = True
        for fi, dj in zip(*np.nonzero(fp)):
            t = arg[fi, dj]
            if best[fi, dj] <= 0:
                kind, gv = "no_overlap", 0
            else:
                gv = int(gn[fi, t])
                with np.errstate(all="ignore"):
                    d = np.nanmedian(np.linalg.norm(det[fi, dj] - gt[fi, t], axis=-1))
                if hit_gt[fi, t]:
                    kind = "dup_of_hit"
                elif np.isfinite(d) and d <= NEAR_PX:
                    kind = "gt_partial" if gv < dn[fi, dj] else "on_animal_other"
                elif dn[fi, dj] < 8:
                    kind = "det_partial"
                else:
                    kind = "offset"
            rec["fp"]["kind"].append(kind)
            rec["fp"]["gt_vis"].append(gv)
    return s["session"], s["difficulty"], rec


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--pool", default="predslp")
    ap.add_argument("--workers", type=int, default=24)
    a = ap.parse_args()
    luc_dir = (OUT / "tmp" / ("fig9slap" if a.pool == "keeptrack" else f"fig9slap_{a.pool}")
               / "sync_stale20_dist25")
    sess, _ = f9.sessions()
    sess = [s for s in sess if s["animals"] > 1]
    import pandas as pd
    ms = pd.read_csv(f9.MASTER, sep="\t", index_col=0).reset_index(drop=True)
    for s in sess:
        r = ms.iloc[s["det_session_idx"]]
        assert str(r["session"]) == s["session"]
        s["reproj"] = {c: r[f"{c}_reproj_h5"] for c in f9.CAMERAS}
    agg = {"hit": {"vis": [], "score": [], "area": [], "frag": []},
           "fp": {"vis": [], "score": [], "area": [], "kind": [], "gt_vis": [],
                  "frag": [], "on_reproj": [], "reproj_unlabelled": []}}
    by_diff = {}
    with ProcessPoolExecutor(a.workers) as ex:
        for sid, d, r in ex.map(one, [(s, a.pool, luc_dir) for s in sess]):
            for g in agg:
                for k in agg[g]:
                    agg[g][k] += r[g][k]
            bd = by_diff.setdefault(d, {"hit": 0, "fp": 0})
            bd["hit"] += len(r["hit"]["vis"])
            bd["fp"] += len(r["fp"]["vis"])
    H = {k: np.array(v, float) for k, v in agg["hit"].items()}
    F = {k: np.array(v, float) for k, v in agg["fp"].items() if k != "kind"}
    kinds = np.array(agg["fp"]["kind"])
    nh, nf = len(H["vis"]), len(F["vis"])
    print(f"[{a.pool}] {len(sess)} multi-animal sessions: {nh:,} hits, {nf:,} FPs "
          f"({100 * nf / (nh + nf):.2f}% of labelled detections)")
    print("FP kinds:", {k: f"{100 * (kinds == k).mean():.1f}%" for k in np.unique(kinds)})
    nov = kinds == "no_overlap"
    print(f"  of the no_overlap FPs: {100 * F['on_reproj'][nov].mean():.1f}% sit on a "
          f"REPROJECTED proofread animal (IoU >= 0.5); {100 * F['reproj_unlabelled'][nov].mean():.1f}% "
          f"on one that has NO 2D label in that frame+camera")
    print(f"  all FPs on a reprojected animal: {100 * F['on_reproj'].mean():.1f}%")
    print(f"  FRAGMENT rule (box >= 60% inside a detection with more keypoints): "
          f"{100 * F['frag'].mean():.1f}% of FPs, {100 * H['frag'].mean():.3f}% of hits "
          f"({int(H['frag'].sum()):,})")
    for k, qs in (("vis", [5, 10, 25, 50]), ("score", [5, 10, 25, 50]), ("area", [10, 25, 50])):
        print(f"  {k:5s} hits p{qs}: {np.nanpercentile(H[k], qs).round(3)}   "
              f"FPs: {np.nanpercentile(F[k], qs).round(3)}")
    # what each simple rule would remove: share of FPs vs share of hits
    rules = {f"vis<{v}": (H["vis"] < v, F["vis"] < v) for v in (4, 6, 8, 10)}
    rules.update({f"score<{t}": (H["score"] < t, F["score"] < t) for t in (0.6, 0.7, 0.8, 0.85)})
    print("rule: FPs removed / hits removed (hits lost = misses added)")
    tab = {}
    for name, (h, f) in rules.items():
        tab[name] = {"fp_removed": float(f.mean()), "hits_removed": float(h.mean()),
                     "fp_n": int(f.sum()), "hit_n": int(h.sum())}
        print(f"  {name:11s} {100 * f.mean():5.1f}% of FPs ({int(f.sum()):,})  /  "
              f"{100 * h.mean():5.2f}% of hits ({int(h.sum()):,})")
    print("FP share by difficulty:", {d: f"{100 * v['fp'] / max(v['hit'] + v['fp'], 1):.2f}%"
                                      for d, v in sorted(by_diff.items())})
    (OUT / f"fp_character_{a.pool}.json").write_text(json.dumps({
        "generated_by": "figs/fp_character.py", "pool": a.pool,
        "n_hits": nh, "n_fps": nf,
        "fp_kinds": {k: int((kinds == k).sum()) for k in np.unique(kinds)},
        "fp_on_reproj": float(F["on_reproj"].mean()),
        "no_overlap_on_reproj": float(F["on_reproj"][nov].mean()),
        "no_overlap_reproj_unlabelled": float(F["reproj_unlabelled"][nov].mean()),
        "fragment_rule": {"fp_removed": float(F["frag"].mean()), "hits_removed": float(H["frag"].mean())},
        "rules": tab, "by_difficulty": by_diff,
        "quantiles": {g: {k: np.nanpercentile(v, [5, 10, 25, 50, 75]).tolist()
                          for k, v in (H if g == "hit" else F).items()
                          if k in ("vis", "score", "area")} for g in ("hit", "fp")},
    }, indent=1))


if __name__ == "__main__":
    main()
