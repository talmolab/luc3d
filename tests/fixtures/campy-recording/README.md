# campy-recording

The manifests of a campy recording folder, for `tests/test-campy-session.mjs`
and `tests/e2e/campy-session-folder.mjs`.

- `session.json` — a REAL one: written by campy-acquire (olinesn/campy `dev`,
  2.1.1rc1) with two emulated cameras, by campy's own
  `tests/test_manifest.py::test_a_recording_says_how_it_was_made` (20 fps,
  experiment "social", animal IDs M1 and M2, notes "new bedding", field
  cage: B3, the note "M2 sleeping" added afterwards). Only the computer's name
  and the absolute paths were replaced (`/data/campy-test`, `/home/lab`), so
  the config's recorded SHA-256 no longer matches its text; nothing reads it.
- `calibration.toml` — two synthetic cameras named like campy's (Camera0,
  Camera1).
- `campy-live-session.json` — written by hand in campy-live's schema
  (`campy-live-session/1`, campy/manifest.py `LiveSession.Start`), with
  `calibration.sha256` the SHA-256 of `calibration.toml` above, byte for byte.
  Change that file and update the hash, or the tests' "same calibration" case
  fails.

The e2e test builds the videos in the browser and writes them where
`session.json` says.
