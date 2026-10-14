#!/usr/bin/env python3
# /// script
# requires-python = ">=3.11"
# dependencies = ["sleap-nn>=0.2.0", "matplotlib", "scipy"]
# ///
"""
Compare centroid models for hallucination: does training with negative frames help?

sleap-nn's `use_negative_frames` adds user-confirmed empty frames to a centroid
model's training so it stops seeing animals in an empty arena. This measures
that, for two or more centroid models on the same video, three ways:

  1. Empty images. Detections and peak confidence on images with no animal: the
     video's median background (the arena, animals removed), the .slp's frames
     marked negative for this video, any --empty-frames ranges and --empty-image
     files.
  2. Real frames. Recall, precision and centroid error on the video's labeled
     frames — a model that never fires is "hard to fool" for free, so this is the
     other half of the trade-off. Frames in a model's own training set
     (labels_gt.train*.slp in its folder) are reported separately.
  3. Hallucination effort. At several empty floor spots (where labeled animals
     stood on other frames), run the model BACKWARD (scripts/sleap_backward.py):
     change the pixels of a disc around the spot, from the median background,
     until sleap-nn's own inference reports an animal anywhere in the disc. How
     much the pixels had to change (RMS grey levels in the disc) is how hard the
     model is to fool; a spot where it held out past --max-change is a lower
     bound. Each model gets the same spots, the same start image, the same random
     views and the same step size, so the numbers compare. Dark spots move
     slower (the image is a sigmoid, flat near black): compare models spot by
     spot, not spots with each other.

Usage:

    PY=~/.local/share/uv/tools/sleap-nn/bin/python
    $PY scripts/sleap_negatives_compare.py \\
        --model without=models/xxx.centroid.n=100 \\
        --model with=models/yyy.centroid.n=100 \\
        --slp labels.slp --video-index 1 --out compare/

    # Empty stretches of the video (e.g. before the animals went in) as more negatives:
    $PY scripts/sleap_negatives_compare.py ... --empty-frames 0-1800

Outputs, in --out:
    summary.md          the comparison table
    hallucination.png   confidence at each spot vs how much the pixels changed,
                        and the change it took to fool each model
    fakes.png           what each model was fooled by, per spot
    empty.png           each model's centroid heatmap on the median background
    report.json         everything, per model and per spot

Requires: sleap-nn (torch, sleap-io, opencv), matplotlib, scipy.
"""

import os

os.environ.setdefault("PYTORCH_ENABLE_MPS_FALLBACK", "1")

import argparse
import glob
import json
import sys
import time
import warnings
from pathlib import Path

import numpy as np

sys.path.insert(0, str(Path(__file__).resolve().parent))
import sleap_backward as sb  # noqa: E402  (its import guard explains a missing sleap-nn)

import cv2  # noqa: E402
import sleap_io as sio  # noqa: E402
import torch  # noqa: E402
from omegaconf import OmegaConf  # noqa: E402
from scipy.optimize import linear_sum_assignment  # noqa: E402
from sleap_nn.inference.peak_finding import find_local_peaks  # noqa: E402

# A spot the model held out on, whose confidence never rose above this, gave the
# optimizer no slope to climb: that is "flat here", not "resisted". A gradient probe
# cannot tell the two apart, so the report must not count one as the other.
FLAT_CONFIDENCE = 0.05

# Reference categorical palette, light surface (validated all-pairs for slots 1-3).
SERIES = ["#2a78d6", "#eb6834", "#1baf7a", "#eda100", "#e87ba4", "#008300", "#4a3aa7", "#e34948"]
SURFACE, TEXT, TEXT_2, GRID = "#fcfcfb", "#0b0b0b", "#52514e", "#e4e3df"


# ---------------------------------------------------------------------------
# Model facts
# ---------------------------------------------------------------------------


def model_facts(model_dir):
    """What the training config says about negative frames, and the training set."""
    d = Path(model_dir)
    facts = {"folder": d.name, "negative_frames": None, "negative_loss_weight": None}
    if (d / "training_config.yaml").exists():
        cfg = OmegaConf.load(d / "training_config.yaml")
        data = cfg.data_config
        facts["negative_frames"] = bool(data.get("use_negative_frames", False))
        facts["negative_loss_weight"] = float(data.get("negative_loss_weight", 1.0))
        facts["sleap_nn_version"] = cfg.get("sleap_nn_version")
        backbone = next(v for v in cfg.model_config.backbone_config.values() if v is not None)
        facts["params"] = cfg.model_config.get("total_params")
        facts["filters"] = backbone.get("filters")
    else:  # SLEAP <= 1.4: the option did not exist
        facts["negative_frames"] = False
    train, n_neg = set(), 0
    files = sorted(glob.glob(str(d / "labels_gt.train*.slp")))
    try:
        for f in files:
            labels = sio.load_slp(f, open_videos=False)
            for lf in labels.labeled_frames:
                train.add((_video_key(lf.video), lf.frame_idx))
            n_neg += len(getattr(labels, "negative_frames", []) or [])
    except Exception as e:  # only says which frames it trained on; not worth failing over
        print(f"  note: cannot read its training labels ({type(e).__name__}: {e}); "
              "held-out frames unknown")
        train, files = None, []
    facts["train_frames"] = train
    facts["train_negative_frames"] = n_neg if files else None
    return facts


def _video_key(video):
    name = video.filename if isinstance(video.filename, str) else video.filename[0]
    return name.replace("\\", "/").split("/")[-1]


# ---------------------------------------------------------------------------
# The three measurements
# ---------------------------------------------------------------------------


@torch.no_grad()
def detect(pair, image_u8):
    """sleap-nn's centroid inference on one uint8 image (1, C, H, W).

    Returns (centroids (n, 2) in video px, their peak values (n,), the heatmap,
    the factor from video px to heatmap cells).
    """
    st = pair.centroid
    img, eff = sb.size_match(pair, image_u8)
    cms, _ = sb.run_stage(st, img)
    peaks, vals, _, _ = find_local_peaks(
        cms.cpu(), threshold=sb.PEAK_THRESHOLD, refinement="integral",
        integral_patch_size=sb.INTEGRAL_PATCH,
    )
    to_grid = eff * st.scale / st.output_stride
    return (peaks / to_grid).numpy(), vals.numpy(), cms[0, 0].cpu().numpy(), to_grid


def confidence_near(cms, to_grid, xy, tol):
    """Highest heatmap value within `tol` video px of `xy` (a square window)."""
    gx, gy = xy[0] * to_grid, xy[1] * to_grid
    r = max(1, int(np.ceil(tol * to_grid)))
    h, w = cms.shape
    y0, y1 = max(0, int(gy) - r), min(h, int(gy) + r + 2)
    x0, x1 = max(0, int(gx) - r), min(w, int(gx) + r + 2)
    return float(cms[y0:y1, x0:x1].max()) if y1 > y0 and x1 > x0 else 0.0


def empty_images_check(pair, empties, device):
    rows = []
    for name, frame in empties:
        u8 = torch.from_numpy(np.ascontiguousarray(frame)).permute(2, 0, 1)[None].to(device)
        pts, vals, cms, _ = detect(pair, u8)
        rows.append({"image": name, "detections": int(len(pts)), "max_confidence": float(cms.max())})
    return rows


def labeled_frames_check(pair, frames, tol, device, train):
    """Recall / precision / centroid error against the labeled anchors.

    `frames` holds (frame_idx, image, user instances); each model reads the
    instances in its own node order, so models with different skeletons compare.
    """
    out = {"all": [], "held_out": []}
    for fidx, frame, insts in frames:
        poses = np.stack([sb.instance_to_array(x, pair.node_names) for x in insts])
        u8 = torch.from_numpy(np.ascontiguousarray(frame)).permute(2, 0, 1)[None].to(device)
        pts, vals, _, _ = detect(pair, u8)
        want = sb.centroids_of(pair, torch.tensor(poses, dtype=torch.float32)).numpy()
        want = want[np.isfinite(want).all(-1)]
        tp, errs = 0, []
        if len(pts) and len(want):
            d = np.linalg.norm(want[:, None] - pts[None], axis=-1)
            r, c = linear_sum_assignment(d)
            ok = d[r, c] <= tol
            tp, errs = int(ok.sum()), d[r, c][ok].tolist()
        row = (tp, len(want), len(pts), errs)
        out["all"].append(row)
        if train is not None and fidx not in train:
            out["held_out"].append(row)

    def score(rows):
        if not rows:
            return None
        tp = sum(r[0] for r in rows)
        n_true = sum(r[1] for r in rows)
        n_found = sum(r[2] for r in rows)
        errs = [e for r in rows for e in r[3]]
        return {
            "frames": len(rows),
            "animals": n_true,
            "recall": tp / n_true if n_true else None,
            "precision": tp / n_found if n_found else None,
            "false_detections": n_found - tp,
            "median_error_px": float(np.median(errs)) if errs else None,
        }

    return {k: score(v) for k, v in out.items()}


def hallucinate(pair, background, spot, radius, args, seed, device):
    """Change a disc around `spot` until sleap-nn reports an animal in it.

    Anywhere in the disc counts, not only at the spot: outside it nothing changed,
    so any animal reported there is one the model was talked into seeing.

    Same machinery as sleap_backward: the model's own training loss with a single
    centroid target, pyramid parameterization, the views it was trained on.
    Returns the step and pixel change at which it was fooled (or None), the
    confidence/change curve, and the final image.
    """
    W, H = background.shape[-1], background.shape[-2]
    pose = np.full((1, len(pair.node_names), 2), np.nan)
    pose[0, pair.anchor_ind if pair.anchor_ind is not None else 0] = spot
    poses = torch.tensor(pose, dtype=torch.float32, device=device)
    node_mask = torch.isfinite(poses).all(-1)
    mask = sb.edit_mask([pose[0]], (W, H), radius, device)
    img_param = sb.PyramidImage(background, args.levels, mask, args.finest)
    opt = torch.optim.Adam(img_param.parameters(), lr=args.lr)
    gen = torch.Generator().manual_seed(seed)
    weight = mask.sum()
    curve, result = [], None
    for step in range(args.max_steps + 1):
        image = img_param()
        u8 = (image.detach() * 255).round().to(torch.uint8)
        pts, vals, cms, to_grid = detect(pair, u8)
        change = float(torch.sqrt((((u8.float() / 255 - background) ** 2) * mask).sum() / weight) * 255)
        conf = confidence_near(cms, to_grid, spot, radius)
        curve.append((step, change, conf))
        hit = len(pts) and (np.linalg.norm(pts - spot, axis=-1) <= radius).any()
        if hit or step == args.max_steps or change >= args.max_change:
            result = {"fooled": bool(hit), "steps": step if hit else None,
                      "change": change if hit else None, "confidence": conf,
                      "gave_up": None if hit else ("change" if change >= args.max_change else "steps")}
            break
        j = args.jitter
        dx, dy = (torch.randint(-j, j + 1, (2,), generator=gen).tolist() if j else (0, 0))
        shifted = torch.roll(image, shifts=(dy, dx), dims=(2, 3)) if j else image
        shift = torch.tensor([dx, dy], dtype=torch.float32, device=device)
        terms = sb.objective(pair, shifted, poses + shift, node_mask, gen if args.augment else None)
        loss = terms["centroid"] + args.tv * sb.total_variation(image)
        opt.zero_grad(set_to_none=True)
        loss.backward()
        opt.step()
    result["curve"] = curve
    result["no_gradient"] = (not result["fooled"]) and max(c[2] for c in curve) < FLAT_CONFIDENCE
    return result, u8


# ---------------------------------------------------------------------------
# Inputs
# ---------------------------------------------------------------------------


def floor_spots(poses_by_frame, anchor_ind, k):
    """`k` spread-out places where labeled animals stood: floor the camera sees."""
    pts = []
    for poses in poses_by_frame:
        for p in poses:
            c = p[anchor_ind] if anchor_ind is not None else np.nanmean(p, axis=0)
            if np.isfinite(c).all():
                pts.append(c)
    pts = np.array(pts)
    if len(pts) == 0:
        raise SystemExit("no labeled animals in this video to place the spots")
    chosen = [int(np.argmin(np.linalg.norm(pts - pts.mean(0), axis=-1)))]
    while len(chosen) < min(k, len(pts)):
        d = np.min(np.linalg.norm(pts[:, None] - pts[chosen][None], axis=-1), axis=1)
        chosen.append(int(np.argmax(d)))
    return pts[chosen]


def parse_ranges(text, n_frames, per_range=10):
    """'0-1800,5000-5100' -> up to `per_range` evenly spaced frames from each range."""
    frames = []
    for part in text.split(","):
        a, _, b = part.strip().partition("-")
        lo, hi = int(a), int(b or a)
        hi = min(hi, n_frames - 1)
        frames += np.unique(np.linspace(lo, hi, min(per_range, hi - lo + 1)).round().astype(int)).tolist()
    return frames


# ---------------------------------------------------------------------------
# Outputs
# ---------------------------------------------------------------------------


def chart(models, path):
    """Confidence vs pixel change per spot, and the change it took to fool each model."""
    import matplotlib

    matplotlib.use("Agg")
    import matplotlib.pyplot as plt

    plt.rcParams.update({"font.size": 10, "text.color": TEXT, "axes.labelcolor": TEXT_2,
                         "xtick.color": TEXT_2, "ytick.color": TEXT_2})
    fig, (ax1, ax2) = plt.subplots(
        1, 2, figsize=(11, 4.4), dpi=150, gridspec_kw={"width_ratios": [1.5, 1]}, facecolor=SURFACE
    )
    for ax in (ax1, ax2):
        ax.set_facecolor(SURFACE)
        for side in ("top", "right"):
            ax.spines[side].set_visible(False)
        for side in ("left", "bottom"):
            ax.spines[side].set_color(GRID)
        ax.grid(True, color=GRID, linewidth=0.8)
        ax.set_axisbelow(True)

    max_change = max(
        [c[1] for m in models for s in m["spots"] for c in s["curve"]] + [1.0]
    )
    for i, m in enumerate(models):
        color = SERIES[i % len(SERIES)]
        for k, s in enumerate(m["spots"]):
            xs = [c[1] for c in s["curve"]]
            ys = [c[2] for c in s["curve"]]
            ax1.plot(xs, ys, color=color, linewidth=1.6, alpha=0.75,
                     label=m["name"] if k == 0 else None, solid_capstyle="round")
            if s["fooled"]:
                ax1.plot(xs[-1], ys[-1], "o", color=color, markersize=6,
                         markeredgecolor=SURFACE, markeredgewidth=1.5)
    ax1.axhline(sb.PEAK_THRESHOLD, color=TEXT_2, linewidth=1, linestyle=(0, (4, 3)))
    ax1.text(0.2, sb.PEAK_THRESHOLD + 0.015, "sleap-nn reports an animal above this",
             ha="left", va="bottom", color=TEXT_2, fontsize=9)
    ax1.set_xlim(0, max_change * 1.02)
    ax1.set_ylim(0, 1)
    ax1.set_xlabel("pixel change in the disc (RMS grey levels)")
    ax1.set_ylabel("highest centroid confidence in the disc")
    ax1.set_title("Making each model see an animal that isn't there", loc="left",
                  color=TEXT, fontsize=11)
    ax1.legend(frameon=False, loc="upper left")

    names = [m["name"] for m in models]
    for i, m in enumerate(models):
        color = SERIES[i % len(SERIES)]
        y = len(models) - 1 - i
        fooled = [s["change"] for s in m["spots"] if s["fooled"]]
        missed = [s for s in m["spots"] if not s["fooled"]]
        jitter = np.linspace(-0.15, 0.15, max(len(m["spots"]), 2))
        for k, s in enumerate(m["spots"]):
            if s["fooled"]:
                ax2.plot(s["change"], y + jitter[k], "o", color=color, markersize=7,
                         markeredgecolor=SURFACE, markeredgewidth=1.5)
            elif s.get("no_gradient"):  # no slope to climb: not evidence of robustness
                ax2.plot(s["curve"][-1][1], y + jitter[k], "x", markersize=7,
                         color=color, markeredgewidth=1.5)
            else:  # a lower bound: it resisted at least this much change
                ax2.plot(s["curve"][-1][1], y + jitter[k], ">", markersize=8,
                         markerfacecolor="none", markeredgecolor=color, markeredgewidth=1.5)
        if fooled:
            med = float(np.median(fooled))
            ax2.plot([med, med], [y - 0.3, y + 0.3], color=TEXT, linewidth=2)
        note = f"{len(fooled)}/{len(m['spots'])} fooled"
        flat = sum(bool(s.get("no_gradient")) for s in missed)
        if flat:
            note += f"; × = no gradient to follow ({flat})"
        if len(missed) > flat:
            note += f"; ▷ = resisted at least this much ({len(missed) - flat})"
        ax2.text(0, y - 0.42, note, color=TEXT_2, fontsize=8.5, va="top")
    ax2.set_yticks(range(len(models)))
    ax2.set_yticklabels(names[::-1], color=TEXT)
    ax2.set_ylim(-0.8, len(models) - 0.4)
    ax2.set_xlim(0, max_change * 1.05)
    ax2.set_xlabel("change it took (RMS grey levels; bar = median)")
    ax2.set_title("Higher = harder to fool", loc="left", color=TEXT, fontsize=11)
    fig.tight_layout()
    fig.savefig(path, facecolor=SURFACE)
    plt.close(fig)


def label(img, text, scale=0.5):
    img = img.copy()
    cv2.putText(img, text, (5, 16), cv2.FONT_HERSHEY_SIMPLEX, scale, (0, 0, 0), 3, cv2.LINE_AA)
    cv2.putText(img, text, (5, 16), cv2.FONT_HERSHEY_SIMPLEX, scale, (255, 255, 255), 1, cv2.LINE_AA)
    return img


def fakes_sheet(models, spots, radius, background, tile=180, gain=4):
    """Per model: what fooled it at each spot, and the change from the empty arena x`gain`."""
    base = background.float()

    def crop_at(rgb, xy):
        x, y = int(round(xy[0])), int(round(xy[1]))
        r = int(radius * 1.2)
        crop = np.zeros((2 * r, 2 * r, 3), np.uint8)
        H, W = rgb.shape[:2]
        y0, y1, x0, x1 = max(0, y - r), min(H, y + r), max(0, x - r), min(W, x + r)
        crop[y0 - (y - r) : y1 - (y - r), x0 - (x - r) : x1 - (x - r)] = rgb[y0:y1, x0:x1]
        return cv2.resize(crop, (tile, tile), interpolation=cv2.INTER_AREA)

    rows = []
    for m in models:
        top, bottom = [], []
        for s, xy, img in zip(m["spots"], spots, m["fake_images"]):
            fake = img.float()
            text = f"step {s['steps']}, {s['change']:.0f} gl" if s["fooled"] else "not fooled"
            top.append(label(crop_at(sb.to_uint8(fake / 255), xy), text))
            diff = ((fake - base) * gain / 255 + 0.5).clamp(0, 1)
            bottom.append(label(crop_at(sb.to_uint8(diff), xy), f"change x{gain}"))
        row = np.concatenate([np.concatenate(top, axis=1), np.concatenate(bottom, axis=1)], axis=0)
        head = np.full((26, row.shape[1], 3), 255, np.uint8)
        cv2.putText(head, m["name"], (5, 19), cv2.FONT_HERSHEY_SIMPLEX, 0.6, (0, 0, 0), 1, cv2.LINE_AA)
        rows.append(np.concatenate([head, row], axis=0))
    return np.concatenate(rows, axis=0)


def empty_sheet(models, background, width=420):
    tiles = []
    bg = sb.to_uint8(background)
    h = int(round(width * bg.shape[0] / bg.shape[1]))
    for m in models:
        cms = m["empty_heatmap"]
        heat = cv2.applyColorMap((np.clip(cms, 0, 1) * 255).astype(np.uint8), cv2.COLORMAP_INFERNO)[..., ::-1]
        heat = cv2.resize(heat, (bg.shape[1], bg.shape[0]), interpolation=cv2.INTER_LINEAR)
        mix = (0.55 * bg + 0.45 * heat).astype(np.uint8)
        mix = cv2.resize(mix, (width, h), interpolation=cv2.INTER_AREA)
        e = m["empty"][0]
        tiles.append(label(mix, f"{m['name']}: {e['detections']} detections, max {e['max_confidence']:.2f}"))
    return np.concatenate(tiles, axis=1)


def fmt(v, spec="{:.2f}", none="—"):
    return none if v is None else spec.format(v)


def negatives_note(facts):
    if not facts["negative_frames"]:
        return "no"
    note = f"yes (weight {facts['negative_loss_weight']:g}"
    if facts["train_negative_frames"] is not None:
        note += f", {facts['train_negative_frames']} frames"
    return note + ")"


def summary_table(models, n_spots):
    head = "| | " + " | ".join(m["name"] for m in models) + " |"
    sep = "|---|" + "---|" * len(models)
    rows = [head, sep]

    def row(label_, values):
        rows.append(f"| {label_} | " + " | ".join(values) + " |")

    row("trained with negative frames", [negatives_note(m["facts"]) for m in models])
    for k, name in enumerate(models[0]["empty"]):
        row(f"empty: {name['image']} — detections / max conf", [
            f"{m['empty'][k]['detections']} / {m['empty'][k]['max_confidence']:.2f}" for m in models])
    for split, what in [("all", "labeled frames"), ("held_out", "labeled frames not trained on")]:
        if all(m["real"][split] is None for m in models):
            continue
        row(f"{what}: recall / precision", [
            "—" if m["real"][split] is None else
            f"{fmt(m['real'][split]['recall'])} / {fmt(m['real'][split]['precision'])} "
            f"(n={m['real'][split]['animals']})" for m in models])
        row(f"{what}: false detections / median error", [
            "—" if m["real"][split] is None else
            f"{m['real'][split]['false_detections']} / {fmt(m['real'][split]['median_error_px'], '{:.1f} px')}"
            for m in models])
    def fooled_note(m):
        flat = sum(bool(s.get("no_gradient")) for s in m["spots"])
        note = f"{sum(s['fooled'] for s in m['spots'])}/{n_spots}"
        return note + (f" ({flat} gave no gradient)" if flat else "")

    row("hallucination: spots fooled", [fooled_note(m) for m in models])
    row("hallucination: median steps / pixel change to fool", [
        (lambda f: "—" if not f else f"{np.median([s['steps'] for s in f]):.0f} / "
         f"{np.median([s['change'] for s in f]):.1f} grey levels")([s for s in m["spots"] if s["fooled"]])
        for m in models])
    return "\n".join(rows)


# ---------------------------------------------------------------------------
# CLI
# ---------------------------------------------------------------------------


def model_spec(item):
    """'NAME=DIR' or 'DIR' -> (name, dir). SLEAP folder names contain '=' themselves
    (`...centroid.n=100`), so the split is the first '=' whose right side exists."""
    if Path(item).is_dir():
        return Path(item).name, item
    for i, ch in enumerate(item):
        if ch == "=" and Path(item[i + 1 :]).is_dir():
            return item[:i], item[i + 1 :]
    raise SystemExit(f"--model {item!r}: no such model folder")


def parse_args(argv=None):
    ap = argparse.ArgumentParser(
        description="Compare centroid models for hallucination on empty arena "
        "(e.g. trained with vs without negative frames).",
        formatter_class=argparse.ArgumentDefaultsHelpFormatter,
    )
    ap.add_argument("--model", action="append", required=True, metavar="[NAME=]DIR",
                    help="a centroid model folder; repeat for each model to compare")
    ap.add_argument("--slp", required=True, help="labels with the video's labeled (and negative) frames")
    ap.add_argument("--video-index", type=int, default=0)
    ap.add_argument("--video", help="the video's file, if the path stored in the .slp is stale")
    ap.add_argument("--empty-frames", help="frame ranges of the video with no animal, e.g. 0-1800")
    ap.add_argument("--empty-image", action="append", default=[], help="an image with no animal")
    ap.add_argument("--spots", type=int, default=8, help="empty floor spots to try to fool each model at")
    ap.add_argument(
        "--max-change", type=float, default=40,
        help="give up on a spot once the disc has changed this much (RMS grey levels): "
        "the model resisted that big a change",
    )
    ap.add_argument("--max-steps", type=int, default=300, help="...or after this many steps")
    ap.add_argument("--eval-frames", type=int, default=25, help="labeled frames to measure recall on")
    ap.add_argument("--background-frames", type=int, default=60)
    ap.add_argument("--lr", type=float, default=0.05, help="step size (faster than sleap_backward's: no realism needed)")
    ap.add_argument("--levels", type=int, default=6)
    ap.add_argument("--finest", type=int, default=1)
    ap.add_argument("--jitter", type=int, default=4)
    ap.add_argument("--tv", type=float, default=0.05)
    ap.add_argument("--no-augment", dest="augment", action="store_false")
    ap.add_argument("--seed", type=int, default=0)
    ap.add_argument("--device", default="auto")
    ap.add_argument("--out", required=True)
    return ap.parse_args(argv)


def main(argv=None):
    sys.stdout.reconfigure(line_buffering=True)
    warnings.filterwarnings("ignore", message=".*not currently supported on the MPS backend.*")
    args = parse_args(argv)
    out = Path(args.out)
    out.mkdir(parents=True, exist_ok=True)
    device = sb.pick_device(args.device)

    specs = [model_spec(item) for item in args.model]

    labels = sio.load_slp(args.slp, open_videos=False)
    video = labels.videos[args.video_index]
    reader = sb.open_video(video, args.video)
    if reader is None:
        raise SystemExit(f"cannot open the video ({video.filename}); pass --video PATH")
    key = _video_key(video)

    t = time.time()
    bg_np = sb.median_background(reader, args.background_frames)
    cv2.imwrite(str(out / "background.png"), bg_np[..., 0] if bg_np.shape[2] == 1 else bg_np[..., ::-1])
    print(f"Median background of {args.background_frames} frames ({time.time() - t:.0f} s)")

    empties = [("median background", bg_np)]
    negs = [lf for lf in (getattr(labels, "negative_frames", []) or []) if lf.video is video]
    empties += [(f"negative frame {lf.frame_idx}", reader[lf.frame_idx]) for lf in negs]
    if args.empty_frames:
        empties += [(f"empty frame {f}", reader[f]) for f in parse_ranges(args.empty_frames, len(reader))]
    for p in args.empty_image:
        empties.append((Path(p).name, sb.load_image(p)))
    print(f"Empty images: median background + {len(negs)} negative frame(s) in the .slp"
          + (f" + {len(empties) - 1 - len(negs)} other(s)" if len(empties) - 1 - len(negs) else ""))

    models = []
    spots = radius = tol = frames = None
    for i, (name, path) in enumerate(specs):
        print(f"\n== {name}  ({path})")
        t = time.time()
        pair = sb.load_pair(path, None, device)
        facts = model_facts(path)
        print(f"  loaded in {time.time() - t:.0f} s; trained with negative frames: "
              f"{'yes' if facts['negative_frames'] else 'no'}")
        if spots is None:  # the first model's skeleton sets up the shared inputs
            labeled = [lf for lf in labels.labeled_frames if lf.video is video and lf.user_instances]
            poses = [np.stack([sb.instance_to_array(x, pair.node_names) for x in lf.user_instances])
                     for lf in labeled]
            half = [np.nanmax(np.linalg.norm(p - np.nanmean(p, 0), axis=-1)) for ps in poses for p in ps]
            half = float(np.nanmedian(half))
            radius = half + 30
            tol = max(10.0, 0.25 * half)
            spots = floor_spots(poses, pair.anchor_ind, args.spots)
            pick = np.unique(np.linspace(0, len(labeled) - 1, min(args.eval_frames, len(labeled))).round().astype(int))
            frames = [(labeled[j].frame_idx, reader[labeled[j].frame_idx], labeled[j].user_instances)
                      for j in pick]
            print(f"  {len(spots)} floor spots, disc radius {radius:.0f} px; {len(frames)} labeled "
                  f"frames, a detection within {tol:.0f} px of a labeled animal counts")
        bg = sb.to_tensor(bg_np, bg_np.shape[2], device)  # the model converts channels itself

        empty = empty_images_check(pair, empties, device)
        _, _, empty_heatmap, _ = detect(pair, torch.from_numpy(bg_np).permute(2, 0, 1)[None].to(device))
        print(f"  median background: {empty[0]['detections']} detection(s), max confidence "
              f"{empty[0]['max_confidence']:.3f}")
        train = (None if facts["train_frames"] is None
                 else {f for (v, f) in facts["train_frames"] if v == key})
        real = labeled_frames_check(pair, frames, tol, device, train)
        a = real["all"]
        seen = None if train is None else sum(f in train for f, _, _ in frames)
        print(f"  labeled frames: recall {fmt(a['recall'])}, precision {fmt(a['precision'])}, "
              f"median error {fmt(a['median_error_px'], '{:.1f} px')}"
              + (f" ({seen} of {len(frames)} frames in its training set)" if seen is not None
                 else " (its training set is unknown)"))

        results, images = [], []
        for k, xy in enumerate(spots):
            t = time.time()
            r, img = hallucinate(pair, bg, xy, radius, args, args.seed + k, device)
            results.append(r)
            images.append(img.cpu())
            end = r["curve"][-1]
            print(f"  spot {k} ({xy[0]:.0f}, {xy[1]:.0f}): "
                  + (f"fooled at step {r['steps']}, change {r['change']:.1f} grey levels"
                     if r["fooled"] else f"not fooled by a {end[1]:.1f}-grey-level change in {end[0]} "
                     f"steps (confidence {r['confidence']:.2f}"
                     + ("; no gradient to follow" if r["no_gradient"] else "") + ")")
                  + f"  ({time.time() - t:.0f} s)")
        models.append({"name": name, "path": path, "facts": facts, "empty": empty, "real": real,
                       "spots": results, "fake_images": images, "empty_heatmap": empty_heatmap})
        del pair
        if device == "mps":
            torch.mps.empty_cache()
        elif device == "cuda":
            torch.cuda.empty_cache()

    table = summary_table(models, len(spots))
    table += (f"\n\nA spot counts as not fooled once its disc changed by {args.max_change:g} grey "
              f"levels RMS or after {args.max_steps} steps without a detection. \"Gave no "
              f"gradient\": its confidence never rose above {FLAT_CONFIDENCE:g}, so the probe "
              "found no slope to climb there — that is not evidence the model resisted.")
    print("\n" + table)
    (out / "summary.md").write_text(
        f"# Hallucination comparison\n\nVideo `{key}`; {len(spots)} floor spots, "
        f"{len(frames)} labeled frames.\n\n{table}\n"
    )
    chart(models, out / "hallucination.png")
    bg_u8 = torch.from_numpy(np.ascontiguousarray(bg_np)).permute(2, 0, 1)[None]
    sb.save_rgb(out / "fakes.png", fakes_sheet(models, spots, radius, bg_u8))
    sb.save_rgb(out / "empty.png", empty_sheet(models, sb.to_tensor(bg_np, 3, "cpu")))
    report = {
        "args": vars(args), "video": key, "spots": spots.tolist(), "disc_radius_px": radius,
        "detection_tolerance_px": tol, "eval_frames": [f for f, _, _ in frames],
        "models": [{k: v for k, v in m.items() if k not in ("fake_images", "empty_heatmap")}
                   | {"facts": {k: v for k, v in m["facts"].items() if k != "train_frames"}}
                   for m in models],
    }
    (out / "report.json").write_text(json.dumps(report, indent=1, default=float))
    print(f"\nWrote {out}/: summary.md, hallucination.png, fakes.png, empty.png, report.json")


if __name__ == "__main__":
    main()
