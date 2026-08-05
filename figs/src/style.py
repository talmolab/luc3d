"""
The `figures-mimic-mjx` panel style, measured from the reference PDFs rather than
eyeballed.

Every number below was read out of `talmolab/figures-mimic-mjx`'s own committed
panel PDFs with PyMuPDF (font sizes, stroke widths, fill colours, page sizes),
so this module reproduces that look rather than approximating it:

    fig3d_env_paral_vs_speed_v12_final.pdf   75.4 x 49.9 mm   Arial 8 pt
    fig2d_continuous_rollout.pdf             77.1 x 51.7 mm   Arial 8 pt
    fig5b_episode_reward.pdf                 76.1 x 75.3 mm   Arial 8 pt
    fig2c_joint_angle_tracking.pdf           87.5 x 94.1 mm   Arial 8 pt

    stroke widths   0.8 pt  axes/spines/ticks
                    2.0 pt  data lines
    fills           #66C2A5 #FC8D62 #8DA0CB  (= seaborn "Set2", verified exactly)

The house rules that follow from those measurements, and that this module enforces:

* **One idea per panel, one panel per file.** No composite. Panel letters, titles
  and footers are NOT drawn -- they are added at assembly time in Illustrator.
  This is the single biggest departure from the old `nature.py` path, which baked
  letters, titles, cross-panel annotation and a footer into one SVG.
* **Coloured bold text instead of a legend box.** `text_legend()`. The reference
  never draws a legend frame; it stacks bold coloured series names in the corner,
  or writes them straight onto the data with `annotate_series()`.
* **Despine.** Top and right always go. Often the left as well (`left=True`),
  leaving bare tick dashes -- that is `fig2b`'s look.
* **8 pt type, everywhere.** Not 6, not 7. Panels are ~76 mm wide and meant to be
  placed at roughly that size, so 8 pt lands at 8 pt on the page.

Usage:

    from src.style import use, panel, text_legend, save, SET2
    use()
    fig, ax = panel()
    ax.plot(x, y, color=SET2[2])
    text_legend(ax, [("DLT", SET2[2]), ("refined", SET2[0])])
    save(fig, 4, "b", "accuracy_vs_cameras")

FONTS. The reference repo's README tells you to `apt install msttcorefonts` to get
real Arial. Where that is unavailable the list below falls through to Liberation
Sans, which is metric-compatible with Arial (identical advance widths), so layout
is unchanged and only the embedded font name differs.
"""

from __future__ import annotations

from pathlib import Path

import matplotlib as mpl
import matplotlib.pyplot as plt
import seaborn as sns

# --------------------------------------------------------------------------
# palette
# --------------------------------------------------------------------------

#: seaborn "Set2" -- verified byte-exact against the reference PDFs' fill colours.
SET2 = [
    "#66C2A5",  # teal
    "#FC8D62",  # salmon
    "#8DA0CB",  # periwinkle
    "#E78AC3",  # pink
    "#A6D854",  # green
    "#FFD92F",  # yellow
    "#E5C494",  # tan
    "#B3B3B3",  # grey
]

TEAL, SALMON, PERIWINKLE, PINK, GREEN, YELLOW, TAN, GREY = SET2

#: The two accent colours `fig2b` uses in place of Set2 for a two-condition
#: contrast, kept because that panel is the clearest statement of the house look.
AMBER = "#DF9C20"
SKY = "#93C9DE"

#: Box/whisker and general line ink in the reference (NOT pure black).
INK = "#4C4D4C"

#: Muted TEXT ink. 4.6:1 on white.
#:
#: `GREY` is `SET2[7]` -- a CATEGORICAL SERIES colour -- and it was being used as a
#: text ink for load-bearing content: every cell of three data tables, the `n=`
#: labels in 4c, the random baseline in 5c, provenance lines. At #B3B3B3 that is
#: **2.1:1** contrast on white at 8 pt, i.e. below every accessibility floor there
#: is, while the headers beside it sat at 8.6:1. Use MUTED for text that must be
#: read but should recede; keep GREY for series marks and rules.
MUTED = "#6E6E6E"

# --------------------------------------------------------------------------
# recurring entities
# --------------------------------------------------------------------------
# COLOUR MEANS ONE THING ACROSS THE WHOLE SET. Before this, the same three Set2
# hues carried unrelated meanings on facing pages -- periwinkle was DLT in Fig 4
# and SLEAP in Fig 7; salmon was the exhaustive baseline in Fig 3, the oracle
# ceiling in Fig 5 and missing keypoints in Fig 6. A reader who learns a hue on
# one page is then actively misled by the next.
#
# The scheme is a RULE, not a lookup table, which is why it can stay consistent:
#
#   TEAL        this work, whatever it is called in that figure
#               (LUC3D, the refined solver, LUC3D's own cross-view residual)
#   SALMON      the thing this work is being compared against
#               (exhaustive association, DLT, ByteTrack)
#   PERIWINKLE  SLEAP specifically -- a named third party that recurs across
#               figures and therefore earns its own hue rather than sharing the
#               generic comparator colour
#   PINK        3D-MuPPET
#   GREY        a BOUND, not a method: the oracle ceiling, the 1/C ceiling, random
#
# SALMON deliberately covers three different comparators. They never co-occur in
# one panel, and "the alternative to ours" is a real shared meaning -- which is
# more honest than minting a fifth hue and implying DLT and ByteTrack are
# unrelated kinds of thing. What must NOT happen is periwinkle meaning DLT in one
# figure and SLEAP in another; those genuinely are different kinds of thing.
#
# Only ENTITIES are reserved. A panel whose series are QUANTITIES rather than
# entities -- Fig 6c's missing/error/tolerance, Fig 3's camera counts -- may use
# the palette freely; there is nothing there to be consistent with.
ENTITY = {
    "luc3d": TEAL,
    "refined": TEAL,
    "residual": TEAL,
    "sleap": PERIWINKLE,
    "confidence": PERIWINKLE,   # the alternative ranking signal, not a tracker
    "bytetrack": SALMON,
    "exhaustive": SALMON,
    "dlt": SALMON,
    "3d-muppet": PINK,
    "oracle": GREY,
    "random": GREY,
    "ceiling": GREY,
}


def entity(name):
    """Colour for a recurring entity, so one hue means one thing set-wide.

    Raises rather than falling back: a silent default is how the inconsistency
    got in.
    """
    try:
        return ENTITY[name.lower()]
    except KeyError:
        raise KeyError(
            f"unknown entity {name!r} -- add it to ENTITY in src/style.py rather "
            f"than picking a hue locally; see the rule above ENTITY") from None


#: Panel size in inches. 3.0 x 2.5 in = 76.2 x 63.5 mm, the reference's own
#: `plt.subplots(figsize=(3, 2.5))`.
PANEL = (3.0, 2.5)

# --------------------------------------------------------------------------
# the column grid
# --------------------------------------------------------------------------
# EVERY PANEL IS BUILT ON THIS GRID, and that is the fix for the single worst
# defect of the first pass: panels were sized ad hoc and saved with
# `bbox_inches="tight"`, so each one's final width depended on how long its y
# tick labels happened to be. Assembled, the rows came out ragged -- panels in
# the same row were different heights and their axes did not line up.
#
# Now: a panel declares a COLUMN SPAN and a ROW HEIGHT, gets exactly that many
# millimetres, and is saved WITHOUT tight bbox, so the PDF is exactly the size
# asked for. `constrained_layout` fits the labels INSIDE that box instead of
# growing it. Two panels of the same class are therefore always identical in
# size, and their plot frames align across a row.

MM_PER_IN = 25.4
PAGE_W = 180.0            # mm, Nature double column
GUTTER = 4.0              # mm between panels in a row

#: span name -> width in mm, laid out so n panels + (n-1) gutters == 180 mm.
SPAN = {
    "full": PAGE_W,                              # 180.0
    "two-thirds": (PAGE_W - GUTTER) * 2 / 3,     # 117.3
    "half": (PAGE_W - GUTTER) / 2,               # 88.0
    "third": (PAGE_W - 2 * GUTTER) / 3,          # 57.3
    "quarter": (PAGE_W - 3 * GUTTER) / 4,        # 42.0
}

#: standard row heights in mm. Data panels use "std"; image rows are taller.
ROW_H = {"short": 40.0, "std": 52.0, "tall": 64.0, "image": 46.0}


def mm(x):
    """mm -> inches, for figsize."""
    return x / MM_PER_IN

#: Repo root (figs/) and the two output trees.
FIGS = Path(__file__).resolve().parent.parent
DATA = FIGS / "data"
FIGURES = FIGS / "figures"


def use(font_size: float = 8.0) -> None:
    """Apply the reference rcParams. Call once at the top of a panel script.

    Mirrors the rcParams block that opens every notebook in the reference repo,
    plus the stroke widths measured out of its PDFs.
    """
    sns.set_theme(style="ticks", context="paper")

    mpl.rcParams.update(
        {
            # --- the reference's own block ---
            "figure.facecolor": "w",
            "figure.dpi": 150,
            "savefig.dpi": 600,
            "savefig.transparent": True,
            # NOT "tight": panels declare an exact size on the column grid and
            # constrained_layout fits the labels inside it. Trimming to the ink
            # would make the saved size depend on tick-label length again.
            "savefig.bbox": None,
            "font.size": font_size,
            "font.family": "sans-serif",
            "font.sans-serif": [
                "Arial",
                "Liberation Sans",
                "Helvetica",
                "DejaVu Sans",
            ],
            # --- measured stroke widths ---
            "axes.linewidth": 0.8,
            "xtick.major.width": 0.8,
            "ytick.major.width": 0.8,
            "xtick.minor.width": 0.8,
            "ytick.minor.width": 0.8,
            "lines.linewidth": 2.0,
            "patch.linewidth": 0.8,
            # --- type: everything at the panel size, nothing smaller ---
            "axes.labelsize": font_size,
            "axes.titlesize": font_size,
            "xtick.labelsize": font_size,
            "ytick.labelsize": font_size,
            "legend.fontsize": font_size,
            # --- chrome the reference never uses ---
            "axes.grid": False,
            "axes.spines.top": False,
            "axes.spines.right": False,
            "legend.frameon": False,
            "axes.titlepad": 4.0,
            # --- keep text as text so Illustrator can edit it ---
            "pdf.fonttype": 42,
            "ps.fonttype": 42,
            "svg.fonttype": "none",
        }
    )


def panel(span="third", row="std", *, left: bool = False, bottom: bool = False,
          key: int = 0, **kw):
    """A despined panel occupying one grid slot, at EXACTLY that size.

    `span` is a key of `SPAN` (or a width in mm), `row` a key of `ROW_H` (or a
    height in mm). The saved PDF is exactly `span x row` millimetres -- see the
    grid note above for why that matters.

    `left=True` / `bottom=True` remove those spines too, leaving bare tick dashes
    (the `fig2b` look). Top and right are always removed.
    """
    w = SPAN.get(span, span) if not isinstance(span, (int, float)) else span
    h = ROW_H.get(row, row) if not isinstance(row, (int, float)) else row
    fig, ax = plt.subplots(figsize=(mm(w), mm(h)), layout="constrained", **kw)
    if key:
        # Reserve a band ABOVE the plot for `text_legend(loc="above")`. Without it
        # the key is inside the data area and lands on the curves it names -- the
        # single most common collision in the first pass, and one no text-vs-text
        # check can see. `key` is the number of entries.
        fig.get_layout_engine().set(rect=(0, 0, 1, 1 - (0.052 * key + 0.02)))
    sns.despine(ax=ax, left=left, bottom=bottom, top=True, right=True)
    if left:
        ax.tick_params(axis="y", length=3)
    if bottom:
        ax.tick_params(axis="x", length=3)
    return fig, ax


def grid(nrows=1, ncols=1, span="full", row="std", *, left: bool = False,
         despine: bool = True, **kw):
    """A multi-axes panel occupying one grid slot, at EXACTLY that size.

    Unlike the old signature, `span`/`row` are the size of the WHOLE panel, not
    per subplot -- so a 3-across panel and a 1-across panel in the same figure row
    come out the same height, which is the point.
    """
    w = SPAN.get(span, span) if not isinstance(span, (int, float)) else span
    h = ROW_H.get(row, row) if not isinstance(row, (int, float)) else row
    fig, axes = plt.subplots(nrows, ncols, figsize=(mm(w), mm(h)),
                             layout="constrained", **kw)
    if despine:
        for ax in (axes.ravel() if hasattr(axes, "ravel") else [axes]):
            sns.despine(ax=ax, left=left, top=True, right=True)
    return fig, axes


#: Where `text_legend` puts its stack. `(x, y, ha, va)` in axes coordinates.
_LEGEND_LOC = {
    # INSIDE the axes. These used to sit at y = 1.04 -- fine under
    # bbox_inches="tight", which grew the page to include them, but the panel is now
    # saved at an exact size and everything above y = 1 is simply cut off.
    "above": (0.015, 0.985, "left", "top"),
    "above right": (0.985, 0.985, "right", "top"),
    "upper left": (0.02, 0.98, "left", "top"),
    "upper right": (0.98, 0.98, "right", "top"),
    "lower left": (0.02, 0.02, "left", "bottom"),
    "lower right": (0.98, 0.02, "right", "bottom"),
}


def text_legend(ax, entries, loc="above", *, dy=0.105, size=None,
                weight="bold", xy=None, transform=None):
    """Bold coloured series names stacked as text, in place of a legend box.

    The reference's signature move -- see `fig2b`'s "STAC Registration" /
    "Track Replay" stack, drawn in the box colours with no frame and no handles,
    sitting ABOVE the axes so it never lands on the data. That is the default here.

    `entries` is a sequence of `(label, colour)`. `loc` is one of `_LEGEND_LOC`;
    pass `xy=(x, y)` to place it by hand in axes coordinates instead.

    Stacks grow DOWNWARD from the anchor for the interior locations and UPWARD for
    the "above" ones, so the block always reads top-to-bottom in `entries` order.
    """
    x, y, ha, va = _LEGEND_LOC[loc]
    if xy is not None:
        x, y = xy
    up = va == "bottom"
    n = len(entries)
    if loc.startswith("above") and transform is None:
        # Figure coordinates, so the key sits in the band panel(key=...) reserved
        # rather than inside the data area.
        transform = ax.figure.transFigure
        x = 0.14 if loc == "above" else 0.98
        y = 0.985
        dy = 0.052
        va = "top"
        up = False
    transform = ax.transAxes if transform is None else transform
    for i, (label, color) in enumerate(entries):
        # Growing upward means the LAST entry sits at the anchor, so invert the
        # offset -- otherwise "above" stacks read bottom-to-top.
        off = (n - 1 - i) * dy if up else -i * dy
        ax.figure.text(x, y + off, label, transform=transform,
                       color=color, fontweight=weight,
                       fontsize=size or mpl.rcParams["font.size"],
                       ha=ha, va=va) if transform is ax.figure.transFigure else ax.text(
            x, y + off, label,
            color=color, fontweight=weight,
            fontsize=size or mpl.rcParams["font.size"],
            transform=transform, ha=ha, va=va,
        )


def annotate_series(ax, x, y, label, color, *, size=None, weight="bold", **kw):
    """Write a series' name directly onto its data, in its own colour.

    The reference does this rather than run a leader line -- see fig3d's
    "Linear Scaling w/ Env Parallelism" sitting in the data area in orange.
    Coordinates are in DATA space unless a `transform` is passed.
    """
    ax.text(
        x, y, label, color=color, fontweight=weight,
        fontsize=size or mpl.rcParams["font.size"], **kw,
    )


def value_labels(ax, xs, ys, fmt="{:.1f}", *, color=INK, dy=0.0, size=None,
                 weight="bold", ha="center", va="bottom"):
    """Print each datum's value next to its mark, the way the reference labels bars."""
    for x, y in zip(xs, ys):
        ax.text(
            x, y + dy, fmt.format(y), color=color, fontweight=weight,
            fontsize=size or mpl.rcParams["font.size"], ha=ha, va=va,
        )


def image_row(paths, labels=None, *, span="full", row=None, crop=None, gap=0.02,
              label_color=None):
    """Lay N app-exported PNGs in a row, each captioned underneath.

    The panels that show what the app actually drew are images, not plots, so they
    get their own primitive rather than being forced through an axes. Every tile is
    drawn at the SAME crop and the same size, because the whole point of these
    sequences is that only one thing changed between them.

    `crop` is `(left, top, right, bottom)` as FRACTIONS of the source image, applied
    identically to every tile -- app exports are 5120x2880 and a figure tile is
    ~40 mm, so an uncropped tile shows a few-dozen-pixel mouse.
    """
    import matplotlib.image as mpimg

    n = len(paths)
    imgs = []
    for p in paths:
        a = mpimg.imread(str(p))
        if crop:
            H, W = a.shape[:2]
            l, t, r, b = crop
            a = a[int(t * H):int(b * H), int(l * W):int(r * W)]
        imgs.append(a)

    # On the column grid like every other panel: width from `span`, and height from
    # the tiles' own aspect unless `row` overrides it, so an image row lines up with
    # the plot rows around it.
    w = SPAN.get(span, span) if not isinstance(span, (int, float)) else span
    ar = imgs[0].shape[0] / imgs[0].shape[1]
    h = (ROW_H.get(row, row) if row is not None else (w / n) * ar * 1.18)
    fig, axes = plt.subplots(1, n, figsize=(mm(w), mm(h)), layout="constrained")
    axes = axes if n > 1 else [axes]
    for ax, a, lab in zip(axes, imgs, labels or [None] * n):
        ax.imshow(a)
        ax.set_xticks([])
        ax.set_yticks([])
        for s in ax.spines.values():
            s.set_visible(False)
        if lab:
            ax.set_xlabel(lab, color=label_color or INK,
                          fontsize=mpl.rcParams["font.size"])
    fig.subplots_adjust(wspace=gap)
    return fig, axes


def load_tile(path, bbox=None, pad=0.10):
    """Read an app export and crop it to a PIXEL bbox from the run's own manifest.

    `bbox` is `(x0, y0, x1, y1)` in source pixels -- exactly what `exportViews()`
    records for each view, so tiles are framed on where the animals actually were
    rather than on a guessed fraction. `pad` widens it by that fraction of the
    larger side, keeping the crop square-ish so a row of tiles shares one aspect.
    """
    import matplotlib.image as mpimg

    a = mpimg.imread(str(path))
    if bbox is None:
        return a
    H, W = a.shape[:2]
    x0, y0, x1, y1 = bbox
    w, h = x1 - x0, y1 - y0
    m = max(w, h) * (1 + pad) / 2.0
    cx, cy = (x0 + x1) / 2.0, (y0 + y1) / 2.0
    x0, x1 = int(max(0, cx - m)), int(min(W, cx + m))
    y0, y1 = int(max(0, cy - m)), int(min(H, cy + m))
    return a[y0:y1, x0:x1]


def tile(ax, path, bbox=None, *, badge=None, badge_color="white", label=None,
         corner="upper left", pad=0.10):
    """One image tile: cropped, unframed, with an optional in-image badge.

    The badge is the app's own view name burned into the corner the way the
    original figures did it (`cam 0 mid`, `anchor`, `not labelled`) -- it belongs
    ON the tile, because a tile without its camera name is unattributable.
    """
    a = load_tile(path, bbox, pad)
    ax.imshow(a)
    ax.set_xticks([])
    ax.set_yticks([])
    for s in ax.spines.values():
        s.set_visible(False)
    if badge:
        va, ha = ("top", "left") if "upper" in corner else ("bottom", "left")
        x, y = (0.03, 0.97) if "upper" in corner else (0.03, 0.03)
        if "right" in corner:
            x, ha = 0.97, "right"
        ax.text(x, y, badge, transform=ax.transAxes, ha=ha, va=va,
                color=badge_color, fontsize=6.5, fontweight="bold")
    if label:
        ax.set_xlabel(label, fontsize=mpl.rcParams["font.size"], color=INK)
    return ax


def footnote(ax, text, *, size=6.5, color=None):
    """A small note under the x axis, appended to the axis label.

    Hand-placed `ax.text(0.5, -0.2, ...)` notes were the second-biggest source of
    clipped and overlapping text once panels started saving at an exact size: they
    sit outside the axes, so they either fell off the page or landed on the x label.
    Folding the note INTO the label guarantees constrained_layout accounts for it.
    """
    lab = ax.get_xlabel()
    ax.set_xlabel(f"{lab}\n{text}" if lab else text)
    # Two sizes in one label is not possible, so the whole label steps down a little
    # and the note carries the smaller weight through colour instead.
    ax.xaxis.label.set_fontsize(min(mpl.rcParams["font.size"], size + 1.0))
    return ax


def save(fig, fig_no, letter, slug, *, png: bool = True, close: bool = True) -> Path:
    """Write `figures/figN/figN<letter>_<slug>.pdf` (+ .png), the reference's naming.

    e.g. `save(fig, 4, "b", "accuracy_vs_cameras")`
         -> figures/fig4/fig4b_accuracy_vs_cameras.pdf

    A companion PNG is written by default so panels can be eyeballed without a
    PDF viewer; the PDF is the artefact that goes into Illustrator.
    """
    out = FIGURES / f"fig{fig_no}"
    out.mkdir(parents=True, exist_ok=True)
    stem = out / f"fig{fig_no}{letter}_{slug}"
    # NO tight bbox. The panel already declared its exact size on the column grid
    # and `constrained_layout` fitted the labels inside it; trimming to the ink
    # would make the output size depend on tick-label length, which is what made
    # the first pass's rows ragged.
    fig.savefig(stem.with_suffix(".pdf"), dpi=600)
    if png:
        fig.savefig(stem.with_suffix(".png"), dpi=600)
    if close:
        plt.close(fig)
    print(f"  wrote {stem.relative_to(FIGS)}.pdf")
    return stem.with_suffix(".pdf")


def data_path(fig_no, name) -> Path:
    """`data/figN/<name>` -- the committed, plot-ready table for a panel."""
    d = DATA / f"fig{fig_no}"
    d.mkdir(parents=True, exist_ok=True)
    return d / name


def deposit(df, fig_no, name) -> Path:
    """Write a plot-ready table to `data/figN/<name>` and return the path.

    The reference's core idiom: the expensive measurement pass deposits a CSV, the
    plotting pass reads it back. The CSV is committed, so a panel can be redrawn
    without re-running the measurement -- and so the numbers on the artwork are
    auditable against a file in the repo.
    """
    p = data_path(fig_no, name)
    df.to_csv(p, index=False)
    print(f"  deposited {p.relative_to(FIGS)}  ({len(df)} rows)")
    return p
