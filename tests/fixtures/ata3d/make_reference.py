"""Reference values for tests/test-adaptive-temporal-averaging.mjs, from ata3d.smooth (olinesn/ata3d @ 9ab769a).

Run:  PYTHONPATH=<ata3d>/src uv run --with numpy python tests/fixtures/ata3d/make_reference.py tests/fixtures/ata3d/reference.json
"""
import json, sys
import numpy as np
from ata3d import smooth

rng = np.random.default_rng(20261121)
S, F = 3, 120
t = np.arange(F)
X = np.zeros((F, S, 3))
# series 0: still point; 1: steady 2 mm/frame along x; 2: oscillation + a 12 mm jump at 70
X[:, 0] = [10.0, -4.0, 50.0]
X[:, 1, 0] = 2.0 * t
X[:, 2, 0] = 8 * np.sin(2 * np.pi * t / 40)
X[:, 2, 1] = 3 * np.cos(2 * np.pi * t / 25)
X[70:, 2, 2] += 12.0
# anisotropic random SPD covariances, per sample
A = rng.normal(size=(F, S, 3, 3)) * 0.6
cov = A @ np.swapaxes(A, -1, -2) + np.eye(3) * rng.uniform(0.2, 1.5, size=(F, S, 1, 1))
L = np.linalg.cholesky(cov)
X = X + np.einsum('fsij,fsj->fsi', L, rng.normal(size=(F, S, 3)))
# missing samples: a gap in series 0, single holes in 1 and 2
X[40:44, 0] = np.nan
X[15, 1] = np.nan
X[100, 2] = np.nan
X = np.round(X, 6)
cov = np.round(cov, 6)
cases = []
for k, hmax in [(3.0, 15), (2.0, 5), (4.0, 15)]:
    r = smooth(X, cov, k=k, hmax=hmax)
    cases.append({'k': k, 'hmax': hmax,
                  'x': [[None if not np.isfinite(v) else float(v) for v in r.x[:, s].ravel()] for s in range(S)],
                  'window': [r.window[:, s].astype(int).tolist() for s in range(S)]})
iu = [(0, 0), (0, 1), (0, 2), (1, 1), (1, 2), (2, 2)]
out = {
    'source': 'ata3d.smooth (olinesn/ata3d 9ab769a), tests/fixtures/ata3d/make_reference.py',
    'frames': F,
    'series': [{'x': [None if not np.isfinite(v) else float(v) for v in X[:, s].ravel()],
                'cov': [float(cov[f, s, i, j]) for f in range(F) for (i, j) in iu]} for s in range(S)],
    'cases': cases,
}
json.dump(out, open(sys.argv[1], 'w'), separators=(',', ':'))
print('ok', {c['k']: [float(np.mean(np.array(w)[np.array(w) > 0])) for w in c['window']] for c in cases})
