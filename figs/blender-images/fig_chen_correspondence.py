#!/usr/bin/env python
"""Blender render of a Chen et al. (2020) Fig. 2 -style correspondence figure,
using real SLAP-2M two-animal data instead of Chen's schematic mocap dots.

ONE render, ONE staging camera, containing BOTH sub-panels side by side and
close together (not two separate stills stitched later):

  * left  ("a", 2D correspondence)  -- both animals' pose at t', the real
    calibrated "side" camera, and its true image plane textured with the real
    (undistorted) video frame at t.
  * right ("b", 3D correspondence)  -- same animals, PLUS a translucent
    "ghost" of the illustrated animal's linear-motion-predicted pose at t.

Both panels are the SAME real camera/data, just translated sideways by
PANEL_OFFSET_M so they sit next to each other. All annotation (dots, rays,
dashed segments, labels, distance callouts) is added afterward by
../fig_chen2020_style.py via chen_common.StagingCamera's analytic projection
-- NOT drawn in Blender -- so re-running the compositor to tweak
wording/placement doesn't require a re-render. Run:

    bpyenv/bin/python chen_fig_prep.py                 # writes chen_fig_data.json
    bpyenv/bin/python fig_chen_correspondence.py        # this file
    python3 ../fig_chen2020_style.py                    # final annotated figure
"""
import json
import os

import bpy
import numpy as np
import toml
from mathutils import Matrix, Vector

import cage_scene as cs
import chen_common as cc

HERE = cc.HERE
MM = cc.MM

GHOST_COLOR = "#2A5C94"
GHOST_ALPHA = 0.62

AZIM_DEG, ELEV_DEG = cc.AZIM_DEG, cc.ELEV_DEG
PANEL_OFFSET_M = cc.PANEL_OFFSET_M


def build_floor(offset, M, coll, tag, floor_half):
    pts = cc.floor_corners_mm(floor_half) * MM + offset
    ob = cs.ngon(f"floor_{tag}", pts, M["cage_floor"], coll)
    # a near-white fill is invisible against the new white background -- an
    # explicit dark outline is what makes it read as a plane (Chen et al.'s own
    # floor is drawn as an outline, not a filled tint).
    for i in range(4):
        cs.tube(f"floor_{tag}_edge{i}", pts[[i, (i + 1) % 4]], 0.0018, M["ink"], coll)
    return ob


def build_camera_prop(name, C_al, right_al, down_al, fwd_al, offset, M, coll):
    """House-style camera body (cage_scene.build_camera_unit), posed at the real
    calibrated extrinsics transformed into the aligned scene frame, then
    translated sideways by `offset` (a pure position shift -- orientation is
    untouched)."""
    R_c2w = np.stack([right_al, down_al, fwd_al], axis=1)  # columns
    cs.build_camera_unit(name, C_al * MM + offset, R_c2w, M, coll, focus=tuple(offset + (0, 0, 0.15)))


def build_ghost(pts_mm, offset, mouse_nodes, mat, coll, tag):
    """A translucent balls+bones-only sketch (no body membranes) of the
    predicted pose -- lighter-weight than build_animal's solid look, so it
    reads as a prediction rather than a second real animal."""
    idx = {n: i for i, n in enumerate(mouse_nodes)}
    pts = pts_mm * MM + offset
    sub = bpy.data.collections.new(f"ghost_{tag}")
    coll.children.link(sub)
    for n, i in idx.items():
        r = cs.NODE_R.get(cs.NODE_GROUP.get(n, "body"), cs.NODE_R["body"])
        cs.ball(f"ghost_{tag}_{n}", pts[i], r * 1.15, mat, sub)
    for j, (a, b) in enumerate(cs.MOUSE_EDGES):
        cs.tube(f"ghost_{tag}_e{j}", pts[[idx[a], idx[b]]], 0.0034, mat, sub)


def build_image_quad(photo_path, center_al, right_al, down_al, half_w, half_h, offset, coll, tag):
    center = np.array(center_al) * MM + offset
    r = np.array(right_al) * half_w * MM
    d = np.array(down_al) * half_h * MM
    verts = [center - r - d, center + r - d, center + r + d, center - r + d]
    faces = [(0, 1, 2, 3)]
    me = bpy.data.meshes.new(f"image_plane_{tag}")
    me.from_pydata([Vector(v) for v in verts], [], faces)
    me.uv_layers.new(name="UV")
    uv = me.uv_layers[0].data
    for loop_idx, (u, v) in zip(range(4), [(0, 1), (1, 1), (1, 0), (0, 0)]):
        uv[loop_idx].uv = (u, v)

    mat = bpy.data.materials.new(f"image_plane_mat_{tag}")
    mat.use_nodes = True
    nt = mat.node_tree
    for n in list(nt.nodes):
        nt.nodes.remove(n)
    out = nt.nodes.new("ShaderNodeOutputMaterial")
    em = nt.nodes.new("ShaderNodeEmission")
    tex = nt.nodes.new("ShaderNodeTexImage")
    tex.image = bpy.data.images.load(photo_path)
    nt.links.new(tex.outputs["Color"], em.inputs["Color"])
    em.inputs["Strength"].default_value = 1.6  # the scene lights don't reach this "screen"
    nt.links.new(em.outputs[0], out.inputs["Surface"])

    ob = bpy.data.objects.new(f"image_plane_{tag}", me)
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


def build_panel(tag, offset, M, scn_coll, data, with_ghost, mouse_nodes):
    build_floor(offset, M, scn_coll, tag, data["floor_half"])

    # The solid mesh is the animal's TRUE current pose (time t), not the stale
    # anchor (t') -- X_t(mu), the point where the back-projected ray meets 3D
    # space, is BY CONSTRUCTION the true triangulated position, so it must
    # coincide with the solid skeleton's shoulder for the ray to visibly
    # intersect the real animal (Eric: "it should be intersecting with animal
    # 1 ... on the shoulder"; rendering the STALE anchor pose instead put the
    # true point and the ghost right next to each other but away from the
    # solid mesh, which read as "both landing on the ghost").
    X_true = np.array(data["X_true_al"])
    X_other = np.array(data["X_other_al"])
    cs.build_animal(cc.TRACK_MAIN, X_true * MM + offset, mouse_nodes, M, scn_coll)
    cs.build_animal(cc.TRACK_OTHER, X_other * MM + offset, mouse_nodes, M, scn_coll)

    build_camera_prop(f"side_{tag}", np.array(data["C_al"]), np.array(data["right_al"]),
                       np.array(data["down_al"]), np.array(data["fwd_al"]), offset, M, scn_coll)

    if with_ghost:
        # ghost is anchored to X_true now too, so its visible offset is the
        # (exaggerated) PREDICTION ERROR -- a small residual near the real
        # animal -- rather than the much larger anchor-to-now displacement.
        ghost_mat = cs.flat_translucent(f"ghost_mat_{tag}", GHOST_COLOR, GHOST_ALPHA)
        X_hat_render = cc.exaggerated_ghost(X_true, np.array(data["X_hat_al"]),
                                           np.array(data["ray_dir_al"]))
        build_ghost(X_hat_render, offset, mouse_nodes, ghost_mat, scn_coll, tag)

    build_image_quad(cc.PHOTO_UNDISTORTED, data["quad_center_al"],
                      data["right_al"], data["down_al"],
                      data["half_w_al"], data["half_h_al"], offset, scn_coll, tag)

    focus = (X_true.mean(0) + X_other.mean(0)) / 2 * MM + offset
    focus[2] = 0.10
    return focus


def render_combined(samples, res, out_name="chen_correspondence_combined.png"):
    data = cc.load_json()
    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn_coll = bpy.context.scene.collection

    M = {k: cs.pbr_mat(k, *v) for k, v in cs.PBR.items()}
    M["cage_wall"] = cs.flat_translucent("cage_wall", cs.PBR["cage_wall"][0], cs.PBR["cage_wall"][3])

    mouse_nodes = toml.load(f"{cc.SLAP2M}/mouse_skeleton.toml")["nodes"]
    assert mouse_nodes == cc.NODE_NAMES

    focus_a = build_panel("a", PANEL_OFFSET_M["a"], M, scn_coll, data, with_ghost=False,
                          mouse_nodes=mouse_nodes)
    focus_b = build_panel("b", PANEL_OFFSET_M["b"], M, scn_coll, data, with_ghost=True,
                          mouse_nodes=mouse_nodes)
    focus = ((focus_a + focus_b) / 2).tolist()

    cs.setup_lighting(focus)
    # white background (not panelA/cage_scene's pale grey), per Eric: the figure
    # is meant to sit on a plain white page like the Chen et al. reference.
    bg = bpy.context.scene.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    bg.inputs[1].default_value = 1.0

    cs.setup_cycles(samples, res)

    stg = cc.StagingCamera(focus=focus, azim_deg=AZIM_DEG, elev_deg=ELEV_DEG,
                            ortho_scale=1.30, res=tuple(res), dist=2.0)
    apply_staging_camera(stg)

    stg_path = os.path.join(HERE, "renders", "chen_staging_camera.json")
    with open(stg_path, "w") as f:
        json.dump(stg.to_dict(), f, indent=2)

    out = os.path.join(HERE, "renders", out_name)
    cs.render_to(out)
    print("wrote", out)


def main():
    import argparse
    ap = argparse.ArgumentParser()
    ap.add_argument("--samples", type=int, default=160)
    ap.add_argument("--res", type=int, nargs=2, default=[2400, 1300])
    args = ap.parse_args()
    render_combined(args.samples, tuple(args.res))


if __name__ == "__main__":
    main()
