"""Study definition (study.toml) and the run that turns recordings into results.json.

study.toml::

    [study]
    name = "Board comparison, ChronicRecord + SLAP"

    [[take]]
    id = "chronicrecord-2026-10-26-a"   # unique
    rig = "chronicrecord"
    session = "2026-10-26"               # cameras untouched within one rig + session
    board = "calibio-300x200-coarse"     # catalogue id, a board.toml path, or omit (take/board.toml)
    path = "/path/to/recording"          # campy/anipose folder: <Camera>/calibration_images/*.mp4
    kind = "calibration"                 # or "test": test board held still at ~10 poses
    # cameras = ["Camera0", "Camera1"]   # optional subset / order
    # reference = "calibration.toml"     # optional calibration made at the time, also scored

Held-out data for a take's calibration, in order of preference: the session's test
recordings; else the session's other calibration takes; else (splits only) the
take's other time blocks.
"""
from __future__ import annotations

import json
import time
import tomllib
from dataclasses import dataclass, field
from pathlib import Path

import numpy as np

import boards as B
import engines
import metrics as M
from camgeom import Calibration, read_calibration, write_calibration
from detect import Detections, detect_video, probe_legacy

VIDEO_EXT = (".mp4", ".avi", ".mkv", ".mov")


@dataclass
class Take:
    id: str
    rig: str
    session: str
    board: B.Board
    board_id: str
    path: Path
    kind: str = "calibration"
    videos: dict = field(default_factory=dict)  # camera -> video path
    reference: Path | None = None
    truth: Path | None = None  # ground-truth calibration (simulations)
    stride: int = 0            # detect every Nth frame (0 = the run's --stride)
    corner_jitter: float = 0.0 # simulations: noise added to the corners when loaded, px


def _find_videos(path: Path, cameras: list[str] | None) -> dict[str, str]:
    def vids(d: Path):
        for sub in (d / "calibration_images", d / "calibration", d):
            if sub.is_dir():
                v = sorted(p for p in sub.iterdir() if p.suffix.lower() in VIDEO_EXT and not p.name.startswith("."))
                if v:
                    return str(v[0])
        return None
    out = {}
    if cameras:
        for c in cameras:
            v = vids(path / c) if (path / c).is_dir() else next((str(p) for p in path.glob(f"{c}.*") if p.suffix.lower() in VIDEO_EXT), None)
            if v is None:
                raise FileNotFoundError(f"no video for camera {c} in {path}")
            out[c] = v
        return out
    for d in sorted(p for p in path.iterdir() if p.is_dir() and not p.name.startswith(".")):
        v = vids(d)
        if v:
            out[d.name] = v
    if not out:
        for p in sorted(path.iterdir()):
            if p.suffix.lower() in VIDEO_EXT:
                out[p.stem] = str(p)
    return out


def load_study(path: Path) -> tuple[dict, list[Take], list[dict]]:
    d = tomllib.loads(path.read_text())
    takes = []
    for t in d.get("take", []):
        p = Path(t["path"]).expanduser()
        if not p.is_absolute():
            p = (path.parent / p).resolve()
        bid = t.get("board")
        if bid in B.CALIBIO or bid in B.LAB:
            board = B.catalogue_board(bid)
        else:
            bp = p / "board.toml"
            if bid:  # a board.toml path: next to the study file, else in the recording folder
                bp = (path.parent / bid) if (path.parent / bid).exists() else p / bid
            board = B.read_board(bp)
            bid = bid if bid and not str(bid).endswith(".toml") else (board.name or f"{board.board_x}x{board.board_y}-{board.square_length:g}mm")
        ref = t.get("reference")
        truth = t.get("truth")
        if t.get("simulated"):  # simulate.py output: detections instead of videos
            videos = {c.name: None for c in read_calibration(p / truth).cameras}
        else:
            videos = _find_videos(p, t.get("cameras"))
        takes.append(Take(t["id"], t["rig"], str(t.get("session", "")), board, bid, p, t.get("kind", "calibration"),
                          videos, (p / ref) if ref else None, (p / truth) if truth else None, int(t.get("stride", 0)),
                          float(t.get("corner_jitter", 0.0))))
    rulers = [{**r, "ruler": True} for r in d.get("ruler", [])]
    return d.get("study", {}), takes, d.get("poses", []) + rulers


# ---- detection cache --------------------------------------------------------------------

def detections(take: Take, cache_root: Path, stride: int = 1, log=print) -> list[Detections]:
    cache = cache_root / take.id
    cache.mkdir(parents=True, exist_ok=True)
    dets = []
    board = take.board
    for cam, video in take.videos.items():
        f = cache / f"{cam}.npz"
        if video is None:
            f = take.path / "detections" / f"{cam}.npz"
        if f.exists():
            d = Detections.load(f)
            if take.corner_jitter > 0:
                import zlib
                from simulate import jittered
                d = jittered(d, take.corner_jitter, np.random.default_rng(zlib.crc32(f"{take.id}/{cam}".encode())))
            dets.append(d)
            continue
        if not dets and board.board_y % 2 == 0:
            board = probe_legacy(board, video)
            take.board = board
        t0 = time.time()
        d = detect_video(video, cam, board, stride=take.stride or stride)
        d.save(f, board)
        log(f"  detect {take.id}/{cam}: {len(d.frames)} frames, board in {int((d.count >= M.MIN_CORNERS).sum())} "
            f"({time.time() - t0:.0f} s)")
        dets.append(d)
    return dets


# ---- the run ----------------------------------------------------------------------------

def _blocks(dets: list[Detections], block_s: float, n_groups: int):
    fps = dets[0].fps or 30.0
    frames = np.unique(np.concatenate([d.frames for d in dets]))
    g = (np.floor(frames / fps / block_s).astype(int)) % n_groups
    return [frames[g == k] for k in range(n_groups)]


def still_frames(dets: list[Detections], tol_px: float = 0.5) -> list[Detections]:
    """Test recordings: keep frames where the board did not move since the previous
    frame (median corner shift below tol_px in every camera that saw it in both)."""
    frames = np.unique(np.concatenate([d.frames for d in dets]))
    keep = []
    for a, b in zip(frames[:-1], frames[1:]):
        ok, seen = True, False
        for d in dets:
            ra, rb = d.at(a), d.at(b)
            if ra is None or rb is None:
                continue
            common, ia, ib = np.intersect1d(ra[0], rb[0], return_indices=True)
            if len(common) < 4:
                continue
            seen = True
            if np.median(np.linalg.norm(ra[1][ia] - rb[1][ib], axis=1)) > tol_px:
                ok = False
                break
        if ok and seen:
            keep.append(b)
    keep = np.asarray(keep)
    return [d.subset(keep) for d in dets]


def _score(cal: Calibration, data: list[tuple[list[Detections], B.Board]]):
    """Held-out reprojection + board geometry over several recordings, pooled by frame."""
    reps, geo, Xs = [], [], []
    for dets, board in data:
        fr, obs = M.stack(dets, board)
        if not len(fr):
            continue
        X = M.triangulate_frames(cal, obs)
        reps.append(M.reprojection(cal, obs, X))
        geo.append((M.board_geometry(X, board), len(fr)))
        Xs.append(X)
    if not reps:
        return None, []
    w = np.array([r["n_obs"] for r in reps], float)
    rep = {k: float(np.average([r[k] for r in reps], weights=w)) for k in ("median_px", "mean_px", "p95_px")}
    rep["n_obs"] = int(w.sum())
    gw = np.array([n for _, n in geo], float)
    g = {k: float(np.average([x[k] for x, _ in geo], weights=gw)) for k in geo[0][0] if k != "frames"}
    g["frames"] = int(sum(x["frames"] for x, _ in geo))
    return {"reprojection": rep, "geometry": g}, Xs


def _truth_error(cal: Calibration, truth: Calibration, data) -> dict:
    """Simulations only: 3D error of triangulated corners against the true calibration's
    triangulation of the noise-free corners, after a rigid alignment of the two frames."""
    errs = []
    for dets, board in data:
        fr, obs = M.stack(dets, board)
        if not len(fr):
            continue
        Xc = M.triangulate_frames(cal, obs).reshape(-1, 3)
        Xt = M.triangulate_frames(truth, obs).reshape(-1, 3)
        ok = np.isfinite(Xc[:, 0]) & np.isfinite(Xt[:, 0])
        if ok.sum() < 10:
            continue
        from camgeom import kabsch
        R, t, _ = kabsch(Xc[ok], Xt[ok])
        errs.append(np.linalg.norm(Xc[ok] @ R.T + t - Xt[ok], axis=1))
    e = np.concatenate(errs) if errs else np.zeros(0)
    return {"vs_truth_median_mm": float(np.median(e)) if len(e) else float("nan"),
            "vs_truth_p95_mm": float(np.percentile(e, 95)) if len(e) else float("nan")}


def run(study_path: Path, out: Path, engine_names=("anipose",), splits: int = 3, block_s: float = 5.0,
        prefixes=(10, 20, 30, 45, 60, 90, 120), calibrat3: Path | None = None, stride: int = 1,
        only_rig: str | None = None, cache: Path | None = None, log=print) -> dict:
    info, takes, pose_specs = load_study(study_path)
    if only_rig:
        takes = [t for t in takes if t.rig == only_rig]
    pose_data = {}
    for ps in pose_specs:
        if only_rig and ps["rig"] != only_rig:
            continue
        import poses as P
        if ps.get("ruler"):
            cams_p, keys, nodes, X2 = P.load(ps["views"], 1, untracked="ruler")
            pose_data.setdefault((ps["rig"], str(ps.get("session", ""))), []).append((ps["id"], cams_p, X2, float(ps["length_mm"])))
        else:
            cams_p, keys, nodes, X2 = P.load(ps["views"], int(ps.get("every", 5)))
            pose_data.setdefault((ps["rig"], str(ps.get("session", ""))), []).append((ps["id"], cams_p, X2, None))
        log(f"poses {ps['id']}: {len(keys)} labelled animal-frames in {len(cams_p)} cameras")
    out.mkdir(parents=True, exist_ok=True)
    cache = cache or out / "cache"
    cal_dir = out / "calibrations"
    cal_dir.mkdir(exist_ok=True)
    results = {"study": info, "created": time.strftime("%Y-%m-%d %H:%M"), "cache": str(cache), "takes": [], "calibrations": [],
               "repeatability": [], "coverage": []}
    dets_of = {}
    for t in takes:
        log(f"take {t.id}: {len(t.videos)} cameras, board {t.board_id} ({t.board.describe()})")
        dets_of[t.id] = detections(t, cache, stride, log)
        d0 = dets_of[t.id][0]
        results["takes"].append({"id": t.id, "rig": t.rig, "session": t.session, "board": t.board_id,
                                 "board_desc": t.board.describe(), "board_params": dict(t.board.__dict__), "kind": t.kind, "cameras": list(t.videos),
                                 "fps": d0.fps, "frames": int(d0.n_frames),
                                 "seconds": float(d0.n_frames / d0.fps) if d0.fps else None,
                                 "size": list(d0.size), "path": str(t.path)})

    sessions = {}
    for t in takes:
        sessions.setdefault((t.rig, t.session), []).append(t)

    for (rig, sess), group in sessions.items():
        cams = sorted(set.intersection(*(set(t.videos) for t in group)), key=list(group[0].videos).index)
        tests = [t for t in group if t.kind == "test"]
        calib = [t for t in group if t.kind == "calibration"]

        def dsel(t):
            return [next(d for d in dets_of[t.id] if d.camera == c) for c in cams]

        full = {}  # (take id, engine) -> Calibration
        for t in calib:
            dets = dsel(t)
            held = tests or [o for o in calib if o is not t]
            held_kind = "test recordings" if tests else ("other takes" if held else None)
            held_data = [(still_frames(dsel(o)) if o.kind == "test" and o.truth is None else dsel(o), o.board) for o in held]
            truth = read_calibration(t.truth).subset(cams) if t.truth else None
            fr_all, obs_all = M.stack(dets, t.board)

            def record(cal, engine, variant, used_frames, extra, heldout_data, heldout_kind):
                rec = {"rig": rig, "session": sess, "take": t.id, "board": t.board_id, "engine": engine,
                       "variant": variant, "frames_used": int(len(used_frames)),
                       "seconds_used": float(len(used_frames) / (dets[0].fps or 30)) if used_frames is not None else None,
                       **extra}
                fr, obs = M.stack(dets, t.board, used_frames if len(used_frames) else None)
                rec["self"] = M.reprojection(cal, obs) if len(fr) else None
                if heldout_data:
                    sc, _ = _score(cal, heldout_data)
                    rec["heldout"] = sc
                    rec["heldout_kind"] = heldout_kind
                if truth is not None:
                    rec["truth"] = _truth_error(cal, truth, heldout_data or [(dets, t.board)])
                if (rig, sess) in pose_data:
                    import poses as P
                    rec["poses"] = {pid: P.errors(cal, cp, X2) for pid, cp, X2, ln in pose_data[(rig, sess)]
                                    if ln is None and set(cp) <= set(cal.names)}
                    rec["rulers"] = {pid: P.ruler_errors(cal, cp, X2, ln) for pid, cp, X2, ln in pose_data[(rig, sess)]
                                     if ln is not None and set(cp) <= set(cal.names)}
                results["calibrations"].append(rec)
                return rec

            # 1. Full take, each engine; plus the calibration made at the time, if given.
            for eng in engine_names:
                try:
                    cal, ex = _calibrate(eng, t, dets, None, out, calibrat3)
                except Exception as e:  # keep going; the report lists failures
                    log(f"  {eng} failed on {t.id}: {e}")
                    results["calibrations"].append({"rig": rig, "session": sess, "take": t.id, "board": t.board_id,
                                                    "engine": eng, "variant": "full", "failed": str(e)[:500]})
                    continue
                full[(t.id, eng)] = cal
                write_calibration(cal, cal_dir / f"{t.id}__{eng}__full.toml", f"board study: {t.id}, {eng}, all frames")
                r = record(cal, eng, "full", fr_all, ex, held_data, held_kind)
                _log_rec(log, r)
            if t.reference and t.reference.exists():
                ref = read_calibration(t.reference)
                if set(cams) <= set(ref.names):
                    r = record(ref.subset(cams), "reference", "full", fr_all, {"file": str(t.reference)}, held_data, held_kind)
                    _log_rec(log, r)

            # 2. Disjoint interleaved time blocks: pseudo-repeats from one recording.
            if splits >= 2:
                groups = _blocks(dets, block_s, splits)
                split_cals = []
                for j, g in enumerate(groups):
                    others = np.concatenate([x for k, x in enumerate(groups) if k != j])
                    ho = [([d.subset(others) for d in dets], t.board)]
                    try:
                        cal, ex = _calibrate("anipose", t, dets, g, out, calibrat3)
                    except Exception as e:
                        log(f"  split {j} failed on {t.id}: {e}")
                        continue
                    split_cals.append(cal)
                    r = record(cal, "anipose", f"split{j + 1}of{splits}", g, ex,
                               held_data or ho, held_kind or "other blocks of the same take")
                if len(split_cals) >= 2:
                    test_data = held_data or [(dets, t.board)]
                    Xs = [_score(c, test_data)[1] for c in split_cals]
                    Xs = [np.concatenate([x.reshape(-1, 3) for x in xs]) for xs in Xs]
                    rp = M.repeatability(split_cals, Xs)
                    results["repeatability"].append({"rig": rig, "session": sess, "board": t.board_id, "take": t.id,
                                                     "kind": f"{splits} disjoint parts of one recording", "engine": "anipose", **rp})

            # 3. First N seconds of the take (how long to record).
            if prefixes and "anipose" in engine_names:
                fps = dets[0].fps or 30.0
                allf = np.unique(np.concatenate([d.frames for d in dets]))
                if held_data:
                    ho, hk, pool = held_data, held_kind, allf
                else:  # prefixes from the first two thirds, scored on the last third
                    cut = allf[int(len(allf) * 2 / 3)]
                    ho, hk, pool = [([d.subset(allf[allf >= cut]) for d in dets], t.board)], "last third of the take", allf[allf < cut]
                span = pool[-1] - pool[0] + 1  # in video frames (detection may skip frames)
                for p in prefixes:
                    sel = pool[pool < pool[0] + p * fps]
                    if p * fps > span * 1.02 or len(sel) < 20:
                        break
                    try:
                        cal, ex = _calibrate("anipose", t, dets, sel, out, calibrat3)
                    except Exception as e:
                        log(f"  prefix {p}s failed on {t.id}: {e}")
                        continue
                    record(cal, "anipose", f"first{p}s", sel, ex, ho, hk)

            # 4. Where the board was found / missed (full anipose calibration, else any).
            cal = full.get((t.id, "anipose")) or next((c for (tid, _), c in full.items() if tid == t.id), None)
            if cal is not None:
                cov = M.coverage(cal, dets, t.board, obs_all, fr_all)
                rows = cov.pop("rows")
                np.save(cache / t.id / "coverage_rows.npy", rows)
                results["coverage"].append({"rig": rig, "session": sess, "take": t.id, "board": t.board_id,
                                            "square_mm": t.board.square_length, **cov,
                                            "curve_square_px": M.detection_curve(rows, 1, np.array([0, 6, 8, 10, 12, 15, 20, 25, 30, 40, 60, 100, 1e9])),
                                            "curve_tilt_deg": M.detection_curve(rows, 2, np.arange(0, 95, 10.0))})

        # 5. Repeatability across separate recordings with the same board.
        for eng in engine_names:
            byb = {}
            for t in calib:
                if (t.id, eng) in full:
                    byb.setdefault(t.board_id, []).append(t)
            for bid, ts in byb.items():
                if len(ts) < 2:
                    continue
                cals = [full[(t.id, eng)] for t in ts]
                test_data = [(dsel(o), o.board) for o in (tests or [x for x in calib if x.board_id != bid])] or \
                            [(dsel(o), o.board) for o in ts]
                Xs = [np.concatenate([x.reshape(-1, 3) for x in _score(c, test_data)[1]]) for c in cals]
                rp = M.repeatability(cals, Xs)
                results["repeatability"].append({"rig": rig, "session": sess, "board": bid, "take": ",".join(t.id for t in ts),
                                                 "kind": f"{len(ts)} separate recordings", "engine": eng, **rp})
    engines.stop_servers()
    (out / "results.json").write_text(json.dumps(results, indent=1, default=_json))
    return results


def _json(o):
    if isinstance(o, (np.floating, np.integer)):
        return o.item()
    if isinstance(o, np.ndarray):
        return o.tolist()
    return str(o)


def _calibrate(engine: str, take: Take, dets, frames, out: Path, calibrat3: Path | None):
    if engine == "anipose":
        return engines.calibrate_anipose(dets, take.board, frames)
    if engine == "calibrat3":
        if calibrat3 is None:
            raise RuntimeError("--calibrat3 <checkout> is required for the calibrat3 engine")
        work = out / "calibrat3" / take.id
        work.mkdir(parents=True, exist_ok=True)
        if frames is None:  # always an H.264 copy: Playwright's Chromium has no HEVC decoder
            session = engines.cut_session(take.videos, np.arange(max(d.n_frames for d in dets)), take.board, work / "full")
            tag = "full"
        else:
            tag = f"f{int(frames[0])}-{int(frames[-1])}-{len(frames)}"
            session = engines.cut_session(take.videos, frames, take.board, work / tag)
        target = len(np.unique(np.concatenate([d.frames for d in dets]))) if frames is None else len(frames)
        return engines.calibrate_calibrat3(Path(session), work / f"{tag}.toml", calibrat3, min(target, 2000),
                                           work / f"{tag}.log")
    raise ValueError(engine)


def _log_rec(log, r):
    s = r.get("self") or {}
    h = (r.get("heldout") or {})
    g = h.get("geometry", {})
    log(f"  {r['take']} {r['engine']}/{r['variant']}: reprojection {s.get('median_px', float('nan')):.2f} px"
        + (f"; held-out ({r.get('heldout_kind')}) {h['reprojection']['median_px']:.2f} px, ruler {g.get('long_length_err_pct', float('nan')):.2f} %, "
           f"board fit {g.get('fit_rms_mm', float('nan')):.2f} mm" if h else "")
        + (f"; vs truth {r['truth']['vs_truth_median_mm']:.2f} mm" if r.get("truth") else ""))


def scan(root: Path, name: str = "") -> str:
    """study.toml text for a folder laid out as the protocol asks:
    <root>/<rig>/<session>/<board-id>_take<N>/ (calibration) and
    <root>/<rig>/<session>/test_<board-id>[_<anything>]/ (still test-board poses).
    <board-id> is a catalogue id (``board_study boards``) or the folder has a board.toml."""
    import re
    lines = [f'[study]\nname = "{name or root.name}"\n']
    for rig in sorted(p for p in root.iterdir() if p.is_dir() and not p.name.startswith(".")):
        for sess in sorted(p for p in rig.iterdir() if p.is_dir() and not p.name.startswith(".")):
            for rec in sorted(p for p in sess.iterdir() if p.is_dir() and not p.name.startswith(".")):
                m = re.match(r"^(test_)?(.+?)(?:_take\d+|_[^_]*)?$", rec.name)
                kind = "test" if rec.name.startswith("test_") else "calibration"
                bid = next((k for k in sorted(B.CALIBIO, key=len, reverse=True) if k in rec.name), None)
                if bid is None and not (rec / "board.toml").exists():
                    lines.append(f"# skipped {rec}: no catalogue board id in the name and no board.toml")
                    continue
                lines.append(f'[[take]]\nid = "{rig.name}-{sess.name}-{rec.name}"\nrig = "{rig.name}"\n'
                             f'session = "{sess.name}"\n' + (f'board = "{bid}"\n' if bid else "") +
                             f'path = "{rec}"\nkind = "{kind}"\n')
    return "\n".join(lines)


def merge(out: Path, parts: list[Path]) -> None:
    """Combine results.json of runs made separately (e.g. one per rig with --rig)."""
    res = None
    for p in parts:
        r = json.loads((p / "results.json").read_text())
        if res is None:
            res = r
            continue
        for k in ("takes", "calibrations", "repeatability", "coverage"):
            res[k] += r[k]
    out.mkdir(parents=True, exist_ok=True)
    (out / "results.json").write_text(json.dumps(res, indent=1, default=_json))
