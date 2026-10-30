# Which calibration board for which rig: recording protocol

This is the part done at the rig. It takes about 45 minutes per rig. The analysis
(`python scripts/board_study run …`, see [README.md](README.md)) does the rest.

The idea: in **one sitting, without touching the cameras**, record every board on
the list **three times**, plus a **test recording** at the start and at the end. Each
board's calibrations are then scored on the same test recordings, which none of them
were made from, so the boards can be compared fairly.

## Which boards on which rig

calib.io names each board by its plate size and pattern: *coarse* has fewer, bigger
squares; *fine* has more, smaller squares. Plate sizes are in mm.

| Rig size | Example rigs | Boards to record |
|---|---|---|
| Small: one home cage, cameras within ~60 cm | ChronicRecord (4 cameras), DoublePoke box, Rig205 | 200×150 coarse, 200×150 fine, **300×200 coarse** (owned), 300×200 fine |
| Medium: an arena of ~0.5–1 m | the 8-camera arena rig (2026), SLAP, Polina's rig | **300×200 coarse** (owned), **400×300 coarse** (owned), 400×300 fine, 600×400 fine, 9×15 custom (25 mm squares) |
| Large: a room-size arena or many cameras | 18-camera rig, marmoset cages | **600×400 coarse** (owned), 600×400 fine, 800×600 coarse, 800×600 fine, 9×15 custom (38 mm squares) |

**Bold** = the lab seems to own it already (found in past recordings: the 14×9-square
20 mm board, the 12×9 30 mm board and the 14×9 40 mm board are exactly calib.io's
300×200, 400×300 and 600×400 coarse). Please check they are where we think they are.
The printed 8×11 board (24 mm squares, 4×4 markers) used for most recordings up to
2026 can be recorded as an extra board on any rig, as a "before" reference.

Skip a board that does not fit: you must be able to tilt it 45° anywhere in the space
without hitting a wall.

Pick one **test board** per rig, the biggest board that still fits comfortably
(small rigs: 300×200 coarse; medium: 400×300 coarse; large: 600×400 coarse).

## Before you start

1. Focus and set up the cameras for an experiment, exactly as for real recordings.
   **Do not touch the cameras, lenses, focus, zoom or mounts until all recordings of
   this sitting are done.** If anything moves, start the sitting again.
2. **Exposure: short** (2 ms or less) so a moving board is not blurred; raise the gain
   instead. Brightness: the white squares should look clearly white but not burnt out
   (roughly 120–220 out of 255). Use the same settings for every board.
3. Lights on as for experiments. Look for glare on the boards (they are matte, but a
   lamp straight behind the camera can still reflect); tilt the board or move the lamp.
4. Recording settings (campy): 10 frames per second, 90 seconds:
   ```
   campy-acquire <config>.yaml --frameRate 10 --recTimeInSec 90 --videoFilename calibration.mp4
   ```
   On a triggered rig keep the trigger: all cameras must take each frame together.
5. Have a notes sheet: for every recording write the folder name, the board, the start
   and stop time of handling (picking the board up to stopping the recording), and
   anything unusual (a camera that dropped frames, the board slipped, someone walked in).

## Recordings, in this order

Name the folders exactly like this, so the analysis finds them by itself
(`<board>` = the board's id from the shopping list, e.g. `calibio-400x300-fine`):

```
<study folder>/<rig>/<date>/test_<test board>_start/
<study folder>/<rig>/<date>/<board>_take1/
...
<study folder>/<rig>/<date>/test_<test board>_end/
```

1. **Test recording (start).** Put the test board still at 12 places, about 3 seconds
   each, moving it quickly in between: near and far, the middle and each corner of the
   space, on the floor and as high as the animals reach, and tilted up to ~45° in
   different directions at some of them. Each place must be seen by at least two
   cameras. A calib.io target stand, a box or a clamp helps keep it still; hands are
   fine if you keep still.
2. **Calibration recordings: every board three times**, in a rotating order so no
   board is always first or last. For example with boards A, B, C, D:
   `A B C D`, then `B C D A`, then `C D A B`. Put the board down between takes and pick
   it up again: each take should be a fresh attempt. For each 90-second take:
   - 0–10 s: board flat on the floor in the middle, where all cameras see it.
   - 10–75 s: move it **slowly** (about a hand's width per second) through the whole
     space the animals use: along every wall and into every corner, low and high.
     Turn it so every camera sees it face-on and tilted about 45° to each side, and
     so neighbouring cameras see it at the same time.
   - 75–90 s: hold it still at three or four places for 2 seconds each.
   - Hold the board by its edges; do not cover the pattern with your hands.
3. **Test recording (end)**: the same as the first, at roughly the same 12 places.
4. *(Optional, the most direct check)* **A ruler**: a rigid steel ruler or bar with two
   clear marks a known distance apart (e.g. 300 mm, measured with calipers), held still
   at 8 places like the test board. Afterwards, label the two marks in LUC3D or SLEAP in
   every camera (a skeleton with two nodes) and add the files to the study (README).

## After

Copy the study folder to the NAS. Then, on any computer with the repository:

```
python scripts/board_study scan <study folder> --out study.toml
python scripts/board_study run study.toml results/
python scripts/board_study report results/
```

(`uv run --with …` in front, see README.)

## What the analysis measures

- **Reprojection error**: how well each calibration explains its own recording, in
  pixels. What calibration tools report; low is necessary but not enough.
- **Accuracy on the test recordings**: the test board's corners are triangulated with
  each calibration and compared with the printed pattern. Reported as the error of long
  distances across the board (like measuring with a ruler, in % of the distance) and as
  how far the triangulated corners sit from a perfectly flat, perfectly printed board (mm).
- **Repeatability**: the three takes of a board give three calibrations; how much the
  focal lengths, lens distortion, camera positions and angles, and above all the
  triangulated 3D points, change between them.
- **Practical**: in what share of frames each camera found the board; the smallest
  board image (square size in pixels) and steepest tilt at which it was still found;
  how the result improves with recording time (calibrations from only the first 10, 20,
  30, … seconds); how long each take took (from your notes sheet).

## Shopping list (calib.io, prices on 29 October 2026)

**Start without buying anything.** The simulations and existing recordings
([RESULTS.md](RESULTS.md)) found no gain from fine boards or the 9 × 15 board, so the first
round of this protocol uses the boards the lab already has (300×200, 400×300 and 600×400
coarse, and the printed 8 × 11). The full list below is what it would take to test every
option on all three rig sizes, in case the first round says otherwise.

All boards: calib.io ChArUco targets on 6 mm aluminium composite, DICT_5X5 markers,
made to order. Prices are calib.io's listed USD prices; shipping and duties are not
included. Product page for the catalogue boards:
<https://calib.io/products/charuco-targets>; custom patterns:
<https://calib.io/products/custom-targets>.

| Id used here | calib.io product | Squares (columns × rows) | Square / marker | Price | Needed for | Owned? |
|---|---|---|---|---|---|---|
| calibio-200x150-coarse | ChArUco Target 200×150, Coarse (P/N CCT200150C) | 12 × 9 | 15 / 11 mm | $132 | small | no |
| calibio-200x150-fine | ChArUco Target 200×150, Fine (CCT200150F) | 24 × 17 | 7.5 / 5.5 mm | $132 | small | no |
| calibio-300x200-coarse | ChArUco Target 300×200, Coarse (CCT300200C) | 14 × 9 | 20 / 15 mm | $137 | small, medium | yes (check) |
| calibio-300x200-fine | ChArUco Target 300×200, Fine (CCT300200F) | 28 × 17 | 10 / 7 mm | $137 | small | no |
| calibio-400x300-coarse | ChArUco Target 400×300, Coarse (CCT400300C) | 12 × 9 | 30 / 22 mm | $153 | medium | yes (check) |
| calibio-400x300-fine | ChArUco Target 400×300, Fine (CCT400300F) | 24 × 17 | 15 / 11 mm | $153 | medium | no |
| calibio-600x400-coarse | ChArUco Target 600×400, Coarse (CCT600400C) | 14 × 9 | 40 / 30 mm | $231 | large | yes (check) |
| calibio-600x400-fine | ChArUco Target 600×400, Fine (CCT600400F) | 28 × 17 | 20 / 15 mm | $231 | medium, large | no |
| calibio-800x600-coarse | ChArUco Target 800×600, Coarse (CCT800600C) | 12 × 9 | 60 / 45 mm | $311 | large | no |
| calibio-800x600-fine | ChArUco Target 800×600, Fine (CCT800600F) | 24 × 17 | 30 / 22 mm | $311 | large | no |
| calibio-custom-9x15-25mm | Custom Target 400×300 (CUT400300): ChArUco 15 × 9, 25 mm squares, 18.75 mm markers, DICT_5X5_1000 | 15 × 9 | 25 / 18.75 mm | $206 | medium | no |
| calibio-custom-9x15-38mm | Custom Target 600×400 (CUT600400): ChArUco 15 × 9, 38 mm squares, 28.5 mm markers, DICT_5X5_1000 | 15 × 9 | 38 / 28.5 mm | $291 | large | no |
| (accessory) | Target Stand (TRGSTA01), holds a plate at 45/60/75/90° | – | – | $173 | test recordings | no |

- **The 9 × 15 board on DICT_5X5_1000** is not one of calib.io's catalogue sizes
  (theirs are 9 × 12 / 9 × 14 coarse and 17 × 24 / 17 × 28 fine). calib.io makes it as a
  custom target on the same aluminium plate; the two square sizes above are the largest
  that fit a 400×300 and a 600×400 plate with a margin. If you meant a specific board
  you already have a link or file for, its numbers go in a `board.toml` and nothing
  else changes.
- calib.io notes that boards with an **even number of rows** were laid out differently
  before OpenCV 4.6. Every board above has an odd number of rows (9, 15 or 17), so all
  tools read them the same way.
- To run the whole protocol on all three core rigs without the owned boards: about
  $1,904 for the nine unowned boards, plus $173 for the stand. The recommendation in the
  results (README) says which ones are worth keeping afterwards.
- Do not order through this document: prices and lead times change. Check the product
  pages and order yourself.
