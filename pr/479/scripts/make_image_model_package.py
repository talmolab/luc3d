#!/usr/bin/env python3
"""Turn an exported image model into a LUCID image-model package for the image ID-switch check.

The input folder must already hold the model in the layout transformers.js loads:

    config.json                 (model_type dinov2 / dinov3_vit)
    onnx/model.onnx             fp32, input pixel_values [n, 3, S, S], output last_hidden_state (CLS = token 0)
    onnx/model_fp16.onnx        optional
    preprocessor_config.json    optional

This script writes lucid-model.json beside them (format: pose/image-model-manifest.js), with the
SHA-256 of every weight file, so LUCID can check the files and key its embedding cache by them.
Load the folder in LUCID: ID Switches tab > Image model > Change... > Load package folder..., or put
it on a web server / Hugging Face repo and load it by URL.

Only pass --fp16 after checking model_fp16.onnx against fp32 ON WEBGPU (a CPU check can hide fp16
overflow: DINOv3's layer-0 attention does exactly that).

Standard library only.

Example:
    python3 scripts/make_image_model_package.py exported/slap-v2A \\
        --name "SLAP rig, fine-tuned dinov2-small (fold A)" --base facebook/dinov2-small \\
        --license Apache-2.0 --input 168 --threshold -1 \\
        --training training.json --validation validation.json
"""
import argparse
import hashlib
import json
import os
import sys

MANIFEST = 'lucid-model.json'
CROP = 160          # the crop side LUCID cuts (ui/image-embedder.js CROP)


def sha256(path):
    h = hashlib.sha256()
    with open(path, 'rb') as f:
        for block in iter(lambda: f.read(1 << 20), b''):
            h.update(block)
    return h.hexdigest()


def load_json_arg(value):
    if value is None:
        return None
    if os.path.isfile(value):
        with open(value) as f:
            return json.load(f)
    return json.loads(value)


def main(argv=None):
    p = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    p.add_argument('folder', help='exported model folder (config.json, onnx/model.onnx)')
    p.add_argument('--name', required=True, help='name shown in LUCID')
    p.add_argument('--base', required=True, help='base model it was trained from, e.g. facebook/dinov2-small')
    p.add_argument('--license', required=True, help="the base model's license, e.g. Apache-2.0 or 'DINOv3 License'")
    p.add_argument('--input', type=int, required=True, help='model input side in px (dinov2: 168; DINOv3: 192)')
    p.add_argument('--threshold', type=float, required=True, help='recommended flag threshold, -4..0')
    p.add_argument('--fp16', action='store_true', help='onnx/model_fp16.onnx was checked against fp32 on WebGPU')
    p.add_argument('--training', help='JSON (or a .json file) describing the training, shown in LUCID')
    p.add_argument('--validation', help='JSON (or a .json file) with validation results, shown in LUCID')
    a = p.parse_args(argv)

    folder = a.folder
    for need in ('config.json', os.path.join('onnx', 'model.onnx')):
        if not os.path.isfile(os.path.join(folder, need)):
            sys.exit('missing ' + os.path.join(folder, need))
    if not (112 <= a.input <= 512 and (a.input % 14 == 0 or a.input % 16 == 0)):
        sys.exit('--input must be 112..512 and a multiple of 14 or 16')
    if not (-4 <= a.threshold <= 0):
        sys.exit('--threshold must be between -4 and 0')
    fp16_path = os.path.join(folder, 'onnx', 'model_fp16.onnx')
    if a.fp16 and not os.path.isfile(fp16_path):
        sys.exit('--fp16 given but there is no onnx/model_fp16.onnx')

    hashes = {'onnx/model.onnx': sha256(os.path.join(folder, 'onnx', 'model.onnx'))}
    if a.fp16:
        hashes['onnx/model_fp16.onnx'] = sha256(fp16_path)
    manifest = {
        'format': 'lucid-image-model', 'version': 1,
        'name': a.name, 'base': a.base, 'license': a.license,
        'input': a.input, 'crop': CROP, 'threshold': a.threshold, 'fp16': bool(a.fp16),
        'sha256': hashes,
    }
    training, validation = load_json_arg(a.training), load_json_arg(a.validation)
    if training is not None:
        manifest['training'] = training
    if validation is not None:
        manifest['validation'] = validation
    out = os.path.join(folder, MANIFEST)
    with open(out, 'w') as f:
        json.dump(manifest, f, indent=2)
        f.write('\n')
    print('wrote', out)
    for k, v in hashes.items():
        print('  ', k, v)


if __name__ == '__main__':
    main()
