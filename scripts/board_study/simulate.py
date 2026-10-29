"""Synthetic calibration recordings of any catalogue board in a copy of a real rig.

The cameras (positions, lenses, distortion, image size) come from a real
calibration.toml. The board motion either comes from a real recording of that rig
(``--trajectory OUT --trajectory-take ID``: every frame's board pose, triangulated
from that run's detections, so the new board is held exactly where and how the
person held the real one) or is a smooth random walk through the space the cameras
share. Each frame is rendered per camera (board pattern with its white plate margin,
supersampled, lens distortion, defocus, motion blur over the exposure, sensor noise)
and run through the same detector as real videos. Detections + the true calibration
are written so ``board_study run`` treats them like real takes, and a static
test-board recording (one frame per still pose) is written for held-out scoring.

What it leaves out: compression artefacts, uneven lighting and glare, the hand and
cage occluding the board, and rolling-shutter / sync error. The first of these is
stood in for by ``corner_jitter`` (Gaussian noise added to every detected corner, in
pixels, when a study loads the simulated detections; the saved detections are
noise-free), set with ``fit-jitter`` so a simulated recording of the rig's real board
gives the same reprojection error as the real recording.
"""
from __future__ import annotations

import json
import multiprocessing as mp
import os
from pathlib import Path

import cv2
import numpy as np

import boards as B
from camgeom import Calibration, read_calibration, write_calibration, kabsch
from detect import Detections, detect_gray, make_detector

SS = 2  # supersampling

_w = {}


def _plate_texture(bid: str, max_px: int = 5000):
    plate, *_ = B.plate_info(bid)
    board = B.catalogue_board(bid)
    # texels per mm: plate sizes divisible by 16 (exact texture pyramid levels)
    ppm = next(p for p in (16, 12, 8, 4, 2) if max(plate) * p <= max_px and all(v * p % 16 == 0 for v in plate))
    margin = (plate[0] - board.pattern_mm[0]) / 2, (plate[1] - board.pattern_mm[1]) / 2
    tex = B.board_image(board, ppm, 0.0)
    W, H = int(round(plate[0] * ppm)), int(round(plate[1] * ppm))
    out = np.full((H, W), 255, np.uint8)
    ox, oy = int(round(margin[0] * ppm)), int(round(margin[1] * ppm))
    out[oy:oy + tex.shape[0], ox:ox + tex.shape[1]] = tex[:H - oy, :W - ox]
    # texture pixel (u, v) -> board mm: x = u / ppm - margin_x (pattern origin at the pattern corner)
    return out, ppm, margin


def _cam_maps(cam):
    """For every distorted output pixel (supersampled), its ideal-pinhole position."""
    W, H = cam.size
    xs, ys = np.meshgrid((np.arange(W * SS) + 0.5) / SS - 0.5, (np.arange(H * SS) + 0.5) / SS - 0.5)
    pts = np.stack([xs.ravel(), ys.ravel()], 1).astype(np.float64).reshape(-1, 1, 2)
    und = cv2.undistortPoints(pts, cam.K, cam.dist, P=cam.K).reshape(H * SS, W * SS, 2)
    return und.astype(np.float32)


def _init(cal_path, bid, params):
    cv2.setNumThreads(1)
    _w["cal"] = read_calibration(cal_path)
    _w["board"] = B.catalogue_board(bid)
    _w["bid"] = bid
    _w["tex"] = _plate_texture(bid)
    tex = _w["tex"][0]
    _w["pyr"] = {k: (cv2.resize(tex, (tex.shape[1] // k, tex.shape[0] // k), interpolation=cv2.INTER_AREA) if k > 1 else tex).astype(np.float32)
                 for k in (1, 2, 4, 8, 16)}
    _w["det"] = make_detector(_w["board"])
    _w["maps"] = {}
    _w["p"] = params


def _render(cam, ci, R, t, rng):
    """Grey image of the board at pose (R, t) (board mm -> world) seen by camera ci."""
    p = _w["p"]
    tex, ppm, margin = _w["tex"]
    W, H = cam.size
    if ci not in _w["maps"]:
        _w["maps"][ci] = _cam_maps(cam)
    und = _w["maps"][ci]
    # texture px -> board mm -> world -> camera -> ideal pixel (supersampled grid coordinates)
    # (texel centres are at integer coordinates: texel u spans board x in [u, u + 1] / ppm)
    A = np.array([[1 / ppm, 0, 0.5 / ppm - margin[0]], [0, 1 / ppm, 0.5 / ppm - margin[1]], [0, 0, 1]])
    Rc, tc = cam.R, np.asarray(cam.tvec, np.float64)
    Rw, tw = Rc @ R, Rc @ t + tc            # board mm -> camera
    Hb = cam.K @ np.column_stack([Rw[:, 0], Rw[:, 1], tw])  # board (x, y, 1) -> ideal pixel
    Hm = Hb @ A
    # image region the plate covers (ideal pixels), clipped to the undistorted footprint
    # distorted-image bounding box of the plate, from points along its edges
    s = np.linspace(0, 1, 25)
    pw, ph = tex.shape[1] / ppm, tex.shape[0] / ppm
    edge = np.concatenate([np.stack([s * pw, 0 * s], 1), np.stack([s * pw, 0 * s + ph], 1),
                           np.stack([0 * s, s * ph], 1), np.stack([0 * s + pw, s * ph], 1)]) - np.array(margin)
    E = np.column_stack([edge, np.zeros(len(edge))]) @ R.T + t
    if (cam.depth(E) <= 1).any():
        return None, None
    q = cam.project(E)
    x0, y0 = q.min(0)
    x1, y1 = q.max(0)
    if x1 < 0 or y1 < 0 or x0 >= W or y0 >= H:
        return None, None
    pad = 10
    c0, r0 = int(max(0, np.floor(x0) - pad)), int(max(0, np.floor(y0) - pad))
    c1, r1 = int(min(W, np.ceil(x1) + pad)), int(min(H, np.ceil(y1) + pad))
    if c1 - c0 < 8 or r1 - r0 < 8:
        return None, None
    r0, r1, c0, c1 = r0 * SS, r1 * SS, c0 * SS, c1 * SS
    sub = und[r0:r1, c0:c1]
    # board texture coordinates for each supersampled pixel: inverse homography
    Hi = np.linalg.inv(Hm)
    X = sub[..., 0] * Hi[0, 0] + sub[..., 1] * Hi[0, 1] + Hi[0, 2]
    Y = sub[..., 0] * Hi[1, 0] + sub[..., 1] * Hi[1, 1] + Hi[1, 2]
    Z = sub[..., 0] * Hi[2, 0] + sub[..., 1] * Hi[2, 1] + Hi[2, 2]
    mx, my = (X / Z).astype(np.float32), (Y / Z).astype(np.float32)
    # area-filtered texture level close to the sampling density, then point-sample it
    ext = Hi[:2, :2] / (Hi[2, 0] * sub[..., 0].mean() + Hi[2, 1] * sub[..., 1].mean() + Hi[2, 2])
    tex_per_ss = float(np.sqrt(abs(np.linalg.det(ext))))  # texels per supersampled pixel
    lvl_k = 1
    while lvl_k * 2 <= min(16, tex_per_ss):
        lvl_k *= 2
    texs = _w["pyr"][lvl_k]
    if lvl_k > 1:
        mx, my = (mx + 0.5) / lvl_k - 0.5, (my + 0.5) / lvl_k - 0.5
    patch = cv2.remap(texs, mx, my, cv2.INTER_LINEAR, borderMode=cv2.BORDER_CONSTANT, borderValue=-1)
    inside = patch >= 0
    lvl = np.where(inside, p["black"] + (p["white"] - p["black"]) * np.clip(patch, 0, 255) / 255.0, p["background"])
    lvl = cv2.resize(lvl.astype(np.float32), ((c1 - c0) // SS, (r1 - r0) // SS), interpolation=cv2.INTER_AREA)
    return lvl, (r0 // SS, c0 // SS)


def _frame_task(task):
    """Render + detect one camera over a run of frames. poses: list of (frame, [(R, t)...] sub-steps)."""
    ci, items, seed = task
    cal, board, p = _w["cal"], _w["board"], _w["p"]
    cam = cal.cameras[ci]
    rng = np.random.default_rng(seed)
    out = []
    for f, steps in items:
        acc, org = None, None
        for (R, t) in steps:
            img, o = _render(cam, ci, R, t, rng)
            if img is None:
                continue
            if acc is None:
                acc, org, n = img.copy(), o, 1
            elif o == org and img.shape == acc.shape:
                acc += img
                n += 1
        if acc is None:
            out.append((f, np.zeros(0, np.int16), np.zeros((0, 2), np.float32), 0, 0.0))
            continue
        acc /= n
        if p["defocus"] > 0:
            acc = cv2.GaussianBlur(acc, (0, 0), p["defocus"])
        acc += rng.normal(0, p["noise"], acc.shape)
        g = np.clip(np.round(acc), 0, 255).astype(np.uint8)
        ids, xy, nm = detect_gray(_w["det"], g, offset=(org[1], org[0]))
        W, H = cam.size
        keep = (xy[:, 0] >= 0) & (xy[:, 0] < W) & (xy[:, 1] >= 0) & (xy[:, 1] < H)
        out.append((f, ids[keep], xy[keep], nm, float(g.mean())))
    return ci, out


def _shared_center(cal: Calibration):
    """Point closest (least squares) to every camera's optical axis."""
    A, b = np.zeros((3, 3)), np.zeros(3)
    for c in cal.cameras:
        d = c.R.T @ np.array([0, 0, 1.0])
        P = np.eye(3) - np.outer(d, d)
        A += P
        b += P @ c.center
    return np.linalg.solve(A, b)


def random_trajectory(cal: Calibration, board: B.Board, n: int, fps: float, volume: float, rng):
    """Smooth random board motion: centre within a box around the shared point, plate
    facing the mean camera direction with up to ~60° of tilt, ~0.2 m/s."""
    c0 = _shared_center(cal)
    toward = np.mean([(c.center - c0) / np.linalg.norm(c.center - c0) for c in cal.cameras], 0)
    toward /= np.linalg.norm(toward)
    pos = np.zeros((n, 3))
    vel = rng.normal(0, 1, 3)
    x = c0.copy()
    speed = 200.0 / fps  # mm per frame
    for i in range(n):
        vel = 0.9 * vel + 0.3 * rng.normal(0, 1, 3)
        x = x + speed * vel / max(1e-6, np.linalg.norm(vel))
        x = c0 + np.clip(x - c0, -volume / 2, volume / 2)
        pos[i] = x
    ang = np.zeros((n, 2))
    a = np.zeros(2)
    for i in range(n):
        a = 0.95 * a + 0.12 * rng.normal(0, 1, 2)
        a = np.clip(a, -1.0, 1.0)
        ang[i] = a
    poses = []
    pc = board.corner_points().mean(0)
    for i in range(n):
        # normal toward the cameras, tilted by ang (radians) about two axes
        z = -toward
        x_ax = np.cross([0, 0, 1.0], z)
        if np.linalg.norm(x_ax) < 1e-6:
            x_ax = np.array([1.0, 0, 0])
        x_ax /= np.linalg.norm(x_ax)
        y_ax = np.cross(z, x_ax)
        R0 = np.column_stack([x_ax, y_ax, z])
        Rt = cv2.Rodrigues(np.array([ang[i, 0], ang[i, 1], 0.4 * ang[i, 0] * ang[i, 1]]))[0]
        R = R0 @ Rt
        t = pos[i] - R @ pc
        poses.append((R, t))
    return poses


def trajectory_from_run(run: Path, take: str, board_real: B.Board, board_new: B.Board):
    """Board poses of a real take (triangulated with that run's calibration), re-centred
    for the new board: the new plate's centre goes where the real plate's centre was."""
    import metrics as M
    cal = read_calibration(run / "calibrations" / f"{take}__anipose__full.toml")
    res = json.loads((run / "results.json").read_text())
    cache = Path(res.get("cache") or run / "cache")
    dets = [Detections.load(cache / take / f"{c}.npz") for c in cal.names]
    fr, obs = M.stack(dets, board_real)
    X = M.triangulate_frames(cal, obs)
    poses = {}
    cr, cn = board_real.corner_points().mean(0), board_new.corner_points().mean(0)
    for fi, R, t in M.board_poses(X, board_real):
        center = R @ cr + t
        poses[int(fr[fi])] = (R, center - R @ cn)
    fps = dets[0].fps or 10.0
    return cal, poses, fps, int(dets[0].n_frames)


def _interp_poses(poses: dict, frames: np.ndarray):
    """Fill missing frames by holding the nearest known pose (board out of view: still rendered)."""
    keys = np.array(sorted(poses))
    out = {}
    for f in frames:
        k = keys[np.argmin(np.abs(keys - f))]
        if abs(k - f) <= 3:
            out[int(f)] = poses[int(k)]
    return out


def _substeps(poses_seq: list, i: int, exposure_frames: float, n: int = 3):
    """Poses spread over the exposure, by interpolating toward the next frame's pose."""
    R, t = poses_seq[i]
    if exposure_frames <= 0.05 or i + 1 >= len(poses_seq) or poses_seq[i + 1] is None:
        return [(R, t)]
    R2, t2 = poses_seq[i + 1]
    rv = cv2.Rodrigues(R2 @ R.T)[0].ravel()
    out = []
    for s in np.linspace(0, exposure_frames, n):
        out.append((cv2.Rodrigues(rv * s)[0] @ R, t + (t2 - t) * s))
    return out


def render_take(cal_path: Path, bid: str, frame_poses: dict, n_frames: int, fps: float, params: dict,
                out_dir: Path, seed: int, workers: int | None = None):
    cal = read_calibration(cal_path)
    frames = np.arange(n_frames)
    seq = [frame_poses.get(int(f)) for f in frames]
    exp_frames = params["exposure_ms"] / 1000 * fps
    per_cam = {ci: [] for ci in range(len(cal.cameras))}
    for i, f in enumerate(frames):
        if seq[i] is None:
            continue
        steps = _substeps(seq, i, exp_frames)
        for ci in per_cam:
            per_cam[ci].append((int(f), steps))
    tasks = []
    chunk = 15
    for ci, items in per_cam.items():
        for a in range(0, len(items), chunk):
            tasks.append((ci, items[a:a + chunk], seed * 100003 + ci * 1009 + a))
    res = {ci: [] for ci in per_cam}
    ctx = mp.get_context("spawn")
    with ctx.Pool(workers or max(1, (os.cpu_count() or 2) - 1), initializer=_init,
                  initargs=(str(cal_path), bid, params)) as pool:
        for ci, out in pool.imap_unordered(_frame_task, tasks):
            res[ci].extend(out)
    det_dir = out_dir / "detections"
    det_dir.mkdir(parents=True, exist_ok=True)
    board = B.catalogue_board(bid)
    for ci, cam in enumerate(cal.cameras):
        found = {f: (ids, xy, nm, b) for f, ids, xy, nm, b in res[ci]}
        fr = np.arange(n_frames)
        cnt = np.array([len(found[f][0]) if f in found else 0 for f in fr], np.int32)
        ids = [found[f][0] for f in fr if f in found and len(found[f][0])]
        xys = [found[f][1] for f in fr if f in found and len(found[f][0])]
        d = Detections(cam.name, cam.size, fps, n_frames, fr.astype(np.int32), cnt,
                       np.array([found[f][2] if f in found else 0 for f in fr], np.int32),
                       np.concatenate(ids) if ids else np.zeros(0, np.int16),
                       np.concatenate(xys).astype(np.float32) if xys else np.zeros((0, 2), np.float32),
                       np.array([found[f][3] if f in found else params["background"] for f in fr], np.float32))
        d.save(det_dir / f"{cam.name}.npz", board)
    (out_dir / "board.toml").write_text(board.to_toml())
    write_calibration(cal, out_dir / "truth.toml", "true calibration of the simulated rig")
    (out_dir / "simulated.json").write_text(json.dumps({"board": bid, "params": params, "fps": fps, "frames": n_frames}))


def test_poses(cal: Calibration, board: B.Board, n: int, volume: float, rng):
    """Still poses of the test board spread through the shared space, facing the cameras."""
    poses = random_trajectory(cal, board, n * 40, 10.0, volume, rng)
    return {i: poses[i * 40 + 20] for i in range(n)}


def main(a):
    rng = np.random.default_rng(a.seed)
    out = a.out
    out.mkdir(parents=True, exist_ok=True)
    rig_cal = a.rig_calibration
    bids = a.boards.split(",")
    real_board = None
    if a.trajectory:
        tk = json.loads((a.trajectory / "results.json").read_text())
        t = next(x for x in tk["takes"] if x["id"] == a.trajectory_take)
        if "board_params" in t:
            real_board = B.Board(**t["board_params"])
        elif t["board"] in B.CALIBIO:
            real_board = B.catalogue_board(t["board"])
        else:  # a board.toml named relative to a study file in studies/
            real_board = B.read_board(Path(__file__).resolve().parent / "studies" / t["board"])
        rig_cal = a.trajectory / "calibrations" / f"{a.trajectory_take}__anipose__full.toml"
    cal = read_calibration(rig_cal)
    c0 = _shared_center(cal)
    dist = float(np.median([np.linalg.norm(c.center - c0) for c in cal.cameras]))
    volume = a.volume_mm or 0.6 * dist
    params = {"exposure_ms": a.exposure_ms, "noise": a.noise, "white": a.white, "black": a.black,
              "background": 0.5 * (a.white + a.black) * 0.6, "defocus": 0.6}
    lines = [f'[study]\nname = "Simulated {a.rig}"\nnote = "Synthetic recordings (scripts/board_study/simulate.py) '
             f'of a copy of the {a.rig} rig from {rig_cal.name}; motion from '
             f'{"a real recording (" + a.trajectory_take + ")" if a.trajectory else "a random walk"}."\n']
    for bid in bids:
        board = B.catalogue_board(bid)
        for k in range(a.takes):
            tid = f"sim-{a.rig}-{bid.replace('calibio-', '')}-{k + 1}"
            d = out / tid
            if (d / "simulated.json").exists():
                print(f"  {tid}: exists")
            else:
                if a.trajectory:
                    _, poses, fps, n = trajectory_from_run(a.trajectory, a.trajectory_take, real_board, board)
                    # each repeat starts at a different point of the real motion, wrapping around
                    shift = int(k * n / max(1, a.takes))
                    poses = {(f - shift) % n: p for f, p in poses.items()}
                    poses = _interp_poses(poses, np.arange(n))
                    if a.frame_step > 1:  # thin the motion: every Nth frame, renumbered, at fps / N
                        poses = {f // a.frame_step: p for f, p in poses.items() if f % a.frame_step == 0}
                        n, fps = n // a.frame_step, fps / a.frame_step
                else:
                    fps = a.fps
                    n = int(a.seconds * fps)
                    poses = dict(enumerate(random_trajectory(cal, board, n, fps, volume, np.random.default_rng(a.seed * 31 + k))))
                render_take(rig_cal, bid, poses, n, fps, params, d, a.seed * 7 + k, a.workers)
                print(f"  {tid}: rendered {n} frames x {len(cal.cameras)} cameras")
            lines.append(f'[[take]]\nid = "{tid}"\nrig = "{a.rig}"\nsession = "sim"\nboard = "{bid}"\n'
                         f'path = "{d}"\ntruth = "truth.toml"\nsimulated = true\ncorner_jitter = {a.corner_jitter}\n')
    if a.test_poses:
        tb = a.test_board or _largest_fitting(cal, volume)
        d = out / f"sim-{a.rig}-test-{tb.replace('calibio-', '')}"
        if not (d / "simulated.json").exists():
            poses = test_poses(cal, B.catalogue_board(tb), a.test_poses, volume, rng)
            p2 = {**params, "exposure_ms": 0.0}
            render_take(rig_cal, tb, poses, a.test_poses, 1.0, p2, d, a.seed + 999, a.workers)
        lines.append(f'[[take]]\nid = "sim-{a.rig}-test"\nrig = "{a.rig}"\nsession = "sim"\nboard = "{tb}"\n'
                     f'path = "{d}"\nkind = "test"\ntruth = "truth.toml"\nsimulated = true\ncorner_jitter = {a.corner_jitter}\n')
    (out / "study.toml").write_text("\n".join(lines))
    print(f"wrote {out / 'study.toml'}")


def _largest_fitting(cal: Calibration, volume: float) -> str:
    """Test board: the biggest coarse plate no larger than ~the volume."""
    best = "calibio-200x150-coarse"
    for bid, (plate, pat, *_) in B.CALIBIO.items():
        if pat == "coarse" and max(plate) <= volume and max(plate) > max(B.CALIBIO[best][0]):
            best = bid
    return best


def fit_jitter(take_dir: Path, target_px: float, lo: float = 0.0, hi: float = 1.5, iters: int = 7) -> float:
    """Corner noise (px) at which an anipose calibration of this simulated take has the
    given median reprojection error (bisection)."""
    import metrics as M
    from engines import calibrate_anipose
    truth = read_calibration(take_dir / "truth.toml")
    board = B.read_board(take_dir / "board.toml")
    base = [Detections.load(take_dir / "detections" / f"{c}.npz") for c in truth.names]

    def err(sig):
        rng = np.random.default_rng(1)
        dets = [jittered(d, sig, rng) for d in base]
        cal, _ = calibrate_anipose(dets, board)
        fr, obs = M.stack(dets, board)
        e = M.reprojection(cal, obs)["median_px"]
        print(f"  corner jitter {sig:.3f} px -> reprojection {e:.3f} px (target {target_px:.3f})")
        return e

    for _ in range(iters):
        mid = 0.5 * (lo + hi)
        if err(mid) < target_px:
            lo = mid
        else:
            hi = mid
    return 0.5 * (lo + hi)


def jittered(d: Detections, sigma: float, rng) -> Detections:
    if sigma <= 0:
        return d
    return Detections(d.camera, d.size, d.fps, d.n_frames, d.frames, d.count, d.n_markers, d.ids,
                      (d.xy + rng.normal(0, sigma, d.xy.shape)).astype(np.float32), d.brightness)
