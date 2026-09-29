#!/usr/bin/env python3
"""
The four controls on the leader-follower asymmetry in Figure 4 (Results, "A series of
control tests"), reproduced from the event pipeline so that every number in that
paragraph has a script and a deposit behind it.

  1. Rearing base rate. Is the female the leader only because she rears more? Each
     session's fraction of female-initiated displays is correlated with the female's
     fraction of the pair's total rearing time (per_track[].rear_frac).
  2. Height threshold. The published rule is neck above 0.75 of each animal's own body
     length. The detector is re-run with (a) an absolute 60 mm neck height for both
     animals and (b) the 0.75 fraction applied to the pair's mean body length, and the
     session leader is compared with the published one.
  3. Body size. Male and female body length (median nose to tail base) are compared
     across sessions, the leader is tested for being the shorter animal, and the
     sessions in which the female is the longer animal are checked separately.

The controls run over the sessions with at least five displays under the published
detector (24), as the text states. The tie rule of 2026-09-20 applies throughout: a
display whose two bouts begin on the same frame has no initiator.

Deposits data/fig4/fig4s_controls.csv (one row per session, three detector settings)
and prints the summary the text quotes.

    .venv/bin/python figs/fig4_controls.py
"""
import glob
import os
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
import fig4_upright as U  # noqa: E402
from src.style import deposit  # noqa: E402

MIN_DISPLAYS = 5


def _init(mode):
    U.REAR_MODE = mode


def one(sd):
    ld = U._load(sd)
    if ld is None:
        return None
    r = U.session_upright(*ld, os.path.basename(sd))
    if r is None:
        return None
    m, f = r["per_track"]
    return {"session": r["session"], "n": r["n_events"], "male_lead": m["n_lead"],
            "female_lead": f["n_lead"], "male_rear_frac": m["rear_frac"],
            "female_rear_frac": f["rear_frac"], "L_male_mm": m["L_mm"],
            "L_female_mm": f["L_mm"]}


def run(mode):
    sds = [d for d in sorted(glob.glob(f"{U.BMIMICA}/*")) if os.path.isdir(d)]
    with ProcessPoolExecutor(max_workers=14, initializer=_init, initargs=(mode,)) as ex:
        rows = [r for r in ex.map(one, sds) if r]
    df = pd.DataFrame(rows)
    df["mode"] = mode or "per_animal"
    df["leader"] = np.select([df.female_lead > df.male_lead, df.male_lead > df.female_lead],
                             ["female", "male"], "tie")
    return df


def main():
    base = run(None)
    ab = run("abs")
    sh = run("shared")
    big = base[base.n >= MIN_DISPLAYS].copy()
    print(f"sessions with >= {MIN_DISPLAYS} displays under the published detector: {len(big)}")

    # 1. base rate
    fshare = big.female_lead / (big.female_lead + big.male_lead)
    frear = big.female_rear_frac / (big.female_rear_frac + big.male_rear_frac)
    r, p = stats.pearsonr(fshare, frear)
    print(f"1. female initiation share vs female share of rearing time: r = {r:.3f}, P = {p:.2f}, n = {len(big)}")

    # 2. thresholds
    def agree(alt, label):
        a = alt.set_index("session").loc[big.session]
        fem = int((a.leader == "female").sum())
        same = int((a.leader.values == big.leader.values).sum())
        print(f"2. {label}: female leader in {fem} of {len(big)}, same leader as published in {same} of {len(big)} "
              f"(displays under this rule: {int(a.n.sum())})")
    agree(ab, f"absolute {U.REAR_ABS_MM:.0f} mm neck height")
    agree(sh, "shared 0.75 x pair mean body length")

    # 3. body size
    allb = base[base.n >= 1]
    longer = int((allb.L_male_mm > allb.L_female_mm).sum())
    w = stats.wilcoxon(allb.L_male_mm - allb.L_female_mm).pvalue
    print(f"3. body length: male median {allb.L_male_mm.median():.1f} mm, female {allb.L_female_mm.median():.1f}; "
          f"male longer in {longer} of {len(allb)} sessions (paired Wilcoxon P = {w:.1e})")
    uniq = allb[allb.leader != "tie"]
    shorter = ((uniq.leader == "female") & (uniq.L_female_mm < uniq.L_male_mm)) | \
              ((uniq.leader == "male") & (uniq.L_male_mm < uniq.L_female_mm))
    print(f"   leader is the shorter animal in {int(shorter.sum())} of {len(uniq)} sessions with a unique leader "
          f"(sign test P = {stats.binomtest(int(shorter.sum()), len(uniq)).pvalue:.4f})")
    fl = allb[allb.L_female_mm > allb.L_male_mm]
    k, n = int(fl.female_lead.sum()), int(fl.female_lead.sum() + fl.male_lead.sum())
    print(f"   sessions where the female is longer: {len(fl)}; she starts {k} of {n} displays with a known initiator "
          f"({100 * k / n:.0f}%, binomial P = {stats.binomtest(k, n).pvalue:.1e})")

    deposit(pd.concat([base, ab, sh], ignore_index=True), 4, "fig4s_controls.csv")


if __name__ == "__main__":
    main()
