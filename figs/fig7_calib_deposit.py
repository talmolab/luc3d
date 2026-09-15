"""Turn the raw benchmark outputs into figs/out/fig7_calibration.json.

The luc3d figure convention: the expensive measurement pass deposits a compact
record, the panel scripts read it back and never touch the corpora. The raw
per-observation errors here run to tens of millions of floats, so what is deposited
is everything a panel can need and nothing it cannot -- per-camera box statistics
(so `ax.bxp` draws the real quartiles, not a re-estimate), a shared log-spaced
histogram per arm, and the headline quantiles.

    python3 deposit.py <out.json> <dataset_dir> [<dataset_dir> ...]
"""
import sys, os, json, glob

import numpy as np

#: The histogram every distribution panel shares, so two arms drawn on one axes are
#: binned identically. Log-spaced because the errors span 0.01 px to tens of px.
EDGES = np.logspace(np.log10(0.01), np.log10(100.0), 181)


#: Whisker percentiles. NOT Tukey's 1.5 IQR, and the reason is the sample size: each
#: camera here carries 10^4-10^6 observations, where the 1.5 IQR fence is not an
#: outlier rule but a guarantee -- it flags tens of thousands of points, and on
#: strictly positive error data the LOWER fence sits below zero, so the lower whisker
#: degenerates into "the smallest error anywhere in the session" (~10^-5 px) and the
#: drawn panel becomes a picture of the log axis rather than of the distribution.
#: p5-p95 says something a reader can act on -- where the middle 90 % of the
#: observations in that camera fall -- and its upper end is the same p95 quoted
#: everywhere else in the figure.
WHIS = (5, 95)


def box_stats(e):
    """matplotlib `bxp`-ready statistics, computed on the FULL array rather than on a
    subsample, so the drawn box is the distribution and not an estimate of it."""
    lo, q1, med, q3, hi = np.percentile(e, [WHIS[0], 25, 50, 75, WHIS[1]])
    return dict(med=float(med), q1=float(q1), q3=float(q3),
                whislo=float(lo), whishi=float(hi),
                mean=float(e.mean()), n=int(e.size),
                p95=float(np.percentile(e, 95)), p99=float(np.percentile(e, 99)))


out_path, dirs = sys.argv[1], sys.argv[2:]
record = dict(hist_edges=EDGES.tolist(), datasets={})

for d in dirs:
    name = os.path.basename(d.rstrip('/'))
    spec = json.load(open(os.path.join(d, 'spec.json')))
    scores = json.load(open(os.path.join(d, 'scores.json')))
    ds = dict(cameras=[c[0] for c in spec['cameras']], size=spec['size'],
              n_cameras=len(spec['cameras']), detsets={}, timing={})

    for npz_path in sorted(glob.glob(os.path.join(d, 'scores_*.npz'))):
        detset = os.path.basename(npz_path)[len('scores_'):-len('.npz')]
        z = np.load(npz_path)
        arms = {}
        for key in z.files:
            label, cam = key.split('|', 1)
            a = arms.setdefault(label, dict(cameras={}, hist=np.zeros(len(EDGES) - 1),
                                            pooled=[]))
            e = z[key]
            a['cameras'][cam] = box_stats(e)
            a['hist'] += np.histogram(e, EDGES)[0]
            a['pooled'].append(e)
        for label, a in arms.items():
            pooled = np.concatenate(a['pooled'])
            a['overall'] = box_stats(pooled)
            a['overall']['p50'] = a['overall']['med']
            # the quantile curve the ECDF panel draws, at 1 % resolution plus a fine
            # tail -- 200 numbers instead of 10^7, and exact at every stop it names
            qs = np.concatenate([np.arange(0, 99, 1.0), np.linspace(99, 100, 21)])
            a['quantiles'] = dict(q=qs.tolist(),
                                  v=np.percentile(pooled, qs).tolist())
            a['hist'] = a['hist'].astype(int).tolist()
            del a['pooled']
        ds['detsets'][detset] = dict(arms=arms, meta=scores.get(detset, {}).get('_meta', {}))

    # wall clock, as each tool actually reported it
    for t in sorted(glob.glob(os.path.join(d, '*.timing.json'))):
        tag = os.path.basename(t)[:-len('.timing.json')]
        ds['timing'][tag] = json.load(open(t))
    for s, tag in ((os.path.join(d, 'anipose_summary.json'), 'anipose'),
                   (os.path.join(d, 'anipose_on_ours.summary.json'), 'anipose_on_ours')):
        if os.path.exists(s):
            ds['timing'][tag] = json.load(open(s))
    # --- the "why" pass, if it has been run -------------------------------------
    # Two separate questions, deposited together because one panel draws both: what the
    # gap is made of (the ablation, every arm scored by the same third party on Anipose's
    # detections) and whether it survives out of sample (the same arms scored only on
    # frames calibrat3 never used).
    abl_p = os.path.join(d, 'ablation_scores.json')
    held_p = os.path.join(d, 'heldout.json')
    if os.path.exists(abl_p):
        a = json.load(open(abl_p)).get('anipose', {})
        ds['ablation'] = {'all': {k: v['overall']['median'] for k, v in a.items()
                                  if k != '_meta'}}
        if os.path.exists(held_p):
            h = json.load(open(held_p))
            ds['ablation']['heldout'] = {k: v['heldout']['median']
                                         for k, v in h['scores'].items()}
            ds['ablation']['heldout_meta'] = {k: v for k, v in h.items() if k != 'scores'}
        else:
            ds['ablation']['heldout'] = {}
        print(f'  ablation: {len(ds["ablation"]["all"])} arms, '
              f'{len(ds["ablation"]["heldout"])} with held-out scores')
    rep_p = os.path.join(d, 'anipose_repeats.json')
    if os.path.exists(rep_p):
        ds['anipose_repeats'] = json.load(open(rep_p))

    record['datasets'][name] = ds
    print(f'{name}: {len(ds["detsets"])} detection sets, arms '
          f'{sorted({a for v in ds["detsets"].values() for a in v["arms"]})}, '
          f'timings {sorted(ds["timing"])}')

json.dump(record, open(out_path, 'w'))
print('wrote', out_path, f'({os.path.getsize(out_path) / 1e3:.0f} kB)')
