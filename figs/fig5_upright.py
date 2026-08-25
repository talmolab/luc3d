#!/usr/bin/env python3
"""
Mutual upright display: detect it, characterise it, and pull real poses out.

WHAT THE EVENT IS. Both animals rearing (neck above REAR_FRAC of their own body
length), within NEAR_BL of each other, held for MIN_EVENT_S. That is the
configuration the coupling analysis found at 2.21x chance and the geometry identified
as face-to-face: tail bases ~0.8 body lengths apart on the floor, both animals up to
~1.1 body lengths, noses converging to ~0.17 body lengths.

WHAT THIS ADDS over fig5_rear_coupling.py, which only established that the coupling
exists and is not an artefact:
  * per-event features -- duration, peak heights, how closely the two animals MATCH
    each other's height, minimum nose gap, convergence ratio;
  * time courses of the gap and both heights around onset, so the approach and the
    break-up are visible rather than summarised;
  * SPEED during the event against each animal's own baseline. This is the one
    measurement that bears on whether these are agonistic (boxing) or affiliative
    (mutual investigation). It does not settle it -- only video can -- but a display
    that is fast and jerky is a different behaviour from one that is still, and the
    figure should not call it "boxing" without looking.
  * arena position, because "both animals rear at the same moment" has an innocent
    explanation this analysis has NOT yet excluded: they are both near the same
    interesting thing (a corner, a wall, a feeder). If events pile up at particular
    places, that is the explanation; if they are spread, it is not.
  * example poses, exported as raw 3D so the artwork can draw real skeletons rather
    than a cartoon.

    figs/.venv/bin/python figs/fig5_upright.py
"""
from __future__ import annotations

import argparse
import glob
import json
import os
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path

import h5py
import numpy as np

HERE = Path(__file__).resolve().parent
OUT = HERE / "out"
BMIMICA = "/root/vast/eric/BMimica"

NODES = ["Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk", "Tail_0",
         "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right", "Haunch_left",
         "Haunch_right", "Neck"]
NOSE, TTI, NECK = NODES.index("Nose"), NODES.index("TTI"), NODES.index("Neck")
#: from slap_2m/mouse_skeleton.toml -- both corpora share this skeleton
EDGES = [[3, 5], [3, 7], [3, 8], [3, 9], [3, 12], [3, 13], [3, 6], [5, 0],
         [5, 14], [5, 10], [5, 11], [5, 1], [5, 2], [3, 4]]

REAR_FRAC, NEAR_BL = 0.75, 2.0
MIN_EVENT_S, MERGE_GAP_S = 0.25, 0.15
WIN_S = 2.0
SPEED_WIN_S = 0.20        # smoothing for the speed estimate
ANGLE_BIN_EDGES_DEG = np.linspace(-180, 180, 25)  # 24 x 15-degree bins, for the rose plot


def runs(mask, min_len, merge_gap):
    m = np.asarray(mask, bool)
    if not m.any():
        return []
    d = np.diff(np.concatenate(([0], m.view(np.int8), [0])))
    s, e = np.flatnonzero(d == 1), np.flatnonzero(d == -1)
    merged = []
    for a, b in zip(s, e):
        if merged and a - merged[-1][1] <= merge_gap:
            merged[-1][1] = b
        else:
            merged.append([a, b])
    return [(a, b) for a, b in merged if b - a >= max(1, min_len)]


def _bias(tracks):
    """Share of displays started by the more-often-initiating animal (0.5-1.0)."""
    if not tracks:
        return None
    return max(tracks.count(0), tracks.count(1)) / len(tracks)


def _load(sd):
    """Mouse-Dyad-10M session -> (tracks_mm, fps, track_names, experimental_code)."""
    fp = glob.glob(os.path.join(sd, "*points3d*.h5"))
    if not fp:
        return None
    with h5py.File(fp[0]) as h:
        t = h["tracks"][:] * 1000.0
        fps = float(h["recording_frame_rate"][()])
        # ANIMAL IDENTITY, carried through so per-animal statistics are possible.
        # Without it the two tracks are anonymous within a session and there is no
        # way to ask the question that matters -- whether the animal that starts the
        # display keeps that role when it is paired with somebody else.
        names = [t.decode() if isinstance(t, bytes) else str(t)
                 for t in h["track_names"][:]] if "track_names" in h else ["0", "1"]
        code = h["experimental_code"][()] if "experimental_code" in h else b""
        code = code.decode() if isinstance(code, bytes) else str(code)
    return t, fps, names, code


def session_upright(t, fps, names, code, session):
    """Detect and characterise mutual upright displays in ONE session.

    Pure function of the array, so any corpus can drive it (Fig 12 runs SLAP-2M and
    the s-DANNCE SCN2A dyads through this exact detector rather than a copy of it).
    `t` is (F, A, N, 3) in MILLIMETRES with the floor at z = 0; only the NOSE, TTI
    and NECK slots are read, so a corpus with a different skeleton adapts by placing
    its own three nodes in those slots (see `fig12_social.py`).
    """
    F, A = t.shape[0], t.shape[1]
    if A != 2:
        return None
    nose, tti, neck = t[:, :, NOSE, :], t[:, :, TTI, :], t[:, :, NECK, :]
    L = np.nanmedian(np.linalg.norm(nose - tti, axis=-1), axis=0)
    if not np.all(np.isfinite(L)) or np.any(L <= 0):
        return None
    Lm = float(np.mean(L))

    # ARENA EXTENT, fit exactly the way fig1_bmimica_scene.py's fit_arena() does
    # (0.1-99.9th percentile of every body point over the whole session) so an
    # event's distance to the nearest wall is measured against the same floor
    # footprint the rest of the pipeline already uses -- not a separately-invented
    # boundary. There is no calibrated physical wall position in this corpus; this
    # is each session's own movement-range proxy for it.
    P_all = t.reshape(-1, 3)
    P_all = P_all[np.isfinite(P_all).all(1)]
    wall_x = np.percentile(P_all[:, 0], [0.1, 99.9])
    wall_y = np.percentile(P_all[:, 1], [0.1, 99.9])

    w = int(round(WIN_S * fps))
    min_len = int(round(MIN_EVENT_S * fps))
    gap = int(round(MERGE_GAP_S * fps))
    sw = max(1, int(round(SPEED_WIN_S * fps)))

    # IDENTITY-STABILITY CHECK. Every per-animal statistic below is only meaningful
    # if track 0 is the same mouse for the whole session. Structural body length is
    # the cheapest witness: computed on each half, an identity swap shows up as the
    # two tracks' lengths crossing over.
    half = F // 2
    L_half = [[float(np.nanmedian(np.linalg.norm(nose[sl, a, :] - tti[sl, a, :],
                                                 axis=-1)))
               for sl in (slice(0, half), slice(half, F))] for a in range(2)]

    rear = np.stack([neck[:, a, 2] / L[a] > REAR_FRAC for a in range(2)], axis=1)
    _v = neck - tti
    ang = np.degrees(np.arctan2(_v[:, :, 2], np.linalg.norm(_v[:, :, :2], axis=-1)))
    sep = np.linalg.norm(tti[:, 0, :] - tti[:, 1, :], axis=-1) / Lm
    base_xy = np.linalg.norm(tti[:, 0, :2] - tti[:, 1, :2], axis=-1) / Lm
    nose_xy = np.linalg.norm(nose[:, 0, :2] - nose[:, 1, :2], axis=-1) / Lm
    nz = np.stack([nose[:, a, 2] / L[a] for a in range(2)], axis=1)
    # THE SAME HEIGHT IN MILLIMETRES. `nz` divides by the animal's OWN body length,
    # so a smaller mouse scores higher for the same nose height off the floor and
    # "reaches higher" cannot be read as "is the bigger animal". Every claim about
    # WHICH ANIMAL is taller has to be checkable in absolute units too.
    nz_mm = nose[:, :, 2]

    # speed of the tail base (body translation), body lengths per second
    spd = np.full((F, 2), np.nan)
    k = np.ones(sw) / sw
    for a in range(2):
        d = np.linalg.norm(np.diff(tti[:, a, :2], axis=0), axis=-1) / Lm * fps
        spd[1:, a] = np.convolve(d, k, mode="same")
    base_spd = np.nanmedian(spd, axis=0)

    # PURSUIT BY FACING, NOT BY WHERE THE ANIMAL IS ACTUALLY HEADED (revised
    # 2026-08-21: a first version used the VELOCITY vector -- where the animal is
    # actually travelling -- instead of this). Facing and travel direction are
    # different questions: an animal can be moving toward its partner while turned
    # sideways, or facing it while stationary or backing away. This version asks
    # specifically whether the animal's own BODY AXIS (Nose -> TTI) is oriented at
    # its partner, then scales that orientation by how fast the animal is actually
    # moving, so a fast animal facing its partner counts far more than a slow or
    # stationary one facing the same way. For track a, `away_a` is the unit vector
    # from the partner to a (partner -> self): `facing_a` (Nose - TTI, normalised)
    # dotted with `away_a` is NEGATIVE when a's body axis points at its partner
    # (opposite `away_a`) and POSITIVE when it points away, and multiplying by that
    # animal's own (unsigned) speed weights it by how much motion is actually behind
    # the orientation -- a stationary animal facing its partner scores ~0, not a
    # large negative number, because facing without moving is not pursuit.
    sep_vec = tti[:, 0, :2] - tti[:, 1, :2]                       # track 0 - track 1
    sep_norm = np.linalg.norm(sep_vec, axis=-1)
    sep_unit = sep_vec / np.where(sep_norm[:, None] > 0, sep_norm[:, None], np.nan)
    facing_vec = nose[:, :, :2] - tti[:, :, :2]                   # (F, 2, 2)
    facing_norm = np.linalg.norm(facing_vec, axis=-1)
    facing_unit = facing_vec / np.where(facing_norm[..., None] > 0,
                                        facing_norm[..., None], np.nan)
    pursuit = np.full((F, 2), np.nan)
    pursuit[:, 0] = np.einsum("ij,ij->i", facing_unit[:, 0, :], sep_unit) * spd[:, 0]
    pursuit[:, 1] = np.einsum("ij,ij->i", facing_unit[:, 1, :], -sep_unit) * spd[:, 1]

    # RELATIVE HEAD/BODY ANGLE, for the rose-plot panel: how each animal's own HEAD
    # (Nose -> Neck) and BODY (Neck -> TTI) axis is oriented relative to the
    # direction TO ITS PARTNER, in degrees, 0 = pointing straight at the partner,
    # +-180 = pointing straight away. Two different anatomical references on
    # purpose -- the head can turn independently of the trunk, so "is he facing her"
    # and "is his whole body turned toward her" can differ.
    to_partner = np.stack([-sep_vec, sep_vec], axis=1)              # (F, 2, 2)
    ang_to_partner = np.arctan2(to_partner[:, :, 1], to_partner[:, :, 0])
    head_vec = nose[:, :, :2] - neck[:, :, :2]
    body_vec = neck[:, :, :2] - tti[:, :, :2]
    ang_head = np.arctan2(head_vec[:, :, 1], head_vec[:, :, 0])
    ang_body = np.arctan2(body_vec[:, :, 1], body_vec[:, :, 0])
    rel_head_deg = np.degrees((ang_head - ang_to_partner + np.pi) % (2 * np.pi) - np.pi)
    rel_body_deg = np.degrees((ang_body - ang_to_partner + np.pi) % (2 * np.pi) - np.pi)

    mask = rear[:, 0] & rear[:, 1] & np.isfinite(sep) & (sep <= NEAR_BL)
    ev = runs(mask, min_len, gap)

    # PER-ANIMAL REAR BOUTS, needed for the initiator question. The display begins
    # when the SECOND animal comes up, so display onset alone cannot say who started
    # it; that needs each animal's own onset.
    own = [runs(rear[:, a], min_len, gap) for a in range(2)]

    # separation velocity, body lengths per second. Negative = closing.
    dsep = np.full(F, np.nan)
    kk = np.ones(sw) / sw
    dsep[1:] = np.convolve(np.diff(sep) * fps, kk, mode="same")

    events, peri_gap, peri_hi, peri_lo = [], [], [], []
    peri_dsep, peri_spd_i, peri_spd_f = [], [], []
    # TRACK-INDEXED, NOT RANK-INDEXED (2026-08-21): peri_hi/peri_lo are "whichever
    # animal peaked higher in THIS display", which changes hands display by display
    # (see fig5_06_upright_dynamics.py's old docstring) and was deliberately kept
    # anonymous. Eric then pointed out that Mouse-Dyad-10M's track slot IS a stable
    # identity after all -- slot 0 is always male, slot 1 always female, verified
    # against every session's track_names (6 animal IDs seen only at slot 0, 9 only
    # at slot 1, zero seen at both) -- so a track-indexed series is no longer "washed
    # toward the mean" the way an arbitrary identity split would be: female reaches
    # higher on 80.9% of displays, not ~50%. `peri_t0`/`peri_t1` carry the RAW
    # track-0/track-1 nose height (no rank relabelling) so the sex-specific curves can
    # be drawn directly.
    peri_t0, peri_t1 = [], []
    # SAME TRACK-INDEXED FIX, for speed (2026-08-21): peri_spd_i/peri_spd_f below are
    # keyed by INITIATOR RANK, not track/sex, and are also None-gated on init_a being
    # resolvable. peri_spd_t0/t1 are the track-indexed twins -- unconditional on
    # init_a, since they don't need to know who started.
    peri_spd_t0, peri_spd_t1 = [], []
    peri_pursuit_t0, peri_pursuit_t1 = [], []
    # DURING-DISPLAY ANGLES, pooled across all events in this session for the rose
    # plot -- every frame of every display, not a per-event summary.
    angle_frames = {"head_t0": [], "head_t1": [], "body_t0": [], "body_t1": []}
    examples = []
    for s, e in ev:
        h0 = float(np.nanmax(nz[s:e, 0]))
        h1 = float(np.nanmax(nz[s:e, 1]))
        hi_a = 0 if h0 >= h1 else 1

        # WHO INITIATED. Take each animal's own rear bout that contains (or most
        # recently preceded) the display and compare their onsets. `lag` is how long
        # the initiator was already up before the follower joined; positive by
        # construction. `None` when either animal's bout cannot be identified, rather
        # than guessing.
        onsets = []
        for a in range(2):
            cand = [bs for bs in own[a] if bs[0] <= s < bs[1]]
            onsets.append(cand[-1][0] if cand else None)
        if None in onsets:
            init_a, lag_s = None, None
        else:
            init_a = 0 if onsets[0] < onsets[1] else 1
            lag_s = abs(onsets[0] - onsets[1]) / fps

        pre = slice(max(0, s - int(round(0.5 * fps))), s)
        # WIDER WINDOW FOR PURSUIT SPECIFICALLY (2026-08-21): the peri time course
        # shows the male/female facing-pursuit gap is not just present in the last
        # 0.5 s before onset, it is present (and if anything slightly LARGER)
        # a full 1-1.5 s out -- this is a sustained orientation difference over the
        # whole approach, not a last-instant effect, so pursuit_rel_t0/t1 use their
        # own, wider 1.5 s pre-onset window rather than reusing `pre`.
        pre_pursuit = slice(max(0, s - int(round(1.5 * fps))), s)
        # PRE-APPROACH ONLY, per track (2026-08-21, revised): `speed_rel` above pools
        # both animals AND only the display's own [s, e) window -- neither
        # distinguishes male from female, and "during" is the wrong window for a
        # question about who is still travelling INTO the display. speed_rel_t0/t1
        # reuse the exact same 0.5 s pre-onset `pre` window the mutual-velocity
        # measure already defines, per track, and stop at onset -- they do NOT
        # include the display itself (an earlier version extended through the
        # display's end; that pooled the approach with the mostly-still hold and
        # muddied the "who is still moving in" question this is meant to answer).
        events.append({
            "dur_s": (e - s) / fps,
            "peak_hi": max(h0, h1), "peak_lo": min(h0, h1),
            "height_match": min(h0, h1) / max(h0, h1) if max(h0, h1) > 0 else np.nan,
            "min_nose_gap": float(np.nanmin(nose_xy[s:e])),
            "base_gap": float(np.nanmedian(base_xy[s:e])),
            "ratio": float(np.nanmedian(nose_xy[s:e] / np.maximum(base_xy[s:e], 1e-6))),
            "speed_rel": float(np.nanmedian(spd[s:e]) / np.nanmean(base_spd))
            if np.nanmean(base_spd) > 0 else np.nan,
            "speed_rel_t0": float(np.nanmedian(spd[pre, 0]) / base_spd[0])
            if base_spd[0] > 0 else np.nan,
            "speed_rel_t1": float(np.nanmedian(spd[pre, 1]) / base_spd[1])
            if base_spd[1] > 0 else np.nan,
            # RAW (not own-baseline-normalised) speed, same 0.5 s pre-onset window,
            # body lengths / s -- for panels that want overall speed rather than
            # each animal's speed relative to its own typical pace.
            "speed_bl_s_t0": float(np.nanmedian(spd[pre, 0])),
            "speed_bl_s_t1": float(np.nanmedian(spd[pre, 1])),
            # PURSUIT BY FACING: negative = body axis oriented at the partner while
            # moving, positive = oriented away while moving, over the 1.5 s pre-onset
            # `pre_pursuit` window, each animal's own baseline speed.
            "pursuit_rel_t0": float(np.nanmedian(pursuit[pre_pursuit, 0]) / base_spd[0])
            if base_spd[0] > 0 else np.nan,
            "pursuit_rel_t1": float(np.nanmedian(pursuit[pre_pursuit, 1]) / base_spd[1])
            if base_spd[1] > 0 else np.nan,
            # mutual velocity: how fast they closed in the half second before, and
            # how fast they separated after
            "approach_bl_s": float(np.nanmedian(dsep[pre])),
            "hold_bl_s": float(np.nanmedian(np.abs(dsep[s:e]))),
            "initiator_is_taller": (None if init_a is None else bool(init_a == hi_a)),
            "initiator_track": init_a,     # 0/1, the animal that came up first
            # WHICH TRACK reached higher, as an identity rather than a rank. Without
            # it the flat event list cannot say whether "the taller animal" is one
            # mouse or a label that changes hands display by display.
            "taller_track": int(hi_a),
            "peak_mm_t0": float(np.nanmax(nz_mm[s:e, 0])),
            "peak_mm_t1": float(np.nanmax(nz_mm[s:e, 1])),
            "taller_track_mm": int(np.nanmax(nz_mm[s:e, 0])
                                   < np.nanmax(nz_mm[s:e, 1])),
            "session": session,
            "lag_s": lag_s,
            # body-axis elevation of each animal at the moment of closest approach
            "elev_hi": float(np.nanmax(ang[s:e, hi_a])),
            "elev_lo": float(np.nanmax(ang[s:e, 1 - hi_a])),
            "x": float(np.nanmean(tti[s:e, :, 0])),
            "y": float(np.nanmean(tti[s:e, :, 1])),
            "start_frame": int(s), "end_frame": int(e),
        })
        # DISTANCE TO THE NEAREST WALL, both animals' mean position to the closest
        # of the four session-fitted edges, in mm and in body lengths.
        _ex, _ey = events[-1]["x"], events[-1]["y"]
        _wall_mm = float(min(_ex - wall_x[0], wall_x[1] - _ex,
                             _ey - wall_y[0], wall_y[1] - _ey))
        events[-1]["wall_dist_mm"] = _wall_mm
        events[-1]["wall_dist_bl"] = _wall_mm / Lm
        # EVERY FRAME OF THIS DISPLAY, both tracks, both anatomical references --
        # pooled across the whole session below for the rose plot.
        for _k, _arr in (("head_t0", rel_head_deg[s:e, 0]),
                        ("head_t1", rel_head_deg[s:e, 1]),
                        ("body_t0", rel_body_deg[s:e, 0]),
                        ("body_t1", rel_body_deg[s:e, 1])):
            _fin = _arr[np.isfinite(_arr)]
            if _fin.size:
                angle_frames[_k].append(_fin)
        if s - w >= 0 and s + w < F:
            g = nose_xy[s - w:s + w + 1]
            if np.isfinite(g).all():
                peri_gap.append(g)
                peri_hi.append(nz[s - w:s + w + 1, hi_a])
                peri_lo.append(nz[s - w:s + w + 1, 1 - hi_a])
                peri_t0.append(nz[s - w:s + w + 1, 0])
                peri_t1.append(nz[s - w:s + w + 1, 1])
                peri_dsep.append(dsep[s - w:s + w + 1])
                peri_spd_t0.append(spd[s - w:s + w + 1, 0] / max(base_spd[0], 1e-9))
                peri_spd_t1.append(spd[s - w:s + w + 1, 1] / max(base_spd[1], 1e-9))
                peri_pursuit_t0.append(pursuit[s - w:s + w + 1, 0]
                                       / max(base_spd[0], 1e-9))
                peri_pursuit_t1.append(pursuit[s - w:s + w + 1, 1]
                                       / max(base_spd[1], 1e-9))
                if init_a is not None:
                    peri_spd_i.append(spd[s - w:s + w + 1, init_a]
                                      / max(base_spd[init_a], 1e-9))
                    peri_spd_f.append(spd[s - w:s + w + 1, 1 - init_a]
                                      / max(base_spd[1 - init_a], 1e-9))
        if (e - s) / fps > 0.5 and min(h0, h1) > 0.9 and np.nanmin(nose_xy[s:e]) < 0.4:
            k = int(s + np.nanargmin(nose_xy[s:e]))
            if np.isfinite(t[k]).all():
                examples.append({"frame": k, "session": session,
                                 "L_mm": Lm, "pose": t[k].tolist(),
                                 "dur_s": (e - s) / fps})
    if not events:
        return None

    # PER-ANIMAL, PER-SESSION. The two obvious innocent explanations for "one animal
    # starts most displays" are both about the individual rather than the pair, and
    # both are testable from quantities that never look at the display:
    #   * it simply rears MORE, so it is up first by base rate  -> rear_frac, n_bouts
    #   * it is the bigger animal                               -> L_mm (structural)
    # `solo_peak` is each animal's own median rear-bout peak height, measured over ALL
    # its rear bouts, so "taller" can be defined without reference to the display in
    # which the two are being compared.
    per_track = []
    for a in range(2):
        peaks = [float(np.nanmax(nz[bs:be, a])) for bs, be in own[a]
                 if np.isfinite(nz[bs:be, a]).any()]
        peaks_mm = [float(np.nanmax(nz_mm[bs:be, a])) for bs, be in own[a]
                    if np.isfinite(nz_mm[bs:be, a]).any()]
        per_track.append({
            # `181323_3` -> animal 181323; the suffix is the within-session slot,
            # not part of the identity (the same animal appears as _0/_1/_3 in
            # different sessions).
            "animal": names[a].split("_")[0],
            "track_name": names[a],
            "L_mm": float(L[a]),
            "L_mm_half1": L_half[a][0], "L_mm_half2": L_half[a][1],
            "solo_peak_mm": float(np.median(peaks_mm)) if peaks_mm else float("nan"),
            "n_taller_mm": sum(1 for e_ in events if e_["taller_track_mm"] == a),
            "rear_frac": float(np.mean(rear[:, a])),
            "n_rear_bouts": len(own[a]),
            "solo_peak": float(np.median(peaks)) if peaks else float("nan"),
            "n_lead": sum(1 for e_ in events if e_["initiator_track"] == a),
            "n_taller": sum(1 for e_ in events if e_["taller_track"] == a),
            "base_speed": float(base_spd[a]),
        })

    med = lambda k: float(np.median([x[k] for x in events]))
    angle_hist = {k: np.histogram(np.concatenate(v) if v else np.array([]),
                                  bins=ANGLE_BIN_EDGES_DEG)[0].tolist()
                 for k, v in angle_frames.items()}
    return {
        "session": session, "fps": fps, "minutes": F / fps / 60.0,
        "experimental_code": code,
        "body_length_mm": Lm, "n_events": len(events),
        "rate_per_min": len(events) / (F / fps / 60.0),
        "med": {k: med(k) for k in ("dur_s", "peak_hi", "peak_lo", "height_match",
                                    "min_nose_gap", "base_gap", "ratio", "speed_rel")},
        "events": events,
        "peri": {k: (np.nanmedian(np.asarray(v), axis=0).tolist() if v else None)
                 for k, v in (("gap", peri_gap), ("hi", peri_hi), ("lo", peri_lo),
                              ("t0", peri_t0), ("t1", peri_t1),
                              ("dsep", peri_dsep), ("spd_init", peri_spd_i),
                              ("spd_follow", peri_spd_f),
                              ("spd_t0", peri_spd_t0), ("spd_t1", peri_spd_t1),
                              ("pursuit_t0", peri_pursuit_t0),
                              ("pursuit_t1", peri_pursuit_t1))} | {
                     "n": len(peri_gap), "half_window": w},
        # PER-SESSION INITIATOR BIAS, off the animal's IDENTITY (track), not its
        # height: the share of resolvable displays started by whichever of the two
        # animals started more of them. 0.5 = no leader, 1.0 = one animal starts
        # every display. An earlier version keyed this off `initiator_is_taller`,
        # which measures something else entirely -- whether the initiator happened to
        # be the one that reached higher in that display.
        "initiator_bias": _bias([e_["initiator_track"] for e_ in events
                                 if e_["initiator_track"] is not None]),
        "n_initiator_known": sum(1 for e_ in events
                                 if e_["initiator_track"] is not None),
        "per_track": per_track,
        "examples": examples[:6],
        "angle_hist": angle_hist,
    }


def _session(sd):
    ld = _load(sd)
    if ld is None:
        return None
    return session_upright(*ld, os.path.basename(sd))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jobs", type=int, default=14)
    ap.add_argument("--out", type=Path, default=OUT / "fig5_upright.json")
    args = ap.parse_args()
    sds = [d for d in sorted(glob.glob(f"{BMIMICA}/*")) if os.path.isdir(d)]
    with ProcessPoolExecutor(max_workers=args.jobs) as ex:
        rows = [r for r in ex.map(_session, sds) if r]

    allev = [e for r in rows for e in r["events"]]
    fps = min(r["fps"] for r in rows)
    w = int(round(WIN_S * fps))
    t = np.arange(-w, w + 1) / fps
    peri = {}
    # TEN SERIES, not just the three the first version had: dsep / spd_init /
    # spd_follow were being computed per session and then silently dropped here, so
    # the deposit carried `null` for them and the velocity panel had nothing to draw.
    # t0/t1 (2026-08-21) are the track-indexed twins of hi/lo, and spd_t0/spd_t1 the
    # track-indexed twins of spd_init/spd_follow -- see the peri_t0/t1 and
    # peri_spd_t0/t1 comments above session_upright's event loop.
    for key in ("gap", "hi", "lo", "t0", "t1", "dsep", "spd_init", "spd_follow",
                "spd_t0", "spd_t1", "pursuit_t0", "pursuit_t1"):
        cur = []
        for r in rows:
            c = r["peri"].get(key)
            if c is None:
                continue
            wr = r["peri"]["half_window"]
            cur.append(np.interp(t, np.arange(-wr, wr + 1) / r["fps"],
                                 np.asarray(c, float)))
        if not cur:
            peri[key] = None
            continue
        a = np.asarray(cur)
        peri[key] = {"n_sessions": int(a.shape[0]),
                     "p25": np.nanpercentile(a, 25, axis=0).tolist(),
                     "p50": np.nanmedian(a, axis=0).tolist(),
                     "p75": np.nanpercentile(a, 75, axis=0).tolist()}
    # ANGLE HISTOGRAMS ARE PLAIN COUNTS, so summing across sessions is exact --
    # no interpolation needed the way the peri time courses need it.
    angle_hist = {k: np.sum([r["angle_hist"][k] for r in rows], axis=0).tolist()
                 for k in ("head_t0", "head_t1", "body_t0", "body_t1")}
    res = {
        "corpus": "BMimica", "n_sessions": len(rows), "n_events": len(allev),
        "rear_frac": REAR_FRAC, "near_bl": NEAR_BL, "min_event_s": MIN_EVENT_S,
        "edges": EDGES, "nodes": NODES,
        "angle_hist": angle_hist,
        "angle_bin_edges_deg": ANGLE_BIN_EDGES_DEG.tolist(),
        "t": t.tolist(), "peri": peri,
        "per_session": [{k: r[k] for k in ("session", "n_events", "rate_per_min",
                                           "body_length_mm", "minutes", "med",
                                           "initiator_bias", "n_initiator_known",
                                           "per_track", "experimental_code")}
                        for r in rows],
        "events": allev,
        "examples": [e for r in rows for e in r["examples"]],
    }
    args.out.parent.mkdir(parents=True, exist_ok=True)
    args.out.write_text(json.dumps(res))

    print(f"{len(rows)} sessions, {len(allev):,} mutual-upright events "
          f"({np.median([r['rate_per_min'] for r in rows]):.2f}/min median)")
    for k in ("dur_s", "peak_hi", "peak_lo", "height_match", "min_nose_gap",
              "base_gap", "ratio", "speed_rel", "lag_s", "approach_bl_s",
              "hold_bl_s", "elev_hi", "elev_lo"):
        v = np.array([e[k] for e in allev], float)
        v = v[np.isfinite(v)]
        print(f"  {k:14} median {np.median(v):6.2f}   p25-p75 "
              f"{np.percentile(v, 25):6.2f}-{np.percentile(v, 75):6.2f}")
    tall = [e["initiator_is_taller"] for e in allev
            if e["initiator_is_taller"] is not None]
    bias = [r["initiator_bias"] for r in rows if r["initiator_bias"] is not None]
    print(f"  initiator resolved on {len(tall)}/{len(allev)} displays; it is the "
          f"TALLER animal in {sum(tall)} ({100 * np.mean(tall):.0f}%)")
    print(f"  per-session initiator bias: median {np.median(bias):.3f} "
          f"(range {min(bias):.2f}-{max(bias):.2f}, n={len(bias)} sessions) "
          f"-- NOTE this max(share) statistic is 1.00 by construction on the "
          f"{sum(1 for r in rows if r['n_events'] < 5)} sessions with <5 displays")
    # PER ANIMAL, which is the unit of replication. Every animal is paired with
    # several partners, so "does this individual start displays" is separable from
    # "is this pair asymmetric" -- and only the first is about the animal.
    led, tot, partners = {}, {}, {}
    for r in rows:
        a0, a1 = (t["animal"] for t in r["per_track"])
        for a, b, k in ((a0, a1, 0), (a1, a0, 1)):
            led[a] = led.get(a, 0) + r["per_track"][k]["n_lead"]
            tot[a] = tot.get(a, 0) + r["n_events"]
            partners.setdefault(a, set()).add(b)
    print("  per-animal initiation share (displays, partners):")
    for a in sorted(tot, key=lambda a: -tot[a]):
        print(f"    {a:9} {led[a]:4}/{tot[a]:4} = {led[a] / tot[a]:.2f}  "
              f"{len(partners[a])} partners")
    print(f"  examples exported: {len(res['examples'])}")
    print(f"[json] {args.out}")


if __name__ == "__main__":
    main()
