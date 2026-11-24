#!/usr/bin/env python3
"""Generate src-tauri/src/train_config_keys.json: every leaf key of sleap-nn's training config
with its value kind, for the desktop app's config allowlist (src-tauri/src/train_config.rs).

The Training panel's local backend sends a training config to Rust as JSON; Rust accepts only the
dotted keys listed here, each value of its kind, and refuses everything else (unknown keys are NOT
passed through: Hydra compose would accept them silently). Keys Rust owns (paths, ports, W&B) are
listed under "forced" and are always overwritten.

Run it with sleap-nn's own Python (the uv tool environment), e.g.:

    ~/.local/share/uv/tools/sleap-nn/bin/python3 -I scripts/gen_train_config_keys.py

`--check` exits 1 when the committed file differs (run it on every sleap-nn bump; the Node wrapper
tests/test-training-config-keys.mjs runs it when uv's sleap-nn is installed).
"""
import json
import os
import sys
import typing

FORCED = {
    # Rust writes these (staging files, the runs folder, its ZMQ ports) or pins them off.
    "data_config.train_labels_path": "staging train file",
    "data_config.val_labels_path": "staging validation file",
    "data_config.test_file_path": "null",
    "data_config.cache_img_path": "inside the staging folder",
    "data_config.skeletons": "null (sleap-nn reads the skeleton from the training file)",
    "trainer_config.ckpt_dir": "the runs folder",
    "trainer_config.run_name": "a unique name Rust checks",
    "trainer_config.resume_ckpt_path": "a model-grant checkpoint or null",
    "model_config.pretrained_backbone_weights": "a model-grant checkpoint or null",
    "model_config.pretrained_head_weights": "a model-grant checkpoint or null",
    "trainer_config.zmq.controller_port": "Rust's port",
    "trainer_config.zmq.publish_port": "Rust's port",
    "trainer_config.save_ckpt": "true",
    "trainer_config.use_wandb": "false",
    "trainer_config.profiler": "null",
    "filename": "empty",
}
# Subtrees dropped entirely (W&B: network + an API key in the file).
DROPPED_PREFIXES = ["trainer_config.wandb."]


def kind_of(t):
    """A small type vocabulary Rust checks: bool, int, float, str, list, dict, any."""
    origin = typing.get_origin(t)
    args = typing.get_args(t)
    if origin is typing.Union:
        inner = [a for a in args if a is not type(None)]
        k = kind_of(inner[0]) if len(inner) == 1 else "any"
        return k
    if origin is typing.Literal:
        return "str"
    if origin in (list, typing.List, tuple, typing.Tuple):
        return "list"
    if origin in (dict, typing.Dict):
        return "dict"
    if t is bool:
        return "bool"
    if t is int:
        return "int"
    if t is float:
        return "float"
    if t is str or t is typing.Text:
        return "str"
    return "any"


def walk(attrs, cls, prefix, out):
    for f in attrs.fields(cls):
        t = f.type
        args = typing.get_args(t) or (t,)
        inner = [a for a in args if isinstance(a, type) and attrs.has(a)]
        key = prefix + f.name
        if inner:
            out["sections"].append(key)
            walk(attrs, inner[0], key + ".", out)
        else:
            out["keys"][key] = kind_of(t)


def main():
    import attrs
    import sleap_nn
    from sleap_nn.config.training_job_config import TrainingJobConfig

    out = {"sleap_nn_version": sleap_nn.__version__, "sections": [], "keys": {}}
    walk(attrs, TrainingJobConfig, "", out)
    for k in list(out["keys"]):
        if any(k.startswith(p) for p in DROPPED_PREFIXES):
            del out["keys"][k]
    out["sections"] = sorted(s for s in out["sections"] if not any((s + ".").startswith(p) for p in DROPPED_PREFIXES))
    missing = [k for k in FORCED if k not in out["keys"]]
    if missing:
        sys.exit("forced keys not in this sleap-nn's config: %s" % ", ".join(missing))
    out["forced"] = FORCED
    out["dropped_prefixes"] = DROPPED_PREFIXES
    out["keys"] = dict(sorted(out["keys"].items()))
    text = json.dumps(out, indent=1, sort_keys=False) + "\n"
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    dest = os.path.join(here, "src-tauri", "src", "train_config_keys.json")
    if "--check" in sys.argv:
        with open(dest, encoding="utf-8") as fh:
            old = json.load(fh)
        new = json.loads(text)
        old.pop("sleap_nn_version", None)
        new.pop("sleap_nn_version", None)
        if old != new:
            sys.exit("src-tauri/src/train_config_keys.json is out of date for sleap-nn %s: re-run this script" % sleap_nn.__version__)
        print("train_config_keys.json matches sleap-nn %s (%d keys)" % (sleap_nn.__version__, len(out["keys"])))
        return
    with open(dest, "w", encoding="utf-8") as fh:
        fh.write(text)
    print("wrote %d keys (sleap-nn %s) to %s" % (len(out["keys"]), sleap_nn.__version__, dest))


if __name__ == "__main__":
    main()
