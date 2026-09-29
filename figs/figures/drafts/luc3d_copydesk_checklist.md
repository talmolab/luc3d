# Copydesk review: `main__1_.tex` (LUC3D manuscript)

Line numbers refer to the `.tex` source. Prose scanned: abstract through Supplementary (lines 88 to 390), including figure captions. Bibliography and preamble skipped.

Each item is a checkbox. Tick it off as you fix it (renders as clickable in GitHub, Obsidian, VS Code preview, Typora, Notion). "Fix" is a direction, not wording to paste.

**Progress:** 31 / 163

---

## 0. Headline counts

| Tell | Count | Notes |
|---|---|---|
| Em dashes (`---` or `—`) | 0 | Clean in body. Two `--` used as em-dash stand-ins in captions (see §1). |
| Semicolons | 57 | Heavily concentrated in captions: L181 has 13, L115 has 8, L157 has 7, L132 has 6. |
| "ships" / "shipped" | 12 | L132, L240, L268, L292, L312, L344 (x4), L348, L388, L390 |
| "rests on" | 2 | Both in L278 |
| "against" as a comparison connective ("4.32 against 3.66") | ~54 | The single strongest machine tell in the manuscript. |
| "rather than" | 38 | Second strongest. Often paired with "against" in the same sentence. |
| "so that" | 16 | Chained purpose clauses. |
| "carries / carry / carrying" (data "carrying" a label, sessions "carrying" ground truth) | 18 | Anthropomorphized data. |
| "holds / hold" (a frame "holds" three identities) | 8 | Same family as "carries". |
| Numbered-setup openers ("Two limits belong with this result", "Three controls test...") | 10 | See §5. |

---

## 1. Hard fails (fix regardless of taste)

- [X] **1.** **L181 (Fig 4 caption, panel E)** · *Em-dash substitute*
  - Current: "Facing-pursuit in the same pre-onset window -- each animal's facing axis dotted with..."
  - Fix: Colon or period.
- [X] **2.** **L395 (Fig 6 caption, panel F)** · *Em-dash substitute*
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
- [ ] **18.** **L390**
  - Current: "The application ships $N = 20$"
  - Fix: "The default is $N = 20$"

"Shipped" is doing double duty for "default" and "released/deployed". Pick one plain word for each and be consistent.

---

## 3. "rests on"

- [ ] **19.** **L278**
  - Current: "the held-out scoring of Figure 2E rests on 884,697,424 solves"
  - Fix: "requires" / "is computed from"
- [ ] **20.** **L278**
  - Current: "The every-frame measurement in Figure 2 rests on 2,862,001,740 two-anchor solves"
  - Fix: Same.

---

## 4. "against" as a comparison word

This is the tic that will get the paper flagged fastest. A human scientist writes "4.32 px with two cameras versus 3.34 px with four" or "compared with". The manuscript uses "X against Y" for nearly every paired number. Representative instances (not exhaustive; ~54 total):

- [ ] **21.** **L140**
  - Current: "misgroups 926 frames against exhaustive enumeration's 1,309, 20.3 against 28.6 per 100,000, and ... 0 against 880 per 100,000" (three in one sentence)
- [ ] **22.** **L146**
  - Current: "0.8614 against 0.8613"
- [ ] **23.** **L152**
  - Current: (title of subsection 2-3 is fine; body) "0.644 to 0.688 at k=2 ... against 0.861 for the full rig" (L302)
- [X] **24.** **L167**
  - Current: "1.08 within two body lengths and 0.97 beyond" is fine; but L175 "90.1~mm against 84.2~mm"
- [X] **25.** **L171**
  - Current: "the female's median share is 0.86 against the male's 0.14"
- [ ] **26.** **L181**
  - Current: "male median -0.708 against female -0.058" ; "0.857 (female) against 0.143 (male)" ; "against 6.2\% for the reverse"
- [ ] **27.** **L294**
  - Current: "2.7 and 5.5 seconds per frame against 11 to 16 milliseconds"
- [ ] **28.** **L302**
  - Current: "against 0.861 for the full rig"
- [ ] **29.** **L344**
  - Current: "against the shipped 60 frames"
- [ ] **30.** **L380**
  - Current: "LUC3D against per-camera trackers"
- [ ] **31.** **L390**
  - Current: "413 switches against 511 at N=10, mean cross-view IDF1 0.861 against 0.850 and median 0.915 against 0.913" ; "(-0.183 against -0.138)"
- [ ] **32.** **L395**
  - Current: Caption uses "against" 6+ times: "Within-view against cross-view IDF1", "no eviction 0.00460\% against stale 20" etc.
- [ ] **33.** **L132**
  - Current: Caption: "every label by hand against the placements still needed", "3D error against the cameras in the solve", "6.3 against 29.0 us", "44.0 against 228.8 us"
- [ ] **34.** **L157**
  - Current: Caption: "misgroups 926 frames against exhaustive's 1,309"
- [ ] **35.** **L192**
  - Current: "detection quality against difficulty"

Also L109 "compared directly against that camera's video" and L226 same phrasing (fine in isolation; noted because it adds to the density).

Suggested fix: do a global search for " against " and replace with "versus", "vs.", "compared with", "and", or restructure ("fell from 4.32 px to 3.34 px"). Keep "against" only where something is literally being tested against a reference (e.g. "against proofread ground truth").

---

## 5. Numbered-setup sentence openers and one-word dramatic fragments

A recurring Claude move: announce a count, then enumerate. Ten instances is a pattern.

- [ ] **36.** **L144**
  - Current: "Two limits belong with this result."
  - Fix: "This result has two caveats." or just start with the first caveat. "Belong with" is not how anyone says this.
- [X] **37.** **L175**
  - Current: "Three controls test the obvious alternatives to a genuine sex difference."
  - Fix: "We tested three alternative explanations."
- [ ] **38.** **L228**
  - Current: "Three instance types are distinguished throughout the interface:"
  - Fix: Acceptable in Methods; leave or say "The interface has three instance types:".
- [ ] **39.** **L292**
  - Current: "Two further properties complete the association."
  - Fix: Cut the sentence; just state the two properties.
- [ ] **40.** **L296**
  - Current: "Two conventions separate the arms."
  - Fix: "The two methods are scored differently in two ways."
- [ ] **41.** **L344**
  - Current: "Two gates anchor the re-runs to the shipped measurement:"
  - Fix: "We checked the re-runs two ways:"
- [ ] **42.** **L348**
  - Current: "Three coordinated changes were evaluated against that defect."
  - Fix: "We evaluated three changes."
- [ ] **43.** **L390**
  - Current: "Two features of the sweep argue that the effect is specific to anchor freshness"
  - Fix: "The sweep suggests the effect comes from anchor freshness, for two reasons."
- [ ] **44.** **L140**
  - Current: "It does not." (standalone fragment after "We investigated whether the cheap and greedy procedure gives up accuracy")
  - Fix: Merge: "It does not give up accuracy: over the 4.57M frames..."
- [ ] **45.** **L146**
  - Current: "The term is necessary. The association does not survive without it:"
  - Fix: Two punchy sentences saying the same thing. Keep one.
- [X] **46.** **L171**
  - Current: "The female starts most of the displays." (one-line topic sentence immediately re-stated with numbers in the next sentence)
  - Fix: Fold into the numeric sentence.
- [ ] **47.** **L138**
  - Current: "That is $A!$ per view and therefore $(A!)^C$ per frame"
  - Fix: Fine mathematically; the "That is..." opener is a tic when it recurs. Minor.

---

## 6. Literary / metaphorical verbs on data (the "Claude voice")

These are the phrases a reviewer will read as machine prose: data that "carries", "holds", "sits", "lands", "hands", "buys", "earns", "survives".

- [ ] **48.** **L109**
  - Current: "the frame holds three identities" ... "The one left over is a duplicate detection ... which one-to-one assignment correctly refuses."
  - Fix: "the frame contains three identities" / "The remaining detection is a duplicate ... which one-to-one assignment rejects."
- [ ] **49.** **L115**
  - Current: "this frame holds 25 detections carrying 21 distinct track names"
  - Fix: "contains 25 detections with 21 distinct track names"
- [ ] **50.** **L125**
  - Current: "lands a median 4.74~mm"
  - Fix: "has a median error of 4.74 mm"
- [ ] **51.** **L127**
  - Current: "the two anchor views for reprojection can also reduce labor cost" (fine) but "So this means that strategic camera placement..."
  - Fix: Cut "So this means that".
- [ ] **52.** **L140**
  - Current: "the 42 SLAP-2M sessions that carry both pool detections and proofread ground truth"
  - Fix: "that have both"
- [ ] **53.** **L142**
  - Current: "the bound is generous to the published method twice over"
  - Fix: "the bound favors the published method in two ways"
- [ ] **54.** **L142**
  - Current: "one second of 50~fps video would cost more than a day"
  - Fix: "would take more than a day to process"
- [ ] **55.** **L144**
  - Current: "which is to say exactly the frames association finds hardest"
  - Fix: "i.e. the hardest frames for association"
- [ ] **56.** **L146**
  - Current: "doubling the ratio to twelve buys 42 fewer switches and no IDF1"
  - Fix: "reduces switches by 42 with no change in IDF1"
- [ ] **57.** **L146**
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
- [ ] **61.** **L181**
  - Current: "so a leg that starts orange and ends blue IS the statement that one animal is carrying two identities" (L157, Fig 3 caption)
  - Fix: Drop the caps and the "IS the statement" construction: "a leg that changes color marks one animal carrying two identities."
- [ ] **62.** **L181, L192**
  - Current: "the wall nearest the viewer is drawn as edges only so the interior is seen through clear air" (appears twice)
  - Fix: "so the interior is visible"
- [ ] **63.** **L210**
  - Current: "The social rearing analysis also surfaced a sex-specific asymmetry"
  - Fix: "revealed"
- [ ] **64.** **L226**
  - Current: "The proofreader's working signal is the reprojection error, surfaced for each keypoint"
  - Fix: "shown"
- [ ] **65.** **L278**
  - Current: "286,200,174 keypoints behind Figures 2B and D, 17,013,412 behind Figures 2E to G, and 187,134,382 keypoint comparisons behind Figure 5"
  - Fix: "underlying" or "used for". "Behind" three times.
- [ ] **66.** **L280**
  - Current: "The sampled density was verified rather than assumed."
  - Fix: "We verified that the subsample is representative."
- [ ] **67.** **L280**
  - Current: "discards redundancy rather than information"
  - Fix: Acceptable, but it is the rather-than tic again.
- [ ] **68.** **L296**
  - Current: "That threading is scaffolding rather than part of the published method"
  - Fix: "That threading is not part of the published method"
- [ ] **69.** **L296**
  - Current: "so each rate carries its own denominator"
  - Fix: "so the two rates have different denominators"
- [ ] **70.** **L312**
  - Current: "The browser deployment that motivates this work forecloses a compiled implementation"
  - Fix: "rules out"
- [ ] **71.** **L340**
  - Current: "the comparison as first run charged them for constraints LUC3D's arm does not face"
  - Fix: "penalized them for constraints LUC3D does not have"
- [ ] **72.** **L344**
  - Current: "each ByteTrack id is bound at birth to one of two slots"
  - Fix: "assigned when first seen"
- [ ] **73.** **L344**
  - Current: "The never-retire knob alone reaches within-view IDF1 0.272"
  - Fix: "Disabling retirement alone gives"
- [ ] **74.** **L382**
  - Current: "We state that rather than pooling it away."
  - Fix: Cut. The sentence before already reports the negative result.
- [ ] **75.** **L384**
  - Current: "This is close to arithmetic rather than a contest"
  - Fix: See hard fail #6.
- [ ] **76.** **L390**
  - Current: "so the material step is from no eviction to any eviction rather than the choice of window"
  - Fix: "so what matters is enabling eviction at all, not the window length"
- [ ] **77.** **L390**
  - Current: "Traversing the same axis in the opposite direction is monotonically harmful across four orders of magnitude"
  - Fix: "Moving the other way (retaining stale evidence longer) monotonically increases switches"
- [ ] **78.** **L390**
  - Current: "its one cost being a deeper worst single-session change"
  - Fix: "at the cost of a larger worst-case drop in one session"
- [ ] **79.** **L148**
  - Current: "For further characterization ... (see Supplementary ...)."
  - Fix: Sentence has no main verb. Rewrite as "Supplementary Figure 6 and Sections ... compare the LUC3D tracker with SLEAP and ByteTrack..."
- [ ] **80.** **L138**
  - Current: "a cheap and greedy approach" / L140 "the cheap and greedy procedure"
  - Fix: "Cheap" is editorializing; "greedy" alone is the technical term.
- [ ] **81.** **L119**
  - Current: Subsection title "Buy two get N free: reprojection speeds up the labeling process"
  - Fix: Cute-title pattern. Your call; Nature Methods reviewers may not love it.

"Arm" (benchmark arm, LUC3D's arm, the greedy arms) appears throughout L294 to L396. It's borrowed from clinical-trial language and reads oddly in a software benchmark. Consider "method" or "condition".

---

## 7. Jargon, puffery, and filler (the abstract, intro, and discussion are the worst offenders)

- [ ] **82.** **L88 (abstract)**
  - Current: "This tool will allow for the widespread proliferation of 3D pose estimation techniques for studying social behavior while reducing the cost of entry for neuroscience labs across the world."
  - Fix: Promotional. "LUC3D lowers the barrier to 3D pose estimation for labs without engineering support."
- [ ] **83.** **L88**
  - Current: "multiple comprehensive datasets"
  - Fix: "two large datasets" (you name them later; "comprehensive" is empty).
- [ ] **84.** **L88**
  - Current: "In addition, we present... Also, a protocol..."
  - Fix: Two consecutive additive openers. Merge.
- [ ] **85.** **L98**
  - Current: "two massive datasets that serve as challenging benchmarks"
  - Fix: "two large datasets" / drop "serve as" (copula avoidance).
- [ ] **86.** **L100**
  - Current: "two comprehensive datasets" ; "an ideal candidate for benchmarking"
  - Fix: Repeats abstract; "ideal candidate" is AI vocabulary. Same phrase again at L248.
- [ ] **87.** **L100**
  - Current: "In addition to new software tools, this paper presents"
  - Fix: Third "in addition" in 12 lines.
- [ ] **88.** **L200**
  - Current: "speed up ... significantly by leveraging reprojection-aided labeling ... which would otherwise require significant manual labor"
  - Fix: "leveraging" is on the banned mid-tier list; "significant" twice in one sentence.
- [ ] **89.** **L200**
  - Current: "We also provide a valuable resource to the community"
  - Fix: Puffery. "We also release two datasets..."
- [ ] **90.** **L202**
  - Current: "allow for significant speedups" ; "In addition to the major speed-up also," ; "Also by providing"
  - Fix: Three additive openers and "significant" again. This paragraph needs a rewrite.
- [ ] **91.** **L206**
  - Current: "LUC3D utilizes labeling redundancy" ; "which LUC3D can recover by utilizing reprojection"
  - Fix: "uses". Twice.
- [ ] **92.** **L208**
  - Current: "As a result, the user needs only to review the session once. As a result, proofreading labor is reduced. Additionally, using more cameras... Also the GUI provides..."
  - Fix: Four consecutive sentences open with a connective. Cut all four.
- [ ] **93.** **L212**
  - Current: "Easily executable 3D pose methods are critical for enabling additional downstream methods"
  - Fix: "critical for enabling" is AI vocabulary.
- [ ] **94.** **L212**
  - Current: "LUC3D successfully shifts the practical bottleneck ... allowing for more users to begin their journey towards 3D pose tracking of social behavior."
  - Fix: Generic positive conclusion + "journey". End on the concrete result instead.
- [ ] **95.** **L210**
  - Current: "characterizing it precisely benefitted greatly from multi-camera 3D pose estimation"
  - Fix: "required" (you already argued no single view recovers height). Also "benefitted" spelling.
- [ ] **96.** **L210**
  - Current: "though we are careful not to overstate this"
  - Fix: Hedging about hedging. Cut; the next sentence already lists what would be needed.
- [ ] **97.** **L94**
  - Current: "the solution to the myriad problems caused by the limitations of 2D"
  - Fix: "myriad" is puffery.
- [ ] **98.** **L107**
  - Current: "Cross-view ID has been traditionally been solved"
  - Fix: Doubled "been".
- [X] **99.** **L163**
  - Current: "The preceding figures demonstrate the usefulness of 3D multi-animal pose estimation data for understanding social behavior."
  - Fix: Filler topic sentence; the figures so far are about accuracy, not social behavior.
- [ ] **100.** **L266**
  - Current: "Calibration is the process by which..."
  - Fix: Textbook opener; fine for Methods but consider trimming.

---

## 8. Run-on sentences (long and comma-heavy)

Sentences over ~55 words or 6+ commas, excluding pure numeric caption lists. Worst first.

- [X] **101.** **L344** · (100 words, 9 commas)
  - Fix: Split into 3 to 4 sentences: (1) retirement disabled, (2) why, (3) the stitch, (4) how slots are assigned.
- [ ] **102.** **L348** · (87 words, 8 commas)
  - Fix: Split at "which is the step-function limit" and at "a target left with fewer than two".
- [ ] **103.** **L310** · (81 words, 3 commas)
  - Fix: Split after "disabled". Explain the reason in its own sentence. Move the "with smoothing left enabled..." result to a third.
- [ ] **104.** **L226** · (70 words, 4 commas)
  - Fix: Split at "and the resulting reconstruction".
- [ ] **105.** **L181** · (69 words)
  - Fix: Split at the semicolon. Also "the males sits" (agreement).
- [X] **106.** **L175** · (65 words, 5 commas)
  - Fix: Split before "so the smaller-bodied sex".
- [ ] **107.** **L302** · (63 words, 9 commas)
  - Fix: Split at "and identity switches". Consider moving the per-k means to a table.
- [ ] **108.** **L228** · (61 words)
  - Fix: Acceptable as a definitional list, but fix the stray comma before the first parenthesis.
- [ ] **109.** **L384** · (60 words)
  - Fix: See hard fail #6.
- [ ] **110.** **L388** · (59 words)
  - Fix: Three "and" clauses plus a semicolon plus a parenthetical inside a parenthetical. Split into three sentences.
- [X] **111.** **L169** · (55 words)
  - Fix: Dangling participle ("Decomposing..." modifies "the male's score"). Restructure: "We decomposed ... The male's score is..."
- [ ] **112.** **L390** · (55 words)
  - Fix: Split at "its one cost".
- [ ] **113.** **L340** · (55 words)
  - Fix: Split at the colon.
- [ ] **114.** **L144** · (52 words, 8 commas)
  - Fix: Split at "and the excluded frames".
- [ ] **115.** **L246** · (30 words, 14 commas)
  - Fix: Missing period after "instances"; two sentences run together.
- [ ] **116.** **L140** · (39 words, 8 commas)
  - Fix: Two sentences; replace "against".
- [ ] **117.** **L278** · (38 words, 9 commas)
  - Fix: Split at the colon; consider a table for the three counts.
- [ ] **118.** **L336** · (40 words, 7 commas)
  - Fix: Split at the semicolon.

Captions L115, L132, L157, L181, L192, L395 are semicolon-chained lists throughout. Nature-style captions do tolerate this, but 13 semicolons in one caption (L181) is well past the norm. Consider periods between panel sub-clauses.

---

## 9. Style inconsistencies (quick wins)

- [ ] **119.** "per cent" (23x, spelled out, British) vs "\%" (19x) · Body uses "per cent"; captions use "%". Pick one. Nature Methods house style is "%".
- [ ] **120.** British vs American spelling mixed · "colour" (L157, L395), "neighbouring" (L388), "Behavioural" (L181), "travelling" (L181) vs "color" (L115), "behavior" everywhere else, "gray" (L157).
- [ ] **121.** "luc3d" lowercase (L132, L365) vs "LUC3D" · Standardize.
- [ ] **122.** "3d error" (L125) vs "3D" · Capitalize.
- [ ] **123.** "Hard Fight" (L260) vs "HardFight" · Standardize.
- [ ] **124.** "Pantopicon" (L369) · Typo for Panopticon.
- [ ] **125.** "Mouse-Dyad-10M-11M" (L360 TODO comment) · Stray.
- [ ] **126.** Caps for emphasis: "TOWARD" (L181), "OTHER" (L181), "IS" (L157) · Remove. Caps-on-words is a flagged pattern and looks odd in a journal caption.

---

## 10. Typos and grammar caught along the way (not style, but fix while you're in there)

- [ ] **127.** **L98**
  - Current: "Proofreading requires requires resolving"
  - Fix: Doubled word.
- [ ] **128.** **L100**
  - Current: "lack environmental enrichment because they introduce occlusions, by adding levels of enrichment this dataset highlights"
  - Fix: Comma splice; needs a period or semicolon.
- [ ] **129.** **L107**
  - Current: "has been traditionally been solved"
  - Fix: Doubled "been".
- [ ] **130.** **L107**
  - Current: "no dropped frames  \citep"
  - Fix: Double space.
- [ ] **131.** **L123**
  - Current: "a 2.3 reduction"
  - Fix: "2.3-fold" (you use "-fold" in the next sentence).
- [ ] **132.** **L123**
  - Current: "While modifying those reprojections ... would result in 48 placements per animal, which is a 1.6-fold reduction"
  - Fix: Sentence fragment (subordinate clause with no main clause).
- [ ] **133.** **L127**
  - Current: "relative to each other Figure 2D."
  - Fix: Missing parentheses around the figure ref.
- [ ] **134.** **L127**
  - Current: "Error therefore falls as k over the sine"
  - Fix: "therefore" has no antecedent; the previous sentence stated a dependency, not a cause.
- [ ] **135.** **L152**
  - Current: "betweem 2.15 to 2.35"
  - Fix: "between 2.15 and 2.35".
- [ ] **136.** **L157**
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
- [X] **142.** **L181**
  - Current: "80.\% of displays"
  - Fix: Stray period.
- [X] **143.** **L181**
  - Current: "the males sits"
  - Fix: Agreement.
- [ ] **144.** **L187**
  - Current: "Each of the 74 SLAP-2M sessions vary"
  - Fix: "varies".
- [ ] **145.** **L187**
  - Current: "more animals does lead to"
  - Fix: "do lead" or "more animals leads to".
- [ ] **146.** **L187**
  - Current: "4.74~px Figure 5E (middle)"
  - Fix: Missing parentheses.
- [ ] **147.** **L206**
  - Current: "from a small number anchor camera views"
  - Fix: "small number of".
- [ ] **148.** **L206**
  - Current: "Reprojections can themselves serve as labels, a keypoint labeled across a few views produces..."
  - Fix: Comma splice.
- [ ] **149.** **L228**
  - Current: "user instances, (created..."
  - Fix: Stray comma.
- [ ] **150.** **L232**
  - Current: "When an annotation that diverges visibly from its dotted reprojection, this flags"
  - Fix: Garbled subordinate clause.
- [ ] **151.** **L234**
  - Current: "offers a choice of output resolution from 360p up to 2K, reports the resulting frame count"
  - Fix: Missing "and".
- [ ] **152.** **L236**
  - Current: "the columnar session data introduced in version 2.8 format"
  - Fix: "introduced in format version 2.8".
- [ ] **153.** **L248**
  - Current: "The multi dataset was collected"
  - Fix: "multi-animal dataset"?
- [ ] **154.** **L248**
  - Current: "(back, mid, side, top, back-left, mid-left, side-left, and top)"
  - Fix: "top" listed twice; 8 views named but only 7 distinct.
- [ ] **155.** **L248**
  - Current: "however it is included"
  - Fix: "they are included" (two views).
- [ ] **156.** **L266**
  - Current: "checker board with bit encodings called Aruco patterns" ; L268 "checkboard"
  - Fix: "ChArUco board" (you use that spelling at L272); "checkerboard".
- [ ] **157.** **L294**
  - Current: "The greedy Hungarian method compared against our reimplementation"
  - Fix: Missing "was".
- [ ] **158.** **L306**
  - Current: "the cameras are frozen so is more akin to"
  - Fix: "so it is more akin".
- [ ] **159.** **L328**
  - Current: "(sign test P = 1.2e-4. Wilcoxon signed-rank ... P = 9.7e-4)"
  - Fix: Period inside parentheses splits the parenthetical; use a semicolon here (one of the few places it belongs).
- [ ] **160.** **L320**
  - Current: Subsection title ends with a period
  - Fix: Remove.
- [ ] **161.** **L361, L365, L367, L369**
  - Current: `\hyperlink{URL}{URL}`
  - Fix: `\hyperlink` is for internal anchors; you want `\href` or `\url`. These links will not work as written.
- [ ] **162.** **L367**
  - Current: calibrat3 documentation points to luc3d-docs
  - Fix: Check whether intentional.
- [ ] **163.** **L125**
  - Current: "The reference is proofread 3D reconstruction aligned to the calibration frame."
  - Fix: Missing article ("the proofread").

---

## What's working

The Methods sections (L274 onward) are unusually rigorous about stating what was measured, on which frames, with which denominators. The caveats in L144 and L380 to L384 about where the exhaustive comparison does and does not apply are exactly the kind of honesty reviewers reward. The behavioral section has real specificity (539 displays, 37 of 56 sessions, 432 female-led) rather than performed specificity. The core problem is not the science or the structure; it's a surface layer of machine phrasing ("against", "rather than", "ships", "carries", numbered openers) laid over it, plus a Discussion that slides into promotional register. Strip the tics and the paper underneath is solid.
