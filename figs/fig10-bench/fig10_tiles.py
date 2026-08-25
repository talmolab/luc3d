#!/usr/bin/env python3
"""Fig 10a tiles: one camera view per dataset with reprojected identities.

Full-resolution single-camera crops (not the diagnostic contact sheets), one per
dataset family, identity-colored with the app's screen palette (print-unsafe
is fine: the skeleton sits ON the photo). Run with an env that has cv2
(liezl_env).

Skeleton rendering (Eric 2026-08-16): filled translucent body surfaces +
anti-aliased edges + joint dots, replacing the original bare keypoint dots.
Aesthetic modeled on blender-images/renders/cage_two_mice.png (2D version).
"""
import os, sys
import numpy as np
import cv2

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
from fig10_validate import load_cal, project
from fig10_prep import load_pred_3d

# app IDENTITY_COLORS (pose/pose-data.js), as BGR for cv2
IDENTITY_BGR = [(0, 255, 0), (255, 0, 255), (255, 255, 0)]   # green, magenta, cyan

# 23-node rat skeleton, array order verified against the BEDDING Label3D files:
# 0 Snout, 1 EarL, 2 EarR, 3 SpineF, 4 SpineM, 5 SpineL, 6 TailBase,
# 7 ShoulderL, 8 ElbowL, 9 WristL, 10 HandL, 11 ShoulderR, 12 ElbowR,
# 13 WristR, 14 HandR, 15 HipL, 16 KneeL, 17 AnkleL, 18 FootL,
# 19 HipR, 20 KneeR, 21 AnkleR, 22 FootR.
#
# EDGES: the deposit's own skeleton.joints_idx from
# s-DANNCE-BEDDING/2024_05_07_F1_F3/20240823_193702_Label3D.mat (1-based in
# the .mat, converted to 0-based here; all 23 pairs verified anatomically
# sane: spine chain, head triangle, girdles, 4 limb chains).
EDGES = [
    (0, 1), (0, 2), (0, 3),            # Snout-EarL, Snout-EarR, Snout-SpineF
    (1, 2),                            # EarL-EarR
    (3, 4), (4, 5), (5, 6),            # SpineF-SpineM-SpineL-TailBase
    (3, 7), (3, 11),                   # SpineF-ShoulderL/R
    (5, 15), (5, 19),                  # SpineL-HipL/R
    (7, 8), (8, 9), (9, 10),           # ShoulderL-ElbowL-WristL-HandL
    (11, 12), (12, 13), (13, 14),      # ShoulderR-ElbowR-WristR-HandR
    (15, 16), (16, 17), (17, 18),      # HipL-KneeL-AnkleL-FootL
    (19, 20), (20, 21), (21, 22),      # HipR-KneeR-AnkleR-FootR
]

# BODY SURFACES (LUCID's choice, not in the deposit): filled translucent
# panels along the body axis; limbs stay edges-only. Each surface is filled
# as the CONVEX HULL of its projected vertices — a 3D-planar quad can
# self-cross (bow-tie) once projected on a twisted pose, and the hull of a
# handful of body points is the same shape whenever the quad is sane. The
# neck/torso/hind panels also include their spine midline node: in side-on
# views the girdle quads project to near-collinear slivers, and the spine
# point (on the back ridge) widens the hull up over the animal's back; in
# top-down views it is interior to the hull and changes nothing.
SURFACES = [
    (0, 1, 2),              # head: Snout-EarL-EarR
    (1, 2, 11, 7, 3),       # neck: Ears-Shoulders + SpineF
    (7, 11, 19, 15, 4),     # torso: Shoulders-Hips + SpineM
    (15, 19, 6, 5),         # hind: Hips-TailBase + SpineL
]

SURFACE_ALPHA = 0.35
EDGE_PX = 5           # at 1920x1200
DOT_PX = 5

TILES = [
    ('/root/vast/eric/s-DANNCE-data/s-DANNCE-TRIADS/2023_03_01_M1_M2_M3', 2, 30000, 'triads'),
    ('/root/vast/eric/s-DANNCE-data/s-DANNCE-BEDDING/2024_05_05_F1_F2', 1, 5000, 'bedding'),
    # SCN2A tile re-picked by Eric 2026-08-16 from an 8-candidate sheet
    # (results/agg/scn2a_tile_candidates.jpg): upright + crouched dyad, centered.
    ('/root/vast/eric/s-DANNCE-data/s-DANNCE-SCN2A_SOC3/2022_10_04_M1_M2', 4, 31267, 'scn2a'),
]
OUT = os.path.join(HERE, 'results', 'agg')
os.makedirs(OUT, exist_ok=True)


def draw_skeleton(img, pts, valid, color):
    """Filled surfaces (translucent) -> AA edges -> joint dots, in place."""
    ipts = np.round(pts).astype(int)
    # surfaces on an overlay, blended once per animal
    overlay = img.copy()
    drew = False
    for surf in SURFACES:
        if all(valid[i] for i in surf):
            poly = cv2.convexHull(ipts[list(surf)].reshape(-1, 1, 2))
            cv2.fillPoly(overlay, [poly], color, lineType=cv2.LINE_AA)
            drew = True
    if drew:
        cv2.addWeighted(overlay, SURFACE_ALPHA, img, 1 - SURFACE_ALPHA, 0, dst=img)
    for i, j in EDGES:
        if valid[i] and valid[j]:
            cv2.line(img, tuple(ipts[i]), tuple(ipts[j]), color, EDGE_PX, cv2.LINE_AA)
    for i in range(len(valid)):
        if valid[i]:
            cv2.circle(img, tuple(ipts[i]), DOT_PX, color, -1, cv2.LINE_AA)


if __name__ == '__main__':
    for S, cam, fr, tag in TILES:
        pred = load_pred_3d(S)
        A = pred.shape[1]
        cal = load_cal(os.path.join(S, 'calibration', f'hires_cam{cam}_params.mat'))
        cap = cv2.VideoCapture(os.path.join(S, 'videos', f'Camera{cam}', '0.mp4'))
        cap.set(cv2.CAP_PROP_POS_FRAMES, fr)
        ok, img = cap.read()
        cap.release()
        assert ok, (S, fr)
        for a in range(A):
            pts, z = project(pred[fr, a].T, cal)
            valid = (z > 0) & np.isfinite(pts).all(axis=1)
            draw_skeleton(img, pts, valid, IDENTITY_BGR[a % len(IDENTITY_BGR)])
        p = os.path.join(OUT, f'tile_{tag}.png')
        cv2.imwrite(p, img)
        print('wrote', p)
