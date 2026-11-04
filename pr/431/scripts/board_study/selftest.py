"""End-to-end check on a synthetic 3-camera rig: simulate a board (random motion, plus a
still test recording), run the study, and require the calibration to come back close
to the truth. About two minutes on 8+ cores."""
from __future__ import annotations

import json
import tempfile
from argparse import Namespace
from pathlib import Path

import numpy as np

import simulate
import study
from camgeom import Calibration, Camera, write_calibration


def _look_at(pos, target):
    import cv2
    z = np.asarray(target, float) - pos
    z /= np.linalg.norm(z)
    x = np.cross([0, 0, 1.0], z)
    x /= np.linalg.norm(x)
    y = np.cross(z, x)
    R = np.stack([x, y, z])
    return cv2.Rodrigues(R)[0].ravel(), -R @ pos


def main(keep: Path | None = None) -> bool:
    root = keep or Path(tempfile.mkdtemp(prefix="board_study_selftest_"))
    root.mkdir(parents=True, exist_ok=True)
    K = np.array([[900.0, 0, 640], [0, 900, 512], [0, 0, 1]])
    cams = []
    for i, ang in enumerate((0, 120, 240)):
        a = np.radians(ang)
        pos = np.array([600 * np.cos(a), 600 * np.sin(a), 450.0])
        r, t = _look_at(pos, [0, 0, 0])
        cams.append(Camera(f"cam{i}", (1280, 1024), K, np.array([-0.2, 0.05, 0, 0, 0]), r, t))
    write_calibration(Calibration(cams), root / "rig.toml", "self-test rig")
    a = Namespace(rig_calibration=root / "rig.toml", rig="selftest", boards="calibio-300x200-coarse", takes=2,
                  seconds=20, fps=5, trajectory=None, trajectory_take=None, frame_step=1, volume_mm=350,
                  exposure_ms=1.0, noise=2.0, white=180, black=25, corner_jitter=0.1, test_poses=8,
                  test_board="calibio-300x200-coarse", seed=3, workers=None, out=root / "sim")
    simulate.main(a)
    res = study.run(root / "sim" / "study.toml", root / "out", ("anipose",), splits=2, block_s=5.0, prefixes=(10,))
    full = [c for c in res["calibrations"] if c["variant"] == "full" and not c.get("failed")]
    ok = len(full) == 2
    for c in full:
        t, g = c["truth"]["vs_truth_median_mm"], c["heldout"]["geometry"]["long_length_err_pct"]
        print(f"{c['take']}: 3D error vs truth {t:.3f} mm, held-out ruler error {g:.3f} %, "
              f"reprojection {c['self']['median_px']:.3f} px")
        ok &= t < 0.5 and g < 0.5 and c["self"]["median_px"] < 0.5
    print("SELFTEST", "PASSED" if ok else "FAILED", f"(files in {root})")
    (root / "selftest.json").write_text(json.dumps({"ok": bool(ok)}))
    return bool(ok)
