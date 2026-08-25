#!/usr/bin/env python3
"""Fig 10 swap diagnostic: for a session's noiseless cell, locate every
persistent identity-swap frame and report the source-track pair distance
around it. Confirms (or refutes) that σ=0 IDF1 losses are merge events in the
sDANNCE source tracks, not tracker noise.

Provenance repair (2026-08): the scored C1_sigma0 cells were prepped with
fig10_run.py's cell_seed(dataset, session, 'C1_sigma0'), NOT seed 0 — pass
that seed via --seed so the diagnosed run IS the scored run. The majority
timeline now uses fig10_score.py's exact rule (per-animal per-frame majority
identity across views, ties broken toward the HIGHER identity id) and counts
switches between consecutive OBSERVED frames, so the emitted switch frames
reconcile 1:1 with the scored cell's `switches`. Each event also records
whether the animal's timeline later reverts to the pre-swap identity, and the
session summary records whether each animal ends on its ORIGINAL identity
('reverts in-session').

Usage: fig10_swapdiag.py --session DIR --work DIR [--seed N] [--out FILE]
                         [--scored results/<ds>/<sess>/C1_sigma0.json]
(expects fig10_prep.py + fig10_bench.mjs to have produced work/bench.json &
gt_perm.npy; runs them itself if absent, prepping with --seed)
"""
import argparse, json, os, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fig10_prep import load_pred_3d

PY = sys.executable


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session', required=True)
    ap.add_argument('--work', required=True)
    ap.add_argument('--seed', type=int, default=0,
                    help='prep seed; MUST be cell_seed(dataset, session, cell) '
                         'to diagnose a scored cell')
    ap.add_argument('--out', default=None,
                    help='output JSON path (default <work>/swapdiag.json)')
    ap.add_argument('--scored', default=None,
                    help='scored cell JSON to cross-check switch count against')
    args = ap.parse_args()
    S = args.session.rstrip('/')
    W = args.work
    X = load_pred_3d(S)
    A = X.shape[1]
    if not os.path.exists(os.path.join(W, 'bench.json')):
        subprocess.run([PY, os.path.join(HERE, 'fig10_prep.py'),
                        '--session', S, '--out', W,
                        '--seed', str(args.seed)], check=True,
                       capture_output=True)
        subprocess.run(['node', os.path.join(HERE, 'fig10_bench.mjs'),
                        '--pred-h5-dir', W, '--num-animals', str(A),
                        '--out', os.path.join(W, 'bench.json')], check=True,
                       capture_output=True, cwd=HERE)
    bench = json.load(open(os.path.join(W, 'bench.json')))
    meta = json.load(open(os.path.join(W, 'meta.json')))
    gt = np.load(os.path.join(W, 'gt_perm.npy'))
    cam_idx = {n: i for i, n in enumerate(bench['cameras'])}
    F = gt.shape[1]
    maj = np.full((F, A), -1, np.int64)
    for fr in bench['frames']:
        f = fr['frame']
        votes = [dict() for _ in range(A)]
        for key, ident in fr['assignments']:
            cam, slot = key.rsplit(':', 1)
            a = int(gt[cam_idx[cam], f, int(slot)])
            if a >= 0:
                votes[a][ident] = votes[a].get(ident, 0) + 1
        for a in range(A):
            if votes[a]:
                # fig10_score.py's exact majority rule: most votes, ties broken
                # toward the higher identity id.
                maj[f, a] = max(votes[a].items(), key=lambda kv: (kv[1], kv[0]))[0]

    com = np.nanmean(X, axis=3)
    d = np.linalg.norm(com[:, :, None, :] - com[:, None, :, :], axis=3)
    d[:, np.arange(A), np.arange(A)] = np.inf
    mind = d.min(axis=(1, 2))

    # Switch events between consecutive OBSERVED frames (fig10_score.py's
    # counting), so len(events) == the scored cell's `switches`.
    events = []
    animals = []
    for a in range(A):
        obsf = np.nonzero(maj[:, a] >= 0)[0]
        vals = maj[obsf, a]
        original = int(vals[0]) if len(vals) else -1
        final = int(vals[-1]) if len(vals) else -1
        for i in np.nonzero(np.diff(vals) != 0)[0]:
            f_prev, f_sw = int(obsf[i]), int(obsf[i + 1])
            lo, hi = max(0, f_sw - 50), min(F, f_sw + 51)
            # does this animal's timeline ever return to the pre-swap identity?
            reverts = bool((vals[i + 1:] == vals[i]).any())
            events.append(dict(
                animal=a, frame=f_sw, prev_frame=f_prev,
                from_id=int(vals[i]), to_id=int(vals[i + 1]),
                dist_at_swap_mm=round(float(mind[f_sw]), 2),
                min_dist_within_50f_mm=round(float(mind[lo:hi].min()), 2),
                argmin_frame=int(lo + np.argmin(mind[lo:hi])),
                reverts_to_from_id_later=reverts))
        animals.append(dict(
            animal=a, original_id=original, final_id=final,
            n_switches=int((np.diff(vals) != 0).sum()),
            reverts_in_session=bool(len(vals) and (np.diff(vals) != 0).any()
                                    and final == original))
        )
    scored_switches = None
    if args.scored and os.path.exists(args.scored):
        scored_switches = json.load(open(args.scored)).get('switches')
    out = dict(session=S, animals=A, frames=F, seed=meta.get('seed'),
               global_min_pair_mm=round(float(mind.min()), 2),
               switch_frames=sorted(e['frame'] for e in events),
               n_switches=len(events),
               scored_cell_switches=scored_switches,
               switch_count_matches_scored=(
                   None if scored_switches is None
                   else len(events) == scored_switches),
               reverts_in_session=[a['animal'] for a in animals
                                   if a['reverts_in_session']],
               per_animal=animals,
               events=events)
    p = args.out or os.path.join(W, 'swapdiag.json')
    os.makedirs(os.path.dirname(os.path.abspath(p)), exist_ok=True)
    json.dump(out, open(p, 'w'), indent=1)
    print(json.dumps(out, indent=1))


if __name__ == '__main__':
    main()
