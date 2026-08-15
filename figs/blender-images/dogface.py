"""
Sub-panel: front view of the dog's face with facial keypoints marked.

Built from the D-SMAL model file rather than the exported OBJ, because the .pkl
carries the skinning WEIGHTS and the joint positions. That matters twice over: the
happy-face pose is a real single-joint LBS rotation of the jaw and ear joints
(j32, j33, j34 — all children of the head joint j16) rather than a guessed region
deformation, and the keypoints can be snapped to anatomy on the rest mesh and then
read off the POSED mesh, so they track the pose instead of drifting.

Note the .pkl v_template is Z-up (X forward, Y lateral, Z up). The exported OBJ is
Y-up. Building from the .pkl avoids the axis correction entirely.

Run: ./bpyenv/bin/python dogface.py [--jaw 16] [--ears 12] [--smile 1.0]
                                    [--res 1800] [--samples 400] [--no-keypoints]
"""
import argparse
import math
import os
import pickle
import sys
import warnings

warnings.filterwarnings("ignore")
import numpy as np

import bpy
from mathutils import Vector, Matrix

import rig

HERE = os.path.dirname(os.path.abspath(__file__))
PKL = os.path.join(HERE, "assets/dsmal/my_smpl_39dogsnorm_newv3_dog.pkl")

J_HEAD, J_JAW, J_EAR_L, J_EAR_R = 16, 32, 33, 34

# Facial keypoints as anatomical targets in the model's own frame. Each is snapped to
# the nearest REST-mesh vertex, then read from the posed mesh. Grouped so the render
# can colour-code them: muzzle / eyes / ears / cranium.
KEYPOINTS = [
    # muzzle
    ("dorsum0",       (1.2309, 0.0000, 0.1174), "muzzle"),   # v1853
    ("dorsum1",       (1.2605, 0.0000, 0.0904), "muzzle"),   # v1004
    ("nose_tip",      (1.3191, 0.0000, 0.0209), "muzzle"),   # v1846
    ("philtrum",      (1.2545, 0.0000, -0.0455), "muzzle"),   # v919
    ("chin",          (1.2232, 0.0000, -0.0838), "muzzle"),   # v1816
    ("nostril_l",     (1.2892, 0.0497, 0.0067), "muzzle"),   # v1891
    ("nostril_r",     (1.2892, -0.0497, 0.0067), "muzzle"),   # v1891
    ("nose_wing_l",   (1.2531, 0.0724, -0.0144), "muzzle"),   # v1057
    ("nose_wing_r",   (1.2531, -0.0724, -0.0144), "muzzle"),   # v1057
    ("lip_corner_l",  (1.0504, 0.0822, -0.0138), "muzzle"),   # v160
    ("lip_corner_r",  (1.0504, -0.0822, -0.0138), "muzzle"),   # v160
    ("lip_upper0_l",  (1.1928, 0.0575, -0.0570), "muzzle"),   # v748
    ("lip_upper0_r",  (1.1928, -0.0575, -0.0570), "muzzle"),   # v748
    ("lip_upper1_l",  (1.1715, 0.0644, -0.0461), "muzzle"),   # v762
    ("lip_upper1_r",  (1.1715, -0.0644, -0.0461), "muzzle"),   # v762
    ("lip_upper2_l",  (1.1367, 0.0751, -0.0339), "muzzle"),   # v909
    ("lip_upper2_r",  (1.1367, -0.0751, -0.0339), "muzzle"),   # v909
    ("lip_upper3_l",  (1.0913, 0.0835, -0.0180), "muzzle"),   # v162
    ("lip_upper3_r",  (1.0913, -0.0835, -0.0180), "muzzle"),   # v162
    ("lip_upper4_l",  (1.0619, 0.0962, -0.0008), "muzzle"),   # v159
    ("lip_upper4_r",  (1.0619, -0.0962, -0.0008), "muzzle"),   # v159
    ("lip_lower0_l",  (1.2086, 0.0433, -0.0704), "muzzle"),   # v901
    ("lip_lower0_r",  (1.2086, -0.0433, -0.0704), "muzzle"),   # v901
    ("lip_lower1_l",  (1.1620, 0.0545, -0.0695), "muzzle"),   # v252
    ("lip_lower1_r",  (1.1620, -0.0545, -0.0695), "muzzle"),   # v252
    ("lip_lower2_l",  (1.1346, 0.0468, -0.0629), "muzzle"),   # v250
    ("lip_lower2_r",  (1.1346, -0.0468, -0.0629), "muzzle"),   # v250
    # eye
    ("eye0_l",        (1.1647, 0.1108, 0.1638), "eye"),   # v648
    ("eye0_r",        (1.1647, -0.1108, 0.1638), "eye"),   # v648
    ("eye1_l",        (1.1594, 0.1068, 0.1456), "eye"),   # v1162
    ("eye1_r",        (1.1594, -0.1068, 0.1456), "eye"),   # v1162
    ("eye2_l",        (1.1680, 0.0908, 0.1318), "eye"),   # v1187
    ("eye2_r",        (1.1680, -0.0908, 0.1318), "eye"),   # v1187
    ("eye3_l",        (1.1801, 0.0619, 0.1308), "eye"),   # v1227
    ("eye3_r",        (1.1801, -0.0619, 0.1308), "eye"),   # v1227
    ("eye4_l",        (1.1899, 0.0551, 0.1392), "eye"),   # v1027
    ("eye4_r",        (1.1899, -0.0551, 0.1392), "eye"),   # v1027
    ("eye5_l",        (1.1915, 0.0659, 0.1565), "eye"),   # v1022
    ("eye5_r",        (1.1915, -0.0659, 0.1565), "eye"),   # v1022
    ("eye6_l",        (1.1882, 0.0837, 0.1699), "eye"),   # v720
    ("eye6_r",        (1.1882, -0.0837, 0.1699), "eye"),   # v720
    ("eye7_l",        (1.1734, 0.1053, 0.1735), "eye"),   # v716
    ("eye7_r",        (1.1734, -0.1053, 0.1735), "eye"),   # v716
    # cranium
    ("sagittal0",     (1.0468, 0.0000, 0.3095), "cranium"),   # v1829
    ("sagittal1",     (1.1011, 0.0000, 0.2900), "cranium"),   # v1830
    ("stop",          (1.2138, 0.0000, 0.1395), "cranium"),   # v991
    ("occiput",       (0.9841, 0.0000, 0.3083), "cranium"),   # v1837
    ("brow_l",        (1.1817, 0.0566, 0.2234), "cranium"),   # v995
    ("brow_r",        (1.1817, -0.0566, 0.2234), "cranium"),   # v995
    ("temple_l",      (1.0927, 0.1265, 0.2223), "cranium"),   # v1052
    ("temple_r",      (1.0927, -0.1265, 0.2223), "cranium"),   # v1052
    ("supraorbital_l", (1.1416, 0.1237, 0.1832), "cranium"),   # v998
    ("supraorbital_r", (1.1416, -0.1237, 0.1832), "cranium"),   # v998
    ("zygoma_l",      (1.1066, 0.1341, 0.1328), "cranium"),   # v978
    ("zygoma_r",      (1.1066, -0.1341, 0.1328), "cranium"),   # v978
    # ear
    ("ear0_l",        (1.0188, 0.1769, 0.1721), "ear"),   # v1793
    ("ear0_r",        (1.0188, -0.1769, 0.1721), "ear"),   # v1793
    ("ear1_l",        (1.0452, 0.2728, 0.2825), "ear"),   # v201
    ("ear1_r",        (1.0452, -0.2728, 0.2825), "ear"),   # v201
    ("ear2_l",        (1.0591, 0.2750, 0.3141), "ear"),   # v1240
    ("ear2_r",        (1.0591, -0.2750, 0.3141), "ear"),   # v1240
    ("ear3_l",        (1.0871, 0.2273, 0.3496), "ear"),   # v368
    ("ear3_r",        (1.0871, -0.2273, 0.3496), "ear"),   # v368
    ("ear4_l",        (1.0879, 0.1913, 0.3348), "ear"),   # v547
    ("ear4_r",        (1.0879, -0.1913, 0.3348), "ear"),   # v547
    ("ear5_l",        (1.0742, 0.1599, 0.3083), "ear"),   # v523
    ("ear5_r",        (1.0742, -0.1599, 0.3083), "ear"),   # v523
    ("ear6_l",        (1.0300, 0.1123, 0.2799), "ear"),   # v496
    ("ear6_r",        (1.0300, -0.1123, 0.2799), "ear"),   # v496
    ("ear7_l",        (0.9978, 0.1145, 0.2735), "ear"),   # v489
    ("ear7_r",        (0.9978, -0.1145, 0.2735), "ear"),   # v489
    ("ear_base_ros_l", (1.0795, 0.1414, 0.1947), "ear"),   # v876
    ("ear_base_ros_r", (1.0795, -0.1414, 0.1947), "ear"),   # v876
    ("ear_base_cau_l", (0.9682, 0.1323, 0.2606), "ear"),   # v488
    ("ear_base_cau_r", (0.9682, -0.1323, 0.2606), "ear"),   # v488
    # jaw
    ("throat",        (0.9175, 0.0000, -0.1507), "jaw"),   # v6
    ("jaw_angle_l",   (1.0723, 0.1252, 0.0466), "jaw"),   # v596
    ("jaw_angle_r",   (1.0723, -0.1252, 0.0466), "jaw"),   # v596
    ("cheek_l",       (1.1239, 0.1229, 0.1050), "jaw"),   # v600
    ("cheek_r",       (1.1239, -0.1229, 0.1050), "jaw"),   # v600
    ("masseter_l",    (1.0590, 0.1421, 0.0778), "jaw"),   # v205
    ("masseter_r",    (1.0590, -0.1421, 0.0778), "jaw"),   # v205
    ("mandible_l",    (1.1950, 0.0368, -0.0843), "jaw"),   # v754
    ("mandible_r",    (1.1950, -0.0368, -0.0843), "jaw"),   # v754
]

KP_COLOR = {
    "muzzle":  "#E8482F",
    "eye":     "#FFC219",
    "ear":     "#2FC4C0",
    "cranium": "#B478E8",
    "jaw":     "#5BD65B",
}


# ---------------------------------------------------------------------------
def load_dsmal(betas=None):
    """Unpickle the chumpy-format model without installing chumpy, by stubbing its
    Ch class as an ndarray subclass that captures the pickled state.

    `betas` walks the model's 78-dimensional shape space away from the mean. The mean
    is an average over 39 dogs of mixed breed, so it is a shape no real dog has, which
    is why it reads as a generic ungulate rather than as a dog. Scale: one unit of
    beta[0] moves a vertex ~0.09 in model units against a 1.95-long body, so useful
    values are roughly +/-3. Joints are re-regressed from the deformed template, so
    the jaw and ear rotations stay anatomically seated.

    CAPTION CONSEQUENCE: with betas set this is no longer "the mean shape", which is
    the claim FIGURE-NOTES verified bit-exact against v_template. "A shape drawn from
    the shape space of a canine parametric shape model (D-SMAL, Rueegg et al. 2023)"
    is still exact, but it is a weaker statement. Default stays the mean."""
    class _Ch(np.ndarray):
        def __new__(cls, *a, **k):
            return np.asarray(a[0] if a else 0).view(cls)

        def __setstate__(self, st):
            x = st.get("x") if isinstance(st, dict) else None
            self._x = np.asarray(x) if x is not None else None

    class _Mod:
        Ch = _Ch

        def __getattr__(self, n):
            return _Ch

    sys.modules["chumpy"] = _Mod()
    sys.modules["chumpy.ch"] = _Mod()
    d = pickle.load(open(PKL, "rb"), encoding="latin1")

    def dense(v):
        if hasattr(v, "toarray"):
            return np.asarray(v.toarray(), dtype=np.float64)
        if hasattr(v, "_x") and getattr(v, "_x", None) is not None:
            return np.asarray(v._x, dtype=np.float64)
        return np.asarray(v, dtype=np.float64)

    V = dense(d["v_template"])
    F = np.asarray(d["f"], dtype=np.int64)
    W = dense(d["weights"])
    if betas is not None and len(betas):
        S = np.asarray(d["shapedirs"], dtype=np.float64)   # (nv, 3, 78)
        b = np.zeros(S.shape[2])
        b[:len(betas)] = np.asarray(betas, dtype=np.float64)[:S.shape[2]]
        V = V + S @ b
        nz = {i: round(float(x), 2) for i, x in enumerate(b) if abs(x) > 1e-9}
        print(f"  shape space: betas {nz}")
    Jm = dense(d["J_regressor"])
    joints = (Jm @ V) if Jm.shape[1] == V.shape[0] else (Jm.T @ V)
    return V, F, W, joints


def rot_y(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[c, 0.0, s], [0.0, 1.0, 0.0], [-s, 0.0, c]])


def rot_x(deg):
    a = math.radians(deg)
    c, s = math.cos(a), math.sin(a)
    return np.array([[1.0, 0.0, 0.0], [0.0, c, -s], [0.0, s, c]])


def joint_rotate(V, W, joint, pivot, R):
    """Weighted single-joint rotation: v += w_j * (R(v - p) + p - v).

    A leaf joint like the jaw or an ear has no children, so this is exact LBS for
    that joint rather than an approximation."""
    w = W[:, joint][:, None]
    d = V - pivot[None, :]
    return V + w * ((d @ R.T) + pivot[None, :] - V)


def smile(V, amount, corners=((1.170, 0.078, -0.018), (1.170, -0.078, -0.018)),
          radius=0.085):
    """Draw the lip corners back and up — the relaxed open-mouth 'play face'.

    Falls off smoothly with distance from each corner so the muzzle deforms as a
    whole instead of spiking two vertices."""
    if abs(amount) < 1e-6:
        return V
    V = V.copy()
    for cx, cy, cz in corners:
        c = np.array([cx, cy, cz])
        dist = np.linalg.norm(V - c[None, :], axis=1)
        u = np.clip(1.0 - dist / radius, 0.0, 1.0)
        w = (u * u * (3.0 - 2.0 * u))[:, None]
        # back along -X, up along +Z, and slightly outward in Y
        delta = np.array([-0.020, 0.0, 0.013]) * amount
        lateral = np.sign(cy) * 0.008 * amount
        V = V + w * (delta[None, :] + np.array([0.0, lateral, 0.0])[None, :])
    return V


# ---------------------------------------------------------------------------
def trim_to_head(V, F, W, keep=(15, 16, 32, 33, 34), thresh=0.5):
    """Keep only the head, jaw, ears and a neck stub. The shoulder and chest were
    intruding into the lower-left of a panel that is supposed to be a face."""
    vmask = W[:, list(keep)].sum(1) > thresh
    fmask = vmask[F].all(axis=1)
    Fk = F[fmask]
    old = np.unique(Fk)
    remap = -np.ones(len(V), dtype=np.int64)
    remap[old] = np.arange(len(old))
    return V[old], remap[Fk], old


def vertex_normals(V, F):
    """Area-weighted vertex normals. Needed to seat the keypoint markers: offsetting
    them radially from a guessed head centre works on the skull but fails on the thin
    ear plates, where the radial direction is nearly tangent to the surface."""
    N = np.zeros_like(V)
    v0, v1, v2 = V[F[:, 0]], V[F[:, 1]], V[F[:, 2]]
    fn = np.cross(v1 - v0, v2 - v0)
    for k in range(3):
        np.add.at(N, F[:, k], fn)
    return N / np.maximum(np.linalg.norm(N, axis=1, keepdims=True), 1e-12)


def _value_noise(P, octaves=3, lacunarity=2.03, gain=0.5):
    """Deterministic aperiodic value noise, smoothstep-interpolated over the integer
    lattice. Pure numpy, no seed state, same result every run.

    Written to replace a product-of-sines term that was secretly a checkerboard. The
    lacunarity is deliberately irrational-ish (2.03, not 2.0) so octaves do not
    re-align into a visible grid of their own.
    """
    P = np.asarray(P, dtype=np.float64)
    total = np.zeros(len(P))
    amp, norm = 1.0, 0.0
    for o in range(octaves):
        Q = P * (lacunarity ** o) + o * 17.13
        i = np.floor(Q)
        f = Q - i
        w = f * f * (3.0 - 2.0 * f)                       # smoothstep
        acc = np.zeros(len(P))
        for dx in (0, 1):
            for dy in (0, 1):
                for dz in (0, 1):
                    c = i + np.array([dx, dy, dz])
                    h = np.sin(c @ np.array([127.1, 311.7, 74.7])) * 43758.5453
                    h = h - np.floor(h)                   # hash -> [0,1)
                    wx = w[:, 0] if dx else 1.0 - w[:, 0]
                    wy = w[:, 1] if dy else 1.0 - w[:, 1]
                    wz = w[:, 2] if dz else 1.0 - w[:, 2]
                    acc += h * wx * wy * wz
        total += amp * (acc * 2.0 - 1.0)
        norm += amp
        amp *= gain
    return total / max(norm, 1e-9)


def coat_colors(V):
    """Per-vertex coat colour, computed directly from vertex position.

    Replaces a procedural node graph that produced a flat grey: the Texture
    Coordinate -> SeparateXYZ -> MapRange -> ColorRamp chain never varied, so the
    factor sat mid-ramp everywhere and both the tonal variation and the dark muzzle
    mask were invisible. Computing it here is exact and inspectable, and the anatomy
    is available (x = snout axis, |y| = lateral, z = height)."""
    x, y, z = V[:, 0], np.abs(V[:, 1]), V[:, 2]
    fawn = np.array([0.700, 0.505, 0.310])
    dark = np.array([0.140, 0.100, 0.082])
    cream = np.array([0.870, 0.800, 0.700])

    # dark muzzle mask, ramping in over the front of the snout
    mz = np.clip((x - 1.150) / 0.135, 0.0, 1.0) ** 1.4
    # pale chin / throat underside
    ch = np.clip((-z - 0.010) / 0.070, 0.0, 1.0) * np.clip((x - 1.10) / 0.12, 0, 1)
    # faint brow marks above the eyes, a real feature in many breeds
    brow = np.exp(-(((x - 1.135) / 0.045) ** 2 + ((y - 0.098) / 0.040) ** 2
                    + ((z - 0.180) / 0.030) ** 2))
    # Fine tonal break-up. This was a product of three sinusoids, which is separable —
    # i.e. a 3D CHECKERBOARD. At ~1 cm vertex spacing against a 0.10 period it aliased
    # into something that passed for noise, so the vertex-colour version never showed
    # it. Baked to a 2048 texture it resolves into an obvious regular grid across the
    # whole face. Value noise is aperiodic and survives any sampling rate.
    n = 0.055 * _value_noise(np.stack([x, y, z], 1) * 46.0, octaves=3)

    col = fawn[None, :] * (1.0 + n[:, None])
    col = col * (1.0 - mz[:, None]) + dark[None, :] * mz[:, None]
    col = col * (1.0 - 0.55 * ch[:, None]) + cream[None, :] * (0.55 * ch[:, None])
    col = col + 0.14 * brow[:, None] * (cream - fawn)[None, :]
    col = np.clip(col, 0.0, 1.0)
    # The values above are authored as sRGB display values, but Blender consumes a
    # FLOAT_COLOR attribute as LINEAR scene-referred data. Without this conversion the
    # dark muzzle mask (0.14 sRGB) arrives as 0.14 linear ~= 0.40 sRGB and renders as
    # mid-brown, which is why the mask looked almost absent.
    return np.where(col <= 0.04045, col / 12.92, ((col + 0.055) / 1.055) ** 2.4)


def mk_mesh(name, V, F, colors=None):
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in V], [], [tuple(f) for f in F])
    me.validate()
    me.update()
    if colors is not None:
        att = me.color_attributes.new(name="Col", type="FLOAT_COLOR",
                                      domain="POINT")
        for i, c in enumerate(colors):
            att.data[i].color = (float(c[0]), float(c[1]), float(c[2]), 1.0)
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)
    for p in me.polygons:
        p.use_smooth = True
    return ob


def fur_material(name="fur"):
    """Short-fur look: a fine noise bump for surface texture, a coarser noise for
    tonal variation, a darker muzzle driven by position, and a little subsurface so
    the form reads round rather than plastic."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])

    coord = nt.nodes.new("ShaderNodeTexCoord")

    cattr = nt.nodes.new("ShaderNodeAttribute")
    cattr.attribute_name = "Col"
    nt.links.new(cattr.outputs["Color"], bsdf.inputs["Base Color"])

    # fine fur bump
    n_fur = nt.nodes.new("ShaderNodeTexNoise")
    n_fur.inputs["Scale"].default_value = 620.0
    n_fur.inputs["Detail"].default_value = 8.0
    n_fur.inputs["Roughness"].default_value = 0.7
    nt.links.new(coord.outputs["Object"], n_fur.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.48
    bump.inputs["Distance"].default_value = 0.0035
    nt.links.new(n_fur.outputs["Fac"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], bsdf.inputs["Normal"])

    bsdf.inputs["Roughness"].default_value = 0.72
    for k, v in (("Subsurface Weight", 0.12), ("Subsurface Radius", None),
                 ("Sheen Weight", 0.28)):
        if k in bsdf.inputs and v is not None:
            bsdf.inputs[k].default_value = v
    if "Subsurface Radius" in bsdf.inputs:
        bsdf.inputs["Subsurface Radius"].default_value = (0.012, 0.005, 0.003)
    return m


def _fur_bump(nt, strength=0.48):
    """The procedural fur bump, shared by the fur and clay materials. Evaluated per
    shading point, so it is resolution-independent and was never the source of the
    softness §3b diagnosed."""
    coord = nt.nodes.new("ShaderNodeTexCoord")
    n_fur = nt.nodes.new("ShaderNodeTexNoise")
    n_fur.inputs["Scale"].default_value = 620.0
    n_fur.inputs["Detail"].default_value = 8.0
    n_fur.inputs["Roughness"].default_value = 0.7
    nt.links.new(coord.outputs["Object"], n_fur.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = strength
    bump.inputs["Distance"].default_value = 0.0035
    nt.links.new(n_fur.outputs["Fac"], bump.inputs["Height"])
    return bump


def normal_material(name="normalviz", bump=0.0, gamma=2.2, style="rgb"):
    """Shade the head by its surface normal instead of the coat colour attribute.

    Why this is not merely a style choice: the coat is a per-vertex FLOAT_COLOR, so
    it can never carry more detail than the mesh carries, and it encodes nothing the
    panel is actually claiming. The normal is the surface itself, so it shows the
    geometry the keypoints are seated on and it is resolution-independent.

    Normals are transformed WORLD -> CAMERA before display. Camera space makes the
    mapping view-consistent and symmetric about the lens axis; world space ties the
    colours to the scene axes, so the same face renders differently the moment the
    camera moves, and left/right symmetry is lost.

    Two traps:

    - Normals live in [-1,1] and colour lives in [0,1], so they need the *0.5 +0.5
      remap. Without it everything facing away from +axis clamps to black.
    - The scene renders with the Standard view transform, which sRGB-encodes on the
      way out, so a linear 0.5 displays as 0.73 and the whole head washes out.
      The Gamma node pre-linearises (n^2.2 ~ sRGB decode) so the DISPLAYED pixel
      value is the normal component. Pass --normal-gamma 1.0 to see the pale version.

    KEEP THIS AS A DIAGNOSTIC, NOT A PANEL MODE. Rendered and rejected on August 13,
    2026. Cycles' CAMERA space here is not the Y-up/-Z-forward convention that gives
    the familiar blue-dominant normal map; the result is green-dominant and spans the
    whole hue circle. That is the fatal part, and it is structural rather than a
    tuning problem: this panel's 41 keypoint colours ARE its legend, so a surface
    that uses every hue leaves no hue for them. Red keypoints vanish on the magenta
    ear, green ones on the green skull, teal on cyan. No gamma fixes that. Use
    --shade clay, which was the right answer to the same question.
    """
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    emit = nt.nodes.new("ShaderNodeEmission")
    emit.inputs["Strength"].default_value = 1.0
    nt.links.new(emit.outputs[0], out.inputs["Surface"])

    geo = nt.nodes.new("ShaderNodeNewGeometry")
    src = geo.outputs["Normal"]
    if bump > 0:
        src = _fur_bump(nt, bump).outputs["Normal"]

    xf = nt.nodes.new("ShaderNodeVectorTransform")
    xf.vector_type = "NORMAL"
    xf.convert_from = "WORLD"
    xf.convert_to = "CAMERA"
    nt.links.new(src, xf.inputs[0])

    mul = nt.nodes.new("ShaderNodeVectorMath")
    mul.operation = "MULTIPLY"
    mul.inputs[1].default_value = (0.5, 0.5, 0.5)
    nt.links.new(xf.outputs[0], mul.inputs[0])
    add = nt.nodes.new("ShaderNodeVectorMath")
    add.operation = "ADD"
    add.inputs[1].default_value = (0.5, 0.5, 0.5)
    nt.links.new(mul.outputs[0], add.inputs[0])

    if style == "rgb":
        tail = add.outputs[0]
        if gamma and abs(gamma - 1.0) > 1e-6:
            g = nt.nodes.new("ShaderNodeGamma")
            g.inputs["Gamma"].default_value = gamma
            nt.links.new(tail, g.inputs["Color"])
            tail = g.outputs["Color"]
        nt.links.new(tail, emit.inputs["Color"])
        return m

    # mono / duotone: keep the normal as the quantity being shown, but spend only
    # LIGHTNESS on it instead of the whole hue circle. The facing term (camera-space
    # normal Z) is what actually describes the form; the x and y channels are what make
    # an RGB normal map garish, and they are also what collides with the marker colours.
    # This is the version that lets a normals panel keep a colour-coded legend.
    # Facing = N.V, taken as an explicit dot product of the shading normal with the
    # incoming ray. NOT a component of the camera-space vector: this build's CAMERA
    # space is not the Y-up/-Z-forward convention (the rgb render comes out green-
    # dominant, not blue-dominant), so picking an axis by assumption gives a flat head.
    # The dot product has no convention to get wrong.
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    nt.links.new(src, dot.inputs[0])
    nt.links.new(geo.outputs["Incoming"], dot.inputs[1])
    absn = nt.nodes.new("ShaderNodeMath")
    absn.operation = "ABSOLUTE"
    nt.links.new(dot.outputs["Value"], absn.inputs[0])

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "EASE"
    e0, e1 = ramp.color_ramp.elements[0], ramp.color_ramp.elements[1]
    if style == "mono":
        e0.position, e0.color = 0.02, (0.022, 0.024, 0.030, 1.0)
        e1.position, e1.color = 0.92, (0.910, 0.915, 0.925, 1.0)
    else:                                    # duotone: cool shadow, warm light
        e0.position, e0.color = 0.02, (0.016, 0.034, 0.078, 1.0)
        e1.position, e1.color = 0.92, (0.970, 0.935, 0.865, 1.0)
    nt.links.new(absn.outputs["Value"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], emit.inputs["Color"])
    return m


def marker_material(name, hexcol, achromatic=False, rim=0.55):
    """Keypoint marker. `achromatic` gives a near-white bead with a dark Fresnel rim.

    The rim is the point. Against an RGB normal render the surface uses every hue at
    full saturation, so no marker colour is safe — a flat white bead disappears into
    the pale facing highlights just as a red one disappears into the magenta flank. A
    dark edge that tracks the viewing angle separates the bead from ANY background,
    because it is a local contrast boundary rather than a colour difference.
    """
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs["Surface"])

    hx = hexcol.lstrip("#")
    s = [int(hx[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
    lin = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in s]
    if achromatic:
        y = 0.2126 * lin[0] + 0.7152 * lin[1] + 0.0722 * lin[2]
        # spread the five groups over a lightness ladder instead of a hue wheel
        y = 0.16 + 0.80 * y ** 0.75
        lin = [y, y, y]

    lw = nt.nodes.new("ShaderNodeLayerWeight")
    lw.inputs["Blend"].default_value = 0.35
    mix = nt.nodes.new("ShaderNodeMixRGB")
    mix.inputs["Color1"].default_value = (lin[0], lin[1], lin[2], 1.0)
    mix.inputs["Color2"].default_value = (0.004, 0.004, 0.005, 1.0)
    scale = nt.nodes.new("ShaderNodeMath")
    scale.operation = "MULTIPLY"
    scale.inputs[1].default_value = rim
    nt.links.new(lw.outputs["Facing"], scale.inputs[0])
    nt.links.new(scale.outputs["Value"], mix.inputs["Fac"])
    nt.links.new(mix.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.30
    if "Emission Color" in b.inputs:
        b.inputs["Emission Color"].default_value = (lin[0], lin[1], lin[2], 1.0)
        b.inputs["Emission Strength"].default_value = 0.20
    return m


def uv_material(image, name="coat_uv", bump=0.40):
    """Skin shader reading the baked coat map through UV instead of a vertex colour."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs["Surface"])
    uvn = nt.nodes.new("ShaderNodeUVMap")
    uvn.uv_map = "UVMap"
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = image
    tex.interpolation = "Cubic"
    tex.extension = "EXTEND"
    nt.links.new(uvn.outputs["UV"], tex.inputs["Vector"])
    nt.links.new(tex.outputs["Color"], b.inputs["Base Color"])
    b.inputs["Roughness"].default_value = 0.70
    if bump > 0:
        nt.links.new(_fur_bump(nt, bump).outputs["Normal"], b.inputs["Normal"])
    for k, v in (("Subsurface Weight", 0.11), ("Sheen Weight", 0.25)):
        if k in b.inputs:
            b.inputs[k].default_value = v
    if "Subsurface Radius" in b.inputs:
        b.inputs["Subsurface Radius"].default_value = (0.012, 0.005, 0.003)
    return m


def clay_material(name="clay", hexcol="#C6C2BB", bump=0.48):
    """Neutral matte surface: the form and the fur bump survive, the coat pattern
    does not. Keeps the lighting rig doing the work of describing shape, and gives
    the saturated keypoint colours a desaturated ground to read against."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    bsdf = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(bsdf.outputs[0], out.inputs["Surface"])

    h = hexcol.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    bsdf.inputs["Base Color"].default_value = (lin(srgb[0]), lin(srgb[1]),
                                               lin(srgb[2]), 1.0)
    bsdf.inputs["Roughness"].default_value = 0.68
    if bump > 0:
        nt.links.new(_fur_bump(nt, bump).outputs["Normal"], bsdf.inputs["Normal"])
    for k, v in (("Subsurface Weight", 0.10), ("Sheen Weight", 0.22)):
        if k in bsdf.inputs:
            bsdf.inputs[k].default_value = v
    if "Subsurface Radius" in bsdf.inputs:
        bsdf.inputs["Subsurface Radius"].default_value = (0.012, 0.008, 0.006)
    return m


def hair_material(name="fur_strands", melanin=0.17, redness=0.55, rough=0.30):
    """Principled Hair BSDF (Chiang). Fur colour comes from melanin concentration
    rather than an RGB base, which is why strands stay plausible under any light —
    an albedo-coloured hair reads as coloured thread.

    TRAP, and an expensive one: the node's `parametrization` defaults to 'COLOR', and
    under that mode the Melanin / Melanin Redness / Tint sockets are **disabled**.
    Assigning them still succeeds — no error, no warning — and is then ignored, so the
    coat renders the default Color of (0.018, 0.006, 0.002), a near-black brown. The
    first fur renders came out as a chocolate bear at melanin 0.17 for exactly this
    reason. Set `parametrization` FIRST, then assign. Socket `.enabled` is the tell.
    """
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    h = nt.nodes.new("ShaderNodeBsdfHairPrincipled")
    h.parametrization = "MELANIN"
    for k, v in (("Melanin", melanin), ("Melanin Redness", redness),
                 ("Roughness", rough), ("Radial Roughness", 0.28),
                 ("Random Color", 0.14), ("Random Roughness", 0.12),
                 ("Coat", 0.25)):
        if k in h.inputs and h.inputs[k].enabled:
            h.inputs[k].default_value = v
        elif k in h.inputs:
            print(f"  WARNING: hair socket {k!r} is disabled under "
                  f"parametrization={h.parametrization}, not set")
    nt.links.new(h.outputs[0], out.inputs["Surface"])
    return m


def add_fur(ob, mat_index, length=0.0165, count=9000, children=26, seed=1):
    """Real hair geometry, not a bump map. This is the single biggest realism lever
    available: a bump-shaded surface always reads as painted clay at the silhouette,
    because the silhouette is where a coat actually shows.

    Emission is masked by a 'furless' vertex group so the rhinarium stays bare — a
    furry nose is the fastest way to lose the read.

    Cost note: children are generated at render time, so `count` is the simulated
    parent count and the visible strand count is count * children.
    """
    ob.modifiers.new("fur", "PARTICLE_SYSTEM")
    psys = ob.particle_systems[-1]
    psys.seed = seed          # seed lives on the SYSTEM, not on the settings
    st = psys.settings
    st.type = "HAIR"
    st.count = count
    st.hair_length = length
    st.hair_step = 4
    st.use_advanced_hair = True
    st.use_hair_bspline = True
    st.child_type = "INTERPOLATED"
    st.child_percent = children
    st.rendered_child_count = children
    st.material = mat_index
    # Optional across builds — assign defensively rather than enumerating, the same
    # rule the Cycles/Metal notes in FIGURE-NOTES 5 arrive at for enums.
    for k, v in (("root_radius", 0.55), ("tip_radius", 0.0),
                 ("radius_scale", 0.0016), ("child_radius", 0.010),
                 ("clump_factor", 0.32), ("clump_shape", 0.42),
                 ("roughness_1", 0.014), ("roughness_1_size", 0.006),
                 ("roughness_endpoint", 0.010), ("roughness_end_shape", 0.7)):
        if hasattr(st, k):
            setattr(st, k, v)
    # Also on the SYSTEM, not the settings — same trap as `seed`. Settings are shared
    # between systems, so anything referring to THIS object's data lives on the system.
    if "furless" in ob.vertex_groups:
        psys.vertex_group_density = "furless"
    return st


def eye_frame(V, F, W, centre, half=0.030):
    """Local frame at one eye: (outward normal, fissure long axis, short axis).

    Taken from an SVD of the surrounding surface patch rather than assumed, because the
    palpebral fissure is not aligned with any model axis — it runs obliquely up and out.
    """
    Nn = vertex_normals(V, F)
    head = W[:, [16]].sum(1) > 0.5
    near = np.where(head & (np.linalg.norm(V - centre, axis=1) < half))[0]
    nrm = Nn[near].mean(0)
    nrm = nrm / max(np.linalg.norm(nrm), 1e-9)
    d = V[near] - V[near].mean(0)
    d = d - np.outer(d @ nrm, nrm)          # flatten into the tangent plane
    _, _, vt = np.linalg.svd(d, full_matrices=False)
    lng = vt[0] - nrm * (vt[0] @ nrm)
    lng = lng / max(np.linalg.norm(lng), 1e-9)
    sht = np.cross(nrm, lng)
    return nrm, lng, sht


def eye_socket(V, F, W, centres, depth=0.0085, ridge=0.0024,
               a=0.0255, b=0.0142, reach=2.60):
    """Carve an almond orbit with raised lid folds around each eye.

    This is the fix for the uncanny read, and it has to be GEOMETRY rather than shading:
    the panel ships as normal-derived shading, so there is no albedo channel to fake an
    eyelid with. What made the old version read as a doll was that D-SMAL models no lids
    at all — the fissure is a ~0.004 crease — so a sphere sat on a convex, featureless
    face and kept a perfectly circular silhouette. Two things follow from that and both
    are fixed here:

      * the aperture is an ELLIPSE (a x b, roughly 1.8:1) aligned to the fissure, so the
        visible eye is almond rather than round
      * a raised annulus outside it reads as upper and lower lid folds, and its inner
        edge clips the eyeball's silhouette instead of leaving a free-floating disc

    Displacement is along the local surface normal with a smoothstep profile: inward
    inside the aperture, outward over the fold, zero past `reach`. Runs on the rest mesh
    before subdivision, like smile(), so Catmull-Clark smooths the result.
    """
    V = V.copy()
    for c in centres:
        c = np.asarray(c, dtype=float)
        nrm, lng, sht = eye_frame(V, F, W, c)
        rel = V - c
        q = np.sqrt((rel @ lng / a) ** 2 + (rel @ sht / b) ** 2)
        along = np.abs(rel @ nrm)
        # Smoothstep gate, not a sqrt. A sqrt falls off sharply near its edge and the
        # discontinuity showed up as a set of concentric ripples in the skin below each
        # eye once the surface was subdivided and normal-shaded.
        g = np.clip(1.0 - along / 0.034, 0.0, 1.0)
        gate = g * g * (3.0 - 2.0 * g)

        inner = np.clip(1.0 - q, 0.0, 1.0)
        inner = inner * inner * (3.0 - 2.0 * inner)
        t = np.clip((q - 1.0) / (reach - 1.0), 0.0, 1.0)
        fold = np.sin(np.pi * t) ** 2.0                        # 0 at both ends

        disp = (-depth * inner + ridge * fold) * gate
        V = V + disp[:, None] * nrm[None, :]
    return V


def eye_material(name="eye", radius=0.018, gaze=(1.0, 0.0, 0.0),
                 iris="#6B4523", pupil="#06050A", limbus="#160E08",
                 sclera="#D6D0C6", pupil_frac=0.055, iris_frac=0.205,
                 limbus_frac=0.245, sclera_frac=0.295):
    """A dog eye is a dark iris with a black pupil and a hard specular catchlight,
    not a uniform black ball. The catchlight is what makes it read as wet and alive at
    sub-panel size, so roughness stays very low and a coat layer sits on top.

    Zones run outward from the gaze pole as fractions of 1 - cos(theta), so 0 is dead
    ahead and 1 is 90 degrees off-axis: pupil, iris, a thin dark limbal ring, then
    sclera. The sclera shows only past the limbus, which is why it appears as pale
    wedges at the medial and lateral canthi rather than as a white ring — the socket
    aperture is ~42 deg tall but effectively open to 90 deg along the fissure, so the
    corners are the only place the outer globe is unoccluded. That is also where a real
    dog shows white, so pushing `sclera_frac` down is the honest way to show more of it.
    """
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs["Surface"])

    def lin(hexcol):
        hx = hexcol.lstrip("#")
        s = [int(hx[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]
        f = [c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4 for c in s]
        return (f[0], f[1], f[2], 1.0)

    # Angular distance from the GAZE AXIS, not radial distance in the object YZ plane.
    # The sphere is axis-aligned, so an object-space YZ radius centres the iris on the
    # model's +X — straight ahead — while the aperture the socket carves is centred on
    # the local surface NORMAL, which on a dog points forward AND well laterally. The
    # iris therefore sat off-centre in the opening. Normalising the object position and
    # dotting it with the gaze vector puts the pupil where the eye actually looks.
    coord = nt.nodes.new("ShaderNodeTexCoord")
    nrmz = nt.nodes.new("ShaderNodeVectorMath")
    nrmz.operation = "NORMALIZE"
    nt.links.new(coord.outputs["Object"], nrmz.inputs[0])
    dot = nt.nodes.new("ShaderNodeVectorMath")
    dot.operation = "DOT_PRODUCT"
    g = np.asarray(gaze, dtype=float)
    g = g / max(np.linalg.norm(g), 1e-9)
    dot.inputs[1].default_value = (float(g[0]), float(g[1]), float(g[2]))
    nt.links.new(nrmz.outputs["Vector"], dot.inputs[0])
    # t = 1 - cos(theta): 0 on the gaze pole, 1 at 90 deg. Radius no longer matters,
    # which also removes the units trap that hid the iris entirely (ramp stops were
    # authored 0..1 while object space ran +/-r = +/-0.018).
    t = nt.nodes.new("ShaderNodeMath")
    t.operation = "SUBTRACT"
    t.inputs[0].default_value = 1.0
    nt.links.new(dot.outputs["Value"], t.inputs[1])

    ramp = nt.nodes.new("ShaderNodeValToRGB")
    ramp.color_ramp.interpolation = "B_SPLINE"
    els = ramp.color_ramp.elements
    els[0].position, els[0].color = 0.0, lin(pupil)
    els[1].position, els[1].color = float(pupil_frac), lin(pupil)
    for pos, col in ((float(iris_frac), lin(iris)),
                     (float(limbus_frac), lin(limbus)),
                     (float(sclera_frac), lin(sclera)),
                     (1.0, lin(sclera))):
        els.new(min(max(pos, 0.001), 0.999)).color = col
    nt.links.new(t.outputs["Value"], ramp.inputs["Fac"])
    nt.links.new(ramp.outputs["Color"], b.inputs["Base Color"])

    b.inputs["Roughness"].default_value = 0.105
    if "Coat Weight" in b.inputs:
        # A full-strength coat over a dark globe produced big hard highlight blocks
        # that read as a glass bead. One small catchlight is what sells a wet eye.
        b.inputs["Coat Weight"].default_value = 0.28
        b.inputs["Coat Roughness"].default_value = 0.08
    if "Specular IOR Level" in b.inputs:
        b.inputs["Specular IOR Level"].default_value = 0.7
    return m


def cylindrical_uv(ob, axis=0):
    """Assign UVs by cylindrical projection about the muzzle axis.

    Deliberately NOT bpy.ops.uv.smart_project. Smart-project scatters the head into
    arbitrary islands, and an island layout you cannot predict is one you cannot paint
    into — the whole point of going to UV here is to author the coat in texture space.
    A cylinder about +X is the natural parameterisation for a muzzle: v runs occiput to
    nose, u runs around the head, and the seam can be put under the jaw where nothing
    looks.

    The wrap is the only subtlety. atan2 jumps from +pi to -pi along the seam, so any
    face straddling it gets a u-range near 1.0 and would be smeared across the entire
    texture. Those faces get their low corners shifted by +1 so the triangle stays
    contiguous in UV, which is why the map is authored slightly wider than [0,1].
    """
    me = ob.data
    P = np.array([v.co[:] for v in me.vertices])
    other = [i for i in (0, 1, 2) if i != axis]
    a, b = P[:, other[0]], P[:, other[1]] - P[:, other[1]].mean()
    u = np.arctan2(a, b) / (2 * np.pi) + 0.5
    t = P[:, axis]
    v = (t - t.min()) / max(float(np.ptp(t)), 1e-9)   # ndarray.ptp() is gone in numpy 2

    uvl = me.uv_layers.new(name="UVMap") if not me.uv_layers else me.uv_layers[0]
    for poly in me.polygons:
        vids = list(poly.vertices)
        us = u[vids]
        if us.max() - us.min() > 0.5:                 # face straddles the seam
            us = np.where(us < 0.5, us + 1.0, us)
        for k, li in enumerate(poly.loop_indices):
            uvl.data[li].uv = (float(us[k]), float(v[vids[k]]))
    return uvl


def bake_coat_texture(ob, fn, res=2048, bleed=6, name="coat_bake"):
    """Rasterise a position-driven pattern into a UV texture, in numpy.

    This is what UV actually buys. The coat used to be a FLOAT_COLOR point attribute,
    so its sharpest possible edge was one mesh edge wide and the muzzle mask blurred
    across whole faces (FIGURE-NOTES 3b). Subdividing to 125k verts pushed that limit
    down but never removed it. A texture decouples pattern resolution from mesh
    resolution completely: at 2048 the mask edge is a texel, not a face.

    Bakes off the BASE mesh, before subdivision, because Catmull-Clark interpolates
    UVs — so ~2.6k triangles rasterise instead of ~250k, and the result is identical.

    `fn(points) -> (n,3) linear RGB` is evaluated at the interpolated 3D position of
    every texel, so the pattern is authored in model space and lands in texture space.
    """
    me = ob.data
    me.calc_loop_triangles()
    uvl = me.uv_layers[0].data
    P = np.array([v.co[:] for v in me.vertices])
    img = np.zeros((res, res, 3), dtype=np.float32)
    cov = np.zeros((res, res), dtype=bool)

    for tri in me.loop_triangles:
        li = tri.loops
        uv = np.array([uvl[i].uv[:] for i in li]) * res
        p3 = P[list(tri.vertices)]
        lo = np.floor(uv.min(0)).astype(int) - 1
        hi = np.ceil(uv.max(0)).astype(int) + 1
        lo = np.maximum(lo, 0)
        hi = np.minimum(hi, res)
        if np.any(hi <= lo):
            continue
        xs = np.arange(lo[0], hi[0]) + 0.5
        ys = np.arange(lo[1], hi[1]) + 0.5
        gx, gy = np.meshgrid(xs, ys)
        d0 = uv[1] - uv[0]
        d1 = uv[2] - uv[0]
        den = d0[0] * d1[1] - d1[0] * d0[1]
        if abs(den) < 1e-12:
            continue
        rx, ry = gx - uv[0][0], gy - uv[0][1]
        w1 = (rx * d1[1] - d1[0] * ry) / den
        w2 = (d0[0] * ry - rx * d0[1]) / den
        w0 = 1.0 - w1 - w2
        m = (w0 >= -1e-6) & (w1 >= -1e-6) & (w2 >= -1e-6)
        if not m.any():
            continue
        pts = (w0[m][:, None] * p3[0] + w1[m][:, None] * p3[1]
               + w2[m][:, None] * p3[2])
        yy = gy[m].astype(int)
        xx = gx[m].astype(int)
        img[yy, xx] = fn(pts).astype(np.float32)
        cov[yy, xx] = True

    # Dilate outward so bilinear filtering at island borders does not sample the void
    # and draw a dark seam along every edge of the unwrap.
    for _ in range(bleed):
        empty = ~cov
        for dy, dx in ((0, 1), (0, -1), (1, 0), (-1, 0)):
            src = np.roll(np.roll(cov, dy, 0), dx, 1)
            take = empty & src
            if take.any():
                img[take] = np.roll(np.roll(img, dy, 0), dx, 1)[take]
                cov |= take

    bimg = bpy.data.images.new(name, res, res, alpha=False, float_buffer=True)
    rgba = np.concatenate([img, np.ones((res, res, 1), np.float32)], axis=2)
    bimg.pixels.foreach_set(rgba.reshape(-1))
    bimg.pack()
    print(f"  baked {name}: {res}x{res}, {cov.mean() * 100:.1f}% covered")
    return bimg


def add_wireframe(Vh, Fh, target=None, width=0.00040, grey=0.34, offset=0.0011,
                  subdiv=1, strength=1.0, name="WIRE"):
    """Thin grey wireframe of the CONTROL CAGE over the shaded surface.

    Deliberately the base cage (~1.3k verts / 2.6k faces), not the rendered mesh. The
    head is subdivided to level 3 for shading, so a wireframe of what is actually
    rendered would be ~250k faces of moiré. The cage is the topology that means
    something — it is what a mesh recovery would return — and at this density it reads
    as structure rather than as noise.

    SHRINKWRAPPED onto the rendered surface, not offset outward along normals. Pushing
    the cage out does stop it sinking, but the cage is a coarse polyhedron whose flat
    faces already stand well proud of the limit surface at grazing angles, so the push
    turns that into a visibly detached wire shell hanging off the ears and jaw — a
    double outline. Shrinkwrap puts every cage vertex exactly on the surface being
    rendered, and then a tiny offset lifts it just clear of z-fighting.

    Emission, not diffuse. Under `--shade normal` the head is an emission shader and the
    area lights are doing nothing, so a lit wire would render near-black and stop being
    subtle.
    """
    me = bpy.data.meshes.new(name)
    me.from_pydata([tuple(v) for v in Vh], [], [tuple(f) for f in Fh])
    me.validate()
    me.update()
    ob = bpy.data.objects.new(name, me)
    bpy.context.scene.collection.objects.link(ob)

    # Subdivide the cage BEFORE shrinkwrapping. Shrinkwrap only moves vertices, so a
    # straight cage edge between two on-surface vertices chords BELOW a convex surface
    # and is hidden along its middle — the wire then renders as asterisks radiating from
    # each vertex instead of as continuous edges. Halving edge length cuts the sagitta
    # roughly fourfold, which is what actually closes the lines up. Worst on the skull,
    # where the cage triangles are largest.
    if subdiv > 0:
        sub = ob.modifiers.new("cage", "SUBSURF")
        sub.levels = subdiv
        sub.render_levels = subdiv
    if target is not None:
        sw = ob.modifiers.new("hug", "SHRINKWRAP")
        sw.target = target
        sw.wrap_method = "NEAREST_SURFACEPOINT"
        sw.offset = offset

    mod = ob.modifiers.new("wire", "WIREFRAME")
    mod.thickness = width
    mod.use_replace = True
    mod.use_boundary = True
    if hasattr(mod, "use_even_offset"):
        mod.use_even_offset = True

    m = bpy.data.materials.new("wire_grey")
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    g = float(grey)
    em.inputs["Color"].default_value = (g, g, g * 1.02, 1.0)
    em.inputs["Strength"].default_value = strength
    nt.links.new(em.outputs[0], out.inputs["Surface"])
    ob.data.materials.append(m)
    print(f"  wireframe: {len(Fh)} cage faces x subdiv {subdiv} "
          f"(~{len(Fh) * 4 ** subdiv} drawn), width {width}, offset {offset}, "
          f"grey {grey}{', shrinkwrapped' if target is not None else ''}")
    return ob


def rhinarium_frame(V, F, W, pad=0.011):
    """Locate the nose leather from the mesh instead of guessing a cutoff.

    The nostrils are by far the sharpest crease on the head — they score 0.81 where
    nothing else on the face clears 0.02 — so they are trivially findable, and the
    rhinarium is the patch spanning them and the rostral tip.

    This replaced a hand-set ball at z = 0.055. That sat on the BRIDGE of the snout,
    covering z 0.032-0.090 while the nostrils sit at z = 0.007, so the black pad was
    pasted across the top of the muzzle with the real nostrils left bare below it.
    Returns (centre, semi_axes, nostril_centres).
    """
    nb = {}
    for a, b, c in F:
        for u, vv in ((a, b), (a, c), (b, a), (b, c), (c, a), (c, b)):
            nb.setdefault(u, set()).add(vv)
    N = vertex_normals(V, F)
    head = W[:, [16, 32]].sum(1) > 0.5
    snout = np.where(head & (V[:, 0] > V[head][:, 0].max() - 0.09))[0]
    cr = np.array([1.0 - float(np.mean(N[list(nb[i])] @ N[i])) for i in snout])
    rim = snout[cr > 0.45]
    if len(rim) < 4:                       # fall back to the top decile
        rim = snout[np.argsort(-cr)[:12]]
    tip = V[snout[np.argmax(V[snout][:, 0])]]
    left = rim[V[rim][:, 1] > 0]
    right = rim[V[rim][:, 1] < 0]
    nostrils = [V[left].mean(0), V[right].mean(0)] if len(left) and len(right) else []
    rimc = V[rim].mean(0)
    centre = np.array([0.5 * (tip[0] + rimc[0]) + 0.006, 0.0,
                       0.5 * (tip[2] + rimc[2])])
    span = V[rim].max(0) - V[rim].min(0)
    semi = np.array([max(tip[0] - rimc[0], 0.02) + pad,
                     span[1] * 0.5 + pad * 1.7,
                     max(span[2], 0.012) * 0.5 + pad * 2.2])
    return centre, semi, nostrils


def nose_material(name="rhinarium", nostrils=(), nostril_r=0.016):
    """Wet nose leather: near-black, glossy, with the cobbled micro-texture that
    separates a rhinarium from a painted dark patch."""
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    nt = m.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    b = nt.nodes.new("ShaderNodeBsdfPrincipled")
    nt.links.new(b.outputs[0], out.inputs["Surface"])
    b.inputs["Base Color"].default_value = (0.016, 0.013, 0.014, 1.0)
    b.inputs["Roughness"].default_value = 0.34
    if "Coat Weight" in b.inputs:
        # A strong coat over near-black leather blew the whole rhinarium out to a flat
        # grey disc — the specular covered every pixel of it. Keep it low and rough.
        b.inputs["Coat Weight"].default_value = 0.12
        b.inputs["Coat Roughness"].default_value = 0.22

    coord = nt.nodes.new("ShaderNodeTexCoord")
    vor = nt.nodes.new("ShaderNodeTexVoronoi")
    vor.inputs["Scale"].default_value = 420.0
    nt.links.new(coord.outputs["Object"], vor.inputs["Vector"])
    bump = nt.nodes.new("ShaderNodeBump")
    bump.inputs["Strength"].default_value = 0.22
    bump.inputs["Distance"].default_value = 0.002
    nt.links.new(vor.outputs["Distance"], bump.inputs["Height"])
    nt.links.new(bump.outputs["Normal"], b.inputs["Normal"])

    # The nostril creases are only ~0.004 deep. On a glossy pad the specular fills them
    # in completely and the nose renders as a plain blob, which is the other half of
    # the "what is going on with the nostrils" problem. Darken them explicitly and
    # roughen them, so they read as openings rather than as dents.
    if len(nostrils):
        acc = None
        for nc in nostrils:
            src = nt.nodes.new("ShaderNodeTexCoord")
            sub = nt.nodes.new("ShaderNodeVectorMath")
            sub.operation = "SUBTRACT"
            sub.inputs[1].default_value = tuple(float(x) for x in nc)
            nt.links.new(src.outputs["Object"], sub.inputs[0])
            ln = nt.nodes.new("ShaderNodeVectorMath")
            ln.operation = "LENGTH"
            nt.links.new(sub.outputs["Vector"], ln.inputs[0])
            mr = nt.nodes.new("ShaderNodeMapRange")
            mr.clamp = True
            mr.inputs["From Min"].default_value = nostril_r * 0.40
            mr.inputs["From Max"].default_value = nostril_r
            mr.inputs["To Min"].default_value = 1.0
            mr.inputs["To Max"].default_value = 0.0
            nt.links.new(ln.outputs["Value"], mr.inputs["Value"])
            if acc is None:
                acc = mr.outputs["Result"]
            else:
                mx = nt.nodes.new("ShaderNodeMath")
                mx.operation = "MAXIMUM"
                nt.links.new(acc, mx.inputs[0])
                nt.links.new(mr.outputs["Result"], mx.inputs[1])
                acc = mx.outputs["Value"]
        mix = nt.nodes.new("ShaderNodeMixRGB")
        mix.inputs["Color1"].default_value = (0.016, 0.013, 0.014, 1.0)
        mix.inputs["Color2"].default_value = (0.0015, 0.0012, 0.0014, 1.0)
        nt.links.new(acc, mix.inputs["Fac"])
        nt.links.new(mix.outputs["Color"], b.inputs["Base Color"])
        rgh = nt.nodes.new("ShaderNodeMath")
        rgh.operation = "MULTIPLY_ADD"
        rgh.inputs[1].default_value = 0.60
        rgh.inputs[2].default_value = 0.34
        nt.links.new(acc, rgh.inputs[0])
        nt.links.new(rgh.outputs["Value"], b.inputs["Roughness"])
    return m


def simple_mat(name, hexcol, rough=0.4, metal=0.0, emit=0.0):
    m = bpy.data.materials.new(name)
    m.use_nodes = True
    b = m.node_tree.nodes["Principled BSDF"]
    h = hexcol.lstrip("#")
    srgb = [int(h[i:i + 2], 16) / 255.0 for i in (0, 2, 4)]

    def lin(c):
        return c / 12.92 if c <= 0.04045 else ((c + 0.055) / 1.055) ** 2.4

    col = (lin(srgb[0]), lin(srgb[1]), lin(srgb[2]), 1.0)
    b.inputs["Base Color"].default_value = col
    b.inputs["Roughness"].default_value = rough
    b.inputs["Metallic"].default_value = metal
    if emit > 0 and "Emission Color" in b.inputs:
        b.inputs["Emission Color"].default_value = col
        b.inputs["Emission Strength"].default_value = emit
    m.diffuse_color = col
    return m


# ---------------------------------------------------------------------------
def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--jaw", type=float, default=17.0, help="deg the jaw opens")
    ap.add_argument("--ears", type=float, default=13.0, help="deg ears tilt forward")
    ap.add_argument("--smile", type=float, default=1.0, help="lip-corner retraction")
    ap.add_argument("--subdiv", type=int, default=3,
                    help="subdivision level before coat evaluation")
    ap.add_argument("--dist", type=float, default=2.25,
                    help="camera distance; 105mm needs ~2.25 to frame the head")
    ap.add_argument("--res", type=int, default=1800)
    ap.add_argument("--samples", type=int, default=380)
    ap.add_argument("--betas", default="",
                    help="comma-separated D-SMAL shape coefficients, leading PCs "
                         "first, e.g. '2,-1.5'. Empty = the mean shape. See "
                         "load_dsmal() for the caption consequence.")
    ap.add_argument("--shade", choices=["coat", "normal", "clay", "uv"],
                    default="coat",
                    help="head surface treatment; keypoints/eyes/tongue keep their "
                         "own materials in every mode, because the keypoint colours "
                         "are the legend")
    ap.add_argument("--normal-style", choices=["rgb", "mono", "duotone"],
                    default="rgb",
                    help="rgb spends the whole hue circle on the normal and collides "
                         "with coloured markers; mono/duotone spend only lightness on "
                         "it and leave the hue circle free for the legend")
    ap.add_argument("--kp-style", choices=["auto", "color", "achromatic"],
                    default="auto",
                    help="auto goes achromatic under rgb normals, colour otherwise")
    ap.add_argument("--kp-seat", type=float, default=0.36,
                    help="marker centre height above the rendered surface, in units of "
                         "marker radius. 1.0 is tangent; below 1 embeds the bead so it "
                         "reads as sitting ON the skin. Was effectively 0.95 against "
                         "the CAGE, which floated at convex extremities.")
    ap.add_argument("--eye-sclera", type=float, default=0.210,
                    help="onset of the sclera as a fraction of 1-cos(theta) from the "
                         "gaze axis; LOWER shows more white at the canthi")
    ap.add_argument("--socket", type=float, default=1.0,
                    help="eye socket + lid fold strength; 0 disables")
    ap.add_argument("--socket-depth", type=float, default=0.0085)
    ap.add_argument("--socket-ridge", type=float, default=0.0024)
    ap.add_argument("--eye-sink", type=float, default=0.0170,
                    help="push the globe in along the surface normal so the lid folds "
                         "clip it; 0 leaves a full circular cap proud of the face")
    ap.add_argument("--wire", action="store_true",
                    help="thin grey wireframe of the control cage over the surface")
    ap.add_argument("--wire-width", type=float, default=0.00040)
    ap.add_argument("--wire-grey", type=float, default=0.34)
    ap.add_argument("--wire-subdiv", type=int, default=1,
                    help="cage subdivisions before shrinkwrap; 0 leaves long edges "
                         "chording under the surface and the wire renders as asterisks")
    ap.add_argument("--wire-offset", type=float, default=0.0011,
                    help="lift off the shrinkwrapped surface, just enough to clear "
                         "z-fighting; large values detach the cage into a halo")
    ap.add_argument("--uv-res", type=int, default=2048,
                    help="baked coat map resolution; decoupled from mesh density")
    ap.add_argument("--uv-dump", action="store_true",
                    help="also write the baked coat map as a PNG for inspection")
    ap.add_argument("--normal-bump", type=float, default=0.0,
                    help="fur bump strength folded into the normal render (0 = the "
                         "clean geometric normal)")
    ap.add_argument("--normal-gamma", type=float, default=2.2,
                    help="pre-linearisation for the Standard view transform; 1.0 "
                         "gives the washed-out version")
    ap.add_argument("--fur", action="store_true",
                    help="real hair geometry instead of a bump map. The silhouette is "
                         "where a coat shows, and a bump map has no silhouette.")
    ap.add_argument("--fur-len", type=float, default=0.0072,
                    help="0.0165 was tried first and reads as a teddy bear; the head "
                         "is only ~0.35 long, so a short coat is well under 0.01")
    ap.add_argument("--fur-count", type=int, default=16000,
                    help="parent strands; visible count is this times the child count")
    ap.add_argument("--fur-melanin", type=float, default=0.17,
                    help="0 pale cream, 1 black. 0.62 rendered as a dark brown bear.")
    ap.add_argument("--no-nose", action="store_true",
                    help="skip the separate rhinarium material")
    ap.add_argument("--nose-scale", type=float, default=1.0,
                    help="scale on the mesh-derived rhinarium extent. The centre and "
                         "shape are measured from the nostril creases now, so this is "
                         "a nudge, not a placement.")
    ap.add_argument("--eye-pos", default="1.177,0.087,0.152",
                    help="eyeball centre, mirrored in y. Default is the model's own "
                         "palpebral fissure (vertex 713), found with --shade normal "
                         "--probe. The pre-Aug-14 value was 1.116,0.118,0.158, which "
                         "is the lateral skull wall, not the eye — see FIGURE-NOTES 3b.")
    ap.add_argument("--eye-r", type=float, default=0.021,
                    help="eyeball radius. The old 0.025 was sized to read as an eye "
                         "on the flat skull wall; seated in the real aperture, 0.017 "
                         "goes beady and 0.021 holds at sub-panel size.")
    ap.add_argument("--probe", default="",
                    help="semicolon-separated model-space points, e.g. "
                         "'1.19,0.05,0.12; 1.15,0.09,0.16', drawn as numbered "
                         "high-contrast markers. Use with --shade normal to find "
                         "features that diffuse shading hides. kpcheck.py prints "
                         "where a landmark snaps; this shows you.")
    ap.add_argument("--kp-r", type=float, default=0.0055,
                    help="marker radius. 0.0068 reads as gumballs once the coat is "
                         "real fur rather than flat clay.")
    ap.add_argument("--no-keypoints", action="store_true")
    ap.add_argument("--no-eyes", action="store_true")
    ap.add_argument("--no-tongue", action="store_true")
    ap.add_argument("--out", default="dogface")
    args = ap.parse_args(sys.argv[1:])

    betas = [float(x) for x in args.betas.replace(",", " ").split()] or None
    V0, F, W, J = load_dsmal(betas)

    # ---- happy face: open jaw, ears forward, lip corners drawn back ----
    V = V0.copy()
    V = joint_rotate(V, W, J_JAW, J[J_JAW], rot_y(args.jaw))
    V = joint_rotate(V, W, J_EAR_L, J[J_EAR_L], rot_y(args.ears))
    V = joint_rotate(V, W, J_EAR_R, J[J_EAR_R], rot_y(args.ears))
    V = smile(V, args.smile)
    _ex, _ey, _ez = [float(v) for v in args.eye_pos.replace(",", " ").split()]
    EYE_C = [np.array([_ex, _ey, _ez]), np.array([_ex, -_ey, _ez])]
    if args.socket > 0:
        V = eye_socket(V, F, W, EYE_C, depth=args.socket_depth * args.socket,
                       ridge=args.socket_ridge * args.socket)
        print(f"  eye sockets carved: depth {args.socket_depth * args.socket:.4f}, "
              f"lid fold {args.socket_ridge * args.socket:.4f}")
    print(f"  posed: jaw +{args.jaw:.0f} deg, ears +{args.ears:.0f} deg, "
          f"smile {args.smile:.2f}")

    rig.reset()
    Vh, Fh, kept = trim_to_head(V, F, W)
    print(f"  trimmed to head: {len(Vh)} verts / {len(Fh)} faces")

    # The coat pattern lives in a per-vertex colour attribute, so it can never be
    # sharper than the mesh spacing — at 1,316 head verts (~1 cm apart) the muzzle
    # mask edge was interpolated across whole faces and looked blurred. Subdivide and
    # BAKE the geometry first, then evaluate the colours on the dense mesh. This also
    # cleans up the faceted ear and skull silhouettes.
    dog = mk_mesh("DOG_HEAD", Vh, Fh)

    # UV and the coat bake both happen on the BASE mesh, before subdivision:
    # Catmull-Clark interpolates UVs, so unwrapping here costs ~2.6k triangles instead
    # of ~250k and gives the identical map.
    coat_img = None
    if args.shade == "uv":
        cylindrical_uv(dog)
        coat_img = bake_coat_texture(dog, coat_colors, res=args.uv_res)
        if args.uv_dump:
            p = os.path.join(HERE, f"{args.out}_coatmap.png")
            coat_img.filepath_raw = p
            coat_img.file_format = "PNG"
            coat_img.save()
            print(f"  wrote coat map {p}")

    if args.subdiv > 0:
        bpy.ops.object.select_all(action="DESELECT")
        dog.select_set(True)
        bpy.context.view_layer.objects.active = dog
        mod = dog.modifiers.new("subsurf", "SUBSURF")
        mod.levels = args.subdiv
        mod.render_levels = args.subdiv
        bpy.ops.object.convert(target="MESH")
        dog = bpy.context.active_object
    Vd = np.array([v.co[:] for v in dog.data.vertices])
    print(f"  subdiv {args.subdiv} -> {len(Vd)} verts for coat evaluation")
    # The subdivision above stays in every shading mode. It is not only about coat
    # sharpness: it also fixes the faceted ear and skull silhouettes, and the marker
    # seating below is calibrated against the subdivided surface.
    if args.shade == "coat":
        Cd = coat_colors(Vd)
        att = dog.data.color_attributes.new(name="Col", type="FLOAT_COLOR",
                                            domain="POINT")
        for i, c in enumerate(Cd):
            att.data[i].color = (float(c[0]), float(c[1]), float(c[2]), 1.0)
    if args.wire:
        add_wireframe(Vh, Fh, target=dog, width=args.wire_width,
                      grey=args.wire_grey, offset=args.wire_offset,
                      subdiv=args.wire_subdiv)
    for pl in dog.data.polygons:
        pl.use_smooth = True
    surf = {
        "coat": lambda: fur_material(),
        "normal": lambda: normal_material(bump=args.normal_bump,
                                          gamma=args.normal_gamma,
                                          style=args.normal_style),
        "clay": lambda: clay_material(),
        "uv": lambda: uv_material(coat_img),
    }[args.shade]()
    dog.data.materials.append(surf)
    print(f"  head shading: {args.shade}")

    # ---- bare zones: rhinarium and the eye apertures ----
    # A plane cut at x > const wrapped the whole end of the muzzle and read as a snout
    # mask rather than a nose. The rhinarium is a rounded pad, so define it as a ball
    # around the nose leather's own centre.
    ex, ey, ez = [float(v) for v in args.eye_pos.replace(",", " ").split()]
    nose_c, nose_semi, nostrils = rhinarium_frame(V0, F, W)
    nose_semi = nose_semi * args.nose_scale
    print(f"  rhinarium frame: centre {np.round(nose_c, 4)} "
          f"semi {np.round(nose_semi, 4)} | nostrils at "
          f"{[list(np.round(n, 4)) for n in nostrils]}")

    def in_nose(p):
        d = (np.asarray(p) - nose_c) / nose_semi
        return float(d @ d) < 1.0

    def near_eye(p):
        p = np.asarray(p)
        return min(np.linalg.norm(p - np.array([ex, s * ey, ez])) for s in (1, -1)) \
            < args.eye_r * 1.30

    if not args.no_nose:
        dog.data.materials.append(nose_material(nostrils=nostrils))
        nose_slot = len(dog.data.materials) - 1
        n_faces = 0
        for pl in dog.data.polygons:
            if in_nose(pl.center):
                pl.material_index = nose_slot
                n_faces += 1
        print(f"  rhinarium: {n_faces} faces")

    # ---- real fur ----
    if args.fur:
        vg = dog.vertex_groups.new(name="furless")
        vg.add(list(range(len(dog.data.vertices))), 1.0, "REPLACE")
        # Fur must be cut back at BOTH the nose and the eyes. Left furry, the eyes are
        # buried under the coat and the face loses them entirely — the first fur render
        # had two faint slits where the eyes should be.
        bare = [i for i, v in enumerate(dog.data.vertices)
                if in_nose(v.co) or near_eye(v.co)]
        if bare:
            vg.add(bare, 0.0, "REPLACE")
        # In normal mode the strands take the normal shader too. Otherwise a fawn coat
        # sits over a rainbow head, which shows neither the surface nor the fur. Cycles
        # gives hair curves a real shading normal, so each strand shades individually —
        # that is where the detail in a normals render actually comes from.
        strand = (normal_material(name="fur_normal", bump=args.normal_bump,
                                  gamma=args.normal_gamma,
                                  style=args.normal_style)
                  if args.shade == "normal"
                  else hair_material(melanin=args.fur_melanin))
        dog.data.materials.append(strand)
        add_fur(dog, len(dog.data.materials), length=args.fur_len,
                count=args.fur_count)
        print(f"  fur: {args.fur_count} parents, len {args.fur_len}, "
              f"melanin {args.fur_melanin}, {len(bare)} bare verts")

    # ---- keypoints: snap to anatomy on the REST mesh, read from the POSED mesh ----
    head_r = 0.351 - (-0.087)
    kp_r = args.kp_r
    if not args.no_keypoints:
        ach = (args.kp_style == "achromatic"
               or (args.kp_style == "auto" and args.shade == "normal"
                   and args.normal_style == "rgb"))
        mats = {k: marker_material(f"kp_{k}", v, achromatic=ach)
                for k, v in KP_COLOR.items()}
        print(f"  markers: {'achromatic + dark rim' if ach else 'colour + dark rim'}")
        # Seat every marker on the RENDERED surface, not on the control cage.
        #
        # History, because this has now failed in both directions. Markers were first
        # placed at the cage vertex and SANK into the ears, because Catmull-Clark pulls
        # the limit surface inward from its cage. The fix was to push out along the
        # vertex normal by ~0.95 r — which over-corrected, and left beads visibly
        # FLOATING wherever the cage stands furthest proud of the limit surface: the ear
        # tips, the crown midline, and under the jaw. All three are convex extremities,
        # which is exactly where the cage-to-limit gap is largest.
        #
        # Neither offset is right, because the gap is not constant. Ask the subdivided
        # mesh where its surface actually is: closest_point_on_mesh() returns the real
        # surface point and its normal, and the bead is seated from there. `seat` < 1
        # embeds the bead slightly so it reads as sitting ON the skin rather than
        # balanced on it.
        floated = 0
        for name, target, group in KEYPOINTS:
            t = np.asarray(target)
            i = int(np.argmin(np.linalg.norm(V0 - t[None, :], axis=1)))
            ok, loc, nrm, _ = dog.closest_point_on_mesh(Vector(V[i]))
            if ok:
                gap = (Vector(V[i]) - loc).length
                if gap > kp_r * 0.5:
                    floated += 1
                q = np.array(loc) + np.array(nrm) * kp_r * args.kp_seat
            else:
                q = V[i] + vertex_normals(V, F)[i] * kp_r * args.kp_seat
            s = rig.sphere(kp_r, tuple(q), mats[group], name=f"kp_{name}", segs=16)
            del s
        print(f"  {len(KEYPOINTS)} keypoints seated on the rendered surface "
              f"(seat {args.kp_seat}); {floated} were >{kp_r * 0.5:.4f} off the cage")

    # ---- probe markers: same snap-and-seat rule as the keypoints ----
    if args.probe:
        PROBE_COLS = ["#FF00A8", "#00E5FF", "#FFE100", "#00FF6A", "#FF6A00", "#B36BFF"]
        Nrm_p = vertex_normals(V, F)
        pts = [p for p in args.probe.split(";") if p.strip()]
        print(f"  probing {len(pts)} point(s):")
        for k, p in enumerate(pts):
            t = np.array([float(v) for v in p.replace(",", " ").split()])
            i = int(np.argmin(np.linalg.norm(V0 - t[None, :], axis=1)))
            q = V[i] + Nrm_p[i] * kp_r * 1.15
            pm = simple_mat(f"probe_{k}", PROBE_COLS[k % len(PROBE_COLS)],
                            rough=0.2, emit=0.55)
            rig.sphere(kp_r * 1.25, tuple(q), pm, name=f"probe_{k}", segs=16)
            print(f"    [{k}] {PROBE_COLS[k % len(PROBE_COLS)]} target "
                  f"{np.round(t, 3)} -> v{i} {np.round(V0[i], 3)} "
                  f"err={np.linalg.norm(V0[i] - t):.4f}")

    # ---- eyeballs: see FIGURE-NOTES 3b. D-SMAL DOES model the palpebral fissure;
    # what it lacks is an eyeball inside it. These spheres are optional. ----
    if not args.no_eyes:
        # Sink the globe along the local surface normal so the carved socket and its
        # lid folds clip the silhouette. A sphere centred ON the surface shows a full
        # circular cap no matter what the surrounding skin does.
        for sy, c in zip((1, -1), EYE_C):
            nrm, _, _ = eye_frame(V, F, W, c)
            p = c - nrm * args.eye_sink
            # one material per eye: the gaze axis is mirrored, so a shared material
            # would centre the right eye's pupil on the left eye's direction
            em = eye_material(name=f"eye_{sy}", radius=args.eye_r, gaze=nrm,
                              sclera_frac=args.eye_sclera,
                              limbus_frac=args.eye_sclera - 0.050,
                              iris_frac=args.eye_sclera - 0.090)
            rig.sphere(args.eye_r, tuple(p), em, name=f"eye_{sy}", segs=40)
        print(f"  eyeballs r={args.eye_r} sunk {args.eye_sink} along the local normal")

    # ---- mouth interior and tongue ----
    if not args.no_tongue:
        dark = simple_mat("mouth", "#2A1013", rough=0.55)
        cav = rig.sphere(0.055, (1.205, 0.0, -0.020), dark, name="mouth_cavity",
                         segs=20, scale=(1.25, 0.85, 0.55))
        del cav
        pink = simple_mat("tongue", "#C2566A", rough=0.30)
        tg = rig.sphere(0.040, (1.258, 0.0, -0.052), pink, name="tongue",
                        segs=22, scale=(1.55, 0.72, 0.30))
        tg.rotation_euler = (0.0, math.radians(18.0), 0.0)

    # ---- near-frontal camera, long lens, shallow depth of field ----
    scn = bpy.context.scene
    cd = bpy.data.cameras.new("Cam")
    cd.type = "PERSP"
    cd.lens = 105.0
    cam = bpy.data.objects.new("Cam", cd)
    scn.collection.objects.link(cam)
    # near-symmetric front view: a small lateral offset keeps the form from
    # going flat, but anything larger reads as a three-quarter view
    target = Vector((1.140, 0.0, 0.132))
    view_dir = Vector((0.995, -0.068, 0.055)).normalized()
    cam.location = target + view_dir * args.dist
    rig.aim(cam, target)
    cd.dof.use_dof = True
    cd.dof.focus_distance = (Vector(cam.location) - target).length
    # f/3.6 defocused the ears and the back of the skull, which read as general
    # softness rather than as depth. f/6.3 keeps the whole head crisp.
    cd.dof.aperture_fstop = 6.3
    scn.camera = cam

    # ---- lighting: soft key, cool fill, tight rim for edge separation ----
    for name, loc, size, energy, warm in [
        ("key",  (2.30, -1.35, 1.15), 1.4, 46.0, (1.0, 0.96, 0.90)),
        ("fill", (1.60, 1.50, 0.35), 1.8, 15.0, (0.88, 0.93, 1.0)),
        ("rim",  (0.20, 0.55, 1.05), 1.0, 26.0, (1.0, 0.98, 0.95)),
        ("kick", (1.90, 0.10, -0.75), 1.2, 11.0, (1.0, 0.94, 0.88)),
    ]:
        ld = bpy.data.lights.new(name, type="AREA")
        # DISK, not SQUARE. A square area light leaves a square highlight, and on a
        # glossy eyeball that reads as two white blocks rather than a catchlight.
        ld.shape = "DISK"
        ld.size = size
        ld.energy = energy
        ld.color = warm
        lo = bpy.data.objects.new(name, ld)
        scn.collection.objects.link(lo)
        lo.location = loc
        rig.aim(lo, (1.15, 0.0, 0.10))

    world = bpy.data.worlds.new("W")
    world.use_nodes = True
    bg = world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (0.80, 0.84, 0.90, 1.0)
    bg.inputs[1].default_value = 0.06
    scn.world = world

    scn.render.resolution_x = args.res
    scn.render.resolution_y = int(args.res * 0.86)
    scn.render.film_transparent = True          # composited later
    scn.render.image_settings.file_format = "PNG"
    scn.render.image_settings.color_mode = "RGBA"
    scn.render.engine = "CYCLES"
    try:
        cp = bpy.context.preferences.addons["cycles"].preferences
        cp.compute_device_type = "METAL"
        cp.get_devices()
        for d in cp.devices:
            d.use = (d.type == "METAL")
        scn.cycles.device = "GPU"
    except Exception as e:
        print("  metal setup failed:", e)
    scn.cycles.samples = args.samples
    scn.cycles.use_denoising = True
    scn.cycles.max_bounces = 8
    # Standard, not AgX: AgX rolled the saturated keypoint colours off to pastels,
    # which is unacceptable when the colours are the legend. Light energies are
    # reduced to compensate for the lack of highlight roll-off.
    scn.view_settings.view_transform = "Standard"

    out = os.path.join(HERE, f"{args.out}.png")
    scn.render.filepath = out
    bpy.ops.render.render(write_still=True)
    print(f"WROTE {out} ({os.path.getsize(out)} bytes)")


if __name__ == "__main__":
    main()
