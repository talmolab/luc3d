#!/usr/bin/env python3
"""
Convert mv-gui 3D points JSON export to a points3d.h5 HDF5 file.

Usage:
    python json_to_h5.py points3d.json output_points3d.h5

The JSON input is produced by mv-gui's "Export 3D Points" menu command.
The output is an HDF5 file compatible with sleap-3d's expected format.

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


def convert_json_to_h5(json_path, h5_path):
    """Convert a mv-gui points3d JSON export to an HDF5 file."""
    with open(json_path, "r") as f:
        data = json.load(f)

    frame_indices = np.array(data.get("frame_indices", []), dtype=np.uint64)
    track_names = data.get("track_names", [])
    node_names = data.get("node_names", [])
    points_3d_raw = data.get("points_3d", [])
    reproj_errors_raw = data.get("reprojection_errors", [])

    n_frames = len(frame_indices)
    n_tracks = len(track_names)
    n_nodes = len(node_names)

    # Build 4D array: (n_frames, n_tracks, n_nodes, 3)
    points_3d = np.full((n_frames, n_tracks, n_nodes, 3), np.nan, dtype=np.float64)
    for fi in range(min(n_frames, len(points_3d_raw))):
        for ti in range(min(n_tracks, len(points_3d_raw[fi]))):
            for ni in range(min(n_nodes, len(points_3d_raw[fi][ti]))):
                pt = points_3d_raw[fi][ti][ni]
                if pt is not None and len(pt) == 3:
                    points_3d[fi, ti, ni] = pt

    # Build 3D array: (n_frames, n_tracks, n_nodes)
    reproj_errors = np.full(
        (n_frames, n_tracks, n_nodes), np.nan, dtype=np.float64
    )
    for fi in range(min(n_frames, len(reproj_errors_raw))):
        for ti in range(min(n_tracks, len(reproj_errors_raw[fi]))):
            for ni in range(min(n_nodes, len(reproj_errors_raw[fi][ti]))):
                val = reproj_errors_raw[fi][ti][ni]
                if val is not None:
                    reproj_errors[fi, ti, ni] = val

    with h5py.File(h5_path, "w") as h5:
        # Main datasets
        h5.create_dataset("points_3d", data=points_3d)
        h5.create_dataset("frame_indices", data=frame_indices)
        h5.create_dataset("reprojection_error", data=reproj_errors)

        # String datasets for names
        str_dtype = h5py.special_dtype(vlen=str)
        h5.create_dataset(
            "track_names", data=np.array(track_names, dtype=object), dtype=str_dtype
        )
        h5.create_dataset(
            "node_names", data=np.array(node_names, dtype=object), dtype=str_dtype
        )

    print(f"Converted {json_path} -> {h5_path}")
    print(f"  Shape: ({n_frames}, {n_tracks}, {n_nodes}, 3)")
    print(f"  Frames: {n_frames}")
    print(f"  Tracks: {track_names}")
    print(f"  Nodes: {node_names}")


if __name__ == "__main__":
    if len(sys.argv) != 3:
        print(f"Usage: {sys.argv[0]} <input_points3d.json> <output_points3d.h5>")
        sys.exit(1)

    convert_json_to_h5(sys.argv[1], sys.argv[2])
