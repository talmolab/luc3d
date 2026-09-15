"""Checks on the benchmark itself: same inputs, same observations, no leakage.

Written after a real failure. SLAP-2M appears to offer dozens of calibration
sessions; every session folder on a date in fact holds a byte-identical copy of that
date's one recording, so a first pass scored the same video ten times and reported it
as n = 10. The tell was medians agreeing to three decimals, which reads as a
remarkably consistent rig rather than as a bug. These tests assert the things that
were being assumed.

    python3 verify.py <bench dir> <bench_slap dir> <bench_synth dir> <synth gt.toml>
"""
import sys, os, json, glob, hashlib, base64, re, subprocess

import numpy as np

PASS, FAIL = [], []


def check(name, ok, detail=''):
    (PASS if ok else FAIL).append(name)
    print(f'  [{"PASS" if ok else "FAIL"}] {name}' + (f'  {detail}' if detail else ''))


def md5(path, n=16 << 20):
    m = hashlib.md5()
    with open(path, 'rb') as f:
        m.update(f.read(n))
    return m.hexdigest()


bench, slap, synth, gt_toml = sys.argv[1:5]

# ---------------------------------------------------------------- inputs
print('\n== 1. input integrity')

# The four SLAP recordings must be genuinely different videos. This is the test that
# would have caught the n=10 mistake on the day it was made.
sigs = {}
for d in sorted(glob.glob(f'{slap}/*/')):
    spec = json.load(open(f'{d}/spec.json'))
    sigs[os.path.basename(d.rstrip('/'))] = md5(spec['cameras'][0][1])
check('the SLAP recordings are distinct videos',
      len(set(sigs.values())) == len(sigs),
      f'{len(set(sigs.values()))} distinct of {len(sigs)}')

# Both tools must have been pointed at the same bytes. anipose reads spec.json's paths;
# calibrat3 was handed session_dir. They have to be the same tree.
same = True
for d in sorted(glob.glob(f'{slap}/*/')) + [f'{bench}/cal_test2', f'{bench}/calib18']:
    sp = f'{d}/spec.json' if os.path.isdir(d) else None
    if not sp or not os.path.exists(sp):
        continue
    spec = json.load(open(sp))
    sess = spec.get('session_dir')
    if not sess:
        continue
    for cam, vid in spec['cameras']:
        hits = glob.glob(f'{sess}/**/{os.path.basename(vid)}', recursive=True)
        if not hits or md5(hits[0]) != md5(vid):
            same = False
check('anipose and calibrat3 read the same video bytes', same)

# ------------------------------------------------------------- observations
print('\n== 2. every arm scored on identical observations')
for d in [f'{bench}/cal_test2', f'{bench}/calib18'] + sorted(glob.glob(f'{slap}/*/')):
    p = os.path.join(d, 'scores.json')
    if not os.path.exists(p):
        continue
    s = json.load(open(p))
    name = os.path.basename(d.rstrip('/'))
    for det, arms in s.items():
        ns = {k: v['overall']['n'] for k, v in arms.items() if k != '_meta'}
        check(f'{name}/{det}: equal n across arms', len(set(ns.values())) == 1,
              f'n={sorted(set(ns.values()))}')

# --------------------------------------------------------------- leakage
print('\n== 3. leakage')

b64 = lambda x, dt: np.frombuffer(base64.b64decode(x), dtype=dt)
for name in ('cal_test2', 'calib18'):
    d = f'{bench}/{name}'
    ho = os.path.join(d, 'heldout.json')
    if not os.path.exists(ho):
        continue
    h = json.load(open(ho))
    # the held-out split must actually be a split
    check(f'{name}: held-out frames exist', h['frames_heldout'] > 0, f'{h["frames_heldout"]}')
    check(f'{name}: held-out + used = all anipose frames',
          h['frames_heldout'] + min(h['frames_used_by_calibrat3'], h['frames_total'])
          >= h['frames_total'] * 0.99, f"{h['frames_heldout']}+used vs {h['frames_total']}")

    # and the two tools' detections must be genuinely different sets, or "scored on
    # Anipose's corners" means nothing
    sess = json.load(open(f'{d}/calibrat3_800.session.json'))
    c3 = {int(f['frame']) for f in sess['detections']['frames']
          if any(v and b64(v['ids'], np.int32).size for v in f['views'])}
    import pickle
    ani = pickle.load(open(f'{d}/anipose_rows.pkl', 'rb'))
    an = {int(r['framenum'][1]) for rows in ani['rows'] for r in rows}
    check(f'{name}: the two detection sets differ', c3 != an,
          f'calibrat3 {len(c3)} frames, anipose {len(an)}')
    check(f'{name}: anipose covers frames calibrat3 never used',
          len(an - c3) > 0, f'{len(an - c3)} frames')

# ------------------------------------------------------------ independence
print('\n== 4. the scorer is independent of calibrat3')
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), 'score.py')).read()
check('score.py imports no calibrat3 code',
      'calibrat3' not in re.sub(r'#.*|""".*?"""', '', src, flags=re.S).split('import')[0] and
      not re.search(r'^\s*(from|import)\s+\w*calib', src, re.M))
check('score.py triangulates with aniposelib', 'from aniposelib' in src)

# ------------------------------------------------------- what was scored
print('\n== 5. the calibrations scored are the intended ones')


def toml_cams(path):
    out, cur = {}, None
    for line in open(path):
        line = line.strip()
        if line.startswith('[') and line.endswith(']'):
            cur = {}
        elif cur is not None and '=' in line:
            k, v = line.split('=', 1)
            nums = [float(x) for x in re.findall(r'-?\d+\.?\d*(?:[eE][-+]?\d+)?', v)]
            if k.strip() == 'name':
                out[v.strip().strip('"')] = cur
            elif nums:
                cur[k.strip()] = nums
    return out


for name, size in (('cal_test2', (1280, 1024)), ('calib18', (1680, 1200))):
    p = f'{bench}/{name}/calibrat3_800.toml'
    if not os.path.exists(p):
        continue
    cams = toml_cams(p)
    cx = [c['matrix'][2] for c in cams.values()]
    offs = [abs(x - (size[0] - 1) / 2) for x in cx]
    # calibrat3's default frees the principal point; if every cx sat exactly at the
    # image centre the file would be an aniposelib-style calibration, not calibrat3's
    check(f'{name}: calibrat3 TOML has a free principal point',
          max(offs) > 1.0, f'max |cx - centre| = {max(offs):.1f} px')
    a = f'{bench}/{name}/calibration_anipose.toml'
    if os.path.exists(a):
        ac = toml_cams(a)
        aoff = [abs(c['matrix'][2] - (size[0] - 1) / 2) for c in ac.values()]
        check(f'{name}: Anipose TOML pins the principal point', max(aoff) < 1e-6)

# ---------------------------------------------------------------- ablation
print('\n== 6. ablation arms differ as intended')
abl = f'{bench}/calib18/ablation'
if os.path.isdir(abl):
    h = {os.path.basename(f)[:-5]: md5(f) for f in sorted(glob.glob(f'{abl}/*.toml'))}
    check('ablation arms are distinct calibrations', len(set(h.values())) == len(h),
          f'{len(set(h.values()))} distinct of {len(h)}')
    am = f'{abl}/anipose-model.toml'
    if os.path.exists(am):
        cams = toml_cams(am)
        off = max(abs(c['matrix'][2] - (1680 - 1) / 2) for c in cams.values())
        k2 = max(abs(c['distortions'][1]) for c in cams.values())
        check('anipose-model arm pins the principal point', off < 1e-6, f'{off:.2e}')
        check('anipose-model arm sets k2 = 0', k2 < 1e-9, f'{k2:.2e}')
    aj = f'{bench}/calib18/ablation.json'
    if os.path.exists(aj):
        for r in json.load(open(aj))['results']:
            if r['tag'] == 'no-rejection':
                frac = r['pointsExcluded'] / max(r['pointsTotal'], 1)
                check('no-rejection arm fitted essentially every point', frac < 0.05,
                      f'{r["pointsExcluded"]}/{r["pointsTotal"]} dropped')

# ------------------------------------------------------- ground truth maths
print('\n== 7. ground-truth comparison')
here = os.path.dirname(os.path.abspath(__file__))
out = subprocess.run([sys.executable, f'{here}/gt_compare.py', gt_toml, '--',
                      f'gt={gt_toml}'], capture_output=True, text=True).stdout
row = [l for l in out.splitlines() if l.startswith('gt ')]
check('ground truth scored against itself is zero',
      bool(row) and all(abs(float(x.rstrip('p%m'))) < 1e-6
                        for x in row[0].split()[1:6]), row[0].strip() if row else 'no row')

# the similarity fit must recover a known transform, or every 3D number is suspect
sys.path.insert(0, here)
from gt_compare import umeyama  # noqa: E402
rng = np.random.default_rng(0)
X = rng.normal(0, 500, (8, 3))
th = 0.7
R_true = np.array([[np.cos(th), -np.sin(th), 0], [np.sin(th), np.cos(th), 0], [0, 0, 1]])
s_true, t_true = 1.37, np.array([10.0, -20.0, 30.0])
Y = s_true * (R_true @ X.T).T + t_true
s, R, t = umeyama(X, Y)
check('similarity fit recovers a known scale', abs(s - s_true) < 1e-9, f's={s:.9f}')
check('similarity fit recovers a known rotation', np.allclose(R, R_true, atol=1e-9))
check('similarity fit recovers a known translation', np.allclose(t, t_true, atol=1e-6))

# --------------------------------------------------------------- deposit
print('\n== 8. deposit matches the raw errors')
dep = '/root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs/out/fig7_calibration.json'
if os.path.exists(dep):
    rec = json.load(open(dep))
    z = np.load(f'{bench}/calib18/scores_anipose.npz')
    pooled = np.concatenate([z[k] for k in z.files if k.startswith('calibrat3_800|')])
    dm = rec['datasets']['calib18']['detsets']['anipose']['arms']['calibrat3_800']['overall']['med']
    check('deposited median matches the raw arrays',
          abs(np.median(pooled) - dm) < 1e-3, f'{np.median(pooled):.4f} vs {dm:.4f}')
    csv = '/root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs/data/fig7/fig7bd_per_camera.csv'
    if os.path.exists(csv):
        import csv as _csv
        rows = list(_csv.DictReader(open(csv)))
        r = [x for x in rows if x['dataset'] == 'calib18' and x['arm'] == 'calibrat3'
             and x['camera'] == 'Camera0']
        if r:
            cam = np.concatenate([z[k] for k in z.files if k == 'calibrat3_800|Camera0'])
            check('deposited CSV matches the raw arrays',
                  abs(np.median(cam) - float(r[0]['median'])) < 1e-3,
                  f'{np.median(cam):.4f} vs {r[0]["median"]}')

print(f'\n{len(PASS)} passed, {len(FAIL)} failed')
if FAIL:
    print('FAILED:')
    for f in FAIL:
        print('  -', f)
sys.exit(1 if FAIL else 0)
