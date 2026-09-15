"""Print every number Fig 7's legend and Results paragraph quote, from the deposit.

Written so the prose cannot drift from the artwork: the legend is typed by hand, but
each figure in it is read off this output rather than remembered from a log.
"""
import json, sys
import numpy as np

rec = json.load(open(sys.argv[1]))
ARMS = ["calibrat3_800", "calibrat3_all", "anipose", "anipose_on_ours"]

for dskey, ds in rec["datasets"].items():
    cams = ds["cameras"]
    print(f"\n{'='*78}\n{dskey}: {len(cams)} cameras, {ds['size']}\n{'='*78}")
    for detset, dv in ds["detsets"].items():
        m = dv["meta"]
        print(f"\n-- scored on {detset} detections: {m.get('points')} points "
              f"from {m.get('frames')} frames")
        for arm in ARMS:
            a = dv["arms"].get(arm)
            if not a:
                continue
            o = a["overall"]
            print(f"   {arm:16s} median {o['med']:6.3f}  mean {o['mean']:6.3f}  "
                  f"p95 {o['p95']:6.2f}  p99 {o['p99']:7.2f}  n={o['n']}")
        base = dv["arms"].get("anipose")
        ours = dv["arms"].get("calibrat3_800")
        if base and ours:
            print(f"   -> calibrat3 is {base['overall']['med'] / ours['overall']['med']:.2f}x "
                  f"lower in median, {base['overall']['p95'] / ours['overall']['p95']:.2f}x in p95")
            wins = sum(ours["cameras"][c]["med"] < base["cameras"][c]["med"] for c in cams)
            print(f"   -> calibrat3 lower in {wins}/{len(cams)} cameras")
            worst_o = max(ours["cameras"].values(), key=lambda c: c["med"])["med"]
            worst_a = max(base["cameras"].values(), key=lambda c: c["med"])["med"]
            print(f"   -> worst camera: calibrat3 {worst_o:.2f} px, Anipose {worst_a:.2f} px")
    print("\n-- wall clock")
    for tag, t in ds["timing"].items():
        if "timing" in t:
            d = t["timing"]
            print(f"   {tag:16s} detect {d['detection_s']:7.1f}s  "
                  f"intr {d['intrinsics_s']:6.1f}s  extr {d['extrinsics_s']:5.1f}s  "
                  f"sba {d['sba_s']:6.1f}s  total {d['total_s']:7.1f}s  "
                  f"({t['detectionFrames']} frames detected)")
        elif "detection_s_wall" in t:
            print(f"   {tag:16s} detect {t['detection_s_wall']:7.1f}s wall "
                  f"({t['detection_s_cpu']:.0f}s cpu, {t.get('opencv_threads','?')} cv2 threads/proc)  "
                  f"calib {t['calibration_s']:6.1f}s  "
                  f"total {t['detection_s_wall'] + t['calibration_s']:7.1f}s  "
                  f"(board found in {min(t['frames_per_cam'])}-{max(t['frames_per_cam'])} frames/cam)")
        else:
            print(f"   {tag:16s} calib {t.get('calibration_s', float('nan')):6.1f}s  "
                  f"dropped {t.get('views_dropped_collinear')} collinear views")
    # Detector YIELD, per camera: the frames each tool found a board in. Not the same
    # question as accuracy, and the one place the two detectors visibly disagree.
    a = ds["timing"].get("anipose", {}).get("frames_per_cam")
    c = ds["timing"].get("calibrat3_all", {}).get("detectionPerView")
    if a and c:
        print("\n-- board found in, per camera (Anipose | calibrat3, every frame)")
        for cam, x, y in zip(cams, a, c):
            flag = "   <-- " if min(x, y) and abs(x - y) / max(x, y) > 0.25 else ""
            print(f"   {cam:10s} {x:5d} | {y:5d}{flag}")
