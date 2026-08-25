#!/usr/bin/env python
"""Blender render for the identity-switch illustration: one floor, TWO real
animals' fading comet trails (2-animal session; the REAL chase trajectory,
anchored at the image-plane frame -- see idswitch_common.py's docstring), and
two real cameras with real image-plane photos at the instant they're close
enough to plausibly swap. The photo
quads are UNANNOTATED here -- both cameras' pose overlays (one correct, one
swapped) are added afterward by ../idswitch_fig_style.py via
chen_common.StagingCamera's analytic projection of the same real 3D points
the quad geometry already carries, exactly like hyp_fig_style.py does for the
original hypothesis figure.

    bpyenv/bin/python idswitch_fig_prep.py
    bpyenv/bin/python idswitch_fig_scene.py
    python3 ../idswitch_fig_style.py
"""
import json

import bpy
import numpy as np
import toml
from mathutils import Matrix, Vector

import cage_scene as cs
import chen_common as cc
import idswitch_common as ic

MM = ic.MM


def build_ghost(pts_mm, mouse_nodes, mat, coll, tag, scale=1.1):
    """Translucent (flat_translucent/emission) balls+tubes only, no body
    membrane -- lighter-weight than cs.build_animal's solid look, so a faded
    trail step reads as "was here" rather than a second real animal. Same
    technique as fig_chen_correspondence.py's build_ghost.

    USED FOR EVERY TRAIL STEP, including the "current" one (at scale=1.0
    alpha, just a bigger `scale`) -- NOT cs.build_animal's PBR `matte_mat` for
    the current pose, which is a real lit material and rendered visibly
    off-hue (cyan/yellow instead of blue/orange) under this scene's lighting,
    while flat_translucent's emission is lighting-independent and always
    shows its true set colour. Keeping every trail step on the SAME material
    class is what makes "blue" and "orange" mean the same colour everywhere
    on the trail."""
    idx = {n: i for i, n in enumerate(mouse_nodes)}
    sub = bpy.data.collections.new(f"ghost_{tag}")
    coll.children.link(sub)
    for n, i in idx.items():
        r = cs.NODE_R.get(cs.NODE_GROUP.get(n, "body"), cs.NODE_R["body"])
        cs.ball(f"ghost_{tag}_{n}", pts_mm[i], r * scale, mat, sub)
    for j, (a, b) in enumerate(cs.MOUSE_EDGES):
        cs.tube(f"ghost_{tag}_e{j}", pts_mm[[idx[a], idx[b]]], 0.0032 * scale, mat, sub)


def build_camera_prop(name, C_al, right_al, down_al, fwd_al, M, coll):
    R_c2w = np.stack([right_al, down_al, fwd_al], axis=1)
    cs.build_camera_unit(name, np.array(C_al) * MM, R_c2w, M, coll, focus=(0, 0, 0.15))


def build_image_quad(name, photo_path, center_al, right_al, down_al, half_w, half_h, coll):
    center = np.array(center_al) * MM
    r = np.array(right_al) * half_w * MM
    d = np.array(down_al) * half_h * MM
    verts = [center - r - d, center + r - d, center + r + d, center - r + d]
    me = bpy.data.meshes.new(f"image_plane_{name}")
    me.from_pydata([Vector(v) for v in verts], [], [(0, 1, 2, 3)])
    me.uv_layers.new(name="UV")
    uv = me.uv_layers[0].data
    for loop_idx, (u, v) in zip(range(4), [(0, 1), (1, 1), (1, 0), (0, 0)]):
        uv[loop_idx].uv = (u, v)

    mat = bpy.data.materials.new(f"image_plane_mat_{name}")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(photo_path)
    nt.links.new(tex.outputs["Color"], em.inputs["Color"])
    em.inputs["Strength"].default_value = 1.6
    nt.links.new(em.outputs[0], out.inputs["Surface"])

    ob = bpy.data.objects.new(f"image_plane_{name}", me)
    ob.data.materials.append(mat)
    coll.objects.link(ob)
    return ob


def apply_staging_camera(stg: cc.StagingCamera):
    cd = bpy.data.cameras.new("RenderCam")
    cd.type = "ORTHO"
    cd.ortho_scale = stg.ortho_scale
    cd.clip_end = 100.0
    cam = bpy.data.objects.new("RenderCam", cd)
    bpy.context.scene.collection.objects.link(cam)
    cam.matrix_world = Matrix(stg.matrix_world_rows())
    bpy.context.scene.camera = cam
    return cam


def main():
    data = json.load(open(ic.DATA_JSON))

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn_coll = bpy.context.scene.collection

    M = {k: cs.pbr_mat(k, *v) for k, v in cs.PBR.items()}
    M["cage_wall"] = cs.flat_translucent("cage_wall", cs.PBR["cage_wall"][0], cs.PBR["cage_wall"][3])

    mouse_nodes = toml.load(f"{cc.SLAP2M}/mouse_skeleton.toml")["nodes"]
    assert mouse_nodes == ic.NODE_NAMES

    # ic.render_floor_half, not data["floor_half"]: with SHOW_TRAILS off the
    # deposited rectangle is sized to trail points nothing draws any more.
    fh = ic.render_floor_half(data)
    floor_pts = np.array([
        (fh["x0"], fh["y0"], 0.0), (fh["x1"], fh["y0"], 0.0),
        (fh["x1"], fh["y1"], 0.0), (fh["x0"], fh["y1"], 0.0),
    ]) * MM
    cs.ngon("floor", floor_pts, M["cage_floor"], scn_coll)
    for i in range(4):
        cs.tube(f"floor_edge{i}", floor_pts[[i, (i + 1) % 4]], 0.0018, M["ink"], scn_coll)

    # The trail is the REAL trajectory anchored at IMAGE_FRAME (Eric: "the 3d
    # trajectory should start with the same frame that is shown in the two
    # views, then the previous frames should be added as colored 3d
    # trajectories, then the subsequent frames should be added as gray
    # trajectories") -- see idswitch_common.py's docstring. Index anchor_index
    # is IMAGE_FRAME's own pose: the emphasized, full-colour "current" instance,
    # identical to what the image planes show. Before it: the animal's colour,
    # fading with age. After it: AMBIGUOUS_GREY, fading into the future.
    trails = [np.array(data["trail_al_a"]), np.array(data["trail_al_b"])]
    anchors = [data["anchor_index_a"], data["anchor_index_b"]]
    track_colors = [ic.COLOR_A, ic.COLOR_B]
    for a in range(2):
        trail = trails[a]
        T = trail.shape[0]
        anchor = anchors[a]
        for i in range(T):
            # ONLY the anchor unless SHOW_TRAILS (Eric: "just make it the 3d
            # instances from that same one frame") -- see its comment.
            if i != anchor and not ic.SHOW_TRAILS:
                continue
            pts = trail[i] * MM
            if i == anchor:
                # ANCHOR POSE: the animal's own colour, full opacity, a bit
                # bigger, but the SAME flat_translucent material class as
                # every ghost step (see build_ghost's docstring for why not
                # cs.build_animal here).
                gmat = cs.flat_translucent(f"ghost_mat_{a}_{i}", track_colors[a], 1.0)
                build_ghost(pts, mouse_nodes, gmat, scn_coll, f"{a}_{i}",
                            scale=ic.ANCHOR_SCALE)
            elif i < anchor:
                alpha = ic.ALPHA_MIN + (ic.ALPHA_MAX - ic.ALPHA_MIN) * i / max(anchor - 1, 1)
                gmat = cs.flat_translucent(f"ghost_mat_{a}_{i}", track_colors[a], alpha)
                build_ghost(pts, mouse_nodes, gmat, scn_coll, f"{a}_{i}", scale=ic.TRAIL_SCALE)
            else:
                # certainty dissipates with distance past the shown moment
                frac = (i - anchor) / max(T - 1 - anchor, 1)
                alpha = ic.ALPHA_MAX - (ic.ALPHA_MAX - ic.ALPHA_MIN) * frac * 0.6
                gmat = cs.flat_translucent(f"ghost_mat_{a}_{i}", ic.AMBIGUOUS_GREY, alpha)
                build_ghost(pts, mouse_nodes, gmat, scn_coll, f"{a}_{i}", scale=ic.TRAIL_SCALE)

    for tag in ("cam_a", "cam_b"):
        info = data[tag]
        build_camera_prop(tag, info["C_al"], info["right_al"], info["down_al"], info["fwd_al"],
                          M, scn_coll)
        photo = ic.photo_path(data["cam_a_name"]) if tag == "cam_a" else ic.photo_path(data["cam_b_name"])
        # quad_right_al, not right_al: flipped by idswitch_fig_prep's
        # mirror_quad_if_back_side when the staging eye views this quad from
        # behind, so its photo reads unmirrored in the final render.
        build_image_quad(tag, photo, info["quad_center_al"], info["quad_right_al"], info["down_al"],
                         info["half_w_al"], info["half_h_al"], scn_coll)

    # the SAME staging camera idswitch_fig_prep.py used for its per-quad
    # mirroring decision -- one definition, in idswitch_common.staging_camera.
    stg = ic.staging_camera(trails, res=(2600, 2000))

    cs.setup_lighting(list(stg.focus))
    bg = bpy.context.scene.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    bg.inputs[1].default_value = 1.0
    cs.setup_cycles(180, [2600, 2000])
    apply_staging_camera(stg)

    with open(ic.STAGING_CAMERA_JSON, "w") as f:
        json.dump(stg.to_dict(), f, indent=2)

    cs.render_to(ic.RENDER_PNG)
    print("wrote", ic.RENDER_PNG)


if __name__ == "__main__":
    main()
