# Copydesk review: LUC3D manuscript (revision 2: `luced_newest.tex`)

Line numbers refer to `luced_newest.tex`. Every item from revision 1 keeps its number; only the line references changed. Items you checked were verified against the new text and kept; 17 items you had not checked were found fixed and are now checked with a "verified fixed" note. New items start at #164.

Each item is a checkbox. Tick it off as you fix it (renders as clickable in GitHub, Obsidian, VS Code preview, Typora, Notion). "Fix" is a direction, not wording to paste.

**Progress:** 227 / 261

---

## 0. Headline counts (revision 2)

| Tell | Rev 1 | Rev 2 | Notes |
|---|---|---|---|
| Em dashes / ` -- ` | 2 | 0 | Clean. |
| "ships" / "shipped" | 12 | 0 | Clean. |
| "rests on" | 2 | 0 | Clean. |
| "against" | ~54 | 41 | Now listed exhaustively in §4, one line each, every instance. About 10 are literal ("scored against ground truth") and marked keep. |
| "rather than" | 38 | 31 | See #201 for the per-line list. |
| "so that" | 16 | 16 | See #200. |
| "carries / carry" | 18 | 14 | See #198. |
| Semicolons | 57 | 57 | Captions: L181 has 11, L115 8, L157 7, L132 6, L394 6, L192 5. |
| "per cent" vs "%" | 23 / 19 | 18 / 20 | Still mixed. #119. |
| `~` used as "approximately" | 0 | 9 | **New LaTeX bug**: `~` is a non-breaking space, so "~10 million" prints as " 10 million". #164. |
| Straight `"` quotes in prose | 0 | 5 | **New LaTeX bug**: render as two closing quotes. #165. |
| Fig 2 caption "against" | 4 flagged | 8 listed | #33 now lists all eight. |

### What your edits taught me (copydesk learn pass on rev 1 → rev 2)

Patterns in the changes you made by hand, which the new items below follow:
- You replace "against" with **"and"**, **"while"**, **"relative to"**, or a restructured sentence; you do not use "versus" in body text. New suggestions use those.
- You spell out **"pixels"** and use **"%"** rather than "px" / "per cent". (Some "per cent" remain in Methods; #119 lists them.)
- You round nine-digit counts to **"~10 million"** style. Good instinct, but it introduced the tilde bug (#164).
- You **cut** over-detailed sentences outright (the 59-frames aside, the complementary-shares clause, the exact frame totals) rather than trimming them. New run-on items suggest cuts first, splits second.
- You prefer plain verbs: "compares", "incorrectly grouped", "is mounted", "reduced". New items avoid proposing anything fancier.
- You kept "A series of control tests were performed to rule out the obvious alternatives", so I have stopped flagging notional agreement and "obvious"; those are your calls.

---

## 1. Hard fails (fix regardless of taste)

- [X] **1.** **L179 (Fig 4 caption, panel E)** · *Em-dash substitute*
  - Current: "Facing-pursuit in the same pre-onset window -- each animal's facing axis dotted with..."
  - Fix: Colon or period.
- [X] **2.** **L390 (Fig 6 caption, panel F)** · *Em-dash substitute*
  - Current: "...487 (stale 1, 10, 20, 30) -- no eviction 0.00460\% against stale 20..."
  - Fix: Period. Start a new sentence.
- [X] **3.** **L169** · *Negative parallelism ("not only X but Y")*
  - Current: "The difference is not only in how fast each animal moves but in what that motion is doing."
  - Fix: State the positive claim: the two animals differ in speed and in direction of travel.
- [X] **4.** **L204** · *Negative parallelism*
  - Current: "greedy Hungarian matching not only can perform this matching efficiently but also can perform better than the exhaustive strategy"
  - Fix: "greedy Hungarian matching is faster and misgroups fewer frames than the exhaustive strategy."
- [X] **5.** **L175** · *Negation-correction chain ("is not simply... It is not an artifact... Nor is it explained...")*
  - Current: Three consecutive sentences open by negating an alternative.
  - Fix: Fine to test alternatives; vary the syntax. Lead one with the control itself ("Sharing a 60 mm threshold across both animals still returns the female as leader in 24 of 24.").
- [X] **6.** **L384** · *Negation-correction ("This is close to arithmetic rather than a contest, and we do not present it as a benchmark win... What the comparison establishes is that the capability is absent; it does not show the methods to be poor.")*
  - Current: Four negations in four clauses.
  - Fix: Say the positive thing once: per-camera trackers have no cross-view identity, so the pooled score measures a capability they lack.

### New hard fails found in revision 2

- [X] **164.** **L123, L167, L244 (x3), L246 (x2), L390 (x2)** · *LaTeX: `~` is a non-breaking space, not "approximately"*
  - Current: "~5 pixels", "~0.8~s", "~10 million", "~20 million", "~100 million", "~2.8 million", "~22.5 million", "~45 million", "~11.7 million"
  - Fix: These will print as " 5 pixels", " 10 million", etc. Use `$\sim$10 million`, `\textasciitilde`, or the word "about". For "~0.8~s" the first tilde must become `$\sim$` and the second stays.
- [X] **165.** **L123, L132** · *LaTeX: straight double quotes*
  - Current: "instance" (L123); "topB", "sideL", "mid", "topC" (L132)
  - Fix: `"..."` renders as two closing quotes in LaTeX. Use ``...'' or, for camera names, \texttt{topB}.
- [X] **166.** **L167** · *Sentence fragment with missing noun (flagged in chat several times; still present)*
  - Current: "While the female's  is close to zero (median -0.06; paired Wilcoxon P = 3.3 × 10⁻⁷³) indicating neither approach nor retreat."
  - Fix: Drop "While", add the noun, remove the double space, comma before "indicating": "The female's score is close to zero (...), indicating neither approach nor retreat."
- [X] **167.** **L342** · *Factual error introduced in the rewrite*
  - Current: "The within-view IDF1 using default settings is 0.272; with the track stitching it performs it is 0.676."
  - Fix: 0.272 is the score with retirement disabled and no stitch, not with default settings (defaults include 2 s retirement). And "with the track stitching it performs it is" is garbled. → "Without the stitch, within-view IDF1 is 0.272; with it, 0.676."
- [X] **168.** **L327** · *Garbled sentence, missing verb*
  - Current: "However, the cross-view comparisons were performed to demonstrate LUC3D's novel functionality and it is important not to presuppose that this SLEAP's or ByteTrack's intended purpose."
  - Fix: "The cross-view comparison is not a benchmark of SLEAP or ByteTrack, which were not designed to maintain identity across cameras; it is included to show what cross-view identity adds." Also "should be seen as a fair benchmark comparison" in the sentence before → "is a fair benchmark".
- [X] **169.** **L382** · *New grammar errors in the rewritten paragraph (was #6/#109)*
  - Current: "can only match most one camera" ; "This comparison establishes is that the cross-view capability is absent" ; "while also showing that LUC3D also improves"
  - Fix: "can match at most one camera" ; "This comparison establishes that" ; drop one "also".
- [X] **170.** **L388** · *Direction of the sweep is stated backwards*
  - Current: "shortening the eviction window reduced switches monotonically down to N = 20: 2,071 with no eviction, 677 at N = 1, 511 at N = 10 and 413 at N = 20, rising again to 487 at N = 30." and "Retaining stale evidence for longer than that had the opposite effect."
  - Fix: N = 1 → 10 → 20 is a lengthening window, and switches fall along it. Say "Enabling eviction cut switches from 2,071 to 677 at N = 1; lengthening the window to N = 10 and N = 20 reduced them further (511, 413), and N = 30 rose again (487)." "Longer than that" then has a referent (N = 20).
- [X] **171.** **L316** · *Duplicate definition*
  - Current: "It counts as missing in a view when the proofread reference carries it there and the matched detection does not." and two sentences later "A keypoint counts as missing in a view when the proofread reference has it and the paired detection does not."
  - Fix: Delete one.
- [X] **172.** **L138, L292, L346** · *Citation form doubles the author-year*
  - Current: "Maree et al. (2024) \citep{Maree2024} uses" ; "Chen et al. (2020) \citep{Chen2020}" ; "the per-frame procedure of \citep{Maree2024}" ; "design of \citep{Chen2020}" ; "Chen et al (2020) \citep{Chen2020}"
  - Fix: These print as "Maree et al. (2024) (Maree et al., 2024)". Use \citet{Maree2024} alone. Also "et al." needs its period at L346, and "Maree et al. ... uses" → "use".
- [X] **173.** **L171** · *Hard-coded figure reference*
  - Current: "(Figure 4C)"
  - Fix: `(Figure~\ref{fig4}C)`, or it will not renumber.
- [X] **174.** **L268** · *Paragraph ends mid-sentence*
  - Current: "...and runs per-camera intrinsics calculations"
  - Fix: Finish the sentence and add a period.
- [X] **175.** **L132** (Fig 2 caption, panel A) · *Garbled numbered list*
  - Current: "2. A showing that two camera views can be used to fill in the rest of the camera views (top)" ; "3. the reprojection drawn into" ; "cam 2 "topC" (bottom, and 4."
  - Fix: "2. The two labeled views (top) and the 3D coordinates solved from them alone (bottom). 3. The reprojection drawn into the unlabeled views, cam 0 mid (top) and cam 2 topC (bottom). 4. A magnified view..." Close the parenthesis; capitalize after each numeral.
- [X] **176.** **L244** · *Misplaced modifier*
  - Current: "a third dataset was used to test social interaction with a high incidence of occlusions known as the HardFight dataset"
  - Fix: "a third dataset, HardFight, was used to test social interaction with a high incidence of occlusions".

---

## 2. "ships" / "shipped" (all 12)

- [X] **7.** **L132**
  - Current: "for the two solvers the app ships"
  - Fix: "the two solvers included in the app"
- [X] **8.** **L240**
  - Current: "the shipped code paths rather than a reimplementation"
  - Fix: "the same code that runs in the released application"
- [X] **9.** **L268**
  - Current: "Each rig ships a calibration file"
  - Fix: "Each rig has a calibration file" / "comes with"
- [X] **10.** **L292**
  - Current: "The application ships $corr2d = 1$, $corr3d = 6$..."
  - Fix: "The default values are..."
- [X] **11.** **L312**
  - Current: "which is why the shipped solver is the one measured"
  - Fix: "which is why we measured the solver as deployed"
- [X] **12.** **L344**
  - Current: "against the shipped 60 frames"
  - Fix: "instead of the default 60 frames"
- [X] **13.** **L344**
  - Current: "Two gates anchor the re-runs to the shipped measurement"
  - Fix: "Two checks tie the re-runs to the original measurement"
- [X] **14.** **L344**
  - Current: "re-scoring the shipped ByteTrack arm"
  - Fix: "the original ByteTrack run"
- [X] **15.** **L344**
  - Current: "re-running one camera-session at the shipped parameters"
  - Fix: "at the original parameters"
- [X] **16.** **L348**
  - Current: "is the one the application now ships"
  - Fix: "is the current default"
- [X] **17.** **L388**
  - Current: "At the shipped $N = 20$"
  - Fix: "At the default $N = 20$"
- [X] **18.** **L390**
  - Current: "The application ships $N = 20$"
  - Fix: "The default is $N = 20$"

"Shipped" is doing double duty for "default" and "released/deployed". Pick one plain word for each and be consistent.

---

## 3. "rests on"

- [X] **19.** **L278**
  - Current: "the held-out scoring of Figure 2E rests on 884,697,424 solves"
  - Fix: "requires" / "is computed from"
- [X] **20.** **L278**
  - Current: "The every-frame measurement in Figure 2 rests on 2,862,001,740 two-anchor solves"
  - Fix: Same.

---

## 4. "against" as a comparison word

This is the tic that will get the paper flagged fastest. A human scientist writes "4.32 px with two cameras versus 3.34 px with four" or "compared with". The manuscript uses "X against Y" for nearly every paired number. All 41 remaining instances are listed in this section (items 22 to 35 and 177 to 186a).

- [X] **21.** **L140**
  - Current: "misgroups 926 frames against exhaustive enumeration's 1,309, 20.3 against 28.6 per 100,000, and ... 0 against 880 per 100,000" (three in one sentence)
- [X] **22.** **L146** · Two instances
  - Current: "by sweeping its weight against the two-dimensional term's" ; "no IDF1 (0.8614 against 0.8613)"
  - Fix: "relative to the two-dimensional term's" ; "(0.8614 and 0.8613)"
- [X] **23.** **L300**
  - Current: (title of subsection 2-3 is fine; body) "0.644 to 0.688 at k=2 ... against 0.861 for the full rig" (L302)
  - Note: Same instance as #28 (moved from old L152/L302); fix once.
- [X] **24.** **L167**
  - Current: "1.08 within two body lengths and 0.97 beyond" is fine; but L175 "90.1~mm against 84.2~mm"
- [X] **25.** **L171**
  - Current: "the female's median share is 0.86 against the male's 0.14"
- [X] **26.** **L179** (Fig 4 caption) · Three instances
  - Current: "Male median -0.708 against female -0.058" ; "session medians 0.857 (female) against 0.143 (male)" ; "at 50.2% of his near onsets, against 6.2% for the reverse"
  - Fix: "male median -0.708, female -0.058" ; "0.857 (female) and 0.143 (male)" ; "compared with 6.2% for the reverse"
- [X] **27.** **L292** · One instance (the other "against" on this line is #157)
  - Current: "at 2.7 and 5.5 seconds per frame against 11 to 16 milliseconds for two animals"
  - Fix: "at 2.7 and 5.5 seconds per frame, compared with 11 to 16 milliseconds for two animals"
- [X] **28.** **L300** · One instance
  - Current: "0.803 to 0.843 at k = 4, against 0.861 for the full rig"
  - Fix: "and 0.861 for the full rig"
- [X] **29.** **L342**
  - Current: "against the shipped 60 frames"
  - Note: Verified fixed in this revision.
- [X] **30.** **L378**
  - Current: "compares LUC3D against per-camera trackers"
  - Fix: "compares LUC3D with per-camera trackers"
- [X] **31.** **L388**
  - Current: "413 switches against 511 at N=10, mean cross-view IDF1 0.861 against 0.850 and median 0.915 against 0.913" ; "(-0.183 against -0.138)"
  - Note: Verified fixed in this revision (now "413 versus 511").
- [X] **32.** **L390** (Fig 6 caption) · Three instances
  - Current: "Within-view against cross-view IDF1" ; "the 2D term against the retained per-view 2D anchor" ; "the 3D term as the detection's back-projected ray against the 3D anchor node"
  - Fix: "Within-view and cross-view IDF1" ; "the 2D term, the distance to the retained per-view 2D anchor" ; "the 3D term, the distance from the detection's back-projected ray to the 3D anchor node"
- [X] **33.** **L132** (Fig 2 caption) · Eight instances, all listed
  - Current: (B) "Manual placements per animal per frame against rig size C" ; (B) "every label by hand ... against the placements still needed after reprojection" ; (C) "3D error against the cameras in the solve" ; (D) "Median two-anchor 3D error against the angle the pair subtends" ; (E) "Solver accuracy against the cameras used" ; (E, bottom) "all views in the solve against the same solve with the worst view dropped" ; (G) "6.3 against 29.0 μs on the linear pair" ; (G) "44.0 against 228.8 μs on the non-linear"
  - Fix: For axis descriptions use "as a function of" or "by": "Manual placements per animal per frame as a function of rig size C" ; "3D error by number of cameras in the solve" ; "3D error as a function of the angle..." ; "Solver accuracy by number of cameras". For paired numbers use "and": "every label by hand ... and the placements still needed" ; "all views in the solve and the same solve with the worst view dropped" ; "6.3 and 29.0 μs" ; "44.0 and 228.8 μs".
- [X] **34.** **L155** (Fig 3 caption) · Four instances
  - Current: "frames misgrouped against proofread ground truth" (keep, literal) ; "misgroups 926 frames against exhaustive's 1,309" ; "(20.3 against 28.6 per 100,000)" ; "the per-session medians are 0 against 880 per 100,000"
  - Fix: Match the body text you already rewrote at L140: "LUC3D's greedy assignment incorrectly grouped 926 frames (20.3 per 100,000) and exhaustive enumeration 1,309 (28.6 per 100,000); at 4 animals in 3 cameras the per-session medians are 0 and 880 per 100,000."
- [X] **35.** **L190** (Fig 5 caption)
  - Current: "Raw per-camera detection quality against difficulty"
  - Fix: "by difficulty rating"

The list above is now exhaustive for lines that already had item numbers; the lines below had no item before. Every "against" in the file is covered by exactly one item in this section. "Keep" means it is a literal comparison to a reference and can stay.

- [X] **177.** **L109** · "so that it can be compared directly against that camera's video" · Optional: "with". Same phrase at L226 (#181).
- [X] **178.** **L115** (Fig 1 caption) · Two instances: "the 3D is proofread against per-view reprojections" (keep, literal) and "Capability comparison against 7 multi-animal or multi-camera pose tools" → "with 7".
- [X] **179.** **L127** · "while the widest at 31 degrees gives 2.7 mm, against a floor of 1.2 mm when all five views contribute" → "compared with a floor of 1.2 mm".
- [X] **180.** **L165** · "supporting the animal's weight against a wall" · Keep (physical, literal).
- [X] **181.** **L226** · "compared directly against that camera's video" → "with".
- [X] **182.** **L290** · "every camera is scored against a recent anchor" · Keep, or "relative to a recent anchor".
- [X] **183.** **L324** · Two instances: "as two distributions rather than one share against a simulated null" → "rather than as one share compared with a simulated null"; "to test the female's share against chance" → keep (literal test) or "relative to chance".
- [X] **184.** **L326** · "Wilcoxon signed-rank on the female's share within each pair against 0.5" · Keep (literal one-sample test).
- [X] **185.** **L346** · Three instances: "Three coordinated changes were evaluated against that defect" → "to address that defect"; "scores all views against the snapshot" (keep); "the evidence the remaining views are scored against" (keep).
- [X] **186.** **L350** · Two instances: "the paired session-level comparison against a fixed value" → "with a fixed value"; "is read against circular-shift nulls" → "is compared with circular-shift nulls".
- [X] **186a.** **L140** · "scored against proofread ground truth" · Keep (literal). Listed so the sweep is complete.

Suggested fix: do a global search for " against " and replace with "versus", "vs.", "compared with", "and", or restructure ("fell from 4.32 px to 3.34 px"). Keep "against" only where something is literally being tested against a reference (e.g. "against proofread ground truth").

---

## 5. Numbered-setup sentence openers and one-word dramatic fragments

A recurring Claude move: announce a count, then enumerate. Ten instances is a pattern.

- [X] **36.** **L144**
  - Current: "Two limits belong with this result."
  - Fix: "This result has two caveats." or just start with the first caveat. "Belong with" is not how anyone says this.
- [X] **37.** **L175**
  - Current: "Three controls test the obvious alternatives to a genuine sex difference."
  - Fix: "We tested three alternative explanations."
- [X] **38.** **L228**
  - Current: "Three instance types are distinguished throughout the interface:"
  - Fix: Acceptable in Methods; leave or say "The interface has three instance types:".
- [X] **39.** **L290**
  - Current: "Two further properties complete the association."
  - Fix: Cut the sentence; just state the two properties.
- [X] **40.** **L294**
  - Current: "Two conventions separate the arms."
  - Fix: "The two methods are scored differently in two ways."
- [X] **41.** **L342**
  - Current: "Two gates anchor the re-runs to the shipped measurement:"
  - Fix: "We checked the re-runs two ways:"
  - Note: Verified fixed in this revision (gates paragraph removed).
- [X] **42.** **L346**
  - Current: "Three coordinated changes were evaluated against that defect."
  - Fix: "We evaluated three changes."
- [X] **43.** **L390**
  - Current: "Two features of the sweep argue that the effect is specific to anchor freshness"
  - Fix: "The sweep suggests the effect comes from anchor freshness, for two reasons."
- [X] **44.** **L140**
  - Current: "It does not." (standalone fragment after "We investigated whether the cheap and greedy procedure gives up accuracy")
  - Fix: Merge: "It does not give up accuracy: over the 4.57M frames..."
  - Note: Verified fixed in this revision.
- [X] **45.** **L146**
  - Current: "The term is necessary. The association does not survive without it:"
  - Fix: Two punchy sentences saying the same thing. Keep one.
- [X] **46.** **L171**
  - Current: "The female starts most of the displays." (one-line topic sentence immediately re-stated with numbers in the next sentence)
  - Fix: Fold into the numeric sentence.
- [X] **47.** **L138**
  - Current: "That is $A!$ per view and therefore $(A!)^C$ per frame"
  - Fix: Fine mathematically; the "That is..." opener is a tic when it recurs. Minor.

### New in revision 2

- [X] **187.** **L144** · Negation closer + "therefore"
  - Current: "The equivalence therefore holds where the published method can run, and is not a claim about the frames where it cannot."
  - Fix: "The two methods agree on the frames where exhaustive enumeration can be run."
- [X] **188.** **L173** · Aphoristic closer with "rather than"
  - Current: "The asymmetry is a property of the pair and of the female in it rather than of any one recording."
  - Fix: Cut; the sentence before already says every pairing has the female leading.
- [X] **189.** **L326** · Negation closer
  - Current: "The result is therefore not an artifact of treating repeated recordings of one pair as independent."
  - Fix: "The result holds with the pair as the unit of replication."
- [X] **190.** **L208** · "What X does establish is that"
  - Current: "What the result does establish is that a stable directional social dynamic exists in this behavior"
  - Fix: "The result establishes a stable directional social dynamic in this behavior".
- [X] **191.** **L350** · Self-conscious hedge
  - Current: "this is a conservative-sounding choice that is not automatically conservative, because"
  - Fix: "this is not automatically conservative, because".
- [X] **192.** **L146** · Figures "ask"; "the arm holds"
  - Current: "Figures 3G and H ask what the three-dimensional term in the association cost contributes" ; "At the app default ratio of six the arm holds 413 switches"
  - Fix: "Figures 3G and H measure the contribution of the three-dimensional term" ; "At the default ratio of six there are 413 switches".

---

## 6. Literary / metaphorical verbs on data (the "Claude voice")

These are the phrases a reviewer will read as machine prose: data that "carries", "holds", "sits", "lands", "hands", "buys", "earns", "survives".

- [X] **48.** **L109**
  - Current: "the frame holds three identities" ... "The one left over is a duplicate detection ... which one-to-one assignment correctly refuses."
  - Fix: "the frame contains three identities" / "The remaining detection is a duplicate ... which one-to-one assignment rejects."
- [X] **49.** **L115**
  - Current: "this frame holds 25 detections carrying 21 distinct track names"
  - Fix: "contains 25 detections with 21 distinct track names"
- [X] **50.** **L125**
  - Current: "lands a median 4.74~mm"
  - Fix: "has a median error of 4.74 mm"
- [X] **51.** **L127**
  - Current: "the two anchor views for reprojection can also reduce labor cost" (fine) but "So this means that strategic camera placement..."
  - Fix: Cut "So this means that".
- [X] **52.** **L292**
  - Current: "the 42 SLAP-2M sessions that carry both pool detections and proofread ground truth"
  - Fix: "that have both"
  - Note: Wording is now "the 92 multi-animal sessions carrying both pool detections and proofread ground truth".
- [X] **53.** **L142**
  - Current: "the bound is generous to the published method twice over"
  - Fix: "the bound favors the published method in two ways"
- [X] **54.** **L142**
  - Current: "one second of 50~fps video would cost more than a day"
  - Fix: "would take more than a day to process"
- [X] **55.** **L144**
  - Current: "which is to say exactly the frames association finds hardest"
  - Fix: "i.e. the hardest frames for association"
- [X] **56.** **L146**
  - Current: "doubling the ratio to twelve buys 42 fewer switches and no IDF1"
  - Fix: "reduces switches by 42 with no change in IDF1"
- [X] **57.** **L146**
  - Current: "The association does not survive without it"
  - Fix: "Without it the association fails"
- [X] **58.** **L165**
  - Current: "every camera sits between 58 and 76 degrees above the animals" ; "the two noses sit 2.7 to 6.0~px apart while the tail bases sit 93 to 106~px apart"
  - Fix: "is mounted" / "are". "Sit" three times in one sentence.
- [X] **59.** **L171**
  - Current: "the shorter lags in the distribution ... are where the high frame rate earns its keep"
  - Fix: "are resolvable only because of the high frame rate"
- [X] **60.** **L175**
  - Current: "the three sessions where the female happens to be the longer animal still hand the female 75 of 97 displays"
  - Fix: "the female still starts 75 of 97 displays"
- [X] **61.** **L157**
  - Current: "so a leg that starts orange and ends blue IS the statement that one animal is carrying two identities" (L157, Fig 3 caption)
  - Fix: Drop the caps and the "IS the statement" construction: "a leg that changes color marks one animal carrying two identities."
- [X] **62.** **L190**
  - Current: "the wall nearest the viewer is drawn as edges only so the interior is seen through clear air" (appears twice)
  - Fix: "so the interior is visible"
- [X] **63.** **L208**
  - Current: "The social rearing analysis also surfaced a sex-specific asymmetry"
  - Fix: "revealed"
- [X] **64.** **L226**
  - Current: "The proofreader's working signal is the reprojection error, surfaced for each keypoint"
  - Fix: "shown"
- [X] **65.** **L278**
  - Current: "286,200,174 keypoints behind Figures 2B and D, 17,013,412 behind Figures 2E to G, and 187,134,382 keypoint comparisons behind Figure 5"
  - Fix: "underlying" or "used for". "Behind" three times.
- [X] **66.** **L278**
  - Current: "The sampled density was verified rather than assumed."
  - Fix: "We verified that the subsample is representative."
- [X] **67.** **L278**
  - Current: "discards redundancy rather than information"
  - Fix: Acceptable, but it is the rather-than tic again.
- [X] **68.** **L294**
  - Current: "That threading is scaffolding rather than part of the published method"
  - Fix: "That threading is not part of the published method"
- [X] **69.** **L294**
  - Current: "so each rate carries its own denominator"
  - Fix: "so the two rates have different denominators"
- [X] **70.** **L308**
  - Current: "The browser deployment that motivates this work forecloses a compiled implementation"
  - Fix: "rules out"
  - Note: Verified fixed in this revision.
- [X] **71.** **L327**
  - Current: "the comparison as first run charged them for constraints LUC3D's arm does not face"
  - Fix: "penalized them for constraints LUC3D does not have"
  - Note: Verified fixed in this revision.
- [X] **72.** **L342**
  - Current: "each ByteTrack id is bound at birth to one of two slots"
  - Fix: "assigned when first seen"
  - Note: Verified fixed in this revision.
- [X] **73.** **L342**
  - Current: "The never-retire knob alone reaches within-view IDF1 0.272"
  - Fix: "Disabling retirement alone gives"
  - Note: Verified fixed in this revision.
- [X] **74.** **L380**
  - Current: "We state that rather than pooling it away."
  - Fix: Cut. The sentence before already reports the negative result.
- [X] **75.** **L382**
  - Current: "This is close to arithmetic rather than a contest"
  - Fix: See hard fail #6.
  - Note: Verified fixed in this revision (but see #169 for new errors in the rewrite).
- [X] **76.** **L390**
  - Current: "so the material step is from no eviction to any eviction rather than the choice of window"
  - Fix: "so what matters is enabling eviction at all, not the window length"
- [X] **77.** **L390**
  - Current: "Traversing the same axis in the opposite direction is monotonically harmful across four orders of magnitude"
  - Fix: "Moving the other way (retaining stale evidence longer) monotonically increases switches"
- [X] **78.** **L390**
  - Current: "its one cost being a deeper worst single-session change"
  - Fix: "at the cost of a larger worst-case drop in one session"
- [X] **79.** **L148**
  - Current: "For further characterization ... (see Supplementary ...)."
  - Fix: Sentence has no main verb. Rewrite as "Supplementary Figure 6 and Sections ... compare the LUC3D tracker with SLEAP and ByteTrack..."
- [X] **80.** **L138, L140**
  - Current: "a cheap and greedy approach" / L140 "the cheap and greedy procedure"
  - Fix: "Cheap" is editorializing; "greedy" alone is the technical term.
- [X] **81.** **L119**
  - Current: Subsection title "Buy two get N free: reprojection speeds up the labeling process"
  - Fix: Cute-title pattern. Your call; Nature Methods reviewers may not love it.

"Arm" (benchmark arm, LUC3D's arm, the greedy arms) appears throughout L294 to L396. It's borrowed from clinical-trial language and reads oddly in a software benchmark. Consider "method" or "condition".

### New in revision 2

- [X] **193.** **L109**
  - Current: "The per-view detector comes from elsewhere; the application consumes SLEAP predictions."
  - Fix: "LUC3D does not include a detector; it reads SLEAP predictions."
- [X] **194.** **L163**
  - Current: "This paper presents a novel 3D social rearing behavior in the Mouse-Dyad-10M corpus in Figure 4."
  - Fix: A paper describes a behavior, it doesn't present one, and "novel" is puffery. "We describe a social rearing behavior in the Mouse-Dyad-10M corpus (Figure 4)."
- [X] **195.** **L165, L167, L187** · Colloquial register
  - Current: "rearing shows up as a synchronized pair interaction" ; "while they are still up on the hind legs" ; "So the male is usually joining in on a rear the female has already started" ; "the detections that do fire" ; "near-rear onsets" (undefined)
  - Fix: "occurs as" ; "while still on the hind legs" ; "The male therefore usually joins a rear the female has already started" ; "the detections that are present" ; define "near" (within two body lengths) or say "onsets within two body lengths".
- [X] **196.** **L218, L268**
  - Current: "It is pure vanilla JS" ; "a project is simply a set of local files" ; "written in JS"
  - Fix: "It is written in plain JavaScript" ; drop "simply" ; "JavaScript".
- [X] **197.** **L142**
  - Current: "it prices the remainder at the cheapest rate measured anywhere in the sweep"
  - Fix: "it assumes the fastest per-hypothesis time measured in the sweep".
- [X] **198.** "carries / carry / carrying" · 14 remaining, all listed
  - L109 "carrying 21 distinct track names" → "with" · L115 "carry no meaning across views" (keep) and "detections carrying 21 distinct track names" → "with" · L157 "one animal is carrying two identities" → "has" · L192 "An animal carries the same color" → "has" · L226 "A timeline widget ... carries frames, tracks and labeled regions" → "shows" · L236 "which carries the calibration" → "contains" · L248 "Each session also carries a curator-assigned difficulty rating" → "has" · L270 "A ChArUco board is carried through the arena" (keep, literal) · L292 "sessions carrying both pool detections and proofread ground truth" → "with" · L294 "frames carrying a transferred ground-truth match" → "with" · L316 "the proofread reference carries it there" → "has" · L334 "the fraction carrying the correct identity" → "with" · L350 "where a session-level test carries a claim" → "supports"; "carry bootstrap confidence intervals" → "have".
- [X] **199.** "arm(s)" · L146, L294 (x3), L296
  - Fix: "method" or "condition". Clinical-trial vocabulary in a software benchmark.
- [X] **200.** "so that" · 16 instances: L96, L109, L208, L220, L224 (x2), L226, L236, L262, L270, L274 (x2), L282, L300, L346, L378
  - Fix: Not all need changing. The chained ones are L224 (two in one paragraph), L274 (two), and L378 ("so that what is compared is association rather than detection" → "isolating association from detection").
- [X] **201.** "rather than" · 31 instances. Worst clusters: L278 (x3), L173 (x2), L192 (x2), L294 (x2), L312 (x2), L324 (x2)
  - Fix: L278 "verified rather than assumed" (#66), "discards redundancy rather than information" (#67), "interacts with a method rather than merely with the sample size" → "affects a method, not just the sample size". L192 "Difficulty removes keypoints rather than degrading them" → "Difficulty removes keypoints; it does not degrade them"; "absent from the data rather than omitted from the figure" → "absent from the data". L312 "across camera counts within one solver rather than between solvers" (fine); "a comparison value rather than absolute 3D accuracy" → "a relative, not absolute, measure".
- [X] **202.** **L300**
  - Current: "The number of cameras identity needs was measured by re-running the tracker on camera subsets" ; "which is what makes the subset cells attributable to the subset rather than to harness drift"
  - Fix: "To measure how many cameras identity tracking needs, the tracker was re-run on camera subsets" ; "so differences between subsets are attributable to the subset".
- [X] **203.** **L308**
  - Current: "it is reported here rather than drawn because a bar of that size would flatten every other bar in the panel" ; "Both linear and nonlinear variants between Anipose and LUC3D were measured and compared." ; "While there are also GPU-based alternatives those would not be suitable" ; "which is also CPU based"
  - Fix: "and is reported here rather than plotted" ; delete the redundant sentence (the paragraph already says this) ; comma after "alternatives" ; "CPU-based".
- [X] **204.** **L312**
  - Current: "This metric measurement is a comparison value rather than absolute 3D accuracy which is reiterated in the legend."
  - Fix: "This is a relative measure, not absolute 3D accuracy, as noted in the legend."
- [X] **205.** **L332** · One 190-word paragraph
  - Current: "through nothing but shared slot numbering" ; "would draw three indistinguishable bars" ; "that level is a property of the pooling convention rather than a strict bound"
  - Fix: Split after "one global identity per animal." and after "asserts cross-view identity." "credit ... through nothing but" → "credit ... purely from shared slot numbering".
- [X] **206.** **L346** · One 330-word paragraph describing an earlier implementation
  - Current: "The browser port as first written retained..." ; "We note additionally that the reference computes the weight with inverted sign" ; "written M1" ; "any anchor that does freeze" ; "rather than by bidding from an obsolete position" ; "the harness reproduced the unevicted baseline's deposited 50-session result bit-identically"
  - Fix: Same problem as the baseline section had: it narrates a prior version the reader never sees. Split into (1) the mechanism in Chen et al. and the defect in the reference implementation, (2) the three changes, (3) the evaluation setup. Cut "as first written", "M1", and the bit-identical reproduction sentence, or move reproduction to Software.
- [X] **207.** **L378, L380**
  - Current: "so that what is compared is association rather than detection" ; "in the two cells where cross-view association ought to help most, three and four animals, it is still negative"
  - Fix: "isolating association from detection" ; "the difference is negative" (say what is negative).
- [X] **208.** **L378**
  - Current: "The per-camera trackers lose about three quarters or more of theirs, 0.642 to 0.146 and 0.676 to 0.157, a retention of 0.23."
  - Fix: "The per-camera trackers retain about 23% of their within-view IDF1 (SLEAP 0.642 to 0.146, ByteTrack 0.676 to 0.157)."
- [X] **209.** **L390** (Fig 6 caption)
  - Current: "The retained anchor is what panel F's staleness window evicts."
  - Fix: "Panel F's staleness window evicts this retained anchor." ("not a chance level" is already fixed.)
- [X] **210.** **L179** (Fig 4 caption) · Remaining after your edits
  - Current: "(male is blue, red is female)" ; "dashed line, the fair coin at 0.5" ; "(0.6x, he is not yet up)"
  - Fix: "(male blue, female red)" ; "dashed line, 0.5" ; "(0.6×; the male has not yet reared)". The "exists only after triangulation" and "excluded rather than folded in" phrases are already fixed.
- [X] **211.** **L324**
  - Current: "(the fewest a two-sided binomial test can call significant)"
  - Fix: "(the minimum for a two-sided binomial test to reach P < 0.05)".
- [X] **212.** **L248**
  - Current: "It is the only recording that was built as a complete application session with its own calibration, which is why the panels driven through the application itself use it."
  - Fix: "It is the only recording with a complete application session and calibration, so it is used for the panels generated in the application (Figures 1 and 2A)."
- [X] **213.** **L278**
  - Current: "The one place where the stride interacts with a method rather than merely with the sample size is temporal smoothing, and that is the reason the smoothing term is disabled during the triangulation comparison, as described below."
  - Fix: "The stride does affect temporal smoothing, which is why that term is disabled in the triangulation comparison (below)."

---

## 7. Jargon, puffery, and filler (the abstract, intro, and discussion are the worst offenders)

- [X] **82.** **L88**
  - Current: "This tool will allow for the widespread proliferation of 3D pose estimation techniques for studying social behavior while reducing the cost of entry for neuroscience labs across the world."
  - Fix: Promotional. "LUC3D lowers the barrier to 3D pose estimation for labs without engineering support."
- [X] **83.** **L88**
  - Current: "multiple comprehensive datasets"
  - Fix: "two large datasets" (you name them later; "comprehensive" is empty).
- [X] **84.** **L88**
  - Current: "In addition, we present... Also, a protocol..."
  - Fix: Two consecutive additive openers. Merge.
- [X] **85.** **L98**
  - Current: "two massive datasets that serve as challenging benchmarks"
  - Fix: "two large datasets" / drop "serve as" (copula avoidance).
- [X] **86.** **L100, L246**
  - Current: "two comprehensive datasets" ; "an ideal candidate for benchmarking"
  - Fix: Repeats abstract; "ideal candidate" is AI vocabulary. Same phrase again at L248.
- [X] **87.** **L100**
  - Current: "In addition to new software tools, this paper presents"
  - Fix: Third "in addition" in 12 lines.
- [X] **88.** **L198**
  - Current: "speed up ... significantly by leveraging reprojection-aided labeling ... which would otherwise require significant manual labor"
  - Fix: "leveraging" is on the banned mid-tier list; "significant" twice in one sentence.
- [X] **89.** **L198**
  - Current: "We also provide a valuable resource to the community"
  - Fix: Puffery. "We also release two datasets..."
- [X] **90.** **L200**
  - Current: "allow for significant speedups" ; "In addition to the major speed-up also," ; "Also by providing"
  - Fix: Three additive openers and "significant" again. This paragraph needs a rewrite.
- [X] **91.** **L204**
  - Current: "LUC3D utilizes labeling redundancy" ; "which LUC3D can recover by utilizing reprojection"
  - Fix: "uses". Twice.
- [X] **92.** **L204**
  - Current: "As a result, the user needs only to review the session once. As a result, proofreading labor is reduced. Additionally, using more cameras... Also the GUI provides..."
  - Fix: Four consecutive sentences open with a connective. Cut all four.
- [X] **93.** **L210**
  - Current: "Easily executable 3D pose methods are critical for enabling additional downstream methods"
  - Fix: "critical for enabling" is AI vocabulary.
- [X] **94.** **L210**
  - Current: "LUC3D successfully shifts the practical bottleneck ... allowing for more users to begin their journey towards 3D pose tracking of social behavior."
  - Fix: Generic positive conclusion + "journey". End on the concrete result instead.
- [X] **95.** **L208**
  - Current: "characterizing it precisely benefitted greatly from multi-camera 3D pose estimation"
  - Fix: "required" (you already argued no single view recovers height). Also "benefitted" spelling.
- [X] **96.** **L208**
  - Current: "though we are careful not to overstate this"
  - Fix: Hedging about hedging. Cut; the next sentence already lists what would be needed.
- [X] **97.** **L94**
  - Current: "the solution to the myriad problems caused by the limitations of 2D"
  - Fix: "myriad" is puffery.
- [X] **98.** **L107**
  - Current: "Cross-view ID has been traditionally been solved"
  - Fix: Doubled "been".
- [X] **99.** **L163**
  - Current: "The preceding figures demonstrate the usefulness of 3D multi-animal pose estimation data for understanding social behavior."
  - Fix: Filler topic sentence; the figures so far are about accuracy, not social behavior.
- [X] **100.** **L264**
  - Current: "Calibration is the process by which..."
  - Fix: Textbook opener; fine for Methods but consider trimming.

### New in revision 2

- [ ] **214.** **L246**
  - Current: "This dataset is unique in its level of diversity and emphasis on freely roaming behavior."
  - Fix: Puffery. State what is in it (strains, sexes, enrichment levels) and let the reader judge.
- [ ] **215.** **L88**
  - Current: "Uncertainty from 2D pose methods can be refined with multi-camera approaches"
  - Fix: Uncertainty is reduced, not refined. "Multi-camera approaches reduce the uncertainty of 2D pose estimates."
- [ ] **216.** **L242**
  - Current: "In general, the experiments consisted of placing mice into an enclosure for 5-60 minute intervals and observing behavior."
  - Fix: Vague filler. Either give the per-dataset session lengths (which L246 and L250 already do) or cut.
- [ ] **217.** **L150**
  - Current: "We have demonstrated that there is little difference in the quality of the solvers when comparing Anipose with LUC3D. However LUC3D is able to perform triangulations faster"
  - Fix: This opens the subsection by claiming what the subsection is about to show. Start with the measurement: "Across four solvers ... the range of per-session medians is 2.15 to 2.35 pixels (Figure 2F)." Comma after "However".

---

## 8. Run-on sentences (long and comma-heavy)

Sentences over ~55 words or 6+ commas, excluding pure numeric caption lists. Worst first.

- [X] **101.** **L344** · (100 words, 9 commas)
  - Fix: Split into 3 to 4 sentences: (1) retirement disabled, (2) why, (3) the stitch, (4) how slots are assigned.
- [X] **102.** **L346** · (87 words, 8 commas)
  - Fix: Split at "which is the step-function limit" and at "a target left with fewer than two".
- [X] **103.** **L308** · (81 words, 3 commas)
  - Fix: Split after "disabled". Explain the reason in its own sentence. Move the "with smoothing left enabled..." result to a third.
- [X] **104.** **L226** · (70 words, 4 commas)
  - Fix: Split at "and the resulting reconstruction".
- [X] **105.** **L179** · (69 words)
  - Fix: Split at the semicolon. Also "the males sits" (agreement).
  - Note: Verified fixed in this revision (sentence split; "the males are").
- [X] **106.** **L175** · (65 words, 5 commas)
  - Fix: Split before "so the smaller-bodied sex".
- [ ] **107.** **L298** · (63 words, 9 commas)
  - Fix: Split at "and identity switches". Consider moving the per-k means to a table.
- [X] **108.** **L228** · (61 words)
  - Fix: Acceptable as a definitional list, but fix the stray comma before the first parenthesis.
- [X] **109.** **L378** · (60 words)
  - Fix: See hard fail #6.
  - Note: See #169: the rewrite has new grammar errors.
  - Note: Merged into #255 (same sentence at L378). Fix it there.
- [X] **110.** **L388** · (59 words)
  - Fix: Three "and" clauses plus a semicolon plus a parenthetical inside a parenthetical. Split into three sentences.
- [X] **111.** **L169** · (55 words)
  - Fix: Dangling participle ("Decomposing..." modifies "the male's score"). Restructure: "We decomposed ... The male's score is..."
- [X] **112.** **L388** · (55 words)
  - Fix: Split at "its one cost".
  - Note: Verified fixed in this revision.
- [X] **113.** **L327** · (55 words)
  - Fix: Split at the colon.
  - Note: Verified fixed in this revision.
- [X] **114.** **L144** · (52 words, 8 commas)
  - Fix: Split at "and the excluded frames".
- [X] **115.** **L246** · (30 words, 14 commas)
  - Fix: Missing period after "instances"; two sentences run together.
  - Note: Verified fixed in this revision.
- [X] **116.** **L140** · (39 words, 8 commas)
  - Fix: Two sentences; replace "against".
  - Note: Verified fixed in this revision.
- [X] **117.** **L276** · (38 words, 9 commas)
  - Fix: Split at the colon; consider a table for the three counts.
  - Note: Verified fixed in this revision.
- [X] **118.** **L334** · (40 words, 7 commas)
  - Fix: Split at the semicolon.

Captions L115, L132, L157, L179, L190, L395 are semicolon-chained lists throughout. Nature-style captions do tolerate this, but 13 semicolons in one caption (L181) is well past the norm. Consider periods between panel sub-clauses.

### New in revision 2

- [ ] **218.** **L127** · Comma splice and stray characters
  - Current: "Increasing the number of contributing views leads to more accurate 3D estimates compared with ground truth, scored relative to a camera the solve never saw, error falls from 4.32 pixels with two cameras to 3.34~ pixels with four views (Figure 2E (Top))."
  - Fix: Two sentences. "3.34~ pixels" has a stray space after the tilde. "(Top)" → "(top)"; avoid nested parentheses.
- [ ] **219.** **L290** · 60+ words
  - Current: "Four animals in six cameras exceeds the harness cap ... and was not run, so its cost in Figure 3F is an arithmetic bound drawn with an open marker, from the (A!)^(C-1) = 7,962,624 hypotheses remaining once the global relabeling symmetry is removed up to the as-published (A!)^C."
  - Fix: Split at "so its cost". State the bound's lower and upper ends in their own sentence.
- [X] **220.** **L324** · No punctuation
  - Current: "The two are complementary within a session since they sum to one so plotting both shows the asymmetry directly and the paired Wilcoxon signed-rank test was performed to test the female's share against chance."
  - Fix: "Because the two shares sum to one within a session, plotting both shows the asymmetry directly. A Wilcoxon signed-rank test compared the female's share with 0.5."
- [X] **221.** **L328** · Garbled
  - Current: "Onsets were split by the distance between animals into when they are in proximity of two body lengths and further apart."
  - Fix: "Onsets were split by inter-animal distance into within two body lengths and beyond."
- [X] **222.** **L208** · Comma splices
  - Current: "The male's approach in the moments beforehand looks like directed pursuit, the male stays oriented toward and closing on the female while the female has already stopped moving. The female holding her position and male closing the distance before the pair rears together, resembles a courtship interaction"
  - Fix: Colon or period after "pursuit"; "the male" before "closing"; remove the comma before "resembles".

---

## 9. Style inconsistencies (quick wins)

- [X] **119.** "per cent" remaining at L171, L173, L185 · Everywhere else already uses "%". Nature Methods house style is "%".
- [X] **120.** British vs American spelling mixed · "colour" and "neighbouring" fixed; "Behavioural", "travelling", "grey" remain at L181, tracked as #223. Original: "colour" (L157, L395), "neighbouring" (L388), "Behavioural" (L181), "travelling" (L181) vs "color" (L115), "behavior" everywhere else, "gray" (L157).
- [X] **121.** "luc3d" lowercase (L363, x2) vs "LUC3D" · Standardize. (L132 instance is fixed.)
  - Note: "The LUC3D GUI" is fixed. The one remaining prose instance ("The code for the luc3d", L359) is tracked as #252. URLs are fine lowercase.
- [X] **122.** "3d error" (L125) vs "3D" · Capitalize.
- [X] **123.** "Hard Fight" (L260) vs "HardFight" · Standardize.
- [X] **124.** "Pantopicon" (L367) · Typo for Panopticon.
- [X] **125.** "Mouse-Dyad-10M-11M" (L358 TODO comment) · Stray.
- [X] **126.** Caps for emphasis: "OTHER" (L181), "IS" (L157) · Remove. ("TOWARD" is fixed.) Caps-on-words is a flagged pattern and looks odd in a journal caption.
  - Note: TOWARD is fixed; IS (L157) and OTHER (L181) remain.
### New in revision 2

- [X] **223.** **L179** (Fig 4 caption) · British spellings remaining: "Behavioural" (caption title), "grey". ("travelling" is fixed.)
- [ ] **224.** Numerals for small counts mixed with words · "8 cameras" (L107, L115) vs "eight cameras" (L109, L248); "4 animals" (x5) vs "four animals" (x4); "2 animals" (x3) vs "two mice". Nature style: words for one to nine unless with a unit or in a caption data list.
- [ ] **225.** Multiplication and plus-minus as ASCII · "1.5x" (L179, L190, L390), "+-" (L190 x2, L390), "1280x1024" (L258) → `$\times$`, `$\pm$`. ("230 x 230 x 140" is fixed.)
- [ ] **226.** Frame-rate unit · "fps" (L142, L179, L260, L276), "frames per second" (L244, L248), "30-150fps", "30 FPS", "150 FPS", "60 FPS" (L258). Pick "fps" and use it everywhere; "30-150fps" needs a space and "to".
- [X] **227.** "non-linear" (7x) vs "nonlinear" (L202, L308).
- [X] **228.** "dialog" (L222, L232) vs "dialogue" (L224).
- [ ] **229.** **L185** · "median IDF1 = .989", "= .654" (leading zero); "10.8-fold" in body vs "10.81-fold" in the L192 caption.
- [X] **230.** "mutual upright display" (L320, Methods) vs "social rearing display" (L169, Results) · One name for the event.
- [X] **231.** **L264, L266, L268** · "Aruco" (L264), "ChAruco" (L264, L266), "ChArUco" (L268) · Three spellings; "ChArUco" is the OpenCV name. Also "checker board" and "checkboard" (both L264) → "checkerboard".
- [X] **232.** **L329** "SLEAP-nn (0.3.0)" vs the package name "sleap-nn"; **L246** "SLEAP-Anipose" · Standardize package names.
- [X] **233.** Double spaces · L107, L127, L202, L224, L258 (and bibliography L441, L443).
- [X] **234.** **L258** · Bare URL "(https://github.com/ksseverson57/campy)" → `\url{}`.
- [X] **235.** **L327** · "LUC3D uses n user-specified global identities" → `$n$`.
- [X] **236.** **L329** · "for example two for Mouse-Dyad-10M, using --max_tracks 2" · "for example" contradicts the literal flag. If every run used 2, drop "for example".
- [ ] **237.** TODO comments left in the source · L252, L259, L355, L358, L362 · Fine while drafting; remove before submission.

---

## 10. Typos and grammar caught along the way (not style, but fix while you're in there)

- [X] **127.** **L98**
  - Current: "Proofreading requires requires resolving"
  - Fix: Doubled word.
- [X] **128.** **L100**
  - Current: "lack environmental enrichment because they introduce occlusions, by adding levels of enrichment this dataset highlights"
  - Fix: Comma splice; needs a period or semicolon.
- [X] **129.** **L107**
  - Current: "has been traditionally been solved"
  - Fix: Doubled "been".
- [X] **130.** **L107**
  - Current: "no dropped frames  \citep"
  - Fix: Double space.
- [X] **131.** **L123**
  - Current: "a 2.3 reduction"
  - Fix: "2.3-fold" (you use "-fold" in the next sentence).
  - Note: Verified fixed in this revision.
- [X] **132.** **L123**
  - Current: "While modifying those reprojections ... would result in 48 placements per animal, which is a 1.6-fold reduction"
  - Fix: Sentence fragment (subordinate clause with no main clause).
- [X] **133.** **L127**
  - Current: "relative to each other Figure~\ref{fig2}D."
  - Fix: Parentheses around the figure ref: "relative to each other (Figure~\ref{fig2}D)."
- [X] **134.** **L127**
  - Current: "Error therefore falls as k over the sine"
  - Fix: "therefore" has no antecedent; the previous sentence stated a dependency, not a cause.
- [X] **135.** **L150**
  - Current: "betweem 2.15 to 2.35"
  - Fix: "between 2.15 and 2.35".
- [X] **136.** **L157**
  - Current: "forming the 3D triangulation.."
  - Fix: Double period.
- [X] **137.** **L165**
  - Current: "Rearing is defined increasing head height"
  - Fix: "defined as".
- [X] **138.** **L165**
  - Current: "the animals weight"
  - Fix: "animal's".
- [X] **139.** **L165**
  - Current: "no view turns can turn pixel gaps into"
  - Fix: Garbled; "no view can turn".
- [X] **140.** **L167**
  - Current: "When averaging the likelihood of rearing given the onset of the other animal demonstrates an asymmetric relationships"
  - Fix: No subject; "relationships" should be singular.
- [X] **141.** **L167**
  - Current: "While the female's rearing near the male's onset is already 4.7 times chance..."
  - Fix: Fragment.
- [X] **142.** **L179**
  - Current: "80.\% of displays"
  - Fix: Stray period.
- [X] **143.** **L179**
  - Current: "the males sits"
  - Fix: Agreement.
- [X] **144.** **L185**
  - Current: "Each of the 74 SLAP-2M sessions vary"
  - Fix: "varies".
- [X] **145.** **L185**
  - Current: "more animals does lead to"
  - Fix: "do lead" or "more animals leads to".
- [X] **146.** **L185**
  - Current: "from 3.65 to 4.74~pixels Figure~\ref{fig5}E (middle)"
  - Fix: Parentheses around the figure ref: "(Figure~\ref{fig5}E, middle)".
- [X] **147.** **L204**
  - Current: "from a small number anchor camera views"
  - Fix: "small number of".
- [X] **148.** **L204**
  - Current: "Reprojections can themselves serve as labels, a keypoint labeled across a few views produces..."
  - Fix: Comma splice.
- [X] **149.** **L228**
  - Current: "user instances, (created..."
  - Fix: Stray comma.
- [ ] **150.** **L230**
  - Current: "When an annotation that diverges visibly from its dotted reprojection, this flags"
  - Fix: Garbled subordinate clause.
- [X] **151.** **L232**
  - Current: "offers a choice of output resolution from 360p up to 2K, reports the resulting frame count"
  - Fix: Missing "and".
- [X] **152.** **L234**
  - Current: "the columnar session data introduced in version 2.8 format"
  - Fix: "introduced in format version 2.8".
- [X] **153.** **L246**
  - Current: "The multi dataset was collected"
  - Fix: "multi-animal dataset"?
- [X] **154.** **L246**
  - Current: "(back, mid, side, top, back-left, mid-left, side-left, and top)"
  - Fix: "top" listed twice; 8 views named but only 7 distinct.
- [X] **155.** **L246**
  - Current: "however it is included"
  - Fix: "they are included" (two views).
  - Note: Verified fixed in this revision.
- [X] **156.** **L264**
  - Current: "checker board with bit encodings called Aruco patterns" ; L268 "checkboard"
  - Fix: "ChArUco board" (you use that spelling at L272); "checkerboard".
- [X] **157.** **L292**
  - Current: "The greedy Hungarian method compared against our reimplementation"
  - Fix: Missing "was".
- [X] **158.** **L302**
  - Current: "the cameras are frozen so is more akin to"
  - Fix: "so it is more akin".
- [X] **159.** **L326**
  - Current: "(sign test P = 1.2e-4. Wilcoxon signed-rank ... P = 9.7e-4)"
  - Fix: Period inside parentheses splits the parenthetical; use a semicolon here (one of the few places it belongs).
- [X] **160.** **L318**
  - Current: Subsection title ends with a period
  - Fix: Remove.
- [X] **161.** **L355, L359, L361, L363**
  - Current: `\hyperlink{URL}{URL}`
  - Fix: `\hyperlink` is for internal anchors; you want `\href` or `\url`. These links will not work as written.
- [X] **162.** **L361**
  - Current: calibrat3 documentation points to luc3d-docs
  - Fix: Check whether intentional.
- [X] **163.** **L125**
  - Current: "The reference is proofread 3D reconstruction aligned to the calibration frame."
  - Fix: Missing article ("the proofread").

### New in revision 2

- [ ] **238.** **L173** · Residue from the rewrite: "female initiated" → "female-initiated"; "happens to be" → "is"; "77 per cent of displays" → "75 of 97 displays (77%)"; comma after "So"; "the leader is shorter" → "was shorter".
- [X] **239.** **L169** · "432 out of 539 of the displays" → "432 of 539 displays"; "36 of the 37 sessions (97.3%) with at least one display" → move the percentage after "display" or drop it; "share of initiating" → "share of initiations"; "while the male's is 0.14" is the complement of 0.86 and can go.
- [X] **240.** **L167** · "indicating orientation towards the female and approaching" → "and approach" (noun + noun); "held for at least a quarter of a second" vs "0.25 s" elsewhere.
- [X] **241.** **L123** · "at 10 pixel" → "at a 10-pixel threshold"; "This shows an estimate of the amount of labeling effort reduced by using reprojections" → "This estimates the labeling effort saved by reprojection".
- [X] **242.** **L140** · "In sessions with four-animal and three cameras" → "with four animals and three cameras".
- [X] **243.** **L185** · "how LUC3D tracker's IDF1" → "how the LUC3D tracker's IDF1".
- [X] **244.** **L206** · "using more cameras give the LUC3D cross-view tracker" → "gives".
- [ ] **245.** **L208** · "or a mating assay" vs L175 "mating assays".
- [ ] **246.** **L224** · "(See Supplementary Figure 7 for GUI screenshot)" → "(see Supplementary Figure 7 for a screenshot)".
- [X] **247.** **L230** · "A project holds one skeleton shared across all of its sessions within a project." → "A project has one skeleton, shared across all of its sessions."
- [ ] **248.** **L226** · "Instances can be deleted individually or users can use the custom instance delete prompt" → "or in bulk through the instance-delete dialog, filtered by".
- [ ] **249.** **L246** · "with 8 camera views with between 1-4 animals" → "with eight camera views and one to four animals".
- [ ] **250.** **L264** · "Calibrations for the SLAP-2M and Mouse-Dyad-10M dataset" → "datasets".
- [X] **251.** **L316** · "how many of the detector's missing nodes that the other views could fill in" → drop "that"; "One view cannot triangulate, so recovery at two cameras is zero by construction" → "With two cameras, a keypoint missing in one view leaves a single view, which cannot triangulate, so recovery is zero by construction."
- [ ] **252.** **L359** · "The code for the luc3d" → "The code for LUC3D".
- [ ] **253.** **L96** · "LUC3D relies on triangulation which recovers ... and reprojection which projects" → commas before each "which", or "triangulation, which ..., and reprojection, which ...".

---


### New issues found in revision 3 (main__2_.tex)

- [X] **255.** **L378** · *Duplicate sentence with grammar errors*
  - Current: "It establishes that cross-view identity is absent from those methods, and separately that LUC3D improves within-view performance. This comparison establishes is that the cross-view capability is absent for SLEAP and ByteTrack while also showing that LUC3D also improves performance within single camera views."
  - Fix: Delete the second sentence entirely. The first says the same thing correctly.
- [X] **256.** **L163** · *Doubled word*
  - Current: "rearing occurs as as a synchronized pair interaction"
  - Fix: "as a".
- [X] **257.** **L384** · *Doubled word*
  - Current: "up to to $N = 20$"
  - Fix: "up to $N = 20$".
- [X] **258.** **L226** · *Missing verb*
  - Current: "produced by the cross-view tracker or imported from SLEAP which read-only until converted"
  - Fix: "which are read-only".
- [ ] **259.** **L316** · *Empty Methods subsection*
  - Current: Subsection header "Behavioral analysis of social rearing courtship behavior." with no content below it.
  - Fix: Fill with the behavioral analysis methods, or delete the empty subsection.
- [X] **260.** **L132** (Fig 2 caption, panel A) · *Garbled phrase*
  - Current: "after the user has accepted for modification"
  - Fix: "after the user has accepted or modified them".
- [X] **261.** **L161** · *Subject-verb agreement*
  - Current: "This paper describe a novel 3D social rearing behavior"
  - Fix: "describes". Also "novel" is flagged (#194).
  - [ ] **262.** REVIEW BEHAVIORAL ANALYSIS RESULTS AND METHODS 
  - [ ] **262.** REVIEW CALIBRATION BENCHMARK RESULTS AND METHODS 

## What's working

The Results rewrite of the greedy-vs-exhaustive paragraph (L140) is a model for the rest: one claim per sentence, each method's number in its own clause, no "against". The social-rearing controls paragraph (L175) now reads as an argument with three named alternatives, each closed. The new sampling paragraph (L276) is short and answers the reader's question. The remaining density is in the captions (Fig 2, 3, 4, 6), the Discussion, and the two long Methods paragraphs at L332 and L346, which still narrate an earlier implementation. Fix #164 and #165 first; they are rendering bugs, not style.
