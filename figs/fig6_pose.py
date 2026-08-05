#!/usr/bin/env python3
"""
Derive a CANONICAL mean 3D pose from the proofread reconstructions, and add it to
figs/out/fig6.json as `mean_pose`.

Fig 6b is the skeleton definition. Drawing it by hand would make it a cartoon; this
instead measures it. Every (frame, animal) pose is translated to its own centroid and
then rotated into a common body frame by Kabsch alignment against a running
reference, and the per-node median is taken. The result is a real average mouse in
this dataset, with the node positions and the 14 edges both coming from the files.

Body frame: the reference pose is itself aligned so that +x runs nose -> tail-tip and
+z is the arena's up, so the projections Fig 6b draws (x-y = top view, x-z = side
view) are anatomically meaningful rather than an arbitrary orientation.

Run with the bench env:
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig6_pose.py
"""
from __future__ import annotations

import argparse
import glob
import json
import os

import h5py
import numpy as np

BM_ROOT = "/root/vast/eric/BMimica"
HERE = os.path.dirname(os.path.abspath(__file__))
FIG6 = os.path.join(HERE, "out", "fig6.json")


def kabsch(P, Q):
    """Rotation R minimising |R P - Q| for centred point sets (no scale, no reflection)."""
    H = P.T @ Q
    U, _, Vt = np.linalg.svd(H)
    d = np.sign(np.linalg.det(Vt.T @ U.T))
    D = np.diag([1.0, 1.0, d])
    return Vt.T @ D @ U.T


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", default=None)
    ap.add_argument("--stride", type=int, default=200)
    ap.add_argument("--iters", type=int, default=3)
    args = ap.parse_args()

    with open(FIG6) as f:
        payload = json.load(f)
    nodes = payload["skeleton"]["nodes"]

    sid = args.session or next(s["session"] for s in payload["bmimica"]
                               if s.get("frames"))
    p3 = glob.glob(f"{BM_ROOT}/{sid}/*points3d*.h5")[0]
    with h5py.File(p3) as f:
        X = f["tracks"][::args.stride]           # (F, A, N, 3)
        names = [n.decode() if isinstance(n, bytes) else str(n)
                 for n in f["node_names"][:]]
    F, A, N, _ = X.shape
    poses = X.reshape(-1, N, 3)
    poses = poses[~np.isnan(poses).any(axis=(1, 2))]
    if len(poses) < 50:
        raise SystemExit(f"only {len(poses)} complete poses in {sid}")

    # centre every pose on its own centroid
    poses = poses - poses.mean(axis=1, keepdims=True)

    # iterate: align all to the reference, re-average, repeat (generalised Procrustes)
    ref = poses[0].copy()
    for _ in range(args.iters):
        acc = np.zeros_like(ref)
        for p in poses:
            acc += kabsch(p, ref) @ p.T if False else (kabsch(p, ref) @ p.T).T
        ref = acc / len(poses)
        ref -= ref.mean(axis=0, keepdims=True)
    aligned = np.stack([(kabsch(p, ref) @ p.T).T for p in poses], 0)
    mean_pose = np.median(aligned, axis=0)

    # Put the mean pose in an anatomical frame: +x along nose -> tail tip.
    idx = {n: i for i, n in enumerate(names)}
    if "Nose" in idx and "TailTip" in idx:
        axis = mean_pose[idx["TailTip"]] - mean_pose[idx["Nose"]]
        axis = axis / np.linalg.norm(axis)
        # rotate `axis` onto +x about the shortest arc
        target = np.array([1.0, 0.0, 0.0])
        v = np.cross(axis, target)
        c = float(axis @ target)
        if np.linalg.norm(v) > 1e-9:
            vx = np.array([[0, -v[2], v[1]], [v[2], 0, -v[0]], [-v[1], v[0], 0]])
            R = np.eye(3) + vx + vx @ vx * (1.0 / (1.0 + c))
            mean_pose = (R @ mean_pose.T).T
        # and put the ears above the trunk in +z, so the side view is upright
        if "Ear_L" in idx and "Ear_R" in idx and "Trunk" in idx:
            ear = (mean_pose[idx["Ear_L"]] + mean_pose[idx["Ear_R"]]) / 2
            if ear[2] < mean_pose[idx["Trunk"]][2]:
                mean_pose[:, 1:] *= -1.0        # flip about the x axis

    # scale report: nose -> trunk, the length the figures quote
    span = None
    if "Nose" in idx and "Trunk" in idx:
        span = float(np.linalg.norm(mean_pose[idx["Nose"]] - mean_pose[idx["Trunk"]]))

    payload["mean_pose"] = dict(
        session=sid, poses_used=int(len(poses)), stride=int(args.stride),
        node_names=names,
        # metres in the proofread frame -> report mm, which is what the text quotes
        xyz_mm=[[float(v) * 1000.0 for v in p] for p in mean_pose],
        nose_to_trunk_mm=(span * 1000.0 if span else None),
        note=("Generalised-Procrustes median over complete proofread poses; "
              "+x = nose->tail, +z = up. Node order matches node_names."),
    )
    # the skeleton's edges are indexed into the .slp node list; re-index onto the
    # points3d node order so Fig 6b can use one array for both.
    slp_nodes = payload["skeleton"]["nodes"]
    remap = []
    for a, b in payload["skeleton"]["edges"]:
        na, nb = slp_nodes[a], slp_nodes[b]
        if na in names and nb in names:
            remap.append([names.index(na), names.index(nb)])
    payload["mean_pose"]["edges"] = remap

    # ---- example two-animal configurations for Fig 6c -----------------------
    # Chosen by MEASURED inter-animal distance, not by behaviour label: there are no
    # behaviour annotations in this corpus, so the panel reports the geometry it can
    # verify (how close the animals are, and their relative body-axis angle) and
    # leaves the naming of the behaviour to a future annotated version.
    with h5py.File(p3) as f:
        Xa = f["tracks"][::args.stride]                # (F, A, N, 3)
    trunk = idx.get("Trunk", 0)
    nose = idx.get("Nose", 0)
    tail = idx.get("TailTip", 0)
    ok = ~np.isnan(Xa).any(axis=(1, 2, 3))
    fr = np.where(ok)[0]
    if len(fr) and Xa.shape[1] >= 2:
        d = np.linalg.norm(Xa[fr, 0, trunk] - Xa[fr, 1, trunk], axis=1) * 1000.0
        def ang(i):
            out = []
            for a in range(2):
                v = Xa[i, a, tail] - Xa[i, a, nose]
                out.append(v / (np.linalg.norm(v) + 1e-12))
            return float(np.degrees(np.arccos(np.clip(out[0] @ out[1], -1, 1))))
        # three configurations across the observed range of proximity
        picks = []
        for q in (2, 25, 80):
            j = int(np.argmin(np.abs(d - np.percentile(d, q))))
            picks.append(dict(
                frame_index=int(fr[j] * args.stride),
                trunk_distance_mm=float(d[j]),
                body_axis_angle_deg=ang(fr[j]),
                percentile=q,
                animals=[[[float(v) * 1000.0 for v in pt] for pt in Xa[fr[j], a]]
                         for a in range(2)]))
        payload["examples_3d"] = dict(
            session=sid, node_names=names, edges=remap, picks=picks,
            trunk_distance_mm_percentiles={str(q): float(np.percentile(d, q))
                                          for q in (1, 5, 25, 50, 75, 95, 99)},
            note=("Frames selected by measured trunk-to-trunk distance percentile. "
                  "NO behaviour labels exist for this corpus -- the panel must not "
                  "assert 'mounting'/'sniffing' without annotation."))
        print("examples: " + ", ".join(
            f"{q['trunk_distance_mm']:.0f} mm / {q['body_axis_angle_deg']:.0f} deg"
            for q in picks))

    with open(FIG6, "w") as f:
        json.dump(payload, f, indent=1)
    print(f"[{sid}] {len(poses)} poses -> canonical mean pose, "
          f"nose-to-trunk {span * 1000:.1f} mm, {len(remap)} edges")
    print(f"[json] {FIG6}")


if __name__ == "__main__":
    main()
