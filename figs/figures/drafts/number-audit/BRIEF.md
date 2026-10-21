# Number audit brief (READ-ONLY)

Repo: /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs  (branch eric/figs)
Manuscript: figs/figures/drafts/luc3d_newest.tex  (the captions there are the master legends)

Question from Eric: are the numbers in the tex correct, and do they reflect the data analysis that
generated the figures as they are now placed?

## Hard rules
- READ-ONLY. Do not edit the tex, any data, any figure, any script. Do not run any job that
  takes more than ~2 minutes or more than one core (another host may be running timing sittings;
  a stray CPU-heavy job invalidates them). Small python/pandas reads of CSV/JSON are fine.
- Write your report to the scratchpad file given in your task, and return a short summary.

## What is placed (as of commit a6752bc0, 2026-10-20)
- tex includes figs/fig1.pdf .. fig9.pdf. Main figure folders: figs/figures/fig{1..7}/, plotted
  data CSVs: figs/data/fig{1..7}/. fig2/fig3/fig6 were copied byte-for-byte from the "c" series
  (fig2c/fig3c/fig6c). data/fig3c/ is a leftover duplicate of data/fig3 — check they agree.
- Deposits (the analysis outputs the panels read) mostly live in figs/out/*.json. Build logs and
  variant link tables: figs/out/md56_logs/ (e.g. FIG2C_js_make_figures.log, *_loads.tsv).
  Panel scripts: figs/panels/*.py; orchestration figs/make_figures.py / assemble.py.
- Context docs (read what's relevant, don't trust blindly — verify against data):
  figs/figures/drafts/LUC3D-JS-CONSISTENCY-PLAN-2026-10-20.md (log at bottom),
  figs/figures/drafts/CONSISTENCY-PLAN-2026-10-19.md, FIGURES-REPORT-2026-10-20.md,
  PROVENANCE-INVESTIGATION-mimic2-2026-10-20.md, ADVERSARIAL-REVIEW-2026-10-20.md, MD56-NUMBER-MAP.md.
- Rules the paper is supposed to follow: every LUC3D number from LUC3D v1.0.5 JS (commit 2dc001fe);
  Mouse-Dyad-10M = 56 sessions, b3 pool (body>=5, tail IN tracking); SLAP-2M = bvis5, tail-free
  tracking; scoring tail-free; no ByteTrack dedupe; identical data across compared arms.
  Fig 3F timing should come from the J17 sitting (deposits fig3_*_clean_b3_j17*.json).
  Fig 2G timing from the watched 10-20 sitting (medians of 100 passes): DLT 0.885 us etc.
- The tex has an uncommitted diff (git diff) updating Fig 3F numbers (14x, 0.28, 0.70 ms) and the
  undistortion sentence. That is current intent.

## Method
1. Extract every quantitative claim in your assigned tex lines (numbers, counts, percentages,
   P values, Ns, "X of Y", ratios, ranges, "more than", "about"), including in captions.
2. For each, find the source: the plotted CSV in data/figN, else the deposit in out/ the panel
   reads (follow the panel script). Recompute where it's a derived quantity (ratio, %, median, test).
3. Verdict per claim: OK / WRONG (give correct value) / ROUNDING (borderline) / STALE (matches an
   older deposit, not the placed one) / UNVERIFIABLE (no source found — say what you searched) /
   MISMATCH-METHOD (number fine but text describes a different procedure/N/pool than the code used).
4. Also check that Ns, session counts, pools and procedures the text states match what the
   generator actually did, and that the placed PDF is built from the data you checked (timestamps,
   build logs).

## Report format (markdown)
Table: | tex line | claim (quoted, short) | source file:field | value found | verdict | note |
Then a short list "Problems, most important first". Be concrete; cite file paths.
