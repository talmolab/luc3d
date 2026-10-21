#!/usr/bin/env python3
"""HardFight tracked and triangulated by LUC3D v1.0.5 (LUC3D-JS plan, 2026-10-20).

HardFight (20260605_133431, 8 cameras, 60 fps, 3 mice) ships no 3D. The Fig 1C / 2A
arena scenes and the Fig 3D identity-switch illustration used to build their 3D with
blender-images/hardfight_common.py's own Python association + NumPy DLT. Eric: "for these
visualizations we should be using luc3d triangulation and tracker". So:

  1. each camera's detections -> the tracker's input (`{cam}_predictions.h5`, `tracks`
     (1, F, S, 15, 2)), slots in exactly hardfight_common.Slp2D.at()'s order (score >= 0.5),
     so a slot index here is an index into at(frame) there;
  2. LUC3D v1.0.5's tracker (figs/fig3-bench/fig3_bench.mjs -> runCrossViewTracker, as Track
     All runs it; every node weight 1, the app default; at most 3 identities);
  3. each identity's views triangulated by LUC3D's DLT (lucid_geom: Camera.undistortPoint +
     triangulatePointDLT, Triangulate All's default; no view rejection, the app default).

Writes figs/out/hardfight_luc3d.npz (X (F, 3, 15, 3) calibration frame, NaN where unseen;
slots (F, 3, 8) slot index or -1) and figs/out/hardfight_luc3d.json (stamp + summary).

    POSE_DIR=/root/vast/eric/lucid-main-md56/pose blender-images/bpyenv/bin/python figs/hardfight_luc3d.py
"""
import json
import os
import subprocess
import sys

import h5py
import numpy as np
import toml

FIGS = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, FIGS)
sys.path.insert(0, os.path.join(FIGS, "blender-images"))
import hardfight_common as hf  # noqa: E402
import lucid_geom  # noqa: E402
from lucid_v105 import lucid_pose  # noqa: E402

OUT = os.path.join(FIGS, "out")
WORK = os.path.join(OUT, "tmp", "hardfight_luc3d")
NODE = os.environ.get("NODE", "/root/vast/eric/node26_env/bin/node")
NFR = 36000


def main():
    pose, LUCID = lucid_pose()
    os.makedirs(WORK, exist_ok=True)
    cal_path = os.path.join(hf.SESSION_SLP, "calibration.toml")
    slp = hf.load_all_slp()
    C = len(hf.CAMS)

    # 1. tracker input, slot order = Slp2D.at() order; slots = the most detections any
    #    camera has in one frame, so no detection is ever dropped
    per = {cam: [slp[cam].at(f) for f in range(NFR)] for cam in hf.CAMS}
    SLOTS = max(len(x) for cam in hf.CAMS for x in per[cam])
    print(f"slots: {SLOTS}", flush=True)
    raw = np.full((C, NFR, SLOTS, hf.N_NODES, 2), np.nan)
    for ci, cam in enumerate(hf.CAMS):
        for f in range(NFR):
            for s, d in enumerate(per[cam][f]):
                raw[ci, f, s] = d["pts"]
        with h5py.File(os.path.join(WORK, f"{cam}_predictions.h5"), "w") as h:
            h["tracks"] = raw[ci][None]
    print("tracker input written", flush=True)

    # 2. LUC3D's tracker
    out_json = os.path.join(WORK, "tracker.json")
    env = {**os.environ, "LUCID_ROOT": os.path.dirname(str(pose)),
           "PATH": os.path.dirname(NODE) + ":" + os.environ.get("PATH", "")}
    subprocess.run([NODE, os.path.join(FIGS, "fig3-bench", "fig3_bench.mjs"),
                    "--session-idx", "0", "--num-animals", str(hf.N_ANIMALS),
                    "--calibration", cal_path, "--pred-h5-dir", WORK,
                    "--cameras", ",".join(hf.CAMS), "--no-exclude-tail", "--out", out_json],
                   check=True, env=env, cwd=FIGS)
    tr = json.load(open(out_json))
    ids = sorted({i for fr in tr["frames"] for _, i in fr["assignments"]})
    if len(ids) > hf.N_ANIMALS:
        raise SystemExit(f"tracker made {len(ids)} identities")
    slots = np.full((NFR, hf.N_ANIMALS, C), -1, int)
    for fr in tr["frames"]:
        for key, ident in fr["assignments"]:
            cam, s = key.rsplit(":", 1)
            slots[fr["frame"], ids.index(ident), hf.CAMS.index(cam)] = int(s)

    # 3. LUC3D's DLT on each identity's views
    obs = np.full((C, NFR, hf.N_ANIMALS, hf.N_NODES, 2), np.nan)
    for a in range(hf.N_ANIMALS):
        for ci in range(C):
            m = slots[:, a, ci] >= 0
            obs[ci, m, a] = raw[ci, np.where(m)[0], slots[m, a, ci]]
    cal = toml.load(cal_path)
    byname = {v["name"]: v for k, v in cal.items() if k.startswith("cam_")}
    cameras = [dict(name=c, matrix=byname[c]["matrix"], distortions=byname[c]["distortions"],
                    rvec=byname[c]["rotation"], tvec=byname[c]["translation"],
                    size=byname[c]["size"]) for c in hf.CAMS]
    X, gstamp = lucid_geom.triangulate(cameras, obs.reshape(C, -1, 2))
    X = X.reshape(NFR, hf.N_ANIMALS, hf.N_NODES, 3)

    np.savez_compressed(os.path.join(OUT, "hardfight_luc3d.npz"), X=X, slots=slots)
    summ = dict(generated_by="figs/hardfight_luc3d.py", driver="figs/fig3-bench/fig3_bench.mjs + figs/lucid_geom.mjs",
                **LUCID, session="20260605_133431-HardFight", cameras=hf.CAMS, frames=NFR,
                identities=[str(i) for i in ids], tracker=dict(numAnimals=hf.N_ANIMALS, nodeWeights="all 1 (app default)",
                                                               runtimeSeconds=tr["runtimeSeconds"], fps=tr["fps"]),
                triangulation="LUC3D triangulatePointDLT on each identity's views, no view rejection (app default)",
                frames_with_identity=[int((slots[:, a] >= 0).any(1).sum()) for a in range(hf.N_ANIMALS)],
                finite_keypoints=int(np.isfinite(X[..., 0]).sum()))
    json.dump(summ, open(os.path.join(OUT, "hardfight_luc3d.json"), "w"), indent=1)
    print(json.dumps({k: summ[k] for k in ("lucid_commit", "identities", "tracker", "frames_with_identity", "finite_keypoints")}))


if __name__ == "__main__":
    main()
