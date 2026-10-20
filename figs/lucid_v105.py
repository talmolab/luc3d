"""The one place a figs/ Python driver learns which LUC3D it calls (LUC3D-JS plan R1, R4).

Python never runs LUC3D's geometry itself. Drivers that shell out to a LUC3D node script
resolve the checkout here: POSE_DIR (or LUCID_ROOT) is REQUIRED, the checkout must be at
v1.0.5 and clean, and `stamp()` is what every deposit records.
"""
import os
import subprocess
from pathlib import Path

V105 = "2dc001fe527c4dbaad17fa171da132cfdfe010e6"


def lucid_pose():
    env = os.environ.get("POSE_DIR") or (
        os.environ.get("LUCID_ROOT") and os.path.join(os.environ["LUCID_ROOT"], "pose"))
    if not env:
        raise SystemExit("POSE_DIR (or LUCID_ROOT) is required: point it at the LUC3D v1.0.5 checkout")
    pose = Path(env).resolve()
    if not pose.is_dir():
        raise SystemExit(f"no pose dir at {pose}")

    def git(*a):
        return subprocess.run(["git", "-C", str(pose), *a], capture_output=True,
                              text=True, check=True).stdout.strip()
    root, commit = git("rev-parse", "--show-toplevel"), git("rev-parse", "HEAD")
    if commit != V105:
        raise SystemExit(f"{root} is at {commit}, not LUC3D v1.0.5 ({V105})")
    if git("status", "--porcelain", "--untracked-files=no"):
        raise SystemExit(f"{root} has local changes")
    return pose, {"lucid_root": root, "lucid_commit": commit, "pose_dir": str(pose)}
