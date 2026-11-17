"""Build `sleap-compound-small.slp`: a small, genuine SLEAP-written .slp.

Python sleap-io writes `frames`/`instances`/`points`/`pred_points` as HDF5
COMPOUND datasets (LUCID's own writer uses 2-D matrices + `field_names`), which
is the layout `loading/slp-import-worker.js`'s `readCompoundColumnsFast` decodes.
`tests/e2e/slp-import-fast-compound.mjs` parses this file through both the fast
reader and h5wasm's `Dataset.value` and requires identical results.

Source: the first 60 labeled frames of one camera of the HardFight_1kModels
prediction set, plus user instances copied from predictions on a few frames so
the `points` table (user instances) is exercised too, with some NaN nodes and
some occluded nodes (coordinates present, visible=False).

    uv run --with sleap-io --with numpy python tests/fixtures/slp-compound/make_fixture.py SRC.slp
"""
import sys
from pathlib import Path

import numpy as np
import sleap_io as sio

src = sys.argv[1]
out = Path(__file__).with_name("sleap-compound-small.slp")

labels = sio.load_slp(src)
lfs = labels.labeled_frames[:60]
for k, lf in enumerate(lfs[:10]):
    if not lf.instances:
        continue
    pred = lf.instances[0]
    pts = pred.numpy().copy()
    if k % 3 == 0:
        pts[k % pts.shape[0]] = np.nan          # a missing node on a user instance
    user = sio.Instance.from_numpy(pts, skeleton=pred.skeleton, track=pred.track)
    if k % 2 == 1:
        # Occluded node: coordinates kept, visible=False (LUCID's `occluded`).
        user.points["visible"][(k + 1) % len(user.points)] = False
    lf.instances.append(user)

small = sio.Labels(labeled_frames=lfs, videos=labels.videos,
                   skeletons=labels.skeletons, tracks=labels.tracks)
sio.save_slp(small, str(out))
print(out, out.stat().st_size, "bytes,", len(small.labeled_frames), "frames,",
      sum(len(lf.instances) for lf in small.labeled_frames), "instances")
