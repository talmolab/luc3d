#!/usr/bin/env python
"""Blender render of a SLAP-2M difficulty tile: cage + N animals + M enrichment objects.

Eric, 2026-08-19: the difficulty-grid intuition figure (candidate fig6 A/B
replacement). Each tile is one cage with a real session's animals plus the
synthetic enrichment objects from pilot_figure_1_viz.00.ipynb (100 mm wireframe
cubes + the coarse wireframe dome/igloo), rendered in cage_scene.py's aesthetic.
Tiles will later be assembled on an environmental-enrichment (x) x #animals (y)
grid.

Objects are drawn ball-and-edge like the animals (balls at skeleton nodes, tubes
on edges, film membranes on faces) but GREEN and fully see-through: every part
uses the flat_translucent matplotlib-alpha film, so the mice stay readable
through them. Cube topology is cube_skeleton.json's 8-node / 12-edge SLEAP
skeleton; the dome is viz cell 23's plot_wireframe hemisphere (4 meridians x 2
rings, r=50 mm) as a 9-node skeleton. No session carries real triangulated
object points (targets/ and grid_volumes/ are empty everywhere), so placement
is synthetic: objects are dropped on the main floor plane at deterministic
greedy positions that maximize clearance from the animals in the chosen frame.

  bpyenv/bin/python enrichment_scene.py --animals 2 --objects 4
  bpyenv/bin/python enrichment_scene.py --session <path> --frame N --objects 3

--animals N --objects M renders the REAL (animals, obstacle_rating) condition:
the session table below has one representative session per combo that actually
exists in master_sheet.xlsx (14 of the 24 cells — the dataset is not a full
factorial), and refuses combos the dataset does not contain. --objects grades
the arrangements between the old draft's anchors: dome / cube / cube+dome /
L of 3 cubes / L + dome on the corner cube (rating-5's look in cage_renders).
"""
import argparse
import math
import os

import bpy
import h5py
import numpy as np

import cage_scene as cs

HERE = os.path.dirname(os.path.abspath(__file__))

# The dataset's REAL (animals, obstacle_rating) coverage — from
# master_sheet.xlsx (2026-08-19). Only these 14 combos exist; the grid must
# not invent the others (1 animal spans all six ratings, 2 animals lacks
# rating 1, 3 animals has only 0 and 4, 4 animals only 0). One representative
# session per combo — a session actually recorded under that condition — plus
# a frame picked by scan: NaN-free for all tracks, body-bone warp in the low
# percentile, animals well separated (multi) or mid-session (single).
#: THE RENDERS KEEP viz_08's tab10 (cage_scene.TAB10), and Fig 6a's camera-view
#: inset is recoloured to match THEM (Eric, 2026-08-19 -- the reverse was tried, with
#: the tiles taking the app's Okabe-Ito identity palette, and rejected). The app-side
#: palette that makes the same animal the same colour is derived from the mapping
#: below and lives in figs/fig6_app.mjs `PALETTE`; keep the two in step.
#:
#: H5 TRACK -> APP IDENTITY, MEASURED, NOT ASSUMED. The two orders come from different
#: passes (SLEAP-Anipose proofread tracks vs LUC3D's cross-view tracker) and do NOT
#: agree. Recovered by projecting each h5 track's 15 keypoints into all six proofread
#: cameras with the session's own calibration + alignment, then voting on the overlay
#: colour the app actually painted at those pixels: track 0 -> id_3 (99% of 2,046
#: sampled px), 1 -> id_2 (100%), 2 -> id_0 (97%), 3 -> id_1 (98%), every track a
#: distinct identity. So the app's id_0..id_3 must carry tab10 entries 2, 3, 1, 0.
#: RE-DERIVE if the frame, the session or the app export changes -- the same vote at
#: the wrong frame returns colliding, low-purity assignments (that is how the stale
#: fig6-view-f120 export was found).
TRACK_TO_IDENTITY = {0: 3, 1: 2, 2: 0, 3: 1}

COMBOS = {
    (1, 0): ("2022-10-19/10192022181735", 9356),
    (1, 1): ("2022-10-19/10192022174609", 2654),
    (1, 2): ("2022-10-07/10072022175009", 9091),
    (1, 3): ("2022-10-19/10192022175248", 3410),
    (1, 4): ("2022-10-07/10072022193448", 9001),
    (1, 5): ("2022-10-20/10202022163211", 29871),
    (2, 0): ("2022-10-07/10072022131531", 12852),
    (2, 2): ("2022-10-07/10072022180149", 11630),
    (2, 3): ("2022-10-19/10192022183808", 7140),
    (2, 4): ("2022-10-07/10072022184618", 6033),
    (2, 5): ("2022-10-07/10072022161055", 5345),
    (3, 0): ("2022-10-07/10072022142111", 11726),
    (3, 4): ("2022-10-07/10072022190807", 13967),
    # FRAME 6020, NOT A SCAN PICK: this tile is the one Fig 6a's camera-view inset
    # expands, so it must render the instant the app exported. The prepared session
    # figs/session-slap-10072022145420 starts at original frame 6000 (fig6_session.py
    # --start) and fig6_app.mjs exports its frame 20, i.e. original 6020 -- an offset
    # CONFIRMED by the colour vote in TRACK_TO_IDENTITY, which is crisp at 6020 and
    # ambiguous 100 frames either side.
    (4, 0): ("2022-10-07/10072022145420", 6020),
}

# --------------------------------------------------------------------------
# object skeletons (meters). Cube: cube_skeleton.json topology — 4 bottom + 4
# top corners, 12 edges. Node order here: bottom_1..4 then top_1..4, CCW.
# --------------------------------------------------------------------------
CUBE_SIDE = 0.100  # viz draw_cube: r = [0, 100] mm
CUBE_EDGES = [(0, 1), (1, 2), (2, 3), (3, 0),          # bottom loop
              (4, 5), (5, 6), (6, 7), (7, 4),          # top loop
              (0, 4), (1, 5), (2, 6), (3, 7)]          # verticals
CUBE_FACES = [(0, 1, 2, 3), (4, 5, 6, 7), (0, 1, 5, 4),
              (1, 2, 6, 5), (2, 3, 7, 6), (3, 0, 4, 7)]


def cube_points(cx, cy, z0, yaw_deg=0.0, side=CUBE_SIDE):
    """(8,3) cube corners, base center (cx,cy,z0), rotated yaw about z."""
    h = side / 2
    base = np.array([[-h, -h], [h, -h], [h, h], [-h, h]])
    a = math.radians(yaw_deg)
    R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    xy = base @ R.T + [cx, cy]
    bot = np.c_[xy, np.full(4, z0)]
    top = np.c_[xy, np.full(4, z0 + side)]
    return np.vstack([bot, top])


# dome: viz cell 23's plot_wireframe — u = linspace(0, 2pi, 5) (4 unique
# meridians), v = linspace(0, 3pi/4, 3) (pole + 2 rings), radius 50 mm. As a
# skeleton: node 0 = pole, 1-4 = upper ring (v=3pi/8), 5-8 = bottom ring
# (v=3pi/4, the widest-in-the-middle igloo profile).
DOME_R = 0.050
DOME_EDGES = ([(0, 1 + i) for i in range(4)] +                       # pole->ring1
              [(1 + i, 5 + i) for i in range(4)] +                   # meridians
              [(1 + i, 1 + (i + 1) % 4) for i in range(4)] +         # ring1 loop
              [(5 + i, 5 + (i + 1) % 4) for i in range(4)])          # ring2 loop
DOME_FACES = ([(0, 1 + i, 1 + (i + 1) % 4) for i in range(4)] +
              [(1 + i, 1 + (i + 1) % 4, 5 + (i + 1) % 4, 5 + i) for i in range(4)])


def dome_points(cx, cy, z_base, r=DOME_R):
    """(9,3) dome nodes; z_base is where the bottom ring sits (floor/cube top)."""
    vs = [0.0, 3 * math.pi / 8, 3 * math.pi / 4]
    zc = z_base + r * (-math.cos(vs[2]))          # center so bottom ring lands on z_base
    pts = [(cx, cy, zc + r)]
    for v in vs[1:]:
        for u in (0, math.pi / 2, math.pi, 3 * math.pi / 2):
            pts.append((cx + r * math.sin(v) * math.cos(u),
                        cy + r * math.sin(v) * math.sin(u),
                        zc + r * math.cos(v)))
    return np.array(pts)


# see-through green, distinct from the tab10 track colours (track 2 is #2CA02C)
OBJ_GREEN = "#1E8449"
OBJ_EDGE_ALPHA = 0.60
OBJ_NODE_ALPHA = 0.70
OBJ_FACE_ALPHA = 0.13
OBJ_BALL_R = 0.0055
OBJ_TUBE_R = 0.0028
# rest objects ON the surface: corner nodes sit one ball radius above it, so
# the balls touch instead of sinking halfway through the floor film
OBJ_LIFT = OBJ_BALL_R + 0.001


def object_mats(M, color, edge_a, face_a):
    M["obj_edge"] = cs.flat_translucent("obj_edge", color, edge_a)
    M["obj_node"] = cs.flat_translucent("obj_node", color, OBJ_NODE_ALPHA * edge_a / OBJ_EDGE_ALPHA)
    M["obj_face"] = cs.flat_translucent("obj_face", color, face_a)


def build_object(name, pts, edges, faces, M, coll):
    """Ball-and-edge enrichment object, all parts the see-through green film.
    Like viz's alpha surfaces they must not darken the scene, so nothing here
    casts shadows."""
    sub = bpy.data.collections.new(f"obj_{name}")
    coll.children.link(sub)
    obs = []
    for i, p in enumerate(pts):
        obs.append(cs.ball(f"{name}_n{i}", p, OBJ_BALL_R, M["obj_node"], sub))
    for j, (a, b) in enumerate(edges):
        obs.append(cs.tube(f"{name}_e{j}", pts[[a, b]], OBJ_TUBE_R, M["obj_edge"], sub))
    for j, f in enumerate(faces):
        obs.append(cs.ngon(f"{name}_f{j}", pts[list(f)], M["obj_face"], sub))
    for ob in obs:
        ob.visible_shadow = False


# --------------------------------------------------------------------------
# placement: the main open floor is the trapezoid Bot_NW - Bot_NE -
# SpoutBot_NE - SpoutBot_NW (the filter side is a raised shelf, z approx +10mm,
# too shallow for a 100 mm cube to sit convincingly)
# --------------------------------------------------------------------------
def floor_frame(cage_nodes, cage):
    idx = {n: i for i, n in enumerate(cage_nodes)}
    corners = cage[[idx[n] for n in ("Bot_NW", "Bot_NE", "SpoutBot_NE", "SpoutBot_NW")]]
    loop = cage[[idx[n] for n in cs.CAGE_SURFACES["floor"]]]
    return corners, loop


def floor_height(loop, x, y):
    """z of the RENDERED floor at (x, y): the floor is ngon('floor'), a fan of
    triangles from the loop centroid, and it is nowhere near planar — the
    filter-side loop nodes sit ~25 mm above the corner nodes, so a plane fit
    through the corners buries anything placed toward the filter side (Eric
    caught the clipped cube edge). Barycentric interpolation on the actual fan."""
    c = loop.mean(axis=0)
    p = np.array([x, y])
    n = len(loop)
    for i in range(n):
        a, b = loop[i], loop[(i + 1) % n]
        M = np.array([[a[0] - c[0], b[0] - c[0]], [a[1] - c[1], b[1] - c[1]]])
        try:
            u, v = np.linalg.solve(M, p - c[:2])
        except np.linalg.LinAlgError:
            continue
        if u >= -1e-9 and v >= -1e-9 and u + v <= 1 + 1e-9:
            return float(c[2] + u * (a[2] - c[2]) + v * (b[2] - c[2]))
    # outside the floor polygon (should not happen for placed footprints):
    # nearest loop node is a safe upper-ish bound
    return float(loop[np.argmin(np.linalg.norm(loop[:, :2] - p, axis=1)), 2])


def rest_z(loop, xys):
    """Base height for a LEVEL object over footprint points: the floor's high
    point under it, plus the ball-radius lift."""
    return max(floor_height(loop, x, y) for x, y in xys) + OBJ_LIFT


def bilerp(corners, u, v):
    """(x,y) on the floor trapezoid; u across (NW->NE), v toward the spout."""
    nw, ne, se, sw = corners[0, :2], corners[1, :2], corners[2, :2], corners[3, :2]
    top = nw + u * (ne - nw)
    bot = sw + u * (se - sw)
    return top + v * (bot - top)


# Each enrichment level is a list of placement UNITS. A unit is a rigid
# arrangement: cube center offsets in cube units (so adjacent cubes share
# faces, like viz cell 23's L of three cubes), plus optionally the dome —
# "floor" beside the cubes, or an int index to sit it on that cube's top.
# Units are placed greedily as a whole; cubes within a unit share one yaw so
# the cluster reads as a structure, not a collision.
# Arrangements follow the notebook/old-draft anchors (cage_renders): rating
# ~3 was drawn as a single cube, rating 5 as the L of three cubes with the
# dome on top. The in-between ratings are graded monotonically between them.
LEVELS = [
    [],
    [{"cubes": [], "dome": "floor", "yaw": 0}],                    # 1: dome
    [{"cubes": [(0, 0)], "yaw": 14}],                              # 2: cube
    [{"cubes": [(0, 0)], "yaw": 14},                               # 3: cube + dome
     {"cubes": [], "dome": "floor", "yaw": 0}],
    [{"cubes": [(0, 0), (-1, 0), (-1, -1)], "yaw": 10}],           # 4: the L
    # the old draft's difficulty-5: L of three cubes, dome on the corner cube
    [{"cubes": [(0, 0), (-1, 0), (-1, -1)], "dome": 1, "yaw": 10}],
]
CUBE_FOOT = CUBE_SIDE * math.sqrt(2) / 2     # footprint radius: half-diagonal
DOME_FOOT = 0.047                            # bottom-ring radius + ball
WALL_GAP = 0.006                             # clearance to the walls
OBJ_GAP = 0.008                              # between elements of different units


def _inside(corners, p, inset):
    """p at least `inset` inside the floor trapezoid (signed edge distances)."""
    quad = corners[:, :2]
    ctr = quad.mean(axis=0)
    for i in range(4):
        a, b = quad[i], quad[(i + 1) % 4]
        e = b - a
        n = np.array([e[1], -e[0]]) / np.linalg.norm(e)
        s = np.sign(np.dot(ctr - a, n))       # orient the normal inward
        if s * np.dot(p - a, n) < inset:
            return False
    return True


def _unit_footprint(unit, anchor):
    """[(xy_center, footprint_radius)] of a unit's cubes/floor dome at anchor."""
    a = math.radians(unit["yaw"])
    R = np.array([[math.cos(a), -math.sin(a)], [math.sin(a), math.cos(a)]])
    feet = [(np.array(o, float) * CUBE_SIDE, CUBE_FOOT) for o in unit["cubes"]]
    if unit.get("dome") == "floor":
        feet.append((np.zeros(2), DOME_FOOT))
    return [(anchor + R @ o, r) for o, r in feet]


def place_objects(level, corners, loop, animal_xy):
    """Deterministic greedy placement: each unit anchors at the candidate spot
    farthest from the animals and the units already placed, subject to every
    element's footprint fitting on the floor (inside the walls) and clearing
    other units' elements. Returns build specs."""
    grid = [bilerp(corners, u, v)
            for v in np.linspace(0.02, 0.92, 12)
            for u in np.linspace(0.05, 0.95, 12)]
    placed = []                               # (xy, radius) of placed elements
    objs = []
    for k, unit in enumerate(LEVELS[level]):
        best, score = None, -1.0
        for anchor in grid:
            feet = _unit_footprint(unit, anchor)
            if not all(_inside(corners, c, r + WALL_GAP) for c, r in feet):
                continue
            if any(np.linalg.norm(c - t) < r + tr + OBJ_GAP
                   for c, r in feet for t, tr in placed):
                continue
            d = min([np.linalg.norm(c - a) for c, _ in feet for a in animal_xy] +
                    [np.linalg.norm(c - t) for c, _ in feet for t, _ in placed] or [np.inf])
            if d > score:
                best, score = anchor, d
        if best is None:
            print(f"place_objects: no room for unit {k} at level {level}, skipped")
            continue
        feet = _unit_footprint(unit, best)
        placed.extend(feet)
        centers = [c for c, _ in feet]
        cubes = []
        for j, c in enumerate(centers[:len(unit["cubes"])]):
            base = cube_points(c[0], c[1], 0.0, unit["yaw"])[:4, :2]
            pts = cube_points(c[0], c[1], rest_z(loop, base), unit["yaw"])
            cubes.append(pts)
            objs.append((f"u{k}_cube{j}", pts, CUBE_EDGES, CUBE_FACES))
        dome = unit.get("dome")
        if dome == "floor":
            c = centers[-1]
            ring = dome_points(c[0], c[1], 0.0)[5:, :2]     # bottom-ring balls
            objs.append((f"u{k}_dome", dome_points(c[0], c[1], rest_z(loop, ring)),
                         DOME_EDGES, DOME_FACES))
        elif isinstance(dome, int):
            top = cubes[dome][4:8].mean(axis=0)
            objs.append((f"u{k}_dome", dome_points(top[0], top[1], top[2] + OBJ_LIFT),
                         DOME_EDGES, DOME_FACES))
    return objs


# --------------------------------------------------------------------------
# framing: fit the ortho window to the content for this tile (no camera rig by
# default, so cage_scene's rig-inclusive 1.34 window would waste half the frame)
# --------------------------------------------------------------------------
def fit_view(points, azim_deg, elev_deg, aspect, margin=1.14):
    az, el = math.radians(azim_deg), math.radians(elev_deg)
    fwd = -np.array([math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)])
    right = np.array([-math.sin(az), math.cos(az), 0.0])
    up = np.cross(right, fwd)
    P = np.asarray(points)
    r, u, f = P @ right, P @ up, P @ fwd
    ortho = margin * max(r.max() - r.min(), (u.max() - u.min()) * aspect)
    mid = (right * (r.max() + r.min()) + up * (u.max() + u.min()) + fwd * (f.max() + f.min())) / 2
    return float(ortho), tuple(mid)


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--animals", type=int, choices=[1, 2, 3, 4],
                    help="animal count; with --objects picks the real session "
                         "recorded under that (animals, obstacle_rating) condition")
    ap.add_argument("--session", help="explicit session path (overrides --animals)")
    ap.add_argument("--frame", type=int, help="frame index (with --session, or to override a preset)")
    ap.add_argument("--objects", type=int, default=0, choices=range(6),
                    help="enrichment level 0-5 (the master sheet's obstacle_rating)")
    ap.add_argument("--out", help="output png (default renders/enrich_a<N>_o<M>.png)")
    ap.add_argument("--samples", type=int, default=192)
    ap.add_argument("--res", type=int, nargs=2, default=[1400, 1200])
    ap.add_argument("--azim", type=float, default=205.0)
    ap.add_argument("--elev", type=float, default=22.0)
    ap.add_argument("--ortho", type=float, help="override the fitted ortho window")
    ap.add_argument("--margin", type=float, default=1.14, help="fitted-window margin")
    ap.add_argument("--fit", choices=["cage", "content"], default="cage",
                    help="fit the window to the cage alone (default — identical "
                         "framing across grid tiles, the cage is the same size "
                         "in every session) or to everything in the scene")
    ap.add_argument("--cameras", action="store_true",
                    help="include the calibrated camera rig (off for grid tiles)")
    ap.add_argument("--clamp-tail", action="store_true", default=True)
    ap.add_argument("--no-clamp-tail", dest="clamp_tail", action="store_false")
    ap.add_argument("--no-open-front", action="store_true",
                    help="keep the fill on the near wall (the default drops it so "
                         "the cage interior is seen through clean air)")
    ap.add_argument("--obj-color", default=OBJ_GREEN)
    ap.add_argument("--obj-alpha", type=float, default=OBJ_EDGE_ALPHA,
                    help="edge/node see-through opacity")
    ap.add_argument("--obj-face-alpha", type=float, default=OBJ_FACE_ALPHA)
    ap.add_argument("--transparent-bounces", type=int, default=128,
                    help="objects stack several films on one ray; cage_scene's 32 "
                         "can exhaust and terminate rays black (the known class)")
    args = ap.parse_args()

    if args.session:
        session = args.session
        frame = args.frame if args.frame is not None else 3200
    else:
        n = args.animals or 2
        if (n, args.objects) not in COMBOS:
            have = sorted(o for a, o in COMBOS if a == n)
            ap.error(f"the dataset has no {n}-animal session at obstacle_rating "
                     f"{args.objects} (available for {n} animals: {have}); "
                     f"pass --session to render it anyway")
        sp, frame = COMBOS[(n, args.objects)]
        session = f"{cs.SLAP2M}/{sp}"
        if args.frame is not None:
            frame = args.frame

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn_coll = bpy.context.scene.collection

    cage_nodes, cage, mouse_nodes, ali, cams = cs.load_session(session)
    ctr = np.mean(cage, axis=0)
    focus = tuple(ctr * [1, 1, 0.7])

    M = {k: cs.pbr_mat(k, *v) for k, v in cs.PBR.items()}
    M["cage_wall"] = cs.flat_translucent("cage_wall", cs.PBR["cage_wall"][0],
                                         cs.PBR["cage_wall"][3])
    object_mats(M, args.obj_color, args.obj_alpha, args.obj_face_alpha)

    # The near wall goes unfilled so the animals and objects are seen through clean
    # air rather than through a grey film (Eric, 2026-08-19). Computed from the
    # render azimuth, not named, so it follows --azim.
    cs.build_cage(cage_nodes, cage, M, scn_coll,
                  open_toward=None if args.no_open_front
                  else cs.camera_dir(args.azim, args.elev))

    pts = cs.load_frame(session, frame)
    if args.clamp_tail:
        cs.clamp_tails(pts, cs.cage_planes(cage_nodes, cage))
    live = [tr for tr in range(pts.shape[0]) if not np.isnan(pts[tr]).all()]
    for tr in live:
        cs.build_animal(tr, pts[tr], mouse_nodes, M, scn_coll)

    corners, loop = floor_frame(cage_nodes, cage)
    animal_xy = [np.nanmean(pts[tr][:, :2], axis=0) for tr in live]
    objs = place_objects(args.objects, corners, loop, animal_xy)
    obj_pts = []
    for name, opts, edges, faces in objs:
        build_object(name, opts, edges, faces, M, scn_coll)
        obj_pts.append(opts)

    zmin = float(cage[:, 2].min())
    if args.cameras:
        for c in cams:
            cs.build_camera_unit(c["name"], c["C"], c["R_cam2world"], M, scn_coll, focus)
            cs.build_camera_support(c["name"], c["C"], M, scn_coll, zmin - 0.012)
    floor = cs.box("room_floor", (6.0, 6.0, 0.02), (0, 0, 0), M["floor"], scn_coll)
    floor.location = (focus[0], focus[1], zmin - 0.012)

    cs.setup_lighting(focus)
    cs.setup_cycles(args.samples, args.res)
    bpy.context.scene.cycles.transparent_max_bounces = args.transparent_bounces

    content = [cage]
    if args.fit == "content":
        content += [pts[tr] for tr in live] + obj_pts
    if args.cameras:
        content.append(np.array([c["C"] for c in cams]))
    aspect = args.res[0] / args.res[1]
    ortho, aimpt = fit_view(np.vstack(content), args.azim, args.elev, aspect, args.margin)
    if args.ortho:
        ortho = args.ortho
    cs.setup_render_camera(aimpt, args.azim, args.elev, ortho)

    n_animals = len(live)
    out = args.out or os.path.join(HERE, "renders", f"enrich_a{n_animals}_o{args.objects}.png")
    os.makedirs(os.path.dirname(out), exist_ok=True)
    cs.render_to(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
