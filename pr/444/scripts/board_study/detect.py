"""ChArUco corner detection over calibration videos, cached per camera.

One sequential decode per video feeds a pool of detector processes (frames are
never seeked, so every camera's frame numbers stay exact). The cache keeps every
sampled frame, including the ones where nothing was found, so detection rates
can be computed later.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
from dataclasses import dataclass
from pathlib import Path

import cv2
import numpy as np

from boards import Board

CACHE_VERSION = 1

_det = None


@dataclass
class Detections:
    """Corners found in one camera's video."""
    camera: str
    size: tuple[int, int]
    fps: float
    n_frames: int
    frames: np.ndarray      # (M,) sampled frame numbers
    count: np.ndarray       # (M,) corners found per sampled frame
    n_markers: np.ndarray   # (M,) markers found per sampled frame
    ids: np.ndarray         # (sum count,) corner ids
    xy: np.ndarray          # (sum count, 2) pixels
    brightness: np.ndarray  # (M,) mean grey level of the frame

    def __post_init__(self):
        self._off = np.concatenate([[0], np.cumsum(self.count)])
        self._index = {int(f): i for i, f in enumerate(self.frames)}

    def at(self, frame: int):
        """(ids, xy) for a frame, or None if it was not sampled / nothing found."""
        i = self._index.get(int(frame))
        if i is None or self.count[i] == 0:
            return None
        a, b = self._off[i], self._off[i + 1]
        return self.ids[a:b], self.xy[a:b]

    def frames_with(self, min_corners: int) -> np.ndarray:
        return self.frames[self.count >= min_corners]

    def dense(self, frame: int, n_corners: int) -> np.ndarray:
        """(n_corners, 2) with NaN for corners not seen."""
        out = np.full((n_corners, 2), np.nan)
        r = self.at(frame)
        if r is not None:
            out[r[0]] = r[1]
        return out

    def subset(self, keep: np.ndarray) -> "Detections":
        """Only the sampled frames whose numbers are in ``keep``."""
        m = np.isin(self.frames, keep)
        rows = np.repeat(m, self.count)
        return Detections(self.camera, self.size, self.fps, self.n_frames, self.frames[m], self.count[m],
                          self.n_markers[m], self.ids[rows], self.xy[rows], self.brightness[m])

    def save(self, path: Path, board: Board):
        np.savez_compressed(path, frames=self.frames, count=self.count, n_markers=self.n_markers,
                            ids=self.ids, xy=self.xy, brightness=self.brightness,
                            meta=json.dumps({"camera": self.camera, "size": list(self.size), "fps": self.fps,
                                             "n_frames": self.n_frames, "board": board.__dict__,
                                             "version": CACHE_VERSION}))

    @staticmethod
    def load(path: Path) -> "Detections":
        z = np.load(path)
        m = json.loads(str(z["meta"]))
        return Detections(m["camera"], tuple(m["size"]), m["fps"], m["n_frames"], z["frames"], z["count"],
                          z["n_markers"], z["ids"], z["xy"], z["brightness"])


def make_detector(board: Board):
    det = cv2.aruco.CharucoDetector(board.cv_board())
    return det


def detect_gray(det, gray: np.ndarray, offset=(0, 0)):
    cc, ci, mc, mi = det.detectBoard(gray)
    nm = 0 if mi is None else len(mi)
    if ci is None or len(ci) == 0:
        return np.zeros(0, np.int16), np.zeros((0, 2), np.float32), nm
    xy = cc.reshape(-1, 2).astype(np.float32)
    xy[:, 0] += offset[0]
    xy[:, 1] += offset[1]
    return ci.ravel().astype(np.int16), xy, nm


def _init(board_dict):
    global _det
    cv2.setNumThreads(1)
    _det = make_detector(Board(**board_dict))


def _work(item):
    f, gray = item
    ids, xy, nm = detect_gray(_det, gray)
    return f, ids, xy, nm, float(gray.mean())


def _frames(path: str, stride: int, start: int, stop: int | None):
    cap = cv2.VideoCapture(path)
    i = 0
    while True:
        ok = cap.grab()
        if not ok or (stop is not None and i >= stop):
            break
        if i >= start and (i - start) % stride == 0:
            ok, img = cap.retrieve()
            if not ok:
                break
            yield i, (cv2.cvtColor(img, cv2.COLOR_BGR2GRAY) if img.ndim == 3 else img)
        i += 1
    cap.release()


def video_info(path: str):
    cap = cv2.VideoCapture(path)
    w, h = int(cap.get(cv2.CAP_PROP_FRAME_WIDTH)), int(cap.get(cv2.CAP_PROP_FRAME_HEIGHT))
    fps = float(cap.get(cv2.CAP_PROP_FPS)) or 0.0
    n = int(cap.get(cv2.CAP_PROP_FRAME_COUNT))
    cap.release()
    return (w, h), fps, n


def probe_legacy(board: Board, video: str, n: int = 40) -> Board:
    """Boards with an even board_y were printed differently before OpenCV 4.6; keep the
    layout that finds more corners on the first frames that show the board."""
    if board.board_y % 2:
        return board
    alt = Board(**{**board.__dict__, "legacy": not board.legacy})
    da, db = make_detector(board), make_detector(alt)
    sa = sb = 0
    for k, (_, g) in enumerate(_frames(video, 5, 0, None)):
        sa += len(detect_gray(da, g)[0])
        sb += len(detect_gray(db, g)[0])
        if k >= n:
            break
    return alt if sb > sa else board


def detect_video(video: str, camera: str, board: Board, stride: int = 1, workers: int | None = None,
                 start: int = 0, stop: int | None = None, progress=None) -> Detections:
    size, fps, n_total = video_info(video)
    workers = workers or max(1, (os.cpu_count() or 2) - 1)
    frames, counts, nms, ids, xys, bright = [], [], [], [], [], []
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers, initializer=_init, initargs=(board.__dict__,)) as pool:
        for k, (f, i, xy, nm, b) in enumerate(pool.imap(_work, _frames(video, stride, start, stop), chunksize=2)):
            frames.append(f); counts.append(len(i)); nms.append(nm); ids.append(i); xys.append(xy); bright.append(b)
            if progress and k % 100 == 0:
                progress(k)
    n_seen = (frames[-1] + 1) if frames else 0
    return Detections(camera, size, fps, max(n_total, n_seen), np.asarray(frames, np.int32),
                      np.asarray(counts, np.int32), np.asarray(nms, np.int32),
                      np.concatenate(ids) if ids else np.zeros(0, np.int16),
                      np.concatenate(xys) if xys else np.zeros((0, 2), np.float32),
                      np.asarray(bright, np.float32))
