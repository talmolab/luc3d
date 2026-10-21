# Handoff: number audit of luc3d_newest.tex, 2026-10-20

**DONE 2026-10-20.** All five audits finished and `NUMBER-AUDIT-2026-10-20.md` is written, with an addendum from the last audit. Nothing to resume.

Paste this file's path into a new Claude Code session running inside `screen`:

```
screen -S lucid
cd /root/vast/eric/sleap-3d-gui/scratch/repos/lucid/figs
claude
> Read figs/figures/drafts/HANDOFF-number-audit-2026-10-20.md and do it.
```

Detach with `Ctrl-a d`. Reattach with `screen -r lucid`.

## The task

Eric asked: are the numbers in `figs/figures/drafts/luc3d_newest.tex` correct? Do they match the data analysis behind the figures as they are placed now?

The deliverable is one markdown report at `figs/figures/drafts/NUMBER-AUDIT-2026-10-20.md`, which is a placeholder for now. Overwrite it. It has two parts:

1. One table per section with the columns: tex line, claim, source file:field, value found, verdict, note.
2. A list headed "Problems, most important first".

Spot-check the main findings yourself before writing the report. Don't pass on an agent's claim without checking it.

**Read-only.** Do not edit the tex, the data, the figures or the scripts. Report what is wrong. Eric decides the fixes. Do not run any job longer than about 2 minutes or using more than one core, because timing sittings may be running on other hosts.

## The method

The rules, the data layout and the verdict codes are in `figs/figures/drafts/number-audit/BRIEF.md`. Read it first. Hand it to every agent.

The previous session split the tex into five audits that ran in parallel:

| Report file | Scope (tex lines) |
|---|---|
| `A_fig1_fig2.md` | 1-138 (abstract, introduction, subsections 2-1 and 2-2, Fig 1 and Fig 2 captions), Methods Software 234-236, Triangulation 295-305, plus any repeat of a Fig 1 or Fig 2 number elsewhere. The abstract's in-app speeds (16,030, 14,694 and 7,035 fps) are Eric's own M1 measurements with no deposit. Check only that they are consistent where they repeat |
| `B_fig3.md` | 140-160 (subsection 2-3 and the Fig 3 caption), association 273-293, tracking metrics 327-331, statistics 349-351, plus repeats in 90-210. Fig 3F must come from the J17 timing (`out/fig3_*_clean_b3_j17*.json`). Check `data/fig3/fig3e_head_to_head.csv` against those deposits |
| `C_fig4_fig5.md` | 162-192 (subsections 2-6 and 2-5, Fig 4 and Fig 5 captions), detection pool 265-271, occlusion 307-309, behaviour 311-325, rearing controls 401-403 and any rearing table or figure after line 480, plus repeats in 90-210 |
| `D_supp6.md` | 405-427 (per-camera trackers, staleness, s-DANNCE), the Supp Fig 6 caption (about 483-489), baselines 333-339, anchor 341-347, plus repeats in 90-210. Check that the Methods defaults match the v1.0.5 code at `/root/vast/eric/lucid-main-md56/pose/*.js` (read-only). Known issue: the placed Supp 6G may come from the pre-v1.0.5 s-DANNCE run (`fig10-bench/results/agg`) rather than `results_v105/agg` |
| `E_datasets_calib_discussion.md` | Discussion 194-210, GUI 214-232, datasets 238-247, ethics and acquisition 249-256, calibration 258-263, calibration bench 429-435, pose models 437-441, calibration vs Anipose 443-453, Panopticon 455-467, the Fig 8 and Fig 9 captions, the datasheet and everything after line 490. Known open items to confirm or refute: "100.8 million 2D poses" are reprojections, the datasheet copy may be stale (Aug 18 vs Oct 1), the calibration bench may not be reproducible |

## Where the partial results are

Look for the most complete copy of each report in two places:

- `/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-lucid/9f0c26fc-aeea-48bd-8b8e-a9bd8ecaabb2/scratchpad/audit/`, where the previous session's agents wrote as they went, possibly up to the disconnect
- `figs/figures/drafts/number-audit/`, a snapshot copied at handoff time (about 20:50 UTC). Audit E had not written anything yet

Copy the newer version of each file into `figs/figures/drafts/number-audit/` so the work lives in the repo. Then, for each audit:

- If the report ends with a "Problems" list, treat it as finished.
- If it doesn't, start one agent with `BRIEF.md` plus that row's scope. Tell the agent to continue from the rows already in the file rather than redo them, to write to that file, and to append rows as it goes, at least every 10 claims.

Run the unfinished audits in parallel as background general-purpose agents.

## Context already established (don't re-derive)

- Placed figures as of commit `a6752bc0`. The tex includes `figs/fig1.pdf` to `fig9.pdf`. Figs 2, 3 and 6 are byte copies of the c series. Plotted CSVs are in `figs/data/fig{1..7}`. `data/fig3c/` is a leftover duplicate of `data/fig3`.
- The tex has an uncommitted diff that is current intent: Fig 3F is now 14x, 0.28 ms and 0.70 ms, and the undistortion sentence now gives 1.7 µs for LUC3D and about 0.4 µs for aniposelib.
- Background docs: `LUC3D-JS-CONSISTENCY-PLAN-2026-10-20.md` (log at the bottom), `FIGURES-REPORT-2026-10-20.md`, `PROVENANCE-INVESTIGATION-mimic2-2026-10-20.md`, `CONSISTENCY-PLAN-2026-10-19.md`, `MD56-NUMBER-MAP.md`. Use them as leads, not as truth. Verify against the data.
