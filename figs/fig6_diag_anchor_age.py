#!/usr/bin/env python
"""Fig 8 diagnostic — HOW OLD are the detections the shipped tracker fuses into its 3D?

This measures the mechanism behind Fig 8d's best result, so that result rests on a
measured cause rather than on a config that happened to win.

`Target.detsByCam` (pose/cross-view-tracker.js) holds ONE detection per camera and
never expires it. `Target.prototype._retriangulate` then fuses all of them:

    var dets = Array.from(this.detsByCam.values());
    ... triangulatePoints(allObs, exts)

So if camera 3 last matched this target 800 frames ago, that 800-frame-old 2D detection
is still an input to the 3D pose that THIS frame's association is scored against. The
anchor is a blend of where the animal is and where it used to be. Nothing ages out,
because the reference tracker this was ported from has no track aging (see the
faithful-port note at the top of pose/cross-view-tracker.js) and the port kept that.

`method.probeAge` in figs/fig6-bench/xv_experimental.js records the age, in frames, of
every detection held at the start of every frame. It is BEHAVIOUR-NEUTRAL — it only
switches on the frame bookkeeping, changes no decision, and this script proves that per
session by comparing the SHA-256 of the tracker's identities+frames payload against the
`shipped` cell. A probe that changed the thing it measures would be worthless.

WHAT IT FINDS: mean age 3.0 to 49.8 frames depending on the session, with maxima of
844 to 8,652 frames -- nearly five minutes of staleness at 30 fps. The session with by
far the oldest anchor (20250904_131913, mean 49.8) is also the one Fig 8c singles out
for losing 0.311 IDF1 to just TEN switches, and it gains the most from evicting stale
detections (+0.311). Across only 8 sessions the age-versus-gain correlation is r = 0.56,
which is suggestive and not significant; the load-bearing evidence is the monotone
ordering of Fig 8d's anchor-freshness axis, not this correlation.

    $PY figs/fig8_diag_anchor_age.py

Output: figs/out/fig8_diag_anchor_age.json
"""
import hashlib
import json
import subprocess
import sys
import time
from concurrent.futures import ProcessPoolExecutor, as_completed
from pathlib import Path

REPO = Path(__file__).resolve().parent.parent
OUT_DIR = REPO / "figs" / "out"
sys.path.insert(0, str(REPO / "figs"))
import fig3_sweep as f3  # noqa: E402
import fig8_methods as f8m  # noqa: E402

CELL = "probe_age"


def _digest(path):
    b = Path(path).read_bytes()
    i = b.find(b'"identities":')
    j = b.find(b',"framesProcessed"', i)
    if i < 0 or j < 0:
        return None
    return hashlib.sha256(b[i:j]).hexdigest()


def _one(session):
    _s, status, info = f8m.run_one(CELL, {"method": {"probeAge": True}}, session)
    if status != "ok":
        return session, None, info
    p = f8m.TMP_DIR / CELL / f"{session}.json"
    st = json.loads(p.read_text()).get("methodStats") or {}
    n = max(1, st.get("ageN", 0))
    shipped = f8m.TMP_DIR / "shipped" / f"{session}.json"
    return session, {
        "session": session,
        "mean_age_frames": st.get("ageSum", 0) / n,
        "frac_older_than_1": st.get("ageOver1", 0) / n,
        "frac_older_than_10": st.get("ageOver10", 0) / n,
        "frac_older_than_100": st.get("ageOver100", 0) / n,
        "max_age_frames": st.get("ageMax", 0),
        "n_observations": st.get("ageN", 0),
        # The probe must not change what it measures.
        "behaviour_neutral": bool(shipped.exists()
                                  and _digest(p) == _digest(shipped)),
    }, None


def main():
    t0 = time.time()
    rows = []
    with ProcessPoolExecutor(max_workers=8) as ex:
        futs = [ex.submit(_one, s) for s in f3.SESSIONS]
        for fut in as_completed(futs):
            s, r, err = fut.result()
            if err:
                print(f"[age] {s} FAILED: {err}", flush=True)
                continue
            rows.append(r)
            print(f"[age] {s}: mean {r['mean_age_frames']:.2f} frames, max "
                  f"{r['max_age_frames']}, neutral={r['behaviour_neutral']}", flush=True)

    rows.sort(key=lambda r: -r["mean_age_frames"])
    neutral = all(r["behaviour_neutral"] for r in rows)
    print()
    print(f"{'session':<18}{'mean age':>10}{'>100 fr':>10}{'max age':>10}")
    for r in rows:
        print(f"{r['session']:<18}{r['mean_age_frames']:>10.2f}"
              f"{100 * r['frac_older_than_100']:>9.2f}%{r['max_age_frames']:>10d}")
    print(f"\nall probe runs behaviour-neutral: {neutral}")

    dest = OUT_DIR / "fig8_diag_anchor_age.json"
    dest.write_text(json.dumps({
        "generated_by": "figs/fig8_diag_anchor_age.py",
        "claim": "Age, in frames, of the per-camera detections that "
                 "Target._retriangulate() fuses into the 3D pose each association is "
                 "scored against. `Target.detsByCam` keeps one detection per camera and "
                 "never expires it, so the anchor blends the current pose with wherever "
                 "each other camera last saw the animal.",
        "behaviour_neutral": neutral,
        "how_neutrality_is_established":
            "For each session the SHA-256 of the probe run's identities+frames payload "
            "is compared with the `shipped` cell's. Identical on every session means "
            "the probe changed no decision, so the ages it reports are the SHIPPED "
            "tracker's and not an artefact of measuring them.",
        "caveat":
            "Across 8 sessions the correlation between mean anchor age and the IDF1 "
            "gain from evicting stale detections is r = 0.56, which at n = 8 is not "
            "significant and is leveraged by one session. The mechanism is established "
            "by the ages themselves and by the monotone anchor-freshness ordering in "
            "figs/out/fig8_methods.json, not by this correlation.",
        "sessions": f3.SESSIONS,
        "per_session": rows,
        "seconds": round(time.time() - t0, 1),
    }, indent=2))
    print(f"[age] wrote {dest}")
    return 0 if neutral else 1


if __name__ == "__main__":
    raise SystemExit(main())
