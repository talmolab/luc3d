"""Shared data/camera math for the Chen et al. (2020) Fig. 2 -style correspondence
figure, built from a real SLAP-2M two-animal session. No bpy dependency here, so
this module loads under both the Blender script (fig_chen_correspondence.py) and
the plain-Python compositor (../fig_chen2020_style.py).

Session: 2022-10-07/10072022180149 (2 animals). Camera: "side" (cam_4) -- the
top/topL views are overhead and read poorly at this abstraction level; side gives
a real oblique view of both animals. That camera has no per-camera proofread
analysis.h5 in this session (only reprojections.slp / predictions.slp), so its 2D
points come from the session-level reprojections.h5["side"], which is the 3D
(proofread, cross-view-consistent) pose reprojected into that view -- exactly the
"x_t"/anchor-reprojection quantities Fig 2 needs, and verified bit-exact below
against an independent analytic projection through calibration.toml.

Frames: t' = 17424 (anchor time), t = 17442 (18 frames later, 0.6 s @ 30 fps).
Both animals are grounded (no rearing/climbing) throughout t'-NWIN..t, track 0
(illustrated identity) walks with a real Trunk displacement of ~85 mm, and the
two animals stay ~225 mm apart. Selected (over the earlier 17419/17437 pick)
for one more property: the perpendicular distance from track 1's (context
animal's) real 3D position to the back-projected ray through track 0's real
detection is ~130 mm -- large enough that the epipolar ray drawn in panel (b)
passes near track 0 only, not through both animals' clusters on screen, which
the first frame choice did (Eric: "the epipolar line does intersect with both
of them"). See scratchpad scan3.py-style search (scans for in-bounds 2D,
grounded, clear track-0 motion, moderate separation, AND large ray-to-other
clearance) folded into chen_fig_prep.py's docstring.
"""
import json
import math
import os

import h5py
import numpy as np
import toml

#: must match cage_scene.py's TAB10[0]/TAB10[1] -- duplicated (not imported) so
#: this module stays bpy-free and loads under the plain-Python compositor too.
TAB10_MAIN = "#1F77B4"
TAB10_OTHER = "#FF7F0E"

SLAP2M = "/root/talmolab-smb/eric/slap_2m"
SESSION = f"{SLAP2M}/2022-10-07/10072022180149"
HERE = os.path.dirname(os.path.abspath(__file__))
DATA_JSON = os.path.join(HERE, "renders", "chen_fig_data.json")
PHOTO_UNDISTORTED = os.path.join(HERE, "renders", "chen_side_photo_undistorted.png")

CAM_KEY = "cam_4"  # "side"
TPRIME, TCUR = 9468, 9486
NWIN = 10  # frames of look-back used to estimate V_t'
TRACK_MAIN, TRACK_OTHER = 0, 1
MM = 0.001

NODE_NAMES = ["Nose", "Ear_R", "Ear_L", "TTI", "TailTip", "Head", "Trunk", "Tail_0",
              "Tail_1", "Tail_2", "Shoulder_left", "Shoulder_right", "Haunch_left",
              "Haunch_right", "Neck"]
TRUNK = NODE_NAMES.index("Trunk")
#: the node the affinity/ray/ghost math is computed against in both panels --
#: Eric asked to switch this from Trunk to the left shoulder (less central
#: clutter, reads more clearly against the rest of the skeleton).
MEASURE_NODE_NAME = "Shoulder_left"
MEASURE_IDX = NODE_NAMES.index(MEASURE_NODE_NAME)

#: duplicated from cage_scene.py's MOUSE_EDGES (same reason as TAB10 above) --
#: used to draw the 2D pose overlay on the image-plane quad.
MOUSE_EDGES = [
    ["TailTip", "Tail_2"], ["Tail_2", "Tail_1"], ["Tail_1", "Tail_0"], ["Tail_0", "TTI"],
    ["TTI", "Trunk"], ["Trunk", "Neck"], ["Neck", "Head"], ["Head", "Nose"],
    ["TTI", "Haunch_left"], ["TTI", "Haunch_right"], ["Trunk", "Haunch_right"], ["Trunk", "Haunch_left"],
    ["Neck", "Shoulder_left"], ["Neck", "Shoulder_right"], ["Ear_L", "Head"], ["Ear_R", "Head"],
    ["Ear_L", "Nose"], ["Ear_R", "Nose"], ["Shoulder_left", "Head"], ["Shoulder_right", "Head"],
    ["Shoulder_left", "Haunch_left"], ["Shoulder_right", "Haunch_right"],
    ["Haunch_right", "TTI"], ["Haunch_left", "TTI"],
    ["Shoulder_left", "Shoulder_right"], ["Haunch_left", "Haunch_right"],
]
MOUSE_EDGE_IDXS = [(NODE_NAMES.index(a), NODE_NAMES.index(b)) for a, b in MOUSE_EDGES]


# --------------------------------------------------------------------------
# camera model -- OpenCV world->cam (x_cam = R X + t) with radial+tangential
# distortion, verified below to reproduce reprojections.h5 bit-exactly.
# --------------------------------------------------------------------------
def rodrigues(r):
    r = np.asarray(r, float)
    th = np.linalg.norm(r)
    if th < 1e-12:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * (K @ K)


def distort(xy, dist):
    k1, k2, p1, p2, k3 = dist
    x, y = xy[..., 0], xy[..., 1]
    r2 = x * x + y * y
    radial = 1 + k1 * r2 + k2 * r2 ** 2 + k3 * r2 ** 3
    xd = x * radial + 2 * p1 * x * y + p2 * (r2 + 2 * x * x)
    yd = y * radial + p1 * (r2 + 2 * y * y) + 2 * p2 * x * y
    return np.stack([xd, yd], axis=-1)


def undistort_px(uv_px, K, dist, iters=20):
    """Pixel -> normalized undistorted camera-plane coords (x/z, y/z)."""
    fx, fy, cx, cy = K[0, 0], K[1, 1], K[0, 2], K[1, 2]
    xn = (uv_px[..., 0] - cx) / fx
    yn = (uv_px[..., 1] - cy) / fy
    x, y = xn.copy(), yn.copy()
    for _ in range(iters):
        d = distort(np.stack([x, y], axis=-1), dist)
        x = x - (d[..., 0] - xn)
        y = y - (d[..., 1] - yn)
    return np.stack([x, y], axis=-1)


def project(P, K, R, t, dist):
    """World point(s) (mm, calibration-world frame) -> distorted pixel coords."""
    Pc = (R @ P[..., None])[..., 0] + t
    xy = Pc[..., :2] / Pc[..., 2:3]
    xyd = distort(xy, dist)
    return np.stack([K[0, 0] * xyd[..., 0] + K[0, 2],
                      K[1, 1] * xyd[..., 1] + K[1, 2]], axis=-1)


class Camera:
    def __init__(self, entry):
        self.name = entry["name"]
        self.K = np.array(entry["matrix"])
        self.R = rodrigues(entry["rotation"])          # world -> cam
        self.t = np.array(entry["translation"])         # mm
        self.dist = np.array(entry["distortions"])
        self.size = entry["size"]                        # (w, h) px
        self.C = -self.R.T @ self.t                       # center, mm, calib-world
        self.R_c2w = self.R.T                              # cam -> world, columns = right, down, forward

    def project(self, P):
        return project(P, self.K, self.R, self.t, self.dist)

    def ray_dir_world(self, uv_px):
        """Unit back-projection ray direction (calibration-world frame) through a
        detected (possibly distorted) pixel."""
        xyn = undistort_px(np.asarray(uv_px, float), self.K, self.dist)
        d_cam = np.array([xyn[0], xyn[1], 1.0])
        d_cam /= np.linalg.norm(d_cam)
        d_world = self.R.T @ d_cam
        return d_world / np.linalg.norm(d_world)


# --------------------------------------------------------------------------
# calibration-world <-> aligned cage frame (floor z~=0, +z up), exactly cage_scene.py's
# convention: aligned = Ra @ (raw - ta). Verified bit-exact against
# aligned_points3d.h5 in chen_fig_prep.py.
# --------------------------------------------------------------------------
class Alignment:
    def __init__(self, ali_toml):
        self.Ra = np.array(ali_toml["rotation"], dtype=float)
        self.ta = np.array(ali_toml["translation"], dtype=float)

    def point(self, X):
        return (self.Ra @ (X - self.ta).T).T if X.ndim > 1 else self.Ra @ (X - self.ta)

    def direction(self, d):
        return self.Ra @ d


# --------------------------------------------------------------------------
# explicit look-at basis for the STAGING (render) camera -- deliberately NOT
# cage_scene.aim()/to_track_quat, so the exact same formula can be replayed in
# plain Python (compositor) to analytically project any 3D point into the
# rendered still's pixel space. Blender camera convention: local -Z = view dir,
# +Y = up, +X = right.
# --------------------------------------------------------------------------
def view_right_vector(azim_deg, elev_deg, world_up=(0.0, 0.0, 1.0)):
    """The staging camera's screen-space 'right' direction for a given azimuth/
    elevation, independent of focus/distance (both cancel out of the look-at
    basis) -- lets a panel-separation offset be defined along the camera's own
    horizontal axis instead of guessing at a world axis that may foreshorten."""
    forward = -camera_dir(azim_deg, elev_deg)
    right = np.cross(forward, np.asarray(world_up, float))
    return right / np.linalg.norm(right)


def camera_dir(azim_deg, elev_deg):
    az, el = math.radians(azim_deg), math.radians(elev_deg)
    return np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)])


def look_at_basis(eye, target, world_up=(0.0, 0.0, 1.0)):
    eye, target = np.asarray(eye, float), np.asarray(target, float)
    forward = target - eye
    forward /= np.linalg.norm(forward)
    right = np.cross(forward, np.asarray(world_up, float))
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)
    return right, up, forward  # local +X, +Y, (view dir; local -Z = forward)


class StagingCamera:
    """Orthographic camera matching cage_scene.setup_render_camera's placement
    convention (focus + azimuth/elevation/distance), but built from an explicit
    look-at basis so this exact projection can be replayed with no bpy."""

    def __init__(self, focus, azim_deg, elev_deg, ortho_scale, res, dist=4.0):
        az, el = math.radians(azim_deg), math.radians(elev_deg)
        self.focus = np.asarray(focus, float)
        self.eye = self.focus + dist * np.array(
            [math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)])
        self.right, self.up, self.forward = look_at_basis(self.eye, self.focus)
        self.ortho_scale = ortho_scale
        self.res = res  # (res_x, res_y)
        assert res[0] >= res[1], "assumes landscape framing (world_width = ortho_scale)"
        self.world_w = ortho_scale
        self.world_h = ortho_scale * res[1] / res[0]

    def project(self, P):
        P = np.asarray(P, float)
        rel = P - self.eye
        xc = rel @ self.right
        yc = rel @ self.up
        px = (xc / (self.world_w / 2) + 1) / 2 * self.res[0]
        py = (1 - (yc / (self.world_h / 2) + 1) / 2) * self.res[1]
        return np.stack([px, py], axis=-1)

    def matrix_world_rows(self):
        """3x4 world matrix (Blender convention) as nested lists, for the bpy script."""
        f = self.forward
        r, u = self.right, self.up
        e = self.eye
        return [[r[0], u[0], -f[0], e[0]],
                [r[1], u[1], -f[1], e[1]],
                [r[2], u[2], -f[2], e[2]],
                [0.0, 0.0, 0.0, 1.0]]

    def to_dict(self):
        return {"focus": self.focus.tolist(), "eye": self.eye.tolist(),
                "right": self.right.tolist(), "up": self.up.tolist(),
                "forward": self.forward.tolist(), "ortho_scale": self.ortho_scale,
                "res": list(self.res)}

    @classmethod
    def from_dict(cls, d):
        cam = cls.__new__(cls)
        cam.focus = np.array(d["focus"])
        cam.eye = np.array(d["eye"])
        cam.right = np.array(d["right"])
        cam.up = np.array(d["up"])
        cam.forward = np.array(d["forward"])
        cam.ortho_scale = d["ortho_scale"]
        cam.res = tuple(d["res"])
        cam.world_w = cam.ortho_scale
        cam.world_h = cam.ortho_scale * cam.res[1] / cam.res[0]
        return cam


def load_calibration():
    cal = toml.load(f"{SESSION}/calibration.toml")
    cam = Camera(cal[CAM_KEY])
    assert cam.name == "side"
    return cam


def load_alignment():
    return Alignment(toml.load(f"{SESSION}/alignment.toml"))


def load_tracks3d():
    with h5py.File(f"{SESSION}/points3d.h5", "r") as f:
        return f["tracks"][:]  # (frames, 2, 15, 3) mm, calibration-world


def load_side_reprojections():
    with h5py.File(f"{SESSION}/reprojections.h5", "r") as f:
        return f["side"][:]  # (frames, 2, 15, 2) px


def save_json(d):
    os.makedirs(os.path.dirname(DATA_JSON), exist_ok=True)
    with open(DATA_JSON, "w") as f:
        json.dump(d, f, indent=2)


def load_json():
    with open(DATA_JSON) as f:
        return json.load(f)


#: The real predicted displacement (X_hat_t - X_t') is only ~50-60 mm at the
#: Trunk, comparable to the animal's own body size, so the solid anchor pose
#: and the ghost prediction rendered at their true positions overlap almost
#: entirely -- illegible. Rendered ghost position is nudged further out by
#: this factor (visual only); every printed number (prediction error, 3D
#: affinity) still uses the true X_hat_al from the JSON, not this exaggerated
#: position.
#:
#: RIGID, not per-node: an earlier version scaled each of the 15 nodes' own
#: (noisy, independently-estimated) predicted displacement by this factor,
#: which amplified their differences too and made the ghost balloon into a
#: visibly distorted, oversized skeleton ("the ghost is gigantic" -- Eric).
#: Shifting every node by the SAME exaggerated Trunk displacement keeps the
#: ghost's pose IDENTICAL in shape to the anchor pose, just translated -- a
#: clean rigid "this identity, moved" rather than a warped guess.
#:
#: Constrained to the WORLD-HORIZONTAL plane (zero world-Z component), so
#: every ghost node stays at the same height as the real animal's
#: corresponding node -- it can only slide sideways along the ground, never
#: lift off it. An earlier version scaled the raw 3D (or screen-plane)
#: displacement directly; at this azimuth/elevation the camera's on-screen
#: "up" is 91% world-Z, so exaggerating that component to a visible size
#: lifted the ghost ~50mm into the air ("floating in outer space" -- Eric),
#: regardless of floor size.
#:
#: DIRECTION: chosen so the ghost's displacement, once projected through the
#: staging camera, appears PERPENDICULAR to the epipolar ray on screen and
#: points toward screen-right -- not toward the real predicted-motion
#: direction (Eric: "make sure that distance is perpendicular to the
#: epipolar line"; the *A_3D* segment drawn afterward, ghost -> closest point
#: on the ray, is a true 3D perpendicular either way, but an orthographic
#: projection of a 3D-perpendicular segment is not generally perpendicular
#: ON SCREEN unless the offset that produced it was chosen in screen space).
#: Solved as a 2x2 system: for a horizontal world direction d=(dx,dy,0), its
#: on-screen coordinates are (d.right_al, d.up_al) -- both linear in (dx,dy) --
#: so the (dx,dy) giving an on-screen offset PARALLEL to the ray's own
#: on-screen perpendicular is found by inverting that 2x2 map.
GHOST_HORIZONTAL_TARGET_MM = 120.0

#: the staging camera's azimuth/elevation -- defined here (rather than only
#: below, next to PANEL_OFFSET_M) because exaggerated_ghost() needs it too.
AZIM_DEG, ELEV_DEG = 160, 24


def exaggerated_ghost(X_tp_al, X_hat_al, ray_dir_al, node=MEASURE_IDX,
                      target_mm=GHOST_HORIZONTAL_TARGET_MM,
                      azim_deg=AZIM_DEG, elev_deg=ELEV_DEG):
    X_tp_al, X_hat_al = np.asarray(X_tp_al), np.asarray(X_hat_al)
    ray_dir_al = np.asarray(ray_dir_al, float)

    forward = -camera_dir(azim_deg, elev_deg)
    right = np.cross(forward, np.array([0.0, 0.0, 1.0]))
    right /= np.linalg.norm(right)
    up = np.cross(right, forward)

    ray_screen = np.array([np.dot(ray_dir_al, right), np.dot(ray_dir_al, up)])
    ray_screen_norm = np.linalg.norm(ray_screen)
    if ray_screen_norm < 1e-9:
        # the ray projects to (near) a single point on screen -- fall back to
        # a fixed horizontal direction so the ghost still separates visibly
        horiz_dir = np.array([1.0, 0.0, 0.0])
    else:
        ray_screen /= ray_screen_norm
        perp_screen = np.array([-ray_screen[1], ray_screen[0]])
        if perp_screen[0] < 0:  # keep it pointing toward screen-right
            perp_screen = -perp_screen

        # A @ (dx, dy) = (screen_x, screen_y), for a horizontal world offset
        # (dx, dy, 0); invert to get the (dx,dy) whose screen projection is
        # exactly `perp_screen`.
        A = np.array([[right[0], right[1]], [up[0], up[1]]])
        dx, dy = np.linalg.solve(A, perp_screen)
        horiz_dir = np.array([dx, dy, 0.0])
        horiz_dir /= np.linalg.norm(horiz_dir)

    rigid_offset = horiz_dir * target_mm
    # every node shifts by the SAME horizontal offset and keeps its OWN real
    # z -- i.e. apply to X_tp_al broadcast (the offset's z is already 0).
    out = X_tp_al + rigid_offset
    out[:, 2] = X_tp_al[:, 2]
    return out


#: shared between fig_chen_correspondence.py (bpy) and ../fig_chen2020_style.py
#: (plain Python, no bpy) -- both panels render in ONE scene/image, offset
#: sideways along the staging camera's own screen-right axis (a raw world axis
#: may not point where the picture's "sideways" actually is at this azimuth,
#: and visibly put both panels' camera props on the same side of the render).
_VIEW_RIGHT = view_right_vector(AZIM_DEG, ELEV_DEG)
#: The real "side" camera sits ~400mm to the side of its own floor's centroid,
#: so an offset smaller than that lets panel a's camera prop drift visually
#: over panel b's floor. The floor itself is now DATA-DRIVEN (sized to fit
#: both animals' full extent incl. tails, chen_fig_prep.py) and came out
#: ~200mm in half-width once that fit both real animals -- an offset this
#: close to the floor's own half-width crowded the two panels' camera props
#: and titles right up against each other ("still getting cut off" was this,
#: not an actual render clip). 0.34m clears both the floor half-width and the
#: camera-to-floor offset with real margin.
PANEL_OFFSET_M = {"a": -0.24 * _VIEW_RIGHT, "b": 0.24 * _VIEW_RIGHT}

def floor_corners_mm(floor_half):
    """floor_half is the data-driven {"x0","x1","y0","y1"} dict computed in
    chen_fig_prep.py (JSON key "floor_half") from the actual frame's animal
    extents -- NOT a hand-picked constant, so it stays correct if the chosen
    frame/pose ever changes again."""
    return np.array([
        (floor_half["x0"], floor_half["y0"], 0.0),
        (floor_half["x1"], floor_half["y0"], 0.0),
        (floor_half["x1"], floor_half["y1"], 0.0),
        (floor_half["x0"], floor_half["y1"], 0.0),
    ])
