"""
Panel A, technical-illustration pass.

Two styles:
  --style render  shaded surfaces, soft area light, Cycles on the Metal GPU (default)
  --style flat    flat emission fills + Freestyle outlines, technical-illustration look

Every camera projects a translucent view volume that is boolean-clipped to the room,
so the volumes terminate on the floor and walls. The material is Transparent+Emission,
which adds light and never occludes, so eight overlapping volumes stay readable.

Run: ./bpyenv/bin/python panelA.py --dog dsmal --face --res 2400 --samples 200
"""
import argparse
import math
import os
import sys

import bpy
from mathutils import Vector, Matrix

import rig  # geometry builders: room, truss, cameras, rack, sync path, human

HERE = os.path.dirname(os.path.abspath(__file__))
DOGS = {
    # dm_control / MuJoCo anatomical dog skin: 17k verts, already standing, and the
    # cleanest small-size silhouette of everything tested.
    "mujoco": "assets/anat_dmcontrol_SKINbody.stl",
    # D-SMAL mean shape (BITE, Rueegg et al. 2023): the real canine shape model,
    # 3889 verts / 7774 faces. Sits in SMAL's REST pose (splayed on its side), so it
    # needs pose parameters applied through the kinematic tree before it can stand.
    "dsmal": "assets/dsmal/39dogsnorm_newv3_dog_mean.obj",
    "shiba": "assets/shiba.glb",
    "beagle": "assets/beagle.glb",
    "gsd": "assets/gsd.glb",
    "wolf": "assets/wolf.glb",
}

# Palette: light fills read by their dark outlines, so fill values can sit close
# together without collapsing. Verified for L* separation and CVD safety.
PAL = dict(
    floor="#F7F7F7",
    wall="#FFFFFF",
    room_stroke="#B0B0B0",
    cam="#08519C",          # machine-vision cameras + mounts: the one strong blue
    cam_dark="#063B70",
    fov_fill="#DCE9F5",     # pre-mixed tint, NOT alpha
    fov_edge="#6BAED6",
    sync="#D55E00",         # vermilion: sync + physiological telemetry
    dog="#E0C9A6",          # warm light fill; the outline does the work
    dog_gear="#D55E00",
    human="#DCDCDC",        # neutral, featureless: de-identified
    rack="#4A5560",
    ink="#1A1A1A",
)

TARGET_DOG_LENGTH = 0.92   # m, nose-to-tail-base of a medium dog

# An isometric 5m room projects to roughly 8.7m wide x 5.2m tall on screen, i.e.
# landscape. Panel A therefore takes the left ~4.0in of the 7.5in figure and the
# two data panels stack to its right; forcing it into a 7.5x3.0 frame crops it.
PANEL_W_IN = 4.0
PANEL_H_IN = 2.5
LINE_PT = 0.5              # Freestyle stroke weight at FINAL printed size
# Camera view volumes are OFF by default. Three treatments were tried and all three
# read badly at panel size: filled cones (occluded the room), wireframe frusta (eight
# of them is spaghetti), and boolean-clipped volumes as emissive surfaces (hard clip
# edges and banded overlaps). Volume Scatter fixed the banding but the coverage voids
# where fewer cameras overlap still read as artifacts. Kept behind --fov in case a
# later pass wants one representative wedge instead of all nine.
SHOW_FOV = False
HEAD_PITCH = 26.0          # deg the dog raises its muzzle toward the experimenter
FOV_DENSITY = 0.038        # scatter density inside each camera view volume


def hex2rgba(h, a=1.0):
    h = h.lstrip("#")
    r, g, b = (int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4))
    # sRGB -> linear, because Blender wants linear and we set view transform to Standard
    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4
    return (lin(r), lin(g), lin(b), a)


def flat_mat(name, hexcolor):
    """Pure emission: no shading gradient at all, so fills stay exactly on-palette."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = hex2rgba(hexcolor)
    em.inputs["Strength"].default_value = 1.0
    nt.links.new(em.outputs["Emission"], out.inputs["Surface"])
    m.diffuse_color = hex2rgba(hexcolor)
    return m


def build_materials():
    return {k: flat_mat(k, v) for k, v in PAL.items()} | {
        "wall_edge": flat_mat("wall_edge", PAL["room_stroke"]),
        "camera": flat_mat("camera", PAL["cam"]),
        "lens": flat_mat("lens", PAL["cam_dark"]),
        "mount": flat_mat("mount", PAL["cam"]),
        "cone": flat_mat("cone", PAL["fov_edge"]),
        "volume": flat_mat("volume", PAL["fov_fill"]),
        "dog_dark": flat_mat("dog_dark", PAL["dog_gear"]),
    }


# --------------------------------------------------------------------------
# 3D-rendered style: real surfaces, real light, soft shadows
# --------------------------------------------------------------------------
# (roughness, metallic, alpha, clearcoat) per material role. Values chosen so the
# room reads as painted drywall, the cameras as anodised housings, and the animal
# and the figure as matte, so nothing looks like plastic.
PBR = {
    "floor":     ("#D9D9D4", 0.58, 0.00, 1.00, 0.06),
    "wall":      ("#EFEEEB", 0.88, 0.00, 1.00, 0.00),
    "wall_edge": ("#C8C8C6", 0.80, 0.00, 1.00, 0.00),
    "camera":    ("#1D4E8A", 0.38, 0.55, 1.00, 0.20),
    "lens":      ("#14171C", 0.22, 0.75, 1.00, 0.35),
    "mount":     ("#5F656E", 0.30, 0.90, 1.00, 0.12),
    "cone":      ("#5A9BD4", 0.55, 0.00, 0.22, 0.00),
    "volume":    ("#9CC4E4", 0.60, 0.00, 0.11, 0.00),
    "dog":       ("#C69B6D", 0.78, 0.00, 1.00, 0.00),
    "dog_dark":  ("#C4551C", 0.55, 0.00, 1.00, 0.05),
    "human":     ("#4E7396", 0.62, 0.00, 1.00, 0.06),
    "rack":      ("#3A4450", 0.42, 0.35, 1.00, 0.10),
    "sync":      ("#C4551C", 0.50, 0.00, 1.00, 0.05),
    "ink":       ("#1A1A1A", 0.60, 0.00, 1.00, 0.00),
    "fov_fill":  ("#9CC4E4", 0.60, 0.00, 0.11, 0.00),
    "fov_edge":  ("#5A9BD4", 0.55, 0.00, 0.22, 0.00),
    "cam":       ("#1D4E8A", 0.38, 0.55, 1.00, 0.20),
    "cam_dark":  ("#14171C", 0.22, 0.75, 1.00, 0.35),
    "dog_gear":  ("#C4551C", 0.55, 0.00, 1.00, 0.05),
    "room_stroke": ("#C8C8C6", 0.80, 0.00, 1.00, 0.00),
}


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
    if alpha < 1.0:
        # transmissive rather than merely see-through, so the wedge reads as a
        # volume of light instead of a flat film laid over the room
        if "Transmission Weight" in b.inputs:
            b.inputs["Transmission Weight"].default_value = 0.55
        if "IOR" in b.inputs:
            b.inputs["IOR"].default_value = 1.05
    m.diffuse_color = hex2rgba(hexcolor)
    return m


def wedge_mat(name, hexcolor, strength=0.55, opacity=0.20):
    """Transparent + Emission mix. Modelling the wedge as glass made it disappear:
    a transmissive solid neither occludes nor glows, so at low alpha it vanishes
    into the wall. This adds light instead."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    mix = nt.nodes.new("ShaderNodeMixShader")
    tr = nt.nodes.new("ShaderNodeBsdfTransparent")
    em = nt.nodes.new("ShaderNodeEmission")
    em.inputs["Color"].default_value = hex2rgba(hexcolor)
    em.inputs["Strength"].default_value = strength
    mix.inputs["Fac"].default_value = opacity
    nt.links.new(tr.outputs[0], mix.inputs[1])
    nt.links.new(em.outputs[0], mix.inputs[2])
    nt.links.new(mix.outputs[0], out.inputs["Surface"])
    m.diffuse_color = hex2rgba(hexcolor)
    return m


def volume_mat(name, hexcolor, density=0.055):
    """A true participating medium instead of an emissive surface.

    Surface emission was the wrong primitive for the view volumes: nine faceted
    pyramids, boolean-clipped to the room, showed every hard clip edge and every
    overlap boundary as a visible band, which read as low-poly crystal rather than
    coverage. A Volume Scatter medium integrates along the ray, so the cone SURFACES
    disappear (Surface is left unconnected, hence fully transparent) and overlapping
    volumes accumulate smoothly and in proportion to path length, which is exactly
    the weighted additive behaviour wanted."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    vol = nt.nodes.new("ShaderNodeVolumeScatter")
    vol.inputs["Color"].default_value = hex2rgba(hexcolor)
    vol.inputs["Density"].default_value = density
    if "Anisotropy" in vol.inputs:
        vol.inputs["Anisotropy"].default_value = 0.25
    nt.links.new(vol.outputs["Volume"], out.inputs["Volume"])
    m.diffuse_color = hex2rgba(hexcolor)
    return m


def build_materials_pbr():
    M = {k: pbr_mat(k, *v) for k, v in PBR.items()}
    M["volume"] = volume_mat("view_volume", "#5FA0DC", density=FOV_DENSITY)
    M["fov_fill"] = M["volume"]
    return M


def setup_lighting_3d():
    """Large soft area lights. The soft contact shadows under the dog, the figure
    and the rack are most of what separates a render from a diagram."""
    scn = bpy.context.scene
    specs = [
        # name,        location,             size, energy, rot(euler)
        ("key",   (-3.4, -4.2, 4.6), 4.5, 900.0, (math.radians(38), math.radians(-16), math.radians(28))),
        ("fill",  (4.6, -2.2, 3.0), 5.0, 260.0, (math.radians(58), math.radians(30), math.radians(-40))),
        ("rim",   (1.2, 4.6, 3.6), 3.5, 200.0, (math.radians(-52), 0.0, math.radians(8))),
        ("bounce", (0.0, 0.0, -0.4), 6.0, 90.0, (math.radians(180), 0.0, 0.0)),
    ]
    for name, loc, size, energy, rot in specs:
        ld = bpy.data.lights.new(name, type="AREA")
        ld.shape = "SQUARE"
        ld.size = size
        ld.energy = energy
        lo = bpy.data.objects.new(name, ld)
        scn.collection.objects.link(lo)
        lo.location = loc
        lo.rotation_euler = rot
        # aim the three primary lights at the working volume
        if name != "bounce":
            rig.aim(lo, (0.25, 0.0, 0.65))

    world = bpy.data.worlds.new("W3D")
    world.use_nodes = True
    nt = world.node_tree
    bg = nt.nodes["Background"]
    bg.inputs[0].default_value = (0.86, 0.88, 0.92, 1.0)
    bg.inputs[1].default_value = 0.55
    scn.world = world


def enable_metal_gpu():
    """Cycles on Apple Silicon.

    compute_device_type's enum_items comes back EMPTY in background mode, so any
    code that validates 'METAL' against the enum before assigning wrongly concludes
    the GPU is unavailable. Assign it directly. Note the FIRST GPU render in a fresh
    environment spends ~100 s compiling Metal kernels; later renders are ~1 s, and
    the compiled kernels persist on disk across processes."""
    try:
        cp = bpy.context.preferences.addons["cycles"].preferences
        cp.compute_device_type = "METAL"
        cp.get_devices()
        used = []
        for d in cp.devices:
            d.use = (d.type == "METAL")
            if d.use:
                used.append(d.name)
        print(f"  cycles devices: {used or 'NONE (falling back to CPU)'}")
        return bool(used)
    except Exception as e:
        print(f"  metal setup failed ({e}); CPU")
        return False


# ---------------------------------------------------------------------------
def _local_extent(obj):
    """Extent straight from vertex coordinates, no matrix applied. Valid because
    import_dog folds the world matrix into the mesh data up front."""
    pts = [v.co for v in obj.data.vertices]
    if not pts:
        return None
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    return dict(sx=max(xs) - min(xs), sy=max(ys) - min(ys), sz=max(zs) - min(zs),
                cx=(max(xs) + min(xs)) / 2, cy=(max(ys) + min(ys)) / 2,
                zmin=min(zs), n=len(pts))


def _world_extent(obj):
    """Bounds from the object's own mesh data, transformed by matrix_world.

    Do NOT use evaluated_get(dg).to_mesh() here: in this bpy build its result is
    invariant to the object transform, so every measurement comes back identical
    and any scale derived from it is silently wrong. This is only valid once the
    armature has been baked with object.convert(), which import_dog does first."""
    mw = obj.matrix_world
    pts = [mw @ v.co for v in obj.data.vertices]
    if not pts:
        return None
    xs = [p.x for p in pts]; ys = [p.y for p in pts]; zs = [p.z for p in pts]
    return dict(sx=max(xs) - min(xs), sy=max(ys) - min(ys), sz=max(zs) - min(zs),
                cx=(max(xs) + min(xs)) / 2, cy=(max(ys) + min(ys)) / 2,
                zmin=min(zs), n=len(pts))


DOG_LOC = (-0.10, -0.35, 0.0)
HUMAN_LOC = (1.05, 0.45, 0.0)


def native_gesture_bearing(obj, from_frac=0.50):
    """Bearing of the gesturing hand relative to the body axis, in the mesh's own
    frame. Guessing the SMPL export's forward axis by hand produced a figure that
    ignored the dog, so this measures the gesture instead.

    Two traps here, both hit in turn. First, an upper z bound of 1.55 m missed the
    hand entirely, because the stay gesture RAISES the arm to about 1.9 m; the search
    then locked onto a torso vertex and returned exactly 0 degrees. Second, this runs
    BEFORE the figure is dropped to the floor, and SMPL's origin sits at the pelvis,
    so absolute thresholds match nothing. The cut is therefore a FRACTION of the
    figure's own height."""
    e = _local_extent(obj)
    z_lo = e["zmin"] + from_frac * e["sz"]
    best, best_d, best_z = None, -1.0, 0.0
    for v in obj.data.vertices:
        if v.co.z < z_lo:
            continue
        dx, dy = v.co.x - e["cx"], v.co.y - e["cy"]
        d = dx * dx + dy * dy
        if d > best_d:
            best_d, best, best_z = d, (dx, dy), v.co.z
    if best is None:
        return 0.0
    print(f"    gesture hand at r={math.sqrt(best_d):.2f} m, z={best_z:.2f} m")
    return math.degrees(math.atan2(best[1], best[0]))


def bearing(frm, to):
    return math.degrees(math.atan2(to[1] - frm[1], to[0] - frm[0]))


def tilt_head(obj, pitch_deg, t_pivot=0.62, t_full=0.84):
    """Raise the muzzle so the dog looks up at the standing experimenter.

    An ARC BEND, not a weighted rotation about a pivot. The earlier version rotated
    each vertex about a fixed point by a smoothstep-weighted angle, which moves
    vertices along CHORDS: the neck axis came out shorter than it started and the
    ventral side bunched, i.e. a visibly squashed neck. Here the neck axis is instead
    re-parameterised onto a circular arc of radius R = L/theta, so its arc length is
    preserved exactly, and the head forward of the bend rides along rigidly.

    Bends in XZ, so it must run while the dog still faces +X — before place_mesh
    applies the heading. The lateral coordinate is untouched: this is pure pitch."""
    if abs(pitch_deg) < 1e-6:
        return
    e = _local_extent(obj)
    xs = [v.co.x for v in obj.data.vertices]
    x0, x1 = min(xs), max(xs)
    span = max(x1 - x0, 1e-9)
    px = x0 + t_pivot * span
    L = (t_full - t_pivot) * span              # arc length of the bending neck
    near = [v.co.z for v in obj.data.vertices if abs(v.co.x - px) < 0.03 * span]
    pz = sum(near) / len(near) if near else e["zmin"] + 0.6 * e["sz"]

    th = math.radians(pitch_deg)               # positive lifts the muzzle
    R = L / th                                  # curvature radius of the neck arc
    ct, st = math.cos(th), math.sin(th)
    ex = px + R * st                            # arc endpoint on the axis
    ez = pz + R * (1.0 - ct)

    for v in obj.data.vertices:
        s = v.co.x - px                         # distance along the neck axis
        if s <= 0.0:
            continue                            # body: untouched
        r = v.co.z - pz                         # offset from the axis
        if s < L:
            phi = s / R
            v.co.x = px + (R - r) * math.sin(phi)
            v.co.z = pz + R - (R - r) * math.cos(phi)
        else:
            d = s - L                           # head: rigid, riding the arc end
            v.co.x = ex + d * ct - r * st
            v.co.z = ez + d * st + r * ct
    obj.data.update()
    print(f"  head bent {pitch_deg:.0f} deg up: neck arc L={L:.3f} R={R:.3f} "
          f"at x={px:.2f} z={pz:.2f}")


def place_mesh(obj, loc, heading_deg):
    """Centre on origin, rotate the mesh data in place, then translate to loc.

    Never set rotation_euler for this: object rotation is about the world origin, so
    a figure standing at (1.05, 0.45) swings along an arc when you rotate it, and any
    separately-built part positioned in data space is left behind."""
    e = _local_extent(obj)
    obj.data.transform(Matrix.Translation(
        Vector((-e["cx"], -e["cy"], -e["zmin"]))))
    obj.data.transform(Matrix.Rotation(math.radians(heading_deg), 4, "Z"))
    obj.data.transform(Matrix.Translation(Vector((loc[0], loc[1], loc[2]))))
    obj.data.update()
    obj.rotation_euler = (0.0, 0.0, 0.0)
    return obj


def import_dog(kind, M, loc=DOG_LOC, heading=None):
    """Import a glTF dog, normalise it to a real medium-dog length, stand it on
    the floor, orient it along its heading, and recolour it to the palette.

    The Quaternius rigs ship a junk helper mesh alongside the animal, so the dog
    is identified as the highest-vertex-count mesh rather than the first one."""
    path = os.path.join(HERE, DOGS[kind])
    before = set(bpy.data.objects)
    ext = os.path.splitext(path)[1].lower()
    if ext == ".glb" or ext == ".gltf":
        bpy.ops.import_scene.gltf(filepath=path)
    elif ext == ".obj":
        bpy.ops.wm.obj_import(filepath=path)
    elif ext == ".stl":
        bpy.ops.wm.stl_import(filepath=path)
    else:
        raise RuntimeError(f"unhandled mesh format {ext}")
    bpy.context.view_layer.update()
    new = [o for o in bpy.data.objects if o not in before]
    meshes = [o for o in new if o.type == "MESH"]
    if not meshes:
        raise RuntimeError(f"no mesh in {path}")

    dog = max(meshes, key=lambda o: len(o.data.vertices))

    if ext in (".glb", ".gltf"):
        # bake the armature-posed shape into real geometry, then drop the rig
        bpy.ops.object.select_all(action="DESELECT")
        dog.select_set(True)
        bpy.context.view_layer.objects.active = dog
        bpy.ops.object.convert(target="MESH")
        dog = bpy.context.active_object
        bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    for o in list(new):
        if o is not dog and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)

    # Fold the glTF root transform (a 100x cm->m scale) into the mesh data by hand
    # and zero the object matrix. bpy.ops.object.transform_apply proved unreliable
    # here, so every subsequent transform goes through mesh.transform(), which
    # edits vertex coordinates directly and needs no operator context or depsgraph.
    dog.data.transform(dog.matrix_world)
    dog.matrix_basis = Matrix.Identity(4)

    ext = _local_extent(dog)
    print(f"  raw[{kind}]: verts={ext['n']} X={ext['sx']:.3f} "
          f"Y={ext['sy']:.3f} Z={ext['sz']:.3f}")

    # A standing quadruped is taller than it is wide. If it is not, the mesh was
    # authored Y-up (as the D-SMAL OBJ is) and merely looks like it is lying on its
    # side. Rotate Y-up into Z-up before doing anything else.
    if ext["sz"] < ext["sy"]:
        dog.data.transform(Matrix.Rotation(math.radians(-90), 4, "X"))
        ext = _local_extent(dog)
        print(f"  [{kind}] was Y-up; rotated to Z-up -> "
              f"X={ext['sx']:.3f} Y={ext['sy']:.3f} Z={ext['sz']:.3f}")

    # the longer horizontal span is the nose-to-tail axis; put it on +X
    if ext["sy"] > ext["sx"]:
        dog.data.transform(Matrix.Rotation(math.radians(-90), 4, "Z"))
        ext = _local_extent(dog)

    s = TARGET_DOG_LENGTH / max(ext["sx"], 1e-9)
    dog.data.transform(Matrix.Diagonal((s, s, s, 1.0)))

    tilt_head(dog, HEAD_PITCH)

    if heading is None:
        # the nose sits on +X after the axis fix, so the dog's bearing to the
        # experimenter IS its heading
        heading = bearing(loc, HUMAN_LOC)
    place_mesh(dog, loc, heading)
    print(f"  dog heading -> {heading:.1f} deg (facing the experimenter)")

    dog.data.materials.clear()
    dog.data.materials.append(M["dog"])
    dog.name = "DOG"

    f = _local_extent(dog)
    print(f"  dog[{kind}]: length={max(f['sx'], f['sy']):.2f} "
          f"height={f['sz']:.2f} m  (target length {TARGET_DOG_LENGTH})")
    return dog


def import_figure(path, M, material_key, normalize="height", target=1.72,
                  loc=(0.0, 0.0, 0.0), heading=0.0, action_hint=None, frame=1,
                  bone_pose=None):
    """Import a rigged glTF figure, optionally bake a pose from one of its baked
    animation clips, normalise it to a real-world size, stand it on the floor and
    flatten it to one flat-fill material.

    Same three traps as the dog: a junk helper mesh ships alongside the figure,
    the glTF root carries a 100x scale, and the evaluated-mesh API ignores the
    object transform. So: pick by vertex count, fold the matrix by hand, and
    transform mesh data directly."""
    before = set(bpy.data.objects)
    before_actions = set(bpy.data.actions)
    bpy.ops.import_scene.gltf(filepath=path)
    bpy.context.view_layer.update()
    new = [o for o in bpy.data.objects if o not in before]
    # Only consider actions THIS import brought in. Searching all of bpy.data.actions
    # matches the dog's clip, because the Quaternius animal and human rigs both
    # name a clip "Idle" and the dog is imported first.
    new_actions = [a for a in bpy.data.actions if a not in before_actions]
    rest_h = None

    # hand-posed rig: clear the imported action first, because its fcurves target
    # rotation_quaternion and silently overwrite anything written to rotation_euler
    # on the next depsgraph evaluation
    if bone_pose:
        arm = next((o for o in new if o.type == "ARMATURE"), None)
        fig0 = max((o for o in new if o.type == "MESH"),
                   key=lambda o: len(o.data.vertices))
        mw0 = fig0.matrix_world
        zs0 = [(mw0 @ v.co).z for v in fig0.data.vertices]
        rest_h = max(zs0) - min(zs0)      # bind-pose height, before posing
        if arm:
            if arm.animation_data:
                arm.animation_data.action = None
                arm.animation_data_clear()
            for pb in arm.pose.bones:
                pb.rotation_mode = "XYZ"
                pb.rotation_euler = (0.0, 0.0, 0.0)
            for bname, (rx, ry, rz) in bone_pose:
                pb = arm.pose.bones.get(bname)
                if pb:
                    pb.rotation_euler = (math.radians(rx), math.radians(ry),
                                         math.radians(rz))
            bpy.context.view_layer.update()

    # pose the rig from a baked clip: a bind-pose T/A-stance reads as a mannequin
    # on a shop rack, not a person standing in a room
    if action_hint:
        arm = next((o for o in new if o.type == "ARMATURE"), None)
        act = next((a for a in new_actions
                    if action_hint.lower() in a.name.lower()), None)
        if arm and act:
            if arm.animation_data is None:
                arm.animation_data_create()
            arm.animation_data.action = act
            bpy.context.scene.frame_set(frame)
            bpy.context.view_layer.update()
            print(f"  posed from '{act.name}' at frame {frame}")

    meshes = [o for o in new if o.type == "MESH"]
    fig = max(meshes, key=lambda o: len(o.data.vertices))
    bpy.ops.object.select_all(action="DESELECT")
    fig.select_set(True)
    bpy.context.view_layer.objects.active = fig
    bpy.ops.object.convert(target="MESH")          # bakes the posed armature
    fig = bpy.context.active_object
    bpy.ops.object.parent_clear(type="CLEAR_KEEP_TRANSFORM")
    for o in list(new):
        if o is not fig and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)

    fig.data.transform(fig.matrix_world)
    fig.matrix_basis = Matrix.Identity(4)

    ext = _local_extent(fig)
    if bone_pose and rest_h:
        s = target / rest_h
    elif normalize == "height":
        s = target / max(ext["sz"], 1e-9)
    else:
        if ext["sy"] > ext["sx"]:
            fig.data.transform(Matrix.Rotation(math.radians(-90), 4, "Z"))
            ext = _local_extent(fig)
        s = target / max(ext["sx"], 1e-9)
    fig.data.transform(Matrix.Diagonal((s, s, s, 1.0)))

    ext = _local_extent(fig)
    fig.data.transform(Matrix.Translation(
        Vector((loc[0] - ext["cx"], loc[1] - ext["cy"], loc[2] - ext["zmin"]))))
    fig.data.update()
    fig.rotation_euler = (0, 0, math.radians(heading))

    fig.data.materials.clear()
    fig.data.materials.append(M[material_key])
    f = _local_extent(fig)
    print(f"  figure[{os.path.basename(path)}]: h={f['sz']:.2f} "
          f"w={max(f['sx'], f['sy']):.2f} m")
    return fig


HUMAN_COLL = "FIG_HUMAN"


def deface(fig, M, head_h=0.235):
    """Cut the head off above the jaw and cap it with a smooth ovoid.

    Suppressing creases was not enough: the modelled eyes and nose survive as
    silhouette and border edges, so the figure kept a face. Removing the geometry
    is the only guarantee, and a blank ovoid head is the clearer statement anyway —
    the figure is anonymous by construction, not by a promise in the caption.

    The cut is anchored a fixed anatomical distance below the crown, NOT to a
    fraction of overall height: a seated figure is 1.0 m tall instead of 1.72 m, so
    a fractional cut decapitates it at the shoulders and leaves the cap floating."""
    import bmesh
    e = _local_extent(fig)
    zcut = e["zmin"] + e["sz"] - head_h
    bm = bmesh.new()
    bm.from_mesh(fig.data)
    doomed = [v for v in bm.verts if v.co.z > zcut]
    bmesh.ops.delete(bm, geom=doomed, context="VERTS")
    bm.to_mesh(fig.data)
    bm.free()
    fig.data.update()

    # Place the cap on the NECK STUMP, not at the body's XY centre: once the figure
    # is seated with its legs out, the body centre sits well forward of the neck and
    # the head floats off in front of the shoulders.
    e2 = _local_extent(fig)
    neck_z = e2["zmin"] + e2["sz"]
    stump = [v.co for v in fig.data.vertices if v.co.z > neck_z - 0.035]
    if stump:
        nx = sum(p.x for p in stump) / len(stump)
        ny = sum(p.y for p in stump) / len(stump)
    else:
        nx, ny = e["cx"], e["cy"]
    head = rig.sphere(0.106, (nx, ny, neck_z + 0.050), M["human"],
                      name="head_blank", segs=28, scale=(0.88, 0.95, 1.14))
    coll = bpy.data.collections.get(HUMAN_COLL)
    if coll:
        for c in list(head.users_collection):
            c.objects.unlink(head)
        coll.objects.link(head)
    print(f"  defaced: removed {len(doomed)} head verts above z={zcut:.2f}")
    return head


WAIT_POSE = [
    # Standing, weight even, torso turned slightly toward the dog, near arm raised
    # forward with the hand flexed back so the palm faces the animal: the ordinary
    # "wait" / "stay" signal. The far arm hangs, which keeps the silhouette readable.
    ("Spine",        (  1,  0,   0)),
    ("Spine1",       (  1,  0,  -4)),
    ("Neck",         (  6,  0,  -3)),
    ("Head",         (  8,  0,  -4)),
    ("LeftUpLeg",    (  2,  0,   4)),
    ("RightUpLeg",   ( -2,  0,  -4)),
    ("LeftLeg",      (  3,  0,   0)),
    ("RightLeg",     (  4,  0,   0)),
    ("RightShoulder",(  0,  0,  -8)),
    ("RightArm",     ( 74,  0,  10)),
    ("RightForeArm", ( 26,  0,   0)),
    ("RightHand",    (-46,  0,   0)),
    ("LeftArm",      ( 10,  0, -10)),
    ("LeftForeArm",  ( 16,  0,   0)),
]


def import_human_smpl(M, loc=HUMAN_LOC, heading=125.0,
                      rel="assets/human/SMPL_stay_lean.obj", target=1.78):
    """The experimenter as a real SMPL body, posed standing with one arm extended in
    a stay gesture. Replaces 4.7k-vertex game art, whose faceted shoulders and limbs
    were the single worst thing in the panel.

    Uses the LEAN shape parameterisation (betas=[1.0, 2.0], 6,531 verts). SMPL's
    default betas=0 is the population MEAN body, which is soft and slightly heavyset
    and read oddly for an experimenter at panel size. beta[0] is height and beta[1] is
    slimness. The head has already been replaced with a smooth ovoid using the model's
    own skinning weights, so no deface pass is needed here either.

    Authored Y-up like the D-SMAL dog, so it needs the same axis correction."""
    path = os.path.join(HERE, rel)
    before = set(bpy.data.objects)
    bpy.ops.wm.obj_import(filepath=path)
    bpy.context.view_layer.update()
    new = [o for o in bpy.data.objects if o not in before and o.type == "MESH"]
    fig = max(new, key=lambda o: len(o.data.vertices))
    for o in list(new):
        if o is not fig and o.name in bpy.data.objects:
            bpy.data.objects.remove(o, do_unlink=True)

    fig.data.transform(fig.matrix_world)
    fig.matrix_basis = Matrix.Identity(4)
    e = _local_extent(fig)
    if e["sz"] < e["sy"]:                      # standing human: height > depth
        fig.data.transform(Matrix.Rotation(math.radians(-90), 4, "X"))
        e = _local_extent(fig)
    s = target / max(e["sz"], 1e-9)
    fig.data.transform(Matrix.Diagonal((s, s, s, 1.0)))
    native = native_gesture_bearing(fig)
    want = bearing(loc, DOG_LOC)
    heading = want - native
    print(f"  human: gesture native={native:.1f} deg, want={want:.1f} deg "
          f"-> heading={heading:.1f} deg")
    place_mesh(fig, loc, heading)
    bpy.ops.object.shade_smooth()

    fig.data.materials.clear()
    fig.data.materials.append(M["human"])
    fig.name = "HUMAN_DEIDENTIFIED"
    coll = bpy.data.collections.new(HUMAN_COLL)
    bpy.context.scene.collection.children.link(coll)
    for c in list(fig.users_collection):
        c.objects.unlink(fig)
    coll.objects.link(fig)
    # No deface pass here. An SMPL body's head is already smooth and featureless -
    # no eye, brow or mouth geometry at all - so rendered untextured it reads as a
    # mannequin head on its own. Cutting and capping it only introduced a seam.
    f = _local_extent(fig)
    print(f"  SMPL human: verts={f['n']} h={f['sz']:.2f} depth={f['sx']:.2f} m")
    return fig


def import_human(M, loc=HUMAN_LOC, heading=-145.0, frame=1):
    """The experimenter, rendered as an untextured neutral figure.

    The mesh carries a modelled face and musculature. Left alone, Freestyle draws
    creases over both and the figure acquires eyes, a nose and a six-pack, which is
    the exact opposite of the de-identification the panel is meant to assert. So the
    figure goes in its own collection and the line pass gives it SILHOUETTE ONLY."""
    fig = import_figure(os.path.join(HERE, "assets/human.glb"), M, "human",
                        normalize="height", target=1.72, loc=loc,
                        heading=heading, bone_pose=WAIT_POSE)
    fig.name = "HUMAN_DEIDENTIFIED"
    coll = bpy.data.collections.new(HUMAN_COLL)
    bpy.context.scene.collection.children.link(coll)
    for c in list(fig.users_collection):
        c.objects.unlink(fig)
    coll.objects.link(fig)
    deface(fig, M)
    return fig


def add_dog_wearables(dog, M):
    """A telemetry harness band around the torso.

    Sizing this from the whole-body bounding box put a fat orange disc beside the
    dog, because bbox centre is not torso centre and each mesh has different
    proportions. Instead, measure the actual body cross-section at mid-length and
    fit the band to it, which works for any of the candidate meshes."""
    e = _local_extent(dog)
    xs = sorted(v.co.x for v in dog.data.vertices)
    xmid = (xs[0] + xs[-1]) / 2
    band = 0.045 * e["sx"]
    ring = [v.co for v in dog.data.vertices if abs(v.co.x - xmid) < band]
    if len(ring) < 12:
        return None
    ys = [p.y for p in ring]; zs = [p.z for p in ring]
    cy = (max(ys) + min(ys)) / 2
    cz = (max(zs) + min(zs)) / 2
    r = 0.5 * max(max(ys) - min(ys), max(zs) - min(zs)) * 1.06

    bpy.ops.mesh.primitive_torus_add(major_radius=r, minor_radius=0.015,
                                     major_segments=28, minor_segments=8)
    t = bpy.context.active_object
    # bake ring orientation + position into the mesh, then copy the dog's own
    # object rotation, so the band travels with the heading without parenting
    t.data.transform(Matrix.Rotation(math.radians(90), 4, "Y"))
    t.data.transform(Matrix.Translation(Vector((xmid, cy, cz))))
    t.data.update()
    t.location = (0, 0, 0)
    t.rotation_euler = dog.rotation_euler
    t.data.materials.clear()
    t.data.materials.append(M["dog_dark"])
    t.name = "harness"
    print(f"  harness: r={r:.3f} at x={xmid:.2f} z={cz:.2f}")
    return t


def _unused_add_dog_wearables(dog, M):
    e = _local_extent(dog)
    zmax = e['zmin'] + e['sz']
    cx, cy = e['cx'], e['cy']
    rig.cyl(0.115, 0.05, (cx, cy, zmax * 0.62),
            rot=(0, math.radians(90), math.radians(-118)),
            material=M["dog_dark"], name="harness")


# ---------------------------------------------------------------------------
def fov_wedge(loc, target, fov_deg, M, length=None, aspect=4.0 / 3.0):
    """The single representative field of view: a solid pre-mixed tint wedge with
    a thin edge, terminated short of the far wall so it reads as measured."""
    loc = Vector(loc)
    d = (Vector(target) - loc)
    L = length if length else min(d.length * 0.62, 1.72)
    fwd = d.normalized()
    rad = math.tan(math.radians(fov_deg / 2)) * L
    bpy.ops.mesh.primitive_cone_add(radius1=0.012, radius2=rad, depth=L, vertices=4)
    c = bpy.context.active_object
    c.rotation_euler = fwd.to_track_quat("Z", "Y").to_euler()
    c.location = loc + fwd * (L / 2)
    c.scale = (1.0, 1.0 / aspect, 1.0)
    c.data.materials.clear()
    c.data.materials.append(M["volume"])
    c.name = "FOV_WEDGE"
    return c


def build_stool(M, loc, seat_z=0.42, seat_r=0.17):
    """A low stool. The seated pose puts the pelvis at roughly 0.42 m with the feet
    flat, which is stool height, not floor height. Rather than fight the leg chain
    into a true floor-sit, give the pose the prop it implies."""
    x, y, _ = loc
    parts = [rig.cyl(seat_r, 0.045, (x, y, seat_z), material=M["mount"],
                     name="stool_seat")]
    for i in range(3):
        a = math.radians(90 + i * 120)
        lx, ly = x + 0.115 * math.cos(a), y + 0.115 * math.sin(a)
        parts.append(rig.thin_line((lx, ly, 0.0), (x + 0.035 * math.cos(a),
                                                   y + 0.035 * math.sin(a),
                                                   seat_z - 0.025),
                                   0.014, M["mount"], f"stool_leg{i}"))
    return parts


def pointing_tick(loc, target, M, length=0.26):
    loc = Vector(loc)
    fwd = (Vector(target) - loc).normalized()
    return rig.thin_line(loc + fwd * 0.09, loc + fwd * (0.09 + length),
                         0.011, M["cone"], "tick")


def room_interior_solid():
    """The room's inner volume, used as a boolean clip target for the view volumes
    and hidden from the render. Without it the wedges shoot straight through the
    walls and out into empty space."""
    R = rig.CFG["room"]
    bpy.ops.mesh.primitive_cube_add(size=1)
    b = bpy.context.active_object
    b.scale = (R["w"], R["d"], R["h"])
    b.location = (0.0, 0.0, R["h"] / 2)
    b.name = "ROOM_INTERIOR"
    b.hide_render = True
    return b


def view_volume(loc, target, fov_deg, M, clip, aspect=4.0 / 3.0, reach=9.0, tag=""):
    """One camera's field of view as a translucent solid that stops at the floor and
    walls. Built long and then boolean-intersected with the room interior, which is
    far more robust than solving each ray against the box analytically.

    The material is Transparent + Emission, so it ADDS light and never occludes: with
    eight of these overlapping, an absorbing material would bury the subjects."""
    loc = Vector(loc)
    fwd = (Vector(target) - loc).normalized()
    rad = math.tan(math.radians(fov_deg / 2)) * reach
    bpy.ops.mesh.primitive_cone_add(radius1=0.004, radius2=rad, depth=reach,
                                    vertices=4)
    c = bpy.context.active_object
    c.rotation_euler = fwd.to_track_quat("Z", "Y").to_euler()
    c.location = loc + fwd * (reach / 2)
    c.scale = (1.0, 1.0 / aspect, 1.0)
    c.data.materials.clear()
    c.data.materials.append(M["volume"])
    c.name = f"FOV{tag}"
    m = c.modifiers.new("clip", "BOOLEAN")
    m.operation = "INTERSECT"
    m.object = clip
    m.solver = "FLOAT"   # Blender 5 renamed FAST -> FLOAT
    return c


def build_optics(M, face_cam=False):
    R = rig.CFG["room"]
    pts = rig.cam_positions(rig.CFG["n_cams"], R["w"], R["d"], R["h"])
    center = (0.0, 0.0, 0.55)
    clip = room_interior_solid() if SHOW_FOV else None
    for i, p in enumerate(pts):
        rig.build_camera_unit(p, center, M, rig.CFG["fov_deg"],
                              cone=False, tag=f"{i:02d}", frustum=False)
        if SHOW_FOV:
            view_volume(p, center, rig.CFG["fov_deg"], M, clip, tag=f"{i:02d}")

    if face_cam:
        # Corner-mounted at dog head height rather than on a floor tripod: a low
        # camera in the wall corner sees the head without putting a stand inside
        # the animal's space, and it mounts to structure that already exists.
        ix2, iy2 = R["w"] / 2 - 0.16, R["d"] / 2 - 0.16
        fp = (-ix2 + 0.06, iy2 - 0.06, 0.55)
        tgt = (DOG_LOC[0], DOG_LOC[1], 0.52)
        rig.build_camera_unit(fp, tgt, M, rig.CFG["face_fov_deg"],
                              cone=False, tag="_face", frustum=False)
        if SHOW_FOV:
            view_volume(fp, tgt, rig.CFG["face_fov_deg"], M, clip, tag="_face")
        rig.thin_line(fp, (-ix2 - 0.09, iy2 + 0.09, 0.55), 0.016, M["mount"],
                      "corner_bracket")
    return pts


# ---------------------------------------------------------------------------
def setup_view(res_x, ortho_scale=6.95):
    """Isometric-ish, cropped so the room's near corner falls below the frame."""
    scn = bpy.context.scene
    cd = bpy.data.cameras.new("ViewCam")
    cd.type = "ORTHO"
    cd.ortho_scale = ortho_scale
    cam = bpy.data.objects.new("ViewCam", cd)
    scn.collection.objects.link(cam)
    az, el, dist = math.radians(-54), math.radians(29), 18.0
    cam.location = (dist * math.cos(el) * math.cos(az),
                    dist * math.cos(el) * math.sin(az),
                    dist * math.sin(el) + 0.6)
    rig.aim(cam, (0.02, 0.16, 1.06))
    scn.camera = cam

    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    world.node_tree.nodes["Background"].inputs[1].default_value = 0.0
    scn.world = world

    scn.render.resolution_x = res_x
    scn.render.resolution_y = int(res_x * (PANEL_H_IN / PANEL_W_IN))
    scn.render.film_transparent = True
    scn.render.image_settings.file_format = "PNG"
    scn.render.image_settings.color_mode = "RGBA"
    scn.view_settings.view_transform = "Standard"
    return cam


def setup_freestyle(res_x, pt_at_final=LINE_PT, panel_width_in=PANEL_W_IN, dpi=600):
    """Freestyle thickness is in PIXELS, so it must be derived from the output
    resolution or a weight tuned at preview size vanishes at print size."""
    scn = bpy.context.scene
    scn.render.use_freestyle = True
    vl = scn.view_layers[0]
    vl.use_freestyle = True
    fs = vl.freestyle_settings
    fs.crease_angle = math.radians(135)
    # Enabling freestyle AUTO-CREATES linesets[0] with linestyle=None, which makes
    # the line pass throw inside parameter_editor.py. Creating a second, valid
    # lineset does not help: the broken one is still processed. Repair them all.
    for existing in fs.linesets:
        if existing.linestyle is None:
            existing.linestyle = bpy.data.linestyles.new(f"LS_{existing.name}")
    ls = fs.linesets[0]
    ls.name = "outline"
    hcoll = bpy.data.collections.get(HUMAN_COLL)
    if hcoll and hasattr(ls, "select_by_collection"):
        ls.select_by_collection = True
        ls.collection = hcoll
        ls.collection_negation = "EXCLUSIVE"     # everything EXCEPT the human
    ls.select_silhouette = True
    ls.select_border = True
    ls.select_crease = True
    ls.select_contour = False
    px_per_pt = (res_x / panel_width_in) / 72.0
    ls.linestyle.thickness = max(1.0, pt_at_final * px_per_pt)
    ls.linestyle.color = hex2rgba(PAL["ink"])[:3]

    # second lineset: the human, outer contour only, no creases -> no face
    if hcoll and hasattr(ls, "select_by_collection"):
        hs = fs.linesets.new("human_silhouette")
        if hs.linestyle is None:
            hs.linestyle = bpy.data.linestyles.new("LS_human")
        hs.select_by_collection = True
        hs.collection = hcoll
        hs.collection_negation = "INCLUSIVE"
        hs.select_silhouette = True
        hs.select_border = True
        hs.select_crease = False
        hs.select_contour = False
        hs.linestyle.thickness = ls.linestyle.thickness
        hs.linestyle.color = hex2rgba(PAL["ink"])[:3]
    print(f"  freestyle thickness = {ls.linestyle.thickness:.2f} px "
          f"({pt_at_final} pt at {panel_width_in}in / {res_x}px)")
    return ls


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--dog", default="mujoco",
                    choices=list(DOGS) + ["proc"])
    ap.add_argument("--res", type=int, default=2000)
    ap.add_argument("--face", action="store_true")
    ap.add_argument("--volume", action="store_true")
    ap.add_argument("--style", default="render", choices=["render", "flat"],
                    help="render = shaded 3D with soft shadows; flat = line art")
    ap.add_argument("--lines", action="store_true", default=None,
                    help="draw Freestyle outlines (default: on for flat, off for render)")
    ap.add_argument("--no-lines", dest="lines", action="store_false")
    ap.add_argument("--engine", default=None, choices=["EEVEE", "CYCLES"])
    ap.add_argument("--samples", type=int, default=180)
    ap.add_argument("--fov-opacity", type=float, default=None)
    ap.add_argument("--head-pitch", type=float, default=None)
    ap.add_argument("--fov", action="store_true",
                    help="draw camera view volumes (off by default)")
    ap.add_argument("--no-fov", action="store_true")
    ap.add_argument("--harness", action="store_true")
    ap.add_argument("--human", default="smpl", choices=["smpl", "quaternius"])
    ap.add_argument("--hheading", type=float, default=125.0)
    ap.add_argument("--proc-human", action="store_true")
    ap.add_argument("--hframe", type=int, default=1)
    ap.add_argument("--out", default="panelA")
    args = ap.parse_args(sys.argv[1:])

    global FOV_DENSITY, SHOW_FOV, HEAD_PITCH
    if args.head_pitch is not None:
        HEAD_PITCH = args.head_pitch
    SHOW_FOV = args.fov and not args.no_fov
    if args.fov_opacity is not None:
        FOV_DENSITY = args.fov_opacity
    style3d = args.style == "render"
    if args.lines is None:
        args.lines = not style3d
    if args.engine is None:
        args.engine = "CYCLES" if style3d else "EEVEE"

    rig.reset()
    M = build_materials_pbr() if style3d else build_materials()

    rig.build_room(M)
    for o in [x for x in bpy.data.objects
              if x.name.startswith("gx") or x.name.startswith("gy")]:
        bpy.data.objects.remove(o, do_unlink=True)
    rig.build_truss(M)
    pts = build_optics(M, face_cam=args.face)
    rig.build_rack(M)
    rig.build_sync_path(M, pts)
    if args.volume:
        rig.build_capture_volume(M)
    if args.dog == "proc":
        rig.build_dog(M)
    else:
        dog = import_dog(args.dog, M)
        if args.harness:
            add_dog_wearables(dog, M)
    if args.proc_human:
        rig.build_human(M)
    elif args.human == "smpl":
        import_human_smpl(M, heading=args.hheading)
    else:
        import_human(M, frame=args.hframe)

    setup_view(args.res)
    if style3d:
        setup_lighting_3d()
    if args.lines:
        # in 3D style the line is a light accent for definition, not the drawing
        setup_freestyle(args.res, pt_at_final=0.22 if style3d else LINE_PT)

    scn = bpy.context.scene
    if args.engine == "CYCLES":
        scn.render.engine = "CYCLES"
        on_gpu = enable_metal_gpu()
        scn.cycles.device = "GPU" if on_gpu else "CPU"
        scn.cycles.samples = args.samples
        scn.cycles.use_denoising = True
        scn.cycles.max_bounces = 12
        scn.cycles.diffuse_bounces = 3
        scn.cycles.transmission_bounces = 12
        # Each view volume costs TWO transparent crossings, and eight of them overlap
        # in the middle of the room. Cycles terminates rays that exceed
        # transparent_max_bounces (default 8) as BLACK, which turned the whole capture
        # volume into a dark mass. This is the fix, not lowering the opacity.
        scn.cycles.transparent_max_bounces = 64
        scn.cycles.volume_bounces = 2
        if hasattr(scn.cycles, "volume_step_rate"):
            scn.cycles.volume_step_rate = 0.5
    else:
        scn.render.engine = "BLENDER_EEVEE"
        if hasattr(scn.eevee, "taa_render_samples"):
            scn.eevee.taa_render_samples = 64
        for flag, val in (("use_gtao", True), ("use_raytracing", True),
                          ("use_shadows", True)):
            if hasattr(scn.eevee, flag):
                setattr(scn.eevee, flag, val)

    if style3d:
        # AgX rolls off the specular highlights on the camera housings; Standard
        # clips them to white and the render starts looking like flat vector art
        scn.view_settings.view_transform = "AgX"
        scn.view_settings.look = "AgX - Medium High Contrast"

    out = os.path.join(HERE, f"{args.out}_{args.dog}.png")
    scn.render.filepath = out
    t0 = __import__("time").time()
    bpy.ops.render.render(write_still=True)
    print(f"WROTE {out} ({os.path.getsize(out)} bytes) "
          f"[{args.engine}, {__import__('time').time() - t0:.1f}s]")


if __name__ == "__main__":
    main()
