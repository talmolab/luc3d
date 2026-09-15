"""Add the 8-camera rig's FOUR recordings and the synthetic ground truth to the deposit.

Two additions to `out/fig7_calibration.json`:

**`datasets.slap8`** replaces the single-recording 8-camera entry. SLAP-2M looks like it
offers dozens of sessions, but every session folder on a date holds a byte-identical copy
of that date's one calibration recording (verified by md5) -- so the tree contains FOUR
distinct recordings, not forty. One of the four (2022-10-07) is the recording calibrat3's
defaults were swept on; it is flagged `tuning` so it cannot be counted as generalisation.
Per-recording arms are kept AND a pooled arm is computed, because the panels want both:
the pooled curve is the distribution, the per-recording curves are the replication.

**`synthetic`** is the ground-truth comparison, which is the only part of this figure that
can ask "did it recover the camera" rather than "did it fit the corners".

    python3 deposit_extra.py <out.json> <bench_slap dir> <bench_synth dir> <gt.toml>
"""
import sys, os, json, glob, subprocess

import numpy as np

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from deposit import EDGES, box_stats          # identical binning/stats as the main pass

out_path, slap_dir, synth_dir, gt_toml = sys.argv[1:5]
rec = json.load(open(out_path))


def arm_record(errs_by_cam):
    """Same shape the main deposit produces, so panels need no special case."""
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


# ---- the four 8-camera recordings ------------------------------------------------
recordings, pooled = {}, {}
cams = None
for d in sorted(glob.glob(f'{slap_dir}/*/')):
    sid = os.path.basename(d.rstrip('/'))
    npz = os.path.join(d, 'scores_anipose.npz')
    if not os.path.exists(npz):
        continue
    spec = json.load(open(os.path.join(d, 'spec.json')))
    z = np.load(npz)
    arms = {}
    for key in z.files:
        lab, cam = key.split('|', 1)
        arms.setdefault(lab, {})[cam] = z[key]
    # NAME THE ARM AS THE MAIN PASS DOES. score_all.sh labels it `calibrat3`; the two-rig
    # deposit calls the same thing `calibrat3_800` (its 800-frame default), and the panels
    # look it up by that name. Renaming here keeps one vocabulary across both passes.
    if 'calibrat3' in arms:
        arms['calibrat3_800'] = arms.pop('calibrat3')
    cams = list(arms['calibrat3_800'])
    recordings[sid] = dict(date=spec.get('date'), note=spec.get('note', ''),
                           tuning='TUNING' in spec.get('note', ''),
                           arms={k: arm_record(v) for k, v in arms.items()})
    for k, v in arms.items():
        for cam, e in v.items():
            pooled.setdefault(k, {}).setdefault(cam, []).append(e)

if recordings:
    rec['datasets']['slap8'] = dict(
        cameras=cams, size=[1280, 1024], n_cameras=len(cams),
        recordings=recordings,
        detsets={'anipose': dict(
            arms={k: arm_record({c: np.concatenate(v) for c, v in d.items()})
                  for k, d in pooled.items()},
            meta=dict(recordings=len(recordings),
                      held_out=sum(not r['tuning'] for r in recordings.values())))},
    )
    print(f'slap8: {len(recordings)} distinct recordings '
          f'({sum(not r["tuning"] for r in recordings.values())} held out), {len(cams)} cameras')

# ---- synthetic ground truth -------------------------------------------------------
here = os.path.dirname(os.path.abspath(__file__))
args = [sys.executable, f'{here}/gt_compare.py', gt_toml, '--',
        f'calibrat3={synth_dir}/calibrat3_800.toml',
        f'anipose={synth_dir}/calibration_anipose.toml']
abl = f'{synth_dir}/ablation/anipose-model.toml'
if os.path.exists(abl):
    args.append(f'c3-anipose-model={abl}')
txt = subprocess.run(args, capture_output=True, text=True).stdout
rows = {}
for line in txt.splitlines():
    p = line.split()
    if len(p) == 9 and p[1].endswith('p'):
        rows[p[0]] = dict(d_pp=float(p[1][:-1]), d_fx=float(p[2][:-1]), d_fy=float(p[3][:-1]),
                          d_k1=float(p[4]), d_k2=float(p[5]),
                          centre_mm=float(p[6][:-2]), scale_pct=float(p[7][:-1]),
                          centre_pct=float(p[8][:-1]))
gt_pp = [float(x) for x in
         [l.split()[1] for l in txt.splitlines() if l.strip().startswith('median') and 'px' in l]] or [0]
if rows:
    rec['synthetic'] = dict(arms=rows, raw=txt)
    print(f'synthetic: {len(rows)} arms -> {list(rows)}')

json.dump(rec, open(out_path, 'w'))
print(f'wrote {out_path} ({os.path.getsize(out_path)/1e3:.0f} kB)')
