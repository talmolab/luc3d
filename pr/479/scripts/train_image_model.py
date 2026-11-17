#!/usr/bin/env python3
"""Train an image model for LUCID's image ID-switch check on ONE rig's own recordings, and write it as a model
package the app loads (ID Switches tab > Image model > Change... > Load package folder...).

No labels are needed. The input is tracked pose files: one .slp per camera per recording, whose tracks follow each
animal within that camera (SLEAP's tracker, or LUCID's By Cam export after Track All):

  * a positive pair = two crops of the same track STRETCH, 1-10 s apart; a stretch ends at a gap over 1 s;
  * the negatives = the other animals in the same frame, which are different animals whatever their labels say.

Tracks may contain swaps. --contact N also ends a stretch at every contact with another animal (body centres closer
than N x body length, the frames within 0.5 s of it left out), so a positive never spans a place where the track could
have swapped. It is OFF by default because on the SLAP rig it cost accuracy: it halved the training frames and dropped
the hardest positives, those just after a contact (2026-11-04, 11 held-out recordings: d' 4.92 with --contact 1 vs
5.85 without, the training study's own model 5.90; frozen dinov2-small 3.89). Turn it on for a rig whose tracker
swaps often.

Steps: cut LUCID's crops (the app's geometry: masked, pose-aligned, 160 px grey), fine-tune the base model's last
--blocks transformer blocks with that contrastive loss (the 2026-11-03 training study's recipe: 3,000 steps, learning
rate 2e-5 on the blocks, a 384-384-128 head trained at 1e-3 and thrown away), score held-out files against the
frozen model, export ONNX (fp32) and write lucid-model.json (scripts/make_image_model_package.py).

Fine-tuning helps on the rig it was trained on and not elsewhere (2026-11-04: SLAP same-coat separation 0.86 -> 0.97;
no gain on other rigs), so train one model per rig, from several of its recordings, and keep a recording or two out
with --holdout to see the gain.

Needs a CUDA GPU (about 6 min on an RTX 6000 Ada, 3,000 steps) and: torch, transformers, sleap-io, av, opencv-python,
numpy, onnx (onnxruntime optional: checks the export). Nodes named Nose and TTI are required, as in the app.

Example:
    python scripts/train_image_model.py out/rig1-model --labels rec1/*/*.slp rec2/*/*.slp \\
        --holdout rec3/*/*.slp --name "Rig 1, fine-tuned dinov2-small"
Then load out/rig1-model in LUCID, run Check ID Switches (Images) on a held-out recording, and adjust the package's
threshold (lucid-model.json) if it flags too much or too little.
"""
import argparse
import glob
import hashlib
import json
import math
import os
import sys
import time

import numpy as np

CROP = 160
CROP_RULE = 2       # bump when the crop changes (part of the crop cache key); 2 = tail nodes t0/t1/... left out
NOSE, TTI = 'Nose', 'TTI'
BASES = {
    # name: (Hugging Face model, input side, license, flag threshold the app uses for it frozen)
    'dinov2-small': ('facebook/dinov2-small', 168, 'Apache-2.0', -1.0),
    'dinov3-vits16': ('facebook/dinov3-vits16-pretrain-lvd1689m', 192, 'DINOv3 License', -1.2),
}
MEAN, STD = (0.485, 0.456, 0.406), (0.229, 0.224, 0.225)
T0 = time.time()


def log(*a):
    print(f'[{time.time() - T0:7.0f}s]', *a, flush=True)


# ---- crops (ui/image-embedder.js cropGeometry + cutCrop) ------------------------------------------------------------

def is_tail_node(name):
    """pose/id-switch-check.js isTailNode: a name starting with "tail", or `t` and a number (t0, t1, ...)."""
    n = name.lower()
    return n.startswith('tail') or (len(n) > 1 and n[0] == 't' and n[1:].isdigit())


def body_index(names):
    """Indices of the body nodes (not tail), as the app's skeletonIndex."""
    return [i for i, n in enumerate(names) if n and not is_tail_node(n)]


def geometry(p, iN, iT, body):
    """The app's crop geometry for one instance's keypoints p [n, 2] (NaN = missing), or None."""
    import cv2
    if not np.isfinite(p[[iN, iT]]).all():
        return None
    v = p[iN] - p[iT]
    L = float(np.hypot(*v))
    b = p[body]
    b = b[np.isfinite(b).all(1)]
    if len(b) < 6 or not L >= 15:
        return None
    return dict(c=b.mean(0), ang=float(np.arctan2(v[1], v[0])), s=CROP / (1.3 * L), L=L,
                hull=cv2.convexHull(b.astype(np.float32)).reshape(-1, 2))


def transform_of(g):
    """canvas: translate(C/2) scale(s) rotate(-ang) translate(-c), as a 2x3 matrix."""
    ca, sa = np.cos(-g['ang']), np.sin(-g['ang'])
    R = np.array([[ca, -sa], [sa, ca]]) * g['s']
    return np.hstack([R, (np.array([CROP / 2, CROP / 2]) - R @ g['c'])[:, None]])


def cut_crop(img, g, others):
    """Masked, pose-aligned grey crop [160, 160] uint8: the animal's hull dilated by L/4, minus the other animals' hulls."""
    import cv2
    M = transform_of(g)
    aligned = cv2.warpAffine(img, M, (CROP, CROP), flags=cv2.INTER_LINEAR, borderValue=0)
    up = 8                                                    # mask drawn at 8x, then averaged down (anti-aliased edge)
    tr = lambda h: ((M[:, :2] @ h.T).T + M[:, 2]) * up
    m = np.zeros((CROP * up, CROP * up), np.uint8)
    h = tr(g['hull']).astype(np.int32)
    cv2.fillPoly(m, [h], 255)
    w = int(round(2 * 0.25 * g['L'] * g['s'] * up))
    cv2.polylines(m, [h], True, 255, thickness=max(1, w), lineType=cv2.LINE_AA)
    for q in h:
        cv2.circle(m, (int(q[0]), int(q[1])), max(1, w // 2), 255, -1)
    for g2 in others:
        cv2.fillPoly(m, [tr(g2['hull']).astype(np.int32)], 0)
    mk = cv2.resize(m, (CROP, CROP), interpolation=cv2.INTER_AREA) > 127
    return np.where(mk, aligned, 0).astype(np.uint8)


# ---- contact-free stretches (pure numpy: --self-test checks it) -----------------------------------------------------

def stretches(frames, tracks, centres, lengths, fps, contact=1.0, margin_s=0.5, gap_s=1.0):
    """Per row (one tracked instance on one frame), the id of its track's contact-free stretch, or -1 for rows at or
    within `margin_s` of a contact. A contact = two tracks on the same frame whose centres are closer than
    `contact` x the larger body length. A stretch also ends at a gap over `gap_s` in its track."""
    frames, tracks = np.asarray(frames), np.asarray(tracks)
    centres, lengths = np.asarray(centres, float), np.asarray(lengths, float)
    n = len(frames)
    touch = np.zeros(n, bool)
    order = np.argsort(frames, kind='stable')
    i = 0
    while i < n:
        j = i
        while j < n and frames[order[j]] == frames[order[i]]:
            j += 1
        rows = order[i:j]
        for a in range(len(rows)):
            for b in range(a + 1, len(rows)):
                ra, rb = rows[a], rows[b]
                if tracks[ra] == tracks[rb]:
                    continue
                d = np.hypot(*(centres[ra] - centres[rb]))
                if d < contact * max(lengths[ra], lengths[rb]):
                    touch[ra] = touch[rb] = True
        i = j
    out = np.full(n, -1, np.int64)
    margin, gap = margin_s * fps, gap_s * fps
    sid = 0
    for t in np.unique(tracks):
        rows = np.where(tracks == t)[0]
        rows = rows[np.argsort(frames[rows], kind='stable')]
        cf = frames[rows][touch[rows]]                      # this track's contact frames
        prev = None
        for r in rows:
            f = frames[r]
            near = len(cf) and np.abs(cf - f).min() <= margin
            if near:
                prev = None                                 # a contact (or its margin) ends the stretch
                continue
            if prev is None or f - prev > gap or (len(cf) and ((cf > prev) & (cf < f)).any()):
                sid += 1
            out[r] = sid
            prev = f
    return out


def self_test():
    """The stretch logic on a made-up scene: two animals, one contact, one gap."""
    fps = 10.0
    F, T, C, L = [], [], [], []
    for f in range(0, 200):
        for t in (0, 1):
            if t == 1 and 120 <= f < 140:
                continue                                    # track 1 missing for 2 s: a gap
            x = 50.0 if t == 0 else (300.0 if not (60 <= f <= 70) else 60.0)   # they touch on frames 60-70
            F.append(f); T.append(t); C.append((x, 100.0)); L.append(40.0)
    s = stretches(F, T, C, L, fps)
    F, T, s = np.array(F), np.array(T), s
    ok = True

    def check(c, m):
        nonlocal ok
        print(('  ok   ' if c else '  FAIL ') + m)
        ok = ok and c
    check((s[(F >= 60) & (F <= 70)] == -1).all(), 'rows at the contact belong to no stretch')
    check((s[(F >= 55) & (F < 60)] == -1).all() and (s[(F > 70) & (F <= 75)] == -1).all(), '…nor within 0.5 s of it')
    a0, b0 = s[(T == 0) & (F < 50)], s[(T == 0) & (F > 80)]
    check(len(set(a0)) == 1 and len(set(b0)) == 1 and a0[0] != b0[0], 'track 0: one stretch before the contact, another after')
    b1, c1 = s[(T == 1) & (F > 80) & (F < 120)], s[(T == 1) & (F >= 140)]
    check(len(set(b1)) == 1 and len(set(c1)) == 1 and b1[0] != c1[0], 'track 1: a 2-s gap starts a new stretch')
    check(len(set(a0) & set(s[T == 1])) == 0, 'stretches never span two tracks')
    s2 = stretches([0, 0], [0, 0], [(0, 0), (1, 0)], [40, 40], fps)
    check((s2 >= 0).all(), 'two rows of the SAME track on a frame are not a contact')
    names = ['nose', 'head', 'trunk', 'tti', 'tail_tip', 't0', 't1', 'T2', 'Tail', 'thorax', 'tti2', 't']
    check(body_index(names) == [0, 1, 2, 3, 9, 10, 11], 'body nodes leave out the tail as the app does (tail*, t<number>)')
    return ok


# ---- one labels file -> crops + metadata (cached) -------------------------------------------------------------------

def resolve_video(labels, slp_path, video_root):
    vids = labels.videos
    if len(vids) != 1:
        raise SystemExit(f'{slp_path}: expected one video per labels file (one camera), found {len(vids)}')
    fn = vids[0].filename
    fn = fn[0] if isinstance(fn, (list, tuple)) else fn
    cands = [fn, os.path.join(os.path.dirname(slp_path), os.path.basename(fn))]
    if video_root:
        cands.append(os.path.join(video_root, os.path.basename(fn)))
    for c in cands:
        if c and os.path.isfile(c):
            return c
    # the one video beside the .slp (a re-encoded copy keeps the frames but not the name the .slp recorded)
    here = [f for f in glob.glob(os.path.join(os.path.dirname(os.path.abspath(slp_path)), '*'))
            if os.path.splitext(f)[1].lower() in ('.mp4', '.avi', '.mkv', '.mov')]
    if len(here) == 1:
        log(f'{os.path.basename(slp_path)}: {os.path.basename(fn)} not found; using {os.path.basename(here[0])}, the one video beside it')
        return here[0]
    raise SkipFile(f'video {fn} not found (put it beside the .slp or pass --video-root)')


class SkipFile(Exception):
    """A labels file this run cannot use (said why, and left out)."""


def cut_file(args):
    """Crops of one tracked labels file: every `step`-th frame's tracked instances, with their track and stretch."""
    slp, cache_dir, step, contact, video_root = args
    import sleap_io as sio
    import av
    # CROP_RULE in the key: crops cut by an older rule (before 2, t0/t1/... tail nodes were in the body) are never reused
    key = hashlib.sha256(f'{os.path.abspath(slp)}|{os.path.getsize(slp)}|{os.path.getmtime(slp)}|{step}|{contact}|{CROP_RULE}'.encode()).hexdigest()[:16]
    out = os.path.join(cache_dir, f'{os.path.splitext(os.path.basename(slp))[0]}-{key}.npz')
    if os.path.exists(out):
        return out
    L = sio.load_slp(slp)
    names = list(L.skeletons[0].node_names)
    if NOSE not in names or TTI not in names:
        raise SkipFile(f'the skeleton needs nodes named {NOSE} and {TTI} (the app aligns crops on them)')
    iN, iT, body = names.index(NOSE), names.index(TTI), body_index(names)
    tracks = {id(t): i for i, t in enumerate(L.tracks)}
    video = resolve_video(L, slp, video_root)
    ct = av.open(video)
    st = ct.streams.video[0]
    st.thread_type = 'AUTO'
    fps = float(st.average_rate) if st.average_rate else 30.0
    tb = float(st.time_base)
    # every tracked instance on every frame (contacts need all of them), geometry per instance
    F, T, C, Ls, G = [], [], [], [], []
    for lf in L.labeled_frames:
        for inst in lf.instances:
            if inst.track is None:
                continue
            g = geometry(inst.numpy(), iN, iT, body)
            if g is None:
                continue
            F.append(lf.frame_idx); T.append(tracks[id(inst.track)]); C.append(g['c']); Ls.append(g['L']); G.append(g)
    if not F:
        raise SkipFile('no tracked instance with a usable pose (a track, Nose, TTI and 6 body points)')
    F, T = np.array(F), np.array(T)
    S = stretches(F, T, np.array(C), np.array(Ls), fps, contact=contact)
    want, onf = {}, {}
    for r in range(len(F)):
        onf.setdefault(int(F[r]), []).append(r)
        if F[r] % step == 0:
            want.setdefault(int(F[r]), []).append(r)
    crops, meta = [], []
    last = max(want) if want else -1
    for i, fr in enumerate(ct.decode(st)):
        fi = int(round(fr.pts * tb * fps)) if fr.pts is not None else i
        if fi > last:
            break
        if fi not in want:
            continue
        img = fr.to_ndarray(format='gray')
        rows = onf[fi]                                      # every animal on the frame masks the others
        for r in want[fi]:
            crops.append(cut_crop(img, G[r], [G[q] for q in rows if q != r]))
            meta.append((fi, T[r], S[r], len(rows)))
    ct.close()
    os.makedirs(cache_dir, exist_ok=True)
    np.savez(out + '.tmp.npz', crops=np.stack(crops) if crops else np.zeros((0, CROP, CROP), np.uint8),
             meta=np.array(meta, np.int64).reshape(-1, 4), fps=fps, source=os.path.abspath(slp))
    os.replace(out + '.tmp.npz', out)
    return out


def cut_one(job):
    try:
        return cut_file(job), None
    except SkipFile as e:
        return None, f'{job[0]}: {e}'


def cut_all(files, cache_dir, step, contact, video_root, workers):
    """Each file's crop cache; files that cannot be used are left out, each with the reason."""
    jobs = [(f, cache_dir, step, contact, video_root) for f in files]
    if workers <= 1:
        res = [cut_one(j) for j in jobs]
    else:
        from multiprocessing import Pool
        with Pool(min(workers, len(jobs))) as p:
            res = p.map(cut_one, jobs)
    for _, why in res:
        if why:
            log('LEFT OUT ' + why)
    out = [r for r, _ in res if r]
    if not out:
        raise SystemExit('no usable labels file')
    return out


# ---- training pairs: anchors in multi-animal frames, positives in the same track stretch -----------------------------

class Pairs:
    def __init__(self, npz_files, lo_s=1.0, hi_s=10.0):
        self.files = []
        for f in npz_files:
            d = np.load(f)
            cr, m, fps = d['crops'], d['meta'], float(d['fps'])
            fr, tr, sid = m[:, 0], m[:, 1], m[:, 2]
            bys = {}
            for i, s in enumerate(sid):
                if s >= 0:
                    bys.setdefault(int(s), []).append(i)
            bys = {k: np.array(v) for k, v in bys.items()}
            byf = {}
            for i, f_ in enumerate(fr):
                byf.setdefault(int(f_), []).append(i)
            # frames with >= 2 animals of distinct tracks, each in a stretch with a partner crop 1-10 s away
            def partner(i):
                if sid[i] < 0:
                    return None
                rows = bys[int(sid[i])]
                dt = np.abs(fr[rows] - fr[i]) / fps
                ok = rows[(dt >= lo_s) & (dt <= hi_s)]
                return ok if len(ok) else None
            groups = []
            for f_, rows in byf.items():
                if len(rows) < 2 or len(set(tr[rows].tolist())) != len(rows):
                    continue
                ps = [partner(i) for i in rows]
                if all(p is not None for p in ps):
                    groups.append((rows, ps))
            self.files.append(dict(crops=cr, groups=groups, n=len(cr)))
        self.w = np.array([len(f['groups']) for f in self.files], np.float64)
        self.n_groups = int(self.w.sum())
        if self.n_groups == 0:
            raise SystemExit('no training frame has two or more animals each with a partner crop 1-10 s away in its stretch: '
                             'more recordings, a smaller --step, or --contact 0')
        self.w /= self.w.sum()

    def batch(self, B, rng):
        A, P, G = [], [], []
        for g in range(B):
            fi = int(rng.choice(len(self.files), p=self.w))
            rows, ps = self.files[fi]['groups'][int(rng.integers(len(self.files[fi]['groups'])))]
            for i, p in zip(rows, ps):
                A.append((fi, i)); P.append((fi, int(rng.choice(p)))); G.append(g)
        return A, P, np.array(G)

    def crops(self, idx):
        return np.stack([self.files[fi]['crops'][i] for fi, i in idx])


# ---- model ----------------------------------------------------------------------------------------------------------

def load_base(base):
    import torch.nn as nn
    from transformers import AutoModel
    hf, size, lic, thr = BASES[base]
    m = AutoModel.from_pretrained(hf, attn_implementation='eager')
    if hasattr(m, 'encoder') and hasattr(m.encoder, 'layer'):
        layers, norm = m.encoder.layer, m.layernorm                   # dinov2
    elif hasattr(m, 'model') and hasattr(m.model, 'layer'):
        layers, norm = m.model.layer, m.norm                          # DINOv3 ViT
    else:
        raise SystemExit(f'do not know where {hf} keeps its transformer blocks')
    if base.startswith('dinov3') and hasattr(m.config, 'pos_embed_rescale'):
        m.config.pos_embed_rescale = None                             # no position jitter at inference (as exported)
    return m, layers, norm, size


def make_model(base, blocks):
    import torch.nn as nn
    m, layers, norm, size = load_base(base)

    class Net(nn.Module):
        def __init__(self):
            super().__init__()
            self.m = m
            self.head = nn.Sequential(nn.Linear(384, 384), nn.GELU(), nn.Linear(384, 128))

        def cls(self, x):
            return self.m(pixel_values=x).last_hidden_state[:, 0]

        def forward(self, x):
            return self.head(self.cls(x))
    net = Net()
    for p in net.m.parameters():
        p.requires_grad = False
    tuned = [p for b in layers[len(layers) - blocks:] for p in b.parameters()] + list(norm.parameters())
    for p in tuned:
        p.requires_grad = True
    return net, tuned, size


def norm3(x):
    import torch
    m = torch.tensor(MEAN, device=x.device).view(1, 3, 1, 1)
    s = torch.tensor(STD, device=x.device).view(1, 3, 1, 1)
    return (x.expand(-1, 3, -1, -1) - m) / s


def prep(x_u8, size):
    """uint8 crops [n,160,160] (torch) -> the app's input: bilinear (align_corners=False) to size, ImageNet-normalised."""
    import torch.nn.functional as F
    x = x_u8.float().div(255).unsqueeze(1)
    if x.shape[-1] != size:
        x = F.interpolate(x, size=(size, size), mode='bilinear', align_corners=False)
    return norm3(x)


def augment(x_u8, size, rot=10, scale=(0.9, 1.1), shift=0.04):
    """Mild geometric jitter, no photometric change (coat brightness is an identity cue)."""
    import torch
    import torch.nn.functional as F
    n, dev = x_u8.shape[0], x_u8.device
    a = (torch.rand(n, device=dev) * 2 - 1) * rot * math.pi / 180
    s = torch.empty(n, device=dev).uniform_(*scale)
    t = (torch.rand(n, 2, device=dev) * 2 - 1) * shift * 2
    th = torch.stack([torch.stack([torch.cos(a) / s, -torch.sin(a) / s, t[:, 0]], 1),
                      torch.stack([torch.sin(a) / s, torch.cos(a) / s, t[:, 1]], 1)], 1)
    grid = F.affine_grid(th, (n, 1, size, size), align_corners=False)
    return norm3(F.grid_sample(x_u8.float().div(255).unsqueeze(1), grid, mode='bilinear', padding_mode='zeros', align_corners=False))


def group_nce(za, zp, G, tau=0.1):
    """Each anchor's positive against the other animals of its frame (their anchors and positives)."""
    import torch
    import torch.nn.functional as F
    za, zp = F.normalize(za, dim=-1), F.normalize(zp, dim=-1)
    Gt = torch.as_tensor(G, device=za.device)
    same = Gt[:, None] == Gt[None, :]
    eye = torch.eye(len(G), dtype=torch.bool, device=za.device)
    loss = 0
    for zq, zk_pos, zk_neg in ((za, zp, za), (zp, za, zp)):
        pos = (zq * zk_pos).sum(-1, keepdim=True) / tau
        mask = same & ~eye
        neg1 = ((zq @ zk_pos.T) / tau).masked_fill(~mask, -1e4)
        neg2 = ((zq @ zk_neg.T) / tau).masked_fill(~mask, -1e4)
        loss = loss + F.cross_entropy(torch.cat([pos, neg1, neg2], 1), torch.zeros(len(G), dtype=torch.long, device=za.device))
    return loss / 2


def train(net, tuned, size, pairs, steps, dev, seed=0):
    import torch
    rng = np.random.default_rng(seed)
    torch.manual_seed(seed)
    net.to(dev).train()
    head = list(net.head.parameters())
    opt = torch.optim.AdamW([{'params': head, 'lr': 1e-3}, {'params': tuned, 'lr': 2e-5}], weight_decay=0.05)
    sched = torch.optim.lr_scheduler.LambdaLR(opt, lambda s: min(1, (s + 1) / 200) * 0.5 * (1 + math.cos(math.pi * s / steps)))
    amp = 'cuda' if 'cuda' in str(dev) else 'cpu'
    for it in range(steps):
        A, P, G = pairs.batch(96, rng)
        xa = augment(torch.from_numpy(pairs.crops(A)).to(dev), size)
        xp = augment(torch.from_numpy(pairs.crops(P)).to(dev), size)
        with torch.autocast(amp, dtype=torch.bfloat16):
            loss = group_nce(net(xa).float(), net(xp).float(), G)
        opt.zero_grad()
        loss.backward()
        opt.step()
        sched.step()
        if it % 250 == 0 or it == steps - 1:
            log(f'step {it}/{steps}: loss {float(loss.detach()):.3f} ({len(G)} crops)')
    net.eval()


# ---- held-out score: does the model tell the animals apart, label-free? ---------------------------------------------

def embed(cls_fn, crops, size, dev, bs=256):
    import torch
    out = []
    with torch.no_grad():
        for i in range(0, len(crops), bs):
            x = prep(torch.from_numpy(crops[i:i + bs]).to(dev), size)
            out.append(torch.nn.functional.normalize(cls_fn(x).float(), dim=-1).cpu().numpy())
    return np.concatenate(out) if out else np.zeros((0, 384), np.float32)


def heldout_auc(npz_files, cls_fn, size, dev, max_per_file=4000, seed=1):
    """AUC that a crop is closer to its own animal 2-10 s later in the same contact-free stretch than to another
    animal on the same frame (raw CLS cosine; the app's per-recording metric adds to this). Single crops."""
    rng = np.random.default_rng(seed)
    pos, neg = [], []
    for f in npz_files:
        d = np.load(f)
        cr, m, fps = d['crops'], d['meta'], float(d['fps'])
        if len(cr) > max_per_file:
            keep = np.sort(rng.choice(len(cr), max_per_file, replace=False))
            cr, m = cr[keep], m[keep]
        e = embed(cls_fn, cr, size, dev)
        fr, tr, sid = m[:, 0], m[:, 1], m[:, 2]
        byf = {}
        for i, f_ in enumerate(fr):
            byf.setdefault(int(f_), []).append(i)
        for rows in byf.values():
            for a in rows:
                for b in rows:
                    if a < b and tr[a] != tr[b]:
                        neg.append(float(e[a] @ e[b]))
        for s in np.unique(sid[sid >= 0]):
            rows = np.where(sid == s)[0]
            for a in rows[::3]:
                dt = np.abs(fr[rows] - fr[a]) / fps
                ok = rows[(dt >= 2) & (dt <= 10)]
                if len(ok):
                    pos.append(float(e[a] @ e[int(rng.choice(ok))]))
    if not pos or not neg:
        return None, 0, 0
    p, n = np.array(pos), np.sort(np.array(neg))
    auc = float((np.searchsorted(n, p, side='left') + np.searchsorted(n, p, side='right')).sum() / 2 / (len(p) * len(n)))
    return auc, len(p), len(n)


# ---- export ---------------------------------------------------------------------------------------------------------

def export(net, base, size, out_dir):
    import torch
    os.makedirs(os.path.join(out_dir, 'onnx'), exist_ok=True)
    m = net.m.cpu().float().eval()

    class Wrap(torch.nn.Module):
        def __init__(self, m):
            super().__init__()
            self.m = m

        def forward(self, pixel_values):
            return self.m(pixel_values=pixel_values).last_hidden_state
    onnx_path = os.path.join(out_dir, 'onnx', 'model.onnx')
    torch.onnx.export(Wrap(m), (torch.zeros(2, 3, size, size),), onnx_path, input_names=['pixel_values'],
                      output_names=['last_hidden_state'],
                      dynamic_axes={'pixel_values': {0: 'batch_size'}, 'last_hidden_state': {0: 'batch_size'}},
                      opset_version=17, dynamo=False)
    cfg = m.config.to_dict()
    cfg.pop('transformers.js_config', None)
    cfg['architectures'] = [type(m).__name__]
    with open(os.path.join(out_dir, 'config.json'), 'w') as f:
        json.dump(cfg, f, indent=2)
    # the export must give torch's CLS (onnxruntime, when installed)
    x = torch.randn(3, 3, size, size)
    with torch.no_grad():
        ref = m(pixel_values=x).last_hidden_state[:, 0].numpy()
    try:
        import onnxruntime as ort
    except ImportError:
        log('onnxruntime not installed: the export was not checked')
        return None
    sess = ort.InferenceSession(onnx_path, providers=['CPUExecutionProvider'])
    got = sess.run(None, {'pixel_values': x.numpy()})[0][:, 0]
    cos = float(np.min((ref * got).sum(1) / np.linalg.norm(ref, axis=1) / np.linalg.norm(got, axis=1)))
    log(f'ONNX vs torch: worst CLS cosine {cos:.6f}')
    if cos < 0.9999:
        raise SystemExit(f'the ONNX export differs from torch (cosine {cos})')
    return cos


# ---- main -----------------------------------------------------------------------------------------------------------

def expand(patterns):
    out = []
    for p in patterns or []:
        hits = sorted(glob.glob(p)) or ([p] if os.path.exists(p) else [])
        if not hits:
            raise SystemExit(f'no file matches {p}')
        out += hits
    return out


def main(argv=None):
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument('out', nargs='?', help='package folder to write')
    ap.add_argument('--labels', nargs='+', help='tracked .slp files to train on (one per camera per recording; globs ok)')
    ap.add_argument('--holdout', nargs='*', default=[], help='tracked .slp files to score, never trained on')
    ap.add_argument('--video-root', help='folder to find videos in when the paths inside the .slp files are stale')
    ap.add_argument('--base', default='dinov2-small', choices=sorted(BASES), help='base model (default dinov2-small: '
                    'fine-tuned, it did as well as DINOv3 or better, under Apache-2.0)')
    ap.add_argument('--name', help='name shown in LUCID')
    ap.add_argument('--threshold', type=float, help="flag threshold (default: the base model's, -1 for dinov2-small)")
    ap.add_argument('--steps', type=int, default=3000)
    ap.add_argument('--blocks', type=int, default=4, help='transformer blocks to fine-tune (the last ones)')
    ap.add_argument('--step', type=int, default=5, help='cut crops every Nth frame')
    ap.add_argument('--contact', type=float, default=0.0, help='also end stretches at contacts: body centres closer than '
                    'this x body length (0 = off, the default; 1 = a body length)')
    ap.add_argument('--workers', type=int, default=max(1, (os.cpu_count() or 2) // 2), help='crop-cutting processes')
    ap.add_argument('--device', default='cuda')
    ap.add_argument('--cache', help='crop cache folder (default <out>/../.crops)')
    ap.add_argument('--self-test', action='store_true', help='check the contact-free stretch logic and exit (numpy only)')
    a = ap.parse_args(argv)
    if a.self_test:
        sys.exit(0 if self_test() else 1)
    if not a.out or not a.labels:
        ap.error('give the package folder and --labels')
    import torch
    train_files, hold_files = expand(a.labels), expand(a.holdout)
    overlap = set(map(os.path.abspath, train_files)) & set(map(os.path.abspath, hold_files))
    if overlap:
        raise SystemExit(f'files both trained on and held out: {sorted(overlap)[:3]}')
    hf, size, lic, base_thr = BASES[a.base]
    cache = a.cache or os.path.join(os.path.dirname(os.path.abspath(a.out)), '.crops')
    log(f'cutting crops: {len(train_files)} training + {len(hold_files)} held-out files, every {a.step}th frame, {a.workers} workers')
    tr_npz = cut_all(train_files, cache, a.step, a.contact, a.video_root, a.workers)
    ho_npz = cut_all(hold_files, cache, a.step, a.contact, a.video_root, a.workers) if hold_files else []
    pairs = Pairs(tr_npz)
    n_crops = sum(f['n'] for f in pairs.files)
    log(f'{n_crops:,} training crops; {pairs.n_groups:,} frames with 2+ animals, each with a partner crop 1-10 s away in its stretch')
    dev = torch.device(a.device if (a.device != 'cuda' or torch.cuda.is_available()) else 'cpu')
    if dev.type != 'cuda':
        log('no CUDA GPU: training on the CPU will be very slow')
    net, tuned, size = make_model(a.base, a.blocks)
    validation = {}
    if ho_npz:
        net.to(dev).eval()
        auc0, npos, nneg = heldout_auc(ho_npz, net.cls, size, dev)
        log(f'held out, frozen {a.base}: AUC {auc0} ({npos} same-animal pairs, {nneg} different-animal pairs)')
    train(net, tuned, size, pairs, a.steps, dev)
    if ho_npz:
        auc1, npos, nneg = heldout_auc(ho_npz, net.cls, size, dev)
        log(f'held out, fine-tuned: AUC {auc1}')
        validation = {'held_out_files': len(hold_files), 'single_crop_auc_frozen': round(auc0, 4) if auc0 is not None else None,
                      'single_crop_auc_fine_tuned': round(auc1, 4) if auc1 is not None else None,
                      'measure': 'same animal 2-10 s apart in one track stretch vs another animal on the same frame, raw CLS cosine'}
    log('exporting ONNX')
    cos = export(net, a.base, size, a.out)
    training = {'method': 'label-free contrastive fine-tune (InfoNCE): positives = the same track stretch 1-10 s apart' +
                          (f', stretches ended at contacts ({a.contact} x body length)' if a.contact > 0 else ''),
                'base': hf, 'blocks': a.blocks, 'steps': a.steps, 'crop_every': a.step, 'contact': a.contact,
                'files': len(train_files), 'crops': n_crops, 'frames': pairs.n_groups,
                'date': time.strftime('%Y-%m-%d'), 'script': 'scripts/train_image_model.py'}
    if cos is not None:
        validation['onnx_vs_torch_cosine'] = round(cos, 6)
    sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
    import make_image_model_package as mk
    args = [a.out, '--name', a.name or f'{os.path.basename(os.path.abspath(a.out))} (fine-tuned {a.base})', '--base', hf,
            '--license', lic, '--input', str(size), '--threshold', str(a.threshold if a.threshold is not None else base_thr),
            '--training', json.dumps(training)]
    if validation:
        args += ['--validation', json.dumps(validation)]
    mk.main(args)
    log(f'done: load {os.path.abspath(a.out)} in LUCID (ID Switches tab > Image model > Change... > Load package folder...)')


if __name__ == '__main__':
    main()
