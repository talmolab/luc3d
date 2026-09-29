#!/usr/bin/env python3
"""
Robustness of the Figure 4 results to the six Mouse-Dyad-10M sessions outside the tracking benchmarks.

All 56 sessions are proofread. The tracking benchmarks (Figures 3 and 6) run on the 50 sessions that
were in the corpus when they were run. The six sessions recorded on 2025-09-08 were skipped at the
200-frame stride for too little cross-camera overlap and joined the corpus once Figure 2 moved to every
frame (commit f1bfe3e). The behavioral analysis uses all 56. Because the manuscript once described the
50 as "the 50 proofread sessions", a reader could infer the other six were not, so this script repeats
every statistic in the social rearing Results on the 50 alone, on the six alone, and on all 56, and
deposits the three side by side (data/fig4/fig4s_benchmark50_subset.csv). The 50 are read from
data/fig2/fig2f_per_session.csv, the list every tracking figure uses.

    python3 figs/fig4_benchmark_subset.py
"""
import json
import re
import sys
from pathlib import Path

import numpy as np
import pandas as pd
from scipy import stats

sys.path.insert(0, str(Path(__file__).resolve().parent))
from src.style import deposit  # noqa: E402

FIGS = Path(__file__).resolve().parent


def stats_for(ev, label):
    known = ev.initiator_track.notna().sum()
    fl = int((ev.initiator_track == 1).sum())
    g = ev.groupby("session").agg(n=("initiator_track", "size"),
                                  f=("initiator_track", lambda x: (x == 1).sum()),
                                  m=("initiator_track", lambda x: (x == 0).sum()))
    b = g[g.n >= 6]
    pp = ev.groupby("pair").agg(n=("initiator_track", "size"),
                                f=("initiator_track", lambda x: (x == 1).sum()),
                                m=("initiator_track", lambda x: (x == 0).sum()))
    p5 = pp[pp.n >= 5]
    row = {"subset": label, "sessions": ev.session.nunique(), "displays": len(ev),
           "female_led": fl, "with_initiator": int(known), "female_led_pct": 100 * fl / known,
           "sessions_female_leads": int((g.f > g.m).sum()), "sessions_tie": int((g.f == g.m).sum()),
           "sessions_ge6": len(b), "female_share_median_ge6": float((b.f / b.n).median()),
           "share_wilcoxon_p": float(stats.wilcoxon(b.f / b.n - b.m / b.n).pvalue) if len(b) >= 5 else np.nan,
           "pairs_ge5": len(p5), "pairs_female_leads": int((p5.f > p5.m).sum())}
    for cm, cf, name, sign in (("speed_bl_s_t0", "speed_bl_s_t1", "speed", 1),
                               ("pursuit_rel_t0", "pursuit_rel_t1", "pursuit", -1)):
        e = ev[np.isfinite(ev[cm]) & np.isfinite(ev[cf])]
        s = e.groupby("session").agg(m=(cm, "median"), f=(cf, "median"))
        d = s.m - s.f
        row[f"{name}_sessions"] = len(s)
        row[f"{name}_male_favoured"] = int((sign * d > 0).sum())
        row[f"{name}_wilcoxon_p"] = float(stats.wilcoxon(d).pvalue) if len(s) >= 5 else np.nan
        row[f"{name}_male_median"] = float(s.m.median())
        row[f"{name}_female_median"] = float(s.f.median())
    return row


def main():
    d = json.load(open(FIGS / "out/fig5_upright.json"))
    ev = pd.DataFrame(d["events"])
    ids = {r["session"]: (r["per_track"][0]["animal"], r["per_track"][1]["animal"]) for r in d["per_session"]}
    ev["pair"] = ev.session.map(lambda s: ids[s][0] + "|" + ids[s][1])
    p50 = set(re.findall(r"20\d{6}_\d{6}", open(FIGS / "data/fig2/fig2f_per_session.csv").read()))
    unproofread = sorted({s for s in ev.session.unique() if s not in p50})
    print("sessions outside the 50 with displays:", unproofread)
    rows = [stats_for(ev, "all_56"),
            stats_for(ev[ev.session.isin(p50)], "benchmark_50"),
            stats_for(ev[~ev.session.isin(p50)], "outside_50_only")]
    df = pd.DataFrame(rows)
    deposit(df, 4, "fig4s_benchmark50_subset.csv")
    with pd.option_context("display.width", 250, "display.max_columns", 40):
        print(df.set_index("subset").T)


if __name__ == "__main__":
    main()
