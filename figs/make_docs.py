#!/usr/bin/env python3
"""
Generate `PANEL-SOURCES.md` -- the map from every panel on the artwork back to the
script that drew it, the data file it read, and the CSV it deposited.

WHY THIS IS GENERATED AND NOT WRITTEN. A hand-kept index of 48 panels across seven
figures is wrong within a week: panels get re-lettered, replaced, or moved between
figures, and nothing complains. Everything below is read out of the same sources the
build itself uses -- `assemble.LAYOUTS` for what is actually placed, the panel
scripts' own `save(...)` calls for which script owns a letter, their `deposit(...)`
calls for the CSVs, and their docstrings for the upstream JSON -- so the document
cannot drift from the figures without the build changing too.

`FIGURE-LEGENDS.md` and `METHODS.md` are written by hand: they are prose about what
the measurements mean, and generating them would only produce a worse version of the
captions. This script checks their panel inventory against the layout, though, so a
legend that has lost a panel is reported.

    python3 figs/make_docs.py            # write PANEL-SOURCES.md
    python3 figs/make_docs.py --check    # exit non-zero if it is out of date
"""
from __future__ import annotations

import argparse
import re
import sys
from pathlib import Path

FIGS = Path(__file__).resolve().parent
sys.path.insert(0, str(FIGS))

import assemble as A  # noqa: E402

PANELS = FIGS / "panels"
OUT = FIGS / "PANEL-SOURCES.md"

#: Measurement passes that write `figs/out/*.json`. A panel names the JSON it reads
#: in its docstring; this maps that JSON back to the pass that produced it, which is
#: the step a reader has to repeat to regenerate a panel from raw data.
PRODUCERS = {
    "fig1.json": "figs/fig1_gui.mjs, figs/fig1_rig.mjs, figs/fig1_tracking.mjs",
    "fig2.json": "figs/fig2_protocol.mjs",
    "fig2_measure.json": "figs/fig2_measure.py",
    "fig3_sweep.json": "figs/fig3_sweep.py",
    "fig3_headtohead.json": "figs/fig3_headtohead.py",
    "fig3_quality.json": "figs/fig3_quality.py",
    "fig3_continuity.json": "figs/fig3_continuity.py",
    "fig3_scale_runtime.json": "figs/fig3_scale_runtime.py",
    "fig4_anipose.json": "figs/fig4_anipose.py",
    "fig4_by_views.json": "figs/fig4_by_views.mjs",
    "fig4_measure.json": "figs/fig4_measure.mjs",
    "fig4_time.json": "figs/fig4_time_luc3d.mjs",
    "fig5.json": "figs/fig5_panel_a.mjs",
    "fig5a.json": "figs/fig5_panel_a.mjs",
    "fig5_upright.json": "figs/fig5_upright.py",
    "fig5_aftermath.json": "figs/fig5_aftermath.py",
    "fig5_rear_coupling_2animal.json": "figs/fig5_rear_coupling.py --slap-animals 2",
    "fig5_rear_coupling.json": "figs/fig5_rear_coupling.py",
    "fig5_rearing.json": "figs/fig5_rearing.py",
    "fig5_proofread.json": "figs/fig5_proofread.py",
    "fig6_detections.json": "figs/fig6_detections.py",
    "fig6_difficulty.json": "figs/fig6_difficulty.py",
    "fig6_measure.json": "figs/fig6_measure.py",
    "fig6_pose.json": "figs/fig6_pose.py",
    "fig6_session.json": "figs/fig6_session.py",
    "fig6_app.json": "figs/fig6_app.mjs",
    "fig6-app.json": "figs/fig6_app.mjs",
    "fig2-protocol.json": "figs/fig2_protocol.mjs",
    "fig3_runtime.json": "figs/fig3_scale_runtime.py",
    "fig3_trackers.json": "figs/fig3_trackers.py",
    "fig4.json": "figs/fig4_measure.mjs (+ figs/fig4_anipose.py, figs/fig4_by_views.mjs)",
    "fig6.json": "figs/fig6_measure.py (+ figs/fig6_pose.py, figs/fig6_app.mjs)",
    "fig5_views.json": "figs/fig5_views.py",
    # Not a figs/out JSON: Fig 1a is a Blender render, and the "measurement pass"
    # that produced it is the scene script that placed the session's calibration,
    # cage corners and tracked poses (see panels/fig1_00_render.py). Since
    # 2026-08-19 the panel reads the video-frame framings under fig1_renders/.
    "blender-images/renders/fig1_renders/slap2m-4mice_f06020.png":
        "blender-images/cage_scene.py",
    # The Mouse-Dyad-10M half of Fig 1a takes TWO scripts: the deposit script measures
    # the arena footprint, picks the frame and carries the calibration into the 3D
    # frame; the scene script only draws what it deposited.
    "blender-images/renders/fig1_renders/mouse-dyad_f55701.png":
        "figs/fig1_bmimica_scene.py (+ blender-images/bmimica_scene.py)",
    # Fig 6a reads TEN tiles (enrich_a{A}_o{O}.png); the docstring names the first
    # as the representative, and the scene script is the measurement pass for all.
    "blender-images/renders/enrich_a1_o0.png":
        "blender-images/enrichment_scene.py",
}


#: The two hand-written documents also ship as PLAIN TEXT twins, because they are
#: pasted into a word processor and markdown does not survive that: asterisks arrive
#: as asterisks, pipe tables as pipes, and -- worst -- the hard line wraps arrive as
#: hard line wraps, which have to be deleted by hand, line by line, before the page
#: can reflow. `plain()` therefore joins every paragraph onto ONE line and lets the
#: word processor do the wrapping, strips the heading marks, and drops the
#: self-referential pointer to the .txt file itself.
#: First-line indent for the plain-text twins. A tab, not spaces: a word processor
#: treats a tab as an indent it can restyle, where spaces are just characters.
INDENT = "\t"

PLAIN = {FIGS / "FIGURE-LEGENDS.md": FIGS / "FIGURE-LEGENDS.txt",
         FIGS / "METHODS.md": FIGS / "METHODS.txt",
         FIGS / "RESULTS.md": FIGS / "RESULTS.txt"}


def plain(md: str, title: str) -> str:
    """Markdown -> word-processor text: one line per paragraph, first-line indent.

    Two rules, both from pasting this into a word processor and finding out. The
    paragraph goes on ONE line, because a hard wrap arrives as a hard wrap and has
    to be deleted line by line before the page can reflow. And paragraphs are
    separated by a first-line INDENT rather than by a blank line, because a blank
    line between every paragraph is a second thing to strip out by hand.
    """
    body = md.split("\n", 1)[1]
    out = []
    for block in body.split("\n\n"):
        b = " ".join(ln.strip() for ln in block.strip().splitlines() if ln.strip())
        if not b or set(b) <= {"-"}:            # horizontal rules
            continue
        if b.startswith("#"):
            # A heading is not indented and keeps a blank line above it, so the
            # sections are still findable in a wall of indented prose.
            out.append("\n" + b.lstrip("# ").strip())
        else:
            out.append(INDENT + b)
    return title + "\n" + "\n".join(out) + "\n"


def write_plain() -> None:
    for src, dst in PLAIN.items():
        title = src.stem.replace("-", " ").upper()
        dst.write_text(plain(src.read_text(), title))
        print(f"wrote {dst.relative_to(FIGS.parent)}")


def panel_script(letter: str, slug: str, fig_no: int) -> Path | None:
    """The script whose `save()` claims this (letter, slug).

    Assemble's own rule is the literal substring `"letter", "slug"`, which misses any
    save() whose slug is an expression -- `save(fig, 3, "c", "quality_shipped" if
    as_shipped else "quality")` and Fig 7's `save(fig, 7, "b", slug("survival",
    variant, corrected))` both produced false MISSING rows here. The fallback regex
    accepts any save() call carrying this figure number and letter whose argument
    list contains the slug as a string literal.
    """
    lit = f'"{letter}", "{slug}"'
    pat = re.compile(
        rf'save\(\s*[^,()]+,\s*{fig_no}\s*,\s*"{letter}"\s*,[^)]*?"{slug}"')
    for src in sorted(PANELS.glob(f"fig{fig_no}_*.py")):
        t = src.read_text()
        if lit in t or pat.search(t):
            return src
    return None


def facts(src: Path) -> dict:
    t = src.read_text()
    m = re.match(r"fig(\d+)_", src.name)
    fig_no = int(m.group(1)) if m else 0
    doc = re.search(r'"""(.*?)"""', t, re.S)
    doc = doc.group(1).strip() if doc else ""
    lines = [ln.strip() for ln in doc.splitlines() if ln.strip()]
    # The one-line purpose is the first line, minus the "Fig 5g -- " prefix.
    purpose = re.sub(r"^Fig\s+\S+\s*--\s*", "", lines[0]) if lines else ""
    if purpose and not purpose.endswith("."):
        purpose += "."
    # Inputs: every JSON the script actually opens, however it names it. Three
    # spellings are in use -- `load("x.json")`, `OUT / "x.json"`, and a bare
    # `figs/out/x.json` in the docstring's Source: block -- and a map that only
    # caught one of them silently reported "no input" for a panel that has one.
    inputs = sorted(set(re.findall(r"figs/out/([A-Za-z0-9_.\-]+\.json)", doc)
                        + re.findall(r'load\(\s*"([^"]+\.json)"', t)
                        + re.findall(r'OUT\s*/\s*"([^"]+\.json)"', t)))
    # Image panels that read a rendered/exported image directly rather than a
    # figs/out JSON (Fig 1a's Blender render). Named in the docstring's Source
    # line; kept separate from `inputs` so render() does not prefix them `out/`.
    images = sorted(set(re.findall(
        r"blender-images/renders/[A-Za-z0-9_.\-/]+\.png", doc)))
    # `deposit(df, N, "name.csv")` where df is often a call with its own commas and
    # the name is often a conditional expression, so: take every string literal
    # ending .csv inside each deposit() call (both branches of a conditional), then
    # keep only the names whose deposited file actually exists under data/figN/.
    # The existence filter is what drops retired variants -- fig2c's `--cdf` path
    # still names `fig2c_reprojection_accuracy.csv`, a file no longer deposited,
    # and listing it here pointed the provenance at a dead table.
    # Fig 7's corrected panels build the name as f"{slug('fig7b_survival', ...)}.csv"
    # -- a single-quoted stem inside the call -- so stems are candidates too, with
    # ".csv" appended; the existence filter keeps only the ones actually deposited.
    dep_re = re.compile(r'deposit\(((?:[^()\'"]|\([^()]*\)|"[^"]*"|\'[^\']*\')*)\)',
                        re.S)
    names = set()
    for args in dep_re.findall(t):
        names.update(re.findall(r'"([^"]+\.csv)"', args))
        names.update(f"{stem}.csv"
                     for stem in re.findall(r"'([A-Za-z0-9_\-]+)'", args))
    csvs = sorted({f"data/fig{fig_no}/{name}" for name in names
                   if (FIGS / "data" / f"fig{fig_no}" / name).exists()})
    return {"purpose": purpose, "inputs": inputs, "images": images, "csvs": csvs}


def render() -> str:
    out = ["# Panel sources",
           "",
           "Every panel on the artwork, the script that draws it, the measurement it "
           "reads, and the plot-ready table it writes. Generated by "
           "`figs/make_docs.py` from `assemble.LAYOUTS` and the panel scripts "
           "themselves — do not edit by hand.",
           "",
           "Build order for any figure is: run the measurement pass (column "
           "*measured by*) → run the panel script (column *drawn by*) → "
           "`python3 figs/assemble.py N`. `python3 figs/make_figures.py` does the "
           "last two for every figure; the measurement passes are run by hand "
           "because they need the corpora and take minutes to hours.",
           ""]
    # Fig 11 owns no panel scripts: fig11_sync.py copies fig7/fig10 panel PDFs at a
    # reduced vector scale, and its MAPPING is the letter table. Resolve each fig11
    # letter through it so the row points at the real source panel instead of
    # reporting 13 false MISSING rows.
    import fig11_sync as F11
    sync_map = {ltr: (sf, sl, slug) for ltr, sf, sl, slug, _ in F11.MAPPING}
    placed = set()
    for fig_no in sorted(A.LAYOUTS):
        out.append(f"## Figure {fig_no}")
        out.append("")
        if fig_no == 11:
            out.append("Combined view of Figs 7 + 10: every panel is a source panel "
                       "PDF copied at reduced vector scale by `figs/fig11_sync.py` "
                       "(no panel scripts of its own; re-run the sync after any "
                       "fig7/fig10 panel regenerates).")
            out.append("")
        out.append("| Panel | Title | Drawn by | Reads | Measured by | Deposits |")
        out.append("|---|---|---|---|---|---|")
        for row in A.LAYOUTS[fig_no]:
            for letter, slug in row:
                src_fig, src_letter = fig_no, letter
                via = ""
                if fig_no == 11 and letter in sync_map:
                    src_fig, src_letter, _ = sync_map[letter]
                    via = (f" (fig{src_fig}{src_letter}, via "
                           f"`figs/fig11_sync.py`)")
                src = panel_script(src_letter, slug, src_fig)
                if src is None:
                    out.append(f"| **{letter}** | — | **MISSING** | | | |")
                    continue
                placed.add(src.name)
                f = facts(src)
                title = A.TITLES.get((fig_no, letter), "")
                producers = sorted({PRODUCERS.get(i, "—")
                                    for i in f["inputs"] + f["images"]})
                ins = ", ".join([f"`out/{i}`" for i in f["inputs"]]
                                + [f"`{i}`" for i in f["images"]]) or "— (drawn)"
                prod = ", ".join(f"`{p}`" for p in producers if p != "—") or "—"
                dep = ", ".join(f"`{c}`" for c in f["csvs"]) or "—"
                out.append(f"| **{letter}** | {title} | `panels/{src.name}`{via} | "
                           f"{ins} | {prod} | {dep} |")
        out.append("")
    unplaced = [p for p in sorted(PANELS.glob("fig*.py")) if p.name not in placed]
    if unplaced:
        out += ["## Panel scripts kept but not placed", "",
                "These still run under `make_figures.py` and still deposit their "
                "CSVs; they are not on any figure. They are kept because the "
                "measurement behind them is cited in the legends or the methods, or "
                "because they were superseded rather than refuted.", "",
                "| Script | What it draws |", "|---|---|"]
        for p in unplaced:
            out.append(f"| `panels/{p.name}` | {facts(p)['purpose']} |")
        out.append("")
    return "\n".join(out) + "\n"


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--check", action="store_true")
    ap.add_argument("--sources-only", action="store_true",
                    help="write PANEL-SOURCES.md only; do not regenerate the "
                         ".txt twins of the hand-written documents")
    args = ap.parse_args()
    text = render()
    if args.check:
        cur = OUT.read_text() if OUT.exists() else ""
        if cur != text:
            print(f"{OUT.name} is out of date — run python3 figs/make_docs.py")
            raise SystemExit(1)
        print(f"{OUT.name} is up to date")
        return
    OUT.write_text(text)
    print(f"wrote {OUT.relative_to(FIGS.parent)}")
    if not args.sources_only:
        write_plain()


if __name__ == "__main__":
    main()
