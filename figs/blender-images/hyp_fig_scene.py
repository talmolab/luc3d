#!/usr/bin/env python
"""Blender render for the multi-view grouping-hypothesis figure: one abstract
floor, 3 real animals (solid, tab10), and TWO real cameras -- variant
"sidetop" (side + top, biggest baseline in the session) or "toptop" (top +
topL, both overhead) -- each with its own real image plane. All annotation
(instance-overlay dots, the 9 candidate correspondence lines, labels) is
added afterward by ../hyp_fig_style.py via chen_common.StagingCamera's
analytic projection -- not drawn here.

    bpyenv/bin/python hyp_fig_prep.py --variant sidetop
    bpyenv/bin/python hyp_fig_scene.py --variant sidetop
    python3 ../hyp_fig_style.py --variant sidetop
"""
import argparse
import json
import os

import bpy
import numpy as np
import toml
from mathutils import Matrix, Vector

import cage_scene as cs
import chen_common as cc
import hyp_common as hc

HERE = hc.HERE
MM = hc.MM

#: staging camera azimuth/elevation per variant -- see hyp_common.STAGING_VIEW
STAGING_VIEW = hc.STAGING_VIEW


def build_camera_prop(name, C_al, right_al, down_al, fwd_al, M, coll):
    R_c2w = np.stack([right_al, down_al, fwd_al], axis=1)
    cs.build_camera_unit(name, np.array(C_al) * MM, R_c2w, M, coll, focus=(0, 0, 0.15))


def build_image_quad(name, photo_path, center_al, right_al, down_al, half_w, half_h, coll):
    center = np.array(center_al) * MM
    r = np.array(right_al) * half_w * MM
    d = np.array(down_al) * half_h * MM
    verts = [center - r - d, center + r - d, center + r + d, center - r + d]
    faces = [(0, 1, 2, 3)]
    me = bpy.data.meshes.new(f"image_plane_{name}")
    me.from_pydata([Vector(v) for v in verts], [], faces)
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
    ap = argparse.ArgumentParser()
    ap.add_argument("--variant", default=hc.DEFAULT_VARIANT, choices=list(hc.CAMERA_PAIRS))
    ap.add_argument("--samples", type=int, default=150)
    ap.add_argument("--res", type=int, nargs=2, default=[2600, 2000])
    args = ap.parse_args()

    data = json.load(open(hc.data_json_path(args.variant)))
    view = STAGING_VIEW[args.variant]

    bpy.ops.wm.read_factory_settings(use_empty=True)
    scn_coll = bpy.context.scene.collection

    M = {k: cs.pbr_mat(k, *v) for k, v in cs.PBR.items()}
    M["cage_wall"] = cs.flat_translucent("cage_wall", cs.PBR["cage_wall"][0], cs.PBR["cage_wall"][3])

    mouse_nodes = toml.load(f"{hc.SLAP2M}/mouse_skeleton.toml")["nodes"]
    assert mouse_nodes == hc.NODE_NAMES

    fh = data["floor_half"]
    floor_pts = np.array([
        (fh["x0"], fh["y0"], 0.0), (fh["x1"], fh["y0"], 0.0),
        (fh["x1"], fh["y1"], 0.0), (fh["x0"], fh["y1"], 0.0),
    ]) * MM
    cs.ngon("floor", floor_pts, M["cage_floor"], scn_coll)
    for i in range(4):
        cs.tube(f"floor_edge{i}", floor_pts[[i, (i + 1) % 4]], 0.0018, M["ink"], scn_coll)

    X_al = np.array(data["X_al"])  # (3,15,3) mm
    for tr in range(hc.N_ANIMALS):
        cs.build_animal(tr, X_al[tr] * MM, mouse_nodes, M, scn_coll, colors=hc.TAB10_3)

    for tag in ("cam_a", "cam_b"):
        info = data[tag]
        build_camera_prop(tag, info["C_al"], info["right_al"], info["down_al"], info["fwd_al"],
                          M, scn_coll)
        photo = hc.photo_a_path(args.variant) if tag == "cam_a" else hc.photo_b_path(args.variant)
        build_image_quad(tag, photo, info["quad_center_al"], info["right_al"], info["down_al"],
                         info["half_w_al"], info["half_h_al"], scn_coll)

    focus = (X_al.mean((0, 1)) * MM).tolist()
    focus[2] = 0.08

    cs.setup_lighting(focus)
    bg = bpy.context.scene.world.node_tree.nodes["Background"]
    bg.inputs[0].default_value = (1.0, 1.0, 1.0, 1.0)
    bg.inputs[1].default_value = 1.0
    cs.setup_cycles(args.samples, args.res)

    stg = cc.StagingCamera(focus=focus, azim_deg=view["azim"], elev_deg=view["elev"],
                            ortho_scale=view["ortho_scale"], res=tuple(args.res), dist=view["dist"])
    apply_staging_camera(stg)

    with open(hc.staging_camera_path(args.variant), "w") as f:
        json.dump(stg.to_dict(), f, indent=2)

    out = hc.render_path(args.variant)
    cs.render_to(out)
    print("wrote", out)


if __name__ == "__main__":
    main()
