"""Shared vocabulary for Fig 7's panels, so they cannot disagree with each other.

WHAT THE FIGURE CLAIMS, stated here because it is narrower than the first draft assumed
and every panel has to stay inside it. It is NOT "calibrat3 is more accurate than
Anipose". Measured:

  * On the 18-camera rig calibrat3 is lower everywhere -- both scoring sets, all 18
    cameras, median 0.47 against 1.27 px and p95 1.17 against 4.92.
  * On the 8-camera rig THE CURVES CROSS. Anipose has the better median on its own
    corners (0.31 against 0.42 px) and is lower in 5 of 8 cameras, while calibrat3 is
    ~5x tighter at p95 (0.91 against 5.06) and ~10x at p99 (2.67 against 25.3).
  * The MEDIAN ranking depends on whose corners the score is read on; the TAIL does
    not. Panel g draws that.

So the claim the figure supports is about the SHAPE of the error distribution --
calibrat3 produces far fewer badly-fit observations -- plus a clear win on the harder
rig. Any panel or caption that says "more accurate" without qualification is overstating
what was measured.

WHAT THE FIGURE COMPARES. Two camera rigs, calibrated end to end by two tools, with
every resulting calibration scored by a THIRD party: aniposelib's own triangulation
and reprojection, on detections neither calibration was fitted to choose. calibrat3's
in-app numbers appear nowhere on this figure -- the app's own metric is what a bug in
the app would corrupt first, and the benchmark exists to be independent of it.

THE THIRD ARM IS NOT A THIRD TOOL. `anipose_on_ours` is aniposelib's own
`calibrate_rows` handed calibrat3's corners. It splits the end-to-end comparison into
its two halves: if calibrat3 wins because it detects more/better corners, this arm
moves with calibrat3; if it wins because it solves better, this arm stays with
Anipose. It therefore wears Anipose's GREEN -- it is that library's solver -- and is
distinguished by a DASH (curves) or an OPEN BOX (boxes), which is the convention
`fig2_15_per_session.py` established for one library in two configurations.
"""
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))
from src.style import entity  # noqa: E402

C3, ANI = entity("calibrat3"), entity("anipose")

#: arm key -> (printed name, colour, filled?). ORDER IS THE DRAWING ORDER.
#: The dash prefix on the third entry is LOAD-BEARING, not decoration: two of the
#: three arms are the same library and therefore the same hue, so the key has to
#: carry the stroke that tells them apart. Without it a reader sees two green names
#: and two green curves and cannot pair them.
ARMS = [
    ("calibrat3", "calibrat3", C3, True),
    ("anipose", "Anipose", ANI, True),
    ("anipose_on_ours", "– – Anipose solver, calibrat3 corners", ANI, False),
]
ARM_COLOR = {k: c for k, _, c, _ in ARMS}
ARM_LABEL = {k: n for k, n, _, _ in ARMS}
ARM_FILLED = {k: f for k, _, _, f in ARMS}

#: dataset key -> (printed name, number of cameras). The printed names say the rig
#: size because that is the variable the two sessions differ in that a reader cares
#: about; the internal keys stay as the measurement wrote them.
DATASETS = [("slap8", "8-camera rig", 8), ("calib18", "18-camera rig", 18)]
DS_LABEL = {k: n for k, n, _ in DATASETS}

#: THE SCORING SET DRAWN ON THE MAIN PANELS. Anipose's OWN detections, deliberately:
#: scoring on calibrat3's corners would let a reader ask whether calibrat3 simply
#: reported the points it happened to fit well. Panel g shows the other scoring set
#: and that the ranking does not move.
MAIN_DETSET = "anipose"

#: calibrat3's headline arm: the app's default sampling, not the all-frames arm.
#: Panel f is the one that shows they agree; everywhere else the DEFAULT is what is
#: being benchmarked, because that is what a user gets.
MAIN_C3 = "calibrat3_800"
