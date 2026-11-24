#!/usr/bin/env python3
"""Vendor sleap-app's baseline training profiles into lib/sleap-app-profiles/profiles.js.

Usage: python3 scripts/vendor_sleap_app_profiles.py <sleap-app checkout> [--commit SHA]

The Training panel's config slots offer these as "Preset: ..." entries (sleap-app
src/lib/trainingProfiles.ts). Each YAML becomes a JSON string in one ES module, so the
deploy stamp and the offline and desktop bundles see a static import. Box-detector
profiles are left out (LUC3D has no box labels). Update PROVENANCE.txt's commit after.
"""
import json
import os
import subprocess
import sys

PROFILES = [
    ("baseline_medium_rf.centroid.yaml", "centroid", "Preset: Centroid (Medium RF)"),
    ("baseline_large_rf.centroid.yaml", "centroid", "Preset: Centroid (Large RF)"),
    ("baseline_medium_rf.topdown.yaml", "centered_instance", "Preset: Centered Instance (Medium RF)"),
    ("baseline_large_rf.topdown.yaml", "centered_instance", "Preset: Centered Instance (Large RF)"),
    ("baseline_medium_rf.bottomup.yaml", "bottomup", "Preset: Bottom-Up (Medium RF)"),
    ("baseline_large_rf.bottomup.yaml", "bottomup", "Preset: Bottom-Up (Large RF)"),
    ("baseline_medium_rf.single.yaml", "single_instance", "Preset: Single Instance (Medium RF)"),
    ("baseline_large_rf.single.yaml", "single_instance", "Preset: Single Instance (Large RF)"),
    ("baseline.multi_class_bottomup.yaml", "multi_class_bottomup", "Preset: Multi-Class Bottom-Up"),
    ("baseline.multi_class_topdown.yaml", "multi_class_topdown", "Preset: Multi-Class Top-Down"),
]


def main():
    if len(sys.argv) < 2:
        sys.exit(__doc__)
    root = sys.argv[1]
    commit = sys.argv[3] if len(sys.argv) > 3 and sys.argv[2] == "--commit" else subprocess.run(
        ["git", "-C", root, "rev-parse", "HEAD"], capture_output=True, text=True, check=False).stdout.strip()
    src = os.path.join(root, "src", "assets", "training_profiles")
    out = [
        "/**",
        " * lib/sleap-app-profiles/profiles.js — sleap-app's baseline training profiles (the Training",
        " * panel's \"Preset: …\" config-slot entries), vendored as JS strings so the deploy stamp and the",
        " * offline/desktop bundles see a static import (a fetched .yaml would not be stamped).",
        " *",
        " * Source: talmolab/sleap-app src/assets/training_profiles/*.yaml and src/lib/trainingProfiles.ts",
        " * @ %s (BSD 3-Clause, see PROVENANCE.txt). The box-detector" % commit,
        " * profiles are left out (LUC3D has no box labels). Regenerate with",
        " * scripts/vendor_sleap_app_profiles.py; do not edit by hand.",
        " */",
        "",
        "/** @type {{filename: string, headType: string, label: string, content: string}[]} */",
        "export const BASELINE_PROFILES = [",
    ]
    for fn, head, label in PROFILES:
        with open(os.path.join(src, fn), encoding="utf-8") as f:
            content = f.read()
        out.append("    { filename: %s, headType: %s, label: %s,\n      content: %s }," % (
            json.dumps(fn), json.dumps(head), json.dumps(label), json.dumps(content)))
    out += ["];", ""]
    here = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
    with open(os.path.join(here, "lib", "sleap-app-profiles", "profiles.js"), "w", encoding="utf-8") as f:
        f.write("\n".join(out))
    print("wrote %d profiles from %s" % (len(PROFILES), commit or "(unknown commit)"))


if __name__ == "__main__":
    main()
