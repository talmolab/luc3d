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


def convert_json_to_slp(json_path, slp_path):
    """Convert a mv-gui JSON export to a SLEAP .slp HDF5 file."""
    with open(json_path, "r") as f:
        data = json.load(f)

    with h5py.File(slp_path, "w") as h5:
        # ---- /metadata group ----
        meta_group = h5.create_group("metadata")
        meta_group.attrs["format_id"] = data.get("format_id", 1.4)
        meta_group.attrs["json"] = json.dumps(data["metadata"])

        # ---- /videos_json ----
        h5.create_dataset(
            "videos_json",
            data=json.dumps(data.get("videos", [])),
            dtype=h5py.special_dtype(vlen=str),
        )

        # ---- /tracks_json ----
        h5.create_dataset(
            "tracks_json",
            data=json.dumps(data.get("tracks", [])),
            dtype=h5py.special_dtype(vlen=str),
        )

        # ---- /suggestions_json ----
        h5.create_dataset(
            "suggestions_json",
            data=json.dumps(data.get("suggestions", [])),
            dtype=h5py.special_dtype(vlen=str),
        )

        # ---- /sessions_json ----
        h5.create_dataset(
            "sessions_json",
            data=json.dumps(data.get("sessions", [])),
            dtype=h5py.special_dtype(vlen=str),
        )

        # ---- /frames structured dataset ----
        frames = data.get("frames", [])
        if frames:
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

        # ---- /instances structured dataset ----
        instances = data.get("instances", [])
        if instances:
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

        # ---- /points structured dataset ----
        points = data.get("points", [])
        if points:
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
                pt_data[i] = (
                    pt.get("x", np.nan),
                    pt.get("y", np.nan),
                    pt.get("visible", False),
                    pt.get("complete", False),
                )
            h5.create_dataset("points", data=pt_data)

        # ---- /pred_points structured dataset ----
        pred_points = data.get("pred_points", [])
        if pred_points:
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
                pred_pt_data[i] = (
                    pt.get("x", np.nan),
                    pt.get("y", np.nan),
                    pt.get("visible", False),
                    pt.get("complete", False),
                    pt.get("score", 0.0),
                )
            h5.create_dataset("pred_points", data=pred_pt_data)

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
