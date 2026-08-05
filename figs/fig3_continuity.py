#!/usr/bin/env python
"""Task 4 — identity continuity over full sessions.

Runs the REAL production tracker (figs/fig3-bench/fig3_bench.mjs, default
champion thresholds) full-length on real sessions, then reuses motmetrics'
OWN per-frame event log (MOTAccumulator.mot_events — the exact same
accumulator construction as figs/fig3_score.py / $BENCH/scripts/evaluate.py)
to extract, per GT animal per camera: the frames at which its identity
SWITCHED. From that:
  - track_lengths_frames: histogram of continuous-identity run lengths
    (frames between consecutive switches) across all sessions/cameras/animals.
  - sustained_identity_fraction: per (session, animal), 1 - (num_switches /
    num_GT-occupied_frames), averaged across cameras.
  - switch_rate_by_distance: for the SLAP-2M hard session (the one session
    with an independent 3D GT reconstruction, points3d.h5 — "the proofread
    3D" the handoff asks for), bins ALL frames by the minimum pairwise
    inter-animal 3D distance that frame, and reports switches-per-bin /
    frames-per-bin. Proximity is the requested proxy for occlusion-heavy
    interaction; no behavior labels are used or implied.

Output: figs/out/fig3_continuity.json
"""
import json
import subprocess
import sys
import time
from glob import glob
from pathlib import Path

import h5py
import numpy as np
import pandas as pd

REPO = Path(__file__).resolve().parent.parent
BENCH = Path("/root/vast/eric/luc3d-bench")
BMROOT = Path("/root/vast/eric/BMimica")
DRIVER = REPO / "figs" / "fig3-bench" / "fig3_bench.mjs"
OUT_DIR = REPO / "figs" / "out"
TMP_DIR = OUT_DIR / "tmp" / "continuity"

MASTER = BENCH / "outputs" / "sleap_nn_master_sheet.tsv"
KEEPTRACK = BENCH / "outputs" / "keeptrack_h5s"
BM_DET = BENCH / "outputs" / "bmimica" / "det_h5"
BM_GT = BENCH / "outputs" / "bmimica" / "gt"
BM_CAMS = ["21241563", "21369048", "21372315", "21372316", "22085397"]
BM_SESSIONS = ["20250827_141755", "20250829_155407"]  # 2 full BMimica sessions (~180k frames each)

SLAP_HARD_SESSION_IDX = 70  # 10072022145420, 4 animals, 6 cams — the flagship hard session
SLAP_CAMS = ["back", "backL", "mid", "midL", "top", "topL"]
SLAP_POINTS3D = Path("/root/talmolab-smb/eric/slap_2m/2022-10-07/10072022145420/points3d.h5")

sys.path.insert(0, str(BENCH / "scripts"))
import evaluate as ev  # noqa: E402
import motmetrics as mm  # noqa: E402


def bm_calib(session):
    hits = glob(str(BMROOT / session / "calibration" / "*_calibration.toml"))
    return hits[0] if hits else None


def run_driver(cmd, timeout):
    r = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    if r.returncode != 0:
        return False, r.stderr[-800:].replace("\n", " ")
    return True, None


def per_camera_events_for_cam(luc, cam, det, gt, occ, num_animals):
    """Build a per-camera MOTAccumulator (same construction as figs/fig3_score.py)
    and return (mot_events DataFrame, occupied_frame_count_per_animal, n_frames)."""
    nf = min(gt.shape[0], det.shape[0])
    ndet = det.shape[1]
    ids = ev.luc3d_assignments_for_cam(luc, cam, nf, ndet)
    acc = mm.MOTAccumulator(auto_id=False)
    occupied = np.zeros(gt.shape[1], dtype=int)
    for fi in range(nf):
        gtb, gti = [], []
        for t in range(gt.shape[1]):
            if not occ[fi, t]:
                continue
            b = ev.bbox_from_kpts(gt[fi, t])
            if b is not None:
                gtb.append(b)
                gti.append(int(t))
                occupied[t] += 1
        prb, prid = [], []
        for a in range(ndet):
            b = ev.bbox_from_kpts(det[fi, a])
            if b is None:
                continue
            g = int(ids[fi, a])
            if g < 0:
                continue
            prb.append(b)
            prid.append(g)
        gtn = np.array(gtb) if gtb else np.empty((0, 4))
        prn = np.array(prb) if prb else np.empty((0, 4))
        dist = mm.distances.iou_matrix(gtn, prn, max_iou=0.5)
        acc.update(gti, prid, dist, frameid=fi)
    return acc.mot_events, occupied, nf


def track_lengths_from_switches(switch_frames, n_frames):
    """Segment [0, n_frames) at switch_frames boundaries; return run lengths."""
    bounds = sorted(set(switch_frames))
    lengths = []
    prev = 0
    for b in bounds:
        if b > prev:
            lengths.append(b - prev)
        prev = b
    if n_frames > prev:
        lengths.append(n_frames - prev)
    return lengths


def main():
    TMP_DIR.mkdir(parents=True, exist_ok=True)
    caveats = []
    blocked = []
    all_track_lengths = []
    sustained = []  # [{session, animal, fraction}]
    sessions_used = []

    # --- BMimica: 2 full sessions, 2 animals, 5 cams ---
    for sid in BM_SESSIONS:
        print(f"=== BMimica {sid} (full length) ===", flush=True)
        calib = bm_calib(sid)
        det_dir = BM_DET / sid
        out_path = TMP_DIR / f"bmimica_{sid}.json"
        cmd = ["node", str(DRIVER), "--session-idx", "0", "--num-animals", "2",
               "--calibration", calib, "--pred-h5-dir", str(det_dir),
               "--out", str(out_path), "--cameras", ",".join(BM_CAMS)]
        t0 = time.time()
        ok, err = run_driver(cmd, timeout=900)
        if not ok:
            blocked.append(f"BMimica {sid}: driver failed: {err}")
            print(f"  FAILED: {err}", flush=True)
            continue
        print(f"  driver done in {time.time()-t0:.0f}s", flush=True)
        sessions_used.append(sid)
        luc = json.loads(out_path.read_text())

        animal_switches = {0: 0, 1: 0}
        animal_occ = {0: 0, 1: 0}
        for cam in BM_CAMS:
            with h5py.File(det_dir / f"{cam}_predictions.h5", "r") as f:
                det = f["tracks"][0][...]
            gt, occ = ev.load_gt(BM_GT / sid / cam / "proofread.analysis.h5")
            events, occupied, nf = per_camera_events_for_cam(luc, cam, det, gt, occ, 2)
            sw = events[events["Type"] == "SWITCH"]
            switch_frames_by_animal = {}
            for oid, grp in sw.groupby("OId"):
                frames = grp.index.get_level_values("FrameId").tolist()
                switch_frames_by_animal[int(oid)] = frames
                animal_switches[int(oid)] = animal_switches.get(int(oid), 0) + len(frames)
                all_track_lengths.extend(track_lengths_from_switches(frames, nf))
            for a in range(2):
                animal_occ[a] = animal_occ.get(a, 0) + int(occupied[a])
                if a not in switch_frames_by_animal:
                    all_track_lengths.extend(track_lengths_from_switches([], nf))
        for a in range(2):
            occ_n = animal_occ[a]
            frac = 1.0 - (animal_switches[a] / occ_n) if occ_n > 0 else None
            sustained.append({"session": sid, "animal": a,
                               "fraction": max(0.0, frac) if frac is not None else None})
        print(f"  switches per animal: {animal_switches}, occupied frames: {animal_occ}", flush=True)

    # --- SLAP-2M hard session: full length, 4 animals, 6 cams (the flagship session) ---
    print("=== SLAP-2M hard session 10072022145420 (full length) ===", flush=True)
    master_df = pd.read_csv(MASTER, sep="\t", index_col=0).reset_index(drop=True)
    row = master_df.iloc[SLAP_HARD_SESSION_IDX]
    slap_session = str(row["session"])
    out_path = TMP_DIR / f"slap2m_{slap_session}.json"
    cmd = ["node", str(DRIVER), "--session-idx", str(SLAP_HARD_SESSION_IDX), "--num-animals", "4",
           "--calibration", row["calibration_toml"], "--pred-h5-dir", str(KEEPTRACK),
           "--out", str(out_path), "--cameras", ",".join(SLAP_CAMS), "--max-frames", "18255"]
    t0 = time.time()
    ok, err = run_driver(cmd, timeout=900)
    switch_rate_by_distance = []
    if not ok:
        blocked.append(f"SLAP-2M {slap_session}: driver failed: {err}")
        print(f"  FAILED: {err}", flush=True)
    else:
        print(f"  driver done in {time.time()-t0:.0f}s", flush=True)
        sessions_used.append(slap_session)
        luc = json.loads(out_path.read_text())

        animal_switches = {a: 0 for a in range(4)}
        animal_occ = {a: 0 for a in range(4)}
        per_frame_switch_count = {}
        for cam in SLAP_CAMS:
            with h5py.File(KEEPTRACK / f"{cam}_predictions.h5", "r") as f:
                det = f["tracks"][SLAP_HARD_SESSION_IDX][...]
            gt, occ = ev.load_gt(Path(row[f"{cam}_proofread_h5"]))
            events, occupied, nf = per_camera_events_for_cam(luc, cam, det, gt, occ, 4)
            sw = events[events["Type"] == "SWITCH"]
            switch_frames_by_animal = {}
            for oid, grp in sw.groupby("OId"):
                frames = grp.index.get_level_values("FrameId").tolist()
                switch_frames_by_animal[int(oid)] = frames
                animal_switches[int(oid)] = animal_switches.get(int(oid), 0) + len(frames)
                all_track_lengths.extend(track_lengths_from_switches(frames, nf))
                for fr in frames:
                    per_frame_switch_count[fr] = per_frame_switch_count.get(fr, 0) + 1
            for a in range(4):
                animal_occ[a] = animal_occ.get(a, 0) + int(occupied[a])
                if a not in switch_frames_by_animal:
                    all_track_lengths.extend(track_lengths_from_switches([], nf))
        for a in range(4):
            occ_n = animal_occ[a]
            frac = 1.0 - (animal_switches[a] / occ_n) if occ_n > 0 else None
            sustained.append({"session": slap_session, "animal": a,
                               "fraction": max(0.0, frac) if frac is not None else None})
        print(f"  switches per animal: {animal_switches}, occupied frames: {animal_occ}", flush=True)

        # Inter-animal 3D distance per frame, from the proofread 3D reconstruction.
        with h5py.File(SLAP_POINTS3D, "r") as f:
            pts3d = f["tracks"][...]  # (nF, 4, 15, 3)
        nf3 = min(pts3d.shape[0], max(per_frame_switch_count.keys(), default=0) + 1, 18255)

        def animal_centroid(fi, a):
            pts = pts3d[fi, a]  # (15,3)
            valid = np.isfinite(pts).all(axis=1)
            if not valid.any():
                return None
            return pts[valid].mean(axis=0)

        min_dist_per_frame = np.full(nf3, np.nan)
        for fi in range(nf3):
            cents = [animal_centroid(fi, a) for a in range(4)]
            dists = []
            for i in range(4):
                if cents[i] is None:
                    continue
                for j in range(i + 1, 4):
                    if cents[j] is None:
                        continue
                    dists.append(float(np.linalg.norm(cents[i] - cents[j])))
            if dists:
                min_dist_per_frame[fi] = min(dists)

        valid_mask = np.isfinite(min_dist_per_frame)
        edges = np.percentile(min_dist_per_frame[valid_mask], np.linspace(0, 100, 11))
        edges = np.unique(edges)
        for lo, hi in zip(edges[:-1], edges[1:]):
            in_bin = valid_mask & (min_dist_per_frame >= lo) & (min_dist_per_frame < hi)
            frame_idxs = set(np.where(in_bin)[0].tolist())
            n_frames_bin = len(frame_idxs)
            n_switches_bin = sum(cnt for fr, cnt in per_frame_switch_count.items() if fr in frame_idxs)
            switch_rate_by_distance.append({
                "lo_mm": float(lo), "hi_mm": float(hi),
                "switches": int(n_switches_bin), "frames": int(n_frames_bin),
            })
        caveats.append(
            "switch_rate_by_distance uses only the SLAP-2M hard session (10072022145420), "
            "the one session with an independent proofread 3D reconstruction (points3d.h5). "
            "BMimica sessions have no equivalent saved 3D GT so are excluded from this metric "
            "(they still contribute to track_lengths_frames / sustained_identity_fraction). "
            "Distance = minimum pairwise distance between any two animals' valid-node 3D "
            "centroid that frame (proximity, a proxy for occlusion-heavy interaction — no "
            "behavior labels used). Bin edges are deciles of the frame-level distance "
            "distribution (data-driven, not guessed), so bins are equal-frequency in frames, "
            "not equal-width in mm."
        )

    caveats.append(
        "Track lengths / switches come directly from motmetrics' own per-frame event log "
        "(MOTAccumulator.mot_events / Type=='SWITCH'), the SAME accumulator construction used "
        "throughout this benchmark (figs/fig3_score.py, evaluate.py) — not a custom reimplementation."
    )
    caveats.append(
        "sustained_identity_fraction = 1 - (num_switches_for_that_animal / num_GT-occupied_frames "
        "for that animal), averaged across that session's cameras. It is a proxy for continuity, "
        "not a strict 'longest correct run' metric — an animal that switches back and forth "
        "still scores proportionally to switch COUNT, not to whether it eventually reacquires "
        "the right label."
    )
    caveats.append(
        "track_lengths_frames pools BOTH per-camera BMimica runs (2 sessions x 5 cameras) AND "
        "the SLAP-2M hard session (6 cameras) — mixed rig/animal-count corpora — read as a "
        "combined continuity picture, not a single-condition statistic."
    )

    out = {
        "generated_by": "figs/fig3_continuity.py",
        "dataset": "both",
        "detection_pool": f"{BM_DET} (BMimica), {KEEPTRACK} (SLAP-2M)",
        "sessions": sessions_used,
        "metric": "IDF1 (motmetrics) + ID-switches",
        "caveats": caveats,
        "blocked": blocked,
        "track_lengths_frames": sorted(all_track_lengths),
        "sustained_identity_fraction": sustained,
        "switch_rate_by_distance": switch_rate_by_distance,
    }
    OUT_DIR.mkdir(parents=True, exist_ok=True)
    (OUT_DIR / "fig3_continuity.json").write_text(json.dumps(out, indent=2))
    print(f"wrote {OUT_DIR / 'fig3_continuity.json'} "
          f"({len(all_track_lengths)} track-length samples)", flush=True)


if __name__ == "__main__":
    main()
