#!/usr/bin/env python3
"""
Fig 6a -- the SLAP-2M rig and one reconstructed frame, in LUC3D's own viewport.

The app's own 3D render: eight camera frusta from the session's calibration, with
the frame's reconstructed animals inside them. Exported by `fig6_app.mjs`, so the
geometry is the calibration the reconstructions were actually computed in.

WHICH WAY IS UP. As in Fig 1c, `rigFit()` takes "up" from the data rather than
assuming Z-up -- these calibration frames can have +Z pointing down, which renders
the rig inverted with the animals floating above the cameras.

    python3 figs/panels/fig6_09_rig.py
"""
import sys
from pathlib import Path

import matplotlib.pyplot as plt

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT  # noqa: E402
from src.style import SPAN, mm, save, tile, use  # noqa: E402


def main():
    use()
    p = OUT / "fig6-rig.png"
    if not p.exists():
        sys.exit("missing figs/out/fig6-rig.png — run `node figs/fig6_app.mjs`")
    fig, ax = plt.subplots(figsize=(mm(SPAN["half"]), mm(40.0)),
                           layout="constrained")
    tile(ax, p, None, badge="8 cameras · 1 frame in 3D")
    save(fig, 6, "a", "rig")


if __name__ == "__main__":
    main()
