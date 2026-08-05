#!/usr/bin/env python3
"""
Fig 6a -- the SLAP-2M rig and one reconstructed frame, in LUC3D's own viewport.

The app's own 3D render: eight camera frusta from the session's calibration, with
the frame's reconstructed animals inside them. Exported by `fig6_app.mjs`, so the
geometry is the calibration the reconstructions were actually computed in.

CROPPED AND MAGNIFIED, FROM THE MANIFEST -- not the raw viewport export. The first
pass of this panel drew `tile(ax, p, None)`, i.e. the whole 3200 x 2560 export in an
88 x 40 mm box: 43 % of the export's width is empty viewport, the rig therefore
landed at ~28 mm and the four reconstructed animals were a ~3 mm unreadable blob.
`out/fig6-app.json` deposits exactly what is needed to fix that, and the legacy
generator used all of it:

  threeD.rigBBox        the render's own content bounds (background-keyed), so the
                        crop is measured off the pixels rather than guessed
  threeD.animalsBBox    the same for the closer `fig6-3d-animals.png` render
  threeD.framing        `pane` (the viewport in CSS px) and `animalsScreen` (the
                        animals' projected centre IN pane px), which is how the
                        marker box lands on the animals in the WIDE render

So: the rig is cropped to `rigBBox`, a dashed box marks the animals inside it, and
the closer render is drawn beside it at ~55 mm as the magnified view, with leader
lines from the box. That is the legacy 6a framing (`legacy/fig6.py:189-217`),
restored -- side by side rather than overlaid, because the space the crop frees is
exactly where legacy had to put its inset.

NO SCALE BAR HERE, deliberately, and this is not an oversight -- see panel b, which
does carry one. These are perspective views of a scene spanning a large depth range
and the viewport's field of view is not recorded, so no single bar would be correct.
The metric referent for the figure is b's 50 mm bars and fig6s2's mean pose.

WHICH WAY IS UP. As in Fig 1c, `rigFit()` takes "up" from the data rather than
assuming Z-up -- these calibration frames can have +Z pointing down, which renders
the rig inverted with the animals floating above the cameras.

    python3 figs/panels/fig6_09_rig.py
"""
import json
import sys
from pathlib import Path

import matplotlib.image as mpimg
import matplotlib.pyplot as plt
from matplotlib.patches import ConnectionPatch, Rectangle

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.data_loader import OUT  # noqa: E402
from src.style import mm, save, use  # noqa: E402

W, H = 98.0, 44.0        # mm; a + b share the 180 mm row (b is 78 mm wide)
RIG_W, GAP, PAD = 40.0, 2.0, 0.5
MARK_MM = 5.0            # print size of the dashed marker box on the wide render


def crop_to(img, bbox, aspect, pad=0.02):
    """Crop `img` to `bbox` (source px), widened to exactly `aspect`.

    `src/style.py:load_tile` pads a bbox to a SQUARE, which is right for a row of
    identical tiles and wrong here: these two axes have different aspects, and a
    square crop would letterbox both of them back into the whitespace this panel
    exists to remove. Returns the array and the crop origin, because the marker box
    has to be placed in crop-relative pixels.
    """
    Him, Wim = img.shape[:2]
    x0, y0, x1, y1 = bbox
    m = max(x1 - x0, y1 - y0) * pad
    x0, y0, x1, y1 = x0 - m, y0 - m, x1 + m, y1 + m
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    w, h = x1 - x0, y1 - y0
    if w / h < aspect:
        w = h * aspect
    else:
        h = w / aspect
    # Shrink (keeping the aspect) rather than letting the slice run off the source.
    s = min(1.0, Wim / w, Him / h)
    w, h = w * s, h * s
    cx = min(max(cx, w / 2.0), Wim - w / 2.0)
    cy = min(max(cy, h / 2.0), Him - h / 2.0)
    X0, Y0 = int(round(cx - w / 2.0)), int(round(cy - h / 2.0))
    return img[Y0:Y0 + int(round(h)), X0:X0 + int(round(w))], (X0, Y0)


def bare(ax):
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    return ax


def badge(ax, text, x=0.03, y=0.97, ha="left", va="top", size=6.5):
    """White in-image type, as `src.style.tile` does it -- and white for a reason:
    it sits on a near-black viewport, and `lint_text.py` treats white spans as
    burned-in image labels rather than as plot text."""
    ax.text(x, y, text, transform=ax.transAxes, ha=ha, va=va, color="white",
            fontsize=size, fontweight="bold")


def main():
    use()
    rig_p = OUT / "fig6-rig.png"
    man_p = OUT / "fig6-app.json"
    if not rig_p.exists() or not man_p.exists():
        sys.exit("missing figs/out/fig6-rig.png or fig6-app.json — "
                 "run `node figs/fig6_app.mjs`")
    app = json.loads(man_p.read_text())
    td = app["threeD"]

    an_name = td.get("animals")
    an_p = OUT / an_name if an_name else None
    has_an = bool(an_p and an_p.exists() and td.get("animalsBBox"))

    an_w = W - RIG_W - GAP - PAD if has_an else 0.0
    rig_h = H - 2 * PAD

    fig = plt.figure(figsize=(mm(W), mm(H)))
    ax = fig.add_axes([PAD / W, PAD / H, RIG_W / W, rig_h / H])
    rig = mpimg.imread(str(rig_p))
    bb = td["rigBBox"]
    crop, (cx0, cy0) = crop_to(rig, (bb["x0"], bb["y0"], bb["x1"], bb["y1"]),
                               RIG_W / rig_h)
    bare(ax).imshow(crop)

    nprf = len(app.get("cameras") or [])
    badge(ax, f"{td['framing']['nCams']} cameras")
    if nprf:
        badge(ax, f"{nprf} proofread", y=0.03, va="bottom", size=6.0)

    # The marker box, placed from the manifest's own projected animal centre. `pane`
    # is the viewport in CSS px and the export is 3200 px wide, so the two axes get
    # their own scale factors -- one factor for both would put the box tens of px off.
    fr = td["framing"]
    amx = fr["animalsScreen"]["x"] * rig.shape[1] / fr["pane"][0] - cx0
    amy = fr["animalsScreen"]["y"] * rig.shape[0] / fr["pane"][1] - cy0
    # MARK_MM of print, converted through the crop's own px-per-mm.
    hw = MARK_MM / RIG_W * crop.shape[1] / 2.0
    hh = MARK_MM * 0.85 / rig_h * crop.shape[0] / 2.0
    inside = (0 <= amx <= crop.shape[1]) and (0 <= amy <= crop.shape[0])
    if inside:
        ax.add_patch(Rectangle((amx - hw, amy - hh), 2 * hw, 2 * hh, fill=False,
                               edgecolor="white", lw=0.6, ls=(0, (2.0, 1.4)),
                               zorder=5))

    if has_an:
        an = mpimg.imread(str(an_p))
        ab = td["animalsBBox"]
        an_h = min(rig_h, an_w * (ab["y1"] - ab["y0"]) / (ab["x1"] - ab["x0"]))
        ax2 = fig.add_axes([(RIG_W + GAP + PAD) / W, (H - PAD - an_h) / H,
                            an_w / W, an_h / H])
        crop2, _ = crop_to(an, (ab["x0"], ab["y0"], ab["x1"], ab["y1"]),
                           an_w / an_h, pad=0.03)
        bare(ax2).imshow(crop2)
        badge(ax2, f"{app['nAnimals']} in 3D")
        badge(ax2, "magnified", y=0.03, va="bottom", size=6.0)
        if inside:
            for xyA, xyB in (((amx + hw, amy - hh), (0.0, 1.0)),
                             ((amx + hw, amy + hh), (0.0, 0.0))):
                fig.add_artist(ConnectionPatch(
                    xyA=xyA, coordsA=ax.transData, xyB=xyB, coordsB=ax2.transAxes,
                    color="#8C8C8C", lw=0.4, ls=(0, (2.0, 1.4)), zorder=1))

    save(fig, 6, "a", "rig")


if __name__ == "__main__":
    main()
