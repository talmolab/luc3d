#!/usr/bin/env python3
"""
Dataset datasheets: SLAP-2M, Mouse-Dyad-10M, and a combined two-column sheet.

Restyles `figures/drafts/slap2m dataset.png` (the hand-made Illustrator draft) as
generated artwork so the tables can be rebuilt when the numbers move. Three sheets:

  figures/datasheets/datasheet_slap2m.{pdf,png}        the draft, regenerated
  figures/datasheets/datasheet_mousedyad10m.{pdf,png}  the other corpus, same style
  figures/datasheets/datasheet_combined.{pdf,png}      both, one label column

STYLE follows the draft: black on white, title block, an unlabelled stats block,
"Metadata" and "Files Per Session" sections separated by thick black bars, labels
left / values right. Type is Helvetica (helv/hebo), the same base-14 faces
`assemble.py` sets panel letters in, so the sheets match the figure pipeline.

NUMBERS.
  * SLAP-2M values are TRANSCRIBED from the draft PNG verbatim (they are not
    re-derivable here: the master sheet lives outside this repo). If a SLAP-2M
    number changes, change SLAP2M below and note the source.
  * Mouse-Dyad-10M values are MEASURED from the corpus (/root/vast/eric/BMimica)
    by --measure and deposited to out/dataset_sheets.json; the sheet renders from
    the deposit. Measured 2026-08-18: 56 sessions x 5 views x ~180k frames
    = 10,084,734 frames/view (the "10M"), every (frame, animal) carrying a 3D
    pose = 20,169,468 3D poses. "2D Poses" follows the draft's convention of
    reprojections = 3D poses x views (the SLAP-2M draft's 22.49 = 2.81 x 8).
  * Provided by Eric (2026-08-18): white mice.
  * CORRECTED (2026-08-21): the corpus is male/female dyads, not all-male -- every
    session's `track_names` slot 0 is a male animal and slot 1 a female animal, and
    that slot assignment is consistent per individual across every session it
    appears in (checked across all 56 sessions: 4 IDs always slot 0 (male), 5 IDs
    always slot 1 (female), zero IDs seen in both -- 9 individuals total, not 15;
    an earlier draft of this comment double-counted per-session track-name suffixes
    as distinct animals). "Male" alone was wrong; see fig5's leader analysis, which
    found this slot convention only after Eric flagged it.
  * Provided by Eric (2026-08-21): Mouse-Dyad-10M has 3 proofreaders.
  * "Total Animals" (2026-08-21) is the corpus-wide count of distinct individuals,
    separate from "Animals / Session" (how many are in any one recording). For
    Mouse-Dyad-10M this is the same 9 individuals (4 male, 5 female) as the sex
    correction above. For SLAP-2M no persistent per-animal identity exists in
    `master_sheet.xlsx` (only per-session white/agouti/black mouse counts), so the
    corpus-wide total cannot be derived here; left as "?" in the sheet -- per Eric,
    the SLAP-2M total goes in the manuscript main text instead, not the datasheet.
  * Held Out Views 0: all five calibrated views feed the proofread 3D; SLAP-2M's
    "2" is the two-of-eight views its proofreading never covered.

    python3 figs/dataset_sheets.py               # render from the deposit
    python3 figs/dataset_sheets.py --measure     # re-measure Mouse-Dyad-10M first
"""
from __future__ import annotations

import argparse
import glob
import json
import os

import fitz

HERE = os.path.dirname(os.path.abspath(__file__))
OUT_JSON = os.path.join(HERE, "out", "dataset_sheets.json")
OUT_DIR = os.path.join(HERE, "figures", "datasheets")
BMIMICA = "/root/vast/eric/BMimica"

MM = 72.0 / 25.4
PNG_DPI = 300

# ---- type scale (pt) and vertical rhythm (mm), eyeballed against the draft ----
TITLE_PT = 15.0
HEADER_PT = 11.0
BODY_PT = 10.0
ROW_MM = 5.4          # body row lead
HEADER_ROW_MM = 7.2   # section-header row (header text + thin rule below)
TITLE_ROW_MM = 10.0
BAR_MM = 2.4          # the thick black section bar
GAP_MM = 1.6          # white gap either side of a bar
PAD_MM = 2.2          # inner left/right padding of a block
MARGIN_MM = 2.0       # page margin around the outer border

INK = (0, 0, 0)
THIN = 0.35           # pt, block borders and header rules


def fmt_millions(n):
    return f"{n / 1e6:.2f}".rstrip("0").rstrip(".") + " million"


# ---- SLAP-2M: transcribed from figures/drafts/'slap2m dataset.png' -------------
SLAP2M = {
    "name": "SLAP-2M",
    "title": "SLAP-2M Dataset",
    "stats": [
        ("Frames", "15.6 million"),
        ("Frames / View", "1.95 million"),
        ("Camera Views", "8"),
        ("Held Out Views", "2"),
        ("No. Sessions", "74"),
        ("Total Animals", "?"),
        ("Animals / Session", "1-4"),
        ("Annotated Animals", "1-4"),
    ],
    "metadata": [
        ("Filename", "README.txt"),
        ("Format", ".slp, .h5, .csv, .mp4, .toml, .png"),
        ("Keywords", "Behavior, Pose Estimation, 3D Pose"),
        ("Data Types", "2D + 3D keypoints, Behavioral Labels"),
        ("3D Poses", "2.81 million"),
        ("2D Poses", "22.49 million"),
        ("Proofreading", "Manual + Automated"),
        ("No. Proofreaders", "2"),
        ("Mice Species", "White, Agouti, Black"),
        ("Mice Sex", "Male, Female"),
    ],
    "files": [
        ("points3d.h5", "3D Animal Keypoints"),
        ("reprojections.h5", "Reprojected 2D Keypoints / View"),
        ("calibration.toml", "Camera Calibration Matrices"),
        ("alignment.toml", "Data Centering Matrices"),
    ],
}


def measure_mousedyad():
    """Count the Mouse-Dyad-10M corpus. Reads every session's points3d h5."""
    import h5py
    import numpy as np
    sessions = sorted(d for d in glob.glob(os.path.join(BMIMICA, "*/"))
                      if os.path.basename(d.rstrip("/")) != "scratch")
    frames = poses3d = 0
    animals = set()
    nodes = None
    for d in sessions:
        fp = glob.glob(os.path.join(d, "*points3d*.h5"))[0]
        with h5py.File(fp) as h:
            X = h["tracks"][:]
            nn = [n.decode() if isinstance(n, bytes) else str(n)
                  for n in h["node_names"][:]]
        nodes = nodes or nn
        assert nn == nodes, f"node order differs in {fp}"
        animals.add(X.shape[1])
        frames += X.shape[0]
        poses3d += int(np.isfinite(X).any(axis=(2, 3)).sum())
        print(f"  {os.path.basename(d.rstrip('/'))}: {X.shape[0]} frames")
    assert animals == {2}, f"non-dyad session present: {animals}"
    views = 5
    return {
        "measured": "2026-08-18",
        "n_sessions": len(sessions),
        "views": views,
        "frames_per_view": frames,
        "frames_total": frames * views,
        "poses_3d": poses3d,
        "poses_2d_reproj": poses3d * views,
        "keypoints": len(nodes),
    }


def mousedyad_sheet(m):
    return {
        "name": "Mouse-Dyad-10M",
        "title": "Mouse-Dyad-10M Dataset",
        "stats": [
            ("Frames", fmt_millions(m["frames_total"])),
            ("Frames / View", fmt_millions(m["frames_per_view"])),
            ("Camera Views", str(m["views"])),
            ("Held Out Views", "0"),
            ("No. Sessions", str(m["n_sessions"])),
            ("Total Animals", "9 (4 Male, 5 Female)"),
            ("Animals / Session", "2"),
            ("Annotated Animals", "2"),
        ],
        "metadata": [
            ("Filename", "README.txt"),
            ("Format", ".slp, .h5, .mp4, .toml"),
            ("Keywords", "Behavior, Pose Estimation, 3D Pose"),
            ("Data Types", "2D + 3D keypoints"),
            ("3D Poses", fmt_millions(m["poses_3d"])),
            ("2D Poses", fmt_millions(m["poses_2d_reproj"])),
            ("Proofreading", "Manual"),
            ("No. Proofreaders", "3"),
            ("Mice Species", "White"),
            ("Mice Sex", "Male, Female"),
        ],
        "files": [
            ("points3d.h5", "3D Animal Keypoints"),
            ("analysis.h5", "2D Keypoints / View"),
            ("predictions.slp", "SLEAP Predictions / View"),
            ("video.mp4", "Camera Video / View"),
            ("calibration.toml", "Camera Calibration Matrices"),
        ],
    }


# ---- the renderer ---------------------------------------------------------------
class Sheet:
    """Row-based layout, drawn twice: a dry pass to size the page, then ink."""

    def __init__(self, width_mm):
        self.w = width_mm
        self.items = []

    def title(self, text):
        self.items.append(("title", text))

    def bar(self):
        self.items.append(("bar",))

    def header(self, text):
        self.items.append(("header", text))

    def row(self, label, *values):
        self.items.append(("row", label, values))

    def height_mm(self):
        h = MARGIN_MM
        for it in self.items:
            h += {"title": TITLE_ROW_MM, "bar": BAR_MM + 2 * GAP_MM,
                  "header": HEADER_ROW_MM, "row": ROW_MM}[it[0]]
        return h + MARGIN_MM + 1.0

    def draw(self, page, value_cols=None, col_headers=None):
        """value_cols: right-edge x (mm) per value column; default one column at
        the block's right pad. col_headers: names drawn right-aligned over the
        value columns, under the title."""
        x0, x1 = MARGIN_MM, self.w - MARGIN_MM
        if value_cols is None:
            value_cols = [x1 - PAD_MM]
        y = MARGIN_MM
        block_top = None          # open block: its border is drawn when it closes

        def close_block(y_end):
            nonlocal block_top
            if block_top is not None:
                page.draw_rect(fitz.Rect(x0 * MM, block_top * MM,
                                         x1 * MM, y_end * MM),
                               color=INK, width=THIN)
                block_top = None

        for it in self.items:
            kind = it[0]
            if kind == "title":
                block_top = block_top if block_top is not None else y
                tw = fitz.get_text_length(it[1], fontname="hebo",
                                          fontsize=TITLE_PT) / MM
                page.insert_text(((x0 + (x1 - x0 - tw) / 2) * MM,
                                  (y + TITLE_ROW_MM - 2.6) * MM),
                                 it[1], fontname="hebo", fontsize=TITLE_PT,
                                 color=INK)
                y += TITLE_ROW_MM
                if col_headers:
                    page.draw_line(fitz.Point(x0 * MM, y * MM),
                                   fitz.Point(x1 * MM, y * MM),
                                   color=INK, width=THIN)
                    for cx, name in zip(value_cols, col_headers):
                        nw = fitz.get_text_length(name, fontname="hebo",
                                                  fontsize=BODY_PT) / MM
                        page.insert_text(((cx - nw) * MM,
                                          (y + ROW_MM - 1.4) * MM),
                                         name, fontname="hebo",
                                         fontsize=BODY_PT, color=INK)
                    y += ROW_MM
                    self._col_header_drawn = True
            elif kind == "bar":
                close_block(y)
                y += GAP_MM
                page.draw_rect(fitz.Rect(x0 * MM, y * MM, x1 * MM,
                                         (y + BAR_MM) * MM),
                               color=INK, fill=INK, width=0)
                y += BAR_MM + GAP_MM
            elif kind == "header":
                block_top = block_top if block_top is not None else y
                page.insert_text(((x0 + PAD_MM) * MM,
                                  (y + HEADER_ROW_MM - 3.2) * MM),
                                 it[1], fontname="helv", fontsize=HEADER_PT,
                                 color=INK)
                y += HEADER_ROW_MM
                page.draw_line(fitz.Point(x0 * MM, y * MM),
                               fitz.Point(x1 * MM, y * MM),
                               color=INK, width=THIN)
            elif kind == "row":
                block_top = block_top if block_top is not None else y
                _, label, values = it
                page.insert_text(((x0 + PAD_MM) * MM, (y + ROW_MM - 1.4) * MM),
                                 label, fontname="helv", fontsize=BODY_PT,
                                 color=INK)
                right_of = (x0 + PAD_MM
                            + fitz.get_text_length(label, fontname="helv",
                                                   fontsize=BODY_PT) / MM)
                for cx, v in zip(value_cols, values):
                    if v is None:
                        continue
                    vw = fitz.get_text_length(v, fontname="helv",
                                              fontsize=BODY_PT) / MM
                    # a value must not run into the label or the column left of it
                    assert cx - vw > right_of + 1.5, \
                        f"column collision at row {label!r}: {v!r} needs " \
                        f"{vw:.1f} mm, only {cx - right_of:.1f} available"
                    page.insert_text(((cx - vw) * MM, (y + ROW_MM - 1.4) * MM),
                                     v, fontname="helv", fontsize=BODY_PT,
                                     color=INK)
                    right_of = cx
                y += ROW_MM
        close_block(y)

    def render(self, out_pdf, value_cols=None, col_headers=None):
        # account for the column-header row in the sizing pass
        extra = ROW_MM if col_headers else 0.0
        doc = fitz.open()
        page = doc.new_page(width=self.w * MM,
                            height=(self.height_mm() + extra) * MM)
        self.draw(page, value_cols=value_cols, col_headers=col_headers)
        os.makedirs(os.path.dirname(out_pdf), exist_ok=True)
        doc.save(out_pdf, deflate=True)
        png = out_pdf[:-4] + ".png"
        fitz.open(out_pdf)[0].get_pixmap(dpi=PNG_DPI).save(png)
        print(f"[sheet] {os.path.relpath(out_pdf, HERE)} + .png")


def build_single(ds, out_pdf, width_mm=92.0):
    s = Sheet(width_mm)
    s.title(ds["title"])
    for label, v in ds["stats"]:
        s.row(label, v)
    s.bar()
    s.header("Metadata")
    for label, v in ds["metadata"]:
        s.row(label, v)
    s.bar()
    s.header("Files Per Session")
    for fn, desc in ds["files"]:
        s.row(fn, desc)
    s.render(out_pdf)


def build_combined(a, b, out_pdf, width_mm=178.0):
    """One label column, one value column per dataset. Files Per Session differ
    per corpus, so they stay as two labelled sub-blocks. 178 mm sits inside
    Nature's 180 mm double column; the 66 mm column pitch clears the longest
    value ('Behavior, Pose Estimation, 3D Pose' ~60 mm at 10 pt — the draw()
    collision assert enforces this)."""
    s = Sheet(width_mm)
    x1 = width_mm - MARGIN_MM
    cols = [x1 - PAD_MM - 66.0, x1 - PAD_MM]
    s.title(f"{a['name']} & {b['name']} Datasets")
    for (la, va), (lb, vb) in zip(a["stats"], b["stats"]):
        assert la == lb, (la, lb)
        s.row(la, va, vb)
    s.bar()
    s.header("Metadata")
    for (la, va), (lb, vb) in zip(a["metadata"], b["metadata"]):
        assert la == lb, (la, lb)
        s.row(la, va, vb)
    s.bar()
    s.header(f"Files Per Session — {a['name']}")
    for fn, desc in a["files"]:
        s.row(fn, None, desc)
    s.bar()
    s.header(f"Files Per Session — {b['name']}")
    for fn, desc in b["files"]:
        s.row(fn, None, desc)
    s.render(out_pdf, value_cols=cols, col_headers=[a["name"], b["name"]])


def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[1])
    ap.add_argument("--measure", action="store_true",
                    help="re-measure Mouse-Dyad-10M from the corpus")
    args = ap.parse_args()

    if args.measure or not os.path.exists(OUT_JSON):
        m = measure_mousedyad()
        os.makedirs(os.path.dirname(OUT_JSON), exist_ok=True)
        with open(OUT_JSON, "w") as f:
            json.dump({"mousedyad10m": m}, f, indent=1)
        print(f"[json] {OUT_JSON}")
    with open(OUT_JSON) as f:
        m = json.load(f)["mousedyad10m"]

    md = mousedyad_sheet(m)
    build_single(SLAP2M, os.path.join(OUT_DIR, "datasheet_slap2m.pdf"))
    build_single(md, os.path.join(OUT_DIR, "datasheet_mousedyad10m.pdf"))
    build_combined(SLAP2M, md, os.path.join(OUT_DIR, "datasheet_combined.pdf"))


if __name__ == "__main__":
    main()
