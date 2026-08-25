#!/usr/bin/env python3
"""Fig 10 C0 defaults audit (provenance repair, 2026-08).

The benchmark's C0 claim — the tracker ran with the shipped defaults (sync
association, stale=20, distanceThreshold=25, corr3dWeight=6, corr2dWeight=1) —
was never verified by an actual readback. This script runs ONE C1_sigma0 cell
per dataset (prep with the exact fig10_run.py cell_seed, bench with no
--params) using the patched fig10_bench.mjs, which now emits `effectiveConfig`:
the hooks' threshold source (getTrackingThresholds over THRESHOLD_DEFAULTS +
__BENCH overrides) AND the fields a CrossViewTracker instance constructed via
the same hp path actually holds. Each dataset's effectiveConfig is asserted
against the claimed defaults and everything is deposited to
results/agg/c0_audit.json. Work dirs are scratch (work/c0audit__*) — scored
results/<dataset>/ cells are not touched.

Usage: fig10_c0_audit.py [--datasets triads,bedding,soc1,soc3] [--jobs 4]
"""
import argparse, json, os, shutil, subprocess, sys
from concurrent.futures import ProcessPoolExecutor

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fig10_run import DATASETS, cell_seed

PY = sys.executable
CELL = 'C1_sigma0'
# one representative session per dataset
SESSIONS = {
    'triads':  '2023_03_01_M1_M2_M3',
    'bedding': '2024_05_05_F1_F2',
    'soc1':    '2022_09_22_M3_M4',
    'soc3':    '2022_10_04_M1_M2',
}
CLAIMED = dict(association='sync', stale=20, distanceThreshold=25,
               corr3dWeight=6, corr2dWeight=1)


def audit_one(dataset):
    session = SESSIONS[dataset]
    S = os.path.join(DATASETS[dataset], session)
    seed = cell_seed(dataset, session, CELL)
    work = os.path.join(HERE, 'work', f'c0audit__{dataset}__{session}')
    shutil.rmtree(work, ignore_errors=True)
    try:
        r = subprocess.run([PY, os.path.join(HERE, 'fig10_prep.py'),
                            '--session', S, '--out', work, '--seed', str(seed)],
                           capture_output=True, text=True)
        if r.returncode:
            return dataset, dict(status='PREP-FAIL', stderr=r.stderr[-400:])
        meta = json.load(open(os.path.join(work, 'meta.json')))
        bench_out = os.path.join(work, 'bench.json')
        r = subprocess.run(['node', os.path.join(HERE, 'fig10_bench.mjs'),
                            '--pred-h5-dir', work,
                            '--num-animals', str(meta['animals']),
                            '--out', bench_out],
                           capture_output=True, text=True, cwd=HERE)
        if r.returncode:
            return dataset, dict(status='BENCH-FAIL', stderr=r.stderr[-400:])
        bench = json.load(open(bench_out))
        eff = bench['effectiveConfig']
        thr, trk = eff['thresholds'], eff['tracker']
        checks = {
            'association_sync': eff['association'].startswith('sync'),
            'stale_20': thr['stale'] == 20 and trk['stale'] == 20,
            'distanceThreshold_25': (thr['distanceThreshold'] == 25
                                     and trk['distThresh'] == 25),
            'corr3dWeight_6': thr['corr3dWeight'] == 6 and trk['corr3d'] == 6,
            'corr2dWeight_1': thr['corr2dWeight'] == 1 and trk['corr2d'] == 1,
        }
        return dataset, dict(
            status='PASS' if all(checks.values()) else 'FAIL',
            session=session, cell=CELL, seed=seed,
            claimed=CLAIMED, checks=checks, effectiveConfig=eff,
            framesProcessed=bench['framesProcessed'],
            detections=bench['detections'],
            runtimeSeconds=bench['runtimeSeconds'])
    finally:
        shutil.rmtree(work, ignore_errors=True)


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--datasets', default='triads,bedding,soc1,soc3')
    ap.add_argument('--jobs', type=int, default=4)
    args = ap.parse_args()
    datasets = args.datasets.split(',')
    out = {}
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        for ds, res in ex.map(audit_one, datasets):
            out[ds] = res
            print(f'[{ds}] {res["status"]}', flush=True)
    dep = os.path.join(HERE, 'results', 'agg', 'c0_audit.json')
    os.makedirs(os.path.dirname(dep), exist_ok=True)
    json.dump(out, open(dep, 'w'), indent=1)
    print(json.dumps({ds: r['status'] for ds, r in out.items()}, indent=1))
    if any(r['status'] != 'PASS' for r in out.values()):
        print('C0 AUDIT FAILED — effective config does not match the claimed '
              'defaults; DO NOT mask this.', file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
