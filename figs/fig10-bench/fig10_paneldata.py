#!/usr/bin/env python3
"""Fig 10 panel-data prep: residuals (10b) + per-session merge stats (10f).

Writes:
  results/agg/panel_10b_residuals.json
      per-camera residuals (px) of reprojected Label3D 3D COMs vs the RAW human
      clicks (`handLabeled2D`) pooled over all TRIADS sessions. (Only TRIADS
      carries handLabeled2D; BEDDING's label data_2d is Label3D's reprojection,
      residual 0 by construction — stated, not plotted.)
  results/agg/panel_10f_merge.json
      per session: min inter-animal COM pair distance (mm), frames <20 mm,
      joined with that session's C1_sigma0 IDF1 + switches.
"""
import glob, json, os, re, sys
import numpy as np
import scipy.io as sio

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fig10_validate import load_cal, project
from fig10_prep import load_pred_3d

DATASETS = {
    'triads':  '/root/vast/eric/s-DANNCE-data/s-DANNCE-TRIADS',
    'bedding': '/root/vast/eric/s-DANNCE-data/s-DANNCE-BEDDING',
    'soc1':    '/root/vast/eric/s-DANNCE-data/s-DANNCE-SCN2A_SOC1',
    'soc3':    '/root/vast/eric/s-DANNCE-data/s-DANNCE-SCN2A_SOC3',
}
AGG = os.path.join(HERE, 'results', 'agg')
os.makedirs(AGG, exist_ok=True)

# ---- 10b: residuals vs raw human clicks (TRIADS) ----
res_by_cam = {c: [] for c in range(1, 7)}
root = DATASETS['triads']
for sess in sorted(os.listdir(root)):
    S = os.path.join(root, sess)
    l3d = sorted(glob.glob(os.path.join(S, '*Label3D_dannce.mat')))
    if not l3d:
        continue
    d = sio.loadmat(l3d[0])
    if 'handLabeled2D' not in d:
        continue
    hl = d['handLabeled2D']                      # (inst, cams, 2, nLab)
    ld = d['labelData']
    for ci in range(6):
        cal = load_cal(os.path.join(S, 'calibration', f'hires_cam{ci+1}_params.mat'))
        e = ld[ci, 0]
        d3 = e['data_3d'][0, 0]                  # (nLab, 3*inst)
        nlab = d3.shape[0]
        ninst = d3.shape[1] // 3
        X = d3.reshape(nlab * ninst, 3)
        gt = hl[:, ci, :, :].transpose(2, 0, 1).reshape(nlab * ninst, 2)
        ok = np.isfinite(X).all(1) & np.isfinite(gt).all(1)
        if not ok.any():
            continue
        pr, _ = project(X[ok], cal, one_based=True)
        r = np.linalg.norm(pr - gt[ok], axis=1)
        res_by_cam[ci + 1].extend(np.round(r, 3).tolist())
json.dump({str(k): v for k, v in res_by_cam.items()},
          open(os.path.join(AGG, 'panel_10b_residuals.json'), 'w'))
print('10b:', {k: (len(v), round(float(np.median(v)), 2)) for k, v in res_by_cam.items()})

# ---- 10f: per-session merge stats joined with sigma0 scores ----
out = []
for ds, root in DATASETS.items():
    for sess in sorted(os.listdir(root)):
        S = os.path.join(root, sess)
        if not os.path.isdir(os.path.join(S, 'calibration')):
            continue
        score_p = os.path.join(HERE, 'results', ds, sess, 'C1_sigma0.json')
        if not os.path.exists(score_p):
            continue
        X = load_pred_3d(S)
        com = np.nanmean(X, axis=3)              # (F,A,3)
        A = com.shape[1]
        dmat = np.linalg.norm(com[:, :, None, :] - com[:, None, :, :], axis=3)
        dmat[:, np.arange(A), np.arange(A)] = np.inf
        mind = dmat.min(axis=(1, 2))
        sc = json.load(open(score_p))
        out.append(dict(
            dataset=ds, session=sess, animals=A, frames=int(com.shape[0]),
            min_pair_mm=round(float(np.nanmin(mind)), 2),
            frames_lt20mm=int((mind < 20).sum()),
            frames_lt50mm=int((mind < 50).sum()),
            idf1_sigma0=sc['idf1'], switches_sigma0=sc['switches']))
        print(f"{ds}/{sess}: min={out[-1]['min_pair_mm']}mm idf1={sc['idf1']}")
json.dump(out, open(os.path.join(AGG, 'panel_10f_merge.json'), 'w'), indent=1)
print(f'10f: {len(out)} sessions')
