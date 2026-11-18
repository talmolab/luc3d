# Results so far (29 October 2026)

## In short

- **Small rigs (one cage, ~30 cm, e.g. ChronicRecord): the calib.io 300×200 coarse
  board (14 × 9 squares of 20 mm, P/N CCT300200C, $137), which the lab already has.**
  On the real ChronicRecord recording it gives 0.12 % ruler error (0.3 mm over 24 cm),
  and the same 3D points move by 0.04 mm between repeated calibrations. In a copy of the
  rig every coarse board from 200×150 to 400×300 did equally well (0.03–0.04 mm 3D error).
  For a tighter cage the 200×150 coarse ($132) is the same thing smaller.
- **Medium rigs (an arena of ~0.5–1 m, 8 cameras): the 300×200 or 400×300 coarse, both
  owned.** In a copy of the 8-camera arena rig all six boards tried gave 0.06–0.10 mm 3D
  error; the real May 2026 recording with the 300×200 coarse gives 0.12 % ruler error and
  0.13 mm 3D spread.
- **Large rigs (18 cameras, marmoset cages): the 600×400 coarse (40 mm squares), owned.**
  In a copy of the 18-camera rig the 600×400 coarse, the 800×600 coarse and the 9 × 15
  custom board all gave 0.13–0.19 mm, no better than smaller boards. **The real 18-camera
  rig's problem was the lens model, not the board:** calibrated with calibrat3 (lens
  centre free, two distortion terms) instead of sleap-anipose's solver (lens centre fixed
  at the image centre, one term), the same recording with the same printed board goes from
  0.48 % to 0.13 % ruler error and from 0.36 to 0.05 mm 3D spread (details below).
- **No fine boards, and no 9 × 15 custom board.** Fine boards were at best 0.02 mm better
  (once), stopped being readable at distances where coarse boards still were (7.5 mm
  squares were unreadable from ChronicRecord's farther cameras), and 4 of 12
  whole-recording calibrations with them failed or diverged in aniposelib, against none of
  20 with coarse or printed boards. The 9 × 15 board scored the same as the coarse board on
  the same plate, for $53–60 more as a custom order.
- **What matters more than the board:** recording 45–60 s that covers the whole space
  with every camera (30-second recordings with poor coverage were the ones that failed),
  synchronized cameras (Polina's rig dropped frames), a flat board, and the calibration
  tool: calibrat3's free principal point fixes the 10-camera marmoset rig (0.15 vs 0.49 px).
- **So nothing needs buying before the real test.** The protocol can be run now with the
  owned 300×200, 400×300 and 600×400 coarse boards plus the printed 8 × 11, which settles
  printed vs aluminium and board size on each rig in one sitting. Buy a 200×150 coarse
  ($132) only if a cage is too small for the 300×200.

These recommendations rest on simulations for the board-vs-board part (no recording
compares boards on one rig in one sitting yet) and on 15 real recordings for the rest.


## What exists today

**Calibration tool.** The campy rigs calibrate with **calibrat3** (the browser app;
ChronicRecord 2026-10-26, campy-live 2026-10-20, the 10-camera marmoset rig 2026-07-21);
older recordings were calibrated with **sleap-anipose** (`slap-calibrate`, i.e. aniposelib).
Both write the anipose `calibration.toml` LUC3D loads. This study calibrates with
aniposelib (the sleap-anipose call) and can also drive calibrat3 headless; every
calibration, including the ones saved with each recording at the time, is scored the
same way, on this study's detections (OpenCV's ChArUco detector). calibrat3 itself
reports lower errors on its own detections: on ChronicRecord it printed 0.08 px for the
calibration that scores 0.30 px here (its headless run through this study reproduced
both numbers), so compare numbers within these reports, not with what the tools print.

**Boards the lab has used** (from 20+ recordings; physical boards not checked):

| Board | Squares | Square / marker | Markers | Used by |
|---|---|---|---|---|
| Printed 8 × 11 (letter paper) | 8 × 11 | 24 / 18.75 mm | 4×4 | almost everything 2022–2026: SLAP, the 18-camera rig, 14/15-camera rigs, DoublePoke, Rig205, CD1F10, the 8-camera arena rig until April 2026, Anwesha's rig (NAS) |
| calib.io 300×200 coarse | 14 × 9 | 20 / 15 mm | 5×5 | 8-camera arena rig from May 2026, Polina's rig, ChronicRecord, campy-live |
| calib.io 400×300 coarse | 12 × 9 | 30 / 22 mm | 5×5 | 5-camera marmoset rig (2025-04-01) |
| calib.io 600×400 coarse | 14 × 9 | 40 / 30 mm | 5×5 | 10-camera marmoset rig (2026-07-21) |

No fine board and no 9 × 15 board has ever been recorded, so **no existing recording
compares boards on the same rig in the same sitting**. The full inventory (about 55
recordings on the Mac, Google Drive and the NAS, which are on disk and which are
online-only) is in the shared notes folder of this work
(`calibration-recordings-inventory.md`).

## What the existing recordings show

Fifteen recordings from nine rigs were re-analysed (`studies/existing-recordings.toml`; full report and figures in `results/existing-recordings/report.md`).
Each was calibrated whole, in 3 disjoint parts (interleaved 5-second blocks, each scored
on the other two), and from its first 10, 20, 30 … seconds. "Ruler error" is the error of
long distances across the board triangulated from frames the calibration did not use;
"3D spread" is how far the same 3D points move between the 3 part-calibrations.

| Rig | Cameras | Board | Length | Board found | Reprojection (here / saved at the time) | Ruler error | 3D spread | Camera position spread |
|---|---|---|---|---|---|---|---|---|
| ChronicRecord (cage) | 4 | calib.io 300×200 coarse | 60 s | 92 % | 0.23 / 0.30 px | 0.12 % | 0.04 mm | 0.3 mm |
| 8-camera arena, 2026-05-06 | 8 | calib.io 300×200 coarse | 120 s | 100 % | 0.32 / 0.41 px | 0.12 % | 0.13 mm | 0.6 mm |
| 8-camera arena, 2026-03-19 | 8 | printed 8 × 11 | 30 s | 79 % | 0.18 / 0.38 px | 0.13 % | 0.05 mm | 0.7 mm |
| 8-camera arena, 2026-04-28 | 8 | printed 8 × 11 | 30 s | 99 % | 0.23 / 0.48 px | 0.13 % | 1.66 mm | one part failed |
| SLAP, 2022-10-19 | 8 | printed 8 × 11 | 92 s | 100 % | 0.33 / 0.59 px | 0.35 % | 1.06 mm | 1.0 mm |
| SLAP, 2022-10-07 | 8 | printed 8 × 11 | 90 s | 98 % | 0.29 / 0.55 px | 0.17 % | 0.62 mm | 1.1 mm |
| CD1F10 | 5 | printed 8 × 11 | 22 s | 59 % | 0.33 / 0.61 px | 0.15 % | 0.35 mm | 1.4 mm |
| Rig205 (3 cameras, 120 fps) | 3 | printed 8 × 11 | 88 s | 43 % | 0.41 / 0.38 px | 2.1 % | 4.6 mm | 8.5 mm |
| Marmoset, 5 cameras | 5 | calib.io 400×300 coarse | 60 s | 93 % | 1.03 / 0.93 px | 1.1 % | 8.1 mm | 8.6 mm |
| Marmoset, 10 cameras | 10 | calib.io 600×400 coarse | 60 s | 39 % | 0.49 / **0.15** px | 0.27 % | 0.90 mm | 15.5 mm |
| 18-camera rig, 2024-12-06 | 17 | printed 8 × 11 | 180 s | 40 % | 1.26 / 1.49 px | 0.48 % | 0.36 mm | 2.8 mm |
| 18-camera rig, 2024-11-19 | 18 | printed 8 × 11 | 150 s | 45 % | 1.87 / 1.97 px | 0.55 % | 0.53 mm | 3.8 mm |
| Polina's rig (start / end) | 7 of 8 | calib.io 300×200 coarse | 38 / 36 s | 75 / 69 % | 1.14 / 0.97 px | 0.35 / 0.79 % | 0.43 / 1.03 mm | 4.3 / 4.8 mm |

What this says:

1. **On small and medium rigs a good recording gives a good calibration with either
   board.** ChronicRecord, the 8-camera arena, SLAP and CD1F10 all reach a held-out ruler
   error of 0.12–0.17 % (0.3 mm over 20 cm; SLAP 2022-10-19 0.35 %).
2. **Repeatability is where the recordings differ.** The two calib.io recordings
   (ChronicRecord, the May arena recording) move 3D points by 0.04 and 0.13 mm between
   part-calibrations; the printed-board recordings by 0.05–1.7 mm, and one 10-second part
   of a 30-second printed-board recording failed outright. But the calib.io recordings
   were also longer and better covered, so this does not isolate the board.
3. **How long to record:** on the medium rigs the held-out ruler error stops improving
   after about 20–45 seconds at 10 frames per second (SLAP: 0.27 % from the first 10 s,
   0.15–0.17 % from 45 s on); ChronicRecord's is flat from 10 s. Very short recordings
   (30 s, some cameras seeing the board in only a quarter of the frames) are where parts
   fail.
4. **Large rigs and few-camera rigs are where calibrations are poor today:** the
   18-camera rig (1.3–1.9 px with the printed board), the 5-camera marmoset rig (1 px,
   1.1 % ruler error, 3D spread 8 mm) and Rig205 (3 cameras, 2 % ruler error). On the
   18-camera rig the cause turned out to be the calibration tool (next section); the other
   two have not been checked that way yet.
5. **Proofread poses barely notice calibration differences on SLAP.** Triangulating the
   proofread poses of five 2022-10-19 SLAP sessions (6 cameras), each calibration gives a
   leave-one-camera-out error of 3.98–4.12 px; the calibration saved at the time 4.12 px,
   the re-calibration here 3.99 px, and calibrations from only the first 20 s already 3.99 px.
   Label noise (about 4 px) dominates. CD1F10's 4 proofread cameras: 3.64–3.86 px.
6. **The calibration tool matters as much as the board here.** On the same detections,
   aniposelib re-run here halves the reprojection error of the calibration saved at the
   time on SLAP, the 8-camera arena and CD1F10 (about 0.3 vs 0.55 px), and calibrat3's
   free principal point is clearly better on the 10-camera marmoset rig (0.15 vs 0.49 px;
   its cameras are cropped off-centre, which a fixed image-centre principal point cannot fit).
7. **Data problems found:** in Polina's rig, Camera1 dropped frames (fewer frames than the
   others, so it is out of step and was left out) and the cameras moved between the start
   and end calibrations; the remaining ~1 px suggests other cameras dropped frames too.
   Rig205's second recording finds the board in only 7 % of frames.

## The 18-camera rig: lens model, not board

The 2024-12-06 recording (17 cameras, the printed 8 × 11 board) was calibrated with both
tools on the same three disjoint parts, each part scored on the other two, all on this
study's detections (`studies/cam18-tools.toml`, `results/cam18-tools/report.md`):

| Calibration tool | Reprojection | Held-out reprojection | Ruler error | Board fit | 3D spread | Camera position spread |
|---|---|---|---|---|---|---|
| aniposelib (sleap-anipose): lens centre fixed, k1 | 1.09 px | 1.25 px | 0.48 % | 0.77 mm | 0.36 mm | 2.8 mm |
| calibrat3: lens centre free, k1 + k2 | 0.45 px | 0.46 px | 0.13 % | 0.20 mm | 0.05 mm | 0.2 mm |

On the whole recording: aniposelib 1.26 px, calibrat3 0.46 px, the calibration saved in
2024 1.49 px. calibrat3 puts every camera's lens centre off the image centre (840, 600) in
the same direction: x 869–905, y 618–656 across all 17 cameras (median 45 px right, 37 px
down), which a fixed-centre model cannot represent.

**This supports the lens-model explanation, not board flatness:** once the lens centre is
free, the same printed board fits a flat plane to 0.20 mm and the rig calibrates as well
as the small and medium rigs (0.13 % ruler error), so the board was flat enough. The
practical fix for the 18-camera rig is to calibrate it with calibrat3 (or any tool with a
free lens centre); a new board is not needed for it.

## Simulations: boards compared in copies of three rigs

Each catalogue board was rendered into a copy of a real rig (its real cameras and lenses),
held along the real board motion from that rig's own calibration recording, run through
the same detector, calibrated with aniposelib and scored against the true rig and on a
simulated still test-board recording. Corner noise was set so that the rig's real board,
simulated, gives the real recording's reprojection error (0.25 px ChronicRecord, 0.29 px
8-camera arena, 1.2 px for the 18-camera rig; also scored at 0.25 px). Full tables and
figures: `results/sim-*/report.md`.

**3D error against the true rig** (median over triangulated test-board corners; "–" = the
whole-recording calibration failed):

| Board | Small: ChronicRecord copy | Medium: 8-camera arena copy | Large: 18-camera copy (0.25 px / 1.2 px noise) |
|---|---|---|---|
| 200×150 fine (7.5 mm) | 0.10 mm, 1 of 2 failed | – | – |
| 200×150 coarse (15 mm) | 0.03 mm | – | – |
| 300×200 fine (10 mm) | 0.05 mm | – | – |
| **300×200 coarse (20 mm)**, owned | 0.03 mm | 0.08 mm | – |
| 400×300 fine (15 mm) | 0.04 mm | 0.06 mm | – |
| 9 × 15 custom, 25 mm (400×300) | 0.04 mm | 0.09 mm | – |
| **400×300 coarse (30 mm)**, owned | 0.04 mm | 0.09 mm | – |
| 600×400 fine (20 mm) | – | 0.10 mm | failed / failed |
| 9 × 15 custom, 38 mm (600×400) | – | – | 0.13 / 0.17 mm |
| **600×400 coarse (40 mm)**, owned | – | 0.10 mm | 0.13 / 0.17 mm |
| 800×600 fine (30 mm) | – | – | diverged / 0.15 mm |
| 800×600 coarse (60 mm) | – | – | 0.14 / 0.19 mm |
| printed 8 × 11 (24 mm), owned | – | – | 0.07 / 0.08 mm |

- Held-out ruler errors follow the same order: 0.06–0.07 % small, 0.07–0.08 % medium,
  0.04–0.07 % (0.11–0.14 % with 1.2 px noise) large. The real recordings of the same rigs:
  0.12 %, 0.12 % and 0.48 %.
- **How long to record:** in the copies the error is close to final after 20 s (small),
  20–30 s (medium) and 90–120 s (large, at the 18-camera rig's 10 fps).
- **Smallest squares still found:** about 18–23 px for fine boards and 28 px and up for
  coarse ones; tilt up to about 45–50° (small, medium) and 66–76° (large) from the line of
  sight.
- **A bias to keep in mind:** the board motion is where a person held the rig's *real*
  board (the 300×200 coarse in the small and medium copies, the printed 8 × 11 in the large
  one), so those boards are favoured slightly: a bigger board centred on the same spots
  falls partly out of view more often. Differences of a few hundredths of a mm are not
  meaningful here; the failures and the detection limits are.
- **Not simulated:** glare, hands and cage parts hiding the board, sync error, boards that
  are not flat, people handling a large board differently from a small one. The real test
  (PROTOCOL.md) covers these.


## Recordings still needed

In order of usefulness. Nothing here needs a purchase.

1. **The protocol (PROTOCOL.md) on three rigs, with the boards already owned**: ChronicRecord
   (small: printed 8 × 11, 300×200 coarse), the 8-camera arena (medium: printed 8 × 11, 300×200,
   400×300 and 600×400 coarse) and the 18-camera rig (large: printed 8 × 11, 400×300 and 600×400
   coarse). One sitting per rig, three takes per board, a still test recording at the start
   and the end: about 45 minutes per rig. This is the board comparison the existing data
   cannot give, and it checks the simulations.
2. **A ruler in each of those sittings** (a steel rule with two marks, held still at 8
   places, the two marks labelled in LUC3D): the one check that does not rely on a
   ChArUco board.
3. **Done (see above):** the 18-camera recording calibrated with calibrat3 next to
   aniposelib. Worth doing the same for the 5-camera marmoset rig and Rig205, whose
   calibrations are also poor.
4. **Make these Google Drive recordings available offline** (they are online-only, and
   `run` reads every frame): the 8-camera arena's calibrations of 2026-05-18, 05-28 and
   06-05 (same board, repeatability across days); the 18-camera rig's 2024-11-20, 11-21 and
   12-03 calibrations and Camera15 of 2024-12-06; Camera1 of the campy-live 2026-10-20
   calibration (a second ChronicRecord day).
5. **Two facts to confirm:** which calib.io boards the lab physically has (the records point
   to the 300×200, 400×300 and 600×400 coarse), and the SLAP board's square size
   (`Proofreading/board.toml` on the Drive is online-only; 24 mm was assumed).
6. **Polina's rig**: a calibration recording where every camera has the same number of
   frames (in the existing ones Camera1 dropped frames, and probably others too).

