#!/usr/bin/env python3
"""Fig 10 verification controls — each targets a specific bug class that could
fake the headline result (IDF1 1.0 / zero switches at sigma=0).

A. RANDOM-GT control (scorer self-confirmation): re-score a real bench run
   against a sidecar whose slot->animal labels are re-drawn at random.
   PASS = IDF1/accuracy collapse to ~1/A. A scorer that reads the tracker's
   own output as truth (or vice versa) would stay near 1.0.

B. SPLICE control (does the pipeline detect a genuine identity change?):
   swap the GT animal labels for all frames >= F/2 and re-score the same run.
   PASS = IDF1 ~0.5 and the switch counter reports the splice (2 counted
   switches for a dyad: both animals' majority flips once). A scorer that
   ignores temporal identity would report 0 switches or unchanged IDF1.

C. WRONG-CALIBRATION control (is geometry load-bearing?): same detections,
   but each camera is given the NEXT camera's extrinsics+intrinsics (names
   kept). PASS = association collapses (IDF1 far below 1, coverage down).
   If the tracker exploited any non-geometric channel (slot order, NaN
   fingerprints, ...), it would survive this.

Usage: fig10_controls.py [--session DIR] [--frames 20000]
Writes results JSON to results/agg/controls.json and prints a verdict table.
"""
import argparse, json, os, re, shutil, subprocess, sys
import numpy as np

HERE = os.path.dirname(os.path.abspath(__file__))
PY = sys.executable


def run(cmd, **kw):
    r = subprocess.run(cmd, capture_output=True, text=True, **kw)
    if r.returncode:
        raise RuntimeError(f'{cmd}: {r.stderr[-500:]}')
    return r.stdout


def score(bench, gt_dir):
    out = json.loads(run([PY, os.path.join(HERE, 'fig10_score.py'),
                          '--bench', bench, '--gt-dir', gt_dir]))
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--session',
                    default='/root/vast/eric/s-DANNCE-data/s-DANNCE-SCN2A_SOC1/2022_09_22_M3_M4')
    ap.add_argument('--frames', type=int, default=20000)
    args = ap.parse_args()

    W = os.path.join(HERE, 'work', 'controls')
    shutil.rmtree(W, ignore_errors=True)
    os.makedirs(W)

    print(f'== baseline: sigma=0, {args.frames} frames, {args.session}')
    run([PY, os.path.join(HERE, 'fig10_prep.py'), '--session', args.session,
         '--out', W, '--seed', '99', '--max-frames', str(args.frames)])
    meta = json.load(open(os.path.join(W, 'meta.json')))
    A = meta['animals']
    run(['node', os.path.join(HERE, 'fig10_bench.mjs'), '--pred-h5-dir', W,
         '--num-animals', str(A), '--out', os.path.join(W, 'bench.json')], cwd=HERE)
    base = score(os.path.join(W, 'bench.json'), W)
    print(f"   baseline idf1={base['idf1']} switches={base['switches']}")

    gt = np.load(os.path.join(W, 'gt_perm.npy'))
    C, F, _ = gt.shape

    # --- A: random GT ---
    wa = os.path.join(W, 'ctrl_random_gt')
    os.makedirs(wa)
    rng = np.random.default_rng(1)
    gt_a = gt.copy()
    for ci in range(C):
        for f in range(F):
            row = gt_a[ci, f]
            present = row >= 0
            vals = row[present]
            rng.shuffle(vals)
            gt_a[ci, f, present] = vals
    np.save(os.path.join(wa, 'gt_perm.npy'), gt_a)
    shutil.copy(os.path.join(W, 'meta.json'), wa)
    a = score(os.path.join(W, 'bench.json'), wa)
    print(f"A  random-GT:  idf1={a['idf1']} acc={a['accuracy']}  (chance = {1/A:.3f})")

    # --- B: mid-session GT splice ---
    wb = os.path.join(W, 'ctrl_splice')
    os.makedirs(wb)
    gt_b = gt.copy()
    half = F // 2
    swap = (np.arange(A) + 1) % A          # cyclic relabel
    m = gt_b[:, half:, :]
    gt_b[:, half:, :] = np.where(m >= 0, swap[np.clip(m, 0, None)], m)
    np.save(os.path.join(wb, 'gt_perm.npy'), gt_b)
    shutil.copy(os.path.join(W, 'meta.json'), wb)
    b = score(os.path.join(W, 'bench.json'), wb)
    print(f"B  GT-splice:  idf1={b['idf1']} switches={b['switches']}  (expect ~0.5 idf1, {A} switches)")

    # --- C: rotated calibration ---
    wc = os.path.join(W, 'ctrl_badcal')
    os.makedirs(wc)
    for f in os.listdir(W):
        if f.endswith('.h5'):
            os.link(os.path.join(W, f), os.path.join(wc, f))
    toml = open(os.path.join(W, 'calibration.toml')).read()
    blocks = re.split(r'(?m)^\[(cam_\d+)\]\s*$', toml)
    # blocks: ['', name1, body1, name2, body2, ...]
    names = blocks[1::2]
    bodies = blocks[2::2]
    rotated = []
    for i, name in enumerate(names):
        donor = bodies[(i + 1) % len(bodies)]
        body = re.sub(r'(?m)^name = .*$', f'name = "{name}"', donor)
        rotated.append(f'[{name}]\n{body.strip()}\n')
    open(os.path.join(wc, 'calibration.toml'), 'w').write('\n'.join(rotated))
    run(['node', os.path.join(HERE, 'fig10_bench.mjs'), '--pred-h5-dir', wc,
         '--num-animals', str(A), '--out', os.path.join(wc, 'bench.json')], cwd=HERE)
    shutil.copy(os.path.join(W, 'gt_perm.npy'), wc)
    shutil.copy(os.path.join(W, 'meta.json'), wc)
    c = score(os.path.join(wc, 'bench.json'), wc)
    print(f"C  bad-calib:  idf1={c['idf1']} coverage={c['coverage']} switches={c['switches']}")

    out = dict(session=args.session, frames=args.frames, animals=A,
               baseline=base, random_gt=a, splice=b, bad_calibration=c)
    os.makedirs(os.path.join(HERE, 'results', 'agg'), exist_ok=True)
    json.dump(out, open(os.path.join(HERE, 'results', 'agg', 'controls.json'), 'w'),
              indent=1)
    print('wrote results/agg/controls.json')


if __name__ == '__main__':
    main()
