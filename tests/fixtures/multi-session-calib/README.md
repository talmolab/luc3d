# multi-session-calib

The two calibrations from the real `small_multi_session/10072022145420_small`
session folder, kept as a fixture because the divergence they encode is the one
`tests/e2e/multi-session-calibration-notice.mjs` is about and synthetic numbers
would not prove the detector works on real data.

- `calibration.toml` — the original, and byte-identical to the copy in all four
  session folders of that project. Eight cameras.
- `calibration-rebased.toml` — what `Set as New Calibration` wrote into ONE of
  those four folders. Same eight cameras, same intrinsics, same distortion, same
  image size, same order; only `rotation` and `translation` differ.

The second is a **pure change of world origin** away from the first, which is
what makes the pair useful: all eight cameras agree on one rigid transform to
3e-14 in rotation and 5e-13 mm in translation, so the origin sits at
`(-10.591, 11.900, 1218.743)` mm — 1218.847 mm away, rotated 162.818° — in the
original frame. Those numbers are asserted, so a change to the frame-recovery
maths shows up as a value difference and not merely as a pass/fail.

No annotation data, no video, no paths: just camera geometry, ~5 KB for the pair.
