#!/usr/bin/env python3
"""Fig 10 aggregation: results/**.json -> summary table + per-panel CSVs.

Reads every per-cell JSON under results/ (the canonical store; all.jsonl is a
convenience log that may contain duplicates from re-runs — per-cell files win).

Outputs into results/agg/:
  summary.csv       one row per (dataset, session, cell)
  by_cell.csv       mean/min/median IDF1 + switches per (dataset, cell)
  panel_10c.csv     IDF1 vs sigma per dataset (C1)
  panel_10d.csv     IDF1 vs dropout (C2/C2b/C3)
  panel_10e.csv     keypoints vs COM at matched noise (C1_sigma0/3 vs C4)
  missing.txt       expected-but-absent cells
"""
import csv, glob, json, os, re
from collections import defaultdict

HERE = os.path.dirname(os.path.abspath(__file__))
RES = os.path.join(HERE, 'results')
AGG = os.path.join(RES, 'agg')
os.makedirs(AGG, exist_ok=True)

EXPECTED_CELLS = (
    [f'C1_sigma{s}' for s in (0, 1, 2, 3, 5, 10, 20)]
    + [f'C2_drop{p}' for p in (0.1, 0.25, 0.5)]
    + [f'C2b_nodedrop{r}' for r in (0.25, 0.5)]
    + [f'C3_occl{q}' for q in (0.25, 0.5)]
    + ['C4_com_sigma0', 'C4_com_sigma3']
    + ['C4u_comused_sigma0', 'C4u_comused_sigma3'])

rows = []
for p in sorted(glob.glob(os.path.join(RES, '*', '*', '*.json'))):
    ds, sess, cell = p.split(os.sep)[-3], p.split(os.sep)[-2], os.path.basename(p)[:-5]
    if ds == 'agg':          # our own output tree (agg/swapdiag/*.json), not cells
        continue
    d = json.load(open(p))
    d.update(dataset=ds, session_name=sess, cell=cell)
    rows.append(d)

cols = ['dataset', 'session_name', 'cell', 'idf1', 'accuracy',
        'grouping_accuracy', 'frames_perfectly_grouped', 'switches',
        'sw_per_100k', 'coverage', 'n_gt_dets', 'identities', 'animals',
        'frames', 'runtimeSeconds', 'fps']
with open(os.path.join(AGG, 'summary.csv'), 'w', newline='') as f:
    w = csv.DictWriter(f, cols, extrasaction='ignore')
    w.writeheader()
    for r in sorted(rows, key=lambda r: (r['dataset'], r['session_name'], r['cell'])):
        w.writerow(r)

by = defaultdict(list)
for r in rows:
    by[(r['dataset'], r['cell'])].append(r)

def stats(v, k='idf1'):
    xs = sorted(r[k] for r in v)
    n = len(xs)
    return dict(n=n, mean=sum(xs) / n, min=xs[0],
                median=xs[n // 2] if n % 2 else (xs[n//2 - 1] + xs[n//2]) / 2)

with open(os.path.join(AGG, 'by_cell.csv'), 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['dataset', 'cell', 'n', 'idf1_mean', 'idf1_median', 'idf1_min',
                'acc_mean', 'sw100k_mean', 'sw100k_max'])
    for (ds, cell), v in sorted(by.items(), key=lambda x: (x[0][1], x[0][0])):
        s = stats(v)
        w.writerow([ds, cell, s['n'], f"{s['mean']:.4f}", f"{s['median']:.4f}",
                    f"{s['min']:.4f}",
                    f"{sum(r['accuracy'] for r in v)/s['n']:.4f}",
                    f"{sum(r['sw_per_100k'] for r in v)/s['n']:.3f}",
                    f"{max(r['sw_per_100k'] for r in v):.3f}"])

# panel CSVs
with open(os.path.join(AGG, 'panel_10c.csv'), 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['dataset', 'sigma_px', 'idf1_mean', 'idf1_median', 'idf1_min', 'n'])
    for (ds, cell), v in sorted(by.items()):
        m = re.match(r'C1_sigma(\d+)$', cell)
        if m:
            s = stats(v)
            w.writerow([ds, m.group(1), f"{s['mean']:.4f}", f"{s['median']:.4f}",
                        f"{s['min']:.4f}", s['n']])

with open(os.path.join(AGG, 'panel_10d.csv'), 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['dataset', 'kind', 'rate', 'idf1_mean', 'idf1_median', 'idf1_min',
                'sw100k_mean', 'n'])
    for (ds, cell), v in sorted(by.items()):
        m = (re.match(r'C2_drop([\d.]+)$', cell) and ('instance', re.match(r'C2_drop([\d.]+)$', cell).group(1))) \
            or (re.match(r'C2b_nodedrop([\d.]+)$', cell) and ('node', re.match(r'C2b_nodedrop([\d.]+)$', cell).group(1))) \
            or (re.match(r'C3_occl([\d.]+)$', cell) and ('occlusion', re.match(r'C3_occl([\d.]+)$', cell).group(1)))
        if m:
            s = stats(v)
            w.writerow([ds, m[0], m[1], f"{s['mean']:.4f}", f"{s['median']:.4f}",
                        f"{s['min']:.4f}",
                        f"{sum(r['sw_per_100k'] for r in v)/s['n']:.3f}", s['n']])

with open(os.path.join(AGG, 'panel_10e.csv'), 'w', newline='') as f:
    w = csv.writer(f)
    w.writerow(['dataset', 'input', 'sigma', 'idf1_mean', 'idf1_min', 'n'])
    for (ds, cell), v in sorted(by.items()):
        pick = {'C1_sigma0': ('keypoints', 0), 'C1_sigma3': ('keypoints', 3),
                'C4_com_sigma0': ('com', 0), 'C4_com_sigma3': ('com', 3),
                # C4u: like-for-like COM (SDANNCE com3d_used.mat — same GT
                # provenance as keypoints). Additive; 'com' rows retained.
                'C4u_comused_sigma0': ('com_used', 0),
                'C4u_comused_sigma3': ('com_used', 3)}.get(cell)
        if pick:
            s = stats(v)
            w.writerow([ds, pick[0], pick[1], f"{s['mean']:.4f}", f"{s['min']:.4f}", s['n']])

# missing cells
missing = []
datasets = sorted({r['dataset'] for r in rows})
sessions = defaultdict(set)
for r in rows:
    sessions[r['dataset']].add(r['session_name'])
for ds in datasets:
    for sess in sorted(sessions[ds]):
        have = {r['cell'] for r in rows if r['dataset'] == ds and r['session_name'] == sess}
        for c in EXPECTED_CELLS:
            if c not in have:
                missing.append(f'{ds}/{sess}/{c}')
open(os.path.join(AGG, 'missing.txt'), 'w').write('\n'.join(missing) + '\n')
print(f'{len(rows)} cell results; {len(missing)} expected cells missing')
if missing:
    for m in missing[:20]:
        print(' missing:', m)
