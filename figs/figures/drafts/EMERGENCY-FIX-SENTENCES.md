# Supplementary Figure 1 emergency fix: former and current sentences

`figs/figures/drafts/luc3d_newest.tex`, edited 2026-09-29 on top of your 01:11 paste. Rule applied throughout: keep your sentence structure, update the numbers, and change wording only where a claim flipped. Each entry gives the **full** former and current sentence(s), copied from the two files (LaTeX exact, so Ctrl-F finds it).

Six lines changed. Nothing else in the file differs. The Supplementary Figure 1 caption (L429) is **unchanged**. It was silent about the baseline settings but not false, and L387 now states them.

---

## 1. L150 · Results, tracking paragraph

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

## 2. L338 · Methods, Baseline configuration, paragraph 1

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

## 3. L340 · Methods, Baseline configuration, SLEAP paragraph

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

## 4. L342 · Methods, Baseline configuration, ByteTrack paragraph

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

## 5. L387 · Supplementary Section 5.1, opening paragraph

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

## 6. L389 · Supplementary Section 5.1, within-view paragraph

**Why:** New numbers from the fair re-run. Two claims flipped: the single-animal gap is now negligible, and in the 3–4-animal sessions LUC3D, not SLEAP, is ahead in all seven.

**Former:**

```latex
The within-view difference between LUC3D and SLEAP is largest in the single-animal sessions, where there is nothing to associate (Supplementary Figure~\ref{fig6}C). Pooled over all 74 sessions LUC3D's within-view IDF1 is higher by 0.099 (56 of 74 sessions, sign test $P = 1.1 \times 10^{-5}$). Restricted to sessions with two or more animals, the difference is 0.067 (31 of 42 sessions, $P = 0.003$). However, in the three and four animal sessions where cross-view association should help most, SLEAP is slightly ahead in all seven sessions (median differences $-0.039$ and $-0.028$).
```

**Current:**

```latex
The within-view difference between LUC3D and SLEAP is negligible in the single-animal sessions, where there is nothing to associate (Supplementary Figure~\ref{fig6}C). Pooled over all 74 sessions LUC3D's within-view IDF1 is higher by 0.026 (26 of 74 sessions, sign test $P = 0.14$). Restricted to sessions with two or more animals, the difference is 0.047 (26 of 42 sessions, $P = 0.16$). In the three and four animal sessions where cross-view association should help most, LUC3D is ahead in all seven sessions (median differences $0.101$ and $0.115$).
```

