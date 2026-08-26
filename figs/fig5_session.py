#!/usr/bin/env python3
"""
Build small, LUC3D-loadable sessions out of SLAP-2M, for Fig 6's app panels.

Fig 6 needs two things the app itself must produce: the rig rendered upright in
LUC3D's own 3D viewport, and multi-camera frames with real instance overlays at
contrasting difficulty. Both need the data loaded as a session, so this trims a short
window out of a real SLAP-2M recording and writes the folder layout the app's
per-camera loader expects:

    <out>/calibration.toml
    <out>/<cam>/<cam>.slp
    <out>/<cam>/<cam>.mp4          (unless --no-video)

Uses the PROOFREAD per-camera labels (`*.predictions.proofread.slp`), which is the
dataset's actual product; only 6 of the 8 cameras have them (`side`/`sideL` do not),
and that is the same 6-camera set the benchmark uses.

Frame-accurate: the video is decoded from frame 0 rather than input-seeking, because a
keyframe-snapped seek would shift every label relative to the remapped .slp. Handles
both user and predicted instances, unlike figs/build_fig_session.py which asserts an
all-predicted source.

Usage:
  /root/vast/eric/luc3d-bench/lp3d_env/bin/python figs/fig5_session.py \\
      --session 10072022145420 --start 6000 --frames 240
"""
from __future__ import annotations

import argparse
import csv
import glob
import json
import os
import shutil
import subprocess

import h5py
import numpy as np

BENCH = "/root/vast/eric/luc3d-bench"
MASTER = f"{BENCH}/outputs/_multi_master.tsv"
SLAP_ROOT = "/root/talmolab-smb/eric/slap_2m"
CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
HERE = os.path.dirname(os.path.abspath(__file__))


def find_session(sid):
    for row in csv.DictReader(open(MASTER), delimiter="\t"):
        if row["session"] == sid:
            return row
    raise SystemExit(f"session {sid} not in {MASTER}")


def trim_slp(src, dst, start, n, video_rel):
    """
    Rewrite a .slp keeping frames [start, start+n), reindexed to 0..n-1.

    Every id space is rebuilt from scratch (frame_id, instance_id, point ranges)
    rather than offset, so the output holds no dangling reference into the frames we
    dropped. `from_predicted` is cleared for the same reason. User (`points`) and
    predicted (`pred_points`) instances are both carried through -- a proofread file
    contains user instances, which build_fig_session.py's version refuses.
    """
    with h5py.File(src, "r") as f:
        frames = f["frames"][:]
        instances = f["instances"][:]
        pred_points = f["pred_points"][:]
        points = f["points"][:]
        meta_json = f["metadata"].attrs["json"]
        tracks_json = f["tracks_json"][:]
        videos_json = f["videos_json"][:]
        frames_dt, inst_dt = f["frames"].dtype, f["instances"].dtype
        pp_dt, pt_dt = f["pred_points"].dtype, f["points"].dtype

    end = start + n
    keep = np.where((frames["frame_idx"] >= start) & (frames["frame_idx"] < end))[0]
    keep = keep[np.argsort(frames["frame_idx"][keep])]
    if not len(keep):
        raise SystemExit(f"no frames in [{start},{end}) in {os.path.basename(src)}")

    out_frames = np.zeros(len(keep), dtype=frames_dt)
    inst_rows, pp_rows, pt_rows = [], [], []
    inst_cursor = pp_cursor = pt_cursor = 0

    for out_i, fi in enumerate(keep):
        fr = frames[fi]
        s, e = int(fr["instance_id_start"]), int(fr["instance_id_end"])
        block = instances[s:e]
        out_frames[out_i]["frame_id"] = out_i
        out_frames[out_i]["video"] = 0
        out_frames[out_i]["frame_idx"] = int(fr["frame_idx"]) - start
        out_frames[out_i]["instance_id_start"] = inst_cursor
        out_frames[out_i]["instance_id_end"] = inst_cursor + len(block)
        for row in block:
            new = np.zeros(1, dtype=inst_dt)[0]
            for name in inst_dt.names:
                new[name] = row[name]
            new["instance_id"] = inst_cursor
            new["frame_id"] = out_i
            new["from_predicted"] = -1
            ps, pe = int(row["point_id_start"]), int(row["point_id_end"])
            if int(row["instance_type"]) == 1:        # predicted
                new["point_id_start"] = pp_cursor
                new["point_id_end"] = pp_cursor + (pe - ps)
                pp_rows.append(pred_points[ps:pe])
                pp_cursor += pe - ps
            else:                                     # user
                new["point_id_start"] = pt_cursor
                new["point_id_end"] = pt_cursor + (pe - ps)
                pt_rows.append(points[ps:pe])
                pt_cursor += pe - ps
            inst_rows.append(new)
            inst_cursor += 1

    out_inst = np.array(inst_rows, dtype=inst_dt) if inst_rows else np.zeros(0, inst_dt)
    out_pp = np.concatenate(pp_rows) if pp_rows else np.zeros(0, dtype=pp_dt)
    out_pt = np.concatenate(pt_rows) if pt_rows else np.zeros(0, dtype=pt_dt)

    vj = json.loads(videos_json[0].decode())
    vj["filename"] = video_rel
    if "backend" in vj:
        vj["backend"]["filename"] = video_rel
        if "shape" in vj["backend"]:
            vj["backend"]["shape"][0] = len(out_frames)
    vj_b = json.dumps(vj).encode()

    with h5py.File(dst, "w") as g:
        g.create_dataset("frames", data=out_frames, dtype=frames_dt)
        g.create_dataset("instances", data=out_inst, dtype=inst_dt)
        g.create_dataset("pred_points", data=out_pp, dtype=pp_dt, compression="gzip")
        g.create_dataset("points", data=out_pt, dtype=pt_dt, compression="gzip")
        g.create_dataset("videos_json", data=np.array([vj_b], dtype=f"|S{len(vj_b)}"))
        g.create_dataset("tracks_json", data=tracks_json)
        md = g.create_group("metadata")
        md.attrs["json"] = meta_json
    return len(out_frames), len(out_inst), len(out_pt), len(out_pp)


def trim_video(src, dst, start, n):
    cmd = ["ffmpeg", "-v", "error", "-y", "-i", src,
           "-vf", f"select='between(n\\,{start}\\,{start + n - 1})',setpts=N/FRAME_RATE/TB",
           "-frames:v", str(n), "-c:v", "libx264", "-preset", "veryfast", "-crf", "20",
           "-pix_fmt", "yuv420p", "-g", "30", "-movflags", "+faststart", dst]
    subprocess.run(cmd, check=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--session", required=True)
    ap.add_argument("--start", type=int, default=6000)
    ap.add_argument("--frames", type=int, default=240)
    ap.add_argument("--out", default=None)
    ap.add_argument("--no-video", action="store_true",
                    help="labels + calibration only; enough for the 3D viewport panel")
    args = ap.parse_args()

    row = find_session(args.session)
    sdir = os.path.join(SLAP_ROOT, os.path.dirname(row["points_3D"]))
    out = args.out or os.path.join(HERE, f"session-slap-{args.session}")
    os.makedirs(out, exist_ok=True)

    calib = os.path.join(sdir, "calibration.toml")
    if not os.path.exists(calib):
        raise SystemExit(f"no calibration.toml in {sdir}")
    shutil.copy(calib, os.path.join(out, "calibration.toml"))

    made = []
    for cam in CAMS:
        slps = glob.glob(f"{sdir}/{cam}/*proofread.slp")
        if not slps:
            print(f"  {cam}: no proofread .slp, skipping")
            continue
        cdir = os.path.join(out, cam)
        os.makedirs(cdir, exist_ok=True)
        nf, ni, nu, npd = trim_slp(slps[0], os.path.join(cdir, f"{cam}.slp"),
                                   args.start, args.frames, f"{cam}.mp4")
        if not args.no_video:
            # The master sheet's own path first. Do NOT assume the CRF the .slp
            # filename mentions: these sessions are labelled against a CRF30 encode
            # that is not always the file still on disk (CRF12 often is), and the two
            # are frame-aligned re-encodes of the same source.
            cand = []
            mv = row.get(f"{cam}_video") or ""
            if mv:
                cand.append(mv if os.path.isabs(mv) else os.path.join(SLAP_ROOT, mv))
            cand += sorted(glob.glob(f"{sdir}/{cam}/*_denoised.mp4"))
            vids = [v for v in cand if os.path.exists(v)]
            if vids:
                trim_video(vids[0], os.path.join(cdir, f"{cam}.mp4"),
                           args.start, args.frames)
                print(f"  {cam}: video from {os.path.basename(vids[0])}")
            else:
                print(f"  {cam}: NO VIDEO FOUND (looked in master sheet + *_denoised.mp4)")
        made.append(cam)
        print(f"  {cam}: {nf} frames, {ni} instances ({nu} user pts, {npd} pred pts)")

    print(f"\n[session] {out}  cameras: {', '.join(made)}")
    print(f"  difficulty {row['difficulty']}, bedding {row['bedding']}, "
          f"{row['animals']} animals")


if __name__ == "__main__":
    main()
