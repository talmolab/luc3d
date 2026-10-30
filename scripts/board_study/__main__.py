"""Compare ChArUco calibration boards across camera rigs.

    uv run --with numpy --with scipy --with opencv-contrib-python-headless --with aniposelib \\
        --with matplotlib python scripts/board_study <command> ...

Commands:
    run STUDY.toml OUT [--engine anipose,calibrat3 --calibrat3 ~/Documents/calibrat3]
        detect, calibrate (full takes, disjoint parts, first N seconds), score -> OUT/results.json
    report OUT        OUT/results.json -> OUT/report.md + OUT/figures/*.png
    scan ROOT         study.toml for recordings laid out as PROTOCOL.md asks
    merge OUT PARTS   combine results.json of separate runs (e.g. one per rig, sharing --cache)
    simulate ...      render synthetic recordings of catalogue boards in a rig taken from a
                      real calibration.toml (see simulate.py), and write a study.toml for them
    boards            print the calib.io catalogue used here
    fit-jitter T PX   corner noise that makes simulated take T match a real reprojection error PX
    selftest          simulate a 3-camera rig, run everything, check the result against the truth

See README.md next to this file for the protocol and the study.toml format.
"""
import argparse
import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import boards as B  # noqa: E402


def main(argv=None):
    ap = argparse.ArgumentParser(prog="board_study", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = ap.add_subparsers(dest="cmd", required=True)
    r = sub.add_parser("run")
    r.add_argument("study", type=Path)
    r.add_argument("out", type=Path)
    r.add_argument("--engine", default="anipose", help="comma list: anipose, calibrat3")
    r.add_argument("--calibrat3", type=Path, help="calibrat3 checkout (with tests/e2e npm-installed)")
    r.add_argument("--splits", type=int, default=3, help="disjoint interleaved parts per take (0 = off)")
    r.add_argument("--block-s", type=float, default=5.0, help="block length for the parts, seconds")
    r.add_argument("--prefixes", default="10,20,30,45,60,90,120", help="first-N-seconds calibrations ('' = off)")
    r.add_argument("--stride", type=int, default=1, help="detect every Nth frame")
    r.add_argument("--rig", help="only this rig")
    r.add_argument("--cache", type=Path, help="detection cache folder (default OUT/cache); share it between runs")
    mg = sub.add_parser("merge")
    mg.add_argument("out", type=Path)
    mg.add_argument("parts", type=Path, nargs="+")
    p = sub.add_parser("report")
    p.add_argument("out", type=Path)
    s = sub.add_parser("simulate")
    s.add_argument("--rig-calibration", type=Path, required=True, help="calibration.toml of the rig to imitate")
    s.add_argument("--rig", required=True)
    s.add_argument("--boards", required=True, help="comma list of catalogue ids (python scripts/board_study boards)")
    s.add_argument("--takes", type=int, default=3)
    s.add_argument("--seconds", type=float, default=60)
    s.add_argument("--fps", type=float, default=10)
    s.add_argument("--trajectory", type=Path, help="results dir of a real run of this rig: reuse its board motion")
    s.add_argument("--trajectory-take", help="take id inside --trajectory")
    s.add_argument("--frame-step", type=int, default=1, help="with --trajectory: use every Nth frame of the real motion")
    s.add_argument("--volume-mm", type=float, default=None, help="size of the region the board is waved through")
    s.add_argument("--exposure-ms", type=float, default=2.0)
    s.add_argument("--noise", type=float, default=2.0, help="sensor noise, grey levels")
    s.add_argument("--corner-jitter", type=float, default=0.0, help="corner_jitter written to the study.toml, px (see fit-jitter)")
    s.add_argument("--white", type=float, default=200, help="grey level of a white square")
    s.add_argument("--black", type=float, default=20)
    s.add_argument("--test-poses", type=int, default=12, help="static test-board recording (0 = none)")
    s.add_argument("--test-board", default=None, help="catalogue id of the test board (default: largest coarse that fits)")
    s.add_argument("--workers", type=int, default=None)
    s.add_argument("--seed", type=int, default=0)
    s.add_argument("--out", type=Path, required=True)
    sc = sub.add_parser("scan")
    sc.add_argument("root", type=Path)
    sc.add_argument("--out", type=Path, help="write here instead of printing")
    fj = sub.add_parser("fit-jitter")
    fj.add_argument("take", type=Path, help="a simulated take folder (simulate output) of the rig's real board")
    fj.add_argument("target_px", type=float, help="median reprojection error of the real recording (results.json, anipose/full)")
    st = sub.add_parser("selftest")
    st.add_argument("--keep", type=Path, help="work here instead of a temporary folder")
    sub.add_parser("boards")
    a = ap.parse_args(argv)

    if a.cmd == "boards":
        for k, (plate, pat, sq, mk, bx, by, usd, pn) in B.CALIBIO.items():
            print(f"{k:28s} {plate[0]}x{plate[1]} mm  {bx}x{by} squares  {sq:g}/{mk:g} mm  ${usd}  {pn}")
        return
    if a.cmd == "fit-jitter":
        import simulate
        print(f"corner_jitter = {simulate.fit_jitter(a.take, a.target_px):.3f}")
        return
    if a.cmd == "selftest":
        import selftest
        sys.exit(0 if selftest.main(a.keep) else 1)
    if a.cmd == "scan":
        import study
        text = study.scan(a.root)
        if a.out:
            a.out.write_text(text)
        else:
            print(text)
        return
    if a.cmd == "run":
        import study
        study.run(a.study, a.out, tuple(a.engine.split(",")), a.splits, a.block_s,
                  tuple(int(x) for x in a.prefixes.split(",") if x), a.calibrat3, a.stride, a.rig, a.cache)
        print(f"wrote {a.out / 'results.json'}")
        return
    if a.cmd == "merge":
        import study
        study.merge(a.out, a.parts)
        print(f"wrote {a.out / 'results.json'}")
        return
    if a.cmd == "report":
        import report
        report.write(a.out)
        return
    if a.cmd == "simulate":
        import simulate
        simulate.main(a)
        return


if __name__ == "__main__":
    main()
