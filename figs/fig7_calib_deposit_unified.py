"""Rebuild out/fig7_calibration.json with all three rigs on ONE OpenCV.

The published deposit mixed OpenCV versions: calibrat3 detects with OpenCV.js 4.13.0,
aniposelib ran against OpenCV 5.0.0, and OpenCV 5 moved the ChArUco corner origin by
half a pixel in both axes. That charged calibrat3 a penalty it did not owe (18-camera
rig: 0.472 px against 0.212 px once both detectors run 4.13). Every arm here is scored
on corners detected by OpenCV 4.13.

    python3 fig7_calib_deposit_unified.py <out.json> <cv4 work dir> <gt.toml> <synth dir>

Rig entries written: `slap8` (4 recordings, 8 cameras), `calib18` (1 recording, 18
cameras, plus the solver ablation) and `md10` (5 recordings, 5 cameras, all held out).
"""
import sys, os, json, glob, subprocess
import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
BENCH = '/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-calibrat3/f2e871e8-b95b-4d4d-8c45-26dcb3703487/scratchpad/bench'
sys.path.insert(0, BENCH)
from deposit import EDGES, box_stats

out_path, work, gt_toml, synth_dir = sys.argv[1:5]

#: md10_20251002_150512: aniposelib's solver diverged on the run that produced
#: calibration_anipose.toml (reported error 1.4e21) and on 2 of 5 repeats. The three
#: converged repeats agree to 0.001 px; rep0 stands in, and the divergence rate is
#: reported separately (data/fig7/fig7s5_anipose_divergence.csv).
ANIPOSE_SUBST = {'md10_20251002_150512': 'anipose_converged_rep0'}


def arm_record(errs_by_cam):
    a = dict(cameras={}, hist=np.zeros(len(EDGES) - 1))
    pooled = []
    for cam, e in errs_by_cam.items():
        a['cameras'][cam] = box_stats(e)
        a['hist'] += np.histogram(e, EDGES)[0]
        pooled.append(e)
    p = np.concatenate(pooled)
    a['overall'] = box_stats(p)
    a['overall']['p50'] = a['overall']['med']
    qs = np.concatenate([np.arange(0, 99, 1.0), np.linspace(99, 100, 21)])
    a['quantiles'] = dict(q=qs.tolist(), v=np.percentile(p, qs).tolist())
    a['hist'] = a['hist'].astype(int).tolist()
    return a


def load_arms(d):
    z = np.load(os.path.join(d, 'scores_anipose.npz'))
    arms = {}
    for key in z.files:
        lab, cam = key.split('|', 1)
        arms.setdefault(lab, {})[cam] = z[key]
    if 'calibrat3' in arms:
        arms['calibrat3_800'] = arms.pop('calibrat3')
    sub = ANIPOSE_SUBST.get(os.path.basename(d))
    if sub and sub in arms:
        arms['anipose'] = arms.pop(sub)
    return arms


def rig(prefix, size, tuning_ids=()):
    recordings, pooled, cams = {}, {}, None
    for d in sorted(glob.glob(os.path.join(work, f'{prefix}*'))):
        if not os.path.exists(os.path.join(d, 'scores_anipose.npz')):
            continue
        sid = os.path.basename(d)[len(prefix):] or os.path.basename(d)
        spec = json.load(open(os.path.join(d, 'spec.json')))
        arms = {k: v for k, v in load_arms(d).items() if k in ('calibrat3_800', 'anipose')}
        cams = list(arms['calibrat3_800'])
        recordings[sid] = dict(date=spec.get('date'), note=spec.get('note', ''),
                               tuning=sid in tuning_ids,
                               arms={k: arm_record(v) for k, v in arms.items()})
        for k, v in arms.items():
            for cam, e in v.items():
                pooled.setdefault(k, {}).setdefault(cam, []).append(e)
    if not recordings:
        return None
    return dict(cameras=cams, size=size, n_cameras=len(cams), recordings=recordings,
                detsets={'anipose': dict(
                    arms={k: arm_record({c: np.concatenate(v) for c, v in d.items()})
                          for k, d in pooled.items()},
                    meta=dict(recordings=len(recordings),
                              held_out=sum(not r['tuning'] for r in recordings.values())))})


rec = dict(hist_edges=EDGES.tolist(), datasets={}, opencv='4.13.0 (both detectors)')

for key, prefix, size, tuning in (('slap8', 'slap_', [1280, 1024], {'10072022120554'}),
                                  ('md10', 'md10_', [1280, 1024], set())):
    e = rig(prefix, size, tuning)
    if e:
        rec['datasets'][key] = e
        print(f'{key}: {len(e["recordings"])} recordings '
              f'({e["detsets"]["anipose"]["meta"]["held_out"]} held out), {e["n_cameras"]} cameras')

# calib18: single recording, and it carries the solver ablation
d = os.path.join(work, 'calib18')
arms = load_arms(d)
spec = json.load(open(os.path.join(d, 'spec.json')))
main = {k: v for k, v in arms.items() if k in ('calibrat3_800', 'anipose', 'default')}
if 'default' in main and 'calibrat3_800' not in main:
    main['calibrat3_800'] = main.pop('default')
# held-out medians and per-rig wall clock, written by heldout.py and the timing pass
ho_path = os.path.join(d, 'heldout.json')
ho = json.load(open(ho_path)) if os.path.exists(ho_path) else {}
#: heldout.py writes {'scores': {arm: {'used': {...}, 'heldout': {...}}}, 'frames_*': n}
heldout = {k: v['heldout']['median'] for k, v in (ho.get('scores') or {}).items()
           if isinstance(v, dict) and 'heldout' in v}
ho_meta = {k: ho[k] for k in ('frames_used_by_calibrat3', 'frames_total', 'frames_heldout')
           if k in ho}
rec['datasets']['calib18'] = dict(
    cameras=list(main['calibrat3_800']), size=[1680, 1200], n_cameras=len(main['calibrat3_800']),
    detsets={'anipose': dict(arms={k: arm_record(v) for k, v in main.items()}, meta={})},
    #: panel g looks the arms up as `abl_<name>`, the vocabulary the original
    #: two-rig deposit used; `anipose` stays bare because it is not an ablation arm.
    ablation=dict(all={(k if k == 'anipose' else f'abl_{k}'):
                       float(np.median(np.concatenate(list(v.values()))))
                       for k, v in arms.items()},
                  heldout={(k if k == 'anipose' else f'abl_{k}'): v
                           for k, v in heldout.items()},
                  heldout_meta=ho_meta))


def timing_for(rig_key, cv4_name, c3_timing_src):
    """`timing` block panel h reads: calibrat3's own stage times, and Anipose's clean pass."""
    t = {}
    if os.path.exists(c3_timing_src):
        t['calibrat3_800'] = json.load(open(c3_timing_src))
    ap = os.path.join(work, '..', 'timing', cv4_name, 'anipose_summary.json')
    ap = os.path.normpath(ap)
    if os.path.exists(ap):
        t['anipose'] = json.load(open(ap))
    return t
print(f'calib18: {len(main["calibrat3_800"])} cameras, ablation arms {sorted(arms)}')

# synthetic ground truth, re-run with aniposelib under 4.13
here = os.path.dirname(os.path.abspath(__file__))
txt = subprocess.run([sys.executable, f'{here}/fig7_calib_gt_compare.py', gt_toml, '--',
                      f'calibrat3={synth_dir}/calibrat3_800.toml',
                      f'anipose={work}/synth/calibration_anipose.toml'],
                     capture_output=True, text=True).stdout
rows = {}
for line in txt.splitlines():
    p = line.split()
    if len(p) == 9 and p[1].endswith('p'):
        rows[p[0]] = dict(d_pp=float(p[1][:-1]), d_fx=float(p[2][:-1]), d_fy=float(p[3][:-1]),
                          d_k1=float(p[4]), d_k2=float(p[5]), centre_mm=float(p[6][:-2]),
                          scale_pct=float(p[7][:-1]), centre_pct=float(p[8][:-1]))
if rows:
    rec['synthetic'] = dict(arms=rows, raw=txt)
    print(f'synthetic: {sorted(rows)}')

# attach the clean-pass timings
C3T = {'slap8': os.path.join(work, 'slap_10072022120554', 'calibrat3_800.timing.json'),
       'calib18': os.path.join(work, 'calib18', 'calibrat3_800.timing.json'),
       'md10': os.path.join(work, 'md10_20250514_134355', 'calibrat3_800.timing.json')}
for k in ('slap8', 'calib18', 'md10'):
    if k in rec['datasets']:
        t = timing_for(k, k, C3T[k])
        if t:
            rec['datasets'][k]['timing'] = t
            print(f'{k}: timing {sorted(t)}')

json.dump(rec, open(out_path, 'w'))
print(f'wrote {out_path} ({os.path.getsize(out_path)/1e3:.0f} kB)')
