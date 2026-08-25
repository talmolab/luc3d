"""Shared data/constants for the identity-switch illustration: the two
animals' REAL 3D "comet trails" through a real close approach, anchored at the
exact frame shown on the two cameras' image planes, plus pose overlays drawn
directly ON those image planes -- one camera's overlay correct, the other's
swapped.

TWO DATASETS (select with the IDSWITCH_DATASET env var; default "hardfight"):

  - "hardfight" (the default): the 20260605_133431-HardFight recording --
    8 cameras, 60 fps, 3 mice, same 15-node skeleton (Eric: "these side views
    look a bit off still ... either we should use two top views or use the
    hard fight dataset side views and top views for this example", picking
    HardFight side+top "should be similar angles though if possible"). It
    ships NO proofread 3D, so hardfight_common.py triangulates the needed
    frames itself (cross-view association + multi-view DLT + fitted floor
    alignment -- see its docstring; body sizes come out 64-88 mm nose-TTI,
    median reprojection error 2-4 px). The figure shows the CLOSEST PAIR of
    the three mice; the third is far away at the chosen event and outside
    both photo crops. The 2D overlays are the triangulated 3D reprojected
    through the calibration -- the same 3D-consistent quantity the SLAP-2M
    reprojections.h5 carries.
  - "slap2m": the original 2-animal SLAP-2M session (chen_common.SESSION,
    "2022-10-07/10072022180149") with its shipped proofread points3d.h5 /
    reprojections.h5. KEPT FULLY REPRODUCIBLE (Eric: "maybe keep the old
    versions too so dont delete them"): every slap2m artifact keeps its old,
    unsuffixed filename (idswitch_fig_data.json, idswitch_render.png,
    lucid_idswitch_style.png, ...), while hardfight writes *_hardfight.*
    beside them -- so the two variants never overwrite each other.

THE TRAIL IS THE REAL TRAJECTORY, ANCHORED AT IMAGE_FRAME (Eric: "the 3d
trajectory should start with the same frame that is shown in the two views,
then the previous frames should be added as colored 3d trajectories, then the
subsequent frames should be added as gray trajectories"). Each trail is the
animal's real tracked poses at real positions for the frames
TRAIL_FRAMES_PRE + [IMAGE_FRAME] + TRAIL_FRAMES_POST:
  - PRE frames: the animal's own colour, fading with age (older = fainter) --
    identity still confidently tracked up to the shown moment;
  - IMAGE_FRAME (index ANCHOR_INDEX): the emphasized "current" pose, full
    opacity and slightly larger -- BY CONSTRUCTION the exact same real 3D pose
    at the exact same real position as the overlays on both image planes, so
    every spatial relation the photos show holds in the trail too;
  - POST frames: AMBIGUOUS_GREY (the same incorrect-hypothesis grey
    hyp_fig_style.py uses), fading into the future -- after the shown close
    approach the figure itself can no longer say which colour is which, so
    neither can the mark (Eric: "make the points that come after that get
    drawn in gry to show the ambiguity").

This REPLACES the earlier schematic-X design (real pose shapes restaged onto
idealised 45/-45- then real-heading paths crossing at the origin). That design
went through three rejected rounds -- raw real trails "very unclear", then
"is the orange one walking backwards?", then trail-vs-photo direction
contradictions ("the blue trajectory is moving to the left in 3d ... but the
blue is facing right in the side view") -- because ANY trail invented
independently of the photos can contradict them somewhere. Anchoring the real
trajectory at the photos' own frame removes the whole failure class.

The full slap2m frame-choice history (2590 -> 2608 -> 2632 -> 2624 -> 2212,
each re-picked on Eric's feedback) is kept below with the slap2m constants.
"""
import os

import numpy as np
import toml

import chen_common as cc

DATASET = os.environ.get("IDSWITCH_DATASET", "hardfight")
assert DATASET in ("hardfight", "slap2m"), DATASET

HERE = cc.HERE
MM = cc.MM
NODE_NAMES = cc.NODE_NAMES
MOUSE_EDGE_IDXS = cc.MOUSE_EDGE_IDXS

#: blue / orange -- chen_common's established identity colours.
COLOR_A, COLOR_B = cc.TAB10_MAIN, cc.TAB10_OTHER

AMBIGUOUS_GREY = "#B8B8B8"  # matches hyp_fig_style.py's INCORRECT_GREY

#: If True, an image-plane quad whose BACK side faces the staging eye gets its
#: texture + overlay mirrored (idswitch_fig_prep.mirror_quad_if_back_side) so
#: its photo reads pixel-for-pixel like the raw camera image. Tried once for
#: the "side" quad and REJECTED (Eric: "i think you are flipping the side view
#: horizontally by accident"): the panes should behave as planes IN the staged
#: 3D scene -- a plane seen from behind legitimately shows the camera's image
#: mirrored, like a photographic slide viewed from its back, and that is how
#: every accepted draft rendered it. Kept as a switch (not deleted) because
#: the raw-picture convention is the other defensible reading and the
#: side-vs-anchor left/right comparison differs between the two.
MIRROR_BACKSIDE_QUADS = False

ALPHA_MIN, ALPHA_MAX = 0.12, 0.62

#: Render the displacement-spaced comet trails around the anchor pose?
#: FALSE as of 2026-08-25 (Eric: "lets get rid of the trajectories, so just
#: make it the 3d instances from that same one frame"). The figure's claim is
#: now purely the CORRESPONDENCE one -- one 3D instance per animal at
#: IMAGE_FRAME, tied to its 2D detection in each pane by a triangle of
#: association lines, exactly like the hypothesis figure this panel sits
#: beside (13c). The trails answered a different question (what happens to
#: identity AFTER the crossing), and with the association triangle drawn on
#: top of them the same picture was carrying two claims at once.
#:
#: The whole trail machinery is KEPT, not deleted -- load_figure_data still
#: computes the per-animal displacement-spaced trails and the JSON still
#: carries them, so flipping this back to True restores the old figure
#: without re-running anything upstream. TRAIL_SCALE / ALPHA_MIN / ALPHA_MAX
#: are unused while it is False, for the same reason.
SHOW_TRAILS = False

#: Margin (mm) around the RENDERED 3D content when the floor plate is sized.
#: With the trails gone the deposited `floor_half` (sized to every trail
#: point, 254 x 413 mm) is mostly empty plate around two animals huddled in
#: one corner, so the floor is re-derived from the anchor poses alone -- see
#: render_floor_half. 70, not prep's own 55: the anchors span only
#: ~125 x 139 mm, and at 55 the plate crowds the bodies.
FLOOR_MARGIN_MM = 70.0

#: ball/tube scale for the NON-anchor trail steps. A close encounter's poses
#: crowd a small region, so full-size ghosts pile up into an unreadable
#: tangle -- shrinking every step except the anchor keeps the trails reading
#: as comet trails while the two anchor poses (the ones that match the image
#: planes) stay dominant.
TRAIL_SCALE = 0.95  # 0.55 -> 0.72 -> 0.95 (Eric: "make the 3d bigger too",
                    # then again 2026-08-25 "we should make the 3d bigger too"
                    # -- the panel also shrank from ~138 mm to c's ~100 mm width
                    # in the fig13 row-2 rebuild, so the marks must grow to keep
                    # their apparent size)

#: Ball/tube scale for the anchor pose -- the one matching the image planes,
#: and with SHOW_TRAILS off the ONLY 3D the scene draws. Was a hardcoded 1.5
#: in idswitch_fig_scene.py, briefly 1.9 when the trails were still present
#: and the anchor had to dominate them.
#:
#: 1.0 = cage_scene.NODE_R UNSCALED, which is exactly what cs.build_animal
#: gives the 3D animals in the hypothesis figure this panel is now a sibling
#: of (Eric: "it should make a triangule like c"), so the two panels' 3D reads
#: at one size. It is also the only value at which this event is legible: the
#: two mice are 62 mm apart in face-to-face contact, and at 1.9 their balls
#: fused into a single blob with no skeleton visible -- scaling UP past ~1.2
#: makes the 3D bigger and less interpretable at the same time.
ANCHOR_SCALE = 1.0

if DATASET == "hardfight":
    # ---- HardFight variant -------------------------------------------------
    #: sideL + mid: the closest analogues of the slap2m figure's side + top
    #: (Eric: "should be similar angles though if possible") -- sideL is a low
    #: oblique side view (~24 degrees elevation, vs the slap2m side camera's
    #: ~28) sitting ~480 mm out, about the slap2m side camera's distance, so
    #: the prop + pane + floor pack tightly like the hyp sidetop composition;
    #: mid is directly overhead (580 mm up, over the arena centre). sideC was
    #: tried first (a true 145-mm-high profile view) but sits 830 mm out --
    #: twice slap2m's side distance -- which left its pane floating far from
    #: both its prop and the floor, a hollow composition.
    CAM_A_NAME, CAM_B_NAME = "Camera6_sideL", "Camera0_mid"
    #: short display names for the figure labels (the raw camera names are
    #: rig-internal).
    CAM_A_LABEL, CAM_B_LABEL = "side", "top"
    #: where each short name is set RELATIVE TO ITS OWN PROP -- "above" /
    #: "right" / "corner" (the quad's bottom-right corner, for a prop that is
    #: genuinely hidden behind its own pane). Stated per dataset rather than
    #: inferred: idswitch_fig_style.py used to guess this from whether the
    #: prop fell inside the quad, and the side camera defeated BOTH guesses --
    #: its prop straddles the pane's right edge, so its centre is inside the
    #: diamond (and inside the diamond's much larger bbox) while the prop
    #: itself is plainly visible, which banished "side" to the pane's bottom
    #: corner where it then collided with "correct IDs". Two cameras per
    #: variant is not enough to earn a heuristic.
    CAM_A_LABEL_POS, CAM_B_LABEL_POS = "above", "right"
    FPS = 60.0

    #: IMAGE_FRAME = 21144, picked by scanning all 36,000 frames for
    #: close-PAIR events (overhead 2D prefilter: exactly 3 detections, pair
    #: centroids 40-130 px apart, third mouse > 260 px away; then 3D
    #: verification). The three cleanest by eye (extracted overlaid photos):
    #: 1576 (nose-to-nose), 13048 (parallel side-by-side), 21144. 21144 wins
    #: on all counts: face-to-face contact at 62 mm separation, BOTH skeletons
    #: complete (15/15 triangulated nodes through the whole trail window) and
    #: cleanly separated in BOTH cameras, the third mouse outside both crops,
    #: and the best motion story -- A walks up to the resting B, contact,
    #: then both dash apart in opposite directions.
    IMAGE_FRAME = 21144

    #: TRAIL FRAMES ARE PICKED BY DISPLACEMENT, NOT AT A FIXED FRAME STEP
    #: (Eric: "can we space out the trajectories before and after and choose a
    #: longer timeline"): fixed 16-frame steps sampled only the slow contact
    #: moment, piling the ghosts onto one spot, while the encounter's real
    #: sweep -- A walks in from (-152, 5) along a curve and flees to (-70, 69),
    #: B comes down from (-125, 73) and drops away, ~190 mm of travel EACH way
    #: -- spans ~+-10 s. So the loader walks TRAIL_SPAN frames each side of
    #: the anchor at TRAIL_LINK_STEP (fine enough that nearest-centroid
    #: identity linking cannot jump animals at this event's speeds), then
    #: keeps, PER ANIMAL, the frames where the centroid has moved
    #: TRAIL_SPACING_MM since the last kept pose -- up to TRAIL_MAX_PRE /
    #: TRAIL_MAX_POST steps. The two animals therefore have their OWN frame
    #: lists (each anchored at IMAGE_FRAME, whose pose is still exactly what
    #: the image planes show); a shared list cannot space both, since they
    #: rest at different times.
    TRAIL_SPAN = 620
    TRAIL_LINK_STEP = 12
    TRAIL_SPACING_MM = 40.0
    TRAIL_MAX_PRE, TRAIL_MAX_POST = 6, 4

    #: staging angles matched to lucid_hyp_style_sidetop.png (Eric: "i would
    #: like to use a similar camera angle to the [hyp sidetop] one, and try to
    #: preserve that because it looks good"). Derivation: the hyp sidetop
    #: staging (azim 290 AS IT WAS WHEN THIS WAS DERIVED -- hyp_common moved it
    #: to 286 on 2026-08-25 to separate 13c's own correspondence triangles; this
    #: panel's angle was NOT re-derived from the new value, because it was
    #: signed off as it stands and 4 degrees of a borrowed relative geometry is
    #: not a reason to disturb a settled composition) sits 287 degrees from the SLAP-2M
    #: "side" camera's own aligned-frame azimuth (3); HardFight's sideL sits
    #: at aligned azimuth -74, so the same relative geometry puts the staging
    #: eye at -74 + 287 = 213. elev raised 30 -> 34 with the compaction pass
    #: (Eric: "we need to make the figure much more compact") -- a slightly
    #: higher eye foreshortens the vertical gaps between floor, panes and
    #: props.
    STAGING_VIEW = {"azim": 213, "elev": 34, "ortho_scale": 2.0, "dist": 2.6}

    #: image-plane standoff (fraction of camera-to-animals distance) and size
    #: multiplier, per camera -- same SMALL-standoff regime as the slap2m/hyp
    #: figures: each pane hugs its own camera prop (their gap is frac x
    #: distance), which is what makes those compositions read tight. Scales
    #: raised in the compaction pass: the crops are tight around two huddled
    #: mice, so at the slap2m scales the panes came out small and left the
    #: canvas centre empty.
    #: QUAD_SCALE_A 10.0 -> 8.6 on 2026-08-25 (Eric: "you could also make the
    #: side view a little smaller in d to keep the rectangular shape, just by a
    #: small amount"). Tucking "correct IDs" under this pane left the panel's
    #: crop nearly square, and the side pane is the tallest single element in
    #: it -- shrinking it raises its bottom corner, which is what the tucked
    #: label hangs off, so the crop's bottom edge comes up with it and the
    #: panel goes back to a landscape rectangle. Small on purpose: the pane
    #: still has to carry two legible skeletons.
    QUAD_STANDOFF_FRAC_A, QUAD_SCALE_A = 0.18, 8.6
    QUAD_STANDOFF_FRAC_B, QUAD_SCALE_B = 0.30, 4.6
    #: tighter photo crops than slap2m's 110 px -- the two mice huddle, so a
    #: wide margin just adds empty dark grid to each pane (compaction pass).
    QUAD_MARGIN_PX = 80

    _SUFFIX = "_hardfight"
else:
    # ---- SLAP-2M variant (the original figure -- kept reproducible) --------
    SESSION = cc.SESSION
    #: the two (only) animals in this session -- chen_common's own established
    #: track order, already used for this exact session in the Chen-style
    #: figure.
    TRACK_A, TRACK_B = cc.TRACK_MAIN, cc.TRACK_OTHER
    CAM_A_NAME, CAM_B_NAME = "side", "top"
    CAM_A_LABEL, CAM_B_LABEL = "side", "top"
    #: reproduces exactly what the old heuristic chose on this variant -- its
    #: side prop really is behind its own pane. See the hardfight block.
    CAM_A_LABEL_POS, CAM_B_LABEL_POS = "corner", "right"
    FPS = 30.0

    #: the instant used for the two cameras' own image-plane overlays AND as
    #: the trail anchor.
    #:
    #: RE-PICKED REPEATEDLY. From 2590 (Eric: "still looks like the pose is
    #: backwards" -- one animal fully hidden at 89/80 px separation, so its
    #: real keypoints matched nothing visible). From 2608 (Eric: "both
    #: animals in the image plane are facing the same direction while the
    #: trajectories are facing different directions" -- real headings only 12
    #: degrees apart there). To 2632 (headings ~90 degrees apart, both
    #: animals identifiable in both views). To 2624 (Eric: "closer together"
    #: -- 97/116 px, nose-to-nose; the still-closer 2592/2644 tangle into one
    #: knot). Then the whole 2500-2700 scenario was dropped (Eric: "lets pick
    #: a different frame and a different scenario? the pose doesnt look great
    #: for these sesssions anyways") and the full 18,247-frame session
    #: scanned for V-shaped close encounters (2D separation 60-170 px in
    #: both cameras, 3D separation 60+ mm larger 40 frames before and after,
    #: extended grounded poses, both animals moving, +-48 frames fully
    #: tracked). Three events survive: 336, 2212, 17414; 2212 is the cleanest
    #: by eye (89/85 px, diagonals 230/232 mm) -- 336 has blue's tail chain
    #: floating oddly, 17414's orange side view is a sprawl.
    IMAGE_FRAME = 2212
    #: 8-frame steps (~0.27 s at 30 fps). PRE starts at 2180 because blue
    #: rests at one spot until ~2188; POST stops at 2236, after which both
    #: animals settle (blue) or loop back across the pre-trail (orange).
    TRAIL_FRAMES_PRE = [2180, 2188, 2196, 2204]
    TRAIL_FRAMES_POST = [2220, 2228, 2236]

    #: azim/elev history: (250, 32) viewed the side quad 14.6 degrees off
    #: edge-on (overlays collapsed to a diagonal -- an optical illusion);
    #: (355, 50) put the eye behind the side camera (Eric: "i dont like being
    #: behind the side camera"); (210, 18) faces the props and keeps both
    #: quads clear of edge-on.
    STAGING_VIEW = {"azim": 210, "elev": 18, "ortho_scale": 2.0, "dist": 3.5}

    QUAD_STANDOFF_FRAC_A, QUAD_SCALE_A = 0.16, 3.4 * 2.3
    QUAD_STANDOFF_FRAC_B, QUAD_SCALE_B = 0.30, 3.4
    QUAD_MARGIN_PX = 110

    _SUFFIX = ""

DATA_JSON = os.path.join(HERE, "renders", f"idswitch_fig_data{_SUFFIX}.json")
STAGING_CAMERA_JSON = os.path.join(HERE, "renders", f"idswitch_staging_camera{_SUFFIX}.json")
RENDER_PNG = os.path.join(HERE, "renders", f"idswitch_render{_SUFFIX}.png")
OUT_PNG_NAME = f"lucid_idswitch_style{_SUFFIX}.png"


def photo_path(cam_tag):
    return os.path.join(HERE, "renders", f"idswitch_photo_{cam_tag}{_SUFFIX}.png")


def trail_frames():
    """(slap2m only) the shared trail frames, oldest first."""
    return TRAIL_FRAMES_PRE + [IMAGE_FRAME] + TRAIL_FRAMES_POST


def anchor_poses(data):
    """(2, 15, 3) aligned mm -- the two animals' poses at IMAGE_FRAME, i.e.
    the ONE frame both image planes show. Read out of the deposited trails at
    their per-animal anchor indices, so this is by construction the same 3D
    the panes' overlays reproject. ONE definition, shared by the scene (what
    it builds) and the compositor (where it routes the association lines)."""
    import numpy as _np
    tr = [_np.array(data["trail_al_a"]), _np.array(data["trail_al_b"])]
    idx = [data["anchor_index_a"], data["anchor_index_b"]]
    return _np.stack([tr[k][idx[k]] for k in range(2)])


def render_floor_half(data):
    """The floor rectangle actually RENDERED, as prep's `floor_half` dict.

    Sized to whatever 3D the scene draws: every trail point when SHOW_TRAILS,
    the two anchor poses alone otherwise (see FLOOR_MARGIN_MM). Shared by
    idswitch_fig_scene.py (which builds the plate) and idswitch_fig_style.py
    (whose content crop projects its corners) -- they must agree or the crop
    clips the plate it is trying to contain."""
    import numpy as _np
    if SHOW_TRAILS:
        return data["floor_half"]
    p = anchor_poses(data).reshape(-1, 3)
    m = FLOOR_MARGIN_MM
    return {"x0": float(p[:, 0].min() - m), "x1": float(p[:, 0].max() + m),
            "y0": float(p[:, 1].min() - m), "y1": float(p[:, 1].max() + m)}


def staging_camera(trail_al_list, res=(2600, 2000)):
    """The staging camera, built from STAGING_VIEW + the trail's own focus --
    ONE definition shared by idswitch_fig_prep.py (which needs the eye position
    to decide per-quad mirroring, see mirror_quad_if_back_side there) and
    idswitch_fig_scene.py (which renders with it). Focus: trail centroid at a
    fixed 0.08 m height."""
    pts = np.concatenate([np.asarray(t).reshape(-1, 3) for t in trail_al_list])
    focus = (pts.mean(axis=0) * MM).tolist()
    focus[2] = 0.08
    v = STAGING_VIEW
    return cc.StagingCamera(focus=focus, azim_deg=v["azim"], elev_deg=v["elev"],
                            ortho_scale=v["ortho_scale"], res=res, dist=v["dist"])


def video_glob(cam_name):
    """Glob for this camera's video (for hyp_fig_prep.extract_photo)."""
    if DATASET == "hardfight":
        import hardfight_common as hf
        return f"{hf.SESSION_VID}/{cam_name}/*.mp4"
    return f"{SESSION}/{cam_name}/{cam_name}-*_h265_CRF12_denoised.mp4"


def load_calibration_all():
    if DATASET == "hardfight":
        import hardfight_common as hf
        return hf.load_calibration_all()
    cal = toml.load(f"{SESSION}/calibration.toml")
    cams = {}
    for key, v in cal.items():
        if key.startswith("cam_"):
            cams[v["name"]] = cc.Camera(v)
    return cams


def load_figure_data():
    """Everything frame-specific the prep needs, dataset-independently, as a
    dict: trail_al ([A (Ta,15,3), B (Tb,15,3)] aligned mm -- the two animals'
    trails, whose lengths and frames may DIFFER per animal), trail_frames
    ([framesA, framesB]), anchor_index ([ia, ib] -- the index of IMAGE_FRAME's
    pose in each trail), S_by_cam (CAM_A_NAME/CAM_B_NAME -> (2,15,2) px 2D at
    IMAGE_FRAME; the 3D reprojected through the calibration -- for slap2m
    exactly what reprojections.h5 stores), ali, cams."""
    cams = load_calibration_all()
    if DATASET == "hardfight":
        return _hf_figure_data(cams)
    return _slap2m_figure_data(cams)


def _slap2m_figure_data(cams):
    import h5py
    ali = cc.Alignment(toml.load(f"{SESSION}/alignment.toml"))
    with h5py.File(f"{SESSION}/points3d.h5") as f:
        tracks = f["tracks"][:]  # (frames, 2, 15, 3) mm, calib-world
    frames = trail_frames()
    trail = []
    for f in frames:
        X = ali.point(tracks[f].reshape(-1, 3)).reshape(2, 15, 3)
        trail.append(X[[TRACK_A, TRACK_B]])
    trail = np.array(trail)  # (T,2,15,3)
    assert not np.isnan(trail).any(), "trail frame with untracked points"
    S_by_cam = {}
    with h5py.File(f"{SESSION}/reprojections.h5") as h5:
        for cam in (CAM_A_NAME, CAM_B_NAME):
            S_by_cam[cam] = h5[cam][IMAGE_FRAME][[TRACK_A, TRACK_B]]
    ia = frames.index(IMAGE_FRAME)
    return {"trail_al": [trail[:, 0], trail[:, 1]],
            "trail_frames": [frames, frames],
            "anchor_index": [ia, ia],
            "S_by_cam": S_by_cam, "ali": ali, "cams": cams}


def _hf_figure_data(cams):
    """HardFight: walk TRAIL_SPAN frames each side of IMAGE_FRAME at
    TRAIL_LINK_STEP, triangulating (hardfight_common) and linking the CLOSEST
    PAIR at IMAGE_FRAME outward by nearest centroid; order the pair [A, B]
    with A = the member that travels farther (the mover -- blue). Then pick
    each animal's OWN trail frames by displacement: keep a walked frame when
    its centroid is TRAIL_SPACING_MM from the last kept one (see the
    TRAIL_SPACING_MM comment for why per-animal, not shared)."""
    import hardfight_common as hf
    slp = hf.load_all_slp()
    ali = hf.load_alignment(slp, cams)

    frames = list(range(IMAGE_FRAME - TRAIL_SPAN, IMAGE_FRAME + TRAIL_SPAN + 1,
                        TRAIL_LINK_STEP))
    if IMAGE_FRAME not in frames:
        frames.append(IMAGE_FRAME)
        frames.sort()

    calib_by, cen_by = {}, {}
    for f in frames:
        X, _ = hf.poses_calib(slp, cams, f)
        calib_by[f] = X
        cen_by[f] = np.nanmean(ali.point(X.reshape(-1, 3)).reshape(X.shape)[:, :, :2], 1)

    cf = cen_by[IMAGE_FRAME]
    n = len(cf)
    assert n >= 2, f"only {n} animals at IMAGE_FRAME"
    d = {(i, j): np.linalg.norm(cf[i] - cf[j]) for i in range(n) for j in range(i + 1, n)}
    pair = list(min(d.items(), key=lambda kv: kv[1])[0])

    picked = {IMAGE_FRAME: pair}
    for direction in (1, -1):
        idx = frames.index(IMAGE_FRAME)
        ref = np.array([cf[pair[0]], cf[pair[1]]])
        while True:
            idx += direction
            if idx < 0 or idx >= len(frames):
                break
            f = frames[idx]
            c = cen_by[f]
            out, used = [], set()
            for r in ref:
                dd = np.linalg.norm(c - r, axis=1)
                j = next(j for j in np.argsort(dd) if j not in used)
                out.append(int(j))
                used.add(int(j))
            picked[f] = out
            ref = np.array([c[out[0]], c[out[1]]])

    # A = the pair member that travels farther over the window (the mover).
    trav = [sum(np.linalg.norm(cen_by[f2][picked[f2][k]] - cen_by[f1][picked[f1][k]])
                for f1, f2 in zip(frames, frames[1:])) for k in range(2)]
    order = [0, 1] if trav[0] >= trav[1] else [1, 0]

    def animal_cen(f, k):
        return cen_by[f][picked[f][order[k]]]

    def animal_pose_al(f, k):
        Xc = calib_by[f][picked[f][order[k]]]
        return ali.point(Xc)

    # displacement-spaced frame selection, per animal, anchored at IMAGE_FRAME
    trail_frames_ab, trails, anchor_idx = [], [], []
    fi = frames.index(IMAGE_FRAME)
    for k in range(2):
        pre, post = [], []
        last = animal_cen(IMAGE_FRAME, k)
        for f in reversed(frames[:fi]):
            if len(pre) >= TRAIL_MAX_PRE:
                break
            if np.linalg.norm(animal_cen(f, k) - last) >= TRAIL_SPACING_MM:
                pre.append(f)
                last = animal_cen(f, k)
        pre.reverse()
        last = animal_cen(IMAGE_FRAME, k)
        for f in frames[fi + 1:]:
            if len(post) >= TRAIL_MAX_POST:
                break
            if np.linalg.norm(animal_cen(f, k) - last) >= TRAIL_SPACING_MM:
                post.append(f)
                last = animal_cen(f, k)
        fs = pre + [IMAGE_FRAME] + post
        T = np.array([animal_pose_al(f, k) for f in fs])
        assert not np.isnan(T).any(), f"animal {k} trail frame with untracked points"
        trail_frames_ab.append(fs)
        trails.append(T)
        anchor_idx.append(len(pre))
        print(f"  animal {'AB'[k]}: {len(pre)} pre + anchor + {len(post)} post "
              f"(frames {fs[0]}..{fs[-1]}, {(fs[-1]-fs[0])/FPS:.1f}s)")

    anchor_calib = calib_by[IMAGE_FRAME][[picked[IMAGE_FRAME][order[0]],
                                          picked[IMAGE_FRAME][order[1]]]]
    # PINHOLE (undistorted-image) coordinates, NOT cams[cam].project: the
    # pane photos are undistorted, and this rig's distortion is strong -- see
    # hardfight_common.project_pinhole.
    S_by_cam = {}
    for cam in (CAM_A_NAME, CAM_B_NAME):
        S_by_cam[cam] = np.stack([hf.project_pinhole(cams[cam], a) for a in anchor_calib])
    return {"trail_al": trails, "trail_frames": trail_frames_ab,
            "anchor_index": anchor_idx,
            "S_by_cam": S_by_cam, "ali": ali, "cams": cams}


def quad_camera(cam):
    """The camera to hand hyp_fig_prep.prep_camera for image-plane-quad
    geometry. hardfight: a DISTORTION-FREE copy -- the pane textures are
    undistorted frames and the overlays are pinhole projections, so the quad
    machinery must treat its pixel inputs as undistorted coordinates too
    (this rig's k1 = -0.36 makes the mismatch visible; see
    hardfight_common.project_pinhole). slap2m: the camera unchanged --
    preserved exactly as the original figure was built (its reprojections.h5
    pixels are distorted-image coordinates and its distortion is mild)."""
    if DATASET == "hardfight":
        import hardfight_common as hf
        return hf.pinhole_camera(cam)
    return cam


