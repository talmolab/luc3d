#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["sleap-nn>=0.2.0"]
# ///
"""
Run a SLEAP top-down model pair BACKWARD: give it a skeleton, get an image.

A centroid model maps a frame to a heatmap with one peak per animal; a
centered-instance model maps a crop around each animal to one heatmap per node.
Neither network is invertible, so "backward" means: find an image which, run
FORWARD through the same two models and the same preprocessing sleap-nn applies
at inference (size-match, scale, pad to stride, crop around each centroid),
produces the heatmaps that the given skeleton(s) would have been trained
against. That is gradient descent on the pixels, with the models' own training
loss as the objective: the result is what the models think that pose looks
like.

What keeps the result looking like an animal rather than noise that drives the
heatmaps just as well (each measured on a 5-mouse frame; see report.json):

  - Start from a real image. By default each requested pose gets the labeled
    animal of the same video whose pose fits it best, cut out of its frame and
    pasted, rotated and scaled, onto the video's median background (the empty
    arena). The optimization then only has to reshape a real animal.
  - Only pixels near the requested animals may change (--margin).
  - Every step, each model sees a random rotation/rescaling of its input within
    the ranges it was trained with (its config's geometric augmentation), plus a
    few pixels of shift. An image has to show the pose from every such view.
  - The image is a pyramid of per-octave layers (finest 2 px by default), summed
    and squashed through a sigmoid, so coarse structure moves as easily as fine.

Usage (sleap-nn's own environment has everything this needs):

    PY=~/.local/share/uv/tools/sleap-nn/bin/python   # or: uv run scripts/sleap_backward.py

    # The pose(s) of one labeled frame, started from the best-matching OTHER
    # labeled animals of that video (never the frame's own):
    $PY scripts/sleap_backward.py \\
        --centroid  models/xxx.centroid.n=123 \\
        --instance  models/yyy.centered_instance.n=123 \\
        --slp labels.slp --frame 1000 --out out/

    # New poses, drawn on that video (it supplies the background and exemplars):
    $PY scripts/sleap_backward.py ... --slp labels.slp --frame 1000 \\
        --pose new_pose.json --out out/

    # Hand-written poses (node names must match the model's skeleton; a node
    # left out or null is "don't care", not "absent"):
    #   {"size": [1280, 1024],
    #    "instances": [{"Nose": [410, 320], "Trunk": [470, 380], ...}, ...]}

    # What the models alone make of a pose, with no real animal to start from:
    $PY scripts/sleap_backward.py ... --init background --out out/

Either model may be given alone. With only --centroid, the whole frame is
optimized for the centroid heatmap; with only --instance, each crop is
optimized for its node heatmaps and the crops are placed on the frame at the
pose's anchor node.

Outputs, in --out:
    image.png         the generated frame (what the models think the pose looks like)
    overlay.png       the same frame with the requested skeleton (green) and the
                      skeleton sleap-nn recovers from it (magenta)
    heatmaps.png      per animal: the crop, the target node heatmaps and the
                      heatmaps the model actually produces on the crop
    progress.png      snapshots of the image during optimization
    report.json       settings, losses and the round-trip error per node
    backward.pkg.slp  the frame with the requested skeleton, for SLEAP / LUCID

Both .ckpt (sleap-nn) and best_model.h5 (SLEAP <= 1.4, UNet only) model
folders load, through sleap-nn's own loader.

Requires: sleap-nn (torch, sleap-io, opencv come with it).
"""

import os

# A few ops (antialiased resize's backward) have no Metal kernel yet; let them
# fall back to the CPU instead of failing. Must be set before torch loads.
os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import argparse
import json
import math
import sys
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Optional

import numpy as np

try:
    import cv2
    import sleap_io as sio
    import torch
    import torch.nn.functional as F
    from sleap_nn.data.confidence_maps import generate_confmaps, generate_multiconfmaps
    from sleap_nn.data.instance_centroids import generate_centroids
    from sleap_nn.data.instance_cropping import make_centered_bboxes
    from sleap_nn.data.resizing import (
        apply_pad_to_stride,
        apply_sizematcher,
        resize_image,
    )
    from sleap_nn.inference.peak_finding import (
        crop_bboxes,
        find_global_peaks,
        find_local_peaks,
    )
    from sleap_nn.inference.predictors import TopDownPredictor
    from omegaconf import OmegaConf
except ImportError as e:
    print(
        f"Error: {e}.\nRun this with sleap-nn's Python, e.g.\n"
        "    ~/.local/share/uv/tools/sleap-nn/bin/python scripts/sleap_backward.py ...\n"
        "or with uv:  uv run scripts/sleap_backward.py ...",
        file=sys.stderr,
    )
    sys.exit(1)


# Inference settings sleap-nn uses by default; the round-trip check uses the same.
PEAK_THRESHOLD = 0.2
INTEGRAL_PATCH = 5


# ---------------------------------------------------------------------------
# Models
# ---------------------------------------------------------------------------


@dataclass
class Stage:
    """One model of the pair, plus the preprocessing sleap-nn applies before it."""

    net: torch.nn.Module  # backbone + head; takes images already in [0, 1]
    head: str  # output key of the confidence-map head
    in_channels: int
    scale: float
    max_stride: int
    output_stride: int
    sigma: float
    rotation: tuple = (0.0, 0.0)  # degrees it was trained to ignore (min, max)
    zoom: tuple = (1.0, 1.0)  # scale factors it was trained to ignore (min, max)


@dataclass
class Pair:
    centroid: Optional[Stage]
    instance: Optional[Stage]
    node_names: list  # channel order of the centered-instance head (or the skeleton)
    edges: list  # (i, j) index pairs into node_names
    anchor_ind: Optional[int]  # None = bounding-box midpoint, as sleap-nn does
    crop_hw: Optional[tuple]  # centered-instance crop (h, w), before its scale
    max_hw: tuple  # sizematcher target (h, w); (None, None) = no size matching


def _backbone(cfg):
    for name, value in cfg.model_config.backbone_config.items():
        if value is not None:
            return value
    raise ValueError("model config has no backbone")


def _stage(module, cfg, head_key, head_cfg) -> Stage:
    net = module.model
    net.eval()
    for p in net.parameters():
        p.requires_grad_(False)
    backbone = _backbone(cfg)
    rotation, zoom = (0.0, 0.0), (1.0, 1.0)
    aug = cfg.data_config.augmentation_config if cfg.data_config.use_augmentations_train else None
    geo = getattr(aug, "geometric", None) if aug is not None else None
    if geo is not None:
        if (geo.rotation_p or 0) > 0:
            rotation = (float(geo.rotation_min), float(geo.rotation_max))
        if (geo.scale_p or 0) > 0:
            zoom = (float(geo.scale_min), float(geo.scale_max))
    return Stage(
        net=net,
        head=head_key,
        in_channels=int(backbone["in_channels"]),
        scale=float(cfg.data_config.preprocessing.scale),
        max_stride=int(backbone["max_stride"]),
        output_stride=int(head_cfg.confmaps.output_stride),
        sigma=float(head_cfg.confmaps.sigma),
        rotation=rotation,
        zoom=zoom,
    )


def load_pair(centroid_dir, instance_dir, device) -> Pair:
    """Load the model(s) with sleap-nn's own loader (.ckpt or legacy .h5)."""
    pred = TopDownPredictor.from_trained_models(
        centroid_ckpt_path=centroid_dir,
        confmap_ckpt_path=instance_dir,
        device=device,
        # None = take each setting from the training config, as `sleap-nn track` does.
        preprocess_config=OmegaConf.create(
            dict.fromkeys(
                ["ensure_rgb", "ensure_grayscale", "crop_size", "max_width", "max_height", "scale"]
            )
        ),
    )
    ccfg, icfg = pred.centroid_config, pred.confmap_config
    skeleton = pred.skeletons[0]
    node_names = list(skeleton.node_names)

    centroid = instance = None
    anchor_part = None
    crop_hw = None
    if ccfg is not None:
        head = ccfg.model_config.head_configs.centroid
        centroid = _stage(pred.centroid_model, ccfg, "CentroidConfmapsHead", head)
        anchor_part = head.confmaps.anchor_part
    if icfg is not None:
        head = icfg.model_config.head_configs.centered_instance
        instance = _stage(
            pred.confmap_model, icfg, "CenteredInstanceConfmapsHead", head
        )
        if head.confmaps.part_names:
            node_names = list(head.confmaps.part_names)
        anchor_part = anchor_part or head.confmaps.anchor_part
        size = int(pred.preprocess_config["crop_size"])
        crop_hw = (size, size)

    edges = []
    for a, b in skeleton.edge_names:
        if a in node_names and b in node_names:
            edges.append((node_names.index(a), node_names.index(b)))
    pre = (ccfg or icfg).data_config.preprocessing
    return Pair(
        centroid=centroid,
        instance=instance,
        node_names=node_names,
        edges=edges,
        anchor_ind=node_names.index(anchor_part) if anchor_part in node_names else None,
        crop_hw=crop_hw,
        max_hw=(pre.max_height, pre.max_width),
    )


# ---------------------------------------------------------------------------
# The forward pipeline, differentiable in the image
# ---------------------------------------------------------------------------


def size_match(pair: Pair, image):
    """sleap-nn's sizematcher: returns (image, effective scale)."""
    return apply_sizematcher(image, max_height=pair.max_hw[0], max_width=pair.max_hw[1])


def run_stage(stage: Stage, image):
    """Scale, pad to stride, and run one model.

    `image` is (n, C, H, W): float in [0, 1] while optimizing, or uint8 to reproduce
    `sleap-nn track` exactly — it resizes the uint8 frame, rounding to whole grey
    levels, and only then divides by 255.
    """
    if stage.scale != 1.0:
        image = resize_image(image, stage.scale)
    image = apply_pad_to_stride(image, stage.max_stride)
    if image.dtype == torch.uint8:
        image = image.float() / 255
    return stage.net(image)[stage.head], image.shape[-2:]


def centroids_of(pair: Pair, poses):
    """Centroids exactly as sleap-nn training computes them (anchor, else bbox mid)."""
    return generate_centroids(poses, anchor_ind=pair.anchor_ind)


def crop_instances(pair: Pair, image, centroids, as_sleap_nn=False):
    """Crop around each centroid.

    Returns the crops, their bounding boxes (sleap-nn's half-pixel corners) and the
    integer pixel each crop actually starts at; the two differ by up to a pixel.
    Node positions are relative to the box's top-left corner, NOT to the start:
    that is the frame sleap-nn's training labels are in (`instance - bbox[0]`) and
    the one its inference adds back (`peak + bbox[0]`).

    While optimizing this slices instead of calling sleap-nn's `crop_bboxes`, whose
    unfold-and-index has no usable gradient: its backward allocates every possible
    crop of the frame at once (1.2 TB for a 500 px crop of a 1280x1024 frame). The
    index arithmetic — rounding, zero padding, clamping — is `crop_bboxes`'s.

    With `as_sleap_nn`, it calls `crop_bboxes` itself, to reproduce `sleap-nn track`
    exactly — including that (sleap-nn 0.2.0) it reads the crop size off the first
    box in float32, so for ~6% of first centroids per axis `499.0` comes out as
    `498.99997` and every crop of that frame is one pixel short.
    """
    h, w = pair.crop_hw
    bboxes = make_centered_bboxes(centroids, h, w)  # (n, 4, 2)
    if as_sleap_nn:
        crops = crop_bboxes(image, bboxes=bboxes, sample_inds=[0] * len(centroids))
        return crops, bboxes, crop_starts(bboxes, *crops.shape[-2:], image.shape[-2:])
    starts = crop_starts(bboxes, h, w, image.shape[-2:])
    hh, hw = h // 2, w // 2
    padded = F.pad(image, (hw, hw, hh, hh), mode="constant", value=0)
    crops = [
        padded[:, :, y + hh : y + hh + h, x + hw : x + hw + w]
        for x, y in starts.to(torch.long).tolist()
    ]
    crops = torch.cat(crops) if crops else image.new_zeros((0, image.shape[1], h, w))
    return crops, bboxes, starts


def crop_starts(bboxes, h, w, image_hw):
    """The image pixel (x, y) that crop pixel (0, 0) of an `h x w` crop really is.

    Same arithmetic as `crop_bboxes`: it truncates the box's top-left plus half the
    crop to a pixel, clamps it to the padded frame, and slices `h x w` from there.
    """
    hh, hw = h // 2, w // 2
    half = torch.tensor([hw, hh], dtype=bboxes.dtype, device=bboxes.device)
    idx = (bboxes[:, 0, :] + half).to(torch.long)
    idx[:, 0] = idx[:, 0].clamp(0, image_hw[1] + 2 * hw - w)
    idx[:, 1] = idx[:, 1].clamp(0, image_hw[0] + 2 * hh - h)
    return idx.to(bboxes.dtype) - half


def similarity_warp(image, src, dst, angle, zoom, out_hw):
    """Rotate by `angle` (radians) and scale by `zoom` about `src`, landing it on `dst`.

    `image` (1, C, H, W); `src`, `dst` (n, 2) pixels; `angle`, `zoom` (n,). Returns
    (n, C, *out_hw): output pixel u shows input point `src + R(-angle) (u - dst) / zoom`,
    i.e. an input point p lands at `dst + zoom R(angle) (p - src)` — see `warp_points`.
    Bilinear, zeros outside the frame, differentiable in the image.
    """
    n = src.shape[0]
    h, w = out_hw
    H, W = image.shape[-2:]
    dev = image.device
    ys, xs = torch.meshgrid(
        torch.arange(h, device=dev, dtype=torch.float32),
        torch.arange(w, device=dev, dtype=torch.float32),
        indexing="ij",
    )
    dx = xs[None] - dst[:, 0, None, None]
    dy = ys[None] - dst[:, 1, None, None]
    c = (torch.cos(angle) / zoom)[:, None, None]
    s = (torch.sin(angle) / zoom)[:, None, None]
    px = src[:, 0, None, None] + c * dx + s * dy
    py = src[:, 1, None, None] - s * dx + c * dy
    grid = torch.stack([2 * px / (W - 1) - 1, 2 * py / (H - 1) - 1], dim=-1)
    return F.grid_sample(
        image.expand(n, -1, -1, -1), grid, mode="bilinear", padding_mode="zeros",
        align_corners=True,
    )


def warp_points(points, src, dst, angle, zoom):
    """Where `similarity_warp` puts `points` (n, K, 2): dst + zoom R(angle) (p - src)."""
    d = points - src[:, None, :]
    c = (torch.cos(angle) * zoom)[:, None]
    s = (torch.sin(angle) * zoom)[:, None]
    x = c * d[..., 0] - s * d[..., 1]
    y = s * d[..., 0] + c * d[..., 1]
    return torch.stack([x, y], dim=-1) + dst[:, None, :]


def random_view(stage: Stage, n, gen, device):
    """Random (angle, zoom) per sample, within what `stage` was trained to ignore."""
    lo, hi = stage.rotation
    angle = torch.deg2rad(lo + (hi - lo) * torch.rand(n, generator=gen))
    lo, hi = stage.zoom
    zoom = lo + (hi - lo) * torch.rand(n, generator=gen)
    return angle.to(device), zoom.to(device)


def objective(pair: Pair, image, poses, node_mask, gen=None):
    """Relative heatmap errors of each model for one image and its target poses.

    `image` (1, C, H, W) in [0, 1] at the video's resolution; `poses` (n, K, 2) in the
    same pixels, NaN where a node is missing; `node_mask` (n, K) True where the node
    is constrained. Each error is sum((pred - target)^2) / sum(target^2): 1.0 is "no
    animal here at all", 0.0 is a perfect match, so the two models weigh alike.

    With a generator `gen`, each model instead sees a random rotation and rescaling
    of its input, drawn from the ranges it was trained with (its training config's
    geometric augmentation), and the targets move with it — the frame turned about
    its centre for the centroid model, each crop about its own centroid for the
    centered-instance model, as in training. That is still the model's training
    distribution, and an image has to look like the pose from every such view to
    keep the error down, which is what keeps it from being pixel-exact noise.
    """
    image, eff = size_match(pair, image)
    poses = poses * eff
    out = {}
    if pair.centroid is not None:
        st = pair.centroid
        frame, frame_poses = image, poses
        if gen is not None and (st.rotation != (0.0, 0.0) or st.zoom != (1.0, 1.0)):
            H, W = image.shape[-2:]
            mid = torch.tensor([[(W - 1) / 2, (H - 1) / 2]], device=image.device)
            angle, zoom = random_view(st, 1, gen, image.device)
            frame = similarity_warp(image, mid, mid, angle, zoom, (H, W))
            flat = warp_points(poses.reshape(1, -1, 2), mid, mid, angle, zoom)
            frame_poses = flat.reshape(poses.shape)
        pred, hw = run_stage(st, frame)
        target = generate_multiconfmaps(
            centroids_of(pair, frame_poses * st.scale)[None].cpu(),  # its grids are on the CPU
            img_hw=tuple(hw),
            num_instances=len(poses),
            sigma=st.sigma,
            output_stride=st.output_stride,
            is_centroids=True,
        ).to(pred.device)
        out["centroid"] = ((pred - target) ** 2).sum() / (target**2).sum()
        out["centroid_maps"] = (pred, target)
    if pair.instance is not None:
        st = pair.instance
        centroids = centroids_of(pair, poses)
        h, w = pair.crop_hw
        bboxes = make_centered_bboxes(centroids, h, w)
        starts = crop_starts(bboxes, h, w, image.shape[-2:])
        if gen is not None and (st.rotation != (0.0, 0.0) or st.zoom != (1.0, 1.0)):
            # Each crop turned about its own centroid, which stays where the plain
            # crop would have put it, so angle 0 / zoom 1 is exactly that crop.
            here = centroids - starts
            angle, zoom = random_view(st, len(poses), gen, image.device)
            crops = similarity_warp(image, centroids, here, angle, zoom, pair.crop_hw)
            local = warp_points(poses, centroids, here, angle, zoom) + starts[:, None, :]
        else:
            crops, _, _ = crop_instances(pair, image, centroids)
            local = poses
        # In the box-corner frame sleap-nn labels and reads peaks in (see
        # `crop_instances`): measured on 5,493 hand-labeled nodes, reading peaks
        # against the integer start instead is off by -0.66/-0.76 px, against the
        # corner by -0.25/-0.34 px.
        local = local - bboxes[:, None, 0, :]
        pred, hw = run_stage(st, crops)
        local = local * st.scale
        target = generate_confmaps(
            local.cpu(), img_hw=tuple(hw), sigma=st.sigma, output_stride=st.output_stride
        ).to(pred.device)
        m = node_mask[:, :, None, None].to(pred.dtype)
        out["instance"] = (((pred - target) ** 2) * m).sum() / ((target**2) * m).sum()
        out["instance_maps"] = (pred, target, crops)
    return out


# ---------------------------------------------------------------------------
# The image being optimized
# ---------------------------------------------------------------------------


class PyramidImage(torch.nn.Module):
    """An image as sigmoid(logit(init) + mask * sum of upsampled per-octave layers).

    Every octave gets its own learnable layer, so a step of the optimizer moves low
    frequencies as readily as high ones; a plain pixel grid moves almost only the
    highest, which is where adversarial noise lives. Where `mask` is 0 the image is
    exactly `init`.
    """

    def __init__(self, init, levels, mask=None, finest=0):
        super().__init__()
        _, c, h, w = init.shape
        self.size = (h, w)
        self.register_buffer("base", torch.logit(init.clamp(0.01, 0.99)))
        self.register_buffer("mask", mask if mask is not None else torch.ones_like(init[:, :1]))
        # Octave k holds detail of ~2^k px; leaving out the finest octaves leaves out
        # the pixel-scale detail adversarial noise is made of.
        self.layers = torch.nn.ParameterList(
            torch.nn.Parameter(
                torch.zeros(1, c, math.ceil(h / 2**k), math.ceil(w / 2**k), device=init.device)
            )
            for k in range(finest, levels)
        )

    def forward(self):
        delta = 0
        for layer in self.layers:
            if layer.shape[-2:] == self.base.shape[-2:]:
                delta = delta + layer
            else:
                delta = delta + F.interpolate(layer, size=self.size, mode="bilinear", align_corners=False)
        return torch.sigmoid(self.base + self.mask * delta)


def edit_mask(poses, size, margin, device):
    """Soft mask of the pixels near the requested animals; None = the whole frame.

    Per animal, a disc around its centroid reaching `margin` px past its farthest
    node, feathered over ~margin/3 px so there is no seam.
    """
    if margin is None or margin < 0:
        return None
    W, H = size
    ys, xs = torch.meshgrid(
        torch.arange(H, dtype=torch.float32), torch.arange(W, dtype=torch.float32), indexing="ij"
    )
    mask = torch.zeros(H, W)
    feather = max(margin / 3, 1.0)
    for pose in poses:
        pts = pose[np.isfinite(pose).all(-1)]
        if len(pts) == 0:
            continue
        c = pts.mean(0)
        r = np.linalg.norm(pts - c, axis=-1).max() + margin
        d = torch.sqrt((xs - float(c[0])) ** 2 + (ys - float(c[1])) ** 2)
        mask = torch.maximum(mask, torch.sigmoid((r - d) / feather))
    return mask[None, None].to(device)


def procrustes(src, dst):
    """Best similarity taking pose `src` onto pose `dst` (K, 2 each; NaNs ignored).

    Returns (angle, zoom, src_centre, dst_centre, rms residual px) in the convention
    of `similarity_warp` / `warp_points`: dst ~ dst_centre + zoom R(angle) (src - src_centre).
    No reflection: a mouse's left and right are labeled.
    """
    ok = np.isfinite(src).all(-1) & np.isfinite(dst).all(-1)
    if ok.sum() < 2:
        return None
    a, b = src[ok], dst[ok]
    ca, cb = a.mean(0), b.mean(0)
    za = (a - ca) @ [1, 1j]
    zb = (b - cb) @ [1, 1j]
    z = np.vdot(za, zb) / np.vdot(za, za)
    rms = float(np.sqrt(np.mean(np.abs(zb - z * za) ** 2)))
    return float(np.angle(z)), float(np.abs(z)), ca, cb, rms


def skeleton_distance(pose, edges, size):
    """Distance (px) from every pixel to the drawn skeleton of `pose`: (H, W) float32."""
    W, H = size
    canvas = np.full((H, W), 255, np.uint8)
    for i, j in edges:
        if np.isfinite(pose[[i, j]]).all():
            cv2.line(canvas, _pt(pose[i]), _pt(pose[j]), 0, 3)
    for p in pose:
        if np.isfinite(p).all():
            cv2.circle(canvas, _pt(p), 2, 0, -1)
    return cv2.distanceTransform(canvas, cv2.DIST_L2, 5)


def exemplar_init(background, poses, pool, reader, edges, device, max_zoom=0.15, log=print):
    """The background with, for each pose, the best-matching real labeled animal pasted in.

    `pool` is a list of (frame_idx, pose, other poses on that frame) user instances.
    Each target pose takes the instance whose shape fits it best after
    rotation/scale/translation (zoom within ±max_zoom: same camera, same-sized
    animals). It is cut out of its frame by its difference from the median
    background, within a body-wide band around its own skeleton (15% of its
    length; a reflection or a tail beside it stays behind) and only where its
    skeleton is the nearest one (so does a neighbour it was touching), then
    rotated, scaled and moved onto the target. Returns (1, C, H, W) in [0, 1].
    """
    bg = to_tensor(background, background.shape[2], device)
    H, W = bg.shape[-2:]
    out = bg.clone()
    cache = {}
    for i, target in enumerate(poses):
        best = None
        for fidx, pose, others in pool:
            fit = procrustes(pose, target)
            if fit is None or abs(math.log(fit[1])) > math.log(1 + max_zoom):
                continue
            if best is None or fit[4] < best[1][4]:
                best = ((fidx, pose, others), fit)
        if best is None:
            log(f"  animal {i}: no labeled animal to start from; left as background")
            continue
        (fidx, pose, others), (angle, zoom, ca, cb, rms) = best
        log(f"  animal {i}: starts as the labeled animal of frame {fidx} (shape mismatch {rms:.1f} px)")
        if fidx not in cache:
            cache[fidx] = to_tensor(reader[fidx], background.shape[2], device)
        frame = cache[fidx]
        # Its silhouette: what differs from the empty arena, near its own nodes only.
        diff = (frame - bg).abs().amax(dim=1, keepdim=True)
        alpha = ((diff - 15 / 255) / (20 / 255)).clamp(0, 1)
        mine = skeleton_distance(pose, edges, (W, H))
        pts = pose[np.isfinite(pose).all(-1)]
        length = np.linalg.norm(pts[:, None] - pts[None], axis=-1).max()
        keep = mine <= max(0.15 * length, 10.0)
        if others:
            keep &= mine <= np.min([skeleton_distance(o, edges, (W, H)) for o in others], axis=0)
        alpha = alpha * torch.from_numpy(keep.astype(np.float32))[None, None].to(device)
        alpha = F.avg_pool2d(alpha, 5, stride=1, padding=2)
        t = lambda img: similarity_warp(
            img,
            torch.tensor(np.array([ca]), dtype=torch.float32, device=device),
            torch.tensor(np.array([cb]), dtype=torch.float32, device=device),
            torch.tensor([angle], dtype=torch.float32, device=device),
            torch.tensor([zoom], dtype=torch.float32, device=device),
            (H, W),
        )
        a = t(alpha)
        out = out * (1 - a) + t(frame) * a
    return out.clamp(0, 1)


def median_background(reader, n):
    """Per-pixel median of `n` frames spread over the video: the arena, no animals."""
    idx = np.linspace(0, len(reader) - 1, n).round().astype(int)
    return np.median(np.stack([reader[int(i)] for i in idx]), axis=0).round().astype(np.uint8)


def total_variation(image):
    return (image[..., 1:, :] - image[..., :-1, :]).abs().mean() + (
        image[..., :, 1:] - image[..., :, :-1]
    ).abs().mean()


def optimize(pair: Pair, init, poses, node_mask, args, mask=None, log=print):
    """Gradient descent on the pixels. Returns (image, history, snapshots)."""
    gen = torch.Generator().manual_seed(args.seed)
    img_param = PyramidImage(init, args.levels, mask, args.finest)
    opt = torch.optim.Adam(img_param.parameters(), lr=args.lr)
    weights = {"centroid": args.centroid_weight, "instance": args.instance_weight}
    history, snapshots = [], []
    snap_every = max(1, args.steps // 7)
    t0 = time.time()
    for step in range(args.steps + 1):
        image = img_param()
        if step % snap_every == 0 or step == args.steps:
            snapshots.append((step, image.detach().cpu()))
        if step == args.steps:
            break
        # Random shift of the whole frame — and of the poses with it — so no detail
        # can rely on sitting at one exact pixel.
        j = args.jitter
        dx, dy = (torch.randint(-j, j + 1, (2,), generator=gen).tolist() if j else (0, 0))
        shifted = torch.roll(image, shifts=(dy, dx), dims=(2, 3)) if j else image
        shift = torch.tensor([dx, dy], dtype=poses.dtype, device=poses.device)
        terms = objective(pair, shifted, poses + shift, node_mask, gen if args.augment else None)
        loss = sum(weights[k] * terms[k] for k in weights if k in terms)
        if args.tv:
            loss = loss + args.tv * total_variation(image)
        if args.keep:
            loss = loss + args.keep * ((image - init) ** 2).mean()
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
        row = {"step": step, "loss": loss.item()}
        row.update({k: terms[k].item() for k in weights if k in terms})
        history.append(row)
        if step % args.log_every == 0:
            parts = "  ".join(f"{k} {row[k]:.4f}" for k in weights if k in row)
            log(f"  step {step:5d}  loss {row['loss']:.4f}  {parts}  ({time.time() - t0:.0f} s)")
    return img_param().detach(), history, snapshots


# ---------------------------------------------------------------------------
# The round trip: what sleap-nn recovers from an image
# ---------------------------------------------------------------------------


@torch.no_grad()
def recover(pair: Pair, image, poses):
    """Run the image forward the way `sleap-nn track` does; return what it finds.

    Pass `image` as uint8 (1, C, H, W) to match it bit for bit.

    Centroids come from the centroid model (or, with no centroid model, from the
    requested poses). Each recovered instance is matched to the requested one whose
    centroid is nearest. Returns a dict of numpy arrays in video pixels.
    """
    image, eff = size_match(pair, image)
    want = centroids_of(pair, poses * eff)
    found_c = None
    if pair.centroid is not None:
        st = pair.centroid
        cms, _ = run_stage(st, image)
        peaks, vals, _, _ = find_local_peaks(
            cms.cpu(), threshold=PEAK_THRESHOLD, refinement="integral",
            integral_patch_size=INTEGRAL_PATCH,
        )
        found_c = peaks * st.output_stride / st.scale  # sizematched pixels
        centroids = found_c
    else:
        centroids = want
    result = {"centroids": (found_c / eff).numpy() if found_c is not None else None}
    if pair.instance is None or len(centroids) == 0:
        return result
    st = pair.instance
    crops, bboxes, _ = crop_instances(
        pair, image, centroids.to(image.device), as_sleap_nn=True
    )
    cms, _ = run_stage(st, crops)
    peaks, vals = find_global_peaks(
        cms.cpu(), threshold=PEAK_THRESHOLD, refinement="integral",
        integral_patch_size=INTEGRAL_PATCH,
    )
    peaks = peaks * st.output_stride / st.scale
    # What sleap-nn reports: peak + the box's half-pixel top-left corner.
    reported = (peaks + bboxes[:, 0, :].cpu()[:, None, :]) / eff
    # Match each requested animal to the nearest recovered centroid.
    d = torch.cdist(want.cpu(), centroids.cpu())
    match = d.argmin(dim=1).numpy() if d.numel() else np.zeros(0, int)
    result.update(
        reported=reported.numpy()[match],
        scores=vals.numpy()[match],
        centroid_dist=(d.min(dim=1).values / eff).numpy() if d.numel() else None,
    )
    return result


def node_errors(pred, poses, node_mask):
    err = np.linalg.norm(pred - poses, axis=-1)
    err[~node_mask] = np.nan
    return err


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


def exemplar_pool(path, video_index, node_names, exclude_frame):
    """Every user-labeled instance of one video, except those on `exclude_frame`.

    Each entry is (frame_idx, pose, the poses of the other animals on that frame).
    """
    labels = sio.load_slp(str(path), open_videos=False)
    video = labels.videos[video_index]
    pool = []
    for lf in labels.labeled_frames:
        if lf.video is not video or lf.frame_idx == exclude_frame:
            continue
        frame_poses = [instance_to_array(inst, node_names) for inst in lf.user_instances]
        for k, pose in enumerate(frame_poses):
            pool.append((lf.frame_idx, pose, frame_poses[:k] + frame_poses[k + 1 :]))
    return pool


def poses_from_slp(path, frame_idx, video_index, node_names, which):
    """The instances of one labeled frame, in the model's node order."""
    labels = sio.load_slp(str(path), open_videos=False)
    video = labels.videos[video_index]
    lfs = labels.find(video, frame_idx)
    if not lfs:
        raise SystemExit(f"{path}: no labeled frame {frame_idx} in video {video_index}")
    lf = lfs[0]
    if which == "user":
        insts = lf.user_instances
    elif which == "predicted":
        insts = lf.predicted_instances
    else:  # user instances if the frame has any, else its predictions
        insts = lf.user_instances or lf.predicted_instances
    if not insts:
        raise SystemExit(f"{path}: frame {frame_idx} has no {which} instances")
    return [instance_to_array(inst, node_names) for inst in insts], video


def instance_to_array(inst, node_names):
    pts = inst.numpy()
    names = inst.skeleton.node_names
    out = np.full((len(node_names), 2), np.nan)
    for k, name in enumerate(node_names):
        if name in names:
            out[k] = pts[names.index(name)]
    return out


def poses_from_json(path, node_names):
    data = json.loads(Path(path).read_text())
    instances = data["instances"] if isinstance(data, dict) else data
    poses = []
    unknown = set()
    for inst in instances:
        arr = np.full((len(node_names), 2), np.nan)
        if isinstance(inst, dict):
            for name, xy in inst.items():
                if name not in node_names:
                    unknown.add(name)
                elif xy is not None:
                    arr[node_names.index(name)] = xy
        else:  # a list in the model's node order
            for k, xy in enumerate(inst[: len(node_names)]):
                if xy is not None:
                    arr[k] = xy
        poses.append(arr)
    if unknown:
        raise SystemExit(
            f"{path}: node(s) {sorted(unknown)} are not in the model's skeleton "
            f"{node_names}"
        )
    size = data.get("size") if isinstance(data, dict) else None
    return poses, size


def open_video(video, override):
    """A readable sio.Video for this labels video, or None."""
    for candidate in [override, getattr(video, "filename", None)]:
        if candidate and not isinstance(candidate, list) and Path(candidate).exists():
            try:
                return sio.load_video(str(candidate))
            except Exception:
                pass
    return None


def load_image(path):
    img = cv2.imread(str(path), cv2.IMREAD_UNCHANGED)
    if img is None:
        raise SystemExit(f"cannot read image {path}")
    if img.ndim == 2:
        img = img[..., None]
    elif img.shape[2] == 4:
        img = img[..., :3]
    if img.shape[2] == 3:
        img = img[..., ::-1]  # BGR -> RGB
    return img


def to_tensor(frame, channels, device):
    """(H, W, c) uint8 -> (1, channels, H, W) float in [0, 1]."""
    t = torch.from_numpy(np.ascontiguousarray(frame)).permute(2, 0, 1)[None].float() / 255
    if t.shape[1] == 1 and channels == 3:
        t = t.repeat(1, 3, 1, 1)
    elif t.shape[1] == 3 and channels == 1:
        t = (0.299 * t[:, :1] + 0.587 * t[:, 1:2] + 0.114 * t[:, 2:3])
    return t.to(device)


# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------

GREEN = (80, 220, 80)
MAGENTA = (230, 60, 230)


def to_uint8(image):
    """(1, C, H, W) in [0, 1] -> (H, W, 3) uint8 RGB (grey repeated) for drawing."""
    arr = (image[0].clamp(0, 1).permute(1, 2, 0).cpu().numpy() * 255).round().astype(np.uint8)
    return np.repeat(arr, 3, axis=2) if arr.shape[2] == 1 else arr


def draw_pose(canvas, pose, edges, color, radius=3):
    for i, j in edges:
        if np.isfinite(pose[[i, j]]).all():
            cv2.line(canvas, _pt(pose[i]), _pt(pose[j]), color, 1, cv2.LINE_AA)
    for p in pose:
        if np.isfinite(p).all():
            cv2.circle(canvas, _pt(p), radius, color, -1, cv2.LINE_AA)


def _pt(xy):
    return int(round(float(xy[0]))), int(round(float(xy[1])))


def save_rgb(path, rgb):
    cv2.imwrite(str(path), np.ascontiguousarray(rgb[..., ::-1]))


def colorize(maps):
    """Max over channels of a (K, h, w) heatmap stack -> (h, w, 3) uint8."""
    m = maps.max(dim=0).values.clamp(0, 1).cpu().numpy()
    return cv2.applyColorMap((m * 255).astype(np.uint8), cv2.COLORMAP_INFERNO)[..., ::-1]


def label(img, text):
    img = img.copy()
    cv2.putText(img, text, (6, 18), cv2.FONT_HERSHEY_SIMPLEX, 0.5, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def heatmap_sheet(pair, image, poses, tile=256):
    """Per animal: crop | target heatmaps | model heatmaps; plus the centroid maps."""
    with torch.no_grad():
        terms = objective(pair, image, poses, torch.isfinite(poses).all(-1))
    rows = []
    fit = lambda a: cv2.resize(np.ascontiguousarray(a), (tile, tile), interpolation=cv2.INTER_AREA)
    if "centroid_maps" in terms:
        pred, target = terms["centroid_maps"]
        th = tile
        tw = int(round(tile * pred.shape[-1] / pred.shape[-2]))
        rs = lambda a: cv2.resize(np.ascontiguousarray(a), (tw, th), interpolation=cv2.INTER_AREA)
        frame = to_uint8(image)
        rows.append(
            np.concatenate(
                [
                    label(rs(frame), "frame"),
                    label(rs(colorize(target[0])), "centroid target"),
                    label(rs(colorize(pred[0])), "centroid model"),
                ],
                axis=1,
            )
        )
    if "instance_maps" in terms:
        pred, target, crops = terms["instance_maps"]
        for i in range(len(crops)):
            crop = to_uint8(crops[i : i + 1])
            rows.append(
                np.concatenate(
                    [
                        label(fit(crop), f"animal {i}"),
                        label(fit(colorize(target[i])), "node targets"),
                        label(fit(colorize(pred[i])), "node model"),
                    ],
                    axis=1,
                )
            )
    width = max(r.shape[1] for r in rows)
    rows = [np.pad(r, ((0, 0), (0, width - r.shape[1]), (0, 0))) for r in rows]
    return np.concatenate(rows, axis=0)


def progress_sheet(snapshots, height=240):
    tiles = []
    for step, img in snapshots:
        rgb = to_uint8(img)
        w = int(round(height * rgb.shape[1] / rgb.shape[0]))
        tiles.append(label(cv2.resize(rgb, (w, height), interpolation=cv2.INTER_AREA), f"step {step}"))
    return np.concatenate(tiles, axis=1)


def save_slp(path, png_path, poses, node_names, edges):
    """A one-frame .pkg.slp: the generated image with the requested skeleton."""
    skeleton = sio.Skeleton(
        nodes=list(node_names),
        edges=[(node_names[i], node_names[j]) for i, j in edges],
    )
    video = sio.Video.from_filename([str(png_path)])
    instances = [
        sio.Instance.from_numpy(p.astype(np.float64), skeleton=skeleton) for p in poses
    ]
    labels = sio.Labels(
        labeled_frames=[sio.LabeledFrame(video=video, frame_idx=0, instances=instances)],
        videos=[video],
        skeletons=[skeleton],
    )
    labels.save(str(path), embed="user")


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def pick_device(name):
    if name != "auto":
        return name
    if torch.cuda.is_available():
        return "cuda"
    if torch.backends.mps.is_available():
        return "mps"
    return "cpu"


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Run a SLEAP centroid + centered-instance pair backward: skeleton in, image out.",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    g = ap.add_argument_group("models (at least one)")
    g.add_argument("--centroid", help="centroid model folder (best.ckpt or best_model.h5)")
    g.add_argument("--instance", help="centered-instance model folder")

    g = ap.add_argument_group("pose")
    g.add_argument("--slp", help="take the pose(s) from this .slp ...")
    g.add_argument("--frame", type=int, help="... at this frame index")
    g.add_argument("--video-index", type=int, default=0, help="... of this video in the .slp")
    g.add_argument(
        "--which", choices=["auto", "user", "predicted"], default="auto",
        help="which instances of the frame (auto: user ones if any, else predictions)",
    )
    g.add_argument("--animals", help="keep only these instances of the frame, e.g. 0,2")
    g.add_argument("--pose", help="JSON poses; replaces the .slp's poses (its frame can still be --init)")

    g = ap.add_argument_group("image")
    g.add_argument(
        "--init", default="auto",
        help="start image: exemplar (the background with the best-matching labeled animal "
        "of the .slp pasted at each pose; never the target frame's own), background "
        "(median of the video: the arena with no animals), frame (the .slp's video "
        "frame), gray, noise, or an image file. "
        "auto = exemplar if the video can be read, else gray",
    )
    g.add_argument(
        "--margin", type=float, default=40,
        help="only pixels within this many px of a requested animal may change "
        "(-1: the whole frame)",
    )
    g.add_argument("--background-frames", type=int, default=60, help="frames in the median background")
    g.add_argument(
        "--video",
        help="the .slp video's file, if the path stored in the .slp is stale "
        "(it supplies the frame size, the background and the exemplars)",
    )
    g.add_argument("--size", type=int, nargs=2, metavar=("W", "H"), help="image size if nothing else gives one")

    g = ap.add_argument_group("optimization")
    g.add_argument("--steps", type=int, default=400)
    g.add_argument("--lr", type=float, default=0.02)
    g.add_argument("--levels", type=int, default=6, help="pyramid octaves")
    g.add_argument(
        "--finest", type=int, default=1,
        help="finest octave optimized: 0 = single pixels, 1 = 2 px, 2 = 4 px ...",
    )
    g.add_argument("--jitter", type=int, default=4, help="max random shift per step, px")
    g.add_argument(
        "--no-augment", dest="augment", action="store_false",
        help="don't show each model random rotations/rescalings of its input "
        "(the ranges come from its training config)",
    )
    g.add_argument("--tv", type=float, default=0.05, help="total-variation weight")
    g.add_argument("--keep", type=float, default=0.0, help="weight pulling the image toward --init")
    g.add_argument("--centroid-weight", type=float, default=1.0)
    g.add_argument("--instance-weight", type=float, default=1.0)
    g.add_argument("--seed", type=int, default=0)
    g.add_argument("--device", default="auto", help="auto, cuda, mps or cpu")
    g.add_argument("--log-every", type=int, default=25)

    ap.add_argument("--out", required=True, help="output folder")
    args = ap.parse_args(argv)
    if not (args.centroid or args.instance):
        ap.error("give --centroid, --instance, or both")
    if not (args.slp or args.pose):
        ap.error("give a pose: --slp with --frame, or --pose")
    if args.slp and args.frame is None:
        ap.error("--slp needs --frame")
    if args.init in ("frame", "background", "exemplar") and not args.slp:
        ap.error(f"--init {args.init} needs --slp and --frame (and a readable video)")
    return args


def main(argv=None):
    sys.stdout.reconfigure(line_buffering=True)  # progress shows up live in a log file
    args = parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    device = pick_device(args.device)
    torch.manual_seed(args.seed)

    print(f"Loading models on {device} ...")
    t0 = time.time()
    pair = load_pair(args.centroid, args.instance, device)
    print(f"  loaded in {time.time() - t0:.0f} s; nodes: {', '.join(pair.node_names)}")
    channels = max(s.in_channels for s in (pair.centroid, pair.instance) if s is not None)

    # The pose(s), and whatever can say how big the frame is.
    poses, size, frame = None, None, None
    if args.slp:
        poses, video = poses_from_slp(args.slp, args.frame, args.video_index, pair.node_names, args.which)
        reader = open_video(video, args.video)
        if reader is not None:
            frame = reader[args.frame]
            size = (frame.shape[1], frame.shape[0])
        elif args.init in ("frame", "background", "exemplar"):
            raise SystemExit(
                f"cannot open the video for --init {args.init} ({video.filename}); pass --video PATH"
            )
    if args.init == "auto":
        args.init = "exemplar" if frame is not None else "gray"
    if args.pose:
        poses, json_size = poses_from_json(args.pose, pair.node_names)
        size = json_size or size
    if args.animals:
        keep = [int(i) for i in args.animals.split(",")]
        poses = [poses[i] for i in keep]
    if args.size:
        size = tuple(args.size)
    if size is None and None not in pair.max_hw:
        size = (pair.max_hw[1], pair.max_hw[0])
    if size is None:
        raise SystemExit("cannot tell the image size; pass --size W H")
    if pair.anchor_ind is not None:
        missing = [i for i, p in enumerate(poses) if not np.isfinite(p[pair.anchor_ind]).all()]
        if missing:
            print(
                f"  note: animal(s) {missing} have no {pair.node_names[pair.anchor_ind]}; "
                "their centroid is the bounding-box middle, as in sleap-nn"
            )
    W, H = int(size[0]), int(size[1])

    if args.init == "gray":
        init = torch.full((1, channels, H, W), 0.5, device=device)
    elif args.init == "noise":
        g = torch.Generator().manual_seed(args.seed)
        init = (0.5 + 0.1 * torch.randn((1, channels, H, W), generator=g)).clamp(0, 1).to(device)
    elif args.init == "frame":
        init = to_tensor(frame, channels, device)
    elif args.init in ("background", "exemplar"):
        t = time.time()
        bg = median_background(reader, args.background_frames)
        cv2.imwrite(str(out / "background.png"), bg[..., 0] if bg.shape[2] == 1 else bg[..., ::-1])
        print(f"  median background of {args.background_frames} frames ({time.time() - t:.0f} s)")
        if args.init == "background":
            init = to_tensor(bg, channels, device)
        else:
            pool = exemplar_pool(args.slp, args.video_index, pair.node_names, args.frame)
            init = exemplar_init(bg, poses, pool, reader, pair.edges, device)
            init = to_tensor(to_uint8(init)[..., :channels], channels, device)
    else:
        img = load_image(args.init)
        if (img.shape[1], img.shape[0]) != (W, H):
            img = cv2.resize(img, (W, H), interpolation=cv2.INTER_AREA)
            img = img[..., None] if img.ndim == 2 else img
        init = to_tensor(img, channels, device)

    poses_t = torch.tensor(np.stack(poses), dtype=torch.float32, device=device)
    node_mask = torch.isfinite(poses_t).all(-1)
    print(f"{len(poses)} animal(s), {W}x{H} px, {channels} channel(s), init {args.init}")

    mask = edit_mask(poses, (W, H), args.margin, device)
    image, history, snapshots = optimize(pair, init, poses_t, node_mask, args, mask)

    # Quantize like a saved image would be, then run it forward as sleap-nn would.
    saved_u8 = (image * 255).round().to(torch.uint8)
    saved = saved_u8.float() / 255
    found = recover(pair, saved_u8, poses_t)
    target = np.stack(poses)
    mask = node_mask.cpu().numpy()

    rgb = to_uint8(saved)
    png = out / "image.png"
    if channels == 1:
        cv2.imwrite(str(png), rgb[..., 0])
    else:
        save_rgb(png, rgb)
    overlay = rgb.copy()
    for p in target:
        draw_pose(overlay, p, pair.edges, GREEN)
    if "reported" in found:
        for p in found["reported"]:
            draw_pose(overlay, p, pair.edges, MAGENTA, radius=2)
    save_rgb(out / "overlay.png", overlay)
    save_rgb(out / "heatmaps.png", heatmap_sheet(pair, saved, poses_t))
    save_rgb(out / "progress.png", progress_sheet(snapshots))
    try:
        save_slp(out / "backward.pkg.slp", png, target, pair.node_names, pair.edges)
    except Exception as e:  # the image is the deliverable; the .slp is a convenience
        print(f"  could not write backward.pkg.slp: {e}")

    report = {
        "args": vars(args),
        "device": device,
        "nodes": pair.node_names,
        "size": [W, H],
        "final": history[-1] if history else None,
        "history": history,
        "target_poses": np.where(np.isfinite(target), target, None).tolist(),
    }
    print("Round trip (run forward again on the saved image):")
    with torch.no_grad():
        terms = objective(pair, saved, poses_t, node_mask)
    report["heatmap_error"] = {k: terms[k].item() for k in ("centroid", "instance") if k in terms}
    print(
        "  heatmap error (0 = exactly the target, 1 = nothing there): "
        + ", ".join(f"{k} {v:.3f}" for k, v in report["heatmap_error"].items())
    )
    if found.get("centroids") is not None:
        report["centroids_found"] = found["centroids"].tolist()
        print(f"  centroid model finds {len(found['centroids'])} animal(s) (asked for {len(poses)})")
        if found.get("centroid_dist") is not None:
            report["centroid_error_px"] = found["centroid_dist"].tolist()
            print(f"  centroid error, px: {np.round(found['centroid_dist'], 2).tolist()}")
    if "reported" in found:
        err = node_errors(found["reported"], target, mask)
        report["node_error_px"] = np.where(np.isfinite(err), err, None).tolist()
        report["nodes_found"] = np.where(np.isfinite(found["reported"]), found["reported"], None).tolist()
        print(f"  node error: median {np.nanmedian(err):.2f} px, max {np.nanmax(err):.2f} px")
        report["node_scores"] = found["scores"].tolist()
        print(f"  node scores: median {np.nanmedian(found['scores']):.2f}, min {np.nanmin(found['scores']):.2f}")
    (out / "report.json").write_text(json.dumps(report, indent=1))
    print(f"Wrote {out}/: image.png, overlay.png, heatmaps.png, progress.png, report.json, backward.pkg.slp")


if __name__ == "__main__":
    main()
