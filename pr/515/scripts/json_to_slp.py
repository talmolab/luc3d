#!/usr/bin/env python3
"""
Convert mv-gui JSON export to a SLEAP .slp (HDF5) file.

Usage:
    python json_to_slp.py labels_export.slp.json output.slp

The JSON input is produced by mv-gui's "Export SLP Data" menu command.
The output is a valid SLEAP .slp file that can be opened in SLEAP desktop.

Requires: h5py, numpy
    pip install h5py numpy
"""

import json
import sys
import numpy as np

try:
    import h5py
except ImportError:
    print("Error: h5py is required. Install with: pip install h5py numpy")
    sys.exit(1)


def write_slp_data(data, h5):
    """Write SLEAP SLP data to an already-opened h5py.File.

    Args:
        data: dict with format_id, metadata, videos, tracks, frames, instances, points, etc.
        h5: an open h5py.File object (mode 'w')
    """
    # ---- /metadata group ----
    meta_group = h5.create_group("metadata")
    meta_group.attrs["format_id"] = data.get("format_id", 1.4)
    # Store as bytes — SLEAP calls .decode() on this attribute
    meta_group.attrs["json"] = np.bytes_(json.dumps(data["metadata"]))

    # ---- /videos_json — one entry per video (always created) ----
    videos = data.get("videos", [])
    video_jsons = [np.bytes_(json.dumps(v)) for v in videos]
    h5.create_dataset(
        "videos_json",
        data=video_jsons if video_jsons else np.array([], dtype="S1"),
        maxshape=(None,),
    )

    # ---- /tracks_json — one entry per track as [skeleton_idx, name] (always created) ----
    tracks = data.get("tracks", [])
    track_jsons = [np.bytes_(json.dumps([0, t])) for t in tracks]
    h5.create_dataset(
        "tracks_json",
        data=track_jsons if track_jsons else np.array([], dtype="S1"),
        maxshape=(None,),
    )

    # ---- /suggestions_json (always created) ----
    suggestions = data.get("suggestions", [])
    sugg_jsons = [np.bytes_(json.dumps(s)) for s in suggestions]
    h5.create_dataset(
        "suggestions_json",
        data=sugg_jsons if sugg_jsons else np.array([], dtype="S1"),
        maxshape=(None,),
    )

    # ---- /sessions_json ----
    sessions = data.get("sessions", [])
    if sessions:
        sess_jsons = [np.bytes_(json.dumps(s)) for s in sessions]
        h5.create_dataset("sessions_json", data=sess_jsons, maxshape=(None,))

    # ---- /frames structured dataset (always created) ----
    frames = data.get("frames", [])
    frame_dtype = np.dtype(
        [
            ("frame_id", np.uint64),
            ("video", np.uint32),
            ("frame_idx", np.uint64),
            ("instance_id_start", np.uint64),
            ("instance_id_end", np.uint64),
        ]
    )
    frame_data = np.zeros(len(frames), dtype=frame_dtype)
    for i, fr in enumerate(frames):
        frame_data[i] = (
            fr["frame_id"],
            fr["video"],
            fr["frame_idx"],
            fr["instance_id_start"],
            fr["instance_id_end"],
        )
    h5.create_dataset("frames", data=frame_data)

    # ---- /instances structured dataset (always created) ----
    instances = data.get("instances", [])
    inst_dtype = np.dtype(
        [
            ("instance_id", np.int64),
            ("instance_type", np.uint8),
            ("frame_id", np.uint64),
            ("skeleton", np.uint32),
            ("track", np.int32),
            ("from_predicted", np.int64),
            ("score", np.float32),
            ("point_id_start", np.uint64),
            ("point_id_end", np.uint64),
            ("tracking_score", np.float32),
        ]
    )
    inst_data = np.zeros(len(instances), dtype=inst_dtype)
    for i, inst in enumerate(instances):
        inst_data[i] = (
            inst["instance_id"],
            inst["instance_type"],
            inst["frame_id"],
            inst["skeleton"],
            inst["track"],
            inst["from_predicted"],
            inst["score"],
            inst["point_id_start"],
            inst["point_id_end"],
            inst["tracking_score"],
        )
    h5.create_dataset("instances", data=inst_data)

    # ---- /points structured dataset (always created) ----
    points = data.get("points", [])
    pt_dtype = np.dtype(
        [
            ("x", np.float64),
            ("y", np.float64),
            ("visible", np.bool_),
            ("complete", np.bool_),
        ]
    )
    pt_data = np.zeros(len(points), dtype=pt_dtype)
    for i, pt in enumerate(points):
        x = pt.get("x")
        y = pt.get("y")
        pt_data[i] = (
            np.nan if x is None else x,
            np.nan if y is None else y,
            pt.get("visible", False),
            pt.get("complete", False),
        )
    h5.create_dataset("points", data=pt_data)

    # ---- /pred_points structured dataset (always created) ----
    pred_points = data.get("pred_points", [])
    pred_pt_dtype = np.dtype(
        [
            ("x", np.float64),
            ("y", np.float64),
            ("visible", np.bool_),
            ("complete", np.bool_),
            ("score", np.float64),
        ]
    )
    pred_pt_data = np.zeros(len(pred_points), dtype=pred_pt_dtype)
    for i, pt in enumerate(pred_points):
        x = pt.get("x")
        y = pt.get("y")
        pred_pt_data[i] = (
            np.nan if x is None else x,
            np.nan if y is None else y,
            pt.get("visible", False),
            pt.get("complete", False),
            pt.get("score", 0.0),
        )
    h5.create_dataset("pred_points", data=pred_pt_data)


def convert_json_to_slp(json_path, slp_path):
    """Convert a LUCID JSON export to a SLEAP .slp HDF5 file."""
    with open(json_path, "r") as f:
        data = json.load(f)

    with h5py.File(slp_path, "w") as h5:
        write_slp_data(data, h5)

    frames = data.get("frames", [])
    instances = data.get("instances", [])
    points = data.get("points", [])
    pred_points = data.get("pred_points", [])
    print(f"Converted {json_path} -> {slp_path}")
    print(f"  Frames: {len(frames)}")
    print(f"  Instances: {len(instances)}")
    print(f"  Points: {len(points)}")
    print(f"  Predicted points: {len(pred_points)}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input.slp.json> <output.slp>")
        sys.exit(1)

    convert_json_to_slp(sys.argv[1], sys.argv[2])
