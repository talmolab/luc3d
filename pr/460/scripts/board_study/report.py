"""results.json -> report.md + figures/*.png (one section per rig)."""
from __future__ import annotations

import json
from pathlib import Path

import numpy as np

import boards as B


def _f(v, d=2, unit=""):
    if v is None or (isinstance(v, float) and not np.isfinite(v)):
        return "–"
    return f"{v:,.{d}f}{unit}"


def _med(vals):
    v = [x for x in vals if x is not None and np.isfinite(x)]
    return float(np.median(v)) if v else float("nan")


def _span(vals, d=2, unit=""):
    """One value, or 'median (min–max)' over several."""
    v = [x for x in vals if x is not None and np.isfinite(x)]
    if not v:
        return "–"
    if len(v) == 1:
        return _f(v[0], d, unit)
    return f"{_f(float(np.median(v)), d, unit)} ({_f(min(v), d)}–{_f(max(v), d)})"


def _board_label(bid: str) -> str:
    if bid in B.CALIBIO:
        plate, pat, sq, mk, bx, by, usd, pn = B.CALIBIO[bid]
        return f"{plate[0]}×{plate[1]} {pat} ({bx}×{by}, {sq:g} mm)"
    return bid


def _board_order(bid: str):
    if bid in B.CALIBIO:
        plate, pat, sq, *_ = B.CALIBIO[bid]
        return (0, plate[0] * plate[1], sq)
    return (1, 0, 0)


def write(out: Path) -> Path:
    import matplotlib
    matplotlib.use("Agg")
    import matplotlib.ticker
    import matplotlib.pyplot as plt

    r = json.loads((out / "results.json").read_text())
    figs = out / "figures"
    figs.mkdir(exist_ok=True)
    takes = {t["id"]: t for t in r["takes"]}
    L = [f"# Calibration board comparison: {r['study'].get('name', '')}", "",
         f"Made {r['created']} by `scripts/board_study`. All numbers are measured with one detector "
         "(OpenCV ChArUco) on every calibration, so they compare across boards and calibration tools, "
         "but they are not the numbers calibrat3 or sleap-anipose print. Held-out = recordings (or parts of a "
         "recording) the calibration did not use.", ""]
    if r["study"].get("note"):
        L += [r["study"]["note"], ""]
    rigs = sorted({c["rig"] for c in r["calibrations"]})
    for rig in rigs:
        rt = [t for t in r["takes"] if t["rig"] == rig]
        t0 = rt[0]
        L += [f"## {rig}", "",
              f"{len(t0['cameras'])} cameras, {t0['size'][0]}×{t0['size'][1]} px, {_f(t0['fps'], 0)} fps. "
              f"Recordings: {len([t for t in rt if t['kind'] == 'calibration'])} calibration, "
              f"{len([t for t in rt if t['kind'] == 'test'])} test.", ""]
        cals = [c for c in r["calibrations"] if c["rig"] == rig and not c.get("failed")]
        boards_ = sorted({c["board"] for c in cals}, key=_board_order)
        has_truth = any(c.get("truth") for c in cals)
        # --- summary per board ------------------------------------------------------
        hdr = ["Board", "Recordings", "Board found", "Reprojection", "Held-out reprojection",
               "Ruler error", "Board fit", "3D spread", "Camera spread", "Focal spread", "Smallest squares found",
               "Steepest tilt found"]
        if has_truth:
            hdr.insert(6, "3D error vs truth")
        L += ["### Per board", "",
              "Reprojection and held-out reprojection: median pixels. Ruler error: median error of lengths "
              "between far-apart corners of the board, triangulated from held-out frames, % of the length. "
              "Board fit: RMS distance of triangulated corners from the printed pattern, mm. "
              "3D spread: how far the same 3D points move between repeated calibrations, mm (median). "
              "Camera spread: camera-position spread between repeats, mm. Focal spread: SD of focal length, %. "
              "Smallest squares found: 5th percentile of square size, in pixels, among detections. "
              "Repeats are separate recordings of one sitting when there are several, else 3 disjoint parts of each recording; "
              "with several recordings the spread columns show median (min–max).", "",
              "| " + " | ".join(hdr) + " |", "|" + "---|" * len(hdr)]
        for bid in boards_:
            full = [c for c in cals if c["board"] == bid and c["variant"] == "full" and c["engine"] == "anipose"]
            if not full:
                full = [c for c in cals if c["board"] == bid and c["variant"] == "full"]
            splits = [c for c in cals if c["board"] == bid and c["variant"].startswith("split") and c["engine"] == "anipose"]
            scored = full if any(c.get("heldout") for c in full) else splits
            ho = [c["heldout"] for c in scored if c.get("heldout")]
            rep = [x for x in r["repeatability"] if x["rig"] == rig and x["board"] == bid and x["engine"] == "anipose"]
            rsep = [x for x in rep if "separate" in x["kind"]] or rep
            cov = [x for x in r["coverage"] if x["rig"] == rig and x["board"] == bid]
            found = _med([_med([v["found_pct"] for v in x["per_camera"].values()]) for x in cov])
            sq = _med([_med([v["min_square_px_found"] for v in x["per_camera"].values()]) for x in cov])
            tilt = _med([_med([v["max_tilt_found_deg"] for v in x["per_camera"].values()]) for x in cov])
            row = [_board_label(bid), str(len({c['take'] for c in full})), _f(found, 0, " %"),
                   _f(_med([(c.get("self") or {}).get("median_px") for c in full]), 2, " px"),
                   _f(_med([h["reprojection"]["median_px"] for h in ho]), 2, " px"),
                   _f(_med([h["geometry"]["long_length_err_pct"] for h in ho]), 3, " %"),
                   _f(_med([h["geometry"]["fit_rms_mm"] for h in ho]), 2, " mm"),
                   _span([x.get("points3d_sd_mm") for x in rsep], 2, " mm"),
                   _span([x.get("camera_pos_sd_mm") for x in rsep], 1, " mm"),
                   _span([x.get("fx_sd_pct") for x in rsep], 2, " %"),
                   _f(sq, 0, " px"), _f(tilt, 0, "°")]
            if has_truth:
                row.insert(6, _f(_med([(c.get("truth") or {}).get("vs_truth_median_mm") for c in scored]), 2, " mm"))
            L.append("| " + " | ".join(row) + " |")
        L.append("")
        # --- how long to record -----------------------------------------------------
        pre = [c for c in cals if c["variant"].startswith("first") and c.get("heldout")]
        if pre:
            secs = sorted({int(c["variant"][5:-1]) for c in pre})
            metric = "truth" if has_truth else "ruler"
            L += ["### How long to record", "",
                  ("3D error against the true calibration (mm, median) " if has_truth else
                   "Held-out ruler error (%) ") + "of a calibration from only the first N seconds of a recording:", "",
                  "| Board | " + " | ".join(f"{s} s" for s in secs) + " | whole |", "|" + "---|" * (len(secs) + 2)]
            fig, ax = plt.subplots(figsize=(6, 4))
            for bid in boards_:
                vals = []
                for s in secs:
                    cs = [c for c in pre if c["board"] == bid and c["variant"] == f"first{s}s"]
                    vals.append(_med([(c["truth"]["vs_truth_median_mm"] if has_truth else c["heldout"]["geometry"]["long_length_err_pct"]) for c in cs]))
                whole = [c for c in cals if c["board"] == bid and c["variant"] == "full" and c["engine"] == "anipose"]
                wv = _med([(c.get("truth") or {}).get("vs_truth_median_mm") if has_truth else (c.get("heldout") or {}).get("geometry", {}).get("long_length_err_pct") for c in whole])
                L.append(f"| {_board_label(bid)} | " + " | ".join(_f(v, 2 if has_truth else 3) for v in vals) + f" | {_f(wv, 2 if has_truth else 3)} |")
                ax.plot(secs, vals, marker="o", label=_board_label(bid))
            ax.set_xlabel("seconds of recording used")
            ax.set_ylabel("3D error vs truth, mm" if has_truth else "held-out ruler error, %")
            ax.set_title(rig)
            ax.grid(alpha=0.3)
            ax.legend(fontsize=7)
            fig.tight_layout()
            fig.savefig(figs / f"{rig}_seconds.png", dpi=130)
            plt.close(fig)
            L += ["", f"![]({'figures/' + rig + '_seconds.png'})", ""]
        # --- detection by square size / tilt ---------------------------------------
        cov = [x for x in r["coverage"] if x["rig"] == rig]
        if cov:
            fig, axs = plt.subplots(1, 2, figsize=(10, 4))
            for bid in boards_:
                cdir = Path(r.get("cache") or out / "cache")
                rows = [np.load(cdir / x["take"] / "coverage_rows.npy") for x in cov if x["board"] == bid
                        and (cdir / x["take"] / "coverage_rows.npy").exists()]
                rows = [x for x in rows if len(x)]
                if not rows:
                    continue
                rows = np.concatenate(rows)
                for ax, col, edges, lab in ((axs[0], 1, np.array([0, 4, 6, 8, 10, 12, 15, 20, 25, 30, 40, 60, 100]), "square size in the image, px"),
                                            (axs[1], 2, np.arange(0, 95, 10.0), "board tilt from the line of sight, °")):
                    x, y = [], []
                    for a, b in zip(edges[:-1], edges[1:]):
                        m = (rows[:, col] >= a) & (rows[:, col] < b)
                        if m.sum() >= 10:
                            x.append(0.5 * (a + b))
                            y.append(100 * rows[m, 4].mean())
                    ax.plot(x, y, marker="o", label=_board_label(bid))
                    ax.set_xlabel(lab)
            for ax in axs:
                ax.set_ylabel("board found when in view, %")
                ax.set_ylim(0, 102)
                ax.grid(alpha=0.3)
            axs[0].set_xscale("log")
            axs[0].set_xticks([5, 10, 20, 40, 80])
            axs[0].xaxis.set_major_formatter(matplotlib.ticker.ScalarFormatter())
            axs[0].xaxis.set_minor_formatter(matplotlib.ticker.NullFormatter())
            axs[1].legend(fontsize=7)
            fig.suptitle(rig)
            fig.tight_layout()
            fig.savefig(figs / f"{rig}_detection.png", dpi=130)
            plt.close(fig)
            L += ["### Where each board is still found", "",
                  "Board poses known from the other cameras, fully inside a camera's image: was it found there?", "",
                  f"![]({'figures/' + rig + '_detection.png'})", ""]
        # --- repeatability per recording -------------------------------------------------
        reps = [x for x in r["repeatability"] if x["rig"] == rig]
        if reps:
            L += ["### Repeatability", "",
                  "| Board | Repeats | Engine | 3D spread (median / p95) | Camera position spread (median / worst) | "
                  "Camera angle spread | Camera distance SD | Focal SD | k1 SD |", "|---|---|---|---|---|---|---|---|---|"]
            for x in sorted(reps, key=lambda x: (_board_order(x["board"]), x["take"])):
                L.append(f"| {_board_label(x['board'])} | {x['kind']}: {x['take']} | {x['engine']} | "
                         f"{_f(x.get('points3d_sd_mm'), 2)} / {_f(x.get('points3d_sd_p95_mm'), 2)} mm | "
                         f"{_f(x.get('camera_pos_sd_mm'), 1)} / {_f(x.get('camera_pos_sd_max_mm'), 1)} mm | "
                         f"{_f(x.get('camera_rot_sd_deg'), 2, '°')} | {_f(x.get('pair_distance_sd_mm'), 1, ' mm')} | "
                         f"{_f(x.get('fx_sd_pct'), 2, ' %')} | {_f(x.get('k1_sd'), 3)} |")
            L.append("")
        # --- engines ----------------------------------------------------------------
        engs = sorted({c["engine"] for c in cals if c["variant"] == "full"})
        if len(engs) > 1:
            L += ["### Calibration tools on the same recordings", "",
                  "| Recording | Tool | Reprojection | Held-out reprojection | Ruler error | Board fit |", "|---|---|---|---|---|---|"]
            for c in sorted((c for c in cals if c["variant"] == "full"), key=lambda c: (c["take"], c["engine"])):
                h = c.get("heldout") or {}
                L.append(f"| {c['take']} | {c['engine']} | {_f((c.get('self') or {}).get('median_px'), 2, ' px')} | "
                         f"{_f(h.get('reprojection', {}).get('median_px'), 2, ' px')} | "
                         f"{_f(h.get('geometry', {}).get('long_length_err_pct'), 3, ' %')} | {_f(h.get('geometry', {}).get('fit_rms_mm'), 2, ' mm')} |")
            L.append("")
        # --- proofread poses / rulers ---------------------------------------------------
        withp = [c for c in cals if c.get("poses")]
        if withp:
            L += ["### Proofread poses", "",
                  "Proofread 2D poses of the same day triangulated with each calibration (median over all labelled "
                  "nodes of every session listed in the study): reprojection, and leave-one-camera-out "
                  "(triangulated from the other cameras, projected into the left-out one). Label noise is in both.", "",
                  "| Calibration | Frames used | Pose reprojection | Leave one camera out |", "|---|---|---|---|"]
            for c in withp:
                ps = list(c["poses"].values())
                L.append(f"| {c['take']} {c['engine']}/{c['variant']} | {c.get('frames_used', '–')} | "
                         f"{_f(_med([p['reprojection_median_px'] for p in ps]), 2, ' px')} | "
                         f"{_f(_med([p['leave_one_camera_out_median_px'] for p in ps]), 2, ' px')} |")
            L.append("")
        withr = [c for c in cals if c.get("rulers")]
        if withr:
            L += ["### Ruler", "", "| Calibration | Median length error | Median |error| | p95 |error| |", "|---|---|---|---|"]
            for c in withr:
                for rid, rr in c["rulers"].items():
                    L.append(f"| {c['take']} {c['engine']}/{c['variant']} ({rid}) | {_f(rr.get('median_error_mm'), 2, ' mm')} | "
                             f"{_f(rr.get('median_abs_error_mm'), 2, ' mm')} ({_f(rr.get('median_abs_error_pct'), 2, ' %')}) | {_f(rr.get('p95_abs_error_mm'), 2, ' mm')} |")
            L.append("")
        # --- tools compared over the disjoint parts ---------------------------------------
        split_engs = sorted({c["engine"] for c in cals if c["variant"].startswith("split")})
        if len(split_engs) > 1:
            L += ["### Calibration tools on the same parts of each recording", "",
                  "Each tool calibrated the same disjoint parts; each part is scored on the others. "
                  "Medians over parts; spreads are between the parts' calibrations.", "",
                  "| Recording | Tool | Reprojection | Held-out reprojection | Ruler error | Board fit | 3D spread | Camera position spread |",
                  "|---|---|---|---|---|---|---|---|"]
            for take in sorted({c["take"] for c in cals if c["variant"].startswith("split")}):
                for eng in split_engs:
                    ps = [c for c in cals if c["take"] == take and c["engine"] == eng and c["variant"].startswith("split")]
                    if not ps:
                        continue
                    ho = [c["heldout"] for c in ps if c.get("heldout")]
                    rp = next((x for x in r["repeatability"] if x["take"] == take and x["engine"] == eng
                               and "disjoint" in x["kind"]), {})
                    L.append(f"| {take} | {eng} ({len(ps)} parts) | {_f(_med([(c.get('self') or {}).get('median_px') for c in ps]), 2, ' px')} | "
                             f"{_f(_med([h['reprojection']['median_px'] for h in ho]), 2, ' px')} | "
                             f"{_f(_med([h['geometry']['long_length_err_pct'] for h in ho]), 3, ' %')} | "
                             f"{_f(_med([h['geometry']['fit_rms_mm'] for h in ho]), 2, ' mm')} | "
                             f"{_f(rp.get('points3d_sd_mm'), 2, ' mm')} | {_f(rp.get('camera_pos_sd_mm'), 1, ' mm')} |")
            L.append("")
        # --- per recording ----------------------------------------------------------
        L += ["### Recordings", "", "| Recording | Board | Length | Board found per camera |", "|---|---|---|---|"]
        for t in rt:
            cv = next((x for x in r["coverage"] if x["take"] == t["id"]), None)
            per = ", ".join(f"{_f(v['found_pct'], 0)}" for v in cv["per_camera"].values()) + " %" if cv else "–"
            L.append(f"| {t['id']} ({t['kind']}) | {_board_label(t['board'])} | {_f(t.get('seconds'), 0, ' s')} | {per} |")
        failed = [c for c in r["calibrations"] if c["rig"] == rig and c.get("failed")]
        if failed:
            L += ["", "Failed calibrations: " + "; ".join(f"{c['take']} {c['engine']}: {c['failed'][:120]}" for c in failed)]
        L.append("")
    p = out / "report.md"
    p.write_text("\n".join(L) + "\n")
    print(f"wrote {p}")
    return p
