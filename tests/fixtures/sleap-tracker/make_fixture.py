"""Regenerate tests/fixtures/sleap-tracker/reference.json: synthetic detections
tracked by UPSTREAM sleap-nn, the ground truth for pose/sleap-tracker.js's port
(tests/test-sleap-tracker.mjs compares every track id).

Needs sleap-nn's own source and environment, e.g. with the `sleap-nn` uv tool
and a clone of talmolab/sleap-nn checked out at the commit the port follows:

    ~/.local/share/uv/tools/sleap-nn/bin/python -I \
        tests/fixtures/sleap-tracker/make_fixture.py <path/to/sleap-nn checkout>

The detections are synthetic (no lab data): seeded random walks that pass close
to each other, with dropped detections, missing nodes, spurious extra poses and
empty frames, so every branch of the tracker — new tracks, the track cap,
infeasible pairs, ties where OKS underflows to 0, culling, connect-single-breaks
— is exercised. Coordinates are rounded to 0.01 px BEFORE tracking, so the JSON
numbers are exactly the doubles both implementations see.
"""
import json, subprocess, sys
import numpy as np

src = sys.argv[1]
sys.path.insert(0, src)
import sleap_io as sio
from sleap_nn.tracking.tracker import run_tracker

# run_tracker hands each frame's image to the tracker; the keypoint/box scorers never read it, and
# there is no video behind synthetic detections.
sio.LabeledFrame.image = property(lambda self: None)

rng = np.random.default_rng(20261007)
T, NA, K = 900, 4, 6
template = np.array([[0, 0], [12, -4], [12, 4], [-10, 0], [-24, 0], [-36, 0]], float)  # nose, ears, trunk, tail…
pos = rng.uniform([80, 80], [560, 400], (NA, 2))
head = rng.uniform(0, 2 * np.pi, NA)
frames = []
for f in range(T):
    head += rng.normal(0, 0.15, NA)
    step = np.stack([np.cos(head), np.sin(head)], 1) * rng.uniform(0, 6, (NA, 1))
    if f % 120 < 30:                       # every 4 s the first two animals walk toward each other
        step[0] += (pos[1] - pos[0]) * 0.06
        step[1] += (pos[0] - pos[1]) * 0.06
    pos = np.clip(pos + step, 40, [600, 440])
    dets = []
    if f % 97 != 50:                       # an empty frame now and then
        for a in range(NA):
            if rng.random() < 0.06: continue                       # missed detection
            c, s = np.cos(head[a]), np.sin(head[a])
            p = template @ np.array([[c, s], [-s, c]]) * (1 + 0.15 * a) + pos[a] + rng.normal(0, 1.5, (K, 2))
            p[rng.random(K) < 0.1] = np.nan                         # missing nodes
            if rng.random() < 0.01: p[:] = np.nan                   # all-NaN detection
            dets.append((np.round(p, 2), round(float(rng.uniform(0.3, 1)), 3)))
        if rng.random() < 0.05:                                     # a spurious extra pose
            p = template + rng.uniform([60, 60], [580, 420]) + rng.normal(0, 3, (K, 2))
            dets.append((np.round(p, 2), round(float(rng.uniform(0.05, 0.4)), 3)))
        order = rng.permutation(len(dets))
        dets = [dets[i] for i in order]
    frames.append(dets)

CONFIGS = {
    'known_count_lucid': dict(candidates_method='local_queues', max_tracks=NA, tracking_target_instance_count=NA,
                              post_connect_single_breaks=True, oks_stddev=0.1),
    'sleap_nn_defaults': dict(),
    'known_count_strict': dict(candidates_method='local_queues', max_tracks=NA, tracking_target_instance_count=NA,
                               post_connect_single_breaks=True, window_size=10, scoring_reduction='robust_quantile',
                               robust_best_instance=0.95),
    'greedy_centroids': dict(features='centroids', scoring_method='euclidean_dist', track_matching_method='greedy',
                             max_tracks=NA + 1),
    'bboxes_iou_culled': dict(features='bboxes', scoring_method='iou', candidates_method='local_queues', max_tracks=NA,
                              tracking_target_instance_count=NA, tracking_pre_cull_to_target=1,
                              tracking_pre_cull_iou_threshold=0.5, tracking_clean_instance_count=NA,
                              tracking_clean_iou_threshold=0.3, min_match_points=2, min_new_track_points=3),
    'max_reduction_window1': dict(scoring_reduction='max', window_size=1),
}

skel = sio.Skeleton([f'n{k}' for k in range(K)])
video = sio.Video('synthetic.mp4')
out = {'source': 'talmolab/sleap-nn@' + subprocess.check_output(['git', '-C', src, 'rev-parse', 'HEAD']).decode().strip(),
       'K': K, 'frames': [[{'p': [None if np.isnan(v) else float(v) for v in d[0].ravel()], 's': d[1]} for d in dets] for dets in frames],
       'configs': {}}
for name, cfg in CONFIGS.items():
    lfs, insts = [], []
    for f, dets in enumerate(frames):
        row = []
        for p, s in dets:
            inst = sio.PredictedInstance.from_numpy(p, skeleton=skel, score=s, point_scores=np.ones(K))
            row.append(inst); insts.append(inst)
        lfs.append(sio.LabeledFrame(video=video, frame_idx=f, instances=row))
    tracked = run_tracker(lfs, **cfg)
    present = {id(i) for lf in tracked for i in lf.instances}
    tid = [int(i.track.name.split('_')[1]) if (i.track is not None and id(i) in present) else -1 for i in insts]
    out['configs'][name] = {'kwargs': cfg, 'tracks': tid}
    print(name, 'tracks', len(set(t for t in tid if t >= 0)), 'dropped', tid.count(-1))
path = __file__.rsplit('/', 1)[0] + '/reference.json'
json.dump(out, open(path, 'w'), separators=(',', ':'))
print('wrote', path)
