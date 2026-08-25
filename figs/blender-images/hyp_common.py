"""Shared data/camera math for the multi-view grouping-hypothesis figure: 3
real animals, 2 real cameras (very different viewpoints -- "side" is low and
near-horizontal, "top" is overhead, baseline 775mm, the largest of any pair in
this session), illustrating that a detection in one view could pair with any
detection in the other before geometry disambiguates them.

Reuses chen_common.py's camera model (Camera/Alignment/StagingCamera,
undistort/project, look-at basis) and skeleton constants (NODE_NAMES,
MOUSE_EDGES, TAB10 colors) rather than duplicating them -- both figures share
the same underlying SLAP-2M calibration format and mouse skeleton.

Session: 2022-10-07/10072022142111 (3 animals). Frame criteria: all three
grounded (no rearing, no keypoint above 130mm), minimum pairwise separation
>=250mm, and -- unlike the first frame tried (12554), where one animal's own
bounding-box "spread" was small enough to read as curled/folded on itself --
every animal's own node bounding-box diagonal >=140mm (an extended,
recognizable pose, not folded up). In-bounds with margin in "side", "top",
AND "topL" simultaneously, so the same frame serves both the side+top and
top+topL camera-pair variants.

FRAME was RE-PICKED TWICE after the distortion correction exposed data
problems the old convention had been blurring over. 6707 -> 11724 (Eric: "the
blue instance on the right just really doesnt align ... specifically the nose
doesnt seem to match"): at 6707 the blue animal is grooming with its head
tucked, and its 3D head chain is compressed AND wrong -- nose-Head 18.1mm
against 33/38mm for the other two animals -- so its reprojected nose lands on
the glass beside the mouse, on nothing visible. Criteria now additionally
require every animal's nose-Head distance >=26mm (an extended,
correctly-triangulated head). Then 11724 -> 11586 (Eric: "the tails look off
a bit, much closer though"): 11724 failed a tail-chain sanity check that is
now also part of the criteria -- every TTI->Tail_0->Tail_1->Tail_2->TailTip
segment 12-55mm, no turn sharper than ~100 degrees (no kinked/zigzag tail),
and the whole tail lying low (z < 70mm, tails rest on the bedding). 229
frames pass everything; 11586 has the most uniform tail segments (max
deviation from 30mm: 10.3mm; min separation 291mm, min nose-Head 36.9mm) and
was confirmed by eye on extracted side/top overlays: all three tails read as
smooth arcs lying on the bedding, blue's nose marker on the white mouse's
nose tip. Same interaction bout as 11724, so the animals sit in nearly the
same three corners and the composition is preserved.
"""
import os

import numpy as np
import toml

import chen_common as cc

HERE = cc.HERE
MM = cc.MM
NODE_NAMES = cc.NODE_NAMES
MOUSE_EDGE_IDXS = cc.MOUSE_EDGE_IDXS
TRUNK = cc.TRUNK
MEASURE_NODE_NAME = "Trunk"
MEASURE_IDX = TRUNK

SLAP2M = cc.SLAP2M
SESSION = f"{SLAP2M}/2022-10-07/10072022142111"
FRAME = 11586
N_ANIMALS = 3

#: the two real cameras used, by their calibration.toml name. Two variants:
#: "sidetop" (default, largest baseline in the session -- side is low and
#: near-horizontal, top is overhead) and "toptop" (top + topL, both overhead,
#: baseline only 121mm -- a much closer pair of viewpoints).
CAMERA_PAIRS = {
    "sidetop": ("side", "top"),
    "toptop": ("top", "topL"),
}
DEFAULT_VARIANT = "sidetop"

#: tab10, first 3 -- must match cage_scene.py's TAB10[:3]
TAB10_3 = ["#1F77B4", "#FF7F0E", "#2CA02C"]

#: display order of the session's tracks: position in this list = colour slot
#: (0 = blue "Animal 1", 1 = orange "Animal 2", 2 = green "Animal 3").
#: [1, 0, 2] swaps which mouse is blue and which is orange at frame 11586
#: (Eric: "this is better but switch the orange and blue colors") -- the
#: legend keeps blue = Animal 1; the two MICE trade colours. Applied once in
#: hyp_fig_prep.main to X_al/Sa/Sb, so every downstream consumer (floor
#: poses, pane overlays, correspondence lines) follows automatically.
TRACK_ORDER = [1, 0, 2]


def cam_names(variant):
    return CAMERA_PAIRS[variant]


#: staging camera azimuth/elevation per variant -- shared between
#: hyp_fig_prep.py (no bpy) and hyp_fig_scene.py (bpy), so it lives here.
STAGING_VIEW = {
    # azim 290 -> 286 on 2026-08-25 (Eric: "the orange and the green line kinda
    # overlap a lot, can we move the figure camera to the left or right
    # slightly so that we can see each triangle distinctively"). 290 sat in a
    # narrow spike: sweeping azimuth and measuring, for every pair of animals,
    # the length over which their coloured correspondence legs run within 26 px
    # of each other, orange/green is ~115 px everywhere EXCEPT 289-292, where
    # it jumps to ~570. Four degrees left drops it back to 114 and is the best
    # of the nearby angles on all three pairs at once (blue/orange 274,
    # blue/green 120) -- going RIGHT also clears orange/green but trades it for
    # blue/green, which more than doubles to ~277 by 295.
    "sidetop": {"azim": 286, "elev": 30, "ortho_scale": 2.0, "dist": 2.6},
    # top+topL are only 121mm apart (both overhead) -- the smallest baseline of
    # any pair in this session -- so from any angle their camera+quad clusters
    # land almost on top of each other (an honest consequence of the real
    # geometry, a much weaker view pair, but illegible as a figure: the two
    # photos visually overlap). SCHEMATIC_OFFSET_B_MM below pulls camera B's
    # prop+quad sideways by a fixed schematic amount to separate them, exactly
    # like fig_chen_correspondence.py's PANEL_OFFSET_M trick for its two (real,
    # identical) camera copies.
    "toptop": {"azim": 180, "elev": 30, "ortho_scale": 2.0, "dist": 2.6},
}
SCHEMATIC_OFFSET_B_MM = {"sidetop": 0.0, "toptop": 260.0}

#: Sideways schematic offset applied to camera A's PROP ALONE -- not its quad,
#: not its detections, not its poses (Eric, 2026-08-25: "for 13c can we move
#: the camera rendering for side to the right a bit"). On `sidetop` the side
#: camera stands almost in its own image plane's plane, so its prop renders
#: half-buried IN the pane's photo: a dark blue box on a dark grey image,
#: which is where "Camera A (side)" then has to be labelled. Nudging just the
#: prop clear of the pane's right edge separates the two.
#:
#: PROP ONLY, deliberately, and this is the difference from
#: SCHEMATIC_OFFSET_B_MM above (which moves prop AND quad AND that camera's
#: detections together, keeping them internally consistent): the panes'
#: positions were signed off as they are ("13c top and side view size is
#: good"), so the quad must not move. The cost is that the prop no longer sits
#: exactly where the pane's own perspective says the eye is -- acceptable in a
#: picture whose panes are already at a schematic standoff and scale, and the
#: same liberty B's offset takes.
SCHEMATIC_OFFSET_A_PROP_MM = {"sidetop": 135.0, "toptop": 0.0}


def schematic_offset_b(variant):
    """World-space (mm, aligned frame) offset applied ONLY to camera B's prop
    + quad (not its real detections' identity/geometry, and not camera A or
    the floor/animals) -- along the staging view's own screen-right axis, so
    it's a pure sideways separation in the rendered picture regardless of
    which variant's azimuth is in play."""
    return _screen_right_offset(variant, SCHEMATIC_OFFSET_B_MM[variant])


def schematic_offset_a_prop(variant):
    """World-space (mm, aligned frame) offset applied ONLY to camera A's PROP
    -- see SCHEMATIC_OFFSET_A_PROP_MM for what it is for and why it moves the
    prop without its quad."""
    return _screen_right_offset(variant, SCHEMATIC_OFFSET_A_PROP_MM[variant])


def _screen_right_offset(variant, amt):
    """`amt` mm along the staging view's own screen-right axis, so the shift is
    a pure sideways separation in the rendered picture whatever the variant's
    azimuth is."""
    if amt == 0.0:
        return np.zeros(3)
    view = STAGING_VIEW[variant]
    return cc.view_right_vector(view["azim"], view["elev"]) * amt


def data_json_path(variant):
    return os.path.join(HERE, "renders", f"hyp_fig_data_{variant}.json")


def photo_a_path(variant):
    a, _ = CAMERA_PAIRS[variant]
    return os.path.join(HERE, "renders", f"hyp_photo_{variant}_{a}.png")


def photo_b_path(variant):
    _, b = CAMERA_PAIRS[variant]
    return os.path.join(HERE, "renders", f"hyp_photo_{variant}_{b}.png")


def staging_camera_path(variant):
    return os.path.join(HERE, "renders", f"hyp_staging_camera_{variant}.json")


def render_path(variant):
    return os.path.join(HERE, "renders", f"hyp_correspondence_{variant}.png")


def load_calibration_all():
    cal = toml.load(f"{SESSION}/calibration.toml")
    cams = {}
    for key, v in cal.items():
        if not key.startswith("cam_"):
            continue
        cams[v["name"]] = cc.Camera(v)
    return cams


def load_alignment():
    return cc.Alignment(toml.load(f"{SESSION}/alignment.toml"))


def load_tracks3d():
    import h5py
    with h5py.File(f"{SESSION}/points3d.h5") as f:
        return f["tracks"][:]  # (frames, 3, 15, 3) mm, calib-world


def load_reprojections(cam_name):
    import h5py
    with h5py.File(f"{SESSION}/reprojections.h5") as f:
        return f[cam_name][:]  # (frames, 3, 15, 2) px
