#!/usr/bin/env python3
"""Fig 10 scorer: bench output JSON + gt_perm.npy sidecar -> identity metrics.

Every detection fed to the tracker was synthesized from a known source animal
(fig10_prep.py records slot->animal per (cam, frame) in gt_perm.npy), so scoring
is exact — no spatial matching step, a detection IS its GT.

Metrics:
  idf1        cross-view IDF1: global identity<->animal bipartite match
              (Hungarian, maximizing shared detections), IDF1 = 2*IDTP/(P+G)
  accuracy    fraction of assigned detections whose identity maps to the
              source animal under that same global matching
  switches    per GT animal, the per-frame majority identity across views;
              count changes between consecutive observed frames; summed
  sw_per_100k switches per 100k GT detections (NOT camera-frames: the
              denominator is n_gt, the count of (cam, frame, slot) GT
              detections; JSON key kept as sw_per_100k for compatibility)
  coverage    assigned detections / GT detections

Usage:
  fig10_score.py --bench out.json --gt-dir <prep out dir> [--json result.json]
"""
import argparse, json, re
import numpy as np
from scipy.optimize import linear_sum_assignment


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--bench', required=True)
    ap.add_argument('--gt-dir', required=True)
    ap.add_argument('--json', default=None)
    args = ap.parse_args()

    bench = json.load(open(args.bench))
    gt = np.load(f'{args.gt_dir}/gt_perm.npy')          # (C, F, A) int16
    meta = json.load(open(f'{args.gt_dir}/meta.json'))
    C, F, A = gt.shape
    # Map camera NAME -> gt row by the camera's own index (cam_4 -> row 3), not
    # by enumeration order — the bench may run a SUBSET of cameras (C7 cells).
    cam_idx = {name: int(name.rsplit('_', 1)[1]) - 1 for name in bench['cameras']}
    # GT denominator counts only the cameras the tracker was actually given.
    used = sorted(cam_idx.values())
    gt = gt[used]
    cam_idx = {name: used.index(i) for name, i in cam_idx.items()}

    ids = sorted({i['id'] for i in bench['identities']})
    id_col = {v: k for k, v in enumerate(ids)}
    nI = len(ids)

    # overlap[identity, animal] = co-assigned detection count
    overlap = np.zeros((nI, A), np.int64)
    n_pred = 0
    unmatched_det = 0                                    # assignment on a GT-absent slot (bug canary)
    # majority identity per (animal, frame) for switch counting
    votes = {}                                           # (a, f) -> {identity: count}
    for fr in bench['frames']:
        f = fr['frame']
        for key, ident in fr['assignments']:
            cam, slot = key.rsplit(':', 1)
            ci, s = cam_idx[cam], int(slot)
            a = int(gt[ci, f, s])
            n_pred += 1
            if a < 0:
                unmatched_det += 1
                continue
            overlap[id_col[ident], a] += 1
            votes.setdefault((a, f), {}).setdefault(ident, 0)
            votes[(a, f)][ident] += 1

    n_gt = int((gt >= 0).sum())

    # global bipartite match, maximize overlap
    pad = max(nI, A)
    costm = np.zeros((pad, pad), np.int64)
    costm[:nI, :A] = -overlap
    ri, cjj = linear_sum_assignment(costm)
    id2animal = {}
    idtp = 0
    for r, c in zip(ri, cjj):
        if r < nI and c < A and overlap[r, c] > 0:
            id2animal[ids[r]] = c
            idtp += int(overlap[r, c])
    idf1 = 2 * idtp / max(1, n_pred + n_gt)
    matched = int(overlap.sum())                         # assigned dets with a GT animal
    correct = idtp
    accuracy = correct / max(1, matched)

    # per-frame grouping accuracy: Hungarian identity<->animal match WITHIN each
    # frame, then fraction of that frame's detections that agree. This is the
    # right metric when frames are sparse (C6 hand labels: labeled frames sit
    # ~400 apart, beyond the stale window, so temporal identity is re-drawn per
    # frame and only the cross-view grouping is meaningful).
    pf_correct = pf_total = 0
    frames_perfect = frames_scored = 0
    for fr in bench['frames']:
        f = fr['frame']
        ov = {}
        tot = 0
        for key, ident in fr['assignments']:
            cam, slot = key.rsplit(':', 1)
            a = int(gt[cam_idx[cam], f, int(slot)])
            if a < 0:
                continue
            ov[(ident, a)] = ov.get((ident, a), 0) + 1
            tot += 1
        if not tot:
            continue
        f_ids = sorted({k[0] for k in ov})
        padf = max(len(f_ids), A)
        cm = np.zeros((padf, padf), np.int64)
        for (ident, a), n in ov.items():
            cm[f_ids.index(ident), a] = -n
        rr, cc = linear_sum_assignment(cm)
        good = -int(cm[rr, cc].sum())
        pf_correct += good
        pf_total += tot
        frames_scored += 1
        if good == tot:
            frames_perfect += 1

    # switches: per animal, majority identity across views per frame
    switches = 0
    for a in range(A):
        prev = None
        for f in range(F):
            v = votes.get((a, f))
            if not v:
                continue
            # majority identity; vote ties break toward the HIGHER identity id
            # (the (count, id) sort key) — deterministic, unlike dict order.
            cur = max(v.items(), key=lambda kv: (kv[1], kv[0]))[0]
            if prev is not None and cur != prev:
                switches += 1
            prev = cur
    cam_frames = n_gt          # GT detections (per-camera, per-frame, per-slot);
    #                            sw_per_100k normalizes by THIS, not camera-frames.
    result = dict(
        idf1=round(idf1, 6), accuracy=round(accuracy, 6),
        grouping_accuracy=round(pf_correct / max(1, pf_total), 6),
        frames_perfectly_grouped=round(frames_perfect / max(1, frames_scored), 6),
        switches=switches, sw_per_100k=round(1e5 * switches / max(1, cam_frames), 3),
        coverage=round(matched / max(1, n_gt), 6),
        n_gt_dets=n_gt, n_pred_dets=n_pred, unmatched_det=unmatched_det,
        identities=nI, animals=A, frames=F,
        runtimeSeconds=bench.get('runtimeSeconds'), fps=round(bench.get('fps', 0), 1),
        condition={k: meta[k] for k in
                   ('noise_px', 'drop_instance', 'drop_node', 'occl_dist',
                    'occl_prob', 'com_only', 'seed')},
        session=meta['session'],
    )
    print(json.dumps(result, indent=1))
    if args.json:
        json.dump(result, open(args.json, 'w'), indent=1)


if __name__ == '__main__':
    main()
