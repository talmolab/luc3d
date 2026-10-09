"""SCORE_NOTAIL=1: build every scoring box WITHOUT tail keypoints (2026-10-08, Eric: "the
tail should not be counted for any of these numbers" / "no tail should be included in 4b,
3b, or 6b").

Every scorer in figs/ (fig3_score, fig3_quality, fig4_slap2m's misgroup pass,
fig6_slap2m_fair) builds its detection AND ground-truth boxes through
luc3d-bench evaluate.bbox_from_kpts, so wrapping that one function removes the tail from
IDF1, false positives, misses, switches and misgrouping everywhere at once. The trackers
already ignore the tail; this changes SCORING only, so no tracker is re-run.

SLAP-2M skeleton (15 nodes): TailTip 4, Tail_0 7, Tail_1 8, Tail_2 9. Mouse-Dyad-10M (BMimica)
uses the SAME 15-node order (checked from its .slp skeleton, 2026-10-08), so one index set
serves both corpora. Applied only to arrays
whose node axis is that skeleton's length. Unset = the scorer unchanged.
"""
import os

import numpy as np

SLAP2M_TAIL = (4, 7, 8, 9)
ACTIVE = os.environ.get("SCORE_NOTAIL") == "1"


def install(ev):
    if not ACTIVE or getattr(ev, "_score_notail", False):
        return
    orig = ev.bbox_from_kpts

    def bbox_from_kpts(kpts, *a, **kw):
        k = np.asarray(kpts, dtype=float)
        if k.ndim == 2 and k.shape[0] == 15:
            k = k.copy()
            k[list(SLAP2M_TAIL)] = np.nan
        return orig(k, *a, **kw)

    ev.bbox_from_kpts = bbox_from_kpts
    ev._score_notail = True


def install_fn(mod, name):
    """Wrap any other keypoints->box function the same way (e.g. ByteTrack's
    run_bytetrack_bench.bbox_from_keypoints, which builds its own boxes)."""
    if not ACTIVE or getattr(mod, f"_score_notail_{name}", False):
        return
    orig = getattr(mod, name)

    def wrapped(kpts, *a, **kw):
        k = np.asarray(kpts, dtype=float)
        if k.ndim == 2 and k.shape[0] == 15:
            k = k.copy()
            k[list(SLAP2M_TAIL)] = np.nan
        return orig(k, *a, **kw)

    setattr(mod, name, wrapped)
    setattr(mod, f"_score_notail_{name}", True)
