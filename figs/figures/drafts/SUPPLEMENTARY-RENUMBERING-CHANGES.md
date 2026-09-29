# Changes to `latex_newest.tex`: supplementary figure numbering and cross-references

Made 2026-09-19. Line numbers are for the file as it stands after these edits.
A copy of the file as it was before them is at
`/tmp/claude-0/-root-vast-eric-sleap-3d-gui-scratch-repos-lucid/aed344f1-a406-4a10-b6aa-bd4b85899b4a/scratchpad/latex_before.tex`.

## 1. Figures 6 to 8 now number as Supplementary Figures 1 to 3

**Lines 385 to 386**, immediately after `\section{Supplementary Material}` (line 383):

```latex
\setcounter{figure}{0}
\renewcommand{\figurename}{Supplementary Figure}
```

Two things happen from that point on. The counter restarts, so the three figures that
follow become 1, 2 and 3 instead of 6, 7 and 8. And `\figurename` is renamed, so their
own captions typeset as "Supplementary Figure 1." rather than "Figure 1.", which would
otherwise collide with the main Figure 1.

`\ref` returns the bare number, so existing text of the form
`Supplementary Figure~\ref{fig6}` renders as "Supplementary Figure 1". No reference in
the file needed rewording.

The mapping is unchanged from what you asked for:

| Label | Line of `\label` | Was | Now |
|---|---|---|---|
| `fig6` | 431 | Figure 6 | Supplementary Figure 1 |
| `fig7` | 438 | Figure 7 | Supplementary Figure 2 |
| `fig8` | 446 | Figure 8 | Supplementary Figure 3 |

The dataset datasheet float further down is not affected. It uses
`\captionof{table}`, so it numbers as a table, not as a fourth supplementary figure.

**Word choice.** I kept "Supplementary", which is what the section heading and all
existing references in the file already use, rather than switching to "Supplemental".
If you prefer "Supplemental", it is one substitution across the file plus the
`\figurename` line, and nothing else has to change.

## 2. Camera calibration section now points into the supplement

**Line 268**, in `\subsection{Camera calibration}\label{methods-calibration}`.

Before:

> Its accuracy was benchmarked against Anipose on two different camera rigs. The
> benchmark methods can be found in Sections~\ref{methods-calib-bench}. The results can
> be found in ~\ref{subsec-calib} and Supplementary Figure~\ref{fig8}.

After:

> Its accuracy was benchmarked against Anipose on three different camera rigs. The
> benchmark methods can be found in Section~\ref{methods-calib-bench}. The results can
> be found in Section~\ref{subsec-calib} and Supplementary Figure~\ref{fig8}.

Three fixes, wording otherwise unchanged. The rig count was **two** and is now three,
since Mouse-Dyad-10M was added. `Sections~` was plural for a single reference. And
`in ~\ref{subsec-calib}` had no noun before it and a stray space, so it would have read
"can be found in  2".

## 3. New pointers from the main text into the supplement

Each of these sends the reader to the panel or section that expands on the point being
made, which did not previously exist in the main text.

**Line 148**, Results, `\subsection{...greedy per-camera assignment...}\label{subsec2-3}`.
The paragraph on the 3D correspondence term now names both where the term is defined and
where it is drawn:

> ...in the association cost (Section~\ref{methods-association}; the 2D and 3D terms are
> drawn on one real frame in Supplementary Figure~\ref{fig6}E).

**Line 282**, Methods, `\subsection{Cross-view association}\label{methods-association}`.
A new opening sentence, before the cost function is defined:

> Supplementary Figure~\ref{fig6}E draws both cost terms on one real frame, the retained
> per-view 2D anchor and the 3D anchor node, and Supplementary
> Section~\ref{subsec2-9} reports the parameter search over the staleness horizon.

**Line 354**, Methods, `\subsection{Anchor staleness and the fresh-anchor tracker}\label{methods-anchor}`.
Appended to the sentence describing the sweep over `N`:

> ...$N$ was swept over 1, 10, 20 and 30; that sweep is drawn in Supplementary
> Figure~\ref{fig6}F and reported in Supplementary Section~\ref{subsec2-9}.

**Line 342**, Methods, `\subsection{Baseline configuration for tracking comparison}\label{methods-baseline}`.
A new opening sentence, since the section sets up baselines for a comparison that is
reported only in the supplement:

> The tracking comparison is reported in Supplementary Section~\ref{subsec2-7} and
> Supplementary Figure~\ref{fig6}A to D.

## 4. Figure 1 had no label

**Line 120.** The Figure 1 environment had a caption but no `\label{fig1}`, while three
places in the text reference `\ref{fig1}`. Those would have typeset as `??`. Added
`\label{fig1}` inside the environment.

After this, every `\ref` in the file resolves. Figure labels are `fig1` through `fig8`
in document order.

## What I did not change

The figure environments themselves, their captions, their `\includegraphics` paths and
the `figs/fig6.pdf`, `fig7.png`, `fig8.pdf` filenames are untouched. Only the numbering
that LaTeX prints changes, so the build still reads the same files.

## 5. "draws" and "drawn" replaced with plain verbs

A figure does not draw anything, and a view does not draw its own detections. This is the
same tic as "Figures 3G and H **ask** what the term contributes" (copydesk item 192) and
belongs with the literary-verb list in copydesk section 6. Five replacements, all to
plain verbs:

| Line | Before | After |
|---|---|---|
| 148 | the 2D and 3D terms are **drawn** on one real frame in Supp. Fig. 1E | Supplementary Figure~\ref{fig6}E **shows** the 2D and 3D terms on one real frame |
| 193 | The wall nearest the viewer is **drawn** as edges only, so the interior is seen through clear air | ...is **shown** as edges only, so the interior is **visible** |
| 227 | the resulting reconstruction is **drawn** in an interactive Three.js viewport | ...is **shown** in... |
| 227 | Every view **draws** its own detections | Every view **shows** its own detections |
| 229 | ...by the annotator and **drawn** as solid fully editable skeletons | ...and **appear as** solid fully editable skeletons |
| 282 | Supp. Fig. 1E **draws** both cost terms | Supplementary Figure~\ref{fig6}E **shows** both cost terms |
| 354 | that sweep is **drawn** in Supp. Fig. 1F | that sweep is **shown** in... |
| 445 | the held-out values are not **drawn** separately | ...are not **shown** separately |

The line 193 edit also picks up copydesk item 62, which flagged "seen through clear air"
in the same sentence.

### Three left in place, deliberately

**Line 193**, "drawn from its own cage corners and tracked 3D poses". This is "drawn
from" in the sense of derived from a source, not a figure doing the drawing.

**Line 292**, "an arithmetic bound drawn with an open marker". This describes a plotting
decision, which is what the word is for.

**Line 424**, "three of six draws" and "the three converged draws". A draw here is a
sample from aniposelib's unseeded random initialisation, which is the correct technical
term. Replacing it would lose the meaning.
