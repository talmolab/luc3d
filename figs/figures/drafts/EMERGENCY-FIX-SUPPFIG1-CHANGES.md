# Emergency fix: text changes for the new Supplementary Figure 1

**Date:** 2026-09-29 · **File edited:** `figs/figures/drafts/luc3d_newest.tex` (your 01:11 paste)  
**Backup of your paste before these edits:** `/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-lucid/56270fd5-7331-4e73-b7e1-e280a95df8ae/scratchpad/luc3d_newest.before_emergency.tex`  
**Scope:** only sentences the new figure made false. Exactly 6 lines changed and nothing else was touched (`git diff --no-index --stat`: 6 insertions, 6 deletions). The Supplementary Figure 1 caption is unchanged. Braces and `$` are balanced on every changed line. There is no LaTeX compiler on this machine, so the file has not been test-compiled.

---

## What changed in the figure

Supplementary Figure 1 (`\label{fig6}`, `figs/figures/fig6/fig6.pdf`) panels **B, C and D** were rebuilt from the fair SLAP-2M re-run (74 sessions × 6 cameras):

| | Before | Now |
|---|---|---|
| Detection pool | `predictions_h5s`, truncated to 4 slots (64% of detections kept) | `keeptrack_h5s`, the same filtered pool for all three trackers |
| SLEAP | its inference-time tracks, no track cap | sleap-nn 0.2.0 re-run with the pool's filters, capped at the session's animal count (1–4), verified ≤ N tracks on 444/444 |
| ByteTrack | retires a lost track after 60 frames | never retires, then stitched (no ground truth) to the animal count |
| LUC3D | shipped tracker (stale 20, distThresh 25, synchronous) | unchanged, and re-scores to the manuscript deposit exactly (max diff 0 over 444 camera-sessions) |

Panels **A, E and F are unchanged.** Source: `figs/out/fig6_slap2m_fair.json`, produced by `figs/fig6_slap2m_fair.py`.

### The numbers the text now uses

| Quantity (within-view IDF1, 74 SLAP-2M sessions) | Before | Now |
|---|---|---|
| Means, LUC3D / SLEAP / ByteTrack | not stated | 0.899 / 0.872 / 0.838 |
| LUC3D − SLEAP, all 74 sessions | +0.099, higher in 56 of 74, P = 1.1×10⁻⁵ | +0.026 (95% CI 0.009–0.044), higher in 26, lower in 39, tied in 9, P = 0.14 |
| ≥ 2 animals (42 sessions) | +0.067, 31 of 42, P = 0.003 | +0.047, 26 of 42, P = 0.16 |
| 1 animal (32 sessions) | the largest gap | median 0.000, within 0.002 in 31 of 32 |
| 3 and 4 animals (7 sessions) | SLEAP ahead in all 7 (−0.039, −0.028) | **LUC3D ahead in all 7** (+0.101, +0.115), P = 0.016 |

P values are exact two-sided sign tests **excluding ties**. The old convention counted the 9 exactly tied single-animal sessions as losses, which would have printed a spurious P = 0.014 in SLEAP's favour.

---

## The edits, in manuscript order

Rule applied: keep your sentence structure, update the numbers, change wording only where a claim flipped. Full former and current sentences:

#### 1. L150 · Results, tracking paragraph

**Why:** "Broadly competitive" sat right before a 0.22 gap on Mouse-Dyad-10M. It is true on SLAP-2M, so the sentence now names SLAP-2M.

**Former:**

```latex
Within a single camera all three methods are broadly competitive.
```

**Current:**

```latex
Within a single camera all three methods are broadly competitive on SLAP-2M (Supplementary Figure~\ref{fig6}B).
```

---

### 2. L338 · Methods, Baseline configuration, paragraph 1

**Why:** B to D now use the improved settings too.

**Former:**

```latex
For Supplementary Figure~\ref{fig6}A, SLEAP and ByteTrack were run with settings that improve their performance over the defaults.
```

**Current:**

```latex
For Supplementary Figure~\ref{fig6}A to D, SLEAP and ByteTrack were run with settings that improve their performance over the defaults.
```

---

### 3. L340 · Methods, Baseline configuration, SLEAP paragraph

**Why:** The sentence before says sleap-nn 0.3.0 and a cap of two, which is Mouse-Dyad-10M only. SLAP-2M used 0.2.0 and a cap of one to four.

**Former:** *(none, new sentence added after this unchanged one)*

```latex
The original run capped instances per frame (\texttt{--tracking\_target\_instance\_count 2}) and not tracks, and produced a median of 47.5 tracks per camera-session.
```

**Current:**

```latex
For SLAP-2M the cap was the session's number of animals, one to four, using sleap-nn (0.2.0), the version that produced the SLAP-2M detections.
```

---

### 4. L342 · Methods, Baseline configuration, ByteTrack paragraph

**Why:** "B to D use the original runs" is false after the re-run.

**Former:**

```latex
These changes apply to Supplementary Figure~\ref{fig6}A only. Supplementary Figure~\ref{fig6}B to D use the original runs of both trackers, in which ByteTrack retires a track after 60 frames (2~s at SLAP-2M's 30 fps).
```

**Current:**

```latex
The same changes apply to Supplementary Figure~\ref{fig6}B to D, where the stitch reduces each session to its number of animals.
```

---

### 5. L387 · Supplementary Section 5.1, opening paragraph

**Why:** "The original settings… not directly comparable" is false after the re-run.

**Former:**

```latex
Supplementary Figure~\ref{fig6}B to D use the SLAP-2M sessions, which range from one to four animals, and the original settings of SLEAP and ByteTrack (Section~\ref{methods-baseline}), so their values are not directly comparable with Supplementary Figure~\ref{fig6}A.
```

**Current:**

```latex
Supplementary Figure~\ref{fig6}B to D use the SLAP-2M sessions, which range from one to four animals, and the same SLEAP and ByteTrack settings as Supplementary Figure~\ref{fig6}A (Section~\ref{methods-baseline}).
```

---

### 6. L389 · Supplementary Section 5.1, within-view paragraph

**Why:** New numbers from the fair re-run. Two claims flipped: the single-animal gap is now negligible, and in the 3–4-animal sessions LUC3D, not SLEAP, is ahead in all seven.

**Former:**

```latex
The within-view difference between LUC3D and SLEAP is largest in the single-animal sessions, where there is nothing to associate (Supplementary Figure~\ref{fig6}C). Pooled over all 74 sessions LUC3D's within-view IDF1 is higher by 0.099 (56 of 74 sessions, sign test $P = 1.1 \times 10^{-5}$). Restricted to sessions with two or more animals, the difference is 0.067 (31 of 42 sessions, $P = 0.003$). However, in the three and four animal sessions where cross-view association should help most, SLEAP is slightly ahead in all seven sessions (median differences $-0.039$ and $-0.028$).
```

**Current:**

```latex
The within-view difference between LUC3D and SLEAP is negligible in the single-animal sessions, where there is nothing to associate (Supplementary Figure~\ref{fig6}C). Pooled over all 74 sessions LUC3D's within-view IDF1 is higher by 0.026 (26 of 74 sessions, sign test $P = 0.14$). Restricted to sessions with two or more animals, the difference is 0.047 (26 of 42 sessions, $P = 0.16$). In the three and four animal sessions where cross-view association should help most, LUC3D is ahead in all seven sessions (median differences $0.101$ and $0.115$).
```


---

## Already done by your own rewrites (not touched here)

- **L150** (checklist E1). You replaced the 56-of-74 SLAP-2M claim with the Mouse-Dyad-10M numbers from panel A. I only fixed the one sentence this left inconsistent (E9 above).
- **L387** (checklist E6). You changed "…and in most sessions improves it" to "…does not cost within-view accuracy (Supplementary Figure~\ref{fig6}A)", and deleted the duplicate B-to-D sentence.

## Noticed but deliberately NOT changed (outside the emergency scope)

- **L338, "Both defaults fragment identities on 20-minute sessions."** Mouse-Dyad-10M sessions are about 20 minutes, but SLAP-2M sessions have a median of 18,139 frames at 30 fps, about 10 minutes. This was already there before the new figure, so I left it. A possible fix is "…on 10- to 20-minute sessions."
- **L148, two copy-edits reverted by your paste.** The stray backtick after "without missing instances." (it prints as an opening quote) and "counts weighting false positives" (should be "counts, which weights false positives"). Both are still in this file and are open in the checklist, marked REVERTED.
- **The session-length control.** Scored in 18,000-frame windows, Mouse-Dyad-10M's SLEAP and ByteTrack rise from 0.662 and 0.703 to 0.798 and 0.823, close to their SLAP-2M two-animal values. That is on 12 of the 50 sessions (`figs/out/fig6_window_length_control_12.json`), so no windowed number is in the text. Run all 50 before quoting it.

## Checklist

`luc3d_copydesk_checklist_v4.md` is updated: the Emergency fix section is 9/9 and every item is ticked with where it went. The overall count is 25 / 150.
