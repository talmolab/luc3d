#!/usr/bin/env python3
"""
Build a SMALL, self-contained multi-camera session for the paper figures.

Source: _bugdata/20260605_133431-HardFight_reencoded  (8 cameras, h264, 1280x1024,
60 fps, 36,000 frames, 3 mice, 15-node skeleton) + its per-camera SLEAP predictions
from _bugdata/20260605_133431-HardFight.

Why trim: the full session is ~2.4 GB of mp4 across 8 cameras. The figure only ever
shows a handful of frames, and the browser has to hold every video it loads, so we cut
a short window and remap the .slp frame indices onto it. The result loads in seconds
and can be committed to a scratch dir.

Window default S=24551, N=300 is the longest run in which ALL EIGHT cameras have >=3
detected instances, i.e. all three animals are visible in every view -- which is the
premise of the reprojection-aided-labeling figure.

Usage: python3 figs/build_fig_session.py [--start S] [--frames N] [--out DIR]
"""
import argparse
import json
import os
import shutil
import subprocess
import sys

import h5py
import numpy as np

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
SRC_VID = os.path.join(REPO, "_bugdata", "20260605_133431-HardFight_reencoded")
SRC_SLP = os.path.join(REPO, "_bugdata", "20260605_133431-HardFight")
CAMS = ["Camera0_mid", "Camera1_topB", "Camera2_topC", "Camera3_sideC",
        "Camera4_topR", "Camera5_topL", "Camera6_sideL", "Camera7_sideR"]


def find(d, ext):
    hits = [f for f in sorted(os.listdir(d)) if f.endswith(ext)]
    if not hits:
        raise SystemExit(f"no {ext} in {d}")
    return os.path.join(d, hits[0])


def trim_video(src, dst, start, n):
    """Frame-accurate trim. Decodes from frame 0 on purpose -- input seeking on
    h264 lands on the nearest keyframe, which would silently shift every label by
    up to a GOP relative to the .slp we remap alongside it."""
    cmd = [
        "ffmpeg", "-v", "error", "-y", "-i", src,
        "-vf", f"select='between(n\\,{start}\\,{start + n - 1})',setpts=N/FRAME_RATE/TB",
        "-frames:v", str(n),
        "-c:v", "libx264", "-preset", "medium", "-crf", "18",
        "-pix_fmt", "yuv420p", "-g", "30", "-movflags", "+faststart",
        dst,
    ]
    subprocess.run(cmd, check=True)


def trim_slp(src, dst, start, n, video_rel):
    """Rewrite a SLEAP .slp keeping only frames [start, start+n), reindexed to 0..n-1.

    Every id space is rebuilt from scratch (frame_id, instance_id, point ranges)
    rather than offset, so the output has no dangling references into the frames we
    dropped. `from_predicted` is cleared for the same reason.
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

    out_frames = np.zeros(len(keep), dtype=frames_dt)
    inst_rows, pp_rows = [], []
    inst_cursor = 0
    pp_cursor = 0

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
            # instance_type 1 == predicted -> pred_points; 0 == user -> points.
            # This source project is 100% predicted; assert rather than guess.
            if int(row["instance_type"]) != 1:
                raise SystemExit("user instance in source .slp -- extend trim_slp")
            new["point_id_start"] = pp_cursor
            new["point_id_end"] = pp_cursor + (pe - ps)
            pp_rows.append(pred_points[ps:pe])
            pp_cursor += pe - ps
            inst_rows.append(new)
            inst_cursor += 1

    out_inst = np.array(inst_rows, dtype=inst_dt) if inst_rows else np.zeros(0, dtype=inst_dt)
    out_pp = np.concatenate(pp_rows) if pp_rows else np.zeros(0, dtype=pp_dt)

    # videos_json: repoint at the trimmed file and correct the frame count, so the
    # app's own frame-count checks agree with the mp4 next to it.
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
        g.create_dataset("points", data=np.zeros(0, dtype=pt_dt), dtype=pt_dt)
        g.create_dataset("videos_json", data=np.array([vj_b], dtype=f"|S{len(vj_b)}"))
        g.create_dataset("tracks_json", data=tracks_json)
        md = g.create_group("metadata")
        md.attrs["json"] = meta_json
    return len(out_frames), len(out_inst), len(out_pp)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--start", type=int, default=24551)
    ap.add_argument("--frames", type=int, default=300)
    ap.add_argument("--out", default=os.path.join(REPO, "figs", "session"))
    ap.add_argument("--cams", default=",".join(CAMS))
    args = ap.parse_args()

    cams = args.cams.split(",")
    out = args.out
    if os.path.isdir(out):
        shutil.rmtree(out)
    os.makedirs(out)
    shutil.copy(os.path.join(SRC_VID, "calibration.toml"),
                os.path.join(out, "calibration.toml"))

    for cam in cams:
        os.makedirs(os.path.join(out, cam))
        src_mp4 = find(os.path.join(SRC_VID, cam), ".mp4")
        src_slp = find(os.path.join(SRC_SLP, cam), ".slp")
        dst_mp4 = os.path.join(out, cam, f"{cam}.mp4")
        dst_slp = os.path.join(out, cam, f"{cam}.slp")
        print(f"[{cam}] video ...", flush=True)
        trim_video(src_mp4, dst_mp4, args.start, args.frames)
        nf, ni, npt = trim_slp(src_slp, dst_slp, args.start, args.frames, f"{cam}.mp4")
        print(f"[{cam}] {nf} frames, {ni} instances, {npt} points, "
              f"{os.path.getsize(dst_mp4)/1e6:.1f} MB mp4", flush=True)

    print("\nsession at", out)


if __name__ == "__main__":
    sys.exit(main())
