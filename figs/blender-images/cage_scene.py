#!/usr/bin/env python
"""Blender render of a SLAP-2M session: cage + animals + the real cameras.

Eric, 2026-08-15: one still of the TWO animals in the cage with the cameras
rendered, then a video — panelA_current.png's aesthetic (matte PBR, soft area
lights, clean isometric view, blue anodised camera bodies), but with the cage
SURFACES FILLED like viz_08.ipynb's matplotlib renders (grey translucent
walls + black edge wireframe), not wireframe-only like RatVid_3D_Blender.

Data (all per session, from /root/talmolab-smb/eric/slap_2m/<date>/<session>/):
  aligned_cage_points3d.h5   tracks (1,1,24,3) mm — the 24 cage corners, aligned
                             cage frame (floor z≈0, +z up)
  aligned_points3d.h5        tracks (frames, tracks, 15, 3) mm, same frame
  alignment.toml             rotation/translation of Y = R @ (X − t), calibration
                             world → aligned cage frame (values stored as STRINGS)
  calibration.toml           aniposelib: per-cam Rodrigues rvec + tvec (mm),
                             OpenCV world→camera (x_cam = R X + t)
Skeleton node orders from slap_2m/{cage,mouse}_skeleton.toml. The surface and
edge node lists are copied verbatim from viz_08.ipynb cells 15–16, with ONE
measured correction (east_wall — see the comment at its entry).

Runs in the pip-installed bpy (bpyenv/, Blender 5.0) — no blender binary needed:

  bpyenv/bin/python cage_scene.py                                  # the still
  bpyenv/bin/python cage_scene.py --video 3000 3600 2 --orbit 30   # the video
  ffmpeg -framerate 30 -i renders/video/f%05d.png -c:v libx264 -pix_fmt yuv420p out.mp4

Cycles on OptiX (A40). The still takes ~1 min; video frames re-pose only the
animal geometry (cage/cameras/lights persist) so a 300-frame clip is tractable.
"""
import argparse
import math
import os
import sys

import bpy
import h5py
import numpy as np
import toml
from mathutils import Matrix, Vector

HERE = os.path.dirname(os.path.abspath(__file__))
SLAP2M = "/root/talmolab-smb/eric/slap_2m"
DEFAULT_SESSION = f"{SLAP2M}/2022-10-07/10072022180149"  # 2 animals; viz_08's own 2-mouse render
MM = 0.001  # scene units are meters

# --------------------------------------------------------------------------
# viz_08 cell 15 — cage surfaces and their outline edges, verbatim
# --------------------------------------------------------------------------
CAGE_SURFACES = {
    "floor":        ["Bot_NW", "FilterBot_NW", "FilterBot_SW", "FilterBot_SE", "FilterBot_NE", "Bot_NE", "SpoutBot_NE", "SpoutBot_NW"],
    "spout_wall":   ["Top_SE", "Top_SW", "SpoutMid_SW", "SpoutMid_SE"],
    "filter_wall":  ["Bot_NW", "FilterBot_NW", "FilterBot_NE", "Bot_NE", "Top_NE", "Top_NNE", "Top_NNW", "Top_NW"],
    "west_wall":    ["Top_SW", "Top_NW", "Bot_NW", "SpoutBot_NW", "SpoutMid_NW", "SpoutMid_SW"],
    # east_wall is the ONE deviation from the verbatim viz_08 lists: the
    # notebook routes it through SpoutBot_NW, which sits 124 mm off the east-
    # wall plane (fit residual 54.7 mm with it, 2.3 mm without; SpoutBot_NE is
    # 4.5 mm from the plane) — a typo that warped the rendered wall and tilted
    # the tail-clamp plane 17 degrees inward. Measured 2026-08-15; fix viz_08 too.
    "east_wall":    ["Top_SE", "Top_NE", "Bot_NE", "SpoutBot_NE", "SpoutMid_NE", "SpoutMid_SE"],
    "spout_top":    ["SpoutMid_NE", "SpoutMid_SE", "SpoutMid_SW", "SpoutMid_NW"],
    "spout_front":  ["SpoutMid_NE", "SpoutBot_NE", "SpoutBot_NW", "SpoutMid_NW"],
    "filter_top":   ["FilterTop_NE", "FilterTop_NW", "FilterTop_SW", "FilterTop_SE"],
    "filter_west":  ["FilterTop_NW", "FilterTop_SW", "FilterBot_SW", "FilterBot_NW"],
    "filter_east":  ["FilterTop_NE", "FilterTop_SE", "FilterBot_SE", "FilterBot_NE"],
    "filter_front": ["FilterTop_SW", "FilterTop_SE", "FilterBot_SE", "FilterBot_SW"],
    "indent":       ["Top_NNW", "Top_NNE", "Mid_NNE", "Mid_NNW"],
}
CAGE_EDGES = [
    # floor
    ["Bot_NW", "FilterBot_NW"], ["FilterBot_NW", "FilterBot_SW"], ["FilterBot_SW", "FilterBot_SE"],
    ["FilterBot_SE", "FilterBot_NE"], ["FilterBot_NE", "Bot_NE"], ["Bot_NE", "SpoutBot_NE"],
    ["SpoutBot_NE", "SpoutBot_NW"], ["SpoutBot_NW", "Bot_NW"],
    # spout wall
    ["Top_SE", "Top_SW"], ["Top_SW", "SpoutMid_SW"], ["SpoutMid_SW", "SpoutMid_SE"], ["SpoutMid_SE", "Top_SE"],
    # filter wall
    ["FilterBot_NW", "FilterBot_NE"], ["Bot_NE", "Top_NE"], ["Top_NNE", "Top_NNW"],
    ["Top_NNW", "Top_NW"], ["Top_NW", "Bot_NW"],
    # west wall
    ["Top_SW", "Top_NW"], ["Bot_NW", "SpoutBot_NW"], ["SpoutBot_NW", "SpoutMid_NW"], ["SpoutMid_NW", "SpoutMid_SW"],
    # east wall
    ["Top_SE", "Top_NE"], ["SpoutMid_NE", "SpoutMid_SE"],
    # spout top / front
    ["SpoutMid_SE", "SpoutMid_SW"], ["SpoutMid_NW", "SpoutMid_NE"], ["SpoutMid_NE", "SpoutBot_NE"],
    # filter box
    ["FilterTop_NE", "FilterTop_NW"], ["FilterTop_NW", "FilterTop_SW"], ["FilterTop_SW", "FilterTop_SE"],
    ["FilterTop_SE", "FilterTop_NE"], ["FilterTop_SW", "FilterBot_SW"], ["FilterTop_SE", "FilterBot_SE"],
    ["FilterBot_SE", "FilterBot_SW"], ["FilterBot_NW", "FilterTop_NW"], ["FilterBot_NE", "FilterTop_NE"],
    # indent
    ["Top_NNW", "Top_NNE"], ["Top_NNE", "Top_NE"], ["Top_NNE", "Mid_NNE"],
    ["Mid_NNE", "Mid_NNW"], ["Mid_NNW", "Top_NNW"],
]

# --------------------------------------------------------------------------
# viz_08 cell 16 — mouse surfaces and edges, verbatim
# --------------------------------------------------------------------------
MOUSE_SURFACES = [
    ["Nose", "Head", "Ear_R"], ["Nose", "Head", "Ear_L"],
    ["Head", "Neck", "Shoulder_left"], ["Head", "Neck", "Shoulder_right"],
    ["Neck", "Trunk", "Haunch_left", "Shoulder_left"], ["Neck", "Trunk", "Haunch_right", "Shoulder_right"],
    ["Trunk", "TTI", "Haunch_left"], ["Trunk", "TTI", "Haunch_right"],
    ["Head", "Shoulder_left", "Shoulder_right"],
    ["Haunch_left", "Haunch_right", "Shoulder_right", "Shoulder_left"],
    ["Haunch_left", "Haunch_right", "TTI"],
]
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

# tab10 track colours, as viz_08 uses (cmap(track))
TAB10 = [
    "#1F77B4", "#FF7F0E", "#2CA02C", "#D62728", "#9467BD",
    "#8C564B", "#E377C2", "#7F7F7F", "#BCBD22", "#17BECF",
]

# panelA's PBR vocabulary (hex, roughness, metallic, alpha, coat)
PBR = {
    "camera":    ("#1D4E8A", 0.38, 0.55, 1.00, 0.20),
    "lens":      ("#14171C", 0.22, 0.75, 1.00, 0.35),
    "mount":     ("#5F656E", 0.30, 0.90, 1.00, 0.12),
    "ink":       ("#1A1A1A", 0.60, 0.00, 1.00, 0.00),
    "floor":     ("#DCDBD6", 0.62, 0.00, 1.00, 0.06),
    "cage_wall": ("#9DA2A8", 0.45, 0.00, 0.30, 0.00),
    "cage_floor": ("#B3B6B9", 0.55, 0.00, 0.80, 0.00),
}
# materials that should read like viz_08's flat translucent grey film, not
# refractive acrylic — skip the panelA transmission recipe for these
NO_TRANSMISSION = {"cage_wall", "cage_floor"}


def hex2rgba(h, a=1.0):
    h = h.lstrip("#")
    return (*(int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)), a)


def pbr_mat(name, hexcolor, rough, metal, alpha, coat):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    b.inputs["Base Color"].default_value = hex2rgba(hexcolor)
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    for key, val in (("Coat Weight", coat), ("Alpha", alpha)):
        if key in b.inputs:
            b.inputs[key].default_value = val
    if alpha < 1.0 and name not in NO_TRANSMISSION:
        # panelA's translucency recipe: a touch of transmission so the walls
        # read as acrylic sheet rather than a film laid over the scene
        if "Transmission Weight" in b.inputs:
            b.inputs["Transmission Weight"].default_value = 0.55
        if "IOR" in b.inputs:
            b.inputs["IOR"].default_value = 1.05
    m.diffuse_color = hex2rgba(hexcolor)
    return m


def matte_mat(name, hexcolor, alpha=1.0):
    """viz_08 animal look: saturated matte, no metal, no sheen."""
    return pbr_mat(name, hexcolor, 0.78, 0.0, alpha, 0.0)


# --------------------------------------------------------------------------
# geometry helpers
# --------------------------------------------------------------------------
def link(obj, coll):
    coll.objects.link(obj)
    return obj


def mesh_obj(name, verts, faces, mat, coll):
    me = bpy.data.meshes.new(name)
    me.from_pydata([Vector(v) for v in verts], [], faces)
    me.update()
    ob = bpy.data.objects.new(name, me)
    ob.data.materials.append(mat)
    if mat.name.startswith(("cage", "body")):
        ob.visible_shadow = False  # translucent panels must not grey out the scene
    return link(ob, coll)


def ngon(name, pts, mat, coll):
    """One filled face over an ordered point loop — fan-triangulated from the
    centroid so slightly non-planar loops (triangulated corners) still fill."""
    c = np.mean(pts, axis=0)
    verts = [c] + list(pts)
    n = len(pts)
    faces = [(0, 1 + i, 1 + (i + 1) % n) for i in range(n)]
    return mesh_obj(name, verts, faces, mat, coll)


def tube(name, pts, radius, mat, coll):
    """Poly-curve with a round bevel: the ball-and-stick 'bone'."""
    cu = bpy.data.curves.new(name, type="CURVE")
    cu.dimensions = "3D"
    cu.bevel_depth = radius
    cu.bevel_resolution = 6
    cu.fill_mode = "FULL"
    sp = cu.splines.new("POLY")
    sp.points.add(len(pts) - 1)
    for p, v in zip(sp.points, pts):
        p.co = (*v, 1.0)
    ob = bpy.data.objects.new(name, cu)
    ob.data.materials.append(mat)
    return link(ob, coll)


def ball(name, center, radius, mat, coll):
    me = bpy.data.meshes.new(name)
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_uvsphere(bm, u_segments=16, v_segments=10, radius=radius)
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = Vector(center)
    ob.data.materials.append(mat)
    for poly in me.polygons:
        poly.use_smooth = True
    return link(ob, coll)


def box(name, size, offset, mat, coll):
    """Axis-aligned box: size (sx,sy,sz), centered at offset (local coords)."""
    sx, sy, sz = (s / 2 for s in size)
    ox, oy, oz = offset
    verts = [(ox + x, oy + y, oz + z) for x in (-sx, sx) for y in (-sy, sy) for z in (-sz, sz)]
    faces = [(0, 1, 3, 2), (4, 6, 7, 5), (0, 4, 5, 1), (2, 3, 7, 6), (0, 2, 6, 4), (1, 5, 7, 3)]
    return mesh_obj(name, verts, faces, mat, coll)


def cylinder(name, radius, depth, offset, mat, coll, axis="Z"):
    me = bpy.data.meshes.new(name)
    import bmesh
    bm = bmesh.new()
    bmesh.ops.create_cone(bm, cap_ends=True, segments=24,
                          radius1=radius, radius2=radius, depth=depth)
    if axis == "Z":
        pass
    bm.to_mesh(me)
    bm.free()
    ob = bpy.data.objects.new(name, me)
    ob.location = Vector(offset)
    ob.data.materials.append(mat)
    for poly in me.polygons:
        poly.use_smooth = True
    return link(ob, coll)


def aim(obj, target):
    """Point a camera/light's -Z at target (panelA's rig.aim, reimplemented —
    rig.py is not in this folder)."""
    d = Vector(target) - obj.location
    obj.rotation_euler = d.to_track_quat("-Z", "Y").to_euler()


# --------------------------------------------------------------------------
# data
# --------------------------------------------------------------------------
def rodrigues(r):
    r = np.asarray(r, float)
    th = np.linalg.norm(r)
    if th < 1e-12:
        return np.eye(3)
    k = r / th
    K = np.array([[0, -k[2], k[1]], [k[2], 0, -k[0]], [-k[1], k[0], 0]])
    return np.eye(3) + np.sin(th) * K + (1 - np.cos(th)) * (K @ K)


def load_session(session):
    cage_nodes = toml.load(f"{SLAP2M}/cage_skeleton.toml")["nodes"]
    mouse_nodes = toml.load(f"{SLAP2M}/mouse_skeleton.toml")["nodes"]
    with h5py.File(f"{session}/aligned_cage_points3d.h5") as f:
        cage = f["tracks"][:].squeeze() * MM               # (24, 3) m
    ali = toml.load(f"{session}/alignment.toml")
    Ra = np.array(ali["rotation"], dtype=float)            # stored as strings
    ta = np.array(ali["translation"], dtype=float)
    cams = []
    cal = toml.load(f"{session}/calibration.toml")
    for key, v in cal.items():
        if not key.startswith("cam_"):
            continue
        R = rodrigues(v["rotation"])                       # world→cam, OpenCV
        t = np.array(v["translation"], dtype=float)
        C = Ra @ (-R.T @ t - ta) * MM                      # center, aligned frame, m
        Rc = R @ Ra.T                                      # aligned-world→cam
        cams.append({"name": v["name"], "C": C, "R_cam2world": Rc.T})
    return cage_nodes, cage, mouse_nodes, ali, cams


TAIL_NODES = [7, 8, 9, 4]  # Tail_0, Tail_1, Tail_2, TailTip in mouse node order


def cage_planes(cage_nodes, cage, margin=0.004):
    """Half-space model of the cage interior: the floor and the four outer
    walls, each fit by least squares over its surface's nodes, normals facing
    the cage centroid. (The spout/filter notches are ignored — the visible
    artifact is tails through the OUTER walls and floor.)"""
    idx = {n: i for i, n in enumerate(cage_nodes)}
    ctr = cage.mean(axis=0)
    planes = []
    for sname in ("floor", "spout_wall", "filter_wall", "west_wall", "east_wall"):
        P = cage[[idx[n] for n in CAGE_SURFACES[sname]]]
        c = P.mean(axis=0)
        _, _, vt = np.linalg.svd(P - c)
        n = vt[2]
        if np.dot(ctr - c, n) < 0:
            n = -n
        planes.append((n, float(np.dot(n, c)) + margin))
    return planes


def clamp_tails(trx, planes, iters=8):
    """Project tail keypoints back inside the cage volume: any tail node below
    a wall/floor plane is moved onto that plane (a few mm inside), iterated so
    points pushed out of one half-space by another converge in corners.
    trx is (frames, tracks, 15, 3) or (tracks, 15, 3), modified in place."""
    tails = trx[..., TAIL_NODES, :]
    for _ in range(iters):
        for n, d in planes:
            s = tails @ n - d
            viol = s < 0
            if viol.any():
                tails[viol] -= s[viol][..., None] * n
    trx[..., TAIL_NODES, :] = tails
    return trx


def load_frame(session, frame):
    with h5py.File(f"{session}/aligned_points3d.h5") as f:
        return f["tracks"][frame] * MM                     # (tracks, 15, 3) m


# --------------------------------------------------------------------------
# scene builders
# --------------------------------------------------------------------------
def build_cage(cage_nodes, cage, M, coll):
    idx = {n: i for i, n in enumerate(cage_nodes)}
    for name, nodes in CAGE_SURFACES.items():
        mat = M["cage_floor"] if name == "floor" else M["cage_wall"]
        ngon(f"cage_{name}", cage[[idx[n] for n in nodes]], mat, coll)
    for i, (a, b) in enumerate(CAGE_EDGES):
        tube(f"cage_edge_{i}", cage[[idx[a], idx[b]]], 0.0022, M["ink"], coll)


def build_camera_unit(name, C, R_c2w, M, coll, focus, body_scale=1.0):
    """A machine-vision camera body: blue anodised box + dark lens barrel,
    built in OpenCV camera coords (+Z optical axis, +Y image-down) and posed
    with the calibrated extrinsics."""
    s = body_scale
    sub = bpy.data.collections.new(f"cam_{name}")
    coll.children.link(sub)
    box(f"cam_{name}_body", (0.042 * s, 0.042 * s, 0.058 * s), (0, 0, -0.020 * s), M["camera"], sub)
    cylinder(f"cam_{name}_lens", 0.0145 * s, 0.030 * s, (0, 0, 0.022 * s), M["lens"], sub)
    cylinder(f"cam_{name}_hood", 0.0165 * s, 0.006 * s, (0, 0, 0.036 * s), M["ink"], sub)
    Rm = Matrix(((R_c2w[0][0], R_c2w[0][1], R_c2w[0][2], C[0]),
                 (R_c2w[1][0], R_c2w[1][1], R_c2w[1][2], C[1]),
                 (R_c2w[2][0], R_c2w[2][1], R_c2w[2][2], C[2]),
                 (0, 0, 0, 1)))
    for ob in sub.objects:
        ob.matrix_world = Rm @ ob.matrix_world


def build_camera_support(name, C, M, coll, floor_z):
    """World-vertical mounting hardware, so the cameras don't float: overhead
    units hang from rods that leave the top of frame (an unseen ceiling rig),
    the low side units stand on rods to the floor — panelA's cameras are
    likewise on physical mounts."""
    x, y, z = C
    if z > 0.4:  # overhead ring
        tube(f"rod_{name}", [(x, y, z + 0.015), (x, y, 1.5)], 0.0042, M["mount"], coll)
    else:        # side-mounted
        tube(f"rod_{name}", [(x, y, z - 0.015), (x, y, floor_z)], 0.0042, M["mount"], coll)
        cylinder(f"foot_{name}", 0.022, 0.008, (x, y, floor_z + 0.004), M["mount"], coll)


def build_animal(track, pts, mouse_nodes, M, coll):
    """viz_08's ball-and-stick mouse in tab10, plus its translucent body
    membranes — surfaces filled, as asked."""
    idx = {n: i for i, n in enumerate(mouse_nodes)}
    col = TAB10[track % len(TAB10)]
    solid = M.setdefault(f"mouse{track}", matte_mat(f"mouse{track}", col))
    body = M.setdefault(f"body{track}", matte_mat(f"body{track}", col, alpha=0.38))
    sub = bpy.data.collections.new(f"animal_{track}")
    coll.children.link(sub)
    for n, i in idx.items():
        r = 0.0095 if n in ("Head", "Trunk", "TTI") else 0.0068
        ball(f"a{track}_{n}", pts[i], r, solid, sub)
    for j, (a, b) in enumerate(MOUSE_EDGES):
        tube(f"a{track}_e{j}", pts[[idx[a], idx[b]]], 0.0036, solid, sub)
    for j, snodes in enumerate(MOUSE_SURFACES):
        ngon(f"a{track}_s{j}", pts[[idx[n] for n in snodes]], body, sub)
    return sub


def clear_animals(scene_coll):
    for sub in list(scene_coll.children):
        if sub.name.startswith("animal_"):
            for ob in list(sub.objects):
                data = ob.data
                bpy.data.objects.remove(ob, do_unlink=True)
                # remove the mesh/curve datablock too, or a 300-frame video
                # render accumulates tens of thousands of orphans (a blanket
                # orphans_purge would instead free the cached per-track
                # materials out from under build_animal's M dict)
                if isinstance(data, bpy.types.Curve):
                    bpy.data.curves.remove(data)
                elif isinstance(data, bpy.types.Mesh):
                    bpy.data.meshes.remove(data)
            scene_coll.children.unlink(sub)
            bpy.data.collections.remove(sub)


def setup_lighting(focus):
    """panelA's four soft area lights, scaled to this ~1.5 m tabletop scene."""
    scn = bpy.context.scene
    specs = [
        # panelA's energies were tuned for a 4 m room; at this 1.5 m tabletop
        # scale the same numbers blow the frame out — quartered, then trimmed
        # against the draft renders
        ("key",    (-1.4, -1.8, 2.0), 1.8, 85.0),
        ("fill",   (1.9, -0.9, 1.3), 2.0, 30.0),
        ("rim",    (0.5, 1.9, 1.5), 1.5, 24.0),
        ("bounce", (0.0, 0.0, -0.25), 2.5, 8.0),
    ]
    for name, loc, size, energy in specs:
        ld = bpy.data.lights.new(name, type="AREA")
        ld.shape = "SQUARE"
        ld.size = size
        ld.energy = energy
        lo = link(bpy.data.objects.new(name, ld), scn.collection)
        lo.location = loc
        if name == "bounce":
            lo.rotation_euler = (math.radians(180), 0, 0)
        else:
            aim(lo, focus)
    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.92, 0.93, 0.95, 1.0)
    bg.inputs[1].default_value = 0.22
    scn.world = world


def setup_render_camera(focus, azim_deg, elev_deg, ortho_scale, dist=4.0):
    az, el = math.radians(azim_deg), math.radians(elev_deg)
    loc = Vector(focus) + dist * Vector(
        (math.cos(el) * math.cos(az), math.cos(el) * math.sin(az), math.sin(el)))
    cd = bpy.data.cameras.new("RenderCam")
    cd.type = "ORTHO"
    cd.ortho_scale = ortho_scale
    cd.clip_end = 100.0
    cam = link(bpy.data.objects.new("RenderCam", cd), bpy.context.scene.collection)
    cam.location = loc
    aim(cam, focus)
    bpy.context.scene.camera = cam
    return cam


def setup_cycles(samples, res):
    scn = bpy.context.scene
    scn.render.engine = "CYCLES"
    scn.cycles.samples = samples
    scn.cycles.use_denoising = True
    scn.render.resolution_x, scn.render.resolution_y = res
    scn.render.film_transparent = False
    scn.view_settings.view_transform = "Standard"  # panelA: no filmic grey-out
    try:
        cp = bpy.context.preferences.addons["cycles"].preferences
        cp.compute_device_type = "OPTIX"
        cp.get_devices()
        for d in cp.devices:
            d.use = d.type in ("OPTIX",)
        scn.cycles.device = "GPU"
    except Exception as e:  # CPU fallback keeps the script usable anywhere
        print("GPU setup failed, CPU fallback:", e, file=sys.stderr)


def render_to(path):
    bpy.context.scene.render.filepath = path
    bpy.ops.render.render(write_still=True)


# --------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("--session", default=DEFAULT_SESSION)
    ap.add_argument("--frame", type=int, default=3200)
    ap.add_argument("--out", default=os.path.join(HERE, "renders", "cage_two_mice.png"))
    ap.add_argument("--video", nargs=3, type=int, metavar=("START", "END", "STEP"),
                    help="render a frame range instead of one still")
    ap.add_argument("--outdir", default=os.path.join(HERE, "renders", "video"))
    ap.add_argument("--orbit", type=float, default=0.0,
                    help="degrees of render-camera azimuth sweep across the video")
    ap.add_argument("--samples", type=int, default=128)
    ap.add_argument("--res", type=int, nargs=2, default=[1600, 1200])
    ap.add_argument("--azim", type=float, default=205.0)
    ap.add_argument("--elev", type=float, default=22.0)
    ap.add_argument("--ortho", type=float, default=1.34)
    ap.add_argument("--aim-x", type=float, default=0.055,
                    help="horizontal offset (m) of the view center from the cage "
                         "centroid — the side cameras weight the frame rightward")
    ap.add_argument("--aim-z", type=float, default=0.38,
                    help="height (m) the render camera looks at — raised above "
                         "the cage centroid so the overhead cameras stay in frame")
    ap.add_argument("--cam-scale", type=float, default=1.0,
                    help="scale factor on the camera body meshes")
    ap.add_argument("--clamp-tail", action="store_true",
                    help="project tail keypoints that triangulated outside the "
                         "cage back inside its walls/floor (visualization only)")
    args = ap.parse_args()

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn_coll = bpy.context.scene.collection

    cage_nodes, cage, mouse_nodes, ali, cams = load_session(args.session)
    ctr = np.mean(cage, axis=0)
    focus = tuple(ctr * [1, 1, 0.7])                  # lights: on the animals
    view_focus = (ctr[0] + args.aim_x, ctr[1], args.aim_z)  # framing: cage + cameras

    M = {k: pbr_mat(k, *v) for k, v in PBR.items()}
    build_cage(cage_nodes, cage, M, scn_coll)
    zmin_cage = float(cage[:, 2].min())
    for c in cams:
        build_camera_unit(c["name"], c["C"], c["R_cam2world"], M, scn_coll,
                          focus, body_scale=args.cam_scale)
        build_camera_support(c["name"], c["C"], M, scn_coll, zmin_cage - 0.012)

    # room floor a hair below the cage floor, big enough to hold every shadow
    zmin = float(cage[:, 2].min())
    floor = box("room_floor", (6.0, 6.0, 0.02), (0, 0, 0), M["floor"], scn_coll)
    floor.location = (focus[0], focus[1], zmin - 0.012)

    setup_lighting(focus)
    setup_cycles(args.samples, args.res)

    if args.video:
        start, end, step = args.video
        frames = list(range(start, end, step))
        os.makedirs(args.outdir, exist_ok=True)
        cam = setup_render_camera(view_focus, args.azim, args.elev, args.ortho)
        with h5py.File(f"{args.session}/aligned_points3d.h5") as f:
            trx = f["tracks"][start:end] * MM
        if args.clamp_tail:
            clamp_tails(trx, cage_planes(cage_nodes, cage))
        for i, fr in enumerate(frames):
            if args.orbit:
                az = args.azim + args.orbit * i / max(1, len(frames) - 1)
                el = args.elev
                d = Vector(cam.location) - Vector(view_focus)
                cam.location = Vector(view_focus) + d.length * Vector(
                    (math.cos(math.radians(el)) * math.cos(math.radians(az)),
                     math.cos(math.radians(el)) * math.sin(math.radians(az)),
                     math.sin(math.radians(el))))
                aim(cam, view_focus)
            clear_animals(scn_coll)
            pts = trx[fr - start]
            for tr in range(pts.shape[0]):
                if not np.isnan(pts[tr]).all():
                    build_animal(tr, pts[tr], mouse_nodes, M, scn_coll)
            render_to(os.path.join(args.outdir, f"f{i:05d}.png"))
            print(f"[{i + 1}/{len(frames)}] frame {fr}", flush=True)
    else:
        pts = load_frame(args.session, args.frame)
        if args.clamp_tail:
            clamp_tails(pts, cage_planes(cage_nodes, cage))
        for tr in range(pts.shape[0]):
            if not np.isnan(pts[tr]).all():
                build_animal(tr, pts[tr], mouse_nodes, M, scn_coll)
        setup_render_camera(view_focus, args.azim, args.elev, args.ortho)
        os.makedirs(os.path.dirname(args.out), exist_ok=True)
        render_to(args.out)
        print("wrote", args.out)


if __name__ == "__main__":
    main()
