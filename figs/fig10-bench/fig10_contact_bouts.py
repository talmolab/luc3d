#!/usr/bin/env python3
"""Fig 10 contact-bout deposit (provenance repair, 2026-08).

The legend's bouts-per-session claim had no deposited numbers. Per dataset,
per session: contact frames are frames whose minimum inter-animal COM pair
distance (COM = nanmean over keypoints of load_pred_3d, as in
fig10_paneldata.py) is < 100 mm; a contact BOUT is a maximal run of
consecutive contact frames. Deposits per-session bout counts (+ contact
frames), per-dataset totals, and the mean bouts/session to
results/agg/contact_bouts.json.

Usage: fig10_contact_bouts.py
"""
import json, os, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fig10_prep import load_pred_3d
from fig10_run import DATASETS

CONTACT_MM = 100.0
AGG = os.path.join(HERE, 'results', 'agg')


def session_bouts(S):
    X = load_pred_3d(S)                                   # (F,A,3,N)
    com = np.nanmean(X, axis=3)                           # (F,A,3)
    A = com.shape[1]
    d = np.linalg.norm(com[:, :, None, :] - com[:, None, :, :], axis=3)
    d[:, np.arange(A), np.arange(A)] = np.inf
    mind = d.min(axis=(1, 2))                             # (F,)
    contact = mind < CONTACT_MM                           # NaN mind -> False
    # bouts = maximal runs of consecutive True
    edges = np.diff(contact.astype(np.int8))
    n_bouts = int((edges == 1).sum()) + int(contact[0])
    return dict(frames=int(contact.shape[0]), animals=A,
                contact_frames=int(contact.sum()), bouts=n_bouts,
                contact_fraction=round(float(contact.mean()), 4))


def main():
    out = {'contact_threshold_mm': CONTACT_MM, 'datasets': {}}
    for ds, root in DATASETS.items():
        sessions = {}
        for sess in sorted(os.listdir(root)):
            S = os.path.join(root, sess)
            if not os.path.isdir(os.path.join(S, 'calibration')):
                continue
            sessions[sess] = session_bouts(S)
            print(f'{ds}/{sess}: bouts={sessions[sess]["bouts"]} '
                  f'contact_frames={sessions[sess]["contact_frames"]}', flush=True)
        bouts = [s['bouts'] for s in sessions.values()]
        out['datasets'][ds] = dict(
            sessions=sessions,
            n_sessions=len(sessions),
            total_bouts=int(np.sum(bouts)),
            total_contact_frames=int(np.sum([s['contact_frames']
                                             for s in sessions.values()])),
            mean_bouts_per_session=round(float(np.mean(bouts)), 2))
    os.makedirs(AGG, exist_ok=True)
    p = os.path.join(AGG, 'contact_bouts.json')
    json.dump(out, open(p, 'w'), indent=1)
    print(json.dumps({ds: v['mean_bouts_per_session']
                      for ds, v in out['datasets'].items()}, indent=1))
    print(f'wrote {p}')


if __name__ == '__main__':
    main()
