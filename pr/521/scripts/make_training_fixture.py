#!/usr/bin/env python3
"""A tiny, real training fixture for the desktop app's local training tests.

Writes into OUT_DIR:
  video.mp4          24 frames, 96x96, a bright two-node "animal" moving on a dark background
  train.slp/val.slp  user instances on 20 / 4 frames; the video is named by a PLACEHOLDER
                     ("lucid-video-0.mp4"), so a run must pass --video-paths (as the app does)
  config.json        a sleap-app preset (single instance, Medium RF) as JSON, shrunk for a
                     quick CPU run: max_epochs from --epochs, batch 4, no caching, 0 workers

Run with sleap-nn's own Python (it has sleap-io, numpy, opencv, yaml):

    ~/.local/share/uv/tools/sleap-nn/bin/python3 -I scripts/make_training_fixture.py OUT_DIR [--epochs N]

Used by `cargo test --features sleap-nn real_training -- --ignored` (LUCID_TRAIN_FIXTURE=OUT_DIR).
Not run in CI (no sleap-nn there).
"""
import json
import os
import re
import sys

import cv2
import numpy as np
import sleap_io as sio
import yaml

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))


def preset(filename):
    """The YAML text of a vendored sleap-app preset (lib/sleap-app-profiles/profiles.js)."""
    src = open(os.path.join(HERE, "lib", "sleap-app-profiles", "profiles.js"), encoding="utf-8").read()
    m = re.search(r'filename: "%s".*?content: ("(?:[^"\\]|\\.)*")' % re.escape(filename), src, re.S)
    if not m:
        sys.exit("preset %s not found" % filename)
    return json.loads(m.group(1))


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    out = os.path.abspath(sys.argv[1])
    epochs = int(sys.argv[sys.argv.index("--epochs") + 1]) if "--epochs" in sys.argv else 2
    os.makedirs(out, exist_ok=True)
    n, w, h = 24, 96, 96
    vw = cv2.VideoWriter(os.path.join(out, "video.mp4"), cv2.VideoWriter_fourcc(*"mp4v"), 10, (w, h), True)
    pts = []
    for i in range(n):
        img = np.full((h, w, 3), 20, np.uint8)
        x, y = 20 + 2 * i, 30 + i
        cv2.circle(img, (x, y), 6, (230, 230, 230), -1)
        cv2.circle(img, (x + 14, y + 10), 4, (160, 160, 160), -1)
        pts.append(((x, y), (x + 14, y + 10)))
        vw.write(img)
    vw.release()

    skel = sio.Skeleton(nodes=["head", "tail"], edges=[("head", "tail")])

    def labels(frames):
        video = sio.Video(filename="lucid-video-0.mp4", open_backend=False)
        lfs = [sio.LabeledFrame(video=video, frame_idx=i, instances=[
            sio.Instance.from_numpy(np.array(pts[i], float), skeleton=skel)]) for i in frames]
        return sio.Labels(labeled_frames=lfs, videos=[video], skeletons=[skel])

    sio.save_slp(labels(range(0, 20)), os.path.join(out, "train.slp"))
    sio.save_slp(labels(range(20, 24)), os.path.join(out, "val.slp"))

    cfg = yaml.safe_load(preset("baseline_medium_rf.single.yaml"))
    cfg["trainer_config"]["max_epochs"] = epochs
    cfg["trainer_config"]["train_data_loader"]["batch_size"] = 4
    cfg["trainer_config"]["train_data_loader"]["num_workers"] = 0
    cfg["trainer_config"]["val_data_loader"]["num_workers"] = 0
    cfg["data_config"]["data_pipeline_fw"] = "torch_dataset"
    cfg["trainer_config"]["visualize_preds_during_training"] = True
    cfg["trainer_config"]["keep_viz"] = True
    with open(os.path.join(out, "config.json"), "w") as fh:
        json.dump(cfg, fh)
    print("wrote %s (%d frames, %d epochs)" % (out, n, epochs))


if __name__ == "__main__":
    main()
