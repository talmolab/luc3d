"""Calibration engines. Both write the anipose ``calibration.toml`` LUC3D loads.

- ``anipose``: aniposelib's ``CameraGroup.calibrate_rows`` with its defaults, the call
  sleap-anipose's ``slap-calibrate`` makes (one focal length + k1 per camera,
  principal point at the image centre). Fed this study's cached detections, so
  subsets (splits, first N seconds) cost no re-detection.
- ``calibrat3``: the browser app the lab's campy rigs use now
  (https://talmolab.github.io/calibrat3/), driven headless through its own
  ``tests/e2e/real-session.mjs`` harness (detection, intrinsics, extrinsics, bundle
  adjustment, export). Needs a calibrat3 checkout with ``tests/e2e`` npm-installed.
  It is always given frame-exact H.264 copies (Playwright's Chromium cannot decode
  HEVC), of the whole take or of the chosen frames.
"""
from __future__ import annotations

import contextlib
import io
import os
import socket
import subprocess
import sys
import time
from pathlib import Path

import numpy as np

from boards import Board
from camgeom import Calibration, Camera, read_calibration
from detect import Detections


def calibrate_anipose(dets: list[Detections], board: Board, frames: np.ndarray | None = None,
                      seed: int = 0) -> tuple[Calibration, dict]:
    from aniposelib.cameras import CameraGroup
    np.random.seed(seed)  # bundle_adjust_iter subsamples points with np.random
    ab = board.anipose_board()
    names = [d.camera for d in dets]
    cg = CameraGroup.from_names(names)
    rows = []
    for cam, d in zip(cg.cameras, dets):
        cam.set_size(tuple(int(v) for v in d.size))
        dd = d if frames is None else d.subset(frames)
        r = []
        for f in dd.frames[dd.count > 0]:
            ids, xy = dd.at(f)
            r.append({"framenum": (0, int(f)), "corners": xy.reshape(-1, 1, 2).astype(np.float32),
                      "ids": ids.reshape(-1, 1).astype(np.int32)})
        rows.append(ab.fill_points_rows(r))
    t0 = time.time()
    with contextlib.redirect_stdout(io.StringIO()):
        err = cg.calibrate_rows(rows, ab, init_intrinsics=True, init_extrinsics=True, verbose=False)
    secs = time.time() - t0
    cams = []
    for c in cg.cameras:
        dist = np.zeros(5)
        dv = np.asarray(c.get_distortions(), np.float64).ravel()
        dist[:min(5, len(dv))] = dv[:5]
        cams.append(Camera(c.get_name(), tuple(int(v) for v in c.get_size()), np.asarray(c.get_camera_matrix(), np.float64),
                           dist, np.asarray(c.get_rotation(), np.float64).ravel(),
                           np.asarray(c.get_translation(), np.float64).ravel()))
    return Calibration(cams, {"engine": "aniposelib", "adj_error": float(err)}), {"seconds": secs, "error": float(err)}


# ---- calibrat3 -------------------------------------------------------------------------

_server = {}


def _free_port() -> int:
    s = socket.socket()
    s.bind(("127.0.0.1", 0))
    p = s.getsockname()[1]
    s.close()
    return p


def _calibrat3_base(repo: Path) -> str:
    if repo in _server:
        return _server[repo][1]
    port = int(os.environ.get("CALIBRAT3_PORT", 0)) or _free_port()
    proc = subprocess.Popen([sys.executable, "server.py", str(port)], cwd=repo,
                            stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)
    base = f"http://127.0.0.1:{port}"
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), 0.2).close()
            break
        except OSError:
            time.sleep(0.1)
    _server[repo] = (proc, base)
    return base


def stop_servers():
    for proc, _ in _server.values():
        proc.terminate()
    _server.clear()


def cut_session(videos: dict[str, str], frames: np.ndarray, board: Board, out: Path) -> Path:
    """Frame-exact copy of the chosen frames of every camera (same frames in all
    cameras, so sync is kept), in calibrat3's flat layout plus board.toml."""
    out.mkdir(parents=True, exist_ok=True)
    (out / "board.toml").write_text(board.to_toml())
    frames = np.unique(frames)
    expr = "+".join(f"between(n\\,{a}\\,{b})" for a, b in _runs(frames))
    script = out / "select.txt"
    script.write_text(f"select='{expr}',setpts=N/FRAME_RATE/TB")
    for cam, v in videos.items():
        dst = out / f"{cam}.mp4"
        if dst.exists():
            continue
        # passthrough: keep exactly the selected frames (otherwise ffmpeg pads to 25 fps with duplicates)
        subprocess.run(["ffmpeg", "-v", "error", "-y", "-i", v, "-filter_script:v", str(script), "-an", "-fps_mode", "passthrough",
                        "-c:v", "libx264", "-crf", "6", "-preset", "fast", "-pix_fmt", "yuv420p",
                        "-g", "10", str(dst)], check=True)
    return out


def _runs(frames: np.ndarray):
    if not len(frames):
        return []
    br = np.where(np.diff(frames) != 1)[0]
    starts = np.r_[frames[0], frames[br + 1]]
    ends = np.r_[frames[br], frames[-1]]
    return list(zip(starts.tolist(), ends.tolist()))


def calibrate_calibrat3(session_dir: Path, out_toml: Path, repo: Path, target: int = 600,
                        log: Path | None = None) -> tuple[Calibration, dict]:
    base = _calibrat3_base(repo)
    env = {**os.environ, "BASE": base, "SESSION": str(session_dir), "TARGET": str(target),
           "OUT_TOML": str(out_toml), "PLAY_SECONDS": "0.5", "REFERENCE": ""}
    t0 = time.time()
    p = subprocess.run(["node", "tests/e2e/real-session.mjs"], cwd=repo, env=env, capture_output=True, text=True)
    secs = time.time() - t0
    if log:
        log.write_text(p.stdout + p.stderr)
    if not out_toml.exists():
        raise RuntimeError(f"calibrat3 failed on {session_dir}:\n{p.stdout[-2000:]}\n{p.stderr[-2000:]}")
    cal = read_calibration(out_toml)
    cal.meta["engine"] = "calibrat3"
    return cal, {"seconds": secs}
