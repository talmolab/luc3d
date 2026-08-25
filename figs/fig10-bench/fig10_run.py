#!/usr/bin/env python3
"""Fig 10 run-matrix orchestrator: prep -> bench -> score per (session, cell).

Cells follow PLAN-fig10-triads-bedding.md §4. Each cell is prep'd into a temp
work dir, tracked with the shipped eric/switch-correct CrossViewTracker
(fig10_bench.mjs), scored against the permutation sidecar, then the bulky H5s
are deleted. Results accumulate in results/<dataset>/<session>/<cell>.json and
one aggregate results/all.jsonl. Re-runs skip cells whose score JSON exists.

Usage:
  fig10_run.py [--datasets triads,bedding] [--jobs 4] [--max-frames 0]
               [--cells C1,C2,...] [--sessions NAME,...]
"""
import argparse, hashlib, itertools, json, os, shutil, subprocess, sys
from concurrent.futures import ProcessPoolExecutor, as_completed

HERE = os.path.dirname(os.path.abspath(__file__))
PY = '/root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs/.venv/bin/python'
DATASETS = {
    'triads':  '/root/vast/eric/s-DANNCE-data/s-DANNCE-TRIADS',
    'bedding': '/root/vast/eric/s-DANNCE-data/s-DANNCE-BEDDING',
    'soc1':    '/root/vast/eric/s-DANNCE-data/s-DANNCE-SCN2A_SOC1',
    'soc3':    '/root/vast/eric/s-DANNCE-data/s-DANNCE-SCN2A_SOC3',
}

def cells():
    out = []
    for s in [0, 1, 2, 3, 5, 10, 20]:                       # C1 noise sweep
        out.append((f'C1_sigma{s}', {'noise_px': s}))
    for p in [0.1, 0.25, 0.5]:                              # C2 instance dropout
        out.append((f'C2_drop{p}', {'noise_px': 3, 'drop_instance': p}))
    for r in [0.25, 0.5]:                                   # C2b node dropout
        out.append((f'C2b_nodedrop{r}', {'noise_px': 3, 'drop_node': r}))
    for q in [0.25, 0.5]:                                   # C3 occlusion-correlated
        out.append((f'C3_occl{q}', {'noise_px': 3, 'occl_dist': 100, 'occl_prob': q}))
    for s in [0, 3]:                                        # C4 COM-only
        out.append((f'C4_com_sigma{s}', {'noise_px': s, 'com_only': True}))
    # C4u (2026-08-17, adversarial review Agent 2 MAJOR #6): like-for-like COM
    # arm — COMs forced from SDANNCE com3d_used.mat (the centroids the sDANNCE
    # pass actually consumed), so the COM and keypoint arms share GT identity
    # provenance for ALL datasets, not just BEDDING (whose C4 already fell back
    # to com3d_used). At sigma=0 BEDDING's C4u should reproduce its C4.
    for s in [0, 3]:
        out.append((f'C4u_comused_sigma{s}',
                    {'noise_px': s, 'com_only': True, 'com_source': 'used'}))
    # C7 camera-count ablation at sigma=3. Subsets chosen for maximal angular
    # spread on the measured rig ring (azimuth order cam 4,6,3,1,2,5 at ~60deg):
    # k=2 is an opposite pair; k=4/5 drop opposite/adjacent-most cameras.
    # k=6 is C1_sigma3 (not re-run).
    for k, cams in [(2, 'cam_1,cam_4'), (3, 'cam_2,cam_3,cam_4'),
                    (4, 'cam_1,cam_3,cam_4,cam_5'),
                    (5, 'cam_1,cam_2,cam_3,cam_4,cam_5')]:
        out.append((f'C7_cams{k}', {'noise_px': 3, 'cameras': cams}))
        out.append((f'C7b_cams{k}_sigma10', {'noise_px': 10, 'cameras': cams}))
        # C7c/C7d (Eric 2026-08-16): the placed 10f runs at sigma=0 —
        # clean vs 25% instance dropout, both noiseless.
        out.append((f'C7c_cams{k}_sigma0', {'noise_px': 0, 'cameras': cams}))
        out.append((f'C7d_cams{k}_drop25', {'noise_px': 0, 'drop_instance': 0.25,
                                            'cameras': cams}))
        # C7e (Eric 2026-08-16, second revision): the placed 10f is the camera
        # sweep UNDER 25% dropout at sigma=0 (left, C7d) and sigma=3 (right,
        # C7e); k=6 for the right arm is C2_drop0.25.
        out.append((f'C7e_cams{k}_s3drop25', {'noise_px': 3, 'drop_instance': 0.25,
                                              'cameras': cams}))
        # C7f (Eric 2026-08-16, fourth 10f revision): sigma=3 + 10% dropout;
        # k=6 endpoint is C2_drop0.1.
        out.append((f'C7f_cams{k}_s3drop10', {'noise_px': 3, 'drop_instance': 0.1,
                                              'cameras': cams}))
    # the k=6 endpoint for the dropout arm (sigma=0 + 25% dropout, full rig) —
    # C2_drop0.25 is at sigma=3 and cannot stand in for it.
    out.append(('C7d_cams6_drop25', {'noise_px': 0, 'drop_instance': 0.25}))
    # C8 (Eric 2026-08-16): 10g's dropout axis moves to sigma=0; 50% needs its
    # own cell (25% = C7d_cams6_drop25, 0% = C1_sigma0).
    out.append(('C8_drop50_sigma0', {'noise_px': 0, 'drop_instance': 0.5}))
    return out

def cell_seed(dataset, session, cell):
    return int(hashlib.sha256(f'{dataset}/{session}/{cell}'.encode()).hexdigest()[:8], 16)

def run_cell(dataset, root, session, cell_name, cond, max_frames):
    res_dir = os.path.join(HERE, 'results', dataset, session)
    os.makedirs(res_dir, exist_ok=True)
    score_path = os.path.join(res_dir, f'{cell_name}.json')
    if os.path.exists(score_path):
        return f'SKIP {dataset}/{session}/{cell_name}'
    S = os.path.join(root, session)
    work = os.path.join(HERE, 'work', f'{dataset}__{session}__{cell_name}')
    shutil.rmtree(work, ignore_errors=True)
    try:
        cameras = cond.get('cameras')
        prep = [PY, os.path.join(HERE, 'fig10_prep.py'), '--session', S, '--out', work,
                '--seed', str(cell_seed(dataset, session, cell_name))]
        for k, v in cond.items():
            if k == 'com_only':
                prep.append('--com-only')
            elif k == 'cameras':
                pass                        # bench-side option, prep writes all cams
            else:
                prep += [f'--{k.replace("_", "-")}', str(v)]
        if max_frames:
            prep += ['--max-frames', str(max_frames)]
        r = subprocess.run(prep, capture_output=True, text=True)
        if r.returncode:
            return f'PREP-FAIL {dataset}/{session}/{cell_name}: {r.stderr[-400:]}'
        meta = json.load(open(os.path.join(work, 'meta.json')))
        bench_out = os.path.join(work, 'bench.json')
        bench_cmd = ['node', os.path.join(HERE, 'fig10_bench.mjs'),
                     '--pred-h5-dir', work, '--num-animals', str(meta['animals']),
                     '--out', bench_out]
        if cameras:
            bench_cmd += ['--cameras', cameras]
        r = subprocess.run(bench_cmd, capture_output=True, text=True, cwd=HERE)
        if r.returncode:
            return f'BENCH-FAIL {dataset}/{session}/{cell_name}: {r.stderr[-400:]}'
        r = subprocess.run([PY, os.path.join(HERE, 'fig10_score.py'),
                            '--bench', bench_out, '--gt-dir', work,
                            '--json', score_path],
                           capture_output=True, text=True)
        if r.returncode:
            return f'SCORE-FAIL {dataset}/{session}/{cell_name}: {r.stderr[-400:]}'
        score = json.load(open(score_path))
        score.update(dataset=dataset, session_name=session, cell=cell_name)
        json.dump(score, open(score_path, 'w'), indent=1)
        with open(os.path.join(HERE, 'results', 'all.jsonl'), 'a') as f:
            f.write(json.dumps(score) + '\n')
        return (f'OK {dataset}/{session}/{cell_name} idf1={score["idf1"]} '
                f'acc={score["accuracy"]} sw={score["switches"]}')
    finally:
        shutil.rmtree(work, ignore_errors=True)

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--datasets', default='triads,bedding')
    ap.add_argument('--jobs', type=int, default=4)
    ap.add_argument('--max-frames', type=int, default=0)
    ap.add_argument('--cells', default=None, help='comma list of cell names to run')
    ap.add_argument('--sessions', default=None)
    args = ap.parse_args()

    all_cells = cells()
    if args.cells:
        want = set(args.cells.split(','))
        all_cells = [c for c in all_cells if c[0] in want]
    jobs = []
    for ds in args.datasets.split(','):
        root = DATASETS[ds]
        sessions = sorted(d for d in os.listdir(root)
                          if os.path.isdir(os.path.join(root, d, 'calibration')))
        if args.sessions:
            keep = set(args.sessions.split(','))
            sessions = [s for s in sessions if s in keep]
        for sess, (cn, cond) in itertools.product(sessions, all_cells):
            jobs.append((ds, root, sess, cn, cond, args.max_frames))
    print(f'{len(jobs)} cells, {args.jobs} workers', flush=True)
    done = 0
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        futs = [ex.submit(run_cell, *j) for j in jobs]
        for f in as_completed(futs):
            done += 1
            print(f'[{done}/{len(jobs)}] {f.result()}', flush=True)

if __name__ == '__main__':
    main()
