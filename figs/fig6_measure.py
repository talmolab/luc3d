#!/usr/bin/env python3
"""
Survey the datasets Fig 6 presents, from the data on disk. Nothing here is typed in
by hand -- every count comes from reading the files.

Run with the bench env (needs cv2/toml for the calibration):
    /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig6_measure.py

Two corpora:
  BMimica  /root/vast/eric/BMimica/<session>/
           5 cameras, 2 mice, per-session proofread 3D (*points3d*.h5, no NaNs).
  SLAP-2M  /root/talmolab-smb/eric/slap_2m/<date>/<session>/
           up to 8 cameras (back, backL, mid, midL, side, sideL, top, topL),
           1-4 mice, points3d.h5 plus per-camera *.proofread.slp where a view has
           been proofread.

What is collected, per session: frame count, animal count, frame rate, which
cameras are present, whether a proofread 3D reconstruction exists, and how many
per-camera files are marked proofread. Plus, once per rig, the camera geometry
(world positions from the calibration extrinsics) and the skeleton (nodes + edges)
-- which is what Fig 6a and Fig 6b are drawn from.

`hours` is frames / frame_rate, i.e. RECORDED duration of the reconstructed range,
not wall-clock session length.

Writes figs/out/fig6.json.
"""
from __future__ import annotations

import argparse
import glob
import json
import os
import sys

import h5py
import numpy as np

BENCH = "/root/vast/eric/luc3d-bench/scripts/bartul"
sys.path.insert(0, BENCH)
from build_gt_reproj import load_calibration, SERIALS  # noqa: E402

BM_ROOT = "/root/vast/eric/BMimica"
SLAP_ROOT = "/root/talmolab-smb/eric/slap_2m"
SLAP_CAMS = ["back", "backL", "mid", "midL", "side", "sideL", "top", "topL"]
HERE = os.path.dirname(os.path.abspath(__file__))
OUT = os.path.join(HERE, "out", "fig6.json")


def rig_from_calibration(toml_path, names=None):
    """Camera world positions (-R^T t) and optical axes, for the rig schematic."""
    cams = load_calibration(toml_path)
    out = {}
    for name, c in cams.items():
        if names and name not in names:
            continue
        R = np.asarray(c["R"])
        t = np.asarray(c["t"]).reshape(3)
        pos = -R.T @ t
        axis = R.T @ np.array([0.0, 0.0, 1.0])
        out[name] = dict(pos=[float(v) for v in pos],
                         axis=[float(v) for v in axis],
                         fx=float(c["K"][0][0]), fy=float(c["K"][1][1]))
    return out


def skeleton_from_slp(slp_path):
    with h5py.File(slp_path) as f:
        md = json.loads(f["metadata"].attrs["json"])
    nodes = [n["name"] for n in md["nodes"]]
    sk = md["skeletons"][0]
    edges = sorted({(min(l["source"], l["target"]), max(l["source"], l["target"]))
                    for l in sk["links"]})
    edges = [e for e in edges if e[0] != e[1]]
    return dict(nodes=nodes, edges=[[int(a), int(b)] for a, b in edges])


def scan_bmimica():
    sessions = []
    for sd in sorted(glob.glob(f"{BM_ROOT}/*")):
        sid = os.path.basename(sd)
        if not (os.path.isdir(sd) and sid[:1].isdigit()):
            continue
        p3 = glob.glob(f"{sd}/*points3d*.h5")
        calib = glob.glob(f"{sd}/calibration/*_calibration.toml")
        cams = [c for c in SERIALS if glob.glob(f"{sd}/{c}/*.slp")]
        rec = dict(session=sid, cameras=len(cams), camera_names=cams,
                   has_calibration=bool(calib), has_proofread_3d=bool(p3))
        if p3:
            try:
                with h5py.File(p3[0]) as f:
                    tr = f["tracks"]
                    rec["frames"] = int(tr.shape[0])
                    rec["animals"] = int(tr.shape[1])
                    rec["nodes"] = int(tr.shape[2])
                    fr = f.get("recording_frame_rate")
                    rec["fps"] = float(fr[()]) if fr is not None else None
                    # A fully proofread reconstruction has no missing keypoints.
                    # Sample rather than read all of it: these are ~180k x 2 x 15 x 3.
                    step = max(1, tr.shape[0] // 2000)
                    samp = tr[::step]
                    rec["nan_frac"] = float(np.isnan(samp).mean())
            except Exception as e:                                     # noqa: BLE001
                rec["error"] = f"{type(e).__name__}: {e}"
        sessions.append(rec)
    return sessions


def scan_slap(max_sessions=0):
    sessions = []
    for dd in sorted(glob.glob(f"{SLAP_ROOT}/20*")):
        if not os.path.isdir(dd):
            continue
        for sd in sorted(glob.glob(f"{dd}/*")):
            if not os.path.isdir(sd):
                continue
            sid = os.path.basename(sd)
            if not sid[:1].isdigit():
                continue
            cams = [c for c in SLAP_CAMS if os.path.isdir(f"{sd}/{c}")]
            if not cams:
                continue
            p3 = [p for p in (f"{sd}/points3d.h5", f"{sd}/aligned_points3d.h5")
                  if os.path.exists(p)]
            proof = 0
            for c in cams:
                if glob.glob(f"{sd}/{c}/*proofread*.slp"):
                    proof += 1
            rec = dict(session=sid, date=os.path.basename(dd),
                       cameras=len(cams), camera_names=cams,
                       has_calibration=os.path.exists(f"{sd}/calibration.toml"),
                       has_proofread_3d=bool(p3), proofread_camera_files=proof)
            if p3:
                try:
                    with h5py.File(p3[0]) as f:
                        tr = f["tracks"]
                        rec["frames"] = int(tr.shape[0])
                        rec["animals"] = int(tr.shape[1])
                        rec["nodes"] = int(tr.shape[2])
                        step = max(1, tr.shape[0] // 1000)
                        rec["nan_frac"] = float(np.isnan(tr[::step]).mean())
                except Exception as e:                                 # noqa: BLE001
                    rec["error"] = f"{type(e).__name__}: {e}"
            sessions.append(rec)
            if max_sessions and len(sessions) >= max_sessions:
                return sessions
    return sessions


def summarise(name, sessions, default_fps):
    ok = [s for s in sessions if s.get("frames")]
    frames = sum(s["frames"] for s in ok)
    fps_vals = [s["fps"] for s in ok if s.get("fps")]
    fps = fps_vals[0] if fps_vals else default_fps
    animals = sorted({s["animals"] for s in ok if s.get("animals")})
    cams = sorted({s["cameras"] for s in sessions if s.get("cameras")})
    return dict(
        name=name, sessions_total=len(sessions), sessions_with_3d=len(ok),
        frames_total=int(frames), fps=fps,
        hours=round(frames / fps / 3600.0, 2) if fps else None,
        animals_range=animals, cameras_range=cams,
        # "proofread" here means: a 3D reconstruction exists AND the sampled
        # keypoints are complete. Reported per corpus so the table can be honest
        # about partial coverage instead of implying everything is finished.
        fully_complete_3d=sum(1 for s in ok if s.get("nan_frac", 1) == 0.0),
        median_nan_frac=(round(float(np.median([s.get("nan_frac", np.nan)
                                                for s in ok])), 5) if ok else None),
    )


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--slap-max", type=int, default=0,
                    help="cap SLAP-2M sessions scanned (0 = all; the share is on SMB)")
    ap.add_argument("--out", default=OUT)
    args = ap.parse_args()

    print("scanning BMimica ...")
    bm = scan_bmimica()
    print(f"  {len(bm)} session dirs, {sum(1 for s in bm if s.get('frames'))} with 3D")
    print("scanning SLAP-2M ...")
    slap = scan_slap(args.slap_max)
    print(f"  {len(slap)} session dirs, {sum(1 for s in slap if s.get('frames'))} with 3D")

    rigs, skel = {}, None
    bm_ok = next((s for s in bm if s.get("has_calibration")), None)
    if bm_ok:
        sd = f"{BM_ROOT}/{bm_ok['session']}"
        rigs["BMimica"] = rig_from_calibration(
            glob.glob(f"{sd}/calibration/*_calibration.toml")[0], set(SERIALS))
        slps = glob.glob(f"{sd}/{bm_ok['camera_names'][0]}/*.slp")
        if slps:
            skel = skeleton_from_slp(slps[0])
    slap_ok = next((s for s in slap if s.get("has_calibration")), None)
    if slap_ok:
        sd = f"{SLAP_ROOT}/{slap_ok['date']}/{slap_ok['session']}"
        try:
            rigs["SLAP-2M"] = rig_from_calibration(f"{sd}/calibration.toml")
        except Exception as e:                                          # noqa: BLE001
            print(f"  SLAP calibration: {type(e).__name__}: {e}")

    payload = dict(
        corpora=[summarise("BMimica", bm, 150.0), summarise("SLAP-2M", slap, 50.0)],
        rigs=rigs, skeleton=skel,
        bmimica=bm, slap2m=slap,
        roots=dict(bmimica=BM_ROOT, slap2m=SLAP_ROOT),
    )
    os.makedirs(os.path.dirname(args.out), exist_ok=True)
    with open(args.out, "w") as f:
        json.dump(payload, f, indent=1)
    for c in payload["corpora"]:
        print(f"[{c['name']}] {c['sessions_with_3d']}/{c['sessions_total']} sessions "
              f"with 3D, {c['frames_total']:,} frames, {c['hours']} h, "
              f"animals {c['animals_range']}, cameras {c['cameras_range']}, "
              f"complete-3D {c['fully_complete_3d']}")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
