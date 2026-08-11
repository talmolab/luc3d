"""
The tool-comparison table, and what every cell rests on.

THIS IS THE SINGLE SOURCE OF TRUTH for the comparison. It lived inline in
`fig1.py`; it is here so the figure generator and the caption cannot drift apart,
which they already had once.

EVERY NON-LUC3D CELL DESCRIBES SOMEONE ELSE'S SOFTWARE FROM ITS PUBLISHED DOCS.
Re-verify against current docs and move `CHECK_DATE` before submission --
`NEEDS_CHECK` prints a warning onto the artwork until you do.

Cells are deliberately CONSERVATIVE: an unsupported "yes" and an unsupported "no"
are both over-claims. Where a tool does a weaker version of a thing, the cell says
which weaker version rather than collapsing to True/False.

A DASH MEANS "NOT A DOCUMENTED FEATURE", not "impossible". Several tools previously
carried the string "1 animal" in the Multi-animal column; that read as a positive
claim about a capability their docs do not describe, so it is now a dash like any
other absent feature.

  SLEAP        multi-camera 3D is real but lives OUTSIDE the GUI, in sleap-io's
               RecordingSession/FrameGroup/InstanceGroup (the SLP 2.8
               /session_data LUC3D itself writes) plus sleap-anipose. There is no
               3D viewport, so proofreading is 2D.
               CROSS-VIEW ID IS "-", NOT A CITATION. An earlier version of this
               table put "Maree et al. 2024" in that cell. That is wrong for a
               capability table: Maree, Afshar, Oline, Leonardis, Falkner & Pereira
               (2024), Measuring Behavior 217-224 is a METHOD PAPER, not a feature
               a SLEAP user can turn on -- the exhaustive multi-view association it
               describes is not shipped in the SLEAP GUI. Naming it in the cell read
               as "SLEAP has this", which over-claims on someone else's behalf. The
               citation still belongs in the Fig 3 caption and in fig3a's
               docstring, where it is credited as the method LUC3D's greedy solve is
               compared against and as the source of the greedy idea itself.
  DANNCE       multi-animal is a checkmark: SDANNCE (Social DANNCE) is the project's
               own multi-animal model and ships in the same repository, so the row
               -- which is titled "DANNCE / SDANNCE" -- does support multiple
               animals. An earlier version put the string "SDANNCE" in the cell,
               which is a hedge the naming of the row already covers.
  Label3D      README: "GUI for the manual labeling of 3D keypoints in multiple
               cameras", "supports multiview triangulation of 3D keypoints". Its
               API takes ONE skeleton struct and multi-animal labelling is not a
               documented feature -- so "1 animal", not a checkmark. This is the
               direct predecessor for reprojection-aided multi-camera 3D labelling
               and must be cited.
  JARVIS       AnnotationTool "leverages the multi camera recordings by projecting
               your manual annotations on a subset of those cameras to the
               remaining ones" and shows a reprojection error bar -- i.e. exactly
               the Fig 2a protocol, which is therefore NOT novel here; the browser
               implementation and the quantification are. No 3D viewport is
               documented, and simultaneous multi-subject capture is not documented
               either.
  DeepLabCut   CORRECTED 2026-08-05. The cell used to read "1 animal, pairwise";
               the multi-animal half was wrong. `docs/Overviewof3D` states "We also
               support multi-animal 3D with this code" and that "single animal
               DeepLabCut and multi-animal DeepLabCut (maDLC) projects are
               supported", so multi-animal is a tick and the 3D cell no longer says
               "1 animal". What IS still true is the pair limit: "Currently,
               DeepLabCut supports triangulation using 2 cameras, but will expand to
               more than 2 cameras in a future version", and the docs point users at
               anipose or AcinoSet beyond two. Hence "pairwise" -- a real restriction
               for a rig of five or eight cameras, and the reason it is not a plain
               tick.
  Anipose      single-animal pipeline, CLI-driven.
  DANNCE       both DANNCE and SDANNCE infer 3D directly from image volumes, so
               there is no per-view 2D track set to associate -- the "-" in
               Cross-view ID means "does not arise", and the caption says so rather
               than letting it read as a deficiency.
  LightningPose
               Biderman, Whiteway et al., "Lightning Pose: improved animal pose
               estimation via semi-supervised learning, Bayesian ensembling and
               cloud-native open-source tools", Nat Methods 21, 1316-1328 (2024).
               Two cells need care and BOTH are hedged deliberately:
               * Multi-animal -- the docs describe "single-animal pose estimation"
                 and multi-animal is not a documented feature, so a dash.
               * 3D proofreading -- a dash. The "Unified Multi-view Viewer" inspects
                 and compares predictions across all camera views, but that is 2D per
                 view; no 3D viewport and no 3D correction is documented. Checked
                 2026-08-05.
               * Multi-camera 3D -- the multi-view support is documented as
                 "Multiview: mirrored or fused frames" / "separate data streams"
                 with multi-view consistency and triangulation LOSSES and
                 Multi-View Transformers. That is multi-view TRAINING, not a
                 calibrated pipeline emitting 3D coordinates, and no calibration
                 format is documented. So the cell reads "multi-view losses", not
                 a checkmark -- ticking it would over-claim, and a bare False would
                 under-claim a genuinely multi-view method.
               It IS the other browser-based tool in this table (`litpose run_app`
               serves a browser GUI covering annotation through diagnostics), which
               is why "runs in" matters here and is not simply "CLI".
"""

#: The "re-verify before submission" banner is no longer PRINTED on the artwork --
#: it is a working note, not figure content, and a publication figure should not
#: carry one. The date it records is still load-bearing and is reported in
#: figs/METHODS.md and figs/FIGURE-LEGENDS.md instead. Set NEEDS_CHECK back to True
#: to put the banner on the panel while auditing the cells.
NEEDS_CHECK = False
CHECK_DATE = "2026-08-05"

#: "No installation" and "Browser-based" replace the old free-text "Install" and
#: "Runs in" columns. They ask the two questions a reader actually has -- can I use
#: this without installing anything, and does it run in a browser -- as booleans that
#: can be scanned down a column, instead of strings ("conda/pip", "desktop",
#: "browser + CLI") that have to be read and compared one at a time. The two are NOT
#: the same question, which is the point: Lightning Pose serves a browser GUI but you
#: must pip-install it first, so it is a tick in one column and a dash in the other.
COLS = ["", "No installation", "Browser-based", "Multi-animal", "Multi-camera 3D",
        "Cross-view ID", "3D proofreading"]

#: name, no-install, browser-based, multi-animal, multi-cam 3D, cross-view ID,
#: 3D proofreading
TOOLS = [
    ("LUC3D (this work)",  True,  True,  True,  True,  True,  True),
    ("SLEAP",              False, False, True,  "sleap-anipose", False, "2D only"),
    ("Label3D",            False, False, False, True,  False, True),
    ("JARVIS (HybridNet)", False, False, False, True,  False, "reproj. error"),
    ("Lightning Pose",     False, True,  False, "multi-view losses", False, False),
    ("DeepLabCut",         False, False, True,  "pairwise", False, False),
    ("Anipose",            False, False, False, True,  False, False),
    ("DANNCE / SDANNCE",   False, False, True,  True,  False, False),
]
