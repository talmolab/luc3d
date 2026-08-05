"""
Loading the measurement JSON and turning it into plot-ready tables.

The reference repo's idiom, which this reproduces: the *expensive* pass (a
Playwright run over the real app, or a 4-million-keypoint sweep over the BMimica
corpus) deposits its result once; the *plotting* pass reads a small committed table
back and draws. In `figures-mimic-mjx` that deposit is `df.to_csv("../data/figN/...")`
followed by `df = pd.read_csv(csv_fp)` in the next cell.

Here the deposit already exists as `figs/out/*.json`, written by the measurement
scripts (`fig4_measure.mjs`, `fig2_measure.py`, ...). Those JSON files are large,
nested and gitignored. What this module adds is the second half of the idiom: each
panel script reduces the JSON to the handful of rows it actually plots and deposits
that as `figs/data/figN/*.csv`, which IS committed.

Two things follow, and both are the point:

* A panel can be redrawn -- restyled, resized, recoloured -- without re-running a
  measurement that needs the bench environment and the raw corpus.
* Every number on the artwork is auditable against a small CSV in the repo, instead
  of living only inside a 950 kB JSON on one machine.

`out/` remains the source of truth. `data/` is derived and regenerable, but it is
committed so the figures are buildable from a fresh clone.
"""

from __future__ import annotations

import json
import sys
from pathlib import Path

FIGS = Path(__file__).resolve().parent.parent
OUT = FIGS / "out"


def load(name: str) -> dict:
    """Read `figs/out/<name>`, or explain what to run if it is missing."""
    p = OUT / name
    if not p.exists():
        sys.exit(
            f"missing figs/out/{name}\n"
            f"  The measurement pass has not been run, or was run elsewhere.\n"
            f"  See figs/README.md -> Pipeline for the command that writes it."
        )
    with p.open() as f:
        return json.load(f)


def have(name: str) -> bool:
    """True if a measurement file is present, for panels that are optional."""
    return (OUT / name).exists()


def pct(d: dict, key: str = "p50") -> float:
    """Pull a percentile out of the summary dicts the measurement scripts emit.

    Those dicts are uniformly `{n, mean, p5, p25, p50, p75, p90, p95, p99}`.
    """
    return d[key]


def median(xs):
    """Median without importing statistics at every call site."""
    xs = sorted(xs)
    n = len(xs)
    if not n:
        raise ValueError("median of an empty sequence")
    m = n // 2
    return xs[m] if n % 2 else 0.5 * (xs[m - 1] + xs[m])
